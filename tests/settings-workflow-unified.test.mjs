import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountWorkflowSettings } from '../src/hanni/js/calendar-workflow-settings.js';
import { workflowPreview } from '../src/hanni/js/jira-workflow-model.js';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const options = () => ({ scope:'scope-demo', revision:'rev1', project:'DEMO', defaultProcessId:null, statuses:[{name:'To Do',bucket:'ready'},{name:'Working',bucket:'working'},{name:'Review',bucket:'review'},{name:'BACKLOG',bucket:'completed'},{name:'Unused',bucket:'hidden'},{name:'Empty status',bucket:null}] });
const row = (id, status, extra = {}) => ({ source_type:'note',source_id:`jira:${id.toString(16).padStart(64,'0')}`,jira_status:status,jira_workflow_scope:'scope-demo',status_extra:'task',...extra });
async function boot(t, { failRules = false, failTemplates = false, readTasks = true, cached = true, initialRules = options() } = {}) {
  const dom = new JSDOM('<main></main>', { url:'https://example.invalid', pretendToBeVisual:true });
  const host = dom.window.document.querySelector('main'), calls = [], state = { raw:null, rules:initialRules, failRules, failTemplates }, pending = [];
  const invoke = async (command, args) => {
    calls.push({command,args});
    if (command === 'get_ui_state') return state.raw;
    if (command === 'set_ui_state') { if (state.failTemplates) throw 'mvp_sync_stale_ui_state'; state.raw = args.value; return null; }
    if (command === 'jira_workflow_cached') return cached ? state.rules : null;
    if (command === 'get_calendar_tasks') { if (!readTasks) throw 'offline'; return [row(1,'To Do'),row(2,'Working'),row(3,'BACKLOG'),row(4,'Review'),row(5,'Unused',{is_active:true}),row(6,'Empty status'),row(7,'To Do',{jira_workflow_scope:'another-project'}),row(8,'To Do',{archived:true})]; }
    if (command === 'jira_workflow_save') { if (state.failRules) throw 'jira_workflow_stale'; state.rules = {...state.rules,revision:'rev2',statuses:args.mappings,defaultProcessId:args.defaultProcessId}; return state.rules; }
    if (command === 'jira_import_now') throw 'jira_token_unavailable';
    throw new Error(command);
  };
  const api = mountWorkflowSettings(host, {invoke,setPending:value=>pending.push(value)});
  t.after(() => {api.dispose();dom.window.close();}); await settle();
  const q = selector => host.querySelector(selector);
  const change = (selector, value, type='change') => { const field=q(selector);field.value=value;field.dispatchEvent(new dom.window.Event(type,{bubbles:true}));return field; };
  return {dom,host,api,state,calls,pending,q,change};
}

test('one settings editor reads local rules without Jira credentials and keeps empty statuses', async t => {
  const x = await boot(t);
  assert.equal(x.q('[data-process-area="work"]').textContent,'Работа · DEMO');
  assert.equal(x.q('[data-process-work]').hidden,false);
  assert.equal(x.q('[data-process-personal]').hidden,true);
  assert.equal(x.q('[data-workflow-status="Empty status"]').value,'');
  assert.equal(x.host.querySelectorAll('[data-workflow-status]').length,6);
  assert.equal(x.calls.some(call=>['jira_import_now','jira_workflow_options'].includes(call.command)),false);
  assert.equal(x.q('[data-workflow-process]').value,'');
  assert.equal(x.q('[data-workflow-apply]').checked,false);
  assert.equal(x.q('[data-workflow-editor] .calendar-processes').hidden,true);
  assert.ok(x.q('[data-workflow-create]'));
  assert.match(x.q('[data-workflow-stages]').parentNode.dataset.workflowRow,/Working/);
  assert.equal(x.api.isDirty(),false);
});

test('preview uses draft rules, verified membership and running tasks, without task titles', async t => {
  const x = await boot(t), counts = () => Object.fromEntries([...x.host.querySelectorAll('[data-workflow-count]')].map(el=>[el.dataset.workflowCount,Number(el.querySelector('strong').textContent)]));
  assert.deepEqual(counts(),{queue:3,review:1,completed:1,all:6});
  x.change('[data-workflow-status="To Do"]','hidden');
  assert.deepEqual(counts(),{queue:2,review:1,completed:1,all:6});
  assert.equal(x.q('[data-workflow-status="To Do"]').value,'hidden');
  assert.equal(x.q('[data-workflow-reload]').disabled,true,'reload must not erase draft mappings');
  assert.deepEqual(workflowPreview([row(1,'Review',{completed:true}),row(2,'BACKLOG',{is_active:true}),row(3,'To Do',{readonly:true})],'scope-demo',options().statuses),{queue:1,review:0,completed:1,all:2,onlyAll:0});
});

test('switching work and personal moves the same template draft and never writes a personal default', async t => {
  const x = await boot(t);
  x.change('[data-workflow-process]','system-analysis');
  const editor = x.q('.calendar-processes');
  x.change('[data-stage-id="analysis"] [data-control="stage-title"]','Модели','input');
  x.change('[data-workflow-status="Review"]','hidden');
  x.q('[data-process-area="personal"]').click();
  assert.equal(x.q('[data-process-personal-editor] .calendar-processes'),editor);
  assert.equal(x.q('[data-stage-id="analysis"] [data-control="stage-title"]').value,'Модели');
  assert.match(x.q('[data-process-personal]').textContent,/создаётся без этапов/);
  x.q('[data-process-area="work"]').click();
  assert.equal(x.q('[data-workflow-editor] .calendar-processes'),editor);
  assert.equal(x.q('[data-workflow-status="Review"]').value,'hidden');
  assert.equal(x.api.isDirty(),true);
  assert.equal(x.calls.some(call=>call.command==='set_ui_state'||call.command==='jira_workflow_save'),false);
});

test('unified save persists templates before rules and refreshes names without implicit bulk application', async t => {
  const x = await boot(t);
  x.change('[data-workflow-process]','system-analysis');
  x.change('[data-control="process-title"]','Анализ','input');
  x.q('[data-unified-save]').click(); await settle();
  assert.equal(x.api.isDirty(),false);
  assert.equal(JSON.parse(x.state.raw).processes[0].title,'Анализ');
  const writes=x.calls.filter(call=>['set_ui_state','jira_workflow_save'].includes(call.command));
  assert.deepEqual(writes.map(call=>call.command),['set_ui_state','jira_workflow_save']);
  assert.equal(writes[1].args.defaultProcessId,'system-analysis');assert.equal(writes[1].args.applyToExisting,false);
  assert.equal(x.q('[data-workflow-process] option:checked').textContent,'Анализ');
  assert.equal(x.q('[data-process-result]').textContent,'Изменения сохранены.');
  assert.equal(x.pending.at(-1),false);
});

test('rule failure after a template save reports the partial result and preserves the remaining draft', async t => {
  const x=await boot(t,{failRules:true});
  x.change('[data-workflow-process]','system-analysis');
  x.change('[data-stage-id="analysis"] [data-control="stage-title"]','Модели','input');
  x.q('[data-unified-save]').click();await settle();
  assert.match(x.q('[data-process-result]').textContent,/Шаблоны этапов сохранены.*Правила проекта не сохранены/);
  assert.match(x.q('[data-process-draft]').textContent,/Не сохранены: правила проекта/);
  assert.equal(x.api.isDirty(),true);assert.equal(x.q('[data-workflow-process]').value,'system-analysis');
  x.state.failRules=false;x.q('[data-unified-save]').click();await settle();
  assert.equal(x.api.isDirty(),false);
  assert.equal(x.calls.filter(call=>call.command==='set_ui_state').length,1,'retry saves only the remaining rules');
});

test('template failure prevents rule writes; cancel rereads saved data and drops both drafts', async t => {
  const x=await boot(t,{failTemplates:true});
  x.change('[data-workflow-process]','system-analysis');
  x.change('[data-stage-id="analysis"] [data-control="stage-title"]','Модели','input');
  x.q('[data-unified-save]').click();await settle();
  assert.equal(x.calls.some(call=>call.command==='jira_workflow_save'),false);
  assert.match(x.q('[data-process-draft]').textContent,/шаблоны этапов и правила проекта/);
  x.q('[data-unified-cancel]').click();await settle();
  assert.equal(x.api.isDirty(),false);assert.equal(x.q('[data-workflow-process]').value,'');
  x.q('[data-process-area="personal"]').click();
  assert.equal(x.q('[data-stage-id="analysis"] [data-control="stage-title"]').value,'Анализ и модели');
});

test('a newly created process is editable inline and saved before it becomes a project default', async t => {
  const x=await boot(t);
  x.q('[data-workflow-create]').click();
  const processId=x.q('[data-workflow-process]').value;
  assert.notEqual(processId,'');assert.notEqual(processId,'system-analysis');
  x.change('[data-control="process-title"]','Проверка','input');
  x.change('[data-control="stage-title"]','Проверить результат','input');
  x.q('[data-unified-save]').click();await settle();
  assert.equal(x.state.rules.defaultProcessId,processId);
  assert.ok(JSON.parse(x.state.raw).processes.some(process=>process.id===processId));
  assert.equal(x.api.isDirty(),false);
});

test('failed explicit Jira refresh leaves cached rules editable; missing task counts are not shown as zero', async t => {
  const x=await boot(t,{readTasks:false});
  assert.match(x.q('[data-workflow-preview-note]').textContent,/Количество задач недоступно/);
  assert.equal(x.q('[data-workflow-count]'),null);
  x.q('[data-workflow-reload]').click();await settle();
  assert.equal(x.q('[data-workflow-message]').getAttribute('role'),'alert');
  assert.equal(x.q('[data-workflow-status="To Do"]').value,'ready');
  x.change('[data-workflow-status="To Do"]','hidden');
  x.q('[data-unified-save]').click();await settle();assert.equal(x.api.isDirty(),false);
});

test('without Jira the personal template editor stays usable and no project rules are invented', async t => {
  const x=await boot(t,{cached:false});
  assert.equal(x.q('[data-process-personal]').hidden,false);
  x.change('[data-stage-id="analysis"] [data-control="stage-title"]','Модели','input');
  x.q('[data-unified-save]').click();await settle();
  assert.equal(x.calls.some(call=>call.command==='jira_workflow_save'),false);
  assert.equal(x.api.isDirty(),false);
});

test('validation reveals an invalid personal template without changing the project default', async t => {
  const x=await boot(t);
  x.change('[data-workflow-process]','system-analysis');
  x.q('[data-unified-save]').click();await settle();
  x.q('[data-process-area="personal"]').click();x.q('[data-processes-add]').click();
  const invalidId=x.q('[data-processes-select]').value;
  x.q('[data-process-area="work"]').click();
  assert.equal(x.q('[data-workflow-process]').value,'system-analysis');
  x.q('[data-unified-save]').click();await settle();
  assert.equal(x.q('[data-process-personal]').hidden,false);
  assert.equal(x.q('[data-processes-select]').value,invalidId);
  assert.equal(x.q('[data-workflow-process]').value,'system-analysis');
  assert.equal(x.calls.filter(call=>call.command==='jira_workflow_save').length,1);
  assert.match(x.q('[data-processes-error]').textContent,/Назови процесс/);
});

test('an invalid template hidden by no project process is revealed before validation focuses its field', async t => {
  const x=await boot(t);
  x.q('[data-process-area="personal"]').click();
  x.change('[data-control="process-title"]','','input');
  x.q('[data-process-area="work"]').click();
  x.q('[data-unified-save]').click();await settle();
  assert.equal(x.q('[data-process-personal]').hidden,false);
  assert.equal(x.q('[data-workflow-process]').value,'');
  assert.equal(x.dom.window.document.activeElement,x.q('[data-control="process-title"]'));
  assert.equal(x.q('[data-control="process-title"]').getAttribute('aria-invalid'),'true');
});


test('status rows follow saved roles, preserve catalog order within each role and stay put while editing', async t => {
  const statuses=[{name:'Done',bucket:'hidden'},{name:'BACKLOG',bucket:'completed'},{name:'Draft',bucket:null},{name:'Queued B',bucket:'ready'},{name:'Working',bucket:'working'},{name:'Queued A',bucket:'ready'},{name:'Review',bucket:'review'},{name:'To Do',bucket:null}];
  const x=await boot(t,{initialRules:{...options(),statuses}});
  const order=()=>[...x.host.querySelectorAll('[data-workflow-row]')].map(row=>row.dataset.workflowRow);
  const savedOrder=['Queued B','Queued A','Working','Review','BACKLOG','Done','Draft','To Do'];
  assert.deepEqual(order(),savedOrder,'the spelling of To Do does not assign it a role');
  x.change('[data-workflow-status="Done"]','ready');
  assert.deepEqual(order(),savedOrder,'changing a rule does not move its control');
  x.q('[data-process-area="personal"]').click();x.q('[data-process-area="work"]').click();
  assert.deepEqual(order(),savedOrder,'switching areas preserves draft row positions');
  x.q('[data-unified-save]').click();await settle();
  assert.deepEqual(order(),['Done','Queued B','Queued A','Working','Review','BACKLOG','Draft','To Do'],'accepted rules reorder the view while keeping catalog order inside each role');
});
