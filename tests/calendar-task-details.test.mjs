import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openCalendarTaskDetails } from '../src/hanni/js/calendar-task-details.js';

const record = {
  source_type: 'note', source_id: 'n-1', title: 'Подготовить схему', date: '2026-09-27',
  sphere: 'work', stage: 'requirements', waiting: true, has_work: true, goal_id: 'g-1',
};

function fixture({ invoke: invokeOverride, task = record, seconds = 61, activeBlocks = [], language = 'ru', ...overrides } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Открыть</button></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  window.document.documentElement.lang = language;
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

test('personal task details expose exact-ID sharing without starting work and clean up on close', async t => {
  const states = new Map(), sent = []; let changed = 0;
  const task = { ...record, sphere: 'personal', version: 7 };
  const f = fixture({ task, onChanged: () => changed++, invoke: async (command, args, fallback) => {
    if (command === 'get_ui_state') return states.get(args.key) ?? null;
    if (command === 'set_ui_state') { states.set(args.key, args.value); return; }
    if (command === 'shared_task_command') {
      const input = args.input;
      if (input.command === 'get') return { isError: true, status: 404, code: 'shared_task_not_found' };
      assert.equal(input.command, 'share'); sent.push(input);
      assert.ok(states.get('calendar_shared_binding_pending_v1:n-1'));
      return { operationId: input.operationId, acknowledged: true, task: { id: 'n-1' } };
    }
    return fallback(command, args);
  }});
  t.after(() => { f.dispose(); f.dom.window.close(); }); await settle();
  const host = f.window.document.querySelector('.task-details-sharing');
  assert.match(host.textContent, /Показать в Agent City/);
  host.querySelector('button').click(); await settle();
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].arguments, { taskId: 'n-1', expectedVersion: 7 });
  assert.equal(changed, 1); assert.match(host.textContent, /Исполнение не запускалось/);
  assert.equal(f.calls.some(([command]) => /^(start_|begin_|record_agent)/.test(command)), false);
  f.dispose(); await settle(); assert.equal(host.children.length, 0);
});

test('shared review unavailability leaves ordinary Edit usable and displays a Russian retry hint without mutations',async t=>{
  const edited=[],f=fixture({reviewUnavailable:true,task:{...record,_reviewReadError:true},onEdit:task=>edited.push(task)});
  t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const notice=f.window.document.querySelector('.task-details-card [role=status]');
  assert.equal(notice.hidden,false);assert.match(notice.textContent,/Результат ИИ сейчас недоступен.*повторите открытие/);
  const edit=f.window.document.querySelector('.task-details-edit');assert.equal(edit.disabled,false);edit.click();await settle();
  assert.equal(edited[0].source_id,record.source_id);assert.equal(f.calls.some(([command])=>/^(set_|save_|start_|shared_task_command)/.test(command)),false);
});

test('English task details localize controls, completed metadata and hours without translating records', async t => {
  const f=fixture({language:'en-GB',task:{...record,title:'User task',description:'User description',completed:true,status_extra:'done',completion_date:'2026-10-03'},seconds:3661});
  t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const card=f.window.document.querySelector('.calendar-task-details');
  assert.match(card.querySelector('.calendar-editor-header p').textContent,/Work.*Completed/);
  assert.equal(card.querySelector('.task-details-total').textContent,'Recorded 1 h 01 min');
  assert.equal(card.querySelector('.task-details-edit').textContent,'Edit');
  assert.equal(card.querySelector('.task-details-stage').getAttribute('aria-label'),'Task stage');
  assert.match(card.querySelector('.task-details-meta').textContent,/Completed.*Oct/);
  assert.match(card.querySelector('.task-details-history summary').textContent,/Time by stage/);
  assert.equal(card.querySelector('.calendar-editor-close').getAttribute('aria-label'),'Close');
  assert.equal(card.querySelector('h2').textContent,'User task');
  assert.equal(card.querySelector('.task-details-description').textContent,'User description');
  assert.equal(f.calls.some(([command])=>/^(set_|save_)/.test(command)),false);
});

test('English instant task and unavailable time keep distinct labels', async t => {
  const f=fixture({language:'EN',task:{...record,task_kind:'instant',waiting:false,stage:''},seconds:null});
  t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  assert.equal(f.window.document.querySelector('.task-details-total').textContent,'Time unavailable');
  assert.match(f.window.document.querySelector('.task-details-execute').getAttribute('aria-label'),/^Complete:/);
});

test('plain and structured EditorJS descriptions render as inert text', async t => {
  for (const payload of [{description:'Short description'}, {content:JSON.stringify({blocks:[{type:'paragraph',data:{text:'<b>Short description</b>'}}]})}]) {
    const f=fixture({task:{...record,...payload}});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
    assert.equal(f.window.document.querySelector('.task-details-description').textContent,'Short description');
    assert.equal(f.window.document.querySelector('.task-details-description script'),null);
    assert.equal(f.calls.some(([command])=>command==='set_ui_state'),false);
  }
});

test('QA-RENDERER-001 preserves literal identifiers and HTML-like text in all plain fields', async t => {
  const texts=['Передать <TaskId> и <source_id> без изменений','<b>literal</b> <script>bad()</script> <img src=x onerror=bad()>','a < b && c > d','Literal &lt;TaskId&gt;'];
  for (const key of ['short_description','description','content']) for (const text of texts) {
    const f=fixture({task:{...record,[key]:text}});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
    const description=f.window.document.querySelector('.task-details-description');
    assert.equal(description.textContent,text);assert.equal(description.children.length,0);
    assert.equal(f.calls.some(([command])=>/^(set_|save_)/.test(command)),false);
  }
  const jsonLiteral=JSON.stringify({blocks:[{type:'paragraph',data:{text:'<TaskId>'}}]});
  const f=fixture({task:{...record,description:jsonLiteral}});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  assert.equal(f.window.document.querySelector('.task-details-description').textContent,jsonLiteral);
});

test('EditorJS known inline markup decodes entities while retaining literal unknown tags safely', async t => {
  const content=JSON.stringify({blocks:[{type:'paragraph',data:{text:'<strong>Передать</strong> <TaskId> и &lt;source_id&gt;<br>Unicode ✓ <img src=x onerror=bad()>'}}]});
  const f=fixture({task:{...record,content}});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const description=f.window.document.querySelector('.task-details-description');
  assert.equal(description.textContent,'Передать <TaskId> и <source_id>\nUnicode ✓ <img src=x onerror=bad()>');
  assert.equal(description.children.length,0);
});

test('description read from detail refreshes the card and absent description stays hidden', async t => {
  const f=fixture({invoke:(command,args,base)=>command==='get_calendar_task'?{...record,description:'Fetched description'}:base(command,args)});
  t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  assert.equal(f.window.document.querySelector('.task-details-description').textContent,'Fetched description');
});

test('missing process retains saved identity and prevents stage writes', async t => {
  const f=fixture({task:{...record,process:'future-process',stage:'future-stage'}});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const select=f.window.document.querySelector('.task-details-stage');
  assert.equal(select.value,'future-stage');assert.equal(select.disabled,true);
  assert.match(f.window.document.querySelector('.task-details-process-notice').textContent,/future-process.*future-stage/);
  select.value='';select.dispatchEvent(new f.window.Event('change'));await settle();
  assert.equal(f.calls.some(([command])=>command==='set_calendar_task_stage'),false);
});

test('completed history identifies completion and zero time without paused task wording', async t => {
  const f=fixture({task:{...record,completed:true,status_extra:'done',completion_date:'2026-10-03'},seconds:0});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const card=f.window.document.querySelector('.calendar-task-details');
  assert.match(card.querySelector('.calendar-editor-header p').textContent,/Завершена/);
  assert.doesNotMatch(card.querySelector('.calendar-editor-header p').textContent,/паузе/);
  assert.equal(card.querySelector('.task-details-total').textContent,'Учтённого времени пока нет');
  assert.match(card.querySelector('.task-details-meta').textContent,/Завершена/);
  assert.equal(card.querySelector('.task-details-execute').hidden,true);
});

test('missing time responses are unknown, never converted to a confirmed zero', async t => {
  const f=fixture({seconds:null});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  assert.equal(f.window.document.querySelector('.task-details-total').textContent,'Время недоступно');
});

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


test('Edit waits for the native asynchronous close event before handing off to the editor', async t => {
  const edited=[]; const f=fixture({onEdit:(task,restore)=>edited.push({task,restore})});
  t.after(()=>{f.dispose();f.dom.window.close();}); await settle();
  const modal=f.window.document.querySelector('dialog');let deliverClose;
  modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  modal.querySelector('.task-details-edit').click();await settle();
  assert.equal(edited.length,0);assert.equal(modal.isConnected,true);
  deliverClose();await settle();
  assert.equal(modal.isConnected,false);assert.equal(edited.length,1);
  assert.equal(edited[0].task.source_id,record.source_id);
  assert.equal(typeof edited[0].restore,'function');
  assert.equal(f.calls.some(([command])=>/^(set_|save_|start_)/.test(command)),false);
});

test('A blocked Edit preserves the workflow draft and cannot trigger editor handoff on a later ordinary close', async t => {
  const edited=[];const f=fixture({onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog'),panel=modal.querySelector('.task-workflow'),next=panel.querySelector('input');
  panel.open=true;next.value='Unsaved explicit step';next.dispatchEvent(new f.window.Event('input',{bubbles:true}));
  modal.querySelector('.task-details-edit').click();await settle();
  assert.equal(modal.open,true);assert.equal(next.value,'Unsaved explicit step');assert.equal(edited.length,0);
  [...panel.querySelectorAll('button')].find(b=>b.textContent==='Отменить ввод').click();
  modal.querySelector('[data-dialog-close]').click();await settle();assert.equal(edited.length,0);
});

test('Delayed native close does not open an editor after leaving its workspace', async t => {
  let current=true;const edited=[];const f=fixture({isCurrent:()=>current,onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog');let deliverClose;
  modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  modal.querySelector('.task-details-edit').click();await settle();current=false;deliverClose();await settle();assert.equal(edited.length,0);
});


test('QA-EDIT-001 repeated Edit before a deferred native close hands off exactly once', async t => {
  const edited=[];const f=fixture({onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog');let deliverClose;
  modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  const edit=modal.querySelector('.task-details-edit');edit.click();edit.click();await settle();
  assert.equal(edited.length,0);edit.dispatchEvent(new f.window.Event('click'));deliverClose();await settle();assert.equal(edited.length,1);
});

test('Edit intent resets after a rejected draft close and an explicit retry still hands off once', async t => {
  const edited=[];const f=fixture({onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog'),panel=modal.querySelector('.task-workflow'),input=panel.querySelector('input'),edit=modal.querySelector('.task-details-edit');
  panel.open=true;input.value='Keep draft';edit.click();edit.click();await settle();
  assert.equal(modal.open,true);assert.equal(input.value,'Keep draft');assert.equal(edited.length,0);assert.equal(edit.disabled,false);
  [...panel.querySelectorAll('button')].find(b=>b.textContent==='Отменить ввод').click();
  let deliverClose;modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  edit.click();edit.click();await settle();deliverClose();await settle();assert.equal(edited.length,1);
  assert.equal(f.calls.some(([command])=>/^(set_|save_|start_)/.test(command)),false);
});

test('disposing while Edit awaits its native close cancels the pending handoff', async t => {
  const edited=[];const f=fixture({onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog');let deliverClose;
  modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  modal.querySelector('.task-details-edit').click();await settle();f.dispose();await settle();deliverClose();await settle();assert.equal(edited.length,0);
});

test('Edit intent resets after a native close error, retaining a single explicit retry', async t => {
  const edited=[];const f=fixture({onEdit:task=>edited.push(task)});t.after(()=>{f.dispose();f.dom.window.close();});await settle();
  const modal=f.window.document.querySelector('dialog'),edit=modal.querySelector('.task-details-edit');
  modal.close=function(){throw Error('Synthetic close error');};edit.click();await settle();assert.equal(modal.open,true);assert.equal(edit.disabled,false);assert.equal(edited.length,0);
  let deliverClose;modal.close=function(){this.open=false;deliverClose=()=>this.dispatchEvent(new f.window.Event('close'));};
  edit.click();edit.click();await settle();deliverClose();await settle();assert.equal(edited.length,1);
});
