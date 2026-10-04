import { createSharedResultReviewAdapter, prepareSharedResultReview } from './shared-result-review-adapter.js';
import { canRefreshHealthView, mayCommitHealthView, retryHealthViewRefresh, startHealthViewRefresh } from './health-view-refresh.js';
import { S, invoke, tabLoaders, TAB_ICONS, loadTabSetting, IS_MOBILE } from './state.js';
import { ICONS } from './icons.js';
import { escapeHtml } from './utils.js';
import { renderUnifiedLayout, savePaneState } from './unified-layout.js';
import { CalendarViews as views } from './calendar-views.js';
import { mountCalendarGridViewport } from './calendar-grid-viewport.js';
import { projectDayStarts } from './calendar-day-start.js';
import { showEventModal, showCalendarCreateModal, showCalendarTaskModal } from './calendar-event-modal.js';
import { mountCalendarGoals } from './calendar-goals.js';
import { mountCalendarNotes } from './calendar-notes.js';
import { mountCalendarDashboardTasks } from './calendar-dashboard-tasks.js';
import { mountCalendarTasks } from './calendar-tasks.js';
import { mountSourceOnboarding } from './data-sources.js';
import { mountCalendarContextMenu } from './calendar-context-menu.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { mountCalendarRecurring } from './calendar-recurring.js';
import { openRecurringRun } from './calendar-routine-execution.js';
import { startCalendarExecution, readActiveBlocks } from './calendar-execution.js';
import { mountCalendarInProgress } from './calendar-in-progress.js';
import { mountCalendarDayBanner } from './calendar-day-banner.js';
import { loadCalendarPreferences } from './calendar-display-preferences.js';
import { attachDevelopmentTask, mountGoalGlance } from './calendar-development.js';
import { openCalendarGoalPopup } from './calendar-goal-popup.js';
import { sphereLabel, isInstantTask } from './task-model.js';
import { loadProcesses, mountStageTime, taskStage } from './task-processes.js';
import { openCalendarTaskDetails } from './calendar-task-details.js';
import { mountCalendarTodayAction } from './calendar-today-action.js';
import { mountCalendarRoutineChoices } from './calendar-routine-choices.js';
import { showCalendarSettings } from './calendar-settings.js';
import { openCalendarCreateMenu } from './calendar-create-menu.js';

let disposeNow = null, disposeTable = null, disposePanel = null, disposeTasks = null;
let disposeSourceOnboarding = null;
let disposeRecurring = null, goalPopup = null, tasksDialog = null;
let disposeDayBanner = null, disposeInProgress = null, todayTaskSelection = null;
let disposeNextAction = null, disposeTaskDetails = null, disposeRoutineChoices = null;
let routinesRouteHandler = null;
let preferences = { density:'comfortable', showCompleted:false };
let workspaceRevision = 0;
let dialogSequence = 0;
const tasksPaneState = { filter:'active', search:'', goal:'', sphere:'', page:0 };
// The Goals/Wishes choice survives pane switches within a session; it is not a stored preference.
const goalsPaneState = { view:'goals' };
let closeCreateMenu = null;
function cleanupWorkspace() { disposeSourceOnboarding?.(); disposeSourceOnboarding=null; workspaceRevision++; disposeNextAction?.(); disposeTaskDetails?.(); disposeRoutineChoices?.(); disposeNextAction = disposeTaskDetails = disposeRoutineChoices = null; disposeNow?.(); disposeTable?.(); disposePanel?.(); disposeTasks?.(); disposeRecurring?.(); disposeDayBanner?.(); disposeInProgress?.(); goalPopup?.dispose(); tasksDialog?.dispose(); disposeInProgress = null; disposeNow = null; disposeTable = null; disposePanel = null; disposeTasks = null; disposeRecurring = null; disposeDayBanner = null; goalPopup = null; tasksDialog = null; }
const nextActionPreferences = () => ({ enabled:preferences.recommendationsEnabled, includeTasks:preferences.recommendTasks, includeRoutines:preferences.recommendRoutines });
const view = { period: 'day', mode: 'grid', date: views.iso(new Date()), firstDay:'mon' };
let initialViewLoaded = false;
window.addEventListener('hanni:calendar-settings-changed', event => {
  const changes = event.detail?.changes || event.detail || {};
  preferences = { ...preferences, ...changes };
  disposeNextAction?.setPreferences(nextActionPreferences());
  document.documentElement.dataset.calendarDensity = preferences.density;
  if (!changes.first_day) return;
  view.firstDay = changes.first_day === 'sun' ? 'sun' : 'mon';
  window.dispatchEvent(new Event('hanni:calendar-refresh'));
});
// Actions that leave the goal popup. Set by the workspace mount, which owns navigation.
const goalPopupActions = { selectGoal: null };
function createGoalTask(goal, returnFocus = null, skill = null) {
  const revision = workspaceRevision;
  void showCalendarCreateModal(null, { initialNoDate:true, initialTitle:skill?.skillTitle, goalId:goal.goalId ?? goal.id, goalTitle:goal.path || goal.title,
    returnFocus, isCurrent:() => revision === workspaceRevision && S.activeTab === 'calendar',
    ...(skill ? { onTaskSaved:task => String(task.goalId) === String(goal.id) ? attachDevelopmentTask(goal.id, skill.skillId, task.id, { invoke }) : Promise.resolve() } : {}),
  });
}
/** Full goal popup (#98): the third display level, opened from the dashboard, Goals and wishes. */
function openGoalPopup(goal, { selection = {}, primaryGoalId, returnFocus } = {}) {
  if (goalPopup || !goal) return;
  const revision = workspaceRevision;
  goalPopup = openCalendarGoalPopup({ document, invoke, goal, selection, primaryGoalId, returnFocus,
    isCurrent:() => revision === workspaceRevision && S.activeTab === 'calendar',
    onClose:() => { goalPopup = null; },
    onSelectGoal: goalPopupActions.selectGoal ? goalId => goalPopupActions.selectGoal(goalId) : null,
    onCreateTask:(target, restore) => createGoalTask(target, restore),
    onCreateSkillTask:(target, skill, restore) => createGoalTask(target, restore, skill),
    onOpenTask:(row, restore) => showRecord(calendarRecord(row), restore),
    onOpenGoal:(next, restore) => { if (revision === workspaceRevision) openGoalPopup(next, { returnFocus:restore }); },
  });
}
const key = (r) => `${r.source_type}:${r.source_id}`;
const changed = () => { window.dispatchEvent(new Event('task-state-changed')); window.dispatchEvent(new Event('hanni:calendar-refresh')); };

// Several tasks may run at once: starting one never pauses another (2026-09-24).
export async function executeCalendarTaskAction(record, action) {
  if (record.source_type !== 'note' || record.readonly || record.completed || record.archived || ['done', 'skipped', 'missed'].includes(record.status_extra)) throw new Error('Эта задача уже недоступна для выполнения. Обнови календарь.');
  const active = (await readActiveBlocks(invoke)).find(block => block.source_type === 'note' && String(block.source_id) === String(record.source_id));
  const sameTask = !!active;
  if (action === 'start') {
    if (sameTask) return;
    await startCalendarExecution(invoke, { ...record, completion_date: record.date || views.iso(new Date()) });
  } else if (action === 'pause') {
    if (!sameTask) throw new Error('Состояние задачи изменилось. Обнови календарь перед паузой.');
    await invoke('pause_task_block', { blockId: Number(active.id) });
  } else if (action === 'finish') {
    // Closing an old block must never finish a concurrently restarted session.
    // Pause is idempotent; note completion atomically rejects any new active block.
    if (sameTask) await invoke('pause_task_block', { blockId: Number(active.id) });
    try { await invoke('complete_calendar_task', { id: String(record.source_id) }); }
    catch (error) {
      if (sameTask) throw Object.assign(new Error('Не удалось завершить задачу после паузы. Её текущий статус обновлён. ' + (error?.message || 'Попробуй ещё раз.')), { refreshRequired: true });
      throw error;
    }
  } else throw new Error('Неизвестное действие.');
}

export function calendarRecord(row) {
  return { ...row, id: `${key(row)}:${row.date || 'undated'}`, time: row.planned_time || null,
    durationMinutes: row.duration_minutes > 0 ? row.duration_minutes : null,
    kind: row.readonly ? 'Данные здоровья' : { note: 'Задача', event: 'Событие', schedule: 'Повторение' }[row.source_type],
    status: row.is_active ? 'В работе' : row.completed ? 'Завершено' : row.status_extra === 'skipped' ? 'Пропущено' : row.has_work || row.actual_minutes > 0 ? 'На паузе' : row.date ? 'Запланировано' : 'Без даты' };
}

function dialog(title, returnFocus = null) {
  const modal = document.createElement('dialog'); modal.className = 'calendar-mvp-dialog';
  const headingId = `calendar-dialog-title-${++dialogSequence}`;
  modal.setAttribute('aria-labelledby', headingId);
  modal.innerHTML = `<header class="cm-dialog-header"><h2 id="${headingId}">${escapeHtml(title)}</h2><button type="button" class="cm-dialog-close" data-close aria-label="Закрыть">×</button></header><form><div class="cm-dialog-body"><div class="cm-fields"></div><p class="cm-error" role="alert" hidden></p></div><div class="cm-actions"><button type="button" data-close>Закрыть</button><button type="submit" class="cm-primary">Сохранить</button></div></form>`;
  document.body.append(modal);
  const focus = document.activeElement;
  let restoreOnClose = true, pending = false;
  modal.setPending = value => {
    pending = value; modal.setAttribute('aria-busy', String(value));
    modal.querySelectorAll('button').forEach(button => { button.disabled = value; });
  };
  modal.restoreFocus = () => { if (returnFocus) returnFocus(); else if (focus?.isConnected) focus.focus(); };
  modal.closeForReplacement = () => { restoreOnClose = false; modal.close(); };
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (!pending) modal.close(); }));
  modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  modal.addEventListener('close', () => { modal.remove(); if (restoreOnClose) modal.restoreFocus(); }, { once: true });
  return modal;
}

function submit(modal, action, validate = null) {
  modal.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = modal.querySelector('[type=submit]');
    if (button.disabled || validate?.() === false) return; modal.setPending(true);
    const error = modal.querySelector('.cm-error'); error.hidden = true;
    try { await action(); modal.close(); changed(); }
    catch { error.textContent = 'Не удалось сохранить. Проверь данные и повтори — изменения формы сохранены.'; error.hidden = false; error.tabIndex = -1; error.focus(); }
    finally { modal.setPending(false); }
  });
}

function taskEditor(record, returnFocus = null, initialFocus = 'title', isCurrent = null) {
  return showCalendarTaskModal(String(record.source_id), { returnFocus, initialFocus, isCurrent });
}

function canChangeOccurrence(record) {
  return record.source_type === 'schedule' && !record.readonly && record.date && !record.completed && record.status_extra !== 'done' && !record.is_active;
}

function occurrenceDialog(record, returnFocus = null) {
  const restore = record.status_extra === 'skipped';
  const modal = dialog(restore ? 'Восстановить повторение' : 'Отменить повторение', returnFocus);
  const fields = modal.querySelector('.cm-fields');
  fields.innerHTML = `<p>${escapeHtml(record.title)} · ${escapeHtml(views.label(record.date))}</p>${restore ? '' : '<label>Какие повторения<select name="scope"><option value="one">Только в этот день</option><option value="future">С этого дня и дальше</option></select></label>'}<p data-occurrence-effect></p>`;
  const scope = fields.querySelector('[name=scope]');
  const save = modal.querySelector('[type=submit]');
  const describe = () => {
    const future = scope?.value === 'future';
    save.textContent = restore ? 'Восстановить в этот день' : future ? 'Отменить с этого дня' : 'Отменить в этот день';
    fields.querySelector('[data-occurrence-effect]').textContent = restore
      ? 'Повторение снова будет запланировано только на этот день.'
      : future ? 'Повторения с выбранного дня перестанут появляться. Предыдущие дни и история сохранятся.'
        : 'Остальные дни не изменятся. Это повторение можно будет восстановить из его карточки.';
  };
  scope?.addEventListener('change', describe); describe();
  modal.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); if (save.disabled) return;
    const args = { scheduleId: String(record.source_id), date: record.date, scope: scope?.value || 'one', cancelled: !restore };
    modal.setPending(true); if (scope) scope.disabled = true;
    const error = modal.querySelector('.cm-error'); error.hidden = true;
    try {
      await invoke('cancel_calendar_occurrence', args);
      modal.close(); changed();
    } catch (cause) {
      error.textContent = (typeof cause === 'string' ? cause : cause?.message) || 'Не удалось изменить повторение. Попробуй ещё раз.';
      error.hidden = false; error.tabIndex = -1; error.focus();
    } finally { modal.setPending(false); if (scope) scope.disabled = false; }
  });
  modal.showModal(); (scope || save).focus();
}

async function showRecord(record, returnFocus = null, initialFocus = null) {
  if (record.source_type === 'note' && !record.readonly) {
    const revision = workspaceRevision;
    const isCurrent = () => revision === workspaceRevision && S.activeTab === 'calendar';
    if (initialFocus === 'goal') return taskEditor(record, returnFocus, 'goal', isCurrent);
    disposeTaskDetails?.();
    disposeTaskDetails = openCalendarTaskDetails(record, { document, invoke, returnFocus, isCurrent,
      onEdit:(task, restore) => taskEditor(task, restore, 'title', isCurrent),
      onChanged:changed, executeAction:executeCalendarTaskAction });
    return;
  }
  const modal = dialog(record.title, returnFocus);
  const summary = [record.kind, isInstantTask(record) && 'Моментальная', sphereLabel(record.sphere), record.status].filter(Boolean).join(' · ');
  modal.querySelector('.cm-fields').innerHTML = `<p>${escapeHtml(summary)}</p><p>${escapeHtml(record.date ? views.label(record.date) : 'Без даты')} · ${escapeHtml(record.time || 'Без времени')}</p><p role="status">Загружаем цель…</p>`;
  modal.showModal(); modal.querySelector('[type=submit]').disabled = true;
  if (record.readonly) { modal.querySelector('[type=submit]').hidden = true; modal.querySelector('[role=status]').textContent = 'Изменения и удаление — в приложении-источнике. Начало дня отмечается отдельно.';
    if (record.health_kind === 'sleep') {
      const details = document.createElement('p');
      const origin = record.health_origin === 'com.sec.android.app.shealth' ? 'Samsung Health' : record.health_origin || 'Health Connect';
      details.textContent = `Источник: ${origin}. Период сна: ${record.durationMinutes} мин. Во сне: ${record.sleep_minutes == null ? 'нет данных о стадиях' : `${record.sleep_minutes} мин`}.`;
      modal.querySelector('.cm-fields').append(details);
    }
    if (record.health_kind === 'walking') {
      const details = document.createElement('p');
      const origin = record.health_origin === 'com.sec.android.app.shealth' ? 'Samsung Health' : record.health_origin || 'Health Connect';
      details.textContent = `Источник: ${origin}. Период прогулки: ${record.durationMinutes || 0} мин.`;
      modal.querySelector('.cm-fields').append(details);
    }
    if (record.health_kind === 'steps') {
      const details = document.createElement('p');
      details.textContent = `Источник: Health Connect (все доступные источники). Шагов за день: ${record.steps_count == null ? 'нет данных' : record.steps_count}. Итог не имеет времени начала.`;
      modal.querySelector('.cm-fields').append(details);
    }
    return; }
  if (canChangeOccurrence(record)) {
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.occurrenceAction = '';
    cancel.textContent = record.status_extra === 'skipped' ? 'Восстановить повторение' : 'Отменить повторение';
    cancel.addEventListener('click', () => { modal.closeForReplacement(); occurrenceDialog(record, modal.restoreFocus); });
    modal.querySelector('.cm-actions').prepend(cancel);
  }
  const workTime = document.createElement('p');
  workTime.dataset.recordWorkTime = ''; workTime.textContent = 'Загружаем учтённое время…';
  modal.querySelector('.cm-fields').append(workTime);
  void invoke('get_calendar_task_minutes', { sourceType: record.source_type, sourceId: String(record.source_id), completionDate: record.completion_date || record.date || null })
    .then(minutes => { if (modal.isConnected) workTime.textContent = `Учтено времени: ${minutes} мин`; })
    .catch(() => { if (modal.isConnected) workTime.textContent = 'Учтённое время сейчас недоступно.'; });
  // A task with a process (2026-09-25): its stage and the time spent in each stage.
  if (record.source_type === 'note') void showStageDetails(modal, record);
  try {
    const [goals, links] = await Promise.all([invoke('get_goals', { tabName: null }), invoke('get_calendar_task_goals')]);
    if (!modal.isConnected) return;
    const current = links.find((link) => key(link) === key(record))?.goal_id;
    const label = document.createElement('label'); label.textContent = 'Цель';
    const select = document.createElement('select'); select.name = 'goal';
    select.append(new Option('Без цели', ''));
    goals.forEach((goal) => select.append(new Option(goal.title, String(goal.id), false, String(goal.id) === String(current))));
    label.append(select); modal.querySelector('[role=status]').replaceWith(label);
    if (record.source_type !== 'schedule') {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Изменить';
      edit.addEventListener('click', () => {
        if (record.source_type === 'note') { modal.closeForReplacement(); taskEditor(record, modal.restoreFocus); }
        else { modal.closeForReplacement(); showEventModal(String(record.source_id), null, { returnFocus: modal.restoreFocus }); }
      });
      modal.querySelector('.cm-actions').prepend(edit);
    }
    modal.querySelector('[type=submit]').disabled = false;
    submit(modal, () => invoke('set_calendar_task_goal', { sourceType: record.source_type, sourceId: String(record.source_id), goalId: select.value ? String(select.value) : null }));
    if (initialFocus === 'goal') select.focus();
  } catch { modal.querySelector('[role=status]').textContent = 'Не удалось загрузить цель. Закрой и открой запись повторно.'; }
}

async function showStageDetails(modal, record) {
  const [processes, detail] = await Promise.all([loadProcesses(invoke), invoke('get_calendar_task', { id: String(record.source_id) }).catch(() => null)]);
  if (!modal.isConnected || isInstantTask(detail || record)) return;
  // The stored row carries the full stage history; the list row is the fallback.
  const row = { ...record, ...(detail ? { process: detail.process, stage: detail.stage, waiting: detail.waiting, stage_log: detail.stage_log } : {}) };
  const stage = taskStage(row, processes);
  if (!stage) return;
  const line = document.createElement('p'); line.dataset.recordStage = '';
  line.textContent = [stage.processTitle, stage.label || 'Стадия не выбрана', stage.waiting && 'жду ответа'].filter(Boolean).join(' · ');
  const time = document.createElement('p'); time.dataset.recordStageTime = '';
  modal.querySelector('[data-record-work-time]').after(line, time);
  const stop = mountStageTime(time, { invoke, row, processes });
  modal.addEventListener('close', stop, { once: true });
}

function mountRecordMenu(element, options) {
  return mountCalendarContextMenu(element, { ...options, getActions: row => {
    const record = calendarRecord(row);
    const actions = [{ id: 'open', label: 'Открыть', dialog: true, run: restore => showRecord(record, restore) }];
    if (record.readonly) return actions;
    if (record.source_type === 'note' || record.source_type === 'event') {
      const edit = (restore, field, isCurrent) => record.source_type === 'note' ? taskEditor(record, restore, field, isCurrent) : showEventModal(String(record.source_id), null, { returnFocus: restore, initialFocus: field, isCurrent });
      actions.push({ id: 'edit', label: 'Изменить', dialog: true, run: (restore, isCurrent) => edit(restore, 'title', isCurrent) });
      actions.push({ id: 'date', label: record.date ? 'Изменить дату' : 'Назначить дату', dialog: true, run: (restore, isCurrent) => edit(restore, 'date', isCurrent) });
    }
    if (['note', 'event', 'schedule'].includes(record.source_type)) actions.push({ id: 'goal', label: 'Связать с целью', dialog: true, run: restore => showRecord(record, restore, 'goal') });
    if (canChangeOccurrence(record)) actions.push({ id: 'occurrence', label: record.status_extra === 'skipped' ? 'Восстановить повторение' : 'Отменить повторение', dialog: true, run: restore => occurrenceDialog(record, restore) });
    // The command checks live timer state atomically. Never call update_note_status here.
    if (record.source_type === 'note' && row.status_extra === 'task' && !record.completed && !record.is_active && !record.archived)
      actions.push({ id: 'complete', label: 'Завершить задачу', run: async restore => { await invoke('complete_calendar_task', { id: String(record.source_id) }); restore(); changed(); } });
    return actions;
  } });
}

export async function mountCalendarTable(el) {
  disposeTable?.();
  let revision = 0, disposed = false, menuRecords = [], actionBusy = false;
  el.classList.add('calendar-mvp');
  el.innerHTML = `<div class="cm-calendar-toolbar"><div class="cm-date-roller" data-date-roller><h2 data-range></h2></div>
    <div class="cm-date"><button data-prev aria-label="Предыдущий период"><span class="cm-icon" aria-hidden="true">${ICONS.chevronLeft}</span></button><button data-next aria-label="Следующий период"><span class="cm-icon" aria-hidden="true">${ICONS.chevronRight}</span></button><button data-today>Сегодня</button></div>
    <div class="cm-toolbar"><div class="cm-segment" role="group" aria-label="Период календаря">${[['day','День'],['week','Неделя'],['month','Месяц']].map(([id,title]) => `<button data-period="${id}" aria-pressed="${view.period === id}">${title}</button>`).join('')}</div></div>
    </div><p data-notice role="status"></p><button data-retry hidden>Повторить загрузку</button><div data-calendar-records></div>`;
  const host = el.querySelector('[data-calendar-records]');
  host.tabIndex = -1;
  const actionStatus = document.createElement('p');
  actionStatus.className = 'calv-action-status'; actionStatus.setAttribute('role', 'status'); actionStatus.tabIndex = -1;
  host.before(actionStatus);
  const gridViewport = mountCalendarGridViewport(host, { pageScroll: IS_MOBILE });
  async function onTaskAction(record, action, trigger) {
    if (actionBusy || disposed) return;
    const restore = () => {
      if (disposed) return;
      const scope = host.querySelector('.calv-main');
      const current = menuRecords.find(item => key(item) === key(record));
      const row = [...(scope?.querySelectorAll('[data-context-record]') || [])].find(node => node.dataset.contextRecord === current?.id);
      (row?.querySelector('[data-record-action], .calv-record') || scope?.querySelector('h3') || host).focus({ preventScroll: true });
    };
    if (action === 'date') { await taskEditor(record, restore, 'date', () => !disposed && el.isConnected); return; }
    actionBusy = true; actionStatus.textContent = ''; actionStatus.classList.remove('is-error');
    host.querySelectorAll('[data-record-action]').forEach(button => { button.disabled = true; });
    try {
      await executeCalendarTaskAction(record, action);
      changed();
      if (!disposed) {
        await refresh();
        actionStatus.textContent = { start: 'Задача в работе.', pause: 'Задача на паузе.', finish: 'Задача завершена.' }[action];
        restore();
      }
    } catch (error) {
      if (error?.refreshRequired) { changed(); if (!disposed) await refresh(); }
      if (!disposed) { actionStatus.textContent = error?.message || 'Не удалось выполнить действие. Попробуй ещё раз.'; actionStatus.classList.add('is-error'); actionStatus.focus(); }
    } finally {
      actionBusy = false;
      if (!disposed) host.querySelectorAll('[data-record-action]').forEach(button => { button.disabled = false; });
    }
  }
  const menu = mountRecordMenu(host, {
    getRecord: item => menuRecords.find(record => record.id === item.dataset.contextRecord),
    restoreFocus: (item, trigger) => {
      const scope = host.querySelector('.calv-main');
      const current = menuRecords.find(record => key(record) === item.dataset.recordSource);
      const candidates = [...(scope?.querySelectorAll('[data-context-record]') || [])].filter(value => value.dataset.contextRecord === (current?.id || item.dataset.contextRecord));
      const row = candidates.find(value => value.dataset.recordDate === item.dataset.recordDate) || candidates[0];
      (row?.querySelector('recordMenu' in trigger.dataset ? '[data-record-menu]' : '.calv-record') || scope?.querySelector('h3') || host).focus({ preventScroll: true });
    },
  });
  async function refresh(quiet = false) {
    if (quiet && !canRefreshHealthView(el)) return;
    const rev = ++revision;
    const period = view.period, mode = view.mode, day = view.date;
    const firstDay = view.firstDay;
    const dates = period === 'month' ? Array.from({ length: 42 }, (_, i) => views.add(views.weekStart(`${day.slice(0,7)}-01`, firstDay), i)) : views.range(period, day, firstDay);
    const visibleRange = views.range(period, day, firstDay);
    if (!quiet) {
    el.querySelector('[data-range]').textContent = period === 'month' ? views.label(day,{month:'long',year:'numeric'}) : period === 'week' ? `${views.label(visibleRange[0])} — ${views.label(visibleRange.at(-1))}` : views.label(day,{weekday:'long',day:'numeric',month:'long'});
    updateDateRoller(period, day);
    el.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
    el.querySelector('[data-notice]').textContent = 'Загружаем расписание…';
    el.querySelector('[data-retry]').hidden = true; host.setAttribute('aria-busy','true');
    }
    try {
      const [calendarResult, tasksResult, dayStartResult] = await Promise.allSettled([
        invoke('get_calendar_records', { start: dates[0], end: dates.at(-1) }),
        invoke('get_calendar_tasks', { includeCompleted: true }),
        invoke('get_ui_state', { key: 'calendar_day_start_v1' }),
      ]);
      if (disposed || rev !== revision) return;
      if (calendarResult.status === 'rejected') throw calendarResult.reason;
      const records = calendarResult.value.map(calendarRecord);
      const taskError = tasksResult.status !== 'fulfilled' || !Array.isArray(tasksResult.value) || tasksResult.value.some(row => !row || row.source_type !== 'note' || row.source_id == null || typeof row.title !== 'string');
      const taskRecords = taskError ? [] : tasksResult.value.map(calendarRecord);
      const dayStarts = projectDayStarts(dayStartResult.status === 'fulfilled' ? dayStartResult.value : null)
        .filter(marker => marker.date >= dates[0] && marker.date <= dates.at(-1));
      const dayStartError = dayStartResult.status === 'rejected';
      if (!mayCommitHealthView(el, JSON.stringify({ period, mode, day, records, taskRecords, taskError, dayStarts, dayStartError }), quiet)) return;
      menu.close(true);
      const focused = document.activeElement;
      const focusKey = host.contains(focused) ? focused.closest('[data-context-record]')?.dataset.contextRecord : null;
      const focusDate = host.contains(focused) ? focused.closest('[data-context-record]')?.dataset.recordDate : null;
      const focusSource = host.contains(focused) ? focused.closest('[data-context-record]')?.dataset.recordSource : null;
      menuRecords = [...new Map([...records, ...taskRecords].map(record => [record.id, record])).values()];
      views.render(host, { period, mode, date: day, firstDay, records, taskRecords, taskError, dayStarts, onTaskAction, actionBusy,
        fitViewport: gridViewport.fit, pageScroll: IS_MOBILE,
        onRetryTasks: () => refresh(),
        onCreateTask: date => openEvent(date, null, 'task', true),
        onCreateEvent: (date, time) => openEvent(date, time),
        onChooseDate: async (value) => {
          view.date = value;
          if (!await refresh() || disposed || !el.isConnected || view.date !== value) return;
          host.querySelector(`[data-calendar-date="${value}"]`)?.focus();
        },
        onChooseRecord: (id) => { const record = menuRecords.find(r => r.id === id); if (record) showRecord(record); } });
      if (focusKey && !focused.isConnected) {
        const scope = host.querySelector('.calv-main');
        const candidates = [...(scope?.querySelectorAll('[data-context-record]') || [])].filter(value => value.dataset.contextRecord === focusKey || value.dataset.recordSource === focusSource);
        const row = candidates.find(value => value.dataset.recordDate === focusDate) || candidates[0];
        (row?.querySelector('recordMenu' in focused.dataset ? '[data-record-menu]' : '.calv-record') || scope?.querySelector('h3') || host).focus({ preventScroll: true });
      }
      el.querySelector('[data-notice]').textContent = dayStartError ? 'Не удалось загрузить отметку начала дня.' : '';
      return true;
    } catch {
      if (disposed || rev !== revision) return;
      if (quiet) { retryHealthViewRefresh(); return; }
      host.replaceChildren(); el.querySelector('[data-notice]').textContent = 'Не удалось загрузить расписание. Это не означает, что календарь пуст.';
      el.querySelector('[data-retry]').hidden = false;
    } finally { if (!disposed && rev === revision) host.removeAttribute('aria-busy'); }
  }
  function move(direction) {
    if (view.period === 'month') {
      const date = new Date(`${view.date}T12:00:00`), day = date.getDate();
      date.setDate(1); date.setMonth(date.getMonth()+direction);
      date.setDate(Math.min(day,new Date(date.getFullYear(),date.getMonth()+1,0).getDate())); view.date = views.iso(date);
    } else view.date = views.add(view.date, direction * (view.period === 'week' ? 7 : 1));
    refresh();
  }
  const roller = el.querySelector('[data-date-roller]');
  function updateDateRoller(period, day) {
    const enabled = period === 'day';
    roller.dataset.enabled = String(enabled);
    roller.tabIndex = enabled ? 0 : -1;
    if (enabled) {
      roller.setAttribute('role', 'spinbutton'); roller.setAttribute('aria-label', 'Дата календаря');
      roller.setAttribute('aria-valuenow', String(Date.parse(`${day}T00:00:00Z`) / 86400000));
      roller.setAttribute('aria-valuetext', views.label(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
      roller.title = 'Колёсико или клавиши ↑ ↓ — соседний день';
    } else {
      ['role', 'aria-label', 'aria-valuenow', 'aria-valuetext', 'title'].forEach(name => roller.removeAttribute(name));
    }
  }
  let wheelAmount = 0, lastWheel = -Infinity, lastStep = -Infinity;
  function wheelDate(event) {
    if (disposed || view.period !== 'day' || document.querySelector('dialog[open], [aria-modal="true"]') ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = event.timeStamp;
    if (now - lastWheel > 200 || Math.sign(wheelAmount) !== Math.sign(event.deltaY)) wheelAmount = 0;
    lastWheel = now;
    if (now - lastStep < 180) return;
    wheelAmount += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
    if (Math.abs(wheelAmount) < 40) return;
    const direction = Math.sign(wheelAmount); wheelAmount = 0; lastStep = now; move(direction);
  }
  function keyDate(event) {
    if (disposed || view.period !== 'day' || document.querySelector('dialog[open], [aria-modal="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    event.preventDefault(); move(direction);
  }
  roller.addEventListener('wheel', wheelDate, { passive: false });
  roller.addEventListener('keydown', keyDate);
  el.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => { view.period = b.dataset.period; refresh(); }));
  el.querySelector('[data-prev]').onclick = () => move(-1); el.querySelector('[data-next]').onclick = () => move(1);
  el.querySelector('[data-today]').onclick = () => { view.date = views.iso(new Date()); refresh(); };
  el.querySelector('[data-retry]').onclick = () => refresh();
  function openEvent(date, time = null, kind = 'event', fromPanel = false) {
    const isCurrent = () => !disposed && el.isConnected;
    showCalendarCreateModal(date, {
      kind, initialTime: time, initialNoDate: fromPanel && date === null && kind === 'task', isCurrent,
      returnFocus: () => {
        if (!isCurrent()) return;
        const slot = time ? host.querySelector(`[data-create-date="${date}"][data-create-time="${time}"]`) : null;
        (slot || (fromPanel && host.querySelector('[data-task-create]')) || document.querySelector('[data-calendar-create]') || host).focus();
      },
    });
  }
  let refreshQueued = false, quietQueued = true;
  const onChange = event => {
    if (!el.isConnected || disposed) return;
    quietQueued &&= !!(event.detail?.quietHealth || event.detail?.quietContent);
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      const quiet = quietQueued; refreshQueued = false; quietQueued = true;
      if (!disposed && el.isConnected) void refresh(quiet);
    });
  };
  window.addEventListener('hanni:calendar-refresh', onChange);
  window.addEventListener('task-state-changed', onChange);
  disposeTable = () => { disposed = true; revision++; gridViewport.dispose(); menu(); roller.removeEventListener('wheel', wheelDate); roller.removeEventListener('keydown', keyDate); window.removeEventListener('hanni:calendar-refresh', onChange); window.removeEventListener('task-state-changed', onChange); };
  await refresh();
}

export function openCalendarCreate(button) {
  const el = document.getElementById('calendar-content');
  if (!el?.querySelector('.uni-pane') || document.querySelector('dialog[open]')) return;
  if (closeCreateMenu) { closeCreateMenu(); return; }
  const revision = workspaceRevision;
  const isCurrent = () => revision === workspaceRevision && button.isConnected && el.isConnected && S.activeTab === 'calendar';
  const pane = S._unifiedPane.calendar;
  const initialKind = pane === 'notes' ? 'note' : pane === 'goals' ? goalsPaneState.view === 'wishes' ? 'wish' : 'goal' : pane === 'routines' ? 'routine' : pane === 'table' ? 'event' : 'task';
  const returnFocus = () => { if (isCurrent()) button.focus({ preventScroll:true }); };
  closeCreateMenu = openCalendarCreateMenu(button, { isCurrent, initialKind,
    onClose: () => { closeCreateMenu = null; },
    onSelect: kind => {
      if (!isCurrent()) return;
      if (kind === 'routine') { window.dispatchEvent(new CustomEvent('hanni:open-routines-pane', { detail:{create:true} })); return; }
      if (kind === 'note' && pane === 'notes' && disposePanel?.openCreate) { void disposePanel.openCreate({returnFocus}); return; }
      if (kind === 'goal' && pane === 'goals' && disposePanel?.openGoalCreate) { disposePanel.openGoalCreate({returnFocus}); return; }
      showCalendarCreateModal(pane === 'tasks' ? null : pane === 'table' ? view.date : views.iso(new Date()), {
        kind, types:[kind], initialNoDate:pane === 'tasks', isCurrent, returnFocus,
      });
    },
  });
}

export async function loadCalendarWorkspace(el, { nativeReview = true } = {}) {
  if(routinesRouteHandler){window.removeEventListener('hanni:open-recurring-settings',routinesRouteHandler);window.removeEventListener('hanni:open-routines-pane',routinesRouteHandler);routinesRouteHandler=null;}
  startHealthViewRefresh();
  cleanupWorkspace(); tabLoaders.cleanupCalendar = cleanupWorkspace;
  const loadRevision = workspaceRevision;
  const { mountCalendarNow } = await import('./calendar-now.js');
  try { preferences=await loadCalendarPreferences(invoke); document.documentElement.dataset.calendarDensity=preferences.density; } catch { /* Settings expose the read error without overwriting the stored snapshot. */ }
  if (!initialViewLoaded) {
    try {
      const [firstDay, defaultView] = await Promise.all([loadTabSetting('calendar', 'first_day'), loadTabSetting('calendar', 'default_view')]);
      if (loadRevision !== workspaceRevision || S.activeTab !== 'calendar') return;
      view.firstDay = firstDay === 'sun' ? 'sun' : 'mon';
      view.period = ({ 'День':'day', 'Неделя':'week', 'Месяц':'month', 'Список':'month' })[defaultView] || 'month';
      view.mode = 'grid';
      initialViewLoaded = true;
    } catch { /* Keep the usable current view if preferences cannot be read. */ }
  }
  if (loadRevision !== workspaceRevision || S.activeTab !== 'calendar') return;
  el.classList.add('calendar-workspace');
  const openPane = async pane => {
    if (!el.isConnected || S.activeTab !== 'calendar') return;
    S._unifiedPane ||= {}; S._unifiedPane.calendar = pane;
    savePaneState('calendar', pane);
    const rendering = renderUnifiedLayout(el, 'calendar', config);
    const navigationRevision = workspaceRevision;
    await rendering;
    if (navigationRevision !== workspaceRevision || S.activeTab !== 'calendar' || !el.isConnected || S._unifiedPane.calendar !== pane) return;
    const tab = el.querySelector(`.uni-tab.active[data-pane="${pane}"]`);
    const heading = el.querySelector('#uni-pane-calendar h2');
    if (tab) tab.focus();
    else if (heading) { heading.tabIndex = -1; heading.focus(); }
  };
  // The shared command is read-only here: bound personal tasks expose their
  // review projection, while ordinary tasks return the expected 404 absence.
  // Native command authority still enforces the isolated profile.
  const readTaskReview=nativeReview ? id=>createSharedResultReviewAdapter(id,invoke).read(id) : null;
  let nativeTaskOpenRevision=0;
  const openNativeTask=async(row,restore)=>{
    const request=++nativeTaskOpenRevision,revision=workspaceRevision,selectedPane=S._unifiedPane.calendar;
    const current=()=>request===nativeTaskOpenRevision&&revision===workspaceRevision&&el.isConnected&&S.activeTab==='calendar'&&S._unifiedPane.calendar===selectedPane;
    const personal=row.sphere==='personal'||String(row.tags||'').split(',').includes('task-sphere:personal');
    if(!personal||row.readonly){showRecord(calendarRecord(row),restore);return;}
    let review;
    try{review=await prepareSharedResultReview(row,invoke,()=>crypto.randomUUID());}
    catch{if(current())showRecord(calendarRecord(row),restore);return;}
    if(!current())return;
    const submit=review.adapter.submit;
    review.adapter.submit=async request=>{const value=await submit(request);if(value.kind==='acknowledged')changed();return value;};
    disposeTaskDetails?.();
    disposeTaskDetails=openCalendarTaskDetails(calendarRecord(row),{document,invoke,review,returnFocus:restore,isCurrent:current,onEdit:(task,returnFocus)=>taskEditor(task,returnFocus,'title',()=>revision===workspaceRevision),onChanged:changed,executeAction:executeCalendarTaskAction});
  };
  const taskOptions = { invoke, mountMenu:mountRecordMenu, openTask:(row,returnFocus)=>showRecord(calendarRecord(row),returnFocus), executeAction:(row,action)=>executeCalendarTaskAction(calendarRecord(row),action), notifyChange:changed };
  let renderLauncherState = null;
  const showAllTasks = (button = null, initialScope = null) => {
    if(tasksDialog)return;
    const revision = workspaceRevision;
    const dialog=createCalendarDialog({document,title:'Что начнём?',hint:'Учёт времени задачи или рутины. Исполнитель агента автоматически не запускается.',
      isCurrent:()=>revision===workspaceRevision&&S.activeTab==='calendar',
      returnFocus:button?()=>{if(button.isConnected)button.focus({preventScroll:true});}:undefined,
      onClose:()=>{disposeTasks?.();disposeRoutineChoices?.();disposeTasks=null;disposeRoutineChoices=null;tasksDialog=null;renderLauncherState=null;},
    });
    tasksDialog=dialog;
    if (button) dialog.modal.dataset.taskLauncher = '';
    dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
    const list = document.createElement('div'); list.dataset.launchSection = 'tasks';
    const scopes = document.createElement('div'); scopes.dataset.launchScopes = '';
    scopes.setAttribute('role','group'); scopes.setAttribute('aria-label','Что начать');
    scopes.innerHTML = '<button type="button" data-launch-scope="all">Всё</button><button type="button" data-launch-scope="tasks">Задачи</button><button type="button" data-launch-scope="routines">Рутины</button>';
    dialog.body.append(scopes);
    if (button) {
      const controller = disposeNow;
      const previous = document.createElement('button'); previous.type='button'; previous.dataset.launcherReturn=''; previous.hidden=true;
      dialog.body.append(previous);
      renderLauncherState = state => {
        previous.hidden = !state.returnTask;
        previous.textContent = state.returnTask ? `Вернуться: ${state.returnTask.title}` : '';
        previous.disabled = dialog.pending || state.busy || !!state.error;
        dialog.error.textContent=state.error;dialog.error.hidden=!state.error;
        dialog.retry.hidden=!state.error;dialog.retry.disabled=dialog.pending||state.busy;
      };
      const perform = async action => {
        if (dialog.pending) return;
        const focused = document.activeElement;
        dialog.setPending(true);
        try { await action(); }
        catch (error) { dialog.showError(error?.message || 'Не удалось выполнить действие.'); }
        finally {
          dialog.setPending(false);
          if (tasksDialog===dialog) {
            renderLauncherState(controller.getLauncherState());
            if ((document.activeElement===focused || document.activeElement===document.body) && focused?.closest('[hidden]')) dialog.modal.querySelector('footer [data-dialog-close]').focus({preventScroll:true});
          }
        }
      };
      previous.addEventListener('click',()=>void perform(controller.returnTo));
      dialog.retry.addEventListener('click',()=>void perform(controller.retry));
      renderLauncherState(controller.getLauncherState());
    }
    dialog.body.append(list);
    const routines = document.createElement('div'); routines.dataset.launchSection = 'routines'; dialog.body.append(routines);
    const setScope = scope => {
      list.hidden = scope === 'routines'; routines.hidden = scope === 'tasks'; dialog.modal.dataset.launchScope = scope;
      scopes.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.launchScope === scope)));
    };
    scopes.addEventListener('click', event => { const button = event.target.closest('[data-launch-scope]'); if (button) setScope(button.dataset.launchScope); });
    setScope(initialScope || (S._unifiedPane.calendar === 'routines' ? 'routines' : S._unifiedPane.calendar === 'tasks' ? 'tasks' : 'all'));
    disposeRoutineChoices = mountCalendarRoutineChoices(routines, { invoke, notifyChange:changed,
      openRoutine:options => { dialog.close({restoreFocus:false}); openRecurringRun({document,invoke,...options,returnFocus:() => (button?.isConnected?button:el.querySelector('[data-calendar-launch]'))?.focus({preventScroll:true})}); },
      openManager:() => { dialog.close(); window.dispatchEvent(new CustomEvent('hanni:open-recurring-settings')); },
    });
    disposeTasks=mountCalendarDashboardTasks(list,taskOptions);
    disposeTasks.showAll();dialog.open();
  };
  // Selection belongs to the visible dashboard mount, including its save queue.
  const selectMainGoal = async goalId => {
    if (S.activeTab !== 'calendar') return;
    S._unifiedPane.calendar = 'dash';
    savePaneState('calendar', 'dash');
    const rendering = renderUnifiedLayout(el, 'calendar', config);
    const dashboardRevision = workspaceRevision;
    await rendering;
    const current = disposeNow;
    if (dashboardRevision !== workspaceRevision || !current || S.activeTab !== 'calendar') return;
    try { await current.selectGoal(goalId); }
    catch (error) {
      if (dashboardRevision !== workspaceRevision || current !== disposeNow || S.activeTab !== 'calendar') return;
      const now = el.querySelector('[data-calendar-now]');
      // Action/save errors already expose the controller's safe retry button.
      if (!now || !now.querySelector('[data-ui="error"]').hidden) return;
      const notice = document.createElement('div');
      notice.className = 'calendar-now__error'; notice.dataset.goalSelectionError = '';
      notice.setAttribute('role', 'alert'); notice.tabIndex = -1;
      const message = document.createElement('p');
      message.textContent = error?.message || 'Не удалось сменить главную цель. Повтори выбор в целях.';
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'calendar-now__secondary'; back.textContent = 'Вернуться к целям';
      back.onclick = () => el.querySelector('.uni-tab[data-pane="goals"]')?.click();
      const dismiss = event => {
        const action = event.target.closest('[data-action]');
        if (!action || action.disabled) return;
        notice.remove(); now.removeEventListener('click', dismiss, true);
      };
      now.addEventListener('click', dismiss, true);
      notice.append(message, back); now.append(notice); notice.focus();
    }
  };
  goalPopupActions.selectGoal = goalId => { void selectMainGoal(goalId); };
  let nowHost = null;
  const config = { title:'Календарь', headerIcon:TAB_ICONS.calendar, editableHeader:false, subtitle:'События и расписание', hideDescription:true, hideMemory:true, accessibleTabs:true, beforeRender:cleanupWorkspace, isCurrent:() => S.activeTab === 'calendar',
    toolbarActions: [
      { label:'Создать', title:'Создать задачу, событие, цель, заметку, желание или рутину', icon:TAB_ICONS.add, onClick:openCalendarCreate },
      { label:'Начать', title:'Начать учёт времени задачи или рутины', icon:ICONS.play, onClick:showAllTasks },
    ],
    renderHeaderExtra: host => {
      const create = host.querySelector('.uni-header-action');
      create.dataset.calendarCreate = '';
      create.setAttribute('aria-label', 'Создать');
      create.setAttribute('aria-haspopup', 'menu');
      create.setAttribute('aria-expanded', 'false');
      const launch = host.querySelector('[data-action-idx="1"]');
      launch.dataset.calendarLaunch = '';
      launch.setAttribute('aria-haspopup', 'dialog');
      // «● N» running tasks on the right of the shared header; it leads to the dashboard widget.
      const header = document.createElement('div');
      header.dataset.calendarRunning = '';
      host.querySelector('.uni-header').append(header);
      nowHost = document.createElement('div');
      nowHost.dataset.calendarNow = '';
      nowHost.classList.add('calendar-main-goal');
      nowHost.hidden = true;
      host.append(nowHost);
      // Every pane shares one execution owner; Dashboard reveals its goal summary.
      disposeNow = mountCalendarNow(nowHost, {
        headerElement:header,
        headerLabel:'Сегодня',
        hideTaskCard:true,
        mountGoalSummary:(host, goal) => mountGoalGlance(host, {invoke, goal}),
        openTaskLauncher:() => showAllTasks(host.querySelector('[data-calendar-launch]')),
        onLauncherStateChange:state => renderLauncherState?.(state),
        openGoalDetails:(goal, { returnFocus } = {}) => openGoalPopup(goal, { primaryGoalId:goal.id, returnFocus }),
        openTaskDetails: (row, restore) => {
          if(row.source_type==='schedule'){
            const [id,date]=JSON.parse(row.source_id);openRecurringRun({document,invoke,id,date});
          }else showRecord(calendarRecord({ ...row, date: row.date || row.completion_date || null }), restore);
        },
        openGoals: async id => {
          await openPane('goals');
          if (id != null && S.activeTab === 'calendar' && S._unifiedPane.calendar === 'goals') el.querySelector(`[data-goal-open="${id}"]`)?.focus();
        },
        openCalendar: () => openPane('table'),
        // The header indicator counts running work; the dashboard widget lists each task.
        openInProgress: async () => {
          if (S._unifiedPane.calendar !== 'dash') await openPane('dash');
          if (S.activeTab === 'calendar' && S._unifiedPane.calendar === 'dash') {
            const heading = el.querySelector('[data-calendar-day-banner] h2');
            if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
          }
        },
        onCurrentTaskChange: value => disposeRecurring?.setCurrentTask(value),
      });
    },
    panes: [{id:'dash',label:'Дашборд'}, {id:'table',label:'Календарь'}, {id:'tasks',label:'Задачи'}, {id:'routines',label:'Рутины'}, {id:'notes',label:'Заметки'}, {id:'goals',label:'Цели'}],
    renderDash: (pane) => {
      pane.innerHTML = `<section class="calendar-today" aria-label="Сегодня">
        <div data-calendar-day-banner></div><div data-calendar-next-action></div>
        <div data-calendar-in-progress></div>
      </section><div data-calendar-now-slot></div>`;
      pane.querySelector('[data-calendar-now-slot]').replaceWith(nowHost);
      nowHost.hidden = false;
      disposeDayBanner = mountCalendarDayBanner(pane.querySelector('[data-calendar-day-banner]'), {
        invoke,
        onOpenSettings:button => showCalendarSettings(button, {section:'next-action',recommendationsOnly:true,returnFocus:() => button.isConnected ? button.focus({preventScroll:true}) : disposeNextAction?.focus()}),
      });
      disposeNextAction = mountCalendarTodayAction(pane.querySelector('[data-calendar-next-action]'), {
        invoke, preferences:nextActionPreferences(), notifyChange:changed, compactRunning:true,
        taskOptions, openRoutines:() => void openPane('routines'),
        onCurrentTaskChange:task => {
          const key = value => value ? `task:${value.source_type}:${String(value.source_id)}` : '';
          const previousKey = key(todayTaskSelection), nextKey = key(task);
          // Update first: clearing old focus can synchronously rerender NextAction
          // and call back into this handler.
          todayTaskSelection = task;
          if (previousKey && previousKey !== nextKey) disposeNextAction?.setFocusedTaskVisible(previousKey,false);
          disposeInProgress?.setSelectedTask(task);
        },
        onRoutineFocusChange:options => disposeInProgress?.setExcludedRoutine(options?.id || null),
        openTask:task => showRecord(calendarRecord(task), () => disposeNextAction?.focus()),
        executeTask:(task,action) => executeCalendarTaskAction(calendarRecord(task),action),
      });
      disposeInProgress = mountCalendarInProgress(pane.querySelector('[data-calendar-in-progress]'), {
        invoke, notifyChange:changed, title:'Идёт сейчас', activeOnly:true, hideWhenEmpty:true, embedded:true,
        singleSelection:true, selectedTask:todayTaskSelection,
        onSelectedTaskState:state => {
          if (!todayTaskSelection || state.key !== `${todayTaskSelection.source_type}:${String(todayTaskSelection.source_id)}`) return;
          disposeNextAction?.setFocusedTaskVisible(`task:${todayTaskSelection.source_type}:${String(todayTaskSelection.source_id)}`,state.visible);
        },
        onEmptyFocus:() => disposeNextAction?.focus(),
        openLauncher:button => showAllTasks(button),
        openTask:(row, restore) => {
          if (row.source_type === 'schedule') { const [id, date] = JSON.parse(row.source_id); disposeNextAction?.openRoutine({id,date,start:false}); }
          else showRecord(calendarRecord({ ...row, date: row.date || null }), restore);
        },
      });
      disposeInProgress.setSelectedTask(todayTaskSelection);
    },
    renderTable: pane => mountCalendarTable(pane),
    renderTasks: pane => {
      const revision = workspaceRevision;
      pane.innerHTML = `<div data-workspace-task-list></div><details class="calendar-task-history"><summary>Запущено и на паузе сегодня</summary><div data-calendar-in-progress></div></details>`;
      disposePanel = mountCalendarTasks(pane.querySelector('[data-workspace-task-list]'), {
        invoke, state:tasksPaneState, readTaskReview, mountMenu:mountRecordMenu, notifyChange:changed,
        openTask:(row,restore) => void openNativeTask(row,restore),
        editDate:(row,restore) => taskEditor(calendarRecord(row),restore,'date',()=>revision===workspaceRevision && pane.isConnected),
        executeAction:(row,action) => executeCalendarTaskAction(calendarRecord(row),action),
      });
      disposeInProgress = mountCalendarInProgress(pane.querySelector('[data-calendar-in-progress]'), {
        invoke, notifyChange:changed, title:'Запущено и на паузе', openLauncher:showAllTasks,
        openTask:(row,restore) => {
          if (row.source_type === 'schedule') { const [id,date] = JSON.parse(row.source_id); openRecurringRun({document,invoke,id,date,start:false}); }
          else showRecord(calendarRecord(row),restore);
        },
      });

    },
    renderRoutines: pane => {
      pane.innerHTML='<div data-calendar-routines></div>';
      disposeRecurring=mountCalendarRecurring(pane.querySelector('[data-calendar-routines]'),{invoke,showCompleted:preferences.showCompleted,library:true});
    },
    renderGoals: async (pane) => {
      const revision = workspaceRevision;
      const dispose = await mountCalendarGoals(pane, { state:goalsPaneState,
        onOpenGoal:(goal, context) => { if (revision === workspaceRevision && pane.isConnected) openGoalPopup(goal, context); },
        onCreateTask: goal => {
          if (!goal || revision !== workspaceRevision || !pane.isConnected) return;
          showCalendarCreateModal(null, { initialNoDate: true, goalId: goal.goalId, goalTitle: goal.path || goal.title, returnFocus: () => pane.querySelector(`[data-goal-id="${goal.goalId}"] [data-goal-menu]`)?.focus(), isCurrent: () => revision === workspaceRevision && pane.isConnected && S.activeTab === 'calendar' });
        }, onSelectGoal: selectMainGoal });
      if (revision !== workspaceRevision) dispose?.();
      else disposePanel = dispose;
    },
    renderNotes: async (pane) => {
      const revision = workspaceRevision;
      const dispose = await mountCalendarNotes(pane);
      if (revision !== workspaceRevision) dispose?.(); else disposePanel = dispose;
    },
  };
  routinesRouteHandler=event=>{
    if(S.activeTab!=='calendar'||!el.isConnected)return;
    const create=event.type==='hanni:open-routines-pane'&&event.detail?.create===true;
    void openPane('routines').then(()=>{if(create&&S._unifiedPane.calendar==='routines')disposeRecurring?.create?.({returnFocus:()=>el.querySelector('[data-calendar-create]')?.focus({preventScroll:true})});});
  };
  window.addEventListener('hanni:open-recurring-settings',routinesRouteHandler);
  window.addEventListener('hanni:open-routines-pane',routinesRouteHandler);
  await renderUnifiedLayout(el, 'calendar', config);
  disposeSourceOnboarding?.();
  disposeSourceOnboarding=mountSourceOnboarding(el,{invoke,onSettings:()=>showCalendarSettings(null,{section:'connections'})});
  const create = document.querySelector('[data-calendar-create]');
  if (create && el.isConnected && el.querySelector('.uni-pane')) create.disabled = false;
}
