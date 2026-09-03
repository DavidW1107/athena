#!/usr/bin/env node
// Argus state emitter. Wired to every Claude Code hook event; writes one small JSON
// file per instance under ~/.argus/state/. No output, never blocks, never fails loud.
const fs = require('fs');
const path = require('path');

const id = process.env.ARGUS_ID;
if (!id) process.exit(0); // not launched by Argus: nothing to report

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(input || '{}'); } catch { /* keep going with an empty payload */ }

  const dir = path.join(process.env.HOME, '.argus', 'state');
  const file = path.join(dir, `${id}.json`);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first event */ }

  const ev = p.hook_event_name || '';
  const next = { ...cur, ts: Math.floor(Date.now() / 1000) };
  if (p.session_id) next.session_id = p.session_id;
  if (p.cwd) next.cwd = p.cwd;

  switch (ev) {
    case 'SessionStart':
      next.state = 'idle';
      next.tool = null;
      break;
    case 'UserPromptSubmit':
      next.state = 'working';
      next.summary = String(p.prompt || '').slice(0, 90);
      break;
    case 'PreToolUse':
      next.state = 'working';
      next.tool = p.tool_name || null;
      break;
    case 'PostToolUse':
      next.state = 'working';
      break;
    case 'Notification':
      // Fires on permission prompts and on idle-waiting. This is the "needs you" signal.
      next.state = 'needs-you';
      next.summary = String(p.message || next.summary || '').slice(0, 90);
      break;
    case 'Stop':
      next.state = 'idle';
      next.tool = null;
      break;
    case 'SessionEnd':
      next.state = 'ended';
      break;
    default:
      break;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next));
  } catch { /* state is best-effort; never break the session over it */ }
  process.exit(0);
});
