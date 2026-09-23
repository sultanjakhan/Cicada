import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';
import { mountCalendarGridViewport } from '../src/hanni/js/calendar-grid-viewport.js';

function setup(t) {
  const dom = new JSDOM('<div class="uni-content"><main></main></div>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  globalThis.document = dom.window.document;
  return dom.window.document.querySelector('main');
}
const records = [
  { id: 'event:a:2026-09-23', source_type: 'event', source_id: 'a', title: 'Созвон', date: '2026-09-23', time: '14:00', durationMinutes: 60 },
  { id: 'note:b:2026-09-23', source_type: 'note', source_id: 'b', title: 'Без времени', date: '2026-09-23', time: null, status_extra: 'task' },
];
const base = { mode: 'grid', date: '2026-09-23', today: '2026-09-23', records, onCreateEvent: () => {} };

test('phone week grid scrolls with the pane and keeps only its day headings sticky', t => {
  const host = setup(t);
  CalendarViews.render(host, { ...base, period: 'week', pageScroll: true });
  const head = host.querySelector('.calv-time-frame > .calv-time-headscroll');
  const scroll = host.querySelector('.calv-time-frame > .calv-time-scroll.calv-time-scroll--page');
  assert.ok(head && scroll);
  assert.equal(head.querySelectorAll('.calv-day-heading').length, 7);
  assert.equal(scroll.querySelector('.calv-day-heading'), null);
  assert.equal(head.querySelector('.calv-untimed-band'), null);
  assert.ok(scroll.querySelector('.calv-untimed-band'));
  assert.equal(scroll.style.maxHeight, '');
  assert.ok(!host.textContent.includes('листай сетку вбок'));
  assert.equal(host.querySelector('.calv-grid-tools').nextElementSibling, host.querySelector('.calv-time-frame'));
});

test('desktop grid keeps its own scroll box, sticky band and week hint', t => {
  const host = setup(t);
  CalendarViews.render(host, { ...base, period: 'week' });
  assert.equal(host.querySelector('.calv-time-frame'), null);
  const scroll = host.querySelector('.calv-time-scroll');
  assert.ok(!scroll.classList.contains('calv-time-scroll--page'));
  assert.ok(scroll.querySelector('.calv-time-sticky .calv-day-heading'));
  assert.ok(scroll.querySelector('.calv-time-sticky .calv-untimed-band'));
  assert.ok(host.textContent.includes('листай сетку вбок'));
});

test('phone grid viewport never assigns an inline height', t => {
  const host = setup(t);
  CalendarViews.render(host, { ...base, period: 'day', pageScroll: true });
  const viewport = mountCalendarGridViewport(host, { pageScroll: true });
  viewport.fit(); viewport.dispose();
  assert.equal(host.querySelector('.calv-time-scroll').style.maxHeight, '');
});
