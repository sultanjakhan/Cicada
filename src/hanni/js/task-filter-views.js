// Saved task views contain filter choices only. The generic native UI-state key
// provides a local, compare-and-swap snapshot without touching task records.
export const TASK_FILTER_VIEWS_KEY = 'calendar_task_filter_views_v1';
export const VIEW_LIMITS = Object.freeze({
  views: 30, title: 80, search: 256, ref: 512, id: 128, raw: 131072,
});

export const DEFAULT_TASK_FILTERS = Object.freeze({
  filter: 'active', search: '', goal: '', sphere: '', personal: '',
  groupBy: 'date', source: '', project: '', tag: '',
});
export const ALL_TASK_FILTERS = Object.freeze({ ...DEFAULT_TASK_FILTERS, filter: 'all' });

const FILTER_KEYS = Object.keys(DEFAULT_TASK_FILTERS);
const FILTER_MODES = new Set(['all', 'active', 'today', 'undated', 'completed', 'review', 'ai-running']);
const SPHERES = new Set(['', 'work', 'personal']);
const PERSONAL_SPHERES = new Set(['', 'home', 'health', 'growth', 'personal', 'none']);
const GROUPS = new Set(['date', 'goal']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED_IDS = new Set(['all', 'active']);

export class TaskFilterViewsError extends Error {
  constructor(code, message, cause, parameters = []) {
    super(message.replace(/\{(\d+)\}/g, (_, index) => String(parameters[Number(index)] ?? '')), cause === undefined ? undefined : { cause });
    this.copyKey = message;
    this.parameters = parameters;
    this.name = 'TaskFilterViewsError';
    this.code = code;
  }
}

const invalid = (message, ...parameters) => new TaskFilterViewsError('validation', message, undefined, parameters);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => new TextEncoder().encode(value).length;

function validateFilters(value, { complete }) {
  if (!isRecord(value)) throw invalid('Фильтры вида повреждены.');
  if (Object.keys(value).some(key => !FILTER_KEYS.includes(key))) {
    throw invalid('Сохранённый вид содержит неизвестный фильтр.');
  }
  if (complete && FILTER_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw invalid('В сохранённом виде отсутствует фильтр.');
  }
  const filters = { ...DEFAULT_TASK_FILTERS };
  for (const key of FILTER_KEYS) {
    const candidate = value[key];
    if (candidate === undefined && !complete) continue;
    if (typeof candidate !== 'string') throw invalid('Недопустимое значение фильтра «{0}».', key);
    const limit = key === 'search' ? VIEW_LIMITS.search : VIEW_LIMITS.ref;
    if (candidate.length > limit) throw invalid('Фильтр «{0}» слишком длинный.', key);
    filters[key] = candidate;
  }
  if (!FILTER_MODES.has(filters.filter) || !SPHERES.has(filters.sphere)
    || !PERSONAL_SPHERES.has(filters.personal) || !GROUPS.has(filters.groupBy)) {
    throw invalid('Сохранённый вид содержит неподдерживаемое значение фильтра.');
  }
  return filters;
}

/** Extract only the choices that affect the task list, filling missing defaults. */
export function taskFilters(state = {}) {
  if (!isRecord(state)) throw invalid('Невозможно прочитать фильтры задач.');
  return validateFilters(Object.fromEntries(FILTER_KEYS.filter(key => state[key] != null)
    .map(key => [key, state[key]])), { complete: false });
}

function validateView(view) {
  if (!isRecord(view)) throw invalid('Сохранённый вид повреждён.');
  if (typeof view.id !== 'string' || !view.id.length || view.id.length > VIEW_LIMITS.id
    || !ID_PATTERN.test(view.id) || RESERVED_IDS.has(view.id)) throw invalid('Недопустимый идентификатор сохранённого вида.');
  if (typeof view.title !== 'string' || !view.title.trim()
    || view.title.trim().length > VIEW_LIMITS.title) throw invalid('Название вида должно содержать от 1 до 80 символов.');
  return { ...view, title: view.title.trim(), filters: validateFilters(view.filters, { complete: true }) };
}

function validateState(value) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.views)) {
    throw invalid('Формат сохранённых видов задач не поддерживается.');
  }
  if (value.views.length > VIEW_LIMITS.views) throw invalid('Слишком много сохранённых видов задач.');
  const seen = new Set();
  const views = value.views.map(view => {
    const checked = validateView(view);
    if (seen.has(checked.id)) throw invalid('Идентификаторы сохранённых видов повторяются.');
    seen.add(checked.id);
    return checked;
  });
  return { ...value, version: 1, views };
}

function serializeState(state) {
  let raw;
  try { raw = JSON.stringify(validateState(state)); }
  catch (error) {
    if (error instanceof TaskFilterViewsError) throw error;
    throw new TaskFilterViewsError('validation', 'Не удалось подготовить сохранённые виды задач.', error);
  }
  if (typeof raw !== 'string' || byteLength(raw) > VIEW_LIMITS.raw) {
    throw invalid('Сохранённые виды задач превышают допустимый размер.');
  }
  return raw;
}

/** Missing UI state is an empty collection; malformed or future data fails closed. */
export function parseTaskFilterViews(raw) {
  if (raw == null || raw === '') return { version: 1, views: [] };
  if (typeof raw !== 'string' || byteLength(raw) > VIEW_LIMITS.raw) {
    throw invalid('Сохранённые виды задач превышают допустимый размер.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new TaskFilterViewsError('validation', 'Не удалось прочитать сохранённые виды задач.', error); }
  return validateState(parsed);
}

/** Generate a persistent view ID, checking the IDs already present in the list. */
export function newTaskFilterViewId(taken = []) {
  const entries = taken instanceof Set ? [...taken] : Array.isArray(taken) ? taken : taken?.views;
  if (!Array.isArray(entries)) throw invalid('Список сохранённых видов повреждён.');
  const ids = new Set(entries.map(entry => typeof entry === 'string' ? entry : entry?.id));
  for (let attempt = 0; attempt < 20; attempt++) {
    const random = globalThis.crypto?.randomUUID?.()
      ?? (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    const id = 'view-' + random;
    if (!ids.has(id)) return id;
  }
  throw new TaskFilterViewsError('validation', 'Не удалось создать уникальный идентификатор вида.');
}

export async function readTaskFilterViews(invoke) {
  let raw;
  try { raw = await invoke('get_ui_state', { key: TASK_FILTER_VIEWS_KEY }); }
  catch (error) { throw new TaskFilterViewsError('read', 'Не удалось загрузить сохранённые виды задач.', error); }
  return { raw: raw ?? null, state: parseTaskFilterViews(raw) };
}

function mergeViews(current, requested) {
  const oldById = new Map(current.views.map(view => [view.id, view]));
  return requested.map(view => isRecord(view) && oldById.has(view.id)
    ? { ...oldById.get(view.id), ...view }
    : view);
}

const isStale = error => {
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
    if (String(cause?.message ?? cause).includes('mvp_sync_stale_ui_state')) return true;
  }
  return false;
};

/** Save an edited state or view array against the exact raw value last read. */
export async function saveTaskFilterViews(invoke, views, expectedRaw) {
  if (expectedRaw != null && typeof expectedRaw !== 'string') throw invalid('Неверная исходная версия сохранённых видов.');
  const current = parseTaskFilterViews(expectedRaw);
  if (!Array.isArray(views) && (!isRecord(views) || views.version !== 1 || !Array.isArray(views.views))) {
    throw invalid('Формат сохранённых видов задач не поддерживается.');
  }
  const submitted = Array.isArray(views) ? { views } : views;
  const state = validateState({ ...current, ...submitted, version: 1,
    views: mergeViews(current, submitted.views) });
  const raw = serializeState(state);
  try {
    await invoke('set_ui_state', {
      key: TASK_FILTER_VIEWS_KEY, value: raw, expectedValue: expectedRaw ?? '',
    });
  } catch (error) {
    if (isStale(error)) {
      throw new TaskFilterViewsError('conflict', 'Сохранённые виды изменились в другом окне. Загрузите их снова и повторите изменение.', error);
    }
    // A transport failure can arrive after native committed the write. Only an
    // exact read-back of the intended bytes acknowledges that outcome.
    try {
      const stored = await invoke('get_ui_state', { key: TASK_FILTER_VIEWS_KEY });
      if (stored === raw) return { raw, state };
    } catch { /* Keep the original write error. */ }
    throw new TaskFilterViewsError('write', 'Не удалось сохранить виды задач.', error);
  }
  return { raw, state };
}
