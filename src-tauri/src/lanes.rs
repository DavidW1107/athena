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

/// Run one pbuild subcommand and return what the user needs to see.
///
/// The contract for both commands is raw stdout, but stdout alone cannot distinguish "it worked
/// and printed nothing" from "it failed and did nothing", and the second of those is a silent
/// no-op behind a button the user believes acted. A non-zero exit is therefore reported in the
/// text itself, which is the only channel this API has.
fn pbuild(sub: &str) -> String {
    let Ok(o) = Command::new("pbuild").arg(sub).output() else {
        return "pbuild not found".into();
    };
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    if o.status.success() {
        return out;
    }
    let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
    let code = o.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
    format!("pbuild {} failed (exit {}): {}\n{}", sub, code, err, out).trim_end().to_string()
}

#[tauri::command]
pub fn pbuild_status() -> String {
    // ponytail: raw text panel. Parse it only if Argus ever needs to act on the numbers.
    pbuild("ls")
}

#[tauri::command]
pub fn pbuild_resume_all() -> String {
    pbuild("resume-all")
}
