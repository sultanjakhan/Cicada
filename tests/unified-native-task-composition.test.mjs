import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountCalendarTasks} from '../src/hanni/js/calendar-tasks.js';
import {readNativeTaskObservations,dashboardFromNativeTasks,nativeTaskKey} from '../src/hanni/js/native-task-observations.js';
import {stableTaskBinding,TASK_RUN_KEY} from '../src/hanni/js/task-run-exchange.js';
import {REGISTRY_KEY} from '../src/hanni/js/work-registry.js';
const tick=()=>new Promise(r=>setTimeout(r,10));
const namespace='00000000-0000-0000-0000-000000000001';
const rows=()=>[{source_type:'note',source_id:'existing-personal',title:'Personal native task',tags:'project:cicada,personal-template',sphere:'personal',status_extra:'task'}, {source_type:'note',source_id:'existing-work',title:'Work native task',tags:'project:agent-city,work-tag',sphere:'work',status_extra:'task'}];
async function source(){
 const native=rows(),binding=await stableTaskBinding(namespace,native[0]);
 const task={id:'published-1',projectId:'p',parentTaskId:null,title:'Publisher alias (not copied)',relationship:'root',status:'done',lastUpdated:'2026-10-03T00:00:00Z',provenance:{kind:'parent-published',reference:'synthetic fixture'},operation:null,waitingFor:null,result:'Published observation result',localBinding:binding};
 const snapshot={schemaVersion:1,kind:'work-registry-snapshot',snapshotId:'fixture-snapshot',sequence:1,source:{publisherId:'fixture-publisher',sourceNamespace:namespace,mode:'published-snapshot'},publishedAt:'2026-10-03T00:00:00Z',staleAfterSeconds:60,projects:[{id:'p',title:'Published project'}],tasks:[task,{...task,id:'unbound',localBinding:null}],runs:[]};
 const exchange={version:1,sourceNamespace:namespace,order:1,bindings:{[binding.taskKey]:binding},runs:{}};
 const invoke=async(name,args)=>{if(name==='get_ui_state'){if(args.key===REGISTRY_KEY)return JSON.stringify({[`fixture-publisher:${namespace}`]:snapshot});if(args.key===TASK_RUN_KEY)return JSON.stringify(exchange);return null;}if(name==='get_calendar_tasks')return structuredClone(native);if(['get_goals','get_calendar_task_goals','get_calendar_task_blocks'].includes(name))return [];throw Error('Unexpected command '+name);};
 return {native,snapshot,exchange,invoke};
}
test('published observations join only explicit native binding; unbound snapshots stay stored, no extra tasks',async()=>{
 const x=await source(),before=JSON.stringify(x.snapshot),value=await readNativeTaskObservations(x.native,x.invoke);
 assert.equal(value.contexts.size,2);assert.equal(value.contexts.get('note:existing-personal').observations.length,1);assert.equal(value.contexts.get('note:existing-work').observations.length,0);assert.equal(value.unboundCount,1);assert.equal(JSON.stringify(x.snapshot),before);
 x.snapshot.tasks[0].localBinding={...x.snapshot.tasks[0].localBinding,sourceNamespace:'00000000-0000-0000-0000-000000000002'};const mismatch=await readNativeTaskObservations(x.native,x.invoke);assert.equal(mismatch.contexts.get('note:existing-personal').observations.length,0);
});
test('one native list composes source/project/tag filters, keeps exact IDs and work/personal split',async()=>{
 const x=await source(),dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main'),opened=[],actions=[];
 x.native.push({source_type:'note',source_id:'jira:synthetic-readonly',title:'Synthetic readonly Jira source',readonly:true,sphere:'work',status_extra:'task'});
 const stop=mountCalendarTasks(host,{invoke:x.invoke,openTask:r=>opened.push(r.source_id),editDate(){},executeAction:()=>actions.push('write'),notifyChange(){}});await tick();await tick();
 assert.equal(host.querySelectorAll('li.ct-row').length,3);assert.equal(host.querySelectorAll('.work-registry-section').length,0);assert.equal(host.querySelector('[data-context-record="note:existing-personal"] .ct-title').textContent,'Personal native task');
 const select=(key,value)=>{const n=host.querySelector(`[data-tasks-observation="${key}"]`);n.value=value;n.dispatchEvent(new dom.window.Event('change'));};
 select('source',`published:fixture-publisher:${namespace}`);assert.equal(host.querySelectorAll('li.ct-row').length,1);host.querySelector('.ct-title').click();assert.deepEqual(opened,['existing-personal']);
 select('source','');select('project','project:agent-city');assert.equal(host.querySelectorAll('li.ct-row').length,1);select('tag','personal-template');assert.equal(host.querySelectorAll('li.ct-row').length,0);host.querySelector('[data-tasks-reset]').click();assert.equal(host.querySelectorAll('li.ct-row').length,3);host.querySelector('[data-tasks-sphere="work"]').click();assert.equal(host.querySelectorAll('li.ct-row').length,2);assert.deepEqual([...host.querySelectorAll('.ct-title')].map(n=>n.textContent).sort(),['Synthetic readonly Jira source','Work native task']);assert.deepEqual(actions,[]);assert.equal(x.native.at(-1).source_id,'jira:synthetic-readonly');assert.equal(x.native.at(-1).readonly,true);stop();dom.window.close();
});
test('authoritative awaiting review/rework stay active; only native acceptance enters completed and dashboard shares identity',async()=>{
 const x=await source(),dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');let state='awaiting_review';
 const readReview=async id=>{if(id!=='existing-personal')throw Error('no result');return{taskId:id,taskRevision:2,resultVersion:2,content:'Immutable result',reviewState:state,history:[{action:'rework',resultVersion:1,comment:'Keep history'}]};};
 const stop=mountCalendarTasks(host,{invoke:x.invoke,readTaskReview:readReview,openTask(){},editDate(){},executeAction(){throw Error('Manual completion forbidden');},notifyChange(){}});await tick();await tick();
 const row=host.querySelector('[data-context-record="note:existing-personal"]');assert.equal(row.querySelector('[data-task-control="finish"]').disabled,true);assert.match(row.textContent,/На приёмке.*v2/);host.querySelector('[data-tasks-filter="completed"]').click();assert.equal(host.querySelectorAll('li.ct-row').length,0);
 state='awaiting_dispatch';dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await tick();await tick();assert.equal(host.querySelectorAll('li.ct-row').length,0);host.querySelector('[data-tasks-filter="active"]').click();assert.match(host.textContent,/Ожидает передачи исполнителю/);state='accepted';dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));await tick();await tick();host.querySelector('[data-tasks-filter="completed"]').click();assert.equal(host.querySelectorAll('li.ct-row').length,1);assert.match(host.textContent,/Принято.*v2/);
 const observed=await readNativeTaskObservations(x.native,x.invoke,{readReview});const dashboard=dashboardFromNativeTasks(x.native,observed.contexts);assert.equal(dashboard.tasks.length,0,'accepted work moves to Tasks history');state='awaiting_dispatch';const reworkObserved=await readNativeTaskObservations(x.native,x.invoke,{readReview});const reworkDashboard=dashboardFromNativeTasks(x.native,reworkObserved.contexts);assert.equal(reworkDashboard.tasks[0].taskKey,'existing-personal');assert.equal(reworkDashboard.tasks[0].reviewState,'awaiting_dispatch');assert.equal(reworkDashboard.tasks[0].needsUser,false);assert.equal(observed.contexts.get(nativeTaskKey(x.native[0])).review.history[0].comment,'Keep history');stop();dom.window.close();
});
test('workspace Tasks has one list and no imported hierarchy mount; storage module remains',()=>{
 const workspace=readFileSync(new URL('../src/hanni/js/calendar-workspace.js',import.meta.url),'utf8');assert.doesNotMatch(workspace,/mountRegistrySources|registryHost/);assert.match(workspace,/mountCalendarTasks/);assert.ok(readFileSync(new URL('../src/hanni/js/work-registry.js',import.meta.url),'utf8').includes('createRegistryStore'));assert.match(readFileSync(new URL('../src/hanni/js/calendar-task-details.js',import.meta.url),'utf8'),/review:dependencies.review/);
});
