import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><button id="trigger">Открыть</button></body>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage; globalThis.FormData = dom.window.FormData;
globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const { openCalendarGoalPopup } = await import('../src/hanni/js/calendar-goal-popup.js');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function backend() {
  const state = {
    goals: [
      { id: 'g0', title: 'Карьера аналитика', goal_kind: 'goal', target_value: 1, unit: '', parent_goal_id: null, description: '', criteria: '' },
      { id: 'g1', title: 'Пробежать полумарафон', goal_kind: 'goal', target_value: 21, current_value: 12, unit: 'км', deadline: '2026-12-01', parent_goal_id: 'g0',
        description: 'Подготовиться без травм\nи пробежать в спокойном темпе', criteria: 'Бегу 15 км без остановки\n\nВосстанавливаюсь за день' },
      { id: 'g2', title: 'Набрать базу', goal_kind: 'goal', target_value: 1, unit: '', parent_goal_id: 'g1', deadline: '2026-10-15' },
      { id: 'g9', title: 'Пить воду', goal_kind: 'daily_norm', target_value: 2, unit: 'л' },
    ],
    links: [{ source_type: 'note', source_id: 't1', goal_id: 'g1' }, { source_type: 'note', source_id: 't2', goal_id: 'g2' }, { source_type: 'event', source_id: 'e1', goal_id: 'g1' }, { source_type: 'note', source_id: 't3', goal_id: 'g1' }],
    tasks: [
      { source_type: 'note', source_id: 't1', title: 'Лёгкая пробежка 5 км', date: '2026-09-25', status_extra: 'task', completed: false },
      { source_type: 'note', source_id: 't2', title: 'Купить пульсометр', date: null, status_extra: 'task', completed: false },
      { source_type: 'note', source_id: 't3', title: 'Старая тренировка', date: null, status_extra: 'done', completed: true },
      { source_type: 'note', source_id: 't4', title: 'Чужая задача', date: null, status_extra: 'task', completed: false },
    ],
    ui: new Map([
      ['calendar_now_v1', JSON.stringify({ version: 1, goalId: 'g0' })],
      ['calendar_development_v1', JSON.stringify({ version: 1, goals: { g1: {
        skills: [{ id: 's1', title: 'Темп 6:00', topic: 'Бег', evidence: 'Забег 10 км' }, { id: 's2', title: 'Растяжка', topic: 'Восстановление' }],
        stages: [{ id: 'st1', title: 'База', skillIds: ['s1'], deadline: '2026-10-15' }, { id: 'st2', title: 'Объём', skillIds: ['s2'] }], activeStageId: 'st1' } } })],
    ]),
    active: null, calls: [],
  };
  state.invoke = async (command, args = {}) => {
    state.calls.push({ command, args: structuredClone(args) });
    if (command === 'get_goals') return structuredClone(state.goals);
    if (command === 'get_calendar_task_goals') return structuredClone(state.links);
    if (command === 'get_calendar_tasks') return structuredClone(state.tasks);
    if (command === 'get_active_block') return state.active;
    if (command === 'get_ui_state') return state.ui.get(args.key) ?? null;
    if (command === 'set_ui_state') { state.ui.set(args.key, args.value); return null; }
    if (command === 'save_calendar_goal') {
      const goal = state.goals.find(item => item.id === args.id);
      if (goal) Object.assign(goal, { title: args.title, description: args.description, criteria: args.criteria, deadline: args.deadline });
      else state.goals.push({ id: `new-${state.goals.length}`, title: args.title, goal_kind: 'goal', target_value: 1, unit: '', parent_goal_id: args.parentGoalId });
      return args.id || `new-${state.goals.length - 1}`;
    }
    if (command === 'delete_goal') { state.goals = state.goals.filter(item => item.id !== args.id); return null; }
    throw new Error('Unexpected IPC ' + command);
  };
  state.count = command => state.calls.filter(call => call.command === command).length;
  return state;
}
async function open(t, data, goalId, options = {}) {
  const trigger = document.getElementById('trigger'); trigger.focus();
  const events = { selected: [], tasks: [], opened: [], goals: [], skills: [], restored: 0, closed: 0 };
  const popup = openCalendarGoalPopup({ document, invoke: data.invoke, goal: data.goals.find(goal => goal.id === goalId),
    returnFocus: () => { events.restored++; trigger.focus(); }, onClose: () => { events.closed++; },
    onSelectGoal: id => events.selected.push(id), onCreateTask: (goal, restore) => events.tasks.push({ goal, restore }),
    onCreateSkillTask: (goal, skill) => events.skills.push({ goal, skill }), onOpenTask: (row, restore) => events.opened.push({ row, restore }),
    onOpenGoal: goal => events.goals.push(goal), ...options });
  t.after(() => { popup.dispose(); document.querySelectorAll('dialog').forEach(node => node.remove()); });
  await popup.ready; await settle();
  const modal = popup.dialog.modal;
  const field = name => modal.querySelector(`[data-goal-field="${name}"]`);
  const action = name => modal.querySelector(`[data-goal-popup-action="${name}"]`);
  return { popup, modal, field, action, events };
}

test('the popup keeps every goal detail: result, criteria, progress, deadline, path, subgoals, tasks, stages and skills', async t => {
  const data = backend(), x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  assert.equal(x.modal.querySelector('h2').textContent, 'Пробежать полумарафон');
  assert.equal(document.activeElement, x.modal.querySelector('h2'));
  assert.equal(x.modal.querySelector('.calendar-editor-header p').textContent, 'до 1 декабря 2026 г.');
  assert.equal(x.field('path').textContent, 'Входит вКарьера аналитика');
  assert.equal(x.field('description').querySelector('.goal-popup__text').textContent, 'Подготовиться без травм\nи пробежать в спокойном темпе');
  assert.deepEqual([...x.field('criteria').querySelectorAll('li')].map(item => item.textContent), ['Бегу 15 км без остановки', 'Восстанавливаюсь за день']);
  assert.equal(x.field('progress').querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '57');
  assert.match(x.field('progress').textContent, /12 из 21 км/);
  assert.match(x.field('deadline').textContent, /1 декабря 2026/);
  assert.deepEqual([...x.field('subgoals').querySelectorAll('button')].map(button => button.textContent), ['Набрать базудо 15 октября 2026 г.']);
  assert.match(x.field('tasks').textContent, /Связано, включая подцели: 3 задачи · 1 событие/);
  assert.deepEqual([...x.field('tasks').querySelectorAll('button span')].map(node => node.textContent), ['Лёгкая пробежка 5 км', 'Купить пульсометр'], 'open tasks of the goal and its subgoals only');
  const development = x.modal.querySelector('[data-goal-development]');
  assert.equal(development.hidden, false);
  assert.equal(development.querySelectorAll('.dev-stage').length, 2);
  assert.equal(development.querySelector('.dev-stage.is-active strong').textContent, 'База');
  assert.deepEqual([...development.querySelectorAll('[data-dev-skill]')].map(button => button.textContent), ['Темп 6:00'], 'the active stage still filters the skills');
  development.querySelector('[data-dev-stage-clear]').click(); await settle();
  assert.equal(development.querySelectorAll('[data-dev-skill]').length, 2);
  assert.equal(development.querySelector('h2'), null, 'the popup header already names the goal');
  assert.equal(data.count('set_ui_state'), 1, 'only the explicit stage filter change wrote');
  assert.equal(x.action('select').hidden, false); assert.equal(x.action('task').hidden, false); assert.equal(x.action('subgoal').hidden, false);
});

test('leaving actions close the popup first and hand back the original focus target', async t => {
  const data = backend();
  let x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.action('select').click(); await settle();
  assert.deepEqual(x.events.selected, ['g1']); assert.equal(x.modal.isConnected, false);
  assert.equal(x.events.restored, 0, 'the dashboard owns focus after selecting');
  x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.action('task').click(); await settle();
  assert.equal(x.modal.isConnected, false);
  assert.deepEqual({ ...x.events.tasks[0].goal }, { goalId: 'g1', title: 'Пробежать полумарафон', path: 'Карьера аналитика → Пробежать полумарафон' });
  x.events.tasks[0].restore(); assert.equal(x.events.restored, 1);
  x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.field('tasks').querySelector('button').click(); await settle();
  assert.equal(x.events.opened[0].row.source_id, 't1'); assert.equal(x.modal.isConnected, false);
  x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.field('subgoals').querySelector('button').click(); await settle();
  assert.equal(x.events.goals[0].id, 'g2');
  x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.modal.querySelector('[data-dev-task="s1"]').click(); await settle();
  assert.equal(x.events.skills[0].skill.skillId, 's1'); assert.equal(x.modal.isConnected, false);
});

test('editing and adding a subgoal stack over the popup and refresh it; deletion closes it', async t => {
  const data = backend(), x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  x.action('edit').click(); await settle();
  let dialogs = [...document.querySelectorAll('dialog[open]')];
  assert.equal(dialogs.length, 2); const editor = dialogs.at(-1);
  assert.equal(editor.querySelector('[name=title]').value, 'Пробежать полумарафон');
  assert.equal(editor.querySelector('[name=criteria]').value, 'Бегу 15 км без остановки\n\nВосстанавливаюсь за день');
  editor.querySelector('[name=title]').value = 'Полумарафон весной';
  editor.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(editor.isConnected, false); assert.equal(x.modal.isConnected, true);
  assert.equal(x.modal.querySelector('h2').textContent, 'Полумарафон весной');
  assert.equal(document.activeElement, x.action('edit'));
  x.action('subgoal').click(); await settle();
  const child = [...document.querySelectorAll('dialog[open]')].at(-1);
  assert.equal(child.querySelector('h2').textContent, 'Новая подцель'); assert.equal(child.querySelector('[name=parent_goal_id]').value, 'g1');
  child.querySelector('[name=title]').value = 'Интервалы';
  child.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.match(x.field('subgoals').textContent, /Интервалы/);
  x.action('delete').click(); await settle();
  const confirm = [...document.querySelectorAll('dialog[open]')].at(-1);
  assert.ok(confirm.matches('[data-goal-delete]'));
  confirm.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(x.modal.isConnected, false); assert.equal(x.events.closed, 1);
  assert.equal(document.activeElement, document.getElementById('trigger'));
  dialogs = [...document.querySelectorAll('dialog')]; assert.equal(dialogs.length, 0);
});

test('the main goal needs no «Сделать главной», a daily norm has only its own fields, and context is read when missing', async t => {
  const data = backend();
  let x = await open(t, data, 'g0');
  assert.equal(data.count('get_ui_state') >= 1, true);
  assert.equal(x.action('select').hidden, true, 'read from calendar_now_v1: g0 is already the main goal');
  assert.equal(x.modal.querySelector('.calendar-editor-header p').textContent, 'Главная цель');
  assert.match(x.field('tasks').textContent, /Связано, включая подцели: 3 задачи · 1 событие/);
  x.popup.close();
  x = await open(t, data, 'g9', { primaryGoalId: 'g0' });
  assert.equal(x.modal.querySelector('.calendar-editor-header p').textContent, 'Ежедневная норма');
  assert.match(x.field('norm').textContent, /Каждый день: 2 л/);
  for (const name of ['select', 'task', 'subgoal']) assert.equal(x.action(name).hidden, true, name);
  assert.equal(x.modal.querySelector('[data-goal-development]').hidden, true);
  x.popup.close();
  data.active = { id: 1, source_type: 'note', source_id: 't1' };
  x = await open(t, data, 'g2', { primaryGoalId: 'g0' });
  assert.equal(x.action('select').disabled, true, 'a running task blocks changing the main goal');
  assert.match(x.field('tasks').textContent, /Купить пульсометр/);
});

test('refreshes keep keyboard focus on a task link and ignore quiet health refreshes', async t => {
  const data = backend(), x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  const reads = data.count('get_goals');
  window.dispatchEvent(new window.CustomEvent('hanni:calendar-refresh', { detail: { quietHealth: true } })); await settle();
  assert.equal(data.count('get_goals'), reads, 'a quiet health refresh does not reread the goal');
  x.field('tasks').querySelector('[data-goal-popup-task="note:t2"]').focus();
  data.tasks[1].title = 'Купить пульсометр и ремешок';
  window.dispatchEvent(new window.Event('task-state-changed')); await settle();
  assert.equal(document.activeElement.dataset.goalPopupTask, 'note:t2');
  assert.match(document.activeElement.textContent, /ремешок/);
});

test('a goal deleted elsewhere turns the popup into a notice instead of stale details', async t => {
  const data = backend(), x = await open(t, data, 'g1', { primaryGoalId: 'g0' });
  data.goals = data.goals.filter(goal => goal.id !== 'g1');
  window.dispatchEvent(new window.Event('task-state-changed')); await settle();
  assert.match(x.modal.querySelector('[data-goal-overview]').textContent, /удалена или больше недоступна/);
  assert.equal(x.modal.querySelector('.goal-popup__actions').hidden, true);
  assert.equal(x.modal.querySelector('[data-goal-development]').hidden, true);
});
