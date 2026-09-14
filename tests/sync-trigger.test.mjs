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

test('every calendar write prefix wakes sync but sync and read commands never recurse', () => {
  for (const command of ['start_calendar_day', 'set_ui_state', 'start_task_block', 'pause_task_block', 'finish_task_block', 'complete_calendar_task', 'delete_goal']) assert.equal(isSyncWrite(command), true, command);
  for (const command of ['get_ui_state', 'mvp_sync_now', 'mvp_sync_configure', 'mvp_sync_set_enabled', 'create_backup']) assert.equal(isSyncWrite(command), false, command);
});
