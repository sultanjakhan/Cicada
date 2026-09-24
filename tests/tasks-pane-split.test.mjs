// Tasks pane, 2026-09-24: Work/Home switch, «В работе» group, overdue cleanup,
// fewer repeated labels, stage menu, grouping by goal and quick add.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountCalendarTasks } from '../src/hanni/js/calendar-tasks.js';
import { TASK_STAGES } from '../src/hanni/js/task-model.js';

const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const day = (delta = 0) => { const d = new Date(); d.setDate(d.getDate() + delta); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const note = (id, date, extra = {}) => ({ source_type: 'note', source_id: id, title: id, date, status_extra: 'task', ...extra });

async function mount(t, rows, { goals = [], links = [], state = {}, handlers = {} } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const host = dom.window.document.querySelector('main'), calls = [];
  const paneState = { filter: 'active', search: '', goal: '', sphere: '', page: 0, ...state };
  let changes = 0;
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (handlers[command]) return handlers[command](args);
    if (command === 'get_calendar_tasks') return rows;
    if (command === 'get_goals') return goals;
    if (command === 'get_calendar_task_goals') return links;
    throw new Error(`unexpected ${command}`);
  };
  const dependencies = { state: paneState, invoke, openTask() {}, editDate() {}, notifyChange() { changes++; }, executeAction: async () => {} };
  const dispose = mountCalendarTasks(host, dependencies);
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  const doc = dom.window.document;
  return {
    dom, doc, host, state: paneState, dependencies, dispose,
    $: selector => host.querySelector(selector),
    titles: () => [...host.querySelectorAll('[data-task-control="open"]')].map(el => el.textContent),
    groups: () => [...host.querySelectorAll('[data-tasks-group]')].map(el => [el.dataset.tasksGroup, el.querySelector('.ct-group-label').textContent, el.querySelector('.ct-group-count').textContent]),
    item: id => host.querySelector(`[data-context-record="note:${id}"]`),
    counts: () => Object.fromEntries([...host.querySelectorAll('[data-tasks-sphere]')].map(el => [el.dataset.tasksSphere, el.querySelector('[data-tasks-sphere-count]').textContent])),
    sphere: id => host.querySelector(`[data-tasks-sphere="${id}"]`).click(),
    filter: id => host.querySelector(`[data-tasks-filter="${id}"]`).click(),
    commands: name => calls.filter(([command]) => command === name).map(([, args]) => args),
    get changes() { return changes; },
    key: (el, key) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  };
}

test('the Work/Home switch counts active tasks, filters rows and is remembered for the session', async t => {
  const rows = [
    note('W1', day(), { sphere: 'work' }), note('W2', null, { sphere: 'work' }), note('W3', day(), { sphere: 'work', completed: true }),
    note('H1', day(), { sphere: 'home' }), note('H2', day(-1), { sphere: 'home' }),
    note('O1', null, { sphere: 'health' }), note('O2', day()), note('O3', day(2), { sphere: 'personal' }),
  ];
  const x = await mount(t, rows);
  assert.deepEqual([...x.host.querySelectorAll('[data-tasks-sphere]')].map(el => el.firstElementChild.textContent), ['Все', 'Работа', 'Дом', 'Другое']);
  assert.equal(x.$('select[data-tasks-sphere]'), null, 'the sphere select is replaced by the switch');
  assert.deepEqual(x.counts(), { '': '7', work: '2', home: '2', other: '3' });
  assert.equal(x.$('[data-tasks-sphere=""]').getAttribute('aria-pressed'), 'true');
  assert.equal(x.item('H1').querySelector('.ct-sphere').textContent, 'Дом', '«Все» keeps the sphere label');

  assert.equal(x.$('[data-tasks-sphere="work"]').getAttribute('aria-label'), 'Работа: 2');
  x.sphere('work');
  assert.deepEqual(x.titles(), ['W1', 'W2']);
  assert.equal(x.state.sphere, 'work');
  assert.equal(x.$('[data-tasks-sphere="work"]').getAttribute('aria-pressed'), 'true');
  assert.equal(x.host.querySelectorAll('.ct-sphere').length, 0, 'a chosen sphere is not repeated in each row');
  assert.equal(x.$('[data-tasks-count]').textContent, '2');

  x.sphere('home'); assert.deepEqual(x.titles(), ['H2', 'H1']);
  x.sphere('other');
  assert.deepEqual(x.titles(), ['O2', 'O3', 'O1'], 'Other holds health, growth, personal and tasks without a sphere');
  assert.equal(x.item('O1').querySelector('.ct-sphere').textContent, 'Здоровье', 'Other mixes spheres, so rows name theirs');
  assert.equal(x.item('O2').querySelector('.ct-sphere'), null);

  x.filter('today');
  assert.deepEqual(x.counts(), { '': '3', work: '1', home: '1', other: '1' }, 'counts follow the day filter');
  assert.deepEqual(x.titles(), ['O2']);
  x.filter('active');
  x.$('[data-tasks-search]').value = 'w'; x.$('[data-tasks-search]').dispatchEvent(new x.dom.window.Event('input'));
  assert.deepEqual(x.counts(), { '': '2', work: '2', home: '0', other: '0' });
  assert.match(x.$('.ct-empty').textContent, /сферу/);

  x.dispose();
  const again = mountCalendarTasks(x.host, x.dependencies); await settle();
  assert.equal(x.$('[data-tasks-sphere="other"]').getAttribute('aria-pressed'), 'true', 'the choice survives a remount');
  again();
  for (const [legacy, expected] of [['health', 'other'], ['none', 'other'], ['work', 'work'], ['bogus', '']]) {
    const state = { filter: 'active', search: '', goal: '', sphere: legacy, page: 0 };
    const stop = mountCalendarTasks(x.host, { ...x.dependencies, state }); await settle();
    assert.equal(state.sphere, expected, `a session value «${legacy}» maps to «${expected}»`);
    stop();
  }
});

test('running tasks form «В работе» on top; paused tasks stay in their day with a small mark', async t => {
  const x = await mount(t, [
    note('Run today', day(), { is_active: true, has_work: true, sphere: 'work' }),
    note('Run late', day(-2), { is_active: true, has_work: true }),
    note('Run free', null, { is_active: true, has_work: true }),
    note('Paused', day(), { has_work: true, actual_minutes: 25 }),
    note('Plain', day()),
    note('Old', day(-3)),
  ]);
  assert.deepEqual(x.groups(), [['running', 'В работе', '3'], ['overdue', 'Просрочено', '1'], ['today', 'Сегодня', '2']]);
  assert.deepEqual(x.titles(), ['Run late', 'Run today', 'Run free', 'Old', 'Paused', 'Plain'], 'running tasks leave their day groups');
  for (const id of ['Run today', 'Run late', 'Run free']) {
    assert.equal(x.item(id).classList.contains('is-running'), true);
    assert.doesNotMatch(x.item(id).querySelector('.ct-meta').textContent, /В работе/, 'the running accent replaces the text');
    assert.equal(x.item(id).querySelector('.ct-visually-hidden').textContent, 'В работе', 'assistive tech still hears it');
  }
  assert.equal(x.item('Run today').querySelector('[data-task-control="date"]'), null, 'today is implied for running work');
  assert.equal(x.item('Run late').querySelector('[data-task-control="date"]').classList.contains('is-overdue'), true, 'an overdue running task keeps its red date');
  assert.equal(x.item('Paused').querySelector('.ct-status').textContent, 'пауза');
  assert.equal(x.item('Plain').querySelector('.ct-status'), null);
  assert.equal(x.item('Run today').querySelector('.ct-status'), null);
  x.$('[data-tasks-group-by="goal"]').click();
  assert.equal(x.groups()[0][0], 'running', '«В работе» stays on top when grouped by goal');
  x.filter('today');
  assert.deepEqual(x.titles(), ['Run today', 'Paused', 'Plain']);
});

function overdueStore(rows) {
  const records = new Map(rows.map(row => [row.source_id, { id: row.source_id, title: row.title, date: row.date, due_date: row.date, time: row.planned_time || null, duration_minutes: row.duration_minutes ?? null, version: 3, status: 'task', completed: false, archived: false, goal_id: row.goal_id ?? null }]));
  return {
    records,
    get_calendar_task: ({ id }) => ({ ...records.get(id) }),
    save_calendar_task: args => {
      const record = records.get(args.id), row = rows.find(item => item.source_id === args.id);
      if (args.expectedVersion !== record.version) throw 'task changed elsewhere or was deleted';
      Object.assign(record, { date: args.dueDate, due_date: args.dueDate, version: record.version + 1 });
      row.date = args.dueDate; if (!args.dueDate) row.planned_time = null;
      return args.id;
    },
  };
}

test('overdue cleanup asks once, moves every overdue task to today through the task save and reports the result', async t => {
  const rows = [
    note('Report', day(-2), { planned_time: '09:00', duration_minutes: 30, goal_id: 'g1', sphere: 'work' }),
    note('Call', day(-1)),
    note('Today', day()),
    note('Running late', day(-4), { is_active: true, has_work: true }),
  ];
  const store = overdueStore(rows);
  const x = await mount(t, rows, { goals: [{ id: 'g1', title: 'Карьера' }], links: [{ source_type: 'note', source_id: 'Report', goal_id: 'g1' }], handlers: store });
  const header = () => x.$('[data-tasks-group="overdue"]');
  assert.deepEqual([...header().querySelectorAll('[data-tasks-bulk]')].map(el => el.textContent), ['Перенести на сегодня', 'Убрать дату']);
  assert.equal(x.$('[data-tasks-group="today"] [data-tasks-bulk]'), null, 'only the overdue group gets bulk actions');

  header().querySelector('[data-tasks-bulk="today"]').click();
  assert.equal(header().querySelector('.ct-confirm-text').textContent, 'Перенести 2 задачи?');
  assert.equal(x.doc.activeElement.dataset.tasksBulk, 'confirm');
  header().querySelector('[data-tasks-bulk="cancel"]').click();
  assert.equal(header().querySelector('.ct-confirm-text'), null);
  assert.equal(x.doc.activeElement.dataset.tasksBulk, 'today', 'cancel returns focus to the action');
  header().querySelector('[data-tasks-bulk="today"]').click();
  x.key(header().querySelector('[data-tasks-bulk="confirm"]'), 'Escape');
  assert.equal(header().querySelector('.ct-confirm-text'), null, 'Escape cancels the inline confirm');
  assert.deepEqual(x.commands('save_calendar_task'), []);

  header().querySelector('[data-tasks-bulk="today"]').click();
  header().querySelector('[data-tasks-bulk="confirm"]').click();
  await settle(8);
  assert.deepEqual(x.commands('get_calendar_task').map(args => args.id), ['Report', 'Call'], 'the running overdue task is not in the group');
  assert.deepEqual(x.commands('save_calendar_task'), [
    { id: 'Report', title: 'Report', dueDate: day(), estimateMinutes: 30, goalId: 'g1', expectedVersion: 3 },
    { id: 'Call', title: 'Call', dueDate: day(), estimateMinutes: null, goalId: null, expectedVersion: 3 },
  ], 'the stored estimate and goal are kept; the time is omitted so the native save keeps it');
  assert.equal(x.$('[data-tasks-message]').textContent, 'Перенесено на сегодня: 2.');
  assert.equal(x.$('[data-tasks-group="overdue"]'), null);
  assert.deepEqual(x.groups().map(([id, , count]) => [id, count]), [['running', '1'], ['today', '3']]);
  assert.ok(x.changes >= 1, 'other surfaces are told about the change');
});

test('«Убрать дату» clears the day of the whole overdue group', async t => {
  const rows = [note('A', day(-1), { planned_time: '10:00' }), note('B', day(-3)), note('C', day(-9)), note('D', day(-2)), note('E', day(-5))];
  const x = await mount(t, rows, { handlers: overdueStore(rows) });
  x.$('[data-tasks-bulk="clear"]').click();
  assert.equal(x.$('.ct-confirm-text').textContent, 'Убрать дату у 5 задач?');
  x.$('[data-tasks-bulk="confirm"]').click(); await settle(12);
  assert.deepEqual(x.commands('save_calendar_task').map(args => [args.id, args.dueDate]), [['C', null], ['E', null], ['B', null], ['D', null], ['A', null]]);
  assert.equal(x.$('[data-tasks-message]').textContent, 'Дата убрана у 5 задач.');
  assert.deepEqual(x.groups(), [['undated', 'Без даты', '5']]);
});

test('a partial overdue move names what failed and keeps it in the group', async t => {
  const rows = [note('Alpha', day(-1)), note('Beta', day(-2)), note('Gamma', day(-3))];
  const store = overdueStore(rows);
  store.records.get('Beta').version = 7; // changed on another device since the list loaded
  store.get_calendar_task = ({ id }) => ({ ...store.records.get(id), ...(id === 'Beta' ? { version: 6 } : {}) });
  const gamma = store.records.get('Gamma');
  const x = await mount(t, rows, { handlers: { ...store, get_calendar_task: args => args.id === 'Gamma' ? { ...gamma, date: day(-10), due_date: day(-10) } : store.get_calendar_task(args) } });
  x.$('[data-tasks-bulk="today"]').click();
  assert.equal(x.$('.ct-confirm-text').textContent, 'Перенести 3 задачи?');
  x.$('[data-tasks-bulk="confirm"]').click(); await settle(10);
  const notice = x.$('[data-tasks-message]');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.match(notice.textContent, /^Перенесено на сегодня: 1 из 3\. Не удалось перенести: «Gamma», «Beta»\. Задачи могли измениться/);
  assert.deepEqual(x.commands('save_calendar_task').map(args => args.id), ['Beta', 'Alpha'], 'a task whose date changed elsewhere is not saved');
  assert.deepEqual(x.groups().map(([id, , count]) => [id, count]), [['overdue', '2'], ['today', '1']]);
  assert.equal(x.doc.activeElement.dataset.tasksBulk, 'today', 'focus returns to the remaining action');
  rows.splice(rows.findIndex(row => row.source_id === 'Beta'), 1);
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle();
  x.$('[data-tasks-bulk="today"]').click();
  assert.equal(x.$('.ct-confirm-text').textContent, 'Перенести 1 задачу?');
});

test('when every overdue save fails the message says so without a success count', async t => {
  const rows = [note('Only', day(-1))];
  const x = await mount(t, rows, { handlers: { get_calendar_task: () => { throw 'offline'; } } });
  x.$('[data-tasks-bulk="clear"]').click(); x.$('[data-tasks-bulk="confirm"]').click(); await settle(8);
  assert.match(x.$('[data-tasks-message]').textContent, /^Не удалось убрать дату: «Only»\. Задача могла измениться/);
  assert.equal(x.item('Only').querySelector('[data-task-control="date"]').textContent, 'Вчера');
});

test('rows do not repeat what their group or filter already says', async t => {
  const x = await mount(t, [
    note('Timed', day(), { planned_time: '14:00' }), note('Untimed', day()), note('Free', null),
    note('Tomorrow', day(1)), note('Late', day(-1), { planned_time: '08:00' }),
  ], { goals: [{ id: 'g', title: 'Дом в порядке' }], links: [{ source_type: 'note', source_id: 'Untimed', goal_id: 'g' }] });
  const date = id => x.item(id).querySelector('[data-task-control="date"]');
  assert.equal(date('Timed').textContent, '14:00');
  assert.equal(date('Untimed'), null);
  assert.equal(date('Free'), null);
  assert.doesNotMatch(x.item('Free').textContent, /Без даты/);
  assert.equal(x.item('Free').querySelector('.ct-meta').textContent, '');
  assert.equal(date('Tomorrow').textContent, 'Завтра');
  assert.equal(date('Late').textContent, 'Вчера, 08:00');
  x.filter('today');
  assert.equal(date('Timed').textContent, '14:00'); assert.equal(date('Untimed'), null);
  x.filter('undated'); assert.doesNotMatch(x.item('Free').textContent, /Без даты/);
  x.filter('active'); x.$('[data-tasks-group-by="goal"]').click();
  assert.equal(date('Untimed').textContent, 'Сегодня', 'a goal group mixes days, so the day is shown');
  x.$('[data-tasks-group-by="date"]').click();
  x.$('[data-tasks-goal]').value = 'g'; x.$('[data-tasks-goal]').dispatchEvent(new x.dom.window.Event('change'));
  assert.equal(x.item('Untimed').querySelector('.ct-goal'), null, 'the chosen goal is not repeated');
});

test('the stage in the row opens a menu that calls set_calendar_task_stage and refreshes the row', async t => {
  const rows = [
    note('Spec', day(), { sphere: 'work', stage: 'description', waiting: true }),
    note('Fresh', null, { sphere: 'work', stage: '' }),
    note('Home with stage', null, { sphere: 'home', stage: 'agreement' }),
    note('Home plain', null, { sphere: 'home' }),
    note('Instant', null, { sphere: 'work', task_kind: 'instant', stage: 'development' }),
    note('Closed', day(-1), { sphere: 'work', stage: 'acceptance', completed: true }),
  ];
  let fail = false;
  const x = await mount(t, rows, { handlers: { set_calendar_task_stage: ({ id, stage, waiting }) => {
    if (fail) throw 'offline';
    const row = rows.find(item => item.source_id === id); Object.assign(row, { stage, waiting }); return { ...row };
  } } });
  const chip = id => x.item(id)?.querySelector('[data-task-control="stage"]') ?? null;
  const menu = () => x.doc.querySelector('[data-tasks-stage-menu]');
  assert.equal(chip('Spec').querySelector('.ct-stage-label').textContent, 'Описание');
  assert.equal(chip('Spec').querySelector('.ct-waiting').textContent, 'жду ответа');
  assert.equal(chip('Fresh').textContent, 'Стадия'); assert.equal(chip('Fresh').classList.contains('is-empty'), true);
  assert.equal(chip('Home with stage').textContent, 'Согласование', 'a set stage shows on any task');
  assert.equal(chip('Home plain'), null, 'no stage placeholder outside work');
  assert.equal(chip('Instant'), null, 'instant tasks have no stage');

  chip('Fresh').click();
  assert.ok(menu()); assert.equal(chip('Fresh').getAttribute('aria-expanded'), 'true');
  const options = () => [...menu().querySelectorAll('[role^="menuitem"]')];
  assert.deepEqual(options().map(el => el.textContent), [...TASK_STAGES.map(([, label]) => label), 'Без стадии', 'Жду ответа']);
  assert.deepEqual(options().filter(el => el.getAttribute('aria-checked') === 'true').map(el => el.textContent), ['Без стадии']);
  assert.equal(x.doc.activeElement.textContent, 'Без стадии', 'focus starts on the current stage');
  x.key(x.doc.activeElement, 'ArrowDown'); assert.equal(x.doc.activeElement.textContent, 'Жду ответа');
  menu().querySelector('[data-stage="requirements"]').click(); await settle();
  assert.deepEqual(x.commands('set_calendar_task_stage'), [{ id: 'Fresh', stage: 'requirements', waiting: false }]);
  assert.equal(menu(), null);
  assert.equal(chip('Fresh').textContent, 'Требования');
  assert.equal(x.doc.activeElement, chip('Fresh'), 'focus returns to the stage in the row');
  assert.ok(x.changes >= 1);

  chip('Spec').click();
  assert.equal(menu().querySelector('[data-stage-waiting]').getAttribute('aria-checked'), 'true');
  menu().querySelector('[data-stage-waiting]').click(); await settle();
  assert.deepEqual(x.commands('set_calendar_task_stage').at(-1), { id: 'Spec', stage: 'description', waiting: false });
  assert.equal(chip('Spec').querySelector('.ct-waiting'), null);

  chip('Home with stage').click();
  menu().querySelector('[data-stage=""]').click(); await settle();
  assert.deepEqual(x.commands('set_calendar_task_stage').at(-1), { id: 'Home with stage', stage: '', waiting: false });
  assert.equal(chip('Home with stage'), null, 'a home task without a stage returns to a plain row');

  fail = true; chip('Spec').click();
  menu().querySelector('[data-stage="agreement"]').click(); await settle();
  assert.ok(menu(), 'a failure keeps the menu open');
  assert.equal(menu().querySelector('[role=alert]').textContent, 'Не удалось изменить стадию. Повтори.');
  assert.equal(chip('Spec').textContent, 'Описание');
  x.key(x.doc.activeElement, 'Escape');
  assert.equal(menu(), null); assert.equal(x.doc.activeElement, chip('Spec'));

  x.filter('completed');
  assert.equal(chip('Closed'), null, 'closed tasks show no stage control');
  x.filter('active');
  rows.push(note('Future', null, { sphere: 'work', stage: 'review-v2', waiting: false }));
  x.dom.window.dispatchEvent(new x.dom.window.Event('task-state-changed')); await settle();
  assert.equal(chip('Future').textContent, 'Стадия', 'an unknown stage is not shown');
  fail = false; chip('Future').click();
  menu().querySelector('[data-stage-waiting]').click(); await settle();
  assert.deepEqual(x.commands('set_calendar_task_stage').at(-1), { id: 'Future', stage: 'review-v2', waiting: true }, 'toggling «Жду ответа» keeps a stage this version does not know');
});

test('«По цели» groups active tasks under their top-level goal, «Без цели» last, «В работе» first', async t => {
  const goals = [{ id: 'g1', title: 'Карьера' }, { id: 'g1a', title: 'SQL', parent_goal_id: 'g1' }, { id: 'g2', title: 'Бег' }, { id: 'g3', title: 'Английский' }];
  const links = [['T1', 'g1a'], ['T2', 'g1'], ['T3', 'g2'], ['T5', 'g2'], ['T6', 'g1a']].map(([source_id, goal_id]) => ({ source_type: 'note', source_id, goal_id }));
  const x = await mount(t, [
    note('T1', day(-1)), note('T2', day()), note('T3', null), note('T4', day()), note('T5', day(), { is_active: true, has_work: true }), note('T6', day(3)), note('T7', null, { completed: true }),
  ], { goals, links });
  assert.equal(x.$('[data-tasks-group-by="date"]').getAttribute('aria-pressed'), 'true');
  assert.equal(x.item('T2').querySelector('.ct-goal').textContent, 'Карьера');
  x.$('[data-tasks-group-by="goal"]').click();
  assert.equal(x.state.groupBy, 'goal');
  assert.deepEqual(x.groups(), [['running', 'В работе', '1'], ['goal:g2', 'Бег', '1'], ['goal:g1', 'Карьера', '3'], ['no-goal', 'Без цели', '1']]);
  assert.deepEqual(x.titles(), ['T5', 'T3', 'T1', 'T2', 'T6', 'T4'], 'inside a goal tasks keep the day urgency');
  assert.equal(x.item('T1').querySelector('.ct-goal').textContent, 'SQL', 'the row names the sub-goal below the group');
  assert.equal(x.item('T1').querySelector('.ct-goal').title, 'Карьера / SQL');
  assert.equal(x.item('T2').querySelector('.ct-goal'), null, 'the group already names a top-level goal');
  assert.equal(x.$('[data-tasks-bulk]'), null, 'overdue actions belong to the date grouping');
  assert.equal(x.item('T5').querySelector('.ct-goal').textContent, 'Бег', 'a running row outside the goal groups still names its goal');
  x.filter('today');
  assert.deepEqual(x.groups().map(([id]) => id), ['running', 'goal:g1', 'no-goal'], 'the day filters group by goal too');
  x.filter('completed');
  assert.equal(x.$('[data-tasks-grouping]').hidden, true);
  assert.deepEqual(x.groups(), []);
  assert.deepEqual(x.titles(), ['T7']);
  x.filter('active');
  x.dispose();
  const again = mountCalendarTasks(x.host, x.dependencies); await settle();
  assert.equal(x.$('[data-tasks-group-by="goal"]').getAttribute('aria-pressed'), 'true', 'the grouping survives a remount');
  again();
});

test('quick add creates a title-only task in the chosen sphere and plans it for today only in «Сегодня»', async t => {
  const rows = [note('Existing', day())];
  let fail = null, next = 1;
  const x = await mount(t, rows, { handlers: { save_calendar_task: args => {
    if (fail) throw fail;
    const id = `new-${next++}`; rows.push(note(id, args.dueDate, { title: args.title, sphere: args.sphere || null })); return id;
  } } });
  const input = x.$('[data-tasks-add]'), status = x.$('[data-tasks-add-status]');
  const enter = async value => { input.value = value; x.key(input, 'Enter'); await settle(); };
  assert.equal(input.placeholder, 'Добавить задачу…');
  await enter('Купить хлеб');
  assert.deepEqual(x.commands('save_calendar_task').at(-1), { id: null, title: 'Купить хлеб', dueDate: null, time: '', estimateMinutes: null, goalId: null, expectedVersion: null, important: false, taskKind: 'normal', sphere: '' });
  assert.equal(input.value, '');
  assert.equal(status.textContent, 'Задача добавлена в «Без даты».');
  assert.ok(x.titles().includes('Купить хлеб'));
  assert.ok(x.changes >= 1);

  x.sphere('work'); x.filter('today');
  await enter('  Созвон по API  ');
  assert.deepEqual(x.commands('save_calendar_task').at(-1), { id: null, title: 'Созвон по API', dueDate: day(), time: '', estimateMinutes: null, goalId: null, expectedVersion: null, important: false, taskKind: 'normal', sphere: 'work' });
  assert.equal(status.textContent, 'Задача добавлена.');
  assert.deepEqual(x.titles(), ['Созвон по API']);
  x.sphere('home'); x.filter('undated'); await enter('Полить цветы');
  assert.deepEqual([x.commands('save_calendar_task').at(-1).sphere, x.commands('save_calendar_task').at(-1).dueDate], ['home', null]);
  x.sphere('other'); await enter('Прогулка');
  assert.equal(x.commands('save_calendar_task').at(-1).sphere, '', '«Другое» adds without a sphere');

  const saved = x.commands('save_calendar_task').length;
  await enter('   ');
  assert.equal(x.commands('save_calendar_task').length, saved, 'an empty line creates nothing');
  input.value = 'Черновик'; x.key(input, 'Escape');
  assert.equal(input.value, '', 'Esc clears the line');
  await enter('x'.repeat(501));
  assert.equal(x.commands('save_calendar_task').length, saved);
  assert.match(status.textContent, /500/); assert.equal(status.getAttribute('role'), 'alert');

  fail = 'offline';
  await enter('Не сохранится');
  assert.equal(status.getAttribute('role'), 'alert');
  assert.match(status.textContent, /^Не удалось добавить задачу: offline\./);
  assert.equal(input.value, 'Не сохранится', 'the typed text stays');
  assert.equal(input.readOnly, false);
  fail = null;

  x.sphere(''); x.filter('active');
  x.$('[data-tasks-search]').value = 'zzz'; x.$('[data-tasks-search]').dispatchEvent(new x.dom.window.Event('input'));
  await enter('Скрытая');
  assert.equal(status.textContent, 'Задача добавлена, но скрыта поиском или фильтром цели.');
  x.filter('completed');
  assert.equal(x.$('[data-tasks-add-form]').hidden, true, 'no quick add among completed tasks');
});

test('phone layout keeps the switches scrollable and the tap targets at least 36px', () => {
  const css = fs.readFileSync(new URL('../src/hanni/css/calendar-tasks.css', import.meta.url), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(css, /\.ct-spheres \{[^}]*overflow-x: auto/);
  for (const selector of ['.ct-filters button', '.ct-spheres button', '.ct-group-action', '.ct-icon-button']) {
    const rule = phone.match(new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] || '';
    assert.match(rule, /height: (3[6-9]|4\d)px/, `${selector} is at least 36px tall on the phone`);
  }
  assert.match(phone, /\.ct-add input \{[^}]*height: 48px/);
  assert.match(phone, /\.ct-grouping button \{[^}]*height: 36px/);
});
