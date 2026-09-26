// The new-instance dialog. Owns the repo datalist, the last-directory memory, and
// the launch call; hands the new instance id back so the caller can select it.

import { launch, listReposOn, listHosts } from './api.js';
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
 *   fields?: { cwd?: string, cmd?: string, name?: string, repos?: string, host?: string },
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
    host: fields.host || '#l-host',
  };
  const q = (s) => document.querySelector(s);

  // Which tile asked for this launch. A tile's + sets it so the instance joins that tile;
  // the header + leaves it null, which means the backend gives the instance its own tile.
  let pendingGroup = null;

  /**
   * Fill the repo datalist from whichever machine is selected, and pick a sensible directory.
   *
   * The repo lists are per machine and the paths only look alike: /home/david/Documents/GitHub on
   * the desktop is a symlink to a different user's home. So the remembered directory is only
   * offered back when the host it was remembered on is the one selected, otherwise a launch would
   * inherit a path that machine may not have.
   * @param {string} host
   * @param {string} [prefer]
   */
  async function fillRepos(host, prefer) {
    const repos = await listReposOn(host || null);
    q(sel.repos).replaceChildren(
      ...repos.map((r) => Object.assign(document.createElement('option'), { value: r }))
    );
    const remembered = localStorage.getItem(LAST_CWD + (host ? ':' + host : ''));
    q(sel.cwd).value = prefer || remembered || repos[0] || '';
  }

  /**
   * Open the launcher, optionally prefilled.
   *
   * A tile's + button passes that tile's directory. Grouping is by repo, so launching into
   * the same directory is all it takes for the instance to land back in the same tile; the
   * launcher needs no concept of groups at all.
   *
   * @param {{ cwd?: string, cmd?: string, name?: string, group?: string, host?: string }} [prefill]
   */
  async function open(prefill = {}) {
    pendingGroup = prefill.group || null;
    const hostEl = q(sel.host);
    if (hostEl) {
      const hosts = await listHosts();
      // A tile's + launches on the same machine that tile is already on, so an instance added to
      // a desktop tile does not silently land here.
      const want = prefill.host || '';
      hostEl.replaceChildren(
        Object.assign(document.createElement('option'), { value: '', textContent: 'this laptop' }),
        ...hosts.map((h) => Object.assign(document.createElement('option'), { value: h, textContent: h }))
      );
      hostEl.value = hosts.includes(want) ? want : '';
      hostEl.onchange = () => fillRepos(hostEl.value);
    }
    await fillRepos(hostEl ? hostEl.value : '', prefill.cwd);
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
    const host = q(sel.host)?.value || '';
    localStorage.setItem(LAST_CWD + (host ? ':' + host : ''), cwd);
    try {
      // No pending group means the header + asked, and that always opens its own tile.
      const v = await launch(
        cwd,
        q(sel.cmd).value,
        q(sel.name).value.trim(),
        pendingGroup,
        !pendingGroup,
        host || null
      );
      q(sel.name).value = '';
      await store.refresh();
      onLaunched?.(v.id);
    } catch (err) {
      alert(err);
    }
  });

  return { open };
}
