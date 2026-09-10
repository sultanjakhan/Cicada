import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dates from '../src/dates.js';
import { layoutSegments } from '../src/layout.js';
import { previewStore } from '../src/preview-store.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const app = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

async function launch(t, decorate = store => store) {
  const dom = new JSDOM(html, { url: 'http://localhost/?preview=1', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // Imported date helpers and evaluated app must share a Date realm, as they do in the app.
  window.Date = Date;
  t.after(() => window.close());
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function (value) {
    this.returnValue = value ?? this.returnValue;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  const store = decorate(previewStore(window.sessionStorage));
  window.testApi = { ...dates, layoutSegments, createStore: async () => store };
  await window.eval(`(async () => { const { ${Object.keys(window.testApi).join(', ')} } = window.testApi; ${app}\n })()`);
  const query = selector => window.document.querySelector(selector);
  const click = async selector => { assert.ok(query(selector), `Missing ${selector}`); query(selector).click(); await settle(); };
  const fill = (name, value) => {
    const field = query('#recordForm').elements.namedItem(name);
    field.value = value;
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, store, query, click, fill };
}

test('empty start; create, edit, complete, reopen and delete a task through the rendered form', async t => {
  const { store, query, click, fill, window } = await launch(t);
  assert.equal((await store.list()).length, 0);
  await click('#newButton');
  fill('title', 'Example task');
  fill('date', '');
  await click('#saveButton');
  assert.equal(query('#editor').hidden, true);
  await click('#undatedButton');
  assert.match(query('#calendar').textContent, /Example task/);
  await click('[data-item]');
  fill('title', 'Edited task');
  await click('#saveButton');
  assert.equal((await store.list())[0].version, 2);
  await click('[data-complete]');
  assert.equal((await store.list())[0].completed, true);
  assert.equal(query('[data-item]'), null);
  const checkbox = query('#showCompleted');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await click('[data-item]');
  await click('#deleteButton');
  assert.equal(query('#confirmDialog').open, true);
  query('#confirmDialog').close('confirm');
  await settle();
  assert.equal((await store.list()).length, 0);
  assert.equal(query('#editor').hidden, true);
});

test('shared event editor persists a cross-midnight event and renders escaped text in every view', async t => {
  const { store, query, click, fill } = await launch(t);
  await click('#newButton');
  await click('[data-kind="event"]');
  assert.equal(query('#recordForm').elements.date.required, true);
  assert.equal(query('#completedField').hidden, true);
  fill('title', '<img src=x onerror=alert(1)>');
  fill('date', dates.todayKey());
  fill('time', '23:30');
  fill('duration_minutes', '90');
  await click('#saveButton');
  const [item] = await store.list();
  assert.equal(item.kind, 'event');
  assert.equal(item.duration_minutes, 90);
  for (const view of ['week', 'month', 'list']) {
    await click(`[data-view="${view}"]`);
    assert.match(query('#calendar').textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(query('#calendar img'), null);
  }
});

test('unsaved edits require explicit discard and a failed save keeps the entered text', async t => {
  const { query, click, fill } = await launch(t, store => ({ ...store, save: async () => { throw new Error('Simulated storage failure'); } }));
  await click('#newButton');
  fill('title', 'Keep this draft');
  await click('#saveButton');
  assert.equal(query('#editor').hidden, false);
  assert.equal(query('#titleInput').value, 'Keep this draft');
  assert.match(query('#formError').textContent, /Simulated storage failure/);
  await click('#closeEditor');
  query('#confirmDialog').close('cancel');
  await settle();
  assert.equal(query('#editor').hidden, false);
  await click('#closeEditor');
  query('#confirmDialog').close('confirm');
  await settle();
  assert.equal(query('#editor').hidden, true);
});

test('filtered next-day list groups a cross-midnight continuation under the selected day', async t => {
  const { query, store, click } = await launch(t);
  const today = dates.todayKey();
  const fields = { kind: 'event', notes: '', completed: false, duration_minutes: 90, expected_version: null };
  await store.save({ ...fields, title: 'Across midnight', date: dates.addDays(today, -1), time: '23:30' });
  for (let i = 0; i < 3; i++) await store.save({ ...fields, title: `Example ${i}`, date: today, time: null });
  await click('#retryButton');
  await click('[data-view="month"]');
  await click(`[data-day-list="${today}"]`);
  assert.equal(query('.agenda-group h2').textContent, `${dates.formatDay(today)}Сегодня`);
  assert.equal(query('.agenda-time').textContent, '↳ 00:00');
});

test('form stays disabled until an in-flight save finishes', async t => {
  let release;
  const { query, click, fill } = await launch(t, store => ({ ...store, save: input => new Promise(resolve => { release = async () => resolve(await store.save(input)); }) }));
  await click('#newButton');
  fill('title', 'Save once');
  await click('#saveButton');
  assert.equal(query('#titleInput').disabled, true);
  assert.equal(query('[data-kind="event"]').disabled, true);
  await release();
  await settle();
  assert.equal(query('#editor').hidden, true);
  assert.equal(query('#titleInput').disabled, false);
});

test('native adapter sends the exact command and argument contract', async t => {
  const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.__TAURI__ = { core: { invoke: async (...args) => { calls.push(JSON.parse(JSON.stringify(args))); } } };
  const source = (await readFile(new URL('../src/store.js', import.meta.url), 'utf8')).replace('export async function', 'async function').replaceAll('import.meta.env.DEV', 'false');
  const store = await dom.window.eval(`(async () => { ${source}; return createStore(); })()`);
  await store.list();
  await store.save({ title: 'Example', expected_version: 2 });
  await store.complete({ id: 'example-id', version: 3, completed: false });
  await store.remove({ id: 'example-id', version: 4 });
  await store.backup();
  assert.deepEqual(calls, [
    ['list_items'], ['save_item', { input: { title: 'Example', expected_version: 2 } }],
    ['set_completed', { id: 'example-id', expectedVersion: 3, completed: true }],
    ['delete_item', { id: 'example-id', expectedVersion: 4 }], ['create_backup'],
  ]);
});
