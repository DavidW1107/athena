// Auto-pause: three independent rules that freeze an instance's cgroup and let it go
// again, plus the one safety rule this whole module exists for.
//
// A stopped process cannot service its own sockets, so an agent turn frozen mid-flight times
// its API call out and the turn is destroyed. On screen that is indistinguishable from a hang.
// So nothing whose hook state is `working` is ever stopped, whatever it is running, and
// anything that might be an agent CLI must additionally be POSITIVELY KNOWN to be sitting at
// `idle` or `needs-you`. Absence of a hook file is absence of evidence, never idleness: that is
// the permanent condition of a Codex instance, which nothing reports state for, so a Codex
// session is never a candidate for an automatic stop. That check is re-read from the hook file
// at the signal gate, never taken from the fleet snapshot the tick started with, because a tick
// that has just shelled out to tmux and read pbuild's ledger is already hundreds of
// milliseconds stale.
//
// Every pause goes through `registry::set_paused`, which freezes the pane's own cgroup. It never
// sends SIGSTOP; `tmux::set_frozen` records why (bash job control stranded every stopped agent).
//
// Ownership (which instance this module froze, and which rules are holding it) is persisted
// next to the config, the moment the freeze succeeds, with the pane pid and that pid's kernel
// start time. A pause therefore survives an Athena restart, and a recycled instance id cannot
// make a later thaw land on a different pane.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::lanes::pbuild_status;
use crate::registry::{read_reg, read_state, set_paused, Instance};
use crate::tmux::sess_name;
use crate::util::{athena_dir, home, now, proc_stat_fields};

const MEMORY: &str = "memory";
const CPU: &str = "cpu";
const WAITING: &str = "waiting";
const BLOCKED: &str = "blocked";

/// pbuild's own status ledger: one file per shard holding one of PBUILD_STATES.
const PBUILD_RUNS: &str = ".local/state/mtmn-parallel/runs";
const PBUILD_STATES: [&str; 4] = ["pending", "running", "done", "failed"];

// ---------------------------------------------------------------- rule config

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WaitTag {
    pub id: String,
    pub run: String,
    pub shard: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Rules {
    pub memory_enabled: bool,
    /// `some avg10` from /proc/pressure/memory, in percent. Strictly above pauses; strictly
    /// below counts towards the calm streak; exactly equal is neither.
    pub memory_threshold: f64,
    pub cpu_enabled: bool,
    /// `some avg10` from /proc/pressure/cpu, in percent. Read exactly like the memory
    /// threshold. Defaults to 60 to agree with pbuild's own `PBUILD_CPU_PAUSE`, so the two
    /// guards do not disagree about what a busy machine is.
    pub cpu_threshold: f64,
    pub waiting_enabled: bool,
    pub waiting_tags: Vec<WaitTag>,
    pub blocked_enabled: bool,
    /// Minutes at `needs-you` before an instance is parked. f64 rather than an integer type so
    /// a UI that hands back `20.0` still deserializes instead of failing the entire tick.
    pub blocked_minutes: f64,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            memory_enabled: true,
            memory_threshold: 70.0,
            cpu_enabled: true,
            cpu_threshold: 60.0,
            waiting_enabled: true,
            waiting_tags: Vec::new(),
            // Off by default: parking a session that is waiting on the user is the one rule
            // whose effect the user did not ask for by launching anything.
            blocked_enabled: false,
            blocked_minutes: 20.0,
        }
    }
}

impl Rules {
    /// Clamp anything a hand-edited config or a stray keystroke could put out of range, and
    /// drop tags that cannot be used to build a ledger path.
    fn sane(mut self) -> Self {
        if !self.memory_threshold.is_finite() {
            self.memory_threshold = 70.0;
        }
        self.memory_threshold = self.memory_threshold.clamp(5.0, 100.0);
        if !self.cpu_threshold.is_finite() {
            self.cpu_threshold = 60.0;
        }
        self.cpu_threshold = self.cpu_threshold.clamp(5.0, 100.0);
        if !self.blocked_minutes.is_finite() {
            self.blocked_minutes = 20.0;
        }
        self.blocked_minutes = self.blocked_minutes.clamp(1.0, 1440.0);
        self.waiting_tags.retain(|t| {
            safe_component(&t.id).is_some()
                && safe_component(&t.run).is_some()
                && safe_component(&t.shard).is_some()
        });
        self
    }
}

fn cfg_path() -> PathBuf {
    athena_dir().join("autopause.json")
}

pub fn read_rules() -> Rules {
    fs::read_to_string(cfg_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Rules>(&s).ok())
        .unwrap_or_default()
        .sane()
}

// ---------------------------------------------------------------- ownership

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Owned {
    /// Every rule currently holding this instance down. The process starts again only when
    /// this set is empty, so two rules can never resume each other's pause.
    reasons: BTreeSet<String>,
    pane_pid: i32,
    /// /proc/<pane_pid>/stat starttime. Same pid plus same start time is the same process.
    pane_start: u64,
    since: u64,
    /// A resume that did not take. The entry is kept so the next tick tries again rather than
    /// leaving a job frozen with nothing left to unfreeze it.
    resume_pending: bool,
}

type OwnedMap = BTreeMap<String, Owned>;

fn owned_path() -> PathBuf {
    athena_dir().join("autopause-owned.json")
}

fn read_owned() -> OwnedMap {
    fs::read_to_string(owned_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_owned(m: &OwnedMap) {
    if let Ok(s) = serde_json::to_string_pretty(m) {
        let _ = fs::write(owned_path(), s);
    }
}

// ---------------------------------------------------------------- report shape

#[derive(Serialize, Clone, Debug)]
pub struct Action {
    pub id: String,
    pub name: String,
    /// memory | waiting | blocked | none
    pub rule: String,
    /// paused | resumed | skipped | notice | error
    pub kind: String,
    pub reason: String,
    pub ts: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct HeldView {
    pub id: String,
    pub name: String,
    pub reasons: Vec<String>,
    pub since: u64,
    pub resume_pending: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct TickReport {
    /// None when PSI is not readable on this kernel.
    pub psi: Option<f64>,
    pub threshold: f64,
    /// Consecutive samples strictly below the threshold. Two of them release a memory pause.
    pub calm: u32,
    pub high: bool,
    pub held: Vec<HeldView>,
    /// What it did and what it would have done: `skipped` and `notice` entries carry the
    /// reason no signal was sent, which is the only way the UI can explain itself.
    pub actions: Vec<Action>,
}

fn name_of(names: &HashMap<String, String>, id: &str) -> String {
    names.get(id).cloned().unwrap_or_else(|| id.to_string())
}

fn act(id: &str, name: &str, rule: &str, kind: &str, reason: impl Into<String>) -> Action {
    Action {
        id: id.to_string(),
        name: name.to_string(),
        rule: rule.to_string(),
        kind: kind.to_string(),
        reason: reason.into(),
        ts: now(),
    }
}

// ---------------------------------------------------------------- shared state

/// Ticks never overlap: one signal decision at a time, so two evaluations cannot both decide
/// to stop the same pane.
static TICK: Mutex<()> = Mutex::new(());
/// The selected instance, pushed by the UI the moment selection moves rather than carried as
/// an argument. The signal gate reads this, so a click that lands mid-tick still protects.
static SELECTED: Mutex<Option<String>> = Mutex::new(None);
/// Consecutive calm samples. Process-local on purpose: after a restart the count begins again
/// at zero, which only ever delays a resume by one tick.
/// Calm streaks keyed by rule and machine: "memory@desk", "cpu@" for this laptop. One counter per
/// machine, because a resume must be justified by the pressure of the machine being resumed on.
static STREAKS: std::sync::OnceLock<Mutex<HashMap<String, u32>>> = std::sync::OnceLock::new();

fn streak_key(rule: &str, host: Option<&str>) -> String {
    format!("{}@{}", rule, host.unwrap_or(""))
}

fn streak_get(key: &str) -> u32 {
    STREAKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|m| m.get(key).copied().unwrap_or(0))
        .unwrap_or(0)
}

fn streak_set(key: &str, v: u32) {
    if let Ok(mut m) = STREAKS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        m.insert(key.to_string(), v);
    }
}
/// The same, for the CPU rule. Separate so a calm CPU never resumes a memory pause.

fn selected_now() -> Option<String> {
    SELECTED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---------------------------------------------------------------- probes

/// `some avg10` from /proc/pressure/<res>: the share of the last ten seconds in which at
/// least one task stalled on that resource. None when PSI is absent or unreadable.
///
/// Read per machine. Pressure is a property of one kernel, so this laptop's memory being tight
/// says nothing about the desktop's and must never pause work there; each machine's own figure
/// governs its own instances.
fn psi_avg10_on(host: crate::hosts::Host, res: &str) -> Option<f64> {
    let text = crate::hosts::read_file(host, &format!("/proc/pressure/{}", res))?;
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("some ") else { continue };
        for field in rest.split_whitespace() {
            if let Some(v) = field.strip_prefix("avg10=") {
                return v.parse::<f64>().ok().filter(|x| x.is_finite());
            }
        }
    }
    None
}

/// Kernel start time of a pid (field 22 of /proc/<pid>/stat, index 19 after comm). Together
/// with the pid it identifies one process across restarts and pid reuse. Per machine, because a
/// pid only means anything on the kernel that issued it.
fn proc_start_on(host: crate::hosts::Host, pid: i32) -> Option<u64> {
    match host {
        None => proc_stat_fields(pid)?.get(19)?.parse().ok(),
        Some(_) => {
            // Same field, read over ssh. The comm field can contain spaces and brackets, so the
            // split is after the LAST ')', exactly as util::proc_stat_fields does locally.
            let text = crate::hosts::read_file(host, &format!("/proc/{}/stat", pid))?;
            text.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
        }
    }
}

/// A path component that is safe to join and unambiguous to compare: no separators, no dot
/// segments, no control characters, not empty.
fn safe_component(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() || t == "." || t == ".." {
        return None;
    }
    if t.contains('/') || t.contains('\\') || t.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(t)
}

fn is_pbuild_state(s: &str) -> bool {
    PBUILD_STATES.contains(&s)
}

/// The status of one pbuild shard, as one of pending/running/done/failed.
///
/// Read from pbuild's status ledger, `~/.local/state/mtmn-parallel/runs/<run>/status/<shard>`,
/// which holds exactly one of those words. The `pbuild status` subcommand cannot be used to
/// ask the question: it takes a state argument and WRITES it, so calling it would set the
/// shard's status rather than report it. The ledger file is what that subcommand writes and
/// what `pbuild wait` reads, so it is the same source of truth.
///
/// Fallback for a machine whose ledger sits elsewhere: the foundation's `lanes::pbuild_status`
/// (`pbuild ls`), parsed structurally rather than by substring.
fn shard_status(run: &str, shard: &str) -> Option<String> {
    let run = safe_component(run)?;
    let shard = safe_component(shard)?;
    let ledger = home().join(PBUILD_RUNS).join(run).join("status").join(shard);
    if let Ok(raw) = fs::read_to_string(&ledger) {
        let state = raw.trim();
        if is_pbuild_state(state) {
            return Some(state.to_string());
        }
    }
    status_from_ls(&pbuild_status(), run, shard)
}

/// Structural parse of `pbuild ls`. A run heading is an unindented `run <id>  <repo>`; each of
/// that run's shards is an indented `<state> <shard>` pair. Every field is compared whole, so
/// `run1` never matches `run10` and a status of `not done` never reads as `done`.
fn status_from_ls(text: &str, run: &str, shard: &str) -> Option<String> {
    let mut current: Option<&str> = None;
    for line in text.lines() {
        let indented = line.starts_with(|c: char| c.is_whitespace());
        let mut f = line.split_whitespace();
        if !indented {
            current = match (f.next(), f.next()) {
                (Some("run"), Some(id)) => Some(id),
                _ => None,
            };
            continue;
        }
        if current != Some(run) {
            continue;
        }
        if let (Some(state), Some(name), None) = (f.next(), f.next(), f.next()) {
            if name == shard && is_pbuild_state(state) {
                return Some(state.to_string());
            }
        }
    }
    None
}

fn basename(token: &str) -> &str {
    token.rsplit('/').next().unwrap_or(token)
}

/// True when any token of the command line names an interactive agent CLI, however it was
/// invoked: `claude`, `/usr/bin/claude`, `env claude --continue`, `npx claude`, `codex`,
/// `sh -lc "cd x && claude"`. Deliberately over-inclusive; a false positive only makes the
/// safety gate stricter, while a false negative would let a live turn be stopped.
///
/// Codex belongs here as much as Claude does. It is a first-class workload in this app and it
/// makes the same long API calls, so it needs the same protection, even though nothing reports
/// its state (see `stoppable`).
fn looks_like_agent(cmd: &str) -> bool {
    cmd.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | ';' | '&' | '|' | '(' | ')' | '`' | '=')
    })
    .filter(|t| !t.is_empty())
    .any(|t| matches!(basename(t), "claude" | "claude-code" | "codex"))
}

/// The safety gate, and the reason this module exists.
///
/// A stopped process cannot service its own sockets, so freezing an agent mid-turn times its
/// API call out and destroys the turn. Nothing reporting `working` is ever stopped, and an
/// agent must additionally be **positively known** to be parked at `idle` or `needs-you`.
///
/// `hook` is `None` when no hook file exists: nobody has reported anything about this instance.
/// That is not idleness, it is absence of evidence, and it is the normal permanent condition
/// for Codex, which has no hook equivalent. Treating it as idle is what would let a live Codex
/// turn be frozen, so an agent with no signal is never stoppable. A build or a shell has no
/// turn to destroy and needs no signal.
fn stoppable(cmd: &str, hook: Option<&str>) -> bool {
    if hook == Some("working") {
        return false;
    }
    if looks_like_agent(cmd) {
        return matches!(hook, Some("idle") | Some("needs-you"));
    }
    true
}

/// Why the gate refused, in words the log can show the user.
fn refusal(cmd: &str, hook: Option<&str>) -> String {
    match hook {
        Some("working") => "mid-turn; stopping it would time out the live API call".to_string(),
        None if looks_like_agent(cmd) => {
            "nothing reports this agent's state, so it cannot be shown to be idle; refusing to \
             risk a live API call"
                .to_string()
        }
        Some(state) => format!("state is {}; only an idle or waiting agent may be stopped", state),
        None => "no state signal".to_string(),
    }
}

struct Live {
    pane: i32,
    stopped: bool,
    /// None means no hook file at all, which is never treated as idle. See `stoppable`.
    hook: Option<String>,
}

/// Everything that can move between the start of a tick and a signal, read fresh.
fn probe(id: &str) -> Option<Live> {
    let host = crate::registry::instance_host(id);
    let hostref = host.as_deref();
    let pane = crate::tmux::pane_map_on(hostref).get(&sess_name(id)).copied()?;
    Some(Live { pane, stopped: crate::tmux::is_frozen_on(hostref, pane), hook: state_of(id, hostref).state })
}

/// Hook state for one instance, from the machine whose hook writes it.
fn state_of(id: &str, host: crate::hosts::Host) -> crate::registry::HookState {
    match host {
        None => read_state(id),
        Some(h) => crate::registry::states_for(h).get(id).cloned().unwrap_or_default(),
    }
}

// ---------------------------------------------------------------- signalling

/// Stop one instance on behalf of one rule. Selection, liveness and the hook state are all
/// re-read here, immediately before the signal, so an instance that became busy or got clicked
/// while this tick was running is left alone.
#[allow(clippy::too_many_arguments)]
fn commit_pause(
    id: &str,
    rule: &str,
    why: &str,
    names: &HashMap<String, String>,
    cmds: &HashMap<String, String>,
    owned: &mut OwnedMap,
    out: &mut Vec<Action>,
) {
    let name = name_of(names, id);
    let cmd = cmds.get(id).cloned().unwrap_or_default();

    if selected_now().as_deref() == Some(id) {
        out.push(act(id, &name, rule, "skipped", "you have it selected"));
        return;
    }
    let Some(live) = probe(id) else {
        out.push(act(id, &name, rule, "skipped", "no live tmux pane"));
        return;
    };
    if !stoppable(&cmd, live.hook.as_deref()) {
        out.push(act(id, &name, rule, "skipped", refusal(&cmd, live.hook.as_deref())));
        return;
    }
    if live.stopped && !owned.contains_key(id) {
        out.push(act(id, &name, rule, "skipped", "already paused by hand; leaving that alone"));
        return;
    }

    let mut e = owned.remove(id).unwrap_or_default();
    let fresh = e.reasons.insert(rule.to_string());
    e.resume_pending = false;

    if live.stopped {
        // Already frozen by an earlier rule of ours: adopt the extra reason, send nothing.
        e.pane_pid = live.pane;
        e.pane_start = proc_start_on(crate::registry::instance_host(id).as_deref(), live.pane).unwrap_or(e.pane_start);
        if e.since == 0 {
            e.since = now();
        }
        if fresh {
            out.push(act(id, &name, rule, "paused", format!("{} (already stopped)", why)));
        }
        owned.insert(id.to_string(), e);
        return;
    }

    match set_paused(id.to_string(), true) {
        Ok(()) => {
            e.pane_pid = live.pane;
            e.pane_start = proc_start_on(crate::registry::instance_host(id).as_deref(), live.pane).unwrap_or(0);
            // Persist immediately rather than at the end of the tick: a crash between the freeze
            // and the write would otherwise leave a frozen pane that the next run reads as paused
            // by hand and never releases.
            e.since = now();
            owned.insert(id.to_string(), e);
            write_owned(owned);
            out.push(act(id, &name, rule, "paused", why));
        }
        Err(err) => {
            // Nothing was frozen, so nothing is owned on account of this rule.
            e.reasons.remove(rule);
            if !e.reasons.is_empty() {
                owned.insert(id.to_string(), e);
            }
            out.push(act(id, &name, rule, "error", format!("could not stop it: {}", err)));
        }
    }
}

/// Thaw an instance. Returns true when ownership may be forgotten.
///
/// The thaw is always sent, even to a pane that reads as running: writing 0 to a thawed cgroup
/// is a no-op, and skipping a resume on a misread is how earlier versions stranded a job. A pane
/// replaced by a different process was already dropped by the generation check in the tick.
fn try_resume(id: &str, name: &str, e: &mut Owned, out: &mut Vec<Action>) -> bool {
    let host = crate::registry::instance_host(id);
    if !crate::tmux::pane_map_on(host.as_deref()).contains_key(&sess_name(id)) {
        out.push(act(id, name, "none", "notice", "process is gone; pause forgotten"));
        return true;
    }
    match set_paused(id.to_string(), false) {
        Ok(()) => {
            out.push(act(id, name, "none", "resumed", "no rule holds it any more"));
            true
        }
        Err(err) => {
            e.resume_pending = true;
            out.push(act(id, name, "none", "error", format!("could not resume it: {}; retrying", err)));
            false
        }
    }
}

// ---------------------------------------------------------------- memory candidate

enum Pick {
    Take(String),
    /// Pressure is high and there were candidates, but not one of them could be shown to be
    /// safely stoppable: mid-turn, or an agent nothing reports state for.
    AllMidTurn,
    Nothing,
}

/// One victim per tick: a build or a shell before a parked Claude, and the longest-idle first
/// inside each of those bands. Everything chosen here is revalidated by `commit_pause`.
fn pressure_candidate(
    reg: &[Instance],
    panes: &HashMap<String, i32>,
    owned: &OwnedMap,
    selected: Option<&str>,
    rule: &str,
    host: crate::hosts::Host,
) -> Pick {
    let mut mid_turn = false;
    let mut cands: Vec<(u8, u64, String)> = Vec::new();
    for inst in reg {
        // Only this machine's instances: pausing a desktop agent would do nothing for pressure
        // here, and the pane pids in `panes` belong to one kernel anyway.
        if inst.host.as_deref() != host {
            continue;
        }
        if selected == Some(inst.id.as_str()) {
            continue;
        }
        if owned.get(&inst.id).map(|e| e.reasons.contains(rule)).unwrap_or(false) {
            continue;
        }
        let Some(pane) = panes.get(&sess_name(&inst.id)).copied() else { continue };
        if crate::tmux::is_frozen_on(host, pane) {
            continue;
        }
        let hs = state_of(&inst.id, host);
        if !stoppable(&inst.cmd, hs.state.as_deref()) {
            mid_turn = true;
            continue;
        }
        let idle = now().saturating_sub(hs.ts.unwrap_or_else(now));
        let band = if looks_like_agent(&inst.cmd) { 1 } else { 0 };
        cands.push((band, idle, inst.id.clone()));
    }
    cands.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    match cands.into_iter().next() {
        Some((_, _, id)) => Pick::Take(id),
        None if mid_turn => Pick::AllMidTurn,
        None => Pick::Nothing,
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn autopause_config() -> Rules {
    read_rules()
}

#[tauri::command]
pub fn autopause_save(rules: Rules) -> Result<Rules, String> {
    let rules = rules.sane();
    let text = serde_json::to_string_pretty(&rules).map_err(|e| e.to_string())?;
    fs::write(cfg_path(), text).map_err(|e| e.to_string())?;
    Ok(rules)
}

/// The UI pushes selection here the instant it changes, outside the tick. That makes selection
/// authoritative at the signal gate instead of a snapshot taken before the tick began.
#[tauri::command]
pub fn autopause_select(id: Option<String>) {
    *SELECTED.lock().unwrap_or_else(|e| e.into_inner()) = id.filter(|s| !s.is_empty());
}

/// One pressure rule, for one resource, on one machine.
///
/// Only a successful sample strictly below the threshold extends the calm streak; an unreadable
/// sample, a sample exactly at the threshold and a disabled rule all reset it, so two
/// nonconsecutive dips can never add up to a resume. Two calm samples, or no pressure signal at
/// all, release the hold: with nothing left to justify it, holding a job down indefinitely is the
/// worse failure.
#[allow(clippy::too_many_arguments)]
fn pressure_rule(
    rule: &str,
    resource: &str,
    enabled: bool,
    threshold: f64,
    midturn_note: &str,
    host: crate::hosts::Host,
    reg: &[Instance],
    panes: &HashMap<String, i32>,
    owned: &mut OwnedMap,
    names: &HashMap<String, String>,
    cmds: &HashMap<String, String>,
    selected: Option<&str>,
    out: &mut Vec<Action>,
) {
    // Every notice names the machine once there is more than one, so a log line cannot be read as
    // being about the wrong computer.
    let where_ = host.map(|h| format!(" on {}", h)).unwrap_or_default();
    let psi = psi_avg10_on(host, resource);
    let key = streak_key(rule, host);
    let mut calm = streak_get(&key);
    let mut high = false;
    if !enabled {
        calm = 0;
    } else {
        match psi {
            None => {
                calm = 0;
                out.push(act("", "", rule, "notice", format!("/proc/pressure/{} unreadable{}; rule idle this tick", resource, where_)));
            }
            Some(v) if v > threshold => {
                calm = 0;
                high = true;
            }
            Some(v) if v < threshold => calm = calm.saturating_add(1),
            Some(_) => calm = 0,
        }
    }
    streak_set(&key, calm);

    if high {
        let head = format!("{} pressure {:.0}% over {:.0}%{}", resource, psi.unwrap_or(0.0), threshold, where_);
        match pressure_candidate(reg, panes, owned, selected, rule, host) {
            Pick::Take(id) => commit_pause(&id, rule, &head, names, cmds, owned, out),
            Pick::AllMidTurn => out.push(act(
                "",
                "",
                rule,
                "notice",
                format!("{}, {}; stopping one could kill a live API call, so nothing was paused", head, midturn_note),
            )),
            Pick::Nothing => out.push(act("", "", rule, "notice", format!("{}, nothing left to pause", head))),
        }
    } else if enabled && (calm >= 2 || psi.is_none()) {
        let why = if psi.is_none() {
            format!("no pressure signal{}; not holding anything on {} grounds", where_, resource)
        } else {
            format!("{} pressure back under the threshold for two ticks{}", resource, where_)
        };
        // Only this machine's holds are released, so a calm laptop cannot thaw an agent the
        // desktop is still holding down.
        let on_host: std::collections::HashSet<&str> = reg
            .iter()
            .filter(|i| i.host.as_deref() == host)
            .map(|i| i.id.as_str())
            .collect();
        for (id, e) in owned.iter_mut() {
            if on_host.contains(id.as_str()) && e.reasons.remove(rule) {
                let label = name_of(names, id);
                out.push(act(id, &label, rule, "notice", why.clone()));
            }
        }
    }
}

/// Evaluate the three rules once and act. Order matters: reconcile ownership, release reasons
/// whose condition has gone, evaluate each enabled rule, then resume anything left holding no
/// reason at all.
#[tauri::command]
pub fn autopause_tick(rules: Rules) -> TickReport {
    let _tick = TICK.lock().unwrap_or_else(|e| e.into_inner());
    let rules = rules.sane();
    let mut owned = read_owned();
    let mut out: Vec<Action> = Vec::new();

    let reg = read_reg();
    let names: HashMap<String, String> =
        reg.iter().map(|i| (i.id.clone(), i.name.clone())).collect();
    let cmds: HashMap<String, String> = reg.iter().map(|i| (i.id.clone(), i.cmd.clone())).collect();
    // One pane map per machine in the fleet; a pid is only meaningful on the kernel that issued it.
    let hosts_in_use: Vec<Option<String>> = {
        let mut v: Vec<Option<String>> = reg.iter().map(|i| i.host.clone()).collect();
        v.push(None);
        v.sort();
        v.dedup();
        v
    };
    let panes_by_host = crate::tmux::pane_maps(&hosts_in_use);
    let host_of: HashMap<String, Option<String>> =
        reg.iter().map(|i| (i.id.clone(), i.host.clone())).collect();
    let selected = selected_now();

    // --- 1. generation reconcile. An entry survives only while the exact process it froze
    // does, so a restarted session or a recycled instance id can never be signalled by proxy.
    for id in owned.keys().cloned().collect::<Vec<_>>() {
        let e = owned[&id].clone();
        let h = host_of.get(&id).cloned().flatten();
        let gone = match panes_by_host.get(&h).and_then(|m| m.get(&sess_name(&id))).copied() {
            None => true,
            Some(pid) => {
                pid != e.pane_pid
                    || (e.pane_start != 0
                        && proc_start_on(h.as_deref(), pid).map(|s| s != e.pane_start).unwrap_or(false))
            }
        };
        if gone || !names.contains_key(&id) {
            owned.remove(&id);
            let label = name_of(&names, &id);
            out.push(act(&id, &label, "none", "notice", "that process is gone; pause forgotten"));
        }
    }

    // --- 2. release. A reason lives exactly as long as its condition: turning a rule off,
    // clearing a tag, a shard finishing or selecting a parked instance all drop it here, so
    // nothing is left frozen by a rule that no longer applies.
    for (id, e) in owned.iter_mut() {
        let label = name_of(&names, id);
        if !rules.memory_enabled && e.reasons.remove(MEMORY) {
            out.push(act(id, &label, MEMORY, "notice", "memory rule switched off"));
        }
        if e.reasons.contains(WAITING) {
            let release = if !rules.waiting_enabled {
                Some("waiting rule switched off".to_string())
            } else {
                match rules.waiting_tags.iter().find(|t| t.id.as_str() == id.as_str()) {
                    None => Some("waiting tag cleared".to_string()),
                    Some(t) => match shard_status(&t.run, &t.shard).as_deref() {
                        Some("done") => Some(format!("{}:{} reported done", t.run, t.shard)),
                        Some("failed") => Some(format!("{}:{} failed; not holding it any longer", t.run, t.shard)),
                        _ => None,
                    },
                }
            };
            if let Some(why) = release {
                e.reasons.remove(WAITING);
                out.push(act(id, &label, WAITING, "notice", why));
            }
        }
        if e.reasons.contains(BLOCKED) {
            let release = if !rules.blocked_enabled {
                Some("blocked rule switched off".to_string())
            } else if selected.as_deref() == Some(id.as_str()) {
                Some("you selected it".to_string())
            } else {
                None
            };
            if let Some(why) = release {
                e.reasons.remove(BLOCKED);
                out.push(act(id, &label, BLOCKED, "notice", why));
            }
        }
    }

    // --- 3. pressure, per resource and per machine.
    //
    // Memory and cpu are evaluated independently because the two go tight independently: a machine
    // can be pegged on CPU while memory PSI sits at zero, which is exactly what happened on
    // 2026-09-06 (cpu 82%, memory 0.00%) when memory was the only pressure rule and so saw a
    // perfectly calm machine. They share one implementation but never share a streak, a threshold
    // or a switch.
    //
    // Per machine, because pressure belongs to a kernel: this laptop being tight is no reason to
    // freeze an agent on the desktop, and freezing one there would not give this laptop any room.
    //
    // Neither rule can stop a session that is mid-turn - `stoppable` refuses anything `working` -
    // and that is the correct trade, since a frozen agent loses its API call. So they only ever
    // park genuinely idle instances to give the busy ones room. A second layer, not the fix for a
    // session spawning duplicate jobs; the PreToolUse duplicate guard is that.
    for host in &hosts_in_use {
        let hr = host.as_deref();
        let empty = HashMap::new();
        let host_panes = panes_by_host.get(host).unwrap_or(&empty);
        pressure_rule(
            MEMORY, "memory", rules.memory_enabled, rules.memory_threshold,
            "but no candidate can be shown to be safely idle",
            hr, &reg, host_panes, &mut owned, &names, &cmds, selected.as_deref(), &mut out,
        );
        pressure_rule(
            CPU, "cpu", rules.cpu_enabled, rules.cpu_threshold,
            "but every candidate is mid-turn",
            hr, &reg, host_panes, &mut owned, &names, &cmds, selected.as_deref(), &mut out,
        );
    }

    // --- 4. waiting on another run's shard.
    if rules.waiting_enabled {
        for t in &rules.waiting_tags {
            if !names.contains_key(&t.id) {
                continue;
            }
            match shard_status(&t.run, &t.shard).as_deref() {
                Some("done") | Some("failed") => {} // released above
                Some(state) => commit_pause(
                    &t.id,
                    WAITING,
                    &format!("waiting on {}:{} ({})", t.run, t.shard, state),
                    &names,
                    &cmds,
                    &mut owned,
                    &mut out,
                ),
                None => out.push(act(
                    &t.id,
                    &name_of(&names, &t.id),
                    WAITING,
                    "notice",
                    format!("{}:{} has no status in pbuild's ledger; not pausing on a guess", t.run, t.shard),
                )),
            }
        }
    }

    // --- 5. blocked on the user for too long.
    if rules.blocked_enabled {
        let cutoff = (rules.blocked_minutes * 60.0).max(60.0) as u64;
        for inst in &reg {
            if selected.as_deref() == Some(inst.id.as_str()) {
                continue;
            }
            let hr = inst.host.as_deref();
            let Some(pane) = panes_by_host.get(&inst.host).and_then(|m| m.get(&sess_name(&inst.id))).copied() else { continue };
            if crate::tmux::is_frozen_on(hr, pane) {
                continue;
            }
            let hs = state_of(&inst.id, hr);
            if hs.state.as_deref() != Some("needs-you") {
                continue;
            }
            let waited = now().saturating_sub(hs.ts.unwrap_or_else(now));
            if waited < cutoff {
                continue;
            }
            commit_pause(
                &inst.id,
                BLOCKED,
                &format!("waiting on you for {} min", waited / 60),
                &names,
                &cmds,
                &mut owned,
                &mut out,
            );
        }
    }

    // --- 6. resume everything no rule holds any more, plus retries of resumes that did not
    // take on an earlier tick.
    for id in owned.keys().cloned().collect::<Vec<_>>() {
        let Some(mut e) = owned.remove(&id) else { continue };
        if !e.reasons.is_empty() {
            owned.insert(id, e);
            continue;
        }
        let label = name_of(&names, &id);
        if !try_resume(&id, &label, &mut e, &mut out) {
            owned.insert(id, e);
        }
    }

    write_owned(&owned);

    let held = owned
        .iter()
        .map(|(id, e)| HeldView {
            id: id.clone(),
            name: name_of(&names, id),
            reasons: e.reasons.iter().cloned().collect(),
            since: e.since,
            resume_pending: e.resume_pending,
        })
        .collect();

    // The header shows ONE pressure figure and has always meant "this machine". Remote pressure is
    // not hidden: every action line from a remote rule names its host.
    let psi = psi_avg10_on(None, "memory");
    let calm = streak_get(&streak_key(MEMORY, None));
    let high = psi.map(|v| v > rules.memory_threshold).unwrap_or(false);
    TickReport { psi, threshold: rules.memory_threshold, calm, high, held, actions: out }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_turn_is_never_stoppable() {
        assert!(!stoppable("claude", Some("working")));
        assert!(!stoppable("codex", Some("working")));
        assert!(!stoppable("claude --continue", Some("dead")));
        assert!(stoppable("claude", Some("idle")));
        assert!(stoppable("claude", Some("needs-you")));
        assert!(stoppable("npm run build", Some("idle")));
    }

    #[test]
    fn an_agent_nothing_reports_on_is_never_stoppable() {
        // Codex has no hook, so its state is permanently unknown. Unknown is not idle: a
        // stopped Codex loses the API call it was waiting on.
        assert!(!stoppable("codex", None));
        assert!(!stoppable("claude", None));
        // A build or a shell has no turn to destroy, so no signal is needed to stop it.
        assert!(stoppable("npm run build", None));
        assert!(stoppable("bash", None));
    }

    #[test]
    fn agents_are_recognised_through_wrappers() {
        for cmd in [
            "claude",
            "/usr/bin/claude",
            "env claude --continue",
            "npx claude",
            "sh -lc 'cd x && claude'",
            "codex",
            "/usr/local/bin/codex",
        ] {
            assert!(looks_like_agent(cmd), "{}", cmd);
        }
        for cmd in ["bash", "npm run build", "claudette", "codexify"] {
            assert!(!looks_like_agent(cmd), "{}", cmd);
        }
    }

    #[test]
    fn ls_is_matched_field_by_field() {
        let text = "memory: 20G available\npressure: OK\n  admitted  shard-a  6G  pid 42\n\nrun run1  /repo\n  done      panes\n  running   cost\n\nrun run10  /repo\n  pending   panes\n";
        assert_eq!(status_from_ls(text, "run1", "panes").as_deref(), Some("done"));
        assert_eq!(status_from_ls(text, "run1", "cost").as_deref(), Some("running"));
        assert_eq!(status_from_ls(text, "run10", "panes").as_deref(), Some("pending"));
        assert_eq!(status_from_ls(text, "run1", "pane"), None);
        assert_eq!(status_from_ls(text, "run2", "panes"), None);
        assert_eq!(status_from_ls("run r  /repo\n  not done  panes\n", "r", "panes"), None);
    }

    #[test]
    fn the_cpu_rule_is_configured_independently_of_memory() {
        // The 2026-09-06 incident: cpu pegged, memory calm. A single shared threshold would
        // have had to read one of those two numbers, and either choice misses one incident.
        let r = Rules::default();
        assert!(r.cpu_enabled);
        assert_eq!(r.cpu_threshold, 60.0);
        assert_ne!(r.cpu_threshold, r.memory_threshold);

        // A hand-edited config cannot put either threshold out of range or make it NaN.
        let bad = Rules { cpu_threshold: f64::NAN, memory_threshold: 900.0, ..Rules::default() }.sane();
        assert_eq!(bad.cpu_threshold, 60.0);
        assert_eq!(bad.memory_threshold, 100.0);
        let low = Rules { cpu_threshold: -5.0, ..Rules::default() }.sane();
        assert_eq!(low.cpu_threshold, 5.0);
    }

    #[test]
    fn psi_is_read_per_resource() {
        // Both files exist on this kernel; the point is that they are read separately and can
        // disagree, which is the whole reason the cpu rule exists.
        for res in ["cpu", "memory"] {
            if let Some(v) = psi_avg10_on(None, res) {
                assert!(v.is_finite() && v >= 0.0, "{} gave {}", res, v);
            }
        }
        assert_eq!(psi_avg10_on(None, "no-such-resource"), None);
    }

    #[test]
    fn a_streak_is_per_rule_and_per_machine() {
        // Four independent counters, not one: a calm laptop must not release a hold the desktop
        // still justifies, and calm memory must not release a cpu hold.
        for (rule, host) in [("memory", None), ("memory", Some("desk")), ("cpu", None), ("cpu", Some("desk"))] {
            streak_set(&streak_key(rule, host), 0);
        }
        streak_set(&streak_key("memory", Some("desk")), 7);
        assert_eq!(streak_get(&streak_key("memory", Some("desk"))), 7);
        assert_eq!(streak_get(&streak_key("memory", None)), 0);
        assert_eq!(streak_get(&streak_key("cpu", Some("desk"))), 0);
        assert_eq!(streak_get(&streak_key("cpu", None)), 0);
    }

    #[test]
    fn tag_components_cannot_escape_the_ledger_directory() {
        assert!(safe_component("../../etc").is_none());
        assert!(safe_component("  ").is_none());
        assert!(safe_component("run-7").is_some());
    }
}
