import { canRefreshHealthView, mayCommitHealthView, retryHealthViewRefresh, startHealthViewRefresh } from './health-view-refresh.js';
import { S, invoke, tabLoaders, TAB_ICONS, loadTabSetting } from './state.js';
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
import { planCalendarTaskForDay } from './calendar-task-planning.js';
import { mountCalendarContextMenu } from './calendar-context-menu.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { mountCalendarRecurring } from './calendar-recurring.js';
import { openRecurringRun } from './calendar-routine-execution.js';
import { startCalendarExecution } from './calendar-execution.js';
import { mountCalendarDayBanner } from './calendar-day-banner.js';
import { loadCalendarPreferences } from './calendar-display-preferences.js';
import { mountGoalDevelopment, mountGoalDevelopmentSummary, attachDevelopmentTask } from './calendar-development.js';

let disposeNow = null, disposeTable = null, disposePanel = null, disposeTasks = null;
let disposeRecurring = null, developmentDialog = null, tasksDialog = null;
let disposeDayBanner = null;
let preferences = { density:'comfortable', showCompleted:false };
let workspaceRevision = 0;
let dialogSequence = 0;
const tasksPaneState = { filter:'active', search:'', goal:'', page:0 };
function cleanupWorkspace() { workspaceRevision++; disposeNow?.(); disposeTable?.(); disposePanel?.(); disposeTasks?.(); disposeRecurring?.(); disposeDayBanner?.(); developmentDialog?.dispose(); tasksDialog?.dispose(); disposeNow = null; disposeTable = null; disposePanel = null; disposeTasks = null; disposeRecurring = null; disposeDayBanner = null; developmentDialog = null; tasksDialog = null; }
const view = { period: 'day', mode: 'grid', date: views.iso(new Date()), firstDay:'mon' };
let initialViewLoaded = false;
window.addEventListener('hanni:calendar-settings-changed', event => {
  const changes = event.detail?.changes || event.detail || {};
  preferences = { ...preferences, ...changes };
  document.documentElement.dataset.calendarDensity = preferences.density;
  if (!changes.first_day) return;
  view.firstDay = changes.first_day === 'sun' ? 'sun' : 'mon';
  window.dispatchEvent(new Event('hanni:calendar-refresh'));
});
window.addEventListener('hanni:open-recurring-settings', () => {
  if (document.querySelector('[data-calendar-recurring]')) return;
  const host = document.createElement('div'); host.hidden = true; document.body.append(host);
  const dispose = mountCalendarRecurring(host, { invoke, showCompleted:preferences.showCompleted });
  // A temporary mount supports this settings entry from Table, Goals and Notes too.
  void dispose.openManager().finally(() => {});
  dispose.onManagerClose = () => { dispose(); host.remove(); };
});

function openGoalDevelopment(goal, selection = {}) {
  if (developmentDialog || !goal) return;
  let mounted = null;
  const dialog = createCalendarDialog({document,title:'Цель',onClose:()=>{mounted?.dispose();developmentDialog=null;}});
  developmentDialog = dialog; dialog.modal.classList.add('calendar-development-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  const host=document.createElement('div');dialog.body.append(host);dialog.open();
  void mountGoalDevelopment(host,{invoke,goal,onCreateTask:skill=>{
    dialog.close();
    void showCalendarCreateModal(null,{initialNoDate:true,initialTitle:skill.skillTitle,goalId:goal.id,goalTitle:goal.title,
      onTaskSaved:task=>String(task.goalId)===String(goal.id)?attachDevelopmentTask(goal.id,skill.skillId,task.id,{invoke}):Promise.resolve(),
    });
  }}).then(value=>{
    if(developmentDialog!==dialog){value.dispose();return;}mounted=value;
    if(selection.skillId){
      const skill=[...host.querySelectorAll('[data-dev-skill]')].find(button=>button.dataset.devSkill===selection.skillId);
      if(skill){let parent=skill.parentElement;while(parent&&parent!==host){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}skill.scrollIntoView({block:'center'});skill.focus();}
    }
  }).catch(error=>dialog.showError(error?.message||String(error)));
}
const key = (r) => `${r.source_type}:${r.source_id}`;
const changed = () => { window.dispatchEvent(new Event('task-state-changed')); window.dispatchEvent(new Event('hanni:calendar-refresh')); };

export async function executeCalendarTaskAction(record, action, { allowSwitch = false } = {}) {
  if (record.source_type !== 'note' || record.readonly || record.completed || record.archived || ['done', 'skipped', 'missed'].includes(record.status_extra)) throw new Error('Эта задача уже недоступна для выполнения. Обнови календарь.');
  const active = await invoke('get_active_block', {});
  const sameTask = active?.source_type === 'note' && String(active.source_id) === String(record.source_id);
  if (action === 'start') {
    if (allowSwitch) return (await startCalendarExecution(invoke, record, document)) !== null;
    if (active && !sameTask) throw new Error('Уже выполняется другая задача. Сначала поставь её на паузу.');
    if (sameTask) return;
    await invoke('start_task_block', { sourceType: 'note', sourceId: String(record.source_id), failIfActive: true, completionDate: record.date || views.iso(new Date()) });
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
  const modal = dialog(record.title, returnFocus);
  modal.querySelector('.cm-fields').innerHTML = `<p>${escapeHtml(record.kind)} · ${escapeHtml(record.status)}</p><p>${escapeHtml(record.date ? views.label(record.date) : 'Без даты')} · ${escapeHtml(record.time || 'Без времени')}</p><p role="status">Загружаем цель…</p>`;
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

export async function mountCalendarTable(el, { openTasks } = {}) {
  disposeTable?.();
  let revision = 0, disposed = false, menuRecords = [], actionBusy = false;
  el.classList.add('calendar-mvp');
  el.innerHTML = `<div class="cm-toolbar"><div class="cm-segment" role="group" aria-label="Период календаря">${[['day','День'],['week','Неделя'],['month','Месяц']].map(([id,title]) => `<button data-period="${id}" aria-pressed="${view.period === id}">${title}</button>`).join('')}</div><div class="cm-segment" role="group" aria-label="Вид календаря"><button data-mode="grid"><span class="cm-icon" aria-hidden="true">${ICONS.calendar}</span>Календарь</button><button data-mode="list"><span class="cm-icon" aria-hidden="true">${ICONS.list}</span>Список</button></div></div>
    <div class="cm-controls"><div class="cm-date"><button data-prev aria-label="Предыдущий период"><span class="cm-icon" aria-hidden="true">${ICONS.chevronLeft}</span></button><div class="cm-date-roller" data-date-roller><span data-date-before aria-hidden="true" hidden></span><h2 data-range></h2><span data-date-after aria-hidden="true" hidden></span></div><button data-next aria-label="Следующий период"><span class="cm-icon" aria-hidden="true">${ICONS.chevronRight}</span></button><button data-today>Сегодня</button></div>
    </div><p data-notice role="status"></p><button data-retry hidden>Повторить загрузку</button><div data-calendar-records></div>`;
  const host = el.querySelector('[data-calendar-records]');
  host.tabIndex = -1;
  const actionStatus = document.createElement('p');
  actionStatus.className = 'calv-action-status'; actionStatus.setAttribute('role', 'status'); actionStatus.tabIndex = -1;
  host.before(actionStatus);
  const gridViewport = mountCalendarGridViewport(host);
  const closePlanningOnEscape = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || disposed || !el.isConnected || document.querySelector('dialog[open], [aria-modal="true"]')) return;
    const panel = host.querySelector('[data-tasks-panel]:not([hidden])');
    if (panel) { event.preventDefault(); panel.querySelector('.calv-panel-close')?.click(); }
  };
  document.addEventListener('keydown', closePlanningOnEscape);
  async function scheduleTask(record, date) {
    if (actionBusy || disposed) return;
    actionBusy = true; actionStatus.textContent = 'Сохраняем дату…'; actionStatus.classList.remove('is-error');
    host.querySelectorAll('[data-plan-task]').forEach(button => { button.disabled = true; });
    try {
      const saved = await planCalendarTaskForDay(invoke, record.source_id, date, () => !disposed && el.isConnected);
      if (!saved) return;
      changed();
      if (!disposed) {
        await refresh();
        actionStatus.textContent = `Задача запланирована на ${views.label(date)} · без времени.`;
        (host.querySelector('[data-plan-task]') || host.querySelector('[data-tasks-toggle]') || host).focus({preventScroll:true});
      }
    } catch (error) {
      if (!disposed) {
        await refresh(); actionStatus.textContent = error?.message || 'Не удалось назначить день. Обнови список и повтори.';
        actionStatus.classList.add('is-error'); actionStatus.focus();
      }
    } finally { actionBusy = false; if (!disposed) host.querySelectorAll('[data-plan-task]').forEach(button => { button.disabled = false; }); }
  }
  async function onTaskAction(record, action, trigger) {
    if (actionBusy || disposed) return;
    const fromPanel = !!trigger?.closest('[data-tasks-panel]');
    const restore = () => {
      if (disposed) return;
      const scope = fromPanel ? host.querySelector('[data-tasks-panel]') : host.querySelector('.calv-main');
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
      const scope = item.closest('[data-tasks-panel]') ? host.querySelector('[data-tasks-panel]') : host.querySelector('.calv-main');
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
    el.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
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
      const focusInPanel = !!focused.closest('[data-tasks-panel]');
      menuRecords = [...new Map([...records, ...taskRecords].map(record => [record.id, record])).values()];
      views.render(host, { period, mode, date: day, firstDay, records, taskRecords, taskError, dayStarts, onTaskAction, actionBusy,
        onScheduleTask: scheduleTask, onOpenTasks: openTasks,
        fitViewport: gridViewport.fit,
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
        const scope = focusInPanel ? host.querySelector('[data-tasks-panel]') : host.querySelector('.calv-main');
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
    for (const [selector, delta] of [['[data-date-before]', -1], ['[data-date-after]', 1]]) {
      const neighbor = roller.querySelector(selector);
      neighbor.hidden = !enabled; neighbor.textContent = enabled ? views.label(views.add(day, delta)) : '';
    }
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
  el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { view.mode = b.dataset.mode; refresh(); }));
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
  disposeTable = () => { disposed = true; revision++; gridViewport.dispose(); menu(); document.removeEventListener('keydown', closePlanningOnEscape); roller.removeEventListener('wheel', wheelDate); roller.removeEventListener('keydown', keyDate); window.removeEventListener('hanni:calendar-refresh', onChange); window.removeEventListener('task-state-changed', onChange); };
  await refresh();
}

export function openCalendarCreate(button) {
  const el = document.getElementById('calendar-content');
  if (!el?.querySelector('.uni-pane') || document.querySelector('dialog[open]')) return;
  const revision = workspaceRevision;
  const isCurrent = () => revision === workspaceRevision && button.isConnected && el.isConnected && S.activeTab === 'calendar';
  const tasksPane = S._unifiedPane.calendar === 'tasks';
  showCalendarCreateModal(tasksPane ? null : S._unifiedPane.calendar === 'table' ? view.date : views.iso(new Date()), {
    initialNoDate: tasksPane,
    isCurrent, returnFocus: () => { if (isCurrent()) button.focus({ preventScroll:true }); },
  });
}

export async function loadCalendarWorkspace(el) {
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
      view.mode = defaultView === 'Список' ? 'list' : 'grid';
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
  const config = { title:'Календарь', headerIcon:TAB_ICONS.calendar, editableHeader:false, subtitle:'События и расписание', hideDescription:true, hideMemory:true, accessibleTabs:true, beforeRender:cleanupWorkspace, isCurrent:() => S.activeTab === 'calendar',
    toolbarActions: [{ label:'Новая задача', title:'Новая задача. В форме также можно выбрать событие.', icon:TAB_ICONS.add, onClick:openCalendarCreate }],
    renderHeaderExtra: host => {
      const create = host.querySelector('.uni-header-action');
      create.dataset.calendarCreate = '';
      create.setAttribute('aria-label', create.title);
      create.setAttribute('aria-haspopup', 'dialog');
    },
    panes: [{id:'dash',label:'Дашборд'}, {id:'table',label:'Календарь'}, {id:'tasks',label:'Задачи'}, {id:'notes',label:'Заметки'}, {id:'goals',label:'Цели'}],
    renderDash: (pane) => {
      pane.innerHTML = '<div data-calendar-day-banner></div><div data-calendar-now></div><div data-calendar-recurring></div>';
      disposeDayBanner = mountCalendarDayBanner(pane.querySelector('[data-calendar-day-banner]'),{invoke});
      const taskOptions = { invoke, mountMenu:mountRecordMenu, openTask:(row,returnFocus)=>showRecord(calendarRecord(row),returnFocus), executeAction:(row,action)=>executeCalendarTaskAction(calendarRecord(row),action,{allowSwitch:true}), notifyChange:changed };
      const showAllTasks = () => {
        if(tasksDialog)return;
        const dialog=createCalendarDialog({document,title:'Все задачи',onClose:()=>{disposeTasks?.();disposeTasks=null;tasksDialog=null;}});
        tasksDialog=dialog;
        dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
        disposeTasks=mountCalendarDashboardTasks(dialog.body,taskOptions);
        disposeTasks.showAll();dialog.open();
      };
      disposeRecurring = mountCalendarRecurring(pane.querySelector('[data-calendar-recurring]'), {
        invoke, showCompleted:preferences.showCompleted,
        mountTasks:host=>mountCalendarDashboardTasks(host,{...taskOptions,embedded:true,onShowAll:showAllTasks}),
      });
      disposeNow = mountCalendarNow(pane.querySelector('[data-calendar-now]'), {
        openGoalDetails:openGoalDevelopment,
        mountGoalSummary:(host,goal)=>mountGoalDevelopmentSummary(host,{invoke,goalId:goal.id,onOpen:selection=>openGoalDevelopment(goal,selection)}),
        openTaskDetails: (row, restore) => {
          if(row.source_type==='schedule'){
            const [id,date]=JSON.parse(row.source_id);openRecurringRun({document,invoke,id,date});
          }else showRecord(calendarRecord({ ...row, date: row.date || row.completion_date || null }), restore);
        },
        openGoals: async id => {
          await openPane('goals');
          if (id != null && S.activeTab === 'calendar' && S._unifiedPane.calendar === 'goals') el.querySelector(`[data-edit-goal="${id}"]`)?.focus();
        },
        openCalendar: () => openPane('table'),
        onCurrentTaskChange: value => disposeRecurring?.setCurrentTask(value),
      });
    },
    renderTable: pane => mountCalendarTable(pane, { openTasks: () => openPane('tasks') }),
    renderTasks: pane => {
      const revision = workspaceRevision;
      disposePanel = mountCalendarTasks(pane, {
        invoke, state:tasksPaneState, mountMenu:mountRecordMenu, notifyChange:changed,
        openTask:(row,restore) => showRecord(calendarRecord(row),restore),
        editDate:(row,restore) => taskEditor(calendarRecord(row),restore,'date',()=>revision===workspaceRevision && pane.isConnected),
        executeAction:(row,action) => executeCalendarTaskAction(calendarRecord(row),action,{allowSwitch:true}),
      });
    },
    renderGoals: async (pane) => {
      const revision = workspaceRevision;
      const dispose = await mountCalendarGoals(pane, { onOpenGoal:openGoalDevelopment, onCreateTask: goal => {
        if (!goal || revision !== workspaceRevision || !pane.isConnected) return;
        showCalendarCreateModal(null, { initialNoDate: true, goalId: goal.goalId, goalTitle: goal.path || goal.title, returnFocus: () => pane.querySelector(`[data-goal-id="${goal.goalId}"] [data-edit-goal]`)?.focus(), isCurrent: () => revision === workspaceRevision && pane.isConnected && S.activeTab === 'calendar' });
      }, onSelectGoal: async goalId => {
        // Selection belongs to the visible dashboard mount, including its save queue.
        if (revision !== workspaceRevision || S.activeTab !== 'calendar') return;
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
      } });
      if (revision !== workspaceRevision) dispose?.();
      else disposePanel = dispose;
    },
    renderNotes: async (pane) => {
      const revision = workspaceRevision;
      const dispose = await mountCalendarNotes(pane);
      if (revision !== workspaceRevision) dispose?.(); else disposePanel = dispose;
    },
  };
  await renderUnifiedLayout(el, 'calendar', config);
  const create = document.querySelector('[data-calendar-create]');
  if (create && el.isConnected && el.querySelector('.uni-pane')) create.disabled = false;
}
