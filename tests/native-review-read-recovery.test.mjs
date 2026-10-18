import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedResultReviewAdapter} from '../src/hanni/js/shared-result-review-adapter.js';
import {readNativeTaskObservations,nativeTaskKey,dashboardFromNativeTasks} from '../src/hanni/js/native-task-observations.js';
import {taskProgress} from '../src/hanni/js/task-progress.js';

const id='00000000-0000-4000-8000-000000000001';
const row={source_type:'note',source_id:id,sphere:'personal',title:'Synthetic recovery task',tags:'task-sphere:personal',completed:false};
function fixture(){
 const task={id,version:7,binding:{sourceId:id},review:{state:'running',resultVersion:2,intentId:'synthetic-rework'},results:[{version:1,content:'Prior synthetic result'},{version:2,content:'Current synthetic result'}],history:[{decision:'rework',resultVersion:1}]};
 const calls=[];let failure=null;
 const invoke=async(name,args)=>{calls.push({name,args});if(name==='get_ui_state')return null;assert.equal(name,'shared_task_command');assert.equal(args.input.command,'get');assert.deepEqual(args.input.arguments,{taskId:id});if(failure instanceof Error)throw failure;if(failure)return failure;return structuredClone(task);};
 const adapter=createSharedResultReviewAdapter(id,invoke,()=> 'synthetic-read-operation');
 const read=previousContexts=>readNativeTaskObservations([row],invoke,{readReview:key=>adapter.read(key),previousContexts});
 return {task,calls,read,fail:value=>{failure=value;}};
}
test('native-shaped running review survives the adapter/Tasks join without implying acceptance',async()=>{
 const f=fixture(),before=JSON.stringify(f.task),observed=await f.read(),ctx=observed.contexts.get(nativeTaskKey(row));
 assert.equal(ctx.review.reviewState,'running');assert.equal(ctx.review.resultVersion,2);assert.equal(ctx.review.taskRevision,7);assert.equal(ctx.reviewReadError,undefined);
 assert.equal(ctx.review.content,'Current synthetic result');assert.equal(ctx.review.history[0].decision,'rework');
 assert.equal(taskProgress({review:ctx.review,completed:true}).state,'running');
 const dashboard=dashboardFromNativeTasks([row],observed.contexts);assert.equal(dashboard.tasks[0].needsUser,false);assert.equal(dashboard.tasks[0].taskKey,id);
 assert.equal(JSON.stringify(f.task),before);assert.ok(f.calls.every(c=>['get_ui_state','shared_task_command'].includes(c.name)));
});
test('denial and transport failures stay unknown; successful reread removes stale error and refreshes result',async()=>{
 for(const failure of [{isError:true,status:403,code:'personal_scope_required'},Error('Synthetic transport failure')]){
  const f=fixture(),initial=await f.read();f.fail(failure);const failed=await f.read(initial.contexts),ctx=failed.contexts.get(nativeTaskKey(row));
  assert.equal(ctx.reviewReadError,true);assert.equal(taskProgress({review:ctx.review,reviewReadError:ctx.reviewReadError}).state,'unknown');
  f.fail(null);f.task.version=8;f.task.review.resultVersion=1;const recovered=await f.read(failed.contexts),next=recovered.contexts.get(nativeTaskKey(row));
  assert.equal(next.reviewReadError,undefined);assert.equal(next.reviewAvailable,true);assert.equal(next.review.taskRevision,8);assert.equal(next.review.resultVersion,1);
 }
});
test('wrong exact UUID or missing binding cannot masquerade as a successful review read',async()=>{
 for(const change of [task=>{task.id='other';},task=>{task.binding.sourceId='other';}]){
  const f=fixture();change(f.task);const ctx=(await f.read()).contexts.get(nativeTaskKey(row));assert.equal(ctx.review,null);assert.equal(ctx.reviewReadError,true);
 }
});
