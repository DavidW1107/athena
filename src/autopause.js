// Auto-pause: the three rules, their thresholds, and a log of the last ten things the rules
// did with the reason for each, so a job that stopped on its own can always be explained.
//
// Two things this panel is careful about, because the backend can only be as safe as the
// signals it is given:
//
//   * selection is pushed to Rust the moment it moves, outside the tick, so the backend's
//     signal gate reads a current value rather than one snapshotted before the tick began;
//   * every configuration change reconciles, including switching the last rule off, and a
//     selection change always reconciles even when no rule is enabled. Otherwise an instance
//     parked by the blocked rule would stay frozen after the rule that froze it was turned off.
//
// The heartbeat rides the store's existing 1s poll (one evaluation every fifth tick); this
// module never starts a timer of its own.

import './autopause.css';
import { autopauseConfig, autopauseSave, autopauseSelect, autopauseTick } from './api.js';
import * as store from './store.js';

const loadRules = autopauseConfig;
const saveRules = autopauseSave;
const evaluate = autopauseTick;
const pushSelected = autopauseSelect;

/** Store ticks between evaluations. The store polls once a second. */
const HEARTBEAT = 5;
const LOG_MAX = 10;

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const clampInt = (v, lo, hi, fallback) => {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const time = (ts) => new Date((ts || 0) * 1000).toLocaleTimeString([], { hour12: false });

/**
 * Mount the auto-pause control into the header.
 * @param {HTMLElement} host
 * @param {{ heartbeat?: number }} [opts]
 * @returns {{ destroy: () => void }}
 */
export function mountAutopause(host, opts = {}) {
  const heartbeat = opts.heartbeat || HEARTBEAT;

  let rules = {
    memory_enabled: true,
    memory_threshold: 70,
    waiting_enabled: true,
    waiting_tags: [],
    blocked_enabled: false,
    blocked_minutes: 20,
  };
  let held = [];
  let log = [];
  let dirty = false;
  let ticking = false;
  let queued = false;
  let lastSelected = undefined;
  let optionSig = '';
  let beat = 0;
  let saveChain = Promise.resolve();

  // ---------------------------------------------------------------- chrome

  const root = el('div', 'ap-root');
  root.innerHTML = `
    <button type="button" class="ap-chip" aria-expanded="false" aria-controls="ap-panel">
      <span class="ap-dot" aria-hidden="true"></span><span class="ap-chip-text">auto-pause</span>
    </button>
    <div class="ap-panel" id="ap-panel" role="group" aria-label="Auto-pause rules" hidden>
      <fieldset class="ap-form" disabled>
        <legend class="ap-sr">Auto-pause rules</legend>

        <section class="ap-rule">
          <div class="ap-head">
            <span class="ap-eyebrow">01 · memory pressure</span>
            <label class="ap-switch"><input type="checkbox" id="ap-mem" aria-label="memory pressure rule"><span>on</span></label>
          </div>
          <p class="ap-note">Above the threshold, one instance is stopped per tick and everything
            paused starts again after two calm ticks. A Claude turn in flight is never stopped.</p>
          <div class="ap-field">
            <label for="ap-mem-th">avg10 threshold</label>
            <input id="ap-mem-th" type="number" min="5" max="100" step="1" inputmode="numeric">
            <span class="ap-unit">%</span>
          </div>
          <p class="ap-readout" id="ap-psi" aria-live="polite">no sample yet</p>
        </section>

        <section class="ap-rule">
          <div class="ap-head">
            <span class="ap-eyebrow">02 · waiting on another run</span>
            <label class="ap-switch"><input type="checkbox" id="ap-wait" aria-label="waiting on another run rule"><span>on</span></label>
          </div>
          <p class="ap-note">A tagged instance stays parked until pbuild's ledger reports that
            shard done.</p>
          <ul class="ap-tags" id="ap-tags"></ul>
          <div class="ap-add">
            <label class="ap-sr" for="ap-tag-inst">instance</label>
            <select id="ap-tag-inst"></select>
            <label class="ap-sr" for="ap-tag-run">run</label>
            <input id="ap-tag-run" placeholder="run" autocomplete="off" spellcheck="false">
            <label class="ap-sr" for="ap-tag-shard">shard</label>
            <input id="ap-tag-shard" placeholder="shard" autocomplete="off" spellcheck="false">
            <button type="button" id="ap-tag-add">hold</button>
          </div>
          <p class="ap-err" id="ap-tag-err" role="alert"></p>
        </section>

        <section class="ap-rule">
          <div class="ap-head">
            <span class="ap-eyebrow">03 · blocked too long</span>
            <label class="ap-switch"><input type="checkbox" id="ap-blk" aria-label="blocked too long rule"><span>on</span></label>
          </div>
          <p class="ap-note">Parked after this long at needs-you, and started again the moment
            you select it.</p>
          <div class="ap-field">
            <label for="ap-blk-min">park after</label>
            <input id="ap-blk-min" type="number" min="1" max="1440" step="1" inputmode="numeric">
            <span class="ap-unit">min</span>
          </div>
        </section>
      </fieldset>

      <div class="ap-held" id="ap-held"></div>
      <div class="ap-eyebrow ap-log-head">last ten actions</div>
      <ol class="ap-log" id="ap-log"></ol>
    </div>`;
  host.replaceChildren(root);

  const $ = (sel) => root.querySelector(sel);
  const chip = $('.ap-chip');
  const chipText = $('.ap-chip-text');
  const dot = $('.ap-dot');
  const panel = $('#ap-panel');
  const form = $('.ap-form');
  const memOn = $('#ap-mem');
  const memTh = $('#ap-mem-th');
  const psiOut = $('#ap-psi');
  const waitOn = $('#ap-wait');
  const tagList = $('#ap-tags');
  const tagInst = $('#ap-tag-inst');
  const tagRun = $('#ap-tag-run');
  const tagShard = $('#ap-tag-shard');
  const tagErr = $('#ap-tag-err');
  const blkOn = $('#ap-blk');
  const blkMin = $('#ap-blk-min');
  const heldOut = $('#ap-held');
  const logOut = $('#ap-log');

  // ---------------------------------------------------------------- rendering

  function syncFields() {
    memOn.checked = !!rules.memory_enabled;
    memTh.value = String(clampInt(rules.memory_threshold, 5, 100, 70));
    waitOn.checked = !!rules.waiting_enabled;
    blkOn.checked = !!rules.blocked_enabled;
    blkMin.value = String(clampInt(rules.blocked_minutes, 1, 1440, 20));
  }

  function renderChip() {
    const on = [rules.memory_enabled, rules.waiting_enabled, rules.blocked_enabled].filter(Boolean).length;
    chipText.textContent = held.length ? `auto-pause ${on}/3 · ${held.length} held` : `auto-pause ${on}/3`;
    dot.dataset.tone = held.length ? 'held' : on ? 'armed' : 'off';
    chip.title = held.length
      ? held.map((h) => `${h.name}: ${h.reasons.join(' + ')}`).join('\n')
      : 'auto-pause rules';
  }

  function renderHeld() {
    heldOut.replaceChildren();
    if (!held.length) {
      heldOut.textContent = 'nothing held';
      return;
    }
    for (const h of held) {
      const row = el('div', 'ap-held-row');
      const name = el('span', 'ap-held-name');
      name.textContent = h.name;
      const why = el('span', 'ap-held-why');
      why.textContent = h.resume_pending ? `${h.reasons.join(' + ')} · resume retrying` : h.reasons.join(' + ');
      row.append(name, why);
      heldOut.appendChild(row);
    }
  }

  function renderTags() {
    tagList.replaceChildren();
    if (!rules.waiting_tags.length) {
      const li = el('li', 'ap-tag-empty');
      li.textContent = 'no instance is waiting on a shard';
      tagList.appendChild(li);
      return;
    }
    for (const t of rules.waiting_tags) {
      const li = el('li', 'ap-tag');
      const label = el('span', 'ap-tag-name');
      const inst = store.getInstance(t.id);
      label.textContent = `${inst ? inst.name : t.id} → ${t.run}:${t.shard}`;
      const drop = el('button');
      drop.type = 'button';
      drop.textContent = 'clear';
      drop.setAttribute('aria-label', `stop waiting on ${t.run}:${t.shard}`);
      drop.onclick = () => {
        rules.waiting_tags = rules.waiting_tags.filter((x) => x !== t);
        renderTags();
        commit();
      };
      li.append(label, drop);
      tagList.appendChild(li);
    }
  }

  function renderLog() {
    logOut.replaceChildren();
    if (!log.length) {
      const li = el('li', 'ap-log-empty');
      li.textContent = 'nothing yet';
      logOut.appendChild(li);
      return;
    }
    for (const a of log) {
      const li = el('li', 'ap-log-row');
      li.dataset.kind = a.kind;
      const when = el('span', 'ap-log-time');
      when.textContent = time(a.ts);
      const what = el('span', 'ap-log-what');
      what.textContent = `${a.name ? `${a.name} ` : ''}${a.kind}`;
      const why = el('span', 'ap-log-why');
      why.textContent = a.reason;
      li.append(when, what, why);
      logOut.appendChild(li);
    }
  }

  function note(kind, reason) {
    push({ id: '', name: '', rule: 'none', kind, reason, ts: Math.floor(Date.now() / 1000) });
    renderLog();
  }

  function push(a) {
    const last = log[0];
    // A notice that repeats every tick (an unreadable PSI file, say) is one line, not ten.
    if (last && last.kind === a.kind && last.reason === a.reason && last.id === a.id) {
      last.ts = a.ts;
      return;
    }
    log.unshift(a);
    log = log.slice(0, LOG_MAX);
  }

  function syncInstanceOptions() {
    const list = store.getInstances();
    const sig = list.map((i) => `${i.id}:${i.name}`).join('|');
    if (sig === optionSig || document.activeElement === tagInst) return;
    optionSig = sig;
    const keep = tagInst.value;
    tagInst.replaceChildren();
    for (const i of list) {
      const o = el('option');
      o.value = i.id;
      o.textContent = `${i.group}/${i.name}`;
      tagInst.appendChild(o);
    }
    if (list.some((i) => i.id === keep)) tagInst.value = keep;
  }

  // ---------------------------------------------------------------- the tick

  async function runTick() {
    if (ticking) {
      // A selection or an edit that arrives mid-tick is queued, never dropped: the blocked
      // rule has to release the instant the user selects what it parked.
      queued = true;
      return;
    }
    ticking = true;
    try {
      const report = await evaluate(rules);
      held = report.held || [];
      for (const a of report.actions || []) push(a);
      psiOut.textContent =
        report.psi === null || report.psi === undefined
          ? 'no PSI on this kernel'
          : `avg10 ${report.psi.toFixed(0)}% of ${report.threshold.toFixed(0)}% · calm ${Math.min(report.calm, 2)}/2${report.high ? ' · over' : ''}`;
      renderChip();
      renderHeld();
      renderLog();
    } catch (err) {
      note('error', `tick failed: ${err}`);
    } finally {
      ticking = false;
      if (queued) {
        queued = false;
        runTick();
      }
    }
  }

  /**
   * Persist the rules and reconcile at once, whether a rule went on, off or nowhere.
   * Saves run one at a time on a chain: two quick edits would otherwise race, and the
   * slower one landing second would write the older configuration back over the newer.
   */
  function commit() {
    dirty = true;
    renderChip();
    saveChain = saveChain.then(async () => {
      try {
        rules = await saveRules(rules);
        syncFields();
      } catch (err) {
        note('error', `could not save the rules: ${err}`);
      }
      await runTick();
    });
    return saveChain;
  }

  // ---------------------------------------------------------------- events

  memOn.onchange = () => {
    rules.memory_enabled = memOn.checked;
    commit();
  };
  memTh.onchange = () => {
    rules.memory_threshold = clampInt(memTh.value, 5, 100, 70);
    memTh.value = String(rules.memory_threshold);
    commit();
  };
  waitOn.onchange = () => {
    rules.waiting_enabled = waitOn.checked;
    commit();
  };
  blkOn.onchange = () => {
    rules.blocked_enabled = blkOn.checked;
    commit();
  };
  blkMin.onchange = () => {
    // Whole minutes only: the backend reads this as a number of seconds to compare against.
    rules.blocked_minutes = clampInt(blkMin.value, 1, 1440, 20);
    blkMin.value = String(rules.blocked_minutes);
    commit();
  };

  $('#ap-tag-add').onclick = () => {
    const id = tagInst.value;
    const run = tagRun.value.trim();
    const shard = tagShard.value.trim();
    const bad = (s) => !s || /[\s/\\]/.test(s);
    if (!id) return (tagErr.textContent = 'pick an instance first');
    if (bad(run) || bad(shard)) return (tagErr.textContent = 'run and shard are single words, no slashes');
    tagErr.textContent = '';
    rules.waiting_tags = [...rules.waiting_tags.filter((t) => t.id !== id), { id, run, shard }];
    tagRun.value = '';
    tagShard.value = '';
    renderTags();
    commit();
  };

  chip.onclick = () => {
    const open = panel.hidden;
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  };

  const close = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  };

  const onKey = (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      close();
      chip.focus();
    }
  };
  const onDown = (e) => {
    if (!panel.hidden && !root.contains(e.target)) close();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown);

  const off = store.subscribe(({ selected }) => {
    if (selected !== lastSelected) {
      lastSelected = selected;
      // Straight through, ahead of any tick: this is what the backend's signal gate reads.
      pushSelected(selected).catch((err) => note('error', `selection push failed: ${err}`));
      // And reconcile now even with every rule off, so a parked instance resumes on selection.
      runTick();
    }
    syncInstanceOptions();
    if (++beat % heartbeat === 0 && (rules.memory_enabled || rules.waiting_enabled || rules.blocked_enabled || held.length)) {
      runTick();
    }
  });

  // ---------------------------------------------------------------- boot

  syncFields();
  renderChip();
  renderHeld();
  renderTags();
  renderLog();

  (async () => {
    try {
      const saved = await loadRules();
      // A load that lands after the user has already edited something is discarded rather
      // than allowed to overwrite the edit.
      if (!dirty) {
        rules = saved;
        syncFields();
        renderTags();
        renderChip();
      }
    } catch (err) {
      note('error', `could not read the rule config: ${err}`);
    } finally {
      form.disabled = false;
      runTick();
    }
  })();

  return {
    destroy() {
      off();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      host.replaceChildren();
    },
  };
}
