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

  /**
   * Open the launcher, optionally prefilled.
   *
   * A tile's + button passes that tile's directory. Grouping is by repo, so launching into
   * the same directory is all it takes for the instance to land back in the same tile; the
   * launcher needs no concept of groups at all.
   *
   * @param {{ cwd?: string, cmd?: string, name?: string }} [prefill]
   */
  async function open(prefill = {}) {
    const repos = await listRepos();
    q(sel.repos).replaceChildren(
      ...repos.map((r) => Object.assign(document.createElement('option'), { value: r }))
    );
    q(sel.cwd).value = prefill.cwd || localStorage.getItem(LAST_CWD) || repos[0] || '';
    if (prefill.cmd) {
      const cmdEl = q(sel.cmd);
      // Only preselect a command the dropdown actually offers; an adopted instance's
      // command can be anything that was running in the session Athena took over.
      if ([...cmdEl.options].some((o) => o.value === prefill.cmd)) cmdEl.value = prefill.cmd;
    }
    q(sel.name).value = prefill.name || '';
    dialog.showModal();
  }

  if (openBtn) openBtn.onclick = () => open();

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
