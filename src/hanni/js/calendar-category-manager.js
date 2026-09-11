// calendar-category-manager.js — manage calendar event categories (rename,
// recolor, change icon, delete) and the "add category" modal.

import { invoke } from './state.js';
import { escapeHtml } from './utils.js';
import { loadCategories, invalidateCategoriesCache, CATEGORY_PALETTE } from './calendar-categories.js';
import { showEmojiPicker } from './emoji-picker.js';

// ── Add category ──
export function showAddCategory(onCreated) {
  let color = CATEGORY_PALETTE[0];
  let icon = '';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal modal-compact">
    <div class="modal-title">Новая категория</div>
    <div class="form-row"><input class="form-input" id="evm-new-name" placeholder="Название" autofocus></div>
    <div class="evm-cat-form-row">
      <span class="evm-label">Цвет</span>
      <div class="evm-palette">
        ${CATEGORY_PALETTE.map((c, i) => `<button type="button" class="evm-cat-swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
      </div>
    </div>
    <div class="evm-cat-form-row">
      <span class="evm-label">Иконка</span>
      <button type="button" class="btn-icon evm-icon-btn" id="evm-new-icon" title="Выбрать emoji">·</button>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="evm-new-cancel">Отмена</button>
      <button class="btn-primary" id="evm-new-save">Создать</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#evm-new-cancel')?.addEventListener('click', () => overlay.remove());

  overlay.querySelectorAll('.evm-palette .evm-cat-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.evm-palette .evm-cat-swatch').forEach(x => x.classList.remove('active'));
      sw.classList.add('active');
      color = sw.dataset.color;
    });
  });
  const iconBtn = overlay.querySelector('#evm-new-icon');
  iconBtn?.addEventListener('click', () => {
    showEmojiPicker(iconBtn, (emoji) => { icon = emoji; iconBtn.textContent = emoji || '·'; });
  });

  overlay.querySelector('#evm-new-save')?.addEventListener('click', async () => {
    const name = overlay.querySelector('#evm-new-name')?.value?.trim();
    if (!name) return;
    try {
      await invoke('create_event_category', { name, color, icon });
      invalidateCategoriesCache();
      overlay.remove();
      if (onCreated) onCreated(name);
    } catch (err) { alert('Ошибка: ' + err); }
  });
}

// ── Manage categories ──
function categoryRow(c) {
  const isGeneral = c.name === 'general';
  return `<div class="evm-cat-item" data-id="${c.id}" data-name="${escapeHtml(c.name)}">
    <button type="button" class="evm-cat-swatch" style="background:${escapeHtml(c.color)}" title="Цвет"></button>
    <input type="color" class="evm-cat-color-input" value="${escapeHtml(c.color)}" tabindex="-1">
    <button type="button" class="btn-icon evm-cat-icon-btn" title="Иконка">${escapeHtml(c.icon || '·')}</button>
    <input class="form-input evm-cat-name" value="${escapeHtml(c.name)}" ${isGeneral ? 'disabled' : ''}>
    <button type="button" class="btn-icon evm-cat-del" title="Удалить" ${isGeneral ? 'disabled' : ''}>🗑</button>
  </div>`;
}

export async function showCategoryManager(onChange) {
  const cats = await loadCategories(true);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal modal-compact">
    <div class="modal-title">Категории событий</div>
    <div class="evm-cat-list">${cats.map(categoryRow).join('')}</div>
    <div class="modal-actions">
      <button class="btn-secondary" id="evm-mgr-add">+ Добавить</button>
      <button class="btn-primary" id="evm-mgr-close">Закрыть</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const changed = () => { invalidateCategoriesCache(); if (onChange) onChange(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#evm-mgr-close')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#evm-mgr-add')?.addEventListener('click', () => {
    showAddCategory(() => {
      loadCategories(true).then(fresh => {
        const list = overlay.querySelector('.evm-cat-list');
        if (list) list.innerHTML = fresh.map(categoryRow).join('');
        bindRows();
        changed();
      });
    });
  });

  function bindRows() {
    overlay.querySelectorAll('.evm-cat-name').forEach(input => {
      input.addEventListener('change', async (e) => {
        const item = e.target.closest('.evm-cat-item');
        const id = String(item.dataset.id);
        const newName = e.target.value.trim();
        if (!newName || newName === item.dataset.name) return;
        try {
          await invoke('update_event_category', { id, name: newName, color: null, icon: null });
          item.dataset.name = newName;
          changed();
        } catch (err) { alert('Ошибка: ' + err); e.target.value = item.dataset.name; }
      });
    });
    overlay.querySelectorAll('.evm-cat-swatch').forEach(swatch => {
      const input = swatch.nextElementSibling;
      swatch.addEventListener('click', () => input?.click());
      input?.addEventListener('change', async () => {
        const item = input.closest('.evm-cat-item');
        const id = String(item.dataset.id);
        try {
          await invoke('update_event_category', { id, name: null, color: input.value, icon: null });
          swatch.style.background = input.value;
          changed();
        } catch (err) { alert('Ошибка: ' + err); }
      });
    });
    overlay.querySelectorAll('.evm-cat-icon-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.evm-cat-item');
        const id = String(item.dataset.id);
        showEmojiPicker(btn, async (emoji) => {
          try {
            await invoke('update_event_category', { id, name: null, color: null, icon: emoji });
            btn.textContent = emoji || '·';
            changed();
          } catch (err) { alert('Ошибка: ' + err); }
        });
      });
    });
    overlay.querySelectorAll('.evm-cat-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const item = e.target.closest('.evm-cat-item');
        const id = String(item.dataset.id);
        const name = item.dataset.name;
        if (!confirm(`Удалить категорию «${name}»? События переедут в «general».`)) return;
        try {
          await invoke('delete_event_category', { id, reassignTo: 'general' });
          item.remove();
          changed();
        } catch (err) { alert('Ошибка: ' + err); }
      });
    });
  }
  bindRows();
}