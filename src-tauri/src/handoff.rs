// Cross-instance handoff: lift the tail of one instance's Claude transcript and paste
// it into another instance as a single prompt.
//
// Two commands, both owned by this shard:
//   transcript_tail  reads the last n real messages of a .jsonl transcript
//   handoff_send     delivers the formatted block to a live tmux session
//
// The transcript shape is the one sessions.rs::first_user_text reads: one JSON record
// per line, `message.content` either a plain string or an array of blocks. Two things
// are handled more carefully here than in a title lookup, because a handoff has to be
// the *actual* last n messages rather than the first plausible one:
//
//   * Synthetic records are identified by their metadata (isMeta, isSidechain,
//     toolUseResult) and by block type, never by what the prose happens to start with.
//     A prompt that opens with "<div>" is a real prompt and must survive.
//   * The file is streamed and only `count` messages are ever held, so a 200 MB
//     transcript costs one line buffer plus the tail, not the whole conversation.
//
// Delivery goes through tmux::send_block, the foundation's shared paste helper: a
// multi-message block is staged in a tmux buffer and pasted with bracketed paste (-p),
// which an agent TUI reads as one prompt, then submitted with exactly one Enter. Typing it
// with `send-keys -l` instead would submit at every newline and the receiving agent would
// get six prompts rather than one.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::sessions::project_slug;
use crate::tmux::sess_name;
use crate::util::home;

/// Upper bound on a tail request. The picker offers 1-40; this is the backstop.
const MAX_MESSAGES: usize = 40;

/// A block larger than this is refused rather than pushed through a tmux buffer.
const MAX_BLOCK_CHARS: usize = 120_000;

/// Tags Claude Code wraps around injected content inside an otherwise real message.
/// Only a complete `<tag>…</tag>` span is removed, so an unbalanced angle bracket in
/// ordinary prose is left exactly as the user wrote it.
const INJECTED_TAGS: [&str; 5] = [
    "system-reminder",
    "local-command-stdout",
    "command-name",
    "command-message",
    "command-args",
];

#[derive(Serialize, Clone, Debug)]
pub struct TranscriptMessage {
    pub role: String,
    pub text: String,
    /// Unix seconds, or 0 when the record carries no parsable timestamp.
    pub ts: u64,
}

// ---------------------------------------------------------------- text extraction

/// Remove every complete `<tag>…</tag>` span from `text`, leaving the rest untouched.
/// An opening tag with no closing tag is prose, not an injection, so it is kept.
fn strip_span(text: &str, tag: &str) -> String {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(a) = rest.find(&open) {
        let after = &rest[a + open.len()..];
        match after.find(&close) {
            Some(b) => {
                out.push_str(&rest[..a]);
                rest = &after[b + close.len()..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn strip_injections(text: &str) -> String {
    let mut s = text.to_string();
    for tag in INJECTED_TAGS {
        if s.contains(tag) {
            s = strip_span(&s, tag);
        }
    }
    s.trim().to_string()
}

/// A record Athena should never hand to another agent, decided from transcript metadata
/// rather than from the message text: hook/caveat injections (`isMeta`), sub-agent
/// conversations (`isSidechain`), and the user-shaped records that only carry a tool
/// result (`toolUseResult`).
fn is_synthetic(v: &Value) -> bool {
    let flag = |k: &str| v.get(k).and_then(|b| b.as_bool()).unwrap_or(false);
    flag("isMeta") || flag("isSidechain") || v.get("toolUseResult").is_some()
}

/// The human-readable text of one record, or None when it carries none. Array content
/// keeps `type: "text"` blocks only, which drops thinking, tool_use, tool_result and
/// image blocks without having to guess from their contents.
fn message_text(v: &Value) -> Option<String> {
    let raw = match v.pointer("/message/content")? {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = strip_injections(&raw);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ---------------------------------------------------------------- timestamps

/// Days since the Unix epoch for a UTC civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Exactly `n` ASCII digits, as an integer. Rejects "1e", " 7", "+3" and anything else
/// `str::parse` would otherwise wave through.
fn digits(s: Option<&str>, n: usize) -> Option<i64> {
    let s = s?;
    if s.len() != n || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A full RFC 3339 instant ("2026-09-03T14:07:02.418Z", or with a `+HH:MM` offset) as
/// unix seconds. Every field is shape-checked and range-checked, the date is checked
/// against the real length of that month, and the arithmetic is checked, so a malformed
/// or out-of-range string returns None instead of a wrapped or nonsense instant.
fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b'T' || b[10] == b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(s.get(0..4), 4)?;
    let month = digits(s.get(5..7), 2)?;
    let day = digits(s.get(8..10), 2)?;
    let hour = digits(s.get(11..13), 2)?;
    let min = digits(s.get(14..16), 2)?;
    let sec = digits(s.get(17..19), 2)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || min > 59 || sec > 60 {
        return None;
    }

    // Optional fractional seconds, then a mandatory zone.
    let mut rest = s.get(19..)?;
    if rest.starts_with('.') {
        let frac = rest[1..].bytes().take_while(|c| c.is_ascii_digit()).count();
        if frac == 0 {
            return None;
        }
        rest = rest.get(1 + frac..)?;
    }
    let zone = *rest.as_bytes().first()?;
    let offset = match zone {
        b'Z' | b'z' if rest.len() == 1 => 0,
        b'+' | b'-' if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let oh = digits(rest.get(1..3), 2)?;
            let om = digits(rest.get(4..6), 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let mag = oh.checked_mul(3600)?.checked_add(om.checked_mul(60)?)?;
            if zone == b'-' {
                -mag
            } else {
                mag
            }
        }
        _ => return None,
    };

    days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3600)?)?
        .checked_add(min.checked_mul(60)?)?
        // A leap second shares the following minute's boundary rather than overflowing it.
        .checked_add(sec.min(59))?
        .checked_sub(offset)
}

/// Unix seconds for a record's `timestamp`, or 0 when it is absent, malformed or before
/// the epoch. The UI treats 0 as "no time known" and shows nothing.
fn parse_ts(v: &Value) -> u64 {
    v.get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(parse_rfc3339)
        .filter(|secs| *secs >= 0)
        .map(|secs| secs as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- commands

/// The last `count` real user/assistant messages of a transcript, oldest first.
///
/// The file is streamed and at most `count` messages are retained, so the cost of a
/// six-message handoff is the same on a fresh conversation and on a week-old one.
#[tauri::command]
pub fn transcript_tail(
    cwd: String,
    session_id: String,
    count: usize,
    host: Option<String>,
) -> Result<Vec<TranscriptMessage>, String> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err("bad session id".into());
    }
    let count = count.clamp(1, MAX_MESSAGES);
    // A desk instance's transcript is on the desk. The same incremental mirror the usage meter
    // uses serves it here, so handing off FROM a remote instance reads its real conversation
    // rather than failing on a path this laptop does not have.
    let path: PathBuf = match host.as_deref().filter(|h| !h.trim().is_empty()) {
        None => home()
            .join(".claude")
            .join("projects")
            .join(project_slug(&cwd))
            .join(format!("{}.jsonl", session_id)),
        Some(h) => crate::cost::mirror_transcript(h, &format!("{}/{}.jsonl", project_slug(&cwd), session_id))?,
    };

    let file = File::open(&path).map_err(|e| format!("cannot read transcript: {}", e))?;
    let mut tail: VecDeque<TranscriptMessage> = VecDeque::with_capacity(count + 1);

    for line in BufReader::new(file).lines() {
        // A line that is not valid UTF-8 is skipped, not fatal. Ending the scan there would
        // silently return the tail from BEFORE the damage while the UI still claims it is the
        // last n messages, which is the one outcome a handoff must never produce.
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        if is_synthetic(&v) {
            continue;
        }
        let text = match message_text(&v) {
            Some(t) => t,
            None => continue,
        };
        tail.push_back(TranscriptMessage { role: role.to_string(), text, ts: parse_ts(&v) });
        if tail.len() > count {
            tail.pop_front();
        }
    }
    Ok(tail.into())
}

/// Paste the handed-over block into the target instance and submit it once.
///
/// Both footguns are refused here as well as in the UI, so neither can be bypassed by a
/// stale panel: a block is never sent back into the instance it came from, and never
/// into a session that is not running. Errors distinguish the two partial states that
/// matter: nothing reached the pane, versus text reached it and was not submitted.
#[tauri::command]
pub fn handoff_send(source_id: String, target_id: String, text: String) -> Result<(), String> {
    let text = text.trim_end();
    if text.is_empty() {
        return Err("nothing to send".into());
    }
    if text.chars().count() > MAX_BLOCK_CHARS {
        return Err(format!("block is too large to paste (limit {} characters)", MAX_BLOCK_CHARS));
    }
    if source_id == target_id {
        return Err("source and target must be different instances".into());
    }
    let host = crate::registry::instance_host(&target_id);
    let hostref = host.as_deref();
    let sess = sess_name(&target_id);
    if !crate::tmux::tmux_alive_on(hostref, &sess) {
        return Err("target instance is not running".into());
    }

    crate::tmux::send_block_on(hostref, &sess, &target_id, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_prose_that_opens_with_a_tag() {
        let v: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":"<div> is not closing"}}"#,
        )
        .unwrap();
        assert_eq!(message_text(&v).as_deref(), Some("<div> is not closing"));
    }

    #[test]
    fn strips_only_complete_injection_spans() {
        let v: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[
                {"type":"text","text":"<system-reminder>ignore me</system-reminder>real prompt"},
                {"type":"tool_use","name":"Read","input":{}}]}}"#,
        )
        .unwrap();
        assert_eq!(message_text(&v).as_deref(), Some("real prompt"));
    }

    #[test]
    fn rejects_malformed_timestamps() {
        assert_eq!(parse_rfc3339("2026-13-03T14:07:02Z"), None); // month 13
        assert_eq!(parse_rfc3339("2026-02-30T14:07:02Z"), None); // no such day
        assert_eq!(parse_rfc3339("2026-09-03T25:07:02Z"), None); // hour 25
        assert_eq!(parse_rfc3339("2026-09-03T14:07:02"), None); // no zone
        assert_eq!(parse_rfc3339("2026-09-03T14:07:02.Z"), None); // empty fraction
    }

    #[test]
    fn parses_utc_and_offsets() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-09-03T14:07:02.418Z"), Some(1_788_444_422));
        assert_eq!(
            parse_rfc3339("2026-09-03T15:07:02+01:00"),
            parse_rfc3339("2026-09-03T14:07:02Z")
        );
    }
}
