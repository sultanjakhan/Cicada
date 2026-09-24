// «В работе» (owner decisions 2026-09-24): every running task plus tasks paused
// today that are still open. Each row shows the task's total time against its
// estimate, its work stage and goal. Start, pause, finish and cancel use the
// shared native commands and never touch other running tasks.
import { ICONS } from './icons.js';
import { readActiveBlocks, startCalendarExecution, sourceKey } from './calendar-execution.js';
import { TASK_STAGES, stageLabel, isInstantTask } from './task-model.js';

const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
const WAIT_ICON = '<svg class="cip-stage-mark" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 1.5h5M3.5 10.5h5M4 1.5v1.3C4 4.1 6 4.8 6 6s-2 1.9-2 3.2v1.3M8 1.5v1.3C8 4.1 6 4.8 6 6s2 1.9 2 3.2v1.3"/></svg>';
const CHEVRON = '<svg class="cip-stage-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 4 2.5 2.5L7.5 4"/></svg>';
const RUNNABLE = ['note', 'event', 'schedule'];
// Device-local memory of «Остановить»: { sourceKey: stoppedAtISO }. Not synchronized.
export const HIDDEN_KEY = 'calendar_in_progress_hidden_v1';
const HIDDEN_DAYS = 2;
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const blockSeconds = block => Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60);
const blockStart = block => new Date(`${block.date}T${block.start_time}`).getTime();
const oneOf = count => count % 10 === 1 && count % 100 !== 11;
// «2 идут · 1 на паузе»: the header counts only running work, the widget names both parts.
const summaryOf = rows => { const running = rows.filter(row => row.running).length, paused = rows.length - running;
  return [running && `${running} ${oneOf(running) ? 'идёт' : 'идут'}`, paused && `${paused} на паузе`].filter(Boolean).join(' · '); };
const closedTask = row => !row || row.archived || row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra || row.status);
const errorText = error => (typeof error === 'string' ? error : error?.message) || '';
let sequence = 0;

/** Under an hour: mm:ss. Longer: «1 ч 05 мин». */
export function formatWorkTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 3600) return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${Math.floor(total / 3600)} ч ${String(Math.floor(total % 3600 / 60)).padStart(2, '0')} мин`;
}
/** «12 / 60 мин» against an estimate, «12 мин» without one. */
export function formatAgainstEstimate(seconds, estimate) {
  const minutes = Math.max(0, Math.floor((Number(seconds) || 0) / 60));
  return estimate > 0 ? `${minutes} / ${estimate} мин` : `${minutes} мин`;
}
function readHidden(raw) {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(Date.parse(at)))) : {};
  } catch { return {}; }
}

export function mountCalendarInProgress(element, dependencies) {
  const { invoke, openTask, openLauncher, notifyChange } = dependencies;
  const clock = dependencies.now || (() => new Date());
  const doc = element.ownerDocument, win = doc.defaultView;
  const prefix = `calendar-in-progress-${++sequence}`;
  let rows = null, failed = false, busy = false, disposed = false, revision = 0, queued = false, feedback = null;
  let hidden = {}, hiddenRaw = null, confirming = null, menu = null;
  let day = dayOf(clock());
  element.classList.add('calendar-in-progress');
  element.innerHTML = `<section class="cip-card" aria-labelledby="${prefix}-title" data-cip-card>
    <div class="cip-heading" data-cip-heading><h2 id="${prefix}-title" tabindex="-1" data-cip-title>В работе</h2><span class="cip-summary" data-cip-count></span></div>
    <ul class="cip-list" data-cip-list></ul>
    <div class="cip-footer" data-cip-footer><button type="button" class="cip-launch" data-cip-launch aria-haspopup="dialog"><span aria-hidden="true">＋</span> Запустить ещё</button></div>
    <div class="cip-empty" data-cip-empty hidden><span class="cip-empty-text" data-cip-empty-text>Ничего не запущено</span><button type="button" class="cip-start" data-cip-launch data-cip-empty-launch aria-haspopup="dialog"><span class="cip-glyph" aria-hidden="true">${ICONS.play}</span>Запустить</button><button type="button" class="cip-start" data-cip-retry hidden>Повторить</button></div>
    <p class="cip-message" data-cip-message role="status" aria-live="polite"></p>
  </section>`;
  const q = name => element.querySelector(`[data-cip-${name}]`);
  const card = q('card'), title = q('title'), list = q('list'), message = q('message');
  const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text != null) value.textContent = text; return value; };
  const iconButton = (className, icon, label, control, row) => {
    const button = node('button', `cip-icon ${className}`); button.type = 'button';
    button.innerHTML = icon; button.title = label; button.setAttribute('aria-label', `${label}: ${row.title}`);
    button.dataset.cipControl = control; button.dataset.cipKey = row.key; button.disabled = busy;
    return button;
  };
  const findControl = (key, control) => [...element.querySelectorAll('[data-cip-control]')].find(button => button.dataset.cipKey === key && button.dataset.cipControl === control);
  const focusFallback = () => { if (!disposed && element.isConnected) (rows?.length ? title : q('empty-launch')).focus({ preventScroll: true }); };
  const restore = (key, control) => { if (disposed || !element.isConnected) return; const button = findControl(key, control) || findControl(key, 'open'); if (button) button.focus({ preventScroll: true }); else focusFallback(); };

  // Total recorded time of the task (all days) plus its running block(s), live.
  function secondsOf(row, now = clock()) {
    return row.baseSeconds + row.starts.reduce((sum, start) => sum + Math.max(0, Math.floor((now - start) / 1000)), 0);
  }
  function timeState(row, now = clock()) {
    const seconds = secondsOf(row, now), minutes = Math.floor(seconds / 60);
    const over = row.estimate > 0 && minutes > row.estimate;
    const text = formatAgainstEstimate(seconds, row.estimate);
    const label = `${row.running ? 'Идёт' : 'На паузе'}. Учтено ${row.estimate > 0 ? `${minutes} из ${row.estimate} мин${over ? ', больше оценки' : ''}` : `${minutes} мин`}`;
    return { text, label, over, ratio: row.estimate > 0 ? Math.min(1, seconds / 60 / row.estimate) : 0 };
  }
  function paintTime(row, time, bar, now) {
    const state = timeState(row, now);
    time.textContent = state.text; time.setAttribute('aria-label', state.label); time.title = state.label;
    time.classList.toggle('is-over', state.over);
    if (bar) { bar.classList.toggle('is-over', state.over); bar.firstChild.style.width = `${Math.round(state.ratio * 1000) / 10}%`; }
  }
  function renderTimes() {
    if (disposed || !rows) return;
    const now = clock();
    for (const item of list.children) {
      const row = rows.find(value => value.key === item.dataset.contextRecord);
      if (row?.running) paintTime(row, item.querySelector('[data-cip-time]'), item.querySelector('[data-cip-progress]'), now);
    }
  }
  function stageChip(row) {
    const chip = node('button', 'cip-stage'); chip.type = 'button';
    chip.dataset.cipControl = 'stage'; chip.dataset.cipKey = row.key; chip.disabled = busy;
    chip.setAttribute('aria-haspopup', 'menu'); chip.setAttribute('aria-expanded', String(menu?.key === row.key && menu.control === 'stage'));
    const label = stageLabel(row.stage);
    chip.classList.toggle('is-empty', !label && !row.waiting);
    chip.classList.toggle('is-waiting', row.waiting);
    const text = node('span', 'cip-stage-text', row.waiting ? ['Жду ответа', label].filter(Boolean).join(' · ') : label || 'Стадия');
    chip.innerHTML = row.waiting ? WAIT_ICON : '';
    chip.append(text); chip.insertAdjacentHTML('beforeend', CHEVRON);
    const description = `Стадия: ${label || 'не выбрана'}${row.waiting ? ', жду ответа' : ''}`;
    chip.title = description; chip.setAttribute('aria-label', `${description}. Изменить: ${row.title}`);
    return chip;
  }
  function confirmPanel(row) {
    const panel = node('div', 'cip-confirm'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `Отменить запуск: ${row.title}`);
    const minutes = Math.floor(row.starts.reduce((sum, start) => sum + Math.max(0, clock() - start), 0) / 60000);
    const text = node('span', 'cip-confirm-text', `Время этого запуска${minutes ? ` (${minutes} мин)` : ''} не сохранится.`);
    const yes = node('button', 'cip-confirm-yes', 'Отменить запуск'); yes.type = 'button'; yes.dataset.cipControl = 'cancel-confirm'; yes.dataset.cipKey = row.key; yes.disabled = busy;
    const no = node('button', 'cip-confirm-no', 'Оставить'); no.type = 'button'; no.dataset.cipControl = 'cancel-keep'; no.dataset.cipKey = row.key; no.disabled = busy;
    panel.append(text, yes, no);
    return panel;
  }
  function renderRow(row) {
    const item = node('li', `cip-row ${row.running ? 'is-running' : 'is-paused'}`);
    item.dataset.contextRecord = row.key;
    const open = node('button', 'cip-title', row.title); open.type = 'button'; open.title = row.title;
    open.dataset.cipControl = 'open'; open.dataset.cipKey = row.key;
    const time = node('span', 'cip-time'); time.dataset.cipTime = row.key;
    const head = node('div', 'cip-line'); head.append(open, time);
    const content = node('div', 'cip-content'); content.append(head);
    const meta = node('div', 'cip-line cip-meta');
    if (row.showStage) meta.append(stageChip(row));
    if (row.goal) { const goal = node('span', 'cip-goal', row.goal); goal.title = `Цель: ${row.goal}`; meta.append(goal); }
    if (meta.childElementCount) content.append(meta);
    let bar = null;
    if (row.estimate > 0) { bar = node('span', 'cip-progress'); bar.dataset.cipProgress = ''; bar.setAttribute('aria-hidden', 'true'); bar.append(node('span')); content.append(bar); }
    paintTime(row, time, bar);
    const actions = node('div', 'cip-actions');
    const toggle = iconButton(`cip-toggle${row.running ? ' is-running' : ''}`, ICONS[row.running ? 'pause' : 'play'], row.running ? 'Пауза' : 'Продолжить', 'toggle', row);
    const finish = iconButton('cip-finish', ICONS.check, 'Готово', 'finish', row);
    const more = iconButton('cip-more', MORE_ICON, 'Действия', 'menu', row);
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(menu?.key === row.key && menu.control === 'menu'));
    actions.append(toggle, finish, more);
    item.append(content, actions);
    if (confirming === row.key) { item.classList.add('is-confirming'); item.append(confirmPanel(row)); }
    return item;
  }
  function render() {
    if (disposed) return;
    const focused = doc.activeElement, focusKey = element.contains(focused) ? focused.dataset.cipKey : null, focusControl = focused?.dataset?.cipControl;
    if (confirming && !rows?.some(row => row.key === confirming && row.running)) confirming = null;
    const empty = !rows?.length;
    card.classList.toggle('is-empty', empty);
    card.setAttribute('aria-busy', String(busy || rows === null));
    q('heading').hidden = empty; list.hidden = empty; q('footer').hidden = empty; q('empty').hidden = !empty;
    q('empty-text').textContent = rows === null ? (failed ? 'Не удалось загрузить задачи в работе.' : 'Загружаем задачи в работе…') : 'Ничего не запущено';
    q('empty-launch').hidden = rows === null; q('retry').hidden = !(rows === null && failed);
    q('count').textContent = empty ? '' : summaryOf(rows);
    element.querySelectorAll('[data-cip-launch], [data-cip-retry]').forEach(button => { button.disabled = busy; });
    list.replaceChildren(...(rows || []).map(renderRow));
    message.textContent = feedback?.text || (rows && failed ? 'Не удалось обновить список. Показано последнее состояние.' : '');
    message.setAttribute('role', feedback?.error || (rows && failed) ? 'alert' : 'status');
    // An open menu follows its re-rendered trigger or closes with its row.
    if (menu) { const trigger = findControl(menu.key, menu.control); if (trigger && !busy) { menu.trigger = trigger; trigger.setAttribute('aria-expanded', 'true'); } else closeMenu(menu.menu.contains(doc.activeElement)); }
    if (focusKey && !focused.isConnected) restore(focusKey, focusControl);
  }
  async function load(today) {
    const [running, blocks, hiddenValue] = await Promise.all([readActiveBlocks(invoke), invoke('get_timeline_blocks', { date: today }), invoke('get_ui_state', { key: HIDDEN_KEY }).catch(() => hiddenRaw)]);
    if (!Array.isArray(running) || !Array.isArray(blocks)) throw new Error('Invalid timeline response');
    const entries = new Map();
    const entry = block => {
      const key = sourceKey(block);
      if (!entries.has(key)) entries.set(key, { key, source_type: block.source_type, source_id: String(block.source_id), running: false, blockIds: [], starts: [], closedSeconds: 0, latestStart: -Infinity, lastBlock: null, title: '', active: null });
      return entries.get(key);
    };
    for (const block of running.filter(value => RUNNABLE.includes(value.source_type))) {
      const row = entry(block); row.running = true; row.blockIds.push(Number(block.id));
      const start = blockStart(block);
      if (Number.isFinite(start)) { row.starts.push(start); row.latestStart = Math.max(row.latestStart, start); }
      row.title ||= block.title || ''; row.completion_date ||= block.completion_date || block.date; row.lastBlock ||= block; row.active ||= block;
    }
    const runningKeys = new Set(entries.keys());
    for (const block of blocks.filter(value => RUNNABLE.includes(value.source_type) && !value.is_active)) {
      const key = sourceKey(block);
      // A task that is not running now appears only when it was worked on today.
      const row = runningKeys.has(key) ? entries.get(key) : entry(block);
      row.closedSeconds += blockSeconds(block);
      const start = blockStart(block);
      if (Number.isFinite(start)) row.latestStart = Math.max(row.latestStart, start);
      if (!row.running && (!row.lastBlock || `${block.end_time || block.start_time}` > `${row.lastBlock.end_time || row.lastBlock.start_time}`)) { row.lastBlock = block; row.completion_date = block.completion_date || block.date; }
    }
    const types = new Set([...entries.values()].map(row => row.source_type));
    const [tasks, events, schedules, links, goals] = await Promise.all([
      types.has('note') ? invoke('get_calendar_tasks', {}) : [],
      types.has('event') ? invoke('get_all_events', {}) : [],
      types.has('schedule') ? invoke('get_schedules', {}) : [],
      // The goal is context only; without it the rows still work.
      entries.size ? invoke('get_calendar_task_goals', {}).catch(() => []) : [],
      entries.size ? invoke('get_goals', { tabName: null }).catch(() => []) : [],
    ]);
    // «Остановить» hides a paused task until a block starts after the stop.
    const nextHidden = readHidden(hiddenValue), horizon = clock().getTime() - HIDDEN_DAYS * 86400000;
    for (const [key, at] of Object.entries(nextHidden)) {
      const stopped = Math.floor(Date.parse(at) / 1000) * 1000, row = entries.get(key);
      if (stopped < horizon || row?.running || (row && row.latestStart >= stopped)) delete nextHidden[key];
    }
    const result = [];
    for (const row of entries.values()) {
      if (!row.running && nextHidden[row.key]) continue;
      let record;
      if (row.source_type === 'note') record = tasks.find(task => task.source_type === 'note' && String(task.source_id) === row.source_id);
      else if (row.source_type === 'event') { const event = events.find(value => String(value.id) === row.source_id); record = event && { ...event, source_type: 'event', source_id: String(event.id), planned_time: event.time, status_extra: event.status }; }
      else record = schedules.find(value => String(value.source_id ?? value.id) === row.source_id);
      // Paused work leaves the widget once its task is finished, skipped or removed.
      if (!row.running && (closedTask(record) || (row.source_type === 'note' && record?.status_extra !== 'task'))) continue;
      row.title = record?.title || row.title || 'Без названия';
      if (row.source_type === 'schedule' && !row.running && record?.block_id != null) row.lastBlockId = Number(record.block_id);
      row.record = { ...(record || {}), source_type: row.source_type, source_id: row.source_id, title: row.title, is_active: row.running, has_work: true, completion_date: row.completion_date, date: record?.date ?? (row.source_type === 'note' ? null : row.completion_date) };
      // Closed work of every day comes from the task row; events fall back to today's blocks.
      row.baseSeconds = Number.isFinite(Number(record?.actual_minutes)) && record?.actual_minutes != null ? Number(record.actual_minutes) * 60 : row.closedSeconds;
      const instant = row.source_type === 'note' && isInstantTask(record || row.active);
      row.estimate = row.source_type === 'note' && !instant && Number(record?.duration_minutes) > 0 ? Number(record.duration_minutes) : null;
      row.showStage = row.source_type === 'note' && !instant;
      row.stage = String(record?.stage ?? row.active?.stage ?? '');
      row.waiting = !!(record?.waiting ?? row.active?.waiting);
      const link = links.find(value => sourceKey(value) === row.key);
      row.goal = link ? goals.find(goal => String(goal.id) === String(link.goal_id))?.title || '' : '';
      result.push(row);
    }
    const raw = JSON.stringify(nextHidden);
    if (raw !== JSON.stringify(readHidden(hiddenValue))) void saveHidden(nextHidden).catch(() => {});
    else { hidden = nextHidden; hiddenRaw = hiddenValue ?? null; }
    const order = [...runningKeys];
    return result.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1) || (a.running ? order.indexOf(a.key) - order.indexOf(b.key)
      : `${b.lastBlock?.end_time || b.lastBlock?.start_time || ''}`.localeCompare(`${a.lastBlock?.end_time || a.lastBlock?.start_time || ''}`)));
  }
  async function saveHidden(next) {
    hidden = next;
    const value = JSON.stringify(next);
    await invoke('set_ui_state', { key: HIDDEN_KEY, value });
    hiddenRaw = value;
  }
  async function refresh(canCommit = null) {
    if (disposed || busy || (canCommit && !canCommit())) return;
    // A new day rereads once; a failed read waits for Retry or the next change event.
    const request = ++revision, today = day = dayOf(clock());
    try {
      const next = await load(today);
      if (disposed || request !== revision || busy || (canCommit && !canCommit())) return;
      rows = next; failed = false;
      dependencies.onRowsChange?.(rows.map(row => row.key));
    } catch {
      if (disposed || request !== revision) return;
      failed = true;
    }
    render();
  }
  const pauseAll = async row => { for (const blockId of row.blockIds) await invoke('pause_task_block', { blockId }); };
  async function act(row, action) {
    if (disposed || busy) return;
    closeMenu(false);
    busy = true; feedback = null; revision++; confirming = null; render();
    let control = { finish: 'open', stop: 'open', cancel: 'open', stage: 'stage', waiting: 'stage' }[action.kind] || 'toggle';
    try {
      if (action.kind === 'pause') await pauseAll(row);
      else if (action.kind === 'start') await startCalendarExecution(invoke, { source_type: row.source_type, source_id: row.source_id, completion_date: row.completion_date });
      else if (action.kind === 'stop') {
        // Pause first: a failed pause must not hide running work.
        await pauseAll(row);
        await saveHidden({ ...hidden, [row.key]: clock().toISOString() });
      } else if (action.kind === 'cancel') {
        for (const blockId of row.blockIds) await invoke('cancel_task_block', { blockId });
      } else if (action.kind === 'stage' || action.kind === 'waiting') {
        const updated = await invoke('set_calendar_task_stage', { id: row.source_id, stage: action.kind === 'stage' ? action.stage : null, waiting: action.kind === 'waiting' ? action.waiting : null });
        if (updated && typeof updated === 'object') { row.stage = String(updated.stage ?? ''); row.waiting = !!updated.waiting; }
      } else if (row.source_type === 'note') {
        // Pause is idempotent; note completion atomically rejects a new running block.
        await pauseAll(row);
        await invoke('complete_calendar_task', { id: row.source_id });
      } else {
        const blockId = row.blockIds[0] ?? row.lastBlockId ?? Number(row.lastBlock?.id);
        if (!Number.isFinite(blockId)) throw new Error('Не удалось найти запись о работе. Обнови экран.');
        await invoke('finish_task_block', { blockId });
      }
      feedback = { text: {
        pause: 'Задача на паузе.', start: 'Задача снова в работе.', finish: 'Задача завершена.',
        stop: 'Задача остановлена и убрана из «В работе». Время сохранено.', cancel: 'Запуск отменён. Его время не учтено.',
        stage: action.stage ? `Стадия: ${stageLabel(action.stage)}.` : 'Стадия снята.', waiting: action.waiting ? 'Отмечено: жду ответа.' : 'Отметка «Жду ответа» снята.',
      }[action.kind] };
    } catch (error) {
      feedback = { error: true, text: errorText(error) || 'Не удалось выполнить действие. Обнови экран и повтори.' };
      control = { finish: 'finish', stop: 'menu', cancel: 'menu', stage: 'stage', waiting: 'stage' }[action.kind] || 'toggle';
    } finally {
      busy = false;
      notify(row);
      await refresh();
      if (!disposed) { render(); if (feedback?.error) { message.tabIndex = -1; message.focus({ preventScroll: true }); } else restore(row.key, control); }
    }
  }
  function notify(row) {
    if (notifyChange) notifyChange();
    else { win.dispatchEvent(new win.Event('task-state-changed')); win.dispatchEvent(new win.CustomEvent('hanni:calendar-refresh')); }
    if (row.source_type === 'schedule') win.dispatchEvent(new win.CustomEvent('hanni:recurring-changed'));
  }

  // A small menu under its trigger (or at the pointer), shared by the stage chip and ⋯.
  function closeMenu(returnFocus = true) {
    if (!menu) return;
    const state = menu; menu = null;
    state.menu.remove();
    doc.removeEventListener('pointerdown', state.outside, true);
    doc.removeEventListener('keydown', state.keys, true);
    doc.removeEventListener('scroll', state.scroll, true);
    win.removeEventListener('resize', state.dismiss);
    if (state.trigger?.isConnected) state.trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) restore(state.key, state.control);
  }
  function openMenu(row, control, trigger, items, label, point = null) {
    closeMenu(false);
    const box = node('div', 'calendar-record-menu cip-menu'); box.setAttribute('role', 'menu'); box.setAttribute('aria-label', label);
    box.dataset.cipMenu = control;
    const buttons = [];
    for (const item of items) {
      if (item.separator) { const line = node('div', 'cip-menu-separator'); line.setAttribute('role', 'separator'); box.append(line); continue; }
      const button = node('button', `cip-menu-item${item.checked ? ' is-checked' : ''}`); button.type = 'button'; button.tabIndex = -1;
      button.setAttribute('role', item.role || 'menuitem'); if (item.role) button.setAttribute('aria-checked', String(!!item.checked));
      button.dataset.menuAction = item.id; button.append(node('span', 'cip-menu-label', item.label));
      if (item.hint) button.append(node('span', 'cip-menu-hint', item.hint));
      button.addEventListener('click', () => { if (menu?.menu === box) item.run(); });
      box.append(button); buttons.push(button);
    }
    doc.body.append(box);
    const anchor = point || trigger.getBoundingClientRect(), rect = box.getBoundingClientRect();
    const x = point ? point.x : anchor.left, below = point ? point.y : anchor.bottom + 4;
    const top = below + rect.height > win.innerHeight - 8 && !point ? anchor.top - rect.height - 4 : below;
    box.style.left = `${Math.max(8, Math.min(x, win.innerWidth - rect.width - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(top, win.innerHeight - rect.height - 8))}px`;
    const state = { menu: box, key: row.key, control, trigger };
    state.dismiss = () => closeMenu(true);
    state.outside = event => { if (!box.contains(event.target) && !state.trigger?.contains(event.target)) closeMenu(!event.target.closest('button, a, input, textarea, select, [tabindex]')); };
    state.scroll = event => { if (!box.contains(event.target)) closeMenu(true); };
    state.keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(true); return; }
      if (!box.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(doc.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    doc.addEventListener('pointerdown', state.outside, true);
    doc.addEventListener('keydown', state.keys, true);
    doc.addEventListener('scroll', state.scroll, true);
    win.addEventListener('resize', state.dismiss);
    menu = state; trigger?.setAttribute('aria-expanded', 'true');
    (buttons.find(button => button.classList.contains('is-checked') && button.getAttribute('role') === 'menuitemradio') || buttons[0])?.focus({ preventScroll: true });
  }
  function openStageMenu(row, trigger) {
    const items = [
      ...TASK_STAGES.map(([id, label]) => ({ id: `stage:${id}`, label, role: 'menuitemradio', checked: row.stage === id, run: () => void act(row, { kind: 'stage', stage: id }) })),
      { id: 'stage:', label: 'Без стадии', role: 'menuitemradio', checked: !stageLabel(row.stage), run: () => void act(row, { kind: 'stage', stage: '' }) },
      { separator: true },
      { id: 'waiting', label: 'Жду ответа', role: 'menuitemcheckbox', checked: row.waiting, run: () => void act(row, { kind: 'waiting', waiting: !row.waiting }) },
    ];
    openMenu(row, 'stage', trigger, items, `Стадия: ${row.title}`);
  }
  function openActionsMenu(row, trigger, point = null) {
    const items = [
      { id: 'stop', label: 'Остановить', hint: row.running ? 'Пауза, время сохранится' : 'Убрать из «В работе»', run: () => void act(row, { kind: 'stop' }) },
      ...(row.running ? [{ id: 'cancel', label: 'Отменить запуск', hint: 'Не учитывать этот запуск', run: () => { closeMenu(false); confirming = row.key; render(); findControl(row.key, 'cancel-confirm')?.focus({ preventScroll: true }); } }] : []),
      { id: 'open', label: 'Открыть', run: () => { closeMenu(false); openTask?.(row.record, () => restore(row.key, 'menu')); } },
    ];
    openMenu(row, 'menu', trigger, items, `Действия: ${row.title}`, point);
  }
  const onClick = event => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button) || button.disabled || disposed) return;
    if ('cipLaunch' in button.dataset) { openLauncher?.(button); return; }
    if ('cipRetry' in button.dataset) { void refresh(); return; }
    const row = rows?.find(value => value.key === button.dataset.cipKey);
    if (!row || busy) return;
    const control = button.dataset.cipControl;
    if (control === 'open') openTask?.(row.record, () => restore(row.key, 'open'));
    else if (control === 'toggle') void act(row, { kind: row.running ? 'pause' : 'start' });
    else if (control === 'finish') void act(row, { kind: 'finish' });
    else if (control === 'stage' || control === 'menu') {
      if (menu?.key === row.key && menu.control === control) { closeMenu(true); return; }
      if (control === 'stage') openStageMenu(row, button); else openActionsMenu(row, button);
    } else if (control === 'cancel-confirm') void act(row, { kind: 'cancel' });
    else if (control === 'cancel-keep') { confirming = null; render(); restore(row.key, 'menu'); }
  };
  const onContextMenu = event => {
    const item = event.target.closest('.cip-row');
    const row = item && rows?.find(value => value.key === item.dataset.contextRecord);
    if (!row || busy || disposed) return;
    event.preventDefault();
    openActionsMenu(row, findControl(row.key, 'menu'), event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null);
  };
  const onKeydown = event => {
    if (event.key === 'Escape' && confirming && element.contains(event.target)) { event.preventDefault(); const key = confirming; confirming = null; render(); restore(key, 'menu'); }
  };
  const onChange = event => {
    if (queued || disposed) return;
    queued = true;
    const canCommit = event?.detail?.remoteSync ? event.detail.canCommit : null;
    queueMicrotask(() => { queued = false; void refresh(canCommit); });
  };
  element.addEventListener('click', onClick);
  element.addEventListener('contextmenu', onContextMenu);
  element.addEventListener('keydown', onKeydown);
  for (const name of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:recurring-changed', 'focus']) win.addEventListener(name, onChange);
  const timer = win.setInterval(() => { if (dayOf(clock()) !== day && !busy) void refresh(); else renderTimes(); }, 1000);
  render();
  const firstLoad = refresh();
  const dispose = () => {
    disposed = true; revision++; closeMenu(false); win.clearInterval(timer);
    element.removeEventListener('click', onClick); element.removeEventListener('contextmenu', onContextMenu); element.removeEventListener('keydown', onKeydown);
    for (const name of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:recurring-changed', 'focus']) win.removeEventListener(name, onChange);
  };
  // The header indicator leads here; wait for the first read so focus lands on a visible control.
  dispose.focus = async () => {
    await firstLoad;
    if (disposed || !element.isConnected) return;
    element.scrollIntoView?.({ block: 'nearest' });
    (rows?.length ? title : q('empty-launch')).focus({ preventScroll: true });
  };
  dispose.refresh = () => refresh();
  dispose.keys = () => (rows || []).map(row => row.key);
  return dispose;
}
