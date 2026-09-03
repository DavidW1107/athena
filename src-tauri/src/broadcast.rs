// One prompt, many instances. Delivery is two phases per recipient with a hard
// short-circuit between them: stage the text in the pane, then submit it. A staging
// failure never gets an Enter behind it, and a submit failure says so explicitly,
// because that is the one outcome that leaves a pane holding an unsent prompt.
//
// Delivery itself is tmux::send_block, the foundation's shared paste helper: multi-line
// text goes through a tmux paste buffer with bracketed paste rather than send-keys, so an
// agent TUI reads the block as one prompt instead of submitting at every newline. Liveness
// is read once from pane_map() for the whole fleet.

use std::collections::HashSet;

use serde::Serialize;

use crate::tmux::{pane_map, send_block, sess_name};

#[derive(Serialize, Clone, Debug)]
pub struct BroadcastResult {
    pub id: String,
    pub ok: bool,
    pub error: Option<String>,
}

impl BroadcastResult {
    fn ok(id: String) -> Self {
        BroadcastResult { id, ok: true, error: None }
    }
    fn err(id: String, msg: String) -> Self {
        BroadcastResult { id, ok: false, error: Some(msg) }
    }
}

/// Send `text` to every id whose tmux session is live, one result entry per id.
///
/// Liveness comes from a single `pane_map()` snapshot, so a hundred recipients still
/// cost one tmux probe. An id missing from that snapshot gets a `not running` entry and
/// no tmux call at all. Duplicate ids are collapsed so nobody is sent the prompt twice.
#[tauri::command]
pub fn send_many(ids: Vec<String>, text: String) -> Result<Vec<BroadcastResult>, String> {
    let text = text.trim_end();
    if text.is_empty() {
        return Err("nothing to send".into());
    }
    if ids.is_empty() {
        return Err("no instances selected".into());
    }

    let panes = pane_map();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let sess = sess_name(&id);
        if !panes.contains_key(&sess) {
            out.push(BroadcastResult::err(id, "not running".into()));
            continue;
        }
        let sent = send_block(&sess, &id, text);
        out.push(match sent {
            Ok(()) => BroadcastResult::ok(id),
            Err(e) => BroadcastResult::err(id, e),
        });
    }
    Ok(out)
}
