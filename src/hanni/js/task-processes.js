// Task processes (owner decision 2026-09-25): a process is a named, ordered list
// of stages. Only a task with a process shows a stage; the built-in process is
// «Системный анализ». No DOM imports except the small time-per-stage view at the end.
//
// Storage and sync:
// - process definitions: the SQLite ui_state key below, one sync record per
//   process (mvp_sync_db.rs). The built-in process is not stored until the
//   owner saves the settings editor. Writes are read → change → compare-and-swap.
// - on a task (items.tags, native task_attributes.rs): `task-process:<id>`,
//   `task-stage:<id>`, `task-waiting` and the history `task-stage-log:<stage>@<UTC>`.
//   Rows carry `process` (derived for 0.3.33 tasks that have a stage but no
//   process), `stage`, `waiting` and `stage_log` [{ stage, at }].
// Stage ids are stable slugs: renaming never touches tasks; a task whose stage
// was deleted keeps the id and shows «Стадия удалена» until it is changed.
export const PROCESSES_STATE_KEY = 'calendar_processes_v1';
export const DEFAULT_PROCESS_ID = 'system-analysis';
export const DELETED_STAGE_LABEL = 'Стадия удалена';
export const PROCESS_LIMITS = Object.freeze({ processes: 20, stages: 30, title: 80 });
export const PROCESS_STALE_MESSAGE = 'Процессы изменены на другом устройстве. Нажми «Отменить изменения», чтобы загрузить новую версию, и повтори.';
const VERSION = 1;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const freeze = process => Object.freeze({ ...process, stages: Object.freeze(process.stages.map(stage => Object.freeze(stage))) });
export const DEFAULT_PROCESS = freeze({ id: DEFAULT_PROCESS_ID, title: 'Системный анализ', stages: [
  ['understanding', 'Понимание'], ['requirements', 'Требования'], ['analysis', 'Анализ и модели'], ['description', 'Описание'],
  ['agreement', 'Согласование'], ['decomposition', 'Декомпозиция'], ['development', 'В разработке'], ['acceptance', 'Приёмка'],
].map(([id, title]) => ({ id, title })) });
const copy = process => ({ ...process, stages: process.stages.map(stage => ({ ...stage })) });
const text = value => String(value ?? '').trim();
const errorText = cause => typeof cause === 'string' ? cause : cause?.message;

export const isProcessId = value => typeof value === 'string' && ID.test(value);
export const defaultProcesses = () => [copy(DEFAULT_PROCESS)];

/** A fresh stable id that is not in `taken` (slug, never derived from the name). */
export function newProcessId(prefix, taken = []) {
  const used = new Set(taken);
  for (;;) {
    const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) || Math.random().toString(36).slice(2, 12);
    const id = `${prefix}-${random}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Reads the stored state. Nothing stored means the built-in process only; a
 * stored list always keeps the built-in process (first when it was missing).
 * Unknown fields are kept so an older client never erases newer data.
 */
export function normalizeProcessState(raw) {
  if (raw == null || raw === '') return { version: VERSION, processes: defaultProcesses() };
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object' || source.version !== VERSION || !Array.isArray(source.processes)) throw new Error('Неподдерживаемый формат процессов. Сохранение остановлено, чтобы не потерять данные.');
  const seen = new Set();
  const processes = source.processes.flatMap(row => {
    const id = row?.id, title = text(row?.title).slice(0, PROCESS_LIMITS.title);
    if (!isProcessId(id) || seen.has(id) || !title || !Array.isArray(row.stages)) return [];
    const ids = new Set();
    const stages = row.stages.flatMap(stage => {
      const stageId = stage?.id, name = text(stage?.title).slice(0, PROCESS_LIMITS.title);
      if (!isProcessId(stageId) || ids.has(stageId) || !name) return [];
      ids.add(stageId);
      return [{ ...stage, id: stageId, title: name }];
    });
    if (!stages.length) return [];
    seen.add(id);
    return [{ ...row, id, title, stages }];
  });
  if (!seen.has(DEFAULT_PROCESS_ID)) processes.unshift(copy(DEFAULT_PROCESS));
  return { ...source, version: VERSION, processes };
}

export class ProcessValidationError extends Error {
  constructor(message, { processId = null, stageId = null, field = 'title' } = {}) {
    super(message); this.name = 'ProcessValidationError'; Object.assign(this, { processId, stageId, field });
  }
}
/** Checks an edited list before it is saved; throws with the offending field. */
export function validateProcesses(processes) {
  if (!Array.isArray(processes) || !processes.length) throw new ProcessValidationError('Нужен хотя бы один процесс.');
  if (processes.length > PROCESS_LIMITS.processes) throw new ProcessValidationError(`Можно сохранить до ${PROCESS_LIMITS.processes} процессов.`);
  const ids = new Set();
  return processes.map(process => {
    const title = text(process?.title);
    if (!isProcessId(process?.id) || ids.has(process.id)) throw new ProcessValidationError('У процесса неверный идентификатор. Отмени изменения и повтори.', { processId: process?.id });
    ids.add(process.id);
    if (!title) throw new ProcessValidationError('Назови процесс.', { processId: process.id });
    if (title.length > PROCESS_LIMITS.title) throw new ProcessValidationError(`Сократи название процесса до ${PROCESS_LIMITS.title} символов.`, { processId: process.id });
    const stages = Array.isArray(process.stages) ? process.stages : [];
    if (!stages.length) throw new ProcessValidationError(`В процессе «${title}» нужна хотя бы одна стадия.`, { processId: process.id, field: 'stages' });
    if (stages.length > PROCESS_LIMITS.stages) throw new ProcessValidationError(`В процессе можно держать до ${PROCESS_LIMITS.stages} стадий.`, { processId: process.id, field: 'stages' });
    const stageIds = new Set();
    return { ...process, title, stages: stages.map(stage => {
      const name = text(stage?.title);
      if (!isProcessId(stage?.id) || stageIds.has(stage.id)) throw new ProcessValidationError('У стадии неверный идентификатор. Отмени изменения и повтори.', { processId: process.id, stageId: stage?.id });
      stageIds.add(stage.id);
      if (!name) throw new ProcessValidationError('Назови стадию или удали её.', { processId: process.id, stageId: stage.id });
      if (name.length > PROCESS_LIMITS.title) throw new ProcessValidationError(`Сократи название стадии до ${PROCESS_LIMITS.title} символов.`, { processId: process.id, stageId: stage.id });
      return { ...stage, title: name };
    }) };
  });
}

export async function readProcessState(invoke) {
  const raw = await invoke('get_ui_state', { key: PROCESSES_STATE_KEY });
  return { raw: raw ?? null, state: normalizeProcessState(raw) };
}
/** Processes for display; an unreadable state falls back to the built-in process. */
export async function loadProcesses(invoke) {
  try { return (await readProcessState(invoke)).state.processes; } catch { return defaultProcesses(); }
}
/** Compare-and-swap write of the whole list; `expectedRaw` is the value it was edited from. */
export async function saveProcessState(invoke, processes, expectedRaw) {
  const valid = validateProcesses(processes);
  const current = expectedRaw ? normalizeProcessState(expectedRaw) : { version: VERSION };
  const value = JSON.stringify({ ...current, version: VERSION, processes: valid });
  try { await invoke('set_ui_state', { key: PROCESSES_STATE_KEY, value, expectedValue: expectedRaw ?? '' }); }
  catch (cause) { if (errorText(cause) === 'mvp_sync_stale_ui_state') throw new Error(PROCESS_STALE_MESSAGE); throw cause; }
  const win = globalThis.window;
  if (win?.CustomEvent) win.dispatchEvent(new win.CustomEvent('hanni:processes-changed'));
  return { raw: value, state: normalizeProcessState(value) };
}

// ---- A task's process and stage ----
/** The process of a task row; a stage or «Жду ответа» without a process means the built-in one. */
export function taskProcessId(row) {
  const id = row?.process;
  if (typeof id === 'string' && id) return id;
  return row?.stage || row?.waiting === true ? DEFAULT_PROCESS_ID : '';
}
export const findProcess = (processes, id) => (processes || []).find(process => process.id === id) || null;
/** The name of any stored stage id, or ''. */
export function stageTitleAnywhere(processes, stageId) {
  for (const process of processes || []) { const stage = process.stages.find(item => item.id === stageId); if (stage) return stage.title; }
  return '';
}
/**
 * Stage state of a task, or null when it has no process (no stage UI then).
 * `next` is the stage the arrow moves to: the first stage from none, the
 * following one otherwise, null at the last stage and for a deleted stage.
 */
export function taskStage(row, processes) {
  const processId = taskProcessId(row);
  if (!processId) return null;
  const process = findProcess(processes, processId);
  const stages = process?.stages || [];
  const stage = typeof row?.stage === 'string' ? row.stage : '';
  const index = stage ? stages.findIndex(item => item.id === stage) : -1;
  const deleted = !!stage && index < 0;
  const label = !stage ? '' : index >= 0 ? stages[index].title : (process ? '' : stageTitleAnywhere(processes, stage)) || DELETED_STAGE_LABEL;
  const next = deleted ? null : stages[index + 1] || null;
  return { processId, process, processTitle: process?.title || 'Процесс не найден', stages, stage, index, deleted, label, next, isLast: index >= 0 && index === stages.length - 1, waiting: row?.waiting === true };
}

// ---- Time per stage (pure) ----
// Only an RFC 3339 date-time counts: Date.parse accepts loose strings such as '0'.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const toMs = value => { const time = typeof value === 'string' && ISO.test(value) ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : NaN; };
/** A block as [start, end) in ms; a running block ends now. `created_at` is its UTC start. */
export function blockInterval(block, now) {
  let start = toMs(block?.created_at);
  if (!Number.isFinite(start)) start = new Date(`${block?.date}T${block?.start_time}`).getTime();
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60);
  const end = block.is_active ? now : start + seconds * 1000;
  return end > start ? { start, end } : null;
}
/** Overlapping blocks of one task count once. */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(Boolean).sort((a, b) => a.start - b.start), out = [];
  for (const item of sorted) {
    const last = out.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end); else out.push({ ...item });
  }
  return out;
}
/**
 * Periods of each stage from the history. Without history the current stage
 * covers all time; before the first entry the task had no stage ('').
 */
export function stagePeriods(log, currentStage = '') {
  const entries = (Array.isArray(log) ? log : []).map((entry, index) => ({ stage: typeof entry?.stage === 'string' ? entry.stage : '', at: toMs(entry?.at), index }))
    .filter(entry => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at || a.index - b.index);
  if (!entries.length) return [{ stage: currentStage || '', start: -Infinity, end: Infinity }];
  const periods = [{ stage: '', start: -Infinity, end: entries[0].at }];
  entries.forEach((entry, index) => periods.push({ stage: entry.stage, start: entry.at, end: entries[index + 1]?.at ?? Infinity }));
  return periods.filter(period => period.end > period.start);
}
/**
 * Seconds of timer work of one task inside each stage period: Map(stageId → seconds),
 * '' for time without a stage. Blocks of other tasks never count here, so
 * parallel tasks each keep their own time.
 */
export function stageSeconds({ blocks = [], log = [], stage = '', now = Date.now() } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const intervals = mergeIntervals(blocks.map(block => blockInterval(block, at)));
  const totals = new Map();
  for (const period of stagePeriods(log, stage)) {
    for (const interval of intervals) {
      const ms = Math.min(interval.end, period.end) - Math.max(interval.start, period.start);
      if (ms > 0) totals.set(period.stage, (totals.get(period.stage) || 0) + ms / 1000);
    }
  }
  return totals;
}
/** «25 мин», «1 ч», «1 ч 10 мин». */
export function formatStageDuration(seconds) {
  const minutes = Math.floor(Math.max(0, Number(seconds) || 0) / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}
/**
 * Display parts in process order: stages with at least a minute and the
 * current stage (live); then deleted stages together; then time without a stage.
 */
export function stageTimeParts(state, totals) {
  if (!state) return [];
  const parts = [], known = new Set(state.stages.map(stage => stage.id));
  for (const stage of state.stages) {
    const seconds = totals.get(stage.id) || 0, current = stage.id === state.stage;
    if (seconds >= 60 || current) parts.push({ id: stage.id, label: stage.title, seconds, current });
  }
  let deleted = 0, count = 0, current = false;
  for (const [id, seconds] of totals) if (id && !known.has(id)) { deleted += seconds; count++; current ||= id === state.stage; }
  if (state.deleted && !totals.has(state.stage)) { count++; current = true; }
  if (deleted >= 60 || current) parts.push({ id: '#deleted', label: count > 1 ? 'Удалённые стадии' : DELETED_STAGE_LABEL, seconds: deleted, current });
  const none = totals.get('') || 0;
  if (none >= 60) parts.push({ id: '', label: 'Без стадии', seconds: none, current: false });
  return parts;
}
/** «Понимание 25 мин · Требования 1 ч 10 мин». */
export const stageTimeText = parts => parts.map(part => `${part.label} ${formatStageDuration(part.seconds)}`).join(' · ');
/** One line for a row's tooltip. */
export function stageTimeTitle(state, totals) {
  const parts = stageTimeParts(state, totals).filter(part => part.seconds >= 60);
  return parts.length ? `Время по стадиям: ${stageTimeText(parts)}` : 'Время по стадиям пока не учтено';
}
/** Blocks of several tasks in one read, grouped by task id; a failed read gives none. */
export async function loadStageBlocks(invoke, sourceIds) {
  const ids = [...new Set(sourceIds.map(String))], out = new Map();
  if (!ids.length) return out;
  try {
    const rows = await invoke('get_calendar_task_blocks', { sourceIds: ids });
    for (const block of Array.isArray(rows) ? rows : []) {
      const id = String(block.source_id);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(block);
    }
  } catch { /* Time per stage is context only. */ }
  return out;
}

/**
 * «Время по стадиям» in a task's details: every stage with its time and the
 * current one live. Renders into `element`; returns a stop function.
 */
export function mountStageTime(element, { invoke, row, processes, now = () => new Date() }) {
  const state = taskStage(row, processes), doc = element.ownerDocument, win = doc.defaultView;
  if (!state) { element.hidden = true; return () => {}; }
  element.hidden = false; element.classList.add('stage-time');
  element.textContent = 'Загружаем время по стадиям…';
  let blocks = null, timer = null, stopped = false;
  const paint = () => {
    if (stopped) return;
    const parts = stageTimeParts(state, stageSeconds({ blocks, log: row.stage_log, stage: state.stage, now: now() }));
    element.replaceChildren();
    const label = doc.createElement('span'); label.className = 'stage-time-label'; label.textContent = 'Время по стадиям';
    element.append(label);
    if (!parts.some(part => part.seconds >= 60 || part.current)) { element.append(doc.createTextNode(': пока не учтено.')); return; }
    element.append(doc.createTextNode(': '));
    parts.forEach((part, index) => {
      if (index) element.append(doc.createTextNode(' · '));
      const item = doc.createElement(part.current ? 'strong' : 'span');
      item.className = 'stage-time-part';
      item.textContent = `${part.label} ${formatStageDuration(part.seconds)}`;
      if (part.current) { item.dataset.stageTimeCurrent = ''; item.title = 'Текущая стадия, время идёт, пока работает таймер'; }
      element.append(item);
    });
  };
  void invoke('get_calendar_task_blocks', { sourceIds: [String(row.source_id ?? row.id)] }).then(rows => {
    if (stopped) return;
    blocks = Array.isArray(rows) ? rows : [];
    paint();
    // The current stage grows while its timer runs.
    if (blocks.some(block => block.is_active)) timer = win.setInterval(() => { if (!element.isConnected) stop(); else paint(); }, 15000);
  }).catch(() => { if (!stopped) element.textContent = 'Время по стадиям сейчас недоступно.'; });
  const stop = () => { stopped = true; if (timer) win.clearInterval(timer); };
  return stop;
}
