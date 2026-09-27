import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarNextAction, rankNextAction } from '../src/hanni/js/calendar-next-action.js';

const today = '2026-09-27';
const now = () => new Date(`${today}T12:00:00`);
const task = (id, fields = {}) => ({ source_type: 'note', source_id: id, title: id, status_extra: 'task', date: null, completed: false, archived: false, ...fields });
const plan = (id, fields = {}) => ({ id, kind: 'action', mode: 'check', title: id, weekdays: [0,1,2,3,4,5,6], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: today, steps: [], ...fields });
const state = (plans = [], days = {}) => JSON.stringify({ version: 1, plans, days });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup(t, { tasks = [], plans = [], days = {}, active = [], failTasks = false } = {}) {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  let timerCallback = null; dom.window.setInterval = callback => { timerCallback = callback; return 1; };
  const host = dom.window.document.querySelector('main'), calls = [];
  let currentTasks = tasks, currentState = state(plans, days), activeBlocks = active, readFailure = failTasks;
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_calendar_tasks') { if (readFailure) throw Error('offline'); return currentTasks; }
    if (name === 'get_active_blocks') return activeBlocks;
    if (name === 'get_active_block') return activeBlocks[0] || null;
    if (name === 'get_ui_state') return currentState;
    if (name === 'set_ui_state') { currentState = args.value; return null; }
    throw Error(name);
  };
  return { dom, host, calls, invoke, tick() { timerCallback?.(); }, get tasks() { return currentTasks; }, set tasks(value) { currentTasks = value; }, get currentState() { return currentState; }, set active(value) { activeBlocks = value; }, set fail(value) { readFailure = value; } };
}

test('ranking favors today-bound work, but current-period routines beat ordinary old backlog', () => {
  const selected = rankNextAction({ now: now(), tasks: [task('undated'), task('due', { date: today, planned_time: '11:00' })], routines: [plan('routine')] });
  assert.equal(selected.task.source_id, 'due');
  assert.match(selected.reason, /Запланировано на сегодня/);
  const overdue = rankNextAction({ now: now(), tasks: [task('past', { date: '2026-09-26' }), task('urgent', { priority: 5 })] });
  assert.equal(overdue.task.source_id, 'urgent');
  assert.match(overdue.reason, /важную/);
  const lunch = rankNextAction({ now: now(), tasks: [task('old', { date: '2026-09-26' })], routines: [{ ...plan('lunch', { title: 'Пообедать' }), status: 'pending' }] });
  assert.equal(lunch.type, 'routine');
  assert.match(lunch.reason, /обед/);
  const old = rankNextAction({ now: now(), tasks: [task('old', { date: '2026-09-26' })], routines: [{ ...plan('morning', { title: 'Утреннее умывание' }), status: 'pending' }] });
  assert.equal(old.type, 'task', 'a routine cue outside its period does not outrank a task');
  assert.match(old.reason, /более ранний день/);
});

test('routine timing cues use existing title/steps and only apply in their time window', () => {
  const lunch = { ...plan('lunch', { title: 'Пообедать' }), status: 'pending' };
  assert.equal(rankNextAction({ now: now(), routines: [lunch] }).key, 'routine:lunch:2026-09-27');
  const morning = rankNextAction({ now: new Date(`${today}T08:00:00`), routines: [{ ...plan('morning', { title: 'Утреннее умывание' }), status: 'pending' }] });
  assert.match(morning.reason, /утро/i);
  const evening = rankNextAction({ now: new Date(`${today}T18:00:00`), routines: [{ ...plan('morning', { title: 'Утреннее умывание' }), status: 'pending' }], tasks: [task('ordinary')] });
  assert.equal(evening.type, 'task', 'a title cue outside its time window does not displace an ordinary task');
});

test('closed tasks, rules, and already-done routines never become recommendations', () => {
  const selected = rankNextAction({ now: now(), tasks: [task('closed', { completed: true }), task('archived', { archived: true })], routines: [plan('rule', { kind: 'rule' }), { ...plan('done'), status: 'done' }] });
  assert.equal(selected, null);
});

test('a running task is open-only when it is the sole candidate', async t => {
  const x = setup(t, { tasks: [task('active', { is_active: true })] }); let opened = 0, executed = 0;
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, openTask: () => opened++, executeTask: () => executed++ });
  t.after(dispose); await settle();
  const button = x.host.querySelector('[data-next-action-action="open"]');
  assert.equal(button.textContent, 'Открыть текущее'); button.click(); await settle();
  assert.equal(opened, 1); assert.equal(executed, 0);
  assert.equal(x.calls.some(call => ['start_task_block', 'pause_task_block'].includes(call.name)), false);
});

test('an instant task exposes completion, not a timer start', async t => {
  const x = setup(t, { tasks: [task('one-tap', { task_kind: 'instant' })] }); const actions = [];
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, executeTask: async (_row, action) => { actions.push(action); } });
  t.after(dispose); await settle();
  const done = x.host.querySelector('[data-next-action-action="done"]');
  assert.equal(done.textContent, 'Отметить выполненным'); done.click(); await settle();
  assert.deepEqual(actions, ['finish']);
  assert.equal(x.calls.some(call => ['start_task_block', 'pause_task_block'].includes(call.name)), false);
});

test('an already-running task remains the primary recommendation over new work', () => {
  const selected = rankNextAction({ now: now(), tasks: [task('active', { is_active: true }), task('overdue', { date: '2026-09-26' })] });
  assert.equal(selected.task.source_id, 'active');
  assert.equal(selected.action, 'open');
});

test('an unfinished routine from a non-applicable day stays primary and opens its original run', async t => {
  const id = 'yesterday-chain', runDate = '2026-09-26';
  const saved = plan(id, { mode: 'chain', weekdays: [6], title: 'Подготовка', steps: [{ title: 'Шаг' }] });
  const record = { snapshot: saved, status: 'pending', run: { steps: [{ title: 'Шаг', status: 'pending' }], createdAt: `${runDate}T08:00:00.000Z` } };
  const x = setup(t, { tasks: [task('new-task')], plans: [saved], days: { [runDate]: { [id]: record } }, active: [{ id: 9, source_type: 'schedule', source_id: JSON.stringify([id, runDate, 0]), is_active: true }] });
  const opened = [];
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, openRoutine: value => opened.push(value) });
  t.after(dispose); await settle();
  assert.match(x.host.textContent, /Подготовка/);
  x.host.querySelector('[data-next-action-action="open"]').click(); await settle();
  assert.deepEqual(opened, [{ id, date: runDate, start: false }]);
});

test('task start rechecks the selected candidate and never pauses parallel work', async t => {
  const x = setup(t, { tasks: [task('initial')] }); let started = 0;
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, executeTask: async (row, action) => { assert.equal(action, 'start'); assert.equal(row.source_id, 'initial'); started++; } });
  t.after(dispose); await settle();
  const action = x.host.querySelector('[data-next-action-action="start"]');
  x.tasks = [task('replacement', { date: today })]; action.click(); await settle();
  assert.equal(started, 0, 'a changed selection blocks the stale click');
  assert.match(x.host.textContent, /Список изменился/);
  assert.equal(x.calls.some(call => ['start_task_block', 'pause_task_block'].includes(call.name)), false);
});

test('a check-only routine can be marked done, but a chain is started explicitly', async t => {
  const x = setup(t, { plans: [plan('check', { title: 'Поесть' })] });
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, openRoutine: () => assert.fail('check routine should not open a run') });
  t.after(dispose); await settle();
  x.host.querySelector('[data-next-action-action="done"]').click(); await settle();
  assert.equal(JSON.parse(x.currentState).days[today].check.status, 'done');
  assert.match(x.host.textContent, /Подходящей задачи или дела сейчас нет/);
  assert.equal(x.calls.some(call => call.name === 'start_task_block'), false);
});

test('a runnable chain starts only after an explicit click and delegates to the routine runner', async t => {
  const x = setup(t, { plans: [plan('chain', { mode: 'chain', title: 'Домашняя задача', steps: [{ title: 'Шаг один' }, { title: 'Шаг два' }] })] });
  const opened = [];
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, openRoutine: value => { opened.push(value); } });
  t.after(dispose); await settle();
  assert.equal(x.host.querySelector('[data-next-action-action="done"]'), null);
  x.host.querySelector('[data-next-action-action="start"]').click(); await settle();
  assert.deepEqual(opened, [{ id: 'chain', date: today, start: true }]);
  assert.equal(x.calls.some(call => ['set_ui_state', 'start_task_block', 'pause_task_block'].includes(call.name)), false);
});

test('not now suppresses only this candidate for one hour without storing state', async t => {
  const x = setup(t, { tasks: [task('defer-me'), task('next')] }); let instant = now();
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: () => instant });
  t.after(dispose); await settle();
  const first = x.host.querySelector('[data-next-action-key]').dataset.nextActionKey;
  x.host.querySelector('[data-next-action-action="later"]').click();
  assert.notEqual(x.host.querySelector('[data-next-action-key]').dataset.nextActionKey, first);
  assert.match(x.host.textContent, /не будет предлагаться в течение часа/);
  assert.equal(x.calls.some(call => call.name === 'set_ui_state'), false);
  const reads = x.calls.filter(call => call.name === 'get_calendar_tasks').length;
  instant = new Date(instant.getTime() + 61 * 60 * 1000); x.tick(); await settle();
  assert.equal(x.host.querySelector('[data-next-action-key]').dataset.nextActionKey, first);
  assert.equal(x.calls.filter(call => call.name === 'get_calendar_tasks').length, reads, 'expiry is recomputed from the clock without a data reload');
});

test('changing preferences invalidates an older in-flight snapshot', async t => {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  const host = dom.window.document.querySelector('main'); let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const invoke = async name => {
    if (name === 'get_calendar_tasks') { calls++; if (calls === 1) { await gate; return [task('stale-task')]; } return []; }
    if (name === 'get_active_blocks') return [];
    if (name === 'get_ui_state') return state();
    throw Error(name);
  };
  const dispose = mountCalendarNextAction(host, { invoke, clock: now }); t.after(dispose);
  await dispose.setPreferences({ enabled: true, includeTasks: false, includeRoutines: false });
  release(); await settle();
  assert.equal(host.querySelector('[data-next-action-key]'), null);
  assert.match(host.textContent, /Подходящей задачи или дела сейчас нет/);
});

test('read failures are visible, retain the last result, and retry recovers', async t => {
  const x = setup(t, { tasks: [task('keep-visible')] });
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now });
  t.after(dispose); await settle();
  x.fail = true; await dispose.refresh();
  assert.match(x.host.textContent, /Показан последний результат/);
  assert.match(x.host.textContent, /keep-visible/);
  x.fail = false; x.host.querySelector('[data-next-action-retry]').click(); await settle();
  assert.equal(x.host.querySelector('[data-next-action-retry]'), null);
  assert.match(x.host.textContent, /keep-visible/);
});

test('no-op refresh preserves recommendation DOM and keyboard focus', async t => {
  const x = setup(t, { tasks: [task('stable')] });
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now });
  t.after(dispose); await settle();
  const card = x.host.querySelector('[data-next-action-key]'), action = x.host.querySelector('[data-next-action-action="start"]');
  action.focus(); await dispose.refresh();
  assert.equal(x.host.querySelector('[data-next-action-key]'), card);
  assert.equal(x.dom.window.document.activeElement, action);
});

test('session suppression clears when the local calendar day changes', async t => {
  const x = setup(t, { tasks: [task('new-day')] }); let instant = now();
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: () => instant });
  t.after(dispose); await settle();
  x.host.querySelector('[data-next-action-action="later"]').click();
  instant = new Date('2026-09-28T08:00:00'); await dispose.refresh(); await settle();
  assert.equal(x.host.querySelector('[data-next-action-key]').dataset.nextActionKey, 'task:note:new-day');
});
