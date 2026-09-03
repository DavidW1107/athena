// Read-only views of the two out-of-process lanes Argus watches but does not own:
// codex-task runs under ~/.codex/tasks, and pbuild's machine-pressure gate.

use std::fs;
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::util::home;

#[derive(Serialize, Clone)]
pub struct CodexTask {
    pub name: String,
    pub dir: String,
    pub status: String,
    pub mtime: u64,
    pub tail: String,
}

#[tauri::command]
pub fn codex_tasks() -> Vec<CodexTask> {
    let root = home().join(".codex").join("tasks");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let dir = e.path();
            let status = match fs::read_to_string(dir.join("status")) {
                Ok(s) if s.trim() == "0" => "done".to_string(),
                Ok(s) => format!("exit {}", s.trim()),
                Err(_) => "running".to_string(),
            };
            let tail = fs::read_to_string(dir.join("last.txt"))
                .ok()
                .map(|s| s.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(CodexTask {
                name: dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                dir: dir.to_string_lossy().to_string(),
                status,
                mtime,
                tail: tail.chars().take(160).collect(),
            });
        }
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(15);
    out
}

#[tauri::command]
pub fn pbuild_status() -> String {
    // ponytail: raw text panel. Parse it only if Argus ever needs to act on the numbers.
    Command::new("pbuild")
        .arg("ls")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|| "pbuild not found".into())
}

#[tauri::command]
pub fn pbuild_resume_all() -> String {
    Command::new("pbuild")
        .arg("resume-all")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|| "pbuild not found".into())
}
