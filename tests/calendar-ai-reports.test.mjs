import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarAiReports } from '../src/hanni/js/calendar-ai-reports.js';
import { stableTaskBinding, TASK_RUN_KEY } from '../src/hanni/js/task-run-exchange.js';
import { REGISTRY_KEY } from '../src/hanni/js/work-registry.js';

const namespace = '00000000-0000-0000-0000-000000000001';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function waitForReports(host) {
  const deadline = Date.now() + 2000;
  while (host.querySelector('section')?.getAttribute('aria-busy') === 'true') {
    assert.ok(Date.now() < deadline, 'AI report read did not settle within two seconds');
    await tick();
  }
}
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
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command,structuredClone(args)]);
    if (command === 'get_calendar_tasks') { taskReads++; return structuredClone(rows); }
    if (command === 'get_ui_state') {
      if (args.key === TASK_RUN_KEY && failExchangeRead) throw Error('fixture read failure');
      return args.key === TASK_RUN_KEY ? structuredClone(exchange) : args.key === REGISTRY_KEY ? null : null;
    }
    throw Error(`Unexpected command: ${command}`);
  };
  return { rows, binding, calls, setExchange(value) { exchange = value; }, setFailExchangeRead(value) { failExchangeRead = value; }, invoke, taskReads:() => taskReads };
}

test('shows only latest reports with exact native bindings and safely renders source titles', async () => {
  const data = await fixture(), dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const dispose = mountCalendarAiReports(host, { invoke:data.invoke, window:dom.window });
  await waitForReports(host);
  assert.equal(host.querySelectorAll('li').length, 1, 'orphan report and unreported native task stay hidden');
  assert.equal(host.querySelector('.calendar-ai-reports').hidden, false);
  assert.equal(host.querySelector('li').dataset.nativeTaskId, 'task-primary');
  assert.equal(host.querySelector('strong').textContent, '<img src=x onerror=alert(1)> Native title');
  assert.equal(host.querySelector('img'), null, 'untrusted source title is text, not markup');
  assert.match(host.textContent, /По последнему отчёту \(Codex\): исполнитель сообщил, что ожидает/);
  assert.match(host.textContent, /Время и актуальность неизвестны/);
  assert.match(host.textContent, /Модель: не сообщена/);
  assert.equal(host.querySelector("li > p:last-child").textContent, "Модель: не сообщена · этап: не сообщён · актуальность: неизвестна");
  assert.match(host.textContent, /Подключение к исполнителю не подтверждено/);
  dispose(); dom.window.close();
});

test('refreshes from mvp-sync-updated and disposes its native listener', async () => {
  const data = await fixture(), dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  let receive, unlistened = 0;
  const dispose = mountCalendarAiReports(host, { invoke:data.invoke, window:dom.window, listen:async (name, callback) => { assert.equal(name,'mvp-sync-updated'); receive = callback; return () => unlistened++; } });
  await waitForReports(host);
  assert.match(host.textContent, /ожидает/);
  const originalRow = host.querySelector('li');
  receive({}); await waitForReports(host);
  assert.equal(host.querySelector('li'), originalRow, 'same observed state preserves the existing row node');
  const updated = await data.invoke('get_ui_state',{key:TASK_RUN_KEY});
  updated.order++;
  updated.runs['run-last-0001'].report = report('run-last-0001',data.binding.taskKey,'done',2);
  updated.runs['run-last-0001'].report.model = null;
  data.setExchange(updated);
  receive({});
  await waitForReports(host);
  assert.match(host.textContent, /сообщил о завершении/);
  const updatedRow = host.querySelector('li');
  assert.notEqual(updatedRow, originalRow, 'changed status updates the rendered row');
  const readsBeforeTaskEvent = data.taskReads();
  dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));
  await waitForReports(host);
  assert.ok(data.taskReads() > readsBeforeTaskEvent, 'native task changes refresh the report projection');
  assert.equal(host.querySelector('li'), updatedRow, 'unchanged native task refresh also preserves row identity');
  data.setFailExchangeRead(true); receive({}); await waitForReports(host);
  assert.equal(host.querySelector('li'), null, 'failed refresh hides the last successful projection');
  assert.match(host.textContent, /Прежние данные скрыты/);
  assert.match(host.textContent, /Актуальность неизвестна: чтение отчётов завершилось ошибкой/);
  data.setFailExchangeRead(false); receive({}); await waitForReports(host);
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
  await waitForReports(host);
  assert.match(host.textContent, /Нет связанных отчётов о работе ИИ/);
  assert.equal(host.querySelector('.calendar-ai-reports').hidden, false, 'empty AI state remains visible');
  assert.match(host.textContent, /Регистрация задачи не означает запуск/);
  dispose(); dom.window.close();
});

test('loading and failed source stay visible and never imply no AI work', async () => {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main'); let reject;
  const dispose = mountCalendarAiReports(host,{window:dom.window,invoke:()=>new Promise((_,r)=>reject=r)});
  assert.equal(host.querySelector('section').hidden,false);
  assert.equal(host.querySelector('section').getAttribute('aria-busy'),'true');
  assert.match(host.textContent,/Загружаем отчёты/);
  reject(Error('synthetic disconnected source')); await tick();
  assert.equal(host.querySelector('section').hidden,false);
  assert.match(host.textContent,/Не удалось прочитать отчёты/);
  assert.equal(host.querySelector('section').hasAttribute('aria-busy'),false);
  dispose(); dom.window.close();
});

test('changed report facts refresh without inventing current execution or accepting done', async () => {
  const data=await fixture(),dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');let receive;
  const dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window,listen:async(_,cb)=>{receive=cb;return()=>{};}});
  await waitForReports(host);
  const updated=await data.invoke('get_ui_state',{key:TASK_RUN_KEY});
  updated.runs['run-last-0001'].model='synthetic-model';
  updated.runs['run-last-0001'].report.model='synthetic-model';
  updated.runs['run-last-0001'].report.stage='Review';
  data.setExchange(updated);receive({});await waitForReports(host);
  assert.match(host.textContent,/synthetic-model.*Review/);
  updated.runs['run-last-0001'].report.status='done';data.setExchange(updated);receive({});await waitForReports(host);
  assert.match(host.textContent,/требует приёмки пользователем/);
  assert.equal(data.rows[0].completed,false);
  dispose();dom.window.close();
});


const englishUncertainty='Executor connection is unconfirmed. Based on the last report. Time and freshness are unknown; the current state is unconfirmed.';
async function awaitText(host,text) {
  const deadline=Date.now()+5000;
  while(!host.textContent.includes(text)&&Date.now()<deadline)await tick();
  assert.ok(host.textContent.includes(text),`Expected rendered text: ${text}`);
}
function englishHost(t) {
  const dom=new JSDOM('<html lang="en-US"><body><main></main></body></html>');
  t.after(()=>dom.window.close());
  return {dom,host:dom.window.document.querySelector('main')};
}
const assertReadOnly=data=>assert.ok(data.calls.every(([command])=>['get_calendar_tasks','get_ui_state'].includes(command)));

for (const [status,agent,name,phrase] of [
  ['running','codex','Codex','reported that they are working'],
  ['waiting','claude','Claude','reported that they are waiting'],
  ['done','agent-city','Agent City','reported completion'],
  ['error','other','another executor','reported an error'],
  ['cancelled','codex','Codex','reported stopping'],
]) test(`English ${status} report preserves authored facts and does not confirm current execution`,async t=>{
  const data=await fixture(),{dom,host}=englishHost(t);
  data.rows[0].title='Завершить день';
  const updated=await data.invoke('get_ui_state',{key:TASK_RUN_KEY});
  const latest=updated.runs['run-last-0001'];latest.agent=agent;latest.model='Начать день';latest.report=report('run-last-0001',data.binding.taskKey,status,2,agent);latest.report.model='Начать день';latest.report.stage='Готово';
  data.setExchange(updated);const before=structuredClone(data.rows);
  const dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window});t.after(dispose);
  const expected=`In the last report (${name}), the executor ${phrase}.`+(status==='done'?' Task completion requires user acceptance.':'');
  await awaitText(host,expected);
  assert.equal(host.querySelector('h3').textContent,'AI work');assert.equal(host.querySelector('section').getAttribute('aria-label'),'AI work');
  assert.equal(host.querySelector('section > p').textContent,englishUncertainty);
  assert.equal(host.querySelectorAll('li').length,1);assert.equal(host.querySelector('li').dataset.nativeTaskId,'task-primary');
  assert.equal(host.querySelector('strong').textContent,'Завершить день');
  assert.equal(host.querySelector('li > p').textContent,expected);
  assert.equal(host.querySelector('li > p:last-child').textContent,'Model: Начать день · stage: Готово · freshness: unknown');
  assert.equal(host.querySelector('time'),null);assert.equal(host.querySelector('button'),null);
  assert.deepEqual(data.rows,before);assert.equal(data.rows[0].completed,false);assertReadOnly(data);
});

test('English absent report facts stay unknown and unconfirmed',async t=>{
  const data=await fixture(),{dom,host}=englishHost(t);
  const dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window});t.after(dispose);
  await awaitText(host,'In the last report (Codex), the executor reported that they are waiting.');
  assert.equal(host.querySelector('section > p').textContent,englishUncertainty);
  assert.equal(host.querySelector('li > p:last-child').textContent,'Model: not reported · stage: not reported · freshness: unknown');
  assert.equal(host.querySelector('strong').textContent,'<img src=x onerror=alert(1)> Native title');assert.equal(host.querySelector('img'),null);assertReadOnly(data);
});

test('English empty state treats a registered attempt without reports as unstarted',async t=>{
  const data=await fixture(),{dom,host}=englishHost(t);
  const registered=await data.invoke('get_ui_state',{key:TASK_RUN_KEY});registered.runs['run-first-0001'].report=null;registered.runs['run-last-0001'].report=null;data.setExchange(registered);
  const before=structuredClone(data.rows),dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window});t.after(dispose);
  await awaitText(host,'No linked AI work reports. Task registration does not mean execution has started.');
  assert.equal(host.querySelector('section').hidden,false);assert.equal(host.querySelector('section > p').textContent,englishUncertainty);assert.equal(host.querySelector('li'),null);
  assert.doesNotMatch(host.textContent,/[А-Яа-яЁё]/);assert.deepEqual(data.rows,before);assertReadOnly(data);
});

test('English loading and disconnected errors stay visible without claiming empty work',async t=>{
  const {dom,host}=englishHost(t);let reject;
  const dispose=mountCalendarAiReports(host,{window:dom.window,invoke:()=>new Promise((_,r)=>reject=r)});t.after(dispose);
  assert.equal(host.querySelector('section').hidden,false);assert.equal(host.querySelector('section').getAttribute('aria-busy'),'true');
  assert.equal(host.querySelector('h3').textContent,'AI work');assert.equal(host.querySelector('section').getAttribute('aria-label'),'AI work');assert.equal(host.querySelector('section > p').textContent,englishUncertainty);assert.ok(host.textContent.includes('Loading reports…'));
  reject(Error('synthetic disconnected source'));await awaitText(host,'Could not read reports. Previous data is hidden.');
  assert.equal(host.querySelector('section > p').textContent,'Freshness is unknown: reading reports failed.');assert.equal(host.querySelector('section').hidden,false);assert.equal(host.querySelector('section').hasAttribute('aria-busy'),false);
  assert.equal(host.querySelector('li'),null);assert.ok(!host.textContent.includes('No linked AI work reports.'));assert.doesNotMatch(host.textContent,/[А-Яа-яЁё]/);
});

test('English report read failure hides stale rows and retry restores only observed facts',async t=>{
  const data=await fixture(),{dom,host}=englishHost(t);const dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window});t.after(dispose);
  await awaitText(host,'In the last report (Codex), the executor reported that they are waiting.');assert.equal(host.querySelectorAll('li').length,1);
  data.setFailExchangeRead(true);dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'Could not read reports. Previous data is hidden.');
  assert.equal(host.querySelector('li'),null);assert.equal(host.querySelector('section > p').textContent,'Freshness is unknown: reading reports failed.');
  data.setFailExchangeRead(false);dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'In the last report (Codex), the executor reported that they are waiting.');
  assert.equal(host.querySelector('section > p').textContent,englishUncertainty);assert.equal(host.querySelector('li > p:last-child').textContent,'Model: not reported · stage: not reported · freshness: unknown');assertReadOnly(data);
});

test('locale refresh translates unchanged report, empty and error states while retaining same-locale row identity',async t=>{
  const data=await fixture(),{dom,host}=englishHost(t);dom.window.document.documentElement.lang='ru';
  const dispose=mountCalendarAiReports(host,{invoke:data.invoke,window:dom.window});t.after(dispose);
  await awaitText(host,'По последнему отчёту (Codex): исполнитель сообщил, что ожидает.');const russianRow=host.querySelector('li');
  dom.window.document.documentElement.lang='en';dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'In the last report (Codex), the executor reported that they are waiting.');
  const englishRow=host.querySelector('li');assert.notEqual(englishRow,russianRow);assert.equal(host.querySelector('h3').textContent,'AI work');assert.equal(host.querySelector('section').getAttribute('aria-label'),'AI work');assert.equal(host.querySelector('section > p').textContent,englishUncertainty);
  dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await waitForReports(host);assert.equal(host.querySelector('li'),englishRow);
  data.setExchange({version:1,sourceNamespace:namespace,order:0,bindings:{},runs:{}});dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'No linked AI work reports. Task registration does not mean execution has started.');
  dom.window.document.documentElement.lang='ru';dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'Нет связанных отчётов о работе ИИ. Регистрация задачи не означает запуск.');assert.equal(host.querySelector('h3').textContent,'Работа ИИ');
  data.setFailExchangeRead(true);dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'Не удалось прочитать отчёты. Прежние данные скрыты.');
  dom.window.document.documentElement.lang='en';dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await awaitText(host,'Could not read reports. Previous data is hidden.');
  assert.equal(host.querySelector('section > p').textContent,'Freshness is unknown: reading reports failed.');assert.equal(host.querySelector('section').getAttribute('aria-label'),'AI work');assertReadOnly(data);
});
