import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTodayAction } from '../src/hanni/js/calendar-today-action.js';
import { startCalendarExecution, pauseCalendarExecution } from '../src/hanni/js/calendar-execution.js';

const settle = async () => { for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve)); };
const key = n => `jira:${n.toString(16).padStart(64,'0')}`;
const task = (n, role='working', extra={}) => ({source_type:'note',source_id:key(n),title:`Задача ${n}`,status_extra:'task',sphere:'work',jira_status:role==='working'?'In Progress':role,jira_workflow_role:role,jira_workflow_revision:'rev1',...extra});
async function setup(t, {preferences, failure=null}={}) {
  const dom=new JSDOM('<main><div id="today"></div><div id="working"></div></main>'), win=dom.window;
  const host=win.document.querySelector('#today'), working=win.document.querySelector('#working'), calls=[], actions=[], opened=[];
  const rows=[task(1,'working',{process:'system-analysis',stage:'analysis'}),task(2),task(3),task(4),task(5,'ready'),task(6,'review'),task(7,'completed'),task(8,'unassigned'),{source_type:'note',source_id:'personal',title:'Личная',status_extra:'task'}];
  const blocks=[], state={failure};
  const invoke=async(command,args)=>{
    calls.push({command,args});
    if(command==='get_ui_state') return null;
    if(command==='get_calendar_tasks') return rows.map(row=>({...row,is_active:blocks.some(block=>block.source_id===row.source_id&&block.is_active),has_work:blocks.some(block=>block.source_id===row.source_id)}));
    if(command==='get_active_blocks') return blocks.filter(block=>block.is_active).map(block=>({...block}));
    if(['get_calendar_task_goals','get_goals'].includes(command)) return [];
    if(command==='get_calendar_task') return {...rows.find(row=>row.source_id===args.id)};
    if(command==='jira_task_workflow_action') { if(state.failure) throw state.failure; return {workflowOutcome:'confirmed'}; }
    if(command==='start_task_block') { const id=blocks.length+1;blocks.push({id,source_type:args.sourceType,source_id:args.sourceId,is_active:true});return id; }
    if(command==='pause_task_block') { if(state.failure) throw state.failure;blocks.find(block=>block.id===args.blockId).is_active=false;return; }
    throw Error(command);
  };
  const changed=()=>win.dispatchEvent(new win.Event('task-state-changed'));
  const execute=async(row,action)=>{actions.push({id:row.source_id,action});if(action==='start')return await startCalendarExecution(invoke,row)!==null;return pauseCalendarExecution(invoke,row);};
  const api=mountCalendarTodayAction(host,{invoke,workingElement:working,preferences,notifyChange:changed,executeTask:execute,
    taskOptions:{invoke,notifyChange:changed,executeAction:execute,openTask:row=>opened.push(row.source_id)}});
  t.after(()=>{api();win.close();});await settle();
  const q=selector=>win.document.querySelector(selector);
  const button=(n,action)=>q(`[data-jira-working-task="note:${key(n)}"] [data-jira-working-action="${action}"]`);
  const writes=()=>calls.filter(call=>/^(start_task_block|pause_task_block|jira_task_workflow_action|set_ui_state)$/.test(call.command));
  return {dom,win,host,working,api,calls,rows,blocks,actions,state,opened,q,button,writes};
}

test('Today lists four Jira working tasks without time blocks, with status and optional stage, and performs no writes',async t=>{
  const x=await setup(t);
  assert.equal(x.working.hidden,false);
  assert.equal(x.q('[data-jira-working-count]').textContent,'4');
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,4);
  assert.equal(x.working.querySelectorAll('.calendar-jira-working__state').length,4);
  assert.ok([...x.working.querySelectorAll('.calendar-jira-working__state')].every(el=>el.textContent==='Учёт времени не запущен'));
  assert.match(x.working.textContent,/Jira: In Progress/);assert.match(x.working.textContent,/Этап: Анализ и модели/);
  assert.doesNotMatch(x.working.textContent,/Задача [5-8]|Личная/);
  assert.deepEqual(x.writes(),[]);
});

test('explicit selection shows one working task without starting and hides only its duplicate while the focus is visible',async t=>{
  const x=await setup(t);
  x.button(2,'select').click();await settle();
  assert.equal(x.host.querySelector('[data-next-action-key]').dataset.nextActionKey,`task:note:${key(2)}`);
  assert.match(x.host.querySelector('[data-today-recommendation]').textContent,/Учёт времени не запущен/);
  assert.match(x.host.querySelector('[data-today-recommendation]').textContent,/Jira: In Progress/);
  assert.equal(x.button(2,'select'),null);
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,3);
  assert.equal(x.q('[data-jira-working-count]').textContent,'4');
  assert.equal(x.q('[data-jira-working-selection]').hidden,false);
  x.host.querySelector('[data-today-choose]').click();await settle();
  assert.equal(x.host.querySelector('[data-today-recommendation]').hidden,true);
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,4,'hidden recommendation must not hide the row');
  x.host.querySelector('[data-today-choose]').click();await settle();
  assert.equal(x.button(2,'select'),null);
  x.api.openRoutine({id:'fictional',date:'2026-09-28',start:false});await settle();
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,4,'a routine focus leaves every Jira task available');
  assert.deepEqual(x.writes(),[]);
});

test('per-row explicit starts use shared Jira confirmation and keep both timers; pause targets only its row',async t=>{
  const x=await setup(t);
  x.button(1,'start').click();await settle();
  assert.deepEqual(x.blocks.filter(block=>block.is_active).map(block=>block.source_id),[key(1)]);
  x.button(2,'start').click();await settle();
  assert.deepEqual(x.blocks.filter(block=>block.is_active).map(block=>block.source_id),[key(1),key(2)]);
  assert.deepEqual(x.actions,[{id:key(1),action:'start'},{id:key(2),action:'start'}]);
  assert.equal(x.calls.filter(call=>call.command==='jira_task_workflow_action').length,2);
  assert.equal(x.calls.some(call=>call.command==='pause_task_block'),false);
  assert.equal(x.button(2,'select'),null,'the second task is the only selected focus');
  assert.match(x.q(`[data-jira-working-task="note:${key(1)}"]`).textContent,/Идёт учёт времени/);
  x.button(1,'pause').click();await settle();
  assert.deepEqual(x.blocks.filter(block=>block.is_active).map(block=>block.source_id),[key(2)]);
  assert.match(x.q(`[data-jira-working-task="note:${key(1)}"]`).textContent,/На паузе/);
});

for(const preferences of [{enabled:false},{includeTasks:false}]) test(`disabled task recommendations keep every working row and title opens the card: ${JSON.stringify(preferences)}`,async t=>{
  const x=await setup(t);
  x.button(2,'select').click();await settle();
  x.api.setPreferences(preferences);await settle();
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,4);
  x.button(2,'select').click();await settle();
  assert.deepEqual(x.opened,[key(2)]);
  assert.deepEqual(x.writes(),[]);
  x.button(2,'start').click();await settle();
  assert.equal(x.blocks.filter(block=>block.is_active).length,1);
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,4,'starting does not hide a task whose focus is disabled');
  assert.deepEqual(x.opened,[key(2)],'a start does not unexpectedly open a card');
});

test('Jira refusal leaves all tasks idle and keeps its safe message after background refresh',async t=>{
  const x=await setup(t,{failure:'jira_token_unavailable'});
  x.button(3,'start').click();await settle();
  assert.equal(x.blocks.length,0);assert.equal(x.button(3,'start').disabled,false);
  assert.match(x.q('[data-jira-working-error]').textContent,/API-токен недоступен/);
  x.win.dispatchEvent(new x.win.Event('task-state-changed'));await settle();
  assert.match(x.q('[data-jira-working-error]').textContent,/API-токен недоступен/);
});

test('raw local pause failures are not displayed',async t=>{
  const x=await setup(t,{preferences:{enabled:false}});
  x.button(1,'start').click();await settle();
  x.state.failure=new Error('SQL_PRIVATE_DETAILS');
  x.button(1,'pause').click();await settle();
  assert.equal(x.blocks[0].is_active,true);
  assert.match(x.q('[data-jira-working-error]').textContent,/Не удалось изменить учёт времени/);
  assert.doesNotMatch(x.working.textContent,/SQL_PRIVATE_DETAILS/);
});

test('status refresh removes a nonworking task and disposal detaches every refresh and action handler',async t=>{
  const x=await setup(t);
  x.rows[0].jira_workflow_role='review';x.rows[0].jira_status='Review';
  x.win.dispatchEvent(new x.win.Event('hanni:jira-imported'));await settle();
  assert.equal(x.working.querySelectorAll('[data-jira-working-task]').length,3);
  const oldButton=x.button(2,'start');x.api();const count=x.calls.length;
  for(const event of ['task-state-changed','hanni:calendar-refresh','hanni:jira-imported','focus']) x.win.dispatchEvent(new x.win.Event(event));
  oldButton.click();await settle();assert.equal(x.calls.length,count);assert.deepEqual(x.writes(),[]);
});
