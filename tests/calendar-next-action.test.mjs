import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarNextAction as basemountCalendarNextAction, rankNextAction } from '../src/hanni/js/calendar-next-action.js';

import {withRecurringBundle} from './fixtures/recurring-bundle.mjs';
const mountCalendarNextAction=(element,options)=>basemountCalendarNextAction(element,{...options,invoke:withRecurringBundle(options.invoke)});

const today = '2026-09-27';
const now = () => new Date(`${today}T12:00:00`);
const task = (id, fields = {}) => ({ source_type: 'note', source_id: id, title: id, status_extra: 'task', date: null, completed: false, archived: false, ...fields });
const plan = (id, fields = {}) => ({ id, kind: 'action', mode: 'check', title: id, weekdays: [0,1,2,3,4,5,6], startsOn: '', endsOn: '', time: '', active: true, required: true, createdOn: today, steps: [], ...fields });
const state = (plans = [], days = {}) => JSON.stringify({ version: 1, plans, days });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup(t, { tasks = [], plans = [], days = {}, active = [], failTasks = false, failGoals = false, links = [], goals = [], processes = null } = {}) {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  let timerCallback = null; dom.window.setInterval = callback => { timerCallback = callback; return 1; };
  const host = dom.window.document.querySelector('main'), calls = [];
  let currentTasks = tasks, currentState = state(plans, days), activeBlocks = active, readFailure = failTasks, goalFailure = failGoals;
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_calendar_tasks') { if (readFailure) throw Error('offline'); return currentTasks; }
    if (name === 'get_calendar_task_goals') { if (goalFailure) throw Error('goal links offline'); return links; }
    if (name === 'get_goals') { if (goalFailure) throw Error('goals offline'); return goals; }
    if (name === 'get_active_blocks') return activeBlocks;
    if (name === 'get_active_block') return activeBlocks[0] || null;
    if (name === 'get_ui_state') return args?.key === 'calendar_processes_v1' ? (processes ? JSON.stringify({ version: 1, processes }) : null) : currentState;
    if (name === 'set_ui_state') { currentState = args.value; return null; }
    throw Error(name);
  };
  return { dom, host, calls, invoke, tick() { timerCallback?.(); }, get tasks() { return currentTasks; }, set tasks(value) { currentTasks = value; }, get currentState() { return currentState; }, set active(value) { activeBlocks = value; }, set fail(value) { readFailure = value; }, set failGoals(value) { goalFailure = value; } };
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

test('a meal graph is offered in meal hours, requires explicit start and completed runs are excluded', () => {
  const meal={...plan('meal',{title:'Еда',mode:'graph',steps:[{title:'Первый шаг',dependsOn:[],trackingMode:'check'}]}),status:'pending'};
  const tasks=[task('old',{date:'2026-09-26'})];
  const selected=rankNextAction({now:now(),tasks,routines:[meal]});
  assert.equal(selected.type,'routine'); assert.equal(selected.action,'start');
  assert.match(selected.reason,/перерыв на еду/);
  assert.equal(rankNextAction({now:new Date(`${today}T03:00:00`),tasks,routines:[meal]}).type,'task');
  assert.equal(rankNextAction({now:now(),tasks,routines:[{...meal,status:'done'}]}).type,'task');
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

test('current task survives pause, can be deferred or changed, and clears after confirmed completion', async t => {
  const activeTask=task('current',{is_active:true});
  const x=setup(t,{tasks:[activeTask,task('backlog',{date:'2026-09-26'}),task('explicit',{date:'2026-09-26'})]});
  const changes=[];
  const dispose=mountCalendarNextAction(x.host,{invoke:x.invoke,clock:now,compactRunning:true,onSelectionChange:value=>changes.push(value)});
  t.after(dispose); await settle();
  assert.equal(changes.at(-1).task.source_id,'current');
  assert.equal(changes.at(-1).action,'open');
  assert.ok(x.host.querySelector('.calendar-next-action__item'),'keep a fallback until the focused task row is confirmed');
  dispose.setFocusedTaskVisible(changes.at(-1).key,true);
  assert.equal(x.host.querySelector('.calendar-next-action__item'),null,'the confirmed work row replaces the duplicate recommendation card');
  assert.equal(x.host.dataset.running,'true');

  x.active=[];
  x.tasks=[task('current',{has_work:true,actual_seconds:90}),task('backlog',{date:'2026-09-26'}),task('explicit',{date:'2026-09-26'})];
  assert.equal(rankNextAction({now:now(),tasks:x.tasks,routines:[{...plan('lunch',{title:'Lunch'}),status:'pending'}]}).type,'routine','ordinary ranking still prefers the eligible lunch routine');
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle();
  assert.equal(changes.at(-1).task.source_id,'current');
  assert.equal(changes.at(-1).action,'start');

  dispose.setFocusedTaskVisible(changes.at(-1).key,false);
  x.host.querySelector('[data-next-action-action="later"]').click();
  assert.equal(changes.at(-1).task.source_id,'backlog','deferring the selected task clears its session-local override');

  dispose.setCurrentTask(task('explicit',{date:'2026-09-26'})); await settle();
  assert.equal(changes.at(-1).task.source_id,'explicit','an explicit task choice replaces session-local current selection');
  x.tasks=[task('explicit',{completed:true}),task('backlog',{date:'2026-09-26'})];
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle();
  assert.equal(changes.at(-1).task.source_id,'backlog','a completed selected task clears after a successful snapshot');
  assert.equal(x.calls.some(call=>['start_task_block','pause_task_block','finish_task_block','set_ui_state'].includes(call.name)),false);
});

test('focused-row handoff is reentrant-safe when selection changes', async t => {
  const x=setup(t,{tasks:[task('first',{is_active:true}),task('second',{is_active:true})]});
  let dispose, selected=null, callbacks=0;
  const onSelectionChange = value => {
    callbacks++;
    const previousKey=selected?.key || '', nextKey=value?.key || '';
    selected=value;
    if(previousKey && previousKey!==nextKey) dispose?.setFocusedTaskVisible(previousKey,false);
    if(nextKey) dispose?.setFocusedTaskVisible(nextKey,true);
  };
  dispose=mountCalendarNextAction(x.host,{invoke:x.invoke,clock:now,compactRunning:true,onSelectionChange});
  t.after(dispose); await settle();
  dispose.setCurrentTask(task('second',{is_active:true})); await settle();
  assert.equal(selected.task.source_id,'second');
  assert.equal(x.host.dataset.running,'true');
  assert.ok(callbacks < 12,'focus callbacks settle after one nested rerender instead of recursing');
});

test('goal association is display context only and never changes task ranking', () => {
  const linked = task('linked', { date: today }), unlinked = task('unlinked', { priority: 5 });
  const goals = [{ id: 'parent', title: 'Главная цель', parent_goal_id: null }, { id: 'child', title: 'Подцель', parent_goal_id: 'parent' }];
  const links = [{ source_type: 'note', source_id: 'linked', goal_id: 'child' }];
  const selected = rankNextAction({ now: now(), tasks: [linked, unlinked], links, goals });
  assert.equal(selected.task.source_id, 'unlinked', 'adding a goal link does not alter the existing priority rules');
  const linkedOnly = rankNextAction({ now: now(), tasks: [linked], links, goals });
  assert.equal(linkedOnly.context.goal, 'Главная цель / Подцель');
  assert.equal(rankNextAction({ now: now(), tasks: [unlinked], links, goals }).context.goal, '');
});

test('waiting task shows goal and stage context and offers review without starting or changing state', async t => {
  const row = task('waiting', { process: 'work', stage: 'requirements', waiting: true });
  const x = setup(t, {
    tasks: [row],
    links: [{ source_type: 'note', source_id: 'waiting', goal_id: 'child' }],
    goals: [{ id: 'parent', title: 'Главная цель' }, { id: 'child', title: 'Подцель', parent_goal_id: 'parent' }],
    processes: [{ id: 'work', title: 'Работа', stages: [{ id: 'requirements', title: 'Сбор требований' }] }],
  });
  const opened = [], executed = [];
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, openTask: value => opened.push(value), executeTask: (_value, action) => executed.push(action) });
  t.after(dispose); await settle();
  assert.match(x.host.querySelector('[data-next-action-context]').textContent, /Главная цель \/ Подцель/);
  assert.match(x.host.querySelector('[data-next-action-context]').textContent, /Этап: Сбор требований/);
  assert.match(x.host.querySelector('[data-next-action-context]').textContent, /Жду ответа/);
  const review = x.host.querySelector('[data-next-action-action="review"]');
  assert.equal(review.textContent, 'Проверить задачу'); review.click(); await settle();
  assert.deepEqual(opened, [row]);
  assert.deepEqual(executed, []);
  assert.equal(x.calls.some(call => ['start_task_block', 'pause_task_block', 'set_calendar_task_stage', 'save_calendar_task'].includes(call.name)), false);
});

test('a waiting task with a running timer remains an open current task', () => {
  const selected = rankNextAction({ now: now(), tasks: [task('active-waiting', { is_active: true, waiting: true, stage: 'requirements' })] });
  assert.equal(selected.action, 'open');
  assert.equal(selected.context.waiting, true);
});

test('a goal read failure is visible instead of being treated as an unlinked task', async t => {
  const x = setup(t, { tasks: [task('linked')], failGoals: true });
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now });
  t.after(dispose); await settle();
  assert.match(x.host.textContent, /Не удалось загрузить рекомендации/);
  assert.equal(x.host.querySelector('[data-next-action-context]'), null);
  assert.ok(x.host.querySelector('[data-next-action-retry]'));
});

test('an unfinished routine from a non-applicable day stays primary and opens its original run', async t => {
  const id = 'yesterday-chain', runDate = '2026-09-26';
  const saved = plan(id, { mode: 'chain', weekdays: [6], title: 'Подготовка', steps: [{ title: 'Шаг' }] });
  const record = { snapshot: saved, status: 'pending', run: { steps: [{ title: 'Шаг', status: 'pending' }], createdAt: `${runDate}T08:00:00.000Z` } };
  const x = setup(t, { tasks: [task('new-task')], plans: [saved], days: { [runDate]: { [id]: record } }, active: [{ id: 9, source_type: 'schedule', source_id: JSON.stringify([id, runDate, 0]), is_active: true }] });
  const opened = [];
  const dispose = mountCalendarNextAction(x.host, { invoke: x.invoke, clock: now, compactRunning:true, openRoutine: value => opened.push(value) });
  t.after(dispose); await settle();
  assert.match(x.host.textContent, /Подготовка/);
  x.host.querySelector('[data-next-action-action="open"]').click(); await settle();
  assert.equal(x.host.dataset.running,'false','an open routine must retain its recommendation surface, never enter compact task mode');
  assert.ok(x.host.querySelector('.calendar-next-action__item'));
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
    if (name === 'get_calendar_task_goals' || name === 'get_goals') return [];
    if (name === 'get_active_blocks') return [];
    if (name === 'get_ui_state') return null;
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
