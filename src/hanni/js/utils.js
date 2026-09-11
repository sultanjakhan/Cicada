// ── js/utils.js — Shared utilities, Markdown, skeletons, helpers ──

import { invoke, S, TAB_REGISTRY, TAB_ICONS, TAB_SETTINGS_DEFS, saveTabCustom, getTabIcon, getTabDesc, loadTabSetting, saveTabSetting, tabLoaders } from '../../state.js';
import { showEmojiPicker } from './emoji-picker.js';
import { sanitizeMarkdownHtml } from './markdown-security.js';

// ── Markdown rendering setup ──
const markedInstance = new marked.Marked({
  breaks: true,
  gfm: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});
markedInstance.use({
  renderer: {
    code({ text, lang }) {
      const highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
      const langLabel = escapeHtml(lang || 'code');
      return `<div class="code-block"><div class="code-header"><span>${langLabel}</span><button class="code-copy-btn" type="button">Копировать</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
    link({ href, text }) {
      return `<a href="#" class="md-link" data-href="${escapeHtml(href)}">${text}</a>`;
    },
    // Marked deliberately preserves raw HTML. Hanni renders model and synced
    // chat content inside a privileged Tauri WebView, so raw HTML is data, not
    // markup. The DOMPurify pass below remains the final defense in depth.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function sanitizeRenderedHtml(html, sourceFallback = '') {
  return sanitizeMarkdownHtml(html, sourceFallback, window.DOMPurify);
}

export function renderMarkdown(text) {
  const source = text || '';
  return sanitizeRenderedHtml(markedInstance.parse(source), source);
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// UUIDv7 — time-ordered 128-bit id, lexicographically sortable. Used as
// primary key on sync-eligible tables that used to rely on integer
// auto-increment so two devices generating rows in parallel never
// collide. Format: 48-bit unix-ms timestamp + 4-bit version + 12-bit
// random + 2-bit variant + 62-bit random. Spec: RFC 9562 §5.7.
export function uuidV7() {
  const ms = BigInt(Date.now());
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  // bytes 0..5: timestamp (big-endian)
  const b = new Uint8Array(16);
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n)  & 0xffn);
  b[5] = Number( ms         & 0xffn);
  // byte 6: version (0111) in high nibble + 4 random bits
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  // byte 8: variant (10) in top 2 bits + 6 random bits
  b[8] = 0x80 | (rand[2] & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rand[i - 6];
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Local YYYY-MM-DD, optionally offset by N days (negative = past).
export function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Minimal escape for HTML attribute values (quotes + opening tag).
export function escAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Filter-chip buttons (.rf-chip). filterAll drops the synthetic "all" option.
export function chips(items, cur, group, filterAll = false) {
  const list = filterAll ? items.filter(o => o.id !== 'all') : items;
  return list.map(o =>
    `<button class="rf-chip${cur === o.id ? ' active' : ''}" data-group="${escapeHtml(group)}" data-val="${escapeHtml(String(o.id))}">${escapeHtml(String(o.label))}</button>`
  ).join('');
}

// ── Skeleton loaders ──

export function skeletonSettings(rows = 3) {
  let html = '<div class="skeleton-card">';
  html += '<div class="skeleton skeleton-header"></div>';
  for (let i = 0; i < rows; i++) {
    html += `<div class="skeleton-row"><div class="skeleton skeleton-line w-1-4"></div><div class="skeleton skeleton-line w-1-4"></div></div>`;
  }
  html += '</div>';
  return html;
}

export function skeletonGrid(cols = 4) {
  let html = '<div style="display:grid;grid-template-columns:repeat(' + cols + ',1fr);gap:10px;margin-bottom:20px;">';
  for (let i = 0; i < cols; i++) {
    html += '<div class="skeleton-stat"><div class="skeleton skeleton-line w-1-2" style="margin:0 auto 6px;height:20px;"></div><div class="skeleton skeleton-line w-3-4" style="margin:0 auto;height:10px;"></div></div>';
  }
  html += '</div>';
  return html;
}

export function skeletonList(items = 5) {
  let html = '';
  for (let i = 0; i < items; i++) {
    const w = i % 3 === 0 ? 'w-3-4' : i % 3 === 1 ? 'w-full' : 'w-1-2';
    html += `<div class="skeleton skeleton-line ${w}"></div>`;
  }
  return html;
}

export function skeletonPage() {
  return skeletonGrid(4) + skeletonSettings(3) + skeletonSettings(2);
}

// ── Confirm modal ──

export function confirmModal(msg = 'Удалить?', confirmLabel = 'Да') {
  return new Promise(resolve => {
    document.querySelectorAll('.col-context-menu').forEach(m => m.remove());
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal modal-compact" style="max-width:320px;text-align:center;">
      <div class="modal-title">${escapeHtml(msg)}</div>
      <div class="modal-actions">
        <button class="btn-secondary confirm-no">Отмена</button>
        <button class="btn-primary confirm-yes" style="background:var(--color-red)">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-no').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.confirm-yes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// ── Toast ──
// Transient bottom notification. Replaces alert() for action feedback so a
// failed/successful operation no longer blocks the UI thread.
let _toastWrap = null;
export function toast(msg, type = 'error') {
  if (!_toastWrap) {
    _toastWrap = document.createElement('div');
    _toastWrap.className = 'hanni-toast-wrap';
    document.body.appendChild(_toastWrap);
  }
  const el = document.createElement('div');
  el.className = `hanni-toast hanni-toast-${type}`;
  el.textContent = msg;
  _toastWrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 3000);
}

// ── Empty state ──
// Consistent "nothing here yet" block: icon (raw SVG) + title + hint + optional
// action button. Pass actionId to wire a click handler after insertion.
export function emptyState({ icon = '', title = '', hint = '', actionLabel = '', actionId = '' } = {}) {
  return `<div class="hanni-empty">
    ${icon ? `<div class="hanni-empty-icon">${icon}</div>` : ''}
    <div class="hanni-empty-title">${escapeHtml(title)}</div>
    ${hint ? `<div class="hanni-empty-hint">${escapeHtml(hint)}</div>` : ''}
    ${actionLabel ? `<button class="hanni-empty-action"${actionId ? ` id="${actionId}"` : ''}>${escapeHtml(actionLabel)}</button>` : ''}
  </div>`;
}

// ── History message helpers ──

export function normalizeHistoryMessage(msg) {
  if (Array.isArray(msg)) {
    return { role: msg[0], content: msg[1] };
  }
  if (msg.proactive) {
    const { proactive, ...rest } = msg;
    return rest;
  }
  return msg;
}

export function getRole(msg) {
  if (Array.isArray(msg)) return msg[0];
  return msg.role;
}

export function getContent(msg) {
  if (Array.isArray(msg)) return msg[1];
  return msg.content || '';
}

// ── Page header ──

export function renderPageHeader(tabId, extra) {
  const reg = TAB_REGISTRY[tabId];
  if (!reg) return '';
  const icon = getTabIcon(tabId);
  const iconHtml = TAB_ICONS[tabId]
    ? `<span class="page-header-icon-static" aria-hidden="true">${icon}</span>`
    : `<button class="page-header-icon-btn${icon.startsWith('<svg') ? ' page-header-icon-svg' : ''}" data-tab-id="${tabId}" title="Сменить иконку">${icon}</button>`;
  const desc = extra?.description || getTabDesc(tabId);
  const props = extra?.properties || [];
  return `<div class="page-header" data-tab-id="${tabId}">
    ${iconHtml}
    <div class="page-header-title">${extra?.title || reg.label}</div>
    <input class="page-header-desc-input" data-tab-id="${tabId}" value="${escapeHtml(desc)}" placeholder="Добавить описание...">
    ${props.length ? `<div class="page-header-properties">${props.map(p =>
      `<span class="page-property"><span class="page-property-label">${p.label}</span><span class="page-property-value ${p.class || ''}">${p.value}</span></span>`
    ).join('')}</div>` : ''}
  </div>`;
}

export function setupPageHeaderControls(tabId) {
  const iconBtn = document.querySelector(`.page-header-icon-btn[data-tab-id="${tabId}"]`);
  if (iconBtn) {
    iconBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showEmojiPicker(iconBtn, (emoji) => {
        if (!S.tabCustomizations[tabId]) S.tabCustomizations[tabId] = {};
        S.tabCustomizations[tabId].icon = emoji;
        saveTabCustom();
        iconBtn.textContent = emoji;
        iconBtn.classList.remove('page-header-icon-svg');
        tabLoaders._renderTabBar?.();
      });
    });
  }

  const descInput = document.querySelector(`.page-header-desc-input[data-tab-id="${tabId}"]`);
  if (descInput) {
    descInput.addEventListener('input', () => {
      if (!S.tabCustomizations[tabId]) S.tabCustomizations[tabId] = {};
      S.tabCustomizations[tabId].desc = descInput.value;
      saveTabCustom();
    });
  }
}

// ── Tab settings ──
// loadTabSetting / saveTabSetting are imported from state.js (canonical location)

export async function renderTabSettingsPage(tabId) {
  const reg = TAB_REGISTRY[tabId];
  const el = document.getElementById(`${tabId}-content`);
  if (!el || !reg) return;
  const defs = TAB_SETTINGS_DEFS[tabId] || [];

  let rowsHtml = '';
  for (const def of defs) {
    const val = await loadTabSetting(tabId, def.key) ?? def.default;
    let controlHtml = '';
    if (def.type === 'toggle') {
      controlHtml = `<label class="toggle"><input type="checkbox" data-tab-id="${tabId}" data-setting-key="${def.key}" ${val === 'true' ? 'checked' : ''}><span class="toggle-track"></span></label>`;
    } else if (def.type === 'select') {
      controlHtml = `<div class="setting-pills" data-tab-id="${tabId}" data-setting-key="${def.key}">` +
        def.options.map(o => `<button class="setting-pill${val === o.value ? ' active' : ''}" data-value="${o.value}">${o.label}</button>`).join('') + `</div>`;
    } else if (def.type === 'number') {
      controlHtml = `<input class="form-input" type="number" min="${def.min || 1}" max="${def.max || 480}" step="1" data-tab-id="${tabId}" data-setting-key="${def.key}" value="${escapeHtml(val)}" style="width:100px;">`;
    } else {
      controlHtml = `<input class="form-input" type="text" data-tab-id="${tabId}" data-setting-key="${def.key}" value="${escapeHtml(val)}">`;
    }
    rowsHtml += `<div class="settings-row"><span class="settings-label">${def.label}</span><span class="settings-value">${controlHtml}</span></div>`;
  }

  el.innerHTML = renderPageHeader(tabId) + `<div class="page-content">
    <div class="settings-section">
      <div class="settings-section-title">Настройки — ${reg.label}</div>
      ${rowsHtml || '<div style="color:var(--text-muted);font-size:13px;">Нет настроек для этой вкладки</div>'}
    </div>
  </div>`;
  setupPageHeaderControls(tabId);

  el.querySelectorAll('input[data-setting-key], select[data-setting-key]').forEach(ctrl => {
    ctrl.addEventListener('change', () => {
      const v = ctrl.type === 'checkbox' ? ctrl.checked : ctrl.value;
      saveTabSetting(ctrl.dataset.tabId, ctrl.dataset.settingKey, v);
    });
  });

  el.querySelectorAll('.setting-pills').forEach(group => {
    group.querySelectorAll('.setting-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        group.querySelectorAll('.setting-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        saveTabSetting(group.dataset.tabId, group.dataset.settingKey, pill.dataset.value);
      });
    });
  });
}

// ── Editor.js block editor helpers ──

export function initBlockEditor(holderId, data, onChange, opts = {}) {
  const { customTools = {}, readOnly = false, placeholder } = opts;
  const baseTools = {
    header: { class: Header, config: { levels: [1, 2, 3], defaultLevel: 2 } },
    list: { class: EditorjsList, inlineToolbar: true },
    checklist: { class: Checklist, inlineToolbar: true },
    quote: { class: Quote },
    code: CodeTool,
    delimiter: Delimiter,
    marker: { class: Marker },
    inlineCode: { class: InlineCode },
  };
  const editor = new EditorJS({
    holder: holderId,
    data: data || { blocks: [] },
    placeholder: placeholder || 'Нажмите / для команд или начните писать...',
    readOnly,
    tools: { ...baseTools, ...customTools },
    onChange: async (api) => {
      if (readOnly) return;
      const output = await api.saver.save();
      if (onChange) onChange(output);
    },
    onReady: () => {
      if (!readOnly && window.DragDrop) new DragDrop(editor);
    },
  });
  return editor;
}

// ── Tab block editor (shared for all tabs) ──

let _tabBlockSaveTimeouts = {};

export async function loadTabBlockEditor(tabId, subTab, contentEl, defaultBlocks) {
  const key = `${tabId}::${subTab || ''}`;
  const holderId = `tab-block-${tabId}-${(subTab || 'main').replace(/\s+/g, '-')}`;

  // Create holder div
  let holderEl = contentEl.querySelector(`#${holderId}`);
  if (!holderEl) {
    holderEl = document.createElement('div');
    holderEl.id = holderId;
    holderEl.className = 'tab-block-editor';
    contentEl.appendChild(holderEl);
  } else {
    holderEl.innerHTML = '';
  }

  // Load saved blocks from DB
  let data = null;
  try {
    const json = await invoke('get_tab_blocks', { tabId, subTab: subTab || '' });
    if (json) data = JSON.parse(json);
  } catch (_) {}

  if (!data) data = defaultBlocks || { blocks: [{ type: 'paragraph', data: { text: '' } }] };

  // Init editor with auto-save (500ms debounce)
  const editor = initBlockEditor(holderId, data, (output) => {
    clearTimeout(_tabBlockSaveTimeouts[key]);
    _tabBlockSaveTimeouts[key] = setTimeout(() => {
      invoke('save_tab_blocks', {
        tabId,
        subTab: subTab || '',
        blocksJson: JSON.stringify(output),
      }).catch(() => {});
    }, 500);
  }, { placeholder: 'Нажмите / для команд или начните писать...' });

  return editor;
}

export function blocksToPlainText(data) {
  return (data?.blocks || []).map(b => {
    if (b.type === 'checklist') return (b.data.items || []).map(i => i.text).join('\n');
    if (b.type === 'list') {
      const extractItems = (items) => (items || []).map(i => typeof i === 'string' ? i : i.content || i.text || '').join('\n');
      return extractItems(b.data.items);
    }
    return b.data?.text || '';
  }).join('\n');
}

export function migrateTextToBlocks(text) {
  if (!text) return { blocks: [] };
  return {
    blocks: text.split('\n\n').filter(Boolean).map(p => ({
      type: 'paragraph',
      data: { text: p.replace(/\n/g, '<br>') }
    }))
  };
}

// Delegated click handler for markdown links (safe — no inline onclick)
document.addEventListener('click', (e) => {
  const modalDismiss = e.target.closest('[data-dismiss-modal]');
  if (modalDismiss) {
    modalDismiss.closest('.modal-overlay')?.remove();
    return;
  }
  const copy = e.target.closest('.code-copy-btn');
  if (copy) {
    const code = copy.closest('.code-block')?.querySelector('code')?.textContent || '';
    navigator.clipboard.writeText(code).catch(() => {});
    return;
  }
  const link = e.target.closest('.md-link');
  if (link) {
    e.preventDefault();
    const url = link.dataset.href;
    if (url) invoke('open_url', { url });
    return;
  }
  const external = e.target.closest('[data-open-url]');
  if (external) {
    e.preventDefault();
    const url = external.dataset.openUrl;
    if (url) invoke('open_url', { url });
  }
});