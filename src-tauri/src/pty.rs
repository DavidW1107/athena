// One pty per attached instance, each running `tmux attach`. Detaching kills only the
// attach client, so the tmux session (and the agent inside it) outlives the window.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, State};

use crate::tmux::{sess_name, tmux_alive};

pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyStore(pub Mutex<HashMap<String, PtyHandle>>);

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
    }
    Ok(())
}
