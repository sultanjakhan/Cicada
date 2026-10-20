import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRecurringStore,recurringItems,parseRecurring,availableGraphSteps} from '../src/hanni/js/calendar-recurring-store.js';
function setup(){let raw=null,fail=false,now=new Date(2026,8,13,12),sequence=0;const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;if(fail)throw Error('offline');raw=args.value;};return {store:createRecurringStore(invoke,{now:()=>now,uuid:()=>String(++sequence)}),second:()=>createRecurringStore(invoke,{now:()=>now,uuid:()=>String(++sequence)}),raw:()=>raw,fail:()=>{fail=true;},advance:()=>{now=new Date(2026,8,14,12);}};}
const action={kind:'action',title:'Учебный курс',weekdays:[0,1,2,3,4,5,6],startsOn:'2026-09-13',endsOn:'2026-09-15'};
const counted={...action,mode:'count',dailyTarget:3};
async function countWrite(store,id,value,day='2026-09-13',item=null){item??=recurringItems(await store.read(),day).find(p=>p.id===id);return store.setCount(id,value,day,{expectedCount:item.completedCount,expectedTarget:item.dailyTarget,expectedStatus:item.status});}
test('a085 target3 marks/correction/reload retain one routine, local days and required metadata',async()=>{
  const x=setup(),{result:id}=await x.store.savePlan({...counted,required:false});
  for(let value=1;value<=4;value++){
    await countWrite(x.store,id,value);const item=recurringItems(await x.second().read(),'2026-09-13')[0];
    assert.equal(item.completedCount,value);assert.equal(item.remainingCount,Math.max(0,3-value));assert.equal(item.required,false);
  }
  await countWrite(x.store,id,2);const prior=(await x.store.read()).days['2026-09-13'];x.advance();
  let next=recurringItems(await x.second().read(),'2026-09-14')[0];assert.equal(next.completedCount,0);assert.equal(next.remainingCount,3);
  await countWrite(x.store,id,1,'2026-09-14');const state=await x.store.read();assert.equal(state.plans.length,1);assert.equal(state.plans[0].id,id);assert.deepEqual(state.days['2026-09-13'],prior);
  await x.store.savePlan({...counted,dailyTarget:5},id);assert.equal(recurringItems(await x.store.read(),'2026-09-14')[0].dailyTarget,3,'started day snapshot stays reviewed');
});
test('a085 stale count/target/status, malformed input and failed writes preserve saved state',async()=>{
  const x=setup(),{result:id}=await x.store.savePlan(counted);const observed=recurringItems(await x.store.read(),'2026-09-13')[0];
  await countWrite(x.store,id,1);let before=x.raw();await assert.rejects(countWrite(x.second(),id,1,'2026-09-13',observed),/уже отмечена/);assert.equal(x.raw(),before);
  for(const count of [-1,1.5,NaN,Infinity,1000001]){await assert.rejects(countWrite(x.store,id,count));assert.equal(x.raw(),before);}
  for(const dailyTarget of [0,-1,1.5,1001,NaN])await assert.rejects(x.store.savePlan({...counted,dailyTarget}));
  await assert.rejects(x.store.setStatus(id,'done'),/количество/);await assert.rejects(countWrite(x.store,id,2,'2026-09-14'));
  x.fail();await assert.rejects(countWrite(x.store,id,2),/offline/);assert.equal(x.raw(),before);
});
test('a085 legacy done is one completion without read migration; malformed counted snapshots fail closed',async()=>{
  const x=setup(),{result:id}=await x.store.savePlan(action);await x.store.setStatus(id,'done');const raw=x.raw();const item=recurringItems(await x.store.read(),'2026-09-13')[0];
  assert.equal(item.dailyTarget,1);assert.equal(item.completedCount,1);assert.equal(item.remainingCount,0);assert.equal(x.raw(),raw);assert.deepEqual(parseRecurring(raw),JSON.parse(raw));
  await countWrite(x.store,id,0);assert.equal(recurringItems(await x.store.read(),'2026-09-13')[0].remainingCount,1);
  for(const change of [{completedCount:-1},{completedCount:1,status:'pending'},{completedCount:1.5}]){const bad=JSON.parse(x.raw());Object.assign(bad.days['2026-09-13'][id],change);assert.throws(()=>parseRecurring(JSON.stringify(bad)));}
});
test('a085 CAS remote failure and observed target change do not retry or overwrite',async()=>{
  let raw=null,writes=0,inject=false;const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;writes++;if(inject){raw=JSON.stringify({...JSON.parse(raw),foreign:true});throw Error('mvp_sync_stale_ui_state');}assert.equal(args.expectedValue,raw??'');raw=args.value;};
  const store=createRecurringStore(invoke,{now:()=>new Date('2026-09-13T12:00:00'),uuid:()=> 'same-id'});await store.savePlan(counted);const old=recurringItems(await store.read(),'2026-09-13')[0];
  await store.savePlan({...counted,dailyTarget:4},'same-id');await assert.rejects(countWrite(store,'same-id',1,'2026-09-13',old),/уже отмечена/);assert.equal(writes,2);
  inject=true;await assert.rejects(countWrite(store,'same-id',1),/другом устройстве/);assert.equal(writes,3);assert.equal(JSON.parse(raw).foreign,true);assert.equal(JSON.parse(raw).days['2026-09-13'],undefined);
});
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
test('future observations and mismatched rule/action statuses rejected',async()=>{const {store}=setup();const {result:id}=await store.savePlan({...action,kind:'rule'});await assert.rejects(store.setStatus(id,'kept','2026-09-14'));await assert.rejects(store.setStatus(id,'done'));await store.setStatus(id,'broken');assert.equal(recurringItems(await store.read(),'2026-09-13')[0].status,'broken');await store.setStatus(id,'pending');assert.equal(recurringItems(await store.read(),'2026-09-13')[0].status,'pending');});
test('native failure retains previous snapshot',async()=>{const context=setup();const {result:id}=await context.store.savePlan(action);const raw=context.raw();context.fail();await assert.rejects(context.store.setStatus(id,'done'));assert.equal(context.raw(),raw);});
test('concurrent controllers serialize updates against latest snapshot',async()=>{const context=setup();await Promise.all([context.store.savePlan(action),context.second().savePlan({...action,title:'Вторая'})]);assert.equal((await context.store.read()).plans.length,2);});
test('queued quick marks check their expected status against the latest state',async()=>{
  const context=setup(),{store}=context;const {result:id}=await store.savePlan(action);
  const results=await Promise.allSettled([
    store.setStatus(id,'done','2026-09-13',{expectedStatus:'pending'}),
    context.second().setStatus(id,'skipped','2026-09-13',{expectedStatus:'pending'}),
  ]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  assert.match(results[1].reason.message,/уже отмечена/);
  assert.equal((await store.read()).days['2026-09-13'][id].status,'done');
});
test('explicit manager edits can still replace and clear existing marks',async()=>{
  const {store}=setup();const {result:id}=await store.savePlan(action);
  for(const status of ['skipped','done','pending']){
    await store.setStatus(id,status);
    assert.equal((await store.read()).days['2026-09-13'][id].status,status);
  }
});
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

test('resuming an explicit saved occurrence keeps its date after reload with another unfinished day', async()=>{
  const snapshot={...action,id:'fictional-repeat',mode:'chain',active:true,createdOn:'2026-09-13',steps:[{title:'First'},{title:'Second'}]};
  const occurrence=(firstStatus)=>({snapshot:structuredClone(snapshot),status:'pending',run:{steps:[{title:'First',status:firstStatus},{title:'Second',status:'pending'}],createdAt:'2026-09-13T12:00:00Z'}});
  for(const dates of [['2026-09-13','2026-09-14'],['2026-09-14','2026-09-13']]){
    const days=Object.fromEntries(dates.map(day=>[day,{[snapshot.id]:occurrence(day==='2026-09-14'?'done':'pending')} ]));
    days['2026-09-12']={[snapshot.id]:{snapshot:structuredClone(snapshot),status:'done'}};
    let raw=JSON.stringify({version:1,plans:[snapshot],days});
    const before=JSON.parse(raw);
    const invoke=async(command,args)=>{if(command==='get_ui_state')return raw;assert.equal(args.expectedValue,raw);raw=args.value;};
    const store=createRecurringStore(invoke,{now:()=>new Date(2026,8,14,12)});
    const resumed=await store.ensureRun(snapshot.id,'2026-09-14');
    assert.deepEqual(resumed.result,{id:snapshot.id,date:'2026-09-14'});
    assert.deepEqual(JSON.parse(raw),before,'resuming preserves both runs, their progress, completion history and definition');
  }
});
