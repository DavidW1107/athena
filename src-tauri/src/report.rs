// Work report: a thin runner around scripts/report.mjs, which owns every rule. The nightly
// systemd timer calls the same script, so the dialog and the archive can never disagree.

use std::process::Command;

use crate::util::home;

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/report.mjs");

/// Launched from the desktop, PATH may not include ~/.local/bin, which is where node lives here.
fn node() -> String {
    let local = home().join(".local/bin/node");
    if local.exists() { local.to_string_lossy().into() } else { "node".into() }
}

fn run(hours: u32, save: bool) -> Result<String, String> {
    let mut cmd = Command::new(node());
    cmd.arg(SCRIPT).args(["--hours", &hours.to_string()]);
    if save {
        cmd.arg("--save");
    }
    let o = cmd.output().map_err(|e| format!("could not run node: {e}"))?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

/// The report as a standalone HTML page. Blocking work runs off the main thread: a first build
/// waits on a Haiku call for the summaries, and a sync command would freeze the window meanwhile.
#[tauri::command]
pub async fn work_report(hours: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run(hours, false))
        .await
        .map_err(|e| e.to_string())?
}

/// Save HTML + PDF to ~/.athena/reports and open the PDF. Returns the saved path.
#[tauri::command]
pub async fn export_report(hours: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = run(hours, true)?.trim().to_string();
        let _ = Command::new("xdg-open").arg(&path).spawn();
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())?
}
