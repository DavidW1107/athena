// A terminal factory, not a terminal. Every piece of per-terminal state (xterm
// instance, fit addon, resize observer, pty event unlisten, attached id) is closed
// over inside createTerm, so a caller can hold four live terminals at once.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { onPty, ptyAttach, ptyDetach, ptyResize, ptyWrite } from './api.js';

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
 * @param {{ fontSize?: number, scrollback?: number, theme?: object, fontFamily?: string }} [opts]
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

  const ro = new ResizeObserver(() => {
    if (!attachedId) return;
    safeFit();
    ptyResize(attachedId, term.cols, term.rows);
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
    fit: safeFit,
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
