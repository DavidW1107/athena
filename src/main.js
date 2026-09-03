import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const $ = (s) => document.querySelector(s);
const STATE_LABEL = { working: 'working', 'needs-you': 'needs you', idle: 'idle', dead: 'not running', ended: 'ended', paused: 'paused' };

let instances = [];
let selected = null;
let term = null, fit = null, unlisten = null, attachedId = null;
let lastStates = new Map();
let notifyOk = false;

// ------------------------------------------------------------------ terminal

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    theme: { background: '#0a0908', foreground: '#e8e4dd', cursor: '#e0a03c' },
    scrollback: 8000,
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  term.onData((d) => attachedId && invoke('pty_write', { id: attachedId, data: d }));
  new ResizeObserver(() => {
    if (!attachedId) return;
    fit.fit();
    invoke('pty_resize', { id: attachedId, cols: term.cols, rows: term.rows });
  }).observe($('#term'));
}

async function select(id) {
  if (attachedId === id) return;
  ensureTerm();
  if (unlisten) { unlisten(); unlisten = null; }
  if (attachedId) { await invoke('pty_detach', { id: attachedId }); attachedId = null; }
  term.reset();
  selected = id;
  const inst = instances.find((i) => i.id === id);
  if (!inst || !inst.alive) { render(); return; }
  fit.fit();
  unlisten = await listen(`pty:${id}`, (e) => term.write(e.payload));
  try {
    await invoke('attach', { id, cols: term.cols, rows: term.rows });
    attachedId = id;
    term.focus();
  } catch (err) {
    term.write(`\r\n\x1b[31margus: ${err}\x1b[0m\r\n`);
  }
  render();
}

// ------------------------------------------------------------------ render

function card(i) {
  const el = document.createElement('div');
  el.className = 'card' + (i.id === selected ? ' sel' : '');
  el.dataset.state = i.state;
  const detail = i.state === 'working' && i.tool ? i.tool : (i.summary || i.cmd);
  el.innerHTML = `
    <div class="banner"></div>
    <div class="card-body">
      <div class="card-top">
        <span class="card-name"></span>
        <span class="card-state">${STATE_LABEL[i.state] || i.state}</span>
      </div>
      <div class="card-sub"></div>
      <div class="card-actions"></div>
    </div>`;
  el.querySelector('.card-name').textContent = i.name;
  el.querySelector('.card-sub').textContent = detail || '';
  const acts = el.querySelector('.card-actions');
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    acts.appendChild(b);
  };
  if (!i.alive) btn('restore', () => invoke('restore', { id: i.id }).then(refresh));
  else if (i.paused) btn('resume', () => invoke('set_paused', { id: i.id, paused: false }).then(refresh));
  else btn('pause', () => invoke('set_paused', { id: i.id, paused: true }).then(refresh));
  btn('close', () => confirm(`Close ${i.name}?`) && invoke('close', { id: i.id }).then(() => { if (selected === i.id) { selected = null; attachedId = null; } refresh(); }));
  el.onclick = () => select(i.id);
  return el;
}

function render() {
  const pane = $('#tab-instances');
  pane.replaceChildren();
  const groups = new Map();
  for (const i of instances) {
    if (!groups.has(i.group)) groups.set(i.group, []);
    groups.get(i.group).push(i);
  }
  for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = document.createElement('div');
    h.className = 'group-label';
    h.textContent = `${g} · ${list.length}`;
    pane.appendChild(h);
    for (const i of list) pane.appendChild(card(i));
  }
  if (!instances.length) {
    pane.innerHTML = '<p class="muted">No instances. Hit <b>+ instance</b>.</p>';
  }

  const needs = instances.filter((i) => i.state === 'needs-you');
  const strip = $('#attention');
  strip.hidden = !needs.length;
  strip.replaceChildren();
  if (needs.length) {
    const b = document.createElement('b');
    b.textContent = `needs you (${needs.length})`;
    strip.appendChild(b);
    for (const i of needs) {
      const btn = document.createElement('button');
      btn.textContent = `${i.group}/${i.name}`;
      btn.onclick = () => select(i.id);
      strip.appendChild(btn);
    }
  }

  const alive = instances.filter((i) => i.alive).length;
  $('#counts').textContent = `${alive}/${instances.length} live · ${needs.length} waiting`;

  const inst = instances.find((i) => i.id === selected);
  $('#stage-bar').innerHTML = inst
    ? `<span>${inst.name}</span><span class="muted">${inst.cwd}</span><span class="muted">${STATE_LABEL[inst.state] || inst.state}</span>`
    : '<span class="muted">no instance selected</span>';
}

// ------------------------------------------------------------------ polling

async function refresh() {
  instances = await invoke('list_instances');
  for (const i of instances) {
    const prev = lastStates.get(i.id);
    if (prev && prev !== 'needs-you' && i.state === 'needs-you' && notifyOk) {
      sendNotification({ title: `${i.group} · ${i.name}`, body: i.summary || 'waiting on you' });
    }
    lastStates.set(i.id, i.state);
  }
  render();
}

async function refreshPressure() {
  const txt = await invoke('pbuild_status');
  const line = txt.split('\n').find((l) => l.startsWith('pressure:')) || txt.split('\n')[0] || '';
  $('#pressure').textContent = line.trim();
}

// ------------------------------------------------------------------ tabs

async function renderSessions() {
  const pane = $('#tab-sessions');
  pane.replaceChildren();
  const cwds = [...new Set(instances.map((i) => i.cwd))];
  if (!cwds.length) { pane.innerHTML = '<p class="muted">Launch something first; this lists past sessions for those directories.</p>'; return; }
  for (const cwd of cwds) {
    const h = document.createElement('div');
    h.className = 'group-label';
    h.textContent = cwd.split('/').pop();
    pane.appendChild(h);
    const rows = await invoke('past_sessions', { cwd });
    for (const s of rows) {
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = '<div class="row-title"></div><div class="row-sub"></div>';
      r.querySelector('.row-title').textContent = s.title;
      r.querySelector('.row-sub').textContent = new Date(s.mtime * 1000).toLocaleString();
      r.onclick = async () => {
        const v = await invoke('resume_session', { cwd, sessionId: s.session_id, name: s.title.slice(0, 24) });
        await refresh();
        select(v.id);
      };
      pane.appendChild(r);
    }
  }
}

async function renderCodex() {
  const pane = $('#tab-codex');
  pane.replaceChildren();
  const rows = await invoke('codex_tasks');
  if (!rows.length) { pane.innerHTML = '<p class="muted">No codex-task runs in ~/.codex/tasks.</p>'; return; }
  for (const t of rows) {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = '<div class="row-title"></div><div class="row-sub"></div>';
    r.querySelector('.row-title').textContent = `${t.status === 'running' ? '● ' : ''}${t.name}`;
    r.querySelector('.row-sub').textContent = `${t.status} · ${t.tail}`;
    r.title = t.dir;
    pane.appendChild(r);
  }
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of ['instances', 'sessions', 'codex']) $(`#tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === 'sessions') renderSessions();
    if (b.dataset.tab === 'codex') renderCodex();
  };
}

// ------------------------------------------------------------------ launcher

$('#new').onclick = async () => {
  const repos = await invoke('list_repos');
  $('#repos').replaceChildren(...repos.map((r) => Object.assign(document.createElement('option'), { value: r })));
  $('#l-cwd').value = localStorage.getItem('lastCwd') || repos[0] || '';
  $('#launcher').showModal();
};

$('#launcher').addEventListener('close', async (e) => {
  if ($('#launcher').returnValue !== 'go') return;
  const cwd = $('#l-cwd').value.trim();
  if (!cwd) return;
  localStorage.setItem('lastCwd', cwd);
  try {
    const v = await invoke('launch', { cwd, cmd: $('#l-cmd').value, name: $('#l-name').value.trim() });
    $('#l-name').value = '';
    await refresh();
    select(v.id);
  } catch (err) {
    alert(err);
  }
});

$('#resume-all').onclick = () => invoke('pbuild_resume_all').then(refreshPressure);

// ------------------------------------------------------------------ boot

(async () => {
  notifyOk = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  await refresh();
  await refreshPressure();
  setInterval(refresh, 1000);
  setInterval(refreshPressure, 5000);
})();
