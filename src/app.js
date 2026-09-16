import './styles.css';
import './hanni/css/calendar-dashboard-v7.css';
import './hanni/css/sync-conflicts.css';
import { tabLoaders, invoke, listen, requestMvpSync, getPendingMvpOperations } from './hanni/js/state.js';
import { startMvpSyncRefresh } from './hanni/js/content-sync-refresh.js';
import { requestHealthViewRefresh } from './hanni/js/health-view-refresh.js';
import { renderTabBar, openDrawer } from './hanni/js/tabs.js';
import { toast } from './hanni/js/utils.js';
import { loadCalendarWorkspace } from './hanni/js/calendar-workspace.js';
import { startAppUpdates } from './hanni/js/app-updates.js';
import { hasUnsavedCalendarNoteDrafts } from './hanni/js/calendar-notes.js';

function showError(error) {
  toast(String(error?.message || error), 'error');
}

window.addEventListener('unhandledrejection', event => showError(event.reason));
window.addEventListener('error', event => showError(event.error || event.message));
document.getElementById('mobile-hamburger').addEventListener('click', openDrawer);
tabLoaders.calendar = () => loadCalendarWorkspace(document.getElementById('calendar-content'));
renderTabBar();
if (window.__TAURI__?.core?.invoke) {
  tabLoaders.calendar().catch(showError);
  startMvpSyncRefresh({ window, invoke, listen, requestSync: requestMvpSync, requestRefresh: requestHealthViewRefresh });
  startAppUpdates({ window, invoke, listen, getPendingOperations: getPendingMvpOperations,
    hasUnsavedDrafts: hasUnsavedCalendarNoteDrafts, notify: message => toast(message) });
} else {
  showError('Открой установленную Hanni MVP: этот экран работает с локальной базой приложения.');
}
queueMicrotask(() => {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 200);
});
