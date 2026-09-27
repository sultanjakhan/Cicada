import { projectDayStarts } from './calendar-day-start.js';
import { dateKey } from './calendar-recurring-store.js';
import { ICONS } from './icons.js';

export function mountCalendarDayBanner(element, { invoke, now = () => new Date(), onOpenSettings } = {}) {
  const document = element.ownerDocument, window = document.defaultView;
  let disposed = false, busy = false, loaded = false, day = '', entries = [], revision = 0, pendingRefresh = false;
  element.className = 'calendar-day-banner';
  // One row: the date may ellipsize, the start action keeps its full label.
  const today = onOpenSettings
    ? `<button type="button" class="today-date__settings" data-today-settings aria-label="Настроить рекомендации на сегодня" aria-haspopup="dialog">Сегодня<span aria-hidden="true">${ICONS.sliders}</span></button>`
    : '<span class="today-date__label">Сегодня</span>';
  element.innerHTML = `<div class="today-date"><h2>${today}<span class="today-date__day"> · <time></time>, <span data-weekday></span></span></h2></div><button type="button" data-start-day disabled>Начать день</button><p role="alert" hidden></p><button type="button" data-day-retry hidden>Повторить загрузку</button>`;
  const settings = element.querySelector('[data-today-settings]');
  if (settings) settings.onclick = () => { if (!disposed) onOpenSettings(settings); };
  const start = element.querySelector('[data-start-day]'), error = element.querySelector('[role=alert]'), retry = element.querySelector('[data-day-retry]');
  function render() {
    if (disposed) return;
    const current = now(); day = dateKey(current);
    element.querySelector('[data-weekday]').textContent = new Intl.DateTimeFormat('ru', { weekday: 'long' }).format(current);
    const time = element.querySelector('time'); time.dateTime = day;
    time.textContent = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(current);
    const started = entries.find(entry => entry.date === day);
    start.textContent = started ? '✓ День начат · ' + started.time : 'Начать день';
    start.disabled = busy || !loaded || !!started; start.classList.toggle('is-started', !!started);
  }
  function ledger(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value || { version: 1, entries: [] };
    if (!parsed || !Array.isArray(parsed.entries)) throw Error('Не удалось прочитать начало дня.');
    return projectDayStarts(parsed);
  }
  async function refresh() {
    if (disposed) return;
    if (busy) { pendingRefresh = true; return; }
    const request = ++revision;
    try {
      const next = ledger(await invoke('get_ui_state', { key: 'calendar_day_start_v1' }));
      if (disposed || request !== revision) return;
      entries = next; loaded = true; error.hidden = true; retry.hidden = true;
    } catch {
      if (disposed || request !== revision) return;
      error.textContent = 'Не удалось обновить начало дня. Повтори загрузку.'; error.hidden = false; retry.hidden = false;
    }
    render();
  }
  async function save() {
    if (disposed || busy || !loaded) return;
    busy = true; ++revision; render();
    try {
      const next = ledger(await invoke('start_calendar_day', {}));
      if (disposed) return;
      entries = next; error.hidden = true; retry.hidden = true;
      window.dispatchEvent(new window.Event('hanni:calendar-refresh'));
    } catch {
      if (!disposed) { error.textContent = 'Не удалось сохранить начало дня. Повтори попытку.'; error.hidden = false; }
    } finally {
      busy = false; render();
      if (pendingRefresh && !disposed) { pendingRefresh = false; void refresh(); }
    }
  }
  const onRefresh = () => { void refresh(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
  start.onclick = () => void save(); retry.onclick = onRefresh;
  window.addEventListener('hanni:calendar-refresh', onRefresh); window.addEventListener('focus', onRefresh);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => { if (day !== dateKey(now())) void refresh(); }, 30_000);
  void refresh();
  return () => {
    disposed = true; ++revision; window.clearInterval(timer);
    window.removeEventListener('hanni:calendar-refresh', onRefresh); window.removeEventListener('focus', onRefresh);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
