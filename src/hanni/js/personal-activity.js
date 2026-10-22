import { createUiCopy } from './ui-copy.js';
import {
  formatDuration,
  formatExecutableBasenames,
  localDayBounds,
  normalizeDayResult,
  parseExecutableBasenames,
  summarizePersonalActivity,
} from './personal-activity-model.js';

export const PERSONAL_ACTIVITY_VIEW_KEY = 'personal_activity_view_v1';

function safeError(error) {
  return typeof error === 'string' ? error : error?.message || '';
}

function conflictError(error) {
  return /conflict|stale|revision|cas|changed|expected/i.test(safeError(error));
}

function errorText(error, copy, kind) {
  if (conflictError(error)) return copy(kind === 'view' ? 'Сводка дня изменилась. Нажми «Повторить проверку», затем сохрани выбор; твой выбор сохранён на экране.' : 'Настройки изменились. Нажми «Повторить проверку», затем сохрани; изменения формы сохранены.');
  return copy(kind === 'view' ? 'Не удалось сохранить выбор сводки дня. Твой выбор сохранён на экране.' : 'Не удалось сохранить настройки. Изменения формы сохранены; повтори попытку.');
}

function dayKey(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) return null;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function setText(element, selector, value) {
  const target = element.querySelector(selector);
  if (target) target.textContent = value;
}

function collectorStatus(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid status');
  const selected = parseExecutableBasenames(value.selectedExecutables ?? []);
  if (!selected.ok) throw new Error('invalid status');
  return { ...value, selectedExecutables: selected.value };
}

export async function loadPersonalActivityView(invoke) {
  const raw = await invoke('get_ui_state', { key: PERSONAL_ACTIVITY_VIEW_KEY });
  if (raw == null) return { enabled: false, raw: '' };
  if (typeof raw !== 'string') throw new Error('invalid personal activity view');
  if (raw === '') return { enabled: false, raw: '' };
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('invalid personal activity view'); }
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('invalid personal activity view');
  return { enabled: value.enabled, raw };
}

export async function savePersonalActivityView(invoke, { enabled, expectedValue = '' } = {}) {
  if (typeof expectedValue !== 'string') throw new Error('invalid personal activity view CAS value');
  const value = JSON.stringify({ version: 1, enabled: enabled === true });
  await invoke('set_ui_state', { key: PERSONAL_ACTIVITY_VIEW_KEY, value, expectedValue });
  return { enabled: enabled === true, raw: value };
}

function statusText(status, copy) {
  if (!status) return copy('Проверяем доступность учёта занятий…');
  if (status.supported === false) return copy('Сбор занятий доступен только локально на Windows, пока Cicada запущена. На iPad сбор не подключён.');
  if (status.lastError) return copy('Последняя проверка учёта занятий не завершилась. История сохранена; повтори проверку.');
  if (!status.enabled) return copy('Учёт занятий выключен. История сохранена.');
  if (status.running) return copy('Учёт занятий включён на этом устройстве.');
  return copy('Учёт занятий включён. Сбор сейчас не запущен.');
}

function freshnessText(value, copy) {
  if (!Number.isFinite(value)) return copy('Актуальность игровых данных неизвестна.');
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? copy.format('Последнее наблюдение игры на этом ПК: {0}', date.toLocaleString(copy.locale)) : copy('Актуальность игровых данных неизвестна.');
}

function configureArgs(status, enabled, selectedExecutables) {
  return { request: { expectedRevision: Number(status?.revision), enabled, selectedExecutables } };
}

/** Settings for the optional Windows collector and the independent Today view. */
export function mountPersonalActivitySettings(element, { invoke, setPending = () => {}, onDirty = () => {} } = {}) {
  const document = element.ownerDocument, window = document.defaultView, copy = createUiCopy(document);
  let disposed = false, busy = false, collectorDirty = false, viewDirty = false;
  let status = null, view = { enabled: false, raw: '' }, viewReadable = false, loadError = '', viewError = '';
  element.className = 'calendar-setting personal-activity-settings';
  element.innerHTML = `
    <h3 data-personal-activity-title></h3>
    <p data-personal-activity-description></p>
    <p data-personal-activity-status role="status" aria-live="polite"></p>
    <label class="personal-activity-settings__toggle"><input type="checkbox" data-personal-activity-enabled> <span data-personal-activity-enabled-label></span></label>
    <label for="personal-activity-executables" data-personal-activity-executables-label></label>
    <textarea id="personal-activity-executables" data-personal-activity-executables rows="2" maxlength="512" spellcheck="false"></textarea>
    <p data-personal-activity-help></p>
    <p data-personal-activity-limits></p>
    <p data-personal-activity-error role="alert" hidden></p>
    <div class="calendar-sync-actions"><button type="button" data-personal-activity-save></button><button type="button" data-personal-activity-retry></button></div>
    <hr>
    <h4 data-personal-activity-view-title></h4>
    <label class="personal-activity-settings__toggle"><input type="checkbox" data-personal-activity-view-enabled> <span data-personal-activity-view-label></span></label>
    <p data-personal-activity-view-help></p>
    <p data-personal-activity-view-error role="alert" hidden></p>
    <button type="button" data-personal-activity-view-save></button>`;
  setText(element, '[data-personal-activity-title]', copy('Учёт занятий'));
  setText(element, '[data-personal-activity-description]', copy('По желанию. Cicada учитывает только выбранные приложения Windows на этом устройстве.'));
  setText(element, '[data-personal-activity-enabled-label]', copy('Включить учёт занятий'));
  setText(element, '[data-personal-activity-executables-label]', copy('Игры на этом ПК (.exe, через запятую)'));
  setText(element, '[data-personal-activity-help]', copy('Введи только имя файла .exe, например game.exe. Cicada не читает окна или содержимое экрана.'));
  setText(element, '[data-personal-activity-limits]', copy('Работает локально на Windows, пока Cicada запущена; учитывается активность клавиатуры и мыши. Активность контроллера не учитывается надёжно. iPad к этому сбору не подключён.'));
  setText(element, '[data-personal-activity-save]', copy('Сохранить учёт занятий'));
  setText(element, '[data-personal-activity-retry]', copy('Повторить проверку'));
  setText(element, '[data-personal-activity-view-title]', copy('Сводка дня'));
  setText(element, '[data-personal-activity-view-label]', copy('Показывать сводку дня на экране Сегодня'));
  setText(element, '[data-personal-activity-view-help]', copy('Сводка выключена по умолчанию и не меняет сохранённую историю.'));
  setText(element, '[data-personal-activity-view-save]', copy('Сохранить сводку дня'));
  const enabled = element.querySelector('[data-personal-activity-enabled]');
  const executables = element.querySelector('[data-personal-activity-executables]');
  const save = element.querySelector('[data-personal-activity-save]');
  const retry = element.querySelector('[data-personal-activity-retry]');
  const error = element.querySelector('[data-personal-activity-error]');
  const viewEnabled = element.querySelector('[data-personal-activity-view-enabled]');
  const viewSave = element.querySelector('[data-personal-activity-view-save]');
  const viewErrorNode = element.querySelector('[data-personal-activity-view-error]');
  const dirty = () => collectorDirty || viewDirty;
  const reportDirty = () => onDirty(dirty());

  function render() {
    if (disposed) return;
    const unsupported = status?.supported === false;
    setText(element, '[data-personal-activity-status]', loadError || statusText(status, copy));
    setText(element, '[data-personal-activity-error]', loadError);
    error.hidden = !loadError;
    setText(element, '[data-personal-activity-view-error]', viewError);
    viewErrorNode.hidden = !viewError;
    if (!collectorDirty) enabled.checked = !!status?.enabled;
    if (!viewDirty) viewEnabled.checked = !!view.enabled;
    enabled.disabled = busy || unsupported;
    executables.disabled = busy || unsupported;
    save.disabled = busy || unsupported || !status;
    retry.disabled = busy;
    viewEnabled.disabled = busy;
    viewSave.disabled = busy || !viewDirty || !viewReadable;
  }

  async function refreshStatus() {
    if (disposed || busy) return;
    busy = true; loadError = ''; render(); setPending(true);
    try {
      const next = collectorStatus(await invoke('personal_activity_status'));
      if (disposed) return;
      status = next;
      if (!collectorDirty) {
        enabled.checked = !!next.enabled;
        executables.value = formatExecutableBasenames(next.selectedExecutables);
      }
    } catch (cause) {
      if (!disposed) loadError = safeError(cause) === 'invalid status' ? copy('Не удалось прочитать настройки. Сохранённые значения формы не изменены.') : copy('Не удалось прочитать настройки. Повтори проверку.');
    } finally { busy = false; setPending(false); if (!disposed) render(); }
  }

  async function refreshView() {
    try {
      const next = await loadPersonalActivityView(invoke);
      if (disposed) return;
      view = next; viewReadable = true; viewError = '';
      if (!viewDirty) viewEnabled.checked = next.enabled;
    } catch {
      if (!disposed) { viewReadable = false; viewError = copy('Не удалось прочитать состояние сводки дня. Повтори проверку; текущий выбор сохранён на экране.'); }
    } finally { if (!disposed) render(); }
  }

  async function refreshAll() {
    if (disposed || busy) return;
    await refreshStatus();
    if (!disposed) await refreshView();
  }

  function markCollectorDirty() { collectorDirty = true; loadError = ''; reportDirty(); render(); }
  function markViewDirty() { viewDirty = true; if (viewReadable) viewError = ''; reportDirty(); render(); }
  enabled.addEventListener('change', markCollectorDirty);
  executables.addEventListener('input', markCollectorDirty);
  viewEnabled.addEventListener('change', markViewDirty);
  save.addEventListener('click', async () => {
    if (disposed || busy || !status || status.supported === false) return;
    const parsed = parseExecutableBasenames(executables.value);
    if (!parsed.ok) { loadError = copy(parsed.error); render(); return; }
    busy = true; loadError = ''; render(); setPending(true);
    try {
      const next = collectorStatus(await invoke('personal_activity_configure', configureArgs(status, enabled.checked, parsed.value)));
      if (disposed) return;
      status = next; collectorDirty = false; enabled.checked = !!next.enabled; executables.value = formatExecutableBasenames(next.selectedExecutables); reportDirty();
    } catch (cause) { if (!disposed) loadError = errorText(cause, copy, 'collector'); }
    finally { busy = false; setPending(false); if (!disposed) render(); }
  });
  viewSave.addEventListener('click', async () => {
    if (disposed || busy || !viewDirty || !viewReadable) return;
    busy = true; viewError = ''; render(); setPending(true);
    try {
      const next = await savePersonalActivityView(invoke, { enabled: viewEnabled.checked, expectedValue: view.raw });
      if (disposed) return;
      view = next; viewDirty = false; reportDirty();
      window.dispatchEvent(new window.CustomEvent('hanni:personal-activity-view-changed', { detail: { enabled: next.enabled, raw: next.raw } }));
    } catch (cause) { if (!disposed) viewError = errorText(cause, copy, 'view'); }
    finally { busy = false; setPending(false); if (!disposed) render(); }
  });
  retry.addEventListener('click', () => void refreshAll());
  void refreshStatus(); void refreshView();
  const dispose = () => { disposed = true; };
  dispose.refresh = refreshAll;
  dispose.isDirty = () => dirty();
  return dispose;
}

function availabilityText(state, copy) {
  if (state === 'partial') return copy('Данные частичные: доступное время показано отдельно.');
  if (state === 'unsupported') return copy('Сбор занятий на этом устройстве недоступен.');
  if (state === 'disabled') return copy('Сбор выключен. Сохранённые записи остаются доступны.');
  if (state === 'unavailable') return copy('Состояние сбора недоступно. Повтори чтение.');
  return '';
}

function renderDuration(summary, selector, label, copy, element) {
  const item = summary?.[selector];
  const hasUnpreciseWalking = selector === 'walking' && summary.walkingRecordCount > summary.walkingPreciseCount;
  if (selector === 'walking' && item?.state !== 'known' && summary.walkingRecordCount > 0) {
    const message = hasUnpreciseWalking
      ? copy('Есть записи прогулок без точного времени; длительность неизвестна.')
      : copy('Есть запись прогулки; точное время недоступно.');
    setText(element, `[data-personal-activity-${selector}]`, `${label}: ${message}`);
    return;
  }
  const duration = `${label}: ${formatDuration(item?.durationMs, copy)}`;
  setText(element, `[data-personal-activity-${selector}]`, hasUnpreciseWalking
    ? `${duration}. ${copy('Есть записи прогулок без точного времени; показана только известная часть.')}`
    : duration);
  const target = element.querySelector(`[data-personal-activity-${selector}-state]`);
  if (target) target.textContent = item?.state === 'known' ? copy('Время объединено по пересечениям.') : copy('Время неизвестно: нет подтверждённого интервала.');
}

/** Read-only Today panel. Root supplies already scoped selected-task intervals. */
export function mountPersonalActivityToday(element, { invoke, date, now = () => new Date(), getSelectedTask = () => null, getTaskIntervals = null, enabled = false } = {}) {
  const document = element.ownerDocument, window = document.defaultView, copy = createUiCopy(document);
  let disposed = false, busy = false, currentEnabled = enabled === true, error = '', generation = 0, rerun = false, timer = null;
  element.className = 'personal-activity-today';
  element.innerHTML = `<section aria-labelledby="personal-activity-today-title"><h3 id="personal-activity-today-title" data-personal-activity-heading></h3><p data-personal-activity-freshness role="status"></p><p data-personal-activity-availability></p><div data-personal-activity-games></div><div data-personal-activity-walking></div><div data-personal-activity-work></div><p data-personal-activity-task></p><p data-personal-activity-error role="alert" hidden></p><button type="button" data-personal-activity-retry></button></section>`;
  setText(element, '[data-personal-activity-heading]', copy('Учёт занятий за сегодня'));
  setText(element, '[data-personal-activity-retry]', copy('Повторить'));
  const retry = element.querySelector('[data-personal-activity-retry]');
  let lastSummary = null;
  function clearReadout() {
    for (const key of ['games', 'walking', 'work']) {
      setText(element, `[data-personal-activity-${key}]`, '');
      setText(element, `[data-personal-activity-${key}-state]`, '');
    }
    setText(element, '[data-personal-activity-freshness]', '');
    setText(element, '[data-personal-activity-availability]', '');
    setText(element, '[data-personal-activity-task]', '');
  }
  function render() {
    if (disposed) return;
    element.hidden = !currentEnabled;
    retry.disabled = busy;
    setText(element, '[data-personal-activity-error]', error);
    element.querySelector('[data-personal-activity-error]').hidden = !error;
    clearReadout();
    if (busy) {
      setText(element, '[data-personal-activity-freshness]', copy('Загружаем доступные записи…'));
      return;
    }
    if (!lastSummary) return;
    setText(element, '[data-personal-activity-task]', lastSummary.taskTitle ? copy.format('Выбрано: {0}', lastSummary.taskTitle) : '');
    setText(element, '[data-personal-activity-freshness]', freshnessText(lastSummary.freshnessMs, copy));
    setText(element, '[data-personal-activity-availability]', availabilityText(lastSummary.observationState, copy));
    renderDuration(lastSummary, 'games', copy('Игры на этом ПК'), copy, element);
    renderDuration(lastSummary, 'walking', copy('Прогулки'), copy, element);
    renderDuration(lastSummary, 'work', copy('Выбранная задача'), copy, element);
  }
  function scheduleTimer() {
    if (timer != null) window.clearInterval(timer);
    timer = currentEnabled && !disposed ? window.setInterval(() => void refresh(), 30_000) : null;
  }
  async function refresh() {
    if (disposed || !currentEnabled) return;
    if (busy) { rerun = true; return; }
    const run = ++generation;
    busy = true; error = ''; lastSummary = null; render();
    try {
      const targetDate = date || dayKey(now()), bounds = localDayBounds(targetDate);
      if (!bounds) throw new Error('invalid day');
      const selected = await getSelectedTask();
      if (disposed || run !== generation || !currentEnabled) return;
      const dayPromise = invoke('personal_activity_day', { request: { date: targetDate, startMs: bounds.startMs, endMs: bounds.endMs } });
      const walkingPromise = invoke('personal_activity_walks', { request: { date: targetDate, startMs: bounds.startMs, endMs: bounds.endMs } });
      const taskPromise = getTaskIntervals ? getTaskIntervals({ date: targetDate, startMs: bounds.startMs, endMs: bounds.endMs, task: selected }) : Promise.resolve(selected?.intervals);
      const [dayRead, walkingRead, taskRead] = await Promise.allSettled([dayPromise, walkingPromise, taskPromise]);
      if (disposed || run !== generation || !currentEnabled) return;
      let dayResult = null, walkingRecords = null, walkingAvailable = false, taskIntervals = null, taskAvailable = false;
      if (dayRead.status === 'fulfilled') {
        dayResult = normalizeDayResult(dayRead.value, bounds);
        if (!dayResult) error = copy('Состояние занятий получено в неполном формате. Повтори чтение.');
      } else error = copy('Не удалось прочитать занятия. Сохранённые записи не потеряны; повтори попытку.');
      if (walkingRead.status === 'fulfilled') { walkingRecords = walkingRead.value; walkingAvailable = Array.isArray(walkingRecords); }
      if (taskRead.status === 'fulfilled') { taskIntervals = taskRead.value; taskAvailable = Array.isArray(taskIntervals); }
      lastSummary = summarizePersonalActivity({ bounds, dayResult, walkingRecords, walkingAvailable, taskIntervals, taskAvailable });
      if (selected?.title) lastSummary.taskTitle = String(selected.title);
    } catch {
      if (!disposed && run === generation) error = copy('Не удалось обновить сводку дня. Сохранённые записи не потеряны; повтори попытку.');
    } finally {
      if (run === generation) { busy = false; if (!disposed) render(); }
      if (!disposed && run === generation && rerun) { rerun = false; void refresh(); }
    }
  }
  retry.addEventListener('click', () => void refresh());
  const setEnabled = value => {
    generation++; busy = false; rerun = false; currentEnabled = value === true; lastSummary = null; error = ''; scheduleTimer(); render();
    if (currentEnabled) void refresh();
  };
  const setCollectorStatus = () => {}; // Kept as a compatible hook; freshness comes from day.observedMs.
  const onCalendarRefresh = () => { void refresh(); };
  window.addEventListener('hanni:calendar-refresh', onCalendarRefresh);
  scheduleTimer(); render();
  if (currentEnabled) void refresh();
  const dispose = () => { disposed = true; generation++; busy = false; rerun = false; if (timer != null) window.clearInterval(timer); window.removeEventListener('hanni:calendar-refresh', onCalendarRefresh); };
  dispose.refresh = refresh;
  dispose.setEnabled = setEnabled;
  dispose.setCollectorStatus = setCollectorStatus;
  return dispose;
}
