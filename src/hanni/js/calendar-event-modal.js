// calendar-event-modal.js — Create / edit calendar event modal with
// DB-driven categories and 5-level priority picker.

import { S, invoke } from './state.js';
import { escapeHtml } from './utils.js';
import { loadCategories } from './calendar-categories.js';
import { showCategoryManager, showAddCategory } from './calendar-category-manager.js';
// These values remain the existing backend section ids; labels are presentation only.
const PROJECT_TABS = [
  { id: 'notes', label: 'Заметки' }, { id: 'jobs', label: 'Работа' },
  { id: 'projects', label: 'Проекты' }, { id: 'development', label: 'Развитие' },
  { id: 'home', label: 'Дом' }, { id: 'hobbies', label: 'Увлечения' },
  
  { id: 'food', label: 'Питание' }, { id: 'money', label: 'Финансы' },
  { id: 'people', label: 'Люди' },
];

function renderProjectPicker(current) {
  const cur = current || '';
  const items = [...PROJECT_TABS];
  if (cur && !items.some(t => t.id === cur)) items.push({ id: cur, label: cur });
  return `<select class="form-select" id="evm-linked-tab">
    <option value=""${!cur ? ' selected' : ''}>Без привязки</option>
    ${items.map(t => `<option value="${escapeHtml(t.id)}"${t.id === cur ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
  </select>`;
}

// Default time is the exact current local minute. Rounding made a modal opened
// at 08:09 misleadingly show 08:10 even though "Создать и начать" starts now.
function currentLocalTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function localNowParts() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    value: d,
  };
}

// Calendar stores wall-clock minutes, not a timezone-aware interval.
function civilMinute(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  const stamp = `${date}T${time}:00.000Z`, value = Date.parse(stamp);
  return Number.isFinite(value) && new Date(value).toISOString() === stamp ? value / 60000 : NaN;
}

function rangeEnd(date, time, duration) {
  const value = civilMinute(date, time) + duration;
  if (!Number.isSafeInteger(value)) return null;
  const end = new Date(value * 60000);
  if (!Number.isFinite(end.getTime())) return null;
  const iso = end.toISOString();
  return iso.length === 24 ? { date: iso.slice(0, 10), time: iso.slice(11, 16) } : null;
}

const PRIORITY_LEVELS = [
  { v: 0, label: 'Нет',          hex: 'var(--bg-hover)',     text: 'var(--text-secondary)' },
  { v: 1, label: '1 · низкий',   hex: 'var(--color-green)',  text: '#fff' },
  { v: 2, label: '2',            hex: 'var(--color-lime)',   text: '#fff' },
  { v: 3, label: '3 · средний',  hex: 'var(--color-yellow)', text: '#fff' },
  { v: 4, label: '4',            hex: 'var(--color-orange)', text: '#fff' },
  { v: 5, label: '5 · срочно',   hex: 'var(--color-red)',    text: '#fff' },
];

export function priorityHex(v) {
  const lv = PRIORITY_LEVELS.find(l => l.v === Number(v));
  return lv ? lv.hex : 'var(--bg-hover)';
}

function renderPriorityPicker(current) {
  const cur = Number(current || 0);
  return `<div class="evm-priority" role="group" aria-label="Важность события" data-evm-priority="${cur}">
    ${PRIORITY_LEVELS.map(l => `
      <button type="button" class="evm-pri-pill${l.v === cur ? ' active' : ''}" data-pri="${l.v}"
        style="--pri-bg:${l.hex};--pri-fg:${l.text};" title="${l.label}" aria-label="${l.label}" aria-pressed="${l.v === cur}">${l.v === 0 ? 'Нет' : l.v}</button>
    `).join('')}
  </div>`;
}

function categoryOptions(cats, current) {
  const options = [...cats];
  if (!options.some(c => c.name === current)) options.unshift({ name: current });
  return options.map(c => `<option value="${escapeHtml(c.name)}"${c.name === current ? ' selected' : ''}>${escapeHtml(c.name === 'general' ? 'Общее' : c.name)}</option>`).join('');
}

const CAT_ACTION_NEW = '__new__';
const CAT_ACTION_MANAGE = '__manage__';
function renderCategoryPicker(cats, current) {
  return `<select class="form-select" id="evm-cat">
    ${categoryOptions(cats, current)}
    <option disabled>──────────</option>
    <option value="${CAT_ACTION_NEW}">Новая категория…</option>
    <option value="${CAT_ACTION_MANAGE}">Управление категориями…</option>
  </select>`;
}

export async function showEventModal(eventId = null, initialDate = null, options = {}) {
  let kind = options.kind === 'task' ? 'task' : 'event';
  const taskId = options.taskId == null ? null : String(options.taskId);
  const isEdit = eventId != null || taskId != null;
  let cats = await loadCategories();
  if (options.isCurrent?.() === false) return;
  let event = null, task = null, recordReady = true;
  if (taskId != null) {
    try { task = await invoke('get_calendar_task', { id: taskId }); }
    catch { recordReady = false; }
    if (options.isCurrent?.() === false) return;
  } else if (isEdit) {
    // No single get_event command — fetch all events and find by id.
    let all;
    try { all = await invoke('get_all_events'); }
    catch (err) { if (options.isCurrent?.() === false) return; alert('Не удалось загрузить событие: ' + err); options.returnFocus?.(); return; }
    if (options.isCurrent?.() === false) return;
    event = (all || []).find(e => e.id === String(eventId));
    if (!event) { alert('Событие не найдено'); options.returnFocus?.(); return; }
  }

  const initDate = taskId != null ? task?.date || '' : event?.date || initialDate || S.selectedCalendarDate || localNowParts().date;
  const initTime = event?.time || options.initialTime || currentLocalTime();
  const initTitle = task?.title || event?.title || '';
  const initDesc = event?.description || '';
  const initCat = event?.category || 'general';
  const initPri = event?.priority ?? 0;
  const initDur = event?.duration_minutes > 0 ? event.duration_minutes : 60;
  const initTab = event?.linked_tab || '';
  const initEnd = rangeEnd(initDate, initTime, initDur) || { date: initDate, time: initTime };
  let savedEventId = taskId ?? (isEdit ? String(eventId) : null);
  let savedVersion = task?.version ?? event?.version ?? null;
  let changed = false;
  let persistedGoalId = task?.goal_id ?? null;
  let goalsReady = false;
  let endDateExpanded = initEnd.date !== initDate;
  let availableGoalIds = new Set();
  let goalDraft = options.goalId == null ? null : String(options.goalId);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay evm-overlay';
  const previousFocus = document.activeElement;
  let pending = false;
  overlay.innerHTML = `<div class="modal evm-modal calendar-editor-shell" role="dialog" aria-modal="true" aria-labelledby="evm-heading" aria-describedby="evm-hint" data-editor-kind="${kind}">
    <header class="evm-heading calendar-editor-header">
      <div><h2 id="evm-heading"></h2><p id="evm-hint"></p></div>
      <button type="button" class="evm-close calendar-editor-close" id="evm-close" aria-label="Закрыть">×</button>
    </header>
    <form id="evm-form" class="calendar-editor-form" novalidate>
      <div class="evm-form-body calendar-editor-body">
      ${isEdit ? '' : '<div class="evm-type-picker" role="group" aria-label="Тип записи"><button type="button" data-editor-type="task">Задача</button><button type="button" data-editor-type="event">Событие</button></div>'}
      <p id="evm-record-error" class="evm-error" role="alert" hidden></p><button type="button" id="evm-record-retry" class="btn-secondary" hidden>Повторить загрузку задачи</button>
      <fieldset class="evm-fields" id="evm-fields">
      <label class="evm-field evm-title-field" for="evm-title">
        <span class="evm-field-label">Название</span>
        <input class="form-input" id="evm-title" placeholder="Например, встреча по проекту" value="${escapeHtml(initTitle)}" required autocomplete="off">
      </label>
      <div class="evm-date-row">
        <label class="evm-field" for="evm-date"><span class="evm-field-label">Дата</span>
          <input class="form-input" id="evm-date" type="date" value="${escapeHtml(initDate)}" required></label>
        <label class="evm-untimed" data-editor-task><input type="checkbox" id="evm-no-date"${(taskId != null && !task?.date) || (!isEdit && kind === 'task' && options.initialNoDate) ? ' checked' : ''}> Без даты</label>
        <label class="evm-untimed" data-editor-event><input type="checkbox" id="evm-all-day"${isEdit && event && !event.time ? ' checked' : ''}> Без времени</label>
      </div>
      <div class="evm-when-row" data-editor-event>
        <label class="evm-field" for="evm-time" data-evm-timing><span class="evm-field-label">Время начала</span>
          <input class="form-input" id="evm-time" type="time" value="${escapeHtml(initTime)}"></label>
        <label class="evm-field" for="evm-end-time" data-evm-timing><span class="evm-field-label">Время окончания</span>
          <input class="form-input" id="evm-end-time" type="time" value="${escapeHtml(initEnd.time)}"></label>
      </div>
      <div class="evm-end-day" data-editor-event>
        <button type="button" id="evm-end-date-toggle" class="evm-end-toggle" aria-controls="evm-end-date-field" aria-expanded="false">Окончание в тот же день · Изменить</button>
        <label class="evm-field" id="evm-end-date-field" for="evm-end-date" data-evm-timing><span class="evm-field-label">Дата окончания</span>
          <input class="form-input" id="evm-end-date" type="date" value="${escapeHtml(initEnd.date)}"></label>
      </div>
      <input id="evm-dur" type="hidden" value="${initDur}">
      <p class="evm-duration-summary" id="evm-duration-summary" data-editor-event></p>
      <p class="evm-range-hint" id="evm-range-hint" hidden>В календаре событие показано в дне начала.</p>
      <label class="evm-field evm-goal-field" for="evm-goal"><span class="evm-field-label">Цель · необязательно</span>
        <select class="form-select" id="evm-goal" disabled>${options.goalId != null ? `<option value="${escapeHtml(String(options.goalId))}">${escapeHtml(options.goalTitle || 'Выбранная цель')}</option>` : '<option value="">Загружаем цели…</option>'}</select></label>
      <p class="evm-goal-path" id="evm-goal-path" aria-live="polite" hidden></p>
      <p class="evm-error" id="evm-goal-error" role="alert" hidden></p>
      <button type="button" class="btn-secondary" id="evm-goal-retry" hidden>Повторить загрузку целей</button>
      <details class="evm-advanced">
        <summary>Детали <span>необязательно</span></summary>
        <div class="evm-advanced-content">
      <label class="evm-field evm-estimate" for="evm-task-estimate" data-editor-task><span class="evm-field-label">Оценка времени, мин</span><input class="form-input" id="evm-task-estimate" type="number" min="1" step="1" inputmode="numeric" placeholder="Не задана" value="${task?.duration_minutes ?? ''}"></label>
        <div class="evm-event-details" data-editor-event>
          <label class="evm-field" for="evm-desc"><span class="evm-field-label">Описание</span>
            <textarea class="form-textarea" id="evm-desc" placeholder="Место, ссылка или контекст встречи" rows="3">${escapeHtml(initDesc)}</textarea></label>
          
          <div class="evm-classify">
            <label class="evm-classify-col" for="evm-cat"><span class="evm-field-label">Категория</span>${renderCategoryPicker(cats, initCat)}</label>
            <label class="evm-classify-col" for="evm-linked-tab"><span class="evm-field-label">Раздел</span>${renderProjectPicker(initTab)}</label>
          </div>
          <div class="evm-field-label">Важность</div>
          ${renderPriorityPicker(initPri)}
          ${isEdit
            ? '<button type="button" class="evm-delete-btn" id="evm-del">Удалить событие…</button>'
            : '<div class="evm-start-option"><p>Если уже приступаешь, начало будет установлено на текущее время.</p><button type="button" class="btn-secondary evm-start-now-btn" id="evm-start-now">Создать и начать сейчас</button></div>'}
        </div></div>
      </details>
      </fieldset>
      </div>
      <p class="evm-error calendar-editor-error" id="evm-error" role="alert" hidden></p>
      <footer class="modal-actions evm-actions calendar-editor-actions">
        <button type="button" class="btn-secondary" id="evm-cancel">Отмена</button>
        <button type="submit" class="btn-primary evm-save-btn" id="evm-save">${isEdit ? 'Сохранить' : 'Создать событие'}</button>
      </footer>
    </form>
  </div>`;
  document.body.appendChild(overlay);
  const notifyChange = () => {
    window.dispatchEvent(new CustomEvent('hanni:calendar-refresh'));
    window.dispatchEvent(new CustomEvent('task-state-changed'));
  };
  const close = () => { if (!pending) { overlay.remove(); if (changed) notifyChange(); } };
  const isTopModal = () => [...document.querySelectorAll('.modal-overlay')].at(-1) === overlay;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay && isTopModal()) close(); });
  overlay.querySelector('#evm-cancel').addEventListener('click', close);
  overlay.querySelector('#evm-close').addEventListener('click', close);
  const keyCtl = new AbortController();
  document.addEventListener('keydown', e => {
    if (!isTopModal()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const focusable = [...overlay.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')].filter(el => {
        if (el.matches(':disabled') || el.closest('[hidden]') || el.type === 'hidden') return false;
        const collapsed = el.closest('details:not([open])');
        return !collapsed || collapsed.firstElementChild === el;
      });
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    }
  }, { signal: keyCtl.signal });
  new MutationObserver((_, obs) => {
    if (!document.body.contains(overlay)) {
      keyCtl.abort(); obs.disconnect();
      if (document.activeElement === document.body) {
        if (options.returnFocus) options.returnFocus();
        else if (previousFocus?.isConnected) previousFocus.focus();
      }
    }
  }).observe(document.body, { childList: true });
  const titleInput = overlay.querySelector('#evm-title');
  const untimed = overlay.querySelector('#evm-all-day');
  const dateInput = overlay.querySelector('#evm-date');
  const timeInput = overlay.querySelector('#evm-time');
  const endDateInput = overlay.querySelector('#evm-end-date');
  const endTimeInput = overlay.querySelector('#evm-end-time');
  const durInput = overlay.querySelector('#evm-dur');
  const rangeHint = overlay.querySelector('#evm-range-hint');
  const noDate = overlay.querySelector('#evm-no-date');
  const estimateInput = overlay.querySelector('#evm-task-estimate');
  const endDateField = overlay.querySelector('#evm-end-date-field');
  const endDateToggle = overlay.querySelector('#evm-end-date-toggle');
  const fields = overlay.querySelector('#evm-fields');
  const recordError = overlay.querySelector('#evm-record-error');
  const recordRetry = overlay.querySelector('#evm-record-retry');
  const updateRangeHint = () => {
    const differentDay = !!dateInput.value && !!endDateInput.value && dateInput.value !== endDateInput.value;
    const hasTiming = kind === 'event' && !untimed.checked;
    rangeHint.hidden = !hasTiming || !differentDay;
    endDateField.hidden = !hasTiming || !(endDateExpanded || differentDay);
    endDateToggle.hidden = !hasTiming;
    endDateToggle.setAttribute('aria-expanded', String(!endDateField.hidden));
    endDateToggle.textContent = differentDay ? `Окончание: ${endDateInput.value} · Изменить` : 'Окончание в тот же день · Изменить';
    const duration = civilMinute(endDateInput.value, endTimeInput.value) - civilMinute(dateInput.value, timeInput.value);
    const summary = overlay.querySelector('#evm-duration-summary');
    summary.hidden = !hasTiming || !Number.isSafeInteger(duration) || duration < 1;
    summary.textContent = `Длительность: ${duration} мин`;
  };
  const shiftEnd = () => {
    const end = rangeEnd(dateInput.value, timeInput.value, Number(durInput.value));
    if (end) { endDateInput.value = end.date; endTimeInput.value = end.time; }
    updateRangeHint();
  };
  const readDuration = () => civilMinute(endDateInput.value, endTimeInput.value) - civilMinute(dateInput.value, timeInput.value);
  const updateDuration = () => {
    const duration = readDuration();
    if (Number.isSafeInteger(duration) && duration > 0) durInput.value = duration;
    updateRangeHint();
  };
  for (const input of [dateInput, timeInput]) input.addEventListener('change', shiftEnd);
  for (const input of [endDateInput, endTimeInput]) input.addEventListener('change', updateDuration);
  const updateTiming = () => {
    overlay.querySelectorAll('[data-evm-timing]').forEach(field => {
      field.hidden = kind !== 'event' || untimed.checked;
      field.querySelector('input').disabled = kind !== 'event' || untimed.checked;
    });
    dateInput.disabled = kind === 'task' && noDate.checked;
    overlay.querySelector('[for="evm-date"] .evm-field-label').textContent = kind === 'task' || untimed.checked ? 'Дата' : 'Дата начала';
    updateRangeHint();
  };
  untimed.addEventListener('change', updateTiming);
  noDate.addEventListener('change', updateTiming);
  endDateToggle.addEventListener('click', () => {
    endDateExpanded = !endDateExpanded;
    // An actual multi-day interval always keeps its end date visible.
    updateRangeHint(); if (!endDateField.hidden) endDateInput.focus();
  });
  const showError = (message, field) => {
    const error = overlay.querySelector('#evm-error');
    error.textContent = message; error.hidden = !message;
    overlay.querySelectorAll('[aria-invalid]').forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
    if (field) {
      if (field === endDateInput) { endDateExpanded = true; updateRangeHint(); }
      const details = field.closest('details'); if (details) details.open = true;
      field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', 'evm-error'); field.focus();
    } else if (message) { error.tabIndex = -1; error.focus(); }
  };
  const updateEditorType = () => {
    overlay.querySelector('.calendar-editor-shell').dataset.editorKind = kind;
    overlay.querySelector('#evm-heading').textContent = isEdit ? (kind === 'task' ? 'Изменить задачу' : 'Редактировать событие') : (kind === 'task' ? 'Новая задача' : 'Новое событие');
    overlay.querySelector('#evm-hint').textContent = kind === 'task' ? 'Дату, цель и оценку времени можно оставить пустыми.' : isEdit ? 'Измени детали в расписании.' : options.initialTime ? 'Выбраны дата и время ячейки. Их можно изменить.' : 'Выбраны дата календаря и текущее время. Их можно изменить.';
    titleInput.placeholder = kind === 'task' ? 'Например, описать пользовательский сценарий' : 'Например, встреча по проекту';
    if (kind === 'task') titleInput.maxLength = 500; else titleInput.removeAttribute('maxlength');
    overlay.querySelectorAll('[data-editor-task]').forEach(node => { node.hidden = kind !== 'task'; });
    overlay.querySelectorAll('[data-editor-event]').forEach(node => { node.hidden = kind !== 'event'; });
    overlay.querySelectorAll('[data-editor-type]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.editorType === kind)); button.disabled = pending || savedEventId != null; });
    overlay.querySelector('#evm-save').textContent = pending ? 'Сохранение…' : savedEventId != null ? 'Сохранить' : kind === 'task' ? 'Создать задачу' : 'Создать событие';
    fields.disabled = pending || !recordReady;
    updateTiming();
  };
  overlay.querySelectorAll('[data-editor-type]').forEach(button => button.addEventListener('click', () => {
    if (pending || savedEventId != null || kind === button.dataset.editorType) return;
    kind = button.dataset.editorType; showError(''); updateEditorType();
  }));
  const setPending = value => {
    pending = value;
    overlay.querySelector('#evm-form').setAttribute('aria-busy', String(value));
    overlay.querySelectorAll('#evm-save, #evm-start-now, #evm-del, #evm-close, #evm-cancel').forEach(btn => { btn.disabled = value; });
    if (changed) overlay.querySelector('#evm-cancel').textContent = 'Закрыть';
    const startButton = overlay.querySelector('#evm-start-now');
    if (startButton && savedEventId != null) startButton.textContent = 'Сохранить и начать сейчас';
    updateEditorType();
  };
  const goalSelect = overlay.querySelector('#evm-goal');
  const goalPath = overlay.querySelector('#evm-goal-path');
  const goalError = overlay.querySelector('#evm-goal-error');
  const goalRetry = overlay.querySelector('#evm-goal-retry');
  const updateGoalPath = () => {
    const option = goalSelect.selectedOptions[0];
    goalPath.hidden = !goalSelect.value || !option;
    goalPath.textContent = goalPath.hidden ? '' : option.textContent;
  };
  goalSelect.addEventListener('change', () => { goalDraft = goalSelect.value; updateGoalPath(); });
  updateGoalPath();
  const loadGoals = async () => {
    if (!recordReady) return;
    const restoreSelectionFocus = document.activeElement === goalRetry;
    goalsReady = false; goalSelect.disabled = true; goalRetry.hidden = true; goalError.hidden = true;
    try {
      const [goals, links] = await Promise.all([invoke('get_goals', { tabName: null }), isEdit && kind === 'event' ? invoke('get_calendar_task_goals') : Promise.resolve([])]);
      if (!overlay.isConnected) return;
      if (taskId != null) persistedGoalId = task?.goal_id ?? null;
      else if (isEdit) {
        const link = links.find(item => item.source_type === 'event' && String(item.source_id) === String(savedEventId));
        persistedGoalId = link?.goal_id == null ? null : String(link.goal_id);
      }
      availableGoalIds = new Set(goals.map(goal => String(goal.id)));
      goalSelect.replaceChildren(new Option('Без цели', ''));
      const byId = new Map(goals.map(goal => [String(goal.id), goal]));
      const labelFor = goal => { const path = []; const seen = new Set(); let current = goal; while (current && !seen.has(String(current.id))) { seen.add(String(current.id)); path.unshift(current.title || 'Без названия'); current = byId.get(String(current.parent_goal_id)); } return path.join(' → '); };
      for (const goal of goals) goalSelect.add(new Option(labelFor(goal), String(goal.id)));
      if (persistedGoalId != null && !goals.some(goal => String(goal.id) === persistedGoalId)) goalSelect.add(new Option('Связанная цель недоступна', String(persistedGoalId)));
      if (goalDraft && ![...goalSelect.options].some(option => option.value === goalDraft)) goalSelect.add(new Option('Выбранная цель недоступна', goalDraft));
      goalSelect.value = goalDraft ?? (persistedGoalId == null ? '' : String(persistedGoalId));
      updateGoalPath(); goalSelect.disabled = false; goalsReady = true;
      if (restoreSelectionFocus && isTopModal()) goalSelect.focus();
    } catch (err) {
      if (!overlay.isConnected) return;
      goalSelect.replaceChildren(new Option('Связь с целью не загружена', ''));
      updateGoalPath();
      goalError.textContent = 'Не удалось загрузить цели. Повтори загрузку перед сохранением: ' + err;
      goalError.hidden = false; goalRetry.hidden = false;
    }
  };
  goalRetry.addEventListener('click', loadGoals);
  const showRecordState = () => {
    recordError.hidden = recordReady;
    recordError.textContent = recordReady ? '' : 'Не удалось загрузить задачу. Её сохранённые поля пока неизвестны; повтори загрузку.';
    recordRetry.hidden = recordReady; fields.disabled = !recordReady || pending;
  };
  recordRetry.addEventListener('click', async () => {
    if (recordRetry.disabled) return; recordRetry.disabled = true;
    try {
      const value = await invoke('get_calendar_task', { id: taskId });
      if (!overlay.isConnected || options.isCurrent?.() === false) return;
      task = value; recordReady = true;
      savedVersion = task.version ?? null;
      titleInput.value = task.title; dateInput.value = task.date || ''; noDate.checked = !task.date; estimateInput.value = task.duration_minutes ?? '';
      showError(''); showRecordState(); updateEditorType();
      if (isTopModal()) (options.initialFocus === 'date' ? (noDate.checked ? noDate : dateInput) : titleInput).focus();
      await loadGoals();
    } catch { if (overlay.isConnected) showRecordState(); }
    finally { recordRetry.disabled = false; }
  });
  showRecordState(); updateEditorType();
  if (isTopModal() && !overlay.contains(document.activeElement)) {
    (recordReady ? (options.initialFocus === 'date' ? (dateInput.disabled ? noDate : dateInput) : titleInput) : recordRetry).focus();
  }
  void loadGoals();

  // Priority pill clicks
  overlay.querySelectorAll('.evm-pri-pill').forEach(p => {
    p.addEventListener('click', () => {
      overlay.querySelectorAll('.evm-pri-pill').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
      p.classList.add('active');
      p.setAttribute('aria-pressed', 'true');
      const wrap = overlay.querySelector('.evm-priority');
      if (wrap) wrap.dataset.evmPriority = p.dataset.pri;
    });
  });

  // Category select: +/⚙️ are sentinel options. On pick → run the
  // action, then re-render options keeping the prior real selection
  // (so the form value doesn't get stuck on a sentinel).
  const refreshCatOptions = (keepValue) => {
    const sel = overlay.querySelector('#evm-cat');
    if (!sel) return;
    const html = renderCategoryPicker(cats, keepValue);
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    sel.innerHTML = tmp.firstElementChild.innerHTML;
    sel.dataset.prev = sel.value;
  };
  const catSel = overlay.querySelector('#evm-cat');
  if (catSel) catSel.dataset.prev = catSel.value;
  catSel?.addEventListener('change', (e) => {
    const v = e.target.value;
    const prev = e.target.dataset.prev || 'general';
    if (v === CAT_ACTION_NEW) {
      e.target.value = prev;
      showAddCategory(async (newName) => {
        cats = await loadCategories(true);
        refreshCatOptions(newName);
      });
    } else if (v === CAT_ACTION_MANAGE) {
      e.target.value = prev;
      showCategoryManager(async () => {
        cats = await loadCategories(true);
        refreshCatOptions(prev);
      });
    } else {
      e.target.dataset.prev = v;
    }
  });

  // Delete (edit-mode only)
  overlay.querySelector('#evm-del')?.addEventListener('click', async () => {
    if (kind !== 'event' || pending || !confirm('Удалить событие безвозвратно?')) return;
    showError(''); setPending(true);
    try {
      await invoke('delete_event', { id: String(eventId) });
      overlay.remove();
      window.dispatchEvent(new CustomEvent('hanni:calendar-refresh'));
    } catch (err) { setPending(false); showError('Не удалось удалить событие: ' + err); }
  });

  const submitEvent = async (startNow) => {
    if (pending) return;
    if (kind === 'task' && startNow) return;
    showError('');
    if (!recordReady) { showError('Сначала повтори загрузку задачи: неизвестные поля нельзя перезаписывать.', recordRetry); return; }
    const title = titleInput.value.trim();
    if (!title) { showError(kind === 'task' ? 'Укажи название задачи.' : 'Укажи название события.', titleInput); return; }
    // New unlinked records do not depend on optional goals. Editing must still
    // wait, because clearing an unknown existing link would lose user data.
    if (!goalsReady && isEdit) { overlay.querySelector('.evm-advanced').open = true; showError('Дождись загрузки целей или повтори её.', goalRetry.hidden ? null : goalRetry); return; }
    const desiredGoalId = goalSelect.value ? String(goalSelect.value) : null;
    if (kind === 'task') {
      if (title.length > 500) { showError('Сократи название задачи до 500 символов.', titleInput); return; }
      const dueDate = noDate.checked ? null : dateInput.value;
      if (dueDate !== null && !Number.isFinite(civilMinute(dueDate, '00:00'))) { showError('Выбери дату или отметь «Без даты».', dateInput); return; }
      const estimateMinutes = estimateInput.value.trim() === '' ? null : Number(estimateInput.value);
      if (estimateInput.validity.badInput || (estimateMinutes !== null && (!Number.isSafeInteger(estimateMinutes) || estimateMinutes <= 0))) {
        showError('Укажи оценку целым числом минут больше нуля или оставь поле пустым.', estimateInput); return;
      }
      if (desiredGoalId != null && !availableGoalIds.has(String(desiredGoalId))) { showError('Связанная цель недоступна. Выбери другую цель или «Без цели».', goalSelect); return; }
      setPending(true);
      try {
        savedEventId = await invoke('save_calendar_task', { id: savedEventId, title, dueDate, estimateMinutes, goalId: desiredGoalId, expectedVersion: savedVersion });
        changed = true; overlay.remove(); notifyChange();
      } catch (error) { setPending(false); showError('Не удалось сохранить задачу. Введённые данные сохранены в форме: ' + error); }
      return;
    }
    const now = startNow ? localNowParts() : null;
    const date = now?.date || dateInput.value;
    const time = now?.time || (untimed.checked ? '' : timeInput.value);
    const dur = untimed.checked ? (startNow ? Number(durInput.value) : 0) : readDuration();
    if (!Number.isFinite(civilMinute(date, '00:00'))) { showError('Выбери дату события.', dateInput); return; }
    if (!startNow && !untimed.checked && !time) { showError('Укажи время начала или выбери «Без времени».', timeInput); return; }
    if ((startNow || !untimed.checked) && (!Number.isSafeInteger(dur) || dur < 1)) {
      showError('Укажи окончание позже начала: проверь обе даты и время.', !endDateInput.value ? endDateInput : endTimeInput); return;
    }
    const cat = overlay.querySelector('#evm-cat')?.value || 'general';
    const pri = parseInt(overlay.querySelector('.evm-priority')?.dataset.evmPriority || '0', 10);
    const desc = overlay.querySelector('#evm-desc')?.value || '';
    const linkedTab = overlay.querySelector('#evm-linked-tab')?.value || '';
    const catColor = (isEdit && cat === initCat ? event.color : null) || cats.find(c => c.name === cat)?.color || '#9B9B9B';
    setPending(true);

    try {
      if (savedEventId != null) {
        await invoke('update_event', {
          id: savedEventId,
          title, description: desc, date, time,
          durationMinutes: dur, category: cat, color: catColor,
          completed: null, priority: pri, linkedTab,
          expectedVersion: savedVersion,
        });
        if (savedVersion != null) savedVersion++;
      } else {
        savedEventId = await invoke('create_event', {
          title, description: desc, date, time,
          durationMinutes: dur, category: cat, color: catColor, priority: pri, linkedTab,
        });
        savedVersion = 1;
      }
      changed = true;
      if (desiredGoalId !== persistedGoalId) {
        try {
          await invoke('set_calendar_task_goal', { sourceType: 'event', sourceId: String(savedEventId), goalId: desiredGoalId });
          persistedGoalId = desiredGoalId;
        } catch (err) {
          setPending(false);
          showError('Событие сохранено, но связь с целью не обновлена. Повтори сохранение — второе событие не создастся. ' + err, goalSelect);
          return;
        }
      }
      if (startNow) {
        try {
          await invoke('start_task_block', { sourceType: 'event', sourceId: String(savedEventId), failIfActive: true });
        } catch (err) {
          setPending(false);
          showError('Событие сохранено, но таймер не запущен. Можно закрыть форму или повторить запуск. ' + err);
          return;
        }
        S.selectedCalendarDate = date;
        S.calDayDate = date;
        S.calendarMonth = now.value.getMonth();
        S.calendarYear = now.value.getFullYear();
        S._calendarInner = 'day';
        if (!S.calViewMode) S.calViewMode = {};
        S.calViewMode.day = 'list';
        try { localStorage.setItem('hanni_calendar_view_mode_day', 'list'); } catch {}
        document.querySelectorAll('[data-calview]').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.calview === 'day');
        });
      }
      overlay.remove();
      notifyChange();
    } catch (err) {
      setPending(false);
      showError((changed ? 'Предыдущее сохранение выполнено, но новые изменения не сохранены: ' : 'Не удалось сохранить событие: ') + err);
    }
  };
  overlay.querySelector('#evm-form').addEventListener('submit', e => { e.preventDefault(); submitEvent(false); });
  overlay.querySelector('#evm-start-now')?.addEventListener('click', () => submitEvent(true));
}

export function showCalendarCreateModal(initialDate = null, options = {}) {
  return showEventModal(null, initialDate, { ...options, kind: options.kind || 'task' });
}

export function showCalendarTaskModal(id, options = {}) {
  return showEventModal(null, null, { ...options, kind: 'task', taskId: String(id) });
}
