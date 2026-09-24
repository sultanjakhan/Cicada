import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startCalendarExecution, pauseCalendarExecution, readActiveBlocks } from '../src/hanni/js/calendar-execution.js';

// Owner decision 2026-09-24: several tasks may run at once. Starting never pauses other work.
test('starting another task keeps the running one, needs no confirmation and the same task is a no-op', async t => {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  let blocks = [{ id:1, source_type:'note', source_id:'old', is_active:true }], calls = [];
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_active_blocks') return blocks.filter(block => block.is_active).reverse();
    if (name === 'start_task_block') { const id = blocks.length + 1; blocks.push({ id, source_type:args.sourceType, source_id:args.sourceId, is_active:true }); return id; }
    if (name === 'pause_task_block') { blocks.find(block => block.id === args.blockId).is_active = false; return; }
    throw Error(name);
  };
  const next = { source_type:'note', source_id:'next', title:'Следующая работа', date:'2026-09-20' };
  assert.equal(await startCalendarExecution(invoke, next, dom.window.document), 2);
  assert.equal(dom.window.document.querySelector('dialog'), null, 'no switch confirmation');
  assert.equal(calls.some(call => call.name === 'pause_task_block'), false);
  assert.deepEqual(calls.find(call => call.name === 'start_task_block').args, { sourceType:'note', sourceId:'next', completionDate:'2026-09-20' });
  assert.deepEqual(blocks.filter(block => block.is_active).map(block => block.source_id), ['old', 'next']);
  assert.equal(await startCalendarExecution(invoke, { source_type:'note', source_id:'old', title:'Предыдущая работа' }), 1, 'the running task is adopted');
  assert.equal(calls.filter(call => call.name === 'start_task_block').length, 1);
  assert.equal(await pauseCalendarExecution(invoke, next), 1);
  assert.deepEqual(blocks.filter(block => block.is_active).map(block => block.source_id), ['old'], 'pause touches only its own task');
  assert.deepEqual(calls.filter(call => call.name === 'pause_task_block').map(call => call.args.blockId), [2]);
});

test('active work falls back to the single-row command only when the list command is missing', async () => {
  const legacy = async name => { if (name === 'get_active_blocks') throw Error('Command get_active_blocks not found'); if (name === 'get_active_block') return { id:5, source_type:'event', source_id:'e' }; throw Error(name); };
  assert.deepEqual((await readActiveBlocks(legacy)).map(block => block.id), [5]);
  const idle = async name => { if (name === 'get_active_blocks') throw Error('Unexpected get_active_blocks'); return null; };
  assert.deepEqual(await readActiveBlocks(idle), []);
  const broken = async () => { throw Error('database is locked'); };
  await assert.rejects(readActiveBlocks(broken), /database is locked/);
});
