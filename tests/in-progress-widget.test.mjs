import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarInProgress, formatWorkTime } from '../src/hanni/js/calendar-in-progress.js';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const TODAY = '2026-09-24', YESTERDAY = '2026-09-23';
const routine = JSON.stringify(['plan-a', TODAY, 0]);

// Fictional records only: two running tasks, one paused today and records that must stay out.
function backend() {
  const state = {
    now: new Date(`${TODAY}T11:00:00`), calls: [], nextId: 50,
    tasks: [
      { source_type:'note', source_id:'draft', title:'Черновик отчёта', status_extra:'task', date:TODAY },
      { source_type:'note', source_id:'call', title:'Позвонить поставщику', status_extra:'task', date:null },
      { source_type:'note', source_id:'letters', title:'Разобрать письма', status_extra:'task', date:TODAY },
      { source_type:'note', source_id:'old', title:'Вчерашняя задача', status_extra:'task', date:null },
    ],
    events: [{ id:'meeting', title:'Созвон с командой', date:TODAY, time:'14:00', completed:true, status:'event' }],
    schedules: [{ id:routine, source_type:'schedule', source_id:routine, title:'Зарядка · Разминка', date:TODAY, completion_date:TODAY, completed:false, status_extra:'pending', block_id:14 }],
    blocks: [
      { id:11, source_type:'note', source_id:'draft', date:TODAY, start_time:'10:30:00', completion_date:TODAY, is_active:true, created_at:'1' },
      { id:12, source_type:'note', source_id:'draft', date:TODAY, start_time:'09:00:00', end_time:'09:40:00', completion_date:TODAY, is_active:false, duration_seconds:2400, created_at:'0' },
      { id:13, source_type:'note', source_id:'letters', date:TODAY, start_time:'08:00:00', end_time:'08:12:30', completion_date:TODAY, is_active:false, duration_seconds:750, created_at:'0' },
      { id:14, source_type:'schedule', source_id:routine, date:TODAY, start_time:'10:58:00', completion_date:TODAY, is_active:true, created_at:'2' },
      { id:15, source_type:'event', source_id:'meeting', date:TODAY, start_time:'07:00:00', end_time:'07:30:00', completion_date:TODAY, is_active:false, duration_seconds:1800, created_at:'0' },
      { id:16, source_type:'note', source_id:'old', date:YESTERDAY, start_time:'18:00:00', end_time:'18:30:00', completion_date:YESTERDAY, is_active:false, duration_seconds:1800, created_at:'0' },
    ],
  };
  state.invoke = async (name, args = {}) => {
    state.calls.push({ name, args });
    if (name === 'get_active_blocks') return state.blocks.filter(block => block.is_active).sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(block => ({ ...block, title:block.source_type === 'note' ? state.tasks.find(task => task.source_id === block.source_id)?.title : null }));
    if (name === 'get_timeline_blocks') return state.blocks.filter(block => block.date === args.date);
    if (name === 'get_calendar_tasks') return state.tasks.filter(task => task.status_extra === 'task' && !task.completed);
    if (name === 'get_all_events') return state.events;
    if (name === 'get_schedules') return state.schedules;
    if (name === 'pause_task_block') { const block = state.blocks.find(value => value.id === args.blockId); block.is_active = false; block.duration_seconds = 60; return; }
    if (name === 'start_task_block') {
      assert.equal(state.blocks.some(block => block.is_active && block.source_type === args.sourceType && block.source_id === args.sourceId), false);
      const id = state.nextId++;
      state.blocks.push({ id, source_type:args.sourceType, source_id:args.sourceId, date:TODAY, start_time:'11:00:00', completion_date:args.completionDate, is_active:true, created_at:String(id) });
      return id;
    }
    if (name === 'complete_calendar_task') { state.tasks.find(task => task.source_id === args.id).status_extra = 'done'; return; }
    if (name === 'finish_task_block') { const block = state.blocks.find(value => value.id === args.blockId); block.is_active = false; const step = state.schedules.find(value => value.source_id === block.source_id); if (step) { step.completed = true; step.status_extra = 'done'; } return; }
    throw new Error(`Unexpected ${name}`);
  };
  state.count = name => state.calls.filter(call => call.name === name).length;
  return state;
}
async function mount(t, data = backend(), extra = {}) {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual:true }), host = dom.window.document.querySelector('main');
  const opened = [], launched = [], menus = [];
  const dispose = mountCalendarInProgress(host, { invoke:data.invoke, now:() => new Date(data.now), openTask:(row, restore) => opened.push({ row, restore }), openLauncher:button => launched.push(button),
    mountMenu:(element, options) => { menus.push(options); return () => {}; }, ...extra });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const rows = () => [...host.querySelectorAll('.cip-row')];
  const control = (key, name) => [...host.querySelectorAll('[data-cip-control]')].find(button => button.dataset.cipKey === key && button.dataset.cipControl === name);
  return { dom, host, data, dispose, opened, launched, menus, rows, control, text:() => rows().map(row => [row.querySelector('.cip-title').textContent, row.querySelector('.cip-state').textContent, row.querySelector('.cip-time').textContent]) };
}

test('work time reads as mm:ss under an hour and in hours and minutes after it', () => {
  assert.equal(formatWorkTime(0), '00:00');
  assert.equal(formatWorkTime(754), '12:34');
  assert.equal(formatWorkTime(3599), '59:59');
  assert.equal(formatWorkTime(3900), '1 ч 05 мин');
  assert.equal(formatWorkTime(-5), '00:00');
});

test('nothing running folds into one line whose only action opens the existing task picker', async t => {
  const data = backend(); data.blocks = [];
  const x = await mount(t, data);
  assert.equal(x.rows().length, 0);
  const empty = x.host.querySelector('[data-cip-empty]');
  assert.equal(empty.hidden, false);
  assert.equal(x.host.querySelector('[data-cip-heading]').hidden, true);
  assert.equal(x.host.querySelector('[data-cip-footer]').hidden, true);
  assert.match(empty.textContent, /Ничего не запущено/);
  const start = empty.querySelector('[data-cip-launch]');
  assert.equal(start.textContent.trim(), 'Запустить');
  start.click();
  assert.deepEqual(x.launched, [start]);
  assert.equal(data.count('start_task_block'), 0, 'opening the picker starts nothing');
});

test('running tasks come first with live time, paused-today tasks follow and finished or older work stays out', async t => {
  const x = await mount(t);
  assert.deepEqual(x.text(), [
    ['Зарядка · Разминка', 'идёт', '02:00'],
    ['Черновик отчёта', 'идёт', '1 ч 10 мин'],
    ['Разобрать письма', 'пауза', '12:30'],
  ]);
  assert.equal(x.host.querySelector('[data-cip-count]').textContent, '2 идут · 1 на паузе');
  assert.deepEqual(x.rows().map(row => row.classList.contains('is-running')), [true, true, false]);
  assert.equal(x.control('note:draft', 'toggle').getAttribute('aria-label'), 'Пауза: Черновик отчёта');
  assert.equal(x.control('note:letters', 'toggle').getAttribute('aria-label'), 'Продолжить: Разобрать письма');
  assert.equal(x.control('note:letters', 'finish').getAttribute('aria-label'), 'Готово: Разобрать письма');
  assert.ok(x.control('note:letters', 'menu').hasAttribute('data-record-menu'));
  x.data.now = new Date(`${TODAY}T11:00:07`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(x.text().map(row => row[2]), ['02:07', '1 ч 10 мин', '12:30'], 'running rows tick, paused rows stay');
  assert.equal(x.host.querySelector('[data-cip-launch]').textContent.trim(), '＋ Запустить ещё');
  x.host.querySelector('[data-cip-footer] [data-cip-launch]').click();
  assert.equal(x.launched.length, 1);
  x.control('note:letters', 'open').click();
  assert.equal(x.opened[0].row.source_id, 'letters');
  assert.equal(x.opened[0].row.is_active, false);
  assert.equal(x.menus[0].getRecord({ dataset:{ contextRecord:'note:draft' } }).title, 'Черновик отчёта');
  assert.equal(x.data.count('start_task_block') + x.data.count('pause_task_block'), 0, 'reading starts or pauses nothing');
});

test('pause and resume act on one task while the other keeps running', async t => {
  const x = await mount(t);
  x.control('note:draft', 'toggle').click(); await settle();
  assert.deepEqual(x.data.calls.filter(call => call.name === 'pause_task_block').map(call => call.args.blockId), [11]);
  assert.equal(x.data.blocks.find(block => block.id === 14).is_active, true, 'the routine step keeps running');
  assert.deepEqual(x.text().map(row => row.slice(0, 2)), [['Зарядка · Разминка', 'идёт'], ['Черновик отчёта', 'пауза'], ['Разобрать письма', 'пауза']]);
  assert.equal(x.dom.window.document.activeElement, x.control('note:draft', 'toggle'));
  x.control('note:letters', 'toggle').click(); await settle();
  assert.deepEqual(x.data.calls.find(call => call.name === 'start_task_block').args, { sourceType:'note', sourceId:'letters', completionDate:TODAY });
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
  assert.equal(x.rows().some(row => row.dataset.contextRecord === 'note:draft'), false);
  x.control(`schedule:${routine}`, 'finish').click(); await settle();
  assert.deepEqual(x.data.calls.find(call => call.name === 'finish_task_block').args, { blockId:14 });
  assert.deepEqual(x.text().map(row => row[0]), ['Разобрать письма']);
  assert.deepEqual(events, ['changed', 'changed', 'recurring']);
  assert.equal(x.data.count('start_task_block'), 0);
});

test('a failed action keeps the rows, reports the error and allows another try', async t => {
  const data = backend(), real = data.invoke;
  data.invoke = async (name, args) => { if (name === 'pause_task_block') throw new Error('Проверочная ошибка'); return real(name, args); };
  const y = await mount(t, data);
  y.control('note:draft', 'toggle').click(); await settle();
  assert.equal(y.host.querySelector('[data-cip-message]').getAttribute('role'), 'alert');
  assert.match(y.host.querySelector('[data-cip-message]').textContent, /Проверочная ошибка/);
  assert.equal(y.rows().length, 3);
  assert.equal(y.control('note:draft', 'toggle').disabled, false);
});
