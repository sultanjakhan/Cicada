import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountHealthActivitySettings, walkingStatusText, stepsStatusText, startHealthActivityImport } from '../src/hanni/js/health-activity.js';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('walking and steps status remain independent, including empty source', () => {
  assert.match(walkingStatusText({ status: 'permission_required', stepsPermissionGranted: true }), /прогулки/);
  assert.match(stepsStatusText({ status: 'ready', stepsPermissionGranted: true, walkingPermissionGranted: false, stepsRecords: 0, lastSuccess: '2026-01-01T00:00:00Z' }), /не найдено/);
  assert.match(walkingStatusText({ status: 'ready', walkingPermissionGranted: true, walkingRecords: 0, lastSuccess: '2026-01-01T00:00:00Z' }), /walking/);
});

test('partial permission keeps separate sections and activity import events', async t => {
  const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section');
  const calls = [], pending = [];
  const dispose = mountHealthActivitySettings(host, { setPending: value => pending.push(value), invoke: async command => {
    calls.push(command);
    if (command === 'health_activity_status') return { status: 'ready', walkingPermissionGranted: true, stepsPermissionGranted: false, walkingRecords: 1, stepsRecords: 0 };
    if (command === 'health_activity_connect') return { status: 'permission_requested', walkingPermissionGranted: true, stepsPermissionGranted: false };
    return { status: 'ready', walkingPermissionGranted: true, stepsPermissionGranted: true, walkingRecords: 1, stepsRecords: 2, changed: 1 };
  } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick();
  assert.deepEqual(calls, ['health_activity_status']);
  assert.match(host.querySelector('[data-activity-walking-status]').textContent, /Импортировано прогулок/);
  assert.match(host.querySelector('[data-activity-steps-status]').textContent, /Разреши/);
  host.querySelector('[data-activity-connect]').click(); await tick();
  assert.deepEqual(calls, ['health_activity_status', 'health_activity_connect']);
  assert.match(host.textContent, /ещё не подтверждено/);
  assert.deepEqual(pending, [true, false]);
});

test('repeated lifecycle events coalesce activity import', async t => {
  const dom = new JSDOM('', { pretendToBeVisual: true });
  let release, calls = 0, sync = 0, refresh = 0;
  const dispose = startHealthActivityImport({ window: dom.window, invoke: () => { calls++; return new Promise(resolve => { release = resolve; }); }, requestSync: () => sync++, requestRefresh: () => refresh++ });
  t.after(() => { dispose(); dom.window.close(); });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  dom.window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(calls, 1); release({ status: 'ready', changed: 1 }); await tick();
  assert.equal(sync, 1); assert.equal(refresh, 1);
});

test('daily steps stay visible in day header while untimed list is collapsed', t => {
  const dom = new JSDOM('<main></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  CalendarViews.render(document.querySelector('main'), { period: 'day', mode: 'grid', date: '2026-09-22', records: [{
    id: 'hc-steps:all:2026-09-22', source_type: 'event', source_id: 'hc-steps:all:2026-09-22', title: 'Шаги', date: '2026-09-22', planned_time: null, duration_minutes: 0, health_kind: 'steps', steps_count: 4321, readonly: true,
  }] });
  assert.match(document.querySelector('.calv-day-heading').textContent, /Шаги: 4321/);
  assert.equal(document.querySelector('[data-untimed-more]')?.getAttribute('aria-expanded'), 'false');
});
