// The adopt dialog: pull something Athena did not start into the fleet.
//
// Two lists, deliberately unequal in prominence. A tmux session is adopted by renaming it,
// which is instant, reversible and cannot disturb the terminal already attached to it. A
// bare process has to be moved with reptyr, which needs ptrace permission and can kill the
// process it is moving, so that half stays behind a preflight banner and says what it costs.

import { adoptProcess, adoptSession, listAdoptableProcesses, listAdoptableSessions, reptyrCheck } from './api.js';
import * as store from './store.js';
import './adopt.css';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Wire the adopt dialog to its opening button.
 *
 *   mountAdopt({ dialog: $('#adopter'), openBtn: $('#adopt'), onAdopted: select });
 *
 * @param {{
 *   dialog: HTMLDialogElement,
 *   openBtn?: HTMLElement,
 *   onAdopted?: (id: string) => void
 * }} cfg
 * @returns {{ open: () => Promise<void> }}
 */
export function mountAdopt({ dialog, openBtn, onAdopted }) {
  const body = el('div', 'adopt-body');
  const menu = el('menu', 'adopt-menu');
  const closeBtn = el('button', 'ghost', 'close');
  closeBtn.type = 'button';
  closeBtn.onclick = () => dialog.close();
  menu.appendChild(closeBtn);
  dialog.replaceChildren(el('h2', 'adopt-title', 'Adopt something already running'), body, menu);

  let busy = false;

  async function adopt(run, label) {
    if (busy) return;
    busy = true;
    try {
      const view = await run();
      await store.refresh();
      dialog.close();
      onAdopted?.(view.id);
    } catch (err) {
      // The backend's message is the useful one here (a vanished session, a refused
      // ptrace), so it is shown as-is rather than replaced with a generic failure.
      window.alert(`Could not adopt ${label}: ${err}`);
      await render();
    } finally {
      busy = false;
    }
  }

  function row(title, sub, actionLabel, onAction, disabled = false) {
    const r = el('div', 'adopt-row');
    const text = el('div', 'adopt-text');
    text.append(el('div', 'adopt-row-title', title), el('div', 'adopt-row-sub', sub));
    const btn = el('button', 'primary', actionLabel);
    btn.type = 'button';
    btn.disabled = disabled;
    btn.onclick = onAction;
    r.append(text, btn);
    return r;
  }

  function section(heading, note) {
    const s = el('section', 'adopt-section');
    s.appendChild(el('h3', 'adopt-heading', heading));
    if (note) s.appendChild(el('p', 'adopt-note', note));
    return s;
  }

  async function render() {
    const [sessions, check] = await Promise.all([listAdoptableSessions(), reptyrCheck()]);
    body.replaceChildren();

    const tmuxSection = section(
      'tmux sessions',
      'Adopting renames the session to athena_<id>. Anything already attached to it stays attached and keeps working.'
    );
    if (!sessions.length) {
      tmuxSection.appendChild(el('p', 'adopt-empty', 'No tmux sessions that Athena does not already own.'));
    }
    for (const s of sessions) {
      tmuxSection.appendChild(
        row(
          s.session,
          `${s.command} in ${s.cwd}${s.attached ? ', attached elsewhere' : ''}`,
          'adopt',
          () => adopt(() => adoptSession(s.session, ''), s.session)
        )
      );
    }
    body.appendChild(tmuxSection);

    const procSection = section(
      'bare processes',
      'An agent running outside tmux. Moving it needs reptyr, which ptrace-attaches to the live process, and the move can kill it. Prefer finishing the turn first.'
    );
    if (!check.ok) {
      const warn = el('div', 'adopt-blocked');
      warn.appendChild(el('p', 'adopt-blocked-why', check.message));
      if (check.fix) {
        const pre = el('pre', 'adopt-fix');
        pre.textContent = check.fix;
        warn.appendChild(pre);
      }
      warn.appendChild(
        el('p', 'adopt-note', 'Athena will not change this for you. Run it yourself if you want it, then reopen this dialog.')
      );
      procSection.appendChild(warn);
    }
    const procs = check.ok ? await listAdoptableProcesses() : [];
    if (check.ok && !procs.length) {
      procSection.appendChild(el('p', 'adopt-empty', 'No agent processes of yours are running outside tmux.'));
    }
    for (const p of procs) {
      procSection.appendChild(
        row(`pid ${p.pid}`, `${p.cmd}${p.cwd ? ` in ${p.cwd}` : ''}`, 'move it', () =>
          adopt(() => adoptProcess(p.pid, ''), `pid ${p.pid}`)
        )
      );
    }
    body.appendChild(procSection);
  }

  async function open() {
    await render();
    dialog.showModal();
  }

  if (openBtn) openBtn.onclick = open;
  return { open };
}
