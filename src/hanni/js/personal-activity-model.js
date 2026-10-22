const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OBSERVATION_STATES = new Set(['disabled', 'unsupported', 'partial', 'unavailable']);

function finiteMs(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidDateKey(value) {
  const match = typeof value === 'string' && value.match(DAY_PATTERN);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function localDayBounds(value) {
  if (!isValidDateKey(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const startDate = new Date(0);
  startDate.setHours(0, 0, 0, 0);
  startDate.setFullYear(year, month - 1, day);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  const startMs = startDate.getTime(), endMs = endDate.getTime();
  if (!finiteMs(startMs) || !finiteMs(endMs) || endMs <= startMs || endMs - startMs > 27 * 60 * 60 * 1000) return null;
  return { date: value, startMs, endMs };
}

export function validInterval(value, bounds = null) {
  if (!value || !finiteMs(value.startMs) || !finiteMs(value.endMs) || value.endMs <= value.startMs) return null;
  if (bounds && (value.endMs <= bounds.startMs || value.startMs >= bounds.endMs)) return null;
  return {
    ...value,
    startMs: bounds ? Math.max(value.startMs, bounds.startMs) : value.startMs,
    endMs: bounds ? Math.min(value.endMs, bounds.endMs) : value.endMs,
  };
}

export function clipAndMergeIntervals(intervals, bounds = null) {
  if (!Array.isArray(intervals)) return null;
  const valid = intervals.map(item => validInterval(item, bounds)).filter(item => item && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const item of valid) {
    const last = merged.at(-1);
    if (last && item.startMs <= last.endMs) last.endMs = Math.max(last.endMs, item.endMs);
    else merged.push({ startMs: item.startMs, endMs: item.endMs });
  }
  return merged;
}

export function unionDurationMs(intervals, bounds = null) {
  const merged = clipAndMergeIntervals(intervals, bounds);
  if (!merged) return null;
  return merged.reduce((sum, item) => sum + item.endMs - item.startMs, 0);
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function parseExecutableBasenames(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
  const invalid = () => ({ ok: false, error: 'Некорректное имя приложения или слишком длинный список.' });
  const names = [];
  for (const part of source) {
    if (typeof part !== 'string') return invalid();
    const name = part.trim();
    if (!name) continue;
    const byteLength = utf8ByteLength(name);
    const stem = name.slice(0, -4);
    if (byteLength > 200 || /[\\/:<>"|?*\u0000-\u001f\u007f]/.test(name) || !/^[^<>:"|?*]+\.exe$/i.test(name)
      || name.startsWith('.') || name.includes('..')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return invalid();
    const canonical = name.toLowerCase();
    if (!names.includes(canonical)) names.push(canonical);
    if (names.length > 32) return invalid();
  }
  names.sort();
  return { ok: true, value: names };
}

export function formatExecutableBasenames(names) {
  return Array.isArray(names) && names.every(name => typeof name === 'string') ? names.join(', ') : '';
}

// Health activity stores precise UTC milliseconds as startMs/endMs. The
// SQLite link columns are start_ms/end_ms; rounded date/time is not accepted.
export function walkingRecordInterval(record, bounds) {
  if (!record || record.health_kind !== 'walking') return null;
  const startMs = record.health_start_ms ?? record.healthStartMs;
  const endMs = record.health_end_ms ?? record.healthEndMs;
  return validInterval({ startMs, endMs }, bounds);
}

export function walkingIntervals(records, bounds) {
  if (!Array.isArray(records)) return null;
  return records.map(record => walkingRecordInterval(record, bounds)).filter(Boolean);
}

function utcTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Convert only the scoped native task-block shape; date/time fields are ignored. */
export function taskBlockIntervals(rows, task, bounds, nowMs = Date.now()) {
  if (!Array.isArray(rows) || !task || task.source_type == null || task.source_id == null || !finiteMs(nowMs)) return null;
  const intervals = [];
  for (const row of rows) {
    if (!row || row.source_type !== task.source_type || String(row.source_id) !== String(task.source_id)) return null;
    const startMs = utcTimestamp(row.created_at);
    if (startMs == null || typeof row.is_active !== 'boolean' || !Number.isSafeInteger(row.duration_seconds) || row.duration_seconds < 0) return null;
    const endMs = row.is_active ? nowMs : startMs + row.duration_seconds * 1000;
    const interval = validInterval({ startMs, endMs }, bounds);
    if (interval) intervals.push(interval);
  }
  return intervals;
}

function statusForIntervals(intervals, sourceAvailable) {
  if (!sourceAvailable || !Array.isArray(intervals) || intervals.length === 0) return { state: 'unknown', durationMs: null };
  const merged = clipAndMergeIntervals(intervals);
  if (!merged?.length) return { state: 'unknown', durationMs: null };
  return { state: 'known', durationMs: merged.reduce((sum, item) => sum + item.endMs - item.startMs, 0) };
}

export function normalizeDayResult(value, bounds) {
  if (!value || typeof value !== 'object' || value.date !== bounds?.date || value.startMs !== bounds.startMs || value.endMs !== bounds.endMs) return null;
  if (!OBSERVATION_STATES.has(value.observationState) || !Array.isArray(value.intervals)) return null;
  if (value.intervals.some(item => !validInterval(item))) return null;
  if (value.observedMs != null && !finiteMs(value.observedMs)) return null;
  return { ...value, intervals: value.intervals.map(item => validInterval(item, bounds)).filter(Boolean) };
}

export function summarizePersonalActivity({ bounds, dayResult, walkingRecords, walkingAvailable = false, taskIntervals, taskAvailable = false } = {}) {
  const dayIntervals = Array.isArray(dayResult?.intervals) ? dayResult.intervals : null;
  const games = statusForIntervals(dayIntervals ? clipAndMergeIntervals(dayIntervals, bounds) : null, dayIntervals !== null);
  const walking = statusForIntervals(walkingIntervals(walkingRecords, bounds), walkingAvailable);
  const work = statusForIntervals(taskIntervals ? clipAndMergeIntervals(taskIntervals, bounds) : null, taskAvailable);
  return {
    bounds,
    games,
    walking,
    work,
    observationState: dayResult?.observationState || 'unavailable',
    freshnessMs: dayResult?.observedMs ?? null,
    walkingRecordCount: walkingAvailable && Array.isArray(walkingRecords) ? walkingRecords.filter(record => record?.health_kind === 'walking').length : 0,
    walkingPreciseCount: walkingAvailable ? (walkingIntervals(walkingRecords, bounds)?.length || 0) : 0,
    sourceError: dayResult?.error || null,
  };
}

export function formatDuration(durationMs, copy = value => value) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return copy('нет данных');
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 1) return copy('меньше минуты');
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return copy.format ? copy.format('{0} мин', minutes) : `${minutes} мин`;
  if (!rest) return copy.format ? copy.format('{0} ч', hours) : `${hours} ч`;
  return copy.format ? copy.format('{0} ч {1} мин', hours, rest) : `${hours} ч ${rest} мин`;
}
