import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const settle = async () => { for (let i = 0; i < 14; i++) await new Promise(resolve => setImmediate(resolve)); };
const options = { project:'DEMO', requestId:'request-1', recovery:null, issueTypes:[{id:'1',name:'Task'},{id:'2',name:'Bug'}] };
async function form(t, handlers = {}, modalOptions = {}) {
  const dom = new JSDOM('<body></body>', {url:'http://localhost',pretendToBeVisual:true}), w = dom.window;
  for (const name of ['window','document','localStorage','MutationObserver','AbortController','CustomEvent','Event','FormData','Option']) globalThis[name] = name === 'window' ? w : w[name];
  globalThis.marked = {Marked:class {use() {} parse(value) {return value;}}};
  const calls = [], replies = {list_event_categories:[],get_goals:[],get_calendar_task_goals:[],get_app_state:null,
    jira_create_options:options,jira_task_create:{requestId:'request-1',itemId:'jira:synthetic',title:'BE: Example',status:'To Do',changed:1},jira_create_acknowledge:{acknowledged:true},save_calendar_task:'personal-1',...handlers};
  w.__TAURI__ = {core:{invoke:async (command,args) => {
    calls.push({command,args}); if (!(command in replies)) throw Error(`Unexpected IPC ${command}`);
    return typeof replies[command] === 'function' ? replies[command](args) : replies[command];
  }}};
  t.after(() => w.close());
  const {showCalendarCreateModal} = await import('../src/hanni/js/calendar-event-modal.js');
  await showCalendarCreateModal(null,{initialNoDate:true,...modalOptions}); await settle();
  const q = s => w.document.querySelector(s), saved = c => calls.filter(x=>x.command===c).map(x=>x.args);
  q('#evm-title').value = 'BE: Example';
  const work = async () => {q('[data-evm-scope="work"]').click();await settle();};
  const submit = async () => {q('#evm-form').requestSubmit();await settle();};
  return {w,q,saved,replies,work,submit,open:async()=>{await showCalendarCreateModal(null,{initialNoDate:true});await settle();}};
}

test('personal creation needs no Jira and work creation sends only a typed title/type/local request', async t => {
  const x = await form(t);
  await x.submit(); assert.equal(x.saved('save_calendar_task').length,1); assert.equal(x.saved('jira_create_options').length,0);
  await x.open(); x.q('#evm-title').value='BE: Example'; await x.work();
  assert.equal(x.q('#evm-save').textContent,'Создать в Jira'); assert.equal(x.q('#evm-save').disabled,true);
  await x.submit(); assert.equal(x.saved('jira_task_create').length,0);
  x.q('[data-jira-create-type]').value='2'; x.q('[data-jira-create-type]').dispatchEvent(new x.w.Event('change'));
  x.q('#evm-desc').value='Forbidden hidden event description';
  await x.submit();
  const [request] = x.saved('jira_task_create');
  assert.deepEqual(Object.keys(request).sort(),['issueTypeId','local','requestId','title']);
  assert.equal(request.issueTypeId,'2'); assert.equal(request.title,'BE: Example'); assert.equal(request.local.process,'');
  assert.equal(JSON.stringify(request).includes('Forbidden'),false);
  assert.equal(x.saved('save_calendar_task').length,1); assert.equal(x.saved('jira_create_acknowledge').length,1); assert.equal(x.q('#evm-form'),null);
});

test('Jira unavailable keeps the work draft and never falls back to a local work task', async t => {
  const x = await form(t,{jira_create_options:()=>{throw 'jira_not_configured';}}); await x.work(); await x.submit();
  assert.equal(x.saved('save_calendar_task').length,0); assert.equal(x.saved('jira_task_create').length,0); assert.equal(x.q('#evm-title').value,'BE: Example');
  x.q('[data-evm-scope="personal"]').click(); await x.submit(); assert.equal(x.saved('save_calendar_task').length,1);
});

test('lost create response reconciles durable unknown state and requires explicit acknowledgement', async t => {
  const x = await form(t); await x.work(); x.q('[data-jira-create-type]').value='1';
  x.replies.jira_task_create = () => {
    x.replies.jira_create_options={...options,requestId:null,issueTypes:[],recovery:{requestId:'request-1',state:'unknown',title:'BE: Example'}};
    throw Error('RAW PRIVATE SERVER TEXT');
  };
  await x.submit(); assert.equal(x.saved('jira_task_create').length,1); assert.equal(x.q('#evm-save').disabled,true);
  assert.equal(x.w.document.body.textContent.includes('RAW PRIVATE'),false); assert.equal(x.q('#evm-title').value,'BE: Example');
  await x.submit(); assert.equal(x.saved('jira_task_create').length,1); assert.equal(x.saved('jira_create_acknowledge').length,0);
  x.replies.jira_create_options={...options,requestId:'request-2'};
  x.q('[data-jira-create-ack]').click(); await settle();
  assert.deepEqual(x.saved('jira_create_acknowledge'),[{requestId:'request-1'}]); assert.equal(x.saved('jira_task_create').length,1);
});

test('reopening after lost successful response presents existing task without another POST', async t => {
  const x = await form(t,{jira_create_options:{...options,requestId:null,issueTypes:[],recovery:{requestId:'request-1',state:'created',itemId:'jira:synthetic',title:'<img src=x onerror=alert(1)>',status:'To Do'}}});
  await x.work(); assert.equal(x.q('img'),null); assert.match(x.q('[data-jira-create-recovery]').textContent,/уже создана/);
  x.q('[data-jira-create-ack]').click(); await settle();
  assert.equal(x.saved('jira_task_create').length,0); assert.equal(x.saved('jira_create_acknowledge').length,1); assert.equal(x.q('#evm-form'),null);
});

test('failed final acknowledgement retries only acknowledgement and locks already created fields', async t => {
  let acknowledgements=0;
  const x = await form(t,{jira_create_acknowledge:()=>{if(++acknowledgements===1)throw Error('IPC lost');return {acknowledged:true};}});
  await x.work(); x.q('[data-jira-create-type]').value='1'; await x.submit();
  assert.equal(x.q('#evm-fields').disabled,true); assert.match(x.q('#evm-error').textContent,/уже создана/);
  await x.submit(); assert.equal(x.saved('jira_task_create').length,1); assert.equal(acknowledgements,2); assert.equal(x.q('#evm-form'),null);
});

test('a slow metadata response cannot convert a switched personal form to Jira', async t => {
  let resolve;
  const x = await form(t,{jira_create_options:()=>new Promise(r=>{resolve=r;})});
  await x.work(); x.q('[data-evm-scope="personal"]').click(); resolve(options); await settle();
  assert.equal(x.q('#evm-jira-create').hidden,true); await x.submit();
  assert.equal(x.saved('save_calendar_task').length,1); assert.equal(x.saved('jira_task_create').length,0);
});

test('recovery acknowledgement locks edits and closing until it finishes', async t => {
  let resolve;
  const x = await form(t,{jira_create_options:{...options,requestId:null,recovery:{requestId:'request-1',state:'created',itemId:'jira:synthetic',title:'BE: Example'}},jira_create_acknowledge:()=>new Promise(r=>{resolve=r;})});
  await x.work(); x.q('[data-jira-create-ack]').click(); await settle();
  assert.equal(x.q('#evm-fields').disabled,true); assert.equal(x.q('#evm-close').disabled,true);
  x.q('[data-evm-scope="personal"]').click(); assert.equal(x.q('[data-evm-scope="work"]').getAttribute('aria-pressed'),'true');
  resolve({acknowledged:true}); await settle(); assert.equal(x.q('#evm-form'),null);
});

test('recovering this form successful POST retries skill attachment before acknowledgement without a second POST', async t => {
  let linked=0;
  const x = await form(t,{}, {onTaskSaved:async record=>{assert.equal(record.id,'jira:synthetic');if(++linked===1)throw Error('Local link failed');}});
  x.replies.jira_task_create=()=>{x.replies.jira_create_options={...options,requestId:null,recovery:{requestId:'request-1',state:'created',itemId:'jira:synthetic',title:'BE: Example'}};throw Error('IPC lost');};
  await x.work(); x.q('[data-jira-create-type]').value='1'; await x.submit();
  x.q('[data-jira-create-ack]').click(); await settle(); assert.equal(x.saved('jira_create_acknowledge').length,0); assert.ok(x.q('#evm-form'));
  x.q('[data-jira-create-ack]').click(); await settle();
  assert.equal(linked,2); assert.equal(x.saved('jira_task_create').length,1); assert.equal(x.saved('jira_create_acknowledge').length,1); assert.equal(x.q('#evm-form'),null);
});
