// Resume browser: reads the Claude Code transcript directory for a cwd and offers
// each past conversation as a one-click relaunch.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::registry::{launch_in, InstanceView};
use crate::util::home;

#[derive(Serialize, Clone)]
pub struct PastSession {
    pub session_id: String,
    pub title: String,
    pub mtime: u64,
    pub cwd: String,
}

pub fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The first real user prompt of a transcript, for use as a title.
///
/// Streamed, and only the first 60 records are ever looked at: a week-old transcript is tens of
/// megabytes and this runs once per session in the Resume list, so reading each file whole would
/// cost hundreds of megabytes to inspect a few kilobytes.
///
/// A record that does not fit the shape is skipped rather than ending the search, and injected
/// content is identified by its tags rather than by the first character. `<div> is not closing`
/// is a real prompt, and handoff.rs carries a test that says so.
pub fn first_user_text(path: &PathBuf) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(60) {
        let Ok(line) = line else { continue };
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        // A record carrying no content at all is one to skip, not a reason to give up on the
        // whole file: `?` here used to turn the very first tool-result record into "no prompt".
        let Some(c) = v.pointer("/message/content") else { continue };
        let text = match c {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) != Some("tool_result"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        let text = strip_injected(&text);
        let text = text.trim();
        if text.is_empty() || text.starts_with("Caveat:") {
            continue;
        }
        return Some(text.chars().take(90).collect());
    }
    None
}

/// Remove the tag spans Claude Code wraps around injected content, leaving ordinary prose that
/// merely happens to contain an angle bracket exactly as the user typed it.
fn strip_injected(text: &str) -> String {
    const TAGS: [&str; 5] = [
        "system-reminder",
        "local-command-stdout",
        "command-name",
        "command-message",
        "command-args",
    ];
    let mut out = text.to_string();
    for tag in TAGS {
        let open = format!("<{}>", tag);
        let close = format!("</{}>", tag);
        loop {
            let Some(a) = out.find(&open) else { break };
            let Some(b) = out[a..].find(&close) else { break };
            out.replace_range(a..a + b + close.len(), "");
        }
    }
    out
}

#[tauri::command]
pub fn past_sessions(cwd: String) -> Vec<PastSession> {
    let dir = home().join(".claude").join("projects").join(project_slug(&cwd));
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let sid = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            out.push(PastSession {
                title: first_user_text(&p).unwrap_or_else(|| "(no prompt)".into()),
                session_id: sid,
                mtime,
                cwd: cwd.clone(),
            });
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(40);
    out
}

#[tauri::command]
pub fn resume_session(cwd: String, session_id: String, name: String) -> Result<InstanceView, String> {
    // A resumed conversation is a new instance and gets its own tile.
    let v = launch_in(cwd, format!("claude --resume {}", session_id), name, None)?;
    Ok(v)
}
