// Native bridge for the original Hanni Calendar components.
import packageInfo from '../../../package.json' with { type: 'json' };
import { loadCalendarPreferences } from './calendar-display-preferences.js';
import { createSyncTrigger, isSyncWrite } from './sync-trigger.js';
const syncTrigger = createSyncTrigger({
  invoke: command => window.__TAURI__.core.invoke(command),
  setTimeout: (...args) => window.setTimeout(...args), clearTimeout: timer => window.clearTimeout(timer),
  afterSync: () => window.dispatchEvent(new window.Event('hanni:sync-check-status')),
});
export const requestMvpSync = () => { if (window.__TAURI__?.core?.invoke) syncTrigger.request(); };
export async function invoke(command, args) {
  if (!window.__TAURI__?.core?.invoke) return Promise.reject(new Error('Требуется установленная Hanni MVP.'));
  const result = await window.__TAURI__.core.invoke(command, args);
  if (isSyncWrite(command)) requestMvpSync();
  return result;
}
export const listen = (...args) => window.__TAURI__.event.listen(...args);
export const emit = (...args) => window.__TAURI__.event.emit(...args);
const FORCE_MOBILE = (() => { try { return localStorage.getItem('hanni_force_mobile') === '1'; } catch { return false; } })();
// A minimized desktop WebView can start with a zero-width viewport. Its
// temporary size must not lock the shell into phone navigation for the session.
export const IS_MOBILE = /android/i.test(navigator.userAgent) || FORCE_MOBILE;
export const IS_DESKTOP = !IS_MOBILE;
document.documentElement.classList.add(IS_MOBILE ? 'mobile' : 'desktop');
if (FORCE_MOBILE) document.documentElement.classList.add('mobile-preview');
export const S = {
  APP_VERSION: packageInfo.version, activeTab: 'calendar', openTabs: ['calendar'], activeSubTab: {},
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
  settings:    _s('<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  add:         _s('<path d="M12 5v14M5 12h14"/>'),
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
export async function loadTabSetting(tabId, key) {
  if (tabId === 'calendar' && ['first_day','default_view'].includes(key)) {
    return (await loadCalendarPreferences(invoke))[key];
  }
  return invoke('get_app_setting', { key: 'tab_' + tabId + '_' + key });
}
export async function saveTabSetting(tabId, key, value) { return invoke('set_app_setting', { key: 'tab_' + tabId + '_' + key, value: String(value) }); }
