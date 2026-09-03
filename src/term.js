// A terminal factory, not a terminal. Every piece of per-terminal state (xterm
// instance, fit addon, resize observer, pty event unlisten, attached id) is closed
// over inside createTerm, so a caller can hold four live terminals at once.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { onPty, ptyAttach, ptyDetach, ptyResize, ptyWrite } from './api.js';

const THEME = { background: '#0a0908', foreground: '#e8e4dd', cursor: '#e0a03c' };

/**
 * Mount an xterm into `mountEl` and return a handle onto it.
 *
 *   const t = createTerm(document.querySelector('#term'));
 *   await t.attach('a1b2c3');   // resolves once the pty is open, or writes the error
 *   t.fit();                    // re-measure after a layout change
 *   await t.detach();           // clears the screen, leaves the tmux session running
 *   t.dispose();                // detach + tear down the xterm; handle is dead after
 *
 * @param {HTMLElement} mountEl
 * @param {{ fontSize?: number, scrollback?: number, theme?: object }} [opts]
 * @returns {{
 *   attach: (id: string) => Promise<boolean>,
 *   detach: () => Promise<void>,
 *   fit: () => void,
 *   focus: () => void,
 *   write: (s: string) => void,
 *   dispose: () => void,
 *   readonly attachedId: string|null,
 *   readonly term: Terminal
 * }}
 */
export function createTerm(mountEl, opts = {}) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
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
      term.write(`\r\n\x1b[31margus: ${err}\x1b[0m\r\n`);
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    if (attachedId) {
      ptyDetach(attachedId).catch(() => {});
      attachedId = null;
    }
    term.dispose();
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
