import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadPersonalActivityView, mountPersonalActivitySettings, mountPersonalActivityToday, savePersonalActivityView } from '../src/hanni/js/personal-activity.js';
import { clipAndMergeIntervals, localDayBounds, normalizeDayResult, parseExecutableBasenames, summarizePersonalActivity, taskBlockIntervals, unionDurationMs, walkingIntervals } from '../src/hanni/js/personal-activity-model.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const bounds = { startMs: 0, endMs: 24 * 60 * 60 * 1000 };

test('activity model unions overlapping intervals and clips cross-boundary records', () => {
  const merged = clipAndMergeIntervals([
    { startMs: 0, endMs: 10_000 },
    { startMs: 9_000, endMs: 20_000 },
    { startMs: 30_000, endMs: 40_000 },
  ], bounds);
  assert.deepEqual(merged, [{ startMs: 0, endMs: 20_000 }, { startMs: 30_000, endMs: 40_000 }]);
  assert.equal(unionDurationMs([{ startMs: 0, endMs: 10_000 }, { startMs: 9_000, endMs: 20_000 }], bounds), 20_000);
  assert.equal(unionDurationMs([{ startMs: 1, endMs: 1 }], bounds), 0);
  assert.equal(unionDurationMs(null, bounds), null);
});

test('walking input accepts actual walking sessions only and keeps missing intervals unknown', () => {
  const records = walkingIntervals([
    { health_kind: 'steps', health_start_ms: 0, health_end_ms: 1000 },
    { health_kind: 'walking', health_start_ms: 1_000, health_end_ms: 11_000 },
    { health_kind: 'walking', date: '2026-10-22', time: '00:00', duration_minutes: 1 },
    { health_kind: 'walking', duration_minutes: 20 },
  ], bounds);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { startMs: 1_000, endMs: 11_000 });
  const summary = summarizePersonalActivity({ bounds, walkingRecords: [], walkingAvailable: true, dayResult: { observationState: 'partial', intervals: [] } });
  assert.equal(summary.walking.state, 'unknown');
  assert.equal(summary.walking.durationMs, null);
  assert.equal(summary.games.durationMs, null);
});

test('task blocks use exact UTC created_at and active end now, without date/time fallback', () => {
  const task = { source_type: 'note', source_id: 'selected' };
  const rows = [
    { source_type: 'note', source_id: 'selected', created_at: '1970-01-01T00:00:00.000Z', duration_seconds: 60, is_active: false },
    { source_type: 'note', source_id: 'selected', created_at: '1970-01-01T00:01:00.000Z', duration_seconds: 0, is_active: true },
  ];
  assert.deepEqual(taskBlockIntervals(rows, task, bounds, 180_000), [
    { startMs: 0, endMs: 60_000 }, { startMs: 60_000, endMs: 180_000 },
  ]);
  assert.equal(taskBlockIntervals([{ ...rows[0], date: '2026-10-22', start_time: '09:00' }], task, bounds, 180_000)[0].startMs, 0);
  assert.equal(taskBlockIntervals([{ ...rows[0], created_at: true }], task, bounds, 180_000), null);
  assert.equal(taskBlockIntervals([{ ...rows[0], source_id: 'other' }], task, bounds, 180_000), null);
});

test('day envelope rejects boolean timestamps and mismatched bounds', () => {
  const day = localDayBounds('2026-10-22');
  const value = { date: day.date, startMs: day.startMs, endMs: day.endMs, observationState: 'partial', intervals: [], observedMs: 1700000000000 };
  assert.ok(normalizeDayResult(value, day));
  assert.equal(normalizeDayResult({ ...value, startMs: true }, day), null);
  assert.equal(normalizeDayResult({ ...value, date: '2026-10-23' }, day), null);
  assert.equal(normalizeDayResult({ ...value, intervals: [{ startMs: true, endMs: day.endMs }] }, day), null);
});

test('executable draft accepts explicit basenames and rejects paths', () => {
  assert.deepEqual(parseExecutableBasenames('Game.EXE,  game.exe\neditor.exe'), { ok: true, value: ['editor.exe', 'game.exe'] });
  assert.equal(parseExecutableBasenames('/Applications/Game.exe').ok, false);
  assert.equal(parseExecutableBasenames('game').ok, false);
  assert.equal(parseExecutableBasenames(`${'a'.repeat(29)}.exe`).ok, true);
  assert.equal(parseExecutableBasenames(`${'я'.repeat(99)}.exe`).ok, false);
  assert.equal(parseExecutableBasenames('.hidden.exe').ok, false);
  assert.equal(parseExecutableBasenames('foo..exe').ok, false);
  assert.equal(parseExecutableBasenames('CON.exe').ok, false);
  assert.equal(parseExecutableBasenames('game:stream.exe').ok, false);
  assert.equal(parseExecutableBasenames('game*.exe').ok, false);
  assert.equal(parseExecutableBasenames('game\u0001.exe').ok, false);
  assert.equal(parseExecutableBasenames(Array.from({ length: 33 }, (_, index) => `game${index}.exe`).join(',')).ok, false);
});

test('settings preserves a draft across a native revision conflict', async t => {
  const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section');
  let status = { supported: true, enabled: false, revision: 4, selectedExecutables: [], running: false };
  const calls = [];
  const dispose = mountPersonalActivitySettings(host, { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === 'personal_activity_status') return status;
    if (command === 'get_ui_state') return null;
    throw Error('conflict');
  } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick();
  const input = host.querySelector('[data-personal-activity-executables]');
  const enabled = host.querySelector('[data-personal-activity-enabled]');
  input.value = 'MyGame.exe'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  enabled.checked = true; enabled.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  host.querySelector('[data-personal-activity-save]').click(); await tick();
  assert.equal(input.value, 'MyGame.exe');
  assert.match(host.querySelector('[data-personal-activity-error]').textContent, /настройки изменились|сохранить/i);
  const configure = calls.find(([command]) => command === 'personal_activity_configure');
  assert.deepEqual(configure[1], { request: { expectedRevision: 4, enabled: true, selectedExecutables: ['mygame.exe'] } });
});

test('daily view conflict reloads its CAS base on Retry and keeps the draft', async t => {
  const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section');
  const firstRaw = '{"version":1,"enabled":true}';
  const latestRaw = '{"version":1,"enabled":false}';
  let viewReads = 0, writes = 0;
  const calls = [];
  const dispose = mountPersonalActivitySettings(host, { invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === 'personal_activity_status') return { supported: true, enabled: false, revision: 4, selectedExecutables: [], running: false };
    if (command === 'get_ui_state') return viewReads++ === 0 ? firstRaw : latestRaw;
    if (command === 'set_ui_state') {
      writes++;
      if (writes === 1) throw Error('ui_state_conflict');
      assert.equal(args.expectedValue, latestRaw);
      return args.value;
    }
    throw Error('unexpected command');
  } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  const checkbox = host.querySelector('[data-personal-activity-view-enabled]');
  checkbox.checked = false; checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  host.querySelector('[data-personal-activity-view-save]').click(); await tick();
  assert.match(host.querySelector('[data-personal-activity-view-error]').textContent, /Повторить проверку|сохрани/i);
  host.querySelector('[data-personal-activity-retry]').click(); await tick(); await tick();
  assert.equal(checkbox.checked, false);
  assert.equal(host.querySelector('[data-personal-activity-view-save]').disabled, false);
  host.querySelector('[data-personal-activity-view-save]').click(); await tick();
  assert.equal(writes, 2);
  assert.equal(calls.filter(([command]) => command === 'get_ui_state').length, 2);
});

test('malformed daily view stays unreadable and cannot be overwritten as absent', async t => {
  const dom = new JSDOM('<section></section>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('section');
  let writes = 0;
  const dispose = mountPersonalActivitySettings(host, { invoke: async command => {
    if (command === 'personal_activity_status') return { supported: true, enabled: false, revision: 1, selectedExecutables: [], running: false };
    if (command === 'get_ui_state') return 'corrupted';
    if (command === 'set_ui_state') writes++;
    return undefined;
  } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  const checkbox = host.querySelector('[data-personal-activity-view-enabled]');
  checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(host.querySelector('[data-personal-activity-view-save]').disabled, true);
  host.querySelector('[data-personal-activity-view-save]').click(); await tick();
  assert.equal(writes, 0);
});

test('daily view persistence is independent and uses expected raw CAS value', async () => {
  const calls = [];
  const invoke = async (command, args) => { calls.push([command, args]); return command === 'get_ui_state' ? '{"version":1,"enabled":true}' : undefined; };
  const loaded = await loadPersonalActivityView(invoke);
  assert.equal(loaded.enabled, true);
  const saved = await savePersonalActivityView(invoke, { enabled: false, expectedValue: loaded.raw });
  assert.equal(saved.enabled, false);
  assert.deepEqual(calls[1], ['set_ui_state', { key: 'personal_activity_view_v1', value: '{"version":1,"enabled":false}', expectedValue: loaded.raw }]);
});

test('first daily view save uses empty CAS sentinel and rejects a stale absent write', async () => {
  let stored = null;
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'get_ui_state') return stored;
    if (command !== 'set_ui_state') throw Error('unexpected command');
    if (args.expectedValue !== (stored ?? '')) throw Error('ui_state_conflict');
    stored = args.value;
    return stored;
  };
  const absent = await loadPersonalActivityView(invoke);
  assert.equal(absent.raw, '');
  await savePersonalActivityView(invoke, { enabled: true, expectedValue: absent.raw });
  assert.equal(calls[1][1].expectedValue, '');
  await assert.rejects(
    () => savePersonalActivityView(invoke, { enabled: false, expectedValue: absent.raw }),
    /ui_state_conflict/,
  );
});

test('Today readout shows unioned game and walking time, selected task, and partial state', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main');
  const calls = [];
  const dayBounds = localDayBounds('2026-10-22');
  const dispose = mountPersonalActivityToday(host, {
    date: '2026-10-22',
    enabled: true,
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === 'personal_activity_day') return {
        date: '2026-10-22', startMs: dayBounds.startMs, endMs: dayBounds.endMs, observedMs: dayBounds.startMs + 20_000,
        observationState: 'partial', intervals: [
          { id: 'a', deviceId: 'pc', startMs: dayBounds.startMs + 1000, endMs: dayBounds.startMs + 11_000 },
          { id: 'b', deviceId: 'pc', startMs: dayBounds.startMs + 10_000, endMs: dayBounds.startMs + 20_000 },
        ], error: null,
      };
      if (command === 'personal_activity_walks') return [
        { health_kind: 'walking', health_start_ms: dayBounds.startMs + 30_000, health_end_ms: dayBounds.startMs + 90_000 },
        { health_kind: 'walking', date: '2026-10-22', duration_minutes: 30 },
        { health_kind: 'steps', health_start_ms: dayBounds.startMs, health_end_ms: dayBounds.startMs + 999_999 },
      ];
      throw Error('unexpected');
    },
    getSelectedTask: () => ({ source_type: 'note', source_id: 'task-1', title: '<Selected>' }),
    getTaskIntervals: () => [{ startMs: dayBounds.startMs + 120_000, endMs: dayBounds.startMs + 180_000 }],
  });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  assert.equal(calls[0][0], 'personal_activity_day');
  assert.match(host.querySelector('[data-personal-activity-games]').textContent, /Игры на этом ПК: меньше минуты/);
  assert.match(host.querySelector('[data-personal-activity-walking]').textContent, /Прогулки: 1 мин/);
  assert.match(host.querySelector('[data-personal-activity-walking]').textContent, /без точного времени; показана только известная часть/);
  assert.match(host.querySelector('[data-personal-activity-work]').textContent, /Выбранная задача: 1 мин/);
  assert.match(host.querySelector('[data-personal-activity-availability]').textContent, /частичные/);
  assert.match(host.querySelector('[data-personal-activity-task]').textContent, /<Selected>/);
  assert.equal(host.querySelector('[data-personal-activity-task]').innerHTML.includes('&lt;Selected&gt;'), true);
  const dayArgs = calls.find(([command]) => command === 'personal_activity_day')[1].request;
  assert.equal(dayArgs.date, '2026-10-22');
  assert.equal(dayArgs.endMs - dayArgs.startMs, dayBounds.endMs - dayBounds.startMs);
});

test('Today labels game freshness and omits a walking partial note when every walk is precise', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main');
  const day = localDayBounds('2026-10-22');
  const dispose = mountPersonalActivityToday(host, {
    date: day.date, enabled: true,
    invoke: async command => command === 'personal_activity_walks'
      ? [{ health_kind: 'walking', health_start_ms: day.startMs, health_end_ms: day.startMs + 60_000 }]
      : { date: day.date, startMs: day.startMs, endMs: day.endMs, observationState: 'partial', observedMs: day.startMs, intervals: [], error: null },
  });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  assert.match(host.querySelector('[data-personal-activity-walking]').textContent, /Прогулки: 1 мин/);
  assert.doesNotMatch(host.querySelector('[data-personal-activity-walking]').textContent, /без точного времени/);
  assert.match(host.querySelector('[data-personal-activity-freshness]').textContent, /Последняя проверка учёта игр на этом ПК/);
});

test('Today discloses when no walking session has precise time', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main');
  const day = localDayBounds('2026-10-22');
  const dispose = mountPersonalActivityToday(host, {
    date: day.date, enabled: true,
    invoke: async command => command === 'personal_activity_walks'
      ? [{ health_kind: 'walking', date: day.date, duration_minutes: 20 }]
      : { date: day.date, startMs: day.startMs, endMs: day.endMs, observationState: 'partial', observedMs: null, intervals: [], error: null },
  });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  assert.match(host.querySelector('[data-personal-activity-walking]').textContent, /без точного времени; длительность неизвестна/);
});

test('Today can be hidden without reading native records', async t => {
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  let calls = 0;
  const dispose = mountPersonalActivityToday(host, { enabled: false, invoke: async () => { calls++; } });
  t.after(() => { dispose(); dom.window.close(); });
  await tick();
  assert.equal(host.hidden, true);
  assert.equal(calls, 0);
  dispose.setEnabled(true); await tick();
  assert.equal(calls, 2);
});

test('Today clears prior readout values when the optional view is turned off', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main');
  const day = localDayBounds('2026-10-22');
  const dispose = mountPersonalActivityToday(host, {
    date: '2026-10-22', enabled: true,
    getSelectedTask: () => ({ source_type: 'note', source_id: 'task-1', title: 'Task' }),
    getTaskIntervals: () => [{ startMs: day.startMs, endMs: day.startMs + 60_000 }],
    invoke: async command => command === 'personal_activity_walks' ? [] : ({
      date: day.date, startMs: day.startMs, endMs: day.endMs, observationState: 'partial', observedMs: day.startMs,
      intervals: [{ startMs: day.startMs, endMs: day.startMs + 60_000 }], error: null,
    }),
  });
  t.after(() => { dispose(); dom.window.close(); });
  await tick(); await tick();
  assert.match(host.querySelector('[data-personal-activity-games]').textContent, /Игры на этом ПК/);
  assert.match(host.querySelector('[data-personal-activity-task]').textContent, /Task/);
  dispose.setEnabled(false);
  for (const key of ['games', 'walking', 'work', 'freshness', 'availability', 'task']) {
    assert.equal(host.querySelector(`[data-personal-activity-${key}]`).textContent, '');
  }
});

test('Today refresh coalesces selected-task changes and never leaves busy after a thrown context read', async t => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main');
  const day = localDayBounds('2026-10-22');
  let selected = 'old', release;
  let dayCalls = 0;
  const valid = title => ({ date: '2026-10-22', startMs: day.startMs, endMs: day.endMs, observationState: 'partial', observedMs: day.startMs, intervals: [], error: null, title });
  const dispose = mountPersonalActivityToday(host, {
    date: '2026-10-22', enabled: true,
    getSelectedTask: () => ({ source_type: 'note', source_id: selected, title: selected }),
    invoke: async command => {
      if (command === 'personal_activity_walks') return [];
      dayCalls++;
      if (dayCalls === 1) return new Promise(resolve => { release = resolve; });
      return valid('new');
    },
    getTaskIntervals: () => [],
  });
  t.after(() => { dispose(); dom.window.close(); });
  await tick();
  selected = 'new'; dispose.refresh();
  release(valid('old')); await tick(); await tick(); await tick();
  assert.match(host.querySelector('[data-personal-activity-task]').textContent, /new/);
  let throws = true;
  dispose.setEnabled(false);
  dispose.setEnabled(true);
  dispose.setEnabled(false);
  // A context callback failure must settle the run and permit a later retry.
  const retryDispose = mountPersonalActivityToday(dom.window.document.createElement('main'), {
    date: '2026-10-22', enabled: true,
    getSelectedTask: () => { if (throws) throw Error('context'); return null; },
    invoke: async command => command === 'personal_activity_walks' ? [] : valid('ok'),
  });
  retryDispose.setEnabled(false); throws = false; retryDispose.setEnabled(true); await tick(); await tick();
  assert.equal(retryDispose.refresh instanceof Function, true);
  retryDispose();
});
