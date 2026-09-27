import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
globalThis.window = bootstrap.window; globalThis.document = bootstrap.window.document;
globalThis.CustomEvent = bootstrap.window.CustomEvent; globalThis.localStorage = bootstrap.window.localStorage;
globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
const { openCalendarRoutineEditor } = await import('../src/hanni/js/calendar-routine-editor.js');

function setup(t, plan = null, savePlan = async fields => ({ state: { plans: [fields] } })) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.invalid' });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  t.after(() => dom.window.close());
  const calls = [];
  const store = { savePlan: async (...args) => { calls.push(args); return savePlan(...args); } };
  const dialog = openCalendarRoutineEditor({ document: dom.window.document, store, plan });
  return { dom, dialog, calls };
}
function flush() { return new Promise(resolve => setImmediate(resolve)); }
async function submit(dialog) { dialog.form.dispatchEvent(new dialog.modal.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true })); await flush(); await flush(); }

test('routine editor starts compact and saves a single action without extra steps', async t => {
  const { dialog, calls } = setup(t);
  const body = dialog.body;
  assert.equal(body.querySelector('.cre-advanced[open]'), null);
  assert.equal(body.querySelectorAll('[data-routine-weekday]').length, 7);
  body.querySelector('[data-routine-title]').value = 'Ежедневное действие';
  await submit(dialog);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].mode, 'check');
  assert.deepEqual(calls[0][0].steps, []);
});

test('graph editor preserves later dependencies through reorder and converts chain options without losing edges', async t => {
  const original = { id: 'graph-1', kind: 'action', mode: 'graph', title: 'Routine', steps: [
    { title: 'Prepare', dependsOn: [], trackingMode: 'track', optional: false },
    { title: 'Work', dependsOn: [0], trackingMode: 'track', optional: true },
    { title: 'Review', dependsOn: [1], trackingMode: 'check', optional: false },
  ], weekdays: [1, 2, 3, 4, 5, 6, 0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog, calls } = setup(t, original);
  const body = dialog.body;
  const workRow = [...body.querySelectorAll('[data-routine-step]')].find(row => row.querySelector('[data-step-title]').value === 'Work');
  const workId = workRow.dataset.routineStep;
  workRow.querySelector('[data-move-step="down"]').click();
  assert.equal([...body.querySelectorAll('[data-step-title]')].at(2).value, 'Work');
  const reviewRow = [...body.querySelectorAll('[data-routine-step]')].find(row => row.querySelector('[data-step-title]').value === 'Review');
  const workDependency = [...reviewRow.querySelectorAll('[data-step-dependency]')].find(input => input.checked);
  assert.equal(workDependency.value, workId);
  await submit(dialog);
  const saved = calls[0][0];
  assert.equal(saved.mode, 'graph');
  assert.deepEqual(saved.steps.map(step => step.title), ['Prepare', 'Review', 'Work']);
  assert.deepEqual(saved.steps[1].dependsOn, [2]);
  assert.deepEqual(saved.steps[2].dependsOn, [0]);

  const chain = { ...original, id: 'chain-1', mode: 'chain', steps: [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }] };
  const next = setup(t, chain);
  const row = [...next.dialog.body.querySelectorAll('[data-routine-step]')][1];
  row.querySelector('.cre-step-options summary').click();
  row.querySelector('[data-step-optional]').click();
  assert.ok(next.dialog.body.querySelector('.cre-step-options[open]'), 'rerender keeps the advanced step panel open');
  await submit(next.dialog);
  assert.equal(next.calls[0][0].mode, 'graph');
  assert.deepEqual(next.calls[0][0].steps.map(step => step.dependsOn), [[], [0], [1]]);
  assert.equal(next.calls[0][0].steps[1].optional, true);
  assert.equal(next.calls[0][0].steps[2].title, 'Third');
});

test('removing a graph step asks before changing dependent prerequisites', t => {
  const original = { id: 'graph-2', kind: 'action', mode: 'graph', title: 'Routine', steps: [
    { title: 'A', dependsOn: [], trackingMode: 'track', optional: false },
    { title: 'B', dependsOn: [0], trackingMode: 'track', optional: false },
  ], weekdays: [0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog, calls } = setup(t, original);
  dialog.body.querySelector('[data-remove-step]').click();
  assert.match(dialog.body.querySelector('[role=alert]').textContent, /Изменится связь/);
  assert.equal(calls.length, 0);
});

test('dependency choices allow a later independent step and prevent the resulting cycle', async t => {
  const plan = { id: 'graph-later', kind: 'action', mode: 'graph', title: 'Routine', steps: [
    { title: 'A', dependsOn: [], trackingMode: 'track', optional: false },
    { title: 'B', dependsOn: [], trackingMode: 'track', optional: false },
    { title: 'C', dependsOn: [], trackingMode: 'track', optional: false },
  ], weekdays: [0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog, calls } = setup(t, plan);
  const rows = [...dialog.body.querySelectorAll('[data-routine-step]')];
  const later = [...rows[0].querySelectorAll('[data-step-dependency]')].find(input => input.value === rows[2].dataset.routineStep);
  assert.ok(later);
  later.click();
  const refreshed = [...dialog.body.querySelectorAll('[data-routine-step]')];
  const wouldCycle = [...refreshed[2].querySelectorAll('[data-step-dependency]')].find(input => input.value === refreshed[0].dataset.routineStep);
  assert.equal(wouldCycle.disabled, true);
  await submit(dialog);
  assert.deepEqual(calls[0][0].steps[0].dependsOn, [2]);
});

test('conflict keeps the full editable draft and shows the store error', async t => {
  const original = { id: 'graph-3', kind: 'action', mode: 'graph', title: 'Before', steps: [
    { title: 'One', dependsOn: [], trackingMode: 'check', optional: false },
    { title: 'Two', dependsOn: [0], trackingMode: 'track', optional: true },
  ], weekdays: [0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog } = setup(t, original, async () => { throw Error('Это расписание изменено на другом устройстве.'); });
  dialog.body.querySelector('[data-routine-title]').value = 'Local draft';
  dialog.body.querySelector('[data-step-title]').value = 'Changed step';
  await submit(dialog);
  assert.equal(dialog.body.querySelector('[data-routine-title]').value, 'Local draft');
  assert.equal(dialog.body.querySelector('[data-step-title]').value, 'Changed step');
  assert.match(dialog.error.textContent, /другом устройстве/);
});

test('switching graph to one action warns and switching back restores unsaved steps', t => {
  const original = { id: 'graph-4', kind: 'action', mode: 'graph', title: 'Routine', steps: [
    { title: 'One', dependsOn: [], trackingMode: 'track', optional: false },
    { title: 'Two', dependsOn: [0], trackingMode: 'check', optional: true },
  ], weekdays: [0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog, calls } = setup(t, original);
  dialog.body.querySelector('[data-layout="single"]').click();
  assert.match(dialog.body.querySelector('[role=alert]').textContent, /будущие запуски будут без этих шагов/);
  dialog.body.querySelector('[data-confirm-collapse]').click();
  dialog.body.querySelector('[data-layout="multi"]').click();
  assert.deepEqual([...dialog.body.querySelectorAll('[data-step-title]')].map(input => input.value), ['One', 'Two']);
  assert.equal(calls.length, 0);
});

test('multi to single to multi preserves fork, join, and forward-edge dependencies', async t => {
  const plan = { id: 'graph-roundtrip', kind: 'action', mode: 'graph', title: 'Routine', steps: [
    { title: 'A', dependsOn: [4], trackingMode: 'track', optional: false },
    { title: 'B', dependsOn: [0], trackingMode: 'track', optional: false },
    { title: 'C', dependsOn: [0], trackingMode: 'check', optional: true },
    { title: 'D', dependsOn: [1, 2], trackingMode: 'track', optional: false },
    { title: 'E', dependsOn: [], trackingMode: 'track', optional: false },
  ], weekdays: [0], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: '2026-01-01' };
  const { dialog, calls } = setup(t, plan);
  dialog.body.querySelector('[data-layout="single"]').click();
  dialog.body.querySelector('[data-confirm-collapse]').click();
  dialog.body.querySelector('[data-layout="multi"]').click();
  await submit(dialog);
  assert.deepEqual(calls[0][0].steps.map(step => step.dependsOn), [[4], [0], [0], [1, 2], []]);
  assert.equal(calls[0][0].steps[2].trackingMode, 'check');
  assert.equal(calls[0][0].steps[2].optional, true);
});
