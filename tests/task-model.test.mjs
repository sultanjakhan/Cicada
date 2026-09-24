// Task time of day, kind and sphere (#96), work stages (2026-09-24) and the shared «Создать» dialog (#97).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TASK_SPHERES, TASK_STAGES, sphereLabel, stageLabel, isInstantTask, taskTime, compareTaskTime } from '../src/hanni/js/task-model.js';
import { rankTasks } from '../src/hanni/js/task-picker-sort.js';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
import { mountCalendarDashboardTasks } from '../src/hanni/js/calendar-dashboard-tasks.js';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const localDay = (shift = 0) => { const d = new Date(); d.setDate(d.getDate() + shift); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The dialog reads the global window/document, like the app shell.
function useWindow(t, handlers = {}) {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost', pretendToBeVisual: true }), w = dom.window;
  for (const name of ['window', 'document', 'localStorage', 'MutationObserver', 'AbortController', 'CustomEvent', 'Event', 'FormData', 'Option']) globalThis[name] = name === 'window' ? w : w[name];
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
  const calls = [], all = { list_event_categories: [{ id: 'general', name: 'general', color: '#999' }], get_goals: [{ id: 'g', title: 'Fictional goal', goal_kind: 'goal' }], get_calendar_task_goals: [], ...handlers };
  w.__TAURI__ = { core: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (!(command in all)) throw new Error(`Unexpected IPC: ${command}`);
    return typeof all[command] === 'function' ? all[command](args) : all[command];
  } } };
  t.after(() => w.close());
  const q = selector => w.document.querySelector(selector);
  const shown = selector => { const el = q(selector); return !!el && !el.closest('[hidden]'); };
  const key = (selector, key, extra = {}) => q(selector).dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  const saved = command => calls.filter(call => call.command === command).map(call => call.args);
  return { w, q, shown, key, saved, calls };
}
const modal = () => import('../src/hanni/js/calendar-event-modal.js');

test('task model helpers read legacy rows as normal, untimed and without sphere', () => {
  assert.deepEqual(TASK_SPHERES.map(([id, label]) => `${id}:${label}`), ['work:Работа', 'home:Дом', 'health:Здоровье', 'growth:Развитие', 'personal:Личное']);
  assert.equal(sphereLabel('home'), 'Дом'); assert.equal(sphereLabel('finance'), ''); assert.equal(sphereLabel(null), '');
  assert.equal(isInstantTask({ source_type: 'note', task_kind: 'instant' }), true);
  assert.equal(isInstantTask({ source_type: 'note' }), false, 'records without a kind are normal');
  assert.equal(isInstantTask({ source_type: 'schedule', task_kind: 'instant' }), false);
  assert.equal(taskTime({ date: '2026-09-24', planned_time: '09:05' }), '09:05');
  assert.equal(taskTime({ date: '2026-09-24', time: '18:40' }), '18:40', 'task details use `time`');
  assert.equal(taskTime({ date: null, planned_time: '09:05' }), '', 'a time without its date is not shown');
  assert.equal(taskTime({ date: '2026-09-24', planned_time: '9:5' }), '');
  const rows = [{ id: 'untimed', date: '2026-09-24' }, { id: 'late', date: '2026-09-24', planned_time: '18:00' }, { id: 'early', date: '2026-09-24', planned_time: '08:00' }];
  assert.deepEqual([...rows].sort(compareTaskTime).map(row => row.id), ['early', 'late', 'untimed']);
});

test('the start picker and Now recommendation never offer an instant task', () => {
  const ranked = rankTasks([
    { source_type: 'note', source_id: 'instant', task_kind: 'instant' },
    { source_type: 'note', source_id: 'normal', task_kind: 'normal' },
    { source_type: 'note', source_id: 'legacy' },
  ], { nowMin: 600 });
  assert.deepEqual(ranked.map(row => row.source_id).sort(), ['legacy', 'normal']);
});

test('Create puts the title first, offers four types and switches the fields by type', async t => {
  const x = useWindow(t);
  const { showCalendarCreateModal } = await modal();
  await showCalendarCreateModal('2026-09-24', {}); await settle();
  assert.deepEqual([...x.w.document.querySelectorAll('[data-editor-type]')].map(el => el.textContent), ['Задача', 'Событие', 'Цель', 'Заметка']);
  assert.equal(x.q('.evm-title-field').nextElementSibling, x.q('.evm-type-picker'), 'the type choice follows the title');
  assert.equal(x.q('[data-editor-type="wish"]'), null, 'no placeholder for the later wishlist');
  const pressed = () => x.q('[data-editor-type][aria-pressed="true"]').dataset.editorType;
  assert.equal(pressed(), 'task'); assert.equal(x.q('#evm-heading').textContent, 'Новая задача');
  for (const selector of ['#evm-date', '#evm-task-time', '#evm-no-date', '[name="evm-task-kind"]', '#evm-sphere', '#evm-task-estimate', '#evm-goal', '#evm-important']) assert.ok(x.shown(selector), selector);
  for (const selector of ['#evm-time', '#evm-desc', '#evm-goal-description', '#evm-note-text']) assert.equal(x.shown(selector), false, selector);

  x.q('[data-editor-type="event"]').click();
  assert.equal(pressed(), 'event'); assert.equal(x.q('#evm-heading').textContent, 'Новое событие');
  assert.ok(x.shown('#evm-time') && x.shown('#evm-all-day'));
  for (const selector of ['#evm-task-time', '#evm-sphere', '[name="evm-task-kind"]']) assert.equal(x.shown(selector), false, selector);

  x.q('[data-editor-type="goal"]').click();
  assert.equal(x.q('#evm-heading').textContent, 'Новая цель'); assert.equal(x.q('#evm-save').textContent, 'Создать цель');
  assert.ok(x.shown('#evm-goal-description'));
  for (const selector of ['#evm-date', '#evm-goal', '#evm-note-text']) assert.equal(x.shown(selector), false, selector);

  x.q('[data-editor-type="note"]').click();
  assert.equal(x.q('#evm-heading').textContent, 'Новая заметка'); assert.equal(x.q('#evm-title-label').textContent, 'Название · необязательно');
  assert.ok(x.shown('#evm-note-text')); assert.equal(x.shown('#evm-goal-description'), false);

  x.q('[data-editor-type="task"]').click();
  assert.equal(x.q('#evm-title-label').textContent, 'Название'); assert.ok(x.shown('#evm-task-time'));
  x.key('#evm-title', 'Escape');
  assert.equal(x.q('#evm-form'), null, 'Esc closes the dialog');
  assert.deepEqual(x.calls.filter(call => !call.command.startsWith('get_') && call.command !== 'list_event_categories'), [], 'closing saves nothing');
});

test('a skill-linked task keeps only the Task and Event choice', async t => {
  const x = useWindow(t);
  const { showCalendarCreateModal } = await modal();
  await showCalendarCreateModal(null, { initialNoDate: true, goalId: 'g', onTaskSaved: async () => {} }); await settle();
  assert.deepEqual([...x.w.document.querySelectorAll('[data-editor-type]')].map(el => el.textContent), ['Задача', 'Событие']);
});

test('Enter saves a task with its time, kind and sphere; an instant task skips the hidden estimate', async t => {
  const x = useWindow(t, { save_calendar_task: 'new-task' });
  const { showCalendarCreateModal } = await modal();
  await showCalendarCreateModal('2026-09-24', {}); await settle();
  x.q('#evm-title').value = 'Полить цветы';
  x.q('#evm-task-time').value = '08:15';
  x.q('#evm-task-estimate').value = '-3';
  x.q('[name="evm-task-kind"][value="instant"]').click();
  assert.equal(x.shown('#evm-task-estimate'), false, 'an instant task hides its estimate');
  assert.match(x.q('#evm-kind-hint').textContent, /одним нажатием/);
  x.q('#evm-sphere').value = 'home';
  x.key('#evm-title', 'Enter');
  await settle();
  const [saved] = x.saved('save_calendar_task');
  assert.deepEqual({ ...saved }, { id: null, title: 'Полить цветы', dueDate: '2026-09-24', time: '08:15', estimateMinutes: null, goalId: null, expectedVersion: null, important: false, taskKind: 'instant', sphere: 'home', stage: null, waiting: null });
  assert.equal(x.shown('#evm-stage'), false, 'an instant task has no stage');
  assert.equal(x.q('#evm-form'), null, 'saving closes the dialog');

  // A normal task without a day has no time of day; the typed time stays in the field.
  await showCalendarCreateModal('2026-09-24', {}); await settle();
  x.q('#evm-title').value = 'Разобрать почту'; x.q('#evm-task-time').value = '10:00'; x.q('#evm-task-estimate').value = '20';
  x.q('#evm-no-date').click();
  assert.equal(x.q('#evm-task-time').disabled, true);
  x.key('#evm-task-estimate', 'Enter'); await settle();
  const second = x.saved('save_calendar_task')[1];
  assert.deepEqual([second.dueDate, second.time, second.estimateMinutes, second.taskKind, second.sphere, second.stage, second.waiting], [null, '', 20, 'normal', '', '', false]);
});

test('stages keep the owner order and the task dialog edits the stage and «Жду ответа»', async t => {
  assert.deepEqual(TASK_STAGES.map(([id]) => id), ['understanding', 'requirements', 'description', 'agreement', 'decomposition', 'development', 'acceptance']);
  assert.equal(stageLabel('development'), 'В разработке'); assert.equal(stageLabel('review'), ''); assert.equal(stageLabel(''), '');
  let stored = { id: 't2', title: 'Fictional spec', date: '2026-09-24', time: null, task_kind: 'normal', sphere: null, stage: '', waiting: false, duration_minutes: 30, version: 2, priority: 0, status: 'task' };
  const x = useWindow(t, { get_calendar_task: () => stored, save_calendar_task: 't2' });
  const { showEventModal, showCalendarCreateModal } = await modal();
  await showCalendarCreateModal('2026-09-24', {}); await settle();
  assert.ok(x.shown('#evm-stage') && x.shown('#evm-waiting'));
  assert.deepEqual([...x.q('#evm-stage').options].map(option => option.textContent), ['—', ...TASK_STAGES.map(([, label]) => label)]);
  x.q('#evm-title').value = 'Согласовать макет'; x.q('#evm-stage').value = 'agreement'; x.q('#evm-waiting').click();
  x.q('#evm-form').requestSubmit(); await settle();
  let saved = x.saved('save_calendar_task')[0];
  assert.deepEqual([saved.stage, saved.waiting], ['agreement', true]);

  // Editing sends only changed values; an unknown stage from a newer version is kept.
  stored = { ...stored, stage: '', waiting: true };
  await showEventModal(null, null, { kind: 'task', taskId: 't2' }); await settle();
  assert.equal(x.q('#evm-stage').value, ''); assert.equal(x.q('#evm-waiting').checked, true);
  x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[1];
  assert.deepEqual([saved.stage, saved.waiting], [null, null], 'unchanged stage and waiting are kept');
  stored = { ...stored, stage: 'review' };
  await showEventModal(null, null, { kind: 'task', taskId: 't2' }); await settle();
  assert.equal(x.q('#evm-stage').value, '', 'an unknown stage is not offered');
  x.q('#evm-waiting').click(); x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[2];
  assert.deepEqual([saved.stage, saved.waiting], [null, false]);
  await showEventModal(null, null, { kind: 'task', taskId: 't2' }); await settle();
  x.q('#evm-stage').value = 'development'; x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[3];
  assert.deepEqual([saved.stage, saved.waiting], ['development', null]);
  // Switching to an instant task hides the row and sends nothing for it.
  await showEventModal(null, null, { kind: 'task', taskId: 't2' }); await settle();
  x.q('#evm-stage').value = 'acceptance'; x.q('[name="evm-task-kind"][value="instant"]').click();
  assert.equal(x.shown('#evm-stage'), false);
  x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[4];
  assert.deepEqual([saved.taskKind, saved.stage, saved.waiting], ['instant', null, null]);
});

test('editing keeps unknown kind and sphere values and an instant task keeps its stored estimate', async t => {
  let stored = { id: 't1', title: 'Fictional chore', date: '2026-09-24', time: '09:30', task_kind: 'instant', sphere: 'finance', duration_minutes: 25, version: 4, priority: 0, status: 'task' };
  const x = useWindow(t, { get_calendar_task: () => stored, save_calendar_task: 't1' });
  const { showEventModal } = await modal();
  await showEventModal(null, null, { kind: 'task', taskId: 't1' }); await settle();
  assert.equal(x.q('#evm-task-time').value, '09:30');
  assert.equal(x.q('[name="evm-task-kind"]:checked').value, 'instant');
  assert.equal(x.q('#evm-sphere').value, '', 'an unknown sphere is not offered');
  x.q('#evm-form').requestSubmit(); await settle();
  let saved = x.saved('save_calendar_task')[0];
  assert.deepEqual([saved.time, saved.taskKind, saved.sphere, saved.estimateMinutes, saved.expectedVersion], ['09:30', null, null, 25, 4], 'unchanged fields are sent as «keep»');

  await showEventModal(null, null, { kind: 'task', taskId: 't1' }); await settle();
  x.q('[name="evm-task-kind"][value="normal"]').click(); x.q('#evm-sphere').value = 'work';
  assert.ok(x.shown('#evm-task-estimate')); assert.equal(x.q('#evm-task-estimate').value, '25');
  x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[1];
  assert.deepEqual([saved.taskKind, saved.sphere, saved.estimateMinutes], ['normal', 'work', 25]);

  await showEventModal(null, null, { kind: 'task', taskId: 't1' }); await settle();
  x.q('#evm-no-date').click(); x.q('#evm-form').requestSubmit(); await settle();
  saved = x.saved('save_calendar_task')[2];
  assert.deepEqual([saved.dueDate, saved.time], [null, ''], '«Без даты» clears the time of day');
  stored = { ...stored, date: null, time: null };
  await showEventModal(null, null, { kind: 'task', taskId: 't1' }); await settle();
  assert.equal(x.q('#evm-task-time').value, '');
});

test('Event, Goal and Note reuse their existing save commands', async t => {
  const events = [];
  const x = useWindow(t, { create_event: 'event-1', save_calendar_goal: 'goal-1', create_note: 'note-1' });
  for (const name of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:calendar-notes-changed']) x.w.addEventListener(name, () => events.push(name));
  const { showCalendarCreateModal } = await modal();

  await showCalendarCreateModal('2026-09-24', { kind: 'event', initialTime: '14:00' }); await settle();
  x.q('#evm-title').value = 'Созвон с командой';
  x.key('#evm-title', 'Enter'); await settle();
  assert.deepEqual([x.saved('create_event')[0].title, x.saved('create_event')[0].date, x.saved('create_event')[0].time], ['Созвон с командой', '2026-09-24', '14:00']);

  await showCalendarCreateModal('2026-09-24', {}); await settle();
  x.q('[data-editor-type="goal"]').click();
  x.key('#evm-title', 'Enter'); await settle();
  assert.equal(x.q('#evm-error').textContent, 'Напиши, к чему хочешь прийти.'); assert.equal(x.saved('save_calendar_goal').length, 0);
  x.q('#evm-title').value = 'Выучить испанский до B1';
  x.q('#evm-goal-description').value = '  Свободно говорить в поездках  ';
  x.key('#evm-goal-description', 'Enter', { ctrlKey: true }); await settle();
  assert.deepEqual(x.saved('save_calendar_goal'), [{ id: null, title: 'Выучить испанский до B1', targetValue: 1, unit: '', deadline: null, goalKind: 'goal', description: 'Свободно говорить в поездках', criteria: '', parentGoalId: null, clearParent: false, currentValue: null }]);
  assert.equal(x.q('#evm-form'), null);
  assert.equal(x.saved('save_calendar_task').length, 0, 'a goal never creates a task');

  await showCalendarCreateModal('2026-09-24', {}); await settle();
  x.q('[data-editor-type="note"]').click();
  x.key('#evm-title', 'Enter'); await settle();
  assert.equal(x.q('#evm-error').textContent, 'Добавь мысль или название заметки.');
  x.q('#evm-note-text').value = '\nИдея для отпуска\nвторая строка';
  x.key('#evm-note-text', 'Enter'); await settle();
  assert.equal(x.saved('create_note').length, 0, 'plain Enter in the text keeps writing');
  x.key('#evm-note-text', 'Enter', { metaKey: true }); await settle();
  assert.deepEqual(x.saved('create_note'), [{ title: 'Идея для отпуска', content: '\nИдея для отпуска\nвторая строка', tags: '', tabName: 'calendar', status: 'note', dueDate: null, reminderAt: null, priority: null }]);
  assert.equal(x.q('#evm-form'), null);
  assert.ok(events.includes('hanni:calendar-notes-changed') && events.includes('task-state-changed'));
});

test('a failed goal save keeps the dialog and its text for another try', async t => {
  let attempts = 0;
  const x = useWindow(t, { save_calendar_goal: () => { if (++attempts === 1) throw new Error('offline'); return 'goal-2'; } });
  const { showCalendarCreateModal } = await modal();
  await showCalendarCreateModal('2026-09-24', {}); await settle();
  x.q('#evm-title').value = 'Пробежать полумарафон'; x.q('[data-editor-type="goal"]').click();
  x.q('#evm-form').requestSubmit(); await settle();
  assert.match(x.q('#evm-error').textContent, /Не удалось сохранить: offline/);
  assert.equal(x.q('#evm-title').value, 'Пробежать полумарафон');
  assert.equal(x.q('#evm-save').disabled, false);
  x.q('#evm-form').requestSubmit(); await settle();
  assert.equal(attempts, 2); assert.equal(x.q('#evm-form'), null);
});

function mountTasksPane(t, rows) {
  const dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid', pretendToBeVisual: true }), host = dom.window.document.querySelector('main');
  const actions = [];
  const dispose = mountCalendarTasks(host, { state: { filter: 'active', search: '', goal: '', sphere: '', page: 0 },
    invoke: async command => command === 'get_calendar_tasks' ? rows : [],
    openTask() {}, editDate() {}, notifyChange() {}, executeAction: async (row, action) => { actions.push([row.source_id, action]); } });
  t.after(() => { dispose(); dom.window.close(); });
  const item = id => host.querySelector(`[data-context-record="note:${id}"]`);
  const titles = () => [...host.querySelectorAll('[data-task-control="open"]')].map(el => el.textContent);
  const filter = value => host.querySelector(`[data-tasks-sphere="${value}"]`).click();
  return { host, item, titles, filter, actions };
}
const note = (id, date, extra = {}) => ({ source_type: 'note', source_id: id, title: id, date, status_extra: 'task', ...extra });

test('Tasks pane shows time, instant kind and sphere, sorts timed tasks and switches between Work, Home and Other', async t => {
  const today = localDay();
  const x = mountTasksPane(t, [
    note('Late call', today, { planned_time: '18:00' }),
    note('Untimed', today, { duration_minutes: 30 }),
    note('Morning run', today, { planned_time: '08:30', sphere: 'health' }),
    note('Water plants', today, { task_kind: 'instant', sphere: 'home', duration_minutes: 10 }),
    note('Stale undated', null, { planned_time: '07:00' }),
  ]);
  await settle();
  assert.deepEqual(x.titles(), ['Morning run', 'Late call', 'Untimed', 'Water plants', 'Stale undated'], 'within a day timed tasks come first, by time');
  const date = id => x.item(id).querySelector('[data-task-control="date"]');
  assert.equal(date('Morning run').textContent, '08:30', 'the Today group keeps the time without repeating «Сегодня»');
  assert.match(date('Morning run').title, /08:30/);
  assert.equal(date('Untimed'), null);
  assert.equal(date('Stale undated'), null, 'an undated task prints no «Без даты»');
  assert.equal(x.item('Morning run').querySelector('.ct-sphere').textContent, 'Здоровье');
  assert.equal(x.item('Untimed').querySelector('.ct-sphere'), null);
  const instant = x.item('Water plants');
  assert.equal(instant.querySelector('.ct-kind').textContent, 'Моментальная');
  assert.equal(instant.querySelector('.ct-sphere').textContent, 'Дом');
  assert.equal(instant.querySelector('[data-task-control="execute"]'), null, 'no Start for an instant task');
  assert.equal(instant.querySelector('.ct-estimate'), null, 'no estimate for an instant task');
  assert.ok(x.item('Untimed').querySelector('[data-task-control="execute"]'));
  assert.equal(x.item('Untimed').querySelector('.ct-kind'), null);

  x.filter('home'); assert.deepEqual(x.titles(), ['Water plants']);
  assert.equal(x.item('Water plants').querySelector('.ct-sphere'), null, 'the chosen sphere is not repeated in rows');
  x.filter('other'); assert.deepEqual(x.titles(), ['Morning run', 'Late call', 'Untimed', 'Stale undated'], 'Other holds health, growth, personal and no sphere');
  x.filter('work'); assert.deepEqual(x.titles(), []);
  assert.match(x.host.querySelector('.ct-empty').textContent, /сферу/);
  x.filter('');
  assert.equal(x.titles().length, 5);
  x.item('Water plants').querySelector('[data-task-control="finish"]').click(); await settle();
  assert.deepEqual(x.actions, [['Water plants', 'finish']], 'one tap completes an instant task');
});

test('a running instant task still offers Pause in the Tasks pane', async t => {
  const x = mountTasksPane(t, [note('Started before', localDay(), { task_kind: 'instant', is_active: true, has_work: true })]);
  await settle();
  assert.equal(x.item('Started before').querySelector('[data-task-control="execute"]').title, 'Пауза');
});

test('Today on the dashboard shows the time and sphere and completes an instant task in one tap', async t => {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const rows = [
    note('Normal', '2026-09-12', { title: 'Отчёт', planned_time: '09:00', duration_minutes: 30 }),
    note('Instant', '2026-09-12', { title: 'Вынести мусор', planned_time: '07:30', task_kind: 'instant', sphere: 'home', duration_minutes: 30 }),
  ];
  const actions = [];
  const dispose = mountCalendarDashboardTasks(host, { invoke: async () => rows, now: () => new Date('2026-09-12T12:00:00'), notifyChange() {},
    executeAction: async (row, action) => { actions.push([row.source_id, action]); } });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const today = host.querySelector('[data-overview-today]');
  assert.deepEqual([...today.querySelectorAll('.cto-task-title')].map(el => el.textContent), ['Вынести мусор', 'Отчёт']);
  const [instant, normal] = today.querySelectorAll('li');
  assert.equal(instant.querySelector('.cto-task-meta').textContent, '07:30 · Дом', 'an instant task shows no estimate');
  assert.equal(normal.querySelector('.cto-task-meta').textContent, '09:00 · 30 мин');
  const run = instant.querySelector('[data-overview-execute]');
  assert.equal(run.textContent, 'Готово'); assert.equal(run.getAttribute('aria-label'), 'Отметить выполненной: Вынести мусор');
  assert.equal(normal.querySelector('[data-overview-execute]').textContent, 'Начать');
  run.click(); await settle();
  assert.deepEqual(actions, [['Instant', 'finish']]);
  assert.match(host.textContent, /Задача выполнена\./);
});

test('the calendar grid places a timed task at its time and offers one-tap Done for an instant task', t => {
  const dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid' }); t.after(() => dom.window.close());
  globalThis.document = dom.window.document;
  const host = dom.window.document.querySelector('main');
  const record = (id, time, extra = {}) => ({ id: `note:${id}:2026-09-24`, source_type: 'note', source_id: id, title: id, date: '2026-09-24', time, status_extra: 'task', ...extra });
  const records = [record('timed', '09:30', { durationMinutes: 45 }), record('instant', '12:00', { task_kind: 'instant' }), record('brief', '15:00', { durationMinutes: 15 }), record('untimed', null)];
  CalendarViews.render(host, { period: 'day', mode: 'grid', date: '2026-09-24', today: '2026-09-24', onTaskAction() {}, records });
  const timed = host.querySelector('.calv-day-column [data-record-source="note:timed"]');
  assert.ok(timed, 'a timed task sits in the hour grid');
  assert.match(timed.querySelector('.calv-record-time').textContent, /09:30–10:15/);
  assert.equal(host.querySelector('.calv-day-column [data-record-source="note:untimed"]'), null);
  const actions = id => [...host.querySelector(`.calv-day-column [data-record-source="note:${id}"]`).querySelectorAll('[data-record-action]')].map(el => `${el.dataset.recordAction}:${el.textContent}`);
  assert.deepEqual(actions('instant'), ['finish:Готово']);
  assert.deepEqual(actions('timed'), ['start:Начать']);
  assert.deepEqual(actions('brief'), [], 'a 15-minute block keeps its title instead of clipped controls');
  assert.equal(host.querySelector('[data-record-source="note:brief"]').classList.contains('calv-record-shell--actions'), false);
  CalendarViews.render(host, { period: 'week', mode: 'grid', date: '2026-09-24', today: '2026-09-24', onTaskAction() {}, records });
  assert.deepEqual(actions('timed'), [], 'narrow Week columns show time and title only');
});
