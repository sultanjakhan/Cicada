import { createCalendarDialog } from './calendar-dialog.js';
import { readActiveBlocks, sourceKey } from './calendar-execution.js';
import { ICONS } from './icons.js';
import { isInstantTask, sphereLabel } from './task-model.js';
import { loadProcesses, mountStageTime, taskStage } from './task-processes.js';

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

function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
  let stageState = null, historyStop = null, clockTimer = null, disposed = false, pending = false, loadRevision = 0;
  const live = () => !disposed && api.modal.isConnected && isCurrent();
  const api = createCalendarDialog({
    document, title: current.title, hint: 'Задача', returnFocus, isCurrent,
    onClose: () => { disposed = true; loadRevision++; historyStop?.(); if (clockTimer) window.clearInterval(clockTimer); },
  });
  const modal = api.modal;
  modal.classList.add('calendar-task-details');
  const headingHint = modal.querySelector('.calendar-editor-header p');
  const fields = api.body;
  fields.classList.add('calendar-task-details__fields');

  const card = document.createElement('div'); card.className = 'task-details-card';
  const stateLine = document.createElement('div'); stateLine.className = 'task-details-state';
  const scope = document.createElement('span'); scope.className = 'task-details-scope';
  const stateLabel = document.createElement('span'); stateLabel.className = 'task-details-state-label';
  stateLine.append(scope, stateLabel);
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
  card.append(stateLine, total, metadata, goal, stageRow, waiting, history, announcement);
  fields.append(card);

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
  function paintTotal() { total.textContent = `Учтено ${formatWorkSeconds(closedSeconds + activeSeconds(Date.now()))}`; }
  function syncClock() {
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = activeForTask(activeBlocks).length ? window.setInterval(paintTotal, 1000) : null;
    paintTotal();
  }
  function syncSummary() {
    const work = current.sphere === 'work';
    scope.textContent = work ? 'Работа' : sphereLabel(current.sphere) || 'Личное';
    const active = activeForTask(activeBlocks).length > 0 || !!current.is_active;
    current.is_active = active;
    const hasWork = active || !!current.has_work || (closedSeconds > 0);
    stateLabel.textContent = active ? 'В работе' : hasWork ? 'На паузе' : 'Не запускалась';
    headingHint.textContent = `${scope.textContent} · ${stateLabel.textContent}`;
    const label = active ? 'Пауза' : hasWork ? 'Продолжить' : 'Начать';
    syncButton.replaceChildren();
    const glyph = document.createElement('span'); glyph.className = 'task-details-button-icon'; glyph.innerHTML = active ? ICONS.pause : ICONS.play;
    syncButton.append(glyph, document.createTextNode(label));
    execute.setAttribute('aria-label', `${label}: ${current.title}`);
    execute.hidden = !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
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
    edit.disabled = value; execute.disabled = value;
    stageSelect.disabled = value || !stageState || !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
  }
  function setLoading(value) {
    api.form.setAttribute('aria-busy', String(value));
    api.retry.disabled = value;
    edit.disabled = value || pending; execute.disabled = value || pending;
    stageSelect.disabled = value || pending || !stageState || !!current.completed || ['done', 'skipped', 'missed'].includes(current.status_extra);
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
      catch { return 0; }
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
        readActiveBlocks(invoke).catch(() => []),
      ]);
      if (!live() || request !== loadRevision) return;
      current = { ...current, ...detail, goal_id: detail?.goal_id ?? current.goal_id };
      processes = processList; goals = Array.isArray(goalResult.value) ? goalResult.value : [];
      const links = linksResult.value;
      if (!current.goal_id && Array.isArray(links)) current.goal_id = links.find(link => link.source_type === 'note' && String(link.source_id) === String(current.source_id))?.goal_id;
      closedSeconds = Number.isFinite(seconds) ? seconds : (finite(current.actual_seconds) ? current.actual_seconds : 0);
      activeBlocks = Array.isArray(active) ? active : [];
      syncStageOptions(); syncSummary(); syncMetadata(); syncClock(); remountHistory();
      api.showError(''); api.retry.hidden = true;
    } catch (error) {
      if (!live() || request !== loadRevision) return;
      api.showError(errorText(error) || 'Не удалось загрузить задачу. Попробуй ещё раз.');
      api.retry.hidden = false;
      stageSelect.disabled = true; execute.disabled = true;
    } finally {
      if (live() && request === loadRevision) {
        setLoading(false);
        if (stageState && !stageRow.hidden) stageSelect.focus({ preventScroll: true });
        else execute.focus({ preventScroll: true });
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
      syncStageOptions(); syncMetadata(); remountHistory();
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
    if (pending || !live()) return;
    const latest = { ...current };
    api.close({ restoreFocus: false });
    onEdit?.(latest, returnFocus);
  });

  execute.addEventListener('click', async () => {
    if (pending || !live() || typeof executeAction !== 'function') return;
    setPending(true); api.showError('');
    try {
      // Re-read own active blocks so a stale card cannot start a duplicate or pause another task.
      const before = await readActiveBlocks(invoke);
      if (!live()) return;
      const own = before.filter(block => sourceKey(block) === sourceKey(current));
      const action = own.length ? 'pause' : 'start';
      const result = await executeAction({ ...current }, action);
      if (result === false) return;
      onChanged?.();
      current.is_active = action === 'start';
      const now = new Date();
      activeBlocks = action === 'start' ? [...before, { source_type: 'note', source_id: current.source_id, date: localDay(now), start_time: now.toTimeString().slice(0, 8) }] : before.filter(block => !own.includes(block));
      syncSummary(); syncClock();
      announcement.textContent = action === 'start' ? 'Задача в работе.' : 'Задача на паузе.';
      try {
        const [fresh, active, seconds] = await Promise.all([
          invoke('get_calendar_task', { id: String(current.source_id) }), readActiveBlocks(invoke), readSeconds(),
        ]);
        if (!live()) return;
        current = { ...current, ...fresh };
        activeBlocks = Array.isArray(active) ? active : [];
        closedSeconds = Number.isFinite(seconds) ? seconds : closedSeconds;
        syncSummary(); syncClock();
      } catch { /* The successful action still stands; the shared surface will refresh. */ }
    } catch (error) {
      if (!live()) return;
      if (error?.refreshRequired) onChanged?.();
      api.showError(errorText(error) || 'Не удалось изменить выполнение задачи. Повтори.');
    } finally { if (live()) setPending(false); }
  });

  api.open(stageRow.hidden ? execute : stageSelect);
  void loadData();
  const dispose = () => { if (!disposed) api.dispose(); };
  dispose.modal = modal;
  return dispose;
}
