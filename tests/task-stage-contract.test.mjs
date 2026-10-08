// Synthetic headless regressions for issue #105: task stages are explicit,
// stable records rather than a heuristic derived from unrelated task fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DEFAULT_PROCESS, stageSeconds, taskStage } from '../src/hanni/js/task-processes.js';
import { mountProcessSettings } from '../src/hanni/js/calendar-process-settings.js';
import { openCalendarTaskDetails } from '../src/hanni/js/calendar-task-details.js';

const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const at = minutes => new Date(Date.UTC(2026, 9, 8, 9, 0) + minutes * 60000).toISOString();
const process = { id: 'p-105', title: 'Release route', stages: [
  { id: 'selected', title: 'Selected' }, { id: 'review', title: 'Review' }, { id: 'done', title: 'Done' },
] };
const detailProcess = { id: 'p-105', title: 'Detail route', stages: [
  { id: 'requirements', title: 'Requirements' }, { id: 'analysis', title: 'Analysis' }, { id: 'acceptance', title: 'Acceptance' },
] };

function settingsFixture(t, { fail = false } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://stage-contract.invalid', pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main'), originalWindow = globalThis.window;
  globalThis.window = dom.window;
  let raw = JSON.stringify({ version: 1, processes: [DEFAULT_PROCESS, process] });
  const writes = [], pending = [];
  const invoke = async (command, args) => {
    if (command === 'get_ui_state') return raw;
    if (command === 'set_ui_state') { if (fail) throw new Error('synthetic save failure'); writes.push(JSON.parse(args.value)); raw = args.value; return null; }
    throw new Error(`unexpected mutation: ${command}`);
  };
  const api = mountProcessSettings(host, { invoke, setPending: value => pending.push(value) });
  t.after(() => { api.dispose(); dom.window.close(); globalThis.window = originalWindow; });
  const stage = id => host.querySelector(`[data-process-id="p-105"] [data-stage-id="${id}"]`);
  const field = id => stage(id).querySelector('[data-control="stage-title"]');
  const type = (input, value) => { input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { dom, host, api, writes, pending, stage, field, type };
}

test('process edits keep task IDs, history and parallel active seconds; deleting a selected stage is explicit', async t => {
  const x = settingsFixture(t); await settle();
  const rows = [
    { source_id: 'active-a', process: 'p-105', stage: 'selected', stage_log: [{ stage: 'selected', at: at(-40) }] },
    { source_id: 'active-b', process: 'p-105', stage: 'review', stage_log: [{ stage: 'review', at: at(-30) }] },
  ];
  const blocks = [
    { id: 'block-a', source_type: 'note', source_id: 'active-a', created_at: at(-30), duration_seconds: 0, is_active: true },
    { id: 'block-b', source_type: 'note', source_id: 'active-b', created_at: at(-20), duration_seconds: 0, is_active: true },
  ];
  const beforeLogs = rows.map(row => structuredClone(row.stage_log));
  const seconds = row => Object.fromEntries(stageSeconds({ blocks: blocks.filter(block => block.source_id === row.source_id), log: row.stage_log, stage: row.stage, now: Date.parse(at(0)) }));
  const beforeSeconds = rows.map(seconds);
  x.type(x.field('selected'), 'Renamed selected');
  x.stage('review').querySelector('[data-control="stage-down"]').click();
  assert.deepEqual([...x.host.querySelectorAll('[data-process-id="p-105"] [data-stage-id]')].map(item => item.dataset.stageId), ['selected', 'done', 'review']);
  assert.equal(await x.api.save(), true);
  assert.deepEqual(x.writes.at(-1).processes.find(item => item.id === 'p-105').stages.map(item => item.id), ['selected', 'done', 'review']);
  assert.equal(x.writes.at(-1).processes.find(item => item.id === 'p-105').stages[0].title, 'Renamed selected');
  x.stage('selected').querySelector('[data-control="stage-delete"]').click();
  assert.equal(await x.api.save(), true);
  const saved = x.writes.at(-1).processes.find(item => item.id === 'p-105');
  assert.deepEqual(saved.stages.map(item => item.id), ['done', 'review']);
  assert.deepEqual(rows.map(row => row.stage), ['selected', 'review']);
  assert.deepEqual(rows.map(row => row.stage_log), beforeLogs);
  assert.deepEqual(rows.map(seconds), beforeSeconds, 'parallel active timers retain per-stage seconds');
  const deleted = taskStage(rows[0], [saved]);
  assert.equal(deleted.stage, 'selected'); assert.equal(deleted.deleted, true); assert.equal(deleted.next, null, 'deleted stage has an explicit no-next state');
});

test('a process save failure keeps the draft and emits no changed event', async t => {
  const x = settingsFixture(t, { fail: true }); let changed = 0;
  x.dom.window.addEventListener('hanni:processes-changed', () => changed++);
  await settle(); x.type(x.field('review'), 'Draft only');
  assert.equal(await x.api.save(), false);
  assert.equal(x.field('review').value, 'Draft only'); assert.equal(x.api.isDirty(), true);
  assert.equal(x.writes.length, 0); assert.equal(changed, 0, 'failed persistence emits no process-changed event');
});

function detailsFixture(t, { instant = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button></body>', { url: 'https://stage-details.invalid', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const route = instant ? detailProcess.stages[1].id : 'requirements';
  const record = { source_type: 'note', source_id: 'detail-105', id: 'detail-105', title: instant ? 'Instant retained tags' : 'Stage selector', date: '2026-10-08', sphere: 'work', process: 'p-105', stage: route, waiting: true, stage_log: [{ stage: route, at: at(-20) }], goal_id: 'goal-105', has_work: true, ...(instant ? { task_kind: 'instant', duration_minutes: 25 } : {}) };
  const parallelBlocks = [
    { id: 'parallel-a', source_type: 'note', source_id: 'detail-105', created_at: '2026-10-08T08:45:00.000Z', date: '2026-10-08', start_time: '08:45:00', is_active: true },
    { id: 'parallel-b', source_type: 'note', source_id: 'parallel-105', created_at: '2026-10-08T08:50:00.000Z', date: '2026-10-08', start_time: '08:50:00', is_active: true },
  ];
  let current = structuredClone(record), failNext = false; const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'get_calendar_task') return structuredClone(current);
    if (command === 'get_ui_state') return args?.key === 'calendar_processes_v1' ? JSON.stringify({ version: 1, processes: [DEFAULT_PROCESS, detailProcess] }) : null;
    if (command === 'get_goals') return [{ id: 'goal-105', title: 'Synthetic goal' }];
    if (command === 'get_calendar_task_goals') return [];
    if (command === 'get_calendar_task_seconds') return 90;
    if (command === 'get_active_blocks') return structuredClone(parallelBlocks);
    if (command === 'set_calendar_task_stage') {
      assert.deepEqual(Object.keys(args).sort(), ['id', 'stage', 'waiting']); assert.equal(args.id, 'detail-105'); assert.equal(args.waiting, null);
      if (failNext) { failNext = false; throw new Error('synthetic stage write failure'); }
      current = { ...current, stage: args.stage, waiting: current.waiting, stage_log: [...current.stage_log, { stage: args.stage, at: at(0) }] };
      return structuredClone(current);
    }
    throw new Error(`unexpected mutation: ${command}`);
  };
  const dispose = openCalendarTaskDetails(record, { document: window.document, invoke, returnFocus: () => window.document.querySelector('#opener').focus() });
  t.after(() => { dispose(); dom.window.close(); });
  return { dom, window, calls, parallelBlocks, get current() { return current; }, set failNext(value) { failNext = value; } };
}

test('stage select supports forward, backward and jump writes, preserves task identity, and retries a failed write', async t => {
  const x = detailsFixture(t); await settle(); const select = x.window.document.querySelector('.task-details-stage');
  for (const target of ['analysis', 'requirements', 'acceptance']) { select.value = target; select.dispatchEvent(new x.window.Event('change', { bubbles: true })); await settle(); assert.equal(select.value, target); }
  const beforeFailure = { row: structuredClone(x.current), stageLog: structuredClone(x.current.stage_log), blocks: structuredClone(x.parallelBlocks) };
  x.failNext = true; select.value = 'requirements'; select.dispatchEvent(new x.window.Event('change', { bubbles: true })); await settle();
  assert.equal(select.value, 'acceptance', 'failed write restores the confirmed stage'); assert.match(x.window.document.querySelector('.calendar-editor-error').textContent, /synthetic stage write failure/);
  assert.deepEqual(x.current, beforeFailure.row, 'failed write leaves the confirmed row untouched');
  assert.deepEqual(x.current.stage_log, beforeFailure.stageLog, 'failed write appends no history entry');
  assert.deepEqual(x.parallelBlocks, beforeFailure.blocks, 'failed write leaves parallel blocks untouched');
  assert.equal(x.current.waiting, true, 'waiting remains an overlay through stage selection');
  select.value = 'requirements'; select.dispatchEvent(new x.window.Event('change', { bubbles: true })); await settle(); assert.equal(select.value, 'requirements');
  assert.deepEqual(x.current.stage_log.map(entry => entry.stage), ['requirements', 'analysis', 'requirements', 'acceptance', 'requirements']);
  assert.equal(x.current.waiting, true);
  assert.deepEqual(x.calls.filter(([command]) => command === 'set_calendar_task_stage').map(([, args]) => args), [
    { id: 'detail-105', stage: 'analysis', waiting: null }, { id: 'detail-105', stage: 'requirements', waiting: null }, { id: 'detail-105', stage: 'acceptance', waiting: null }, { id: 'detail-105', stage: 'requirements', waiting: null }, { id: 'detail-105', stage: 'requirements', waiting: null },
  ]);
  const mutations = x.calls.filter(([command]) => !['get_calendar_task', 'get_ui_state', 'get_goals', 'get_calendar_task_goals', 'get_calendar_task_seconds', 'get_active_blocks'].includes(command)).map(([command]) => command);
  assert.deepEqual(mutations, ['set_calendar_task_stage', 'set_calendar_task_stage', 'set_calendar_task_stage', 'set_calendar_task_stage', 'set_calendar_task_stage']);
  for (const forbidden of ['cancel_task_block', 'pause_task_block', 'start_task_block', 'set_calendar_task_goal', 'archive_calendar_task']) assert.equal(mutations.includes(forbidden), false, 'stage selection must not call ' + forbidden);
  assert.deepEqual(x.current && { id: x.current.id, source_id: x.current.source_id, goal_id: x.current.goal_id, date: x.current.date }, { id: 'detail-105', source_id: 'detail-105', goal_id: 'goal-105', date: '2026-10-08' });
  assert.deepEqual(x.parallelBlocks, [
    { id: 'parallel-a', source_type: 'note', source_id: 'detail-105', created_at: '2026-10-08T08:45:00.000Z', date: '2026-10-08', start_time: '08:45:00', is_active: true },
    { id: 'parallel-b', source_type: 'note', source_id: 'parallel-105', created_at: '2026-10-08T08:50:00.000Z', date: '2026-10-08', start_time: '08:50:00', is_active: true },
  ]);
});

test('normal rows have no inferred process, while instant cards hide retained process tags and estimates', async t => {
  const normal = { source_type: 'note', source_id: 'normal-105', title: 'Work route template', date: '2026-10-08', status_extra: 'task', task_kind: 'normal', sphere: 'work', goal_id: 'goal-105' };
  assert.equal(taskStage(normal, [DEFAULT_PROCESS, process]), null, 'title/sphere/goal do not create a process');
  const explicit = { ...normal, process: 'p-105', stage: 'review' };
  assert.equal(taskStage(explicit, [DEFAULT_PROCESS, process]).processId, 'p-105', 'process appears only from explicit task tags');
  const details = detailsFixture(t, { instant: true }); await settle(); const doc = details.window.document;
  assert.equal(doc.querySelector('.task-details-stage-row').hidden, true); assert.equal(doc.querySelector('.task-details-route').hidden, true);
  assert.doesNotMatch(doc.querySelector('.task-details-total').textContent, /25/);
  assert.ok(details.calls.some(([command]) => command === 'get_active_blocks'));
  assert.equal(doc.querySelector('.task-details-stage-row').hidden, true, 'instant process tags do not expose a stage selector');
});
