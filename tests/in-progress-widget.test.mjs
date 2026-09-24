import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarInProgress, formatWorkTime, formatAgainstEstimate, HIDDEN_KEY } from '../src/hanni/js/calendar-in-progress.js';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const TODAY = '2026-09-24', YESTERDAY = '2026-09-23';
const routine = JSON.stringify(['plan-a', TODAY, 0]);

// Fictional records only: two running tasks, one paused today and records that must stay out.
function backend() {
  const state = {
    now: new Date(`${TODAY}T11:00:00`), calls: [], nextId: 50, ui: new Map(),
    tasks: [
      { source_type:'note', source_id:'draft', title:'Черновик отчёта', status_extra:'task', date:TODAY, duration_minutes:60, task_kind:'normal', stage:'description', waiting:false, earlier:0 },
      { source_type:'note', source_id:'call', title:'Позвонить поставщику', status_extra:'task', date:null, duration_minutes:null, task_kind:'normal', stage:'', waiting:false, earlier:0 },
      { source_type:'note', source_id:'letters', title:'Разобрать письма', status_extra:'task', date:TODAY, duration_minutes:45, task_kind:'normal', stage:'agreement', waiting:true, earlier:1200 },
      { source_type:'note', source_id:'old', title:'Вчерашняя задача', status_extra:'task', date:null, duration_minutes:null, task_kind:'normal', stage:'', waiting:false, earlier:0 },
    ],
    events: [{ id:'meeting', title:'Созвон с командой', date:TODAY, time:'14:00', completed:true, status:'event' }],
    schedules: [{ id:routine, source_type:'schedule', source_id:routine, title:'Зарядка · Разминка', date:TODAY, completion_date:TODAY, completed:false, status_extra:'pending', block_id:14 }],
    goals: [{ id:'g1', title:'Освоить системный анализ', parent_goal_id:null }, { id:'g2', title:'Портфолио аналитика', parent_goal_id:'g1' }],
    links: [{ source_type:'note', source_id:'draft', goal_id:'g2' }],
    blocks: [
      { id:11, source_type:'note', source_id:'draft', date:TODAY, start_time:'10:30:00', completion_date:TODAY, is_active:true, created_at:'1' },
      { id:12, source_type:'note', source_id:'draft', date:TODAY, start_time:'09:00:00', end_time:'09:40:00', completion_date:TODAY, is_active:false, duration_seconds:2400, created_at:'0' },
      { id:13, source_type:'note', source_id:'letters', date:TODAY, start_time:'08:00:00', end_time:'08:12:30', completion_date:TODAY, is_active:false, duration_seconds:750, created_at:'0' },
      { id:14, source_type:'schedule', source_id:routine, date:TODAY, start_time:'10:58:00', completion_date:TODAY, is_active:true, created_at:'2' },
      { id:15, source_type:'event', source_id:'meeting', date:TODAY, start_time:'07:00:00', end_time:'07:30:00', completion_date:TODAY, is_active:false, duration_seconds:1800, created_at:'0' },
      { id:16, source_type:'note', source_id:'old', date:YESTERDAY, start_time:'18:00:00', end_time:'18:30:00', completion_date:YESTERDAY, is_active:false, duration_seconds:1800, created_at:'0' },
    ],
  };
  // Closed work of every day, as the native task list reports it.
  const withWork = task => ({ ...task, actual_minutes: Math.floor((task.earlier + state.blocks.filter(block => !block.is_active && block.source_id === task.source_id).reduce((sum, block) => sum + (block.duration_seconds || 0), 0)) / 60) });
  state.invoke = async (name, args = {}) => {
    state.calls.push({ name, args });
    if (name === 'get_active_blocks') return state.blocks.filter(block => block.is_active).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(block => ({ ...block, title:block.source_type === 'note' ? state.tasks.find(task => task.source_id === block.source_id)?.title : null }));
    if (name === 'get_timeline_blocks') return state.blocks.filter(block => block.date === args.date);
    if (name === 'get_calendar_tasks') return state.tasks.filter(task => task.status_extra === 'task' && !task.completed).map(withWork);
    if (name === 'get_all_events') return state.events;
    if (name === 'get_schedules') return state.schedules;
    if (name === 'get_goals') return state.goals;
    if (name === 'get_calendar_task_goals') return state.links;
    if (name === 'get_ui_state') return state.ui.get(args.key) ?? null;
    if (name === 'set_ui_state') { state.ui.set(args.key, args.value); return; }
    if (name === 'pause_task_block') { const block = state.blocks.find(value => value.id === args.blockId); block.is_active = false; block.duration_seconds = 60; block.end_time = '11:00:00'; return; }
    if (name === 'start_task_block') {
      assert.equal(state.blocks.some(block => block.is_active && block.source_type === args.sourceType && block.source_id === args.sourceId), false);
      const id = state.nextId++, start = state.now.toTimeString().slice(0, 8);
      state.blocks.push({ id, source_type:args.sourceType, source_id:args.sourceId, date:TODAY, start_time:start, completion_date:args.completionDate, is_active:true, created_at:String(id) });
      return id;
    }
    if (name === 'cancel_task_block') {
      const at = state.blocks.findIndex(value => value.id === args.blockId && value.is_active);
      if (at < 0) throw 'block is not active';
      state.blocks.splice(at, 1); return;
    }
    if (name === 'set_calendar_task_stage') {
      const task = state.tasks.find(value => value.source_id === args.id);
      if (args.stage != null) task.stage = args.stage;
      if (args.waiting != null) task.waiting = args.waiting;
      return { id:task.source_id, title:task.title, stage:task.stage, waiting:task.waiting, status:'task' };
    }
    if (name === 'complete_calendar_task') { state.tasks.find(task => task.source_id === args.id).status_extra = 'done'; return; }
    if (name === 'finish_task_block') { const block = state.blocks.find(value => value.id === args.blockId); block.is_active = false; const step = state.schedules.find(value => value.source_id === block.source_id); if (step) { step.completed = true; step.status_extra = 'done'; } return; }
    throw new Error(`Unexpected ${name}`);
  };
  state.count = name => state.calls.filter(call => call.name === name).length;
  state.args = name => state.calls.filter(call => call.name === name).map(call => call.args);
  return state;
}
async function mount(t, data = backend(), extra = {}) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual:true }), host = dom.window.document.querySelector('main');
  const opened = [], launched = [];
  const dispose = mountCalendarInProgress(host, { invoke:data.invoke, now:() => new Date(data.now), openTask:(row, restore) => opened.push({ row, restore }), openLauncher:button => launched.push(button), ...extra });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const doc = dom.window.document;
  const rows = () => [...host.querySelectorAll('.cip-row')];
  const row = key => rows().find(item => item.dataset.contextRecord === key);
  const control = (key, name) => [...host.querySelectorAll('[data-cip-control]')].find(button => button.dataset.cipKey === key && button.dataset.cipControl === name);
  const menu = () => doc.querySelector('.cip-menu');
  const menuItems = () => [...(menu()?.querySelectorAll('[role^="menuitem"]') || [])].map(item => item.querySelector('.cip-menu-label').textContent);
  const choose = async label => { [...menu().querySelectorAll('[role^="menuitem"]')].find(item => item.querySelector('.cip-menu-label').textContent === label).click(); await settle(); };
  const text = () => rows().map(item => [item.querySelector('.cip-title').textContent, item.querySelector('.cip-time').textContent, item.querySelector('.cip-stage .cip-stage-text')?.textContent ?? null, item.querySelector('.cip-goal')?.textContent ?? null]);
  const refresh = async () => { dom.window.dispatchEvent(new dom.window.Event('task-state-changed')); await settle(); };
  return { dom, doc, host, data, dispose, opened, launched, rows, row, control, menu, menuItems, choose, text, refresh };
}

test('work time reads as mm:ss under an hour and against the estimate in minutes', () => {
  assert.equal(formatWorkTime(0), '00:00');
  assert.equal(formatWorkTime(754), '12:34');
  assert.equal(formatWorkTime(3900), '1 ч 05 мин');
  assert.equal(formatAgainstEstimate(754, 60), '12 / 60 мин');
  assert.equal(formatAgainstEstimate(754, null), '12 мин');
  assert.equal(formatAgainstEstimate(-5, 30), '0 / 30 мин');
  assert.equal(formatAgainstEstimate(4500, 60), '75 / 60 мин');
});

test('nothing running folds into one line whose only action opens the existing task picker', async t => {
  const data = backend(); data.blocks = [];
  const x = await mount(t, data);
  assert.equal(x.rows().length, 0);
  const empty = x.host.querySelector('[data-cip-empty]');
  assert.equal(empty.hidden, false);
  assert.equal(x.host.querySelector('[data-cip-heading]').hidden, true);
  assert.match(empty.textContent, /Ничего не запущено/);
  const start = empty.querySelector('[data-cip-launch]');
  start.click();
  assert.deepEqual(x.launched, [start]);
  assert.equal(data.count('start_task_block'), 0, 'opening the picker starts nothing');
});

test('rows show total time against the estimate, the stage chip and the goal; over the estimate turns amber', async t => {
  const x = await mount(t);
  assert.deepEqual(x.text(), [
    ['Зарядка · Разминка', '2 мин', null, null],
    ['Черновик отчёта', '70 / 60 мин', 'Описание', 'Портфолио аналитика'],
    ['Разобрать письма', '32 / 45 мин', 'Жду ответа · Согласование', null],
  ], 'running first; paused-today next; finished and older work stays out');
  assert.equal(x.host.querySelector('[data-cip-count]').textContent, '2 идут · 1 на паузе');
  assert.deepEqual(x.rows().map(item => item.classList.contains('is-running')), [true, true, false]);
  const draft = x.row('note:draft'), letters = x.row('note:letters');
  assert.equal(draft.querySelector('.cip-time').classList.contains('is-over'), true, 'actual 70 is over the 60 minute estimate');
  assert.equal(draft.querySelector('.cip-time').getAttribute('aria-label'), 'Идёт. Учтено 70 из 60 мин, больше оценки');
  assert.equal(draft.querySelector('[data-cip-progress]').classList.contains('is-over'), true);
  assert.equal(draft.querySelector('[data-cip-progress] > span').style.width, '100%');
  assert.equal(letters.querySelector('.cip-time').classList.contains('is-over'), false);
  assert.equal(letters.querySelector('[data-cip-progress] > span').style.width, '71.1%');
  assert.equal(letters.querySelector('.cip-stage').classList.contains('is-waiting'), true);
  assert.equal(x.row(`schedule:${routine}`).querySelector('[data-cip-progress]'), null, 'no estimate, no bar');
  assert.equal(x.row(`schedule:${routine}`).querySelector('.cip-stage'), null, 'a routine step has no stage');
  assert.equal(x.control('note:draft', 'toggle').getAttribute('aria-label'), 'Пауза: Черновик отчёта');
  assert.equal(x.control('note:letters', 'finish').getAttribute('aria-label'), 'Готово: Разобрать письма');
  assert.match(x.control('note:draft', 'stage').getAttribute('aria-label'), /^Стадия: Описание\. Изменить: Черновик отчёта$/);
  x.data.now = new Date(`${TODAY}T11:01:00`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(x.text().map(row => row[1]), ['3 мин', '71 / 60 мин', '32 / 45 мин'], 'running rows tick, paused rows stay');
  x.control('note:letters', 'open').click();
  assert.equal(x.opened[0].row.source_id, 'letters');
  assert.equal(x.data.count('start_task_block') + x.data.count('pause_task_block') + x.data.count('set_ui_state'), 0, 'reading changes nothing');
});

test('an instant task shows no stage chip and no estimate', async t => {
  const data = backend();
  data.tasks.push({ source_type:'note', source_id:'quick', title:'Полить цветы', status_extra:'task', date:TODAY, duration_minutes:5, task_kind:'instant', stage:'development', waiting:false, earlier:0 });
  data.blocks.push({ id:17, source_type:'note', source_id:'quick', date:TODAY, start_time:'10:59:00', completion_date:TODAY, is_active:true, created_at:'3' });
  const x = await mount(t, data);
  const quick = x.row('note:quick');
  assert.equal(quick.querySelector('.cip-stage'), null);
  assert.equal(quick.querySelector('.cip-time').textContent, '1 мин');
  assert.equal(quick.querySelector('[data-cip-progress]'), null);
});

test('pause and resume act on one task while the other keeps running', async t => {
  const x = await mount(t);
  x.control('note:draft', 'toggle').click(); await settle();
  assert.deepEqual(x.data.args('pause_task_block').map(args => args.blockId), [11]);
  assert.equal(x.data.blocks.find(block => block.id === 14).is_active, true, 'the routine step keeps running');
  assert.equal(x.row('note:draft').classList.contains('is-paused'), true);
  assert.equal(x.dom.window.document.activeElement, x.control('note:draft', 'toggle'));
  x.control('note:letters', 'toggle').click(); await settle();
  assert.deepEqual(x.data.args('start_task_block')[0], { sourceType:'note', sourceId:'letters', completionDate:TODAY });
  assert.equal(x.data.count('pause_task_block'), 1, 'resuming never pauses other work');
  assert.deepEqual(x.data.blocks.filter(block => block.is_active).map(block => block.source_id).sort(), ['letters', routine].sort());
  assert.equal(x.rows()[0].querySelector('.cip-title').textContent, 'Разобрать письма', 'the newest running task leads');
  assert.match(x.host.querySelector('[data-cip-message]').textContent, /снова в работе/);
});

test('Done closes a note through task completion and a routine step through its latest block', async t => {
  const events = [];
  const x = await mount(t, backend(), { notifyChange:() => events.push('changed') });
  x.dom.window.addEventListener('hanni:recurring-changed', () => events.push('recurring'));
  x.control('note:draft', 'finish').click(); await settle();
  assert.deepEqual(x.data.calls.filter(call => ['pause_task_block', 'complete_calendar_task'].includes(call.name)).map(call => [call.name, call.args]), [['pause_task_block', { blockId:11 }], ['complete_calendar_task', { id:'draft' }]]);
  assert.equal(x.row('note:draft'), undefined);
  x.control(`schedule:${routine}`, 'finish').click(); await settle();
  assert.deepEqual(x.data.args('finish_task_block')[0], { blockId:14 });
  assert.deepEqual(x.text().map(row => row[0]), ['Разобрать письма']);
  assert.deepEqual(events, ['changed', 'changed', 'recurring']);
  assert.equal(x.data.count('start_task_block'), 0);
});

test('the stage chip opens seven stages, «Без стадии» and a «Жду ответа» toggle', async t => {
  const x = await mount(t);
  const chip = x.control('note:draft', 'stage');
  chip.click();
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(x.menuItems(), ['Понимание', 'Требования', 'Описание', 'Согласование', 'Декомпозиция', 'В разработке', 'Приёмка', 'Без стадии', 'Жду ответа']);
  const checked = [...x.menu().querySelectorAll('[aria-checked="true"]')].map(item => item.textContent);
  assert.deepEqual(checked, ['Описание']);
  assert.equal(x.doc.activeElement, x.menu().querySelector('[data-menu-action="stage:description"]'), 'focus starts at the current stage');
  await x.choose('Согласование');
  assert.deepEqual(x.data.args('set_calendar_task_stage'), [{ id:'draft', stage:'agreement', waiting:null }]);
  assert.equal(x.menu(), null);
  assert.equal(x.row('note:draft').querySelector('.cip-stage-text').textContent, 'Согласование');
  assert.equal(x.doc.activeElement, x.control('note:draft', 'stage'));
  x.control('note:draft', 'stage').click();
  await x.choose('Жду ответа');
  assert.deepEqual(x.data.args('set_calendar_task_stage')[1], { id:'draft', stage:null, waiting:true });
  assert.equal(x.row('note:draft').querySelector('.cip-stage-text').textContent, 'Жду ответа · Согласование');
  x.control('note:letters', 'stage').click();
  await x.choose('Без стадии');
  assert.deepEqual(x.data.args('set_calendar_task_stage')[2], { id:'letters', stage:'', waiting:null });
  assert.equal(x.row('note:letters').querySelector('.cip-stage-text').textContent, 'Жду ответа', 'waiting stays without a stage');
  // Escape closes the menu without a change and returns focus to the chip.
  x.control('note:letters', 'stage').click();
  x.doc.dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
  assert.equal(x.menu(), null);
  assert.equal(x.doc.activeElement, x.control('note:letters', 'stage'));
  assert.equal(x.data.count('set_calendar_task_stage'), 3);
  assert.equal(x.data.count('pause_task_block') + x.data.count('start_task_block'), 0, 'a stage never touches the timer');
});

test('the ⋯ menu offers Stop, Cancel start only for running work, and Open', async t => {
  const x = await mount(t);
  x.control('note:draft', 'menu').click();
  assert.deepEqual(x.menuItems(), ['Остановить', 'Отменить запуск', 'Открыть']);
  await x.choose('Открыть');
  assert.equal(x.opened.at(-1).row.source_id, 'draft');
  x.control('note:letters', 'menu').click();
  assert.deepEqual(x.menuItems(), ['Остановить', 'Открыть'], 'a paused task has no start to cancel');
  x.control('note:letters', 'menu').click();
  assert.equal(x.menu(), null, 'the trigger toggles the menu');
});

test('Stop pauses the task and keeps it out of «В работе» until it is started again', async t => {
  const x = await mount(t);
  x.control('note:draft', 'menu').click();
  await x.choose('Остановить');
  assert.deepEqual(x.data.args('pause_task_block'), [{ blockId:11 }], 'running time is kept by a normal pause');
  const stored = JSON.parse(x.data.ui.get(HIDDEN_KEY));
  assert.deepEqual(Object.keys(stored), ['note:draft']);
  assert.equal(Date.parse(stored['note:draft']), new Date(`${TODAY}T11:00:00`).getTime());
  assert.equal(x.row('note:draft'), undefined);
  assert.deepEqual(x.text().map(row => row[0]), ['Зарядка · Разминка', 'Разобрать письма']);
  assert.match(x.host.querySelector('[data-cip-message]').textContent, /Время сохранено/);
  await x.refresh();
  assert.equal(x.row('note:draft'), undefined, 'a reread keeps it hidden');
  // A paused task can be stopped too; nothing is paused for it.
  x.control('note:letters', 'menu').click();
  await x.choose('Остановить');
  assert.equal(x.data.count('pause_task_block'), 1);
  assert.equal(x.row('note:letters'), undefined);
  // Starting the task again from anywhere brings it back and forgets the stop.
  x.data.now = new Date(`${TODAY}T11:05:00`);
  await x.data.invoke('start_task_block', { sourceType:'note', sourceId:'draft', completionDate:TODAY });
  await x.refresh();
  assert.equal(x.row('note:draft').classList.contains('is-running'), true);
  assert.deepEqual(Object.keys(JSON.parse(x.data.ui.get(HIDDEN_KEY))), ['note:letters']);
  x.control('note:draft', 'toggle').click(); await settle();
  assert.equal(x.row('note:draft').classList.contains('is-paused'), true, 'paused after the restart it stays listed');
});

test('old or invalid stop marks are pruned', async t => {
  const data = backend();
  data.ui.set(HIDDEN_KEY, JSON.stringify({ 'note:letters': `${YESTERDAY}T07:00:00.000Z`, 'note:gone': '2026-09-01T10:00:00.000Z', 'note:bad': 'soon' }));
  const x = await mount(t, data);
  assert.ok(x.row('note:letters'), 'work that started after the stop brings the task back');
  assert.deepEqual(JSON.parse(data.ui.get(HIDDEN_KEY)), {});
});

test('Cancel start asks once inline, then discards only the running block', async t => {
  const x = await mount(t);
  x.control('note:draft', 'menu').click();
  await x.choose('Отменить запуск');
  assert.equal(x.doc.querySelector('dialog'), null, 'no modal');
  const panel = x.row('note:draft').querySelector('.cip-confirm');
  assert.match(panel.textContent, /Время этого запуска \(30 мин\) не сохранится/);
  assert.equal(x.doc.activeElement, x.control('note:draft', 'cancel-confirm'));
  x.control('note:draft', 'cancel-keep').click(); await settle();
  assert.equal(x.row('note:draft').querySelector('.cip-confirm'), null);
  assert.equal(x.doc.activeElement, x.control('note:draft', 'menu'));
  assert.equal(x.data.count('cancel_task_block'), 0);
  x.control('note:draft', 'menu').click();
  await x.choose('Отменить запуск');
  x.row('note:draft').dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  assert.equal(x.row('note:draft').querySelector('.cip-confirm'), null, 'Escape keeps the start');
  x.control('note:draft', 'menu').click();
  await x.choose('Отменить запуск');
  x.control('note:draft', 'cancel-confirm').click(); await settle();
  assert.deepEqual(x.data.args('cancel_task_block'), [{ blockId:11 }]);
  assert.equal(x.data.count('pause_task_block'), 0);
  // Earlier work of today stays: the task is listed as paused with only that time.
  assert.equal(x.row('note:draft').classList.contains('is-paused'), true);
  assert.equal(x.row('note:draft').querySelector('.cip-time').textContent, '40 / 60 мин');
  assert.equal(x.data.blocks.find(block => block.id === 14).is_active, true, 'other running work is untouched');
  assert.match(x.host.querySelector('[data-cip-message]').textContent, /Запуск отменён/);
});

test('a failed action keeps the rows, reports the error and allows another try', async t => {
  const data = backend(), real = data.invoke;
  data.invoke = async (name, args) => { if (['pause_task_block', 'set_calendar_task_stage'].includes(name)) throw new Error('Проверочная ошибка'); return real(name, args); };
  const y = await mount(t, data);
  y.control('note:draft', 'toggle').click(); await settle();
  assert.equal(y.host.querySelector('[data-cip-message]').getAttribute('role'), 'alert');
  assert.match(y.host.querySelector('[data-cip-message]').textContent, /Проверочная ошибка/);
  assert.equal(y.rows().length, 3);
  assert.equal(y.control('note:draft', 'toggle').disabled, false);
  // A failed stop hides nothing.
  y.control('note:draft', 'menu').click();
  await y.choose('Остановить');
  assert.equal(data.ui.has(HIDDEN_KEY), false);
  assert.ok(y.row('note:draft'));
  y.control('note:draft', 'stage').click();
  await y.choose('Приёмка');
  assert.equal(y.row('note:draft').querySelector('.cip-stage-text').textContent, 'Описание', 'the stage is unchanged');
});
