import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';

function setup(t) {
  const dom = new JSDOM('<!doctype html><div class="uni-content"><main></main></div>', { url: 'https://fixture.invalid' });
  t.after(() => dom.window.close());
  globalThis.document = dom.window.document;
  return { dom, host: dom.window.document.querySelector('main') };
}

test('Month keeps 42 date cells, shows timed and no-time previews in order, and reports exact overflow', t => {
  const { host } = setup(t), selected = [];
  const records = [
    { id: 'event:timed:2026-09-26', source_type: 'event', source_id: 'timed', title: 'Созвон с командой', date: '2026-09-26', time: '10:00' },
    { id: 'note:no-time:2026-09-26', source_type: 'note', source_id: 'no-time', title: 'Без срока по времени', date: '2026-09-26', status_extra: 'task' },
    { id: 'schedule:repeat:2026-09-26', source_type: 'schedule', source_id: 'repeat', title: 'Повторение', date: '2026-09-26', time: null },
  ];
  CalendarViews.render(host, { period: 'month', mode: 'grid', date: '2026-09-26', today: '2026-09-27', records, onChooseDate: date => selected.push(date) });
  const cells = [...host.querySelectorAll('.calv-month-cell')];
  assert.equal(cells.length, 42);
  const cell = host.querySelector('[data-calendar-date="2026-09-26"]');
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
  assert.equal(cell.dataset.weekend, 'true');
  const previews = [...cell.querySelectorAll('.calv-month-preview')];
  assert.deepEqual(previews.map(node => node.textContent), ['10:00 · Созвон с командой', 'Без времени · Без срока по времени']);
  assert.deepEqual(previews.map(node => node.dataset.sourceType), ['event', 'note']);
  assert.equal(cell.querySelector('.calv-day-count').textContent, '+1');
  assert.match(cell.getAttribute('aria-label'), /Событие: Созвон с командой, 10:00/);
  assert.match(cell.getAttribute('aria-label'), /Задача: Без срока по времени, без времени/);
  assert.match(cell.getAttribute('aria-label'), /ещё 1/);
  assert.equal(host.querySelector('[data-calendar-date="2026-09-27"][aria-current="date"]')?.dataset.weekend, 'true');
  assert.ok(cells.some(node => node.dataset.outside === 'true'));
  cell.click();
  assert.deepEqual(selected, ['2026-09-26']);
});

test('empty month days have no false overflow marker and preview labels retain selected state', t => {
  const { host } = setup(t);
  CalendarViews.render(host, { period: 'month', mode: 'grid', date: '2026-09-14', today: '2026-09-14', records: [] });
  const cell = host.querySelector('[data-calendar-date="2026-09-14"]');
  assert.equal(cell.getAttribute('aria-current'), 'date');
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
  assert.equal(cell.querySelector('.calv-month-preview'), null);
  assert.equal(cell.querySelector('.calv-day-count'), null);
  assert.match(cell.getAttribute('aria-label'), /пунктов: 0/);
});

test('Day and Week retain event/task identity and their existing time-grid structure', t => {
  const { host } = setup(t);
  const records = [
    { id: 'event:meeting:2026-09-23', source_type: 'event', source_id: 'meeting', title: 'Встреча', date: '2026-09-23', time: '11:00', durationMinutes: 60 },
    { id: 'note:task:2026-09-23', source_type: 'note', source_id: 'task', title: 'Подготовить файл', date: '2026-09-23', time: '12:00', durationMinutes: 45, status_extra: 'task' },
  ];
  for (const period of ['day', 'week']) {
    CalendarViews.render(host, { period, mode: 'grid', date: '2026-09-23', today: '2026-09-23', records });
    assert.equal(host.querySelector('.calv-time-board').classList.contains(`calv-time-board--${period}`), true);
    assert.ok(host.querySelector('[data-record-source="event:meeting"][data-source-type="event"]'));
    assert.ok(host.querySelector('[data-record-source="note:task"][data-source-type="note"]'));
    assert.ok(host.querySelector('.calv-day-column[data-weekend="false"]'));
  }
});
