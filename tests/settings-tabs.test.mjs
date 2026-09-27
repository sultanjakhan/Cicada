import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const windows = new Set();
afterEach(() => {
  for (const window of windows) {
    window.document.querySelectorAll('dialog').forEach(dialog => dialog.close());
    window.close();
  }
  windows.clear();
});

async function boot({ failPreferenceSave = false, failPreferenceLoad = false, delayPreferenceLoad = false, deferProcessSave = false, initialPreferences = null, section = 'next-action', recommendationsOnly = false } = {}) {
  const dom = new JSDOM('<button id="settings">Настройки</button>', { url: 'http://cicada.local', pretendToBeVisual: true });
  windows.add(dom.window);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };

  const ui = new Map(), writes = [], calls = [];
  if (initialPreferences) ui.set('calendar_preferences_v1', JSON.stringify(initialPreferences));
  let preferenceFailures = failPreferenceLoad ? 1 : 0;
  let resolvePreferenceLoad = null, deferredPreferenceUsed = false, resolveProcessSave = null;
  dom.window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    calls.push(command);
    if (command === 'get_ui_state') {
      if (args.key === 'calendar_preferences_v1') {
        if (preferenceFailures > 0) { preferenceFailures--; throw Error('preferences offline'); }
        if (delayPreferenceLoad && !deferredPreferenceUsed) {
          deferredPreferenceUsed = true;
          return new Promise(resolve => { resolvePreferenceLoad = () => resolve(ui.get(args.key) ?? null); });
        }
      }
      return ui.get(args.key) ?? null;
    }
    if (command === 'get_app_setting') return null;
    if (command === 'set_ui_state') {
      writes.push(args.key);
      if (failPreferenceSave && args.key === 'calendar_preferences_v1') throw Error('preferences offline');
      if (deferProcessSave && args.key === 'calendar_processes_v1') {
        return new Promise(resolve => { resolveProcessSave = () => { ui.set(args.key, args.value); resolve(null); }; });
      }
      ui.set(args.key, args.value); return null;
    }
    if (command === 'mvp_sync_status') return { configured: true, enabled: true, pending: 0, conflicts: 0, running: false };
    if (command === 'health_sleep_status') return { status: 'unsupported' };
    if (command === 'health_activity_status') return { status: 'unsupported' };
    if (command === 'digital_activity_status') return { enabled: false, devices: [] };
    if (command === 'mvp_update_status') return { installed_version: '0.3.35', configured: false, phase: 'idle' };
    if (command === 'mvp_sync_set_enabled') return { configured: true, enabled: args.enabled, pending: 0, conflicts: 0, running: false };
    throw Error(command);
  } } };

  const module = await import(`../src/hanni/js/calendar-settings.js?${Math.random()}`);
  module.showCalendarSettings(document.querySelector('#settings'), { section, recommendationsOnly });
  await tick();
  return { dom, ui, writes, calls, modal: document.querySelector('dialog'),
    resolvePreferenceLoad: () => resolvePreferenceLoad?.(), resolveProcessSave: () => resolveProcessSave?.() };
}

test('tab semantics, deep link and keyboard navigation preserve a preference draft', async () => {
  const x = await boot();
  const { modal } = x;
  const tabs = [...modal.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 6);
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
  const panel = x.modal.querySelector('#calendar-settings-panel-processes');
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.ok(panel.classList.contains('calendar-settings-panel'), 'the editor mount keeps the panel styling and hidden-state selector');
});

test('restriction form draft participates in the existing close confirmation', async () => {
  const x=await boot({section:'restrictions'}),{modal}=x;
  const selected=modal.querySelector('[role="tab"][aria-selected="true"]');
  assert.equal(selected.textContent,'Ограничения');
  modal.querySelector('[data-da-add]').click();
  const label=modal.querySelector('[data-da-label]');label.value='Телефон';label.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));await tick();
  assert.equal(modal.querySelector('.calendar-settings-actions').dataset.dirty,'true');
  modal.querySelector('.calendar-settings-actions [data-dialog-close]').click();
  const confirmation=modal.querySelector('[data-close-confirmation]');assert.equal(confirmation.hidden,false);
  confirmation.querySelectorAll('button')[0].click();
  assert.equal(modal.open,true);assert.equal(label.value,'Телефон');
  modal.querySelector('.calendar-settings-actions [data-dialog-close]').click();
  confirmation.querySelectorAll('button')[1].click();
  assert.equal(modal.open,false);
});

test('preference controls stay disabled during a delayed read while connections remain usable', async () => {
  const x = await boot({ delayPreferenceLoad: true });
  const toggle = x.modal.querySelector('[data-key="recommendTasks"]');
  assert.equal(toggle.disabled, true);
  assert.match(x.modal.querySelector('.calendar-settings-loading').textContent, /Загружаем/);
  toggle.checked = false;
  toggle.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  assert.equal(x.modal.querySelector('[type="submit"]').hidden, true, 'the guarded handler does not create a draft before read completes');
  x.modal.querySelector('#calendar-settings-tab-connections').click();
  assert.equal(x.modal.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Подключения');
  assert.ok(x.modal.querySelector('[data-sync-now]'));
  x.resolvePreferenceLoad();
  await tick();
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, true, 'the loaded preference replaces an attempted synthetic edit');
});

test('recommendation sources honor a saved disabled master toggle after loading', async () => {
  const x = await boot({ initialPreferences: { version: 1, first_day: 'mon', default_view: 'Месяц', density: 'comfortable', showCompleted: false, recommendationsEnabled: false, recommendTasks: true, recommendRoutines: false } });
  assert.equal(x.modal.querySelector('[data-key="recommendationsEnabled"]').checked, false);
  assert.equal(x.modal.querySelector('[data-key="recommendTasks"]').disabled, true);
  assert.equal(x.modal.querySelector('[data-key="recommendRoutines"]').disabled, true);
});

test('Cancel opens inline confirmation; Escape or Continue resumes editing and explicit discard closes', async () => {
  const x = await boot();
  const toggle = x.modal.querySelector('[data-key="recommendTasks"]');
  toggle.checked = false;
  toggle.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  const cancel = x.modal.querySelector('[data-dialog-close]');
  cancel.click();
  const confirmation = x.modal.querySelector('[data-close-confirmation]');
  assert.equal(confirmation.hidden, false);
  assert.equal(document.activeElement, confirmation.querySelector('button'));
  assert.match(confirmation.textContent, /Есть несохранённые изменения/);
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(confirmation.hidden, true, 'Escape dismisses the inline confirmation');
  assert.equal(x.modal.open, true);
  cancel.click();
  assert.equal(confirmation.hidden, false);
  confirmation.querySelectorAll('button')[1].click();
  assert.equal(x.modal.open, false);
  assert.deepEqual(x.writes, []);
});

test('routine transition waits for explicit discard and does not fire on repeated close', async () => {
  const x = await boot();
  let opened = 0;
  x.dom.window.addEventListener('hanni:open-recurring-settings', () => { opened++; });
  const toggle = x.modal.querySelector('[data-key="recommendTasks"]');
  toggle.checked = false;
  toggle.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.modal.querySelector('[data-recurring]').click();
  assert.equal(x.modal.querySelector('[data-close-confirmation]').hidden, false);
  assert.equal(opened, 0);
  assert.equal(x.modal.querySelector('[data-dialog-close]').disabled, true);
  x.modal.querySelector('[data-dialog-close]').click();
  assert.equal(x.modal.open, true, 'a repeated close cannot close the dialog');
  assert.equal(opened, 0, 'a repeated close does not invoke the routines route');
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(x.modal.querySelector('[data-close-confirmation]').hidden, true);
  x.modal.querySelector('[data-recurring]').click();
  x.modal.querySelector('[data-close-confirmation] button:last-child').click();
  assert.equal(x.modal.open, false);
  assert.equal(opened, 1, 'the routines route runs only after explicit discard');
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
  assert.equal(x.modal.querySelector('[data-key="recommendTasks"]').disabled, true);
  assert.equal(x.modal.querySelector('[data-value="sun"]').disabled, true);
  assert.equal(x.modal.querySelector('[type="submit"]').disabled, true);
  assert.ok(x.calls.includes('mvp_sync_status'));
  x.modal.querySelector('[data-prefs-retry]').click();
  await tick();
  assert.equal(x.modal.querySelector('[data-key="recommendTasks"]').disabled, false);
  assert.equal(x.modal.querySelector('[data-prefs-error]').hidden, true);
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

test('an in-flight process save prevents closing the settings shell', async () => {
  const x = await boot({ deferProcessSave: true, delayPreferenceLoad: true });
  const process = x.modal.querySelector('.calendar-processes');
  const stage = process.querySelector('[data-stage-id="analysis"] [data-control="stage-title"]');
  stage.value = 'Модели'; stage.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
  process.querySelector('[data-processes-save]').click();
  await tick();
  assert.equal(x.modal.querySelector('.calendar-editor-actions [data-dialog-close]').disabled, true);
  x.resolvePreferenceLoad();
  await tick();
  assert.equal(x.modal.querySelector('.calendar-editor-actions [data-dialog-close]').disabled, true,
    'finishing the independent preference load does not clear the process pending lock');
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(x.modal.open, true);
  x.resolveProcessSave();
  await tick();
  assert.equal(x.modal.querySelector('.calendar-editor-actions [data-dialog-close]').disabled, false);
});

test('connection drafts survive calendar saves and closing requires explicit discard', async () => {
  const x = await boot();
  const preference = x.modal.querySelector('[data-key="recommendTasks"]');
  preference.checked = false;
  preference.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.modal.querySelector('#calendar-settings-tab-connections').click();
  const enabled = x.modal.querySelector('[data-sync-enabled]');
  enabled.checked = false;
  enabled.dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(x.modal.open, true);
  assert.equal(x.modal.querySelector('#calendar-settings-panel-connections').hidden, false);
  assert.equal(enabled.checked, false);
  assert.equal(x.calls.includes('mvp_sync_set_enabled'), false);
  assert.equal(x.ui.has('calendar_preferences_v1'), true);
  assert.equal(x.modal.querySelector('[data-settings-status]').hidden, false);
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(x.modal.querySelector('[data-close-confirmation]').hidden, false);
  x.modal.querySelector('[data-close-confirmation] button:first-of-type').click();
  x.modal.querySelector('[data-sync-cancel]').click();
  await tick();
  assert.equal(x.modal.querySelector('[data-settings-status]').hidden, true);
  x.modal.querySelector('footer [data-dialog-close]').click();
  assert.equal(x.modal.open, false);
});


test('Today entry exposes only selection settings and saves no unrelated preference',async()=>{
  const x=await boot({recommendationsOnly:true,initialPreferences:{density:'compact',showCompleted:true,recommendRoutines:false}});
  try {
    assert.match(x.modal.querySelector('h2').textContent,/Выбор следующего действия/);
    assert.equal(x.modal.querySelector('[role="tab"]'),null);
    assert.equal(x.modal.querySelector('[data-recurring]'),null);
    assert.equal(x.modal.querySelector('[data-key="showCompleted"]'),null);
    assert.equal(x.calls.some(c=>/^(mvp_sync_status|health_.*_status|mvp_update_status|digital_activity_.*)$/.test(c)),false,'focused entry does not read unrelated service status');
    const input=x.modal.querySelector('[data-key="recommendTasks"]');input.checked=false;input.dispatchEvent(new x.dom.window.Event('change',{bubbles:true}));
    const latest=JSON.parse(x.ui.get('calendar_preferences_v1'));latest.density='comfortable';latest.first_day='sun';
    x.ui.set('calendar_preferences_v1',JSON.stringify(latest));
    x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
    const saved=JSON.parse(x.ui.get('calendar_preferences_v1'));
    assert.equal(saved.recommendTasks,false);assert.equal(saved.recommendRoutines,false);
    assert.equal(saved.density,'comfortable');assert.equal(saved.first_day,'sun');assert.equal(saved.showCompleted,true);
    assert.equal(x.modal.open,false);
  } finally{x.modal.close();}
});
