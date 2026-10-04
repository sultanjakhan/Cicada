import {createWorkflowStore} from './task-workflow.js';
import {createRegistryStore,freshness} from './work-registry.js';
import {createTaskRunExchange,stableTaskBinding} from './task-run-exchange.js';
const same=(a,b)=>a&&b&&['sourceNamespace','sourceType','sourceId','taskKey'].every(k=>a[k]===b[k]);
export const nativeTaskKey=row=>`${row.source_type}:${row.source_id}`;
export function nativeTaskTags(row){return [...new Set((typeof row.tags==='string'?row.tags.split(','):[]).map(t=>t.trim()).filter(t=>t&&!t.startsWith('task-')))];}
// Read-only join onto native rows; never imports tasks, completes them or guesses title matches.
export async function readNativeTaskObservations(rows,invoke,{readReview=null,previousContexts=new Map()}={}){
 const [registry,exchange]=await Promise.allSettled([createRegistryStore(invoke).load(),createTaskRunExchange(invoke).load()]);
 const contexts=new Map(),unbound=[];
 const all=registry.status==='fulfilled'?Object.values(registry.value):[],state=exchange.status==='fulfilled'?exchange.value:null;
 for(const row of rows){
  const tags=nativeTaskTags(row),ctx={sources:[{id:'native',label:'Задачи Cicada'}],projects:tags.filter(t=>t.startsWith('project:')).map(t=>({id:t,label:t.slice(8)})),tags,observations:[],reports:[],review:null,reviewAvailable:!!readReview};
  if(!row.readonly){try{ctx.workflow=await createWorkflowStore(row,invoke).load();}catch{ctx.workflowReadError=true;}}
  const expected=state&&!row.readonly?await stableTaskBinding(state.sourceNamespace,row):null;
  const bound=expected&&same(state.bindings[expected.taskKey],expected)?expected:null;
  if(bound){ctx.binding=bound;ctx.reports=Object.values(state.runs).filter(r=>r.taskKey===bound.taskKey&&r.report).sort((a,b)=>a.receivedOrder-b.receivedOrder).map(r=>({...r.report,receivedOrder:r.receivedOrder,receivedAt:null,freshness:'unknown'}));}
  for(const snapshot of all)for(const task of snapshot.tasks){
   if(!bound||!same(task.localBinding,bound))continue;
   const source=`published:${snapshot.source.publisherId}:${snapshot.source.sourceNamespace}`,project=snapshot.projects.find(p=>p.id===task.projectId);
   ctx.sources.push({id:source,label:`Источник: ${snapshot.source.publisherId}`});
   if(project)ctx.projects.push({id:`${source}:${project.id}`,label:project.title});
   ctx.observations.push({source,task,snapshot,freshness:freshness(snapshot,task)});
  }
  if(readReview&&!row.readonly){try{const review=await readReview(String(row.source_id));if(review?.taskId!==String(row.source_id)||!['awaiting_review','accepted','awaiting_dispatch'].includes(review.reviewState)||!Number.isSafeInteger(review.taskRevision)||review.taskRevision<1||!Number.isSafeInteger(review.resultVersion)||review.resultVersion<1)throw Error('Invalid review');ctx.review=review;}catch(error){
   ctx.reviewAvailable=false;
   const previous=previousContexts.get(nativeTaskKey(row))?.review;
   const absent=(error?.status===403&&error?.code==='review_prototype_disabled')||(error?.status===404&&['no_review_result','shared_task_not_found'].includes(error?.code));
   ctx.review=previous||null;ctx.reviewReadError=!!previous||!absent;
  }}
  contexts.set(nativeTaskKey(row),ctx);
 }
 for(const snapshot of all)for(const task of snapshot.tasks)if(![...contexts.values()].some(c=>c.observations.some(o=>o.snapshot===snapshot&&o.task===task)))unbound.push({snapshotId:snapshot.snapshotId,taskId:task.id});
 return {contexts,unboundCount:unbound.length,available:registry.status==='fulfilled'&&exchange.status==='fulfilled'};
}
export function observationMatches(ctx,state){return (!state.source||ctx.sources.some(s=>s.id===state.source))&&(!state.project||ctx.projects.some(p=>p.id===state.project))&&(!state.tag||ctx.tags.includes(state.tag));}
export function dashboardFromNativeTasks(rows,contexts){
 const tasks=[],reports=[];
 for(const row of rows){const ctx=contexts.get(nativeTaskKey(row));if(!ctx||(!ctx.reports.length&&!ctx.review)||(ctx.review?ctx.review.reviewState==='accepted':row.completed||['done','skipped','missed'].includes(row.status_extra)))continue;
  const project=ctx.projects[0];tasks.push({taskKey:String(row.source_id),title:row.title,runTaskKeys:ctx.binding?[ctx.binding.taskKey]:[],project:project?{id:project.id,name:project.label}:null,tags:ctx.tags.map(t=>({id:t,name:t})),needsUser:ctx.review?ctx.review.reviewState==='awaiting_review':null,resultVersion:ctx.review?.resultVersion??null,reviewState:ctx.review?.reviewState??null});reports.push(...ctx.reports);
 }
 return {tasks,reports};
}
