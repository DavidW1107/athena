// Work report dialog: the page scripts/report.mjs renders, framed as-is, plus a window picker
// and a PDF export. All the rules live in that script; this file only shows its output.

import { exportReport, workReport } from './api.js';

export function mountReport(host) {
  host.innerHTML = `
    <div class="report-bar">
      <select class="report-hours" aria-label="window">
        <option value="24">last 24h</option>
        <option value="48">last 48h</option>
        <option value="168">last 7 days</option>
      </select>
      <button class="ghost report-refresh">refresh</button>
      <span class="report-status" aria-live="polite"></span>
      <span class="spacer"></span>
      <button class="primary report-export">export PDF</button>
    </div>
    <iframe class="report-frame" title="work report" sandbox></iframe>`;
  const $ = (s) => host.querySelector(s);
  const hours = () => Number($('.report-hours').value);
  let gen = 0;

  // Not awaited by the dialog: the first build of a window waits on the Haiku summaries, and
  // the dialog should open straight away and say so rather than sit on the button.
  function render() {
    const mine = ++gen;
    $('.report-status').textContent = 'building…';
    workReport(hours())
      .then((page) => {
        if (mine !== gen) return; // a newer window was picked meanwhile
        $('.report-frame').srcdoc = page;
        $('.report-status').textContent = '';
      })
      .catch((e) => mine === gen && ($('.report-status').textContent = `failed: ${e}`));
  }

  $('.report-hours').onchange = render;
  $('.report-refresh').onclick = render;
  $('.report-export').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    $('.report-status').textContent = 'exporting…';
    try {
      $('.report-status').textContent = `saved ${await exportReport(hours())}`;
    } catch (e) {
      $('.report-status').textContent = `export failed: ${e}`;
    } finally {
      ev.currentTarget.disabled = false;
    }
  };
  return { render };
}
