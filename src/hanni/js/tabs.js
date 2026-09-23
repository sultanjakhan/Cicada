import { S, TAB_ICONS, TAB_REGISTRY, getTabIcon, IS_MOBILE, tabLoaders } from './state.js';
import { showCalendarSettings } from './calendar-settings.js';

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

export async function loadSubTabContent(tabId, subTab) {
  if (tabId !== 'calendar') return;
  if (subTab === 'Настройки') {
    showCalendarSettings(document.querySelector('[data-calendar-settings]'));
    return;
  }
  await tabLoaders.calendar?.();
}

export function switchTab(tabId) {
  if (tabId !== 'calendar') return;
  if (S.activeTab === tabId && document.querySelector('#calendar-content .uni-header')) return;
  S.activeTab = 'calendar';
  renderTabBar();
  void loadSubTabContent('calendar', S.activeSubTab.calendar || null);
}

export function renderSubSidebar() {
  // The original renderer has no sub-navigation for Calendar; its workspace owns the pane tabs.
}

export function renderTabBar() {
  const tabList = document.getElementById('tab-list');
  const bottom = document.getElementById('tab-bar-bottom');
  if (!tabList || !bottom) return;
  tabList.replaceChildren();
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'tab-item active';
  item.dataset.tabId = 'calendar';
  item.title = TAB_REGISTRY.calendar.label;
  item.setAttribute('aria-label', TAB_REGISTRY.calendar.label);
  item.setAttribute('aria-current', 'page');
  item.innerHTML = `<span class="tab-item-icon">${getTabIcon('calendar')}</span>${IS_MOBILE ? `<span class="tab-item-label">${TAB_REGISTRY.calendar.label}</span>` : ''}`;
  const select = () => { closeDrawer(); switchTab('calendar'); };
  item.addEventListener('click', select);
  tabList.append(item);

  bottom.replaceChildren();
  const gear = document.createElement('button');
  gear.type = 'button'; gear.dataset.calendarSettings = '';
  gear.className = 'tab-item';
  gear.title = 'Настройки';
  gear.setAttribute('aria-label', gear.title);
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.innerHTML = `<span class="tab-item-icon">${TAB_ICONS.settings}</span>${IS_MOBILE ? `<span class="tab-item-label">${gear.title}</span>` : ''}`;
  gear.addEventListener('click', () => { closeDrawer(); showCalendarSettings(gear); });
  const version = document.createElement('div');
  version.className = 'version-label-bar';
  version.textContent = `v${S.APP_VERSION}`;
  bottom.append(gear, version);
}
