import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedResultReviewAdapter,prepareSharedResultReview} from '../src/hanni/js/shared-result-review-adapter.js';
function fixture(){
 const values=new Map(),requests=[],task={id:'native-id',version:2,binding:{sourceId:'native-id'},review:{resultVersion:1,state:'awaiting_review'},results:[{version:1,content:'Preserved result'}],history:[]};let drop=false,conflict=false;
 const invoke=async(cmd,args)=>{
  if(cmd==='get_ui_state')return values.get(args.key)??null;
  if(cmd==='set_ui_state'){if('expectedValue'in args)assert.equal(values.get(args.key)??null,args.expectedValue);values.set(args.key,args.value);return;}
  assert.equal(cmd,'shared_task_command');const {input}=args;
  if(input.command==='get')return structuredClone(task);
  assert.ok(values.get('calendar_shared_review_pending_v1:native-id'),'decision must be durable before transmission');requests.push(structuredClone(input));
  if(conflict)return {isError:true,status:409,code:'revision_conflict',current:structuredClone(task)};
  task.version=3;task.review.state='awaiting_dispatch';task.history=[{comment:input.arguments.comment}];
  if(drop){drop=false;throw Error('unknown outcome');}
  return {acknowledged:true,operationId:input.operationId,task:structuredClone(task)};
 };
 return {values,requests,task,invoke,lose(){drop=true;},conflict(){conflict=true;}};
}
const request=(operation_id='review-op-001',comment='Saved feedback')=>({task_id:'native-id',operation_id,expected_revision:2,result_version:1,action:'rework',comment});
test('unknown response outcome recovers exact review operation after restart, preserving prior result',async()=>{
 const f=fixture(),adapter=createSharedResultReviewAdapter('native-id',f.invoke,()=> 'read-op-001');f.lose();await assert.rejects(adapter.submit(request()),/unknown outcome/);
 const reopened=await prepareSharedResultReview({source_type:'note',source_id:'native-id'},f.invoke,()=> 'read-op-002');assert.deepEqual(reopened.drafts.get('native-id').pending,request());
 await reopened.adapter.submit(reopened.drafts.get('native-id').pending);assert.deepEqual(f.requests[0],f.requests[1]);assert.equal(f.values.get('calendar_shared_review_pending_v1:native-id'),'');assert.equal(f.task.results[0].content,'Preserved result');assert.equal((await reopened.adapter.read('native-id')).reviewState,'awaiting_dispatch');
});
test('conflicting reviews preserve each feedback entry and restore the latest draft',async()=>{
 const f=fixture();f.conflict();const adapter=createSharedResultReviewAdapter('native-id',f.invoke,()=> 'read-op-001');await assert.rejects(adapter.submit(request()),e=>e.status===409);await assert.rejects(adapter.submit(request('review-op-002','Second feedback')),e=>e.status===409);
 assert.equal(JSON.parse(f.values.get('calendar_shared_review_pending_v1:native-id:conflict')).length,2);const reopened=await prepareSharedResultReview({source_type:'note',source_id:'native-id'},f.invoke);assert.equal(reopened.drafts.get('native-id').comment,'Second feedback');assert.equal(f.task.review.state,'awaiting_review');
});
test('no binding, no result and mismatched task identities stay unavailable',async()=>{
 const adapter=createSharedResultReviewAdapter('native-id',async()=>({id:'other'}));await assert.rejects(adapter.read('native-id'),/identity/);
 const f=fixture();f.task.review=null;await assert.rejects(createSharedResultReviewAdapter('native-id',f.invoke).read('native-id'),e=>e.code==='no_review_result');await assert.rejects(adapter.read('other'),/mismatch/);
});
