import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountTaskWorkflow} from '../src/hanni/js/task-workflow-view.js';
import {workflowKey,workflowTaskId} from '../src/hanni/js/task-workflow.js';
const record={source_type:'note',source_id:'synthetic-next-step'};
const settle=()=>new Promise(r=>setTimeout(r,20));
async function mount(steps,{failRead=false,failWrite=false}={}) {
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main'),calls=[];
 let raw=JSON.stringify({version:1,taskId:workflowTaskId(record),steps,result:'',run:null});
 const invoke=async(command,args)=>{calls.push(command);if(command==='get_ui_state'){if(args.key===workflowKey(record)){if(failRead)throw Error('synthetic read failure');return raw;}return null;}if(command==='set_ui_state'){if(failWrite)throw Error('synthetic write failure');raw=args.value;return;}throw Error('Unexpected side effect: '+command);};
 const dispose=mountTaskWorkflow(host,{record,invoke});await settle();
 return{dom,host,calls,dispose,close(){dispose();dom.window.close();}};
}
test('collapsed task workflow exposes confirmed nearest step and waiting without starting anything',async()=>{
 const x=await mount([{id:'a',title:'Planned next',status:'planned'},{id:'b',title:'Текущий шаг <script>',status:'running'},{id:'c',title:'Ответ коллеги',status:'blocked'}]);
 try{assert.equal(x.host.querySelector('details').open,false);assert.equal(x.host.querySelector('.task-next-step p').textContent,'Сейчас: Текущий шаг <script>');assert.match(x.host.querySelector('.task-next-step').textContent,/Ждём ответа: Ответ коллеги/);assert.equal(x.host.querySelector('script'),null);const choose=x.host.querySelector('.task-next-step button');assert.equal(choose.textContent,'Выбрать другой шаг');choose.click();assert.equal(x.host.querySelector('details').open,true);assert.equal(x.dom.window.document.activeElement,x.host.querySelector('select'));assert.ok(x.calls.every(c=>c==='get_ui_state'));}finally{x.close();}
});
test('first planned step stays explicit; blocked and completed steps are never suggested as an action',async()=>{
 for(const [steps,text] of [
 [[{id:'a',title:'Wait',status:'blocked'},{id:'b',title:'Next',status:'planned'}],'Ближайший шаг: Next'],
 [[{id:'a',title:'Wait',status:'blocked'}],'Незавершённые шаги ждут ответа.'],
 [[{id:'a',title:'Done',status:'done'}],'Все сохранённые шаги выполнены: 1.']]){const x=await mount(steps);try{assert.equal(x.host.querySelector('.task-next-step p').textContent,text);assert.ok(x.calls.every(c=>c==='get_ui_state'));}finally{x.close();}}
});
test('empty task has a direct route to its existing next-step field without a new screen or writes',async()=>{
 const x=await mount([]);try{assert.match(x.host.querySelector('.task-next-step p').textContent,/ещё не указан/);x.host.querySelector('.task-next-step button').click();assert.equal(x.host.querySelector('details').open,true);assert.equal(x.dom.window.document.activeElement,x.host.querySelector('input'));assert.ok(x.calls.every(c=>c==='get_ui_state'));}finally{x.close();}
});
test('unreadable steps are unknown and failed saves keep the confirmed next step',async()=>{
 const unreadable=await mount([],{failRead:true});try{assert.match(unreadable.host.querySelector('.task-next-step p').textContent,/неизвестен/);assert.equal(unreadable.host.querySelector('.task-next-step button').disabled,true);}finally{unreadable.close();}
 const x=await mount([{id:'a',title:'Confirmed next',status:'planned'}],{failWrite:true});try{const s=x.host.querySelector('select');s.value='done';s.dispatchEvent(new x.dom.window.Event('change'));await settle();assert.equal(x.host.querySelector('.task-next-step p').textContent,'Ближайший шаг: Confirmed next');assert.match(x.host.querySelector('[role=status]').textContent,/не подтверждены/);}finally{x.close();}
});
test('confirmed completion exposes the next planned step and keeps other running work visible',async()=>{
 const x=await mount([{id:'a',title:'First',status:'planned'},{id:'b',title:'Second',status:'planned'}]);
 try{const s=x.host.querySelector('select');s.value='done';s.dispatchEvent(new x.dom.window.Event('change'));await settle();assert.equal(x.host.querySelector('.task-next-step p').textContent,'Ближайший шаг: Second');assert.match(x.host.querySelector('summary').textContent,/1\/2/);}finally{x.close();}
 const parallel=await mount([{id:'a',title:'First',status:'running'},{id:'b',title:'Second',status:'running'}]);
 try{assert.match(parallel.host.querySelector('.task-next-step p').textContent,/ещё в работе: 1/);assert.ok(parallel.calls.every(c=>c==='get_ui_state'));}finally{parallel.close();}
});
