mod api;
mod host;
mod input;
mod views;

use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wasm/lnbits-extension.wit", world: "supportchat", generate_all });
struct Extension;

type Reply = Result<Value, String>;

fn run(input: &str, handler: fn(&Value) -> Reply) -> String {
    let request = if input.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_str(input)
    };
    let result = match request {
        Ok(value) if value.is_object() => handler(&value),
        _ => Err("request must be a JSON object.".into()),
    };
    match result {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string()
}

// Each WIT export has the same JSON envelope.
macro_rules! routes {
    ($($name:ident),+ $(,)?) => {
        impl Guest for Extension {
            $(fn $name(input:String) -> String { run(&input, api::$name) })+
        }
    };
}
routes!(
    create_inbox,
    update_inbox,
    list_inboxes,
    delete_inbox,
    list_conversations,
    list_messages,
    reply_conversation,
    update_conversation,
    resolve_conversation,
    mark_conversation_read,
    add_internal_note,
    list_canned_replies,
    save_canned_reply,
    delete_canned_reply,
    get_public_inbox,
    start_conversation,
    get_public_conversation,
    post_public_message
);
export!(Extension);
