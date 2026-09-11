import './styles.css';
import { tabLoaders } from './hanni/js/state.js';
import { renderTabBar, openDrawer } from './hanni/js/tabs.js';
import { toast } from './hanni/js/utils.js';
import { loadCalendarWorkspace } from './hanni/js/calendar-workspace.js';

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
} else {
  showError('Открой установленную Hanni MVP: этот экран работает с локальной базой приложения.');
}
queueMicrotask(() => {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 200);
});
