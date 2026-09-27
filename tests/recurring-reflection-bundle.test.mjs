import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecurringStore,mergeRecurringBundle,recurringItems} from '../src/hanni/js/calendar-recurring-store.js';
const date='2026-01-15';
const plan={id:'plan',kind:'action',mode:'check',title:'Fixture',weekdays:[0,1,2,3,4,5,6],startsOn:'2026-01-01',endsOn:'',createdOn:'2026-01-01',time:'',active:true,required:true,steps:[]};
const answer={ruleOutcome:'kept',restoration:'better',trigger:'Saved answer'};
const day={legacy:false,prompt:'Historical question',snapshot:plan,status:'pending',answer};
const bundle=(core,sidecar)=>({recurring:JSON.stringify(core),reflections:JSON.stringify(sidecar)});
const core={version:1,plans:[plan],days:{}};
const sidecar={version:1,plans:{plan:{legacy:false,enabled:false,prompt:null}},days:{[date]:{plan:day}}};
test('canonical disable and answer override late inline fields and recover a missing day without restoring a plan',()=>{
  const old=structuredClone(core);old.plans[0].reflection={prompt:'Stale question'};
  old.days[date]={plan:{snapshot:{...plan,reflection:{prompt:'Stale question'}},status:'done',reflection:{...answer,trigger:'Stale answer'}}};
  const merged=mergeRecurringBundle(bundle(old,sidecar));
  assert.equal(merged.plans[0].reflection,undefined);
  assert.equal(merged.days[date].plan.snapshot.reflection.prompt,'Historical question');
  assert.deepEqual(merged.days[date].plan.reflection,answer);
  assert.equal(merged.days[date].plan.status,'done');
  const recovered=mergeRecurringBundle(bundle({version:1,plans:[],days:{}},sidecar));
  assert.deepEqual(recovered.plans,[]);
  assert.equal(recovered.days[date].plan._reflectionOnly,true);
  assert.equal(recurringItems(recovered,date)[0].reflectionAnswer.trigger,'Saved answer');
});
test('store uses one native bundle write and both exact CAS tokens; status intentionally restores recovered day',async()=>{
  const initial=bundle(core,sidecar),calls=[];
  const invoke=async(command,args)=>{calls.push({command,args});if(command==='recurring_get_bundle')return initial;if(command==='recurring_save_bundle')return {...initial,recurring:args.value};throw Error(command);};
  const store=createRecurringStore(invoke,{now:()=>new Date(date+'T12:00:00')});
  await store.setStatus('plan','done',date);
  assert.deepEqual(calls.map(c=>c.command),['recurring_get_bundle','recurring_save_bundle']);
  const args=calls[1].args;
  assert.equal(args.expectedRecurring,initial.recurring);assert.equal(args.expectedReflections,initial.reflections);
  assert.equal(args.reflectionChange,null);
  assert.equal(JSON.parse(args.value).days[date].plan._reflectionOnly,undefined);
});
test('answer and explicit disable use separate intents, while ordinary edit cannot imply reflection deletion',async()=>{
  const enabled=structuredClone(sidecar);enabled.plans.plan={legacy:false,enabled:true,prompt:'Current question'};
  const initial=bundle(core,enabled),writes=[];
  const invoke=async(command,args)=>{if(command==='recurring_get_bundle')return initial;if(command==='recurring_save_bundle'){writes.push(args);return {...initial,recurring:args.value};}throw Error(command);};
  const store=createRecurringStore(invoke,{now:()=>new Date(date+'T12:00:00')});
  await store.savePlan({...plan,title:'Edited'},'plan');assert.equal(writes.at(-1).reflectionChange,null);
  await store.setReflection('plan',answer,date);assert.deepEqual(writes.at(-1).reflectionChange,{kind:'answer',id:'plan',date,answer});
  await store.savePlan({...plan,reflection:null},'plan');assert.deepEqual(writes.at(-1).reflectionChange,{kind:'plan',id:'plan',prompt:null});
});
test('second-key CAS rejection stays a visible error and never falls back to generic UI writes',async()=>{
  const calls=[];const initial=bundle(core,sidecar);
  const store=createRecurringStore(async(command)=>{calls.push(command);if(command==='recurring_get_bundle')return initial;throw 'mvp_sync_stale_ui_state';},{now:()=>new Date(date+'T12:00:00')});
  await assert.rejects(store.setStatus('plan','done',date),/Данные изменены/);
  assert.deepEqual(calls,['recurring_get_bundle','recurring_save_bundle']);
});
