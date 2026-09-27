import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRecurringStore,recurringItems,parseRecurring,availableGraphSteps} from '../src/hanni/js/calendar-recurring-store.js';
function setup(){let raw=null,fail=false,now=new Date(2026,8,13,12),sequence=0;const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(fail)throw Error('offline');raw=args.value;};return {store:createRecurringStore(invoke,{now:()=>now,uuid:()=>String(++sequence)}),second:()=>createRecurringStore(invoke,{now:()=>now,uuid:()=>String(++sequence)}),raw:()=>raw,fail:()=>{fail=true;},advance:()=>{now=new Date(2026,8,14,12);}};}
const action={kind:'action',title:'Учебный курс',weekdays:[0,1,2,3,4,5,6],startsOn:'2026-09-13',endsOn:'2026-09-15'};
test('native runtime fixtures match actual frontend activity and chain payloads',async()=>{
  for(const mode of ['activity','chain']){
    let raw=null;
    const store=createRecurringStore(async(command,args)=>{if(command==='get_ui_state')return raw;raw=args.value;},{now:()=>new Date(2026,8,20,12),uuid:()=> 'p'});
    await store.savePlan({kind:'action',title:mode==='chain'?'Chain':'One',mode,weekdays:[0,1,2,3,4,5,6],steps:mode==='chain'?[{title:'First'},{title:'Second'}]:[]});
    await store.ensureRun('p');
    const state=JSON.parse(raw);state.days['2026-09-20'].p.run.createdAt='2026-09-20T00:00:00Z';
    assert.deepEqual(state,JSON.parse(readFileSync(new URL(`./fixtures/recurring-${mode}.json`,import.meta.url),'utf8')));
  }
});
test('fresh profile has no plans or personal seed; quantitative kind rejected',async()=>{const {store}=setup();assert.deepEqual((await store.read()).plans,[]);await assert.rejects(store.savePlan({...action,kind:'norm'}));});
test('course applies only to selected weekdays and inclusive dates',async()=>{const {store}=setup();const {state}=await store.savePlan({...action,weekdays:[0,2]});assert.equal(recurringItems(state,'2026-09-12').length,0);assert.equal(recurringItems(state,'2026-09-13').length,1);assert.equal(recurringItems(state,'2026-09-14').length,0);assert.equal(recurringItems(state,'2026-09-15').length,1);assert.equal(recurringItems(state,'2026-09-16').length,0);});
test('edit preserves historical title/status and updates today only',async()=>{const context=setup(),{store}=context;const {result:id}=await store.savePlan(action);await store.setStatus(id,'done');context.advance();await store.savePlan({...action,title:'Новое название'},id);const state=await store.read();assert.equal(recurringItems(state,'2026-09-13')[0].title,action.title);assert.equal(recurringItems(state,'2026-09-13')[0].status,'done');assert.equal(recurringItems(state,'2026-09-14')[0].title,'Новое название');assert.equal(recurringItems(state,'2026-09-14')[0].status,'pending');});
test('optional reflection is backward compatible and saved as a dated answer without changing completion',async()=>{const x=setup(),{result:id}=await x.store.savePlan({...action,reflection:{prompt:'Мой вопрос'}});assert.equal((await x.store.read()).plans[0].reflection.prompt,'Мой вопрос');await assert.rejects(x.store.setReflection(id,{ruleOutcome:'kept',restoration:'better'},'2026-09-14'));const result=await x.store.setReflection(id,{ruleOutcome:'no_answer',restoration:'same',trigger:'Короткая заметка'});assert.equal(result.state.days['2026-09-13'][id].status,'pending');assert.deepEqual(recurringItems(result.state,'2026-09-13')[0].reflection,{prompt:'Мой вопрос'});assert.deepEqual(recurringItems(result.state,'2026-09-13')[0].reflectionAnswer,{ruleOutcome:'no_answer',restoration:'same',trigger:'Короткая заметка'});x.advance();assert.equal(recurringItems(await x.store.read(),'2026-09-13')[0].reflectionAnswer.ruleOutcome,'no_answer');assert.equal(recurringItems(await x.store.read(),'2026-09-14')[0].reflectionAnswer,undefined);});
test('reflection is limited to a single check action and malformed answers fail closed',async()=>{const {store}=setup();await assert.rejects(store.savePlan({...action,mode:'activity',reflection:{prompt:'Question'}}));const {result:id}=await store.savePlan({...action,reflection:{prompt:'Question'}});await assert.rejects(store.setReflection(id,{ruleOutcome:'maybe',restoration:'better'}));assert.throws(()=>parseRecurring(JSON.stringify({version:1,plans:[{...action,id:'p',reflection:{prompt:'Question'}}],days:{'2026-09-13':{p:{snapshot:{...action,id:'p',reflection:{prompt:'Question'}},status:'pending',reflection:{ruleOutcome:'maybe',restoration:'same',trigger:''}}}}})));});
test('completion and undo preserve answers already saved for that day',async()=>{const {store}=setup(),{result:id}=await store.savePlan({...action,reflection:{prompt:'Question'}});await store.setReflection(id,{ruleOutcome:'kept',restoration:'better',trigger:'Saved'});await store.setStatus(id,'done');assert.equal(recurringItems(await store.read(),'2026-09-13')[0].reflectionAnswer.trigger,'Saved');await store.setStatus(id,'pending');const item=recurringItems(await store.read(),'2026-09-13')[0];assert.equal(item.status,'pending');assert.equal(item.reflectionAnswer.ruleOutcome,'kept');});
test('future observations and mismatched rule/action statuses rejected',async()=>{const {store}=setup();const {result:id}=await store.savePlan({...action,kind:'rule'});await assert.rejects(store.setStatus(id,'kept','2026-09-14'));await assert.rejects(store.setStatus(id,'done'));await store.setStatus(id,'broken');assert.equal(recurringItems(await store.read(),'2026-09-13')[0].status,'broken');await store.setStatus(id,'pending');assert.equal(recurringItems(await store.read(),'2026-09-13')[0].status,'pending');});
test('native failure retains previous snapshot',async()=>{const context=setup();const {result:id}=await context.store.savePlan(action);const raw=context.raw();context.fail();await assert.rejects(context.store.setStatus(id,'done'));assert.equal(context.raw(),raw);});
test('concurrent controllers serialize updates against latest snapshot',async()=>{const context=setup();await Promise.all([context.store.savePlan(action),context.second().savePlan({...action,title:'Вторая'})]);assert.equal((await context.store.read()).plans.length,2);});
test('new plan without start cannot appear before creation',async()=>{const {store}=setup();const {state}=await store.savePlan({...action,startsOn:''});assert.equal(recurringItems(state,'2026-09-12').length,0);});
test('invalid snapshots never silently reset data',()=>{assert.throws(()=>parseRecurring('{'));assert.throws(()=>parseRecurring('{"version":2,"plans":[],"days":{}}'));});

test('a runnable occurrence is stable across retries, definition edits and midnight',async()=>{
  const x=setup();
  const fields={...action,mode:'chain',steps:[{title:'Prepare'},{title:'Practice'},{title:'Review'}]};
  const {result:id}=await x.store.savePlan(fields);
  const first=await x.store.ensureRun(id);
  assert.deepEqual(first.result,{id,date:'2026-09-13'});
  const original=JSON.stringify(first.state.days['2026-09-13'][id]);
  await x.store.savePlan({...fields,title:'Edited',steps:[{title:'Replacement'}]},id);
  assert.equal(JSON.stringify((await x.store.read()).days['2026-09-13'][id]),original);
  x.advance();
  const resumed=await x.store.ensureRun(id);
  assert.deepEqual(resumed.result,first.result);
  assert.equal(Object.keys(resumed.state.days).length,1);
  await assert.rejects(x.store.setStatus(id,'done','2026-09-13'),/выполнение/);
});

test('rules and checkmarks do not acquire an execution, malformed steps are rejected',async()=>{
  const {store}=setup();const {result:id}=await store.savePlan({...action,kind:'rule'});
  await assert.rejects(store.ensureRun(id),/недоступно/);
  await assert.rejects(store.savePlan({...action,kind:'rule',mode:'activity'}),/Правило/);
  await assert.rejects(store.savePlan({...action,mode:'chain',steps:[]}),/шагов/);
});

test('concurrent remote apply between read and write rejects stale recurring snapshot',async()=>{
  let raw=null,changed=false;const remote=JSON.stringify({version:1,plans:[],days:{}});
  const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;assert.equal(args.expectedValue,'');raw=remote;changed=true;if(args.expectedValue!==raw)throw Error('mvp_sync_stale_ui_state');raw=args.value;};
  const store=createRecurringStore(invoke,{now:()=>new Date(2026,8,13,12),uuid:()=> 'local-new'});
  await assert.rejects(store.savePlan(action),/другом устройстве/);assert.equal(changed,true);assert.equal(raw,remote);
});

test('a plan editor baseline permits independent remote plans to merge',async()=>{
  let raw=null;const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;assert.equal(args.expectedValue,raw??'');raw=args.value;};
  const store=createRecurringStore(invoke,{now:()=>new Date(2026,8,13,12),uuid:()=> 'plan-a'});await store.savePlan(action);const expectedPlan=(await store.read()).plans[0];
  const remote=await store.read();remote.plans.push({...expectedPlan,id:'plan-b',title:'Remote B'});raw=JSON.stringify(remote);
  await store.savePlan({...action,title:'Local A'},'plan-a',{expectedPlan});assert.deepEqual((await store.read()).plans.map(plan=>plan.title),['Local A','Remote B']);
});

test('graph runs preserve check, optional and dependency metadata and unlock joins after done or skipped',async()=>{
  const {store}=setup(),steps=[
    {title:'A',dependsOn:[],trackingMode:'track',optional:false},
    {title:'B',dependsOn:[0],trackingMode:'track',optional:false},
    {title:'C',dependsOn:[0],trackingMode:'check',optional:true},
    {title:'D',dependsOn:[1,2],trackingMode:'track',optional:false},
  ];
  const {result:id,state:saved}=await store.savePlan({...action,mode:'graph',steps});
  const {state:started}=await store.ensureRun(id),record=started.days['2026-09-13'][id];
  assert.deepEqual(record.snapshot.steps,steps);
  assert.deepEqual(record.run.steps.map(({title,dependsOn,trackingMode,optional})=>({title,dependsOn,trackingMode,optional})),steps);
  assert.deepEqual(availableGraphSteps(record.snapshot,record.run),[0]);
  record.run.steps[0].status='skipped';
  assert.deepEqual(availableGraphSteps(record.snapshot,record.run),[1,2]);
  record.run.steps[1].status='done';
  assert.deepEqual(availableGraphSteps(record.snapshot,record.run),[2]);
  record.run.steps[2].status='done';
  assert.deepEqual(availableGraphSteps(record.snapshot,record.run),[3]);
  assert.equal(saved.plans[0].steps[3].dependsOn.length,2);
});

test('graph validation rejects invalid, duplicate, self and cyclic dependencies and more than 50 nodes',async()=>{
  const {store}=setup(),base={...action,mode:'graph'};
  for(const steps of [
    [{title:'Missing',dependsOn:[1]}],
    [{title:'Self',dependsOn:[0]}],
    [{title:'Duplicate',dependsOn:[]},{title:'Duplicate edges',dependsOn:[0,0]}],
    [{title:'A',dependsOn:[1]},{title:'B',dependsOn:[0]}],
    [{title:'Bad mode',dependsOn:[],trackingMode:'timer'}],
    [{title:'Bad optional flag',dependsOn:[],optional:'yes'}],
    Array.from({length:51},(_,index)=>({title:`Step ${index}`,dependsOn:[]})),
  ]) await assert.rejects(store.savePlan({...base,steps}));
  await assert.rejects(store.savePlan({...base,steps:[{title:'No dependencies',dependsOn:null}]}));
});

test('editing graph schedule fields keeps structure in both plan and original run snapshot',async()=>{
  const {store}=setup(),steps=[{title:'Root',dependsOn:[],trackingMode:'check',optional:false},{title:'Leaf',dependsOn:[0],trackingMode:'track',optional:true}];
  const {result:id}=await store.savePlan({...action,mode:'graph',steps});await store.ensureRun(id);
  await store.savePlan({...action,title:'Renamed graph',mode:'graph',steps:undefined,weekdays:[1,2]},id);
  const state=await store.read(),today=state.days['2026-09-13'][id];
  assert.deepEqual(state.plans[0].steps,steps);
  assert.deepEqual(today.snapshot.steps,steps);
  assert.deepEqual(today.run.steps.map(step=>step.dependsOn),[[],[0]]);
  assert.equal(state.plans[0].title,'Renamed graph');
});

test('changing a graph plan to one action preserves the already-started run snapshot',async()=>{
  const {store}=setup(),steps=[{title:'Root',dependsOn:[],trackingMode:'check',optional:false},{title:'Leaf',dependsOn:[0],trackingMode:'track',optional:true}];
  const {result:id}=await store.savePlan({...action,mode:'graph',steps});
  await store.ensureRun(id);
  const before=(await store.read()).days['2026-09-13'][id];
  await store.savePlan({...action,title:'One future action',mode:'activity',steps:[]},id);
  const after=(await store.read()).days['2026-09-13'][id];
  assert.equal((await store.read()).plans[0].mode,'activity');
  assert.deepEqual(after.snapshot,before.snapshot);
  assert.deepEqual(after.run,before.run);
});

test('stored graph run whose dependencies differ from its snapshot fails closed',()=>{
  const source={version:1,plans:[],days:{'2026-09-13':{graph:{snapshot:{...action,id:'graph',mode:'graph',steps:[{title:'A',dependsOn:[]},{title:'B',dependsOn:[0]}]},status:'pending',run:{steps:[{title:'A',dependsOn:[],status:'pending'},{title:'B',dependsOn:[],status:'pending'}]}}}}};
  assert.throws(()=>parseRecurring(JSON.stringify(source)),/Не удалось прочитать/);
});
