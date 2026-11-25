use crate::{host, input::*, views as v, Reply};
use serde_json::{json, Value};
use std::collections::HashMap;
const INBOX: &str = "inboxes";
const CONV: &str = "conversations";
const MSG: &str = "messages";
const NOTES: &str = "internal_notes";
const REPLIES: &str = "canned_replies";

pub fn create_inbox(r: &Value) -> Reply {
    save_inbox(r, true)
}
pub fn update_inbox(r: &Value) -> Reply {
    save_inbox(r, false)
}
pub fn list_inboxes(r: &Value) -> Reply {
    let sort = match s(&r["sortBy"]) {
        "name" => "name",
        "updated_at" => "updated_at",
        _ => "created_at",
    };
    let mut opts = options(r, 100, &["name", "welcome_message"], sort);
    opts["descending"] = json!(r["descending"] == true || r["descending"] == "true");
    let p = host::page(INBOX, opts)?;
    Ok(json!({"inboxes":p.rows.iter().map(v::inbox).collect::<Vec<_>>(),"total":p.total}))
}
pub fn delete_inbox(r: &Value) -> Reply {
    let row = lookup(r, INBOX, false)?;
    let id = s(&row["id"]);
    if host::page(CONV, json!({"filters":{"inbox_id":id},"limit":1}))?.total > 0 {
        return Err("Inboxes with conversations cannot be deleted.".into());
    }
    host::delete(INBOX, id)?;
    host::log(&format!("supportchat: deleted inbox {id}"), "info");
    Ok(json!({"id":id,"deleted":true}))
}
pub fn list_conversations(r: &Value) -> Reply {
    let inbox = lookup(r, INBOX, false)?;
    let mut filters = json!({"inbox_id":inbox["id"]});
    for (key, values) in [("status", &v::STATUSES), ("priority", &v::PRIORITIES)] {
        let value = clean(&r[key], 20);
        if values.contains(&value.as_str()) {
            filters[key] = value.into();
        }
    }
    let (sort, field) = match s(&r["sortBy"]) {
        "created_at" => ("created_at", "createdAt"),
        "updated_at" => ("updated_at", "updatedAt"),
        "visitor_name" => ("visitor_name", "visitorName"),
        "priority" => ("priority", "priority"),
        _ => ("last_message_at", "lastMessageAt"),
    };
    let descending = r["descending"] != false && r["descending"] != "false";
    let p = host::page(
        CONV,
        json!({"filters":filters,"search":clean(&r["search"],256),"searchFields":["visitor_name","visitor_email","subject","status","priority","tags"],"sortBy":sort,"descending":descending,"limit":200}),
    )?;
    let messages = host::page(
        MSG,
        json!({"filters":{"inbox_id":inbox["id"]},"sortBy":"created_at","limit":1000}),
    )?;
    let mut groups: HashMap<&str, Vec<&Value>> = HashMap::new();
    for m in &messages.rows {
        groups.entry(s(&m["conversation_id"])).or_default().push(m);
    }
    let mut rows: Vec<_> = p
        .rows
        .iter()
        .map(|row| {
            v::private_conversation(
                row,
                groups.get(s(&row["id"])).map(Vec::as_slice).unwrap_or(&[]),
            )
        })
        .collect();
    rows.sort_by(|left, right| {
        let (a, b) = (&left[field], &right[field]);
        let order = if a.is_number() {
            i(a).cmp(&i(b))
        } else {
            s(a).to_lowercase().cmp(&s(b).to_lowercase())
        };
        if descending {
            order.reverse()
        } else {
            order
        }
    });
    let (limit, offset) = pagination(r, 100);
    Ok(
        json!({"inbox":v::inbox(&inbox),"conversations":rows.into_iter().skip(offset as usize).take(limit as usize).collect::<Vec<_>>(),"total":p.total}),
    )
}
pub fn list_messages(r: &Value) -> Reply {
    let c = lookup(r, CONV, false)?;
    let mut opts = options(r, 200, &["sender_name", "body"], "created_at");
    opts["filters"] = json!({"conversation_id":c["id"]});
    let messages = host::page(MSG, opts.clone())?;
    let notes = host::page(NOTES, opts)?;
    let mut rows: Vec<_> = messages
        .rows
        .iter()
        .map(|m| v::message(m, false))
        .chain(notes.rows.iter().map(|n| v::message(n, true)))
        .collect();
    rows.sort_by_key(|m| i(&m["createdAt"]));
    Ok(
        json!({"conversation":v::private_conversation(&c,&[]),"messages":rows,"total":messages.total+notes.total}),
    )
}
pub fn reply_conversation(r: &Value) -> Reply {
    let mut c = lookup(r, CONV, false)?;
    load(INBOX, s(&c["inbox_id"]), false)?;
    let now = host::now();
    let m = json!({"id":host::id("msg"),"conversation_id":c["id"],"inbox_id":c["inbox_id"],"sender_type":"agent","sender_name":v::text(&r["name"],80,"Support"),"body":body(r)?,"created_at":now});
    host::set(MSG, &m)?;
    merge(
        &mut c,
        json!({"status":"open","snoozed_until":0,"agent_last_read_at":now,"updated_at":now,"last_message_at":now}),
    );
    host::set(CONV, &c)?;
    publish(&c, "message.created", Some(&m));
    Ok(json!({"conversation":v::private_conversation(&c,&[]),"message":v::message(&m,false)}))
}
pub fn update_conversation(r: &Value) -> Reply {
    let mut c = lookup(r, CONV, false)?;
    c["status"] = v::choice(
        r.get("status").unwrap_or(&c["status"]),
        &v::STATUSES,
        "open",
    )
    .into();
    c["priority"] = v::choice(
        r.get("priority").unwrap_or(&c["priority"]),
        &v::PRIORITIES,
        "normal",
    )
    .into();
    c["tags"] = json!(v::tags(r.get("tags").unwrap_or(&c["tags"])));
    c["snoozed_until"] = if c["status"] == "snoozed" {
        i(r.get("snoozedUntil").unwrap_or(&c["snoozed_until"])).max(0)
    } else {
        0
    }
    .into();
    c["updated_at"] = host::now().into();
    host::set(CONV, &c)?;
    publish(&c, "conversation.updated", None);
    Ok(json!({"conversation":v::private_conversation(&c,&[])}))
}
pub fn resolve_conversation(r: &Value) -> Reply {
    let mut c = lookup(r, CONV, false)?;
    load(INBOX, s(&c["inbox_id"]), false)?;
    merge(
        &mut c,
        json!({"status":"resolved","snoozed_until":0,"updated_at":host::now()}),
    );
    host::set(CONV, &c)?;
    publish(&c, "conversation.resolved", None);
    Ok(json!({"conversation":v::private_conversation(&c,&[])}))
}
pub fn mark_conversation_read(r: &Value) -> Reply {
    let mut c = lookup(r, CONV, false)?;
    c["agent_last_read_at"] = host::now().into();
    host::set(CONV, &c)?;
    Ok(json!({"conversation":v::private_conversation(&c,&[])}))
}
pub fn add_internal_note(r: &Value) -> Reply {
    let c = lookup(r, CONV, false)?;
    let n = json!({"id":host::id("note"),"conversation_id":c["id"],"inbox_id":c["inbox_id"],"sender_name":v::text(&r["name"],80,"Support"),"body":body(r)?,"created_at":host::now()});
    host::set(NOTES, &n)?;
    Ok(json!({"note":v::message(&n,true)}))
}
pub fn list_canned_replies(r: &Value) -> Reply {
    let c = lookup(r, INBOX, false)?;
    let mut opts = options(r, 100, &["title", "body"], "title");
    opts["filters"] = json!({"inbox_id":c["id"]});
    let p = host::page(REPLIES, opts)?;
    Ok(json!({"cannedReplies":p.rows.iter().map(v::canned).collect::<Vec<_>>(),"total":p.total}))
}
pub fn save_canned_reply(r: &Value) -> Reply {
    let inbox = lookup(r, INBOX, false)?;
    let id = clean_id(&r["id"]);
    let old = if id.is_empty() {
        Value::Null
    } else {
        host::get(REPLIES, &id)?
    };
    if !old.is_null() && old["inbox_id"] != inbox["id"] {
        return Err("Canned reply does not belong to this inbox.".into());
    }
    let now = host::now();
    let row = json!({"id":if id.is_empty(){host::id("reply")}else{id},"inbox_id":inbox["id"],"title":required(&r["title"],"title",80)?,"body":body(r)?,"created_at":old["created_at"].as_u64().unwrap_or(now),"updated_at":now});
    host::set(REPLIES, &row)?;
    Ok(json!({"cannedReply":v::canned(&row)}))
}
pub fn delete_canned_reply(r: &Value) -> Reply {
    let id = required(&r["replyId"], "replyId", 128)?;
    if host::get(REPLIES, &id)?.is_null() {
        return Err("Canned reply not found.".into());
    }
    host::delete(REPLIES, &id)?;
    Ok(json!({"id":id,"deleted":true}))
}
pub fn get_public_inbox(r: &Value) -> Reply {
    Ok(json!({"inbox":v::inbox(&lookup(r,INBOX,true)?)}))
}
pub fn start_conversation(r: &Value) -> Reply {
    let inbox = lookup(r, INBOX, true)?;
    if inbox["is_active"] != true {
        return Err("This support inbox is not accepting messages.".into());
    }
    let now = host::now();
    let body = body(r)?;
    let subject = v::text(&r["subject"], 120, &clean(&json!(body), 80));
    let id = host::append_public(
        CONV,
        s(&inbox["id"]),
        &json!({"visitor_name":v::text(&r["name"],80,"Guest"),"visitor_email":clean(&r["email"],160),"subject":subject,"status":"open","priority":"normal","tags":[],"agent_last_read_at":0,"snoozed_until":0,"created_at":now,"updated_at":now,"last_message_at":now}),
    );
    let c = load(CONV, &id, true)?;
    let m = append(&c, &body, string_or(&c["visitor_name"], "Guest"), now);
    publish(&c, "message.created", Some(&m));
    Ok(
        json!({"inbox":v::inbox(&inbox),"conversation":v::conversation(&c),"messages":[v::message(&m,false)]}),
    )
}
pub fn get_public_conversation(r: &Value) -> Reply {
    let c = lookup(r, CONV, true)?;
    let inbox = load(INBOX, s(&c["inbox_id"]), true)?;
    let (limit, offset) = pagination(r, 200);
    let p = host::public_page(
        MSG,
        s(&c["id"]),
        json!({"sortBy":"created_at","limit":limit,"offset":offset}),
    )?;
    Ok(
        json!({"inbox":v::inbox(&inbox),"conversation":v::conversation(&c),"messages":p.rows.iter().map(|m|v::message(m,false)).collect::<Vec<_>>(),"total":p.total}),
    )
}
pub fn post_public_message(r: &Value) -> Reply {
    let c = lookup(r, CONV, true)?;
    if c["status"] == "resolved" {
        return Err("This conversation has been resolved.".into());
    }
    let now = host::now();
    let p = host::public_page(
        MSG,
        s(&c["id"]),
        json!({"sortBy":"created_at","descending":true,"limit":1}),
    )?;
    if p.rows
        .first()
        .is_some_and(|m| now <= i(&m["created_at"]).max(0) as u64)
    {
        return Err("Please wait before sending another message.".into());
    }
    let m = append(
        &c,
        &body(r)?,
        &v::text(&r["name"], 80, string_or(&c["visitor_name"], "Guest")),
        now,
    );
    publish(&c, "message.created", Some(&m));
    Ok(json!({"conversation":v::conversation(&c),"message":v::message(&m,false)}))
}
fn save_inbox(r: &Value, new: bool) -> Reply {
    let now = host::now();
    let mut row = if new {
        let id = clean_id(&r["id"]);
        json!({"id":if id.is_empty(){host::id("inbox")}else{id},"created_at":now})
    } else {
        lookup(r, INBOX, false)?
    };
    let active = if !new && r.get("isActive").is_none() && r.get("is_active").is_none() {
        row["is_active"] == true
    } else {
        r["isActive"] != false && r["is_active"] != false
    };
    let fields = json!({"name":v::text(&r["name"],80,string_or(&row["name"],"Support inbox")),
        "welcome_message":v::text(alias(r,"welcomeMessage","welcome_message"),280,string_or(&row["welcome_message"],"Send us a message and we will reply here.")),
        "is_active":active,"accent_color":v::color(&r["accentColor"],&v::color(&row["accent_color"],"#f2a900")),
        "launcher_text":v::text(&r["launcherText"],40,&v::text(&row["launcher_text"],40,v::LAUNCHER)),
        "offline_message":v::text(&r["offlineMessage"],280,&v::text(&row["offline_message"],280,v::OFFLINE)),
        "office_hours_enabled":r.get("officeHoursEnabled").unwrap_or(&row["office_hours_enabled"])==true,
        "office_hours_start":v::hour(&r["officeHoursStart"],v::hour(&row["office_hours_start"],9)),
        "office_hours_end":v::hour(&r["officeHoursEnd"],v::hour(&row["office_hours_end"],17)),"updated_at":now});
    merge(&mut row, fields);
    host::set(INBOX, &row)?;
    host::log(
        &format!("supportchat: saved inbox {}", s(&row["id"])),
        "info",
    );
    Ok(json!({"inbox":v::inbox(&row)}))
}
fn lookup(r: &Value, table: &str, public: bool) -> Reply {
    let key = if table == INBOX {
        "inboxId"
    } else {
        "conversationId"
    };
    load(table, &required(&r[key], key, 128)?, public)
}
fn load(table: &str, id: &str, public: bool) -> Reply {
    let row = if public {
        host::get_public(table, id)?
    } else {
        host::get(table, id)?
    };
    if row.is_null() {
        Err(if table == INBOX {
            "Support inbox not found."
        } else {
            "Conversation not found."
        }
        .into())
    } else {
        Ok(row)
    }
}
fn append(c: &Value, body: &str, name: &str, now: u64) -> Value {
    let mut row = json!({"inbox_id":c["inbox_id"],"sender_type":"visitor","sender_name":name,"body":body,"created_at":now});
    let id = host::append_public(MSG, s(&c["id"]), &row);
    row["id"] = id.into();
    row["conversation_id"] = c["id"].clone();
    row
}
fn publish(c: &Value, event: &str, msg: Option<&Value>) {
    let mut payload = json!({"type":event,"conversation":v::conversation(c)});
    if let Some(m) = msg {
        payload["message"] = v::message(m, false);
    }
    host::publish(&format!("conversation:{}", s(&c["id"])), payload.clone());
    host::publish(&format!("inbox:{}", s(&c["inbox_id"])), payload);
}
fn clean_id(v: &Value) -> String {
    let id = clean(v, 128);
    if id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        id
    } else {
        String::new()
    }
}
fn body(r: &Value) -> Result<String, String> {
    let body: String = s(alias(r, "body", "message"))
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .chars()
        .take(2000)
        .collect();
    if body.is_empty() {
        Err("Message is required.".into())
    } else {
        Ok(body)
    }
}
fn options(r: &Value, default: u32, fields: &[&str], sort: &str) -> Value {
    let (limit, offset) = pagination(r, default);
    json!({"limit":limit,"offset":offset,"search":clean(&r["search"],256),"searchFields":fields,"sortBy":sort})
}
