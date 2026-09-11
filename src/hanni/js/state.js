// Local-only bridge for the original Hanni Calendar components.
export function invoke(command, args) {
  if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error('Требуется установленная Hanni MVP.'));
  return window.__TAURI__.core.invoke(command, args);
}
export const listen = (...args) => window.__TAURI__.event.listen(...args);
export const emit = (...args) => window.__TAURI__.event.emit(...args);
export const IS_MOBILE = /android/i.test(navigator.userAgent) || window.innerWidth < 640;
export const IS_DESKTOP = !IS_MOBILE;
export const S = {
  APP_VERSION: '0.2.0', activeTab: 'calendar', openTabs: ['calendar'], activeSubTab: {},
  tabCustomizations: {}, theme: localStorage.getItem('hanni_theme') || 'light',
  calendarYear: new Date().getFullYear(), calendarMonth: new Date().getMonth(),
  selectedCalendarDate: null, calWeekOffset: 0, calDayDate: null,
};
export function setTheme(theme) {
  S.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', S.theme);
  localStorage.setItem('hanni_theme', S.theme);
}
setTheme(S.theme);
export const _s = d => '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + d + '</svg>';
// Upstream calendar and settings SVG constants are inserted below.
export const TAB_ICONS = {
  calendar:    _s('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  settings:    _s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
};
export const TAB_REGISTRY = { calendar: { label: 'Календарь', icon: TAB_ICONS.calendar, closable: false, subTabs: [] } };
export const TAB_DESCRIPTIONS = { calendar: 'События и расписание' };
export function saveTabCustom() { localStorage.setItem('hanni_tab_custom', JSON.stringify(S.tabCustomizations)); }
export function getTabIcon(id) { return TAB_ICONS[id] || ''; }
export function getTabDesc(id) { return S.tabCustomizations[id]?.desc ?? TAB_DESCRIPTIONS[id] ?? ''; }
export const TAB_SETTINGS_DEFS = { calendar: [
  { key: 'first_day', label: 'Первый день недели', type: 'select', options: [
    { value: 'mon', label: 'Понедельник' }, { value: 'sun', label: 'Воскресенье' },
  ], default: 'mon' },
  { key: 'default_view', label: 'Вид по умолчанию', type: 'select', options: [
    { value: 'Месяц', label: 'Месяц' }, { value: 'Неделя', label: 'Неделя' },
    { value: 'День', label: 'День' }, { value: 'Список', label: 'Список' },
  ], default: 'Месяц' },
] };
export const tabLoaders = {};
export async function loadTabSetting(tabId, key) { return invoke('get_app_setting', { key: 'tab_' + tabId + '_' + key }); }
export async function saveTabSetting(tabId, key, value) { return invoke('set_app_setting', { key: 'tab_' + tabId + '_' + key, value: String(value) }); }
