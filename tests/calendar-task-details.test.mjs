import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openCalendarTaskDetails } from '../src/hanni/js/calendar-task-details.js';

const record = {
  source_type: 'note', source_id: 'n-1', title: 'Подготовить схему', date: '2026-09-27',
  sphere: 'work', stage: 'requirements', waiting: true, has_work: true, goal_id: 'g-1',
};

function fixture({ invoke: invokeOverride, task = record, seconds = 61, activeBlocks = [], ...overrides } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Открыть</button></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'get_calendar_task') return { ...task };
    if (command === 'get_ui_state') return null;
    if (command === 'get_goals') return [{ id: 'g-1', title: 'План', parent_goal_id: null }];
    if (command === 'get_calendar_task_goals') return [];
    if (command === 'get_calendar_task_seconds') return seconds;
    if (command === 'get_active_blocks') return activeBlocks;
    return undefined;
  };
  const transport = invokeOverride ? (command, args) => invokeOverride(command, args, invoke, calls) : invoke;
  const opener = window.document.querySelector('#opener');
  const dispose = openCalendarTaskDetails(task, { document: window.document, invoke: transport, returnFocus: () => opener.focus(), ...overrides });
  return { dom, window, calls, invoke, opener, dispose };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('task primary action explicitly starts a timer, not an agent', async t => {
  const actions = [];
  const f = fixture({ task: { ...record, has_work: false }, seconds: 0, executeAction: async (_task, action) => { actions.push(action); } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  assert.match(f.window.document.querySelector('.task-details-execute').getAttribute('aria-label'), /^Начать таймер:/);
  f.window.document.querySelector('.task-details-execute').click(); await settle();
  assert.deepEqual(actions, ['start']);
  assert.ok(f.calls.every(([command]) => !/dispatch|launch_agent|start_agent/.test(command)));
});

test('workflow close warning clears after explicit discard or acknowledged result save', async t => {
  const f = fixture(); t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const modal = f.window.document.querySelector('dialog');
  const warning = modal.querySelector('[data-dialog-error]');
  const panel = modal.querySelector('.task-workflow');
  panel.open = true;
  const next = panel.querySelector('input');
  next.value = 'Unsubmitted step';
  next.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  modal.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(modal.open, true);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /Сохрани шаг или результат/);
  [...panel.querySelectorAll('button')].find(b => b.textContent === 'Отменить ввод').click();
  assert.equal(next.value, '');
  assert.equal(warning.hidden, true);
  assert.equal(f.calls.filter(([command]) => command === 'set_ui_state').length, 0);
  const result = panel.querySelector('textarea');
  result.value = 'Explicit synthetic result';
  result.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  modal.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(warning.hidden, false);
  [...panel.querySelectorAll('button')].find(b => b.textContent === 'Сохранить результат').click(); await settle();
  assert.equal(warning.hidden, true);
  assert.equal(f.calls.filter(([command]) => command === 'set_ui_state').length, 1);
  assert.equal(result.value, 'Explicit synthetic result');
  modal.querySelector('[data-dialog-close]').click(); await settle();
  assert.equal(modal.isConnected, false);
});

test('opens as a read-only operational card, with goal/stage/time and no mutation', async t => {
  const f = fixture(); t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const card = f.window.document.querySelector('.calendar-task-details');
  assert.ok(card);
  assert.match(card.querySelector('h2').textContent, /Подготовить схему/);
  assert.match(card.textContent, /План/);
  assert.equal(card.querySelector('.task-details-goal select, .task-details-goal button'), null);
  assert.match(card.textContent, /Учтено 01:01/);
  assert.equal(card.querySelector('.task-details-history').open, false);
  assert.equal(card.querySelector('.task-details-stage').value, 'requirements');
  assert.equal(card.querySelector('.task-details-waiting').hidden, false);
  assert.equal(f.calls.some(([command]) => ['set_calendar_task_stage', 'start_task_block', 'pause_task_block'].includes(command)), false);
});

test('shows process route and shared controls only for a personal task without inventing a review result', async t => {
  const f = fixture({ task: { ...record, sphere: 'personal' }, invoke: async (command, args, baseInvoke, calls) => {
    if (command === 'shared_task_command') return { isError: true, status: 404, code: 'shared_task_not_found' };
    return baseInvoke(command, args);
  } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const card = f.window.document.querySelector('.calendar-task-details');
  assert.match(card.querySelector('.task-details-route-title').textContent, /Маршрут: Системный анализ/);
  assert.match(card.querySelector('.task-details-route-current').textContent, /Текущий этап: Требования/);
  assert.match(card.querySelector('.task-details-route-next').textContent, /Следующий этап: Анализ и модели/);
  assert.match(card.querySelector('.task-details-route-hint').textContent, /Настройки → Этапы задач/);
  assert.ok(card.querySelector('.task-details-shared-controls'));
  assert.equal(card.querySelector('.task-result-review'), null);
  assert.equal(f.calls.some(([command]) => /start|pause|dispatch|launch_agent/.test(command)), false);
});

test('stage change is immediate, preserves waiting and exposes an error before allowing retry', async t => {
  let attempts = 0;
  const f = fixture({ invoke: async (command, args, baseInvoke, calls) => {
    if (command === 'set_calendar_task_stage' && ++attempts === 1) throw new Error('Сервер недоступен');
    if (command === 'set_calendar_task_stage') { calls.push([command, args]); return { ...record, stage: args.stage, waiting: true }; }
    return baseInvoke(command, args);
  } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const select = f.window.document.querySelector('.task-details-stage');
  select.value = 'analysis'; select.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(f.window.document.querySelector('.calendar-editor-error').textContent, /Сервер недоступен/);
  assert.equal(select.value, 'requirements');
  assert.equal(select.disabled, false);
  select.value = 'analysis'; select.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await settle();
  const update = f.calls.find(([command]) => command === 'set_calendar_task_stage');
  assert.deepEqual(update[1], { id: 'n-1', stage: 'analysis', waiting: null });
  assert.equal(select.value, 'analysis');
  assert.equal(f.window.document.querySelector('.task-details-waiting').hidden, false);
  assert.equal(f.window.document.querySelector('.calendar-editor-error').hidden, true);
});

test('start action is single-flight and does not implicitly pause another task', async t => {
  let release;
  const action = new Promise(resolve => { release = resolve; });
  const executed = [];
  const f = fixture({ executeAction: async (_task, name) => { executed.push(name); await action; } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const button = f.window.document.querySelector('.task-details-execute');
  button.click(); button.click();
  await settle();
  assert.deepEqual(executed, ['start']);
  release(); await settle();
  assert.deepEqual(executed, ['start']);
  assert.equal(f.calls.some(([command]) => command === 'pause_task_block'), false);
});

test('edit handoff is single-flight while the details card closes', async t => {
  const edited = [];
  const f = fixture({ onEdit: (task) => edited.push(task) });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const edit = f.window.document.querySelector('.task-details-edit');
  edit.click(); edit.click();
  await settle();
  assert.equal(edited.length, 1);
});

test('repeated edit before deferred native close hands off exactly once', async t => {
  const edited = [];
  const f = fixture({ onEdit: (task) => edited.push(task) });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const modal = f.window.document.querySelector('dialog');
  let deliverClose;
  modal.close = function () { this.open = false; deliverClose = () => this.dispatchEvent(new f.window.Event('close')); };
  const edit = modal.querySelector('.task-details-edit');
  edit.click(); edit.click();
  await settle();
  assert.equal(edited.length, 0);
  deliverClose();
  await settle();
  assert.equal(edited.length, 1);
});

test('edit handoff can be retried after a dirty workflow refuses close', async t => {
  const edited = [];
  const f = fixture({ onEdit: (task) => edited.push(task) });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const modal = f.window.document.querySelector('dialog');
  const panel = modal.querySelector('.task-workflow');
  panel.open = true;
  const step = panel.querySelector('input');
  step.value = 'Unsubmitted step';
  step.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  modal.querySelector('.task-details-edit').click();
  await settle();
  assert.equal(edited.length, 0);
  assert.equal(modal.isConnected, true);
  assert.match(modal.querySelector('[data-dialog-error]').textContent, /Сохрани шаг или результат/);
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Отменить ввод').click();
  modal.querySelector('.task-details-edit').click();
  await settle();
  assert.equal(edited.length, 1);
});

test('disposing while edit awaits native close cancels the handoff', async t => {
  const edited = [];
  const f = fixture({ onEdit: (task) => edited.push(task) });
  t.after(() => { f.dom.window.close(); });
  await settle();
  const modal = f.window.document.querySelector('dialog');
  let deliverClose;
  modal.close = function () { this.open = false; deliverClose = () => this.dispatchEvent(new f.window.Event('close')); };
  modal.querySelector('.task-details-edit').click();
  await settle();
  f.dispose();
  deliverClose();
  await settle();
  assert.equal(edited.length, 0);
});

test('disposing while the initial read is pending makes its late result inert', async t => {
  let release;
  const pendingRead = new Promise(resolve => { release = resolve; });
  const f = fixture({ invoke: (command, args, baseInvoke) => command === 'get_calendar_task' ? pendingRead : baseInvoke(command, args) });
  t.after(() => f.dom.window.close());
  f.dispose();
  release({ ...record, title: 'Поздний ответ' });
  await settle();
  assert.equal(f.window.document.querySelector('.calendar-task-details'), null);
});

test('active-block read failure stays visible and read-only until Retry succeeds', async t => {
  let fail = true;
  const f = fixture({ invoke: async (command, args, baseInvoke) => {
    if (command === 'get_active_blocks' && fail) throw new Error('Временная ошибка чтения');
    return baseInvoke(command, args);
  } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const dialog = f.window.document.querySelector('.calendar-task-details');
  const error = dialog.querySelector('.calendar-editor-error');
  assert.match(error.textContent, /Временная ошибка чтения/);
  assert.equal(f.window.document.activeElement, error, 'load failure does not steal focus from its message');
  assert.equal(dialog.querySelector('.task-details-edit').disabled, true);
  assert.equal(dialog.querySelector('.task-details-execute').disabled, true);
  assert.equal(dialog.querySelector('.task-details-stage').disabled, true);
  fail = false;
  dialog.querySelector('[data-dialog-retry]').click();
  await settle();
  assert.equal(error.hidden, true);
  assert.equal(dialog.querySelector('.task-details-edit').disabled, false);
  assert.equal(dialog.querySelector('.task-details-stage').disabled, false);
});

test('the fetched active-block list replaces a stale row is_active flag', async t => {
  const f = fixture({ task: { ...record, waiting:false, is_active: true, has_work: false, actual_seconds: 0 }, seconds: 0 });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const dialog = f.window.document.querySelector('.calendar-task-details');
  assert.match(dialog.querySelector('.calendar-editor-header p').textContent, /Не запускалась/);
  assert.match(dialog.querySelector('.task-details-execute').textContent, /Начать/);
});

test('instant task completes without starting or pausing a timer', async t => {
  const instant = { ...record, task_kind: 'instant', stage: '', waiting: false, has_work: false, actual_seconds: 0 };
  const actions = [];
  const f = fixture({ task: instant, seconds: 0, executeAction: async (_task, action) => actions.push(action) });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  const dialog = f.window.document.querySelector('.calendar-task-details');
  assert.equal(dialog.querySelector('.task-details-stage-row').hidden, true);
  dialog.querySelector('.task-details-execute').click();
  await settle();
  assert.deepEqual(actions, ['finish']);
  assert.match(dialog.querySelector('.calendar-editor-header p').textContent, /Завершена/);
  assert.equal(dialog.querySelector('.task-details-execute').hidden, true);
  assert.equal(f.calls.some(([command]) => command === 'start_task_block' || command === 'pause_task_block'), false);
});

test('does not render a false zero when both seconds APIs fail and no row fallback exists', async t => {
  const f = fixture({ task: { ...record, actual_seconds: undefined, actual_minutes: undefined }, seconds: 0, invoke: async (command, args, baseInvoke) => {
    if (command === 'get_calendar_task_seconds' || command === 'get_calendar_task_minutes') throw new Error(`${command} unavailable`);
    return baseInvoke(command, args);
  } });
  t.after(() => { f.dispose(); f.dom.window.close(); });
  await settle();
  assert.equal(f.window.document.querySelector('.task-details-total').textContent, 'Время недоступно');
});

test('long Unicode task context remains complete and keyboard-focusable without mutations', async t => {
  const title='Жұмыс 🚀 '+ '界'.repeat(500),f=fixture({task:{...record,title}});
  t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog'),context=modal.querySelector('.calendar-editor-header > div');
  assert.equal(modal.querySelector('h2').textContent,title);assert.equal(context.tabIndex,0);assert.equal(context.getAttribute('aria-labelledby'),modal.getAttribute('aria-labelledby'));
  const before=f.calls.length;context.focus();assert.equal(f.window.document.activeElement,context);assert.equal(f.calls.length,before);
});

test('card shows confirmed workflow progress independently of inactive timer', async t=>{
 const f=fixture({task:{...record,waiting:false,has_work:false},seconds:0,invoke:async(command,args,fallback)=>command==='get_ui_state'&&args.key.startsWith('calendar_task_workflow_v1:')?JSON.stringify({version:1,taskId:'cicada:note:n-1',steps:[{id:'step',title:'Manual work',status:'running'}],result:'',run:null}):fallback(command,args)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();assert.match(f.window.document.querySelector('.calendar-editor-hint')?.textContent||f.window.document.body.textContent,/В работе/);assert.match(f.window.document.body.textContent,/Таймер не запущен/);
});

test('active timer and blocked workflow remain separate visible states',async t=>{
 const f=fixture({task:{...record,waiting:false},activeBlocks:[{source_type:'note',source_id:'n-1',date:'2026-10-03',start_time:'00:00:00'}],invoke:async(command,args,fallback)=>command==='get_ui_state'&&args.key.startsWith('calendar_task_workflow_v1:')?JSON.stringify({version:1,taskId:'cicada:note:n-1',steps:[{id:'step',title:'Wait for person',status:'blocked'}],result:'',run:null}):fallback(command,args)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();const hint=f.window.document.querySelector('.calendar-editor-header p').textContent;assert.match(hint,/Ждёт ответа/);assert.match(hint,/Таймер идёт/);
});
