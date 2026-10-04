import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountTaskResultReview } from '../src/hanni/js/task-result-review.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture() {
  const dom = new JSDOM('<main></main>'), doc = dom.window.document, calls = [], drafts = new Map();
  let projection = {taskId:'fixture-task',taskRevision:3,resultVersion:2,content:'Synthetic immutable result',reviewState:'awaiting_review',history:[]};
  let mode = 'acknowledged', resolve, count=0;
  const adapter = {
    read:async()=>structuredClone(projection),
    submit:async request=> {
      calls.push(request);
      if(mode==='hold')await new Promise(r=>{resolve=r;});
      if(mode==='conflict')throw Object.assign(Error('stale'),{status:409});
      if(mode==='unknown')throw Error('connection unavailable');
      if(mode==='queued')return {kind:'queued'};
      projection={...projection,taskRevision:projection.taskRevision+1,reviewState:request.action==='accept'?'accepted':'awaiting_dispatch',history:[...projection.history,{action:request.action,resultVersion:request.result_version,comment:request.comment}]};
      return {kind:'acknowledged',operation_id:request.operation_id,projection:structuredClone(projection)};
    },
  };
  const mount = () => mountTaskResultReview(doc.querySelector('main'),{taskId:'fixture-task',adapter,drafts,operationId:()=>`fixture-op-${++count}`});
  const button = text => [...doc.querySelectorAll('button')].find(b=>b.textContent===text);
  const comment = text => {const input=doc.querySelector('textarea');input.value=text;input.dispatchEvent(new dom.window.Event('input'));};
  return {dom,doc,calls,drafts,mount,button,comment,mode:value=>{mode=value;},release:()=>resolve(),change:()=>{projection={...projection,taskRevision:5,resultVersion:3,content:'New immutable result'};},projection:()=>projection,running:()=>{projection={...projection,taskRevision:projection.taskRevision+1,reviewState:'running'};}};
}

test('accept binds exact task/result revisions and shows persisted accepted history',async()=>{
 const x=fixture(),stop=x.mount();await tick();
 assert.match(x.doc.body.textContent,/ревизия 2/);x.button('Принять').click();await tick();
 assert.deepEqual(x.calls[0],{task_id:'fixture-task',expected_revision:3,result_version:2,operation_id:'fixture-op-1',action:'accept'});
 assert.equal(x.projection().reviewState,'accepted');assert.match(x.doc.querySelector('ol').textContent,/accept.*2/);
 assert.equal(x.button('Доработать').disabled,true);stop();x.dom.window.close();
});
test('rework requires comment and distinguishes queued, awaiting dispatch and running',async()=>{
 const x=fixture();let stop=x.mount();await tick();x.button('Доработать').click();assert.equal(x.calls.length,0);
 x.comment('Keep exact revision');x.mode('queued');x.button('Доработать').click();await tick();
 assert.match(x.doc.querySelector('[role=status]').textContent,/локальной очереди/);assert.equal(x.projection().reviewState,'awaiting_review');
 assert.equal(x.button('Принять').disabled,true);assert.equal(x.button('Отменить решение').disabled,true);stop();stop=x.mount();await tick();assert.equal(x.button('Принять').disabled,true);assert.match(x.doc.querySelector('[role=status]').textContent,/локальной очереди/);
 x.mode('acknowledged');x.button('Повторить отправку').click();await tick();assert.deepEqual(x.calls[0],x.calls[1]);
 assert.match(x.doc.body.textContent,/работа ещё не началась/);assert.match(x.doc.querySelector('ol').textContent,/Keep exact revision/);
 assert.equal(x.projection().reviewState,'awaiting_dispatch');x.running();x.button('Обновить результат').click();await tick();assert.match(x.doc.body.textContent,/подтверждено исполнителем/);stop();x.dom.window.close();
});
test('stale409 requires explicit refresh and keeps comment without auto rebase',async()=>{
 const x=fixture(),stop=x.mount();await tick();x.comment('Original comment');x.mode('conflict');x.change();x.button('Доработать').click();await tick();
 assert.match(x.doc.querySelector('[role=status]').textContent,/409/);assert.equal(x.doc.querySelector('textarea').value,'Original comment');assert.equal(x.button('Принять').disabled,true);
 x.button('Обновить результат').click();await tick();assert.equal(x.calls.length,1);assert.match(x.doc.body.textContent,/ревизия 3/);
 x.mode('acknowledged');x.button('Доработать').click();await tick();assert.equal(x.calls[1].result_version,3);assert.equal(x.calls[1].expected_revision,5);assert.notEqual(x.calls[0].operation_id,x.calls[1].operation_id);stop();x.dom.window.close();
});
test('repeated click and close while pending cannot duplicate or cancel submitted work',async()=>{
 const x=fixture(),stop=x.mount();await tick();x.mode('hold');x.button('Принять').click();x.button('Принять').click();assert.equal(x.calls.length,1);assert.throws(()=>stop.beforeClose());
 x.release();await tick();stop();x.dom.window.close();
});
test('cancel and close preserve unsubmitted draft across remount',async()=>{
 const x=fixture();let stop=x.mount();await tick();x.comment('Retained draft');x.button('Отменить решение').click();assert.equal(x.calls.length,0);assert.doesNotThrow(()=>stop.beforeClose());stop();stop=x.mount();await tick();assert.equal(x.doc.querySelector('textarea').value,'Retained draft');stop();x.dom.window.close();
});
test('unknown outcome retries immutable request with same operation after refresh/remount',async()=>{
 const x=fixture();let stop=x.mount();await tick();x.comment('Same immutable payload');x.mode('unknown');x.button('Доработать').click();await tick();stop();stop=x.mount();await tick();x.change();x.button('Обновить результат').click();await tick();assert.equal(x.button('Принять').disabled,true);
 x.mode('queued');x.button('Повторить отправку').click();await tick();assert.deepEqual(x.calls[0],x.calls[1]);assert.equal(x.calls.length,2);stop();x.dom.window.close();
});

test('forced component disposal retains in-flight operation without claiming a receipt',async()=>{
 const x=fixture();let stop=x.mount();await tick();x.comment('In-flight draft');x.mode('hold');x.button('Доработать').click();stop();x.release();await tick();stop=x.mount();await tick();assert.equal(x.doc.querySelector('textarea').value,'In-flight draft');assert.equal(x.button('Принять').disabled,true);assert.match(x.doc.querySelector('[role=status]').textContent,/неизвестен/);x.mode('queued');x.button('Повторить отправку').click();await tick();assert.deepEqual(x.calls[0],x.calls[1]);stop();x.dom.window.close();
});

function overlappingFixture() {
 const dom=new JSDOM('<main></main>'),doc=dom.window.document,drafts=new Map(),calls=[];
 const initial={taskId:'overlap',taskRevision:3,resultVersion:2,content:'Synthetic result',reviewState:'awaiting_review',history:[]};
 let current=structuredClone(initial),lateResolve,lateReject;
 const adapter={read:async()=>structuredClone(current),submit:async request=>{
   calls.push(structuredClone(request));
   if(calls.length===1)return new Promise((resolve,reject)=>{lateResolve=resolve;lateReject=reject;});
   current={...initial,taskRevision:4,reviewState:'awaiting_dispatch',history:[{action:'rework',resultVersion:2,comment:request.comment}]};
   return {kind:'acknowledged',operation_id:request.operation_id,projection:structuredClone(current)};
 }};
 const mount=()=>mountTaskResultReview(doc.querySelector('main'),{taskId:'overlap',adapter,drafts,operationId:()=> 'overlap-op-1'});
 const button=text=>[...doc.querySelectorAll('button')].find(b=>b.textContent===text);
 const edit=text=>{const input=doc.querySelector('textarea');input.value=text;input.dispatchEvent(new dom.window.Event('input'));};
 return {dom,doc,drafts,calls,mount,button,edit,lateSuccess:()=>lateResolve({kind:'acknowledged',operation_id:'overlap-op-1',projection:structuredClone(current)}),lateFailure:()=>lateReject(Error('old request unknown')),newResult:()=>{current={...initial,taskRevision:5,resultVersion:3};}};
}

test('late disposed completion cannot resurrect pending or comment after newer success and close',async()=>{
 for(const completion of ['lateSuccess','lateFailure']){
  const x=overlappingFixture();const old=x.mount();await tick();x.edit('Old comment');x.button('Доработать').click();old();
  let next=x.mount();await tick();x.button('Повторить отправку').click();await tick();assert.deepEqual(x.calls[0],x.calls[1]);
  assert.equal(x.drafts.get('overlap').pending,null);assert.equal(x.drafts.get('overlap').comment,'');next();
  x[completion]();await tick();assert.equal(x.drafts.get('overlap').pending,null);assert.equal(x.drafts.get('overlap').comment,'');
  next=x.mount();await tick();assert.equal(x.doc.querySelector('textarea').value,'');assert.equal(x.button('Повторить отправку').hidden,true);next();x.dom.window.close();
 }
});

test('late old completion and repeated old dispose preserve edits made after newer success',async()=>{
 const x=overlappingFixture(),old=x.mount();await tick();x.edit('Old comment');x.button('Доработать').click();old();
 let next=x.mount();await tick();x.button('Повторить отправку').click();await tick();x.newResult();x.button('Обновить результат').click();await tick();x.edit('New revision draft');
 x.lateSuccess();await tick();old();assert.equal(x.drafts.get('overlap').pending,null);assert.equal(x.drafts.get('overlap').comment,'New revision draft');next();
 next=x.mount();await tick();assert.equal(x.doc.querySelector('textarea').value,'New revision draft');assert.equal(x.button('Повторить отправку').hidden,true);next();x.dom.window.close();
});

test('superseded mounted lifecycle cannot overwrite the current task session',async()=>{
 const x=overlappingFixture(),old=x.mount();await tick();x.edit('Original');x.button('Доработать').click();
 const next=x.mount();await tick();const buttons=[...x.doc.querySelectorAll('button')];buttons.filter(b=>b.textContent==='Повторить отправку').at(-1).click();await tick();
 x.newResult();buttons.filter(b=>b.textContent==='Обновить результат').at(-1).click();await tick();
 const input=[...x.doc.querySelectorAll('textarea')].at(-1);input.value='Active new draft';input.dispatchEvent(new x.dom.window.Event('input'));
 x.lateSuccess();await tick();old();assert.equal(x.drafts.get('overlap').pending,null);assert.equal(x.drafts.get('overlap').comment,'Active new draft');next();x.dom.window.close();
});
