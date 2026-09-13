import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
test('native task ACK followed by failed skill link retries only link and never duplicates task',async t=>{
  const dom=new JSDOM('<body></body>',{url:'http://localhost',pretendToBeVisual:true}),w=dom.window;
  for(const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option'])globalThis[name]=name==='window'?w:w[name];
  globalThis.marked={Marked:class{use(){}parse(value){return value;}}};
  let saved=0,linked=0;
  w.__TAURI__={core:{invoke:async(command)=>{
    if(command==='list_event_categories')return [{id:'general',name:'Общее',color:'#999'}];
    if(command==='get_goals')return [{id:'g',title:'Goal',goal_kind:'goal'}];
    if(command==='save_calendar_task'){saved++;return 'native-task';}
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
  assert.match(form.innerText||form.textContent,/вторая задача не создастся/);
  form.requestSubmit();await settle();
  assert.equal(saved,1);assert.equal(linked,2);assert.equal(form.isConnected,false);
});
