// Resume browser: reads the Claude Code transcript directory for a cwd and offers
// each past conversation as a one-click relaunch.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::registry::{launch, InstanceView};
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

pub fn first_user_text(path: &PathBuf) -> Option<String> {
    let s = fs::read_to_string(path).ok()?;
    for line in s.lines().take(60) {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let c = v.pointer("/message/content")?;
        let text = match c {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        let text = text.trim();
        // Skip hook/system injections; they are never a useful title.
        if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
            continue;
        }
        return Some(text.chars().take(90).collect());
    }
    None
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
    let v = launch(cwd, format!("claude --resume {}", session_id), name)?;
    Ok(v)
}
