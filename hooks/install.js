#!/usr/bin/env node
// Adds the Argus state hook to ~/.claude/settings.json for every event Argus reads.
// Backs the file up first, is idempotent, and `--uninstall` removes only Argus entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = path.join(process.env.HOME, '.claude', 'settings.json');
const hook = path.join(here, 'argus-state.js');
const node = process.execPath;
const cmd = `${node} "${hook}"`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const uninstall = process.argv.includes('--uninstall');

// A first run on a machine with no settings.json is the normal case, not an error.
let cfg = {};
let backup = null;
if (fs.existsSync(settings)) {
  try {
    cfg = JSON.parse(fs.readFileSync(settings, 'utf8')) || {};
  } catch (err) {
    console.error(`${settings} is not valid JSON; refusing to rewrite it. ${err.message}`);
    process.exit(1);
  }
  backup = `${settings}.argus-backup-${Date.now()}`;
  fs.copyFileSync(settings, backup);
} else if (uninstall) {
  console.log(`No ${settings}; nothing to remove.`);
  process.exit(0);
} else {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
}

const isArgus = (h) => String(h?.command || '').includes('argus-state.js');

cfg.hooks = cfg.hooks || {};
for (const ev of EVENTS) {
  // Drop only the Argus command out of each group, never the group. A group can hold another
  // tool's hook, and taking the whole group would silently uninstall that tool as well.
  const groups = [];
  for (const g of cfg.hooks[ev] || []) {
    const kept = (g.hooks || []).filter((h) => !isArgus(h));
    if (kept.length) groups.push({ ...g, hooks: kept });
    else if (!(g.hooks || []).some(isArgus)) groups.push(g); // an empty group we did not empty
  }
  if (!uninstall) {
    groups.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  }
  if (groups.length) cfg.hooks[ev] = groups;
  else delete cfg.hooks[ev];
}

fs.writeFileSync(settings, JSON.stringify(cfg, null, 2));
console.log(`${uninstall ? 'Removed' : 'Installed'} Argus hooks in ${settings}`);
if (backup) console.log(`Backup: ${backup}`);
