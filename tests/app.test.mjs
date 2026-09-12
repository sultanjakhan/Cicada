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

async function launch(t, { mobile = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], settings = new Map(), errors = [];
  if (mobile) w.localStorage.setItem('hanni_force_mobile', '1');
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

test('bundled shell boots the original workspace and all four panes with only Calendar in the sidebar', async t => {
  const { w, click, calls, errors } = await launch(t);
  assert.equal(w.document.title, 'Hanni MVP');
  assert.ok(w.document.documentElement.classList.contains('desktop'));
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
  assert.deepEqual(errors, []);
});

test('upstream mobile mode enables its CSS and closes the drawer through its backdrop', async t => {
  const { w, click } = await launch(t, { mobile: true });
  assert.ok(w.document.documentElement.classList.contains('mobile'));
  await click('#mobile-hamburger');
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.ok(w.document.querySelector('#tab-bar').classList.contains('drawer-open'));
  assert.ok(w.document.querySelector('.drawer-backdrop').classList.contains('visible'));
  await click('.drawer-backdrop');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  assert.equal(w.document.querySelector('.drawer-backdrop').classList.contains('visible'), false);
});

test('one persistent header action opens the shared Task/Event editor and restores focus', async t => {
  const { w, click } = await launch(t);
  assert.equal(w.document.querySelector('[data-overview-create]'), null);
  const trigger = w.document.querySelector('.uni-header-action');
  assert.ok(trigger.closest('.uni-navigation'));
  assert.ok(trigger.closest('.uni-navigation').querySelector('.uni-tabs'));
  assert.equal(w.document.querySelector('.uni-header-desc'), null);
  assert.equal(trigger.closest('.uni-content'), null);
  trigger.focus();
  await click('.uni-header-action');
  assert.ok(w.document.querySelector('#evm-form'));
  assert.ok(w.document.querySelector('#evm-title'));
  assert.ok(w.document.querySelector('#evm-goal'));
  const toggle = w.document.querySelector('[data-editor-type="event"]');
  assert.ok(toggle, 'shared event switch');
  toggle.click();
  await settle();
  assert.ok(w.document.querySelector('#evm-date'));
  await click('#evm-close');
  assert.equal(w.document.activeElement, trigger);
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelectorAll('.uni-header-action').length, 1);
  assert.equal(w.document.querySelector('[data-create]'), null);
  await click('[data-period="day"]');
  await click('[data-today]');
  await click('[data-next]');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await click('.uni-header-action');
  assert.equal(w.document.querySelector('#evm-date').value, date, 'creation uses the viewed date');
});

test('Calendar settings retain only upstream general definitions and restore the workspace', async t => {
  const { w, click, calls } = await launch(t);
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  await click('#tab-bar-bottom [aria-label="\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438"]');
  assert.equal(w.document.querySelector('.settings-page-title').textContent, '\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u2014 \u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c');
  assert.equal(w.document.querySelectorAll('.setting-pills').length, 2);
  assert.equal(w.document.querySelector('[data-theme-setting]'), null);
  assert.equal(w.document.querySelector('#mvp-settings'), null);
  await click('[data-setting-key="first_day"] [data-value="sun"]');
  assert.ok(calls.some(call => call.command === 'set_app_setting' && call.args.key === 'tab_calendar_first_day' && call.args.value === 'sun'));
  await click('#tab-bar-bottom [aria-label="\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438"]');
  assert.ok(w.document.querySelector('[data-calendar-records]'));
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  assert.equal(calls.some(call => call.command === 'create_backup'), false);
});
