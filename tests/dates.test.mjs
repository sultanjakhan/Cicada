import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  addDays, compareItems, dateFromKey, formatDay, formatMonth, itemSegments,
  minutesLabel, monthDays, shiftMonth, startOfWeek, timeMinutes, todayKey, weekDays,
} from '../src/dates.js';

test('uses local date keys and local noon without UTC drift', () => {
  const date = dateFromKey('2026-01-01');
  assert.equal(date.getHours(), 12);
  assert.equal(todayKey(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
  assert.equal(todayKey(new Date(2026, 0, 1, 23, 55)), '2026-01-01');
});

test('calendar arithmetic crosses leap, month, year and DST boundaries', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(startOfWeek('2026-03-01'), '2026-02-23');
  assert.deepEqual(weekDays('2026-03-01'), [
    '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01',
  ]);
});

test('calendar arithmetic stays on adjacent local days across DST in New York', () => {
  const moduleUrl = new URL('../src/dates.js', import.meta.url).href;
  const script = `import { addDays } from ${JSON.stringify(moduleUrl)}; console.log(addDays('2026-03-08', 1), addDays('2026-11-01', 1));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2026-03-09 2026-11-02');
});

test('month grids always contain six Monday-first weeks', () => {
  const days = monthDays('2024-02-14');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2024-01-29');
  assert.equal(days.at(-1), '2024-03-10');
  assert.equal(days[0], startOfWeek(days[0]));
  assert.equal(shiftMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftMonth('2025-01-31', 1), '2025-02-28');
  assert.equal(shiftMonth('2026-01-31', -1), '2025-12-31');
});

test('rejects invalid keys and times instead of normalizing them', () => {
  for (const value of ['2026-02-29', '2026-2-03', '2026-13-01', 'hello']) {
    assert.throws(() => dateFromKey(value), RangeError);
  }
  for (const value of ['24:00', '9:00', '12:60', null]) {
    assert.throws(() => timeMinutes(value), RangeError);
  }
  assert.equal(timeMinutes('23:59'), 1439);
  assert.equal(minutesLabel(0), '00:00');
  assert.equal(minutesLabel(1440), '24:00');
  assert.throws(() => minutesLabel(1441), RangeError);
});

test('splits timed cross-midnight items into daily segments', () => {
  assert.deepEqual(itemSegments({ date: '2026-09-10', time: '23:30', duration_minutes: 90 }), [
    { date: '2026-09-10', start: 1410, end: 1440, continuedBefore: false, continuedAfter: true },
    { date: '2026-09-11', start: 0, end: 60, continuedBefore: true, continuedAfter: false },
  ]);
  assert.deepEqual(itemSegments({ date: '2026-09-10', time: null, duration_minutes: 60 }), []);
  assert.deepEqual(itemSegments({ date: null, time: '08:00', duration_minutes: 60 }), []);
  assert.throws(() => itemSegments({ date: '2026-09-10', time: '08:00', duration_minutes: 0 }), RangeError);
});

test('sorts dated items, then untimed items, then undated records deterministically', () => {
  const items = [
    { id: '4', date: null, time: null, title: 'Без даты' },
    { id: '3', date: '2026-09-10', time: '09:00', title: 'Бета' },
    { id: '2', date: '2026-09-10', time: null, title: 'Альфа' },
    { id: '1', date: '2026-09-09', time: '23:00', title: 'Гамма' },
  ];
  assert.deepEqual(items.sort(compareItems).map(item => item.id), ['1', '2', '3', '4']);
  assert.equal(formatMonth('2026-09-10'), 'сентябрь 2026');
  assert.equal(formatDay('2026-09-10'), 'четверг, 10 сентября');
});
