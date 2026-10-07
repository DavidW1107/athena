#!/bin/sh
# Login entry point (~/.config/autostart/athena.desktop): bring every instance back, open the grid.
# The restore runs in the background so the window is not held up by it.
"$(dirname "$0")/restore-all.py" >>"$HOME/.athena/restore.log" 2>&1 &
exec "$HOME/.local/bin/athena"
