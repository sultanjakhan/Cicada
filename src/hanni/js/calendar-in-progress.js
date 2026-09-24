// «В работе» (owner decision 2026-09-24): every running task plus tasks paused
// today that are still open. It reads existing timeline blocks only; start,
// pause and finish use the shared native commands and never touch other tasks.
import { ICONS } from './icons.js';
import { readActiveBlocks, startCalendarExecution, sourceKey } from './calendar-execution.js';

const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
const RUNNABLE = ['note', 'event', 'schedule'];
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const blockSeconds = block => Math.max(0, Number(block.duration_seconds) || (Number(block.duration_minutes) || 0) * 60);
const oneOf = count => count % 10 === 1 && count % 100 !== 11;
// «2 идут · 1 на паузе»: the header counts only running work, the widget names both parts.
const summaryOf = rows => { const running = rows.filter(row => row.running).length, paused = rows.length - running;
  return [running && `${running} ${oneOf(running) ? 'идёт' : 'идут'}`, paused && `${paused} на паузе`].filter(Boolean).join(' · '); };
const closedTask = row => !row || row.archived || row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra || row.status);
let sequence = 0;

/** Under an hour: mm:ss. Longer: «1 ч 05 мин». */
export function formatWorkTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 3600) return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${Math.floor(total / 3600)} ч ${String(Math.floor(total % 3600 / 60)).padStart(2, '0')} мин`;
}

export function mountCalendarInProgress(element, dependencies) {
  const { invoke, openTask, openLauncher, mountMenu, notifyChange } = dependencies;
  const clock = dependencies.now || (() => new Date());
  const doc = element.ownerDocument, win = doc.defaultView;
  const prefix = `calendar-in-progress-${++sequence}`;
  let rows = null, failed = false, busy = false, disposed = false, revision = 0, queued = false, feedback = null;
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

  function secondsOf(row, now = clock()) {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    return row.closedSeconds + row.starts.reduce((sum, start) => sum + Math.max(0, Math.floor((now - Math.max(start, midnight)) / 1000)), 0);
  }
  function renderTimes() {
    if (disposed || !rows) return;
    const now = clock();
    for (const time of element.querySelectorAll('[data-cip-time]')) {
      const row = rows.find(value => value.key === time.dataset.cipTime);
      if (row?.running) time.textContent = formatWorkTime(secondsOf(row, now));
    }
  }
  function renderRow(row) {
    const item = node('li', `cip-row ${row.running ? 'is-running' : 'is-paused'}`);
    item.dataset.contextRecord = row.key;
    const open = node('button', 'cip-title', row.title); open.type = 'button'; open.title = row.title;
    open.dataset.cipControl = 'open'; open.dataset.cipKey = row.key;
    const meta = node('span', 'cip-meta');
    const state = node('span', 'cip-state', row.running ? 'идёт' : 'пауза');
    const time = node('span', 'cip-time', formatWorkTime(secondsOf(row))); time.dataset.cipTime = row.key;
    time.setAttribute('aria-label', 'Время сегодня'); time.title = 'Время сегодня';
    meta.append(state, time);
    const content = node('div', 'cip-content'); content.append(open, meta);
    const actions = node('div', 'cip-actions');
    const toggle = iconButton(`cip-toggle${row.running ? ' is-running' : ''}`, ICONS[row.running ? 'pause' : 'play'], row.running ? 'Пауза' : 'Продолжить', 'toggle', row);
    const finish = iconButton('cip-finish', ICONS.check, 'Готово', 'finish', row);
    actions.append(toggle, finish);
    if (mountMenu) {
      const more = iconButton('cip-more', MORE_ICON, 'Действия', 'menu', row);
      more.dataset.recordMenu = ''; more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      actions.append(more);
    }
    item.append(content, actions);
    return item;
  }
  function render() {
    if (disposed) return;
    const focused = doc.activeElement, focusKey = element.contains(focused) ? focused.dataset.cipKey : null, focusControl = focused?.dataset?.cipControl;
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
    if (focusKey && !focused.isConnected) restore(focusKey, focusControl);
  }
  async function load(today) {
    const [running, blocks] = await Promise.all([readActiveBlocks(invoke), invoke('get_timeline_blocks', { date: today })]);
    if (!Array.isArray(running) || !Array.isArray(blocks)) throw new Error('Invalid timeline response');
    const entries = new Map();
    const entry = block => {
      const key = sourceKey(block);
      if (!entries.has(key)) entries.set(key, { key, source_type: block.source_type, source_id: String(block.source_id), running: false, blockIds: [], starts: [], closedSeconds: 0, lastBlock: null, title: '' });
      return entries.get(key);
    };
    for (const block of running.filter(value => RUNNABLE.includes(value.source_type))) {
      const row = entry(block); row.running = true; row.blockIds.push(Number(block.id));
      const start = new Date(`${block.date}T${block.start_time}`);
      if (Number.isFinite(start.getTime())) row.starts.push(start.getTime());
      row.title ||= block.title || ''; row.completion_date ||= block.completion_date || block.date; row.lastBlock ||= block;
    }
    const runningKeys = new Set(entries.keys());
    for (const block of blocks.filter(value => RUNNABLE.includes(value.source_type) && !value.is_active)) {
      const key = sourceKey(block);
      // A task that is not running now appears only when it was worked on today.
      const row = runningKeys.has(key) ? entries.get(key) : entry(block);
      row.closedSeconds += blockSeconds(block);
      if (!row.running && (!row.lastBlock || `${block.end_time || block.start_time}` > `${row.lastBlock.end_time || row.lastBlock.start_time}`)) { row.lastBlock = block; row.completion_date = block.completion_date || block.date; }
    }
    const types = new Set([...entries.values()].map(row => row.source_type));
    const [tasks, events, schedules] = await Promise.all([
      types.has('note') ? invoke('get_calendar_tasks', {}) : [],
      types.has('event') ? invoke('get_all_events', {}) : [],
      types.has('schedule') ? invoke('get_schedules', {}) : [],
    ]);
    const result = [];
    for (const row of entries.values()) {
      let record;
      if (row.source_type === 'note') record = tasks.find(task => task.source_type === 'note' && String(task.source_id) === row.source_id);
      else if (row.source_type === 'event') { const event = events.find(value => String(value.id) === row.source_id); record = event && { ...event, source_type: 'event', source_id: String(event.id), planned_time: event.time, status_extra: event.status }; }
      else record = schedules.find(value => String(value.source_id ?? value.id) === row.source_id);
      // Paused work leaves the widget once its task is finished, skipped or removed.
      if (!row.running && (closedTask(record) || (row.source_type === 'note' && record?.status_extra !== 'task'))) continue;
      row.title = record?.title || row.title || 'Без названия';
      if (row.source_type === 'schedule' && !row.running && record?.block_id != null) row.lastBlockId = Number(record.block_id);
      row.record = { ...(record || {}), source_type: row.source_type, source_id: row.source_id, title: row.title, is_active: row.running, has_work: true, completion_date: row.completion_date, date: record?.date ?? (row.source_type === 'note' ? null : row.completion_date) };
      result.push(row);
    }
    const order = [...runningKeys];
    return result.sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1) || (a.running ? order.indexOf(a.key) - order.indexOf(b.key)
      : `${b.lastBlock?.end_time || b.lastBlock?.start_time || ''}`.localeCompare(`${a.lastBlock?.end_time || a.lastBlock?.start_time || ''}`)));
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
  async function act(row, action) {
    if (disposed || busy) return;
    busy = true; feedback = null; revision++; render();
    let control = action === 'finish' ? 'open' : 'toggle';
    try {
      if (action === 'pause') {
        for (const blockId of row.blockIds) await invoke('pause_task_block', { blockId });
      } else if (action === 'start') {
        await startCalendarExecution(invoke, { source_type: row.source_type, source_id: row.source_id, completion_date: row.completion_date });
      } else if (row.source_type === 'note') {
        // Pause is idempotent; note completion atomically rejects a new running block.
        for (const blockId of row.blockIds) await invoke('pause_task_block', { blockId });
        await invoke('complete_calendar_task', { id: row.source_id });
      } else {
        const blockId = row.blockIds[0] ?? row.lastBlockId ?? Number(row.lastBlock?.id);
        if (!Number.isFinite(blockId)) throw new Error('Не удалось найти запись о работе. Обнови экран.');
        await invoke('finish_task_block', { blockId });
      }
      feedback = { text: { pause: 'Задача на паузе.', start: 'Задача снова в работе.', finish: 'Задача завершена.' }[action] };
    } catch (error) {
      feedback = { error: true, text: (typeof error === 'string' ? error : error?.message) || 'Не удалось выполнить действие. Обнови экран и повтори.' };
      control = action === 'finish' ? 'finish' : 'toggle';
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
  const disposeMenu = mountMenu?.(element, {
    getRecord: item => busy ? null : rows?.find(row => row.key === item.dataset.contextRecord)?.record || null,
    restoreFocus: (item, trigger) => restore(item.dataset.contextRecord, 'recordMenu' in trigger.dataset ? 'menu' : 'open'),
  });
  const onClick = event => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button) || button.disabled || disposed) return;
    if ('cipLaunch' in button.dataset) { openLauncher?.(button); return; }
    if ('cipRetry' in button.dataset) { void refresh(); return; }
    const row = rows?.find(value => value.key === button.dataset.cipKey);
    if (!row || busy) return;
    const control = button.dataset.cipControl;
    if (control === 'open') openTask?.(row.record, () => restore(row.key, 'open'));
    else if (control === 'toggle') void act(row, row.running ? 'pause' : 'start');
    else if (control === 'finish') void act(row, 'finish');
  };
  const onChange = event => {
    if (queued || disposed) return;
    queued = true;
    const canCommit = event?.detail?.remoteSync ? event.detail.canCommit : null;
    queueMicrotask(() => { queued = false; void refresh(canCommit); });
  };
  element.addEventListener('click', onClick);
  for (const name of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:recurring-changed', 'focus']) win.addEventListener(name, onChange);
  const timer = win.setInterval(() => { if (dayOf(clock()) !== day && !busy) void refresh(); else renderTimes(); }, 1000);
  render();
  const firstLoad = refresh();
  const dispose = () => {
    disposed = true; revision++; disposeMenu?.(); win.clearInterval(timer); element.removeEventListener('click', onClick);
    for (const name of ['task-state-changed', 'hanni:calendar-refresh', 'hanni:recurring-changed', 'focus']) win.removeEventListener(name, onChange);
  };
  // The header summary leads here; wait for the first read so focus lands on a visible control.
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
