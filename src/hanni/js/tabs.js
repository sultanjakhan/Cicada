import { S, TAB_ICONS, TAB_REGISTRY, TAB_SETTINGS_DEFS, getTabIcon, IS_MOBILE, tabLoaders, loadTabSetting, saveTabSetting } from './state.js';

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
    tabLoaders.cleanupCalendar?.();
    await renderSettingsPage();
    return;
  }
  await tabLoaders.calendar?.();
}

export function switchTab(tabId) {
  if (tabId !== 'calendar') return;
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
  const item = document.createElement('div');
  item.className = 'tab-item active';
  item.dataset.tabId = 'calendar';
  item.title = TAB_REGISTRY.calendar.label;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
  item.innerHTML = `<span class="tab-item-icon">${getTabIcon('calendar')}</span>${IS_MOBILE ? `<span class="tab-item-label">${TAB_REGISTRY.calendar.label}</span>` : ''}`;
  const select = () => { closeDrawer(); switchTab('calendar'); };
  item.addEventListener('click', select);
  item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  tabList.append(item);

  bottom.replaceChildren();
  const gear = document.createElement('div');
  const inSettings = S.activeSubTab.calendar === 'Настройки';
  gear.className = 'tab-item' + (inSettings ? ' active' : '');
  gear.title = 'Настройки';
  gear.setAttribute('role', 'button');
  gear.setAttribute('aria-label', gear.title);
  gear.tabIndex = 0;
  gear.innerHTML = `<span class="tab-item-icon">${TAB_ICONS.settings}</span>`;
  const toggleSettings = () => {
    S.activeSubTab.calendar = inSettings ? null : 'Настройки';
    renderTabBar();
    void loadSubTabContent('calendar', S.activeSubTab.calendar);
  };
  gear.addEventListener('click', toggleSettings);
  gear.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSettings(); } });
  const version = document.createElement('div');
  version.className = 'version-label-bar';
  version.textContent = `v${S.APP_VERSION}`;
  bottom.append(gear, version);
}

async function renderSettingsPage() {
  const el = document.getElementById('calendar-content');
  if (!el || S.activeSubTab.calendar !== 'Настройки') return;
  const defs = TAB_SETTINGS_DEFS.calendar;
  const values = await Promise.all(defs.map(async def => [def, (await loadTabSetting('calendar', def.key)) ?? def.default]));
  if (S.activeSubTab.calendar !== 'Настройки') return;
  const rows = values.map(([def, value]) => `<div class="settings-row"><span class="settings-label">${def.label}</span><span class="settings-value"><div class="setting-pills" data-tab-id="calendar" data-setting-key="${def.key}">${def.options.map(option => `<button class="setting-pill${value === option.value ? ' active' : ''}" data-value="${option.value}" type="button">${option.label}</button>`).join('')}</div></span></div>`).join('');
  el.innerHTML = `<div class="settings-page"><div class="settings-page-header"><span class="settings-page-icon">${TAB_ICONS.settings}</span><span class="settings-page-title">Настройки — ${TAB_REGISTRY.calendar.label}</span></div><div class="tab-settings-tabs"><button class="tab-settings-tab active" type="button">Основные</button></div><div class="settings-page-content"><div class="settings-section"><div class="settings-section-title">Основные</div>${rows}</div></div></div>`;
  el.querySelectorAll('.setting-pills').forEach(group => {
    group.querySelectorAll('.setting-pill').forEach(pill => pill.addEventListener('click', () => {
      group.querySelectorAll('.setting-pill').forEach(button => button.classList.toggle('active', button === pill));
      void saveTabSetting(group.dataset.tabId, group.dataset.settingKey, pill.dataset.value);
    }));
  });
}
