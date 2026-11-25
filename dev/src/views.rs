use crate::{host, input::*};
use serde_json::{json, Value};

pub const OFFLINE: &str = "We are currently offline. Leave a message and we will reply.";
pub const LAUNCHER: &str = "Chat with support";
pub const STATUSES: [&str; 4] = ["open", "pending", "snoozed", "resolved"];
pub const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];

pub fn text(v: &Value, max: usize, default: &str) -> String {
    let value = clean(v, max);
    if value.is_empty() {
        default.into()
    } else {
        value
    }
}
pub fn color(v: &Value, default: &str) -> String {
    let color = clean(v, 7);
    if color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        color.to_lowercase()
    } else {
        default.into()
    }
}
pub fn hour(v: &Value, fallback: i64) -> i64 {
    let n = num(v, fallback as f64);
    if n.fract() == 0. && (0.0..=23.).contains(&n) {
        n as i64
    } else {
        fallback
    }
}
pub fn choice(v: &Value, options: &[&str], fallback: &str) -> String {
    let value = clean(v, 20);
    if options.contains(&value.as_str()) {
        value
    } else {
        fallback.into()
    }
}
pub fn tags(v: &Value) -> Vec<String> {
    let items = v
        .as_array()
        .cloned()
        .unwrap_or_else(|| s(v).split(',').map(|v| json!(v)).collect());
    let mut tags = Vec::new();
    for item in items {
        let tag = clean(&item, 32).to_lowercase();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
        if tags.len() == 10 {
            break;
        }
    }
    tags
}
pub fn inbox(row: &Value) -> Value {
    let active = row["is_active"] == true;
    let enabled = row["office_hours_enabled"] == true;
    let start = hour(&row["office_hours_start"], 9);
    let end = hour(&row["office_hours_end"], 17);
    let current = (host::now() / 3600 % 24) as i64;
    let open = if start <= end {
        (start..end).contains(&current)
    } else {
        current >= start || current < end
    };
    json!({
        "id":row["id"], "name":row["name"], "welcomeMessage":row["welcome_message"], "isActive":active,
        "accentColor":color(&row["accent_color"],"#f2a900"), "launcherText":text(&row["launcher_text"],40,LAUNCHER),
        "offlineMessage":text(&row["offline_message"],280,OFFLINE), "officeHoursEnabled":enabled,
        "officeHoursStart":start,"officeHoursEnd":end,"isOnline":active&&(!enabled||open),
        "createdAt":i(&row["created_at"]),"updatedAt":i(&row["updated_at"])
    })
}
pub fn conversation(row: &Value) -> Value {
    json!({
        "id":row["id"],"inboxId":row["inbox_id"],"visitorName":row["visitor_name"],"subject":row["subject"],
        "status":choice(&row["status"],&STATUSES,"open"),"createdAt":i(&row["created_at"]),
        "updatedAt":i(&row["updated_at"]),"lastMessageAt":i(&row["last_message_at"])
    })
}
pub fn private_conversation(row: &Value, messages: &[&Value]) -> Value {
    let mut result = conversation(row);
    let read = i(&row["agent_last_read_at"]);
    let unread = messages
        .iter()
        .filter(|m| m["sender_type"] == "visitor" && i(&m["created_at"]) > read)
        .count();
    let last = messages
        .iter()
        .map(|m| i(&m["created_at"]))
        .fold(i(&row["last_message_at"]), i64::max);
    merge(
        &mut result,
        json!({"visitorEmail":row["visitor_email"],"priority":choice(&row["priority"],&PRIORITIES,"normal"),
        "tags":tags(&row["tags"]),"unreadCount":unread,"agentLastReadAt":read,"snoozedUntil":i(&row["snoozed_until"]).max(0),"lastMessageAt":last}),
    );
    result
}
pub fn message(row: &Value, note: bool) -> Value {
    json!({"id":row["id"],"conversationId":row["conversation_id"],"inboxId":row["inbox_id"],
    "senderType":if note{"internal_note"}else{s(&row["sender_type"])},"senderName":row["sender_name"],"body":row["body"],"createdAt":i(&row["created_at"])})
}
pub fn canned(row: &Value) -> Value {
    json!({"id":row["id"],"inboxId":row["inbox_id"],"title":row["title"],"body":row["body"],"createdAt":i(&row["created_at"]),"updatedAt":i(&row["updated_at"])})
}
