import './styles.css';
import { S, invoke, setTheme, tabLoaders } from './hanni/js/state.js';
import { renderTabBar } from './hanni/js/tabs.js';
import { loadCalendarWorkspace } from './hanni/js/calendar-workspace.js';

const alert = document.getElementById('mvp-alert');
function showError(error) {
  alert.querySelector('span').textContent = String(error?.message || error);
  alert.hidden = false;
}
alert.querySelector('button').addEventListener('click', () => { alert.hidden = true; });
window.addEventListener('unhandledrejection', event => { showError(event.reason); });
window.addEventListener('error', event => { showError(event.error || event.message); });

const settings = document.getElementById('mvp-settings');
document.addEventListener('hanni:settings', () => {
  document.getElementById('mvp-theme').value = S.theme;
  settings.showModal();
});
document.getElementById('mvp-settings-close').addEventListener('click', () => settings.close());
document.getElementById('mvp-theme').addEventListener('change', event => setTheme(event.target.value));
document.getElementById('mvp-backup').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await invoke('create_backup');
    document.getElementById('mvp-backup-result').textContent = 'Копия сохранена: ' + (typeof result === 'string' ? result : result.path);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});
document.getElementById('mobile-hamburger').addEventListener('click', () => document.getElementById('tab-bar').classList.toggle('drawer-open'));
tabLoaders.calendar = () => loadCalendarWorkspace(document.getElementById('calendar-content'));
renderTabBar();
if (window.__TAURI__?.core?.invoke) {
  tabLoaders.calendar().catch(showError);
} else {
  showError('Открой установленную Hanni MVP: этот экран работает с локальной базой приложения.');
}
