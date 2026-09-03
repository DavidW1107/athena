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

install -Dm755 "$binary" "$HOME/.local/bin/athena"

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

echo "Installed:"
echo "  $HOME/.local/bin/athena"
echo "  $desktop"
echo "Search your desktop for 'Athena'. Re-run this after every release build."
