// Dropping files from the file manager onto a tile types their paths into that terminal,
// which is what every Linux terminal emulator does and what Athena was missing.
//
// This cannot be an HTML5 `drop` listener. Tauri claims the webview's native drag
// destination, so a drag carrying real files never reaches the page: the enter / over /
// drop pair arrives on the webview event channel instead, with OS paths already resolved.
// (Page-internal drags, the tile and tab reordering in dnd.js, are untouched by that and
// keep using ordinary HTML5 events.)
//
// The trade is that the event carries a screen position rather than a target element, so
// this module does its own hit test.

import { getCurrentWebview } from '@tauri-apps/api/webview';

import { dropText } from './shellquote.js';
import './filedrop.css';

/**
 * Insert text at a field's caret, replacing whatever is selected, and leave the caret after
 * it. Same shape as typing, which is what a drop onto a text field means everywhere else.
 *
 * The synthetic `input` event matters: a listener watching the field for changes would
 * otherwise never hear about a value that arrived this way.
 */
function insertIntoField(field, text) {
  const at = field.selectionStart ?? field.value.length;
  const to = field.selectionEnd ?? at;
  field.value = field.value.slice(0, at) + text + field.value.slice(to);
  field.selectionStart = field.selectionEnd = at + text.length;
  field.focus();
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Start routing OS file drops.
 *
 *   mountFileDrop({ onTerminal: (group, text) => grid.insertText(group, text) });
 *
 * A drop onto a text input or textarea (the launcher's directory field, the broadcast and
 * handoff boxes) fills that field. A drop anywhere on a tile goes to `onTerminal` with the
 * tile's group. A drop on neither is ignored rather than guessed at.
 *
 * @param {{ onTerminal?: (group: string, text: string) => void }} [cfg]
 * @returns {{ destroy: () => void }}
 */
export function mountFileDrop({ onTerminal } = {}) {
  let hot = null;
  let unlisten = null;
  let dead = false;

  /** The element under a physical screen position, or null once outside the page. */
  function elementAt(position) {
    if (!position) return null;
    // The event reports device pixels; elementFromPoint wants CSS pixels.
    const r = window.devicePixelRatio || 1;
    return document.elementFromPoint(position.x / r, position.y / r);
  }

  /** Whichever of the two things a drop can land on sits closest to the pointer. */
  const targetAt = (position) =>
    elementAt(position)?.closest('input[type="text"], input:not([type]), textarea, .tile') ?? null;

  function highlight(el) {
    if (hot === el) return;
    hot?.classList.remove('drop-hot');
    hot = el;
    hot?.classList.add('drop-hot');
  }

  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (dead) return;
      if (payload.type === 'leave') {
        highlight(null);
        return;
      }
      if (payload.type === 'enter' || payload.type === 'over') {
        highlight(targetAt(payload.position));
        return;
      }
      if (payload.type !== 'drop') return;

      const target = targetAt(payload.position);
      highlight(null);
      if (!target || !payload.paths?.length) return;

      const text = dropText(payload.paths);
      if (target.classList.contains('tile')) onTerminal?.(target.dataset.group, text);
      else insertIntoField(target, text);
    })
    .then((un) => {
      // destroy() can win the race against this resolving, so a listener that arrives after
      // teardown is dropped immediately rather than left running.
      if (dead) un();
      else unlisten = un;
    })
    .catch((err) => console.error('[athena] file drop unavailable', err));

  return {
    destroy() {
      dead = true;
      highlight(null);
      unlisten?.();
      unlisten = null;
    },
  };
}
