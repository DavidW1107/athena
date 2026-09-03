#!/usr/bin/env node
// Adds the Argus state hook to ~/.claude/settings.json for every event Argus reads.
// Backs the file up first, is idempotent, and `--uninstall` removes only Argus entries.
const fs = require('fs');
const path = require('path');

const settings = path.join(process.env.HOME, '.claude', 'settings.json');
const hook = path.join(__dirname, 'argus-state.js');
const node = process.execPath;
const cmd = `${node} "${hook}"`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const uninstall = process.argv.includes('--uninstall');

const cfg = JSON.parse(fs.readFileSync(settings, 'utf8'));
const backup = `${settings}.argus-backup-${Date.now()}`;
fs.copyFileSync(settings, backup);

cfg.hooks = cfg.hooks || {};
for (const ev of EVENTS) {
  const groups = (cfg.hooks[ev] || []).filter(
    (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('argus-state.js'))
  );
  if (!uninstall) {
    groups.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  }
  if (groups.length) cfg.hooks[ev] = groups;
  else delete cfg.hooks[ev];
}

fs.writeFileSync(settings, JSON.stringify(cfg, null, 2));
console.log(`${uninstall ? 'Removed' : 'Installed'} Argus hooks in ${settings}`);
console.log(`Backup: ${backup}`);
