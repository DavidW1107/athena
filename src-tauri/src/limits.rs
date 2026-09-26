// Subscription limits: the 5-hour and weekly windows of every Claude account plus Codex.
//
// Claude: the same endpoint `/usage` reads, called with each account's own OAuth token. Codex:
// every turn logs `rate_limits` into its session file, so the newest one is the current reading.
// Nothing here refreshes a token: Claude rotates the refresh token when it does that, and a copy
// refreshed behind its back would log the account out. An expired token shows as stale instead.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

use crate::accounts::accounts;
use crate::util::{home, now};

/// ponytail: one fetch per 5 min for the whole fleet; the endpoint is unofficial, so stay polite.
const TTL: u64 = 300;
/// An account this full is skipped by `accounts::choose` before it hits the wall.
pub const PREEMPT: f64 = 95.0;

#[derive(Serialize, Clone, Default)]
pub struct Window {
    pub pct: f64,
    /// Epoch seconds, or None while the window has not started.
    pub resets_at: Option<u64>,
}

#[derive(Serialize, Clone, Default)]
pub struct Limit {
    /// "a", "b", ... for Claude accounts, "codex" for Codex.
    pub name: String,
    pub five_hour: Option<Window>,
    pub weekly: Option<Window>,
    /// Why this row could not be refreshed; the windows then hold the last good reading.
    pub error: Option<String>,
    /// When the windows were read.
    pub at: u64,
}

struct Cache {
    rows: Vec<Limit>,
    at: u64,
    busy: bool,
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache { rows: vec![], at: 0, busy: false }))
}

/// The cached rows, kicking a background refresh when they are older than TTL. Never blocks.
pub fn snapshot() -> Vec<Limit> {
    let mut c = cache().lock().unwrap();
    if !c.busy && now().saturating_sub(c.at) >= TTL {
        c.busy = true;
        std::thread::spawn(refresh);
    }
    c.rows.clone()
}

fn refresh() {
    let prior = cache().lock().unwrap().rows.clone();
    let mut rows: Vec<Limit> = accounts().iter().map(|a| claude(a)).collect();
    rows.push(codex());
    // A failed read keeps the last good windows, so one expired token does not blank a row.
    for r in rows.iter_mut().filter(|r| r.error.is_some()) {
        if let Some(p) = prior.iter().find(|p| p.name == r.name) {
            r.five_hour = p.five_hour.clone();
            r.weekly = p.weekly.clone();
            r.at = p.at;
        }
    }
    let mut c = cache().lock().unwrap();
    c.rows = rows;
    c.at = now();
    c.busy = false;
}

/// True when a cached reading puts `acct` at or past PREEMPT in a window that has not reset yet.
pub fn nearly_out(acct: &str) -> bool {
    snapshot().iter().filter(|r| r.name == acct).any(|r| {
        [&r.five_hour, &r.weekly]
            .into_iter()
            .flatten()
            .any(|w| w.pct >= PREEMPT && w.resets_at.is_some_and(|t| t > now()))
    })
}

fn config_dir(acct: &str) -> PathBuf {
    if acct == "a" {
        home().join(".claude")
    } else {
        home().join(format!(".claude-{}", acct))
    }
}

fn claude(acct: &str) -> Limit {
    let mut out = Limit { name: acct.to_string(), at: now(), ..Default::default() };
    match claude_usage(acct) {
        Ok(v) => {
            out.five_hour = claude_window(&v["five_hour"]);
            out.weekly = claude_window(&v["seven_day"]);
        }
        Err(e) => out.error = Some(e),
    }
    out
}

fn claude_usage(acct: &str) -> Result<Value, String> {
    let creds = fs::read_to_string(config_dir(acct).join(".credentials.json")).map_err(|_| "not logged in")?;
    let token = serde_json::from_str::<Value>(&creds)
        .ok()
        .and_then(|v| v["claudeAiOauth"]["accessToken"].as_str().map(String::from))
        .ok_or("no OAuth token")?;
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("unexpected token format".into());
    }
    // The token goes in on stdin as curl config, never argv, so `ps` cannot show it.
    let mut child = Command::new("curl")
        .args(["-sS", "-m", "15", "-w", "\n%{http_code}", "-K", "-", "https://api.anthropic.com/api/oauth/usage"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("curl: {}", e))?;
    let cfg = format!(
        "header = \"Authorization: Bearer {}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\n",
        token
    );
    child.stdin.take().ok_or("curl stdin")?.write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&o.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or((&text, ""));
    match code {
        "200" => serde_json::from_str(body).map_err(|e| e.to_string()),
        "401" => Err("sign-in expired: open a claude on this account to refresh it".into()),
        "" | "000" => Err("offline".into()),
        c => Err(format!("HTTP {}", c)),
    }
}

fn claude_window(v: &Value) -> Option<Window> {
    let pct = v["utilization"].as_f64()?;
    let resets_at = v["resets_at"].as_str().and_then(iso_epoch);
    Some(Window { pct, resets_at })
}

/// "2026-09-29T01:59:59.829249+00:00" to epoch seconds. The endpoint always answers in UTC.
fn iso_epoch(s: &str) -> Option<u64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(s.ends_with("+00:00") || s.ends_with('Z')) {
        return None;
    }
    // Days from civil, Howard Hinnant's algorithm.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + h * 3600 + mi * 60 + se).ok()
}

fn codex() -> Limit {
    let mut out = Limit { name: "codex".into(), at: now(), ..Default::default() };
    let Some(rl) = newest_codex_limits() else {
        out.error = Some("no Codex session logged a limit yet".into());
        return out;
    };
    for key in ["primary", "secondary"] {
        let w = &rl[key];
        let (Some(pct), Some(mins)) = (w["used_percent"].as_f64(), w["window_minutes"].as_u64()) else { continue };
        let resets_at = w["resets_at"].as_u64();
        // A window that reset since the last Codex turn is empty now, whatever the log says.
        let pct = if resets_at.is_some_and(|t| t <= now()) { 0.0 } else { pct };
        let win = Some(Window { pct, resets_at: resets_at.filter(|t| *t > now()) });
        if mins <= 24 * 60 {
            out.five_hour = win;
        } else {
            out.weekly = win;
        }
    }
    out
}

/// `rate_limits` from the newest Codex session file that has one.
fn newest_codex_limits() -> Option<Value> {
    // sessions/YYYY/MM/DD/*.jsonl: descend newest-first so only today's few files are read.
    fn sorted(p: &PathBuf) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        v.sort();
        v.reverse();
        v
    }
    let mut files = vec![];
    'outer: for y in sorted(&home().join(".codex/sessions")) {
        for m in sorted(&y) {
            for d in sorted(&m) {
                let mut day: Vec<(std::time::SystemTime, PathBuf)> = sorted(&d)
                    .into_iter()
                    .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f)))
                    .collect();
                day.sort();
                day.reverse();
                files.extend(day.into_iter().map(|(_, f)| f));
                if files.len() >= 20 {
                    break 'outer;
                }
            }
        }
    }
    files.iter().find_map(|f| {
        let text = fs::read_to_string(f).ok()?;
        text.lines()
            .rev()
            .filter(|l| l.contains("\"rate_limits\""))
            .find_map(|l| {
                let v: Value = serde_json::from_str(l).ok()?;
                let rl = v["payload"]["rate_limits"].clone();
                rl.is_object().then_some(rl)
            })
    })
}

#[tauri::command]
pub fn account_limits() -> Vec<Limit> {
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_to_epoch() {
        assert_eq!(iso_epoch("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(iso_epoch("2026-09-29T01:59:59.829249+00:00"), Some(1790647199));
        assert_eq!(iso_epoch("2026-10-01T06:00:00Z"), Some(1790834400));
        assert_eq!(iso_epoch("2026-10-01T06:00:00+01:00"), None);
    }
}
