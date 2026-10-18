import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeResultReviewAdapter } from '../src/hanni/js/native-result-review-adapter.js';

const request = { task_id: 'synthetic-task', expected_revision: 3, result_version: 2, operation_id: 'synthetic-review', action: 'rework', comment: 'Keep this exact feedback' };
function receipt() {
  return { kind: 'acknowledged', operation_id: request.operation_id, projection: {
    taskId: request.task_id, taskRevision: 4, resultVersion: 2, content: 'Synthetic result', reviewState: 'awaiting_dispatch',
    history: [{ operationId: request.operation_id, action: request.action, resultVersion: 2, taskRevision: 4, comment: request.comment, eventId: 'synthetic-event' }],
  } };
}
function fixture(value, fresh = value.projection) {
  const calls = [];
  const adapter = createNativeResultReviewAdapter(request.task_id, async command => {
    calls.push(command);
    if (command === 'enqueue_task_result_review') return { kind: 'queued', operation_id: request.operation_id };
    if (command === 'commit_task_result_review') return structuredClone(value);
    if (command === 'read_task_result_review') return { projection: structuredClone(fresh), pending: [] };
    throw Error('Unexpected command');
  });
  return { adapter, calls };
}

test('native receipt must prove the exact requested revision, decision and feedback', async () => {
  const cases = [
    p => { p.resultVersion = 3; },
    p => { p.taskRevision = 5; },
    p => { p.reviewState = 'accepted'; },
    p => { p.history = []; },
    p => { p.history[0].operationId = 'other-review'; },
    p => { p.history[0].action = 'accept'; },
    p => { p.history[0].resultVersion = 3; },
    p => { p.history[0].taskRevision = 5; },
    p => { p.history[0].comment = 'Different feedback'; },
  ];
  for (const corrupt of cases) {
    const value = receipt(); corrupt(value.projection);
    const f = fixture(value);
    await assert.rejects(f.adapter.submit(structuredClone(request)), /Unconfirmed native decision/);
    assert.equal(f.calls.includes('read_task_result_review'), false);
  }
});

test('verified original retry receipt can render a newer result without deciding it', async () => {
  const value = receipt();
  const fresh = { ...structuredClone(value.projection), taskRevision: 6, resultVersion: 3, content: 'New synthetic result', reviewState: 'awaiting_review' };
  const f = fixture(value, fresh);
  assert.deepEqual((await f.adapter.submit(structuredClone(request))).projection, fresh);
  assert.equal(f.calls.filter(c => c === 'commit_task_result_review').length, 1);
});

test('unverified receipt keeps the card draft and immutable retry instead of confirming acceptance', async () => {
  const { JSDOM } = await import('jsdom');
  const { mountTaskResultReview } = await import('../src/hanni/js/task-result-review.js');
  const dom = new JSDOM('<main></main>');
  const drafts = new Map();
  const value = receipt(); value.projection.resultVersion = 3;
  const initial = { ...receipt().projection, taskRevision: 3, reviewState: 'awaiting_review', history: [] };
  const { adapter } = fixture(value, initial);
  const stop = mountTaskResultReview(dom.window.document.querySelector('main'), { taskId: request.task_id, adapter, drafts, operationId: () => request.operation_id });
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    await settle();
    const input = dom.window.document.querySelector('textarea');
    input.value = request.comment; input.dispatchEvent(new dom.window.Event('input'));
    const buttons = [...dom.window.document.querySelectorAll('button')];
    buttons.find(b => b.textContent === 'Доработать').click();
    await settle();
    assert.match(dom.window.document.querySelector('[role=status]').textContent, /Исход отправки неизвестен/);
    assert.equal(input.value, request.comment);
    assert.deepEqual(drafts.get(request.task_id).pending, request);
    assert.equal(buttons.find(b => b.textContent === 'Принять').disabled, true);
  } finally { stop(); dom.window.close(); }
});

test('native accept receipt uses the existing audit protocol without inventing reviewer identity', async () => {
  const value = receipt(); value.projection.reviewState = 'accepted';
  value.projection.history[0].action = 'accept'; value.projection.history[0].comment = null;
  const accepted = { ...request, action: 'accept' }; delete accepted.comment;
  const f = fixture(value);
  assert.equal((await f.adapter.submit(accepted)).kind, 'acknowledged');
});

test('mutation of the caller request during enqueue cannot switch the operation being committed', async () => {
  const mutable = structuredClone(request), calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = createNativeResultReviewAdapter(request.task_id, async (command, args) => {
    calls.push({ command, args });
    if (command === 'enqueue_task_result_review') { await gate; return { kind: 'queued', operation_id: request.operation_id }; }
    if (command === 'commit_task_result_review') return receipt();
    return { projection: receipt().projection, pending: [] };
  });
  const pending = adapter.submit(mutable);
  mutable.operation_id = 'another-operation'; mutable.action = 'accept';
  release();
  assert.equal((await pending).kind, 'acknowledged');
  assert.equal(calls[1].args.operationId, request.operation_id);
  assert.deepEqual(calls[0].args.input, request);
});
