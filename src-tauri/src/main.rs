// Athena: manager for Claude Code / Codex terminal instances.
//
// Design in one line: tmux owns session lifetime, a JSON registry owns intent,
// Claude Code hooks own state. Athena just renders and orchestrates those three.
//
// CONVERGENCE POINT. This file holds module declarations and the Tauri builder and
// nothing else. A feature shard adds its own `mod` line and its commands to the
// invoke_handler list at integration time; it never edits anything else here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adopt;
mod autopause;
mod broadcast;
mod cost;
mod handoff;
mod lanes;
mod pty;
mod registry;
mod sessions;
mod tmux;
mod util;

use pty::PtyStore;

fn main() {
    util::athena_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(PtyStore::default())
        .invoke_handler(tauri::generate_handler![
            registry::list_instances,
            registry::launch_in,
            registry::restore,
            registry::close,
            registry::set_paused,
            registry::send_text,
            registry::send_key,
            registry::list_repos,
            adopt::list_adoptable_sessions,
            adopt::adopt_session,
            adopt::list_adoptable_processes,
            adopt::reptyr_check,
            adopt::adopt_process,
            sessions::past_sessions,
            sessions::resume_session,
            lanes::codex_tasks,
            lanes::pbuild_status,
            lanes::pbuild_resume_all,
            broadcast::send_many,
            cost::session_usage,
            handoff::transcript_tail,
            handoff::handoff_send,
            autopause::autopause_config,
            autopause::autopause_save,
            autopause::autopause_select,
            autopause::autopause_tick,
            pty::attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_detach
        ])
        .run(tauri::generate_context!())
        .expect("athena failed to start");
}
