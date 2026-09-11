#!/usr/bin/env bash
# Make a second Claude subscription a thin profile over ~/.claude.
#
#   scripts/setup-account.sh b        # -> ~/.claude-b, run it as CLAUDE_CONFIG_DIR=~/.claude-b claude
#
# ~/.claude stays the real store AND account "a" (plain `claude`). The profile dir symlinks every
# shared item back to it, so a skill, hook, memory or setting edited once exists for both logins.
# projects/ is shared on purpose: it holds the auto-memory, and Athena moves a session to the
# other account with `claude --resume <id>`, which only finds the transcript if both see it.
#
# Never shared: .credentials.json and .claude.json (the login and account identity), plus the
# per-process caches, daemon and backups. Idempotent; re-run after adding a new top-level item.
set -euo pipefail

name="${1:?usage: setup-account.sh <name>   e.g. b}"
[[ "$name" =~ ^[a-z0-9]+$ && "$name" != a ]] || { echo "name must be [a-z0-9]+ and not 'a'"; exit 1; }
A="$HOME/.claude"
P="$HOME/.claude-$name"

SHARE=(
  CLAUDE.md settings.json keybindings.json
  skills agents commands output-styles hooks plugins
  projects sessions file-history todos plans tasks session-env shell-snapshots paste-cache
  history.jsonl chrome browser-profiles tools downloads feedback
)

mkdir -p "$P"
chmod 700 "$P"
for f in "${SHARE[@]}"; do
  [ -e "$A/$f" ] || continue
  if [ -e "$P/$f" ] && [ ! -L "$P/$f" ]; then
    echo "skip $P/$f: a real file is there, move it aside first"
    continue
  fi
  ln -sfn "$A/$f" "$P/$f"
done

# User-scope MCP servers and folder trust live in ~/.claude.json, not settings.json, so they do
# not travel with the symlinks. Copy them in; never the oauth or identity keys. The profile's own
# values win for anything it already has.
python3 - "$HOME/.claude.json" "$P/.claude.json" <<'EOF'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
a = json.load(open(src))
b = json.load(open(dst)) if os.path.exists(dst) else {}
b['mcpServers'] = {**a.get('mcpServers', {}), **b.get('mcpServers', {})}
# `claude auth login` never runs first-run onboarding, so without these a session Athena resumes on
# this profile sits on the theme picker instead of carrying on.
for k in ('hasCompletedOnboarding', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'hasSeenTasksHint',
          'hasCompletedClaudeInChromeOnboarding', 'hasSeenAutoModeEntryWarning',
          'hasSeenAutoModeOutsideReadPrompt', 'hasResetAutoModeOptInForDefaultOffer'):
    if k in a:
        b.setdefault(k, a[k])
projects = b.setdefault('projects', {})
for path, cfg in a.get('projects', {}).items():
    projects[path] = {**cfg, **projects.get(path, {})}
tmp = dst + '.tmp'
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
    json.dump(b, f, indent=2)
os.replace(tmp, dst)
EOF

if [ -f "$P/.credentials.json" ]; then
  echo "$P ready, logged in."
else
  echo "$P ready. Log in once:  CLAUDE_CONFIG_DIR=$P claude   then /login"
fi
