// Production review seam over explicitly bound native tasks. Never starts a timer/model.
const allowed=new Set(['awaiting_review','accepted','awaiting_dispatch','running']);
function review(task,id){
 if(task?.id!==id||task?.binding?.sourceId!==id||!Number.isSafeInteger(task.version)||task.version<1)throw Error('Invalid shared task identity');
 const r=task.review,result=task.results?.find(v=>v.version===r?.resultVersion);
 if(!r||!result){const error=Error('No review result');error.status=404;error.code='no_review_result';throw error;}
 if(!allowed.has(r.state)||typeof result.content!=='string'||!Array.isArray(task.history))throw Error('Invalid shared review');
 return {taskId:id,taskRevision:task.version,resultVersion:r.resultVersion,content:result.content,reviewState:r.state,history:structuredClone(task.history),results:structuredClone(task.results)};
}
async function command(invoke,op,name,args){
 const value=await invoke('shared_task_command',{input:{operationId:op,command:name,arguments:structuredClone(args)}});
 if(value?.isError){const error=Error(value.code||'Shared task unavailable');error.status=value.status;error.code=value.code;error.current=value.current;throw error;}return value;
}
export function createSharedResultReviewAdapter(taskId,invoke,operationId=()=>crypto.randomUUID()){
 const key=`calendar_shared_review_pending_v1:${taskId}`;
 async function pending(){const raw=await invoke('get_ui_state',{key});if(raw==null||raw==='')return {raw:raw??null,value:null};
  let value;try{value=JSON.parse(raw);}catch{throw Error('Invalid persisted shared review');}
  if(value.task_id!==taskId||!['accept','rework'].includes(value.action)||typeof value.operation_id!=='string')throw Error('Invalid persisted shared review');return {raw,value};
 }
 const read=async id=>{if(id!==taskId)throw Error('Task mismatch');return review(await command(invoke,operationId(),'get',{taskId}),taskId);};
 return {read,
  async recover(){const p=await pending();return {projection:await read(taskId),pending:p.value?[{request:p.value,state:'queued'}]:[]};},
  async submit(request){
   if(request?.task_id!==taskId||!['accept','rework'].includes(request.action))throw Error('Invalid review decision');
   const p=await pending();if(p.value&&JSON.stringify(p.value)!==JSON.stringify(request))throw Error('Resolve the pending review first');
   const raw=JSON.stringify(request);
   if(!p.value)await invoke('set_ui_state',{key,value:raw,expectedValue:p.raw});
   const args={taskId,expectedVersion:request.expected_revision,resultVersion:request.result_version,decision:request.action};
   if(request.action==='rework')args.comment=request.comment;
   try{
    const receipt=await command(invoke,request.operation_id,'review',args);
    if(receipt.operationId!==request.operation_id||receipt.acknowledged!==true)throw Error('Unconfirmed review receipt');
    await invoke('set_ui_state',{key,value:'',expectedValue:raw});
    return {kind:'acknowledged',operation_id:request.operation_id,projection:await read(taskId)};
   }catch(error){
    if(error?.status===409){
     // Feedback stays durable after the conflict, while the stale operation is retired explicitly.
     const conflictKey=key+':conflict',previous=await invoke('get_ui_state',{key:conflictKey});
     const saved=previous?JSON.parse(previous):[],history=Array.isArray(saved)?saved:[saved];
     if(!history.some(item=>item.operation_id===request.operation_id))history.push(structuredClone(request));
     await invoke('set_ui_state',{key:conflictKey,value:JSON.stringify(history),expectedValue:previous??null});
     await invoke('set_ui_state',{key,value:'',expectedValue:raw});
    }throw error;
   }
  }
 };
}
export async function prepareSharedResultReview(record,invoke,operationId=()=>crypto.randomUUID()){
 if(record?.source_type!=='note'||record.readonly)throw Error('Editable native task required');
 const taskId=String(record.source_id),adapter=createSharedResultReviewAdapter(taskId,invoke,operationId),recovered=await adapter.recover();
 const queued=recovered.pending[0]?.request;
 let comment=queued?.comment||'';
 if(!comment){const raw=await invoke('get_ui_state',{key:`calendar_shared_review_pending_v1:${taskId}:conflict`});if(raw){try{const value=JSON.parse(raw);comment=(Array.isArray(value)?value.at(-1):value)?.comment||'';}catch{throw Error('Invalid conflict feedback');}}}
 const drafts=new Map([[taskId,{comment,pending:queued||null,outcome:queued?'queued':null}]]);
 return {taskId,adapter,drafts,operationId};
}


