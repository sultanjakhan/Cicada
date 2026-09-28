import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountJiraWorkflowSettings } from '../src/hanni/js/jira-workflow-settings.js';
import { inWorkingQueue, jiraCanRecommend, jiraCanStart } from '../src/hanni/js/jira-workflow-model.js';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
import { rankNextAction } from '../src/hanni/js/calendar-next-action.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const row = (n, role, status, extra = {}) => ({ source_type:'note', source_id:`jira:${n.toString(16).padStart(64,'0')}`, title:`Example ${n}`, status_extra:'task', sphere:'work', jira_workflow_role:role, jira_status:status, ...extra });
const options = () => ({ scope:'example-scope', revision:'revision-1', project:'DEMO', defaultProcessId:null, statuses:[{name:'To Do',bucket:null},{name:'BACKLOG',bucket:'completed'},{name:'<img src=x onerror=alert(1)>',bucket:null}] });

test('workflow uses explicit project rules, never Jira spelling or category guesses', () => {
  assert.equal(jiraCanStart(row(1,'completed','To Do')),false);
  assert.equal(jiraCanStart(row(2,'ready','BACKLOG')),true);
  assert.equal(jiraCanStart(row(3,null,'In Progress')),false);
  assert.equal(inWorkingQueue(row(4,'hidden','Other',{is_active:true})),true);
  assert.equal(jiraCanRecommend(row(5,'working','Started')),false);
  assert.equal(jiraCanRecommend(row(6,'working','Started',{has_work:true})),true);
  assert.equal(jiraCanRecommend({source_type:'note',source_id:'personal'}),true);
});

test('recommendations exclude finished, hidden, review and unassigned; running work remains controllable', () => {
  const tasks=[row(1,'completed','BACKLOG',{priority:9}),row(2,'review','Review'),row(3,'hidden','Done'),row(4,'unassigned','Draft'),row(5,'working','In Progress'),row(6,'ready','To Do')];
  assert.equal(rankNextAction({tasks}).task.source_id,tasks[5].source_id);
  assert.equal(rankNextAction({tasks:tasks.slice(0,5)}),null);
  assert.equal(rankNextAction({tasks,activeBlocks:[{source_type:'note',source_id:tasks[0].source_id}]}).action,'open');
});

test('Tasks starts with the working queue; All and exact status filters preserve every imported task', async t => {
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');
  const rows=[row(1,'ready','To Do'),row(2,'working','In Progress'),row(3,'completed','BACKLOG'),row(4,'review','Review'),row(5,'hidden','Done'),row(6,'unassigned','Draft'),row(7,'completed','BACKLOG',{is_active:true})];
  const dispose=mountCalendarTasks(host,{invoke:async command=>command==='get_calendar_tasks'?rows:command==='get_ui_state'?null:[],openTask(){},editDate(){},executeAction(){},notifyChange(){}});
  t.after(()=>{dispose();dom.window.close();}); await settle();
  const titles=()=>[...host.querySelectorAll('[data-task-control="open"]')].map(el=>el.textContent);
  assert.deepEqual(titles(),['Example 7','Example 1','Example 2']);
  assert.equal(host.querySelector('[data-context-record="note:'+rows[6].source_id+'"] [data-task-control="execute"]').title,'Пауза');
  host.querySelector('[data-tasks-filter="completed"]').click(); assert.deepEqual(titles(),['Example 3']);
  host.querySelector('[data-tasks-filter="review"]').click(); assert.deepEqual(titles(),['Example 4']);
  assert.equal(host.querySelector('[data-task-control="execute"]'),null);
  host.querySelector('[data-tasks-filter="all"]').click(); assert.equal(titles().length,7);
  const select=host.querySelector('[data-tasks-jira-status]'); select.value='Draft'; select.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(titles(),['Example 6']);
  host.querySelector('[data-tasks-filter="active"]').click(); assert.equal(titles().length,3);
});

async function settings(t, handler) {
  const dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main'),calls=[];
  const dispose=mountJiraWorkflowSettings(host,{invoke:async(command,args)=>{calls.push({command,args});return handler(command,args);},errorText:()=> 'Не удалось сохранить правила.'});
  t.after(()=>{dispose();dom.window.close();});
  dispose.setConnection({enabled:true,site:'example.atlassian.net',project:'DEMO'});
  const q=name=>host.querySelector(`[data-workflow-${name}]`);
  q('reload').click();await settle();return {dom,host,calls,dispose,q};
}

test('project settings load the complete catalog safely; assignment and bulk application require explicit save', async t => {
  const x=await settings(t,(command,args)=>command==='get_ui_state'?null:command==='jira_workflow_save'?{...options(),revision:'revision-2',statuses:args.mappings,defaultProcessId:args.defaultProcessId}:options());
  assert.equal(x.host.querySelector('img'),null);
  assert.equal(x.q('map').querySelectorAll('select').length,3);
  assert.equal(x.q('map').querySelector('select').value,'','To Do is not guessed');
  assert.equal(x.calls.some(call=>call.command==='jira_workflow_save'),false);
  x.q('map').querySelector('select').value='ready';
  x.q('process').value='system-analysis'; x.q('process').dispatchEvent(new x.dom.window.Event('change',{bubbles:true}));
  assert.equal(x.q('apply').checked,false);
  x.q('save').click();await settle();
  const args=x.calls.find(call=>call.command==='jira_workflow_save').args;
  assert.equal(args.scope,'example-scope');assert.equal(args.expectedRevision,'revision-1');
  assert.equal(args.applyToExisting,false);assert.equal(args.defaultProcessId,'system-analysis');
  assert.equal(args.mappings[0].bucket,'ready');assert.equal(x.dispose.isDirty(),false);
});

test('failed workflow save preserves the edited rules and never applies the process implicitly', async t => {
  const x=await settings(t,command=>{if(command==='get_ui_state')return null;if(command==='jira_workflow_save')throw 'private raw response';return options();});
  const select=x.q('map').querySelector('select');select.value='working';select.dispatchEvent(new x.dom.window.Event('change',{bubbles:true}));
  x.q('save').click();await settle();
  assert.equal(select.value,'working');assert.equal(x.dispose.isDirty(),true);
  assert.equal(x.q('message').getAttribute('role'),'alert');assert.doesNotMatch(x.host.textContent,/private raw/);
  x.dispose.setConnection({enabled:true,site:'example.atlassian.net',project:'OTHER'});
  assert.equal(x.q('fields').hidden,true);assert.equal(x.dispose.isDirty(),false);
});
