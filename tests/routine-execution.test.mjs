import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openRecurringRun } from '../src/hanni/js/calendar-routine-execution.js';
import { recurringSourceId } from '../src/hanni/js/calendar-recurring-store.js';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function setup(t){
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const date='2026-09-13',id='test-run';
  const plan={id,kind:'action',mode:'chain',title:'Практика',weekdays:[0,1,2,3,4,5,6],startsOn:'',endsOn:'',time:'',active:true,required:true,createdOn:date,steps:[{title:'Подготовить'},{title:'Сделать'}]};
  const record={snapshot:plan,status:'pending',run:{steps:plan.steps.map(step=>({...step,status:'pending'}))}};
  let state={version:1,plans:[plan],days:{[date]:{[id]:record}}},active=null,hasWork=false,fail=false,onRead=null;
  const calls=[];
  const invoke=async(name,args)=>{
    calls.push({name,args});
    if(name==='get_ui_state'){onRead?.();onRead=null;return JSON.stringify(state);}
    if(name==='get_schedules')return record.run.steps.map((step,index)=>({id:recurringSourceId(id,date,index),title:step.title,is_active:active?.source_id===recurringSourceId(id,date,index),has_work:hasWork&&index===0,block_id:hasWork&&index===0?1:null}));
    if(name==='get_active_block')return active;
    if(name==='start_task_block'){if(fail)throw Error('Проверочная ошибка');hasWork=true;active={id:1,source_type:'schedule',source_id:args.sourceId};return 1;}
    if(name==='get_timeline_blocks')return [];
    if(name==='pause_task_block'){active=null;return;}
    if(name==='finish_task_block'||name==='skip_recurring_step'){
      record.run.steps.find(step=>step.status==='pending').status=name==='finish_task_block'?'done':'skipped';active=null;return;
    }
    throw Error(`Unexpected ${name}`);
  };
  return {document:dom.window.document,invoke,id,date,calls,record,open:(start=false)=>openRecurringRun({document:dom.window.document,invoke,id,date,start}),race:fn=>{onRead=fn;},fail:value=>{fail=value;},clear:()=>{state.days={};}};
}
test('routine pauses, completes one step, waits for manual next start and reopens from saved progress',async t=>{
  const x=setup(t);x.open();await settle();
  const click=async action=>{x.document.querySelector(`[data-run-action=${action}]`).click();await settle();};
  await click('start');await click('pause');
  assert.equal(x.document.querySelector('[data-run-action=start]').textContent,'Продолжить');
  await click('finish');
  assert.deepEqual(x.record.run.steps.map(step=>step.status),['done','pending']);
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1);
  x.document.querySelector('[data-dialog-close]').click();x.open();await settle();
  assert.equal(x.document.querySelector('[aria-current=step] span').textContent,'Сделать');
  await click('skip');assert.match(x.document.querySelector('dialog').textContent,/1 из 2/);
});
test('a stale skip never applies to the next step and an API error permits retry',async t=>{
  const x=setup(t);x.open();await settle();
  x.race(()=>{x.record.run.steps[0].status='done';});
  x.document.querySelector('[data-run-action=skip]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='skip_recurring_step').length,0);
  assert.match(x.document.querySelector('[role=alert]').textContent,/Шаг уже изменился/);
  x.fail(true);x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.match(x.document.querySelector('[role=alert]').textContent,/Проверочная ошибка/);
  assert.equal(x.document.querySelector('fieldset').disabled,false);
  x.fail(false);x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.ok(x.document.querySelector('[data-run-action=pause]'));
});
test('opening details without an existing run creates no obligation',async t=>{
  const x=setup(t);x.clear();x.open();await settle();
  assert.match(x.document.querySelector('[role=alert]').textContent,/ещё не начато/);
  assert.equal(x.calls.some(call=>call.name==='set_ui_state'||call.name==='start_task_block'),false);
});
