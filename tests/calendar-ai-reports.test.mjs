import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarAiReports } from '../src/hanni/js/calendar-ai-reports.js';
import { stableTaskBinding, TASK_RUN_KEY } from '../src/hanni/js/task-run-exchange.js';
import { REGISTRY_KEY } from '../src/hanni/js/work-registry.js';

const namespace = '00000000-0000-0000-0000-000000000001';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const task = (source_id, title) => ({ source_type:'note', source_id, title, tags:'', status_extra:'task', completed:false, archived:false, readonly:false });
const report = (runId, taskKey, status, sequence = 1, agent = 'codex') => ({ runId, sequence, taskKey, agent, model:null, provider:null, stage:null, status, skillIds:[], mcpCalls:null, inputTokens:null, outputTokens:null });

async function fixture() {
  const rows = [task('task-primary', '<img src=x onerror=alert(1)> Native title'), task('task-empty', 'No report task')];
  const binding = await stableTaskBinding(namespace, rows[0]);
  const orphan = await stableTaskBinding(namespace, task('missing-native', 'orphan'));
  let exchange = {
    version:1, sourceNamespace:namespace, order:3,
    bindings:{ [binding.taskKey]:binding, [orphan.taskKey]:orphan },
    runs:{
      'run-first-0001':{ runId:'run-first-0001', taskKey:binding.taskKey, agent:'codex', provider:null, model:null, report:report('run-first-0001',binding.taskKey,'running'), receivedOrder:1 },
      'run-last-0001':{ runId:'run-last-0001', taskKey:binding.taskKey, agent:'codex', provider:null, model:null, report:report('run-last-0001',binding.taskKey,'waiting'), receivedOrder:2 },
      'run-orphan-001':{ runId:'run-orphan-001', taskKey:orphan.taskKey, agent:'claude', provider:null, model:null, report:report('run-orphan-001',orphan.taskKey,'running',1,'claude'), receivedOrder:3 },
    },
  };
  let taskReads = 0, failExchangeRead = false;
  const invoke = async (command, args) => {
    if (command === 'get_calendar_tasks') { taskReads++; return structuredClone(rows); }
    if (command === 'get_ui_state') {
      if (args.key === TASK_RUN_KEY && failExchangeRead) throw Error('fixture read failure');
      return args.key === TASK_RUN_KEY ? structuredClone(exchange) : args.key === REGISTRY_KEY ? null : null;
    }
    throw Error(`Unexpected command: ${command}`);
  };
  return { rows, binding, setExchange(value) { exchange = value; }, setFailExchangeRead(value) { failExchangeRead = value; }, invoke, taskReads:() => taskReads };
}

test('shows only latest reports with exact native bindings and safely renders source titles', async () => {
  const data = await fixture(), dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const dispose = mountCalendarAiReports(host, { invoke:data.invoke, window:dom.window });
  await tick(); await tick();
  assert.equal(host.querySelectorAll('li').length, 1, 'orphan report and unreported native task stay hidden');
  assert.equal(host.querySelector('li').dataset.nativeTaskId, 'task-primary');
  assert.equal(host.querySelector('strong').textContent, '<img src=x onerror=alert(1)> Native title');
  assert.equal(host.querySelector('img'), null, 'untrusted source title is text, not markup');
  assert.match(host.textContent, /По последнему отчёту \(Codex\): исполнитель сообщил, что ожидает/);
  assert.match(host.textContent, /Время и актуальность неизвестны/);
  assert.doesNotMatch(host.textContent, /\b(model|stage|live|сейчас)\b/i);
  dispose(); dom.window.close();
});

test('refreshes from mvp-sync-updated and disposes its native listener', async () => {
  const data = await fixture(), dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  let receive, unlistened = 0;
  const dispose = mountCalendarAiReports(host, { invoke:data.invoke, window:dom.window, listen:async (name, callback) => { assert.equal(name,'mvp-sync-updated'); receive = callback; return () => unlistened++; } });
  await tick(); await tick();
  assert.match(host.textContent, /ожидает/);
  const originalRow = host.querySelector('li');
  receive({}); await tick(); await tick();
  assert.equal(host.querySelector('li'), originalRow, 'same observed state preserves the existing row node');
  const updated = await data.invoke('get_ui_state',{key:TASK_RUN_KEY});
  updated.order++;
  updated.runs['run-last-0001'].report = report('run-last-0001',data.binding.taskKey,'done',2);
  updated.runs['run-last-0001'].report.model = null;
  data.setExchange(updated);
  receive({});
  await tick(); await tick();
  assert.match(host.textContent, /сообщил о завершении/);
  const updatedRow = host.querySelector('li');
  assert.notEqual(updatedRow, originalRow, 'changed status updates the rendered row');
  const readsBeforeTaskEvent = data.taskReads();
  dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));
  await tick(); await tick();
  assert.ok(data.taskReads() > readsBeforeTaskEvent, 'native task changes refresh the report projection');
  assert.equal(host.querySelector('li'), updatedRow, 'unchanged native task refresh also preserves row identity');
  data.setFailExchangeRead(true); receive({}); await tick(); await tick();
  assert.equal(host.querySelector('li'), null, 'failed refresh hides the last successful projection');
  assert.match(host.textContent, /Прежние данные скрыты/);
  assert.match(host.textContent, /Актуальность неизвестна: чтение отчётов завершилось ошибкой/);
  data.setFailExchangeRead(false); receive({}); await tick(); await tick();
  assert.match(host.textContent, /сообщил о завершении/, 'successful retry restores the latest observed report');
  dispose(); await tick();
  assert.equal(unlistened,1);
  dom.window.close();
});

test('renders a clear empty state when no linked report exists', async () => {
  const data = await fixture(), dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const empty = { version:1, sourceNamespace:namespace, order:0, bindings:{}, runs:{} };
  data.setExchange(empty);
  const dispose = mountCalendarAiReports(host, { invoke:data.invoke, window:dom.window });
  await tick(); await tick();
  assert.match(host.textContent, /Нет связанных отчётов о работе ИИ/);
  dispose(); dom.window.close();
});
