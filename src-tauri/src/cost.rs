// Context-burn meter. The plan is a subscription, so nothing here is priced in
// money: the only question worth answering is how full a session's context
// window is, i.e. which instance is about to need a compact.
//
// Reads the same ~/.claude/projects/<slug>/<session>.jsonl transcripts that
// sessions.rs already walks, reusing its project_slug().

use std::fs::File;
use std::io::{BufRead, BufReader};

use serde::Serialize;

use crate::sessions::project_slug;
use crate::util::home;

/// Context window per known model family, matched on the id prefix so a dated
/// build ("claude-opus-5-20260401") resolves like the bare family id. An id that
/// matches nothing yields None, and the UI then shows the raw token count with
/// no percentage rather than a percentage of the wrong denominator.
const CONTEXT_LIMITS: &[(&str, u64)] = &[
    ("claude-opus-5", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-fable", 1_000_000),
    ("claude-haiku-4-5", 200_000),
];

#[derive(Serialize, Clone)]
pub struct UsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub message_count: u64,
    pub model: String,
    /// Current window occupancy: the last usage record only, never a sum.
    pub context_tokens: u64,
    pub context_limit: Option<u64>,
}

/// Keep a local copy of a remote transcript in step, and answer with its path.
///
/// A transcript is append-only and reaches tens of megabytes, and the meter re-reads it on a timer,
/// so shipping the whole file every refresh would put that much over the cable each time for a few
/// hundred bytes of new data. Instead only the bytes past what we already hold are fetched
/// (`tail -c +N`) and appended to a mirror under ~/.athena/cache, and the existing parser then runs
/// on that mirror unchanged: one implementation of the token accounting, not two.
///
/// A remote file SHORTER than the mirror is not an append: the session was rewritten or the id was
/// reused, so the mirror is thrown away and refetched whole rather than parsed as a spliced file.
pub fn mirror_transcript(host: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    let local = crate::util::athena_dir().join("cache").join("transcripts").join(host).join(rel);
    if let Some(dir) = local.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not make the mirror directory: {}", e))?;
    }
    let remote = format!("$HOME/.claude/projects/{}", rel);
    let size_out = crate::hosts::run(Some(host), "sh", &["-c", &format!("stat -c %s \"{}\" 2>/dev/null || echo 0", remote)])
        .ok_or_else(|| format!("{} is not reachable", host))?;
    let remote_size: u64 = String::from_utf8_lossy(&size_out.stdout).trim().parse().unwrap_or(0);
    if remote_size == 0 {
        return Err(format!("no transcript for that session on {}", host));
    }
    let have = std::fs::metadata(&local).map(|m| m.len()).unwrap_or(0);
    if have > remote_size {
        let _ = std::fs::remove_file(&local);
    }
    let have = std::fs::metadata(&local).map(|m| m.len()).unwrap_or(0);
    if have == remote_size {
        return Ok(local);
    }
    let script = format!("tail -c +{} \"{}\"", have + 1, remote);
    let out = crate::hosts::run(Some(host), "sh", &["-c", &script])
        .ok_or_else(|| format!("{} is not reachable", host))?;
    if !out.status.success() {
        return Err(format!("could not read the transcript on {}", host));
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&local)
        .map_err(|e| format!("could not write the mirror: {}", e))?;
    f.write_all(&out.stdout).map_err(|e| format!("could not write the mirror: {}", e))?;
    Ok(local)
}

fn field(usage: &serde_json::Value, name: &str) -> u64 {
    usage.get(name).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Model ids can carry a variant suffix ("claude-opus-5[1m]"); the family is
/// everything before it.
fn normalise(model: &str) -> String {
    model.split('[').next().unwrap_or(model).trim().to_ascii_lowercase()
}

fn context_limit(model: &str) -> Option<u64> {
    let norm = normalise(model);
    let bare = format!("claude-{}", norm);
    CONTEXT_LIMITS
        .iter()
        .find(|(family, _)| {
            let dashed = format!("{}-", family);
            norm == *family
                || norm.starts_with(&dashed)
                || bare == *family
                || bare.starts_with(&dashed)
        })
        .map(|(_, limit)| *limit)
}

/// A session id is a bare file stem. Reject anything that could carry a path
/// component ('/', '.', '..') so a crafted id cannot read outside the project
/// transcript directory.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Token totals for one Claude Code session plus its current context occupancy.
///
/// Totals are summed over every assistant record that carries a usage object.
/// `context_tokens` is not a total: it is input + cache_read + cache_creation of
/// the newest usage record, which is what the model is actually holding now.
/// Malformed lines are skipped, so a truncated or partly written transcript
/// still reports the usage it does contain.
#[tauri::command]
pub fn session_usage(cwd: String, session_id: String, host: Option<String>) -> Result<UsageSummary, String> {
    if !valid_session_id(&session_id) {
        return Err(format!("not a session id: {}", session_id));
    }
    let rel = format!("{}/{}.jsonl", project_slug(&cwd), session_id);
    let path = match host.as_deref().filter(|h| !h.trim().is_empty()) {
        None => home().join(".claude").join("projects").join(&rel),
        Some(h) => mirror_transcript(h, &rel)?,
    };
    let file = File::open(&path)
        .map_err(|e| format!("could not read transcript {}: {}", path.display(), e))?;

    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut cache_creation_tokens: u64 = 0;
    let mut message_count: u64 = 0;
    let mut model = String::new();
    let mut context_tokens: u64 = 0;
    let mut last_msg_id = String::new();

    // filter_map, not map_while: one invalid-UTF-8 line must not truncate the
    // rest of the file and silently under-report every total after it.
    for line in BufReader::new(file).lines().filter_map(Result::ok) {
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        // Validate the usage object before touching any accumulator, so a
        // tool-only or stream-error record leaves the last known context size
        // (and model) standing instead of resetting it to zero.
        let usage = match value.pointer("/message/usage") {
            Some(u) if u.is_object() => u,
            _ => continue,
        };

        // Claude writes one API response as several assistant records when it interleaves
        // thinking, text and tool use, and repeats the SAME usage object on each of them.
        // Counting every copy inflates every total and the message count with it, so a record
        // that repeats the message id its predecessor carried is read for its context size only.
        let msg_id = value
            .pointer("/message/id")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        let repeat = !msg_id.is_empty() && msg_id == last_msg_id;
        last_msg_id = msg_id;

        if let Some(m) = value.pointer("/message/model").and_then(|m| m.as_str()) {
            model = m.to_string();
        }

        let line_input = field(usage, "input_tokens");
        let line_cache_read = field(usage, "cache_read_input_tokens");
        let line_cache_creation = field(usage, "cache_creation_input_tokens");

        if !repeat {
            message_count = message_count.saturating_add(1);
            input_tokens = input_tokens.saturating_add(line_input);
            output_tokens = output_tokens.saturating_add(field(usage, "output_tokens"));
            cache_read_tokens = cache_read_tokens.saturating_add(line_cache_read);
            cache_creation_tokens = cache_creation_tokens.saturating_add(line_cache_creation);
        }
        // Occupancy is the newest record's own numbers either way: a repeat carries the same
        // snapshot, and taking it again is harmless and keeps this the last word in the file.
        context_tokens = line_input
            .saturating_add(line_cache_read)
            .saturating_add(line_cache_creation);
    }

    Ok(UsageSummary {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        message_count,
        context_tokens,
        context_limit: context_limit(&model),
        model,
    })
}
