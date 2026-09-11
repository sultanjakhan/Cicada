import { S, TAB_ICONS } from './state.js';
import { escapeHtml } from './utils.js';
const defaultPanes = [{id:'dash', label:'Дашборд'}, {id:'table',label:'Таблица'}, {id:'goals',label:'Цели'}, {id:'notes',label:'Заметки'}];
const load = () => { try { return JSON.parse(localStorage.getItem('hanni_mvp_panes') || '{}'); } catch { return {}; } };
export function savePaneState(tabId, pane) { const state=load(); state[tabId]=pane; localStorage.setItem('hanni_mvp_panes', JSON.stringify(state)); }
export async function renderUnifiedLayout(el, tabId, config) {
  config.beforeRender?.(); S._unifiedPane ||= {}; const panes=config.panes || defaultPanes; let active=S._unifiedPane[tabId] || load()[tabId] || panes[0].id;
  if (!panes.some(p => p.id === active)) active=panes[0].id; S._unifiedPane[tabId]=active;
  el.innerHTML=`<div class="uni-header"><span class="uni-header-icon uni-header-icon--static" aria-hidden="true">${config.headerIcon || TAB_ICONS?.[tabId] || '🗓️'}</span><span class="uni-header-name">${escapeHtml(config.title || 'Календарь')}</span><div class="uni-header-desc">${escapeHtml(config.subtitle || '')}</div></div><div class="uni-tabs">${panes.map(p=>`<button type="button" class="uni-tab${p.id===active?' active':''}" data-pane="${p.id}" aria-pressed="${p.id===active}">${p.label}</button>`).join('')}</div><div class="uni-content"><div class="uni-pane" id="uni-pane-${tabId}"></div></div>`;
  el.querySelectorAll('.uni-tab').forEach(button => button.addEventListener('click', () => { S._unifiedPane[tabId]=button.dataset.pane; savePaneState(tabId, button.dataset.pane); void renderUnifiedLayout(el,tabId,config); }));
  const pane=el.querySelector(`#uni-pane-${tabId}`); const render={dash:config.renderDash,table:config.renderTable,goals:config.renderGoals,notes:config.renderNotes}[active]; if (render) await render(pane);
}
