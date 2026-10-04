import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountCalendarTasks} from '../src/hanni/js/calendar-tasks.js';
const tick=()=>new Promise(r=>setTimeout(r,10));
function fixture(){
 const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main'),calls=[],rows=[{source_type:'note',source_id:'normal-existing',title:'Existing personal task',tags:'project:cicada,tag-one',sphere:'personal',status_extra:'task'},{source_type:'note',source_id:'normal-done',title:'Existing completed task',tags:'project:agent-city',completed:true,status_extra:'done'}];
 const invoke=async(name)=>{calls.push(name);if(name==='get_calendar_tasks')return rows;if(['get_goals','get_calendar_task_goals','get_calendar_task_blocks'].includes(name))return [];if(name==='get_ui_state')return null;throw Error('Unexpected write/prototype command '+name);};
 return{dom,host,calls,invoke};
}
test('normal mode uses one list and native filters without issuing review commands or requiring feature',async()=>{
 const x=fixture(),state={filter:'review',search:'',goal:'',sphere:'',page:0};const stop=mountCalendarTasks(x.host,{state,invoke:x.invoke,openTask(){},editDate(){},executeAction(){throw Error('No write requested');},notifyChange(){}});await tick();await tick();
 assert.equal(state.filter,'active');assert.equal(x.host.querySelector('[data-tasks-filter="review"]').hidden,true);assert.equal(x.host.querySelectorAll('li.ct-row').length,1);assert.equal(x.host.querySelector('.ct-title').textContent,'Existing personal task');
 const project=x.host.querySelector('[data-tasks-observation="project"]');project.value='project:agent-city';project.dispatchEvent(new x.dom.window.Event('change'));assert.equal(x.host.querySelectorAll('li.ct-row').length,0);x.host.querySelector('[data-tasks-filter="completed"]').click();assert.equal(x.host.querySelector('.ct-title').textContent,'Existing completed task');
 assert.equal(x.host.querySelectorAll('.work-registry-section').length,0);assert.ok(x.calls.every(c=>!c.includes('result_review')&&!c.startsWith('prototype_')));assert.doesNotMatch(x.host.textContent,/Native review|isolated opt-in/);stop();x.dom.window.close();
});
test('explicit injected review consumer remains separate and visible without enabling default profile authority',async()=>{
 const x=fixture(),stop=mountCalendarTasks(x.host,{invoke:x.invoke,readTaskReview:async id=>{if(id!=='normal-existing')throw Error('no result');return{taskId:id,taskRevision:2,resultVersion:1,reviewState:'awaiting_review',content:'Synthetic fixture',history:[]};},openTask(){},editDate(){},executeAction(){throw Error('Manual completion not authorized');},notifyChange(){}});await tick();await tick();
 assert.equal(x.host.querySelector('[data-tasks-filter="review"]').hidden,false);x.host.querySelector('[data-tasks-filter="review"]').click();assert.equal(x.host.querySelectorAll('li.ct-row').length,1);assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,true);stop();x.dom.window.close();
});
test('integrated source reads shared review for bound tasks and preserves native guards',()=>{
 const workspace=readFileSync(new URL('../src/hanni/js/calendar-workspace.js',import.meta.url),'utf8');assert.match(workspace,/nativeReview = true/);assert.match(workspace,/createSharedResultReviewAdapter\(id,invoke\)\.read\(id\)/);assert.doesNotMatch(workspace,/mountRegistrySources/);assert.doesNotMatch(workspace,/mountDashboardAiWork|data-calendar-ai-work|disposeAiWork/);const native=readFileSync(new URL('../src-tauri/src/native_result_review.rs',import.meta.url),'utf8');assert.match(native,/review_prototype_disabled/);assert.match(native,/local-result-review-prototype/);
});

test('readonly-only list preserves exact open identity and disables every mutation',async()=>{
 const x=fixture(),opened=[];const invoke=async(name,args)=>name==='get_calendar_tasks'?[{source_type:'note',source_id:'jira:synthetic-readonly',title:'Readonly visible source',readonly:true,sphere:'work',status_extra:'task',date:'2026-10-03'}]:x.invoke(name,args);
 const stop=mountCalendarTasks(x.host,{invoke,openTask:r=>opened.push(r.source_id),editDate(){throw Error('No readonly date write');},executeAction(){throw Error('No readonly write');},notifyChange(){}});await tick();await tick();
 assert.equal(x.host.querySelectorAll('li.ct-row').length,1);assert.equal(x.host.querySelector('.ct-group-count').textContent,'1');x.host.querySelector('.ct-title').click();assert.deepEqual(opened,['jira:synthetic-readonly']);
 for(const button of x.host.querySelectorAll('[data-task-control]'))if(button.dataset.taskControl!=='open')assert.equal(button.disabled,true);
 x.host.querySelector('[data-tasks-sphere="work"]').click();assert.equal(x.host.querySelectorAll('li.ct-row').length,1);
 const search=x.host.querySelector('input[type="search"]');search.value='Readonly';search.dispatchEvent(new x.dom.window.Event('input'));assert.equal(x.host.querySelectorAll('li.ct-row').length,1);assert.ok(x.calls.every(c=>c.startsWith('get_')));stop();x.dom.window.close();
});
test('known managed ownership survives failed read and recovers on subsequent refresh',async()=>{
 const x=fixture();let fail=false;const stop=mountCalendarTasks(x.host,{invoke:x.invoke,readTaskReview:async id=>{if(id!=='normal-existing')throw{status:404,code:'no_review_result'};if(fail)throw Error('Temporary transport failure');return{taskId:id,taskRevision:2,resultVersion:1,reviewState:'awaiting_review'};},openTask(){},editDate(){},executeAction(){throw Error('No manual finish');},notifyChange(){}});await tick();await tick();
 fail=true;x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await tick();await tick();assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,true);assert.match(x.host.textContent,/Состояние приёмки не обновлено/);
 fail=false;x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await tick();await tick();assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,true);assert.doesNotMatch(x.host.textContent,/Состояние приёмки не обновлено/);stop();x.dom.window.close();
});
test('explicit disabled prototype or absent result permits ordinary manual tasks',async()=>{
 for(const error of [{status:403,code:'review_prototype_disabled'},{status:404,code:'no_review_result'},{status:404,code:'shared_task_not_found'}]){const x=fixture();const stop=mountCalendarTasks(x.host,{invoke:x.invoke,readTaskReview:async()=>{throw error;},openTask(){},editDate(){},executeAction(){},notifyChange(){}});await tick();await tick();assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,false);stop();x.dom.window.close();}
});

test('an absent binding cannot erase previously observed pending review or unlock manual completion',async()=>{
 const x=fixture();let absent=false;
 const stop=mountCalendarTasks(x.host,{invoke:x.invoke,readTaskReview:async id=>{if(absent)throw{status:404,code:'shared_task_not_found'};return{taskId:id,taskRevision:2,resultVersion:1,reviewState:'awaiting_review'};},openTask(){},editDate(){},executeAction(){throw Error('No manual finish');},notifyChange(){}});
 await tick();await tick();assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,true);
 absent=true;x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));await tick();await tick();
 assert.equal(x.host.querySelector('[data-task-control="finish"]').disabled,true);assert.match(x.host.textContent,/Состояние приёмки не обновлено/);
 stop();x.dom.window.close();
});
