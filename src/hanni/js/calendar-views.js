  'use strict';
import { renderDayStartMarker } from './calendar-day-start.js';
  const parse = (value) => new Date(`${value}T12:00:00`);
  const iso = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const add = (value, days) => { const date = parse(value); date.setDate(date.getDate() + days); return iso(date); };
  const monday = (value) => add(value, -((parse(value).getDay() + 6) % 7));
  const weekStart = (value, firstDay = 'mon') => firstDay === 'sun' ? add(value, -parse(value).getDay()) : monday(value);
  const label = (value, options = { day: 'numeric', month: 'long' }) => {
    const text = parse(value).toLocaleDateString('ru-RU', options);
    return text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);
  };
  const minutes = (value) => value.split(':').map(Number).reduce((h, m) => h * 60 + m);
  const hhmm = (value) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}${value >= 1440 ? ` (+${Math.floor(value / 1440)} д.)` : ''}`;
  const viewStates = new WeakMap();
  let viewSequence = 0;
  const hourHeight = 76;
  const foldedHeight = 44;
  const isClosed = record => !record.readonly && !record.is_active && (record.completed || ['done', 'skipped', 'missed'].includes(record.status_extra));
  const isCompleted = record => !record.readonly && (record.completed || record.status_extra === 'done');
  const isMissed = record => !record.readonly && !isCompleted(record) && (record.status_extra === 'skipped' || record.status_extra === 'missed');
  function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function button(cls, text, action) { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; }
  function range(period, date, firstDay = 'mon') {
    if (period === 'day') return [date];
    if (period === 'week') return Array.from({ length: 7 }, (_, i) => add(weekStart(date, firstDay), i));
    const start = `${date.slice(0, 7)}-01`;
    return Array.from({ length: new Date(parse(start).getFullYear(), parse(start).getMonth() + 1, 0).getDate() }, (_, i) => add(start, i));
  }
  // Split only the visible projection. Every segment still opens the same source record.
  function daySegments(records, dates) {
    return records.flatMap(record => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(record.time || '') ||
          !Number.isFinite(record.durationMinutes) || record.durationMinutes <= 0) return [record];
      const [year, month, day] = record.date.split('-').map(Number);
      const origin = Date.UTC(year, month - 1, day) / 86400000;
      const start = minutes(record.time), end = start + record.durationMinutes;
      const isSleep = record.health_kind === 'sleep';
      const sleepMinutes = record.sleep_minutes === undefined ? record.durationMinutes : record.sleep_minutes;
      const wakeDate = isSleep ? add(record.date, Math.floor(end / 1440)) : null;
      return dates.flatMap(date => {
        const [y, m, d] = date.split('-').map(Number);
        const offset = (Date.UTC(y, m - 1, d) / 86400000 - origin) * 1440;
        const from = Math.max(start, offset), to = Math.min(end, offset + 1440);
        if (from >= to) {
          if (isSleep && date === wakeDate && end === offset) return [{ ...record, date, time: null, durationMinutes: null,
            sleepWakeDate: wakeDate, sleepContinues: false, sleepCountedMinutes: sleepMinutes }];
          return [];
        }
        return [{ ...record, date, time: hhmm(from - offset), durationMinutes: to - from,
          ...(isSleep ? { sleepWakeDate: wakeDate, sleepContinues: date !== wakeDate,
            sleepCountedMinutes: date === wakeDate ? sleepMinutes : 0,
            title: date === wakeDate ? record.title : 'Шёл сон' } : {}),
          continuesBefore: start < offset, continuesAfter: end > offset + 1440,
          displayEnd: to - offset === 1440 ? '24:00' : hhmm(to - offset) }];
      });
    });
  }
  function recordButton(record, options, cls = '') {
    const shell = el('div', `calv-record-shell ${cls}`);
    shell.dataset.contextRecord = record.id;
    shell.dataset.recordSource = `${record.source_type}:${record.source_id}`;
    shell.dataset.recordDate = record.date || '';
    const node = button('calv-record', '', () => options.onChooseRecord?.(record.id));
    node.dataset.recordId = record.id;
    const time = record.time ? `${record.time}${record.durationMinutes ? `–${record.displayEnd || hhmm(minutes(record.time) + record.durationMinutes)}` : ''}` : 'Без времени';
    const continuation = [record.continuesBefore && 'Продолжение', record.continuesAfter && 'Продолжится завтра'].filter(Boolean).join(' · ');
    node.append(el('span', 'calv-record-time', time), el('strong', '', record.title), el('span', 'calv-record-meta', `${record.kind || 'Задача'} · ${record.status || 'Запланировано'}`));
    node.setAttribute('aria-label', `${record.title}, ${record.date ? label(record.date) : 'Без даты'}, ${time}, ${record.status || 'Запланировано'}. Открыть подробности`);
    if (record.sleepWakeDate) {
      const summary = record.sleepContinues ? `Учтён в дне пробуждения: ${label(record.sleepWakeDate)}`
        : record.sleepCountedMinutes === null ? 'Время сна по стадиям не передано источником'
        : `За ночь: ${Math.floor(record.sleepCountedMinutes / 60)} ч ${record.sleepCountedMinutes % 60} мин`;
      node.querySelector('.calv-record-meta').textContent = summary;
      node.setAttribute('aria-label', `${node.getAttribute('aria-label')}. ${summary}`);
    }
    if (continuation) {
      shell.dataset.continuation = '';
      node.querySelector('.calv-record-meta').append(` · ${continuation}`);
      node.setAttribute('aria-label', `${node.getAttribute('aria-label')}. ${continuation}`);
    }
    const more = button('calv-record-more', '⋯', () => {});
    more.dataset.recordMenu = ''; more.setAttribute('aria-label', `Действия: ${record.title}`);
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    shell.append(node, more);
    if (options.onTaskAction && record.source_type === 'note' && !record.readonly && !record.archived && !isClosed(record)) {
      shell.classList.add('calv-record-shell--actions');
      const actions = el('div', 'calv-record-actions');
      const addAction = (action, title) => {
        const control = button('calv-record-action', title, () => options.onTaskAction(record, action, control));
        control.dataset.recordAction = action;
        control.disabled = !!options.actionBusy;
        control.setAttribute('aria-label', `${title}: ${record.title}`);
        actions.append(control);
      };
      if (!record.date) addAction('date', 'Назначить дату');
      if (record.is_active) addAction('pause', 'Пауза');
      else addAction('start', record.has_work || record.actual_minutes > 0 ? 'Продолжить' : 'Начать');
      if (record.is_active || record.has_work || record.actual_minutes > 0) addAction('finish', 'Завершить');
      shell.append(actions);
    }
    return shell;
  }
  function agenda(parent, title, records, options, dayStarts = [], showEmpty = true) {
    const group = el('section', 'calv-agenda');
    group.append(el('h3', '', title));
    if (showEmpty && !records.length && !dayStarts.length) group.append(el('p', 'calv-empty', 'Запланированных пунктов нет.'));
    const items = [...records.map(record => ({ time: record.time || '99', record })),
      ...dayStarts.map(marker => ({ time: marker.time, marker }))].sort((a, b) => a.time.localeCompare(b.time));
    for (const item of items) group.append(item.marker ? renderDayStartMarker(item.marker) : recordButton(item.record, options));
    parent.append(group);
  }
  function history(parent, records, options, state) {
    const groups = [
      { key: 'completed', label: '✓ Завершённые', records: records.filter(isCompleted) },
      { key: 'missed', label: '↷ Пропущенные', records: records.filter(isMissed) }
    ];
    if (!groups.some(group => group.records.length)) return;
    for (const group of groups) {
      if (!group.records.length) continue;
    const panel = el('details', 'calv-disclosure');
      panel.dataset.historyRecords = group.key; panel.open = state.historyOpen[group.key] === true;
    const summary = el('summary');
      summary.dataset.calendarControl = `history-${group.key}`;
      summary.append(el('span', 'calv-history-label', group.label), el('span', 'calv-disclosure-count', String(group.records.length)));
    panel.append(summary);
      for (const date of [...new Set(group.records.map(record => record.date))])
        agenda(panel, date ? label(date, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Без даты', group.records.filter(record => record.date === date), options);
      panel.addEventListener('toggle', () => { if (panel.isConnected) state.historyOpen[group.key] = panel.open; });
    parent.append(panel);
    }
  }
  function untimedBand(dates, records, options, state) {
    const untimedPreviewLimit = 0;
    const band = el('div', 'calv-untimed-band');
    band.append(el('span', 'calv-untimed-corner', 'Без времени'));
    for (const date of dates) {
      const items = records.filter(record => record.date === date);
      const column = el('section', 'calv-untimed-day'); column.dataset.untimedDate = date;
      column.setAttribute('aria-label', `${label(date)}, без времени: ${items.length}`);
      const heading = el('h3', 'calv-untimed-count', '—'); heading.hidden = items.length > 0;
      const list = el('div', 'calv-untimed-list'); list.id = `${state.id}-untimed-${date}`;
      list.tabIndex = -1;
      const more = button('calv-band-more', '', () => { state.untimedExpanded[date] = !state.untimedExpanded[date]; renderItems(); });
      more.dataset.untimedMore = date; more.setAttribute('aria-controls', list.id);
      more.dataset.calendarControl = `untimed-${date}`;
      function renderItems() {
        const expanded = state.untimedExpanded[date] === true;
        list.replaceChildren(...(expanded ? items : items.slice(0, untimedPreviewLimit)).map(record => recordButton(record, options, 'calv-untimed-record')));
        more.textContent = expanded ? 'Свернуть' : 'Показать';
        more.setAttribute('aria-expanded', String(expanded)); more.hidden = items.length <= untimedPreviewLimit;
      }
      renderItems(); column.append(heading, list, more); band.append(column);
    }
    return band;
  }
  function timeFoldPlan(records, { date, period, today, now, expanded = {} }) {
    if (period !== 'day') return { folds: [], map: minute => minute / 60 * hourHeight, height: 24 * hourHeight };
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const candidates = records
      .filter(record => record.date === date && record.time && (record.durationMinutes || 0) > 120)
      .map(record => ({ record, start: minutes(record.time), end: Math.min(1440, minutes(record.time) + record.durationMinutes) }))
      .filter(({ record, start, end }) => {
        if (expanded[`${date}:${record.id}`] || end <= start || (date === today && end > currentMinute) || date > today) return false;
        return !records.some(other => other !== record && other.date === date && other.time &&
          minutes(other.time) <= end && minutes(other.time) + (other.durationMinutes || 30) >= start);
      })
      .sort((a, b) => a.start - b.start);
    const folds = candidates.filter((candidate, index) => !candidates.slice(0, index).some(other => other.end > candidate.start));
    const map = minute => {
      let removed = 0;
      for (const fold of folds) {
        const startY = fold.start / 60 * hourHeight - removed;
        if (minute <= fold.start) return minute / 60 * hourHeight - removed;
        if (minute < fold.end) return startY + (minute - fold.start) / (fold.end - fold.start) * foldedHeight;
        removed += (fold.end - fold.start) / 60 * hourHeight - foldedHeight;
      }
      return minute / 60 * hourHeight - removed;
    };
    return { folds, map, height: map(1440) };
  }
  function tasksPanel(root, shell, options, state) {
    const items = (options.taskRecords || []).filter(record => record.source_type === 'note' && !record.readonly && !record.archived && !record.date && !isClosed(record));
    const tools = el('div', 'calv-view-tools');
    const aside = el('aside', 'calv-tasks-panel'); aside.id = `${state.id}-tasks`; aside.dataset.tasksPanel = '';
    const heading = el('h3', '', 'Запланировать'); heading.id = `${state.id}-tasks-title`; heading.tabIndex = -1;
    heading.dataset.calendarControl = 'tasks-heading';
    aside.setAttribute('aria-labelledby', heading.id);
    const toggle = button('calv-panel-toggle', options.taskError ? 'Запланировать' : `Запланировать · ${items.length}`, () => {
      state.tasksOpen = !state.tasksOpen; sync(); if (state.tasksOpen) heading.focus();
    });
    toggle.dataset.tasksToggle = ''; toggle.setAttribute('aria-controls', aside.id);
    toggle.dataset.calendarControl = 'tasks-toggle';
    const close = button('calv-panel-close', '×', () => { state.tasksOpen = false; sync(); toggle.focus(); });
    close.setAttribute('aria-label', 'Закрыть планирование');
    close.dataset.calendarControl = 'tasks-close';
    const header = el('div', 'calv-tasks-heading'); header.append(heading, close);
    aside.append(header);
    aside.append(el('p', 'calv-panel-hint', 'Задачи без даты. Назначь выбранный день или перетащи задачу на дату календаря.'));
    if (options.taskError) {
      const error = el('p', 'calv-panel-hint', 'Не удалось загрузить задачи. Повтори загрузку, чтобы увидеть список.'); error.setAttribute('role', 'status');
      const retry = button('calv-panel-toggle', 'Повторить загрузку задач', () => options.onRetryTasks?.());
      retry.dataset.taskRetry = ''; retry.dataset.calendarControl = 'task-retry'; aside.append(error, retry);
    } else {
      const search = el('input', 'calv-task-search'); search.type = 'search'; search.placeholder = 'Найти задачу'; search.setAttribute('aria-label', 'Найти задачу');
      search.value = state.taskSearch; search.dataset.taskSearch = ''; search.dataset.calendarControl = 'task-search';
      const dateHint = el('p', 'calv-panel-hint', `Выбран день: ${label(options.date, { day: 'numeric', month: 'long' })}`);
      const list = el('div', 'calv-task-list'); list.dataset.taskList = '';
      list.addEventListener('scroll', () => { state.taskScroll = list.scrollTop; });
      function renderItems() {
        const query = state.taskSearch.trim().toLocaleLowerCase('ru-RU');
        const visible = items.filter(record => record.title.toLocaleLowerCase('ru-RU').includes(query))
          .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || a.title.localeCompare(b.title, 'ru'));
        list.replaceChildren(...visible.map(record => {
          const card = recordButton(record, { ...options, onTaskAction:null }, 'calv-task-record');
          const meta = card.querySelector('.calv-record-meta');
          meta.textContent = [record.durationMinutes > 0 && `${record.durationMinutes} мин`, record.is_active && 'В работе'].filter(Boolean).join(' · ');
          meta.hidden = !meta.textContent;
          if (options.onScheduleTask) {
            const plan = button('calv-plan-task', 'На этот день', () => options.onScheduleTask(record, options.date));
            plan.dataset.planTask = String(record.source_id); plan.dataset.calendarControl = `plan-${record.source_id}`;
            plan.disabled = !!options.actionBusy; plan.setAttribute('aria-label', `Запланировать «${record.title}» на ${label(options.date)}`);
            card.append(plan); card.draggable = !options.actionBusy;
            card.addEventListener('dragstart', event => { if (options.actionBusy) { event.preventDefault(); return; } state.draggedTask = String(record.source_id); event.dataTransfer.setData('application/x-hanni-task', state.draggedTask); event.dataTransfer.effectAllowed = 'move'; });
            card.addEventListener('dragend', () => { state.draggedTask = null; root.querySelectorAll('.calv-drop-target').forEach(target=>target.classList.remove('calv-drop-target')); });
          }
          return card;
        }));
        if (!visible.length) list.append(el('p', 'calv-empty', query ? 'По запросу задач нет.' : 'Все задачи распределены по дням.'));
        list.scrollTop = state.taskScroll;
      }
      search.addEventListener('input', () => { state.taskSearch = search.value; state.taskScroll = 0; renderItems(); });
      aside.append(search, dateHint, list); renderItems();
    }
    if (options.onOpenTasks) aside.append(button('calv-all-tasks', 'Все задачи', options.onOpenTasks));
    tools.append(toggle); root.prepend(tools); shell.append(aside);
    function sync() {
      aside.hidden = !state.tasksOpen; toggle.setAttribute('aria-expanded', String(state.tasksOpen));
      try { root.ownerDocument.defaultView.localStorage.setItem('calendar.tasks-panel-open', String(state.tasksOpen)); } catch {}
    }
    aside.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.click(); } });
    sync();
  }
  function render(root, options) {
    let savedPanelOpen = false;
    try { savedPanelOpen = root.ownerDocument.defaultView.localStorage.getItem('calendar.tasks-panel-open') === 'true'; } catch {}
    if (!viewStates.has(root)) viewStates.set(root, { id: `calv-${++viewSequence}`, tasksOpen: savedPanelOpen, taskSearch: '', taskScroll: 0, historyOpen: {}, untimedExpanded: {}, timeFoldsExpanded: {}, slotFocus: {} });
    const state = viewStates.get(root);
    const focused = root.ownerDocument.activeElement;
    const controlFocus = root.contains(focused) ? focused.dataset.calendarControl : null;
    root.querySelectorAll('[data-history-records]').forEach(panel => { state.historyOpen[panel.dataset.historyRecords] = panel.open; });
    const viewKey = `${options.period}:${options.mode}:${options.date}`;
    const outer = root.closest('.uni-content');
    const outerScroll = state.viewKey === viewKey ? outer?.scrollTop || 0 : 0;
    const previousScroll = root.querySelector('.calv-time-scroll');
    const scrollPosition = state.viewKey === viewKey && previousScroll ? { top: previousScroll.scrollTop, left: previousScroll.scrollLeft } : null;
    state.viewKey = viewKey;
    root.replaceChildren();
    const shell = el('div', 'calv-layout'), container = el('div', 'calv-main'); shell.append(container); root.append(shell);
    const dates = range(options.period, options.date, options.firstDay);
    const projectionDates = options.period === 'month' ? Array.from({ length: 42 }, (_, i) => add(weekStart(`${options.date.slice(0, 7)}-01`, options.firstDay), i)) : dates;
    const today = options.today || iso(new Date());
    const set = new Set(dates);
    const dayStarts = options.dayStarts || [];
    const startsOn = date => dayStarts.filter(marker => marker.date === date);
    const projected = daySegments(options.records, projectionDates);
    const available = projected.filter(record => !isClosed(record));
    const records = available.filter((record) => record.date && set.has(record.date)).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'));
    root.dataset.period = options.period; root.dataset.mode = options.mode;
    tasksPanel(root, shell, options, state);
    if (options.mode === 'list') {
      const groups = dates.filter((date) => records.some((record) => record.date === date) || startsOn(date).length);
      if (!groups.length) container.append(el('p', 'calv-empty', 'В этом периоде нет запланированных пунктов.'));
      for (const date of groups) agenda(container, label(date, { weekday: 'long', day: 'numeric', month: 'long' }), records.filter((record) => record.date === date), options, startsOn(date));
    } else if (options.period === 'month') {
      const grid = el('div', 'calv-month');
      grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', label(options.date, { month: 'long', year: 'numeric' }));
      const weekdays = options.firstDay === 'sun' ? ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] : ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      for (const day of weekdays) grid.append(el('div', 'calv-weekday', day));
      const first = weekStart(`${options.date.slice(0, 7)}-01`, options.firstDay);
      const offset = (parse(`${options.date.slice(0, 7)}-01`).getDay() + (options.firstDay === 'sun' ? 0 : 6)) % 7;
      const cellCount = Math.ceil((offset + dates.length) / 7) * 7;
      for (let i = 0; i < cellCount; i++) {
        const date = add(first, i);
        const dayRecords = available.filter((record) => record.date === date).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
        const cell = button('calv-month-cell', '', () => options.onChooseDate?.(date));
        cell.dataset.calendarDate = date;
        cell.dataset.outside = String(date.slice(0, 7) !== options.date.slice(0, 7));
        cell.setAttribute('aria-pressed', String(date === options.date));
        if (date === today) cell.setAttribute('aria-current', 'date');
        cell.setAttribute('aria-label', `${label(date, { day: 'numeric', month: 'long', year: 'numeric' })}, пунктов: ${dayRecords.length}`);
        cell.append(el('span', 'calv-date-number', String(parse(date).getDate())));
        for (const marker of startsOn(date)) cell.append(renderDayStartMarker(marker, { compact: true }));
        if (startsOn(date).length) cell.setAttribute('aria-label', `${cell.getAttribute('aria-label')}. Начало дня: ${startsOn(date).map(marker => marker.time).join(', ')}`);
        const preview = dayRecords.filter(record => record.time).slice(0, 2);
        for (const record of preview) cell.append(el('span', 'calv-month-preview', `${record.time} ${record.title}`));
        if (dayRecords.length) {
          const count = el('span', 'calv-day-count', 'Показать');
          cell.append(count);
        }
        grid.append(cell);
      }
      container.append(grid);
      const selected = records.filter(record => record.date === options.date);
      agenda(container, `Выбранный день · ${label(options.date)}`, selected.filter(record => record.time), options, startsOn(options.date), !selected.length);
      if (selected.some(record => !record.time)) container.append(untimedBand([options.date], selected.filter(record => !record.time), options, state));
    } else {
      const timed = records.filter((record) => record.time);
      const untimed = records.filter((record) => !record.time);
      // Every hour remains reachable, even when no task currently occupies it.
      const firstHour = 0;
      const lastHour = 24;
      const scroll = el('div', 'calv-time-scroll');
      scroll.id = `${state.id}-time-grid`;
      scroll.tabIndex = 0;
      scroll.dataset.calendarControl = 'time-grid';
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', options.period === 'week' ? 'Недельная сетка. Можно прокручивать по горизонтали и вертикали.' : 'Сетка дня. Можно прокручивать по вертикали.');
      const board = el('div', `calv-time-board calv-time-board--${options.period}`);
      board.style.setProperty('--calv-days', String(dates.length));
      const headings = el('div', 'calv-time-head'); headings.append(el('span', 'calv-time-corner', 'Время'));
      for (const date of dates) {
        const day = button('calv-day-heading', '', () => options.onChooseDate?.(date));
        day.append(el('span', 'calv-day-weekday', label(date, { weekday: 'short' })), el('span', 'calv-day-number', String(parse(date).getDate())));
        day.dataset.calendarDate = date;
        day.setAttribute('aria-label', label(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
        day.setAttribute('aria-pressed', String(date === options.date));
        if (date === today) day.setAttribute('aria-current', 'date');
        headings.append(day);
      }
      const sticky = el('div', 'calv-time-sticky'); sticky.append(headings);
      if (untimed.length) sticky.append(untimedBand(dates, untimed, options, state));
      board.append(sticky);
      const body = el('div', 'calv-time-body');
      const foldPlan = timeFoldPlan(timed, { date: options.date, period: options.period, today, now: options.now || new Date(), expanded: state.timeFoldsExpanded });
      body.style.height = `${foldPlan.height}px`;
      const hours = el('div', 'calv-hours');
      for (let hour = firstHour; hour < lastHour; hour++) {
        const minute = hour * 60;
        if (foldPlan.folds.some(fold => minute > fold.start && minute < fold.end)) continue;
        const tick = el('span', '', hhmm(minute)); tick.style.top = `${foldPlan.map(minute)}px`; hours.append(tick);
      }
      body.append(hours);
      for (const date of dates) {
        const column = el('div', 'calv-day-column');
        const isFoldedMinute = minute => date === options.date && foldPlan.folds.some(fold => minute >= fold.start && minute < fold.end);
        if (options.onCreateEvent) {
          const requestedHour = state.slotFocus[date] ?? (date === today ? (options.now || new Date()).getHours() : 9);
          const selectedHour = isFoldedMinute(requestedHour * 60)
            ? Array.from({ length: 24 }, (_, index) => index).find(hour => !isFoldedMinute(hour * 60))
            : requestedHour;
          for (let hour = 0; hour < 24; hour++) {
            const time = hhmm(hour * 60);
            const slot = button('calv-time-slot', '', () => options.onCreateEvent(date, time));
            slot.dataset.createDate = date; slot.dataset.createTime = time;
            slot.dataset.calendarControl = `slot-${date}-${time}`;
            slot.setAttribute('aria-label', `Новое событие: ${label(date, { day: 'numeric', month: 'long', year: 'numeric' })}, ${time}`);
            slot.title = `${time} · Новое событие`;
            if (isFoldedMinute(hour * 60)) continue;
            slot.style.top = `${foldPlan.map(hour * 60)}px`; slot.style.height = `${foldPlan.map((hour + 1) * 60) - foldPlan.map(hour * 60)}px`;
            slot.tabIndex = hour === selectedHour ? 0 : -1;
            slot.addEventListener('focus', () => {
              state.slotFocus[date] = hour;
              column.querySelectorAll('[data-create-time]').forEach(item => { item.tabIndex = item === slot ? 0 : -1; });
            });
            slot.addEventListener('keydown', event => {
              let next = { ArrowUp: Math.max(0, hour - 1), ArrowDown: Math.min(23, hour + 1), Home: 0, End: 23 }[event.key];
              if (next == null) return;
              const direction = event.key === 'ArrowUp' ? -1 : 1;
              while (isFoldedMinute(next * 60) && next > 0 && next < 23) next += direction;
              event.preventDefault(); column.querySelector(`[data-create-time="${hhmm(next * 60)}"]`)?.focus();
            });
            column.append(slot);
          }
        }
        const dayRecords = timed.filter((record) => record.date === date);
        const layout = [];
        // Connected overlap groups get equal-width lanes; gaps stay empty.
        let group = [], groupEnd = -1;
        const flush = () => {
          const ends = [];
          for (const record of group) {
            const start = minutes(record.time); let lane = ends.findIndex((end) => end <= start);
            if (lane < 0) lane = ends.length;
            ends[lane] = start + (record.durationMinutes || 30);
            layout.push({ record, lane, group });
          }
          group.lanes = ends.length;
        };
        for (const record of dayRecords) {
          const start = minutes(record.time), end = start + (record.durationMinutes || 30);
          if (start >= groupEnd && group.length) { flush(); group = []; groupEnd = -1; }
          group.push(record); groupEnd = Math.max(groupEnd, end);
        }
        if (group.length) flush();
        for (const { record, lane, group: overlap } of layout) {
          if (date === options.date && foldPlan.folds.some(fold => fold.record === record)) continue;
          const node = recordButton(record, options, 'calv-grid-record');
          if ((record.durationMinutes || 30) <= 30) {
            node.classList.add('calv-grid-record--short');
            if (!record.continuesBefore && !record.continuesAfter) node.querySelector('.calv-record-time').textContent = record.time;
          }
          node.style.top = `${foldPlan.map(minutes(record.time))}px`;
          node.style.height = `${foldPlan.map(Math.min(1440, minutes(record.time) + (record.durationMinutes || 30))) - foldPlan.map(minutes(record.time))}px`;
          node.style.width = `calc(${100 / overlap.lanes}% - 6px)`;
          node.style.left = `calc(${lane * 100 / overlap.lanes}% + 3px)`;
          node.title = node.querySelector('.calv-record').getAttribute('aria-label');
          column.append(node);
        }
        if (date === options.date) for (const fold of foldPlan.folds) {
          const key = `${date}:${fold.record.id}`;
          const node = button('calv-time-fold', '', () => { state.timeFoldsExpanded[key] = true; render(root, options); });
          node.dataset.timeFold = key; node.dataset.calendarControl = `time-fold-${key}`;
          node.style.top = `${foldPlan.map(fold.start)}px`; node.style.height = `${foldedHeight}px`;
          const endLabel = fold.end === 1440 ? '24:00' : hhmm(fold.end);
          node.setAttribute('aria-label', `Сжатый интервал ${hhmm(fold.start)}–${endLabel}: ${fold.record.title}. Развернуть.`);
          const hours = Math.round((fold.record.sleepCountedMinutes ?? (fold.end - fold.start)) / 60 * 10) / 10;
          const durationLabel = fold.record.sleepCountedMinutes === null ? 'стадии сна не переданы' : `${String(hours).replace('.0', '')} ч`;
          node.textContent = fold.record.sleepContinues ? `Шёл сон · Учтён ${label(fold.record.sleepWakeDate)} · Развернуть` : `${hhmm(fold.start)}–${endLabel} · ${fold.record.title} · ${durationLabel} · Развернуть`;
          column.append(node);
        }
        for (const marker of startsOn(date)) {
          const node = renderDayStartMarker(marker);
          node.classList.add('calv-day-start--timeline');
          node.style.top = `${foldPlan.map(minutes(marker.time))}px`;
          column.append(node);
        }
        body.append(column);
      }
      board.append(body); scroll.append(board); container.append(scroll);
      if (options.onCreateEvent) container.append(el('p', 'calv-scroll-hint', 'Нажми свободную ячейку, чтобы создать событие. С клавиатуры: ↑ ↓ выбирают час, Enter открывает форму.'));
      if (options.period === 'week') container.append(el('p', 'calv-scroll-hint', 'На телефоне листай сетку вбок. Полные названия доступны в списке и по нажатию на пункт.'));
      // Start near useful daytime content; early/late records remain scrollable.
      const now = options.now || new Date();
      const selectedTimed = timed.filter(record => record.date === options.date);
      const daytime = selectedTimed.find(record => minutes(record.time) >= 7 * 60 && minutes(record.time) < 21 * 60);
      const focusHour = options.date === today
        ? now.getHours() - 1 : daytime ? Math.floor(minutes(daytime.time) / 60) - 1 : 9;
      const gridTools = el('div', 'calv-grid-tools');
      scroll.before(gridTools);
      const expandedFoldKeys = Object.keys(state.timeFoldsExpanded).filter(key => key.startsWith(`${options.date}:`) && state.timeFoldsExpanded[key]);
      if (expandedFoldKeys.length) {
        const collapse = button('calv-collapse-folds', 'Сжать длинные события', () => {
          expandedFoldKeys.forEach(key => { delete state.timeFoldsExpanded[key]; });
          render(root, options);
          root.querySelector('[data-time-fold]')?.focus();
        });
        collapse.dataset.collapseTimeFolds = ''; collapse.dataset.calendarControl = 'collapse-time-folds';
        collapse.setAttribute('aria-label', 'Сжать раскрытые длинные события этого дня');
        gridTools.append(collapse);
      }
      if (set.has(today)) {
        const jump = button('calv-jump-now', 'К текущему времени', () => {
          const current = options.now || new Date();
          scroll.scrollTop = Math.max(0, foldPlan.map(Math.max(0, current.getHours() * 60 + current.getMinutes() - 60)));
          if (options.period === 'week') scroll.scrollLeft = dates.indexOf(today) * (board.getBoundingClientRect().width - 54) / 7;
          scroll.focus();
        });
        jump.dataset.jumpNow = ''; gridTools.prepend(jump);
        jump.dataset.calendarControl = 'jump-now';
      }
      options.fitViewport?.();
      scroll.scrollTop = Math.max(0, foldPlan.map(focusHour * 60));
      if (options.period === 'week') {
        const dayIndex = dates.indexOf(options.date);
        scroll.scrollLeft = dayIndex * (board.getBoundingClientRect().width - 54) / 7;
      }
      if (scrollPosition) { scroll.scrollTop = scrollPosition.top; scroll.scrollLeft = scrollPosition.left; }
    }
    if (options.onScheduleTask) {
      for (const target of container.querySelectorAll('[data-calendar-date], [data-untimed-date]')) {
        const accepts = () => !options.actionBusy && state.draggedTask && (options.taskRecords || []).some(record => String(record.source_id) === state.draggedTask && !record.date && !isClosed(record));
        target.addEventListener('dragover', event => { if (!accepts()) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; target.classList.add('calv-drop-target'); });
        target.addEventListener('dragleave', () => target.classList.remove('calv-drop-target'));
        target.addEventListener('drop', event => {
          target.classList.remove('calv-drop-target'); if (!accepts()) return;
          event.preventDefault(); event.stopPropagation();
          const record = options.taskRecords.find(record => String(record.source_id) === state.draggedTask);
          state.draggedTask = null; options.onScheduleTask(record, target.dataset.calendarDate || target.dataset.untimedDate);
        });
      }
    }
    history(container, projected.filter(record => isClosed(record) && (!record.date || set.has(record.date))), options, state);
    if (controlFocus && !focused.isConnected) {
      const replacement = [...root.querySelectorAll('[data-calendar-control]')].find(node => node.dataset.calendarControl === controlFocus && !node.closest('[hidden]'));
      (replacement || root.querySelector('[data-tasks-toggle]')).focus({ preventScroll: true });
    }
    if (outer) outer.scrollTop = outerScroll;
  }
  export const CalendarViews = Object.freeze({ render, range, add, iso, monday, weekStart, label, daySegments, timeFoldPlan });
