// Argus: manager for Claude Code / Codex terminal instances.
//
// Design in one line: tmux owns session lifetime, a JSON registry owns intent,
// Claude Code hooks own state. Argus just renders and orchestrates those three.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

// ---------------------------------------------------------------- paths

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn argus_dir() -> PathBuf {
    let d = home().join(".argus");
    let _ = fs::create_dir_all(d.join("state"));
    d
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- registry

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Instance {
    id: String,
    name: String,
    cwd: String,
    group: String,
    cmd: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    created: u64,
}

fn reg_path() -> PathBuf {
    argus_dir().join("instances.json")
}

fn read_reg() -> Vec<Instance> {
    fs::read_to_string(reg_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_reg(v: &[Instance]) {
    if let Ok(s) = serde_json::to_string_pretty(v) {
        let _ = fs::write(reg_path(), s);
    }
}

// ---------------------------------------------------------------- tmux

fn tmux(args: &[&str]) -> Option<std::process::Output> {
    Command::new("tmux").args(args).output().ok()
}

fn sess_name(id: &str) -> String {
    format!("argus_{}", id)
}

fn tmux_alive(sess: &str) -> bool {
    tmux(&["has-session", "-t", sess]).map(|o| o.status.success()).unwrap_or(false)
}

fn pane_pid(sess: &str) -> Option<i32> {
    let o = tmux(&["list-panes", "-t", sess, "-F", "#{pane_pid}"])?;
    String::from_utf8_lossy(&o.stdout).lines().next()?.trim().parse().ok()
}

/// Fields of /proc/<pid>/stat after the comm field, which itself may contain spaces.
fn proc_stat_fields(pid: i32) -> Option<Vec<String>> {
    let s = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    let rest = s.rsplit_once(')')?.1;
    Some(rest.split_whitespace().map(|x| x.to_string()).collect())
}

/// Foreground process group of the pane's tty: the job actually running (claude/codex),
/// not the shell. Signalling this group stops the whole tree.
fn fg_pgid(sess: &str) -> Option<i32> {
    // after comm: state, ppid, pgrp, session, tty_nr, tpgid
    tpgid_of(pane_pid(sess)?)
}

/// One tmux call for the whole fleet: session name -> first pane pid.
/// The poll runs every second, so per-instance `has-session` calls are not affordable.
fn pane_map() -> HashMap<String, i32> {
    let mut m = HashMap::new();
    if let Some(o) = tmux(&["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]) {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((sess, pid)) = line.split_once(' ') {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    m.entry(sess.to_string()).or_insert(pid);
                }
            }
        }
    }
    m
}

fn tpgid_of(pid: i32) -> Option<i32> {
    proc_stat_fields(pid)?.get(5)?.parse().ok()
}

fn is_stopped_pid(pane: i32) -> bool {
    match tpgid_of(pane).and_then(proc_stat_fields) {
        Some(f) => f.first().map(|s| s == "T").unwrap_or(false),
        None => false,
    }
}

fn signal_group(pgid: i32, sig: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("kill -{} -{}", sig, pgid))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn git_group(cwd: &str) -> String {
    let top = Command::new("git")
        .args(["-C", cwd, "rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let path = top.unwrap_or_else(|| cwd.to_string());
    PathBuf::from(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path)
}

// ---------------------------------------------------------------- hook state

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct HookState {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    ts: Option<u64>,
}

fn read_state(id: &str) -> HookState {
    fs::read_to_string(argus_dir().join("state").join(format!("{}.json", id)))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[derive(Serialize, Clone, Debug)]
struct InstanceView {
    id: String,
    name: String,
    cwd: String,
    group: String,
    cmd: String,
    created: u64,
    session_id: Option<String>,
    alive: bool,
    paused: bool,
    state: String,
    tool: Option<String>,
    summary: Option<String>,
    idle_secs: u64,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn list_instances() -> Vec<InstanceView> {
    let mut reg = read_reg();
    let mut dirty = false;
    let mut out = Vec::new();
    let panes = pane_map();
    for inst in reg.iter_mut() {
        let sess = sess_name(&inst.id);
        let pane = panes.get(&sess).copied();
        let alive = pane.is_some();
        let hs = read_state(&inst.id);
        // The hook is the only place a resume id ever appears; persist it once seen.
        if hs.session_id.is_some() && hs.session_id != inst.session_id {
            inst.session_id = hs.session_id.clone();
            dirty = true;
        }
        let paused = pane.map(is_stopped_pid).unwrap_or(false);
        let state = if !alive {
            "dead".to_string()
        } else if paused {
            "paused".to_string()
        } else {
            hs.state.clone().unwrap_or_else(|| "idle".to_string())
        };
        out.push(InstanceView {
            id: inst.id.clone(),
            name: inst.name.clone(),
            cwd: inst.cwd.clone(),
            group: inst.group.clone(),
            cmd: inst.cmd.clone(),
            created: inst.created,
            session_id: inst.session_id.clone(),
            alive,
            paused,
            state,
            tool: hs.tool.clone(),
            summary: hs.summary.clone(),
            idle_secs: now().saturating_sub(hs.ts.unwrap_or(now())),
        });
    }
    if dirty {
        write_reg(&reg);
    }
    out
}

#[tauri::command]
fn launch(cwd: String, cmd: String, name: String) -> Result<InstanceView, String> {
    if !PathBuf::from(&cwd).is_dir() {
        return Err(format!("no such directory: {}", cwd));
    }
    let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) % 0xffff_ffff);
    let sess = sess_name(&id);
    let group = git_group(&cwd);
    let name = if name.trim().is_empty() { group.clone() } else { name };

    let ok = tmux(&[
        "new-session", "-d", "-s", &sess, "-c", &cwd,
        "-e", &format!("ARGUS_ID={}", id),
        "-e", &format!("ARGUS_NAME={}", name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed (is tmux installed?)".into());
    }
    tmux(&["send-keys", "-t", &sess, &cmd, "Enter"]);

    let inst = Instance { id, name, cwd, group, cmd, session_id: None, created: now() };
    let mut reg = read_reg();
    reg.push(inst.clone());
    write_reg(&reg);
    Ok(list_instances().into_iter().find(|v| v.id == inst.id).unwrap())
}

/// Bring back an instance whose tmux session died (app closed, laptop rebooted).
/// If a Claude session id was ever captured, resume that conversation rather than start fresh.
#[tauri::command]
fn restore(id: String) -> Result<(), String> {
    let reg = read_reg();
    let inst = reg.iter().find(|i| i.id == id).ok_or("unknown instance")?;
    let sess = sess_name(&id);
    if tmux_alive(&sess) {
        return Ok(());
    }
    let ok = tmux(&[
        "new-session", "-d", "-s", &sess, "-c", &inst.cwd,
        "-e", &format!("ARGUS_ID={}", id),
        "-e", &format!("ARGUS_NAME={}", inst.name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed".into());
    }
    let line = match (&inst.session_id, inst.cmd.as_str()) {
        (Some(sid), c) if c.starts_with("claude") => format!("claude --resume {}", sid),
        _ => inst.cmd.clone(),
    };
    tmux(&["send-keys", "-t", &sess, &line, "Enter"]);
    Ok(())
}

#[tauri::command]
fn close(id: String) -> Result<(), String> {
    tmux(&["kill-session", "-t", &sess_name(&id)]);
    let _ = fs::remove_file(argus_dir().join("state").join(format!("{}.json", id)));
    let reg: Vec<Instance> = read_reg().into_iter().filter(|i| i.id != id).collect();
    write_reg(&reg);
    Ok(())
}

#[tauri::command]
fn set_paused(id: String, paused: bool) -> Result<(), String> {
    let sess = sess_name(&id);
    let pgid = fg_pgid(&sess).ok_or("no foreground job in that pane")?;
    if pgid <= 1 {
        return Err("refusing to signal pgid <= 1".into());
    }
    let sig = if paused { "STOP" } else { "CONT" };
    if signal_group(pgid, sig) {
        Ok(())
    } else {
        Err(format!("kill -{} failed", sig))
    }
}

#[tauri::command]
fn send_text(id: String, text: String) -> Result<(), String> {
    let sess = sess_name(&id);
    if !tmux_alive(&sess) {
        return Err("not running".into());
    }
    tmux(&["send-keys", "-t", &sess, "-l", &text]);
    tmux(&["send-keys", "-t", &sess, "Enter"]);
    Ok(())
}

#[tauri::command]
fn send_key(id: String, key: String) -> Result<(), String> {
    tmux(&["send-keys", "-t", &sess_name(&id), &key]);
    Ok(())
}

// ---------------------------------------------------------------- resume browser

#[derive(Serialize, Clone)]
struct PastSession {
    session_id: String,
    title: String,
    mtime: u64,
    cwd: String,
}

fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn first_user_text(path: &PathBuf) -> Option<String> {
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
fn past_sessions(cwd: String) -> Vec<PastSession> {
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
fn resume_session(cwd: String, session_id: String, name: String) -> Result<InstanceView, String> {
    let v = launch(cwd, format!("claude --resume {}", session_id), name)?;
    Ok(v)
}

// ---------------------------------------------------------------- codex + pbuild lanes

#[derive(Serialize, Clone)]
struct CodexTask {
    name: String,
    dir: String,
    status: String,
    mtime: u64,
    tail: String,
}

#[tauri::command]
fn codex_tasks() -> Vec<CodexTask> {
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
fn pbuild_status() -> String {
    // ponytail: raw text panel. Parse it only if Argus ever needs to act on the numbers.
    Command::new("pbuild")
        .arg("ls")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|| "pbuild not found".into())
}

#[tauri::command]
fn pbuild_resume_all() -> String {
    Command::new("pbuild")
        .arg("resume-all")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_else(|| "pbuild not found".into())
}


/// Two levels under the GitHub root, which is exactly how the buckets are laid out
/// (clients/, internal/, tools/, demos/, personal/). Keeps the launcher a fuzzy pick.
#[tauri::command]
fn list_repos() -> Vec<String> {
    let root = home().join("Documents").join("GitHub");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            out.push(e.path().to_string_lossy().to_string());
            if let Ok(rd2) = fs::read_dir(e.path()) {
                for e2 in rd2.flatten() {
                    if e2.path().is_dir() {
                        out.push(e2.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------- pty bridge

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct PtyStore(Mutex<HashMap<String, PtyHandle>>);

#[tauri::command]
fn attach(app: tauri::AppHandle, ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sess = sess_name(&id);
    if !tmux_alive(&sess) {
        return Err("session not running".into());
    }
    let mut map = ptys.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&id) {
        return Ok(());
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new("tmux");
    cmd.arg("attach");
    cmd.arg("-t");
    cmd.arg(&sess);
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let ev = format!("pty:{}", id);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    // Keep a partial multi-byte char for the next read instead of mangling it.
                    let split = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) => match e.error_len() {
                            Some(_) => e.valid_up_to() + 1, // genuinely invalid: drop one byte
                            None => e.valid_up_to(),
                        },
                    };
                    let chunk = String::from_utf8_lossy(&carry[..split]).to_string();
                    carry.drain(..split);
                    if !chunk.is_empty() {
                        let _ = app.emit(&ev, chunk);
                    }
                }
            }
        }
    });
    map.insert(id, PtyHandle { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
fn pty_write(ptys: State<PtyStore>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().map_err(|e| e.to_string())?;
    let h = map.get_mut(&id).ok_or("not attached")?;
    h.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    h.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().map_err(|e| e.to_string())?;
    let h = map.get(&id).ok_or("not attached")?;
    h.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_detach(ptys: State<PtyStore>, id: String) -> Result<(), String> {
    let mut map = ptys.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = map.remove(&id) {
        let _ = h.child.kill(); // kills the attach client only; the tmux session lives on
    }
    Ok(())
}

// ---------------------------------------------------------------- main

fn main() {
    argus_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(PtyStore::default())
        .invoke_handler(tauri::generate_handler![
            list_instances, launch, restore, close, set_paused, send_text, send_key,
            past_sessions, resume_session, codex_tasks, pbuild_status, pbuild_resume_all, list_repos,
            attach, pty_write, pty_resize, pty_detach
        ])
        .run(tauri::generate_context!())
        .expect("argus failed to start");
}
