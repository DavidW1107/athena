// The adopt dialog: pull something Athena did not start into the fleet.
//
// Two lists, deliberately unequal in prominence. A tmux session is adopted by renaming it,
// which is instant, reversible and cannot disturb the terminal already attached to it. A
// bare process has to be moved with reptyr, which needs ptrace permission and can kill the
// process it is moving, so that half stays behind a preflight banner and says what it costs.

import {
  adoptProcess,
  adoptSession,
  importAgent,
  listAdoptableProcesses,
  listAdoptableSessions,
  listRunningAgents,
  pastSessions,
  reptyrCheck,
} from './api.js';
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

  async function adopt(run, label, closeAfter = true) {
    if (busy) return;
    busy = true;
    try {
      const view = await run();
      await store.refresh();
      if (closeAfter) dialog.close();
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

  /** A picker of recent transcripts, for a process whose session id is not in its argv. */
  async function sessionPicker(cwd) {
    const sel = document.createElement('select');
    sel.className = 'adopt-pick';
    sel.append(Object.assign(document.createElement('option'), { value: '', textContent: 'pick a session' }));
    for (const s of await pastSessions(cwd)) {
      sel.append(
        Object.assign(document.createElement('option'), {
          value: s.session_id,
          textContent: `${new Date(s.mtime * 1000).toLocaleString()}  ${s.title}`,
        })
      );
    }
    return sel;
  }

  async function render() {
    const [running, sessions, check] = await Promise.all([
      listRunningAgents(),
      listAdoptableSessions(),
      reptyrCheck(),
    ]);
    body.replaceChildren();

    // First, because on this machine it is the common case: agents running in ordinary
    // terminal windows, outside tmux, which can only be brought in by resuming them.
    const runSection = section(
      'running agents',
      'Athena stops the process and resumes its session in a tile. The conversation carries on from its transcript; anything mid-turn is lost. Stopping happens first, so two processes never append to one transcript.'
    );
    if (!running.length) {
      runSection.appendChild(el('p', 'adopt-empty', 'No agent processes of yours are running outside Athena.'));
    }
    const exact = running.filter((r) => r.session_id);
    if (exact.length > 1) {
      const all = el('button', 'primary', `import all ${exact.length}`);
      all.type = 'button';
      all.onclick = async () => {
        for (const r of exact) {
          // Sequential on purpose: each one stops a process and starts a tmux session.
          // eslint-disable-next-line no-await-in-loop
          await adopt(() => importAgent(r.pid, r.session_id, r.cwd, r.title || ''), `pid ${r.pid}`, false);
        }
        dialog.close();
      };
      runSection.appendChild(all);
    }
    for (const r of running) {
      const sub = `${r.cwd}${r.title ? ` and ${r.title}` : ''}`;
      if (r.session_id) {
        runSection.appendChild(
          row(`pid ${r.pid}  ${r.session_id.slice(0, 8)}`, sub, 'import', () =>
            adopt(() => importAgent(r.pid, r.session_id, r.cwd, r.title || ''), `pid ${r.pid}`)
          )
        );
      } else {
        // Started fresh, so its id is not in argv and nothing in /proc reveals it. Ask
        // rather than guess: a wrong guess resumes somebody else's conversation.
        const rowEl = row(`pid ${r.pid}`, `${r.cwd}  (started fresh, choose its session)`, 'import', () => {}, true);
        const pick = await sessionPicker(r.cwd);
        const btn = rowEl.querySelector('button');
        pick.onchange = () => {
          btn.disabled = !pick.value;
        };
        btn.onclick = () =>
          adopt(() => importAgent(r.pid, pick.value, r.cwd, pick.selectedOptions[0]?.textContent || ''), `pid ${r.pid}`);
        rowEl.querySelector('.adopt-text').appendChild(pick);
        runSection.appendChild(rowEl);
      }
    }
    body.appendChild(runSection);

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
