import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountRecurringRun as basemountRecurringRun, openRecurringRun as baseopenRecurringRun } from '../src/hanni/js/calendar-routine-execution.js';
import { recurringSourceId } from '../src/hanni/js/calendar-recurring-store.js';
import {withRecurringBundle} from './fixtures/recurring-bundle.mjs';
const mountRecurringRun=(element,options)=>basemountRecurringRun(element,{...options,invoke:withRecurringBundle(options.invoke)});
const openRecurringRun=options=>baseopenRecurringRun({...options,invoke:withRecurringBundle(options.invoke)});

const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function setup(t,{other=null,mode='chain',graphSteps=null,changingForeignSchedule=false,terminalStatus=null}={}){
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
  const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,id='test-run';
  const steps=graphSteps||[{title:'Подготовить'},{title:'Сделать'}];
  const plan={id,kind:'action',mode,title:'Практика',weekdays:[0,1,2,3,4,5,6],startsOn:'',endsOn:'',time:'',active:true,required:true,createdOn:date,steps};
  const stepStatus=terminalStatus==='done'?'done':terminalStatus==='skipped'?'skipped':'pending';
  const record={snapshot:plan,status:terminalStatus||'pending',run:{steps:plan.steps.map(step=>mode==='graph'?{...step,dependsOn:step.dependsOn||[],trackingMode:step.trackingMode||'track',optional:step.optional??false,status:stepStatus}:{title:step.title,status:stepStatus})}};
  let state={version:1,plans:[plan],days:{[date]:{[id]:record}}},active=null,hasWork=false,fail=false,onRead=null,foreignSeconds=0,holdWrite=false,releaseWrite=null,holdRead=false,releaseRead=null;
  const calls=[];
  const invoke=async(name,args)=>{
    calls.push({name,args});
    if(name==='get_ui_state'){const hook=onRead;onRead=null;hook?.();if(holdRead){holdRead=false;return new Promise(resolve=>{releaseRead=()=>resolve(JSON.stringify(state));});}return JSON.stringify(state);}
    if(name==='set_ui_state'){
      const save=()=>{state=JSON.parse(args.value);Object.assign(record,state.days[date]?.[id]||{});};
      if(holdWrite){holdWrite=false;return new Promise(resolve=>{releaseWrite=()=>{save();resolve();};});}
      save();return;
    }
    if(name==='get_schedules')return [...record.run.steps.map((step,index)=>({id:recurringSourceId(id,date,index),title:step.title,is_active:active?.source_id===recurringSourceId(id,date,index),has_work:hasWork&&active?.source_id!==recurringSourceId(id,date,index)&&index===0,block_id:hasWork&&index===0?1:null})),...(changingForeignSchedule?[{id:'unrelated-schedule',actual_seconds:++foreignSeconds}]:[])];
    if(name==='get_active_block')return active;
    if(name==='get_active_blocks')return [active,other].filter(Boolean);
    if(name==='start_task_block'){if(fail)throw Error('Проверочная ошибка');hasWork=true;active={id:1,source_type:'schedule',source_id:args.sourceId};return 1;}
    if(name==='get_timeline_blocks')return [];
    if(name==='pause_task_block'){assert.notEqual(args.blockId,other?.id,'unrelated work must keep running');active=null;return;}
    if(name==='complete_recurring_step'){
      const index=JSON.parse(args.sourceId)[2];record.run.steps[index].status='done';updateRunStatus();return;
    }
    if(name==='finish_task_block'||name==='skip_recurring_step'){
      const sourceId=name==='skip_recurring_step'?args.sourceId:active?.source_id,index=sourceId?JSON.parse(sourceId)[2]:record.run.steps.findIndex(step=>step.status==='pending');
      record.run.steps[index].status=name==='finish_task_block'?'done':'skipped';updateRunStatus();if(active?.source_id===sourceId)active=null;return;
    }
    throw Error(`Unexpected ${name}`);
  };
  function updateRunStatus(){const statuses=record.run.steps.map(step=>step.status);record.status=statuses.includes('pending')?'pending':statuses.includes('skipped')?'skipped':'done';}
  const host=dom.window.document.querySelector('main');
  return {document:dom.window.document,host,invoke,id,date,calls,record,open:(start=false)=>openRecurringRun({document:dom.window.document,invoke,id,date,start}),mountInline:(onClose,start=false,onTerminal)=>mountRecurringRun(host,{document:dom.window.document,invoke,id,date,start,onClose,onTerminal}),race:fn=>{onRead=fn;},fail:value=>{fail=value;},clear:()=>{state.days={};},setTerminal(status){record.status=status;record.run.steps.forEach(step=>{step.status=status;});},deferRead:()=>{holdRead=true;},releaseRead:()=>releaseRead?.(),deferWrite:()=>{holdWrite=true;},releaseWrite:()=>releaseWrite?.()};
}
test('inline runner reuses the routine steps and leaves a running step alive on return to recommendation',async t=>{
  const other={id:9,source_type:'note',source_id:'unrelated',is_active:true};
  const x=setup(t,{other});let returned=0;const dispose=x.mountInline(()=>{returned++;});await settle();
  assert.equal(x.document.querySelector('dialog'),null);
  assert.equal(x.document.querySelector('[data-run-heading]').tagName,'H3');
  assert.equal(x.document.activeElement.dataset.runHeading,'');
  assert.equal(x.document.querySelector('[data-run-action=start]').textContent,'Начать шаг');
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0,'mount never starts a step by itself');
  x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1);
  assert.equal(other.is_active,true);
  x.document.querySelector('[data-run-close]').click();
  assert.equal(returned,1);
  assert.equal(x.document.querySelector('[data-run-action=pause]').textContent,'Пауза');
  dispose();dispose();
  assert.equal(x.calls.some(call=>call.name==='pause_task_block'),false,'disposing the surface never pauses work');
  assert.equal(x.host.childElementCount,0);
});
test('terminal callback fires once after the final confirmed step and only after busy clears',async t=>{
  const x=setup(t);let dispose,returned=[];
  dispose=x.mountInline(()=>{},false,details=>returned.push({...details,busy:dispose.isBusy()}));await settle();
  x.host.querySelector('[data-run-action=skip]').click();await settle();
  assert.deepEqual(returned,[],'a partial skip does not close the routine');
  x.host.querySelector('[data-run-action=skip]').click();await settle();await settle();
  assert.deepEqual(returned,[{id:x.id,date:x.date,status:'skipped',busy:false}]);
  x.document.defaultView.dispatchEvent(new x.document.defaultView.Event('hanni:calendar-refresh'));await settle();
  assert.equal(returned.length,1,'duplicate external refreshes do not notify twice');
  dispose();
});

test('finishing the last check step reports done after the refreshed run snapshot',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'Готово',dependsOn:[],trackingMode:'check'}]});let dispose,reported=[];
  dispose=x.mountInline(()=>{},false,details=>reported.push({...details,busy:dispose.isBusy()}));await settle();
  x.host.querySelector('[data-run-action=complete]').click();await settle();await settle();
  assert.deepEqual(reported,[{id:x.id,date:x.date,status:'done',busy:false}]);
  dispose();
});

test('an initially terminal run is reported once after mount returns and is not busy',async t=>{
  const x=setup(t,{terminalStatus:'done'});let dispose,returned=[];
  dispose=x.mountInline(()=>{},false,details=>returned.push({...details,busy:dispose.isBusy()}));
  assert.deepEqual(returned,[],'callback is deferred until the caller has received the disposer');
  await settle();
  assert.deepEqual(returned,[{id:x.id,date:x.date,status:'done',busy:false}]);
  dispose();
});

test('a failed read does not report terminal until a retry confirms the run',async t=>{
  const x=setup(t,{terminalStatus:'done'});x.race(()=>{throw Error('Нет ответа');});let reported=0;
  const dispose=x.mountInline(()=>{},false,()=>{reported++;});await settle();
  assert.equal(reported,0);
  assert.match(x.host.querySelector('[role=alert]').textContent,/Нет ответа/);
  x.host.querySelector('[data-run-retry]').click();await settle();
  assert.equal(reported,1);
  dispose();
});

test('external terminal refresh notifies once, while disposal during the read suppresses a stale callback',async t=>{
  const x=setup(t);let reported=0;const dispose=x.mountInline(()=>{},false,()=>{reported++;});await settle();
  x.setTerminal('done');x.deferRead();
  x.document.defaultView.dispatchEvent(new x.document.defaultView.Event('hanni:calendar-refresh'));
  dispose();x.releaseRead();await settle();
  assert.equal(reported,0,'a disposed surface must ignore a late terminal snapshot');
});

test('the full routine disclosure keeps its routine-level label',async t=>{
  const x=setup(t);const dispose=x.mountInline(()=>{});await settle();
  assert.equal(x.host.querySelector('[data-run-plan] summary').textContent,'Вся рутина · 2');
  dispose();
});
test('inline runner exposes read errors and retry without implicitly starting work',async t=>{
  const x=setup(t);x.race(()=>{throw Error('Нет ответа');});
  const dispose=x.mountInline(()=>{});await settle();
  assert.equal(x.document.querySelector('dialog'),null);
  assert.match(x.host.querySelector('[role=alert]').textContent,/Нет ответа/);
  assert.ok(x.host.querySelector('[data-run-retry]'));
  x.host.querySelector('[data-run-retry]').click();await settle();
  assert.ok(x.host.querySelector('[data-run-action=start]'));
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  dispose();
});
test('inline runner stays busy and cannot be collapsed while explicit run creation is pending',async t=>{
  const x=setup(t);x.clear();x.deferWrite();const dispose=x.mountInline(()=>{},true);await settle();
  assert.equal(dispose.isBusy(),true);
  assert.equal(x.host.querySelector('[data-run-close]').disabled,true);
  x.releaseWrite();await settle();
  assert.equal(dispose.isBusy(),false);
  assert.equal(x.host.querySelector('[data-run-close]').disabled,false);
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1,'the explicit mount action is completed without a teardown race');
  dispose();
});
test('inline retry preserves run creation intent but never auto-starts after a failed initial read',async t=>{
  const x=setup(t);x.clear();x.race(()=>{throw Error('Нет ответа');});const dispose=x.mountInline(()=>{},true);await settle();
  assert.match(x.host.querySelector('[role=alert]').textContent,/Нет ответа/);
  assert.equal(x.calls.filter(call=>call.name==='set_ui_state').length,0);
  x.host.querySelector('[data-run-retry]').click();await settle();
  assert.ok(x.host.querySelector('[data-run-action=start]'));
  assert.equal(x.calls.filter(call=>call.name==='set_ui_state').length,1,'retry creates the run requested by the original explicit action');
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0,'retry does not repeat the explicit timer start');
  dispose();
});
test('an observed run deleted remotely stays unavailable instead of being recreated on retry',async t=>{
  const x=setup(t);const dispose=x.mountInline(()=>{});await settle();
  x.clear();x.document.defaultView.dispatchEvent(new x.document.defaultView.Event('hanni:calendar-refresh'));await settle();
  assert.match(x.host.querySelector('[role=alert]').textContent,/больше недоступно/);
  assert.equal(x.host.querySelector('[data-run-action=start]'),null);
  x.host.querySelector('[data-run-retry]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='set_ui_state').length,0,'retry must not recreate a previously observed run');
  assert.equal(x.host.querySelector('[data-run-action=start]'),null);
  dispose();
});
test('inline graph keeps check and track actions explicit and exposes newly unlocked steps',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[
    {title:'Отметка без таймера',dependsOn:[],trackingMode:'check'},
    {title:'Действие с таймером',dependsOn:[0],trackingMode:'track'},
  ]});
  const dispose=x.mountInline(()=>{});await settle();
  assert.equal(x.host.querySelector('[data-run-plan]').open,false);
  assert.equal(x.host.querySelectorAll('[data-plan-step]').length,2);
  assert.equal(x.host.querySelector('[data-run-action=complete]').textContent,'Отметить шаг');
  assert.equal(x.host.querySelector('[data-run-action=start]'),null);
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  x.host.querySelector('[data-run-action=complete]').click();await settle();
  assert.equal(x.record.run.steps[0].status,'done');
  assert.equal(x.host.querySelector('[data-routine-step="1"][data-run-action=start]').textContent,'Начать шаг');
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0,'unlocking a track step does not auto-start it');
  x.host.querySelector('[data-run-action=start]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,1);
  dispose();
});
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

test('graph shows direct actions for available roots and waits for an explicit start',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'First root',dependsOn:[]},{title:'Second root',dependsOn:[]}]});
  x.open(true);await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  assert.equal(x.document.querySelectorAll('[data-run-action=start]').length,2);
  assert.equal(x.document.querySelector('[data-run-plan]').open,false);
  x.document.querySelector('[data-routine-step="1"]').click();await settle();
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
  assert.match(x.document.querySelector('[data-plan-step="1"]').textContent,/После: Prepare/);
  assert.match(x.document.querySelector('[data-plan-step="2"]').textContent,/После: Prepare/);
  assert.match(x.document.querySelector('[data-plan-step="3"]').textContent,/После: Write, Check/);
  assert.equal(x.document.querySelector('[data-routine-step="1"]'),null,'locked steps have no executable control');
  const click=async action=>{x.document.querySelector(`[data-run-action=${action}]`).click();await settle();};
  await click('start');await click('finish');
  assert.equal(x.calls.some(call=>call.name==='pause_task_block'),false,'graph execution leaves other running tasks untouched');
  assert.equal(other.is_active,true);
  assert.equal(x.document.querySelector('[data-routine-step="1"]').disabled,false);
  assert.equal(x.document.querySelector('[data-routine-step="2"]').disabled,false);
  assert.match(x.document.querySelector('[data-run-step-card="2"]').textContent,/Отметка без таймера/);
  x.document.querySelector('[data-run-step="1"][data-run-action=skip]').click();await settle();
  assert.equal(x.record.run.steps[1].status,'skipped');
  assert.equal(x.document.querySelector('[data-run-action="complete"]').textContent,'Отметить шаг');
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
  assert.equal(x.document.querySelector('[data-run-action="complete"]').textContent,'Отметить шаг');
});

test('completing a check step with multiple unlocked successors focuses the first step choice',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[
    {title:'Check',dependsOn:[],trackingMode:'check'},
    {title:'Branch A',dependsOn:[0],trackingMode:'track'},
    {title:'Branch B',dependsOn:[0],trackingMode:'track'},
  ]});
  x.open();await settle();
  x.document.querySelector('[data-run-action="complete"]').click();await settle();
  const available=x.document.querySelectorAll('[data-routine-step]:not(:disabled)');
  assert.equal(available.length,2);
  assert.equal(x.document.activeElement,available[0]);
  assert.equal(available[0].dataset.routineStep,'1');
});

test('graph start revalidates unlocked dependencies before writing',async t=>{
  const x=setup(t,{mode:'graph',graphSteps:[{title:'Root',dependsOn:[]},{title:'Next',dependsOn:[0]}]});
  x.open();await settle();
  x.race(()=>{x.record.run.steps[0].status='done';});
  x.document.querySelector('[data-run-action=start]').click();await settle();
  assert.equal(x.calls.filter(call=>call.name==='start_task_block').length,0);
  assert.match(x.document.querySelector('[role=alert]').textContent,/недоступен|изменился/i);
});

test('quiet routine refresh preserves the current action, focus and expanded plan',async t=>{
  const x=setup(t,{changingForeignSchedule:true});x.open();await settle();
  const action=x.document.querySelector('[data-run-action=start]'),plan=x.document.querySelector('[data-run-plan]');
  action.focus();plan.open=true;
  x.document.defaultView.dispatchEvent(new x.document.defaultView.Event('hanni:calendar-refresh'));await settle();
  assert.equal(x.document.querySelector('[data-run-action=start]'),action);
  assert.equal(x.document.activeElement,action);
  assert.equal(x.document.querySelector('[data-run-plan]'),plan);
  assert.equal(plan.open,true);
  assert.equal(x.calls.some(call=>call.name==='start_task_block'),false);
});

test('a failed initial read can be retried without implicitly starting the timer',async t=>{
  const x=setup(t);x.race(()=>{throw Error('Нет ответа');});x.open(true);await settle();
  assert.equal(x.document.querySelector('[data-dialog-retry]').hidden,false);
  assert.match(x.document.querySelector('[role=alert]').textContent,/Нет ответа/);
  x.document.querySelector('[data-dialog-retry]').click();await settle();
  assert.equal(x.document.querySelector('[data-dialog-retry]').hidden,true);
  assert.ok(x.document.querySelector('[data-run-action=start]'));
  assert.equal(x.calls.some(call=>call.name==='start_task_block'),false);
});
