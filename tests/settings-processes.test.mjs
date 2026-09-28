// «Процессы задач» inside Calendar settings (2026-09-25): the dialog's Save also
// saves pending process edits; Cancel and Escape write nothing. Fictional data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
async function boot() {
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
  const dom = new JSDOM('<button id="t">gear</button>', { url: 'http://x', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const ui = new Map(), writes = [];
  dom.window.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'get_ui_state') return ui.get(args.key) ?? null;
    if (command === 'get_app_setting') return null;
    if (command === 'set_ui_state') { writes.push(args.key); ui.set(args.key, args.value); return null; }
    throw Error(command);
  } } };
  const module = await import(`../src/hanni/js/calendar-settings.js?${Math.random()}`);
  module.showCalendarSettings(document.querySelector('#t'));
  await tick();
  const modal = document.querySelector('dialog');
  const input = selector => modal.querySelector(selector);
  const type = (field, value) => { field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const submit = async () => { modal.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick(); };
  return { dom, modal, ui, writes, input, type, submit };
}

test('process changes save from their own section and never piggyback on calendar preferences', async () => {
  const x = await boot();
  const section = x.modal.querySelector('.calendar-processes');
  assert.ok(section, 'the editor is part of Calendar settings');
  assert.equal(section.querySelector('h3').textContent, 'Процессы задач');
  x.type(section.querySelector('[data-stage-id="analysis"] [data-control="stage-title"]'), 'Модели');
  assert.deepEqual(x.writes, [], 'editing a process does not write preferences');
  assert.equal(x.modal.querySelector('[type="submit"]').hidden, true, 'the calendar Save is absent while its preferences are clean');
  section.querySelector('[data-processes-save]').click();
  await tick();
  assert.equal(x.modal.open, true, 'saving processes keeps the settings panel open');
  assert.ok(x.writes.includes('calendar_processes_v1'));
  assert.equal(x.writes.some(key => key === 'calendar_preferences_v1'), false);
  const stored = JSON.parse(x.ui.get('calendar_processes_v1'));
  assert.equal(stored.processes[0].stages.find(stage => stage.id === 'analysis').title, 'Модели');
});

test('an invalid process keeps the dialog open; Escape dismisses close confirmation', async () => {
  const x = await boot();
  const section = x.modal.querySelector('.calendar-processes');
  x.type(section.querySelector('[data-control="process-title"]'), '');
  section.querySelector('[data-processes-save]').click();
  await tick();
  assert.equal(x.modal.open, true);
  assert.deepEqual(x.writes, [], 'nothing is written');
  assert.equal(section.querySelector('[data-processes-error]').textContent, 'Назови процесс.');
  assert.equal(document.activeElement, section.querySelector('[data-control="process-title"]'));
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(x.modal.open, true);
  assert.equal(x.modal.querySelector('[data-close-confirmation]').hidden, false);
  x.modal.dispatchEvent(new x.dom.window.Event('cancel', { cancelable: true }));
  assert.equal(x.modal.querySelector('[data-close-confirmation]').hidden, true);
  assert.equal(x.modal.open, true);
  x.modal.querySelector('[data-close-confirmation] button:last-child').click();
  assert.equal(x.modal.open, false);
  assert.deepEqual(x.writes, [], 'Escape writes nothing');
});

test('saving calendar preferences never discards a process draft', async () => {
  const x = await boot();
  const section = x.modal.querySelector('.calendar-processes');
  const stage = section.querySelector('[data-stage-id="analysis"] [data-control="stage-title"]');
  x.type(stage, 'Модели');
  const day = x.modal.querySelector('[data-value="sun"]');
  day.click();
  await x.submit();
  assert.equal(x.modal.open, true);
  assert.equal(x.modal.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Процессы задач');
  assert.equal(section.querySelector('[data-stage-id="analysis"] [data-control="stage-title"]').value, 'Модели');
  assert.ok(x.writes.includes('calendar_preferences_v1'));
  assert.equal(x.writes.includes('calendar_processes_v1'), false);
  assert.match(x.modal.querySelector('[data-settings-status]').textContent, /Черновик процессов ещё не сохранён/);
  section.querySelector('[data-processes-save]').click();
  await tick();
  assert.equal(x.modal.open, true);
  assert.ok(x.writes.includes('calendar_processes_v1'));
});
