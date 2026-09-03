// The new-instance dialog. Owns the repo datalist, the last-directory memory, and
// the launch call; hands the new instance id back so the caller can select it.

import { launch, listRepos } from './api.js';
import * as store from './store.js';

const LAST_CWD = 'lastCwd';

/**
 * Wire the launcher dialog to its opening button.
 *
 *   mountLauncher({ dialog: $('#launcher'), openBtn: $('#new'), onLaunched: select });
 *
 * @param {{
 *   dialog: HTMLDialogElement,
 *   openBtn: HTMLElement,
 *   fields?: { cwd?: string, cmd?: string, name?: string, repos?: string },
 *   onLaunched?: (id: string) => void
 * }} cfg
 * @returns {{ open: () => Promise<void> }}
 */
export function mountLauncher({ dialog, openBtn, fields = {}, onLaunched }) {
  const sel = {
    cwd: fields.cwd || '#l-cwd',
    cmd: fields.cmd || '#l-cmd',
    name: fields.name || '#l-name',
    repos: fields.repos || '#repos',
  };
  const q = (s) => document.querySelector(s);

  async function open() {
    const repos = await listRepos();
    q(sel.repos).replaceChildren(
      ...repos.map((r) => Object.assign(document.createElement('option'), { value: r }))
    );
    q(sel.cwd).value = localStorage.getItem(LAST_CWD) || repos[0] || '';
    dialog.showModal();
  }

  if (openBtn) openBtn.onclick = open;

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'go') return;
    const cwd = q(sel.cwd).value.trim();
    if (!cwd) return;
    localStorage.setItem(LAST_CWD, cwd);
    try {
      const v = await launch(cwd, q(sel.cmd).value, q(sel.name).value.trim());
      q(sel.name).value = '';
      await store.refresh();
      onLaunched?.(v.id);
    } catch (err) {
      alert(err);
    }
  });

  return { open };
}
