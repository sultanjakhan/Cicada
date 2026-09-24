import{
   createRequire
  }
from 'node:module';
import{
   fileURLToPath
  }
from 'node:url';
const require = createRequire(import.meta.url);
const path = require('node:path');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const{
   JSDOM
  }
= require('jsdom');
const toData = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const source = fs.readFileSync(path.join(root, 'src/hanni/js/calendar-now.js'), 'utf8') .replace(/^import .*state\.js';$/m, 'const defaultInvoke = () => { throw new Error("Inject invoke in tests"); };') .replace(/^import .*task-picker-sort\.js';$/m, 'const defaultRankTasks = items => items;') .replace(/^import .*task-picker-view\.js';$/m, 'const loadCategoryWeights = async () => ({});') .replace("'./icons.js'", JSON.stringify(toData(fs.readFileSync(path.join(root, 'src/hanni/js/icons.js'), 'utf8')))) .replace("'./calendar-dialog.js'", JSON.stringify(toData(fs.readFileSync(path.join(root, 'src/hanni/js/calendar-dialog.js'), 'utf8'))));
const modulePromise = import(toData(source.replace("'./calendar-execution.js'", JSON.stringify(new URL('../src/hanni/js/calendar-execution.js', import.meta.url).href)).replace("'./calendar-context-menu.js'", JSON.stringify(new URL('../src/hanni/js/calendar-context-menu.js', import.meta.url).href)).replace("'./task-importance.js'", JSON.stringify(new URL('../src/hanni/js/task-importance.js', import.meta.url).href))));
const rankPromise = import(toData(fs.readFileSync(path.join(root, 'src/hanni/js/task-picker-sort.js'), 'utf8')));
const clone = value => structuredClone(value);
const blank = () => ({
   version: 1, goalId: 'goal-a', selectionMode: 'auto', selection: null, execution: null, completed: null
  });

test('remote refresh rereads saved goal without writing the old cached selection back', async t => {
  const x=await mount(t);const before=x.data.count('set_ui_state');
  x.data.stored=JSON.stringify({...blank(),goalId:'goal-b'});
  x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('task-state-changed',{detail:{remoteSync:true,canCommit:()=>true}}));await x.settle();
  assert.match(x.ui('goal-title').textContent,/Гардероб/);assert.equal(x.data.count('set_ui_state'),before);assert.equal(JSON.parse(x.data.stored).goalId,'goal-b');
});

test('remote refresh waits for an open picker and never overwrites its draft', async t => {
  const x=await mount(t);await x.click('open-goal');const picker=x.dom.window.document.querySelector('.calendar-goal-picker');
  const search=picker.querySelector('[data-goal-search]');search.value='draft query';search.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
  const reads=x.data.count('get_ui_state');x.data.stored=JSON.stringify({...blank(),goalId:'goal-b'});
  x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('task-state-changed',{detail:{remoteSync:true,canCommit:()=>!picker.open}}));await x.settle();
  assert.equal(search.value,'draft query');assert.equal(x.data.count('get_ui_state'),reads);assert.equal(picker.open,true);
  picker.close();x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('task-state-changed',{detail:{remoteSync:true,canCommit:()=>true}}));await x.settle();assert.match(x.ui('goal-title').textContent,/Гардероб/);
});

test('CAS rejects a stale local choice and retry reads remote state without overwriting it', async t => {
  const x=await mount(t);const initial=x.data.stored;const remote=JSON.stringify({...blank(),goalId:'goal-b'});
  x.data.before.set('set_ui_state',args=>{assert.equal(args.expectedValue,initial);x.data.stored=remote;throw Error('mvp_sync_stale_ui_state');});
  await x.click('start');assert.equal(x.data.stored,remote);assert.match(x.ui('error-text').textContent,/другом устройстве/);
  x.data.before.delete('set_ui_state');await x.click('retry');assert.equal(JSON.parse(x.data.stored).goalId,'goal-b');
  assert.equal(x.data.count('start_task_block'),1,'retry must not restart the already committed timer');
});

test('a newer remote revision during a read is reread before replacing Now state', async t => {
  const x=await mount(t);let release;const pause=new Promise(resolve=>{release=resolve;});
  x.data.after.set('get_ui_state',async()=>{x.data.after.delete('get_ui_state');await pause;});
  x.data.stored=JSON.stringify({...blank(),goalId:'goal-b'});
  const sync=()=>x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('task-state-changed',{detail:{remoteSync:true,canCommit:()=>true}}));sync();
  await new Promise(resolve=>setImmediate(resolve));x.data.stored=JSON.stringify({...blank(),goalId:null});sync();release();await x.settle();
  assert.equal(JSON.parse(x.data.stored).goalId,null);assert.doesNotMatch(x.ui('goal-title').textContent,/Карьера|Гардероб/);assert.equal(x.data.count('set_ui_state'),0);
});
function backend(initial = blank()){
   const state ={
     stored: initial == null ? null : JSON.stringify(initial), now: new Date('2026-09-05T10:00:00'), goals: [{
       id: 'goal-a', title: 'Карьера', status: 'active'
          },{
       id: 'goal-b', title: 'Гардероб', status: 'active'
          }], tasks: [{
       source_type: 'event', source_id: 'event-a', title: 'Вопросы к интервью', duration_minutes: 25, priority: 2, category: 'work', completed: false, tracking_mode: 'track'
          },{
       source_type: 'note', source_id: 'task-a', title: 'Заметки по API', duration_minutes: 15, priority: 1, category: 'work', completed: false, tracking_mode: 'check', date: null
          }, ], links: [{
       source_type: 'event', source_id: 'event-a', goal_id: 'goal-a'
          },{
       source_type: 'note', source_id: 'task-a', goal_id: 'goal-a'
          }], blocks: [], calls: [], before: new Map(), after: new Map(), nextId: 100,
      };
   const invoke = async (command, args ={

      }) =>{
     state.calls.push({
       command, args: clone(args)
          });
     if (state.before.has(command)) await state.before.get(command)(args);
     let result;
     if (command === 'get_ui_state') result = state.stored;
     else if (command === 'set_ui_state'){
       assert.equal(args.key, 'calendar_now_v1');
       state.stored = args.value;

          }
     else if (command === 'get_goals'){
       result = state.goals;

          }
     else if (command === 'get_calendar_task_goals') result = state.links;
     else if (command === 'get_calendar_records'){
       assert.equal(args.start, args.end);
       result = state.tasks.filter(task => !task.date || task.date === args.start);

          }
     else if (command === 'get_calendar_task_minutes'){
       result = Math.floor(state.blocks.filter(block => !block.is_active && block.source_type === args.sourceType && String(block.source_id) === args.sourceId && (args.sourceType !== 'schedule' || (block.completion_date || block.date) === args.completionDate)) .reduce((sum, block) => sum + Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60), 0) / 60);

          }
     else if (command === 'get_calendar_task_seconds'){
       result = state.blocks.filter(block => !block.is_active && block.source_type === args.sourceType && String(block.source_id) === args.sourceId && (args.sourceType !== 'schedule' || (block.completion_date || block.date) === args.completionDate)) .reduce((sum, block) => sum + Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60), 0);

          }
     else if (command === 'get_task_pins') result = [];
     else if (command === 'get_active_block') result = state.blocks.find(block => block.is_active) || null;
     else if (command === 'get_active_blocks') result = state.blocks.filter(block => block.is_active).reverse();
     else if (command === 'get_latest_task_block') result = state.blocks.at(-1) || null;
     else if (command === 'get_timeline_blocks') result = state.blocks.filter(block => block.date === args.date);
     else if (command === 'get_all_events') result = state.tasks.filter(task => task.source_type === 'event').map(task => ({
       ...task, id: task.source_id
          }));
     else if (command === 'get_note') result = state.tasks.find(task => task.source_type === 'note' && String(task.source_id) === String(args.id));
     else if (command === 'get_schedules') result = [];
     else if (command === 'start_task_block'){
       // Several tasks may run at once; one source never gets a second running block.
       const existing = state.blocks.find(block => block.is_active && block.source_type === args.sourceType && block.source_id === args.sourceId);
       if (existing && args.failIfActive) throw new Error('task is already active');
       if (existing) result = existing.id;
       else{
         result = state.nextId++;
         state.blocks.push({
           id: result, date: `${state.now.getFullYear()}-${String(state.now.getMonth() + 1).padStart(2, '0')}-${String(state.now.getDate()).padStart(2, '0')}`, completion_date: args.completionDate, start_time: `${String(state.now.getHours()).padStart(2, '0')}:${String(state.now.getMinutes()).padStart(2, '0')}`, duration_minutes: 0, duration_seconds: 0, source_type: args.sourceType, source_id: args.sourceId, is_active: true
                  });

              }

          }
     else if (command === 'pause_task_block' || command === 'finish_task_block'){
       const block = state.blocks.find(value => value.id === args.blockId);
       assert.ok(block);
       if (block.is_active){
         block.duration_seconds = Math.max(0, Math.floor((state.now - new Date(`${block.date}T${block.start_time}`)) / 1000));
         block.duration_minutes = Math.floor(block.duration_seconds / 60);
         block.is_active = false;

              }
       if (command === 'finish_task_block'){
         const task = state.tasks.find(value => value.source_type === block.source_type && String(value.source_id) === block.source_id);
         if (task){
           task.completed = true;
           task.status_extra = 'done';

                  }

              }

          }
     else throw new Error('Unexpected command ' + command);
     if (state.after.has(command)) await state.after.get(command)(args);
     return clone(result);

      };
   state.invoke = invoke;
   state.count = command => state.calls.filter(call => call.command === command).length;
   state.onceFail = (command, phase = 'before') =>{
     state[phase].set(command, () =>{
       state[phase].delete(command);
       throw new Error('synthetic failure');

          });

      };
   return state;

  }
async function mount(t, data = backend(), dependencies ={

  }){
   const{
     mountCalendarNow
      }
   = await modulePromise;
   const{
     rankTasks
      }
   = await rankPromise;
   const dom = new JSDOM('<div id="host"></div>',{
     url: 'http://127.0.0.1/', pretendToBeVisual: true
      });
   dom.window.HTMLDialogElement.prototype.showModal = function (){
     this.open = true;
     this.querySelector('button')?.focus();

      };
   dom.window.HTMLDialogElement.prototype.close = function (){
     this.open = false;
     this.dispatchEvent(new dom.window.Event('close'));

      };
   const errors = [];
   dom.window.addEventListener('error', event => errors.push(event.error));
   const host = dom.window.document.getElementById('host');
   const header = dependencies.header ? dom.window.document.createElement('div') : null;
   if (header) host.before(header);
   const currentTasks = [];
   const cleanup = mountCalendarNow(host,{
     invoke: data.invoke, headerElement:header, now: () => new Date(data.now), loadWeights: async () => ({
       work: 1
          }), rankTasks, onCurrentTaskChange: value => currentTasks.push(value), ...dependencies
      });
   t.after(() =>{
     cleanup();
     dom.window.close();
     assert.deepEqual(errors, []);

      });
   const ui = name => host.querySelector(`[data-ui="${name}"]`);
   const action = name => host.querySelector(`[data-action="${name}"]`);
   const settle = async () =>{
     for (let i = 0;
     i < 60;
     i++){
       await new Promise(resolve => setImmediate(resolve));
       if (ui('card').getAttribute('aria-busy') === 'false') return;

          }
     throw new Error('did not settle');

      };
   const click = async name =>{
     action(name).click();
     await settle();

      };
   const choose = async (kind, value) =>{
     await click('open-' + kind);
     if (kind === 'goal'){
       dom.window.document.querySelector(`[data-goal-choice="${value}"]`).click();
       await settle();
       return;

          }
     if (kind === 'task' && ui('task-full').hidden) await click('all-tasks');
     ui(kind + '-select').value = value;
     ui(kind + '-form').dispatchEvent(new dom.window.Event('submit',{
       bubbles: true, cancelable: true
          }));
     await settle();

      };
   const refresh = async () =>{
     dom.window.dispatchEvent(new dom.window.Event('task-state-changed'));
     await settle();

      };
   await settle();
   return{
     dom, host, header, data, ui, action, settle, click, choose, refresh, cleanup, currentTasks
      };

  }
test('header hides empty, automatic and completed work while explicit selection opens the same details', async t => {
  const opened = [], x = await mount(t, backend(), { header:true, openTaskDetails:(row,restore)=>opened.push({row,restore}) });
  assert.equal(x.header.hidden, true, 'an automatic suggestion is not a selected task');
  await x.choose('task', 'note:task-a');
  const title = x.header.querySelector('[data-header-action="details"]');
  assert.equal(x.header.hidden, false);
  assert.equal(title.textContent, 'Заметки по API');
  assert.equal(title.title, 'Заметки по API');
  assert.equal(x.data.count('start_task_block'), 0);
  title.focus(); title.click();
  assert.equal(opened.at(-1).row.source_id, 'task-a');
  assert.equal(opened.at(-1).row.is_active, false);
  x.ui('card').focus(); opened.at(-1).restore();
  assert.equal(x.dom.window.document.activeElement, title);
  x.header.querySelector('[data-header-action="toggle"]').click(); await x.settle();
  await x.click('finish');
  assert.equal(x.header.hidden, true);
  const empty = await mount(t, backend({ ...blank(), goalId:null }), { header:true });
  assert.equal(empty.header.hidden, true);
});

test('hidden full surface shares header start, pause and retry without duplicate blocks or hidden focus', async t => {
  const x = await mount(t, backend(), { header:true });
  await x.choose('task', 'note:task-a');
  x.host.hidden = true;
  const toggle = x.header.querySelector('[data-header-action="toggle"]');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  x.data.before.set('start_task_block', () => pending);
  toggle.click(); toggle.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.data.count('start_task_block'), 1);
  assert.equal(toggle.disabled, true);
  release(); await x.settle();
  x.data.before.delete('start_task_block');
  assert.equal(toggle.textContent, 'Пауза');
  assert.equal(x.dom.window.document.activeElement, toggle);
  x.data.now = new Date('2026-09-05T10:04:00');
  toggle.click(); await x.settle();
  assert.equal(toggle.textContent, 'Продолжить');
  assert.equal(x.header.querySelector('[data-header-time]').textContent, '4 мин');
  x.data.onceFail('set_ui_state');
  toggle.click(); await x.settle();
  const retry = x.header.querySelector('[data-header-action="retry"]');
  assert.equal(x.header.querySelector('[data-header-error]').parentElement.hidden, false);
  assert.equal(toggle.disabled, true);
  assert.equal(x.dom.window.document.activeElement, retry);
  const starts = x.data.count('start_task_block');
  retry.click(); await x.settle();
  assert.equal(x.data.count('start_task_block'), starts, 'save retry must not start another interval');
  assert.equal(x.data.blocks.filter(block => block.is_active).length, 1);
  assert.equal(x.dom.window.document.activeElement, toggle);
  assert.equal(x.header.querySelector('[data-header-error]').parentElement.hidden, true);
});

test('unknown current work stays hidden on read failure while launcher exposes safe retry', async t => {
  const data = backend(); data.onceFail('get_ui_state');
  const x = await mount(t, data, { header:true });
  x.host.hidden = true;
  assert.equal(x.header.hidden, true);
  assert.equal(x.header.querySelector('[data-header-action="toggle"]').hidden, true);
  assert.match(x.cleanup.getLauncherState().error, /Не удалось обновить/);
  await x.cleanup.retry(); await x.settle();
  assert.equal(x.header.hidden, true, 'successful load has only an automatic suggestion');
  assert.equal(data.count('start_task_block'), 0);
});

test('late header start preserves input focus chosen in the same pane while native execution is pending', async t => {
  const x = await mount(t, backend(), { header:true });
  await x.choose('task', 'note:task-a');
  x.host.hidden = true;
  const input = x.dom.window.document.createElement('textarea');
  x.header.after(input);
  let release;
  x.data.before.set('start_task_block', () => new Promise(resolve => { release = resolve; }));
  const toggle = x.header.querySelector('[data-header-action="toggle"]');
  toggle.focus(); toggle.click();
  await new Promise(resolve => setImmediate(resolve));
  input.focus(); input.value = 'Новый текст заметки';
  release(); await x.settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.data.count('start_task_block'), 1);
  assert.equal(toggle.textContent, 'Пауза');
  assert.equal(input.value, 'Новый текст заметки');
  assert.equal(x.dom.window.document.activeElement, input);
});

test('header preserves routine step identity and occurrence across pause and resume', async t => {
  const data = backend({ ...blank(), goalId:null });
  const sourceId = JSON.stringify(['routine-a', '2026-09-04', 1]);
  data.tasks.push({ source_type:'schedule', source_id:sourceId, title:'Второй шаг', completion_date:'2026-09-04', tracking_mode:'track' });
  data.blocks.push({ id:80, source_type:'schedule', source_id:sourceId, date:'2026-09-04', completion_date:'2026-09-04', start_time:'23:59', is_active:true, duration_minutes:0 });
  const opened = [], x = await mount(t, data, { header:true, openTaskDetails:row=>opened.push(row) });
  x.host.hidden = true;
  x.header.querySelector('[data-header-action="details"]').click();
  assert.equal(opened[0].source_id, sourceId);
  assert.equal(opened[0].completion_date, '2026-09-04');
  const toggle = x.header.querySelector('[data-header-action="toggle"]');
  toggle.click(); await x.settle();
  assert.equal(toggle.textContent, 'Продолжить');
  toggle.click(); await x.settle();
  assert.equal(data.blocks.at(-1).source_id, sourceId);
  assert.equal(data.blocks.at(-1).completion_date, '2026-09-04');
  assert.equal(data.count('finish_task_block'), 0);
});

test('external execution notification never focuses a hidden full surface', async t => {
  const x = await mount(t, backend(), { header:true });
  await x.click('start');
  x.host.hidden = true;
  const toggle = x.header.querySelector('[data-header-action="toggle"]');
  toggle.focus();
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:execution-started', { cancelable:true }));
  await x.settle(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.dom.window.document.activeElement, toggle);
});

test('header presentation preserves goal details and allows goal selection after completed work without the removed Next button', async t => {
  const data = backend({ ...blank(), completed:{ source_type:'event', source_id:'event-a', title:'Вопросы к интервью' } });
  const x = await mount(t, data, { header:true, hideTaskCard:true });
  assert.equal(x.ui('card').hidden, true);
  assert.equal(x.host.querySelector('.calendar-now__goal').closest('[hidden]'), null);
  assert.equal(x.ui('goal-title').textContent, 'Карьера');
  assert.equal(x.action('open-goal').disabled, false);
  await x.cleanup.selectGoal('goal-b');
  assert.equal(x.ui('goal-title').textContent, 'Гардероб');
  assert.equal(JSON.parse(data.stored).completed, null);
  assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));
  assert.equal(data.count('start_task_block'), 0);
});

test('header menu switches and finishes an event without exposing the hidden task card', async t => {
  let launchers = 0;
  const x = await mount(t, backend(), { header:true, hideTaskCard:true, openTaskLauncher:()=>launchers++ });
  await x.data.invoke('start_task_block', { sourceType:'event', sourceId:'event-a', failIfActive:true, completionDate:'2026-09-05' });
  await x.refresh();
  const more = x.header.querySelector('[data-record-menu]');
  more.click();
  assert.equal(x.data.count('start_task_block'), 1);
  x.dom.window.document.querySelector('[data-menu-action="switch-task"]').click(); await x.settle();
  assert.equal(launchers, 1);
  assert.equal(x.data.count('pause_task_block'), 1);
  assert.equal(x.cleanup.getLauncherState().returnTask.source_id, 'event-a');
  assert.equal(x.header.hidden, true);
  await x.cleanup.returnTo(); await x.settle();
  more.click(); x.dom.window.document.querySelector('[data-menu-action="finish"]').click(); await x.settle();
  assert.equal(x.data.count('finish_task_block'), 1);
  assert.equal(x.data.tasks.find(task => task.source_id === 'event-a').completed, true);
  assert.equal(x.header.hidden, true);
  assert.equal(x.ui('card').hidden, true);
});

test('read-only current-task notifications track recommendation, active, paused and completed identity', async t =>{
   const x = await mount(t);
   assert.deepEqual(x.currentTasks.at(-1),{
     key: 'event:event-a', state: 'recommendation'
      });
   assert.equal(x.data.count('start_task_block'), 0);
   assert.equal(x.ui('status').hidden, true, 'a recommendation is not shown as running');
   await x.choose('task', 'note:task-a');
   assert.deepEqual(x.currentTasks.at(-1),{
     key: 'note:task-a', state: 'recommendation'
      });
   await x.click('start');
   assert.deepEqual(x.currentTasks.at(-1),{
     key: 'note:task-a', state: 'active'
      });
   assert.equal(x.ui('status').textContent, 'В работе');
   await x.click('pause');
   assert.deepEqual(x.currentTasks.at(-1),{
     key: 'note:task-a', state: 'paused'
      });
   assert.equal(x.ui('status').textContent, 'На паузе');
   await x.click('finish');
   assert.deepEqual(x.currentTasks.at(-1),{
     key: 'note:task-a', state: 'completed'
      });
   x.cleanup();
   const length = x.currentTasks.length;
   await x.refresh();
   assert.equal(x.currentTasks.length, length);

  });
test('a failed dashboard task overview does not disable or restart the current timer', async t =>{
   const x = await mount(t);
   const{
     mountCalendarDashboardTasks
      }
   = await import('../src/hanni/js/calendar-dashboard-tasks.js');
   const list = x.dom.window.document.createElement('div');
   x.host.after(list);
   const dispose = mountCalendarDashboardTasks(list,{
     invoke: async () =>{
       throw new Error('list unavailable');

          }

      });
   t.after(dispose);
   for (let i = 0;
   i < 5;
   i++) await new Promise(resolve => setImmediate(resolve));
   assert.equal(list.querySelector('[data-overview-retry]').hidden, false);
   await x.click('start');
   assert.equal(x.host.dataset.state, 'active');
   await x.click('pause');
   assert.equal(x.host.dataset.state, 'paused');
   assert.equal(x.data.count('start_task_block'), 1);

  });
test('no goal is quiet; selecting a real goal ranks linked tasks without starting and Escape cancels a draft', async t =>{
   const x = await mount(t, backend(null));
   assert.equal(x.host.dataset.state, 'empty');
   assert.equal(x.action('start').hidden, true);
   await x.choose('goal', 'goal-a');
   assert.equal(x.host.dataset.taskKey, 'event:event-a');
   assert.equal(x.host.dataset.state, 'recommendation');
   assert.equal(x.data.count('start_task_block'), 0);
   await x.click('open-goal');
   const picker = x.dom.window.document.querySelector('.calendar-goal-picker');
   assert.equal(picker.querySelector('select'), null);
   picker.dispatchEvent(new x.dom.window.Event('cancel',{
     cancelable: true
      }));
   assert.equal(x.dom.window.document.querySelector('.calendar-goal-picker'), null);
   assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));
   assert.equal(JSON.parse(x.data.stored).goalId, 'goal-a');

  });
test('a main goal includes tasks from nested goals and ignores an accidental parent cycle', async t =>{
   const data = backend();
   data.goals.push({
     id: 'goal-c', title: 'Подцель', parent_goal_id: 'goal-a', status: 'active'
      });
   data.links = [{
     source_type: 'event', source_id: 'event-a', goal_id: 'goal-c'
      }];
   const x = await mount(t, data);
   assert.equal(x.host.dataset.taskKey, 'event:event-a');
   data.goals[0].parent_goal_id = 'goal-c';
   await x.refresh();
   assert.equal(x.host.dataset.taskKey, 'event:event-a');

  });
test('manual selection survives same-goal confirmation, ranking refresh and a new mount', async t =>{
   const data = backend(), x = await mount(t, data);
   await x.choose('task', 'note:task-a');
   await x.choose('goal', 'goal-a');
   data.tasks[0].priority = 5;
   await x.refresh();
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(x.host.dataset.selectionMode, 'manual');
   x.cleanup();
   const next = await mount(t, data);
   assert.equal(next.host.dataset.taskKey, 'note:task-a');
   assert.equal(data.count('start_task_block'), 0);

  });
test('pause, goal change, reload and finish retain execution identity and exclude pause time', async t =>{
   const data = backend(), x = await mount(t, data);
   await x.choose('task', 'note:task-a');
   await x.click('start');
   data.now = new Date('2026-09-05T10:03:00');
   await x.click('pause');
   await x.choose('goal', 'goal-b');
   assert.equal(x.host.dataset.state, 'paused');
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(x.ui('meta').textContent, '3 мин из 15 мин');
   x.cleanup();
   data.now = new Date('2026-09-05T11:00:00');
   const y = await mount(t, data);
   assert.equal(y.host.dataset.state, 'paused');
   await y.click('finish');
   assert.equal(y.host.dataset.state, 'completed');
   assert.equal(y.ui('meta').textContent, 'Учтено 3 мин');
   await y.click('next');
   assert.equal(y.host.dataset.state, 'empty');
   assert.equal(y.action('start').hidden, true);

  });
test('double start and an external refresh while start is pending remain one operation', async t =>{
   const data = backend(), x = await mount(t, data);
   let release;
   const gate = new Promise(resolve =>{
     release = resolve;

      });
   data.before.set('start_task_block', () => gate);
   x.action('start').click();
   x.action('start').click();
   x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(data.count('start_task_block'), 1);
   assert.equal(x.ui('card').getAttribute('aria-busy'), 'true');
   release();
   await x.settle();
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(data.blocks.length, 1);
   assert.equal(x.action('open-goal').disabled, true);

  });
test('failed pause keeps the task and retries the same block after a refresh', async t =>{
   const x = await mount(t);
   await x.click('start');
   const id = x.data.blocks[0].id;
   x.data.onceFail('pause_task_block');
   await x.click('pause');
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(x.ui('error').hidden, false);
   await x.refresh();
   assert.match(x.ui('error-text').textContent, /поставить задачу на паузу/);
   await x.click('retry');
   assert.equal(x.host.dataset.state, 'paused');
   assert.deepEqual(x.data.calls.filter(call => call.command === 'pause_task_block').map(call => call.args.blockId), [id, id]);

  });
test('a committed start with a lost response is adopted on retry instead of duplicated', async t =>{
   const x = await mount(t);
   x.data.onceFail('start_task_block', 'after');
   await x.click('start');
   assert.equal(x.ui('error').hidden, false);
   assert.equal(x.data.blocks.length, 1);
   await x.click('retry');
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(x.data.count('start_task_block'), 1);
   assert.equal(x.data.blocks.length, 1);

  });
test('failed persistence after start retries persistence without replaying the mutation', async t =>{
   const x = await mount(t);
   x.data.onceFail('set_ui_state');
   await x.click('start');
   assert.match(x.ui('error-text').textContent, /без повторного запуска/);
   await x.click('retry');
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(x.data.count('start_task_block'), 1);
   assert.equal(JSON.parse(x.data.stored).execution.blockId, x.data.blocks[0].id);

  });
test('stale Start retry refreshes after an unavailable source without starting again', async t =>{
   const data = backend();
   const event = data.tasks.find(task => task.source_type === 'event' && task.source_id === 'event-a');
   event.completed = true; event.status_extra = 'done';
   data.tasks.push({ source_type: 'note', source_id: 'task-b', title: 'Следующая задача', duration_minutes: 10, priority: 0, category: 'work', completed: false, tracking_mode: 'check', date: null });
   data.links.push({ source_type: 'note', source_id: 'task-b', goal_id: 'goal-a' });
   const x = await mount(t, data);
   data.before.set('start_task_block', () =>{
     const stale = data.tasks.find(task => task.source_type === 'note' && task.source_id === 'task-a');
     stale.completed = true; stale.status_extra = 'done';
     throw new Error('source record not found');

    });
   await x.click('start');
   assert.equal(data.count('start_task_block'), 1);
   assert.match(x.ui('error-text').textContent, /Задача уже завершена или недоступна\. Обнови экран\./);
   assert.equal(x.ui('error').hidden, false);
   await x.click('retry');
   assert.equal(data.count('start_task_block'), 1, 'retry only refreshes a stale Start');
   assert.equal(x.host.dataset.taskKey, 'note:task-b');
   assert.equal(x.host.dataset.state, 'recommendation');
   assert.equal(x.ui('error').hidden, true);
   assert.equal(x.action('start').disabled, false);

  });

test('a deleted paused event clears stale execution and retains its closed history', async t =>{
   const initial = blank();
   initial.execution = { blockId: 77, date: '2026-09-05', task: { source_type: 'event', source_id: 'event-a', title: 'Удалённое событие', completion_date: '2026-09-05' } };
   initial.selection = { source_type: 'event', source_id: 'event-a' }; initial.selectionMode = 'manual';
   const data = backend(initial);
   data.tasks = data.tasks.filter(task => task.source_type !== 'event');
   data.links = data.links.filter(link => link.source_type !== 'event');
   data.blocks.push({ id: 77, date: '2026-09-05', start_time: '09:00', source_type: 'event', source_id: 'event-a', is_active: false, duration_minutes: 12 });
   const x = await mount(t, data);
   assert.equal(x.host.dataset.state, 'recommendation');
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(JSON.parse(data.stored).execution, null);
   assert.equal(JSON.parse(data.stored).selection, null);
   assert.equal(data.blocks[0].duration_minutes, 12, 'closed history remains available to storage');
   await x.refresh();
   assert.equal(JSON.parse(data.stored).execution, null);

  });test('global active task on another date blocks goal switching and a different task starts beside it without stopping it', async t =>{
   const data = backend();
   data.blocks.push({
     id: 90, date: '2026-09-04', start_time: '23:58', source_type: 'note', source_id: 'task-a', is_active: true, duration_minutes: 0
      });
   const x = await mount(t, data);
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(x.action('open-goal').disabled, true);
   assert.ok(data.calls.some(call => call.command === 'get_timeline_blocks' && call.args.date === '2026-09-04'));
   const other = await mount(t);
   other.data.blocks.push({
     id: 91, date: '2026-09-05', start_time: '10:00', source_type: 'note', source_id: 'task-a', is_active: true, duration_minutes: 0
      });
   await other.click('start');
   // Parallel work (2026-09-24): the stale recommendation starts beside the running task.
   assert.equal(other.data.count('start_task_block'), 1);
   assert.equal(other.data.count('pause_task_block'), 0);
   assert.equal(other.data.blocks[0].is_active, true, 'the concurrent task keeps running');
   assert.equal(other.data.blocks.filter(block => block.is_active).length, 2);
   assert.equal(other.ui('error').hidden, true);
   assert.equal(other.host.dataset.taskKey, 'event:event-a');
   assert.equal(other.host.dataset.state, 'active');

  });
test('read failures preserve the last task, retry recovers, and cleanup removes refresh listeners', async t =>{
   const x = await mount(t);
   await x.choose('task', 'note:task-a');
   x.data.onceFail('get_calendar_task_goals');
   await x.refresh();
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(x.ui('error').hidden, false);
   assert.equal(x.action('start').disabled, true);
   await x.click('retry');
   assert.equal(x.ui('error').hidden, true);
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   x.cleanup();
   const count = x.data.calls.length;
   x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(x.data.calls.length, count);

  });
test('resume starts another segment for the same source and preserves the occurrence date', async t =>{
   const data = backend();
   data.tasks[0].source_type = 'schedule';
   data.tasks[0].source_id = 'uuid-test';
   data.tasks[0].completion_date = '2026-09-04';
   data.links[0] ={
     source_type: 'schedule', source_id: 'uuid-test', goal_id: 'goal-a'
      };
   const x = await mount(t, data);
   await x.click('start');
   data.now = new Date('2026-09-05T10:02:00');
   await x.click('pause');
   data.now = new Date('2026-09-05T11:00:00');
   await x.click('start');
   assert.equal(data.blocks.length, 2);
   assert.equal(x.host.dataset.taskKey, 'schedule:uuid-test');
   data.now = new Date('2026-09-05T11:03:00');
   await x.click('pause');
   assert.equal(x.ui('meta').textContent, '5 мин из 25 мин');
   assert.ok(data.calls.filter(call => call.command === 'start_task_block').every(call => call.args.completionDate === '2026-09-04'));

  });
test('adopting an existing active task retries a failed local save on the next refresh', async t =>{
   const data = backend();
   data.blocks.push({
     id: 80, date: '2026-09-05', start_time: '09:58', source_type: 'note', source_id: 'task-a', is_active: true, duration_minutes: 0
      });
   data.onceFail('set_ui_state');
   const x = await mount(t, data);
   assert.equal(x.host.dataset.state, 'active');
   assert.equal(x.ui('error').hidden, false);
   await x.click('retry');
   assert.equal(JSON.parse(data.stored).execution.blockId, 80);
   assert.equal(data.count('start_task_block'), 0);
   assert.equal(x.ui('error').hidden, true);

  });
test('readonly health and check-only schedules are excluded while undated note tasks remain selectable', async t =>{
   const data = backend();
   data.tasks.unshift({
     source_type: 'event', source_id: 'readonly-event', title: 'Readonly health', readonly: true, priority: 10
      },{
     source_type: 'schedule', source_id: 'review', title: 'Only a check', tracking_mode: 'check', priority: 9
      }, );
   data.links.push({
     source_type: 'event', source_id: 'readonly-event', goal_id: 'goal-a'
      },{
     source_type: 'schedule', source_id: 'review', goal_id: 'goal-a'
      });
   const x = await mount(t, data);
   await x.click('open-task');
   assert.deepEqual([...x.ui('task-select').options].map(option => option.value), ['event:event-a', 'note:task-a']);
   assert.equal(data.calls.find(call => call.command === 'get_calendar_records').args.start, '2026-09-05');

  });
test('a late start from a disposed mount cannot overwrite the new mount goal selection', async t =>{
   const data = backend(), old = await mount(t, data);
   let release;
   const gate = new Promise(resolve =>{
     release = resolve;

      });
   data.before.set('start_task_block', () => gate);
   old.action('start').click();
   await new Promise(resolve => setImmediate(resolve));
   old.cleanup();
   const current = await mount(t, data);
   await current.choose('goal', 'goal-b');
   assert.equal(JSON.parse(data.stored).goalId, 'goal-b');
   release();
   for (let i = 0;
   i < 5;
   i++) await new Promise(resolve => setImmediate(resolve));
   assert.equal(JSON.parse(data.stored).goalId, 'goal-b');
   assert.equal(data.blocks.length, 1);
   await current.refresh();
   assert.equal(current.host.dataset.state, 'active');
   assert.equal(JSON.parse(data.stored).goalId, 'goal-b');

  });
test('active previous-day schedule retains its saved occurrence rather than adopting today planned occurrence', async t =>{
   const stored = blank();
   stored.execution ={
     blockId: 90, date: '2026-09-04', task:{
       source_type: 'schedule', source_id: 'alternative-a', title: 'Повторение', duration_minutes: 25, completion_date: '2026-09-04'
          }

      };
   const data = backend(stored);
   data.tasks = [{
     source_type: 'schedule', source_id: 'alternative-a', title: 'Повторение', duration_minutes: 25, completion_date: '2026-09-05', tracking_mode: 'track'
      }];
   data.links = [{
     source_type: 'schedule', source_id: 'alternative-a', goal_id: 'goal-a'
      }];
   data.blocks.push({
     id: 90, date: '2026-09-04', start_time: '23:58', source_type: 'schedule', source_id: 'alternative-a', is_active: true, duration_minutes: 0
      });
   const x = await mount(t, data);
   await x.click('pause');
   await x.click('start');
   assert.equal(data.calls.find(call => call.command === 'start_task_block').args.completionDate, '2026-09-04');

  });
test('a note resumed the next day retains earlier work through pause and finish', async t =>{
   const data = backend(), x = await mount(t, data);
   await x.choose('task', 'note:task-a');
   await x.click('start');
   data.now = new Date('2026-09-05T10:20:00');
   await x.click('pause');
   assert.equal(x.ui('meta').textContent, '20 мин из 15 мин');
   data.now = new Date('2026-09-06T10:00:00');
   await x.refresh();
   assert.equal(x.ui('meta').textContent, '20 мин из 15 мин');
   await x.click('start');
   assert.equal(x.ui('meta').textContent, '20 мин из 15 мин', 'resume must retain the closed first-day segment');
   data.now = new Date('2026-09-06T10:05:00');
   await x.click('pause');
   assert.deepEqual(data.blocks.map(block => block.date), ['2026-09-05', '2026-09-06']);
   assert.equal(data.blocks.reduce((sum, block) => sum + block.duration_minutes, 0), 25);
   assert.equal(x.ui('meta').textContent, '25 мин из 15 мин');
   data.now = new Date('2026-09-06T12:00:00');
   await x.click('finish');
   assert.equal(x.ui('meta').textContent, 'Учтено 25 мин', 'paused time must not enter the aggregate');

  });
test('completed dated event retains total after next-day remount outside the planned records', async t =>{
   const data = backend();
   data.tasks[0].date = '2026-09-05';
   data.tasks[0].completion_date = '2026-09-05';
   const x = await mount(t, data);
   await x.click('start');
   data.now = new Date('2026-09-05T10:20:00');
   await x.click('finish');
   assert.equal(x.ui('meta').textContent, 'Учтено 20 мин');
   x.cleanup();
   data.now = new Date('2026-09-06T10:00:00');
   assert.equal((await data.invoke('get_calendar_records',{
     start: '2026-09-06', end: '2026-09-06'
      })).some(task => task.source_type === 'event'), false);
   const y = await mount(t, data);
   assert.equal(y.host.dataset.state, 'completed');
   assert.equal(y.host.dataset.taskKey, 'event:event-a');
   assert.equal(data.blocks.reduce((sum, block) => sum + block.duration_minutes, 0), 20);
   assert.equal(y.ui('meta').textContent, 'Учтено 20 мин');
   assert.equal(data.count('start_task_block'), 1, 'remount must not start another block');

  });
for (const kind of ['task']) test(`pressing the ${kind} picker trigger again closes it and discards the draft without a write`, async t =>{
   const x = await mount(t), writes = x.data.count('set_ui_state');
   await x.click(`open-${kind}`);
   assert.equal(x.ui(`${kind}-form`).hidden, false);
   x.ui(`${kind}-select`).value = kind === 'goal' ? 'goal-b' : 'note:task-a';
   await x.click(`open-${kind}`);
   assert.equal(x.ui(`${kind}-form`).hidden, true);
   assert.equal(x.action(`open-${kind}`).getAttribute('aria-expanded'), 'false');
   assert.equal(x.dom.window.document.activeElement, x.action(`open-${kind}`));
   assert.equal(x.data.count('set_ui_state'), writes);
   assert.equal(x.data.count('start_task_block'), 0);

  });
test('goal picker opens native popup, marks current choice, and current click performs no IPC', async t =>{
   const x = await mount(t);
   x.action('open-goal').focus();
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('dialog.calendar-goal-picker');
   assert.equal(modal.open, true);
   assert.equal(x.action('open-goal').getAttribute('aria-haspopup'), 'dialog');
   assert.equal(modal.querySelector('[data-goal-choice="goal-a"]').getAttribute('aria-current'), 'true');
   assert.equal(modal.querySelector('[data-goal-search]').parentElement.hidden, true);
   const calls = x.data.calls.length;
   modal.querySelector('[data-goal-choice="goal-a"]').click();
   await x.settle();
   assert.equal(x.data.calls.length, calls);
   assert.equal(modal.isConnected, false);
   assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));

  });
test('many goals retain full names and search/filter through refresh without writing', async t =>{
   const data = backend();
   data.goals = Array.from({
     length: 41
      }, (_, i) => ({
     id: i + 1, title: i === 40 ? 'Специалист ' + 'длинное название '.repeat(30) : `Цель ${i + 1}`
      }));
   const x = await mount(t, data);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('dialog.calendar-goal-picker'), search = modal.querySelector('[data-goal-search]');
   assert.equal(search.parentElement.hidden, false);
   assert.equal(x.dom.window.document.activeElement, search);
   assert.equal(modal.querySelectorAll('[data-goal-choice]').length, 42);
   const submission = new x.dom.window.Event('submit',{
     cancelable: true
      });
   modal.querySelector('form').dispatchEvent(submission);
   assert.equal(submission.defaultPrevented, true);
   assert.equal(modal.querySelector('[data-goal-choice="41"] > span').textContent, data.goals[40].title);
   const writes = data.count('set_ui_state');
   search.value = 'СПЕЦИАЛИСТ';
   search.dispatchEvent(new x.dom.window.Event('input'));
   assert.equal(modal.querySelectorAll('[data-goal-choice]').length, 2);
   await x.refresh();
   assert.equal(search.value, 'СПЕЦИАЛИСТ');
   assert.equal(x.dom.window.document.activeElement, search);
   assert.equal(data.count('set_ui_state'), writes);
   search.value = 'Не существует';
   search.dispatchEvent(new x.dom.window.Event('input'));
   assert.equal(modal.querySelector('[data-goal-empty]').hidden, false);
   assert.equal(modal.querySelector('[data-goal-choice=""]').textContent, 'Пока без цели');
   modal.querySelector('[data-dialog-close]').click();
   assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));

  });
test('empty goal catalog permits explicit clearing and keeps an honest empty state', async t =>{
   const data = backend();
   data.goals = [];
   const x = await mount(t, data);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   assert.equal(modal.querySelectorAll('[data-goal-choice]').length, 1);
   assert.match(modal.querySelector('[data-goal-empty]').textContent, /пока нет/);
   modal.querySelector('[data-goal-choice=""]').click();
   await x.settle();
   assert.equal(JSON.parse(data.stored).goalId, null);
   assert.equal(data.count('start_task_block'), 0);

  });
test('same-title goals remain distinct by their deadlines after clearing primary; deadline-only refresh updates the row', async t =>{
   const data = backend();
   data.goals = [{
     id: 'goal-a', title: 'Одинаковая цель'
      },{
     id: 'goal-b', title: 'Одинаковая цель', deadline: '2026-12-01'
      }];
   const x = await mount(t, data);
   await x.choose('goal', '');
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   const first = modal.querySelector('[data-goal-choice="goal-a"]'), second = modal.querySelector('[data-goal-choice="goal-b"]');
   assert.notEqual(first.textContent, second.textContent);
   assert.match(second.textContent, /Срок: 1 декабря 2026/);
   assert.equal(first.querySelector('.calendar-goal-deadline'), null);
   second.focus();
   data.goals[1].deadline = '2027-02-03';
   await x.refresh();
   const refreshed = modal.querySelector('[data-goal-choice="goal-b"]');
   assert.equal(second.isConnected, false);
   assert.match(refreshed.textContent, /Срок: 3 февраля 2027/);
   assert.equal(x.dom.window.document.activeElement, refreshed);
   assert.equal(JSON.parse(data.stored).goalId, null);

  });
test('goal availability is reread at selection; a removed choice cannot become primary', async t =>{
   const x = await mount(t);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   x.data.goals = x.data.goals.filter(goal => goal.id !== 'goal-b');
   modal.querySelector('[data-goal-choice="goal-b"]').click();
   await x.settle();
   assert.equal(JSON.parse(x.data.stored).goalId, 'goal-a');
   assert.match(modal.querySelector('[data-dialog-error]').textContent, /больше недоступна/);
   assert.equal(x.dom.window.document.activeElement, modal.querySelector('[data-dialog-error]'));
   assert.equal(modal.querySelector('[data-goal-choice="goal-b"]'), null);

  });
test('goal selection save failure retries its phase inside popup without repeating the action or moving focus behind it', async t =>{
   const x = await mount(t);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   let reject = true;
   x.data.before.set('set_ui_state', () =>{
     if (reject){
       reject = false;
       throw new Error('save unavailable');

          }

      });
   modal.querySelector('[data-goal-choice="goal-b"]').click();
   await x.settle();
   assert.equal(modal.isConnected, true);
   assert.equal(x.dom.window.document.activeElement, modal.querySelector('[data-dialog-error]'));
   assert.equal(modal.querySelector('[data-dialog-retry]').hidden, false);
   assert.equal(x.ui('error').hidden, true);
   const activeReads = x.data.count('get_active_blocks'), goalChecks = x.data.count('get_active_block');
   modal.querySelector('[data-dialog-retry]').click();
   await x.settle();
   assert.equal(JSON.parse(x.data.stored).goalId, 'goal-b');
   assert.equal(modal.isConnected, false);
   assert.equal(x.data.count('get_active_blocks'), activeReads + 1, 'only the final snapshot reads active work');
   assert.equal(x.data.count('get_active_block'), goalChecks, 'goal action is not repeated');
   assert.equal(x.data.count('start_task_block'), 0);
   assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));

  });
test('pending goal selection blocks double choice and cancel; disposal cannot reclaim focus', async t =>{
   const x = await mount(t);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   let release;
   const hold = new Promise(resolve =>{
     release = resolve;

      });
   x.data.before.set('set_ui_state', () => hold);
   modal.querySelector('[data-goal-choice="goal-b"]').click();
   for (let i = 0;
   i < 5;
   i++) await new Promise(resolve => setImmediate(resolve));
   modal.querySelector('[data-goal-choice=""]').click();
   const cancel = new x.dom.window.Event('cancel',{
     cancelable: true
      });
   modal.dispatchEvent(cancel);
   assert.equal(cancel.defaultPrevented, true);
   assert.equal(modal.isConnected, true);
   assert.equal(modal.querySelector('[data-dialog-close]').disabled, true);
   const writes = x.data.count('set_ui_state');
   const outside = x.dom.window.document.createElement('button');
   x.dom.window.document.body.append(outside);
   outside.focus();
   x.cleanup();
   assert.equal(modal.isConnected, false);
   release();
   for (let i = 0;
   i < 5;
   i++) await new Promise(resolve => setImmediate(resolve));
   assert.equal(x.dom.window.document.activeElement, outside);
   assert.equal(x.data.count('set_ui_state'), writes);

  });
test('external read failure is retried inside the open picker without selecting no-goal or writing state', async t =>{
   const x = await mount(t);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker'), writes = x.data.count('set_ui_state');
   x.data.before.set('get_goals', () =>{
     throw new Error('read unavailable');

      });
   await x.refresh();
   assert.equal(modal.querySelector('[data-dialog-error]').hidden, false);
   assert.equal(modal.querySelector('[data-dialog-retry]').hidden, false);
   assert.equal(x.ui('error').hidden, true);
   assert.equal(x.dom.window.document.activeElement, modal.querySelector('[data-dialog-error]'));
   x.data.before.delete('get_goals');
   modal.querySelector('[data-dialog-retry]').click();
   await x.settle();
   assert.equal(modal.isConnected, true);
   assert.equal(modal.querySelector('[data-dialog-error]').hidden, true);
   assert.equal(JSON.parse(x.data.stored).goalId, 'goal-a');
   assert.equal(x.data.count('set_ui_state'), writes);

  });
test('a task started after opening the goal picker blocks selection in the popup and leaves its identity intact', async t =>{
   const x = await mount(t);
   await x.click('open-goal');
   const modal = x.dom.window.document.querySelector('.calendar-goal-picker');
   x.data.blocks.push({
     id: 600, date: '2026-09-05', source_type: 'event', source_id: 'event-a', title: 'Другая работа', is_active: true, start_time: '10:00'
      });
   modal.querySelector('[data-goal-choice="goal-b"]').click();
   await x.settle();
   assert.equal(JSON.parse(x.data.stored).goalId, 'goal-a');
   assert.match(modal.querySelector('[data-dialog-error]').textContent, /паузу/);
   assert.equal(x.dom.window.document.activeElement, modal.querySelector('[data-dialog-error]'));
   assert.equal(x.data.blocks[0].is_active, true);
   assert.equal(x.data.count('pause_task_block') + x.data.count('finish_task_block'), 0);

  });
test('up to two ranked alternatives show known duration and directly select without starting; all candidates stay reachable', async t =>{
   const data = backend();
   data.tasks.push({
     source_type: 'note', source_id: 'alternative-a', title: 'ДлинноеНазвание'.repeat(20), duration_minutes: null
      },{
     source_type: 'note', source_id: 'alternative-b', title: 'Последний вариант', duration_minutes: 20
      });
   data.links.push({
     source_type: 'note', source_id: 'alternative-a', goal_id: 'goal-a'
      },{
     source_type: 'note', source_id: 'alternative-b', goal_id: 'goal-a'
      });
   const x = await mount(t, data,{
     rankTasks: tasks => tasks
      });
   await x.click('open-task');
   const choices = x.ui('task-alternatives').querySelectorAll('button');
   assert.equal(choices.length, 2);
   assert.deepEqual([...choices].map(button => button.dataset.taskKey), ['note:task-a', 'note:alternative-a']);
   assert.match(choices[0].textContent, /15 мин/);
   assert.equal(choices[1].querySelector('.calendar-now__alternative-time'), null);
   assert.equal(x.ui('task-select').options.length, 4);
   assert.equal(x.dom.window.document.activeElement, choices[0]);
   choices[1].click();
   await x.settle();
   assert.equal(x.host.dataset.taskKey, 'note:alternative-a');
   assert.equal(x.ui('task-form').hidden, true);
   assert.equal(data.count('start_task_block'), 0);
   assert.equal(JSON.parse(data.stored).selectionMode, 'manual');
   await x.choose('task', 'note:alternative-b');
   assert.equal(x.host.dataset.taskKey, 'note:alternative-b');
   assert.equal(data.count('start_task_block'), 0);

  });
test('a stale direct alternative cannot switch an active task after external refresh', async t =>{
   const x = await mount(t);
   await x.click('open-task');
   const choice = x.ui('task-alternatives').querySelector('button');
   x.data.blocks.push({
     id: 88, date: '2026-09-05', source_type: 'event', source_id: 'event-a', start_time: '10:00', is_active: true
      });
   await x.refresh();
   const saved = x.data.stored;
   choice.click();
   await x.settle();
   assert.equal(x.ui('task-form').hidden, true);
   assert.equal(x.host.dataset.taskKey, 'event:event-a');
   assert.equal(x.data.stored, saved);
   assert.equal(x.data.count('pause_task_block'), 0);
   assert.equal(x.data.count('start_task_block'), 0);

  });
test('full task selection reveals on demand with focus and no auto-start; a single candidate needs no extra reveal', async t =>{
   const x = await mount(t);
   await x.click('open-task');
   const reveal = x.action('all-tasks'), full = x.ui('task-full');
   assert.equal(full.hidden, true);
   assert.equal(reveal.getAttribute('aria-expanded'), 'false');
   assert.equal(reveal.getAttribute('aria-controls'), full.id);
   assert.equal(x.ui('task-form').querySelector('[data-action="cancel-picker"]').closest('[hidden]'), null);
   await x.click('all-tasks');
   assert.equal(full.hidden, false);
   assert.equal(reveal.getAttribute('aria-expanded'), 'true');
   assert.equal(x.dom.window.document.activeElement, x.ui('task-select'));
   await x.refresh();
   assert.equal(full.hidden, false);
   assert.equal(x.dom.window.document.activeElement, x.ui('task-select'));
   await x.click('all-tasks');
   assert.equal(full.hidden, true);
   assert.equal(x.dom.window.document.activeElement, reveal);
   await x.click('all-tasks');
   x.ui('task-select').value = 'note:task-a';
   x.ui('task-form').dispatchEvent(new x.dom.window.Event('submit',{
     bubbles: true, cancelable: true
      }));
   await x.settle();
   assert.equal(x.host.dataset.taskKey, 'note:task-a');
   assert.equal(x.ui('task-form').hidden, true);
   assert.equal(x.data.count('start_task_block'), 0);
   x.data.tasks = x.data.tasks.filter(task => task.source_type === 'note');
   await x.refresh();
   await x.click('open-task');
   assert.equal(x.ui('task-alternatives').hidden, true);
   assert.equal(full.hidden, false);
   assert.equal(reveal.hidden, true);
   assert.equal(x.dom.window.document.activeElement, x.ui('task-select'));
   assert.equal(x.data.count('start_task_block'), 0);

  });
test('a paused note completed outside today is reconciled from its authoritative status without changing work history', async t =>{
   const data = backend();
   data.tasks[1].date = '2026-09-05';
   const x = await mount(t, data);
   await x.choose('task', 'note:task-a');
   await x.click('start');
   data.now = new Date('2026-09-05T10:12:00');
   await x.click('pause');
   const history = clone(data.blocks);
   data.now = new Date('2026-09-06T10:00:00');
   data.tasks[1].status = 'done';
   data.tasks[1].completed = true;
   data.onceFail('get_note');
   await x.refresh();
   assert.equal(x.host.dataset.state, 'paused');
   assert.equal(x.ui('error').hidden, false);
   assert.equal(JSON.parse(data.stored).execution.task.source_id, 'task-a');
   data.onceFail('get_calendar_task_seconds');
   await x.click('retry');
   assert.equal(x.host.dataset.state, 'paused', 'a later failed read cannot partially commit completed execution');
   assert.equal(x.ui('error').hidden, false);
   await x.click('retry');
   assert.equal(x.host.dataset.state, 'completed');
   assert.equal(x.ui('error').hidden, true);
   assert.equal(x.ui('meta').textContent, 'Учтено 12 мин');
   assert.deepEqual(data.blocks, history);
   assert.equal(data.count('start_task_block'), 1);
   assert.equal(data.count('finish_task_block'), 0);

  });
for (const sourceType of ['note', 'event']) test(`running and paused ${sourceType} rereads edited fields without changing timer history`, async t => {
   const data=backend(), task=data.tasks.find(row=>row.source_type===sourceType);
   task.date='2026-09-05';
   const x=await mount(t,data);
   await x.choose('task', `${sourceType}:${task.source_id}`);
   await x.click('start');
   const execution=JSON.parse(data.stored).execution, blocks=clone(data.blocks);
   task.title='Новое название'; task.duration_minutes=45; task.date='2026-09-06'; task.priority=5;
   await x.refresh();
   assert.equal(x.host.dataset.state,'active');
   assert.equal(x.ui('title').textContent,'Новое название');
   assert.equal(x.host.querySelectorAll('[data-important-badge]').length,sourceType==='note'?1:0);
   assert.equal(x.ui('card').classList.contains('task-important'),sourceType==='note');
   if(sourceType==='note') {
     assert.equal(x.ui('card').firstElementChild.textContent,'Важная задача');
     assert.equal(x.ui('title').parentElement.querySelector('[data-important-badge]'),null,'importance is separate from the task title');
   }
   assert.match(x.ui('meta').textContent,/из 45 мин/);
   assert.equal(JSON.parse(data.stored).execution.task.date,'2026-09-06');
   assert.equal(JSON.parse(data.stored).execution.task.completion_date,execution.task.completion_date);
   assert.deepEqual(data.blocks,blocks);
   await x.click('pause');
   const paused=clone(data.blocks);
   task.title='Изменено на паузе'; task.duration_minutes=60; task.priority=0;
   await x.refresh();
   assert.equal(x.host.dataset.state,'paused');
   assert.equal(x.ui('title').textContent,'Изменено на паузе');
   assert.equal(x.host.querySelectorAll('[data-important-badge]').length,0);
   assert.equal(x.ui('card').classList.contains('task-important'),false,'clearing importance also clears the card emphasis');
   assert.match(x.ui('meta').textContent,/из 60 мин/);
   assert.equal(JSON.parse(data.stored).execution.blockId,execution.blockId);
   assert.deepEqual(data.blocks,paused);
   assert.equal(data.count('start_task_block'),1);
   const legacy=JSON.parse(data.stored);delete legacy.execution.task.priority;delete task.priority;
   data.stored=JSON.stringify(legacy);x.cleanup();
   const restored=await mount(t,data);
   assert.equal(restored.host.dataset.state,'paused');
   assert.equal(restored.host.querySelectorAll('[data-important-badge]').length,0,'legacy state is not important');
   assert.deepEqual(data.blocks,paused);
});

test('main goal shows the current task branch without repeating its title or inventing progress', async t => {
   const data = backend();
   data.goals.push({id:'stage-a',title:'Данные',parent_goal_id:'goal-a'}, {id:'stage-b',title:'SQL',parent_goal_id:'stage-a'});
   data.links[0].goal_id='stage-b';
   const x = await mount(t,data);
   assert.equal(x.ui('goal-stage').textContent,'Текущий этап: Данные → SQL');
   assert.equal(x.ui('goal-stage').hidden,false);
   // #98: the block names the next task once, beside the stage, and invents no percentage.
   assert.equal(x.ui('goal-next-text').textContent,'Вопросы к интервью');
   assert.equal(x.host.querySelector('.calendar-now__goal').textContent.split('Вопросы к интервью').length,2);
   assert.doesNotMatch(x.host.querySelector('.calendar-now__goal').textContent,/%/);
   assert.equal(data.count('start_task_block'),0);
   await x.choose('goal', 'stage-a');
   assert.equal(x.ui('goal-title').textContent, 'Данные');
   assert.equal(x.ui('goal-stage').textContent, 'Текущий этап: SQL', 'a nested main goal starts its path at the selected goal');
   await x.choose('goal', 'goal-a');
   data.links[0].goal_id='goal-a';
   await x.refresh();
   assert.equal(x.ui('goal-stage').hidden,true,'direct root link needs no duplicate root breadcrumb');
});

test('an unrelated or broken goal branch is never presented as part of the main goal', async t => {
   const data=backend();
   const x=await mount(t,data);
   await x.click('start');
   data.goals.push({id:'broken',title:'Чужой этап',parent_goal_id:'missing'});
   data.links[0].goal_id='broken';
   await x.refresh();
   assert.equal(x.ui('goal-stage').hidden,true);
   data.goals.at(-1).parent_goal_id='broken';
   await x.refresh();
   assert.equal(x.ui('goal-stage').hidden,true,'cycle terminates safely');
   assert.equal(x.host.dataset.state,'active','goal metadata does not interrupt the timer');
});

test('main goal has its own result and named details without duplicating current task or inventing progress', async t =>{
   const data = backend();
   data.goals[0] ={
     ...data.goals[0], title: 'Подготовить учебный проект <script>', deadline: '2026-10-01', target_value: 1, current_value: 0, unit: '', percent: '0'
      };
   data.links.push(clone(data.links[1]));
   const x = await mount(t, data), card = x.host.querySelector('.calendar-now__goal');
   assert.equal(x.ui('goal-status').hidden, true);
   assert.equal(x.ui('goal-title').textContent, data.goals[0].title);
   assert.equal(card.querySelector('script'), null);
   assert.equal(x.ui('goal-meta'), null, 'the deadline moved from the dashboard to the goal details');
   assert.doesNotMatch(card.textContent, /1 октября 2026/);
   assert.equal(x.action('open-goal').getAttribute('aria-label'), 'Сменить главную цель');
   assert.equal(x.action('goal-details').querySelector('[data-ui="goal-title"]'), x.ui('goal-title'));
   assert.equal(card.querySelector('[data-action="start"]'), null);
   assert.equal(x.ui('goal-next-text').textContent, 'Вопросы к интервью', 'the next task is named, not started');
   const writesBefore = data.count('set_ui_state');
   x.action('goal-details').focus();
   await x.click('goal-details');
   const modal = x.dom.window.document.querySelector('dialog');
   assert.equal(modal.getAttribute('aria-labelledby'), modal.querySelector('h2').id);
   assert.equal(x.dom.window.document.activeElement, modal.querySelector('h2'));
   assert.deepEqual([...modal.querySelectorAll('dd')].map(node => node.textContent), ['1', '1']);
   assert.doesNotMatch(modal.textContent, /%|0 из 1/);
   assert.match(modal.textContent, /Срок: 1 октября 2026/);
   assert.equal(data.count('set_ui_state'), writesBefore);
   assert.equal(data.count('start_task_block'), 0);
   modal.querySelector('[data-goal-close]').click();
   assert.equal(x.dom.window.document.querySelector('dialog'), null);
   assert.equal(x.dom.window.document.activeElement, x.action('goal-details'));

  });
test('goal details expose stored result, criteria and direct subgoals as text without mutating records', async t => {
   const data = backend();
   Object.assign(data.goals[0], { description: 'Подготовить портфолио\n<script>пример</script>', criteria: 'Проверить API\n\nОбъяснить <img src=x> модель' });
   data.goals.push({ id: 'stage', parent_goal_id: 'goal-a', title: 'Учебный проект', status: 'active' }, { id: 'nested', parent_goal_id: 'stage', title: 'Вложенный шаг', status: 'active' });
   const before = clone(data.goals), x = await mount(t, data);
   const writes = data.count('set_ui_state');
   await x.click('goal-details');
   const modal = x.dom.window.document.querySelector('dialog');
   assert.equal(modal.querySelector('.calendar-goal-dialog__description').textContent, before[0].description);
   assert.deepEqual([...modal.querySelectorAll('li')].map(node => node.textContent), ['Проверить API', 'Объяснить <img src=x> модель', 'Учебный проект']);
   assert.equal(modal.querySelector('script, img'), null);
   assert.deepEqual(data.goals, before);
   assert.equal(data.count('set_ui_state'), writes);
});

for (const paused of [false, true]) test(`switching a ${paused ? 'paused' : 'running'} task preserves work and leaves it incomplete across remount`, async t => {
   const x = await mount(t);
   await x.click('start');
   x.data.now = new Date('2026-09-05T10:12:00');
   if (paused) await x.click('pause');
   const pauseCount = x.data.count('pause_task_block');
   await x.click('switch-task');
   assert.equal(x.data.count('pause_task_block'), pauseCount + (paused ? 0 : 1));
   assert.equal(x.data.count('finish_task_block'), 0);
   assert.equal(x.data.blocks[0].duration_minutes, 12);
   assert.equal(x.data.blocks[0].is_active, false);
   assert.equal(x.data.tasks[0].completed, false);
   assert.equal(JSON.parse(x.data.stored).execution, null);
   assert.equal(x.host.dataset.state, 'recommendation');
   assert.equal(x.ui('task-form').hidden, false);
   await x.click('cancel-picker');
   x.cleanup();
   const y = await mount(t, x.data);
   assert.equal(y.host.dataset.state, 'recommendation');
   assert.equal(y.data.blocks[0].duration_minutes, 12);
   assert.equal(y.action('switch-task').hidden, true);
});

test('return keeps the previous task across restart without starting it automatically', async t => {
   const x=await mount(t);
   await x.choose('task','note:task-a');await x.click('start');await x.click('pause');await x.click('switch-task');
   const starts=x.data.count('start_task_block');
   assert.equal(JSON.parse(x.data.stored).returnTo.source_id,'task-a');
   x.cleanup();const y=await mount(t,x.data);
   assert.equal(y.data.count('start_task_block'),starts);
   assert.equal(y.action('return').hidden,false);
   await y.click('return');
   assert.equal(y.host.dataset.state,'active');
   assert.equal(JSON.parse(y.data.stored).execution.task.source_id,'task-a');
   assert.equal(y.data.count('finish_task_block'),0);
});

test('remount adopts work started and paused in another pane without reviving an explicitly cleared block', async t => {
   const x=await mount(t);
   await x.choose('task','note:task-a');await x.click('start');await x.click('pause');
   x.cleanup();
   const id=await x.data.invoke('start_task_block',{sourceType:'event',sourceId:'event-a',failIfActive:true});
   await x.data.invoke('pause_task_block',{blockId:id});
   const starts=x.data.count('start_task_block');
   const y=await mount(t,x.data);
   assert.equal(JSON.parse(y.data.stored).execution.task.source_id,'event-a');
   assert.equal(JSON.parse(y.data.stored).returnTo.source_id,'task-a');
   assert.equal(y.host.dataset.state,'paused');
   assert.equal(y.data.count('start_task_block'),starts,'reading another pane must not start work');
   await y.click('switch-task');await y.click('cancel-picker');y.cleanup();
   const z=await mount(t,y.data);
   assert.equal(JSON.parse(z.data.stored).execution,null,'explicitly changing task must remain cleared');
   assert.equal(z.data.count('start_task_block'),starts);
});

test('switch retry saves an already paused task without executing pause again', async t => {
   const x = await mount(t);
   await x.click('start');
   x.data.onceFail('set_ui_state');
   await x.click('switch-task');
   assert.equal(x.ui('error').hidden, false);
   assert.equal(x.data.count('pause_task_block'), 1);
   await x.click('retry');
   assert.equal(x.ui('error').hidden, true);
   assert.equal(x.data.count('pause_task_block'), 1);
   assert.equal(x.data.count('finish_task_block'), 0);
   assert.equal(JSON.parse(x.data.stored).execution, null);
   assert.equal(x.ui('task-form').hidden, false);
});

test('return no longer offers a task completed elsewhere', async t => {
   const x=await mount(t);
   await x.choose('task','note:task-a');await x.click('start');await x.click('pause');await x.click('switch-task');
   x.data.tasks.find(task=>task.source_id==='task-a').completed=true;
   await x.refresh();
   assert.equal(x.action('return').hidden,true);
   assert.equal(JSON.parse(x.data.stored).returnTo,null);
});

test('switching never pauses a different concurrently started task or clears the saved execution', async t => {
   const x = await mount(t);
   await x.click('start');
   const execution = JSON.parse(x.data.stored).execution;
   x.data.blocks[0].is_active = false;
   x.data.blocks.push({ ...x.data.blocks[0], id: 999, source_type: 'note', source_id: 'task-a', is_active: true });
   await x.click('switch-task');
   assert.equal(x.data.count('pause_task_block'), 0);
   assert.equal(x.data.count('finish_task_block'), 0);
   assert.equal(x.data.blocks[1].is_active, true);
   assert.deepEqual(JSON.parse(x.data.stored).execution, execution);
   assert.match(x.ui('error-text').textContent, /другая задача/);
});

test('goal details show an existing explicit measurement without deriving task completion percent', async t =>{
   const data = backend();
   Object.assign(data.goals[0],{
     target_value: 120, current_value: 18, unit: 'страниц', percent: '15'
      });
   const x = await mount(t, data);
   await x.click('goal-details');
   const modal = x.dom.window.document.querySelector('dialog');
   assert.match(modal.textContent, /Учтено: 18 из 120 страниц/);
   assert.doesNotMatch(modal.textContent, /15%/);

  });
test('missing legacy measurement values do not become invented zero or null progress', async t =>{
   for (const current of [null, undefined, '']){
     const data = backend();
     Object.assign(data.goals[0],{
       target_value: 120, current_value: current, unit: 'страниц'
          });
     const x = await mount(t, data);
     await x.click('goal-details');
     assert.doesNotMatch(x.dom.window.document.querySelector('dialog').textContent, /Учтено:/);
     x.cleanup();

      }

  });
test('closing details after the selected goal becomes unavailable restores the available chooser', async t =>{
   const x = await mount(t);
   await x.click('goal-details');
   x.data.goals = x.data.goals.filter(goal => goal.id !== 'goal-a');
   await x.refresh();
   x.dom.window.document.querySelector('[data-goal-close]').click();
   assert.equal(x.dom.window.document.activeElement, x.action('open-goal'));

  });
test('no goal and unavailable goal keep selection upstairs and an empty saved goal remains valid', async t =>{
   const none = await mount(t, backend(null));
   assert.equal(none.ui('goal-status').textContent, 'Главная цель не выбрана');
   assert.equal(none.action('goal-details').hidden, true);
   assert.equal(none.action('open-goal').classList.contains('calendar-now__primary'), true);
   assert.equal(none.action('choose-goal').hidden, true);
   assert.equal(none.action('calendar').hidden, true);
   assert.equal(none.action('browse-goals').hidden, false);
   none.cleanup();
   const unavailable = backend({
     ...blank(), goalId: 'missing'
      }), missing = await mount(t, unavailable);
   assert.equal(missing.ui('goal-status').textContent, 'Цель недоступна');
   assert.equal(missing.action('goal-details').hidden, true);
   assert.equal(missing.action('open-goal').disabled, false);
   assert.equal(unavailable.count('start_task_block'), 0);
   missing.cleanup();
   const data = backend({
     ...blank(), goalId: 'goal-b'
      }), empty = await mount(t, data);
   assert.equal(empty.ui('goal-title').textContent, 'Гардероб');
   assert.equal(empty.host.dataset.state, 'empty');
   await empty.click('goal-details');
   assert.match(empty.dom.window.document.querySelector('dialog').textContent, /Цель можно сохранить без задач/);
   assert.equal(data.count('start_task_block'), 0);
   assert.equal(JSON.parse(data.stored).goalId, 'goal-b');

  });
test('active work permits reading the goal while goal changes remain guarded and paused task identity survives selection', async t =>{
   const x = await mount(t);
   await x.click('start');
   assert.equal(x.action('open-goal').disabled, true);
   assert.equal(x.action('goal-details').disabled, false);
   const writes = x.data.count('set_ui_state');
   await x.click('goal-details');
   x.dom.window.document.querySelector('[data-goal-close]').click();
   assert.equal(x.data.count('set_ui_state'), writes);
   assert.equal(x.data.count('pause_task_block'), 0);
   await x.click('pause');
   await x.choose('goal', 'goal-b');
   assert.equal(x.ui('goal-title').textContent, 'Гардероб');
   assert.equal(x.host.dataset.state, 'paused');
   assert.equal(x.host.dataset.taskKey, 'event:event-a');
   assert.equal(x.data.count('start_task_block'), 1);

  });
test('unmounting a goal details owner closes the dialog without reclaiming focus', async t =>{
   const x = await mount(t);
   await x.click('goal-details');
   const outside = x.dom.window.document.createElement('button');
   x.dom.window.document.body.append(outside);
   outside.focus();
   x.cleanup();
   assert.equal(x.dom.window.document.querySelector('dialog'), null);
   assert.equal(x.dom.window.document.activeElement, outside);

  });
test('closing goal details during a pending refresh focuses its heading until controls become available', async t =>{
   const x = await mount(t);
   await x.click('goal-details');
   let release;
   const gate = new Promise(resolve =>{
     release = resolve;

      });
   x.data.before.set('get_goals', () => gate);
   x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed'));
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(x.action('goal-details').disabled, true);
   assert.equal(x.action('open-goal').disabled, true);
   x.dom.window.document.querySelector('[data-goal-close]').click();
   assert.equal(x.dom.window.document.activeElement, x.ui('goal-title'));
   release();
   await x.settle();
   assert.equal(x.dom.window.document.activeElement, x.ui('goal-title'));

  });
test('closing an externally dismissed goal dialog does not override focus already moved outside', async t =>{
   const x = await mount(t);
   await x.click('goal-details');
   const outside = x.dom.window.document.createElement('button');
   x.host.after(outside);
   outside.focus();
   x.dom.window.document.querySelector('dialog').close();
   assert.equal(x.dom.window.document.activeElement, outside);

  });
test('an empty selected goal opens the calendar to add or link tasks, while browsing goals remains separate', async t =>{
   let calendar = 0, goals = 0;
   const x = await mount(t, backend({
     ...blank(), goalId: 'goal-b'
      }),{
     openCalendar: () =>{
       calendar++;

          }, openGoals: () =>{
       goals++;

          }

      });
   assert.equal(x.action('calendar').hidden, false);
   assert.equal(x.action('calendar').textContent.trim(), 'Открыть календарь');
   await x.click('calendar');
   assert.equal(calendar, 1);
   assert.equal(goals, 0);
   assert.equal(x.data.count('start_task_block'), 0);
   x.cleanup();
   const none = await mount(t, backend(null),{
     openCalendar: () =>{
       calendar++;

          }, openGoals: () =>{
       goals++;

          }

      });
   assert.equal(none.action('calendar').hidden, true);
   await none.click('browse-goals');
   assert.equal(goals, 1);
   assert.equal(calendar, 1);

  });
test('an isolated empty goal emits the calendar table fallback event', async t =>{
   const x = await mount(t, backend({
     ...blank(), goalId: 'goal-b'
      }));
   let tables = 0, catalogs = 0;
   x.dom.window.addEventListener('hanni:calendar-open-table', () =>{
     tables++;

      });
   x.dom.window.addEventListener('hanni:calendar-open-goals', () =>{
     catalogs++;

      });
   await x.click('calendar');
   assert.equal(tables, 1);
   assert.equal(catalogs, 0);

  });
test('details remain accessible during work and after completion with the real state', async t =>{
   const opened = [], x = await mount(t, backend(),{
     openTaskDetails: row => opened.push(row)
      });
   assert.ok(x.action('task-details').closest('h2'));
   assert.equal(x.host.querySelector('.calendar-now__actions [data-action="task-details"]'), null);
   await x.click('start');
   await x.click('task-details');
   assert.equal(opened.at(-1).is_active, true);
   assert.equal(opened.at(-1).completed, false);
   x.data.now = new Date('2026-09-05T10:12:00');
   await x.click('finish');
   await x.click('task-details');
   assert.equal(opened.at(-1).completed, true);
   assert.equal(opened.at(-1).is_active, false);
   assert.equal(opened.at(-1).actual_minutes, 12);
   assert.equal(opened.at(-1).source_id, 'event-a');

  });
test('daily norms cannot be selected as the main goal through either entry point', async t =>{
   const data = backend();
   data.goals.push({
     id: 'goal-c', title: 'Вода', goal_kind: 'daily_norm'
      });
   const x = await mount(t, data);
   await x.click('open-goal');
   assert.equal(x.dom.window.document.querySelector('[data-goal-choice="3"]'), null);
   await assert.rejects(x.cleanup.selectGoal('goal-c'), /недоступна/);
   assert.equal(JSON.parse(data.stored).goalId, 'goal-a');

  });


test('Now floors combined closed and active seconds once, including legacy minute blocks', async t => {
   const data = backend();
   data.blocks.push(
     {id: 1, source_type: 'event', source_id: 'event-a', date: '2026-09-05', start_time: '09:58:30', duration_minutes: 1, duration_seconds: 90, is_active: false},
     {id: 2, source_type: 'event', source_id: 'event-a', date: '2026-09-05', start_time: '09:59:30', duration_minutes: 0, duration_seconds: 0, is_active: true}
   );
   const x = await mount(t, data);
   assert.equal(x.host.dataset.state, 'active');
   assert.ok(x.ui('meta').textContent.startsWith('2 '), '90 closed seconds plus 30 active seconds is two minutes after one floor');
   assert.equal(data.count('get_calendar_task_seconds'), 1);
   assert.equal(data.count('get_calendar_task_minutes'), 0);
});

test('Now falls back once to legacy task minutes only when the seconds command is absent', async t => {
   const initial = blank();
   initial.completed = {source_type: 'event', source_id: 'event-a', title: 'Finished event', duration_minutes: 25, date: null, completion_date: null};
   const data = backend(initial);
   data.blocks.push({id: 1, source_type: 'event', source_id: 'event-a', date: '2026-09-05', start_time: '09:58', duration_minutes: 2, duration_seconds: 120, is_active: false});
   data.before.set('get_calendar_task_seconds', () => { throw new Error('Command get_calendar_task_seconds not found'); });
   const x = await mount(t, data);
   assert.match(x.ui('meta').textContent, /2 /, 'legacy minutes continue to render time');
   assert.equal(data.count('get_calendar_task_seconds'), 1);
   assert.equal(data.count('get_calendar_task_minutes'), 1);
   await x.refresh();
   assert.equal(data.count('get_calendar_task_seconds'), 1, 'known-missing command is not retried on every refresh');
   assert.equal(data.count('get_calendar_task_minutes'), 2);
});

test('Now does not hide real seconds-command errors behind the legacy fallback', async t => {
   const initial = blank();
   initial.completed = {source_type: 'event', source_id: 'event-a', title: 'Finished event', duration_minutes: 25, date: null, completion_date: null};
   const data = backend(initial);
   data.before.set('get_calendar_task_seconds', () => { throw new Error('backend unavailable'); });
   const x = await mount(t, data);
   assert.equal(x.ui('error').hidden, false);
   assert.equal(data.count('get_calendar_task_seconds'), 1);
   assert.equal(data.count('get_calendar_task_minutes'), 0);
});

// Owner decision 2026-09-24: several tasks may run at once and the header only counts them.
test('two running tasks turn the header into a count that leads to the dashboard list without pausing anything', async t => {
  let opened = 0;
  const x = await mount(t, backend({ ...blank(), goalId:null }), { header:true, hideTaskCard:true, openInProgress:() => opened++ });
  const header = x.header, summary = header.querySelector('[data-header-action="in-progress"]');
  await x.data.invoke('start_task_block', { sourceType:'note', sourceId:'task-a', completionDate:'2026-09-05' });
  await x.refresh();
  assert.equal(header.dataset.mode, 'single');
  assert.equal(summary.hidden, true);
  assert.equal(header.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  await x.data.invoke('start_task_block', { sourceType:'event', sourceId:'event-a', completionDate:'2026-09-05' });
  await x.refresh();
  assert.equal(header.hidden, false);
  assert.equal(header.dataset.mode, 'several');
  assert.equal(summary.hidden, false);
  assert.equal(summary.querySelector('[data-header-count]').textContent, 'В работе: 2');
  assert.equal(summary.querySelector('[data-header-latest]').textContent, 'Вопросы к интервью', 'the newest running task is named');
  assert.match(summary.getAttribute('aria-label'), /^В работе: 2 задачи, последняя — Вопросы к интервью\. Показать на дашборде$/);
  for (const hidden of ['.calendar-current-task__copy', '[data-header-action="toggle"]', '[data-record-menu]', '[data-header-time]']) assert.equal(header.querySelector(hidden).hidden, true, hidden);
  summary.click();
  assert.equal(opened, 1);
  assert.equal(x.data.count('pause_task_block'), 0);
  assert.equal(x.data.blocks.filter(block => block.is_active).length, 2);
  assert.equal(JSON.parse(x.data.stored).returnTo, null, 'a task that keeps running is not a return target');
  // Pausing the newest task leaves one running: the header is back to its single controls.
  await x.data.invoke('pause_task_block', { blockId:x.data.blocks.find(block => block.source_id === 'event-a').id });
  await x.refresh();
  assert.equal(header.dataset.mode, 'single');
  assert.equal(summary.hidden, true);
  assert.equal(header.querySelector('[data-header-action="details"]').textContent, 'Заметки по API');
  assert.equal(header.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  assert.equal(x.cleanup.getLauncherState().returnTask.source_id, 'event-a', 'the paused task can still be returned to');
  await x.cleanup.returnTo(); await x.settle();
  assert.equal(x.data.count('pause_task_block'), 1, 'return starts the paused task beside the running one');
  assert.deepEqual(x.data.blocks.filter(block => block.is_active).map(block => block.source_id).sort(), ['event-a', 'task-a']);
  assert.equal(header.dataset.mode, 'several');
  assert.equal(x.cleanup.getLauncherState().returnTask, null);
});

test('compact goal block names the next goal task and opens it and the goal through existing handlers', async t => {
  const opened = [], goalsOpened = [];
  const x = await mount(t, backend(), { openTaskDetails:(row, restore) => opened.push({ row, restore }), openGoalDetails:(goal, options) => goalsOpened.push({ goal, options }) });
  const next = x.action('goal-next-task');
  assert.equal(next.hidden, false);
  assert.equal(x.ui('goal-next-title').textContent, 'Вопросы к интервью', 'the highest ranked open goal task');
  assert.equal(next.getAttribute('aria-label'), 'Следующая задача по цели: Вопросы к интервью');
  assert.equal(x.ui('goal-next-text').hidden, true);
  next.focus(); next.click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].row.source_type, 'event'); assert.equal(opened[0].row.source_id, 'event-a');
  assert.equal(x.data.count('start_task_block'), 0, 'opening the next task never starts it');
  x.ui('card').focus(); opened[0].restore();
  assert.equal(x.dom.window.document.activeElement, next);
  const open = x.action('goal-open');
  assert.equal(open.hidden, false); assert.equal(open.textContent, 'Открыть');
  open.focus(); open.click();
  assert.equal(goalsOpened.length, 1); assert.equal(goalsOpened[0].goal.id, 'goal-a');
  x.ui('card').focus(); goalsOpened[0].options.returnFocus();
  assert.equal(x.dom.window.document.activeElement, open);
  await x.click('goal-details');
  assert.equal(goalsOpened.length, 2, 'the title opens the same popup');
  assert.equal(x.action('open-goal').querySelector('[data-action-label]').textContent, 'Сменить');
});

test('the next goal task skips running work and a goal without tasks says so', async t => {
  const x = await mount(t, backend(), { openTaskDetails:() => {} });
  await x.click('start');
  assert.equal(x.ui('goal-next-title').textContent, 'Заметки по API', 'the running task is listed in «В работе», not as next');
  const data = backend({ ...blank(), goalId:'goal-b' }), other = await mount(t, data, { openTaskDetails:() => {} });
  assert.equal(other.action('goal-next-task').hidden, true);
  assert.equal(other.ui('goal-next-text').textContent, 'Задач по цели пока нет');
  assert.equal(other.ui('goal-next').classList.contains('is-empty'), true);
});

test('empty goal block is one short prompt with Выбрать цель', async t => {
  const x = await mount(t, backend(null), { openTaskDetails:() => {} });
  assert.equal(x.host.dataset.goal, 'none');
  assert.equal(x.ui('goal-empty').textContent, 'Выбери, к чему хочешь прийти');
  for (const name of ['goal-status', 'goal-hint', 'goal-next', 'goal-stage']) assert.equal(x.ui(name).hidden, true, name);
  assert.equal(x.action('goal-open').hidden, true);
  assert.equal(x.action('open-goal').querySelector('[data-action-label]').textContent, 'Выбрать цель');
  assert.equal(x.action('open-goal').classList.contains('calendar-now__primary'), true);
  assert.equal(x.host.querySelector('[data-goal-development]').hidden, true);
});

test('dashboard glance mounts once per goal, follows goal edits and is replaced when the main goal changes', async t => {
  const mounted = [];
  const mountGoalSummary = async (host, goal) => {
    const entry = { goal, updates: [], disposed: false };
    mounted.push(entry); host.textContent = `glance ${goal.id}`;
    return { update: next => entry.updates.push(next), dispose: () => { entry.disposed = true; } };
  };
  const data = backend();
  const x = await mount(t, data, { mountGoalSummary });
  assert.equal(mounted.length, 1); assert.equal(mounted[0].goal.id, 'goal-a');
  assert.equal(x.host.querySelector('[data-goal-development]').hidden, false);
  assert.equal(x.ui('goal-stage').hidden, true, 'the glance, not the task branch, shows the stage');
  data.goals[0] = { ...data.goals[0], current_value: 3, target_value: 10, unit: 'шт' };
  await x.refresh();
  assert.equal(mounted.length, 1, 'a goal edit does not remount the glance');
  assert.equal(mounted[0].updates.at(-1).current_value, 3);
  await x.choose('goal', 'goal-b');
  assert.equal(mounted.length, 2); assert.equal(mounted[0].disposed, true); assert.equal(mounted[1].goal.id, 'goal-b');
});
