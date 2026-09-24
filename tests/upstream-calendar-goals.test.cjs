'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const read = name => fs.readFileSync(path.resolve(__dirname, '../src/hanni/js', name + '.js'), 'utf8');
// data: modules cannot resolve relative imports, so each local dependency is
// inlined the same way (identical URLs keep one shared module instance).
const stubs = {
  'state': 'export const invoke = () => { throw new Error("Inject API"); };',
  'utils': 'export const escapeHtml = value => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");',
};
const urls = new Map();
const moduleUrl = name => {
  if (!urls.has(name)) urls.set(name, data(stubs[name] ?? read(name).replace(/from '\.\/([\w-]+)\.js'/g, (_, dep) => `from ${JSON.stringify(moduleUrl(dep))}`)));
  return urls.get(name);
};
const modulePromise = import(moduleUrl('calendar-goals'));
const tick = async () => { for (let i = 0; i < 7; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(t, { dependencies = {}, ui: initialUi = {} } = {}) {
  const dom = new JSDOM('<main></main><button id="outside">Вне</button>', { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button')?.focus(); };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const goals = [], links = [], calls = [], before = new Map(); let selected = 0, created = null, active = null;
  const ui = new Map(Object.entries({ calendar_now_v1: JSON.stringify({ version: 1, goalId: null }), ...initialUi }));
  const api = async (name, args) => {
    calls.push({ name, args: structuredClone(args) }); if (before.has(name)) await before.get(name)(args);
    if (name === 'get_goals') return structuredClone(goals);
    if (name === 'get_calendar_task_goals') return structuredClone(links);
    if (name === 'get_ui_state') return ui.get(args.key) ?? null;
    if (name === 'set_ui_state') { if (args.expectedValue != null && (ui.get(args.key) ?? '') !== args.expectedValue) throw new Error('mvp_sync_stale_ui_state'); ui.set(args.key, args.value); return; }
    if (name === 'get_active_block') return active;
    if (name === 'save_calendar_goal') { const id = goals.length + 1; const values = { id: args.id || id, title: args.title, deadline: args.deadline, goal_kind: args.goalKind, description: args.description, criteria: args.criteria, target_value: args.targetValue, unit: args.unit, parent_goal_id: args.clearParent ? null : args.parentGoalId, current_value: args.currentValue };
      if (args.id) Object.assign(goals.find(goal => goal.id === args.id), values); else goals.push(values); return id; }
    if (name === 'delete_goal') { goals.splice(goals.findIndex(goal => goal.id === args.id), 1); return; }
    throw new Error('Unexpected IPC ' + name);
  };
  const root = w.document.querySelector('main');
  const opened = [];
  const dispose = await (await modulePromise).mountCalendarGoals(root, { invoke: api, onSelectGoal: () => { selected++; }, onCreateTask: goal => { created = goal; }, ...dependencies });
  t.after(() => { dispose(); dom.window.close(); });
  const open = () => { const trigger = root.querySelector('[data-new]'); trigger.focus(); trigger.click(); return w.document.querySelector('dialog[data-goal-create], dialog[data-wish-form]'); };
  const submit = async modal => { modal.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await tick(); };
  const refresh = async () => { w.dispatchEvent(new w.Event('task-state-changed')); await tick(); };
  const menuItems = selector => { const more = root.querySelector(selector); more.focus(); more.click(); return [...w.document.querySelectorAll('.calendar-record-menu [role=menuitem]')]; };
  const menu = async (selector, action) => { menuItems(selector).find(item => item.dataset.menuAction === action).click(); await tick(); return w.document.querySelector('dialog'); };
  return { w, root, goals, links, calls, before, ui, opened, dispose, open, submit, refresh, menu, menuItems, selected: () => selected, created: () => created, setActive: value => { active = value; } };
}

test('New goal opens a named shared dialog, not an inline form; cancel restores the trigger without IPC', async t => {
  const x = await setup(t), calls = x.calls.length, modal = x.open();
  assert.equal(modal.open, true); assert.equal(x.root.querySelector('form'), null);
  assert.equal(x.w.document.getElementById(modal.getAttribute('aria-labelledby')).textContent, 'Новая цель');
  assert.equal(x.w.document.activeElement, modal.querySelector('[name=title]'));
  modal.querySelector('[name=title]').value = 'Не сохранять'; modal.dispatchEvent(new x.w.Event('cancel', { cancelable: true }));
  assert.equal(modal.isConnected, false); assert.equal(x.w.document.activeElement, x.root.querySelector('[data-new]')); assert.equal(x.calls.length, calls);
});

for (const deadline of ['', '2027-02-03']) test(`goal creation keeps the existing model and optional deadline ${deadline || 'empty'}`, async t => {
  const x = await setup(t), modal = x.open(); modal.querySelector('[name=title]').value = '  Стать специалистом  '; modal.querySelector('[name=deadline]').value = deadline;
  await x.submit(modal);
  assert.deepEqual(x.calls.filter(call => call.name === 'save_calendar_goal'), [{ name: 'save_calendar_goal', args: { id: null, title: 'Стать специалистом', targetValue: 1, unit: '', deadline: deadline || null, goalKind: 'goal', description: '', criteria: '', parentGoalId: null, clearParent: false, currentValue: null } }]);
  assert.equal(modal.isConnected, false); assert.equal(x.goals.length, 1); assert.equal(x.selected(), 0);
  assert.equal(x.calls.some(call => /set_ui_state|task_block/.test(call.name)), false);
  assert.match(x.root.querySelector('[data-list]').textContent, /Стать специалистом/); assert.equal(x.w.document.activeElement, x.root.querySelector('[data-new]'));
});

test('empty and excessive goal titles are focused errors; a 500-character title remains valid', async t => {
  const x = await setup(t), modal = x.open(), title = modal.querySelector('[name=title]');
  for (const value of ['   ', 'Д'.repeat(501)]) {
    title.value = value; await x.submit(modal); assert.equal(x.goals.length, 0);
    assert.equal(title.getAttribute('aria-invalid'), 'true'); assert.equal(x.w.document.activeElement, title);
  }
  title.value = 'Д'.repeat(500); await x.submit(modal); assert.equal(x.goals[0].title.length, 500);
});

test('native partial date with empty value and badInput cannot silently save as no deadline', async t => {
  const x = await setup(t), modal = x.open(), title = modal.querySelector('[name=title]'), deadline = modal.querySelector('[name=deadline]');
  title.value = 'Сохранить со сроком';
  // JSDOM has no segmented native date editor. Reproduce its browser-observed validity state.
  Object.defineProperty(deadline, 'validity', { configurable: true, value: { badInput: true, valid: false } });
  deadline.value = ''; await x.submit(modal);
  assert.equal(x.calls.some(call => call.name === 'save_calendar_goal'), false); assert.equal(modal.isConnected, true);
  assert.equal(x.w.document.activeElement, deadline); assert.equal(deadline.getAttribute('aria-invalid'), 'true'); assert.equal(title.value, 'Сохранить со сроком');
  delete deadline.validity; deadline.value = '2026-12-01'; await x.submit(modal);
  assert.equal(x.goals[0].deadline, '2026-12-01');
});

test('pending goal save blocks submit, top close and Escape, then failed form retries once without losing fields', async t => {
  const x = await setup(t), modal = x.open(); modal.querySelector('[name=title]').value = 'Черновик'; modal.querySelector('[name=deadline]').value = '2027-02-03';
  let release; const wait = new Promise(resolve => { release = resolve; }); x.before.set('save_calendar_goal', async () => { await wait; throw new Error('failure'); });
  modal.querySelector('[type=submit]').click(); modal.querySelector('[type=submit]').click();
  for (const close of modal.querySelectorAll('[data-dialog-close]')) { assert.equal(close.disabled, true); close.click(); }
  const cancel = new x.w.Event('cancel', { cancelable: true }); modal.dispatchEvent(cancel); assert.equal(cancel.defaultPrevented, true); assert.equal(modal.isConnected, true);
  release(); await tick(); assert.equal(x.calls.filter(call => call.name === 'save_calendar_goal').length, 1); assert.equal(x.goals.length, 0);
  assert.equal(modal.querySelector('[name=title]').value, 'Черновик'); assert.equal(modal.querySelector('[name=deadline]').value, '2027-02-03');
  assert.equal(x.w.document.activeElement, modal.querySelector('[data-dialog-error]'));
  x.before.delete('save_calendar_goal'); await x.submit(modal); assert.equal(x.goals.length, 1); assert.equal(modal.isConnected, false);
});

test('successful create followed by failed catalog refresh closes the form and retry reads without duplicate create', async t => {
  const x = await setup(t), modal = x.open(); modal.querySelector('[name=title]').value = 'Уже сохранено';
  x.before.set('get_goals', () => { throw new Error('read failure'); }); await x.submit(modal);
  assert.equal(modal.isConnected, false); assert.equal(x.goals.length, 1); assert.equal(x.root.querySelector('[data-retry]').hidden, false);
  x.before.delete('get_goals'); x.root.querySelector('[data-retry]').click(); await tick();
  assert.equal(x.calls.filter(call => call.name === 'save_calendar_goal').length, 1); assert.match(x.root.querySelector('[data-list]').textContent, /Уже сохранено/);
});

test('disposed goal catalog closes its dialog and late save completion preserves outside focus', async t => {
  const x = await setup(t), modal = x.open(); modal.querySelector('[name=title]').value = 'Поздний ответ';
  let release; x.before.set('save_calendar_goal', () => new Promise(resolve => { release = resolve; })); modal.querySelector('[type=submit]').click();
  const outside = x.w.document.querySelector('#outside'); outside.focus(); x.dispose(); assert.equal(modal.isConnected, false);
  release(); await tick(); assert.equal(x.w.document.activeElement, outside); assert.equal(x.goals.length, 1);
});

test('daily norms and long-term goals have explicit types and editable result criteria', async t => {
  const x = await setup(t), modal = x.open(), fields = modal.querySelector('form').elements;
  fields.title.value = 'Вода'; fields.goal_kind.value = 'daily_norm'; fields.target_value.value = '2'; fields.unit.value = 'л';
  fields.description.value = 'Отслеживать выпитое за день'; fields.criteria.value = 'Записан объём за день';
  await x.submit(modal);
  assert.equal(x.goals[0].goal_kind, 'daily_norm');
  assert.match(x.root.textContent, /Ежедневные нормы/); assert.match(x.root.textContent, /Каждый день: 2 л/);
  assert.equal(x.root.querySelector('[data-select]'), null);
  const edit = await x.menu('[data-goal-menu="1"]', 'edit'), editFields = edit.querySelector('form').elements;
  assert.equal(editFields.criteria.value, 'Записан объём за день');
  editFields.goal_kind.value = 'goal'; editFields.title.value = 'API';
  editFields.criteria.value = 'Описан контракт\nПроверены ошибки'; await x.submit(edit);
  assert.equal(x.goals.length, 1); assert.equal(x.goals[0].goal_kind, 'goal'); assert.equal(x.goals[0].criteria, 'Описан контракт\nПроверены ошибки');
  assert.match(x.root.textContent, /Долгосрочные цели/);
  assert.doesNotMatch(x.root.querySelector('[data-list]').textContent, /Описан контракт/, 'criteria live in the goal popup, not in the list');
});

test('existing goals stay unclassified until their type is explicitly chosen', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: '2 литра', target_value: 2, unit: 'л' });
  await x.refresh();
  assert.match(x.root.textContent, /Без типа/);
  const edit = await x.menu('[data-goal-menu="9"]', 'edit');
  edit.querySelector('[name=title]').value = 'Обновлённое название';
  await x.submit(edit); assert.equal(edit.isConnected, false);
  assert.equal(x.goals[0].title, 'Обновлённое название');
  assert.equal(x.goals[0].goal_kind, null);
  assert.equal(x.goals.length, 1);
});

test('goal forest keeps nested goals ordered once and tolerates missing parents and cycles', async () => {
  const { calendarGoalForest } = await modulePromise;
  const rows = calendarGoalForest([
    { id: 1, title: 'Корень', goal_kind: 'goal' }, { id: 2, title: 'Ребёнок', goal_kind: 'goal', parent_goal_id: 1 },
    { id: 3, title: 'Без родителя', goal_kind: 'goal', parent_goal_id: 99 }, { id: 4, title: 'Цикл A', goal_kind: 'goal', parent_goal_id: 5 },
    { id: 5, title: 'Цикл B', goal_kind: 'goal', parent_goal_id: 4 },
  ]);
  assert.deepEqual(rows.map(row => [row.goal.id, row.depth]), [[1, 0], [2, 1], [3, 0], [4, 0], [5, 1]]);
});

test('parent goal counts linked records through all subgoals once and follows relinking', async () => {
  const { calendarGoalLinks, calendarGoalDescendants } = await modulePromise;
  const goals = [{id:1,title:'Корень',goal_kind:'goal'}, {id:2,title:'Этап',goal_kind:'goal',parent_goal_id:1}, {id:3,title:'Практика',goal_kind:'goal',parent_goal_id:2}, {id:4,title:'Другая цель',goal_kind:'goal'}];
  const links = [{goal_id:2,source_type:'note',source_id:'a'}, {goal_id:3,source_type:'note',source_id:'b'}, {goal_id:3,source_type:'note',source_id:'b'}, {goal_id:3,source_type:'event',source_id:'b'}, {goal_id:4,source_type:'note',source_id:'c'}];
  const label = id => calendarGoalLinks(links, id, [...calendarGoalDescendants(goals, id)].filter(value => value !== String(id)));
  assert.equal(label(1), '2 задачи · 1 событие');
  assert.equal(label(2), label(1));
  assert.equal(label(3), '1 задача · 1 событие');
  assert.equal(label(4), '1 задача');
  links[0].goal_id = 4;
  assert.equal(label(1), '1 задача · 1 событие');
  assert.equal(label(4), '2 задачи');
});

test('goal editor offers only valid parents, clears a parent, and starts a task with the visible goal path', async t => {
  const x = await setup(t);
  x.goals.push({ id: 1, title: 'Карьерный путь', goal_kind: 'goal', target_value: 1 }, { id: 2, title: 'API', goal_kind: 'goal', parent_goal_id: 1, target_value: 1 });
  await x.refresh();
  await x.menu('[data-goal-menu="2"]', 'task');
  assert.deepEqual(x.created(), { goalId: 2, title: 'API', path: 'Карьерный путь → API' });
  const edit = await x.menu('[data-goal-menu="2"]', 'edit'), parent = edit.querySelector('[name=parent_goal_id]');
  assert.deepEqual([...parent.options].map(option => option.value), ['', '1']);
  parent.value = ''; await x.submit(edit);
  assert.deepEqual(x.calls.filter(call => call.name === 'save_calendar_goal').at(-1).args, {
    id: 2, title: 'API', targetValue: 1, unit: '', deadline: null, goalKind: 'goal', description: '', criteria: '', parentGoalId: null, clearParent: true, currentValue: null,
  });
});

test('nested rows collapse and reopen with focus, keeping a bounded deep indent', async t => {
  const x = await setup(t);
  x.goals.push({ id: 1, title: 'Корень', goal_kind: 'goal', target_value: 1 }, { id: 2, title: 'Подцель', goal_kind: 'goal', parent_goal_id: 1, target_value: 1 }, { id: 3, title: 'Шаг', goal_kind: 'goal', parent_goal_id: 2, target_value: 1 });
  await x.refresh();
  const rootRow = x.root.querySelector('[data-goal-id="1"]');
  assert.equal(rootRow.classList.contains('is-subgoal'), false);
  assert.equal(x.root.querySelector('[data-goal-id="3"]').classList.contains('is-subgoal'), true);
  const collapse = rootRow.querySelector('[data-goal-collapse]'); collapse.click();
  assert.equal(x.root.querySelector('[data-goal-id="2"]'), null);
  assert.equal(x.root.querySelector('[data-goal-collapse="1"]').getAttribute('aria-expanded'), 'false');
  assert.equal(x.w.document.activeElement, x.root.querySelector('[data-goal-collapse="1"]'));
  await x.refresh();
  assert.equal(x.root.querySelector('[data-goal-id="2"]'), null);
  assert.equal(x.w.document.activeElement, x.root.querySelector('[data-goal-collapse="1"]'));
  x.root.querySelector('[data-goal-collapse="1"]').click();
  assert.equal(x.root.querySelector('[data-goal-id="3"]').style.getPropertyValue('--goal-depth'), '2');
});

test('qualitative goals keep backend-compatible defaults without forcing numeric input', async t => {
  const x = await setup(t), modal = x.open(), fields = modal.querySelector('form').elements;
  assert.equal(fields.numeric_progress.checked, false); assert.equal(modal.querySelector('[data-numeric-fields]').hidden, true);
  fields.title.value = 'Освоить системный анализ'; await x.submit(modal);
  assert.equal(x.goals[0].target_value, 1); assert.equal(x.goals[0].unit, '');
  const daily = x.open(); daily.querySelector('[name=goal_kind][value=daily_norm]').click();
  assert.equal(daily.querySelector('[data-numeric-fields]').hidden, false);
});

test('long-term numeric goals show real current and target values without inventing qualitative progress', async t => {
  const x = await setup(t);
  x.goals.push({ id: 1, title: 'Накопить резерв', goal_kind: 'goal', target_value: 100000, current_value: 25000, unit: '₸' }, { id: 2, title: 'Выстроить процесс', goal_kind: 'goal', target_value: 1, unit: '' });
  await x.refresh();
  assert.match(x.root.querySelector('[data-goal-id="1"] .cp-goal-row__meta').textContent, /25\s000 из 100\s000 ₸/);
  assert.equal(x.root.querySelector('[data-goal-id="2"] .cp-goal-row__meta'), null);
});

test('unrecognized goal kinds remain visible for repair instead of disappearing', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: 'Старый тип', goal_kind: 'legacy_kind', target_value: 1 });
  await x.refresh();
  assert.match(x.root.textContent, /Без типа/); assert.match(x.root.textContent, /Старый тип/);
});

test('goal deletion requires confirmation; cancellation preserves the goal and failure can be retried', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: 'Старая цель', target_value: 1 });
  await x.refresh();
  const trigger = x.root.querySelector('[data-goal-menu="9"]');
  let modal = await x.menu('[data-goal-menu="9"]', 'delete');
  assert.ok(modal.matches('[data-goal-delete]'));
  assert.equal(x.calls.some(call => call.name === 'delete_goal'), false);
  assert.match(modal.textContent, /Задачи|задачи/);
  modal.dispatchEvent(new x.w.Event('cancel', { cancelable: true }));
  assert.equal(x.goals.length, 1); assert.equal(x.w.document.activeElement, trigger);
  modal = await x.menu('[data-goal-menu="9"]', 'delete');
  x.before.set('delete_goal', () => { throw new Error('offline'); });
  await x.submit(modal);
  assert.equal(x.goals.length, 1); assert.equal(modal.isConnected, true);
  assert.equal(modal.querySelector('[type=submit]').disabled, false);
  assert.match(modal.querySelector('[data-dialog-error]').textContent, /Не удалось удалить/);
  x.before.delete('delete_goal'); await x.submit(modal);
  assert.equal(x.goals.length, 0); assert.equal(modal.isConnected, false);
  assert.equal(x.root.querySelector('[data-goal-menu="9"]'), null);
  assert.equal(x.w.document.activeElement, x.root.querySelector('[data-new]'));
  assert.equal(x.calls.some(call => /delete_note|delete_event|delete_schedule/.test(call.name)), false);
});

// #98 level 2: compact rows; the popup (level 3) opens from the row.
const levels = { calendar_now_v1: JSON.stringify({ version: 1, goalId: 'g1' }), calendar_development_v1: JSON.stringify({ version: 1, goals: {
  g1: { skills: [{ id: 's1', title: 'Пишу user story', topic: 'Требования' }], stages: [{ id: 'st1', title: 'Основы требований', skillIds: ['s1'] }, { id: 'st2', title: 'API', skillIds: [] }], activeStageId: 'st1' },
  g3: { skills: [], stages: [{ id: 'x', title: 'Разминка', skillIds: [] }], activeStageId: null },
} }) };
const levelGoals = [
  { id: 'g1', title: 'Освоить системный анализ', goal_kind: 'goal', target_value: 1, unit: '', deadline: '2026-12-01', description: 'Уверенно описывать требования\nи модели данных', criteria: 'Пишу спецификацию API' },
  { id: 'g2', title: 'Подготовить портфолио', goal_kind: 'goal', target_value: 1, unit: '', parent_goal_id: 'g1', description: '' },
  { id: 'g3', title: 'Пробежать полумарафон', goal_kind: 'goal', target_value: 21, current_value: 12, unit: 'км', description: 'Без травм' },
  { id: 'g4', title: 'Пить воду', goal_kind: 'daily_norm', target_value: 2, unit: 'л' },
];

test('goal rows show title, one-line description, current stage and deadline; the main goal is marked', async t => {
  const x = await setup(t, { ui: levels }); x.goals.push(...structuredClone(levelGoals)); await x.refresh();
  const row = id => x.root.querySelector(`[data-goal-id="${id}"]`);
  assert.equal(row('g1').classList.contains('is-primary'), true);
  assert.equal(row('g1').querySelector('.cp-goal-row__badge').textContent, 'Главная');
  assert.equal(row('g3').querySelector('.cp-goal-row__badge'), null);
  assert.equal(row('g1').querySelector('.cp-goal-row__desc').textContent, 'Уверенно описывать требования', 'only the first line of the description');
  assert.equal(row('g1').querySelector('.cp-goal-row__meta').textContent, 'Этап: Основы требований · до 1 декабря 2026 г.');
  assert.match(row('g3').querySelector('.cp-goal-row__meta').textContent, /^Этап не выбран · 12 из 21 км$/);
  assert.equal(row('g2').querySelector('.cp-goal-row__meta'), null, 'a goal without stages, value or deadline has no meta line');
  assert.equal(row('g2').style.getPropertyValue('--goal-depth'), '1');
  assert.equal(row('g4').closest('[data-list]').querySelectorAll('.cp-goal-group')[1].textContent, 'Ежедневные нормы');
  assert.equal(row('g4').querySelector('.cp-goal-row__meta').textContent, 'Каждый день: 2 л');
  assert.doesNotMatch(x.root.querySelector('[data-list]').textContent, /Пишу спецификацию|Связано/, 'criteria and links stay in the popup');
  assert.equal(row('g1').querySelector('[data-select]'), null, 'the main goal has no «Сделать главной»');
  assert.equal(row('g4').querySelector('[data-select]'), null, 'daily norms cannot be the main goal');
  assert.equal(row('g3').querySelector('[data-select]').textContent, 'Сделать главной');
});

test('a goal row opens the popup with its context; the menu holds task, subgoal, edit and delete', async t => {
  const x = await setup(t, { ui: levels, dependencies: { onOpenGoal: (goal, context) => opened.push({ goal, context }) } });
  const opened = [];
  x.goals.push(...structuredClone(levelGoals)); await x.refresh();
  x.root.querySelector('[data-goal-id="g3"] .cp-goal-row__desc').click();
  assert.equal(opened.length, 1, 'a click anywhere on the row opens it');
  assert.equal(opened[0].goal.id, 'g3'); assert.equal(opened[0].context.primaryGoalId, 'g1');
  x.w.document.querySelector('#outside').focus(); opened[0].context.returnFocus();
  assert.equal(x.w.document.activeElement, x.root.querySelector('[data-goal-open="g3"]'));
  x.root.querySelector('[data-goal-open="g1"]').click();
  assert.equal(opened.at(-1).goal.id, 'g1');
  assert.deepEqual(x.menuItems('[data-goal-menu="g3"]').map(item => item.textContent), ['Добавить задачу', 'Подцель', 'Редактировать', 'Удалить']);
  x.w.document.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(x.menuItems('[data-goal-menu="g4"]').map(item => item.textContent), ['Редактировать', 'Удалить']);
  x.w.document.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const subgoal = await x.menu('[data-goal-menu="g3"]', 'subgoal');
  assert.equal(subgoal.querySelector('h2').textContent, 'Новая подцель');
  assert.equal(subgoal.querySelector('[name=parent_goal_id]').value, 'g3');
  x.root.querySelector('[data-goal-id="g3"] [data-select]').click(); await tick();
  assert.equal(x.selected(), 1, '«Сделать главной» selects through the dashboard owner');
});

test('a running task disables «Сделать главной» and says why', async t => {
  const x = await setup(t, { ui: levels }); x.goals.push(...structuredClone(levelGoals));
  x.setActive({ id: 5, source_type: 'note', source_id: 't1' }); await x.refresh();
  assert.equal(x.root.querySelector('[data-goal-id="g3"] [data-select]').disabled, true);
  assert.match(x.root.querySelector('[data-message]').textContent, /на паузу/);
});

// #85: wishes live in the Goals tab, apart from goals.
const wishState = wishes => JSON.stringify({ version: 1, wishes });
const wish = (id, extra = {}) => ({ id, title: `Желание ${id}`, category: 'other', price: null, currency: 'KZT', url: '', note: '', status: 'want', goalId: null, createdAt: `2026-09-0${id.length}T10:00:00.000Z`, updatedAt: '', ...extra });

test('Goals | Wishes switch keeps its choice across remounts and changes the create action', async t => {
  const state = { view: 'goals' };
  const x = await setup(t, { dependencies: { state } });
  const [goalsButton, wishesButton] = x.root.querySelectorAll('[data-goals-view]');
  assert.equal(goalsButton.getAttribute('aria-pressed'), 'true'); assert.equal(x.root.querySelector('[data-new]').textContent, 'Новая цель');
  wishesButton.click(); await tick();
  assert.equal(wishesButton.getAttribute('aria-pressed'), 'true'); assert.equal(x.w.document.activeElement, wishesButton);
  assert.equal(x.root.querySelector('[data-goals-panel]').hidden, true); assert.equal(x.root.querySelector('[data-wishes-panel]').hidden, false);
  assert.equal(x.root.querySelector('[data-new]').textContent, 'Новое желание');
  assert.match(x.root.querySelector('.cp-wish-empty').textContent, /Желаний пока нет/);
  assert.equal(state.view, 'wishes');
  x.dispose();
  const again = await setup(t, { dependencies: { state } });
  assert.equal(again.root.querySelector('[data-goals-view="wishes"]').getAttribute('aria-pressed'), 'true');
});

test('a wish becomes a goal through the goal editor, keeps its details and links to the new goal', async t => {
  const x = await setup(t, { dependencies: { state: { view: 'wishes' } }, ui: { calendar_wishes_v1: wishState([wish('w1', { title: 'Беговые кроссовки', price: 45000, note: 'Размер 42', url: 'https://example.com/shoes', status: 'saving' })]) } });
  await tick();
  const editor = await x.menu('[data-wish-menu="w1"]', 'convert');
  const fields = editor.querySelector('form').elements;
  assert.equal(editor.querySelector('h2').textContent, 'Новая цель');
  assert.equal(fields.title.value, 'Беговые кроссовки');
  assert.equal(fields.description.value, 'Размер 42\nСсылка: https://example.com/shoes');
  assert.equal(fields.numeric_progress.checked, true, 'a price becomes the saving target');
  assert.equal(fields.target_value.value, '45000'); assert.equal(fields.unit.value, '₸');
  assert.equal(x.goals.length, 0, 'nothing is saved before confirmation');
  await x.submit(editor); await tick();
  const save = x.calls.find(call => call.name === 'save_calendar_goal').args;
  assert.deepEqual([save.title, save.targetValue, save.unit, save.goalKind, save.currentValue], ['Беговые кроссовки', 45000, '₸', 'goal', null]);
  const stored = JSON.parse(x.ui.get('calendar_wishes_v1')).wishes[0];
  assert.equal(stored.goalId, '1'); assert.equal(stored.status, 'saving', 'converting keeps the wish and its status');
  assert.ok(stored.convertedAt);
  assert.match(x.root.querySelector('[data-wish-id="w1"] .cp-wish-row__meta').textContent, /Цель: Беговые кроссовки/);
  assert.deepEqual(x.menuItems('[data-wish-menu="w1"]').map(item => item.dataset.menuAction), ['edit', 'link', 'delete'], 'no second conversion; opening the goal needs the popup');
});

test('a failed conversion mark keeps the created goal and offers a retry without a second goal', async t => {
  const x = await setup(t, { dependencies: { state: { view: 'wishes' } }, ui: { calendar_wishes_v1: wishState([wish('w1')]) } });
  await tick();
  const editor = await x.menu('[data-wish-menu="w1"]', 'convert');
  x.before.set('set_ui_state', () => { throw new Error('offline'); });
  await x.submit(editor); await tick();
  assert.equal(x.goals.length, 1);
  assert.match(x.root.querySelector('.cp-wish-notice').textContent, /Цель создана, но желание не отмечено/);
  x.before.delete('set_ui_state');
  x.root.querySelector('[data-wish-convert-retry]').click(); await tick();
  assert.equal(JSON.parse(x.ui.get('calendar_wishes_v1')).wishes[0].goalId, '1');
  assert.equal(x.root.querySelector('.cp-wish-notice'), null);
  assert.equal(x.calls.filter(call => call.name === 'save_calendar_goal').length, 1);
});
