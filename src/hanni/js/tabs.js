// Original sidebar markup, restricted to the single Calendar project.
import { S, TAB_ICONS, TAB_REGISTRY, getTabIcon, IS_MOBILE, tabLoaders } from './state.js';
export function renderTabBar() {
  const tabList = document.getElementById('tab-list');
  tabList.replaceChildren();
  const item = document.createElement('div');
  item.className = 'tab-item active';
  item.dataset.tabId = 'calendar';
  item.title = TAB_REGISTRY.calendar.label;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
  item.setAttribute('aria-label', item.title);
  item.innerHTML = '<span class="tab-item-icon">' + getTabIcon('calendar') + '</span>' + (IS_MOBILE ? '<span class="tab-item-label">Календарь</span>' : '');
  const select = () => { document.getElementById('tab-bar').classList.remove('drawer-open'); tabLoaders.calendar?.(); };
  item.addEventListener('click', select);
  item.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
  tabList.appendChild(item);
  const bottom = document.getElementById('tab-bar-bottom');
  bottom.replaceChildren();
  const gear = document.createElement('div');
  gear.className = 'tab-item';
  gear.title = 'Настройки';
  gear.setAttribute('role', 'button');
  gear.setAttribute('aria-label', gear.title);
  gear.tabIndex = 0;
  gear.innerHTML = '<span class="tab-item-icon">' + TAB_ICONS.settings + '</span>';
  const settings = () => document.dispatchEvent(new Event('hanni:settings'));
  gear.addEventListener('click', settings);
  gear.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); settings(); } });
  const version = document.createElement('div');
  version.className = 'version-label-bar';
  version.textContent = 'v' + S.APP_VERSION;
  bottom.append(gear, version);
}
