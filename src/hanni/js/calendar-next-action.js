import { isInstantTask, taskTime } from './task-model.js';
import { createRecurringStore, recurringItems, unfinishedRun, dateKey, recurringSourceId } from './calendar-recurring-store.js';
import { readActiveBlocks } from './calendar-execution.js';
import { readProcessState, taskStage } from './task-processes.js';
import { jiraCanRecommend } from './jira-workflow-model.js';

const deferred = new Map();
const keyOfTask = task => `task:${task.source_type}:${String(task.source_id)}`;
const keyOfRoutine = (id, date) => `routine:${id}:${date}`;
const validClock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const safeText = value => String(value ?? '');

function routineStepTitles(item) {
  return [item.title, ...(item.steps || []).map(step => step.title)].filter(Boolean).join(' ');
}

function routinePeriod(item) {
  const text = routineStepTitles(item).toLocaleLowerCase('ru');
  if (/\b(morning|breakfast)\b|утр(?:о|ом|а|ен\p{L}*)|завтрак/u.test(text)) return 'morning';
  if (/\b(lunch|noon)\b|обед\p{L}*/u.test(text)) return 'lunch';
  if (/\b(evening|dinner|supper)\b|вечер\p{L}*|ужин\p{L}*/u.test(text)) return 'evening';
  if (/^(еда|поесть|приём пищи|прием пищи|meal)$/iu.test(String(item.title || '').trim())) return 'meal';
  return '';
}

function activeRoutineId(block) {
  if (block?.source_type !== 'schedule') return null;
  try {
    const parsed = JSON.parse(String(block.source_id));
    return Array.isArray(parsed) && parsed.length === 3 ? String(parsed[0]) : null;
  } catch { return null; }
}

function taskGoalPath(task, links, goals) {
  const link = links.find(item => item.source_type === task.source_type && String(item.source_id) === String(task.source_id));
  if (!link || link.goal_id == null) return '';
  const chain = [], seen = new Set();
  let goal = goals.find(item => String(item.id) === String(link.goal_id));
  while (goal && !seen.has(String(goal.id))) {
    seen.add(String(goal.id)); chain.unshift(goal); goal = goals.find(item => String(item.id) === String(goal.parent_goal_id));
  }
  return chain.map(item => safeText(item.title).trim()).filter(Boolean).join(' / ');
}

function taskContext(task, links = [], goals = [], processes = []) {
  const stage = taskStage(task, processes);
  return {
    goal: taskGoalPath(task, links, goals),
    stage: stage && (stage.label || stage.waiting) ? stage.label : '',
    waiting: Boolean(stage?.waiting),
    jiraStatus: safeText(task.jira_status),
  };
}

function explainTask(task, now, today) {
  const date = typeof task.date === 'string' ? task.date : '';
  const time = taskTime(task);
  if (date === today && time && validClock(time)) {
    const planned = new Date(`${today}T${time}:00`).getTime();
    const delta = planned - now.getTime();
    if (delta <= 0) return { score: 850, reason: `Запланировано на сегодня, ${time}.` };
    if (delta <= 2 * 60 * 60 * 1000) return { score: 820, reason: `Запланировано на сегодня, ${time}.` };
  }
  if (Number(task.priority) >= 5) return { score: 680, reason: date && date < today ? 'Важная задача, запланированная на более ранний день.' : 'Ты отметил задачу как важную.' };
  if (date && date < today) return { score: 360, reason: 'Задача запланирована на более ранний день.' };
  if (date === today) return { score: 650, reason: 'Задача запланирована на сегодня.' };
  if (date && date > today) return { score: 220, reason: `Задача запланирована на ${date}.` };
  return { score: 300, reason: 'Задача без заданного срока.' };
}

function explainRoutine(item, now, today) {
  const clock = String(item.time || '');
  if (validClock(clock)) {
    const planned = new Date(`${today}T${clock}:00`).getTime();
    const delta = planned - now.getTime();
    if (delta <= 0) return { score: 880, reason: `Время рутины — ${clock}.` };
    if (delta <= 2 * 60 * 60 * 1000) return { score: 810, reason: `Время рутины — ${clock}.` };
    return { score: 180, reason: `По расписанию — ${clock}.` };
  }
  const period = routinePeriod(item), hour = now.getHours();
  if (period === 'morning' && hour >= 5 && hour < 12) return { score: 560, reason: 'Утро — рутина ещё не отмечена.' };
  if (period === 'lunch' && hour >= 11 && hour < 16) return { score: 560, reason: 'Время обеда — рутина ещё не отмечена.' };
  if (period === 'evening' && hour >= 17 && hour < 24) return { score: 560, reason: 'Вечер — рутина ещё не отмечена.' };
  if (period === 'meal' && (hour >= 7 && hour < 11 || hour >= 12 && hour < 16 || hour >= 18 && hour < 22)) return { score: 560, reason: 'Можно сделать перерыв на еду — рутина ещё не отмечена.' };
  return { score: 250, reason: item.required === false ? 'Необязательное дело на сегодня.' : 'Повторяющееся дело на сегодня.' };
}

/** Pure ranking function for a snapshot. It never starts work or changes routine status. */
export function rankNextAction({ now = new Date(), tasks = [], routines = [], activeBlocks = [], deferredKeys = new Set(), links = [], goals = [], processes = [] } = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('now must be a valid date');
  const today = dateKey(instant), candidates = [], activeTasks = [], activeRoutines = [];
  const activeTaskKeys = new Set(activeBlocks.filter(row => row?.source_type === 'note').map(row => `task:note:${String(row.source_id)}`));
  const activeRoutineKeys = new Set(activeBlocks.filter(row => row?.source_type === 'schedule').map(activeRoutineId).filter(Boolean));
  for (const task of tasks) {
    if (!task || task.source_type !== 'note' || task.completed || task.archived || task.readonly || task.status_extra && task.status_extra !== 'task') continue;
    const key = keyOfTask(task), active = Boolean(task.is_active || activeTaskKeys.has(key));
    const context = taskContext(task, links, goals, processes);
    if (active) { activeTasks.push({ key, type: 'task', title: safeText(task.title) || 'Задача', reason: 'Задача уже выполняется.', action: 'open', task, context }); continue; }
    if (!jiraCanRecommend(task)) continue;
    const progress = Boolean(task.has_work || Number(task.actual_seconds) > 0 || Number(task.actual_minutes) > 0);
    const urgency = explainTask(task, instant, today);
    candidates.push({ key, type: 'task', title: safeText(task.title) || 'Задача', reason: progress ? `На паузе. ${urgency.reason}` : urgency.reason, action: context.waiting ? 'review' : isInstantTask(task) ? 'finish' : 'start', task, context, score: urgency.score + (progress ? 80 : 0) });
  }
  for (const item of routines) {
    if (!item || item.kind !== 'action' || item.status !== 'pending') continue;
    const run = item.run;
    const active = activeRoutineKeys.has(String(item.id));
    const date = item.runDate || today;
    if (active) { activeRoutines.push({ key: keyOfRoutine(item.id, date), type: 'routine', title: safeText(item.title) || 'Повторяющееся дело', reason: 'Выполнение уже запущено.', action: 'open', routine: item, date, run }); continue; }
    // Only actual routine activities can be launched; a check-only action is explicitly marked done.
    if (!['check', 'activity', 'chain', 'graph'].includes(item.mode)) continue;
    const urgency = explainRoutine(item, instant, today);
    candidates.push({ key: keyOfRoutine(item.id, date), type: 'routine', title: safeText(item.title) || 'Повторяющееся дело', reason: run ? `На паузе. ${urgency.reason}` : urgency.reason, action: item.mode === 'check' ? 'done' : 'start', routine: item, date, run, score: urgency.score + (run ? 90 : 0) });
  }
  const available = candidates.filter(item => !deferredKeys.has(item.key));
  available.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'ru') || a.key.localeCompare(b.key));
  const active = [...activeTasks, ...activeRoutines].filter(item => !deferredKeys.has(item.key)).sort((a, b) => a.title.localeCompare(b.title, 'ru') || a.key.localeCompare(b.key))[0];
  return active || available[0] || null;
}

function normalizedPreferences(value = {}) {
  return { enabled: value.enabled !== false, includeTasks: value.includeTasks !== false, includeRoutines: value.includeRoutines !== false };
}

export function mountCalendarNextAction(element, dependencies) {
  const { invoke, openTask, executeTask, openRoutine, notifyChange, onOpenSettings } = dependencies;
  const document = element.ownerDocument, window = document.defaultView;
  const clock = dependencies.clock || (() => new Date());
  const store = createRecurringStore(invoke, { now: clock });
  let preferences = normalizedPreferences(dependencies.preferences), disposed = false, revision = 0, busy = false, preferencesChangedWhileBusy = false, snapshot = null, recommendation = null, currentTaskKey = '', focusedTaskKey = '', renderedKey = '', error = '', feedback = '', lastDay = '', focusTarget = null, refreshQueued = false;

  element.classList.add('calendar-next-action');
  if (!dependencies.hideHeading) element.setAttribute('aria-labelledby', 'calendar-next-action-title');

  const getNow = () => { const value = clock(); return value instanceof Date ? value : new Date(value); };
  const getDeferred = now => {
    const today = dateKey(now);
    if (lastDay && today !== lastDay) deferred.clear();
    lastDay = today;
    for (const [key, value] of deferred) if (value.day !== today || value.until <= now.getTime()) deferred.delete(key);
    return new Set(deferred.keys());
  };
  const selection = data => {
    const now = getNow();
    if (currentTaskKey && preferences.includeTasks) {
      const currentTask = data.tasks.find(task => task.source_type === 'note' && !task.completed && !task.archived && !task.readonly && (!task.status_extra || task.status_extra === 'task') && keyOfTask(task) === currentTaskKey);
      if (currentTask && (jiraCanRecommend(currentTask) || data.activeBlocks.some(block => keyOfTask(block) === currentTaskKey))) {
        const active = Boolean(currentTask.is_active || data.activeBlocks.some(block => keyOfTask(block) === currentTaskKey));
        const context = taskContext(currentTask, data.links, data.goals, data.processes);
        const urgency = explainTask(currentTask, now, data.today);
        const hasWork = Boolean(currentTask.has_work || Number(currentTask.actual_seconds) > 0 || Number(currentTask.actual_minutes) > 0);
        return { key: currentTaskKey, type: 'task', title: safeText(currentTask.title) || 'Задача',
          reason: active ? 'Задача уже выполняется.' : hasWork ? `На паузе. ${urgency.reason}` : urgency.reason,
          action: active ? 'open' : context.waiting ? 'review' : isInstantTask(currentTask) ? 'finish' : 'start', task: currentTask, context };
      }
      // A confirmed successful snapshot no longer contains the selected open task.
      currentTaskKey = '';
    }
    const routines = new Map(data.routines.map(item => [item.id, item]));
    if (preferences.includeRoutines) {
      const ids = new Set([...data.state.plans.map(plan => plan.id), ...Object.values(data.state.days).flatMap(records => Object.keys(records))]);
      for (const id of ids) {
        const unfinished = unfinishedRun(data.state, id);
        if (unfinished) routines.set(id, { ...(routines.get(id) || unfinished.record.snapshot), status: 'pending', run: unfinished.record.run, runDate: unfinished.date });
      }
    }
    const selected = rankNextAction({ now, tasks: preferences.includeTasks ? data.tasks : [], routines: preferences.includeRoutines ? [...routines.values()] : [], activeBlocks: data.activeBlocks, deferredKeys: getDeferred(now), links: data.links, goals: data.goals, processes: data.processes });
    // Once an active task is the current recommendation, keep that identity
    // through a pause. This is view state only; ranking and timer records stay untouched.
    if (selected?.type === 'task' && selected.action === 'open') currentTaskKey = selected.key;
    return selected;
  };

  function render() {
    if (disposed) return;
    const selected = recommendation;
    const hasWork = Boolean(selected?.type === 'task' && (selected.task?.has_work || Number(selected.task?.actual_seconds) > 0 || Number(selected.task?.actual_minutes) > 0));
    const compactRunning = Boolean(dependencies.compactRunning && selected?.type === 'task' && (selected.action === 'open' || hasWork) && focusedTaskKey === selected.key);
    element.dataset.running = String(!!compactRunning);
    const signature = JSON.stringify([preferences, selected && [selected.key, selected.type, selected.title, selected.reason, selected.action, selected.context], compactRunning, Boolean(error), feedback, Boolean(snapshot), busy]);
    if (signature === renderedKey) {
      const retry = element.querySelector('[data-next-action-retry]'); if (retry) retry.disabled = busy;
      element.querySelectorAll('[data-next-action-action]').forEach(button => { button.disabled = busy; });
      dependencies.onSelectionChange?.(selected?.type === 'task' ? { key: selected.key, type: 'task', action: selected.action, task: selected.task } : null);
      return;
    }
    const active = element.contains(document.activeElement) ? document.activeElement.dataset.nextActionAction || document.activeElement.dataset.nextActionSetting || document.activeElement.hasAttribute('data-next-action-retry') && 'retry' : focusTarget;
    renderedKey = signature;
    const section = document.createElement('section'); section.className = 'calendar-next-action__surface';
    const header = document.createElement('header');
    const heading = document.createElement('h2'); heading.id = 'calendar-next-action-title'; heading.tabIndex = -1; heading.textContent = compactRunning ? 'Сейчас' : 'Что сделать сейчас'; header.append(heading);
    if (onOpenSettings) { const settings = document.createElement('button'); settings.type = 'button'; settings.dataset.nextActionSetting = 'settings'; settings.textContent = 'Настроить'; settings.disabled = busy; settings.addEventListener('click', () => onOpenSettings(settings)); header.append(settings); }
    if (!dependencies.hideHeading) section.append(header);
    if (!preferences.enabled) {
      const copy = document.createElement('p'); copy.textContent = 'Рекомендации выключены.'; section.append(copy);
    } else if (!snapshot && !error) {
      const copy = document.createElement('p'); copy.textContent = 'Загружаем задачи и дела…'; section.append(copy);
    } else if (selected) {
      const card = document.createElement('div'); card.className = 'calendar-next-action__item'; card.dataset.nextActionKey = selected.key;
      const title = document.createElement('h3'); title.textContent = selected.title; if (!compactRunning) card.append(title);
      const why = document.createElement('p'); why.className = 'calendar-next-action__reason'; why.textContent = selected.reason; if (!compactRunning) card.append(why);
      if (!compactRunning && selected.type === 'routine') {
        const context = document.createElement('p'); context.className = 'calendar-next-action__context';
        const count = selected.routine.steps?.length || 0;
        context.textContent = selected.routine.mode === 'check' ? 'Рутина · отметка без таймера' : count > 1 ? `Рутина · шагов: ${count}` : 'Рутина · с учётом времени';
        card.append(context);
      }
      if (!compactRunning && selected.type === 'task' && (selected.context?.goal || selected.context?.stage || selected.context?.waiting || selected.context?.jiraStatus)) {
        const context = document.createElement('p'); context.className = 'calendar-next-action__context'; context.dataset.nextActionContext = '';
        const parts = [];
        if (selected.context.goal) parts.push(`Цель: ${selected.context.goal}`);
        if (selected.context.jiraStatus) parts.push(`Jira: ${selected.context.jiraStatus}`);
        if (selected.context.stage) parts.push(`Этап: ${selected.context.stage}`);
        if (selected.context.waiting) parts.push('Жду ответа');
        context.textContent = parts.join(' · ');
        if (selected.context.goal) context.title = `Цель: ${selected.context.goal}`;
        card.append(context);
      }
      const actions = document.createElement('div'); actions.className = 'calendar-next-action__actions';
      if (selected.action === 'open') {
        const open = button('Открыть текущее', 'open', () => activate('open')); actions.append(open);
      } else if (selected.action === 'done' || selected.action === 'finish') {
        actions.append(button('Отметить выполненным', 'done', () => activate('done')));
      } else if (selected.action === 'review') {
        actions.append(button('Проверить задачу', 'review', () => activate('review')));
      } else {
        actions.append(button(selected.action === 'start' && (selected.task?.has_work || selected.task?.actual_seconds > 0 || selected.task?.actual_minutes > 0 || selected.run) ? 'Продолжить' : 'Начать', 'start', () => activate('start')));
        if (selected.type === 'task' || selected.run) actions.append(button('Открыть', 'open', () => activate('details')));
      }
      actions.append(button('Не предлагать час', 'later', () => deferCurrent()));
      if (!compactRunning) { card.append(actions); section.append(card); }
    } else if (snapshot) {
      const copy = document.createElement('p'); copy.textContent = 'Подходящей задачи или дела сейчас нет.'; section.append(copy);
    }
    if (feedback) { const status = document.createElement('p'); status.className = 'calendar-next-action__feedback'; status.setAttribute('role', 'status'); status.textContent = feedback; section.append(status); }
    if (error) { const alert = document.createElement('p'); alert.className = 'calendar-next-action__error'; alert.setAttribute('role', 'alert'); alert.textContent = snapshot ? `Не удалось обновить рекомендации. Показан последний результат. ${error}` : `Не удалось загрузить рекомендации. ${error}`; section.append(alert); const retry = button('Повторить загрузку', 'retry', () => refresh()); retry.dataset.nextActionRetry = ''; section.append(retry); }
    section.setAttribute('aria-busy', String(busy || !snapshot && !error));
    element.replaceChildren(section);
    if (active) {
      const target = active === 'retry' ? section.querySelector('[data-next-action-retry]') : section.querySelector(`[data-next-action-action="${active}"]`) || section.querySelector(`[data-next-action-setting="${active}"]`);
      (target || section.querySelector('h2'))?.focus({ preventScroll: true });
    }
    dependencies.onSelectionChange?.(selected?.type === 'task' ? { key: selected.key, type: 'task', action: selected.action, task: selected.task } : null);
  }
  function button(label, action, handler) {
    const node = document.createElement('button'); node.type = 'button'; node.dataset.nextActionAction = action; node.textContent = label; node.disabled = busy; node.addEventListener('click', handler); return node;
  }

  async function readSnapshot() {
    const now = getNow(), today = dateKey(now);
    const [taskRows, links, goals, processes, activeBlocks, state] = await Promise.all([
      preferences.includeTasks ? invoke('get_calendar_tasks', {}) : Promise.resolve([]),
      preferences.includeTasks ? invoke('get_calendar_task_goals') : Promise.resolve([]),
      preferences.includeTasks ? invoke('get_goals', { tabName: null }) : Promise.resolve([]),
      preferences.includeTasks ? readProcessState(invoke).then(result => result.state.processes) : Promise.resolve([]),
      preferences.includeTasks || preferences.includeRoutines ? readActiveBlocks(invoke) : Promise.resolve([]),
      preferences.includeRoutines ? store.read() : Promise.resolve({ version: 1, plans: [], days: {} }),
    ]);
    if (!Array.isArray(taskRows) || !Array.isArray(links) || !Array.isArray(goals) || !Array.isArray(processes) || !Array.isArray(activeBlocks)) throw new Error('Некорректный ответ сервера.');
    return { now, today, tasks: taskRows.filter(task => task?.source_type === 'note' && !task.completed && !task.archived && !task.readonly && (!task.status_extra || task.status_extra === 'task')), links, goals, processes, activeBlocks, state, routines: recurringItems(state, today) };
  }

  async function refresh() {
    if (disposed || busy || !preferences.enabled) return;
    const own = ++revision;
    try {
      const next = await readSnapshot();
      if (disposed || own !== revision) return;
      snapshot = next; recommendation = preferences.enabled ? selection(next) : null; error = ''; feedback = ''; render();
    } catch (cause) {
      if (disposed || own !== revision) return;
      error = cause?.message || String(cause); render();
    }
  }

  function deferCurrent() {
    if (!recommendation) return;
    const now = getNow(), key = recommendation.key, title = recommendation.title;
    deferred.set(key, { until: now.getTime() + 60 * 60 * 1000, day: dateKey(now) });
    if (currentTaskKey === key) currentTaskKey = '';
    focusTarget = 'later'; recommendation = snapshot ? selection(snapshot) : null; feedback = `«${title}» не будет предлагаться в течение часа.`; render();
  }

  async function activate(kind) {
    if (!recommendation || busy || disposed) return;
    const expected = recommendation, own = ++revision;
    busy = true; feedback = ''; error = ''; render();
    try {
      const fresh = await readSnapshot();
      if (disposed || own !== revision) return;
      const current = selection(fresh);
      if (!current || current.key !== expected.key || current.action !== expected.action) {
        snapshot = fresh; recommendation = current; feedback = 'Список изменился. Проверь новую рекомендацию.'; return;
      }
      if (kind === 'open' || kind === 'details' || kind === 'review') {
        if (current.type === 'task') openTask?.(current.task);
        else if (current.action === 'open' || current.action === 'start') openRoutine?.({ id: current.routine.id, date: current.date, start: false });
        return;
      }
      if (current.type === 'task' && kind === 'start' && current.action === 'start') {
        if (!executeTask) throw new Error('Действие задачи недоступно.');
        if (await executeTask(current.task, 'start') === false) return;
      } else if (current.type === 'task' && kind === 'done' && current.action === 'finish') {
        if (!executeTask) throw new Error('Действие задачи недоступно.');
        if (await executeTask(current.task, 'finish') === false) return;
      } else if (current.type === 'routine' && kind === 'start' && current.action === 'start') {
        if (!openRoutine) throw new Error('Запуск рутины недоступен.');
        if (openRoutine({ id: current.routine.id, date: current.date, start: true }) === false) return;
      } else if (current.type === 'routine' && kind === 'done' && current.action === 'done') {
        await store.setStatus(current.routine.id, 'done', current.date);
      } else throw new Error('Действие больше недоступно. Обнови список.');
      notifyChange?.();
      feedback = current.action === 'done' || kind === 'done' ? `«${current.title}» — выполнено.` : '';
      snapshot = await readSnapshot();
      if (disposed || own !== revision) return;
      recommendation = selection(snapshot);
    } catch (cause) {
      if (!disposed && own === revision) error = cause?.message || String(cause);
    } finally {
      if (!disposed && own === revision) { busy = false; render(); if (preferencesChangedWhileBusy) { preferencesChangedWhileBusy = false; void refresh(); } }
    }
  }

  const onChanged = () => { if (refreshQueued || disposed) return; refreshQueued = true; queueMicrotask(() => { refreshQueued = false; void refresh(); }); };
  window.addEventListener('task-state-changed', onChanged);
  window.addEventListener('hanni:calendar-refresh', onChanged);
  window.addEventListener('hanni:recurring-changed', onChanged);
  const timer = window.setInterval(() => {
    if (preferences.enabled && (!snapshot || dateKey(getNow()) !== snapshot.today)) void refresh();
    else if (preferences.enabled) { const selected = selection(snapshot); if (selected?.key !== recommendation?.key || selected?.reason !== recommendation?.reason) { recommendation = selected; render(); } }
  }, 30000);
  if (preferences.enabled) void refresh(); else render();

  const dispose = () => { if (disposed) return; disposed = true; revision++; window.clearInterval(timer); window.removeEventListener('task-state-changed', onChanged); window.removeEventListener('hanni:calendar-refresh', onChanged); window.removeEventListener('hanni:recurring-changed', onChanged); };
  dispose.setPreferences = next => { preferences = normalizedPreferences(next); if (!preferences.includeTasks) currentTaskKey = ''; if (busy) preferencesChangedWhileBusy = true; else revision++; if (!preferences.enabled) recommendation = null; else if (snapshot) { recommendation = selection(snapshot); if (!busy) void refresh(); } else if (!busy) void refresh(); render(); };
  dispose.setCurrentTask = task => {
    currentTaskKey = task == null ? '' : typeof task === 'string' ? task : keyOfTask(task);
    if (snapshot) { recommendation = selection(snapshot); render(); }
    if (!busy) void refresh();
  };
  dispose.setFocusedTaskVisible = (key, visible) => {
    const target = String(key || '');
    if (visible) {
      if (focusedTaskKey === target) return;
      focusedTaskKey = target;
    } else {
      if (focusedTaskKey !== target) return;
      focusedTaskKey = '';
    }
    render();
  };
  dispose.refresh = refresh;
  dispose.focus = () => element.querySelector('h2')?.focus({ preventScroll: true });
  return dispose;
}
