import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_FILTER_VIEWS_KEY, VIEW_LIMITS, DEFAULT_TASK_FILTERS, ALL_TASK_FILTERS,
  taskFilters, parseTaskFilterViews, newTaskFilterViewId,
  readTaskFilterViews, saveTaskFilterViews,
} from '../src/hanni/js/task-filter-views.js';

const view = (id = 'view-a', changes = {}) => ({
  id, title: 'Мои задачи', filters: { ...DEFAULT_TASK_FILTERS, ...changes },
});
function native(initial = null) {
  let raw = initial;
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    assert.equal(args.key, TASK_FILTER_VIEWS_KEY);
    if (command === 'get_ui_state') return raw;
    if (command !== 'set_ui_state') throw Error('Unexpected native command: ' + command);
    if (args.expectedValue !== (raw ?? '')) throw Error('mvp_sync_stale_ui_state');
    raw = args.value;
    return null;
  };
  return { invoke, calls, raw: () => raw, replace: value => { raw = value; } };
}
const hasCode = code => error => error?.code === code;

test('fresh state and canonical filter snapshots exclude page, rows and task identity', () => {
  assert.deepEqual(parseTaskFilterViews(null), { version: 1, views: [] });
  assert.deepEqual(parseTaskFilterViews(''), { version: 1, views: [] });
  assert.equal(ALL_TASK_FILTERS.filter, 'all');
  assert.equal(DEFAULT_TASK_FILTERS.filter, 'active');
  assert.deepEqual(taskFilters({
    filter: 'today', search: 'plan', goal: 'goal-7', sphere: 'personal',
    personal: 'health', groupBy: 'goal', source: 'local', project: 'P', tag: 'focus',
    page: 9, taskId: 'private-task', rows: [{ title: 'record' }],
  }), {
    filter: 'today', search: 'plan', goal: 'goal-7', sphere: 'personal',
    personal: 'health', groupBy: 'goal', source: 'local', project: 'P', tag: 'focus',
  });
  assert.deepEqual(taskFilters({}), DEFAULT_TASK_FILTERS);
  assert.throws(() => taskFilters({ filter: 'future' }), hasCode('validation'));
});

test('save, reload, edit and delete use only the generic UI-state CAS key', async () => {
  const store = native();
  const first = await readTaskFilterViews(store.invoke);
  assert.equal(first.raw, null);
  const id = newTaskFilterViewId(first.state.views);
  assert.match(id, /^view-[A-Za-z0-9_-]+$/);
  const created = await saveTaskFilterViews(store.invoke,
    [{ id, title: '  На сегодня  ', filters: taskFilters({ filter: 'today', search: 'plan', page: 4 }) }],
    first.raw);
  assert.equal(created.state.views[0].title, 'На сегодня');
  assert.deepEqual((await readTaskFilterViews(store.invoke)).state, created.state);
  const edited = await saveTaskFilterViews(store.invoke, {
    ...created.state, views: [{ ...created.state.views[0], title: 'Срочное',
      filters: taskFilters({ filter: 'all', groupBy: 'goal' }) }],
  }, created.raw);
  assert.equal((await readTaskFilterViews(store.invoke)).state.views[0].filters.filter, 'all');
  const deleted = await saveTaskFilterViews(store.invoke, { ...edited.state, views: [] }, edited.raw);
  assert.deepEqual((await readTaskFilterViews(store.invoke)).state.views, []);
  assert.equal(store.raw(), deleted.raw);
  assert.deepEqual(store.calls.map(call => call.command),
    ['get_ui_state', 'set_ui_state', 'get_ui_state', 'set_ui_state', 'get_ui_state', 'set_ui_state', 'get_ui_state']);
  assert.equal(store.calls[1].args.expectedValue, '');
  assert.equal(store.calls[3].args.expectedValue, created.raw);
  assert.equal(store.calls[5].args.expectedValue, edited.raw);
});

test('unknown same-version metadata survives both array and state saves', async () => {
  const initial = JSON.stringify({
    version: 1, extension: { source: 'future client' },
    views: [{ ...view(), extension: { color: 'blue' } }],
  });
  const store = native(initial);
  const first = await readTaskFilterViews(store.invoke);
  const arraySave = await saveTaskFilterViews(store.invoke,
    [{ id: 'view-a', title: 'Renamed', filters: { ...DEFAULT_TASK_FILTERS, search: 'x' } }],
    first.raw);
  assert.deepEqual(arraySave.state.extension, { source: 'future client' });
  assert.deepEqual(arraySave.state.views[0].extension, { color: 'blue' });
  const stateSave = await saveTaskFilterViews(store.invoke,
    { version: 1, views: [{ id: 'view-a', title: 'Again', filters: { ...DEFAULT_TASK_FILTERS } }] },
    arraySave.raw);
  assert.deepEqual(stateSave.state.extension, { source: 'future client' });
  assert.deepEqual(stateSave.state.views[0].extension, { color: 'blue' });
  assert.deepEqual(parseTaskFilterViews(store.raw()), stateSave.state);
});

test('stale concurrent writes fail with conflict and require a fresh read', async () => {
  const store = native();
  const a = await readTaskFilterViews(store.invoke);
  const b = await readTaskFilterViews(store.invoke);
  const savedA = await saveTaskFilterViews(store.invoke, [view('view-a')], a.raw);
  await assert.rejects(
    saveTaskFilterViews(store.invoke, [view('view-b')], b.raw),
    hasCode('conflict'),
  );
  assert.equal(store.raw(), savedA.raw);
  const fresh = await readTaskFilterViews(store.invoke);
  const savedB = await saveTaskFilterViews(store.invoke,
    [...fresh.state.views, view('view-b')], fresh.raw);
  assert.deepEqual(savedB.state.views.map(item => item.id), ['view-a', 'view-b']);
});

test('malformed, future and broadened stored data cannot be read or overwritten', async () => {
  const invalidRaw = [
    '{',
    JSON.stringify({ version: 2, views: [] }),
    JSON.stringify({ version: 1, views: [view('same'), view('same')] }),
    JSON.stringify({ version: 1, views: [{ ...view(), filters: { ...DEFAULT_TASK_FILTERS, taskId: 'x' } }] }),
    JSON.stringify({ version: 1, views: [view('x', { filter: 'future' })] }),
    JSON.stringify({ version: 1, views: [{ ...view(), filters: { filter: 'active' } }] }),
    JSON.stringify({ version: 1, views: [view('x', { sphere: 'future' })] }),
    JSON.stringify({ version: 1, views: [view('x', { groupBy: 'future' })] }),
  ];
  for (const raw of invalidRaw) {
    assert.throws(() => parseTaskFilterViews(raw), hasCode('validation'));
    const store = native(raw);
    await assert.rejects(readTaskFilterViews(store.invoke), hasCode('validation'));
    await assert.rejects(saveTaskFilterViews(store.invoke, [], raw), hasCode('validation'));
    assert.equal(store.raw(), raw);
    assert.equal(store.calls.some(call => call.command === 'set_ui_state'), false);
  }
});

test('limits and invalid edits fail before native write', async () => {
  const store = native();
  const cases = [
    [view('x', { search: 's'.repeat(VIEW_LIMITS.search + 1) })],
    [view('x', { goal: 'g'.repeat(VIEW_LIMITS.ref + 1) })],
    [{ ...view(), title: 'x'.repeat(VIEW_LIMITS.title + 1) }],
    [{ ...view(), id: 'bad id' }],
    [view('duplicate'), view('duplicate')],
    Array.from({ length: VIEW_LIMITS.views + 1 }, (_, index) => view('v-' + index)),
  ];
  for (const views of cases) await assert.rejects(
    saveTaskFilterViews(store.invoke, views, null), hasCode('validation'));
  assert.throws(() => parseTaskFilterViews(' '.repeat(VIEW_LIMITS.raw + 1)), hasCode('validation'));
  assert.equal(store.calls.length, 0);
});

test('native read and write failures are distinct; exact read-back acknowledges a lost reply', async () => {
  await assert.rejects(readTaskFilterViews(async () => { throw Error('offline'); }), hasCode('read'));
  let raw = null;
  const failedWrite = async command => command === 'get_ui_state' ? raw : Promise.reject(Error('offline'));
  await assert.rejects(saveTaskFilterViews(failedWrite, [view()], null), hasCode('write'));
  const committedButUnacknowledged = async (command, args) => {
    if (command === 'get_ui_state') return raw;
    raw = args.value;
    throw Error('lost reply');
  };
  const saved = await saveTaskFilterViews(committedButUnacknowledged, [view()], null);
  assert.equal(raw, saved.raw);
  assert.equal(parseTaskFilterViews(raw).views.length, 1);
  const changedAfterWrite = async (command, args) => {
    if (command === 'get_ui_state') return raw;
    raw = JSON.stringify({ version: 1, views: [] });
    throw Error('lost reply');
  };
  await assert.rejects(
    saveTaskFilterViews(changedAfterWrite, [view('view-b')], saved.raw),
    hasCode('write'),
  );
});


test('permanent tab IDs cannot be loaded or saved as user views', async () => {
  for (const id of ['all', 'active']) {
    const raw = JSON.stringify({ version: 1, views: [view(id)] });
    const stored = native(raw);
    assert.throws(() => parseTaskFilterViews(raw), hasCode('validation'));
    await assert.rejects(readTaskFilterViews(stored.invoke), hasCode('validation'));
    await assert.rejects(saveTaskFilterViews(stored.invoke, [], raw), hasCode('validation'));
    assert.equal(stored.raw(), raw);
    assert.equal(stored.calls.some(call => call.command === 'set_ui_state'), false);

    const fresh = native();
    await assert.rejects(saveTaskFilterViews(fresh.invoke, [view(id)], null), hasCode('validation'));
    assert.equal(fresh.calls.length, 0);
  }
});
