// A terminal factory, not a terminal. Every piece of per-terminal state (xterm
// instance, fit addon, resize observer, pty event unlisten, attached id) is closed
// over inside createTerm, so a caller can hold four live terminals at once.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

import { onPty, primaryRead, primaryWrite, ptyAttach, ptyDetach, ptyRefresh, ptyResize, ptyWrite, uiLog } from './api.js';

// Kept in step with the tokens in style.css. xterm needs literal colours (it paints to a
// canvas and cannot read a CSS custom property), so this is the one place a hex is allowed.
// These sixteen values are copied verbatim from the palette the user's own terminal runs:
// Ptyxis, "VS Code" profile, [Dark] section. Do not "improve" them; the point is that output
// looks identical in Athena and in the terminal next to it. xterm paints to a canvas and
// cannot read a CSS custom property, which is why the literals live here.
const THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(0, 154, 251, 0.32)',
  black: '#6a787a',
  red: '#e9653b',
  green: '#39e9a8',
  yellow: '#e5b684',
  blue: '#44aae6',
  magenta: '#e17599',
  cyan: '#3dd5e7',
  white: '#c3dde1',
  brightBlack: '#598489',
  brightRed: '#e65029',
  brightGreen: '#00ff9a',
  brightYellow: '#e89440',
  brightBlue: '#009afb',
  brightMagenta: '#ff578f',
  brightCyan: '#5fffff',
  brightWhite: '#d9fbff',
};

/**
 * Mount an xterm into `mountEl` and return a handle onto it.
 *
 *   const t = createTerm(tileBodyElement);
 *   await t.attach('a1b2c3');   // resolves once the pty is open, or writes the error
 *   t.fit();                    // re-measure after a layout change
 *   await t.detach();           // clears the screen, leaves the tmux session running
 *   await t.dispose();          // detach + tear down the xterm; handle is dead after
 *
 * @param {HTMLElement} mountEl
 * @param {{ fontSize?: number, scrollback?: number, theme?: object, fontFamily?: string,
 *   onResize?: (cols: number, rows: number) => void }} [opts]
 * @returns {{
 *   attach: (id: string) => Promise<boolean>,
 *   detach: () => Promise<void>,
 *   fit: () => void,
 *   focus: () => void,
 *   write: (s: string) => void,
 *   dispose: () => Promise<void>,
 *   readonly attachedId: string|null,
 *   readonly term: Terminal
 * }}
 */
export function createTerm(mountEl, opts = {}) {
  const term = new Terminal({
    fontFamily: opts.fontFamily ?? '"Ubuntu Sans Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: opts.fontSize ?? 12.5,
    theme: opts.theme ?? THEME,
    scrollback: opts.scrollback ?? 8000,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(mountEl);

  let attachedId = null;
  let unlisten = null;
  let disposed = false;

  term.onData((d) => attachedId && ptyWrite(attachedId, d));

  // Ctrl+Shift+C / Ctrl+Shift+V, the way every Linux terminal binds them. Plain Ctrl+C has
  // to stay SIGINT, which is the whole reason the shifted pair exists.
  //
  // The system clipboard goes through the Tauri plugin rather than navigator.clipboard: on
  // Linux the webview is WebKitGTK, where the async clipboard READ sits behind a permission
  // request Tauri never answers, so navigator.clipboard.readText() rejects and paste silently
  // does nothing. The plugin reads it in Rust, where there is no permission gate.
  //
  // Returning false tells xterm to swallow the key, but xterm returns early WITHOUT calling
  // preventDefault, so the browser's own binding still fires. That matters for exactly one
  // key: WebKitGTK maps Ctrl+Shift+V to paste-as-plain-text, xterm's input textarea is
  // editable, and its native paste handler would then deliver the same text a second time.
  // preventDefault here is what makes the plugin the only path.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k !== 'c' && k !== 'v') return true;
    e.preventDefault();
    if (k === 'c') {
      // No selection means no copy, and the key is still swallowed rather than reaching the
      // agent as a stray control code. Matches GNOME Terminal.
      const sel = term.getSelection();
      if (sel) writeText(sel).catch((err) => console.error('[athena] copy', err));
    } else {
      // term.paste, not ptyWrite: it wraps the text in bracketed-paste markers when the
      // program asked for them, which is what stops a multi-line paste from being run line
      // by line by a shell, and what makes an agent TUI read it as one prompt.
      readText()
        .then((txt) => txt && term.paste(txt))
        .catch((err) => console.error('[athena] paste', err));
    }
    return false;
  });

  // ---------------------------------------------------------------- the other clipboard

  // Copy on select and middle-click paste: the pair of habits a Linux terminal gives you that
  // have nothing to do with Ctrl+Shift. Both move the PRIMARY selection rather than the
  // clipboard, which is what keeps them from ever touching what Ctrl+Shift+C put there.
  //
  // Neither can be left to the browser. xterm's own Linux support here only moves its hidden
  // textarea under the pointer and hopes the engine does the rest, which is a Chromium
  // behaviour; WebKitGTK is the engine in a Tauri window, and its rules for propagating a
  // textarea selection to PRIMARY are not the ones a terminal needs. So both directions are
  // explicit, and the browser's own attempt is suppressed to avoid pasting twice.

  // Selecting with the mouse takes PRIMARY, exactly as dragging over text in any terminal does.
  //
  // On mouseup rather than onSelectionChange, which fires on every pixel of a drag and would be
  // one IPC round trip per mouse move. The timeout is because xterm finishes the selection on a
  // document-level mouseup that runs after this one has bubbled: without it the text read here
  // is the selection as it stood one event ago.
  mountEl.addEventListener('mouseup', () => {
    setTimeout(() => {
      if (disposed) return;
      // A click that clears the selection leaves PRIMARY alone rather than blanking it. That is
      // also what every terminal does: clicking away does not empty your middle-click buffer.
      const sel = term.getSelection();
      if (sel) primaryWrite(sel).catch((err) => console.error('[athena] primary', err));
    }, 0);
  });

  // Middle click pastes PRIMARY.
  //
  // preventDefault on all three events because WebKit can act on any of them: mousedown for
  // autoscroll, mouseup for its own global-selection paste, auxclick for what xterm binds.
  // The paste itself hangs off mousedown so it happens the instant the button goes down.
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    mountEl.addEventListener(type, (e) => {
      if (e.button !== 1) return;
      // A program that turned mouse reporting on wants the button itself, so it gets it, and
      // shift is the override every terminal offers for exactly that case. Without the override
      // middle-click paste would just quietly stop working inside anything using the mouse.
      if (term.modes.mouseTrackingMode !== 'none' && !e.shiftKey) return;
      e.preventDefault();
      if (type !== 'mousedown') return;
      primaryRead()
        .then((txt) => txt && term.paste(txt))
        .catch((err) => console.error('[athena] primary paste', err));
    });
  }

  // ---------------------------------------------------------------- write-queue guard

  // xterm 5.5's WriteBuffer only schedules a flush when a write lands on an EMPTY queue. If
  // parsing one chunk throws, the flush loop dies with that chunk still queued, and from then
  // on every write just appends: the tile freezes on its last frame for good, while resizes
  // (a separate path) keep working. That is the "frozen tile" seen 2026-09-23: tmux still
  // delivering, Rust still reading, nothing drawn until Athena restarted.
  //
  // Two layers. The wrapper stops the wedge at source: a chunk that throws is logged with its
  // bytes, skipped, and the tile repainted by tmux. The watchdog covers any other way the
  // queue can stall: no progress for two ticks means kick the flush and repaint.
  // ponytail: reaches into xterm privates (_core._writeBuffer); pinned to 5.5, re-check on upgrade.
  const wb = term._core?._writeBuffer;
  const repaint = () => attachedId && ptyRefresh(attachedId).catch(() => {});
  let watchdog = null;
  if (wb && typeof wb._action === 'function' && typeof wb._innerWrite === 'function') {
    const parse = wb._action;
    wb._action = (data, promiseResult) => {
      try {
        return parse(data, promiseResult);
      } catch (err) {
        uiLog(`parse threw on ${attachedId}: ${err} @ ${err?.stack} chunk=${JSON.stringify(String(data).slice(0, 600))}`);
        repaint();
        return undefined; // treated as a finished sync write, so the loop moves on
      }
    };
    let lastOffset = -1;
    let lastLen = -1;
    watchdog = setInterval(() => {
      const queued = wb._writeBuffer.length > wb._bufferOffset;
      if (queued && wb._bufferOffset === lastOffset && wb._writeBuffer.length >= lastLen) {
        uiLog(`write queue stalled on ${attachedId}: ${wb._writeBuffer.length - wb._bufferOffset} chunks, ${wb._pendingData} bytes; kicked`);
        lastOffset = -1;
        wb._innerWrite();
        repaint();
        return;
      }
      lastOffset = queued ? wb._bufferOffset : -1;
      lastLen = wb._writeBuffer.length;
    }, 2000);
  } else {
    uiLog('xterm write buffer internals changed; write-queue guard is off');
  }

  /**
   * Re-measure AND tell the pty, which are two different things.
   *
   * safeFit alone only changes how many cells xterm draws. The pty has to be resized as well,
   * because that is what makes tmux resize the pane, which is what delivers SIGWINCH, which is
   * what makes the agent redraw at the new width. Fitting without the pty resize is exactly the
   * "it got bigger but the text did not reflow" symptom.
   */
  function fitAndSync() {
    if (disposed) return;
    safeFit();
    if (attachedId) ptyResize(attachedId, term.cols, term.rows);
    // The owner gets told the new character grid, which is what lets a caller react to a
    // pane that has become too narrow. Called after the pty resize so the number reported
    // is the one the agent will actually be drawing into.
    opts.onResize?.(term.cols, term.rows);
  }

  const ro = new ResizeObserver(() => {
    if (!attachedId) return;
    fitAndSync();
  });
  ro.observe(mountEl);

  function safeFit() {
    try {
      fitAddon.fit();
    } catch {
      // fit throws while the element is display:none; the next observation retries.
    }
  }

  async function detach() {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (attachedId) {
      const id = attachedId;
      attachedId = null;
      await ptyDetach(id).catch(() => {});
    }
    if (!disposed) term.reset();
  }

  async function attach(id) {
    if (disposed) return false;
    if (attachedId === id) return true;
    await detach();
    safeFit();
    unlisten = await onPty(id, (chunk) => term.write(chunk));
    try {
      await ptyAttach(id, term.cols, term.rows);
      attachedId = id;
      term.focus();
      return true;
    } catch (err) {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      term.write(`\r\n\x1b[31mathena: ${err}\x1b[0m\r\n`);
      return false;
    }
  }

  /**
   * Tear the handle down and return the pty detach, so a caller that is about to attach the
   * same instance id somewhere else can await it. pty.rs keys one pty per id and `attach` on
   * an already-attached id is a successful no-op, so a re-attach that overtakes this detach
   * would be a no-op followed by the detach killing the pty both ends thought they had.
   * @returns {Promise<void>} resolves once the pty is released.
   */
  function dispose() {
    if (disposed) return Promise.resolve();
    disposed = true;
    ro.disconnect();
    clearInterval(watchdog);
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    let released = Promise.resolve();
    if (attachedId) {
      released = ptyDetach(attachedId).catch(() => {});
      attachedId = null;
    }
    term.dispose();
    return released;
  }

  return {
    attach,
    detach,
    fit: fitAndSync,
    focus: () => term.focus(),
    write: (s) => term.write(s),
    dispose,
    get attachedId() {
      return attachedId;
    },
    get term() {
      return term;
    },
  };
}
