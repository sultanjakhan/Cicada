import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { recurringSourceId } from '../src/hanni/js/calendar-recurring-store.js';

const bootstrap = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.invalid' });
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
globalThis.CustomEvent = bootstrap.window.CustomEvent;
globalThis.localStorage = bootstrap.window.localStorage;
globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
const { mountCalendarRecurring } = await import('../src/hanni/js/calendar-recurring.js');

const today = '2026-09-13', yesterday = '2026-09-12';
const id = 'routine:"saved"]'; // Stored IDs need not be CSS-safe UUIDs.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const graphSteps = [
  { title: 'Prepare', dependsOn: [], trackingMode: 'check', optional: false },
  { title: 'Review', dependsOn: [0], trackingMode: 'check', optional: false },
  { title: 'Work', dependsOn: [0], trackingMode: 'track', optional: true },
  { title: 'Close', dependsOn: [1, 2], trackingMode: 'check', optional: false },
];
function plan(mode = 'graph', extra = {}) {
  return { id, kind: 'action', title: 'Saved routine', mode,
    steps: mode === 'graph' ? structuredClone(graphSteps) : mode === 'chain' ? [{ title: 'Prepare' }, { title: 'Work' }] : [],
    weekdays: [0, 1, 2, 3, 4, 5, 6], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: yesterday, ...extra };
}
function execution(snapshot, status = 'pending') {
  const steps = snapshot.mode === 'activity' ? [{ title: snapshot.title }] : snapshot.steps;
  return { snapshot: structuredClone(snapshot), status,
    run: { createdAt: `${yesterday}T09:00:00.000Z`, steps: steps.map((step, index) => ({ ...structuredClone(step),
      status: status === 'pending' ? (steps.length > 1 && index === 0 ? 'done' : 'pending') : status })) } };
}
async function setup(t, state, { library = true } = {}) {
  const dom = new JSDOM('<!doctype html><main></main>', { url: 'https://fixture.invalid' });
  const document = dom.window.document, host = document.querySelector('main');
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  let raw = JSON.stringify(state), active = [];
  const calls = [];
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_ui_state') return raw;
    if (name === 'set_ui_state') {
      assert.equal(args.expectedValue, raw, 'edits use the canonical compare-and-swap store');
      raw = args.value; return;
    }
    if (name === 'get_active_blocks') return active;
    if (name === 'get_schedules') return Object.entries(JSON.parse(raw).days).flatMap(([date, records]) => Object.entries(records).flatMap(([planId, record]) =>
      (record.run?.steps || []).map((step, index) => ({ id: recurringSourceId(planId, date, index), title: step.title,
        is_active: active.some(block => block.source_id === recurringSourceId(planId, date, index)) }))));
    if (name === 'start_task_block') {
      active.push({ id: 1, source_type: args.sourceType, source_id: args.sourceId }); return 1;
    }
    throw Error(`Unexpected command: ${name}`);
  };
  const dispose = mountCalendarRecurring(host, { invoke, library, now: () => new Date(`${today}T12:00:00`) });
  t.after(() => {
    [...document.querySelectorAll('dialog[open]')].reverse().forEach(dialog => dialog.close());
    dispose(); dom.window.close();
  });
  await settle();
  if (!library) await dispose.openManager();
  const root = library ? host : document.querySelector('dialog[open]');
  const button = attribute => [...root.querySelectorAll(`[${attribute}]`)].find(node => node.getAttribute(attribute) === id);
  return { dom, document, host, root, button, calls, state: () => JSON.parse(raw),
    writes: () => calls.filter(call => call.name === 'set_ui_state'),
    mutations: () => calls.filter(call => !['get_ui_state', 'get_schedules', 'get_active_blocks'].includes(call.name)) };
}

for (const [mode, status, active] of [
  ['activity', 'pending', true], ['chain', 'pending', false], ['graph', 'pending', true],
  ['activity', 'done', false], ['chain', 'skipped', true], ['graph', 'done', true],
]) test(`library retains ${status === 'pending' ? 'Continue' : 'View'} for saved ${mode} after future definition becomes check`, async t => {
  const snapshot = plan(mode), record = execution(snapshot, status);
  const original = { version: 1, plans: [plan('check', { active, title: 'Future check' })], days: { [today]: { [id]: record } } };
  const x = await setup(t, original);
  const run = x.button('data-library-run');
  assert.ok(run, 'saved execution remains reachable regardless of the future mode/active flag');
  assert.equal(run.textContent, status === 'pending' ? 'Продолжить' : 'Просмотреть');
  assert.equal(run.dataset.libraryDate, today);
  assert.equal(run.dataset.libraryView, String(status !== 'pending'));
  assert.equal(x.button('data-library-mark'), undefined, 'a saved run cannot be replaced with a direct mark');
  const search = x.root.querySelector('[data-routine-search]');
  search.value = 'Future'; search.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(x.state(), original);
  assert.deepEqual(x.mutations(), [], 'rendering and search never start or finish execution');
  if (status !== 'pending') {
    run.click(); await settle();
    const dialog = x.document.querySelector('dialog[open]');
    assert.equal(dialog.querySelector('h2').textContent, snapshot.title);
    assert.equal(dialog.querySelector('[data-run-ready] h3').textContent, 'Рутина завершена');
    assert.equal(dialog.querySelector('[data-run-action]'), null);
    assert.deepEqual(x.mutations(), [], 'View is read-only and does not create another occurrence');
    assert.deepEqual(x.state(), original);
  }
});

for (const library of [true, false]) test(`${library ? 'library' : 'manager'} resumes a previous-day partial graph using its saved origin and steps after mode change`, async t => {
  const snapshot = plan(), record = execution(snapshot);
  const original = { version: 1, plans: [plan('check', { title: 'Future check' })], days: { [yesterday]: { [id]: record } } };
  const x = await setup(t, original, { library });
  const run = x.button('data-library-run');
  assert.ok(run);
  assert.equal(run.textContent, 'Продолжить');
  assert.equal(run.dataset.libraryDate, yesterday);
  assert.equal(run.dataset.libraryView, 'false');
  assert.equal(x.button('data-library-mark'), undefined, 'today check must not clone or replace the unfinished occurrence');
  assert.deepEqual(x.mutations(), []);
  run.click(); await settle();
  const runner = [...x.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(runner.querySelector('h2').textContent, snapshot.title);
  assert.deepEqual([...runner.querySelectorAll('[data-run-step-card]')].map(node => node.dataset.runStepCard), ['1', '2']);
  assert.match(runner.querySelector('.calendar-run-progress').textContent, /Выполнено 1 из 4/);
  assert.deepEqual(x.mutations(), [], 'opening the choice of available branches does not run or complete one');
  runner.querySelector('[data-run-action="start"][data-run-step="2"]').click(); await settle();
  assert.deepEqual(x.calls.filter(call => call.name === 'start_task_block').map(call => call.args), [
    { sourceType: 'schedule', sourceId: recurringSourceId(id, yesterday, 2), completionDate: yesterday },
  ]);
  assert.equal(x.writes().length, 0);
  assert.deepEqual(x.state(), original, 'origin, plan ID, snapshot, completed steps and history are retained');
  assert.equal(x.state().days[today], undefined);
});

test('manager selects the prior pending run even when today already has a finished run', async t => {
  const snapshot = plan();
  const original = { version: 1, plans: [plan('check')], days: {
    [yesterday]: { [id]: execution(snapshot) },
    [today]: { [id]: execution(plan('activity', { title: 'Finished today' }), 'done') },
  } };
  const x = await setup(t, original, { library: false });
  const run = x.button('data-library-run');
  assert.ok(run); assert.equal(run.dataset.libraryDate, yesterday);
  assert.equal(run.dataset.libraryView, 'false');
  run.click(); await settle();
  const runner = [...x.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(runner.querySelector('h2').textContent, snapshot.title);
  assert.equal(runner.querySelectorAll('[data-run-step-card]').length, 2);
  assert.deepEqual(x.state(), original); assert.deepEqual(x.mutations(), []);
});

test('manager opens a finished saved run as read-only after future mode change and disabling', async t => {
  const snapshot = plan('chain'), original = { version: 1, plans: [plan('check', { active: false })],
    days: { [today]: { [id]: execution(snapshot, 'done') } } };
  const x = await setup(t, original, { library: false });
  const run = x.button('data-library-run');
  assert.ok(run); assert.equal(run.textContent, 'Просмотреть'); assert.equal(run.dataset.libraryView, 'true');
  run.click(); await settle();
  const runner = [...x.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(runner.querySelector('h2').textContent, snapshot.title);
  assert.equal(runner.querySelector('[data-run-action]'), null);
  assert.deepEqual(x.state(), original); assert.deepEqual(x.mutations(), []);
});

for (const library of [true, false]) for (const filtered of [false, true]) test(`${library ? 'library' : 'manager'} restores edit focus to ${filtered ? 'visible search when rename no longer matches' : 'the saved plan ID after row replacement'}`, async t => {
  const snapshot = plan('activity');
  const original = { version: 1, plans: [snapshot], days: { [yesterday]: { [id]: execution(snapshot) } } };
  const x = await setup(t, original, { library });
  if (filtered) {
    const search = x.root.querySelector('[data-routine-search]');
    search.value = 'Saved'; search.dispatchEvent(new x.dom.window.Event('input', { bubbles: true }));
  }
  const opener = x.button('data-recurring-edit'); opener.focus(); opener.click();
  const editor = [...x.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(x.document.activeElement, editor.querySelector('[data-routine-title]'));
  assert.deepEqual(x.mutations(), [], 'opening an editor does not mutate routine execution');
  editor.querySelector('[data-routine-title]').value = 'Renamed routine';
  editor.querySelector('[data-routine-tracking][value="check"]').click();
  editor.querySelector('form').dispatchEvent(new x.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(editor.isConnected, false); assert.equal(opener.isConnected, false);
  const saved = x.state();
  assert.equal(saved.plans[0].id, id); assert.equal(saved.plans[0].title, 'Renamed routine'); assert.equal(saved.plans[0].mode, 'check');
  assert.deepEqual(saved.days, original.days, 'editing preserves the old execution snapshot and progress');
  assert.equal(x.writes().length, 1); assert.deepEqual(x.mutations().map(call => call.name), ['set_ui_state']);
  const updatedOpener = x.button('data-recurring-edit'), search = x.root.querySelector('[data-routine-search]');
  assert.equal(updatedOpener.closest('.calendar-routine-library-row').hidden, filtered);
  assert.equal(x.document.activeElement, filtered ? search : updatedOpener);
  assert.equal(x.document.activeElement.isConnected, true);
  assert.equal(x.document.activeElement.closest('[hidden]'), null, 'focus always returns to a visible control');
  assert.equal(search.value, filtered ? 'Saved' : '', 'saving retains the search query');
});
test('manager keeps saved origin even while future plan remains runnable', async t => {
  const snapshot = plan();
  const original = { version: 1, plans: [snapshot], days: {
    [yesterday]: { [id]: execution(snapshot) },
    [today]: { [id]: execution(plan('activity', { title: 'Finished today' }), 'done') },
  } };
  const x = await setup(t, original, { library: false });
  const run = x.button('data-library-run');
  assert.ok(run); assert.equal(run.textContent, 'Продолжить');
  run.click(); await settle();
  const runner = [...x.document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(runner.querySelector('h2').textContent, snapshot.title,
    'Continue must open the prior graph rather than today finished activity');
  assert.equal(run.dataset.libraryDate, yesterday);
  assert.equal(runner.querySelectorAll('[data-run-step-card]').length, 2);
  assert.deepEqual(x.state(), original); assert.deepEqual(x.mutations(), []);
});
for (const active of [true, false]) test(`library keeps optional unfinished graph visible when future optional check is ${active ? 'active' : 'disabled'}`, async t => {
  const snapshot = plan('graph', { required: false }), record = execution(snapshot);
  const earlier = '2026-09-11', completedSnapshot = plan('graph', { required: false, createdOn: earlier, title: 'Earlier graph' });
  const original = { version: 1, plans: [plan('check', { required: false, active, title: 'Future optional check' })], days: {
    [earlier]: { [id]: execution(completedSnapshot, 'done') },
    [yesterday]: { [id]: record },
  } };
  const x = await setup(t, original);
  const run = x.button('data-library-run');
  assert.ok(run, 'every saved unfinished execution retains its Continue control');
  assert.equal(run.textContent, 'Продолжить');
  assert.equal(run.closest('[hidden]'), null, 'optional or disabled metadata must not hide unfinished execution');
  assert.equal(run.dataset.libraryDate, yesterday); assert.equal(run.dataset.libraryView, 'false');
  assert.equal(x.button('data-library-mark'), undefined);
  assert.deepEqual(x.state(), original); assert.deepEqual(x.mutations(), []);
  run.click(); await settle();
  const runner = x.document.querySelector('dialog[open]');
  assert.equal(runner.querySelector('h2').textContent, snapshot.title);
  assert.deepEqual([...runner.querySelectorAll('[data-run-step-card]')].map(node => node.dataset.runStepCard), ['1', '2']);
  assert.match(runner.querySelector('.calendar-run-progress').textContent, /Выполнено 1 из 4/);
  assert.deepEqual(x.mutations(), [], 'discovering or opening optional branches never starts or completes one');
  assert.deepEqual(x.state().days[yesterday][id], record);
  assert.deepEqual(x.state(), original, 'saved optional snapshot, origin, completed steps, IDs and earlier history remain unchanged');
  assert.equal(x.state().days[today], undefined);
});