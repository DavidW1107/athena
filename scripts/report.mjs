#!/usr/bin/env node
// Work report: what was done, what is live, what stalled and what was only dipped into over a
// rolling window, split client vs internal.
//
//   node scripts/report.mjs [--hours 24]            HTML to stdout (the Athena dialog)
//   node scripts/report.mjs [--hours 24] --save     HTML + PDF into ~/.athena/reports, prints the PDF path
//
// Everything is derived, nothing is recorded: the Claude transcripts of both accounts say what
// was asked and which files were touched, git says what shipped and what is left uncommitted,
// and ~/.athena/state says who is waiting on you right now. The hook's state files cannot be
// the source because each event overwrites them.
//
// A project is the git repo of the files a session EDITED, never its cwd: nearly every instance
// runs from the GitHub root, so cwd names nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const GITHUB = path.join(HOME, 'Documents', 'GitHub');
const OUT_DIR = path.join(HOME, '.athena', 'reports');
const HOUR = 3600;
const QUIET = 2 * HOUR; // no activity for this long and a project is no longer active
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const TS = /"timestamp":"([^"]+)"/;
const PATHS = new RegExp(`${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s'"\`;&|<>)]+`, 'g');

// ------------------------------------------------------------------ transcripts

/**
 * Fold one transcript's in-window records into `sessions` (keyed by session id). Streamed, and
 * a line is only parsed when its timestamp is inside the window: a day of transcripts is
 * hundreds of megabytes. `seen` dedupes by record uuid, because a session moved to the second
 * account carries its history into a second file.
 */
export async function scanTranscript(file, sinceIso, sessions, seen) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const sid = path.basename(file, '.jsonl');
  let title = null;
  for await (const line of rl) {
    if (line.startsWith('{"type":"ai-title"')) {
      try { title = JSON.parse(line).aiTitle || title; } catch { /* torn line */ }
      continue;
    }
    const ts = TS.exec(line)?.[1];
    if (!ts || ts < sinceIso) continue; // ISO-8601 UTC compares correctly as a string
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.uuid && seen.has(o.uuid)) continue;
    if (o.uuid) seen.add(o.uuid);
    if (o.isSidechain) continue;

    const s = (sessions[sid] ||= { id: sid, cwd: o.cwd, prompts: [], edits: new Set(), reads: [], first: ts, last: ts, lastText: '' });
    if (ts < s.first) s.first = ts;
    if (ts > s.last) s.last = ts;
    s.cwd = o.cwd || s.cwd;

    const content = o.message?.content;
    if (o.type === 'user') {
      if (o.origin?.kind !== 'human') continue; // tool results, task notifications, peers, skills
      const text = typeof content === 'string' ? content : (content || []).map((c) => c.text || '').join(' ');
      // Athena types this into a session it moved after a usage limit; it is not the user's work.
      if (text.startsWith('Your last turn was cut off by a usage limit')) continue;
      s.prompts.push({ ts, text: text.trim() });
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) s.lastText = c.text.trim();
        if (c.type !== 'tool_use') continue;
        const inp = c.input || {};
        const p = inp.file_path || inp.notebook_path || inp.path;
        if (EDIT_TOOLS.has(c.name) && p) s.edits.add(p);
        else if (p) s.reads.push(p);
        if (c.name === 'Bash' && inp.command) s.reads.push(...(inp.command.match(PATHS) || []));
      }
    }
  }
  if (sessions[sid] && title) sessions[sid].title = title;
}

// ------------------------------------------------------------------ projects

const rootCache = new Map();

/** Nearest enclosing git repo of a path, or null. Stops at $HOME. */
export function gitRoot(p) {
  let d = path.dirname(p);
  const hit = [];
  while (d.startsWith(HOME) && d !== HOME) {
    if (rootCache.has(d)) { const r = rootCache.get(d); hit.forEach((h) => rootCache.set(h, r)); return r; }
    hit.push(d);
    if (fs.existsSync(path.join(d, '.git'))) { hit.forEach((h) => rootCache.set(h, d)); return d; }
    d = path.dirname(d);
  }
  hit.forEach((h) => rootCache.set(h, null));
  return null;
}

/** The label a human knows a path's project by: `clients/alucast-crm`, `~/.claude/skills`. */
export function projectOf(p) {
  if (!p.startsWith(HOME + '/')) return null; // scratchpads under /tmp belong to no project
  const root = gitRoot(p);
  const base = root || p;
  if (base.startsWith(GITHUB + '/')) {
    const segs = path.relative(GITHUB, base).split('/');
    if (root) return { label: segs.join('/'), root };
    // Not a repo: the bucket and the directory under it (clients/acmr holds a third level).
    return { label: segs.slice(0, segs[0] === 'clients' && segs[1] === 'acmr' ? 3 : 2).join('/'), root: null };
  }
  const segs = path.relative(HOME, base).split('/');
  return { label: '~/' + (root ? segs.join('/') : segs.slice(0, 2).join('/')), root };
}

/** Machinery that every session reads (memory, skills, Athena itself); never evidence of a project. */
const PLUMBING = ['.claude', '.claude-b', '.athena', '.codex', '.config', '.local'].map((d) => path.join(HOME, d) + '/');
const isPlumbing = (p) => PLUMBING.some((d) => p.startsWith(d));
const MEMORY = ['.claude', '.claude-b'].map((d) => path.join(HOME, d, 'projects') + '/');

/** Which projects a session worked on: repos it edited, else the one it read most, else its cwd. */
export function sessionProjects(s) {
  const edited = new Map();
  for (const f of s.edits) {
    if (MEMORY.some((d) => f.startsWith(d))) continue; // saving a memory is bookkeeping, not project work
    const pr = projectOf(f);
    if (pr) edited.set(pr.label, pr);
  }
  if (edited.size) return [...edited.values()];
  const tally = new Map();
  for (const f of s.reads) {
    if (isPlumbing(f) || !fs.existsSync(f)) continue; // a Bash regex or a deleted temp file is not a path
    const pr = projectOf(f);
    if (!pr) continue;
    const t = tally.get(pr.label) || { pr, n: 0 };
    t.n++;
    tally.set(pr.label, t);
  }
  const best = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  if (best) return [best.pr];
  const pr = s.cwd && s.cwd !== GITHUB ? projectOf(path.join(s.cwd, 'x')) : null;
  return [pr || { label: 'GitHub (no project)', root: null }];
}

export const isClient = (label) => label.startsWith('clients/') || label.startsWith('demos/');

// ------------------------------------------------------------------ git

const git = (root, ...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

function gitFacts(root, sinceEpoch, edited) {
  const unpushed = new Set(git(root, 'rev-list', '--all', '--not', '--remotes').split('\n').filter(Boolean).map((h) => h.slice(0, 7)));
  const hasRemote = git(root, 'remote').trim() !== '';
  // HEAD, not --all: worktrees share refs, so --all would list every sibling worktree's commits too.
  const commits = git(root, 'log', 'HEAD', `--since=@${sinceEpoch}`, '--format=%h%x09%ct%x09%s')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, ct, ...rest] = l.split('\t');
      return { hash: hash.slice(0, 7), ts: Number(ct), subject: rest.join('\t'), pushed: hasRemote && !unpushed.has(hash.slice(0, 7)) };
    });
  // Only files THIS window's sessions edited count as left over; someone else's dirty tree is not a stall.
  const dirty = git(root, 'status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((l) => path.join(root, l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')))
    .filter((f) => edited.has(f)).length;
  return { commits, dirty };
}

// ------------------------------------------------------------------ buckets

const ago = (secs) => (secs < HOUR ? `${Math.max(1, Math.round(secs / 60))}m` : `${Math.round(secs / HOUR)}h`);

/**
 * Sort one project into buckets. Pure, so report.test.mjs can pin the rules.
 *
 * done     commits in the window, or real work that went quiet with nothing left hanging
 * active   an instance is working now, or anything happened in the last 2h
 * stalled  real work, quiet 2h+, AND a concrete reason (waiting on you, limit, uncommitted, a question)
 * dipped   3 prompts or fewer and no edits
 *
 * A project with commits can also be active or stalled: shipped some, still going or left some.
 */
export function bucket(p, now) {
  const quiet = now - p.lastEpoch;
  const working = p.states.some((s) => s.state === 'working' && now - s.ts < 15 * 60);
  const active = working || quiet < QUIET;
  const work = p.prompts >= 4 || p.edits > 0;

  const reasons = [];
  for (const s of p.states) {
    if (s.state === 'needs-you') reasons.push(`waiting on you ${ago(now - s.ts)}`);
    if (s.state === 'limited') reasons.push('usage limit hit');
  }
  if (p.dirty) reasons.push(`uncommitted edits in ${p.dirty} file${p.dirty === 1 ? '' : 's'}`);
  if (p.endedOnQuestion) reasons.push('ended on a question to you');

  const out = [];
  if (p.commits > 0) out.push('done');
  if (active) out.push('active');
  else if (work && reasons.length) out.push('stalled');
  else if (!p.commits) out.push(work ? 'done' : 'dipped');
  return { buckets: out, reasons: active ? [] : [...new Set(reasons)], quiet };
}

// ------------------------------------------------------------------ summaries

/**
 * One line per project from Haiku, in a single call. Cached by the exact input, so reopening
 * the dialog costs nothing until a project changes. Any failure (limit, offline, bad JSON)
 * falls back to the session titles: the report must never depend on the model answering.
 */
function summarise(projects) {
  const cacheFile = path.join(OUT_DIR, 'summaries.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* first run */ }

  const inputs = projects.map((p) => {
    const brief = {
      project: p.label,
      titles: [...new Set(p.sessions.map((s) => s.title).filter(Boolean))],
      prompts: [...new Set(p.promptTexts.map((t) => t.replace(/\s+/g, ' ').slice(0, 160)))].slice(0, 15),
      commits: p.commits.map((c) => c.subject).slice(0, 15),
      files_edited: p.editCount,
    };
    return { p, brief, key: crypto.createHash('sha1').update(JSON.stringify(brief)).digest('hex') };
  });
  const todo = inputs.filter((i) => !cache[i.key]);

  if (todo.length) {
    const prompt =
      'You write one line per project for a developer\'s daily work report. For each project below, ' +
      'write what was worked on in at most 18 words: plain past tense, concrete nouns, no filler, ' +
      'no em dashes, no "the user". Answer with ONLY a JSON object mapping project name to the line.\n\n' +
      JSON.stringify(todo.map((t) => t.brief));
    const env = { ...process.env };
    // Launched from an Athena pane, these would make the state hook report this throwaway call as that instance.
    delete env.ATHENA_ID;
    delete env.TMUX_PANE;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const r = spawnSync('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '', prompt], {
      cwd: OUT_DIR, env, encoding: 'utf8', timeout: 120000,
    });
    try {
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1));
      for (const t of todo) if (typeof json[t.brief.project] === 'string') cache[t.key] = json[t.brief.project];
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
    } catch { /* fall back below */ }
  }
  for (const i of inputs) {
    i.p.summary = (cache[i.key] || i.brief.titles.join('; ') || i.brief.prompts[0] || '').replace(/[\u2013\u2014]/g, ',');
  }
}

// ------------------------------------------------------------------ build

export async function build(hours, { llm = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - hours * HOUR;
  const sinceIso = new Date(since * 1000).toISOString();

  const sessions = {};
  const seen = new Set();
  for (const cfg of ['.claude', '.claude-b']) {
    const dir = path.join(HOME, cfg, 'projects');
    let slugs = [];
    try { slugs = fs.readdirSync(dir); } catch { continue; }
    for (const slug of slugs) {
      let files = [];
      try { files = fs.readdirSync(path.join(dir, slug)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const full = path.join(dir, slug, f);
        if (fs.statSync(full).mtimeMs / 1000 < since) continue;
        await scanTranscript(full, sinceIso, sessions, seen);
      }
    }
  }

  const states = {};
  const stateDir = path.join(HOME, '.athena', 'state');
  for (const f of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      if (st.session_id && (!states[st.session_id] || states[st.session_id].ts < st.ts)) states[st.session_id] = st;
    } catch { /* half-written */ }
  }

  const projects = new Map();
  for (const s of Object.values(sessions)) {
    if (s.cwd?.startsWith(OUT_DIR)) continue; // this script's own summary calls
    if (!s.prompts.length && !s.edits.size) continue; // resumed and left, or only background noise
    for (const pr of sessionProjects(s)) {
      const p = projects.get(pr.label) || { label: pr.label, root: pr.root, sessions: [], promptTexts: [], edited: new Set(), states: [], lastEpoch: 0, endedOnQuestion: false };
      p.sessions.push(s);
      p.promptTexts.push(...s.prompts.map((x) => x.text));
      for (const f of s.edits) if (projectOf(f)?.label === pr.label) p.edited.add(f);
      const last = Math.floor(Date.parse(s.last) / 1000);
      if (last > p.lastEpoch) { p.lastEpoch = last; p.endedOnQuestion = s.lastText.endsWith('?'); }
      if (states[s.id]) p.states.push(states[s.id]);
      projects.set(pr.label, p);
    }
  }

  const list = [...projects.values()];
  for (const p of list) {
    const g = p.root ? gitFacts(p.root, since, p.edited) : { commits: [], dirty: 0 };
    p.commits = g.commits;
    p.editCount = p.edited.size;
    Object.assign(p, bucket({ ...p, prompts: p.promptTexts.length, edits: p.edited.size, commits: g.commits.length, dirty: g.dirty }, now));
  }
  if (llm) summarise(list);
  list.sort((a, b) => b.lastEpoch - a.lastEpoch);
  return { now, since, hours, projects: list };
}

// ------------------------------------------------------------------ html

const esc = (s) => String(s).replace(/[&<>"'`=\/]/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (epoch) =>
  new Date(epoch * 1000).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const BUCKETS = [
  ['done', 'Done'],
  ['active', 'In progress'],
  ['stalled', 'Stalled'],
  ['dipped', 'Dipped into'],
];

function item(p, b) {
  const meta = [];
  if (b === 'done' && p.commits.length) {
    const unpushed = p.commits.filter((c) => !c.pushed).length;
    meta.push(`${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}${unpushed ? `, ${unpushed} unpushed` : ', pushed'}`);
  }
  if (b === 'stalled') meta.push(`<span class="why">${esc(p.reasons.join(', '))}</span>`, `quiet ${ago(p.quiet)}`);
  if (b === 'active') meta.push(p.states.some((s) => s.state === 'working') ? 'working now' : `last activity ${ago(p.quiet)} ago`);
  meta.push(`${p.promptTexts.length} prompt${p.promptTexts.length === 1 ? '' : 's'}`);
  if (p.editCount) meta.push(`${p.editCount} file${p.editCount === 1 ? '' : 's'} edited`);
  const commits = b === 'done' && p.commits.length
    ? `<ul class="commits">${p.commits.slice(0, 8).map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)}</li>`).join('')}${p.commits.length > 8 ? `<li>and ${p.commits.length - 8} more</li>` : ''}</ul>`
    : '';
  return `<li class="item"><div class="head"><span class="name">${esc(p.label)}</span><span class="meta">${meta.join(' · ')}</span></div>` +
    `<p class="sum">${esc(p.summary || '')}</p>${commits}</li>`;
}

function section(title, projects) {
  if (!projects.length) return '';
  const groups = BUCKETS.map(([k, label]) => {
    const ps = projects.filter((p) => p.buckets.includes(k));
    return ps.length ? `<h3 class="b-${k}">${label} <span>${ps.length}</span></h3><ul>${ps.map((p) => item(p, k)).join('')}</ul>` : '';
  }).join('');
  return `<section><h2>${title}</h2>${groups}</section>`;
}

export function html(r) {
  const ps = r.projects;
  const totals = [
    `${ps.length} project${ps.length === 1 ? '' : 's'}`,
    `${ps.reduce((n, p) => n + p.promptTexts.length, 0)} prompts`,
    `${ps.reduce((n, p) => n + p.commits.length, 0)} commits`,
    `${ps.filter((p) => p.buckets.includes('stalled')).length} stalled`,
  ].join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Work report ${esc(when(r.now))}</title>
<style>
:root { --ink:#1d1c1a; --soft:#6b6862; --line:#e4e0d8; --ground:#faf8f4; --done:#1f7a4d; --active:#0b6fb8; --stalled:#b25e00; --dipped:#7a7670; }
* { box-sizing:border-box; }
body { margin:0; background:var(--ground); color:var(--ink); font:14px/1.5 "Ubuntu Sans","Inter",system-ui,sans-serif; }
main { max-width:860px; margin:0 auto; padding:40px 32px 56px; }
header { border-bottom:1px solid var(--line); padding-bottom:18px; margin-bottom:8px; }
h1 { margin:0; font-size:28px; line-height:1.05; letter-spacing:-0.02em; font-weight:650; }
.range, .totals { margin:6px 0 0; color:var(--soft); font-variant-numeric:tabular-nums; }
.totals { font-family:"Ubuntu Sans Mono",ui-monospace,monospace; font-size:12px; }
h2 { margin:34px 0 4px; font-size:19px; letter-spacing:-0.01em; }
h3 { margin:20px 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:0.08em; font-family:"Ubuntu Sans Mono",ui-monospace,monospace; }
h3 span { color:var(--soft); font-weight:400; }
h3.b-done { color:var(--done); } h3.b-active { color:var(--active); } h3.b-stalled { color:var(--stalled); } h3.b-dipped { color:var(--dipped); }
ul { list-style:none; margin:0; padding:0; }
.item { padding:10px 0; border-top:1px solid var(--line); break-inside:avoid; }
.head { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; }
.name { font-weight:600; }
.meta { color:var(--soft); font-size:12px; font-variant-numeric:tabular-nums; }
.why { color:var(--stalled); font-weight:600; }
.sum { margin:2px 0 0; }
.commits { margin:4px 0 0; font-size:12px; color:var(--soft); }
.commits code { font-family:"Ubuntu Sans Mono",ui-monospace,monospace; color:var(--ink); }
.empty { color:var(--soft); margin-top:24px; }
@page { size:A4; margin:14mm; }
@media print { body { background:#fff; } main { padding:0; max-width:none; } }
</style></head><body><main>
<header><h1>Work report</h1>
<p class="range">${esc(when(r.since))} to ${esc(when(r.now))}, last ${r.hours}h</p>
<p class="totals">${esc(totals)}</p></header>
${ps.length ? section('Client', ps.filter((p) => isClient(p.label))) + section('Internal', ps.filter((p) => !isClient(p.label))) : '<p class="empty">Nothing in this window.</p>'}
</main></body></html>`;
}

// ------------------------------------------------------------------ cli

function savePdf(htmlText, hours, now) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new Date(now * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const stem = path.join(OUT_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${hours}h`);
  fs.writeFileSync(`${stem}.html`, htmlText);
  // A throwaway profile, or headless Chrome hands the job to the user's running browser and exits.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-report-'));
  const r = spawnSync('google-chrome', ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${profile}`, `--print-to-pdf=${stem}.pdf`, pathToFileURL(`${stem}.html`).href], { timeout: 60000, stdio: 'ignore' });
  fs.rmSync(profile, { recursive: true, force: true });
  // No Chrome: the HTML is still a complete report, and it prints to PDF from any browser.
  return r.status === 0 && fs.existsSync(`${stem}.pdf`) ? `${stem}.pdf` : `${stem}.html`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const hours = Math.max(1, Math.min(24 * 31, Number(args[args.indexOf('--hours') + 1]) || 24));
  const r = await build(hours, { llm: !args.includes('--no-llm') });
  const page = html(r);
  process.stdout.write(args.includes('--save') ? savePdf(page, hours, r.now) + '\n' : page);
}
