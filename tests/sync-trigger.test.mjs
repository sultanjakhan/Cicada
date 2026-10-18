import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncTrigger, isSyncWrite } from '../src/hanni/js/sync-trigger.js';

test('write bursts coalesce and a save during sync queues another nonblocking wake', async () => {
  const timers = new Map(), calls = []; let next = 0, release;
  const trigger = createSyncTrigger({ invoke: async command => { calls.push(command); await new Promise(resolve => { release = resolve; }); },
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  const fire = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  trigger.request(); trigger.request(); trigger.request(); assert.equal(timers.size, 1);
  fire(); assert.deepEqual(calls, ['mvp_sync_now']);
  trigger.request(); fire(); assert.equal(calls.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); fire(); assert.equal(calls.length, 2);
  trigger.dispose(); release();
});

test('a write during an in-flight exchange drains immediately without an extra debounce poll', async () => {
  const timers = new Map(), calls = []; let next = 0, release;
  const trigger = createSyncTrigger({ invoke: async command => { calls.push(command); await new Promise(resolve => { release = resolve; }); },
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  trigger.request(); const first = [...timers.values()][0]; timers.clear(); first();
  trigger.request(); trigger.request();
  assert.equal(timers.size, 0, 'in-flight writes only mark one pending wake');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, 'pending local changes do not wait for a second debounce');
  trigger.dispose(); release();
});

test('an offline exchange retains one pending write wake and disposal cancels it', async () => {
  const timers = new Map(); let next = 0, calls = 0, fail;
  const trigger = createSyncTrigger({ invoke: async () => { calls++; if(calls === 1) await new Promise((_, reject) => { fail = reject; }); },
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id) });
  trigger.request(); const first = [...timers.values()][0]; timers.clear(); first();
  trigger.request(); fail(Error('synthetic disconnect'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'the pending write is retried once, not dropped or retried forever');
  assert.equal(timers.size, 0);
  trigger.request(); trigger.dispose();
  assert.equal(timers.size, 0);
});

test('pending writes still flush when a view observer throws; disposed work never wakes again', async () => {
  const timers = new Map(); let next=0, calls=0, release;
  const trigger=createSyncTrigger({invoke:async()=>{calls++;await new Promise(resolve=>{release=resolve;});},
    afterSync:()=>{throw Error('synthetic observer failure');},
    setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  trigger.request(); const first=[...timers.values()][0];timers.clear();first();
  trigger.request();release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);trigger.request();trigger.dispose();release();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(timers.size,0);
});

test('every calendar write prefix wakes sync but sync and read commands never recurse', () => {
  for (const command of ['start_calendar_day', 'set_ui_state', 'start_task_block', 'pause_task_block', 'finish_task_block', 'complete_calendar_task', 'delete_goal', 'mvp_sync_conflict_resolve']) assert.equal(isSyncWrite(command), true, command);
  for (const command of ['get_ui_state', 'mvp_sync_now', 'mvp_sync_configure', 'mvp_sync_set_enabled', 'create_backup']) assert.equal(isSyncWrite(command), false, command);
});
