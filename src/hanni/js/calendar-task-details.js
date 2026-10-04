import {taskProgress} from './task-progress.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { readActiveBlocks, sourceKey } from './calendar-execution.js';
import { ICONS } from './icons.js';
import { isInstantTask, sphereLabel } from './task-model.js';
import { loadProcesses, mountStageTime, taskStage } from './task-processes.js';
import { mountTaskWorkflow } from './task-workflow-view.js';
import { mountSharedTaskControls } from './shared-task-controls.js';

const errorText = error => (typeof error === 'string' ? error : error?.message) || '';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function formatWorkSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  if (seconds < 3600) return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(seconds / 3600)} ч ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')} мин`;
}

function formatDate(date) {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(parsed) : date;
}

function goalTitle(goals, id) {
  const chain = [], seen = new Set();
  let current = goals.find(goal => String(goal.id) === String(id));
  while (current && !seen.has(String(current.id))) {
    seen.add(String(current.id)); chain.unshift(current); current = goals.find(goal => String(goal.id) === String(current.parent_goal_id));
  }
  return chain.map(goal => goal.title).join(' / ');
}

/** Opens the compact, read-oriented task card. Stage selection saves immediately. */
export function openCalendarTaskDetails(record, dependencies) {
  const { document, invoke, returnFocus, isCurrent = () => true, onEdit, onChanged, executeAction } = dependencies;
  if (!record || record.source_type !== 'note' || record.readonly) return () => {};

  const window = document.defaultView;
  let current = { ...record }, processes = [], goals = [], activeBlocks = [], closedSeconds = 0;
  let stageState = null, historyStop = null, workflowStop = null, sharedControlsStop = null, clockTimer = null, disposed = false, pending = false, loadFailed = false, activeStatusKnown = false, timeAvailable = false, loadRevision = 0, editHandoff = null;
  const live = () => !disposed && api.modal.isConnected && isCurrent();
  const api = createCalendarDialog({
    document, title: current.title, hint: 'Задача', returnFocus, isCurrent,
    beforeClose: () => workflowStop?.beforeClose?.(),
    onClose: () => { disposed = true; loadRevision++; historyStop?.(); workflowStop?.(); sharedControlsStop?.(); if (clockTimer) window.clearInterval(clockTimer); },
  });
  const modal = api.modal;
  modal.classList.add('calendar-task-details');
  const headingContext = modal.querySelector('.calendar-editor-header > div');
  headingContext.tabIndex = 0;
  headingContext.setAttribute('role', 'group');
  headingContext.setAttribute('aria-labelledby', modal.getAttribute('aria-labelledby'));
  const headingHint = modal.querySelector('.calendar-editor-header p');
  const fields = api.body;
  fields.classList.add('calendar-task-details__fields');

  const card = document.createElement('div'); card.className = 'task-details-card';
  const route = document.createElement('section'); route.className = 'task-details-route'; route.hidden = true; route.setAttribute('aria-label', 'Маршрут задачи');
  const routeTitle = document.createElement('strong'); routeTitle.className = 'task-details-route-title';
  const routeCurrent = document.createElement('p'); routeCurrent.className = 'task-details-route-current';
  const routeNext = document.createElement('p'); routeNext.className = 'task-details-route-next';
  const routeHint = document.createElement('p'); routeHint.className = 'task-details-route-hint'; routeHint.textContent = 'Шаблоны: Настройки → Этапы задач';
  route.append(routeTitle, routeCurrent, routeNext, routeHint);
  const total = document.createElement('strong'); total.className = 'task-details-total';
  const metadata = document.createElement('div'); metadata.className = 'task-details-meta';
  const goal = document.createElement('div'); goal.className = 'task-details-goal'; goal.hidden = true;
  const stageRow = document.createElement('label'); stageRow.className = 'task-details-stage-row';
  const stageCaption = document.createElement('span'); stageCaption.className = 'task-details-stage-caption';
  const stageIcon = document.createElement('span'); stageIcon.className = 'task-details-icon'; stageIcon.innerHTML = ICONS.list;
  stageCaption.append(stageIcon, document.createTextNode('Этап'));
  const stageSelect = document.createElement('select'); stageSelect.className = 'task-details-stage'; stageSelect.setAttribute('aria-label', 'Этап задачи');
  stageRow.append(stageCaption, stageSelect);
  const waiting = document.createElement('span'); waiting.className = 'task-details-waiting'; waiting.textContent = 'Жду ответа'; waiting.hidden = !current.waiting;
  const history = document.createElement('details'); history.className = 'task-details-history';
  const historySummary = document.createElement('summary'); historySummary.innerHTML = `<span class="task-details-icon">${ICONS.list}</span><span>Время по этапам</span>`;
  const historyContent = document.createElement('div'); historyContent.className = 'task-details-history-content';
  history.append(historySummary, historyContent);
  const announcement = document.createElement('span'); announcement.className = 'task-details-sr-only'; announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
  card.append(total, metadata, goal, route, stageRow, waiting, history, announcement);
  fields.append(card);
  const sharedControlsHost = document.createElement('section'); sharedControlsHost.className = 'task-details-shared-controls'; sharedControlsHost.setAttribute('aria-label', 'Связь задачи');
  fields.append(sharedControlsHost);
  sharedControlsStop = mountSharedTaskControls(sharedControlsHost, { record: current, invoke, onShared: () => onChanged?.() });
  let confirmedWorkflow=null,workflowReadError=false;
  workflowStop = mountTaskWorkflow(fields, { record: current, invoke, review:dependencies.review||null, onSaved: () => onChanged?.(), onState:(state,failed)=>{confirmedWorkflow=state;workflowReadError=failed;syncSummary();}, onClean: () => {
    if (['Сохрани шаг или результат перед закрытием.', 'Дождись сохранения шагов.'].includes(api.error.textContent)) api.showError('');
  } });
  if (dependencies.review) {
    const resultReview = fields.querySelector('.task-result-review');
    if (resultReview) fields.prepend(resultReview);
  }

  const actions = modal.querySelector('.calendar-editor-actions');
  actions.replaceChildren();
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'task-details-edit'; edit.textContent = 'Изменить';
  const execute = document.createElement('button'); execute.type = 'button'; execute.className = 'calendar-editor-primary task-details-execute';
  const syncButton = document.createElement('span'); syncButton.className = 'task-details-button-label'; execute.append(syncButton);
  actions.append(edit, execute);

  const iconLabel = (icon, text) => {
    const item = document.createElement('span'); item.className = 'task-details-meta-item';
    const glyph = document.createElement('span'); glyph.className = 'task-details-icon'; glyph.innerHTML = icon;
    const label = document.createElement('span'); label.textContent = text;
    item.append(glyph, label); return item;
  };
  const activeForTask = blocks => blocks.filter(block => sourceKey(block) === sourceKey(current));
  const activeSeconds = now => activeForTask(activeBlocks).reduce((sum, block) => {
    const start = new Date(`${block.date}T${block.start_time}`).getTime();
    return sum + (Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0);
  }, 0);
  function paintTotal() {
    if (!timeAvailable) { total.textContent = 'Время недоступно'; return; }
    const estimate = Number(current.duration_minutes ?? current.durationMinutes);
    const planned = !isInstantTask(current) && Number.isFinite(estimate) && estimate > 0 ? ` · Оценка ${estimate} мин` : '';
    total.textContent = `Учтено ${formatWorkSeconds(closedSeconds + activeSeconds(Date.now()))}${planned}`;
    total.title = 'Общее время задачи';
  }
  function syncClock() {
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = timeAvailable && activeStatusKnown && activeForTask(activeBlocks).length ? window.setInterval(paintTotal, 1000) : null;
    paintTotal();
  }
  function syncSummary() {
    const scope = current.sphere === 'work' ? 'Работа' : sphereLabel(current.sphere) || 'Личное';
    const completed = !!current.completed || current.status === 'done' || ['done', 'skipped', 'missed'].includes(current.status_extra);
    const active = activeStatusKnown && activeForTask(activeBlocks).length > 0;
    current.is_active = active;
    const hasWork = active || !!current.has_work || (closedSeconds > 0);
    const status = loadFailed ? 'Статус недоступен' : !activeStatusKnown ? 'Проверяем статус…' : isInstantTask(current) ? (completed ? 'Завершена' : 'К выполнению') : active ? 'В работе' : hasWork ? 'На паузе' : 'Не запускалась';
    const progress=taskProgress({completed,workflow:confirmedWorkflow,workflowReadError,waiting:!!current.waiting,review:current._review,reviewReadError:!!current._reviewReadError});
    headingHint.textContent = `${scope} · ${progress?.label||status}${progress?` · ${!activeStatusKnown?'Таймер неизвестен':active?'Таймер идёт':hasWork?'Таймер на паузе':'Таймер не запущен'}`:''}`;
    const label = isInstantTask(current) ? 'Завершить' : active ? 'Пауза таймера' : hasWork ? 'Продолжить таймер' : 'Начать таймер';
    syncButton.replaceChildren();
    const glyph = document.createElement('span'); glyph.className = 'task-details-button-icon'; glyph.innerHTML = isInstantTask(current) ? ICONS.check : active ? ICONS.pause : ICONS.play;
    syncButton.append(glyph, document.createTextNode(label));
    execute.setAttribute('aria-label', `${label}: ${current.title}`);
    execute.hidden = completed;
  }
  function syncMetadata() {
    metadata.replaceChildren();
    if (current.date) metadata.append(iconLabel(ICONS.calendar, `${formatDate(current.date)}${current.time ? ` · ${current.time}` : ''}`));
    const linked = goalTitle(goals, current.goal_id ?? current.goalId);
    goal.hidden = !linked;
    if (linked) goal.replaceChildren(iconLabel(ICONS.target, linked));
  }
  function syncStageOptions() {
    stageState = taskStage(current, processes);
    stageRow.hidden = !stageState || isInstantTask(current);
    route.hidden = !stageState || isInstantTask(current);
    if (stageState && !isInstantTask(current)) {
      routeTitle.textContent = `Маршрут: ${stageState.processTitle}`;
      routeCurrent.textContent = stageState.label ? `Текущий этап: ${stageState.label}` : 'Текущий этап: не выбран';
      routeNext.textContent = stageState.next ? `Следующий этап: ${stageState.next.title}` : stageState.isLast ? 'Следующий этап: маршрут завершён' : 'Следующий этап: выбери этап';
    }
    waiting.hidden = !stageState?.waiting;
    if (!stageState) { stageSelect.replaceChildren(); return; }
    const options = [new window.Option('Без этапа', '')];
    if (stageState.deleted && stageState.stage) options.push(new window.Option(stageState.label, stageState.stage));
    for (const item of stageState.stages) options.push(new window.Option(item.title, item.id));
    stageSelect.replaceChildren(...options);
    stageSelect.value = stageState.stage || '';
    stageSelect.disabled = pending || !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
  }
  function remountHistory() {
    historyStop?.(); historyStop = null;
    if (history.open && stageState) historyStop = mountStageTime(historyContent, { invoke, row: current, processes });
  }
  function setPending(value) {
    pending = value; api.setPending(value);
    edit.disabled = value || loadFailed; execute.disabled = value || loadFailed;
    stageSelect.disabled = value || loadFailed || !stageState || !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
  }
  function setLoading(value) {
    api.form.setAttribute('aria-busy', String(value));
    api.retry.disabled = value;
    edit.disabled = value || pending || loadFailed; execute.disabled = value || pending || loadFailed;
    stageSelect.disabled = value || pending || loadFailed || !stageState || !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
  }

  syncSummary(); syncMetadata(); syncStageOptions();
  history.addEventListener('toggle', () => {
    if (history.open) remountHistory();
    else { historyStop?.(); historyStop = null; }
  });

  async function readSeconds() {
    try { return Math.max(0, Number(await invoke('get_calendar_task_seconds', { sourceType: 'note', sourceId: String(current.source_id) })) || 0); }
    catch {
      if (finite(current.actual_seconds)) return current.actual_seconds;
      if (finite(current.actual_minutes)) return current.actual_minutes * 60;
      try { return Math.max(0, Number(await invoke('get_calendar_task_minutes', { sourceType: 'note', sourceId: String(current.source_id), completionDate: current.completion_date || current.date || null })) || 0) * 60; }
      catch { return null; }
    }
  }
  async function loadData({ retry = false } = {}) {
    const request = ++loadRevision;
    if (retry) { api.showError(''); api.retry.hidden = true; }
    setLoading(true);
    try {
      const [detail, processList, goalResult, linksResult, seconds, active] = await Promise.all([
        invoke('get_calendar_task', { id: String(current.source_id) }),
        loadProcesses(invoke),
        invoke('get_goals', { tabName: null }).then(value => ({ value }), error => ({ error })),
        invoke('get_calendar_task_goals').then(value => ({ value }), error => ({ error })),
        readSeconds(),
        readActiveBlocks(invoke),
      ]);
      if (!live() || request !== loadRevision) return;
      current = { ...current, ...detail, goal_id: detail?.goal_id ?? current.goal_id };
      processes = processList; goals = Array.isArray(goalResult.value) ? goalResult.value : [];
      const links = linksResult.value;
      if (!current.goal_id && Array.isArray(links)) current.goal_id = links.find(link => link.source_type === 'note' && String(link.source_id) === String(current.source_id))?.goal_id;
      timeAvailable = Number.isFinite(seconds);
      closedSeconds = timeAvailable ? seconds : 0;
      activeBlocks = Array.isArray(active) ? active : [];
      activeStatusKnown = true; loadFailed = false;
      syncStageOptions(); syncSummary(); syncMetadata(); syncClock(); remountHistory();
      api.showError(''); api.retry.hidden = true;
    } catch (error) {
      if (!live() || request !== loadRevision) return;
      activeBlocks = []; activeStatusKnown = false; timeAvailable = false; closedSeconds = 0; loadFailed = true;
      syncSummary(); syncClock();
      api.showError(errorText(error) || 'Не удалось загрузить задачу. Попробуй ещё раз.');
      api.retry.hidden = false;
    } finally {
      if (live() && request === loadRevision) {
        setLoading(false);
        if (!loadFailed) {
          if (dependencies.review) headingContext.focus({ preventScroll: true });
          else if (stageState && !stageRow.hidden) stageSelect.focus({ preventScroll: true });
          else execute.focus({ preventScroll: true });
        }
      }
    }
  }
  api.retry.addEventListener('click', () => void loadData({ retry: true }));

  stageSelect.addEventListener('change', async () => {
    if (pending || !live() || !stageState) return;
    const next = stageSelect.value;
    if (next === (stageState.stage || '')) return;
    const previous = stageState.stage || '';
    setPending(true); api.showError('');
    try {
      const updated = await invoke('set_calendar_task_stage', { id: String(current.source_id), stage: next, waiting: null });
      if (!live()) return;
      current = { ...current, ...updated, stage: typeof updated?.stage === 'string' ? updated.stage : next, waiting: typeof updated?.waiting === 'boolean' ? updated.waiting : !!current.waiting };
      syncStageOptions(); syncSummary();syncMetadata(); remountHistory();
      announcement.textContent = `Этап: ${stageState?.label || 'Без этапа'}.`;
      onChanged?.();
    } catch (error) {
      if (live()) {
        stageSelect.value = previous;
        api.showError(errorText(error) || 'Не удалось изменить этап. Выбери его и повтори.');
        stageSelect.focus({ preventScroll: true });
      }
    } finally { if (live()) setPending(false); }
  });

  edit.addEventListener('click', () => {
    if (pending || editHandoff || !live()) return;
    const latest = { ...current };
    const intent = {
      cancel() {
        if (editHandoff !== intent) return;
        editHandoff = null;
        api.modal.removeEventListener('close', openEditor);
        if (live()) edit.disabled = pending || loadFailed || api.pending;
      },
    };
    // Native close is deferred. Keep one intent until its event or cancellation.
    const openEditor = () => {
      if (editHandoff !== intent) return;
      intent.cancel();
      if (!api.modal.isConnected && isCurrent()) onEdit?.(latest, returnFocus);
    };
    editHandoff = intent;
    edit.disabled = true;
    api.modal.addEventListener('close', openEditor, { once: true });
    void Promise.resolve(api.close({ restoreFocus: false })).then(() => {
      // A rejected draft close must permit a fresh explicit Edit, not a later close.
      if (api.modal.open) intent.cancel();
    }, () => intent.cancel());
  });

  execute.addEventListener('click', async () => {
    if (pending || !live() || typeof executeAction !== 'function') return;
    setPending(true); api.showError('');
    let activeReadSucceeded = false;
    try {
      // Re-read own active blocks so a stale card cannot start a duplicate or pause another task.
      const instant = isInstantTask(current);
      const before = await readActiveBlocks(invoke);
      activeReadSucceeded = true;
      if (!live()) return;
      activeBlocks = before; activeStatusKnown = true; syncSummary();
      const own = before.filter(block => sourceKey(block) === sourceKey(current));
      const action = instant ? 'finish' : own.length ? 'pause' : 'start';
      const result = await executeAction({ ...current }, action);
      if (result === false) return;
      onChanged?.();
      if (instant) { current.completed = true; current.status = 'done'; current.status_extra = 'done'; }
      announcement.textContent = instant ? 'Задача завершена.' : action === 'start' ? 'Задача в работе.' : 'Задача на паузе.';
      const [freshResult, activeResult, secondsResult] = await Promise.allSettled([
        invoke('get_calendar_task', { id: String(current.source_id) }), readActiveBlocks(invoke), readSeconds(),
      ]);
      if (!live()) return;
      if (freshResult.status === 'fulfilled') current = { ...current, ...freshResult.value };
      if (instant && !current.completed && current.status !== 'done' && current.status_extra !== 'done') {
        current.completed = true; current.status = 'done'; current.status_extra = 'done';
      }
      if (activeResult.status === 'fulfilled') { activeBlocks = activeResult.value; activeStatusKnown = true; }
      else { activeBlocks = []; activeStatusKnown = false; loadFailed = true; }
      if (secondsResult.status === 'fulfilled' && Number.isFinite(secondsResult.value)) { closedSeconds = secondsResult.value; timeAvailable = true; }
      else { timeAvailable = false; }
      if (freshResult.status === 'rejected' || activeResult.status === 'rejected') {
        loadFailed = true; api.retry.hidden = false;
        api.showError(errorText(freshResult.reason || activeResult.reason) || 'Не удалось обновить состояние задачи. Повтори чтение.');
      }
      syncSummary(); syncClock();
    } catch (error) {
      if (!live()) return;
      if (error?.refreshRequired) onChanged?.();
      if (!activeReadSucceeded || error?.refreshRequired) {
        activeBlocks = []; activeStatusKnown = false; loadFailed = true; syncSummary();
        api.retry.hidden = false;
      }
      api.showError(errorText(error) || 'Не удалось изменить выполнение задачи. Повтори.');
    } finally { if (live()) { setPending(false); if (loadFailed) { edit.disabled = true; execute.disabled = true; stageSelect.disabled = true; } } }
  });

  api.open(dependencies.review ? headingContext : stageRow.hidden ? execute : stageSelect);
  void loadData();
  const dispose = () => { editHandoff?.cancel(); if (!disposed) api.dispose(); };
  dispose.modal = modal;
  return dispose;
}
