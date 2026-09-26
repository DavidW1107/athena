// The whole stage: every instance visible at once, one tile per repo group.
//
// The rule that shapes this file: a GROUP takes one tile's footprint no matter how many
// instances it holds, the way a terminal window holds tabs. So a tile owns exactly one
// terminal, the tabs choose which instance that terminal is showing, and an inactive tab
// holds no pty at all. tmux keeps the session's screen, so switching back redraws it.
//
// That is also what makes "as many as I open" affordable: N groups means N ptys, not N
// instances. The grid never shrinks a tile below a readable width; it scrolls instead.

import { closeInstance, endScroll, ptyWrite, restore, setGroup, setPaused, stateLabel, tmuxScroll } from './api.js';
import * as store from './store.js';
import { effectiveState, getNote, prune as pruneNotes, setNote, subscribeNotes } from './notes.js';
import { createTerm } from './term.js';
import { MIME_INSTANCE, MIME_TILE, dragPayload, isDroppable } from './dnd.js';
import './grid.css';

const ORDER_KEY = 'athena.tileOrder';
const FONT_KEY = 'athena.tileFont';

// A tile never gets narrower than this, so a big fleet scrolls rather than shrinking to
// unusable slivers. MIN_ROW_PX does the same for height.
const MIN_TILE_PX = 360;
const MIN_ROW_PX = 220;
const MIN_FONT = 8;
const MAX_FONT = 24;
const DEFAULT_FONT = 12.5;

// Anything Claude Code prints is wrapped at the pane width AT THE TIME IT IS PRINTED, with real
// newlines, so a conversation held in a narrow tile stays narrow forever: no terminal can
// un-wrap a hard break. Rather than let a small tile permanently record 61-column output, the
// font steps down until the pane is at least this wide.
// ponytail: a constant. Make it a setting if 100 ever turns out to be the wrong number.
const MIN_COLS = 100;

// Pixels of wheel travel per line of scrollback. Tuned for a trackpad: small enough that a
// gentle swipe moves, large enough that a mouse notch is not a leap.
const PX_PER_LINE = 20;

/** Small keyed maps of per-tile preferences, all failing soft to an empty object. */
function readMap(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeMap(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked localStorage costs a remembered preference and nothing else.
  }
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Tile order the user dragged into place. Unknown groups sort after it, alphabetically. */
function readOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOrder(order) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // A full or blocked localStorage costs the remembered order and nothing else.
  }
}

/**
 * Mount the tiled grid.
 *
 *   const grid = mountGrid(document.querySelector('#grid'));
 *   await grid.destroy();
 *
 * @param {HTMLElement} host
 * @param {{ term?: object }} [opts]
 * @returns {{ destroy: () => Promise<void>, focusGroup: (group: string) => void,
 *   insertText: (group: string, text: string) => void }}
 */
export function mountGrid(host, opts = {}) {
  /** @type {Map<string, any>} */
  const tiles = new Map();
  let order = readOrder();
  let fonts = readMap(FONT_KEY);
  let destroyed = false;
  let dragging = null;

  // WebKitGTK sometimes never delivers dragend (drop outside the window, focus change mid-drag),
  // which left a tile stuck at .dragging opacity. Any drop, or any pointerdown afterwards (the
  // platform sends none while a drag is live), proves the drag is over, so all three end it.
  function endDrag() {
    dragging = null;
    for (const n of grid.querySelectorAll('.tile.dragging, .tile.over')) n.classList.remove('dragging', 'over');
  }
  window.addEventListener('drop', endDrag, true);
  window.addEventListener('pointerdown', endDrag, true);

  const grid = el('div', 'grid');
  const empty = el('p', 'grid-empty', 'No instances yet. Launch one, or adopt something already running.');
  host.replaceChildren(grid, empty);

  // ---------------------------------------------------------------- tile construction

  function buildTile(group) {
    const root = el('section', 'tile');
    root.dataset.group = group;

    const head = el('div', 'tile-head');
    head.draggable = true;
    const title = el('span', 'tile-group', group);
    const tabs = el('div', 'tile-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', `instances in ${group}`);
    // Launch straight into THIS group. Grouping is by repo, so handing the launcher this
    // tile's directory is all it takes for the new instance to land back in this tile.
    const plus = el('button', 'tile-plus', '+');
    plus.type = 'button';
    plus.title = `new instance in ${group}`;
    plus.setAttribute('aria-label', `new instance in ${group}`);
    plus.onclick = (e) => {
      e.stopPropagation();
      const any = store.getInstances().find((i) => i.group === group);
      opts.onNewInTile?.({ group, cwd: any ? any.cwd : '', cmd: any ? any.cmd : '', host: any ? any.host : null });
    };

    // The terminal's real character grid, shown because "did this actually resize" was
    // otherwise unanswerable from the outside.
    const size = el('span', 'tile-size');
    // A pane in copy mode is frozen: the agent's new output does not appear until the mode
    // ends. That has to be visible, and one click has to undo it.
    const scrolled = el('button', 'tile-scrolled', 'scrolled');
    scrolled.type = 'button';
    scrolled.hidden = true;
    scrolled.title = 'this pane is showing history and is not live, click to return to the bottom';
    scrolled.onclick = (e) => {
      e.stopPropagation();
      clearScrolled(tiles.get(group));
    };
    // Pin a note on the ACTIVE instance. aria-pressed rather than a second label, because
    // the button's job is to report whether a note exists as much as to add one.
    const noteBtn = el('button', 'tile-note-btn', 'note');
    noteBtn.type = 'button';
    noteBtn.setAttribute('aria-pressed', 'false');
    noteBtn.onclick = (e) => {
      e.stopPropagation();
      const tile = tiles.get(group);
      if (!tile?.activeId) return;
      // The button is the way back out as well as in, so a second click always closes:
      // clearing a stored note, or just dismissing a banner opened and never typed into.
      if (getNote(tile.activeId)) {
        setNote(tile.activeId, '');
        closeNote();
      } else if (!tile.note.hidden) {
        closeNote();
      } else {
        openNote(tile);
      }
    };
    const actions = el('div', 'tile-actions');
    head.append(title, tabs, plus, scrolled, size, noteBtn, actions);

    const body = el('div', 'tile-body');
    const termHost = el('div', 'tile-term');
    const msg = el('div', 'tile-msg');
    msg.hidden = true;

    // The note banner. Built once and hidden, because it holds a focused input while the
    // user types and rebuilding it on the 1s poll would steal the caret every second.
    const note = el('div', 'tile-note');
    note.hidden = true;
    const noteInput = el('input', 'tile-note-text');
    noteInput.type = 'text';
    noteInput.maxLength = 160;
    noteInput.placeholder = 'waiting on\u2026';
    noteInput.setAttribute('aria-label', `note for the active instance in ${group}`);
    const noteClear = el('button', 'tile-note-clear', '\u00d7');
    noteClear.type = 'button';
    noteClear.title = 'remove this note and let the instance signal normally again';
    // The label says what the banner IS, not what the state is: the head chip already reads
    // `held` and a third indigo "held" on the same tile is a repetition, not a reinforcement.
    note.append(el('span', 'tile-note-label', 'note'), noteInput, noteClear);
    body.append(termHost, msg, note);

    // The banner's events belong to the banner. The tile root focuses its terminal on any
    // click that is not a button, so without this the caret was taken out of the note input
    // by the same click that put it there; and a keystroke that bubbled to xterm typed the
    // note into the agent.
    note.addEventListener('keydown', (e) => e.stopPropagation());
    note.addEventListener('click', (e) => e.stopPropagation());

    /**
     * Take the banner off the tile. Called directly rather than left to the note-change
     * emit, because clearing an ALREADY empty banner changes nothing, so setNote returns
     * false, nothing is emitted and nothing repaints: the x on an empty banner looked inert.
     */
    const closeNote = () => {
      noteInput.value = '';
      note.hidden = true;
    };

    const commitNote = () => {
      const tile = tiles.get(group);
      if (!tile?.activeId) return;
      // An empty commit is a delete, which is what makes select-all-delete the whole gesture.
      setNote(tile.activeId, noteInput.value);
      // Nothing to show and nothing being typed: the banner has no reason to hold the row.
      if (!noteInput.value.trim()) closeNote();
    };

    noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNote();
        noteInput.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // Escape abandons the edit rather than the note: put back what was stored.
        const tile = tiles.get(group);
        const stored = tile?.activeId ? getNote(tile.activeId) : '';
        noteInput.value = stored;
        noteInput.blur();
        if (!stored) closeNote();
      }
    });
    noteInput.addEventListener('blur', commitNote);
    // The x removes the note from the instance outright: the text is deleted, the banner
    // comes off the terminal, and the tile goes back to signalling its own state.
    noteClear.onclick = (e) => {
      e.stopPropagation();
      const tile = tiles.get(group);
      if (tile?.activeId) setNote(tile.activeId, '');
      closeNote();
      tile?.term?.focus();
    };

    // Ctrl and the wheel is the terminal zoom, scoped to THIS terminal. Without
    // preventDefault the webview zooms the entire window instead, which is not what a
    // per-terminal size control should do.
    // Capture phase, because xterm listens on its own element and would otherwise forward
    // the wheel to the application first. Claude Code reads a forwarded wheel as "cycle
    // through past messages", which is what made scrolling up walk the conversation instead
    // of showing what had scrolled off the top.
    body.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey) {
          bumpFont(group, e.deltaY < 0 ? 1 : -1);
          return;
        }
        const tile = tiles.get(group);
        if (!tile?.activeId) return;
        // deltaMode 1 means the delta is already in lines; 0 means pixels.
        queueScroll(tile, e.deltaMode === 1 ? e.deltaY * PX_PER_LINE : e.deltaY);
      },
      { passive: false, capture: true }
    );

    // Double click the header to fill the window with this tile, again to put it back. A
    // transient view, deliberately not persisted: it is a way to read something, not a layout.
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      toggleZoom(group);
    });

    root.append(head, body);

    head.addEventListener('dragstart', (e) => {
      dragging = group;
      e.dataTransfer.setData(MIME_TILE, group);
      e.dataTransfer.effectAllowed = 'move';
      root.classList.add('dragging');
    });
    head.addEventListener('dragend', endDrag);

    // dragenter and dragleave also fire for descendants, so the highlight is reference
    // counted rather than toggled; crossing a child would otherwise clear it early.
    let overDepth = 0;
    root.addEventListener('dragenter', (e) => {
      if (!isDroppable(e.dataTransfer) || dragging === group) return;
      e.preventDefault();
      overDepth += 1;
      root.classList.add('over');
    });
    root.addEventListener('dragover', (e) => {
      if (!isDroppable(e.dataTransfer) || dragging === group) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    root.addEventListener('dragleave', () => {
      overDepth = Math.max(0, overDepth - 1);
      if (overDepth === 0) root.classList.remove('over');
    });
    root.addEventListener('drop', (e) => {
      overDepth = 0;
      root.classList.remove('over');
      const payload = dragPayload(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      if (payload.kind === 'instance') {
        // Merging two tiles is moving their instances: grouping lives on the instance, so
        // nothing about the terminal or its session moves, only which tile draws it.
        const inst = store.getInstance(payload.value);
        if (inst && inst.group !== group) {
          setGroup(payload.value, group).then(store.refresh).catch((err) => console.error('[athena] merge', err));
        }
      } else if (payload.value && payload.value !== group) {
        reorder(payload.value, group);
      }
    });

    // Scrolling leaves the pane in tmux copy mode, where keystrokes drive the scroller
    // rather than the agent. The first key after a scroll cancels it, so typing behaves the
    // way it does in any terminal: you scroll up to read, start typing, and you are back.
    root.addEventListener(
      'keydown',
      (e) => {
        const tile = tiles.get(group);
        if (!tile?.scrolled) return;
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
        clearScrolled(tile);
      },
      { capture: true }
    );

    // Keyboard equivalent of the ctrl-wheel zoom, so the size control is reachable without
    // a pointer. Bound on the tile so it applies to whichever terminal has focus.
    root.addEventListener('keydown', (e) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') bumpFont(group, 1);
      else if (e.key === '-' || e.key === '_') bumpFont(group, -1);
      else if (e.key === '0') resetFont(group);
      else return;
      e.preventDefault();
    });

    // Clicking anywhere that is not a control focuses this tile's terminal, which is also
    // what makes it the selected instance for auto-pause and handoff.
    root.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      focusTile(group);
    });

    grid.appendChild(root);
    return {
      group,
      root,
      head,
      tabs,
      actions,
      termHost,
      msg,
      size,
      scrolledBadge: scrolled,
      note,
      noteInput,
      noteBtn,
      term: null,
      activeId: null,
      scrolled: false,
      chain: Promise.resolve(),
      gen: 0,
    };
  }

  // ---------------------------------------------------------------- ordering

  function reorder(from, before) {
    const groups = [...tiles.keys()];
    const next = order.filter((g) => groups.includes(g) && g !== from);
    for (const g of groups) if (!next.includes(g) && g !== from) next.push(g);
    const at = next.indexOf(before);
    next.splice(at < 0 ? next.length : at, 0, from);
    order = next;
    writeOrder(order);
    applyOrder();
  }

  function applyOrder() {
    const sorted = [...tiles.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
    for (const g of sorted) grid.appendChild(tiles.get(g).root);
    layout();
  }

  // ---------------------------------------------------------------- attach

  /**
   * Point a tile's single terminal at one instance.
   *
   * One terminal per tile is the whole reason a group costs one footprint, so switching
   * tab is an attach on the same handle. term.attach detaches the previous id first, and
   * pty.rs keys one pty per instance id, so nothing else can be holding what we release.
   */
  function setActive(tile, id) {
    const gen = ++tile.gen;
    tile.activeId = id;
    renderTile(tile);

    tile.chain = tile.chain.then(async () => {
      if (tile.gen !== gen || destroyed) return;
      const inst = id ? store.getInstance(id) : null;
      if (!inst || !inst.alive) {
        await tile.term?.detach();
        return;
      }
      if (!tile.term) {
        tile.term = createTerm(tile.termHost, {
          ...opts.term,
          fontSize: fontFor(tile.group),
          onResize: () => autoFont(tile),
        });
      }
      let ok = false;
      let why = 'attach failed';
      try {
        ok = await tile.term.attach(id);
      } catch (err) {
        why = String(err);
      }
      if (tile.gen !== gen) return; // the user switched tab while this was attaching
      if (ok) {
        tile.term.fit();
        showSize(tile);
      } else {
        showMessage(tile, `athena: ${why}`);
      }
    });
    tile.chain = tile.chain.catch((err) => console.error('[athena] tile', err));
    return tile.chain;
  }

  function showMessage(tile, text, action) {
    tile.msg.replaceChildren(el('span', null, text));
    if (action) {
      const b = el('button', 'ghost', action.label);
      b.type = 'button';
      b.onclick = action.run;
      tile.msg.appendChild(b);
    }
    tile.msg.hidden = false;
    tile.termHost.hidden = true;
  }

  // ---------------------------------------------------------------- size and zoom

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /**
   * Lay the tiles out as evenly as the count allows: as square a grid as possible, fuller
   * rows on top, and every row stretched to the full width.
   *
   * cols = ceil(sqrt(n)) gives the squarest shape; the remainder is spread so the top rows
   * carry the extra. To let a short last row fill the width, the grid is given lcm(row counts)
   * tracks and each tile spans an equal share of them: with 5 tiles that is 6 tracks, the top
   * three spanning 2 each and the bottom two spanning 3 each.
   *
   *   4 -> 2,2   5 -> 3,2   6 -> 3,3   7 -> 3,2,2   9 -> 3,3,3
   */
  function layout() {
    const items = [...grid.children].filter((n) => n.classList.contains('tile'));
    const n = items.length;
    if (!n) return;

    const wide = Math.max(1, Math.floor((host.clientWidth || 1200) / MIN_TILE_PX));
    const cols = Math.min(Math.ceil(Math.sqrt(n)), wide);
    const rows = Math.ceil(n / cols);
    const base = Math.floor(n / rows);
    const extra = n % rows;
    const counts = Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));

    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const tracks = counts.reduce((a, c) => (a * c) / gcd(a, c), 1);

    grid.style.gridTemplateColumns = `repeat(${tracks}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(${MIN_ROW_PX}px, 1fr))`;

    let i = 0;
    counts.forEach((count, r) => {
      const span = tracks / count;
      for (let p = 0; p < count; p += 1) {
        const el = items[i];
        i += 1;
        if (!el) return;
        el.style.gridColumn = `${p * span + 1} / span ${span}`;
        el.style.gridRow = `${r + 1}`;
      }
    });
  }

  function fontFor(group) {
    const n = Number(fonts[group]);
    return Number.isFinite(n) ? clamp(n, MIN_FONT, MAX_FONT) : DEFAULT_FONT;
  }

  /**
   * Keep a tile at MIN_COLS by shrinking its type, and let it grow back when there is room.
   *
   * Skipped entirely once the user has set a size by hand for that tile: an automatic
   * override of a deliberate choice is worse than a narrow pane. Ctrl-0 clears the manual
   * size and hands the tile back to this.
   */
  function autoFont(tile) {
    if (!tile?.term || tile.autoBusy) return;
    if (fonts[tile.group] !== undefined) return; // set by hand, leave it alone
    tile.autoBusy = true;
    try {
      // Character width scales with font size, so the size that yields MIN_COLS is a ratio
      // rather than a search. Three passes is ample; rounding to half points keeps it stable.
      for (let pass = 0; pass < 3; pass++) {
        const cols = tile.term.term.cols;
        const size = tile.term.term.options.fontSize;
        if (!cols) break;
        if (cols >= MIN_COLS && size >= DEFAULT_FONT) break;
        const want = clamp(Math.round(size * (cols / MIN_COLS) * 2) / 2, MIN_FONT, DEFAULT_FONT);
        if (Math.abs(want - size) < 0.25) break;
        tile.term.term.options.fontSize = want;
        tile.term.fit();
      }
    } finally {
      tile.autoBusy = false;
    }
    showSize(tile);
  }

  /**
   * Batch wheel movement into one tmux call at a time.
   *
   * A wheel event is not one scroll: a trackpad emits a stream of small pixel deltas, and
   * firing a tmux command per event meant hundreds of process spawns a second, issued
   * concurrently, so they completed out of order and the pane landed somewhere other than
   * where the gesture pointed. Pixels accumulate here, flush on a short timer as a single
   * line count, and only one call is ever in flight per tile. The pixel remainder is kept so
   * slow trackpad movement still adds up instead of being rounded away to nothing.
   */
  function queueScroll(tile, deltaPx) {
    // Scrolling DOWN while already at the bottom must do nothing at all. It used to enter
    // copy mode, fail to move, and be cancelled again by the bottom check, so every downward
    // notch made tmux enter and leave copy mode and repaint the pane. That thrash is what
    // made a line smear down the screen.
    if (!tile.scrolled && deltaPx > 0) return;

    tile.wheelPx = (tile.wheelPx || 0) + deltaPx;
    if (!tile.scrolled) {
      tile.scrolled = true;
      tile.scrolledBadge.hidden = false;
      // tmux draws its copy-mode cursor wherever the scroll has reached, which reads as the
      // prompt cursor wandering up the history. Hiding it locally is best effort: a tmux
      // redraw may put it back, and it is restored unconditionally when the scroll ends.
      tile.term?.write('\x1b[?25l');
    }
    if (tile.scrollTimer || tile.scrollBusy) return;
    tile.scrollTimer = setTimeout(flushScroll, 40, tile);
  }

  async function flushScroll(tile) {
    tile.scrollTimer = null;
    const lines = Math.trunc(tile.wheelPx / PX_PER_LINE);
    tile.wheelPx -= lines * PX_PER_LINE;
    if (!lines || !tile.activeId) return;
    // Same guard on the flush path: a downward batch when the pane is already live has
    // nowhere to go, and sending it would re-enter copy mode for nothing.
    if (!tile.scrolled && lines > 0) return;
    tile.scrollBusy = true;
    try {
      // The backend reports whether the pane is still in copy mode, so returning to the
      // bottom puts the tile back to live without a second round trip to ask.
      const stillScrolled = await tmuxScroll(tile.activeId, -lines);
      if (!stillScrolled) clearScrolled(tile);
    } catch {
      // A pane that went away mid-gesture is not worth reporting.
    } finally {
      tile.scrollBusy = false;
    }
    if (Math.abs(tile.wheelPx) >= PX_PER_LINE && !tile.scrollTimer) {
      tile.scrollTimer = setTimeout(flushScroll, 40, tile);
    }
  }

  /** Leave copy mode and put the tile back to live. Safe to call when not scrolled. */
  function clearScrolled(tile) {
    if (!tile || !tile.scrolled) return;
    tile.scrolled = false;
    tile.wheelPx = 0;
    tile.scrolledBadge.hidden = true;
    tile.term?.write('\x1b[?25h'); // whatever tmux did with it, leave it visible
    if (tile.activeId) endScroll(tile.activeId).catch(() => {});
  }

  /** Live character grid, plus the type size when it is not the default. */
  function showSize(tile) {
    if (!tile.term) {
      tile.size.textContent = '';
      return;
    }
    const t = tile.term.term;
    const px = t.options.fontSize;
    tile.size.textContent = `${t.cols}x${t.rows}${px !== DEFAULT_FONT ? ` @${px}` : ''}`;
  }

  function bumpFont(group, step) {
    const tile = tiles.get(group);
    if (!tile) return;
    const next = clamp(fontFor(group) + step, MIN_FONT, MAX_FONT);
    if (next === fontFor(group)) return;
    fonts[group] = next;
    writeMap(FONT_KEY, fonts);
    if (tile.term) {
      tile.term.term.options.fontSize = next;
      tile.term.fit();
      showSize(tile);
    }
  }

  function resetFont(group) {
    delete fonts[group];
    writeMap(FONT_KEY, fonts);
    const tile = tiles.get(group);
    if (tile?.term) {
      tile.term.term.options.fontSize = DEFAULT_FONT;
      tile.term.fit();
      autoFont(tile); // back under automatic control
    }
  }

  /**
   * Fill the whole window with one tile, or restore the layout.
   *
   * The refit is forced rather than left to the ResizeObserver. The observer does fire, but the
   * terminal has to re-measure AFTER the browser has laid the new geometry out, and a resize
   * that lands on the old character grid is exactly the "text did not reflow" symptom: two
   * animation frames put the fit safely past layout. The pty resize that follows is what makes
   * tmux send SIGWINCH, which is what makes the agent redraw itself at the new width.
   *
   * Escape is deliberately NOT bound to exit. It belongs to the agent in the terminal, and
   * stealing it to close a view would break cancelling a turn.
   */
  function toggleZoom(group) {
    const tile = tiles.get(group);
    if (!tile) return;
    const on = !tile.root.classList.contains('zoomed');
    for (const t of tiles.values()) t.root.classList.remove('zoomed');
    tile.root.classList.toggle('zoomed', on);
    grid.classList.toggle('has-zoom', on);
    if (on) focusTile(group);
    // Every tile may have changed size, not just this one: leaving the zoom restores the rest.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const t of tiles.values()) {
          t.term?.fit();
          if (t.term) showSize(t);
        }
      })
    );
  }

  /**
   * Type text into a tile's live terminal, exactly as if it had been typed at the keyboard.
   * Used by the file drop, so a dropped path lands at the cursor and nothing is submitted.
   *
   * The pane is taken out of copy mode first: a scrolled pane routes keystrokes to tmux's
   * scroller, so the paths would drive the scrollback instead of reaching the agent.
   */
  function insertText(group, text) {
    const tile = tiles.get(group);
    if (!tile?.activeId || !text) return;
    clearScrolled(tile);
    ptyWrite(tile.activeId, text);
  }

  function focusTile(group) {
    const tile = tiles.get(group);
    if (!tile) return;
    for (const [g, t] of tiles) t.root.classList.toggle('on', g === group);
    if (tile.activeId) store.setSelected(tile.activeId);
    tile.term?.focus();
  }

  // ---------------------------------------------------------------- notes

  /**
   * Paint the banner from what is stored. Called from renderTile, so it runs on the 1s poll:
   * the input's value is only written while the user is NOT in it, or every keystroke would
   * be overwritten by the next tick with whatever was last committed.
   */
  function renderNote(tile) {
    const text = tile.activeId ? getNote(tile.activeId) : '';
    const editing = document.activeElement === tile.noteInput;
    tile.note.hidden = !text && !editing;
    if (!editing) tile.noteInput.value = text;
    tile.noteBtn.setAttribute('aria-pressed', String(Boolean(text)));
    tile.noteBtn.title = text
      ? 'clear this note and let the instance signal normally again'
      : 'note what this instance is waiting on, and hold its needs-you alarm';
    tile.noteBtn.disabled = !tile.activeId;
  }

  /** Show the banner and put the caret in it. */
  function openNote(tile) {
    tile.note.hidden = false;
    tile.noteInput.value = getNote(tile.activeId);
    tile.noteInput.focus();
    tile.noteInput.select();
  }

  // ---------------------------------------------------------------- rendering

  /** " · B" for an instance on a second subscription; account "a" is the default and unmarked. */
  const acctTag = (i) => (i.account && i.account !== 'a' ? ` · ${i.account.toUpperCase()}` : '');
  // Which machine it runs on. Local instances say nothing, because that is still almost all of
  // them and a badge on every tab would be noise; a remote one names its host.
  const hostTag = (i) => (i.host ? ` · ${i.host}` : '');

  function renderTile(tile) {
    const members = store
      .getInstances()
      .filter((i) => i.group === tile.group)
      .sort((a, b) => a.created - b.created);

    // Tabs. Rebuilt each render because a tab is cheap and its state changes every second.
    tile.tabs.replaceChildren();
    for (const i of members) {
      const tab = el('button', 'tile-tab' + (i.id === tile.activeId ? ' on' : ''));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(i.id === tile.activeId));
      const iState = effectiveState(i);
      tab.title = `${i.name}: ${stateLabel(iState)}${acctTag(i)}${hostTag(i)}`;
      const dot = el('span', 'tile-dot');
      dot.dataset.state = iState;
      tab.append(dot, el('span', 'tile-tab-name', i.name + acctTag(i)));
      if (i.host) tab.append(el('span', 'tile-tab-host', i.host));
      tab.onclick = (e) => {
        e.stopPropagation();
        if (i.id !== tile.activeId) setActive(tile, i.id);
        focusTile(tile.group);
      };
      // Drag a tab onto another tile to move that instance there, which is also how two
      // tiles that should have been one get merged.
      tab.draggable = true;
      tab.addEventListener('dragstart', (ev) => {
        ev.stopPropagation();
        ev.dataTransfer.setData(MIME_INSTANCE, i.id);
        ev.dataTransfer.effectAllowed = 'move';
      });
      tile.tabs.appendChild(tab);
    }
    // A single healthy instance needs no tab strip, but then the head is the only place
    // its name can appear, so the title carries it instead of just the group.
    const soloTabs = members.length < 2 && members.every((i) => i.alive);
    tile.tabs.hidden = soloTabs;
    const solo = soloTabs ? members[0] : null;
    tile.head.querySelector('.tile-group').textContent =
      solo && solo.name !== tile.group ? `${tile.group} / ${solo.name}` : tile.group;

    // Actions apply to the active instance only, so the row never becomes a wall of buttons.
    const active = tile.activeId ? store.getInstance(tile.activeId) : null;
    tile.actions.replaceChildren();
    const activeState = effectiveState(active);
    if (active) {
      const state = el('span', 'tile-state', stateLabel(activeState) + acctTag(active));
      state.dataset.state = activeState;
      tile.actions.appendChild(state);
      const btn = (label, run, title) => {
        const b = el('button', 'ghost', label);
        b.type = 'button';
        if (title) b.title = title;
        b.onclick = (e) => {
          e.stopPropagation();
          run();
        };
        tile.actions.appendChild(b);
      };
      if (!active.alive) btn('restore', () => restore(active.id).then(store.refresh));
      else if (active.paused) btn('resume', () => setPaused(active.id, false).then(store.refresh));
      else btn('pause', () => setPaused(active.id, true).then(store.refresh));
      btn('close', () => {
        if (window.confirm(`Close ${active.name}?`)) closeInstance(active.id).then(store.refresh);
      }, 'kill the tmux session and forget the instance');
    }

    // The tile's own border carries the active instance's state, so a full screen of tiles
    // reads at a glance without hunting for a dot.
    tile.root.dataset.state = activeState;
    renderNote(tile);
    showSize(tile);

    // Body: a live instance shows its terminal, anything else says why it does not.
    if (active && active.alive) {
      tile.msg.hidden = true;
      tile.termHost.hidden = false;
    } else if (active) {
      showMessage(tile, `${active.name} is ${stateLabel(activeState)}.`, {
        label: 'restore',
        run: () => restore(active.id).then(store.refresh),
      });
    } else {
      showMessage(tile, 'No instances in this group.');
    }
  }

  // ---------------------------------------------------------------- store sync

  function sync() {
    if (destroyed) return;
    const instances = store.getInstances();
    const groups = new Set(instances.map((i) => i.group));
    // The live id set is already in hand here, so orphan notes cost no poll of their own.
    pruneNotes(instances.map((i) => i.id));

    for (const [g, tile] of [...tiles]) {
      if (groups.has(g)) continue;
      tiles.delete(g);
      if (tile.root.classList.contains('zoomed')) grid.classList.remove('has-zoom');
      tile.gen += 1; // cancel anything still queued on this tile
      tile.root.remove();
      tile.term?.dispose();
    }

    let added = false;
    for (const g of groups) {
      if (tiles.has(g)) continue;
      tiles.set(g, buildTile(g));
      added = true;
    }

    for (const [g, tile] of tiles) {
      const members = instances.filter((i) => i.group === g);
      const stillThere = members.some((i) => i.id === tile.activeId);
      if (!stillThere) {
        // Prefer something alive so a tile does not open on a corpse when one exists.
        const next = members.find((i) => i.alive) || members[0];
        setActive(tile, next ? next.id : null);
      } else {
        renderTile(tile);
      }
    }

    if (added) applyOrder();
    layout();
    empty.hidden = tiles.size > 0;
    grid.hidden = tiles.size === 0;
  }

  // Column count depends on the host width, so the layout is recomputed when the window is.
  const hostRO = new ResizeObserver(() => layout());
  hostRO.observe(host);

  store.subscribe(sync);
  // A note is a click, so it repaints now rather than up to a second later.
  const offNotes = subscribeNotes(() => {
    if (destroyed) return;
    for (const tile of tiles.values()) renderTile(tile);
  });
  sync();

  return {
    focusGroup: focusTile,
    insertText,
    toggleZoom,
    zoom: bumpFont,
    resetZoom: resetFont,
    async destroy() {
      destroyed = true;
      window.removeEventListener('drop', endDrag, true);
      window.removeEventListener('pointerdown', endDrag, true);
      hostRO.disconnect();
      offNotes();
      store.unsubscribe(sync);
      await Promise.all([...tiles.values()].map((t) => t.chain.catch(() => {})));
      await Promise.all([...tiles.values()].map((t) => t.term?.dispose()));
      tiles.clear();
      host.replaceChildren();
    },
  };
}
