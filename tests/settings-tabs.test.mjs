import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

async function boot({ failPreferenceSave = false, failPreferenceLoad = false, section = 'next-action' } = {}) {
  const dom = new JSDOM('<button id="settings">Настройки</button>', { url: 'http://cicada.local', pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  dom.window.confirm = () => false;
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };

  const ui = new Map(), writes = [], calls = [];
  dom.window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    calls.push(command);
    if (command === 'get_ui_state') {
      if (failPreferenceLoad && args.key === 'calendar_preferences_v1') throw Error('preferences offline');
      return ui.get(args.key) ?? null;
    }
    if (command === 'get_app_setting') return null;
    if (command === 'set_ui_state') {
      writes.push(args.key);
      if (failPreferenceSave && args.key === 'calendar_preferences_v1') throw Error('preferences offline');
      ui.set(args.key, args.value); return null;
    }
    if (command === 'mvp_sync_status') return { configured: true, enabled: true, pending: 0, conflicts: 0, running: false };
    if (command === 'health_sleep_status') return { status: 'unsupported' };
    if (command === 'health_activity_status') return { status: 'unsupported' };
    if (command === 'mvp_update_status') return { installed_version: '0.3.35', configured: false, phase: 'idle' };
    if (command === 'mvp_sync_set_enabled') return { configured: true, enabled: args.enabled, pending: 0, conflicts: 0, running: false };
    throw Error(command);
  } } };

  const module = await import(`../src/hanni/js/calendar-settings.js?${Math.random()}`);
  module.showCalendarSettings(document.querySelector('#settings'), { section });
  await tick();
  return { dom, ui, writes, calls, modal: document.querySelector('dialog') };
}

test('tab semantics, deep link and keyboard navigation preserve a preference draft', async () => {
  const x = await boot();
  const { modal } = x;
  const tabs = [...modal.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 5);
  assert.equal(tabs.find(tab => tab.getAttribute('aria-selected') === 'true').textContent, 'Сегодня');
  assert.equal(modal.querySelector('[role="tabpanel"][aria-labelledby="calendar-settings-tab-today"]').hidden, false);

  const recommendations = modal.querySelector('[data-key="recommendTasks"]');
  recommendations.checked = false;
  recommendations.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  tabs[0].focus();
  tabs[0].dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(document.activeElement, tabs[1]);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(recommendations.checked, false, 'switching tabs keeps the Today draft mounted');
  tabs[1].dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(document.activeElement, tabs.at(-1));
  tabs.at(-1).dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(document.activeElement, tabs[0]);
  assert.equal(modal.querySelector('[type="submit"]').hidden, false);
});

test('the process deep link selects the task-stage tab', async () => {
  const x = await boot({ section: 'processes' });
  assert.equal(x.modal.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Этапы задач');
  assert.equal(x.modal.querySelector('#calendar-settings-panel-processes').hidden, false);
});

test('Cancel guards unsaved preferences and discards only after an explicit choice', async () => {
  const x = await boot();
  const toggle = x.modal.querySelector('[data-key="recommendTasks"]');
  toggle.checked = false;
  toggle.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  const cancel = x.modal.querySelector('[data-dialog-close]');
  cancel.click();
  assert.equal(x.modal.open, true, 'declining the native confirmation keeps the draft open');
  x.dom.window.confirm = () => true;
  cancel.click();
  assert.equal(x.modal.open, false);
  assert.deepEqual(x.writes, []);
});

test('a preference write failure stays in its edited tab and retains the draft', async () => {
  const x = await boot({ failPreferenceSave: true });
  const toggle = x.modal.querySelector('[data-key="recommendTasks"]');
  toggle.checked = false;
  toggle.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(x.modal.open, true);
  assert.equal(x.modal.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Сегодня');
  assert.equal(toggle.checked, false);
  assert.match(x.modal.querySelector('[data-prefs-error]').textContent, /черновик остался в форме/i);
  assert.doesNotMatch(x.modal.querySelector('[data-prefs-error]').textContent, /ничего не изменено/i);
});

test('connection actions remain available after preference load failure and do not use the calendar Save', async () => {
  const x = await boot({ failPreferenceLoad: true });
  assert.ok(x.modal.querySelector('[data-sync-save]'));
  assert.ok(x.modal.querySelector('[data-sleep-status]'));
  assert.ok(x.modal.querySelector('[data-activity-walking-status]'));
  assert.ok(x.modal.querySelector('[data-update-check]'));
  assert.match(x.modal.querySelector('[data-prefs-error]').textContent, /preferences offline/);
  assert.equal(x.modal.querySelector('[type="submit"]').disabled, true);
  assert.ok(x.calls.includes('mvp_sync_status'));
});

test('saving a connection uses its own action and does not write calendar preferences', async () => {
  const x = await boot();
  x.modal.querySelector('#calendar-settings-tab-connections').click();
  const enabled = x.modal.querySelector('[data-sync-enabled]');
  enabled.checked = false;
  enabled.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.modal.querySelector('[data-sync-save]').click();
  await tick();
  assert.ok(x.calls.includes('mvp_sync_set_enabled'));
  assert.equal(x.writes.includes('calendar_preferences_v1'), false);
  assert.equal(x.modal.open, true);
});
