import { S, TAB_ICONS, TAB_REGISTRY, getTabIcon, IS_MOBILE, setTheme, tabLoaders } from './state.js';

let drawerBackdrop = null;

export function closeDrawer() {
  document.getElementById('tab-bar')?.classList.remove('drawer-open');
  drawerBackdrop?.classList.remove('visible');
}

export function openDrawer() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  tabBar.classList.add('drawer-open');
  if (!drawerBackdrop) {
    drawerBackdrop = document.createElement('div');
    drawerBackdrop.className = 'drawer-backdrop';
    drawerBackdrop.addEventListener('click', closeDrawer);
    document.body.append(drawerBackdrop);
  }
  requestAnimationFrame(() => drawerBackdrop.classList.add('visible'));
}

function hideSettings() {
  const content = document.getElementById('calendar-content');
  const settings = content?.querySelector('.settings-page');
  if (!content || !settings) return;
  settings.remove();
  [...content.children].forEach(child => { child.hidden = false; });
  S.settingsOpen = false;
  renderTabBar();
}

function showSettings() {
  const content = document.getElementById('calendar-content');
  if (!content) return;
  if (S.settingsOpen) return hideSettings();
  [...content.children].forEach(child => { child.hidden = true; });
  const page = document.createElement('section');
  page.className = 'settings-page';
  page.innerHTML = `<div class="settings-page-header"><span class="settings-page-icon">${TAB_ICONS.settings}</span><span class="settings-page-title">Настройки — ${TAB_REGISTRY.calendar.label}</span></div>
    <div class="tab-settings-tabs"><button class="tab-settings-tab active" type="button">Оформление</button></div>
    <div class="settings-page-content"><div class="settings-section"><div class="settings-section-title">Оформление</div><div class="settings-row"><span class="settings-label">Тема</span><span class="settings-value"><select class="form-input" data-theme-setting><option value="light">Светлая</option><option value="dark">Тёмная</option></select></span></div></div></div>`;
  const select = page.querySelector('[data-theme-setting]');
  select.value = S.theme;
  select.addEventListener('change', () => setTheme(select.value));
  content.append(page);
  S.settingsOpen = true;
  renderTabBar();
}

export function renderTabBar() {
  const tabList = document.getElementById('tab-list');
  const bottom = document.getElementById('tab-bar-bottom');
  if (!tabList || !bottom) return;
  tabList.replaceChildren();
  const item = document.createElement('div');
  item.className = 'tab-item active';
  item.dataset.tabId = 'calendar';
  item.title = TAB_REGISTRY.calendar.label;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
  const icon = getTabIcon('calendar');
  item.innerHTML = `<span class="tab-item-icon">${icon}</span>${IS_MOBILE ? `<span class="tab-item-label">${TAB_REGISTRY.calendar.label}</span>` : ''}`;
  const select = () => { closeDrawer(); if (S.settingsOpen) hideSettings(); else tabLoaders.calendar?.(); };
  item.addEventListener('click', select);
  item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  tabList.append(item);
  bottom.replaceChildren();
  const gear = document.createElement('div');
  gear.className = 'tab-item' + (S.settingsOpen ? ' active' : '');
  gear.title = 'Настройки';
  gear.setAttribute('role', 'button');
  gear.setAttribute('aria-label', gear.title);
  gear.tabIndex = 0;
  gear.innerHTML = `<span class="tab-item-icon">${TAB_ICONS.settings}</span>`;
  gear.addEventListener('click', showSettings);
  gear.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showSettings(); } });
  const version = document.createElement('div');
  version.className = 'version-label-bar';
  version.textContent = `v${S.APP_VERSION}`;
  bottom.append(gear, version);
}
