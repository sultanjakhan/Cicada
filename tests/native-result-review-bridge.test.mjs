import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createNativeResultReviewAdapter, prepareNativeResultReview } from '../src/hanni/js/native-result-review-adapter.js';
import { mountTaskWorkflow } from '../src/hanni/js/task-workflow-view.js';
const executable = process.env.CICADA_NATIVE_REVIEW_TEST_EXE;
const skip = !executable && 'Requires explicitly supplied compiled native MockRuntime test executable';
const fixtureRoot = resolve('.local/native-review-fixtures');
async function database() { await mkdir(fixtureRoot, { recursive: true }); const root = await mkdtemp(join(fixtureRoot, 'synthetic-')); await writeFile(join(root, 'synthetic-review-fixture.txt'), 'synthetic-only'); return root; }
function worker(root) {
  const child = spawn(executable, ['--exact','native_result_review::tests::stdio_bridge_worker','--ignored','--nocapture'], { env: { ...process.env, CICADA_REVIEW_SYNTHETIC_ROOT: root }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let buffer = '', diagnostics = '', sequence = 0; const waiting = new Map();
  child.stderr.on('data', value => diagnostics += value);
  child.stdout.on('data', value => {
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end).replace(/\r$/, ''); buffer = buffer.slice(end+1);
      const marker = line.indexOf('REVIEW_IPC_JSON:');
      if (marker < 0) { diagnostics += `${line}\n`; continue; }
      const response = JSON.parse(line.slice(marker+'REVIEW_IPC_JSON:'.length)); const promise = waiting.get(response.seq);
      if (promise) { waiting.delete(response.seq); clearTimeout(promise.timer); response.error !== undefined ? promise.reject(response.error) : promise.resolve(response.result); }
    }
  });
  child.on('close', code => { for (const value of waiting.values()) { clearTimeout(value.timer); value.reject(Error(`Native worker exited ${code}: ${diagnostics}`)); } waiting.clear(); });
  return {
    invoke(command,args) { const seq = ++sequence; return new Promise((resolve,reject) => { const timer=setTimeout(() => { waiting.delete(seq); reject(Error(`Native request timeout: ${command}: ${diagnostics}`)); },10000); waiting.set(seq,{resolve,reject,timer}); child.stdin.write(JSON.stringify({seq,command,args})+'\n'); }); },
    async close() { const completion=once(child,'close'); child.stdin.end(); const [code]=await completion; assert.equal(code,0,diagnostics); },
    async crash() { const completion=once(child,'close'); child.kill('SIGKILL'); await completion; },
  };
}
async function until(condition) { for (let i=0;i<200;i++) { if (condition()) return; await new Promise(resolve=>setTimeout(resolve,5)); } assert.ok(condition(),'UI/native async scenario did not settle'); }
async function seed(native) {
  const id=await native.invoke('save_calendar_task',{id:null,title:'Synthetic UI task',dueDate:null,estimateMinutes:null,goalId:null});
  assert.match(id,/^[0-9a-f-]{36}$/);
  await native.invoke('prototype_publish_task_result',{input:{task_id:id,operation_id:'publish-1',expected_revision:1,content:'Synthetic immutable native result'}});
  return {source_type:'note',source_id:id,title:'Synthetic UI task'};
}
function surface(dom,record,native,review) { const host=dom.window.document.createElement('div'); dom.window.document.body.append(host); const stop=mountTaskWorkflow(host,{record,invoke:native.invoke,review}); return {host,stop,section:host.querySelector('.task-result-review')}; }

test('actual result card request -> real native IPC -> same-DB commit -> reopen readback', {skip}, async () => {
  const root=await database(); let native=worker(root), dom=new JSDOM('<body></body>'), card;
  try {
    const record=await seed(native); const review=await prepareNativeResultReview(record,native.invoke,()=> 'ui-review-1');
    assert.equal(review.taskId,record.source_id); card=surface(dom,record,native,review);
    const rework=[...card.section.querySelectorAll('button')].find(button=>button.textContent==='Доработать');
    await until(()=>!rework.disabled); const comment=card.section.querySelector('textarea'); comment.value='Synthetic exact native correction'; comment.dispatchEvent(new dom.window.Event('input')); rework.click();
    await until(()=>card.section.textContent.includes('Решение подтверждено сервисом.'));
    assert.match(card.section.textContent,/работа ещё не началась/);
    const bundle=await native.invoke('read_task_result_review',{taskId:record.source_id});
    assert.equal(bundle.projection.taskRevision,3); assert.equal(bundle.projection.reviewState,'awaiting_dispatch'); assert.equal(bundle.projection.history[1].comment,comment.value || 'Synthetic exact native correction'); assert.equal(bundle.pending[0].request.operation_id,'ui-review-1'); assert.equal(bundle.pending[0].state,'acknowledged');
    card.stop();card=null;dom.window.close();await native.close();native=worker(root);
    const reopened=await prepareNativeResultReview(record,native.invoke,()=> 'unused-operation'); assert.equal(reopened.drafts.get(record.source_id).pending,null);
    dom=new JSDOM('<body></body>');card=surface(dom,record,native,reopened);await until(()=>card.section.textContent.includes('работа ещё не началась'));
    assert.equal((await reopened.adapter.read(record.source_id)).taskRevision,3);assert.deepEqual(await native.invoke('get_active_blocks',{}),[]);
  } finally { card?.stop();dom.window.close();await native.close();await rm(root,{recursive:true,force:true}); }
});

test('durable native enqueue restores original UI pending payload after process crash', {skip}, async () => {
  const root=await database();let native=worker(root),dom=new JSDOM('<body></body>'),card;
  try {
    const record=await seed(native);
    // Scheduling fault only: enqueue goes to the actual handler; commit call is not sent.
    const interrupted=async (command,args)=>{if(command==='commit_task_result_review')throw Error('Synthetic interruption before local apply');return native.invoke(command,args)};
    const review=await prepareNativeResultReview(record,interrupted,()=> 'persisted-click');card=surface(dom,record,native,review);
    const rework=[...card.section.querySelectorAll('button')].find(button=>button.textContent==='Доработать');await until(()=>!rework.disabled);
    card.section.querySelector('textarea').value='Synthetic persistent correction';rework.click();await until(()=>card.section.textContent.includes('Исход отправки неизвестен'));
    const saved=review.drafts.get(record.source_id).pending;assert.equal(saved.operation_id,'persisted-click');card.stop();card=null;dom.window.close();await native.crash();native=worker(root);
    const restored=await prepareNativeResultReview(record,native.invoke,()=> {throw Error('New ID must not be allocated')});assert.deepEqual(restored.drafts.get(record.source_id).pending,saved);
    dom=new JSDOM('<body></body>');card=surface(dom,record,native,restored);const retry=[...card.section.querySelectorAll('button')].find(button=>button.textContent==='Повторить отправку');await until(()=>!retry.disabled);retry.click();await until(()=>card.section.textContent.includes('Решение подтверждено сервисом.'));
    const bundle=await native.invoke('recover_task_result_review',{taskId:record.source_id});assert.equal(bundle.projection.taskRevision,3);assert.equal(bundle.projection.history.length,2);assert.equal(bundle.pending.length,1);assert.equal(bundle.pending[0].request.operation_id,'persisted-click');assert.equal(bundle.pending[0].state,'acknowledged');
  } finally {card?.stop();dom.window.close();await native.close();await rm(root,{recursive:true,force:true});}
});

test('native adapter refuses owner/path injection and cross-task request before invoke',async()=>{
  let calls=0;const adapter=createNativeResultReviewAdapter('existing-native-id',()=>{calls++;throw Error('Unexpected invoke')});
  await assert.rejects(adapter.submit({task_id:'existing-native-id',expected_revision:2,result_version:1,operation_id:'op',action:'accept',owner:'fake'}));
  await assert.rejects(adapter.submit({task_id:'other-task',expected_revision:2,result_version:1,operation_id:'op',action:'accept'}));assert.equal(calls,0);
});

test('native decision transaction survives actual crash at every cutpoint without partial intent', {skip}, async () => {
  for (const phase of ['after_intent_audit','after_task','after_receipt','after_outbox_ack']) {
    const root=await database();let native=worker(root);
    try {
      const record=await seed(native);
      const request={task_id:record.source_id,expected_revision:2,result_version:1,operation_id:'crash-click',action:'rework',comment:'Synthetic crash correction'};
      await native.invoke('enqueue_task_result_review',{input:request});
      await assert.rejects(native.invoke('__fixture_crash_review',{operationId:'crash-click',phase}));
      native=worker(root);
      const before=await native.invoke('recover_task_result_review',{taskId:record.source_id});assert.equal(before.projection.taskRevision,2);assert.equal(before.projection.history.length,1);assert.equal(before.pending[0].state,'queued');assert.deepEqual(before.pending[0].request,request);
      const adapter=createNativeResultReviewAdapter(record.source_id,native.invoke);const receipt=await adapter.submit(request);assert.equal(receipt.projection.taskRevision,3);assert.equal(receipt.projection.history.length,2);assert.equal(receipt.projection.reviewState,'awaiting_dispatch');
      assert.equal((await adapter.submit(request)).projection.taskRevision,3);
    } finally {await native.close();await rm(root,{recursive:true,force:true});}
  }
});
