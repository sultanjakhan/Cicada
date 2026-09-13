import { invoke as defaultInvoke } from './state.js';
import { rankTasks as defaultRankTasks } from './task-picker-sort.js';
import { loadCategoryWeights } from './task-picker-view.js';
import { ICONS } from './icons.js';
import { createCalendarDialog } from './calendar-dialog.js';

const buttonContent = (icon, label) => `<span class="calendar-now__button-icon" aria-hidden="true">${ICONS[icon]}</span><span data-action-label>${label}</span>`;

const STATE_KEY = 'calendar_now_v1';
let nextInstance = 0;
// Serialize this device-local KV key across remounts, including an in-flight old save.
let stateWriteQueue = Promise.resolve();
const keyOf = task => task ? `${task.source_type}:${String(task.source_id)}` : '';
const dateOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateOf(date) === value ? value : null;
};
const freshState = () => ({ version: 1, goalId: null, selectionMode: 'auto', selection: null, execution: null, completed: null });
const taskOf = row => ({
  source_type: row.source_type, source_id: String(row.source_id),
  title: row.title || 'Без названия',
  duration_minutes: Number(row.duration_minutes || row.target_minutes) || null,
  date: validDate(row.date), completion_date: validDate(row.completion_date) || validDate(row.date),
});
const validTask = value => value && ['event', 'note', 'schedule'].includes(value.source_type) && value.source_id != null;
function restoreState(raw) {
  if (!raw) return freshState();
  const value = JSON.parse(raw);
  if (value?.version !== 1) throw new Error('Unsupported calendar state');
  return {
    version: 1, goalId: value.goalId == null ? null : String(value.goalId),
    selectionMode: value.selectionMode === 'manual' ? 'manual' : 'auto',
    selection: validTask(value.selection) ? taskOf(value.selection) : null,
    execution: value.execution && Number.isSafeInteger(value.execution.blockId) && /^\d{4}-\d{2}-\d{2}$/.test(value.execution.date) && validTask(value.execution.task)
      ? { blockId: value.execution.blockId, date: value.execution.date, task: taskOf(value.execution.task) } : null,
    completed: validTask(value.completed) ? taskOf(value.completed) : null,
  };
}

/** Mount a Calendar-only execution surface. UI state is device-local SQLite KV.
 * Dependencies are injectable for isolated tests; production callers need only element.
 * The backend must preserve closed-block duration in finish_task_block.
 */
export function mountCalendarNow(element, dependencies = {}) {
  const api = dependencies.invoke || defaultInvoke;
  const rank = dependencies.rankTasks || defaultRankTasks;
  const loadWeights = dependencies.loadWeights || loadCategoryWeights;
  const clock = dependencies.now || (() => new Date());
  const document = element.ownerDocument, window = document.defaultView;
  const prefix = `calendar-now-${++nextInstance}`;
  let saved = freshState(), initialized = false, snapshot = null;
  let disposed = false, busy = false, reading = false, readAgain = false;
  let readFlight = null, failure = null, panel = null, panelReturn = null, needsSave = false;
  let stateVersion = 0, currentState = 'loading';
  let goalDialog = null, goalPicker = null;
  let taskListExpanded = false;

  element.classList.add('calendar-now');
  element.classList.toggle('calendar-now--compact', dependencies.compact === true);
  element.innerHTML = `
    <section class="calendar-now__goal" aria-labelledby="${prefix}-goal-label ${prefix}-goal-title">
      <div class="calendar-now__goal-top"><p class="calendar-now__eyebrow" id="${prefix}-goal-label"><span class="calendar-now__goal-symbol" aria-hidden="true">${ICONS.flag}</span>Главная цель</p><button type="button" data-action="open-goal" class="calendar-now__quiet" aria-label="Сменить главную цель" aria-haspopup="dialog"><span class="calendar-now__button-icon" data-ui="goal-change-icon" aria-hidden="true" hidden>${ICONS.cycle}</span><span data-action-label>Выбрать цель</span></button></div>
      <h2 id="${prefix}-goal-title"><button type="button" data-action="goal-details" class="calendar-now__goal-link" aria-haspopup="dialog" hidden><span data-ui="goal-title"></span><span class="calendar-now__button-icon" aria-hidden="true">${ICONS.arrowRight}</span></button><span data-ui="goal-empty"></span></h2>
      <span data-ui="goal-status" class="calendar-now__goal-status" hidden></span>
      <p data-ui="goal-stage" class="calendar-now__goal-stage" hidden></p>
      <p data-ui="goal-meta" class="calendar-now__goal-meta" hidden></p>
      <p data-ui="goal-hint" class="calendar-now__goal-hint" hidden></p>
      <div class="calendar-now__goal-actions">
        <button type="button" data-action="browse-goals" class="calendar-now__quiet" hidden>Все цели</button>
      </div>
    </section>
    <section class="calendar-now__card" data-ui="card" tabindex="-1" aria-labelledby="${prefix}-title" aria-busy="true">
      <p class="calendar-now__eyebrow">Сейчас</p>
      <p data-ui="status" class="calendar-now__status" hidden></p>
      <h2 id="${prefix}-title"><button type="button" data-action="task-details" class="calendar-now__task-link" aria-haspopup="dialog" hidden><span data-ui="title"></span><span class="calendar-now__button-icon" aria-hidden="true">${ICONS.arrowRight}</span></button><span data-ui="title-empty"></span></h2>
      <p data-ui="meta" class="calendar-now__meta"></p>
      <p data-ui="support" class="calendar-now__support" hidden></p>
      <div class="calendar-now__actions">
        <button type="button" data-action="start" class="calendar-now__primary" hidden>${buttonContent('play', 'Начать')}</button>
        <button type="button" data-action="pause" class="calendar-now__primary" hidden>${buttonContent('pause', 'Пауза')}</button>
        <button type="button" data-action="finish" class="calendar-now__secondary" hidden>${buttonContent('check', 'Завершить')}</button>
        <button type="button" data-action="switch-task" class="calendar-now__quiet" title="Остановить выполнение и выбрать другую задачу. Учтённое время сохранится." hidden>${buttonContent('switch', 'Сменить задачу')}</button>
        <button type="button" data-action="open-task" class="calendar-now__secondary" aria-controls="${prefix}-tasks" aria-expanded="false" hidden>${buttonContent('switch', 'Сменить задачу')}</button>
        <button type="button" data-action="next" class="calendar-now__primary" hidden>${buttonContent('arrowRight', 'Следующая задача')}</button>
        <button type="button" data-action="choose-goal" class="calendar-now__primary" hidden>${buttonContent('target', 'Выбрать цель')}</button>
        <button type="button" data-action="calendar" class="calendar-now__secondary" hidden>${buttonContent('calendar', 'Открыть календарь')}</button>
      </div>
      <form data-ui="task-form" id="${prefix}-tasks" class="calendar-now__picker" hidden>
        <div data-ui="task-alternatives" class="calendar-now__alternatives"></div>
        <div class="calendar-now__picker-actions"><button type="button" data-action="all-tasks" class="calendar-now__secondary" aria-controls="${prefix}-all-tasks" aria-expanded="false">Все подходящие задачи</button><button type="button" data-action="cancel-picker" class="calendar-now__quiet">Отмена</button></div>
        <div data-ui="task-full" id="${prefix}-all-tasks" class="calendar-now__full-picker" hidden>
          <label for="${prefix}-task-select">Задача на сейчас</label>
          <select id="${prefix}-task-select" data-ui="task-select"></select>
          <div class="calendar-now__picker-actions"><button type="submit" class="calendar-now__primary">Выбрать</button><button type="button" data-action="auto" class="calendar-now__quiet">По рекомендации</button></div>
        </div>
      </form>
    </section>
    <div data-ui="error" class="calendar-now__error" role="alert" hidden><p data-ui="error-text"></p><button type="button" data-action="retry" class="calendar-now__secondary">Повторить</button></div>
    <span data-ui="live" class="calendar-now__sr" role="status" aria-live="polite"></span>`;
  const ui = Object.fromEntries([...element.querySelectorAll('[data-ui]')].map(node => [node.dataset.ui, node]));
  const actions = Object.fromEntries([...element.querySelectorAll('[data-action]')].map(node => [node.dataset.action, node]));
  const announce = text => { if (!disposed) ui.live.textContent = text; };
  const localDate = () => dateOf(clock());
  const selectedGoal = () => snapshot?.goals.find(goal => String(goal.id) === saved.goalId);
  const goalDateLabel = value => validDate(value) ? new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const descendantGoalIds = goalId => {
    const ids = new Set([String(goalId)]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      snapshot.goals.forEach(goal => {
        const id = String(goal.id);
        if (ids.has(String(goal.parent_goal_id)) && !ids.has(id)) { ids.add(id); expanded = true; }
      });
    }
    return ids;
  };
  function openGoalDetails() {
    const goal = selectedGoal();
    if (!goal || disposed) return;
    if (goalDialog?.isConnected) return;
    closePicker();
    const modal = document.createElement('dialog'); modal.className = 'calendar-goal-dialog';
    let restore = true;
    const heading = document.createElement('h2'); heading.id = `${prefix}-goal-detail-title`; heading.textContent = goal.title; heading.tabIndex = -1;
    modal.setAttribute('aria-labelledby', heading.id);
    const status = document.createElement('p'); status.className = 'calendar-goal-dialog__status'; status.textContent = 'Показана на дашборде';
    const date = document.createElement('p'); date.textContent = goalDateLabel(goal.deadline) ? `Срок: ${goalDateLabel(goal.deadline)}` : 'Срок не задан';
    const header = document.createElement('header'); header.className = 'calendar-goal-dialog__header';
    const label = document.createElement('p'); label.textContent = 'Главная цель';
    const topClose = document.createElement('button'); topClose.type = 'button'; topClose.textContent = '×'; topClose.className = 'calendar-goal-dialog__close'; topClose.dataset.goalClose = ''; topClose.setAttribute('aria-label', 'Закрыть цель'); topClose.onclick = () => modal.close();
    header.append(label, topClose);
    const body = document.createElement('div'); body.className = 'calendar-goal-dialog__body'; body.append(heading, status, date);
    modal.append(header, body);
    const addSection = (title, content) => {
      const label = document.createElement('h3'); label.textContent = title;
      body.append(label, content);
    };
    if (String(goal.description || '').trim()) {
      const description = document.createElement('p'); description.className = 'calendar-goal-dialog__description'; description.textContent = goal.description;
      addSection('Результат', description);
    }
    const criteria = String(goal.criteria || '').split('\n').map(line => line.trim()).filter(Boolean);
    const stages = snapshot.goals.filter(item => String(item.parent_goal_id) === String(goal.id));
    for (const [label, entries] of [['Готово, когда', criteria], ['Подцели', stages.map(item => item.title)]]) {
      if (!entries.length) continue;
      const list = document.createElement('ul'); list.className = 'calendar-goal-dialog__list';
      for (const text of entries) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
      addSection(label, list);
    }
    if (String(goal.unit || '').trim() && Number.isFinite(goal.target_value) && goal.target_value > 0 && Number.isFinite(goal.current_value)) {
      const measure = document.createElement('p'); measure.textContent = `Учтено: ${goal.current_value} из ${goal.target_value} ${goal.unit}`; body.append(measure);
    }
    const goalIds = descendantGoalIds(goal.id);
    const links = snapshot.links.filter(link => goalIds.has(String(link.goal_id)));
    const counts = ['note', 'event', 'schedule'].map(kind => [kind, new Set(links.filter(link => link.source_type === kind).map(link => String(link.source_id))).size]);
    if (counts.some(([, count]) => count > 0)) {
      const label = document.createElement('h3'); label.textContent = 'Связанные записи';
      const list = document.createElement('dl');
      for (const [kind, count] of counts.filter(([, value]) => value > 0)) {
        const term = document.createElement('dt'); term.textContent = { note: 'Задачи', event: 'События', schedule: 'Повторения' }[kind];
        const value = document.createElement('dd'); value.textContent = String(count); list.append(term, value);
      }
      body.append(label, list);
    } else {
      const empty = document.createElement('p'); empty.textContent = 'Пока нет связанных записей. Цель можно сохранить без задач.'; body.append(empty);
    }
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Закрыть'; close.dataset.goalClose = '';
    close.onclick = () => modal.close();
    const footer = document.createElement('footer'); footer.className = 'calendar-goal-dialog__actions'; footer.append(close); modal.append(footer);
    if (dependencies.openGoals) {
      const manage = document.createElement('button'); manage.type = 'button'; manage.textContent = 'Редактировать цель'; manage.dataset.goalManage = '';
      manage.onclick = () => { restore = false; modal.close(); dependencies.openGoals(goal.id); };
      footer.prepend(manage);
    }
    modal.addEventListener('close', () => {
      const focused = document.activeElement;
      const focusOutside = focused !== document.body && !modal.contains(focused) && focused !== actions['goal-details'];
      modal.remove(); if (goalDialog === modal) goalDialog = null;
      if (restore && !disposed && element.isConnected && !focusOutside) {
        if (!actions['goal-details'].hidden && !actions['goal-details'].disabled) actions['goal-details'].focus();
        else if (!actions['open-goal'].disabled) actions['open-goal'].focus();
        else { ui['goal-title'].tabIndex = -1; ui['goal-title'].focus(); }
      }
    }, { once: true });
    modal.dispose = () => { restore = false; modal.close(); };
    goalDialog = modal; document.body.append(modal); modal.showModal(); heading.focus();
  }
  function candidates() {
    if (!snapshot || !selectedGoal()) return [];
    const goalIds = descendantGoalIds(saved.goalId);
    const linked = new Set(snapshot.links.filter(link => goalIds.has(String(link.goal_id))).map(keyOf));
    const nowMin = clock().getHours() * 60 + clock().getMinutes();
    const available = snapshot.planned.filter(task => {
      const match = /^([0-2]\d):([0-5]\d)/.exec(task.visible_from || '');
      const visibleFrom = match ? Number(match[1]) * 60 + Number(match[2]) : null;
      return linked.has(keyOf(task)) && !task.readonly && !task.completed && !task.is_active &&
        !['done', 'skipped'].includes(task.status_extra) && !(task.source_type === 'schedule' && task.tracking_mode === 'check') &&
        (visibleFrom == null || nowMin >= visibleFrom);
    });
    return rank(available, { nowMin, weights: snapshot.weights, pins: snapshot.pins });
  }
  function chosenTask() {
    if (snapshot?.active && saved.execution) return saved.execution.task;
    if (saved.execution) return saved.execution.task;
    if (saved.completed) return saved.completed;
    const available = candidates();
    return (saved.selectionMode === 'manual' && available.find(task => keyOf(task) === keyOf(saved.selection))) || available[0] || null;
  }
  function elapsedMinutes() {
    const task = chosenTask();
    if (!task || !snapshot) return 0;
    const sameOccurrence = block => task.source_type !== 'schedule' || !validDate(block.completion_date) || block.completion_date === task.completion_date;
    let seconds = snapshot.workTime?.key === keyOf(task) && snapshot.workTime.occurrence === task.completion_date
      ? snapshot.workTime.seconds : snapshot.blocks.filter(block => !block.is_active && keyOf(block) === keyOf(task) && sameOccurrence(block))
      .reduce((sum, block) => sum + Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60), 0);
    if (snapshot.active && keyOf(snapshot.active) === keyOf(task)) {
      const started = new Date(`${snapshot.active.date}T${snapshot.active.start_time}`);
      if (Number.isFinite(started.getTime())) seconds += Math.max(0, Math.floor((clock() - started) / 1000));
    }
    return Math.floor(seconds / 60);
  }
  function renderTime() {
    if (disposed) return;
    const task = chosenTask();
    if (['active', 'paused', 'completed'].includes(currentState)) {
      const actual = `${elapsedMinutes()} мин`;
      ui.meta.textContent = currentState === 'completed' ? `Учтено ${actual}` : task?.duration_minutes ? `${actual} из ${task.duration_minutes} мин` : `Учтено ${actual}`;
    } else ui.meta.textContent = task?.duration_minutes ? `${task.duration_minutes} мин` : '';
  }
  function options(select, values, selected) {
    select.replaceChildren(...values.map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    select.value = selected;
  }
  function openGoalPicker(trigger) {
    if (goalPicker || busy || reading || failure || !snapshot || snapshot.active || saved.completed) return;
    closePicker();
    const editor = createCalendarDialog({ document, title: 'Главная цель', hint: 'Выбери то, на чём хочешь сосредоточиться.',
      isCurrent: () => !disposed && element.isConnected,
      returnFocus: () => {
        if (trigger.isConnected && !trigger.disabled && !trigger.hidden) trigger.focus();
        else { ui['goal-title'].tabIndex = -1; ui['goal-title'].focus(); }
      }, onClose: () => { goalPicker = null; if (!disposed) render(); } });
    editor.modal.classList.add('calendar-goal-picker');
    editor.body.innerHTML = `<label class="calendar-editor-field" data-goal-search-field for="${prefix}-search">Найти цель<input type="search" id="${prefix}-search" data-goal-search autocomplete="off" placeholder="Название цели"></label><div data-goal-choices></div><p data-goal-empty role="status" hidden></p>`;
    goalPicker = { editor, query: editor.body.querySelector('[data-goal-search]'), list: editor.body.querySelector('[data-goal-choices]'), empty: editor.body.querySelector('[data-goal-empty]'), signature: '', working: false, requestedId: undefined, reportedFailure: null };
    goalPicker.query.addEventListener('input', renderGoalPicker);
    editor.body.addEventListener('click', event => {
      const button = event.target.closest('[data-goal-choice]');
      if (!button || button.disabled || editor.pending) return;
      const id = button.dataset.goalChoice || null;
      if (id === saved.goalId) { editor.close(); return; }
      void chooseDialogGoal(id);
    });
    editor.retry.addEventListener('click', () => chooseDialogGoal(goalPicker.requestedId, true));
    renderGoalPicker();
    editor.open(goalPicker.query.closest('[hidden]') ? editor.body.querySelector('[aria-current="true"]') || editor.body.querySelector('[data-goal-choice]') : goalPicker.query);
  }
  function renderGoalPicker() {
    if (!goalPicker) return;
    const picker = goalPicker, { editor, query, list, empty } = picker;
    const many = snapshot.goals.length >= 8;
    query.parentElement.hidden = !many;
    const filter = many ? query.value.trim().toLocaleLowerCase('ru') : '';
    const signature = JSON.stringify([saved.goalId, snapshot.goals.map(goal => [goal.id, goal.title, goal.deadline]), filter]);
    let restoreChoice;
    if (signature !== picker.signature) {
      picker.signature = signature;
      restoreChoice = list.contains(document.activeElement) ? document.activeElement.dataset.goalChoice : undefined;
      list.replaceChildren();
      const goals = [...snapshot.goals].sort((a, b) => Number(String(b.id) === saved.goalId) - Number(String(a.id) === saved.goalId))
        .filter(goal => !filter || goal.title.toLocaleLowerCase('ru').includes(filter));
      for (const [id, title, deadline] of [[null, 'Пока без цели'], ...goals.map(goal => [String(goal.id), goal.title, goal.deadline])]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-goal-choice'; button.dataset.goalChoice = id || '';
        const text = document.createElement('span'); text.textContent = title; button.append(text);
        const formattedDeadline = goalDateLabel(deadline);
        if (formattedDeadline) {
          const date = document.createElement('span'); date.className = 'calendar-goal-deadline'; date.textContent = `Срок: ${formattedDeadline}`; text.append(date);
        }
        if (id === saved.goalId) {
          button.setAttribute('aria-current', 'true');
          const badge = document.createElement('span'); badge.className = 'calendar-goal-current'; badge.textContent = id ? 'Главная' : 'Выбрано'; button.append(badge);
        }
        list.append(button);
      }
      empty.hidden = goals.length > 0;
      empty.textContent = filter ? 'По этому названию целей не найдено.' : 'Сохранённых целей пока нет. Добавь цель в разделе «Цели».';
    }
    list.querySelectorAll('button').forEach(button => { button.disabled = !!snapshot.active || !!saved.completed || !!failure; });
    editor.setPending(picker.working || busy || reading);
    if (restoreChoice !== undefined && !editor.pending) [...list.children].find(button => button.dataset.goalChoice === restoreChoice)?.focus();
    if (!picker.working && failure && picker.reportedFailure !== failure) {
      picker.reportedFailure = failure; editor.retry.hidden = false; editor.showError(failure.message);
    } else if (!picker.working && !failure && picker.reportedFailure) {
      picker.reportedFailure = null;
      const restore = document.activeElement === editor.error || document.activeElement === editor.retry;
      editor.showError(''); editor.retry.hidden = true;
      if (restore) (many ? query : list.querySelector('[aria-current="true"]') || list.querySelector('button')).focus();
    }
  }
  async function chooseDialogGoal(id, retry = false) {
    const picker = goalPicker;
    if (!picker || picker.working || busy || reading) return;
    picker.working = true; picker.requestedId = id; picker.editor.showError(''); picker.editor.retry.hidden = true; renderGoalPicker();
    try {
      if (retry && failure) {
        await run(failure.operation);
        if (failure) throw new Error(failure.message);
        // A failed preliminary refresh has not selected the requested goal yet.
        if (id !== undefined && saved.goalId !== id) await selectGoal(id);
      } else if (id !== undefined) await selectGoal(id);
      if (disposed || goalPicker !== picker) return;
      if (id === undefined) { picker.editor.showError(''); picker.editor.retry.hidden = true; return; }
      picker.working = false; picker.editor.setPending(false); picker.editor.close();
    } catch (error) {
      if (disposed || goalPicker !== picker) return;
      picker.editor.retry.hidden = false;
      picker.editor.showError(error?.message || 'Не удалось выбрать цель. Повтори выбор.');
    } finally {
      picker.working = false;
      if (!disposed && goalPicker === picker) renderGoalPicker();
    }
  }
  function closePicker(focus = false) {
    taskListExpanded = false;
    panel = null; ui['task-form'].hidden = true;
    actions['open-task'].setAttribute('aria-expanded', 'false');
    if (focus && panelReturn?.isConnected) panelReturn.focus();
  }
  function openPicker(kind, trigger) {
    if (kind === 'goal') { openGoalPicker(trigger); return; }
    if (panel === kind) { closePicker(true); return; }
    if (busy || reading || failure || snapshot?.active || saved.completed || (kind === 'task' && saved.execution)) return;
    closePicker(); panel = kind; panelReturn = trigger;
    renderTaskPicker(keyOf(chosenTask()));
    ui[`${kind}-form`].hidden = false;
    actions[`open-${kind}`].setAttribute('aria-expanded', 'true');
    (ui['task-alternatives'].querySelector('button') || ui['task-select']).focus();
  }
  function renderTaskPicker(selected = ui['task-select'].value) {
    const available = candidates();
    if (ui['task-full'].contains(document.activeElement)) taskListExpanded = true;
    const focusedKey = ui['task-alternatives'].contains(document.activeElement) ? document.activeElement.dataset.taskKey : null;
    const duration = task => { const minutes = taskOf(task).duration_minutes; return Number.isFinite(minutes) && minutes > 0 ? `${minutes} мин` : ''; };
    options(ui['task-select'], available.map(task => [keyOf(task), `${task.title}${duration(task) ? ` · ${duration(task)}` : ''}`]), available.some(task => keyOf(task) === selected) ? selected : keyOf(chosenTask()));
    ui['task-alternatives'].replaceChildren();
    for (const task of available.filter(task => keyOf(task) !== keyOf(chosenTask())).slice(0, 2)) {
      const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'calendar-now__alternative'; choice.dataset.action = 'select-task'; choice.dataset.taskKey = keyOf(task);
      const title = document.createElement('span'); title.textContent = task.title; choice.append(title);
      if (duration(task)) { const meta = document.createElement('span'); meta.className = 'calendar-now__alternative-time'; meta.textContent = duration(task); choice.append(meta); }
      ui['task-alternatives'].append(choice);
    }
    ui['task-alternatives'].hidden = !ui['task-alternatives'].childElementCount;
    actions['all-tasks'].hidden = ui['task-alternatives'].hidden;
    ui['task-full'].hidden = !ui['task-alternatives'].hidden && !taskListExpanded;
    actions['all-tasks'].setAttribute('aria-expanded', String(!ui['task-full'].hidden));
    if (focusedKey) ([...ui['task-alternatives'].querySelectorAll('button')].find(button => button.dataset.taskKey === focusedKey) || (ui['task-full'].hidden ? actions['all-tasks'] : ui['task-select'])).focus();
  }
  function render() {
    if (disposed) return;
    const task = chosenTask(), active = snapshot?.active;
    currentState = !snapshot ? 'loading' : active ? 'active' : saved.execution ? 'paused' : saved.completed ? 'completed' : task ? 'recommendation' : 'empty';
    element.dataset.state = currentState; element.dataset.taskKey = keyOf(task); element.dataset.selectionMode = saved.selectionMode;
    ui.card.setAttribute('aria-busy', String(busy || reading));
    const goal = selectedGoal();
    ui['goal-title'].textContent = goal?.title || (!snapshot ? 'Загружаем цель…' : saved.goalId ? 'Выбранная цель недоступна' : 'Выбери, к чему хочешь прийти');
    ui['goal-empty'].textContent = goal ? '' : ui['goal-title'].textContent;
    ui['goal-empty'].hidden = !!goal;
    ui['goal-status'].textContent = !snapshot || goal ? '' : saved.goalId ? 'Цель недоступна' : 'Главная цель не выбрана';
    ui['goal-status'].hidden = !snapshot || !!goal;
    const linkedGoal = snapshot?.links.find(link => keyOf(link) === keyOf(task));
    const branch = [], visited = new Set();
    let node = snapshot?.goals.find(item => String(item.id) === String(linkedGoal?.goal_id));
    while (node && !visited.has(String(node.id))) {
      visited.add(String(node.id)); branch.unshift(node);
      if (String(node.id) === String(goal?.id)) break;
      node = snapshot.goals.find(item => String(item.id) === String(node.parent_goal_id));
    }
    const isGoalBranch = goal && branch.length > 1 && String(branch[0].id) === String(goal.id);
    ui['goal-stage'].textContent = isGoalBranch ? `Текущий этап: ${branch.slice(1).map(item => item.title).join(' → ')}` : '';
    ui['goal-stage'].hidden = !isGoalBranch;
    ui['goal-meta'].textContent = goalDateLabel(goal?.deadline) ? `Срок: ${goalDateLabel(goal.deadline)}` : '';
    ui['goal-meta'].hidden = !ui['goal-meta'].textContent;
    ui['goal-hint'].textContent = !snapshot || goal ? '' : saved.goalId ? 'Выбери другую цель или сохрани новую.' : 'Цель можно сохранить без срока и без готового плана.';
    ui['goal-hint'].hidden = !ui['goal-hint'].textContent;
    actions['goal-details'].hidden = !goal;
    actions['goal-details'].disabled = busy || reading || !!failure;
    actions['browse-goals'].hidden = !!goal || !snapshot;
    actions['open-goal'].querySelector('[data-action-label]').textContent = goal ? 'Сменить' : 'Выбрать цель';
    ui['goal-change-icon'].hidden = !goal;
    actions['open-goal'].setAttribute('aria-label', goal ? 'Сменить главную цель' : 'Выбрать главную цель');
    actions['browse-goals'].parentElement.hidden = !!goal || !snapshot;
    actions['open-goal'].classList.toggle('calendar-now__primary', !goal);
    actions['open-goal'].classList.toggle('calendar-now__quiet', !!goal);
    actions['open-goal'].disabled = !!active || busy || reading || !!failure || !snapshot || !!saved.completed;
    actions['open-goal'].title = active ? 'Для смены цели поставь задачу на паузу' : '';
    const status = { active: 'В работе', paused: 'На паузе', completed: 'Завершено' }[currentState];
    ui.status.textContent = status || ''; ui.status.hidden = !status;
    ui.title.textContent = task?.title || (!snapshot ? 'Загружаем «Сейчас»…' : !selectedGoal() ? 'Выбери главную цель выше — здесь появится задача.' : 'Для этой цели пока нет подходящей задачи.');
    const canOpenTask = !!task && !!dependencies.openTaskDetails;
    actions['task-details'].hidden = !canOpenTask;
    actions['task-details'].disabled = busy || reading || !!failure;
    actions['task-details'].title = canOpenTask ? 'Открыть задачу' : '';
    ui['title-empty'].textContent = canOpenTask ? '' : ui.title.textContent;
    ui['title-empty'].hidden = canOpenTask;
    ui.support.hidden = currentState !== 'empty' || !selectedGoal();
    ui.support.textContent = selectedGoal() ? 'Свяжи задачу с целью в календаре. Запуск остаётся твоим решением.' : '';
    const visible = currentState === 'active' ? ['pause', 'finish', 'switch-task'] : currentState === 'paused' ? ['start', 'finish', 'switch-task'] : currentState === 'completed' ? ['next'] : currentState === 'recommendation' ? ['start', 'open-task'] : currentState === 'empty' && selectedGoal() ? ['calendar'] : [];
    for (const button of ui.card.querySelectorAll('.calendar-now__actions button')) {
      button.hidden = !visible.includes(button.dataset.action); button.disabled = busy || reading || !!failure;
    }
    actions.start.querySelector('[data-action-label]').textContent = currentState === 'paused' ? 'Продолжить' : 'Начать';
    if (active || busy) closePicker();
    if (panel === 'task' && !reading && !failure) renderTaskPicker();
    ui['task-alternatives'].querySelectorAll('button').forEach(button => { button.disabled = busy || reading || !!failure || !!active; });
    actions['all-tasks'].disabled = busy || reading || !!failure || !!active;
    ui.error.hidden = !failure || !!goalPicker;
    ui['error-text'].textContent = failure?.message || '';
    actions.retry.disabled = busy || reading;
    renderGoalPicker();
    renderTime();
    dependencies.onCurrentTaskChange?.({ key: keyOf(task), state: currentState });
  }
  async function persist() {
    needsSave = true;
    const value = JSON.stringify(saved);
    const write = stateWriteQueue.catch(() => {}).then(async () => {
      if (disposed) return false;
      await api('set_ui_state', { key: STATE_KEY, value });
      return true;
    });
    stateWriteQueue = write;
    if (await write && value === JSON.stringify(saved)) needsSave = false;
  }
  async function resolveTask(block, planned, state) {
    const execution = state.execution?.blockId === Number(block.id) && keyOf(state.execution.task) === keyOf(block) ? state.execution.task : null;
    const occurrence = validDate(block.completion_date) || execution?.completion_date;
    const fresh = planned.find(task => keyOf(task) === keyOf(block) && (block.source_type !== 'schedule' || !occurrence || task.completion_date === occurrence));
    if (fresh) return taskOf({ ...fresh, completion_date: occurrence || fresh.completion_date });
    // A title, estimate or due date can change while the timer stays on the same
    // record. Preserve its execution occurrence, but read current record fields.
    if (block.source_type === 'note' || block.source_type === 'event') {
      const row = block.source_type === 'note' ? await api('get_note', { id: String(block.source_id) })
        : (await api('get_all_events', {})).find(item => String(item.id) === String(block.source_id));
      if (!row) throw new Error('missing-record');
      return taskOf({ ...row, source_type: block.source_type, source_id: block.source_id, completion_date: occurrence || block.date });
    }
    const known = execution ||
      [state.selection, state.completed].find(task => keyOf(task) === keyOf(block) && (!occurrence || task.completion_date === occurrence));
    if (known) return taskOf({ ...known, completion_date: occurrence || known.completion_date });
    if (block.title) return taskOf({ ...block, completion_date: occurrence || block.date });
    let row;
    if (block.source_type === 'event') row = (await api('get_all_events', {})).find(item => String(item.id) === String(block.source_id));
    else if (block.source_type === 'note') row = await api('get_note', { id: String(block.source_id) });
    else if (block.source_type === 'schedule') row = (await api('get_schedules', { category: null })).find(item => String(item.id) === String(block.source_id));
    return taskOf({ ...row, source_type: block.source_type, source_id: block.source_id, title: row?.title || 'Текущая задача', completion_date: occurrence || block.date });
  }
  async function fetchSnapshot() {
    const date = localDate(), version = stateVersion;
    const state = initialized ? structuredClone(saved) : restoreState(await api('get_ui_state', { key: STATE_KEY }));
    const [goals, links, planned, active, todayBlocks, pins, weights] = await Promise.all([
      api('get_goals', { tabName: null }), api('get_calendar_task_goals', {}),
      api('get_calendar_records', { start: date, end: date }), api('get_active_block', {}), api('get_timeline_blocks', { date }),
      api('get_task_pins', {}).catch(() => []), loadWeights().catch(() => ({})),
    ]);
    const extraDates = [...new Set([active?.date, state.execution?.date].filter(value => value && value !== date))];
    const extraBlocks = await Promise.all(extraDates.map(value => api('get_timeline_blocks', { date: value })));
    const blocks = [...new Map([...todayBlocks, ...extraBlocks.flat()].map(block => [block.id, block])).values()];
    if (disposed || stateVersion !== version) return;
    const before = JSON.stringify(state);
    if (active) {
      const task = await resolveTask(active, planned, state);
      state.execution = { blockId: Number(active.id), date: active.date, task }; state.completed = null;
    } else if (state.execution) {
      const block = blocks.find(item => Number(item.id) === state.execution.blockId);
      let task = planned.find(item => keyOf(item) === keyOf(state.execution.task) &&
        (item.source_type !== 'schedule' || item.completion_date === state.execution.task.completion_date));
      // A paused note may be completed from All tasks while its due date is outside
      // today's projection. Read its authoritative status before offering Resume.
      if (block && !task && state.execution.task.source_type === 'note') {
        const note = await api('get_note', { id: String(state.execution.task.source_id) });
        if (!note) throw new Error('missing-note');
        task = { ...note, status_extra: note.status || note.status_extra };
      }
      if (block && !task && state.execution.task.source_type === 'event') {
        task = (await api('get_all_events', {})).find(item => String(item.id) === state.execution.task.source_id);
        if (!task) {
          if (block.is_active) throw new Error('missing-event');
          state.execution = null; state.selection = null; state.selectionMode = 'auto';
        }
      }
      if (block && task) {
        const previous = state.execution.task;
        state.execution.task = taskOf({ ...previous, ...task, source_type: previous.source_type, source_id: previous.source_id, completion_date: previous.completion_date });
      }
      if (!block) { state.execution = null; state.selection = null; state.selectionMode = 'auto'; }
      else if (task?.completed || task?.status_extra === 'done') { state.completed = state.execution.task; state.execution = null; }
    }
    const timedTask = state.execution?.task || state.completed;
    const workTime = timedTask ? { key: keyOf(timedTask), occurrence: timedTask.completion_date,
      seconds: Math.max(0, Number(await api('get_calendar_task_seconds', { sourceType: timedTask.source_type,
        sourceId: String(timedTask.source_id), completionDate: timedTask.completion_date })) || 0) } : null;
    if (disposed || stateVersion !== version) return;
    saved = state; initialized = true; snapshot = { date, goals: goals.filter(goal => goal.goal_kind !== 'daily_norm'), links, planned, active, blocks, pins, weights, workTime };
    if (saved.selectionMode === 'manual' && !saved.execution && !saved.completed && !candidates().some(task => keyOf(task) === keyOf(saved.selection))) {
      saved.selection = null; saved.selectionMode = 'auto';
    }
    if (JSON.stringify(saved) !== before || needsSave) await persist();
  }
  async function refresh() {
    if (disposed) return;
    if (busy || readFlight) { readAgain = true; return readFlight; }
    reading = true; render();
    readFlight = (async () => {
      try { await fetchSnapshot(); if (failure?.operation.kind === 'refresh') failure = null; }
      catch { if (!failure) failure = { operation: { kind: 'refresh', phase: 'refresh' }, message: 'Не удалось обновить «Сейчас». Последний выбор сохранён.' }; }
      finally { reading = false; readFlight = null; render(); if (readAgain && !busy && !disposed) { readAgain = false; void refresh(); } }
    })();
    return readFlight;
  }
  async function perform(operation) {
    if (operation.kind === 'goal') {
      if (snapshot.active || await api('get_active_block', {})) throw new Error('active');
      if (operation.goalId !== saved.goalId) {
        saved.goalId = operation.goalId;
        if (!saved.execution) { saved.selection = null; saved.selectionMode = 'auto'; }
      }
    } else if (operation.kind === 'select') {
      saved.selection = taskOf(operation.task); saved.selectionMode = 'manual';
    } else if (operation.kind === 'auto') {
      saved.selection = null; saved.selectionMode = 'auto';
    } else if (operation.kind === 'next') {
      saved.completed = null; saved.selection = null; saved.selectionMode = 'auto';
    } else {
      const active = await api('get_active_block', {});
      if (operation.kind === 'start') {
        if (active && keyOf(active) !== keyOf(operation.task)) throw new Error('different-active');
        const blockId = active?.id ?? await api('start_task_block', {
          sourceType: operation.task.source_type, sourceId: String(operation.task.source_id), failIfActive: true,
          completionDate: operation.task.completion_date || operation.task.date || localDate(),
        });
        saved.execution = { blockId: Number(blockId), date: active?.date || localDate(), task: taskOf(operation.task) }; saved.completed = null;
      } else {
        if (active && Number(active.id) !== operation.execution.blockId) throw new Error('different-active');
        if (operation.kind === 'pause' || operation.kind === 'switch-task') {
          if (active) await api('pause_task_block', { blockId: operation.execution.blockId });
          else {
            const blocks = await api('get_timeline_blocks', { date: operation.execution.date });
            if (!blocks.some(block => Number(block.id) === operation.execution.blockId && !block.is_active)) throw new Error('missing-block');
          }
          if (operation.kind === 'switch-task') {
            saved.execution = null; saved.completed = null; saved.selection = null; saved.selectionMode = 'auto';
          } else saved.execution = operation.execution;
        } else {
          await api('finish_task_block', { blockId: operation.execution.blockId });
          saved.completed = operation.execution.task; saved.execution = null;
        }
      }
    }
  }
  function errorMessage(error) { return typeof error === 'string' ? error : error?.message; }
  function failureMessage(operation, error) {
    const message = errorMessage(error);
    if (message === 'active') return 'Для смены цели поставь текущую задачу на паузу.';
    if (message === 'different-active') return 'Сейчас запущена другая задача. Обнови экран перед продолжением.';
    if (operation.kind === 'start' && message === 'source record not found') return 'Задача уже завершена или недоступна. Обнови экран.';
    if (operation.phase === 'save') return 'Действие применено, но не удалось сохранить выбор. Повтор сохранит его без повторного запуска задачи.';
    if (operation.phase === 'refresh') return 'Не удалось обновить «Сейчас». Последний выбор сохранён.';
    return ({ start: 'Не удалось запустить задачу.', pause: 'Не удалось поставить задачу на паузу.', finish: 'Не удалось завершить задачу.', 'switch-task': 'Не удалось сменить задачу. Текущая задача сохранена.' })[operation.kind] || 'Не удалось сохранить выбор.';
  }
  async function run(operation) {
    if (disposed || busy || reading) return;
    busy = true; stateVersion++; failure = null; closePicker(); render();
    try {
      if (!operation.phase || operation.phase === 'action') { operation.phase = 'action'; await perform(operation); operation.phase = 'save'; }
      if (disposed) return;
      if (operation.phase === 'save') { await persist(); operation.phase = 'refresh'; }
      await fetchSnapshot();
      announce(({ start: 'Задача в работе.', pause: 'Задача приостановлена.', finish: 'Задача завершена.', 'switch-task': 'Выполнение остановлено. Учтённое время сохранено. Выбери другую задачу.', goal: 'Цель выбрана.', select: 'Задача выбрана. Нажми «Начать», когда будешь готов.' })[operation.kind] || 'Выбор обновлён.');
    } catch (error) {
      failure = { operation, message: failureMessage(operation, error) };
      // A different active task is never closed implicitly by this surface.
      const message = errorMessage(error);
      if (message === 'different-active' || (operation.kind === 'start' && message === 'source record not found')) {
        failure.operation = { kind: 'refresh', phase: 'refresh' };
      }
    } finally {
      busy = false; render();
      if (disposed && ['start', 'pause', 'finish', 'switch-task'].includes(operation.kind)) {
        // The command may have committed after navigation; the current mount rereads DB.
        window.dispatchEvent(new window.Event('task-state-changed'));
        window.dispatchEvent(new window.CustomEvent('hanni:calendar-refresh'));
      }
      if (!disposed) {
        if (!goalPicker) {
          if (failure) actions.retry.focus();
          else (ui.card.querySelector('.calendar-now__actions button:not([hidden])') || ui.card).focus();
        }
        if (!failure && operation.kind === 'switch-task' && selectedGoal()) openPicker('task', actions['open-task']);
        if (['start', 'pause', 'finish', 'switch-task'].includes(operation.kind) && operation.phase === 'refresh') {
          window.dispatchEvent(new window.Event('task-state-changed'));
          window.dispatchEvent(new window.CustomEvent('hanni:calendar-refresh'));
        }
        if (readAgain) { readAgain = false; void refresh(); }
      }
    }
  }
  const onClick = event => {
    const button = event.target.closest('[data-action]'); if (!button || !element.contains(button) || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'cancel-picker') { closePicker(true); return; }
    if (action === 'open-goal' || action === 'choose-goal') { openPicker('goal', button); return; }
    if (action === 'open-task') { openPicker('task', button); return; }
    if (action === 'task-details') {
      const task = chosenTask();
      if (task) dependencies.openTaskDetails?.({ ...task, completed: !!saved.completed, is_active: currentState === 'active', status_extra: saved.completed ? 'done' : 'task', actual_minutes: elapsedMinutes() }, () => {
        if (!disposed && element.isConnected) (actions['task-details'].hidden ? ui.card : actions['task-details']).focus();
      });
      return;
    }
    if (action === 'goal-details') { openGoalDetails(); return; }
    if (action === 'calendar') {
      if (dependencies.openCalendar) dependencies.openCalendar();
      else window.dispatchEvent(new window.CustomEvent('hanni:calendar-open-table'));
      return;
    }
    if (action === 'browse-goals') {
      if (dependencies.openGoals) dependencies.openGoals();
      else window.dispatchEvent(new window.CustomEvent('hanni:calendar-open-goals'));
      return;
    }
    if (action === 'retry') { if (failure) void run(failure.operation); return; }
    if (busy || reading || failure) return;
    if (action === 'all-tasks') {
      if (panel !== 'task' || snapshot?.active || saved.execution || saved.completed) return;
      taskListExpanded = !taskListExpanded; ui['task-full'].hidden = !taskListExpanded;
      button.setAttribute('aria-expanded', String(taskListExpanded));
      (taskListExpanded ? ui['task-select'] : button).focus();
      return;
    }
    if (action === 'select-task') {
      if (panel !== 'task' || snapshot?.active || saved.execution || saved.completed) return;
      const task = candidates().find(task => keyOf(task) === button.dataset.taskKey);
      if (task) void run({ kind: 'select', task: taskOf(task) });
      return;
    }
    if (action === 'start') { const task = chosenTask(); if (task) void run({ kind: 'start', task: taskOf(task) }); }
    else if (action === 'pause' || action === 'finish' || action === 'switch-task') { if (saved.execution) void run({ kind: action, execution: structuredClone(saved.execution) }); }
    else if (action === 'next' || action === 'auto') void run({ kind: action });
  };
  const onSubmit = event => {
    if (event.target !== ui['task-form']) return;
    event.preventDefault(); if (busy || reading || failure || snapshot?.active) return;
    if (saved.execution) return;
    const task = candidates().find(value => keyOf(value) === ui['task-select'].value);
    if (task) void run({ kind: 'select', task: taskOf(task) });
  };
  const onKeydown = event => { if (event.key === 'Escape' && panel) { event.preventDefault(); closePicker(true); } };
  const onExternal = () => { void refresh(); };
  element.addEventListener('click', onClick); element.addEventListener('submit', onSubmit); element.addEventListener('keydown', onKeydown);
  window.addEventListener('task-state-changed', onExternal);
  window.addEventListener('focus', onExternal);
  const timer = window.setInterval(() => { if (snapshot && localDate() !== snapshot.date && !busy && !reading) void refresh(); renderTime(); }, 1000);
  void refresh();
  const dispose = () => {
    disposed = true; stateVersion++; goalDialog?.dispose(); goalPicker?.editor.dispose(); window.clearInterval(timer);
    element.removeEventListener('click', onClick); element.removeEventListener('submit', onSubmit); element.removeEventListener('keydown', onKeydown);
    window.removeEventListener('task-state-changed', onExternal); window.removeEventListener('focus', onExternal);
  };
  // Goal cards share this mount's save queue and preserve paused execution.
  async function selectGoal(value) {
    if (disposed || busy) throw new Error('Дождись завершения текущего действия.');
    if (readFlight) await readFlight;
    await refresh();
    const goalId = value == null ? null : String(value);
    if (disposed || busy || reading || failure || !snapshot) throw new Error('Не удалось обновить текущую задачу. Повтори выбор.');
    if (snapshot.active) throw new Error('Для смены цели поставь текущую задачу на паузу.');
    if (saved.completed) throw new Error('Нажми «Следующая задача» перед сменой цели.');
    if (goalId && !snapshot.goals.some(goal => String(goal.id) === goalId)) throw new Error('Эта цель больше недоступна.');
    if (goalId === saved.goalId) return;
    await run({ kind: 'goal', goalId });
    if (failure) throw new Error(failure.message);
  }
  dispose.selectGoal = selectGoal;
  return dispose;
}
