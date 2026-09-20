import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
test('native task ACK followed by failed skill link retries only link and never duplicates task',async t=>{
  const dom=new JSDOM('<body></body>',{url:'http://localhost',pretendToBeVisual:true}),w=dom.window;
  for(const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option'])globalThis[name]=name==='window'?w:w[name];
  globalThis.marked={Marked:class{use(){}parse(value){return value;}}};
  let saved=0,linked=0,saveArgs=[];
  w.__TAURI__={core:{invoke:async(command,args)=>{
    if(command==='list_event_categories')return [{id:'general',name:'Общее',color:'#999'}];
    if(command==='get_goals')return [{id:'g',title:'Goal',goal_kind:'goal'}];
    if(command==='save_calendar_task'){saved++;saveArgs.push(args);return 'native-task';}
    if(command==='get_calendar_task_goals')return [];
    throw Error(command);
  }}};
  const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
  t.after(()=>dom.window.close());
  const {showCalendarCreateModal}=await import('../src/hanni/js/calendar-event-modal.js');
  await showCalendarCreateModal(null,{initialNoDate:true,initialTitle:'Practice',goalId:'g',onTaskSaved:async row=>{linked++;assert.equal(row.id,'native-task');if(linked===1)throw Error('link failed');}});
  await settle();
  const form=document.querySelector('#evm-form');form.requestSubmit();await settle();
  assert.equal(saved,1);assert.equal(linked,1);assert.ok(form.isConnected);
  assert.equal(saveArgs[0].important, false);
  assert.match(form.innerText||form.textContent,/вторая задача не создастся/);
  form.requestSubmit();await settle();
  assert.equal(saved,1);assert.equal(linked,2);assert.equal(form.isConnected,false);
});

test('task editor preserves legacy priority until the important checkbox changes',async t=>{
  const dom=new JSDOM('<body></body>',{url:'http://localhost',pretendToBeVisual:true}),w=dom.window;
  for(const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option'])globalThis[name]=name==='window'?w:w[name];
  globalThis.marked={Marked:class{use(){}parse(value){return value;}}};
  const saves=[]; let reads=0;
  w.__TAURI__={core:{invoke:async(command,args)=>{
    if(command==='list_event_categories')return [];
    if(command==='get_goals')return [];
    if(command==='get_calendar_task'){reads++;return {id:'task-3',title:'Legacy',date:'2026-09-20',priority:reads===1?3:5,version:2};}
    if(command==='save_calendar_task'){saves.push(args);return 'task-3';}
    if(command==='get_calendar_task_goals')return [];
    throw Error(command);
  }}};
  const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
  t.after(()=>dom.window.close());
  const {showEventModal}=await import('../src/hanni/js/calendar-event-modal.js');
  await showEventModal(null,null,{kind:'task',taskId:'task-3'}); await settle();
  let form=document.querySelector('#evm-form'); form.requestSubmit(); await settle();
  assert.equal(saves[0].important,null);
  await showEventModal(null,null,{kind:'task',taskId:'task-3'}); await settle();
  form=document.querySelector('#evm-form'); form.querySelector('#evm-important').click(); form.requestSubmit(); await settle();
  assert.equal(saves[1].important,false);
});
