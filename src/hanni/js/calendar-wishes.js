// «Желания» list inside Goals (#85). Data rules live in calendar-wishes-store.js.
import { createCalendarDialog } from './calendar-dialog.js';
import { ICONS } from './icons.js';
import {
  WISHES_STATE_KEY, WISH_CATEGORIES, WISH_STATUSES, WISH_CURRENCIES, WISH_LIMITS, normalizeWishState, validateWishInput,
  createWish, updateWish, setWishStatus, deleteWish, markWishConverted, wishPriceLabel, wishCategoryLabel, wishStatusLabel, isOpenWish,
} from './calendar-wishes-store.js';

let nextInstance = 0;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const attr = value => String(value).replace(/["\\]/g, '\\$&');
const ORDER = { saving: 0, want: 1, bought: 2, dropped: 3 };

/**
 * Wishes list. Dependencies: invoke, mountMenu (context menu), getGoals()
 * (null until goals are loaded), openGoal(goal, returnFocus),
 * convertToGoal(wish, done(goalId), restoreFocus), openUrl(url), returnFocus().
 */
export function mountCalendarWishes(element, dependencies = {}) {
  const { invoke } = dependencies;
  const document = element.ownerDocument, window = document.defaultView;
  const prefix = `calendar-wishes-${++nextInstance}`;
  let disposed = false, revision = 0, wishes = null, failed = false, closedOpen = false, dialog = null, pendingConversion = null, busy = false;
  element.classList.add('cp-wishes');
  element.innerHTML = `<p class="cp-message" data-wish-message role="status" aria-live="polite"></p><button type="button" data-wish-retry hidden>Повторить</button><div class="cp-wish-list" data-wish-list aria-busy="true"></div>`;
  const list = element.querySelector('[data-wish-list]'), message = element.querySelector('[data-wish-message]'), retry = element.querySelector('[data-wish-retry]');
  const goalsById = () => { const goals = dependencies.getGoals?.(); return goals ? new Map(goals.map(goal => [String(goal.id), goal])) : null; };
  const findWish = id => wishes?.find(wish => wish.id === id);
  const fallbackFocus = () => { if (dependencies.returnFocus) dependencies.returnFocus(); else list.querySelector('button')?.focus(); };
  const focusRow = (id, selector = '[data-wish-edit]') => {
    const row = list.querySelector(`[data-wish-id="${attr(id)}"]`);
    const target = row?.querySelector(selector) || row?.querySelector('button');
    if (target) target.focus(); else fallbackFocus();
  };
  const say = (text, alert = false) => { message.textContent = text; message.setAttribute('role', alert ? 'alert' : 'status'); };

  function goalLabel(wish, goals) {
    if (!wish.goalId) return '';
    if (!goals) return 'Есть цель';
    const goal = goals.get(wish.goalId);
    return goal ? `Цель: ${goal.title}` : 'Цель удалена';
  }
  function row(wish, goals) {
    const item = document.createElement('li');
    item.className = `cp-wish-row cp-wish-row--${wish.status}`; item.dataset.wishId = wish.id; item.dataset.contextRecord = wish.id;
    const meta = [wishCategoryLabel(wish.category), wishPriceLabel(wish), goalLabel(wish, goals)].filter(Boolean);
    item.innerHTML = `<button type="button" class="cp-wish-row__open" data-wish-edit="${escapeHtml(wish.id)}" aria-haspopup="dialog"><span class="cp-wish-row__title">${escapeHtml(wish.title)}</span><span class="cp-wish-row__meta">${meta.map(escapeHtml).join(' · ')}</span>${wish.note ? `<span class="cp-wish-row__note">${escapeHtml(wish.note)}</span>` : ''}</button>
      <div class="cp-wish-row__actions">${wish.url ? `<button type="button" class="cp-wish-row__icon" data-wish-link="${escapeHtml(wish.id)}" aria-label="Открыть ссылку: ${escapeHtml(wish.title)}" title="${escapeHtml(wish.url)}"><span aria-hidden="true">${ICONS.externalLink}</span></button>` : ''}
      <label class="cp-wish-status"><span class="cp-sr">Статус: ${escapeHtml(wish.title)}</span><select data-wish-status="${escapeHtml(wish.id)}" ${busy ? 'disabled' : ''}>${WISH_STATUSES.map(([value, label]) => `<option value="${value}" ${value === wish.status ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <button type="button" class="cp-wish-row__more" data-record-menu data-wish-menu="${escapeHtml(wish.id)}" aria-label="Действия: ${escapeHtml(wish.title)}" aria-haspopup="menu" aria-expanded="false">⋯</button></div>`;
    return item;
  }
  function render() {
    if (disposed) return;
    list.setAttribute('aria-busy', String(wishes === null && !failed));
    retry.hidden = !failed;
    if (wishes === null) { list.replaceChildren(); return; }
    const focused = document.activeElement;
    const focusKey = list.contains(focused) ? Object.entries(focused.dataset).filter(([key]) => key.startsWith('wish')).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${attr(value)}"]`).join('') : '';
    list.replaceChildren();
    if (pendingConversion) {
      const notice = document.createElement('div'); notice.className = 'cp-wish-notice'; notice.setAttribute('role', 'alert');
      notice.innerHTML = '<p>Цель создана, но желание не отмечено как превращённое.</p><button type="button" data-wish-convert-retry>Повторить отметку</button>';
      list.append(notice);
    }
    if (!wishes.length) {
      const empty = document.createElement('div'); empty.className = 'cp-empty cp-wish-empty';
      empty.innerHTML = '<h3>Желаний пока нет</h3><p>Сохрани покупку, поездку или впечатление — без срока и без плана. Если понадобится накопить, желание можно превратить в цель.</p>';
      list.append(empty); return;
    }
    const goals = goalsById();
    const sorted = [...wishes].sort((a, b) => ORDER[a.status] - ORDER[b.status] || String(b.createdAt).localeCompare(String(a.createdAt)) || a.title.localeCompare(b.title, 'ru'));
    const open = sorted.filter(isOpenWish), closed = sorted.filter(wish => !isOpenWish(wish));
    if (open.length) {
      const openList = document.createElement('ul'); openList.className = 'cp-wish-rows'; openList.setAttribute('aria-label', 'Хочу и коплю');
      open.forEach(wish => openList.append(row(wish, goals)));
      list.append(openList);
    } else {
      const none = document.createElement('p'); none.className = 'cp-muted cp-wish-none'; none.textContent = 'Все желания исполнены или отложены.'; list.append(none);
    }
    if (closed.length) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'cp-wish-closed-toggle'; toggle.dataset.wishClosedToggle = '';
      toggle.setAttribute('aria-expanded', String(closedOpen)); toggle.setAttribute('aria-controls', `${prefix}-closed`);
      toggle.textContent = `${closedOpen ? 'Скрыть' : 'Показать'} куплено и передумал · ${closed.length}`;
      const closedList = document.createElement('ul'); closedList.className = 'cp-wish-rows cp-wish-rows--closed'; closedList.id = `${prefix}-closed`; closedList.hidden = !closedOpen;
      closed.forEach(wish => closedList.append(row(wish, goals)));
      list.append(toggle, closedList);
    }
    if (focusKey && !focused.isConnected) list.querySelector(focusKey)?.focus();
  }
  async function refresh(canCommit = null) {
    if (disposed || (canCommit && !canCommit())) return;
    const own = ++revision;
    if (wishes === null) say('Загружаем желания…');
    try {
      const raw = await invoke('get_ui_state', { key: WISHES_STATE_KEY });
      if (disposed || own !== revision || (canCommit && !canCommit())) return;
      wishes = normalizeWishState(raw).wishes; failed = false;
      if (message.textContent === 'Загружаем желания…' || message.getAttribute('role') === 'alert') say('');
    } catch (cause) {
      if (disposed || own !== revision) return;
      failed = true; say(cause?.message?.startsWith('Неподдерживаемый') ? cause.message : 'Не удалось загрузить желания. Сохранённые желания остаются на месте.', true);
    }
    render();
  }
  function openForm(wish = null) {
    if (dialog || disposed) return null;
    const editor = createCalendarDialog({ document, title: wish ? 'Изменить желание' : 'Новое желание', hint: 'Желание — одно действие без плана. Цену и ссылку можно добавить позже.', submitLabel: 'Сохранить',
      isCurrent: () => !disposed && element.isConnected, returnFocus: () => wish && findWish(wish.id) ? focusRow(wish.id) : fallbackFocus(), onClose: () => { dialog = null; } });
    dialog = editor; editor.modal.dataset.wishForm = '';
    const id = `${prefix}-form`;
    editor.body.innerHTML = `<div class="calendar-goal-fields cp-wish-fields">
      <label class="calendar-editor-field" for="${id}-title">Что хочется?<input id="${id}-title" name="title" required maxlength="${WISH_LIMITS.title}" autocomplete="off" placeholder="Например, новые кроссовки"></label>
      <label class="calendar-editor-field" for="${id}-category">Категория<select id="${id}-category" name="category">${WISH_CATEGORIES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <div class="cp-wish-price"><label class="calendar-editor-field" for="${id}-price">Цена · необязательно<input id="${id}-price" name="price" inputmode="decimal" autocomplete="off" placeholder="Например, 45 000"></label>
      <label class="calendar-editor-field" for="${id}-currency">Валюта<select id="${id}-currency" name="currency">${WISH_CURRENCIES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div>
      <label class="calendar-editor-field" for="${id}-url">Ссылка · необязательно<input id="${id}-url" name="url" type="url" inputmode="url" maxlength="${WISH_LIMITS.url}" autocomplete="off" placeholder="https://"></label>
      <label class="calendar-editor-field" for="${id}-status">Статус<select id="${id}-status" name="status">${WISH_STATUSES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <label class="calendar-editor-field" for="${id}-note">Заметка · необязательно<textarea id="${id}-note" name="note" maxlength="${WISH_LIMITS.note}" rows="3" placeholder="Размер, цвет, где видел"></textarea></label></div>`;
    const fields = editor.form.elements;
    fields.title.value = wish?.title || ''; fields.category.value = wish?.category || 'other'; fields.price.value = wish?.price ?? '';
    fields.currency.value = wish?.currency || 'KZT'; fields.url.value = wish?.url || ''; fields.status.value = wish?.status || 'want'; fields.note.value = wish?.note || '';
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); if (editor.pending || disposed) return;
      editor.showError('');
      const input = { title: fields.title.value, category: fields.category.value, price: fields.price.value, currency: fields.currency.value, url: fields.url.value, status: fields.status.value, note: fields.note.value };
      try { validateWishInput(input); }
      catch (cause) { editor.showError(cause.message, cause.field ? fields[cause.field] : null); return; }
      editor.setPending(true);
      try {
        const saved = wish ? await updateWish(wish.id, input, { invoke, original: wish }) : await createWish(input, { invoke });
        editor.setPending(false); editor.close();
        if (!disposed) { await refresh(); say(wish ? 'Желание сохранено.' : 'Желание добавлено.'); focusRow(saved.id); }
      } catch (cause) { if (!disposed && editor.modal.isConnected) { editor.setPending(false); editor.showError(cause?.message || 'Не удалось сохранить желание. Текст остался в форме — попробуй ещё раз.'); } }
    });
    editor.open(fields.title);
    return editor;
  }
  function confirmDelete(wish, restore) {
    if (dialog || disposed) return;
    const editor = createCalendarDialog({ document, title: 'Удалить желание?', hint: wish.goalId ? 'Созданная из него цель останется.' : 'Желание исчезнет со всех устройств.', submitLabel: 'Удалить', isCurrent: () => !disposed && element.isConnected,
      returnFocus: () => (findWish(wish.id) ? restore?.() : fallbackFocus()), onClose: () => { dialog = null; } });
    dialog = editor; editor.modal.dataset.wishDelete = ''; editor.body.textContent = wish.title;
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); if (editor.pending || disposed) return;
      editor.showError(''); editor.setPending(true);
      try { await deleteWish(wish.id, { invoke }); editor.setPending(false); await refresh(); editor.close(); if (!disposed) say('Желание удалено.'); }
      catch (cause) { if (!disposed && editor.modal.isConnected) { editor.setPending(false); editor.showError(cause?.message || 'Не удалось удалить желание. Попробуй ещё раз.'); } }
    });
    editor.open(editor.modal.querySelector('[data-dialog-close]'));
  }
  async function markConverted(wishId, goalId) {
    pendingConversion = { wishId, goalId };
    try {
      await markWishConverted(wishId, goalId, { invoke }); pendingConversion = null;
      if (!disposed) { await refresh(); say('Цель создана. Желание осталось в списке со ссылкой на неё.'); focusRow(wishId); }
    } catch (cause) { if (!disposed) { render(); say(cause?.message || 'Не удалось отметить желание.', true); } }
  }
  function convert(wish) {
    if (!dependencies.convertToGoal || disposed) return;
    dependencies.convertToGoal(wish, goalId => markConverted(wish.id, goalId), () => focusRow(wish.id, '[data-wish-menu]'));
  }
  async function openLink(wish) {
    if (!wish?.url) return;
    try { await (dependencies.openUrl ? dependencies.openUrl(wish.url) : invoke('open_url', { url: wish.url })); }
    catch {
      let copied = false;
      try { await window.navigator.clipboard.writeText(wish.url); copied = true; } catch { /* Clipboard may be unavailable. */ }
      say(copied ? 'Не удалось открыть ссылку — она скопирована в буфер обмена.' : `Не удалось открыть ссылку: ${wish.url}`, true);
    }
  }
  async function changeStatus(select) {
    const wish = findWish(select.dataset.wishStatus); if (!wish || busy) return;
    const next = select.value; if (next === wish.status) return;
    busy = true; select.disabled = true;
    try { await setWishStatus(wish.id, next, { invoke }); await refresh(); say(`«${wish.title}»: ${wishStatusLabel(next).toLowerCase()}.`); }
    catch (cause) { select.value = wish.status; say(cause?.message || 'Не удалось сменить статус. Повтори.', true); }
    finally {
      busy = false;
      if (!disposed) {
        // A wish that became bought or dropped moves into the closed history; open it so focus can follow.
        if (!isOpenWish({ status: next }) && findWish(wish.id)?.status === next) closedOpen = true;
        render(); list.querySelector(`[data-wish-status="${attr(wish.id)}"]`)?.focus();
      }
    }
  }
  const onClick = event => {
    const button = event.target.closest('button'); if (!button || !element.contains(button) || button.disabled) return;
    if (button === retry) { void refresh(); return; }
    if ('wishClosedToggle' in button.dataset) { closedOpen = !closedOpen; render(); list.querySelector('[data-wish-closed-toggle]')?.focus(); return; }
    if ('wishConvertRetry' in button.dataset && pendingConversion) { void markConverted(pendingConversion.wishId, pendingConversion.goalId); return; }
    if (button.dataset.wishEdit) { const wish = findWish(button.dataset.wishEdit); if (wish) openForm(wish); return; }
    if (button.dataset.wishLink) void openLink(findWish(button.dataset.wishLink));
  };
  const onChange = event => { if (event.target.matches?.('[data-wish-status]')) void changeStatus(event.target); };
  element.addEventListener('click', onClick); element.addEventListener('change', onChange);
  const disposeMenu = dependencies.mountMenu?.(list, {
    getRecord: item => findWish(item.dataset.contextRecord),
    restoreFocus: item => focusRow(item.dataset.contextRecord, '[data-wish-menu]'),
    getActions: wish => {
      const goals = goalsById(), goal = wish.goalId ? goals?.get(wish.goalId) : null;
      // A wish converts once; only a deleted goal (known after goals load) allows another conversion.
      const convertible = !wish.goalId || (goals && !goal);
      const actions = [{ id: 'edit', label: 'Изменить', dialog: true, run: () => openForm(wish) }];
      if (wish.url) actions.push({ id: 'link', label: 'Открыть ссылку', run: async restore => { await openLink(wish); restore(); } });
      if (goal && dependencies.openGoal) actions.push({ id: 'goal', label: 'Открыть цель', dialog: true, run: restore => dependencies.openGoal(goal, restore) });
      else if (convertible && dependencies.convertToGoal && isOpenWish(wish)) actions.push({ id: 'convert', label: 'Превратить в цель', dialog: true, run: () => convert(wish) });
      actions.push({ id: 'delete', label: 'Удалить', dialog: true, run: restore => confirmDelete(wish, restore) });
      return actions;
    },
  });
  // Local wish writes and remote sync change the list; goal renames arrive through render().
  const onExternal = event => {
    if (dialog || busy || (event.type === 'hanni:calendar-refresh' && !event.detail?.remoteSync)) return;
    void refresh(event.detail?.remoteSync ? event.detail.canCommit : null);
  };
  window.addEventListener('hanni:wishes-changed', onExternal);
  window.addEventListener('hanni:calendar-refresh', onExternal);
  const ready = refresh();
  return {
    ready, refresh, openCreate: () => openForm(null), render,
    dispose() { disposed = true; revision++; dialog?.dispose(); disposeMenu?.(); element.removeEventListener('click', onClick); element.removeEventListener('change', onChange); window.removeEventListener('hanni:wishes-changed', onExternal); window.removeEventListener('hanni:calendar-refresh', onExternal); element.replaceChildren(); },
  };
}
