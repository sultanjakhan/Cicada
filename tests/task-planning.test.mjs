import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { planCalendarTaskForDay } from '../src/hanni/js/calendar-task-planning.js';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';

test('planning preserves current task fields and goal, using a versioned update only', async () => {
  const calls=[];
  const fresh={id:'task-a',title:'Renamed remotely',status:'task',duration_minutes:45,goal_id:'new-goal',version:7};
  await planCalendarTaskForDay(async(command,args)=>{calls.push({command,args});return command==='get_calendar_task'?fresh:'task-a';},'task-a','2026-09-20');
  assert.deepEqual(calls,[{command:'get_calendar_task',args:{id:'task-a'}},{command:'save_calendar_task',args:{id:'task-a',title:'Renamed remotely',dueDate:'2026-09-20',estimateMinutes:45,goalId:'new-goal',expectedVersion:7}}]);
});

test('planning rejects stale, closed and already dated tasks and never retries a failed write', async () => {
  for(const extra of [{completed:true},{archived:true},{due_date:'2026-09-21'},{status:'done'}]) {
    const writes=[];
    await assert.rejects(planCalendarTaskForDay(async(command,args)=>{if(command==='get_calendar_task')return{id:'a',status:'task',...extra};writes.push(args);},'a','2026-09-20'));
    assert.equal(writes.length,0);
  }
  let writes=0;
  await assert.rejects(planCalendarTaskForDay(async command=>{if(command==='get_calendar_task')return{id:'a',status:'task',version:1};writes++;throw new Error('version conflict');},'a','2026-09-20'),/version conflict/);
  assert.equal(writes,1);
  await assert.rejects(planCalendarTaskForDay(()=>{throw new Error('Must not read');},'a','2026-02-30'));
});

test('leaving Calendar while the fresh task is loading cancels planning before mutation', async () => {
  let writes=0;
  assert.equal(await planCalendarTaskForDay(async command=>{if(command==='get_calendar_task')return{id:'a',status:'task'};writes++;},'a','2026-09-20',()=>false),false);
  assert.equal(writes,0);
});

test('planning panel shows only undated tasks, supports a day button and drops on dates, and preserves List', t => {
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid'});t.after(()=>dom.window.close());
  globalThis.document=dom.window.document;
  const host=document.querySelector('main'), plans=[];
  const task=(id,date,extra={})=>({id:`note:${id}:${date||'undated'}`,source_type:'note',source_id:id,title:id,date,status_extra:'task',...extra});
  const rows=[task('undated',null),task('dated','2026-09-16'),task('done',null,{completed:true}),task('archived',null,{archived:true})];
  const options={period:'month',mode:'grid',date:'2026-09-16',records:rows,taskRecords:rows,onScheduleTask:(row,date)=>plans.push([row.source_id,date]),onOpenTasks:()=>{}};
  CalendarViews.render(host,options);
  assert.equal(host.querySelector('[data-tasks-panel]').hidden,true);
  host.querySelector('[data-tasks-toggle]').click();
  assert.equal(host.querySelector('[data-tasks-panel]').hidden,false);
  assert.deepEqual([...host.querySelectorAll('[data-plan-task]')].map(el=>el.dataset.planTask),['undated']);
  assert.equal(host.querySelectorAll('[data-task-filter]').length,0);
  host.querySelector('[data-plan-task]').click();assert.deepEqual(plans.shift(),['undated','2026-09-16']);
  const card=host.querySelector('[draggable="true"]');const dataTransfer={setData(){},effectAllowed:'',dropEffect:''};
  const start=new dom.window.Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(start,'dataTransfer',{value:dataTransfer});card.dispatchEvent(start);
  const target=host.querySelector('[data-calendar-date="2026-09-20"]');
  const drop=new dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:dataTransfer});target.dispatchEvent(drop);
  assert.deepEqual(plans.shift(),['undated','2026-09-20']);
  const escape=new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true});host.querySelector('[data-tasks-panel]').dispatchEvent(escape);
  assert.equal(host.querySelector('[data-tasks-panel]').hidden,true);
  CalendarViews.render(host,{...options,mode:'list'});
  assert.ok(host.querySelector('.calv-agenda'));
  assert.equal(host.querySelector('[data-tasks-panel]').hidden,true);
});
