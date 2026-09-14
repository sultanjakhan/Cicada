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

async function launch(t, { mobile = false, initialSettings = [] } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], settings = new Map(initialSettings), errors = [], before = new Map();
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
    if (before.has(command)) await before.get(command)(args);
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
  return { w, calls, click, errors, before, settings };
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

test('v7 Today embeds native tasks and connects Add, All tasks and Schedule', async t => {
  const {w,click,errors}=await launch(t);
  assert.equal(w.document.querySelectorAll('.calendar-recurring__card').length,1);
  assert.equal(w.document.querySelector('[data-calendar-tasks]'),null);
  assert.ok(w.document.querySelector('[data-calendar-recurring] [data-overview-embedded]'));
  assert.equal(w.document.querySelector('[data-undo-day]'),null);
  await click('[data-recurring-add]');
  assert.equal(w.document.querySelectorAll('dialog[open]').length,1);
  assert.equal(w.document.querySelector('[data-add-kind="norm"]'),null);
  await click('[data-add-kind="task"]');
  assert.ok(w.document.querySelector('#evm-form'));
  assert.equal(w.document.querySelector('[data-add-kind]'),null,'choice closes before the shared Task/Event form opens');
  await click('#evm-close');
  await click('[data-recurring-all]');
  assert.equal(w.document.querySelector('dialog [data-overview-all]').hidden,false);
  await click('dialog footer [data-dialog-close]');
  await click('[data-pane="table"]');
  w.dispatchEvent(new w.CustomEvent('hanni:open-recurring-settings'));
  await settle();
  assert.equal(w.document.querySelectorAll('body > .calendar-recurring[hidden]').length,1);
  await click('dialog footer [data-dialog-close]');
  assert.equal(w.document.querySelectorAll('body > .calendar-recurring[hidden]').length,0);
  assert.deepEqual(errors,[]);
});

test('one persistent action below the Calendar heading opens the shared Task/Event editor and restores focus', async t => {
  const { w, click } = await launch(t);
  assert.equal(w.document.querySelector('[data-overview-create]'), null);
  const trigger = w.document.querySelector('[data-calendar-create]');
  assert.ok(trigger.closest('.uni-header-actions'));
  assert.equal(trigger.closest('.uni-header-actions').previousElementSibling.className, 'uni-header');
  assert.equal(trigger.closest('.uni-header-actions').nextElementSibling.className, 'uni-navigation');
  assert.equal(w.document.querySelector('#tab-bar [data-calendar-create]'), null);
  assert.equal(w.document.querySelector('.uni-header-desc'), null);
  assert.equal(trigger.closest('.uni-content'), null);
  trigger.focus();
  await click('[data-calendar-create]');
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
  assert.equal(w.document.querySelectorAll('[data-calendar-create]').length, 1);
  assert.equal(w.document.querySelector('[data-create]'), null);
  await click('[data-period="day"]');
  await click('[data-today]');
  await click('[data-next]');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await click('[data-calendar-create]');
  assert.equal(w.document.querySelector('#evm-date').value, date, 'creation uses the viewed date');
});

test('modal settings save without replacing the current calendar pane and return focus on close', async t => {
  const { w, click, calls } = await launch(t);
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  const pane = w.document.querySelector('.uni-pane');
  const scroll = w.document.querySelector('.uni-content'); scroll.scrollTop = 87;
  const trigger = w.document.querySelector('[data-calendar-settings]'); trigger.focus();
  await click('#tab-bar-bottom [aria-label="\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438"]');
  assert.equal(w.document.querySelector('.calendar-settings-dialog h2').textContent, 'Настройки календаря');
  assert.equal(w.document.querySelector('.uni-pane'), pane);
  assert.equal(w.document.querySelectorAll('.setting-pills').length, 3);
  assert.equal(w.document.querySelector('[data-theme-setting]'), null);
  assert.equal(w.document.querySelector('#mvp-settings'), null);
  await click('[data-key="first_day"] [data-value="sun"]');
  assert.equal(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'calendar_preferences_v1'), false);
  await click('.calendar-settings-dialog [type=submit]');
  assert.ok(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'calendar_preferences_v1' && JSON.parse(call.args.value).first_day === 'sun'));
  assert.ok(w.document.querySelector('[data-calendar-records]'));
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  assert.equal(w.document.querySelector('.uni-pane'), pane);
  assert.equal(scroll.scrollTop, 87);
  assert.equal(w.document.activeElement, trigger);
  assert.equal(w.document.querySelector('.calv-weekday').textContent, 'Вс');
  assert.equal(calls.some(call => call.command === 'create_backup'), false);
});

test('clicking the current sidebar item or pane preserves its DOM and scroll, and the header is static', async t => {
  const { w, click, calls } = await launch(t);
  for (const id of ['dash', 'table', 'goals', 'notes']) {
    await click(`[data-pane="${id}"]`);
    const pane = w.document.querySelector('.uni-pane');
    const scroll = w.document.querySelector('.uni-content'); scroll.scrollTop = 61;
    await click('[data-tab-id="calendar"]');
    await click(`[data-pane="${id}"]`);
    assert.equal(w.document.querySelector('.uni-pane'), pane);
    assert.equal(scroll.scrollTop, 61);
  }
  const heading = await click('.uni-header-name');
  assert.notEqual(heading.contentEditable, 'true');
  assert.equal(heading.hasAttribute('title'), false);
  assert.equal(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'tab_meta_calendar'), false);
});

test('settings save failure keeps the old selection and a retry can persist it', async t => {
  const { w, click, before, settings } = await launch(t);
  await click('[data-calendar-settings]');
  before.set('set_ui_state', () => { throw Error('offline'); });
  await click('[data-key="first_day"] [data-value="sun"]');
  await click('.calendar-settings-dialog [type=submit]');
  assert.equal(w.document.querySelector('[data-value="mon"]').getAttribute('aria-pressed'), 'false');
  assert.equal(w.document.querySelector('[data-value="sun"]').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('[data-dialog-error]').hidden, false);
  assert.equal(settings.has('calendar_preferences_v1'), false);
  before.delete('set_ui_state');
  await click('.calendar-settings-dialog [type=submit]');
  assert.equal(JSON.parse(settings.get('calendar_preferences_v1')).first_day, 'sun');
  assert.equal(w.document.querySelector('.calendar-settings-dialog'), null);
});

test('settings wait for acknowledgement before closing and ignore late loading after Escape', async t => {
  const { w, click, before } = await launch(t);
  await click('[data-calendar-settings]');
  let resolveSave;
  before.set('set_ui_state', () => new Promise(resolve => { resolveSave = resolve; }));
  await click('[data-key="first_day"] [data-value="sun"]');
  await click('.calendar-settings-dialog [type=submit]');
  const modal = w.document.querySelector('.calendar-settings-dialog');
  modal.dispatchEvent(new w.Event('cancel', { cancelable:true }));
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(modal.open, true);
  assert.equal(w.document.querySelector('[data-value="mon"]').getAttribute('aria-pressed'), 'false');
  resolveSave(); await settle();
  modal.dispatchEvent(new w.Event('cancel', { cancelable:true })); await settle();
  assert.equal(modal.isConnected, false);
  const pendingReads = [];
  before.set('get_app_setting', () => new Promise(resolve => pendingReads.push(resolve)));
  await click('[data-calendar-settings]');
  const loading = w.document.querySelector('.calendar-settings-dialog');
  loading.dispatchEvent(new w.Event('cancel', { cancelable:true })); await settle();
  pendingReads.forEach(resolve => resolve()); await settle();
  assert.equal(w.document.querySelector('.calendar-settings-dialog'), null);
  assert.equal(w.document.activeElement, w.document.querySelector('[data-calendar-settings]'));
});

test('saved calendar defaults determine the first Table view after startup', async t => {
  const { w, click } = await launch(t, { initialSettings:[['tab_calendar_first_day','sun'], ['tab_calendar_default_view','Неделя']] });
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelector('[data-period="week"]').getAttribute('aria-pressed'), 'true');
  assert.match(w.document.querySelector('.calv-day-weekday').textContent, /Вс/i);
  const range = w.document.querySelector('[data-range]').textContent;
  await click('[data-calendar-settings]');
  await click('[data-key="default_view"] [data-value="День"]');
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(w.document.querySelector('[data-period="week"]').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('[data-range]').textContent, range);
});

test('mobile creation returns to its visible action and settings return to the closed drawer opener', async t => {
  const { w, click } = await launch(t, { mobile:true });
  const create = await click('[data-calendar-create]');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  await click('#evm-close');
  assert.equal(w.document.activeElement, create);
  await click('#mobile-hamburger'); await click('[data-calendar-settings]');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(w.document.activeElement.id, 'mobile-hamburger');
});
