import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openCalendarTaskDetails } from '../src/hanni/js/calendar-task-details.js';

const record = {
  source_type: 'note', source_id: 'n-1', title: 'Подготовить схему', date: '2026-09-27',
  sphere: 'work', stage: 'requirements', waiting: true, has_work: true, goal_id: 'g-1',
};

function fixture({ invoke: invokeOverride, ...overrides } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Открыть</button></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'get_calendar_task') return { ...record };
    if (command === 'get_ui_state') return null;
    if (command === 'get_goals') return [{ id: 'g-1', title: 'План', parent_goal_id: null }];
    if (command === 'get_calendar_task_goals') return [];
    if (command === 'get_calendar_task_seconds') return 61;
    if (command === 'get_active_blocks') return [];
    return undefined;
  };
  const transport = invokeOverride ? (command, args) => invokeOverride(command, args, invoke, calls) : invoke;
  const opener = window.document.querySelector('#opener');
  const dispose = openCalendarTaskDetails(record, { document: window.document, invoke: transport, returnFocus: () => opener.focus(), ...overrides });
  return { dom, window, calls, invoke, opener, dispose };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('opens as a read-only operational card, with goal/stage/time and no mutation', async t => {
  const f = fixture(); t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const card = f.window.document.querySelector('.calendar-task-details');
  assert.ok(card);
  assert.match(card.querySelector('h2').textContent, /Подготовить схему/);
  assert.match(card.textContent, /План/);
  assert.equal(card.querySelector('.task-details-goal select, .task-details-goal button'), null);
  assert.match(card.textContent, /Учтено 01:01/);
  assert.equal(card.querySelector('.task-details-history').open, false);
  assert.equal(card.querySelector('.task-details-stage').value, 'requirements');
  assert.equal(card.querySelector('.task-details-waiting').hidden, false);
  assert.equal(f.calls.some(([command]) => ['set_calendar_task_stage', 'start_task_block', 'pause_task_block'].includes(command)), false);
});

test('stage change is immediate, preserves waiting and exposes an error before allowing retry', async t => {
  let attempts = 0;
  const f = fixture({ invoke: async (command, args, baseInvoke, calls) => {
    if (command === 'set_calendar_task_stage' && ++attempts === 1) throw new Error('Сервер недоступен');
    if (command === 'set_calendar_task_stage') { calls.push([command, args]); return { ...record, stage: args.stage, waiting: true }; }
    return baseInvoke(command, args);
  } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const select = f.window.document.querySelector('.task-details-stage');
  select.value = 'analysis'; select.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(f.window.document.querySelector('.calendar-editor-error').textContent, /Сервер недоступен/);
  assert.equal(select.value, 'requirements');
  assert.equal(select.disabled, false);
  select.value = 'analysis'; select.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await settle();
  const update = f.calls.find(([command]) => command === 'set_calendar_task_stage');
  assert.deepEqual(update[1], { id: 'n-1', stage: 'analysis', waiting: null });
  assert.equal(select.value, 'analysis');
  assert.equal(f.window.document.querySelector('.task-details-waiting').hidden, false);
  assert.equal(f.window.document.querySelector('.calendar-editor-error').hidden, true);
});

test('start action is single-flight and does not implicitly pause another task', async t => {
  let release;
  const action = new Promise(resolve => { release = resolve; });
  const executed = [];
  const f = fixture({ executeAction: async (_task, name) => { executed.push(name); await action; } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const button = f.window.document.querySelector('.task-details-execute');
  button.click(); button.click();
  await settle();
  assert.deepEqual(executed, ['start']);
  release(); await settle();
  assert.deepEqual(executed, ['start']);
  assert.equal(f.calls.some(([command]) => command === 'pause_task_block'), false);
});

test('disposing while the initial read is pending makes its late result inert', async t => {
  let release;
  const pendingRead = new Promise(resolve => { release = resolve; });
  const f = fixture({ invoke: (command, args, baseInvoke) => command === 'get_calendar_task' ? pendingRead : baseInvoke(command, args) });
  t.after(() => f.dom.window.close());
  f.dispose();
  release({ ...record, title: 'Поздний ответ' });
  await settle();
  assert.equal(f.window.document.querySelector('.calendar-task-details'), null);
});
