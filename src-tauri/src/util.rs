// Paths, clock, and /proc parsing. No Argus concepts live here, so every other
// module may depend on this one and nothing depends back.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

pub fn argus_dir() -> PathBuf {
    let d = home().join(".argus");
    let _ = fs::create_dir_all(d.join("state"));
    d
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Fields of /proc/<pid>/stat after the comm field, which itself may contain spaces.
pub fn proc_stat_fields(pid: i32) -> Option<Vec<String>> {
    let s = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    let rest = s.rsplit_once(')')?.1;
    Some(rest.split_whitespace().map(|x| x.to_string()).collect())
}
