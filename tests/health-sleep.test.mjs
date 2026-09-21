import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSleepSettings, sleepStatusText, startSleepImport } from '../src/hanni/js/health-sleep.js';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('sleep status separates permission, absent source data and unverified import', () => {
  assert.match(sleepStatusText({ status: 'permission_required' }), /Разреши/);
  assert.match(sleepStatusText({ status: 'ready', records: 0 }), /ещё не подтверждён/);
  assert.match(sleepStatusText({ status: 'ready', records: 0, lastSuccess: '2026-01-01T00:00:00Z' }), /не найдено/);
  assert.match(sleepStatusText({ status: 'ready', records: 2, lastError: 'import_failed' }), /не завершён/);
  assert.match(sleepStatusText({ status: 'unsupported' }), /телефоне Android/);
});

test('connect is explicit, missing background support is visible, errors cannot expose native data', async t => {
  const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section'), calls = [], pending = [];
  let fail = false, imported = 0;
  dom.window.addEventListener('hanni:sleep-imported', () => imported++);
  const dispose = mountSleepSettings(host, { setPending: value => pending.push(value), invoke: async command => {
    calls.push(command);
    if (fail) throw Error('private-source-record');
    return command === 'health_sleep_status' ? { status: 'permission_required' }
      : { status: 'ready', backgroundAvailable: false, backgroundGranted: false, records: 2, changed: 2, lastSuccess: '2026-01-01T00:00:00Z' };
  } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); assert.deepEqual(calls, ['health_sleep_status']);
  host.querySelector('[data-sleep-connect]').click(); await tick();
  assert.deepEqual(calls, ['health_sleep_status', 'health_sleep_connect']);
  assert.match(host.textContent, /не поддерживает чтение в фоне/); assert.equal(imported, 1);
  assert.deepEqual(pending, [true, false]);
  fail = true; host.querySelector('[data-sleep-import]').click(); await tick();
  assert.doesNotMatch(host.textContent, /private-source-record/);
  assert.equal(host.querySelector('[data-sleep-retry]').hidden, false);
});

test('foreground import coalesces lifecycle triggers and sends only committed changes', async t => {
  const dom = new JSDOM('', { pretendToBeVisual: true });
  let release, calls = 0, sync = 0, refresh = 0;
  const dispose = startSleepImport({ window: dom.window, invoke: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    requestSync: () => sync++, requestRefresh: () => refresh++ });
  t.after(() => { dispose(); dom.window.close(); });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(calls, 1); release({ status: 'ready', changed: 2 }); await tick();
  assert.equal(sync, 1); assert.equal(refresh, 1);
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  release({ status: 'ready', changed: 0 }); await tick(); assert.equal(sync, 1);
  dispose(); dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); assert.equal(calls, 2);
});

test('overnight projection counts stage sleep at wake date, and missing stages stay unknown', t => {
  const dom = new JSDOM('<main></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const host = document.querySelector('main');
  const record = { id: 'fictional-sleep', source_type: 'event', source_id: 'fictional-sleep', title: 'Сон',
    date: '2026-01-01', time: '23:00', durationMinutes: 480, sleep_minutes: 420, health_kind: 'sleep', readonly: true };
  const draw = (date, value = record) => CalendarViews.render(host, { period: 'day', mode: 'list', date, records: [value] });
  draw('2026-01-01'); assert.match(host.textContent, /Учтён в дне пробуждения/); assert.doesNotMatch(host.textContent, /За ночь/);
  draw('2026-01-02'); assert.match(host.textContent, /За ночь: 7 ч 0 мин/); assert.doesNotMatch(host.textContent, /8 ч/);
  draw('2026-01-02', { ...record, sleep_minutes: null }); assert.match(host.textContent, /по стадиям не передано/);
  assert.doesNotMatch(host.textContent, /За ночь: 0/);
});
