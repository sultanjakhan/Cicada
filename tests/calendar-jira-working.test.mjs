import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTodayAction } from '../src/hanni/js/calendar-today-action.js';
import { mountCalendarInProgress, HIDDEN_KEY } from '../src/hanni/js/calendar-in-progress.js';
import { startCalendarExecution } from '../src/hanni/js/calendar-execution.js';

const settle = async () => { for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve)); };
const TODAY='2026-09-28';
const key = n => `jira:${n.toString(16).padStart(64,'0')}`;
const task = (n, role='working', extra={}) => ({source_type:'note',source_id:key(n),title:`Задача ${n}`,status_extra:'task',sphere:'work',jira_status:role==='working'?'In Progress':role,jira_workflow_role:role,jira_workflow_revision:'rev1',...extra});
async function setup(t, {preferences, failure=null, failRead=false, current=true, hidden=null, delayed=false}={}) {
  const dom=new JSDOM('<main><div id="today"></div><div id="working"></div></main>'), win=dom.window;
  const host=win.document.querySelector('#today'), working=win.document.querySelector('#working'), calls=[], opened=[];
  const rows=[...(current?[task(1,'working',{process:'system-analysis',stage:'analysis'}),task(2),task(3),task(4)]:[]),task(5,'ready'),task(6,'review'),task(7,'completed'),task(8,'unassigned'),{source_type:'note',source_id:'personal',title:'Личная',status_extra:'task'}];
  const blocks=[], schedules=[], state={failure,failRead,hidden}, states=[];
  let resolveRead;
  const firstRead=delayed?new Promise(resolve=>{resolveRead=resolve;}):Promise.resolve();
  const invoke=async(command,args={})=>{
    calls.push({command,args});
    if(command==='get_ui_state') return args.key===HIDDEN_KEY?state.hidden:null;
    if(command==='get_calendar_tasks') return rows.filter(row=>!row.completed).map(row=>({...row,is_active:blocks.some(block=>block.source_id===row.source_id&&block.is_active),has_work:blocks.some(block=>block.source_id===row.source_id)}));
    if(command==='get_active_blocks') return blocks.filter(block=>block.is_active).map(block=>({...block}));
    if(command==='get_timeline_blocks') {await firstRead;if(state.failRead)throw Error('READ_PRIVATE_DETAILS');return blocks.filter(block=>block.date===args.date).map(block=>({...block}));}
    if(command==='get_calendar_task_blocks') return blocks.filter(block=>args.sourceIds.includes(block.source_id)).map(block=>({...block}));
    if(command==='get_schedules') return schedules;
    if(['get_calendar_task_goals','get_goals','recurring_get_today','recurring_get_plans'].includes(command)) return [];
    if(command==='get_calendar_task') return {...rows.find(row=>row.source_id===args.id)};
    if(command==='jira_task_workflow_action') { if(state.failure) throw state.failure; return {workflowOutcome:'confirmed'}; }
    if(command==='start_task_block') { const id=blocks.length+1;blocks.push({id,source_type:args.sourceType,source_id:args.sourceId,date:TODAY,start_time:'11:00:00',is_active:true});return id; }
    if(command==='pause_task_block') { if(state.failure) throw state.failure;Object.assign(blocks.find(block=>block.id===args.blockId),{is_active:false,end_time:'11:01:00',duration_seconds:60});return; }
    if(command==='set_calendar_task_stage') {const row=rows.find(row=>row.source_id===args.id);row.stage=args.stage;return {...row};}
    if(command==='complete_calendar_task') {rows.find(row=>row.source_id===args.id).completed=true;return;}
    throw Error(command);
  };
  const changed=()=>win.dispatchEvent(new win.Event('task-state-changed'));
  const api=mountCalendarTodayAction(host,{invoke,unifiedCurrentWork:true,preferences,notifyChange:changed,
    taskOptions:{invoke,notifyChange:changed,executeAction:async(row,action)=>action==='start'&&await startCalendarExecution(invoke,row)!==null,openTask:row=>opened.push(row.source_id)}});
  const currentApi=mountCalendarInProgress(working,{invoke,now:()=>new Date(`${TODAY}T11:01:00`),includeJiraWorking:true,hideWhenEmpty:true,embedded:true,
    notifyChange:changed,openTask:row=>opened.push(row.source_id),onState:next=>{states.push(next);api.setCurrentWork(next);}});
  t.after(()=>{api();currentApi();win.close();});await settle();
  const q=selector=>win.document.querySelector(selector);
  const button=(n,action)=>q(`[data-context-record="note:${key(n)}"] [data-cip-control="${action}"]`);
  const writes=()=>calls.filter(call=>/^(start_task_block|pause_task_block|jira_task_workflow_action|set_ui_state|set_calendar_task_stage|complete_calendar_task)$/.test(call.command));
  const visibleRows=()=>[...working.querySelectorAll('.cip-row')].map(row=>row.dataset.contextRecord);
  const refresh=async()=>{win.dispatchEvent(new win.Event('hanni:calendar-refresh'));await settle();};
  return {dom,win,host,working,api,currentApi,calls,rows,blocks,schedules,state,states,opened,q,button,writes,visibleRows,refresh,resolveRead};
}

test('one current-work block shows all four Jira working tasks without time blocks and never recommends a fifth',async t=>{
  const x=await setup(t);
  assert.equal(x.working.hidden,false);
  assert.equal(x.q('[data-today-title]').textContent,'В работе · 4');
  assert.equal(x.q('[data-today-recommendation]').hidden,true);
  assert.equal(x.visibleRows().length,4);
  assert.ok([...x.working.querySelectorAll('.cip-state')].every(el=>el.textContent==='Учёт времени не запущен'));
  assert.ok([...x.working.querySelectorAll('[data-cip-time]')].every(el=>el.textContent==='00:00'));
  assert.match(x.working.textContent,/Jira: In Progress/);assert.match(x.working.textContent,/Этап:Анализ и модели/);
  assert.doesNotMatch(x.working.textContent,/Задача [5-8]|Личная/);
  assert.deepEqual(x.writes(),[]);
  x.button(2,'open').click();await settle();
  assert.deepEqual(x.opened,[key(2)]);assert.equal(x.visibleRows().length,4);
  assert.equal(x.q('[data-today-title]').textContent,'В работе · 4');
});

test('per-row start confirms Jira, preserves every row and order, runs timers in parallel, and pauses only one',async t=>{
  const x=await setup(t), initial=x.visibleRows();
  x.button(3,'toggle').click();await settle();
  x.button(2,'toggle').click();await settle();
  assert.deepEqual(x.blocks.filter(block=>block.is_active).map(block=>block.source_id),[key(3),key(2)]);
  assert.equal(x.calls.filter(call=>call.command==='jira_task_workflow_action').length,2);
  assert.equal(x.calls.some(call=>call.command==='pause_task_block'),false);
  assert.deepEqual(x.visibleRows(),initial);
  assert.match(x.button(3,'open').closest('.cip-row').textContent,/Идёт учёт времени/);
  x.button(3,'toggle').click();await settle();
  assert.deepEqual(x.blocks.filter(block=>block.is_active).map(block=>block.source_id),[key(2)]);
  assert.deepEqual(x.visibleRows(),initial);
  assert.match(x.button(3,'open').closest('.cip-row').textContent,/На паузе/);
  assert.equal(x.q('[data-today-recommendation]').hidden,true);
  assert.equal(x.q('[data-today-title]').textContent,'В работе · 4');
});

test('internal-stage arrow still advances only that task without starting a timer',async t=>{
  const x=await setup(t);
  x.rows[0].actual_seconds=600;
  x.rows[0].stage_log=[{stage:'analysis',at:`${TODAY}T11:00:00`}];
  await x.refresh();
  const row=()=>x.button(1,'open').closest('.cip-row');
  assert.equal(row().querySelector('[data-cip-time]').textContent,'10:00');
  assert.equal(row().querySelector('.cip-time-label').textContent,'Время работы');
  assert.equal(row().querySelector('.cip-stage-time'),null);
  x.button(1,'stage-next').click();await settle();
  assert.equal(x.rows[0].stage,'description');assert.match(x.button(1,'open').closest('.cip-row').textContent,/Этап:Описание/);
  assert.equal(row().querySelector('[data-cip-time]').textContent,'10:00','changing the stage preserves total task time');
  assert.deepEqual(x.writes().map(call=>call.command),['set_calendar_task_stage']);
  assert.equal(x.visibleRows().length,4);
});

test('old stop records cannot hide Jira working rows, and their menu cannot stop/hide them',async t=>{
  const hidden=JSON.stringify({[`note:${key(1)}`]:`${TODAY}T10:00:00Z`,'note:expired':'2026-09-20T10:00:00Z'}), x=await setup(t,{hidden});
  assert.equal(x.visibleRows().length,4);assert.equal(x.state.hidden,hidden);assert.deepEqual(x.writes(),[]);
  x.button(1,'menu').click();
  assert.equal(x.q('[data-menu-action="stop"]'),null);assert.ok(x.q('[data-menu-action="open"]'));
});

for(const preferences of [{enabled:false},{includeTasks:false}]) test(`disabled recommendations leave all current tasks usable: ${JSON.stringify(preferences)}`,async t=>{
  const x=await setup(t,{preferences});
  x.button(2,'open').click();await settle();assert.deepEqual(x.opened,[key(2)]);
  x.api.setPreferences(preferences);await settle();assert.equal(x.visibleRows().length,4);
  x.button(2,'toggle').click();await settle();assert.equal(x.blocks.filter(block=>block.is_active).length,1);
  assert.equal(x.visibleRows().length,4);assert.equal(x.q('[data-today-recommendation]').hidden,true);
});

test('recommendation remains hidden before the first read, appears only when current work is empty, and returns after completion',async t=>{
  const x=await setup(t,{delayed:true});
  assert.equal(x.q('[data-today-recommendation]').hidden,true);assert.equal(x.states.at(-1).ready,false);
  x.resolveRead();await settle();assert.equal(x.visibleRows().length,4);assert.equal(x.q('[data-today-recommendation]').hidden,true);
  for(const row of x.rows.filter(row=>row.jira_workflow_role==='working')) row.jira_workflow_role='review';
  await x.refresh();
  assert.equal(x.working.hidden,true);assert.equal(x.q('[data-today-recommendation]').hidden,false);
  assert.equal(x.q('[data-today-title]').textContent,'Что сделать сейчас');
  assert.equal(x.q('[data-next-action-key]').dataset.nextActionKey,`task:note:${key(5)}`);
  assert.deepEqual(x.writes(),[]);
});

test('first read failure and later failure after empty never claim there is no current work',async t=>{
  const x=await setup(t,{current:false,failRead:true});
  assert.equal(x.q('[data-today-recommendation]').hidden,true);
  assert.match(x.q('[data-cip-empty-text]').textContent,/Не удалось загрузить/);
  assert.equal(x.q('[data-cip-retry]').hidden,false);
  x.state.failRead=false;x.q('[data-cip-retry]').click();await settle();
  assert.equal(x.q('[data-today-recommendation]').hidden,false);
  x.state.failRead=true;await x.refresh();
  assert.equal(x.q('[data-today-recommendation]').hidden,true);assert.match(x.q('[data-cip-empty-text]').textContent,/Не удалось загрузить/);
  assert.equal(x.q('[data-cip-retry]').hidden,false);assert.doesNotMatch(x.working.textContent,/READ_PRIVATE_DETAILS/);
});

test('running and paused-today personal tasks suppress recommendation until both leave current work',async t=>{
  const x=await setup(t,{current:false});
  assert.equal(x.q('[data-today-recommendation]').hidden,false);
  x.blocks.push({id:1,source_type:'note',source_id:'personal',date:TODAY,start_time:'10:00:00',is_active:true});await x.refresh();
  assert.equal(x.q('[data-today-recommendation]').hidden,true);assert.deepEqual(x.visibleRows(),['note:personal']);
  Object.assign(x.blocks[0],{is_active:false,end_time:'10:30:00',duration_seconds:1800});await x.refresh();
  assert.equal(x.q('[data-today-recommendation]').hidden,true);assert.match(x.working.textContent,/На паузе/);
  x.rows.find(row=>row.source_id==='personal').completed=true;await x.refresh();assert.equal(x.q('[data-today-recommendation]').hidden,false);
});

test('paused Jira tasks leave current work after a role change, but a live timer stays available to pause',async t=>{
  const x=await setup(t,{current:false});
  x.rows.unshift(task(1));
  for(const row of x.rows.filter(row=>row.jira_workflow_role)) x.blocks.push({id:x.blocks.length+1,source_type:'note',source_id:row.source_id,date:TODAY,start_time:'10:00:00',end_time:'10:30:00',duration_seconds:1800,is_active:false});
  await x.refresh();assert.deepEqual(x.visibleRows(),[`note:${key(1)}`]);assert.equal(x.q('[data-today-recommendation]').hidden,true);
  x.rows[0].jira_workflow_role='review';await x.refresh();
  assert.deepEqual(x.visibleRows(),[]);assert.equal(x.q('[data-today-recommendation]').hidden,false);
  x.blocks[0].is_active=true;await x.refresh();assert.deepEqual(x.visibleRows(),[`note:${key(1)}`]);
  assert.equal(x.q('[data-today-recommendation]').hidden,true);
  x.button(1,'toggle').click();await settle();
  assert.deepEqual(x.visibleRows(),[]);assert.equal(x.q('[data-today-recommendation]').hidden,false);
});

test('an expanded routine is counted separately from visible rows and never exposes a new recommendation',async t=>{
  const x=await setup(t,{current:false}), id=JSON.stringify(['routine-a',TODAY,0]);
  x.schedules.push({source_type:'schedule',source_id:id,title:'Рутина',status_extra:'pending'});
  x.blocks.push({id:1,source_type:'schedule',source_id:id,date:TODAY,start_time:'10:00:00',is_active:true});await x.refresh();
  x.currentApi.setExcludedRoutine('routine-a');
  assert.deepEqual(x.states.at(-1),{count:0,totalCount:1,ready:true,failed:false});
  assert.equal(x.visibleRows().length,0);assert.equal(x.q('[data-today-title]').textContent,'В работе');
  assert.equal(x.q('[data-today-recommendation]').hidden,true);
  x.currentApi.setExcludedRoutine(null);assert.equal(x.visibleRows().length,1);
});

test('launcher and routine/task choices remain available while all current tasks stay visible',async t=>{
  const x=await setup(t);
  x.q('[data-today-start-another]').click();await settle();
  assert.equal(x.q('[data-today-choices]').hidden,false);assert.equal(x.visibleRows().length,4);
  assert.equal(x.q('[data-today-scope="tasks"]').getAttribute('aria-pressed'),'true');
  assert.equal(x.q('[data-today-choose]').textContent,'К текущим задачам');
  x.q('[data-today-choose]').click();await settle();assert.equal(x.q('[data-today-recommendation]').hidden,true);
  x.q('[data-today-choose]').click();await settle();assert.equal(x.q('[data-today-scope="routines"]').getAttribute('aria-pressed'),'true');
  assert.equal(x.visibleRows().length,4);assert.deepEqual(x.writes(),[]);
});

test('Jira refusal leaves timers idle with its safe message and raw pause errors remain private',async t=>{
  const x=await setup(t,{failure:'jira_token_unavailable'});
  x.button(3,'toggle').click();await settle();assert.equal(x.blocks.length,0);
  assert.match(x.q('[data-cip-message]').textContent,/API-токен недоступен/);
  await x.refresh();assert.match(x.q('[data-cip-message]').textContent,/API-токен недоступен/);
  x.state.failure=null;x.button(1,'toggle').click();await settle();
  x.state.failure=new Error('SQL_PRIVATE_DETAILS');x.button(1,'toggle').click();await settle();
  assert.equal(x.blocks[0].is_active,true);assert.match(x.q('[data-cip-message]').textContent,/Не удалось выполнить действие/);
  assert.doesNotMatch(x.working.textContent,/SQL_PRIVATE_DETAILS/);
});

test('refresh follows explicit status roles and dispose detaches action and refresh handlers',async t=>{
  const x=await setup(t);x.rows[0].jira_workflow_role='review';x.rows[0].jira_status='Review';await x.refresh();
  assert.equal(x.visibleRows().length,3);assert.equal(x.q('[data-today-title]').textContent,'В работе · 3');
  const oldButton=x.button(2,'toggle');x.api();x.currentApi();const count=x.calls.length;
  for(const event of ['task-state-changed','hanni:calendar-refresh','hanni:jira-imported','focus']) x.win.dispatchEvent(new x.win.Event(event));
  oldButton.click();await settle();assert.equal(x.calls.length,count);assert.deepEqual(x.writes(),[]);
});
