'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const data = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const read = name => fs.readFileSync(path.resolve(__dirname, '../src/hanni/js', name + '.js'), 'utf8');
const source = read('calendar-goals').replace(/^import .*state\.js';\r?$/m, 'const defaultInvoke = () => { throw new Error("Inject API"); };')
  .replace(/^import .*utils\.js';\r?$/m, 'const escapeHtml = value => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");')
  .replace("'./calendar-dialog.js'", JSON.stringify(data(read('calendar-dialog'))));
const modulePromise = import(data(source));
const tick = async () => { for (let i = 0; i < 7; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(t) {
  const dom = new JSDOM('<main></main><button id="outside">Вне</button>', { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button')?.focus(); };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const goals = [], calls = [], before = new Map(); let selected = 0, created = null;
  const api = async (name, args) => {
    calls.push({ name, args: structuredClone(args) }); if (before.has(name)) await before.get(name)(args);
    if (name === 'get_goals') return structuredClone(goals);
    if (name === 'get_calendar_task_goals') return [];
    if (name === 'get_ui_state') return JSON.stringify({ version: 1, goalId: null });
    if (name === 'get_active_block') return null;
    if (name === 'save_calendar_goal') { const id = goals.length + 1; const values = { id: args.id || id, title: args.title, deadline: args.deadline, goal_kind: args.goalKind, description: args.description, criteria: args.criteria, target_value: args.targetValue, unit: args.unit, parent_goal_id: args.clearParent ? null : args.parentGoalId, current_value: args.currentValue };
      if (args.id) Object.assign(goals.find(goal => goal.id === args.id), values); else goals.push(values); return id; }
    if (name === 'delete_goal') { goals.splice(goals.findIndex(goal => goal.id === args.id), 1); return; }
    throw new Error('Unexpected IPC ' + name);
  };
  const root = w.document.querySelector('main');
  const dispose = await (await modulePromise).mountCalendarGoals(root, { invoke: api, onSelectGoal: () => { selected++; }, onCreateTask: goal => { created = goal; } });
  t.after(() => { dispose(); dom.window.close(); });
  const open = () => { const trigger = root.querySelector('[data-new]'); trigger.focus(); trigger.click(); return w.document.querySelector('dialog[data-goal-create]'); };
  const submit = async modal => { modal.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await tick(); };
  return { w, root, goals, calls, before, dispose, open, submit, selected: () => selected, created: () => created };
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
  x.root.querySelector('[data-edit-goal]').click();
  const edit = x.w.document.querySelector('dialog'), editFields = edit.querySelector('form').elements;
  assert.equal(editFields.criteria.value, 'Записан объём за день');
  editFields.goal_kind.value = 'goal'; editFields.title.value = 'API';
  editFields.criteria.value = 'Описан контракт\nПроверены ошибки'; await x.submit(edit);
  assert.equal(x.goals.length, 1); assert.equal(x.goals[0].goal_kind, 'goal');
  assert.match(x.root.textContent, /Долгосрочные цели/); assert.equal(x.root.querySelectorAll('article li').length, 2);
});

test('existing goals stay unclassified until their type is explicitly chosen', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: '2 литра', target_value: 2, unit: 'л' });
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  assert.match(x.root.textContent, /Без типа/);
  x.root.querySelector('[data-edit-goal]').click(); const edit = x.w.document.querySelector('dialog');
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

test('goal editor offers only valid parents, clears a parent, and starts a task with the visible goal path', async t => {
  const x = await setup(t);
  x.goals.push({ id: 1, title: 'Карьерный путь', goal_kind: 'goal', target_value: 1 }, { id: 2, title: 'API', goal_kind: 'goal', parent_goal_id: 1, target_value: 1 });
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  [...x.root.querySelector('[data-goal-id="2"]').querySelectorAll('button')].find(button => button.textContent === 'Добавить задачу').click();
  assert.deepEqual(x.created(), { goalId: 2, title: 'API', path: 'Карьерный путь → API' });
  x.root.querySelector('[data-goal-id="2"] [data-edit-goal]').click();
  const edit = x.w.document.querySelector('dialog'), parent = edit.querySelector('[name=parent_goal_id]');
  assert.deepEqual([...parent.options].map(option => option.value), ['', '1']);
  parent.value = ''; await x.submit(edit);
  assert.deepEqual(x.calls.filter(call => call.name === 'save_calendar_goal').at(-1).args, {
    id: 2, title: 'API', targetValue: 1, unit: '', deadline: null, goalKind: 'goal', description: '', criteria: '', parentGoalId: null, clearParent: true, currentValue: null,
  });
});

test('nested rows collapse and reopen with focus, keeping a compact path and a bounded deep indent', async t => {
  const x = await setup(t);
  x.goals.push({ id: 1, title: 'Корень', goal_kind: 'goal', target_value: 1 }, { id: 2, title: 'Подцель', goal_kind: 'goal', parent_goal_id: 1, target_value: 1 }, { id: 3, title: 'Шаг', goal_kind: 'goal', parent_goal_id: 2, target_value: 1 });
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  const rootCard = x.root.querySelector('[data-goal-id="1"]');
  assert.equal(rootCard.querySelector('.cp-goal-card__header').nextElementSibling.className, 'cp-goal-card__details');
  assert.match(x.root.querySelector('[data-goal-id="3"] .cp-goal-path').textContent, /Корень → Подцель → Шаг/);
  const collapse = rootCard.querySelector('[data-goal-collapse]'); collapse.click();
  assert.equal(x.root.querySelector('[data-goal-id="2"]'), null);
  assert.equal(x.root.querySelector('[data-goal-collapse="1"]').getAttribute('aria-expanded'), 'false');
  assert.equal(x.w.document.activeElement, x.root.querySelector('[data-goal-collapse="1"]'));
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
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
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  assert.match(x.root.querySelector('[data-goal-id="1"]').textContent, /Прогресс: 25000 из 100000 ₸/);
  assert.doesNotMatch(x.root.querySelector('[data-goal-id="2"]').textContent, /Прогресс:|Цель: 1/);
});

test('unrecognized goal kinds remain visible for repair instead of disappearing', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: 'Старый тип', goal_kind: 'legacy_kind', target_value: 1 });
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  assert.match(x.root.textContent, /Без типа/); assert.match(x.root.textContent, /Старый тип/);
});

test('goal deletion requires confirmation; cancellation preserves the goal and failure can be retried', async t => {
  const x = await setup(t); x.goals.push({ id: 9, title: 'Старая цель', target_value: 1 });
  x.w.dispatchEvent(new x.w.Event('task-state-changed')); await tick();
  const trigger = x.root.querySelector('[data-delete-goal]'); trigger.focus(); trigger.click();
  let modal = x.w.document.querySelector('[data-goal-delete]');
  assert.equal(x.calls.some(call => call.name === 'delete_goal'), false);
  assert.match(modal.textContent, /Задачи|задачи/);
  modal.dispatchEvent(new x.w.Event('cancel', { cancelable: true }));
  assert.equal(x.goals.length, 1); assert.equal(x.w.document.activeElement, trigger);
  trigger.click(); modal = x.w.document.querySelector('[data-goal-delete]');
  x.before.set('delete_goal', () => { throw new Error('offline'); });
  await x.submit(modal);
  assert.equal(x.goals.length, 1); assert.equal(modal.isConnected, true);
  assert.equal(modal.querySelector('[type=submit]').disabled, false);
  assert.match(modal.querySelector('[data-dialog-error]').textContent, /Не удалось удалить/);
  x.before.delete('delete_goal'); await x.submit(modal);
  assert.equal(x.goals.length, 0); assert.equal(modal.isConnected, false);
  assert.equal(x.root.querySelector('[data-delete-goal]'), null);
  assert.equal(x.calls.some(call => /delete_note|delete_event|delete_schedule/.test(call.name)), false);
});
