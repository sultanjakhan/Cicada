import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { build } from 'vite';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const result = await build({
  configFile: false, root: new URL('../src', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'app.js', formats: ['iife'], name: 'HanniUnderTest' },
    rolldownOptions: { output: { codeSplitting: false } } }
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(file => file.type === 'chunk').code;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function launch(t, { mobile = false, initialSettings = [], width, userAgent, taskState = null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], settings = new Map(initialSettings), errors = [], before = new Map();
  if (width != null) Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: userAgent, configurable: true });
  if (mobile) w.localStorage.setItem('hanni_force_mobile', '1');
  w.structuredClone = structuredClone;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.addEventListener('error', event => errors.push(event.message));
  w.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    calls.push({ command, args });
    if (before.has(command)) await before.get(command)(args);
    if (command === 'get_note') return taskState?.tasks.find(task => task.source_id === args.id) || null;
    if (command === 'get_goals') return taskState?.goals || [];
    if (command === 'get_calendar_task_goals') return taskState?.links || [];
    if (command === 'get_calendar_records' || command === 'get_calendar_tasks') return taskState?.tasks.map(task => ({ ...task,
      is_active:taskState.blocks.some(block => block.source_id === task.source_id && block.is_active),
      has_work:taskState.blocks.some(block => block.source_id === task.source_id),
    })) || [];
    if (command === 'get_timeline_blocks') return taskState?.blocks.filter(block => block.date === args.date) || [];
    if (command === 'get_active_block') return taskState?.blocks.find(block => block.is_active) || null;
    if (command === 'get_latest_task_block') return taskState?.blocks.at(-1) || null;
    if (command === 'get_calendar_task_seconds') return taskState?.blocks.filter(block => !block.is_active && block.source_id === args.sourceId).reduce((sum,block) => sum + block.duration_seconds, 0) || 0;
    if (command === 'get_schedules') return [];
    if (command === 'start_task_block') {
      assert.equal(args.failIfActive, true);
      assert.equal(taskState.blocks.some(block => block.is_active), false);
      const id = taskState.blocks.length + 1;
      taskState.blocks.push({ id, source_type:args.sourceType, source_id:args.sourceId, date:args.completionDate, completion_date:args.completionDate, start_time:'10:00', is_active:true, duration_seconds:0 });
      return id;
    }
    if (command === 'pause_task_block') {
      taskState.blocks.find(block => block.id === args.blockId).is_active = false;
      return;
    }
    if (command === 'finish_task_block') {
      const block = taskState.blocks.find(block => block.id === args.blockId);
      block.is_active = false;
      const task = taskState.tasks.find(task => task.source_id === block.source_id);
      task.completed = true; task.status_extra = 'done';
      return;
    }
    if (['get_calendar_records','get_calendar_tasks','get_goals','get_calendar_task_goals','get_timeline_blocks','get_task_pins','get_notes','get_all_events'].includes(command)) return [];
    if (command === 'get_ui_state' || command === 'get_app_setting') return settings.get(args.key) || null;
    if (command === 'set_ui_state' || command === 'set_app_setting') { settings.set(args.key, args.value); return; }
    if (command === 'list_event_categories') return [{ id: 'general', name: 'Общее', color: '#9B9B9B', icon: '' }];
    if (command === 'get_calendar_task_minutes') return 0;
    throw new Error('Unexpected IPC: ' + command);
  } }, event: { listen: async () => () => {}, emit: async () => {} } };
  for (const name of ['highlight.min.js','marked.min.js','vendor/purify.min.js']) w.eval(await readFile(new URL('../src/public/' + name, import.meta.url), 'utf8'));
  w.eval(bundle);
  await settle();
  t.after(async () => {
    w.document.querySelector('#evm-close')?.click();
    await settle();
    dom.window.close();
  });
  const click = async selector => { const el = w.document.querySelector(selector); assert.ok(el, 'Missing ' + selector); el.click(); await settle(); return el; };
  return { w, calls, click, errors, before, settings };
}

test('bundled shell boots the five workspace panes with only Calendar in the sidebar', async t => {
  const { w, click, calls, errors } = await launch(t);
  assert.equal(w.document.title, 'Cicada');
  assert.ok(w.document.documentElement.classList.contains('desktop'));
  assert.deepEqual([...w.document.querySelectorAll('#tab-list [data-tab-id]')].map(el => el.dataset.tabId), ['calendar']);
  assert.deepEqual([...w.document.querySelectorAll('.uni-tab')].map(el => el.textContent), ['Дашборд','Календарь','Задачи','Заметки','Цели']);
  assert.ok(w.document.querySelector('[data-calendar-now]'));
  assert.equal(w.document.querySelector('.calendar-now__card').hidden, true);
  assert.equal(w.document.querySelector('.calendar-now__goal').closest('[hidden]'), null);
  assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
  for (const [pane, selector] of [['table','.calendar-workspace-table'],['tasks','.calendar-tasks'],['goals','.calendar-goals'],['notes','.calendar-notes']]) {
    await click('[data-pane="' + pane + '"]');
    assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, pane);
    if (pane !== 'table') assert.ok(w.document.querySelector(selector), selector);
    assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
  }
  assert.ok(calls.some(call => call.command === 'get_calendar_records'));
  assert.ok(calls.some(call => call.command === 'get_notes'));
  assert.deepEqual(errors, []);
});

test('persistent launcher is beside creation in every empty pane and closes back to its trigger', async t => {
  const { w, click, calls, errors } = await launch(t);
  for (const pane of ['dash', 'table', 'tasks', 'notes', 'goals']) {
    await click(`[data-pane="${pane}"]`);
    const launcher = w.document.querySelector('[data-calendar-launch]');
    assert.equal(launcher.textContent.trim(), 'Запустить задачу');
    assert.equal(launcher.disabled, false);
    assert.equal(launcher.closest('[hidden]'), null);
    assert.equal(launcher.previousElementSibling, w.document.querySelector('[data-calendar-create]'));
    assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
    assert.equal(w.document.querySelector('.calendar-now__card').hidden, true);
    launcher.focus(); await click('[data-calendar-launch]');
    const chooser = w.document.querySelector('[data-task-launcher]');
    assert.equal(chooser.open, true);
    assert.equal(chooser.querySelector('[data-overview-all]').hidden, false);
    assert.match(chooser.textContent, /Незавершённых задач пока нет/);
    await click('[data-task-launcher] footer [data-dialog-close]');
    assert.equal(w.document.activeElement, launcher);
  }
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 0);
  assert.deepEqual(errors, []);
});

test('automatic recommendation remains visible in Today while the header preview and full task card are hidden', async t => {
  const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const taskState = {
    tasks:[{ id:'suggested', source_type:'note', source_id:'suggested', title:'Задача на сегодня', date, status_extra:'task' }],
    goals:[{ id:'main-goal', title:'Изучить тему', status:'active' }],
    links:[{ source_type:'note', source_id:'suggested', goal_id:'main-goal' }], blocks:[],
  };
  const saved = { version:1, goalId:'main-goal', selectionMode:'auto', selection:null, execution:null, completed:null, observedBlockId:null };
  const { w, calls, errors } = await launch(t, { taskState, initialSettings:[['calendar_now_v1',JSON.stringify(saved)]] });
  assert.equal(w.document.querySelector('[data-calendar-now]').dataset.taskKey, 'note:suggested', 'the controller has an automatic candidate');
  assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
  assert.equal(w.document.querySelector('.calendar-now__card').hidden, true);
  const today = w.document.querySelector('[data-calendar-recurring] [data-overview-task="note:suggested"]');
  assert.ok(today, 'Today must not exclude an invisible automatic recommendation');
  assert.equal(today.closest('[hidden]'), null);
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 0);
  assert.deepEqual(errors, []);
});

test('launcher previews goal-free undated tasks without starting and only its explicit action uses the existing identity', async t => {
  const taskState = { tasks:[
    { id:'unscheduled', source_type:'note', source_id:'unscheduled', title:'Проверить пример', date:null, status_extra:'task' },
    { id:'finished', source_type:'note', source_id:'finished', title:'Готовая задача', date:null, status_extra:'done', completed:true },
  ], blocks:[] };
  const { w, click, calls, errors } = await launch(t, { taskState });
  await click('[data-pane="notes"]');
  const launcher = w.document.querySelector('[data-calendar-launch]');
  launcher.focus(); await click('[data-calendar-launch]');
  assert.equal(w.document.querySelector('[data-overview-task="note:finished"]'), null);
  const preview = w.document.querySelector('[data-task-launcher] [data-overview-task="note:unscheduled"]');
  assert.ok(preview);
  preview.focus(); await click('[data-task-launcher] [data-overview-task="note:unscheduled"]');
  assert.equal(w.document.querySelector('.calendar-mvp-dialog h2').textContent, 'Проверить пример');
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 0);
  assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
  await click('.calendar-mvp-dialog [data-close]');
  assert.equal(w.document.activeElement, preview);
  await click('[data-task-launcher] [data-overview-execute="note:unscheduled"]');
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 1);
  assert.equal(calls.find(call => call.command === 'start_task_block').args.sourceId, 'unscheduled');
  assert.equal(taskState.tasks.length, 2, 'execution does not copy the task');
  assert.equal(taskState.blocks.filter(block => block.is_active).length, 1);
  assert.equal(w.document.querySelector('[data-header-action="details"]').textContent, 'Проверить пример');
  assert.equal(w.document.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  assert.equal(w.document.querySelector('.calendar-now__card').hidden, true);
  assert.equal(w.document.activeElement, w.document.querySelector('[data-task-launcher] [data-overview-execute="note:unscheduled"]'));
  await click('[data-task-launcher] footer [data-dialog-close]');
  assert.equal(w.document.activeElement, launcher);
  await click('[data-header-action="toggle"]');
  assert.equal(w.document.querySelector('[data-header-action="toggle"]').textContent, 'Продолжить');
  assert.deepEqual(errors, []);
});

test('header menu finishes current work and launcher returns to the previous task after the preview disappears', async t => {
  const fixture = pausedTaskFixture();
  fixture.taskState.tasks.push({ id:'second-task', source_type:'note', source_id:'second-task', title:'Вторая задача', date:null, status_extra:'task' });
  const { w, click, calls, errors } = await launch(t, fixture);
  await click('[data-calendar-launch]');
  await click('[data-task-launcher] [data-overview-execute="note:second-task"]');
  await click('[data-task-launcher] footer [data-dialog-close]');
  assert.equal(w.document.querySelector('[data-header-action="details"]').textContent, 'Вторая задача');
  const starts = calls.filter(call => call.command === 'start_task_block').length;
  await click('[data-calendar-current-task] [data-record-menu]');
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, starts, 'More does not start or resume');
  await click('[data-menu-action="finish"]');
  assert.equal(calls.filter(call => call.command === 'finish_task_block').length, 1);
  assert.equal(w.document.querySelector('[data-calendar-current-task]').hidden, true);
  await click('[data-calendar-launch]');
  const previous = w.document.querySelector('[data-launcher-return]');
  assert.equal(previous.hidden, false);
  assert.equal(previous.textContent, 'Вернуться: Подготовить пример');
  previous.focus(); await click('[data-launcher-return]');
  assert.equal(w.document.querySelector('[data-header-action="details"]').textContent, 'Подготовить пример');
  assert.equal(fixture.taskState.blocks.find(block => block.is_active).source_id, 'header-task');
  assert.equal(previous.hidden, true);
  assert.equal(w.document.activeElement, w.document.querySelector('[data-task-launcher] footer [data-dialog-close]'));
  assert.equal(w.document.querySelector('.calendar-now__card').hidden, true);
  assert.deepEqual(errors, []);
});

function pausedTaskFixture() {
  const date = '2026-09-22';
  const task = { id:'header-task', source_type:'note', source_id:'header-task', title:'Подготовить пример', status_extra:'task', date:null, actual_minutes:7, has_work:true };
  const taskState = { tasks:[task], blocks:[{ id:1, source_type:'note', source_id:task.source_id, date, completion_date:date, start_time:'09:00', is_active:false, duration_seconds:420 }] };
  const saved = { version:1, goalId:null, selectionMode:'auto', selection:null, execution:{ blockId:1, date, task:{ ...task, completion_date:date } }, completed:null, observedBlockId:1 };
  return { taskState, initialSettings:[['calendar_now_v1', JSON.stringify(saved)]] };
}

test('one current-task controller follows all panes with paused state, details and shared execution', async t => {
  const fixture = pausedTaskFixture(), { w, click, calls, errors } = await launch(t, fixture);
  for (const pane of ['dash', 'table', 'tasks', 'notes', 'goals']) {
    await click(`[data-pane="${pane}"]`);
    const header = w.document.querySelector('[data-calendar-current-task]');
    assert.equal(header.hidden, false);
    assert.equal(header.querySelector('[data-header-action="details"]').textContent, 'Подготовить пример');
    assert.equal(header.querySelector('[data-header-action="toggle"]').textContent, 'Продолжить');
    assert.equal(header.querySelector('[data-header-time]').textContent, '7 мин');
    assert.equal(w.document.querySelectorAll('[data-calendar-now]').length, 1);
    assert.equal(w.document.querySelector('[data-calendar-now]').hidden, pane !== 'dash');
  }
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 0);
  const title = w.document.querySelector('[data-header-action="details"]');
  title.focus(); await click('[data-header-action="details"]');
  assert.equal(w.document.querySelector('dialog h2').textContent, 'Подготовить пример');
  await click('dialog [data-close]');
  assert.equal(w.document.activeElement, title);
  await click('[data-header-action="toggle"]');
  assert.equal(w.document.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  assert.equal(w.document.activeElement, w.document.querySelector('[data-header-action="toggle"]'));
  await click('[data-pane="notes"]');
  assert.equal(w.document.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  await click('[data-header-action="toggle"]');
  await click('[data-pane="dash"]');
  assert.equal(w.document.querySelector('[data-calendar-now]').dataset.state, 'paused');
  assert.equal(w.document.querySelector('[data-calendar-now]').dataset.taskKey, 'note:header-task');
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 1);
  assert.equal(calls.filter(call => call.command === 'pause_task_block').length, 1);
  assert.equal(fixture.taskState.blocks.filter(block => block.is_active).length, 0);
  assert.deepEqual(errors, []);
});

test('late header start after navigation updates the new controller without reclaiming focus', async t => {
  const fixture = pausedTaskFixture(), { w, click, calls, before, errors } = await launch(t, fixture);
  let release;
  before.set('start_task_block', () => new Promise(resolve => { release = resolve; }));
  w.document.querySelector('[data-header-action="toggle"]').click();
  await settle();
  await click('[data-pane="notes"]');
  const notesTab = w.document.querySelector('[data-pane="notes"]');
  notesTab.focus();
  release(); await settle();
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 1);
  assert.equal(fixture.taskState.blocks.filter(block => block.is_active).length, 1);
  assert.equal(w.document.querySelector('[data-header-action="toggle"]').textContent, 'Пауза');
  assert.equal(w.document.activeElement, notesTab);
  assert.equal(w.document.querySelectorAll('[data-calendar-now]').length, 1);
  assert.deepEqual(errors, []);
});

test('unknown current work stays hidden on read failure and launcher keeps error and retry accessible', async t => {
  const { w, click, before, calls, errors } = await launch(t);
  before.set('get_ui_state', args => { if (args.key === 'calendar_now_v1') throw Error('Read unavailable'); });
  await click('[data-pane="notes"]');
  assert.equal(w.document.querySelector('[data-calendar-now]').hidden, true);
  const header = w.document.querySelector('[data-calendar-current-task]');
  assert.equal(header.hidden, true);
  assert.equal(header.querySelector('[data-header-action="toggle"]').hidden, true);
  const launcher = w.document.querySelector('[data-calendar-launch]');
  launcher.focus(); await click('[data-calendar-launch]');
  assert.match(w.document.querySelector('[data-task-launcher] [data-dialog-error]').textContent, /Не удалось обновить/);
  assert.equal(w.document.querySelector('[data-task-launcher] [data-dialog-retry]').hidden, false);
  before.delete('get_ui_state');
  await click('[data-task-launcher] [data-dialog-retry]');
  assert.equal(header.hidden, true);
  assert.equal(w.document.querySelector('[data-task-launcher] [data-dialog-error]').hidden, true);
  await click('[data-task-launcher] footer [data-dialog-close]');
  assert.equal(w.document.activeElement, launcher);
  assert.equal(calls.filter(call => call.command === 'start_task_block').length, 0);
  assert.deepEqual(errors, []);
});

test('planning closes with Escape outside the panel and Tasks creation starts without a date', async t => {
  const { w, click } = await launch(t);
  await click('[data-pane="table"]');
  await click('[data-tasks-toggle]');
  assert.equal(w.document.querySelector('[data-tasks-panel]').hidden, false);
  w.document.querySelector('[data-period="month"]').focus();
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
  assert.equal(w.document.querySelector('[data-tasks-panel]').hidden, true);
  await click('[data-pane="tasks"]');
  await click('[data-calendar-create]');
  const noDate = w.document.querySelector('#evm-no-date');
  assert.ok(noDate?.checked, 'Task capture must allow an unscheduled date');
});

for (const width of [0, 500]) test(`desktop layout survives startup at ${width}px and restoring the window`, async t => {
  const { w, click } = await launch(t, { width });
  assert.ok(w.document.documentElement.classList.contains('desktop'));
  assert.ok(!w.document.documentElement.classList.contains('mobile'));
  Object.defineProperty(w, 'innerWidth', { value: 1100, configurable: true });
  w.dispatchEvent(new w.Event('resize'));
  await click('[data-calendar-settings]');
  w.document.querySelector('dialog').close(); await settle();
  assert.ok(w.document.activeElement.matches('[data-calendar-settings]'), 'settings return to the desktop sidebar');
  assert.ok(!w.document.documentElement.classList.contains('mobile'));
});

test('Android layout keeps its mobile navigation in a wide viewport', async t => {
  const { w, click } = await launch(t, { width: 1100, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' });
  assert.ok(w.document.documentElement.classList.contains('mobile'));
  await click('#mobile-hamburger');
  assert.ok(w.document.querySelector('#tab-bar').classList.contains('drawer-open'));
});

test('upstream mobile mode enables its CSS and closes the drawer through its backdrop', async t => {
  const { w, click } = await launch(t, { mobile: true });
  assert.ok(w.document.documentElement.classList.contains('mobile'));
  await click('#mobile-hamburger');
  await new Promise(resolve => w.requestAnimationFrame(resolve));
  assert.ok(w.document.querySelector('#tab-bar').classList.contains('drawer-open'));
  assert.ok(w.document.querySelector('.drawer-backdrop').classList.contains('visible'));
  await click('.drawer-backdrop');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  assert.equal(w.document.querySelector('.drawer-backdrop').classList.contains('visible'), false);
});

test('Today has one task list and creation stays in the routine manager', async t => {
  const {w,click,errors}=await launch(t);
  assert.equal(w.document.querySelectorAll('.calendar-recurring__card').length,1);
  assert.equal(w.document.querySelector('[data-calendar-tasks]'),null);
  assert.ok(w.document.querySelector('[data-calendar-recurring] [data-overview-embedded]'));
  assert.equal(w.document.querySelector('[data-undo-day]'),null);
  assert.equal(w.document.querySelector('[data-calendar-recurring] [data-recurring-add]'),null);
  await click('[data-recurring-manage]');
  assert.equal(w.document.querySelectorAll('dialog[open]').length,1);
  await click('[data-recurring-add]');
  assert.equal(w.document.querySelector('[data-add-kind="norm"]'),null);
  assert.equal(w.document.querySelector('[data-add-kind="task"]'), null);
  assert.ok(w.document.querySelector('[name="kind"] option[value="action"]'));
  assert.ok(w.document.querySelector('[name="kind"] option[value="rule"]'));
  assert.ok(w.document.querySelector('[name="title"]'));
  assert.equal(w.document.querySelector('[data-add-kind]'),null,'choice closes before the shared Task/Event form opens');
  await click('dialog[open]:last-of-type footer [data-dialog-close]');
  await click('dialog[open] footer [data-dialog-close]');
  await click('[data-recurring-all]');
  assert.equal(w.document.querySelector('dialog [data-overview-all]').hidden,false);
  await click('dialog footer [data-dialog-close]');
  await click('[data-pane="table"]');
  w.dispatchEvent(new w.CustomEvent('hanni:open-recurring-settings'));
  await settle();
  assert.equal(w.document.querySelectorAll('body > .calendar-recurring[hidden]').length,1);
  await click('dialog footer [data-dialog-close]');
  assert.equal(w.document.querySelectorAll('body > .calendar-recurring[hidden]').length,0);
  assert.deepEqual(errors,[]);
});

test('one persistent action below the Calendar heading opens the shared Task/Event editor and restores focus', async t => {
  const { w, click } = await launch(t);
  assert.equal(w.document.querySelector('[data-overview-create]'), null);
  const trigger = w.document.querySelector('[data-calendar-create]');
  assert.ok(trigger.closest('.uni-header-actions'));
  assert.equal(trigger.closest('.uni-header-actions').previousElementSibling.className, 'uni-header');
  assert.equal(trigger.closest('.uni-header-actions').nextElementSibling.className, 'uni-navigation');
  assert.equal(w.document.querySelector('#tab-bar [data-calendar-create]'), null);
  assert.equal(w.document.querySelector('.uni-header-desc'), null);
  assert.equal(trigger.closest('.uni-content'), null);
  trigger.focus();
  await click('[data-calendar-create]');
  assert.ok(w.document.querySelector('#evm-form'));
  assert.ok(w.document.querySelector('#evm-title'));
  assert.ok(w.document.querySelector('#evm-goal'));
  const toggle = w.document.querySelector('[data-editor-type="event"]');
  assert.ok(toggle, 'shared event switch');
  toggle.click();
  await settle();
  assert.ok(w.document.querySelector('#evm-date'));
  await click('#evm-close');
  assert.equal(w.document.activeElement, trigger);
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelectorAll('[data-calendar-create]').length, 1);
  assert.equal(w.document.querySelector('[data-create]'), null);
  await click('[data-period="day"]');
  await click('[data-today]');
  await click('[data-next]');
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await click('[data-calendar-create]');
  assert.equal(w.document.querySelector('#evm-date').value, date, 'creation uses the viewed date');
});

test('modal settings save without replacing the current calendar pane and return focus on close', async t => {
  const { w, click, calls } = await launch(t);
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  const pane = w.document.querySelector('.uni-pane');
  const scroll = w.document.querySelector('.uni-content'); scroll.scrollTop = 87;
  const trigger = w.document.querySelector('[data-calendar-settings]'); trigger.focus();
  await click('#tab-bar-bottom [aria-label="\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438"]');
  assert.equal(w.document.querySelector('.calendar-settings-dialog h2').textContent, 'Настройки календаря');
  assert.equal(w.document.querySelector('.uni-pane'), pane);
  assert.equal(w.document.querySelectorAll('.setting-pills').length, 3);
  assert.equal(w.document.querySelector('[data-theme-setting]'), null);
  assert.equal(w.document.querySelector('#mvp-settings'), null);
  await click('[data-key="first_day"] [data-value="sun"]');
  assert.equal(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'calendar_preferences_v1'), false);
  await click('.calendar-settings-dialog [type=submit]');
  assert.ok(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'calendar_preferences_v1' && JSON.parse(call.args.value).first_day === 'sun'));
  assert.ok(w.document.querySelector('[data-calendar-records]'));
  assert.equal(w.document.querySelector('.uni-tab.active').dataset.pane, 'table');
  assert.equal(w.document.querySelector('.uni-pane'), pane);
  assert.equal(scroll.scrollTop, 87);
  assert.equal(w.document.activeElement, trigger);
  assert.equal(w.document.querySelector('.calv-weekday').textContent, 'Вс');
  assert.equal(calls.some(call => call.command === 'create_backup'), false);
});

test('clicking the current sidebar item or pane preserves its DOM and scroll, and the header is static', async t => {
  const { w, click, calls } = await launch(t);
  for (const id of ['dash', 'table', 'goals', 'notes']) {
    await click(`[data-pane="${id}"]`);
    const pane = w.document.querySelector('.uni-pane');
    const scroll = w.document.querySelector('.uni-content'); scroll.scrollTop = 61;
    await click('[data-tab-id="calendar"]');
    await click(`[data-pane="${id}"]`);
    assert.equal(w.document.querySelector('.uni-pane'), pane);
    assert.equal(scroll.scrollTop, 61);
  }
  const heading = await click('.uni-header-name');
  assert.notEqual(heading.contentEditable, 'true');
  assert.equal(heading.hasAttribute('title'), false);
  assert.equal(calls.some(call => call.command === 'set_ui_state' && call.args.key === 'tab_meta_calendar'), false);
});

test('settings save failure keeps the old selection and a retry can persist it', async t => {
  const { w, click, before, settings } = await launch(t);
  await click('[data-calendar-settings]');
  before.set('set_ui_state', () => { throw Error('offline'); });
  await click('[data-key="first_day"] [data-value="sun"]');
  await click('.calendar-settings-dialog [type=submit]');
  assert.equal(w.document.querySelector('[data-value="mon"]').getAttribute('aria-pressed'), 'false');
  assert.equal(w.document.querySelector('[data-value="sun"]').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('[data-dialog-error]').hidden, false);
  assert.equal(settings.has('calendar_preferences_v1'), false);
  before.delete('set_ui_state');
  await click('.calendar-settings-dialog [type=submit]');
  assert.equal(JSON.parse(settings.get('calendar_preferences_v1')).first_day, 'sun');
  assert.equal(w.document.querySelector('.calendar-settings-dialog'), null);
});

test('settings wait for acknowledgement before closing and ignore late loading after Escape', async t => {
  const { w, click, before } = await launch(t);
  await click('[data-calendar-settings]');
  let resolveSave;
  before.set('set_ui_state', () => new Promise(resolve => { resolveSave = resolve; }));
  await click('[data-key="first_day"] [data-value="sun"]');
  await click('.calendar-settings-dialog [type=submit]');
  const modal = w.document.querySelector('.calendar-settings-dialog');
  modal.dispatchEvent(new w.Event('cancel', { cancelable:true }));
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(modal.open, true);
  assert.equal(w.document.querySelector('[data-value="mon"]').getAttribute('aria-pressed'), 'false');
  resolveSave(); await settle();
  modal.dispatchEvent(new w.Event('cancel', { cancelable:true })); await settle();
  assert.equal(modal.isConnected, false);
  const pendingReads = [];
  before.set('get_app_setting', () => new Promise(resolve => pendingReads.push(resolve)));
  await click('[data-calendar-settings]');
  const loading = w.document.querySelector('.calendar-settings-dialog');
  loading.dispatchEvent(new w.Event('cancel', { cancelable:true })); await settle();
  pendingReads.forEach(resolve => resolve()); await settle();
  assert.equal(w.document.querySelector('.calendar-settings-dialog'), null);
  assert.equal(w.document.activeElement, w.document.querySelector('[data-calendar-settings]'));
});

test('saved calendar defaults determine the first Table view after startup', async t => {
  const { w, click } = await launch(t, { initialSettings:[['tab_calendar_first_day','sun'], ['tab_calendar_default_view','Неделя']] });
  await click('[data-pane="table"]');
  assert.equal(w.document.querySelector('[data-period="week"]').getAttribute('aria-pressed'), 'true');
  assert.match(w.document.querySelector('.calv-day-weekday').textContent, /Вс/i);
  const range = w.document.querySelector('[data-range]').textContent;
  await click('[data-calendar-settings]');
  await click('[data-key="default_view"] [data-value="День"]');
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(w.document.querySelector('[data-period="week"]').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('[data-range]').textContent, range);
});

test('mobile creation returns to its visible action and settings return to the closed drawer opener', async t => {
  const { w, click } = await launch(t, { mobile:true });
  const create = await click('[data-calendar-create]');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  await click('#evm-close');
  assert.equal(w.document.activeElement, create);
  await click('#mobile-hamburger'); await click('[data-calendar-settings]');
  assert.equal(w.document.querySelector('#tab-bar').classList.contains('drawer-open'), false);
  await click('.calendar-settings-dialog .calendar-editor-close');
  assert.equal(w.document.activeElement.id, 'mobile-hamburger');
});
