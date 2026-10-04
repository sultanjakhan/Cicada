import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCalendarReviewSource,isCalendarReviewAbsent} from '../src/hanni/js/calendar-review-source.js';
import {mountTaskResultReview} from '../src/hanni/js/task-result-review.js';
import {readNativeTaskObservations,nativeTaskKey,dashboardFromNativeTasks} from '../src/hanni/js/native-task-observations.js';
import {taskProgress} from '../src/hanni/js/task-progress.js';
import {mountDashboardAiWork} from '../src/hanni/js/dashboard-ai-work.js';

const id='native-fixture-id',record={source_type:'note',source_id:id,title:'Same title as another task'};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({nativeReview=false}={}) {
  const state=new Map(),calls=[],receipts=new Map();let count=0,failure=null,mode='acknowledged';
  const task={id,version:7,binding:{sourceNamespace:'00000000-0000-4000-8000-000000000001',sourceType:'note',sourceId:id,taskKey:'fixture-shared-key'},review:{resultVersion:2,state:'awaiting_review',intentId:null},results:[{version:2,content:'Synthetic immutable result'}],history:[]};
  const projection=()=>({taskId:id,taskRevision:3,resultVersion:1,content:'Legacy result',reviewState:'awaiting_review',history:[]});
  const invoke=async(name,args)=>{
    calls.push([name,structuredClone(args)]);
    if(name==='get_ui_state')return state.get(args.key)??null;
    if(name==='set_ui_state'){
      if(Object.hasOwn(args,'expectedValue'))assert.equal(state.get(args.key)??null,args.expectedValue);
      state.set(args.key,args.value);return;
    }
    if(name==='read_task_result_review'||name==='recover_task_result_review')return {projection:projection(),pending:[]};
    if(name==='shared_task_command'){
      const {operationId,command,arguments:input}=args.input;
      assert.equal(input.taskId,id);
      if(command==='get'){if(failure)throw failure;return structuredClone(task);}
      assert.equal(command,'review');
      if(receipts.has(operationId))return structuredClone(receipts.get(operationId));
      if(mode==='conflict')return {isError:true,status:409,code:'version_conflict',current:structuredClone(task)};
      if(mode==='unknown')throw Error('Synthetic connection failure');
      assert.equal(input.expectedVersion,task.version);assert.equal(input.resultVersion,task.review.resultVersion);
      task.version++;task.review.state=input.decision==='accept'?'accepted':'awaiting_dispatch';
      task.history.push({action:input.decision,resultVersion:input.resultVersion,comment:input.comment});
      const receipt={operationId,acknowledged:true};receipts.set(operationId,receipt);
      if(mode==='unknownApplied')throw Error('Synthetic lost receipt');
      return structuredClone(receipt);
    }
    throw Error('Unexpected synthetic command '+name);
  };
  const source=createCalendarReviewSource(invoke,{nativeReview,operationId:()=>`00000000-0000-4000-8000-${String(++count).padStart(12,'0')}`});
  return {source,invoke,state,calls,task,fail:value=>{failure=value;},mode:value=>{mode=value;},reviews:()=>calls.filter(([name,args])=>name==='shared_task_command'&&args.input.command==='review').map(([,args])=>args.input),legacy:()=>calls.filter(([name])=>name.includes('task_result_review'))};
}

test('shared source reads and prepares exact native identity without a title join or implicit mutation',async()=>{
  const x=fixture({nativeReview:true}),value=await x.source.read(id),prepared=await x.source.prepare(record);
  assert.equal(value.taskId,id);assert.equal(value.content,'Synthetic immutable result');assert.equal(value.taskRevision,7);
  assert.equal(prepared.taskId,id);assert.ok(prepared.drafts instanceof Map);assert.equal(x.legacy().length,0);
  assert.equal(x.calls.some(([name])=>name==='set_ui_state'),false);assert.equal(x.reviews().length,0);
  const before=x.calls.length;
  await assert.rejects(x.source.read(123),/Exact native task/);
  await assert.rejects(x.source.prepare({...record,source_id:123}),/Exact native task/);
  await assert.rejects(x.source.prepare({...record,readonly:true}),/Editable native/);
  await assert.rejects(x.source.prepare({...record,source_type:'event'}),/Editable native/);
  assert.equal(x.calls.length,before);
  x.task.binding.sourceId='different-native-task';
  await assert.rejects(x.source.read(id),/Invalid shared task identity/);assert.equal(x.legacy().length,0);
});

test('only the two explicit shared absence responses permit the existing opted-in prototype fallback',async()=>{
  for(const code of ['shared_task_not_found','no_review_result'])for(const enabled of [false,true]) {
    const x=fixture({nativeReview:enabled}),error=Object.assign(Error(code),{status:404,code});x.fail(error);
    assert.equal(isCalendarReviewAbsent(error),true);
    if(enabled){assert.equal((await x.source.read(id)).content,'Legacy result');assert.equal((await x.source.prepare(record)).taskId,id);assert.equal(x.legacy().length,2);}
    else{await assert.rejects(x.source.read(id),error);await assert.rejects(x.source.prepare(record),error);assert.equal(x.legacy().length,0);}
  }
});

test('unavailable, unauthorized, malformed and unrelated 404 responses never select another result authority',async()=>{
  for(const error of [Error('offline'),Object.assign(Error('denied'),{status:403,code:'shared_tasks_disabled'}),Object.assign(Error('prototype disabled'),{status:403,code:'review_prototype_disabled'}),Object.assign(Error('server'),{status:500,code:'unavailable'}),Object.assign(Error('unknown'),{status:404,code:'different_resource'})]) {
    const x=fixture({nativeReview:true});x.fail(error);assert.equal(isCalendarReviewAbsent(error),false);
    await assert.rejects(x.source.read(id),error);await assert.rejects(x.source.prepare(record),error);assert.equal(x.legacy().length,0);
  }
  const x=fixture({nativeReview:true});x.task.id='wrong-task';
  await assert.rejects(x.source.prepare(record),/Invalid shared task identity/);assert.equal(x.legacy().length,0);
});

test('transient unavailable preparation retries the shared authority without prototype fallback or a decision',async()=>{
  const x=fixture({nativeReview:true});x.fail(Error('offline'));await assert.rejects(x.source.prepare(record),/offline/);
  x.fail(null);const prepared=await x.source.prepare(record);assert.equal((await prepared.adapter.read(id)).content,'Synthetic immutable result');
  assert.equal(x.legacy().length,0);assert.equal(x.reviews().length,0);
});

function ui(x,prepared){
  const dom=new JSDOM('<main></main>'),doc=dom.window.document;doc.documentElement.lang='ru';
  const stop=mountTaskResultReview(doc.querySelector('main'),prepared);
  return {dom,doc,stop,button:label=>[...doc.querySelectorAll('button')].find(button=>button.textContent===label),comment:value=>{const input=doc.querySelector('textarea');input.value=value;input.dispatchEvent(new dom.window.Event('input'));}};
}

test('real producer adapter plus existing review UI retain the original operation and payload across failed send and remount',async()=>{
  const x=fixture();let screen=ui(x,await x.source.prepare(record));await settle();
  screen.comment('Keep exact feedback');x.mode('unknown');screen.button('Доработать').click();await settle();
  assert.equal(x.reviews().length,1);assert.match(screen.doc.querySelector('[role=status]').textContent,/неизвестен/);
  screen.stop();screen.dom.window.close();screen=ui(x,await x.source.prepare(record));await settle();
  assert.equal(screen.doc.querySelector('textarea').value,'Keep exact feedback');assert.equal(screen.button('Принять').disabled,true);
  x.mode('acknowledged');screen.button('Повторить отправку').click();await settle();
  assert.deepEqual(x.reviews()[0],x.reviews()[1]);assert.equal(x.task.review.state,'awaiting_dispatch');
  assert.match(screen.doc.body.textContent,/работа ещё не началась/);assert.equal(x.legacy().length,0);
  screen.stop();screen.dom.window.close();
});

test('replayed old receipt renders a fresh result and cannot accept the newer result',async()=>{
  const x=fixture();let screen=ui(x,await x.source.prepare(record));await settle();
  x.mode('unknownApplied');screen.button('Принять').click();await settle();screen.stop();screen.dom.window.close();
  x.task.version++;x.task.results.push({version:3,content:'New synthetic result'});x.task.review={resultVersion:3,state:'awaiting_review',intentId:null};
  screen=ui(x,await x.source.prepare(record));await settle();x.mode('acknowledged');screen.button('Повторить отправку').click();await settle();
  assert.deepEqual(x.reviews()[0],x.reviews()[1]);assert.equal(x.reviews()[1].arguments.resultVersion,2);
  assert.equal(x.task.review.state,'awaiting_review');assert.equal(x.task.review.resultVersion,3);
  assert.match(screen.doc.body.textContent,/New synthetic result/);assert.equal(screen.button('Принять').disabled,false);
  screen.stop();screen.dom.window.close();
});

test('409 keeps feedback through reopen, retires the stale decision and requires an explicit fresh decision',async()=>{
  const x=fixture();let screen=ui(x,await x.source.prepare(record));await settle();
  screen.comment('Preserved conflict feedback');x.mode('conflict');screen.button('Доработать').click();await settle();
  assert.match(screen.doc.querySelector('[role=status]').textContent,/409/);assert.equal(screen.button('Принять').disabled,true);
  screen.stop();screen.dom.window.close();x.task.version++;screen=ui(x,await x.source.prepare(record));await settle();
  assert.equal(screen.doc.querySelector('textarea').value,'Preserved conflict feedback');assert.equal(x.reviews().length,1);
  x.mode('acknowledged');screen.button('Доработать').click();await settle();
  assert.notEqual(x.reviews()[0].operationId,x.reviews()[1].operationId);assert.equal(x.reviews()[1].arguments.expectedVersion,8);
  assert.equal(x.reviews()[1].arguments.comment,'Preserved conflict feedback');screen.stop();screen.dom.window.close();
});

test('running review is authoritative progress with no fabricated report; unavailable reread keeps known review ownership',async()=>{
  const x=fixture();x.task.review.state='running';
  const first=await readNativeTaskObservations([record],x.invoke,{readReview:id=>x.source.read(id)}),ctx=first.contexts.get(nativeTaskKey(record));
  assert.equal(ctx.review.reviewState,'running');assert.equal(ctx.reviewReadError,undefined);
  const dashboard=dashboardFromNativeTasks([record],first.contexts);assert.equal(dashboard.tasks[0].reviewState,'running');assert.equal(dashboard.tasks[0].needsUser,false);assert.deepEqual(dashboard.reports,[]);
  assert.match(taskProgress({review:ctx.review,language:'ru'}).label,/подтверждено исполнителем/);
  x.fail(Error('offline'));const second=await readNativeTaskObservations([record],x.invoke,{readReview:id=>x.source.read(id),previousContexts:first.contexts});
  assert.equal(second.contexts.get(nativeTaskKey(record)).reviewReadError,true);assert.equal(second.contexts.get(nativeTaskKey(record)).review.reviewState,'running');
  const absent=fixture();absent.fail(Object.assign(Error('unshared'),{status:404,code:'shared_task_not_found'}));
  const normal=await readNativeTaskObservations([record],absent.invoke,{readReview:id=>absent.source.read(id)});
  assert.equal(normal.contexts.get(nativeTaskKey(record)).reviewReadError,false);assert.deepEqual(dashboardFromNativeTasks([record],normal.contexts),{tasks:[],reports:[]});
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main'),stop=mountDashboardAiWork(host,{read:async()=>dashboard});await settle();
  assert.match(host.querySelector('.dashboard-ai-work__result').textContent,/запуск подтверждён исполнителем/);
  assert.match(host.querySelector('.dashboard-ai-work__notice').textContent,/Текущее выполнение не подтверждено/);
  assert.equal(host.querySelector('.dashboard-ai-work__details'),null);stop();dom.window.close();
});

test('a bound task with no result stays an ordinary task without claiming authority failure',async()=>{
  const x=fixture();x.task.review=null;
  await assert.rejects(x.source.prepare(record),error=>error.status===404&&error.code==='no_review_result'&&isCalendarReviewAbsent(error));
  assert.equal(x.legacy().length,0);assert.equal(x.reviews().length,0);
});
