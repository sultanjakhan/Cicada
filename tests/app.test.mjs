import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { build } from 'vite';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const result = await build({
  configFile: false, root: new URL('../src', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'app.js', formats: ['iife'], name: 'HanniUnderTest' },
    rolldownOptions: { output: { codeSplitting: false } } }
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(file => file.type === 'chunk').code;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function launch(t) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], settings = new Map(), errors = [];
  w.structuredClone = structuredClone;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.addEventListener('error', event => errors.push(event.message));
  w.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (['get_calendar_records','get_calendar_tasks','get_goals','get_calendar_task_goals','get_timeline_blocks','get_task_pins','get_notes','get_all_events'].includes(command)) return [];
    if (command === 'get_active_block') return null;
    if (command === 'get_ui_state' || command === 'get_app_setting') return settings.get(args.key) || null;
    if (command === 'set_ui_state' || command === 'set_app_setting') { settings.set(args.key, args.value); return; }
    if (command === 'list_event_categories') return [{ id: 'general', name: 'Общее', color: '#9B9B9B', icon: '' }];
    if (command === 'get_calendar_task_minutes') return 0;
    if (command === 'create_backup') return 'example-backup.db';
    throw new Error('Unexpected IPC: ' + command);
  } }, event: { listen: async () => () => {}, emit: async () => {} } };
  for (const name of ['highlight.min.js','marked.min.js','vendor/purify.min.js']) w.eval(await readFile(new URL('../src/public/' + name, import.meta.url), 'utf8'));
  w.eval(bundle);
  await settle();
  t.after(async () => {
    w.document.querySelector('#evm-close')?.click();
    await settle();
    dom.window.close();
  });
  const click = async selector => { const el = w.document.querySelector(selector); assert.ok(el, 'Missing ' + selector); el.click(); await settle(); return el; };
  return { w, calls, click, errors };
}

test('installed shell boots the original workspace and all four panes with only Calendar in the sidebar', async t => {
  const { w, click, calls, errors } = await launch(t);
  assert.equal(w.document.title, 'Hanni MVP');
  assert.deepEqual([...w.document.querySelectorAll('#tab-list [data-tab-id]')].map(el => el.dataset.tabId), ['calendar']);
  assert.deepEqual([...w.document.querySelectorAll('.uni-tab')].map(el => el.textContent), ['Дашборд','Таблица','Цели','Заметки']);
  assert.ok(w.document.querySelector('[data-calendar-now]'));
  for (const [pane, selector] of [['table','.calendar-workspace-table'],['goals','.calendar-goals'],['notes','.calendar-notes']]) {
    await click('[data-pane="' + pane + '"]');
    assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, pane);
    if (pane !== 'table') assert.ok(w.document.querySelector(selector), selector);
  }
  assert.ok(calls.some(call => call.command === 'get_calendar_records'));
  assert.ok(calls.some(call => call.command === 'get_notes'));
  assert.equal(w.document.getElementById('mvp-alert').hidden, true, w.document.getElementById('mvp-alert').textContent);
  assert.deepEqual(errors, []);
});

test('original shared Task/Event editor opens from the dashboard', async t => {
  const { w, click } = await launch(t);
  await click('[data-overview-create]');
  assert.ok(w.document.querySelector('#evm-form'));
  assert.ok(w.document.querySelector('#evm-title'));
  assert.ok(w.document.querySelector('#evm-goal'));
  const toggle = w.document.querySelector('[data-editor-type="event"]');
  assert.ok(toggle, 'shared event switch');
  toggle.click();
  await settle();
  assert.ok(w.document.querySelector('#evm-date'));
  assert.equal(w.document.getElementById('mvp-alert').hidden, true);
});

test('MVP settings preserve the separate name, theme and local backup action', async t => {
  const { w, click, calls } = await launch(t);
  await click('#tab-bar-bottom [aria-label="Настройки"]');
  assert.equal(w.document.getElementById('mvp-settings').open, true);
  const select = w.document.getElementById('mvp-theme');
  select.value = 'dark'; select.dispatchEvent(new w.Event('change'));
  assert.equal(w.document.documentElement.dataset.theme, 'dark');
  await click('#mvp-backup');
  assert.ok(calls.some(call => call.command === 'create_backup'));
  assert.match(w.document.getElementById('mvp-backup-result').textContent, /example-backup.db/);
});
