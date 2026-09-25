// Task processes (2026-09-25): process state, stage visibility and the arrow,
// time per stage, and the «Процессы задач» settings editor. Fictional data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_PROCESS, DEFAULT_PROCESS_ID, PROCESSES_STATE_KEY, blockInterval, formatStageDuration, mergeIntervals, normalizeProcessState,
  saveProcessState, stagePeriods, stageSeconds, stageTimeParts, stageTimeText, stageTimeTitle, taskProcessId, taskStage, validateProcesses,
} from '../src/hanni/js/task-processes.js';
import { mountProcessSettings } from '../src/hanni/js/calendar-process-settings.js';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const T = minutes => new Date(Date.UTC(2026, 8, 25, 9, 0) + minutes * 60000).toISOString();
const block = (start, minutes, extra = {}) => ({ source_type: 'note', source_id: 't', created_at: T(start), duration_seconds: minutes * 60, is_active: false, ...extra });
const minutes = totals => Object.fromEntries([...totals].map(([id, seconds]) => [id, Math.round(seconds / 60)]));
const custom = { id: 'p-report', title: 'Отчёт', stages: [{ id: 's-draft', title: 'Черновик' }, { id: 's-check', title: 'Проверка' }] };

test('nothing stored means the built-in «Системный анализ»; a stored list keeps it and drops malformed entries', () => {
  for (const raw of [null, '']) assert.deepEqual(normalizeProcessState(raw).processes, [{ ...DEFAULT_PROCESS, stages: DEFAULT_PROCESS.stages.map(stage => ({ ...stage })) }]);
  assert.equal(DEFAULT_PROCESS.title, 'Системный анализ');
  assert.deepEqual(DEFAULT_PROCESS.stages.map(stage => stage.title), ['Понимание', 'Требования', 'Анализ и модели', 'Описание', 'Согласование', 'Декомпозиция', 'В разработке', 'Приёмка']);
  const state = normalizeProcessState(JSON.stringify({ version: 1, future: true, processes: [
    { ...custom, color: 'blue' }, { id: 'Bad', title: 'x', stages: [{ id: 's', title: 's' }] }, { id: 'p-empty', title: 'Пусто', stages: [] },
    { id: 'p-report', title: 'Дубль', stages: [{ id: 's', title: 's' }] },
    { id: 'p-mixed', title: '  Смешанный  ', stages: [{ id: 's-1', title: 'Раз' }, { id: 's-1', title: 'Дубль' }, { id: 'Bad Id', title: 'x' }, { id: 's-2', title: ' ' }] },
  ] }));
  assert.deepEqual(state.processes.map(process => process.id), [DEFAULT_PROCESS_ID, 'p-report', 'p-mixed'], 'the built-in process is added when missing');
  assert.equal(state.future, true, 'unknown fields are kept');
  assert.equal(state.processes[1].color, 'blue');
  assert.deepEqual(state.processes[2], { id: 'p-mixed', title: 'Смешанный', stages: [{ id: 's-1', title: 'Раз' }] });
  assert.throws(() => normalizeProcessState('{"version":2,"processes":[]}'), /Неподдерживаемый формат/);
});

test('migration on read: a stage or «Жду ответа» without a process means the built-in process', () => {
  assert.equal(taskProcessId({ stage: 'agreement' }), DEFAULT_PROCESS_ID);
  assert.equal(taskProcessId({ stage: '', waiting: true }), DEFAULT_PROCESS_ID);
  assert.equal(taskProcessId({ process: 'p-report', stage: 's-draft' }), 'p-report');
  assert.equal(taskProcessId({ process: 'p-report', stage: '' }), 'p-report');
  for (const row of [{}, { stage: '', waiting: false }, { sphere: 'work' }, null]) assert.equal(taskProcessId(row), '');
});

test('stage UI exists only with a process; the arrow moves forward and stops at the last stage', () => {
  const processes = [DEFAULT_PROCESS, custom];
  assert.equal(taskStage({ sphere: 'work' }, processes), null, 'no process, no stage control');
  const none = taskStage({ process: DEFAULT_PROCESS_ID, stage: '' }, processes);
  assert.deepEqual([none.label, none.next.id, none.index, none.deleted], ['', 'understanding', -1, false], 'from no stage the arrow starts the first one');
  const middle = taskStage({ stage: 'requirements' }, processes);
  assert.deepEqual([middle.label, middle.next.id, middle.next.title, middle.isLast], ['Требования', 'analysis', 'Анализ и модели', false]);
  const last = taskStage({ stage: 'acceptance', waiting: true }, processes);
  assert.deepEqual([last.label, last.next, last.isLast, last.waiting], ['Приёмка', null, true, true]);
  const report = taskStage({ process: 'p-report', stage: 's-draft' }, processes);
  assert.deepEqual([report.processTitle, report.label, report.next.id], ['Отчёт', 'Черновик', 's-check']);
  const deleted = taskStage({ process: 'p-report', stage: 's-gone' }, processes);
  assert.deepEqual([deleted.label, deleted.deleted, deleted.next], ['Стадия удалена', true, null], 'a deleted stage keeps its id and has no next stage');
  const unknown = taskStage({ process: 'p-later', stage: 's-check' }, processes);
  assert.deepEqual([unknown.processTitle, unknown.label, unknown.next], ['Процесс не найден', 'Проверка', null], 'a process not synced yet still names a known stage');
});

test('time per stage: blocks spanning a change are split, overlaps count once, the running block counts up to now', () => {
  const log = [{ stage: 'understanding', at: T(0) }, { stage: 'requirements', at: T(30) }, { stage: 'analysis', at: T(90) }];
  // 09:10–09:50 spans the change at 09:30; 09:40–10:00 overlaps it; 10:20 is running until 10:45.
  const blocks = [block(10, 40), block(40, 20), block(80, 0, { is_active: true, duration_seconds: 0 })];
  const now = Date.parse(T(105));
  assert.deepEqual(minutes(stageSeconds({ blocks, log, stage: 'analysis', now })), { understanding: 20, requirements: 40, analysis: 15 });
  // The stage changed while the block was running: both periods get their part.
  const running = [block(80, 0, { is_active: true })];
  assert.deepEqual(minutes(stageSeconds({ blocks: running, log, stage: 'analysis', now })), { requirements: 10, analysis: 15 });
  assert.deepEqual(minutes(stageSeconds({ blocks: running, log, stage: 'analysis', now: Date.parse(T(125)) })), { requirements: 10, analysis: 35 }, 'the current stage grows');
  // Time before the first entry had no stage.
  assert.deepEqual(minutes(stageSeconds({ blocks: [block(-20, 30)], log, stage: 'analysis', now })), { '': 20, understanding: 10 });
});

test('time per stage without history, with a cleared stage, with a deleted stage and for parallel tasks', () => {
  const now = Date.parse(T(200));
  assert.deepEqual(minutes(stageSeconds({ blocks: [block(0, 25), block(60, 5)], log: [], stage: 'agreement', now })), { agreement: 30 }, 'no transitions: the current stage owns the time');
  assert.deepEqual(minutes(stageSeconds({ blocks: [block(0, 25)], log: [], stage: '', now })), { '': 25 });
  const cleared = [{ stage: 'requirements', at: T(0) }, { stage: '', at: T(20) }];
  assert.deepEqual(minutes(stageSeconds({ blocks: [block(0, 30)], log: cleared, stage: '', now })), { requirements: 20, '': 10 });
  // A deleted stage keeps its time; the parts put it after the known stages.
  const log = [{ stage: 'requirements', at: T(0) }, { stage: 'gone', at: T(10) }, { stage: 'agreement', at: T(20) }];
  const totals = stageSeconds({ blocks: [block(0, 30)], log, stage: 'agreement', now });
  const state = taskStage({ stage: 'agreement' }, [DEFAULT_PROCESS]);
  assert.equal(stageTimeText(stageTimeParts(state, totals)), 'Требования 10 мин · Согласование 10 мин · Стадия удалена 10 мин');
  const current = taskStage({ stage: 'gone' }, [DEFAULT_PROCESS]);
  assert.deepEqual(stageTimeParts(current, stageSeconds({ blocks: [], log: [], stage: 'gone', now })).map(part => [part.label, part.current]), [['Стадия удалена', true]], 'a deleted current stage is still shown live');
  // Parallel tasks: each total uses only that task's blocks, so both keep the full overlap.
  const a = stageSeconds({ blocks: [block(0, 60)], log: [], stage: 'requirements', now });
  const b = stageSeconds({ blocks: [block(30, 60, { source_id: 'other' })], log: [], stage: 'analysis', now });
  assert.deepEqual([minutes(a), minutes(b)], [{ requirements: 60 }, { analysis: 60 }]);
});

test('intervals, periods and formatting are pure helpers', () => {
  assert.equal(blockInterval({ created_at: '0', date: '2026-09-25', start_time: '10:00:00', duration_seconds: 60 }, 0).end - blockInterval({ created_at: '0', date: '2026-09-25', start_time: '10:00:00', duration_seconds: 60 }, 0).start, 60000, 'a loose created_at falls back to the local start');
  assert.equal(blockInterval({ created_at: T(0), duration_seconds: 0 }, 0), null, 'an empty closed block counts nothing');
  assert.deepEqual(mergeIntervals([{ start: 5, end: 9 }, { start: 0, end: 6 }, { start: 12, end: 13 }]), [{ start: 0, end: 9 }, { start: 12, end: 13 }]);
  assert.deepEqual(stagePeriods([{ stage: 'b', at: T(10) }, { stage: 'a', at: T(0) }, { stage: 'x', at: 'soon' }], 'b').map(period => period.stage), ['', 'a', 'b'], 'history is ordered by time; unreadable entries are skipped');
  assert.deepEqual(stagePeriods([], 'a'), [{ stage: 'a', start: -Infinity, end: Infinity }]);
  assert.deepEqual([0, 59, 60, 25 * 60, 60 * 60, 70 * 60, 125 * 60].map(formatStageDuration), ['0 мин', '0 мин', '1 мин', '25 мин', '1 ч', '1 ч 10 мин', '2 ч 5 мин']);
  const state = taskStage({ stage: 'requirements' }, [DEFAULT_PROCESS]);
  assert.equal(stageTimeTitle(state, new Map()), 'Время по стадиям пока не учтено');
  assert.equal(stageTimeTitle(state, new Map([['understanding', 1500], ['requirements', 4200], ['', 30]])), 'Время по стадиям: Понимание 25 мин · Требования 1 ч 10 мин');
});

test('validation names the field and a stale save is reported without overwriting', async () => {
  assert.throws(() => validateProcesses([{ ...custom, title: ' ' }]), error => error.field === 'title' && error.processId === 'p-report');
  assert.throws(() => validateProcesses([{ ...custom, stages: [] }]), error => error.field === 'stages');
  assert.throws(() => validateProcesses([{ ...custom, stages: [{ id: 's-draft', title: '' }] }]), error => error.stageId === 's-draft');
  assert.throws(() => validateProcesses([custom, custom]), /идентификатор/);
  const writes = [], current = JSON.stringify({ version: 1, processes: [DEFAULT_PROCESS] }), older = JSON.stringify({ version: 1, processes: [custom] });
  const invoke = async (command, args) => { writes.push([command, args]); if (args.expectedValue !== current) throw 'mvp_sync_stale_ui_state'; };
  await assert.rejects(saveProcessState(invoke, [custom], older), /изменены на другом устройстве/);
  const saved = await saveProcessState(invoke, [DEFAULT_PROCESS, custom], current);
  assert.deepEqual(saved.state.processes.map(process => process.id), [DEFAULT_PROCESS_ID, 'p-report']);
  assert.deepEqual(writes.map(([command, args]) => [command, args.key]), [['set_ui_state', PROCESSES_STATE_KEY], ['set_ui_state', PROCESSES_STATE_KEY]]);
  assert.equal(writes[1][1].expectedValue, current, 'compare-and-swap against the edited version');
});

// ---- The settings editor ----
function editor(t, { stored = null, fail = null } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const host = dom.window.document.createElement('section'); dom.window.document.body.append(host);
  const data = { raw: stored, writes: [], pending: [] };
  const invoke = async (command, args) => {
    if (command === 'get_ui_state') return data.raw;
    if (command === 'set_ui_state') {
      if (fail) throw fail;
      if ((data.raw ?? '') !== args.expectedValue) throw 'mvp_sync_stale_ui_state';
      data.writes.push(JSON.parse(args.value)); data.raw = args.value; return null;
    }
    throw new Error(`unexpected ${command}`);
  };
  const api = mountProcessSettings(host, { invoke, setPending: value => data.pending.push(value) });
  t.after(() => { api.dispose(); dom.window.close(); });
  const doc = dom.window.document;
  const $ = selector => host.querySelector(selector);
  const process = id => host.querySelector(`[data-process-id="${id}"]`);
  const stages = id => [...process(id).querySelectorAll('[data-control="stage-title"]')].map(input => input.value);
  const stageControl = (id, stage, name) => process(id).querySelector(`[data-stage-id="${stage}"] [data-control="${name}"]`);
  const type = (input, value) => { input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { dom, doc, host, api, data, $, process, stages, stageControl, type };
}

test('the editor renames the process and a stage, reorders with ↑ ↓ and keeps focus on the moved stage', async t => {
  const x = editor(t); await settle();
  assert.equal(x.$('h3').textContent, 'Процессы задач');
  assert.equal(x.$('[data-processes-save]').disabled, true, 'nothing to save yet');
  assert.deepEqual(x.stages(DEFAULT_PROCESS_ID), DEFAULT_PROCESS.stages.map(stage => stage.title));
  x.type(x.process(DEFAULT_PROCESS_ID).querySelector('[data-control="process-title"]'), 'СА');
  x.type(x.stageControl(DEFAULT_PROCESS_ID, 'understanding', 'stage-title'), 'Вникнуть');
  assert.equal(x.$('[data-processes-save]').disabled, false);
  assert.equal(x.stageControl(DEFAULT_PROCESS_ID, 'understanding', 'stage-up').disabled, true, 'the first stage cannot go up');
  x.stageControl(DEFAULT_PROCESS_ID, 'analysis', 'stage-up').click();
  assert.deepEqual(x.stages(DEFAULT_PROCESS_ID).slice(0, 3), ['Вникнуть', 'Анализ и модели', 'Требования']);
  assert.equal(x.doc.activeElement, x.stageControl(DEFAULT_PROCESS_ID, 'analysis', 'stage-up'), 'focus follows the moved stage');
  x.stageControl(DEFAULT_PROCESS_ID, 'analysis', 'stage-up').click();
  assert.equal(x.doc.activeElement, x.stageControl(DEFAULT_PROCESS_ID, 'analysis', 'stage-down'), 'at the top the other arrow takes focus');
  // Alt+↓ in the name field moves too.
  const field = x.stageControl(DEFAULT_PROCESS_ID, 'acceptance', 'stage-title');
  field.focus(); field.dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  assert.deepEqual(x.stages(DEFAULT_PROCESS_ID).slice(-2), ['Приёмка', 'В разработке']);
  assert.equal(x.doc.activeElement, x.stageControl(DEFAULT_PROCESS_ID, 'acceptance', 'stage-title'));
  x.$('[data-processes-save]').click(); await settle();
  assert.equal(x.data.writes.length, 1);
  const [saved] = x.data.writes[0].processes;
  assert.equal(saved.title, 'СА');
  assert.deepEqual(saved.stages.map(stage => stage.id), ['analysis', 'understanding', 'requirements', 'description', 'agreement', 'decomposition', 'acceptance', 'development'], 'ids never change');
  assert.equal(saved.stages[1].title, 'Вникнуть');
  assert.deepEqual(x.data.pending, [true, false]);
  assert.equal(x.$('[data-processes-status]').textContent, 'Процессы сохранены.');
  assert.equal(x.$('[data-processes-save]').disabled, true);
  assert.equal(x.api.isDirty(), false);
});

test('the editor adds and deletes stages, adds a process and Cancel restores the stored version', async t => {
  const x = editor(t, { stored: JSON.stringify({ version: 1, processes: [DEFAULT_PROCESS, custom] }) }); await settle();
  assert.equal(x.process('p-report').querySelector('[data-control="process-remove"]'), null, 'a saved process is not removed here');
  // Delete the middle stage: focus moves to the next stage's delete button.
  x.stageControl(DEFAULT_PROCESS_ID, 'agreement', 'stage-delete').click();
  assert.equal(x.stages(DEFAULT_PROCESS_ID).includes('Согласование'), false);
  assert.equal(x.doc.activeElement, x.stageControl(DEFAULT_PROCESS_ID, 'decomposition', 'stage-delete'));
  assert.match(x.$('[data-processes-status]').textContent, /«Согласование» будет удалена после сохранения/);
  // A single stage cannot be deleted.
  x.stageControl('p-report', 's-check', 'stage-delete').click();
  assert.equal(x.stageControl('p-report', 's-draft', 'stage-delete').disabled, true);
  // Add a stage: a new stable id and focus in its name.
  x.process('p-report').querySelector('[data-control="stage-add"]').click();
  const added = x.doc.activeElement;
  assert.equal(added.dataset.control, 'stage-title');
  const addedId = added.closest('[data-stage-id]').dataset.stageId;
  assert.match(addedId, /^s-[a-z0-9]+$/);
  x.type(added, 'Сдача');
  // Add a process.
  x.$('[data-processes-add]').click();
  const title = x.doc.activeElement;
  assert.equal(title.dataset.control, 'process-title');
  const processId = title.closest('[data-process-id]').dataset.processId;
  assert.match(processId, /^p-[a-z0-9]+$/);
  x.type(title, 'Ремонт');
  x.type(x.process(processId).querySelector('[data-control="stage-title"]'), 'Смета');
  // Cancel rereads the stored version.
  x.$('[data-processes-cancel]').click(); await settle();
  assert.equal(x.process(processId), null);
  assert.deepEqual(x.stages('p-report'), ['Черновик', 'Проверка']);
  assert.equal(x.stages(DEFAULT_PROCESS_ID).includes('Согласование'), true);
  assert.equal(x.data.writes.length, 0, 'Cancel writes nothing');
  assert.equal(x.$('[data-processes-status]').textContent, 'Изменения отменены.');
  // Again, then save: the deleted stage is gone from the process; tasks keep its id.
  x.stageControl(DEFAULT_PROCESS_ID, 'agreement', 'stage-delete').click();
  x.$('[data-processes-add]').click();
  const next = x.doc.activeElement.closest('[data-process-id]').dataset.processId;
  x.type(x.doc.activeElement, 'Ремонт'); x.type(x.process(next).querySelector('[data-control="stage-title"]'), 'Смета');
  x.$('[data-processes-save]').click(); await settle();
  const written = x.data.writes[0].processes;
  assert.deepEqual(written.map(process => process.title), ['Системный анализ', 'Отчёт', 'Ремонт']);
  assert.equal(written[0].stages.some(stage => stage.id === 'agreement'), false);
});

test('the editor refuses an empty name at its field and reports a save from another device', async t => {
  const x = editor(t); await settle();
  x.$('[data-processes-add]').click();
  const processId = x.doc.activeElement.closest('[data-process-id]').dataset.processId;
  x.$('[data-processes-save]').click(); await settle();
  assert.equal(x.data.writes.length, 0);
  assert.equal(x.$('[data-processes-error]').textContent, 'Назови процесс.');
  assert.equal(x.doc.activeElement, x.process(processId).querySelector('[data-control="process-title"]'));
  assert.equal(x.doc.activeElement.getAttribute('aria-invalid'), 'true');
  x.type(x.doc.activeElement, 'Ремонт');
  x.$('[data-processes-save]').click(); await settle();
  assert.equal(x.$('[data-processes-error]').textContent, 'Назови стадию или удали её.');
  x.process(processId).querySelector('[data-control="process-remove"]').click();
  assert.equal(x.process(processId), null, 'an unsaved process can be removed');
  assert.equal(x.api.isDirty(), false);
  // Another device saved meanwhile: the write is refused and nothing is overwritten.
  x.type(x.stageControl(DEFAULT_PROCESS_ID, 'requirements', 'stage-title'), 'ТЗ');
  x.data.raw = JSON.stringify({ version: 1, processes: [DEFAULT_PROCESS, custom] });
  x.$('[data-processes-save]').click(); await settle();
  assert.equal(x.data.writes.length, 0);
  assert.match(x.$('[data-processes-error]').textContent, /изменены на другом устройстве/);
  assert.equal(x.stageControl(DEFAULT_PROCESS_ID, 'requirements', 'stage-title').value, 'ТЗ', 'the edit stays in the form');
  x.$('[data-processes-cancel]').click(); await settle();
  assert.ok(x.process('p-report'), 'Cancel loads the newer version');
});
