import './styles.css';
import { createStore } from './store.js';
import { todayKey, dateFromKey, addDays, weekDays, monthDays, shiftMonth, minutesLabel, itemSegments, compareItems, formatMonth, formatDay } from './dates.js';
import { layoutSegments } from './layout.js';

const $ = selector => document.querySelector(selector);
const form = $('#recordForm');
const state = { date: todayKey(), view: 'week', filter: 'all', items: [], showCompleted: false, dateFilter: null, editing: null, kind: 'task', initialForm: '', busy: false, ready: false };
let store;
let toastTimer;
let previousFocus;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const labelKind = item => item.kind === 'task' ? 'Задача' : 'Событие';
const showError = error => {
  $('#errorBanner span').textContent = String(error?.message || error);
  $('#errorBanner').hidden = false;
};
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function visibleItems() {
  return state.items.filter(item => (state.filter === 'all' || item.kind === state.filter) && (state.showCompleted || !item.completed)).sort(compareItems);
}
function onDate(item, date) {
  return item.date === date || itemSegments(item).some(segment => segment.date === date);
}
function itemButton(item, extra = '') {
  return `<button class="mini-record ${item.kind} ${item.completed ? 'is-completed' : ''}" data-item="${escapeHtml(item.id)}" title="${escapeHtml(item.title)}"><span class="record-dot" aria-hidden="true">${item.completed ? '✓' : ''}</span>${item.time ? `<span class="mini-time">${escapeHtml(item.time)}</span>` : ''}<span class="mini-title">${escapeHtml(item.title)}</span>${extra}</button>`;
}
function renderWeek(items) {
  const days = weekDays(state.date);
  const now = new Date();
  const today = todayKey(now);
  const timed = items.flatMap(item => itemSegments(item).map(segment => ({ ...segment, item })));
  return `<div class="week-view"><div class="week-sticky"><div class="week-head"><div class="time-corner">${Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').at(-1).replaceAll('_', ' ')}</div>${days.map(date => `<button class="week-day-heading ${date === today ? 'today' : ''}" data-create-date="${date}" title="Добавить запись на ${escapeHtml(formatDay(date))}"><span>${dateFromKey(date).toLocaleDateString('ru', { weekday: 'short' })}</span><strong>${Number(date.slice(-2))}</strong></button>`).join('')}</div><div class="all-day-grid"><div class="all-day-label">На день</div>${days.map(date => `<div class="all-day-cell">${items.filter(item => item.date === date && !item.time).map(item => itemButton(item)).join('')}</div>`).join('')}</div></div><div class="week-scroll"><div class="time-grid"><div class="time-axis">${Array.from({ length: 24 }, (_, hour) => `<span style="top:${hour * 60}px">${String(hour).padStart(2, '0')}:00</span>`).join('')}</div>${days.map(date => {
    const segments = layoutSegments(timed.filter(segment => segment.date === date));
    return `<div class="time-column ${date === today ? 'today-column' : ''}"><button class="grid-hit" data-grid-date="${date}" aria-label="Добавить запись на ${escapeHtml(formatDay(date))}"></button>${segments.map(segment => `<button class="timed-record ${segment.item.kind} ${segment.item.completed ? 'is-completed' : ''}" data-item="${escapeHtml(segment.item.id)}" style="top:${segment.start}px;height:${Math.max(24, segment.end - segment.start - 2)}px;left:calc(${segment.lane / segment.columns * 100}% + 3px);width:calc(${100 / segment.columns}% - 6px)" title="${escapeHtml(segment.item.title)} · ${minutesLabel(segment.start)}–${minutesLabel(segment.end)}"><strong>${segment.continuedBefore ? '↳ ' : ''}${escapeHtml(segment.item.title)}</strong>${segment.end - segment.start >= 38 ? `<span>${minutesLabel(segment.start)}–${minutesLabel(segment.end)}${segment.continuedAfter ? ' ↗' : ''}</span>` : ''}</button>`).join('')}${date === today ? `<div class="now-line" style="top:${now.getHours() * 60 + now.getMinutes()}px"><span></span></div>` : ''}</div>`;
  }).join('')}</div></div></div>`;
}
function renderMonth(items) {
  const days = monthDays(state.date);
  return `<div class="month-view"><div class="month-weekdays">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => `<span>${day}</span>`).join('')}</div><div class="month-grid">${days.map(date => {
    const records = items.filter(item => onDate(item, date));
    return `<div class="month-cell ${date.slice(0, 7) !== state.date.slice(0, 7) ? 'outside-month' : ''}"><button class="day-number ${date === todayKey() ? 'today' : ''}" data-create-date="${date}" aria-label="Добавить запись на ${escapeHtml(formatDay(date))}">${Number(date.slice(-2))}</button><div class="month-records">${records.slice(0, 3).map(item => itemButton(item, item.date !== date ? '<span>↳</span>' : '')).join('')}${records.length > 3 ? `<button class="more-button" data-day-list="${date}">ещё ${records.length - 3}</button>` : ''}</div></div>`;
  }).join('')}</div></div>`;
}
function agendaTime(item) {
  if (!item.time) return item.date ? 'На день' : '—';
  const segment = state.dateFilter && itemSegments(item).find(value => value.date === state.dateFilter);
  return segment ? `${segment.continuedBefore ? '↳ ' : ''}${minutesLabel(segment.start)}` : item.time;
}
function renderList(items) {
  const shown = state.dateFilter === 'undated' ? items.filter(item => !item.date) : state.dateFilter ? items.filter(item => onDate(item, state.dateFilter)) : items;
  const groups = new Map();
  for (const item of shown) {
    const key = state.dateFilter && state.dateFilter !== 'undated' ? state.dateFilter : item.date || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const filter = state.dateFilter ? `<div class="list-active-filter"><span>${state.dateFilter === 'undated' ? 'Без даты' : escapeHtml(formatDay(state.dateFilter))}</span><button class="subtle-button" id="clearDateFilter">Показать все записи ×</button></div>` : '';
  if (!shown.length) return `${filter}<div class="empty-state"><div class="empty-calendar" aria-hidden="true">${state.dateFilter === 'undated' ? '✓' : '＋'}</div><h2>${state.dateFilter === 'undated' ? 'Нет записей без даты' : 'Здесь пока пусто'}</h2><p>Добавь задачу или событие — и начни с одного дела.</p><button class="primary-button" id="emptyCreate">Создать запись</button></div>`;
  return `${filter}<div class="agenda">${[...groups].map(([date, records]) => `<section class="agenda-group"><h2>${date === 'undated' ? 'Без даты' : escapeHtml(formatDay(date))}${date === todayKey() ? '<span class="today-label">Сегодня</span>' : ''}</h2>${records.map(item => `<div class="agenda-row ${item.completed ? 'is-completed' : ''}">${item.kind === 'task' ? `<input class="task-check" type="checkbox" data-complete="${escapeHtml(item.id)}" ${item.completed ? 'checked' : ''} aria-label="${item.completed ? 'Вернуть в работу' : 'Завершить'}: ${escapeHtml(item.title)}">` : '<span class="event-symbol" aria-label="Событие">◇</span>'}<button class="agenda-item" data-item="${escapeHtml(item.id)}"><span class="agenda-time">${escapeHtml(agendaTime(item))}</span><span class="agenda-text"><strong>${escapeHtml(item.title)}</strong>${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ''}</span><span class="type-label ${item.kind}">${labelKind(item)}</span></button></div>`).join('')}</section>`).join('')}</div>`;
}
function render({ resetScroll = false } = {}) {
  const scroll = $('.week-scroll')?.scrollTop;
  const items = visibleItems();
  $('#periodTitle').textContent = state.view === 'list' ? 'Все записи' : formatMonth(state.date);
  $('#previousButton').disabled = state.view === 'list';
  $('#nextButton').disabled = state.view === 'list';
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === state.view));
  document.querySelectorAll('[data-filter]').forEach(button => { button.setAttribute('aria-pressed', button.dataset.filter === state.filter); button.classList.toggle('active', button.dataset.filter === state.filter); });
  $('#undatedCount').textContent = state.items.filter(item => !item.date && !item.completed).length;
  $('#calendar').innerHTML = state.view === 'week' ? renderWeek(items) : state.view === 'month' ? renderMonth(items) : renderList(items);
  $('#calendar').setAttribute('aria-busy', 'false');
  $('#recordSummary').textContent = state.items.length ? `${state.items.filter(item => item.kind === 'task' && !item.completed).length} задач в работе · ${state.items.filter(item => item.kind === 'event').length} событий` : 'Пустой календарь. Место для твоих планов.';
  const scroller = $('.week-scroll');
  if (scroller) scroller.scrollTop = !resetScroll && scroll != null ? scroll : 8 * 60;
}
async function refresh(options = {}) {
  try {
    store ||= await createStore();
    state.items = await store.list();
    state.ready = true;
    $('#errorBanner').hidden = true;
    $('#previewBanner').hidden = !store.preview;
    $('#storageBadge').hidden = store.preview;
    $('#backupButton').disabled = store.preview;
    render(options);
  } catch (error) {
    showError(error);
    if (!state.ready) {
      $('#calendar').innerHTML = '<div class="empty-state"><h2>Календарь не открылся</h2><p>Данные не изменены. Исправь ошибку выше и повтори попытку.</p></div>';
      $('#calendar').setAttribute('aria-busy', 'false');
    }
  }
}
function formInput() {
  const values = new FormData(form);
  return {
    id: state.editing?.id || null,
    expected_version: state.editing?.version || null,
    kind: state.kind,
    title: String(values.get('title') || '').trim(),
    notes: String(values.get('notes') || ''),
    date: values.get('date') || null,
    time: values.get('time') || null,
    duration_minutes: Number(values.get('duration_minutes')) || 60,
    completed: state.kind === 'task' && form.elements.completed.checked,
  };
}
function formState() { return JSON.stringify(formInput()); }
function updateKind(kind) {
  state.kind = kind;
  document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', button.dataset.kind === kind));
  form.elements.date.required = kind === 'event';
  $('#dateHint').textContent = kind === 'event' ? 'обязательно' : 'можно без даты';
  $('#completedField').hidden = kind !== 'task';
  if (kind === 'event') {
    form.elements.completed.checked = false;
    if (!form.elements.date.value) form.elements.date.value = state.date;
  }
  updateTimeHint();
}
function updateTimeHint() {
  const input = formInput();
  form.elements.time.disabled = !input.date;
  if (!input.date) form.elements.time.value = '';
  $('#durationField').hidden = !form.elements.time.value;
  if (!input.date) $('#timeHint').textContent = 'Задача останется в списке «Без даты».';
  else if (!input.time) $('#timeHint').textContent = input.kind === 'event' ? 'Без времени — событие на весь день.' : 'Без времени — задача на выбранный день.';
  else {
    try {
      const segments = itemSegments(input);
      const last = segments.at(-1);
      $('#timeHint').textContent = `До ${minutesLabel(last.end)}${segments.length > 1 ? ' следующего дня' : ''}`;
    } catch { $('#timeHint').textContent = 'Длительность — от 1 до 1440 минут.'; }
  }
}
async function confirmAction(title, text, action = 'Продолжить') {
  const dialog = $('#confirmDialog');
  if (dialog.open) return false;
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmAction').textContent = action;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function mayDiscard() {
  return $('#editor').hidden || state.initialForm === formState() || await confirmAction('Закрыть без сохранения?', 'Изменения в этой записи не сохранены.', 'Не сохранять');
}
async function openEditor(item = null, defaults = {}) {
  if (!state.ready || state.busy || !await mayDiscard()) return;
  previousFocus = document.activeElement;
  state.editing = item ? { ...item } : null;
  form.reset();
  form.elements.title.value = item?.title || '';
  form.elements.notes.value = item?.notes || '';
  form.elements.date.value = item ? item.date || '' : defaults.date === null ? '' : defaults.date || state.date;
  form.elements.time.value = item?.time || defaults.time || '';
  form.elements.duration_minutes.value = item?.duration_minutes || 60;
  form.elements.completed.checked = !!item?.completed;
  updateKind(item?.kind || 'task');
  $('#editorEyebrow').textContent = item ? 'В КАЛЕНДАРЕ' : 'НОВАЯ ЗАПИСЬ';
  $('#editorTitle').textContent = item ? 'Детали записи' : 'Добавить в календарь';
  $('#deleteButton').hidden = !item;
  $('#formError').hidden = true;
  $('#editor').hidden = false;
  $('#workspace').classList.add('editing');
  state.initialForm = formState();
  $('#titleInput').focus();
}
function closeEditor() {
  $('#editor').hidden = true;
  $('#workspace').classList.remove('editing');
  state.editing = null;
  (previousFocus?.isConnected ? previousFocus : $('#newButton')).focus();
}
function formError(error) {
  $('#formError').textContent = String(error?.message || error);
  $('#formError').hidden = false;
}
function setBusy(busy) {
  state.busy = busy;
  form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = busy; });
  $('#closeEditor').disabled = busy;
  $('#saveButton').textContent = busy ? 'Сохраняем…' : 'Сохранить';
  if (!busy) updateTimeHint();
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !form.reportValidity()) return;
  const input = formInput();
  if (!input.title) { formError('Добавь название записи.'); $('#titleInput').focus(); return; }
  const editing = !!state.editing;
  setBusy(true);
  try {
    await store.save(input);
    closeEditor();
    await refresh();
    toast(editing ? 'Изменения сохранены' : 'Запись добавлена');
  } catch (error) { formError(error); }
  finally { setBusy(false); }
});
form.addEventListener('input', updateTimeHint);
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => updateKind(button.dataset.kind)));
$('#closeEditor').addEventListener('click', async () => { if (!state.busy && await mayDiscard()) closeEditor(); });
$('#newButton').addEventListener('click', () => openEditor());
$('#deleteButton').addEventListener('click', async () => {
  if (!state.editing || state.busy) return;
  const item = state.editing;
  if (!await confirmAction('Удалить запись?', `«${item.title}» будет удалена из календаря.`, 'Удалить')) return;
  setBusy(true);
  try { await store.remove(item); closeEditor(); await refresh(); toast('Запись удалена'); }
  catch (error) { formError(error); }
  finally { setBusy(false); }
});
$('#calendar').addEventListener('click', async event => {
  const target = event.target.closest('button, input[data-complete]');
  if (!target || state.busy) return;
  if (target.dataset.item) return openEditor(state.items.find(item => item.id === target.dataset.item));
  if (target.dataset.complete) {
    const item = state.items.find(value => value.id === target.dataset.complete);
    target.disabled = true;
    try { await store.complete(item); await refresh(); toast(item.completed ? 'Задача возвращена в работу' : 'Задача завершена'); }
    catch (error) { target.checked = item.completed; target.disabled = false; showError(error); }
    return;
  }
  if (target.dataset.createDate) return openEditor(null, { date: target.dataset.createDate });
  if (target.dataset.gridDate) {
    const minute = event.detail === 0 ? 9 * 60 : Math.min(1410, Math.max(0, Math.floor((event.clientY - target.getBoundingClientRect().top) / 30) * 30));
    return openEditor(null, { date: target.dataset.gridDate, time: minutesLabel(minute) });
  }
  if (target.dataset.dayList) { state.view = 'list'; state.dateFilter = target.dataset.dayList; render(); }
  if (target.id === 'clearDateFilter') { state.dateFilter = null; render(); }
  if (target.id === 'emptyCreate') openEditor(null, { date: state.dateFilter === 'undated' ? null : state.date });
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  if (!state.ready) return;
  state.view = button.dataset.view; state.dateFilter = null; render({ resetScroll: true });
}));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  if (!state.ready) return;
  state.filter = button.dataset.filter; render();
}));
$('#showCompleted').addEventListener('change', event => { state.showCompleted = event.target.checked; if (state.ready) render(); });
$('#undatedButton').addEventListener('click', () => { if (state.ready) { state.view = 'list'; state.dateFilter = 'undated'; render(); } });
function navigate(direction) {
  if (!state.ready || state.view === 'list') return;
  state.date = state.view === 'week' ? addDays(state.date, direction * 7) : shiftMonth(state.date, direction);
  render({ resetScroll: true });
}
$('#previousButton').addEventListener('click', () => navigate(-1));
$('#nextButton').addEventListener('click', () => navigate(1));
function goToday() { if (state.ready) { state.date = todayKey(); state.dateFilter = null; if (state.view === 'list') state.view = 'week'; render({ resetScroll: true }); } }
$('#todayButton').addEventListener('click', goToday);
$('.brand').addEventListener('click', event => { event.preventDefault(); goToday(); });
$('#retryButton').addEventListener('click', () => refresh());
$('#settingsButton').addEventListener('click', () => $('#settingsDialog').showModal());
$('#closeSettings').addEventListener('click', () => $('#settingsDialog').close());
$('#backupButton').addEventListener('click', async () => {
  if (!store) return;
  $('#backupButton').disabled = true;
  $('#backupResult').textContent = 'Создаём копию…';
  try { const path = await store.backup(); $('#backupResult').textContent = `Копия сохранена: ${path}`; }
  catch (error) { $('#backupResult').textContent = String(error?.message || error); }
  finally { $('#backupButton').disabled = !!store.preview; }
});
function setTheme(theme) {
  const valid = ['light', 'dark'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = valid;
  $('#themeSelect').value = valid;
  try { localStorage.setItem('hanni-mvp-theme', valid); } catch { /* Theme remains usable without storage. */ }
}
try { setTheme(localStorage.getItem('hanni-mvp-theme')); } catch { setTheme('system'); }
$('#themeSelect').addEventListener('change', event => setTheme(event.target.value));
document.addEventListener('keydown', async event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !$('#editor').hidden && !state.busy) {
    event.preventDefault(); if (await mayDiscard()) closeEditor();
  }
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest('input, textarea, select, [contenteditable="true"], dialog') && $('#editor').hidden) {
    event.preventDefault(); openEditor();
  }
});
setInterval(() => { if (state.ready && state.view === 'week' && $('#editor').hidden && !document.hidden) render(); }, 60_000);
await refresh({ resetScroll: true });
