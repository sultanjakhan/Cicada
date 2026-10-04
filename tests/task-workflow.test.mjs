import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWorkflowStore, readWorkflow, workflowTaskId, workflowKey } from '../src/hanni/js/task-workflow.js';
import { mountTaskWorkflow } from '../src/hanni/js/task-workflow-view.js';

const task = { source_type: 'note', source_id: 'synthetic-task' };
function backend() {
  const values = new Map(), calls = [];
  let rejectWrite = false;
  return { values, calls, failWrite: value => { rejectWrite = value; }, async invoke(command, args) {
    calls.push(command);
    if (command === 'get_ui_state') return values.get(args.key) ?? null;
    if (command === 'set_ui_state') {
      if (rejectWrite) throw new Error('disk unavailable');
      if ((values.get(args.key) ?? '') !== args.expectedValue) throw new Error('mvp_sync_stale_ui_state');
      values.set(args.key, args.value); return;
    }
    throw new Error(`Unexpected side effect: ${command}`);
  } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('manual steps and result survive a fresh store without starting execution', async () => {
  const db = backend();
  const first = createWorkflowStore(task, db.invoke, () => 'step-1');
  await first.addStep('Составить план');
  await first.setStep('step-1', 'running');
  assert.equal((await first.load()).steps[0].status, 'running');
  await first.setStep('step-1', 'done');
  await first.saveResult('План проверен');
  const second = createWorkflowStore(task, db.invoke);
  assert.deepEqual(await second.load(), { version: 1, taskId: workflowTaskId(task), steps: [{ id: 'step-1', title: 'Составить план', status: 'done' }], result: 'План проверен', run: null });
  assert.ok(db.calls.every(command => ['get_ui_state', 'set_ui_state'].includes(command)));
});

test('unreadable state and failed writes never fabricate success or replace saved data', async () => {
  const db = backend(), store = createWorkflowStore(task, db.invoke, () => 's');
  await store.addStep('Шаг');
  const prior = db.values.get(workflowKey(task));
  db.failWrite(true);
  await assert.rejects(store.setStep('s', 'done'));
  assert.equal(db.values.get(workflowKey(task)), prior);
  db.failWrite(false);
  db.values.set(workflowKey(task), '{invalid');
  await assert.rejects(store.saveResult('result'));
  assert.equal(db.values.get(workflowKey(task)), '{invalid');
  assert.throws(() => readWorkflow({ version: 2 }, task));
});

test('concurrent windows reject stale writes and preserve the winning step', async () => {
  const db = backend();
  const a = createWorkflowStore(task, db.invoke, () => 'a');
  const b = createWorkflowStore(task, db.invoke, () => 'b');
  const results = await Promise.allSettled([a.addStep('A'), b.addStep('B')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await a.load()).steps.length, 1);
});

test('runner events require matching IDs, increasing sequence and evidence for completion', async () => {
  const db = backend(), store = createWorkflowStore(task, db.invoke);
  const taskId = workflowTaskId(task);
  await store.attachRun({ taskId, runId: 'external-run-1', executor: 'codex' });
  assert.equal((await store.load()).run.status, 'planned');
  await assert.rejects(store.applyRunEvent({ taskId: 'wrong', runId: 'external-run-1', sequence: 1, status: 'running' }));
  await store.applyRunEvent({ taskId, runId: 'external-run-1', sequence: 1, status: 'running' });
  await assert.rejects(store.applyRunEvent({ taskId, runId: 'external-run-1', sequence: 1, status: 'blocked' }));
  await assert.rejects(store.applyRunEvent({ taskId, runId: 'external-run-1', sequence: 2, status: 'done' }));
  await store.applyRunEvent({ taskId, runId: 'external-run-1', sequence: 2, status: 'done', summary: 'Synthetic output verified' });
  await assert.rejects(store.applyRunEvent({ taskId, runId: 'external-run-1', sequence: 3, status: 'running' }));
  assert.equal((await store.load()).result, ''); // executor evidence does not complete the product task
});

test('task card flow adds a step, shows progress, saves result and restores after remount', async () => {
  const db = backend();
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  let dispose = mountTaskWorkflow(host, { record: task, invoke: db.invoke });
  await settle();
  assert.match(host.textContent, /Внешний исполнитель не связан/);
  host.querySelector('input').value = 'Синтетический шаг <script>';
  assert.throws(() => dispose.beforeClose(), /Сохрани/);
  host.querySelector('details button').click(); await settle();
  assert.equal(host.querySelector('li span').textContent, 'Синтетический шаг <script>');
  assert.equal(host.querySelector('script'), null);
  const select = host.querySelector('select'); select.value = 'running';
  select.dispatchEvent(new dom.window.Event('change')); await settle();
  assert.equal(host.querySelector('select').value, 'running');
  host.querySelector('select').value = 'done';
  host.querySelector('select').dispatchEvent(new dom.window.Event('change')); await settle();
  host.querySelector('textarea').value = 'Готовый результат';
  host.querySelectorAll('details button')[1].click(); await settle();
  dispose.beforeClose(); dispose(); host.replaceChildren();
  dispose = mountTaskWorkflow(host, { record: task, invoke: db.invoke }); await settle();
  assert.match(host.querySelector('summary').textContent, /1\/1/);
  assert.equal(host.querySelector('textarea').value, 'Готовый результат');
  dispose(); dom.window.close();
});

test('failed UI write retains draft and reports unconfirmed state', async () => {
  const db = backend(), dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  const dispose = mountTaskWorkflow(host, { record: task, invoke: db.invoke }); await settle();
  db.failWrite(true); host.querySelector('input').value = 'Не потерять';
  host.querySelector('details button').click(); await settle();
  assert.equal(host.querySelector('input').value, 'Не потерять');
  assert.match(host.querySelector('[role=status]').textContent, /не подтверждены/);
  assert.equal(host.querySelectorAll('li').length, 0);
  dispose(); dom.window.close();
});


test('failed step status save restores confirmed progress without losing Unicode drafts', async t => {
  const db = backend(), store = createWorkflowStore(task, db.invoke, () => 'synthetic-step');
  await store.addStep('Synthetic step');
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const dispose = mountTaskWorkflow(host, { record: task, invoke: db.invoke });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const stepDraft = 'Next \u0416\u04b1\u043c\u044b\u0441 \u{1f680} <script>' + '\u754c'.repeat(500);
  const resultDraft = 'Synthetic \u043d\u04d9\u0442\u0438\u0436\u0435 \u{1f9ea}\n' + '\u754c'.repeat(3000);
  host.querySelector('input').value = stepDraft;
  host.querySelector('textarea').value = resultDraft;
  db.failWrite(true);
  const select = host.querySelector('select'); select.value = 'done';
  select.dispatchEvent(new dom.window.Event('change')); await settle();
  assert.equal(host.querySelector('select').value, 'planned');
  assert.match(host.querySelector('summary').textContent, /0\/1/);
  assert.equal((await store.load()).steps[0].status, 'planned');
  assert.equal(host.querySelector('input').value, stepDraft);
  assert.equal(host.querySelector('textarea').value, resultDraft);
  assert.throws(() => dispose.beforeClose());
  db.failWrite(false);
  const retrySelect = host.querySelector('select'); retrySelect.value = 'done';
  retrySelect.dispatchEvent(new dom.window.Event('change')); await settle();
  assert.equal(host.querySelector('select').value, 'done');
  assert.match(host.querySelector('summary').textContent, /1\/1/);
  assert.equal((await store.load()).steps[0].status, 'done');
  assert.equal(host.querySelector('input').value, stepDraft);
  assert.equal(host.querySelector('textarea').value, resultDraft);
});
