import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const today=()=>{const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const row=(id,date,extra={})=>({source_type:'note',source_id:id,title:id,date,status_extra:'task',...extra});

async function setup(t) {
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid',pretendToBeVisual:true});
  const host=dom.window.document.querySelector('main'), state={filter:'active',search:'',goal:'',page:0};
  let rows=[row('SQL',null),row('API',today()),row('Done',today(),{completed:true}),row('Hidden',null,{archived:true})],fail=false;
  const actions=[], opened=[];
  const dependencies={state,invoke:async command=>{if(fail)throw new Error('offline');if(command==='get_calendar_tasks')return rows;if(command==='get_goals')return[{id:'parent',title:'Career'},{id:'child',parent_goal_id:'parent',title:'SQL'}];if(command==='get_calendar_task_goals')return[{source_type:'note',source_id:'SQL',goal_id:'child'}];throw new Error(command);},openTask:(task)=>opened.push(task.source_id),editDate:()=>{},executeAction:async(task,action)=>{actions.push([task.source_id,action]);rows=rows.map(r=>r===task?{...r,completed:true}:r);},notifyChange:()=>{}};
  const dispose=mountCalendarTasks(host,dependencies);t.after(()=>{dispose();dom.window.close();});await settle();
  const titles=()=>[...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  const change=(selector,value)=>{const el=host.querySelector(selector);el.value=value;el.dispatchEvent(new dom.window.Event(el.tagName==='INPUT'?'input':'change',{bubbles:true}));};
  return{host,dom,state,dependencies,dispose,titles,change,actions,opened,setFail:value=>fail=value};
}

test('task catalogue filters actual records by day, completion, search and parent goal', async t=>{
  const x=await setup(t);assert.deepEqual(x.titles(),['API','SQL']);
  x.host.querySelector('[data-tasks-filter="undated"]').click();assert.deepEqual(x.titles(),['SQL']);
  x.host.querySelector('[data-tasks-filter="today"]').click();assert.deepEqual(x.titles(),['API']);
  x.host.querySelector('[data-tasks-filter="completed"]').click();assert.deepEqual(x.titles(),['Done']);
  x.host.querySelector('[data-tasks-filter="active"]').click();x.change('[data-tasks-goal]','parent');assert.deepEqual(x.titles(),['SQL']);
  x.change('[data-tasks-search]','Missing');assert.deepEqual(x.titles(),[]);assert.equal(x.host.querySelector('[data-tasks-count]').textContent,'0');
  x.change('[data-tasks-search]','');x.change('[data-tasks-goal]','none');assert.deepEqual(x.titles(),['API']);
  x.host.querySelector('[data-task-control="open"]').click();assert.deepEqual(x.opened,['API']);
});

test('important badge is shown for priority five note tasks only', async t=>{
  const x=await setup(t);
  const rows=await x.dependencies.invoke('get_calendar_tasks'); rows[0].priority=5;
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle(); await settle();
  assert.ok(x.host.querySelectorAll('[data-important-badge]').length >= 1);
  assert.match(x.host.textContent,/Важная/);
});

test('completion updates the same task and count, while a failed refresh preserves visible records', async t=>{
  const x=await setup(t);x.host.querySelector('[data-task-control="finish"]').click();await settle();await settle();
  assert.deepEqual(x.actions,[['API','finish']]);assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-count]').textContent,'1');
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await settle();await settle();
  assert.equal(x.host.querySelector('[data-tasks-message]').textContent,'Задача завершена.');
  x.setFail(true);x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await settle();await settle();
  assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-retry]').hidden,false);
  x.setFail(false);x.host.querySelector('[data-tasks-retry]').click();await settle();assert.equal(x.host.querySelector('[data-tasks-retry]').hidden,true);
});

test('pane filter state survives remount and disposed async results cannot replace the new pane', async t=>{
  const x=await setup(t);x.host.querySelector('[data-tasks-filter="undated"]').click();x.change('[data-tasks-search]','SQL');x.dispose();
  const dispose=mountCalendarTasks(x.host,x.dependencies);await settle();assert.deepEqual(x.titles(),['SQL']);assert.equal(x.host.querySelector('[data-tasks-search]').value,'SQL');dispose();
  let release;const pending=new Promise(resolve=>release=resolve);
  const stop=mountCalendarTasks(x.host,{...x.dependencies,invoke:()=>pending});stop();x.host.textContent='another pane';release([]);await settle();assert.equal(x.host.textContent,'another pane');
});
