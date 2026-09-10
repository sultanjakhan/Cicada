const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const WEEKDAYS = [
  'воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота',
];

function invalid(message) {
  throw new RangeError(message);
}

function keyParts(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    invalid(`Invalid date key: ${key}`);
  }
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    invalid(`Invalid date key: ${key}`);
  }
  return { year, month, day, date };
}

function keyFromDate(date) {
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysInMonth(year, monthIndex) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex + 1, 0);
  return date.getDate();
}

export function todayKey(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) invalid('Invalid date');
  return keyFromDate(now);
}

export function dateFromKey(key) {
  return keyParts(key).date;
}

export function addDays(key, days) {
  if (!Number.isInteger(days)) invalid(`Invalid day offset: ${days}`);
  const date = dateFromKey(key);
  date.setDate(date.getDate() + days);
  return keyFromDate(date);
}

export function startOfWeek(key) {
  const date = dateFromKey(key);
  const mondayOffset = (date.getDay() + 6) % 7;
  return addDays(key, -mondayOffset);
}

export function weekDays(key) {
  const start = startOfWeek(key);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function monthDays(key) {
  const { year, month } = keyParts(key);
  const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function shiftMonth(key, offset) {
  if (!Number.isInteger(offset)) invalid(`Invalid month offset: ${offset}`);
  const { year, month, day } = keyParts(key);
  const absoluteMonth = year * 12 + (month - 1) + offset;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonthIndex = ((absoluteMonth % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonthIndex));
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export function timeMinutes(time) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    invalid(`Invalid time: ${time}`);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minutesLabel(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    invalid(`Invalid minutes: ${minutes}`);
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function itemSegments(item) {
  if (!item || item.date == null || item.time == null) return [];
  dateFromKey(item.date);
  const start = timeMinutes(item.time);
  if (!Number.isInteger(item.duration_minutes) || item.duration_minutes < 1 || item.duration_minutes > 1440) {
    invalid(`Invalid duration: ${item.duration_minutes}`);
  }

  const segments = [];
  let date = item.date;
  let minute = start;
  let remaining = item.duration_minutes;
  while (remaining > 0) {
    const length = Math.min(remaining, 1440 - minute);
    remaining -= length;
    segments.push({
      date,
      start: minute,
      end: minute + length,
      continuedBefore: segments.length > 0,
      continuedAfter: remaining > 0,
    });
    date = addDays(date, 1);
    minute = 0;
  }
  return segments;
}

export function compareItems(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  const leftDate = left.date == null ? null : left.date;
  const rightDate = right.date == null ? null : right.date;
  if (leftDate !== rightDate) {
    if (leftDate == null) return 1;
    if (rightDate == null) return -1;
    return leftDate < rightDate ? -1 : 1;
  }

  const leftTime = left.time == null ? -1 : timeMinutes(left.time);
  const rightTime = right.time == null ? -1 : timeMinutes(right.time);
  if (leftTime !== rightTime) return leftTime - rightTime;

  const titleOrder = String(left.title ?? '').localeCompare(String(right.title ?? ''), 'ru');
  if (titleOrder !== 0) return titleOrder;
  return String(left.id ?? '').localeCompare(String(right.id ?? ''), 'ru');
}

export function formatMonth(key) {
  const { year, month } = keyParts(key);
  return `${MONTHS[month - 1]} ${year}`;
}

export function formatDay(key) {
  const { month, day, date } = keyParts(key);
  return `${WEEKDAYS[date.getDay()]}, ${day} ${MONTHS_GENITIVE[month - 1]}`;
}
