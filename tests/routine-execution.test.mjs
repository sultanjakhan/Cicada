import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openRecurringRun } from '../src/hanni/js/calendar-routine-execution.js';
import { recurringSourceId } from '../src/hanni/js/calendar-recurring-store.js';
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function setup(t,{other=null,mode='chain',graphSteps=null}={}){
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const date='2026-09-13',id='test-run';
  const steps=graphSteps||[{title:'Подготовить'},{title:'Сделать'}];
  const plan={id,kind:'action',mode,title:'Практика',weekdays:[0,1,2,3,4,5,6],startsOn:'',endsOn:'',time:'',active:true,required:true,createdOn:date,steps};
  const record={snapshot:plan,status:'pending',run:{steps:plan.steps.map(step=>mode==='graph'?{...step,dependsOn:step.dependsOn||[],trackingMode:step.trackingMode||'track',optional:step.optional??false,status:'pending'}:{title:step.title,status:'pending'})}};
  let state={version:1,plans:[plan],days:{[date]:{[id]:record}}},active=null,hasWork=false,fail=false,onRead=null;
  const calls=[];
  const invoke=async(name,args)=>{
    calls.push({name,args});
    if(name==='get_ui_state'){onRead?.();onRead=null;return JSON.stringify(state);}
    if(name==='get_schedules')return record.run.steps.map((step,index)=>({id:recurringSourceId(id,date,index),title:step.title,is_active:active?.source_id===recurringSourceId(id,date,index),has_work:hasWork&&active?.source_id!==recurringSourceId(id,date,index)&&index===0,block_id:hasWork&&index===0?1:null}));
    if(name==='get_active_block')return active;
    if(name==='get_active_blocks')return [active,other].filter(Boolean);
    if(name==='start_task_block'){if(fail)throw Error('Проверочная ошибка');hasWork=true;active={id:1,source_type:'schedule',source_id:args.sourceId};return 1;}
    if(name==='get_timeline_blocks')return [];
    if(name==='pause_task_block'){assert.notEqual(args.blockId,other?.id,'unrelated work must keep running');active=null;return;}
    if(name==='complete_recurring_step'){
      const index=JSON.parse(args.sourceId)[2];record.run.steps[index].status='done';return;
    }
    if(name==='finish_task_block'||name==='skip_recurring_step'){
      const sourceId=name==='skip_recurring_step'?args.sourceId:active?.source_id,index=sourceId?JSON.parse(sourceId)[2]:record.run.steps.findIndex(step=>step.status==='pending');
      record.run.steps[index].status=name==='finish_task_block'?'done':'skipped';if(active?.source_id===sourceId)active=null;return;
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
test('a routine step starts, pauses and finishes beside unrelated running work',async t=>{
  const other={id:9,source_type:'note',source_id:'unrelated',is_active:true};
  const x=setup(t,{other});x.open();await settle();
  const click=async action=>{x.document.querySelector(`[data-run-action=${action}]`).click();await settle();};
  await click('start');
  assert.equal(x.document.querySelector('dialog').textContent.includes('Переключить'),false,'no switch confirmation');
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1);
  assert.equal(x.calls.some(call=>call.name==='pause_task_block'),false,'starting never pauses other work');
  await click('pause');
  assert.deepEqual(x.calls.filter(call=>call.name==='pause_task_block').map(call=>call.args.blockId),[1]);
  await click('finish');
  assert.deepEqual(x.record.run.steps.map(step=>step.status),['done','pending']);
  assert.equal(other.is_active,true);
});

test('graph with multiple available roots waits for the user to choose and never autostarts',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'First root',dependsOn:[]},{title:'Second root',dependsOn:[]}]});
  x.open(true);await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  assert.equal(x.document.querySelector('[data-run-action=start]'),null);
  x.document.querySelector('[data-routine-step="1"]').focus();x.document.querySelector('[data-routine-step="1"]').click();
  assert.equal(x.document.activeElement,x.document.querySelector('[data-routine-step="1"]'),'step selection keeps keyboard focus');
  x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block')[0].args.sourceId,recurringSourceId(x.id,x.date,1));
});

test('graph branch choices unlock a join after parents are done or skipped',async t=>{
  const other={id:9,source_type:'note',source_id:'parallel-work',is_active:true};
  const x=setup(t,{other,mode:'graph',graphSteps:[
    {title:'Prepare',dependsOn:[],trackingMode:'track'},
    {title:'Write',dependsOn:[0],trackingMode:'track'},
    {title:'Check',dependsOn:[0],trackingMode:'check',optional:true},
    {title:'Join',dependsOn:[1,2],trackingMode:'track'},
  ]});
  x.open();await settle();
  assert.match(x.document.querySelector('[data-routine-step="1"]').textContent,/После: Prepare/);
  assert.match(x.document.querySelector('[data-routine-step="2"]').textContent,/После: Prepare/);
  assert.match(x.document.querySelector('[data-routine-step="3"]').textContent,/После: Write, Check/);
  assert.equal(x.document.querySelector('[data-routine-step="1"]').disabled,true);
  const click=async action=>{x.document.querySelector(`[data-run-action=${action}]`).click();await settle();};
  await click('start');await click('finish');
  assert.equal(x.calls.some(call=>call.name==='pause_task_block'),false,'graph execution leaves other running tasks untouched');
  assert.equal(other.is_active,true);
  assert.equal(x.document.querySelector('[data-routine-step="1"]').disabled,false);
  assert.equal(x.document.querySelector('[data-routine-step="2"]').disabled,false);
  x.document.querySelector('[data-routine-step="1"]').click();await click('skip');
  assert.equal(x.record.run.steps[1].status,'skipped');
  x.document.querySelector('[data-routine-step="2"]').click();
  assert.equal(x.document.querySelector('[data-run-action="complete"]').textContent,'Готово');
  await click('complete');
  assert.equal(x.record.run.steps[2].status,'done');
  assert.equal(x.calls.filter(call=>call.name==='complete_recurring_step').at(-1).args.sourceId,recurringSourceId(x.id,x.date,2));
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1,'check steps do not create timer blocks');
  assert.equal(x.document.querySelector('[data-routine-step="3"]').disabled,false);
  await click('start');
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').at(-1).args.sourceId,recurringSourceId(x.id,x.date,3));
});

test('a sole check step opens as an explicit check action and never autostarts a timer',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'Отметить',dependsOn:[],trackingMode:'check'}]});
  x.open(true);await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  assert.equal(x.document.querySelector('[data-run-action="complete"]').textContent,'Готово');
});

test('graph start revalidates unlocked dependencies before writing',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'Root',dependsOn:[]},{title:'Next',dependsOn:[0]}]});
  x.open();await settle();
  x.race(()=>{x.record.run.steps[0].status='done';});
  x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  assert.match(x.document.querySelector('[role=alert]').textContent,/недоступен|изменился/i);
});
