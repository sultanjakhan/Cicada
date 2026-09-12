import { S, invoke, TAB_ICONS } from './state.js';
import { escapeHtml } from './utils.js';

const renderRevisions = new WeakMap();
const DEFAULT_PANES = [
  { id: 'dash', label: 'Дашборд' },
  { id: 'table', label: 'Таблица' },
  { id: 'goals', label: 'Цели' },
  { id: 'notes', label: 'Заметки' },
];
const loadPaneState = () => {
  try { return JSON.parse(localStorage.getItem('hanni_panes') || '{}'); } catch { return {}; }
};
export function savePaneState(tabId, pane) {
  const state = loadPaneState(); state[tabId] = pane;
  localStorage.setItem('hanni_panes', JSON.stringify(state));
}
async function getTabMeta(tabId) {
  try { const value = await invoke('get_ui_state', { key: `tab_meta_${tabId}` }); return value ? JSON.parse(value) : {}; } catch { return {}; }
}
async function saveTabMeta(tabId, meta) {
  await invoke('set_ui_state', { key: `tab_meta_${tabId}`, value: JSON.stringify(meta) }).catch(() => {});
}
function beginHeaderEdit(node, initial, save) {
  if (node.contentEditable === 'true') return;
  node.contentEditable = 'true'; node.focus();
  const range = document.createRange(); range.selectNodeContents(node);
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  const finish = async () => { node.contentEditable = 'false'; await save(node.textContent.trim()); };
  node.addEventListener('blur', finish, { once: true });
  node.addEventListener('keydown', event => {
    if (event.key === 'Escape') { node.textContent = initial; node.blur(); }
    else if (event.key === 'Enter') { event.preventDefault(); node.blur(); }
  }, { once: true });
}
function wireHeaderEdit(el, tabId, config, meta, defaults, revision) {
  const name = el.querySelector('.uni-header-name');
  const desc = el.querySelector('.uni-header-desc');
  name?.addEventListener('click', () => beginHeaderEdit(name, meta.name || defaults.name, async value => {
    if (!value || value === (meta.name || defaults.name) || renderRevisions.get(el) !== revision) return;
    meta.name = value; await saveTabMeta(tabId, meta);
  }));
  desc?.addEventListener('click', () => {
    const current = meta.desc ?? defaults.desc ?? '';
    desc.innerHTML = escapeHtml(current);
    beginHeaderEdit(desc, current, async value => {
      if (renderRevisions.get(el) !== revision) return;
      meta.desc = value; await saveTabMeta(tabId, meta);
      if (!value) desc.innerHTML = '<span style="opacity:0.4">Добавить описание…</span>';
    });
  });
}
async function renderActivePane(pane, activePane, config) {
  const renderer = { dash: config.renderDash, table: config.renderTable, goals: config.renderGoals, notes: config.renderNotes }[activePane];
  if (renderer) await renderer(pane);
}

/** Calendar-only clipped upstream unified layout: original shell markup and four permitted panes. */
export async function renderUnifiedLayout(el, tabId, config = {}) {
  config.beforeRender?.();
  const revision = (renderRevisions.get(el) || 0) + 1;
  renderRevisions.set(el, revision);
  S._unifiedPane ||= {};
  const panes = config.panes || DEFAULT_PANES;
  let activePane = S._unifiedPane[tabId] || loadPaneState()[tabId] || panes[0].id;
  if (!panes.some(pane => pane.id === activePane)) activePane = panes[0].id;
  S._unifiedPane[tabId] = activePane;

  const defaults = { name: config.title || tabId, icon: config.headerIcon || TAB_ICONS[tabId] || '', desc: config.subtitle || '' };
  const meta = await getTabMeta(tabId);
  if (renderRevisions.get(el) !== revision || config.isCurrent?.() === false) return;
  const icon = config.headerIcon || meta.icon || defaults.icon;
  const name = meta.name || defaults.name;
  const desc = meta.desc ?? defaults.desc ?? '';
  const tabsHtml = panes.map(pane => {
    const count = config.counts?.[pane.id];
    const countHtml = count != null ? `<span class="uni-tab-count">(${count})</span>` : '';
    return `<button type="button" class="uni-tab${pane.id === activePane ? ' active' : ''}" data-pane="${pane.id}" aria-pressed="${pane.id === activePane}">${pane.label}${countHtml}</button>`;
  }).join('');
  const actionsHtml = (config.toolbarActions || []).map((action, index) => `<button type="button" class="uni-header-action" data-action-idx="${index}" title="${escapeHtml(action.title || '')}">${action.icon || ''}${action.label ? `<span>${escapeHtml(action.label)}</span>` : ''}</button>`).join('');
  el.innerHTML = `
    <div class="uni-header">
      <span class="uni-header-icon${config.headerIcon ? ' uni-header-icon--static' : ''}" ${config.headerIcon ? 'aria-hidden="true"' : 'title="Изменить иконку"'}>${icon}</span>
      <h1 class="uni-header-name" title="Изменить название">${escapeHtml(name)}</h1>
      ${config.hideDescription ? '' : `<div class="uni-header-desc" title="Изменить описание">${desc ? escapeHtml(desc) : '<span style="opacity:0.4">Добавить описание…</span>'}</div>`}
    </div>
    ${config.headerExtra || ''}
    <div class="uni-navigation"><div class="uni-tabs" aria-label="Разделы календаря">${tabsHtml}</div>${actionsHtml ? `<div class="uni-header-actions">${actionsHtml}</div>` : ''}</div>
    <div class="uni-content"><div class="uni-pane" id="uni-pane-${tabId}"></div></div>`;
  wireHeaderEdit(el, tabId, config, meta, defaults, revision);
  (config.toolbarActions || []).forEach((action, index) => el.querySelector(`[data-action-idx="${index}"]`)?.addEventListener('click', event => { event.stopPropagation(); action.onClick?.(event.currentTarget); }));
  el.querySelectorAll('.uni-tab').forEach(tab => tab.addEventListener('click', () => {
    S._unifiedPane[tabId] = tab.dataset.pane; savePaneState(tabId, tab.dataset.pane);
    void renderUnifiedLayout(el, tabId, config);
  }));
  config.renderHeaderExtra?.(el);
  const pane = el.querySelector(`#uni-pane-${tabId}`);
  await renderActivePane(pane, activePane, config);
  if (renderRevisions.get(el) !== revision || config.isCurrent?.() === false) return;
}
