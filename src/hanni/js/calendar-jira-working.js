import { ICONS } from './icons.js';
import { jiraWorkflowRole } from './jira-workflow-model.js';
import { loadProcesses, taskStage } from './task-processes.js';

const keyOf = row => row ? `${row.source_type}:${String(row.source_id)}` : '';
const hasWork = row => Boolean(row.has_work || Number(row.actual_seconds) > 0 || Number(row.actual_minutes) > 0);
const eligible = row => jiraWorkflowRole(row) === 'working' && !row.archived && !row.readonly && !row.completed && (!row.status_extra || row.status_extra === 'task');

/** Jira progress describes the task; local execution is always a separate action. */
export function mountCalendarJiraWorking(element, { invoke, executeAction, notifyChange, onSelect, onStarted }) {
  const doc = element.ownerDocument, win = doc.defaultView;
  let disposed = false, rows = null, processes = [], selectedKey = '', busy = false, revision = 0;
  let readError = '', actionError = '', signature = '';
  element.classList.add('calendar-jira-working');
  element.hidden = true;
  element.innerHTML = `<header><h3 tabindex="-1">Начатые в Jira <span data-jira-working-count></span></h3></header>
    <p class="calendar-jira-working__selection" data-jira-working-selection hidden>Выбранная задача показана выше.</p>
    <ul data-jira-working-list></ul><p class="calendar-jira-working__error" data-jira-working-error role="alert" hidden></p><button type="button" data-jira-working-retry hidden>Обновить список</button>`;
  const q = name => element.querySelector(`[data-jira-working-${name}]`);
  const node = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
  const taskButton = (key, action) => [...element.querySelectorAll('[data-jira-working-action]')].find(button => button.dataset.jiraWorkingKey === key && button.dataset.jiraWorkingAction === action);
  function render() {
    if (disposed) return;
    const visible = (rows || []).filter(row => keyOf(row) !== selectedKey);
    const error = actionError || readError;
    element.hidden = !visible.length && !error;
    q('count').textContent = String(rows?.length || 0);
    q('selection').hidden = !rows?.some(row => keyOf(row) === selectedKey);
    q('error').textContent = error; q('error').hidden = !error; q('retry').hidden = !error; q('retry').disabled = busy;
    const nextSignature = JSON.stringify([visible, processes, busy]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const focused = element.contains(doc.activeElement) ? { key: doc.activeElement.dataset.jiraWorkingKey, action: doc.activeElement.dataset.jiraWorkingAction } : null;
    q('list').replaceChildren(...visible.map(row => {
      const item = node('li', 'calendar-jira-working__row'); item.dataset.jiraWorkingTask = keyOf(row);
      const content = node('div', 'calendar-jira-working__content');
      const title = node('button', 'calendar-jira-working__title', row.title); title.type = 'button'; title.dataset.jiraWorkingKey = keyOf(row); title.dataset.jiraWorkingAction = 'select'; title.disabled = busy;
      title.addEventListener('click', () => { if (!busy && !disposed) onSelect?.(row); });
      const stage = taskStage(row, processes);
      const meta = node('span', 'calendar-jira-working__meta', [`Jira: ${row.jira_status}`, stage?.label && `Этап: ${stage.label}`, stage?.waiting && 'Жду ответа'].filter(Boolean).join(' · '));
      const state = node('span', 'calendar-jira-working__state', row.is_active ? 'Идёт учёт времени' : hasWork(row) ? 'На паузе' : 'Учёт времени не запущен');
      content.append(title, meta, state);
      const action = row.is_active ? 'pause' : 'start';
      const label = row.is_active ? 'Приостановить учёт времени' : hasWork(row) ? 'Продолжить учёт времени' : 'Начать учёт времени';
      const control = node('button', 'calendar-jira-working__control'); control.type = 'button'; control.title = label; control.setAttribute('aria-label', `${label}: ${row.title}`);
      control.dataset.jiraWorkingKey = keyOf(row); control.dataset.jiraWorkingAction = action; control.disabled = busy || !executeAction;
      control.innerHTML = ICONS[row.is_active ? 'pause' : 'play'];
      control.addEventListener('click', () => void execute(row, action));
      item.append(content, control); return item;
    }));
    if (focused?.key) taskButton(focused.key, focused.action)?.focus({ preventScroll: true });
  }
  async function refresh() {
    if (disposed || busy) return;
    const own = ++revision;
    try {
      const [tasks, templates] = await Promise.all([invoke('get_calendar_tasks', {}), loadProcesses(invoke)]);
      if (disposed || own !== revision) return;
      if (!Array.isArray(tasks)) throw new Error('Invalid task response');
      rows = [...new Map(tasks.filter(eligible).map(row => [keyOf(row), row])).values()];
      processes = templates; readError = ''; render();
    } catch {
      if (!disposed && own === revision) { readError = rows ? 'Не удалось обновить начатые задачи. Показан предыдущий список.' : 'Не удалось загрузить начатые задачи Jira.'; render(); }
    }
  }
  async function execute(row, action) {
    if (disposed || busy || !executeAction) return;
    busy = true; revision++; actionError = ''; render();
    try {
      if (await executeAction(row, action) === false || disposed) return;
      if (action === 'start') onStarted?.(row);
      notifyChange?.();
    } catch (cause) {
      if (disposed) return;
      actionError = cause?.jiraWorkflow === true && cause.message ? cause.message : 'Не удалось изменить учёт времени. Обнови список и попробуй ещё раз.';
      if (cause?.refreshRequired) notifyChange?.();
    } finally {
      busy = false;
      if (!disposed) { await refresh(); render(); }
    }
  }
  q('retry').onclick = () => { actionError = ''; void refresh(); };
  const changed = () => { void refresh(); };
  for (const event of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:jira-imported', 'focus']) win.addEventListener(event, changed);
  void refresh();
  const dispose = () => { disposed = true; revision++; for (const event of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:jira-imported', 'focus']) win.removeEventListener(event, changed); };
  dispose.setSelectedTask = row => { const next = keyOf(row); if (next === selectedKey) return; selectedKey = next; render(); };
  dispose.refresh = refresh;
  return dispose;
}
