import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { mountTaskWorkflow } from '../src/hanni/js/task-workflow-view.js';
import { createTaskRunExchange, readTaskRunStatus, stableTaskBinding, TASK_RUN_KEY, validateRunReport } from '../src/hanni/js/task-run-exchange.js';

const record = { source_type: 'note', source_id: 'synthetic-task' };
const namespace = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const values = new Map(), writes = [], calls = [];
  return { values, writes, calls, async invoke(command, args) {
    calls.push(command);
    if (command === 'get_calendar_task') { assert.equal(args.id, record.source_id); return { id: record.source_id }; }
    if (command === 'get_ui_state') return values.get(args.key) ?? null;
    if (command === 'set_ui_state') {
      if ((values.get(args.key) ?? '') !== args.expectedValue) throw new Error('mvp_sync_stale_ui_state');
      values.set(args.key, args.value); writes.push(args.value); return;
    }
    throw new Error(`Unexpected effect: ${command}`);
  } };
}
async function setup() {
  const db = fixture();
  let id = 1;
  const exchange = createTaskRunExchange(db.invoke, () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`);
  await exchange.prepareSource();
  const binding = await exchange.bindTask(record);
  const runId = await exchange.createAttempt(binding, { agent: 'codex' });
  return { db, exchange, binding, runId };
}
const reportOf = (binding, runId, more = {}) => ({ runId, sequence: 1, taskKey: binding.taskKey, agent: 'codex', provider: null, model: null, stage: null, status: 'running', skillIds: [], inputTokens: null, outputTokens: null, mcpCalls: null, ...more });

test('namespace initialization is explicit and survives a fresh reader; distinct sources differ', async () => {
  const db = fixture(), exchange = createTaskRunExchange(db.invoke, () => namespace);
  assert.equal(await readTaskRunStatus(record, db.invoke), null);
  assert.equal(db.writes.length, 0);
  assert.equal(await exchange.prepareSource(), namespace);
  const binding = await exchange.bindTask(record);
  const fresh = createTaskRunExchange(db.invoke, () => '00000000-0000-4000-8000-000000000099');
  assert.equal(await fresh.prepareSource(), namespace);
  assert.deepEqual(await fresh.bindTask(record), binding);
  const other = await stableTaskBinding('00000000-0000-4000-8000-000000000099', record);
  assert.notEqual(other.taskKey, binding.taskKey);
  assert.match(binding.taskKey, /^cicada-[a-f0-9]{16}-synthetic-task$/);
});

test('attempt IDs are separate; allocation never produces activity or a zero spend', async () => {
  const { exchange, db, binding, runId } = await setup();
  const second = await exchange.createAttempt(binding, { agent: 'other' });
  assert.notEqual(second, runId);
  assert.deepEqual(await readTaskRunStatus(record, db.invoke), { runId: second, report: null, cost: null });
  await assert.rejects(exchange.exportReport(second), /no_observed_report/);
  assert.ok(db.calls.every(command => ['get_ui_state', 'set_ui_state', 'get_calendar_task'].includes(command)));
});

test('export/import duplicates are idempotent across reopen and reordered JSON keys', async () => {
  const { exchange, db, binding, runId } = await setup();
  await exchange.recordReport(binding, reportOf(binding, runId));
  const exported = JSON.parse(await exchange.exportReport(runId));
  assert.equal(exported.report.inputTokens, null);
  assert.equal(exported.report.outputTokens, null);
  const before = db.writes.length;
  const reopened = createTaskRunExchange(db.invoke);
  exported.binding = Object.fromEntries(Object.entries(exported.binding).reverse());
  exported.report = Object.fromEntries(Object.entries(exported.report).reverse());
  await reopened.importReport(JSON.stringify(exported));
  assert.equal(db.writes.length, before);
  assert.equal((await readTaskRunStatus(record, db.invoke)).report.status, 'running');
  await assert.rejects(reopened.recordReport(binding, reportOf(binding, runId, { status: 'error' })), /sequence_conflict/);
  await reopened.recordReport(binding, reportOf(binding, runId, { sequence: 2, status: 'done' }));
  await assert.rejects(reopened.importReport(JSON.stringify(exported)), /sequence_conflict/);
});

test('identity switches, decreasing counters and wrong sources cannot overwrite a run', async () => {
  const { exchange, db, binding, runId } = await setup();
  const initial = reportOf(binding, runId, { inputTokens: 12, outputTokens: 3, mcpCalls: [{ server: 'fixture', tool: 'read', calls: 2 }] });
  await exchange.recordReport(binding, initial);
  const before = db.values.get(TASK_RUN_KEY);
  for (const more of [{ inputTokens: 0 }, { outputTokens: null }, { mcpCalls: null }, { agent: 'other' }, { model: 'changed' }, { taskKey: binding.taskKey + '-other' }]) {
    await assert.rejects(exchange.recordReport(binding, { ...initial, sequence: 2, ...more }));
    assert.equal(db.values.get(TASK_RUN_KEY), before);
  }
  const wrongSource = fixture();
  const other = createTaskRunExchange(wrongSource.invoke, () => '00000000-0000-4000-8000-000000000099');
  await other.prepareSource(); await other.bindTask(record);
  await assert.rejects(other.importReport(await exchange.exportReport(runId)), /source_or_binding_mismatch/);
});

test('unknown telemetry differs from observed zero; extra secrets, arguments and invalid states reject', () => {
  const report = { runId: 'fixture-run-0001', sequence: 1, taskKey: null, agent: 'other', status: 'waiting' };
  assert.equal(validateRunReport(report).inputTokens, null);
  assert.equal(validateRunReport({ ...report, inputTokens: 0 }).inputTokens, 0);
  for (const payload of [{ ...report, cost: 0 }, { ...report, prompt: 'forbidden' }, { ...report, status: 'blocked' }, { ...report, sequence: true }, { ...report, mcpCalls: [{ server: 's', tool: 't', calls: 1, args: {} }] }]) assert.throws(() => validateRunReport(payload));
});

test('malformed existing exchange data stays untouched and concurrent preparation converges', async () => {
  const db = fixture();
  const a = createTaskRunExchange(db.invoke, () => namespace);
  const b = createTaskRunExchange(db.invoke, () => '00000000-0000-4000-8000-000000000099');
  const names = await Promise.all([a.prepareSource(), b.prepareSource()]);
  assert.equal(names[0], names[1]);
  db.values.set(TASK_RUN_KEY, '{bad');
  await assert.rejects(a.prepareSource());
  assert.equal(db.values.get(TASK_RUN_KEY), '{bad');
});

test('real Agent City validator and persistent RunStore accept the exported strict projection', { skip: !process.env.AGENT_CITY_CONTRACT_ROOT }, async () => {
  const { exchange, binding, runId } = await setup();
  await exchange.recordReport(binding, reportOf(binding, runId));
  const envelope = JSON.parse(await exchange.exportReport(runId));
  const code = `import importlib.util,json,pathlib,sys,tempfile\np=pathlib.Path(sys.argv[1])/'run_store.py'\nspec=importlib.util.spec_from_file_location('fixture_run_store',p)\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\npayload=json.load(sys.stdin)\nwith tempfile.TemporaryDirectory() as directory:\n store=m.RunStore(directory); first=store.report(payload); duplicate=store.report(payload)\n assert first==duplicate\n restored=m.RunStore(directory).snapshot()\n assert len(restored)==1 and restored[0]['inputTokens'] is None\n print(json.dumps({'runs':len(restored),'status':restored[0]['status'],'inputTokens':restored[0]['inputTokens']}))`;
  const result = spawnSync('python', ['-B', '-c', code, process.env.AGENT_CITY_CONTRACT_ROOT], { input: JSON.stringify(envelope.report), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { runs: 1, status: 'running', inputTokens: null });
});

test('task card labels imported telemetry and unknown spend without completing the task', async () => {
  const { exchange, db, binding, runId } = await setup();
  await exchange.recordReport(binding, reportOf(binding, runId, { status: 'done' }));
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  const before = db.writes.length;
  const dispose = mountTaskWorkflow(host, { record, invoke: db.invoke });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(host.textContent, /Последний импортированный отчёт codex: Завершён/);
  assert.match(host.textContent, /Токены: неизвестно \/ неизвестно/);
  assert.match(host.textContent, /Стоимость не сообщена/);
  assert.equal(host.querySelector('textarea').value, '');
  assert.equal(db.writes.length, before);
  dispose(); dom.window.close();
});

test('open task card refreshes changed reports without overwriting an unsaved result or producing execution', async()=>{
  const {exchange,db,binding,runId}=await setup();
  await exchange.recordReport(binding,reportOf(binding,runId));
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  const dispose=mountTaskWorkflow(host,{record,invoke:db.invoke});
  await new Promise(resolve=>setTimeout(resolve,40));
  const result=host.querySelector('textarea');result.value='Unsaved synthetic draft';
  await exchange.recordReport(binding,reportOf(binding,runId,{sequence:2,status:'done',inputTokens:17}));
  const before=db.writes.length;
  [...host.querySelectorAll('button')].find(b=>b.textContent==='Обновить состояние').click();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.match(host.textContent,/Последний импортированный отчёт codex: Завершён/);
  assert.match(host.textContent,/Токены: 17 \/ неизвестно/);
  assert.equal(result.value,'Unsaved synthetic draft');
  assert.equal(db.writes.length,before);
  assert.throws(()=>dispose.beforeClose(),/Сохрани/);
  dispose();dom.window.close();
});
