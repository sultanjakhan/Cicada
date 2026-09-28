import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DEFAULT_PROCESS, normalizeProcessState, taskStage, stageTimeParts } from '../src/hanni/js/task-processes.js';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const subset = ['understanding', 'acceptance'];
const stored = { id:'fictional-task', title:'Fictional subset', date:null, task_kind:'normal', sphere:'work', process:'system-analysis', stage:'requirements', stage_ids:subset, waiting:false, version:1 };
const jira = { project:'DEMO', requestId:'fictional-request', issueTypes:[{id:'1',name:'Task'}], defaultProcessId:'system-analysis', recovery:null };
async function form(t, { row = null, handlers = {} } = {}) {
  const dom = new JSDOM('<body></body>', {url:'https://fixture.invalid',pretendToBeVisual:true}), w = dom.window;
  for (const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option']) globalThis[name] = name === 'window' ? w : w[name];
  globalThis.marked = {Marked:class {use() {} parse(value) {return value;}}};
  const calls=[], replies={list_event_categories:[],get_goals:[],get_calendar_task_goals:[],get_calendar_task_blocks:[],get_ui_state:null,get_app_state:null,
    get_calendar_task:row,save_calendar_task:'fictional-task',jira_create_options:jira,jira_task_create:{requestId:'fictional-request',itemId:'jira:fictional',changed:1},jira_create_acknowledge:{acknowledged:true},...handlers};
  w.__TAURI__={core:{invoke:async(command,args)=>{calls.push({command,args});if(!(command in replies))throw Error(`Unexpected ${command}`);return typeof replies[command]==='function'?replies[command](args):replies[command];}}};
  const {showCalendarCreateModal,showCalendarTaskModal}=await import('../src/hanni/js/calendar-event-modal.js');
  if(row)await showCalendarTaskModal(row.id);else await showCalendarCreateModal(null,{initialNoDate:true});await settle();
  const q=selector=>w.document.querySelector(selector), saved=command=>calls.filter(call=>call.command===command).map(call=>call.args);
  const change=(selector,value)=>{q(selector).value=value;q(selector).dispatchEvent(new w.Event('change',{bubbles:true}));};
  t.after(()=>w.close());return {w,q,saved,replies,change,submit:async()=>{q('#evm-form').requestSubmit();await settle();}};
}

test('next stage follows the selected subset in template order; skipped-stage time keeps its name',()=>{
  const state=taskStage({...stored,stage:'understanding'},[DEFAULT_PROCESS]);
  assert.deepEqual(state.stages.map(stage=>stage.id),subset);assert.equal(state.next.id,'acceptance');
  const excluded=taskStage(stored,[DEFAULT_PROCESS]);assert.equal(excluded.deleted,false);assert.equal(excluded.excluded,true);
  assert.match(excluded.label,/Требования — не выбран/);assert.equal(excluded.next.id,'acceptance');
  assert.deepEqual(stageTimeParts(excluded,new Map([['requirements',180],['analysis',120],['acceptance',60]])).map(part=>[part.label,part.seconds]),[['Требования',180],['Анализ и модели',120],['Приёмка',60]]);
  assert.equal(taskStage({...stored,stage:'removed'},[DEFAULT_PROCESS]).next,null);
  assert.equal(taskStage({stage_ids:subset},[DEFAULT_PROCESS]),null);
  const custom={...DEFAULT_PROCESS,stages:DEFAULT_PROCESS.stages.map(stage=>({...stage,title:stage.id==='understanding'?'Моё название':stage.title}))};
  assert.equal(normalizeProcessState(JSON.stringify({version:1,processes:[custom]})).processes[0].stages[0].title,'Моё название');
});

test('ordinary editing preserves the selected subset and current excluded stage',async t=>{
  const x=await form(t,{row:stored});
  assert.equal(x.q('#evm-stage').value,'requirements');assert.match(x.q('#evm-stage').selectedOptions[0].textContent,/не выбран для задачи/);
  assert.equal(x.q('#evm-stage').selectedOptions[0].disabled,true);
  assert.deepEqual([...x.q('[data-stage-subset-options]').querySelectorAll('input:checked')].map(input=>input.dataset.stageSubsetId),subset);
  await x.submit();const [request]=x.saved('save_calendar_task');assert.equal(request.stage,null);assert.equal(request.stageIds,null);assert.equal(request.process,null);
});

test('checkbox changes keep the current stage, reject zero choices and support explicit all stages',async t=>{
  const x=await form(t,{row:{...stored,stage_ids:null}});
  x.q('[data-stage-subset-id="requirements"]').click();
  assert.equal(x.q('#evm-stage').value,'requirements');assert.match(x.q('#evm-stage').selectedOptions[0].textContent,/не выбран/);
  for(const input of [...x.q('[data-stage-subset-options]').querySelectorAll('input:checked')]) x.q(`[data-stage-subset-id="${input.dataset.stageSubsetId}"]`).click();
  await x.submit();assert.equal(x.saved('save_calendar_task').length,0);assert.match(x.q('#evm-error').textContent,/хотя бы один этап/);
  x.q('[data-stage-subset-all]').click();await x.submit();assert.deepEqual(x.saved('save_calendar_task')[0].stageIds,[]);
});

test('new work task applies project default once, saves the chosen subset locally, and keeps no process explicit',async t=>{
  const x=await form(t);assert.equal(x.q('#evm-process').value,'');
  x.q('[data-evm-scope="work"]').click();await settle();assert.equal(x.q('#evm-process').value,'system-analysis');assert.equal(x.q('#evm-stage').value,'');
  x.change('#evm-process','');x.q('[data-evm-scope="personal"]').click();x.q('[data-evm-scope="work"]').click();await settle();assert.equal(x.q('#evm-process').value,'');
  x.change('#evm-process','system-analysis');
  for(const input of [...x.q('[data-stage-subset-options]').querySelectorAll('input')]) if(!subset.includes(input.dataset.stageSubsetId))x.q(`[data-stage-subset-id="${input.dataset.stageSubsetId}"]`).click();
  x.q('#evm-title').value='Fictional chosen stages';await x.submit();const [request]=x.saved('jira_task_create');
  assert.deepEqual(request.local.stageIds,subset);assert.equal(request.local.process,'system-analysis');
  assert.deepEqual(Object.keys(request).sort(),['issueTypeId','local','requestId','title']);assert.equal(x.saved('save_calendar_task').length,0);
});

test('late project defaults respect explicit process choice and a switched personal form',async t=>{
  let resolve;const x=await form(t,{handlers:{jira_create_options:()=>new Promise(r=>{resolve=r;})}});
  x.q('[data-evm-scope="work"]').click();await settle();x.q('[data-evm-scope="personal"]').click();resolve(jira);await settle();
  assert.equal(x.q('#evm-process').value,'');
  x.change('#evm-process','');x.q('[data-evm-scope="work"]').click();await settle();assert.equal(x.q('#evm-process').value,'');
});

test('orphan selections survive a title edit',async t=>{
  const x=await form(t,{row:{...stored,process:'deleted-process',stage:'orphan',stage_ids:['orphan']}});
  assert.equal(x.q('#evm-stage').value,'orphan');assert.match(x.q('[data-stage-subset-options]').textContent,/orphan/);
  x.q('#evm-title').value='Updated fictional title';await x.submit();assert.equal(x.saved('save_calendar_task')[0].stageIds,null);
  assert.equal(x.saved('jira_create_options').length,0);
});


test('an existing Jira task without process never receives the project default',async t=>{
  const x=await form(t,{row:{...stored,process:'',stage:'',stage_ids:null}});
  assert.equal(x.q('#evm-process').value,'');assert.equal(x.q('[data-stage-subset]').hidden,true);
  await x.submit();assert.equal(x.saved('save_calendar_task')[0].process,null);assert.equal(x.saved('save_calendar_task')[0].stageIds,null);
  assert.equal(x.saved('jira_create_options').length,0);
});
