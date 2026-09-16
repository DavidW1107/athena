#!/usr/bin/env bash
# Put Athena in the desktop's app list so it is searchable by name and launchable by icon.
#
# Everything lands under ~/.local, so this needs no root and touches no system directory.
# The binary is COPIED to ~/.local/bin rather than linked into the build tree, because a
# cargo clean would otherwise leave a launcher pointing at nothing.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$repo/src-tauri/target/release/athena"

if [ ! -x "$binary" ]; then
  echo "No release binary at $binary" >&2
  echo "Build it first:  npm run tauri build -- --no-bundle" >&2
  exit 1
fi

# Install beside the target and RENAME over it, rather than writing the target in place.
# Linux refuses to open a running executable for writing (ETXTBSY), and Athena running an
# older build is the normal case when you install a new one, so `install` straight onto the
# target failed exactly when it was needed. A rename swaps the directory entry: the running
# process keeps its old inode and carries on until it is quit.
install -d "$HOME/.local/bin"
install -m755 "$binary" "$HOME/.local/bin/.athena.new"
mv -f "$HOME/.local/bin/.athena.new" "$HOME/.local/bin/athena"

for size in 32 128 256; do
  src="$repo/src-tauri/icons/${size}x${size}.png"
  [ -f "$src" ] || src="$repo/src-tauri/icons/128x128@2x.png"
  [ -f "$src" ] || continue
  install -Dm644 "$src" "$HOME/.local/share/icons/hicolor/${size}x${size}/apps/athena.png"
done

desktop="$HOME/.local/share/applications/athena.desktop"
install -d "$(dirname "$desktop")"
cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Athena
GenericName=Agent instance manager
Comment=Watch and control every Claude Code and Codex instance in one window
Exec=$HOME/.local/bin/athena
Icon=athena
Terminal=false
Categories=Development;
Keywords=claude;codex;agent;terminal;tmux;instances;fleet;
StartupWMClass=Athena
DESKTOP
chmod 644 "$desktop"

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# Nightly work report: the last 24h saved as HTML + PDF into ~/.athena/reports at 23:55.
# Persistent=true runs a missed night at next login. Re-running this only rewrites the units.
node_bin="$(command -v node || echo "$HOME/.local/bin/node")"
units="$HOME/.config/systemd/user"
install -d "$units"
cat > "$units/athena-report.service" <<UNIT
[Unit]
Description=Athena nightly work report

[Service]
Type=oneshot
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin $repo/scripts/report.mjs --hours 24 --save
UNIT
cat > "$units/athena-report.timer" <<UNIT
[Unit]
Description=Athena nightly work report

[Timer]
OnCalendar=*-*-* 23:55
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now athena-report.timer >/dev/null

if pgrep -x athena >/dev/null 2>&1; then
  echo
  echo "NOTE: Athena is currently running an older build. Quit and reopen it, or the changes"
  echo "      you just installed will not be in the window you are looking at."
  echo
fi

echo "Installed:"
echo "  $HOME/.local/bin/athena"
echo "  $desktop"
echo "  $units/athena-report.timer (nightly report at 23:55)"
echo "Search your desktop for 'Athena'. Re-run this after every release build."
