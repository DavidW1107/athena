// One pty per attached instance, each running `tmux attach`. Detaching kills only the
// attach client, so the tmux session (and the agent inside it) outlives the window.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager, State};

use crate::tmux::{sess_name, tmux_alive};

pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Which attach this handle is. The reader thread removes its own entry when the client
    /// exits, and only if the map still holds the same generation, so a handle created by a
    /// later re-attach is never swept away by an older thread finishing.
    pub gen: u64,
}

#[derive(Default)]
pub struct PtyStore(pub Mutex<HashMap<String, PtyHandle>>);

/// Attach generation, so an exiting reader thread can tell its own entry from its successor's.
static GEN: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn attach(app: tauri::AppHandle, ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String> {
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
    // Argus is a terminal tool and is often launched from inside tmux. An inherited $TMUX makes
    // the client refuse to nest ("sessions should be nested with care"), and it would exit
    // immediately into a handle this map would then cache as live.
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let generation = GEN.fetch_add(1, Ordering::Relaxed);
    let ev = format!("pty:{}", id);
    let done_id = id.clone();
    let done_app = app.clone();
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
        // The client has exited: the tmux session was killed, the server went away, or a nested
        // attach was refused. Drop the handle, because `attach` treats map membership as proof
        // that a live client exists and would otherwise return a successful no-op forever,
        // leaving the user looking at a dead terminal that no reconnect can repair.
        if let Some(store) = done_app.try_state::<PtyStore>() {
            if let Ok(mut map) = store.0.lock() {
                if map.get(&done_id).map(|h| h.gen) == Some(generation) {
                    if let Some(mut h) = map.remove(&done_id) {
                        let _ = h.child.wait();
                    }
                }
            }
        }
    });
    map.insert(id, PtyHandle { master: pair.master, writer, child, gen: generation });
    Ok(())
}

#[tauri::command]
pub fn pty_write(ptys: State<PtyStore>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().map_err(|e| e.to_string())?;
    let h = map.get_mut(&id).ok_or("not attached")?;
    h.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    h.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().map_err(|e| e.to_string())?;
    let h = map.get(&id).ok_or("not attached")?;
    h.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_detach(ptys: State<PtyStore>, id: String) -> Result<(), String> {
    let mut map = ptys.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = map.remove(&id) {
        let _ = h.child.kill(); // kills the attach client only; the tmux session lives on
        // Reap it. Dropping the handle does not, so switching between cards or panes would
        // otherwise leave one defunct child per detach under the app for the whole session.
        let _ = h.child.wait();
    }
    Ok(())
}
