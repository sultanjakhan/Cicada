// Record types of the shared «Создать» dialog (#97). Task and Event use the
// scheduling editor in calendar-event-modal.js. Every other type owns a small
// field panel and saves through an existing native command.
//
// Extension point: add one entry to CREATE_TYPES. The dialog renders its button
// in this order, shows
// only its panel, reuses the shared title field and calls `save` on Enter or
// the primary button.
//   id, label           — stable key and button text
//   heading, hint       — dialog heading and short explanation
//   submitLabel         — primary button text
//   titleLabel, titlePlaceholder — shared title field
//   titleRequired       — message when the title is empty; '' makes it optional
//   panel(doc)          — returns the element with the type's own fields
//   validate?(panel, title) — { message, field } to stop saving, else null
//   save(panel, { invoke, title }) — persists; a rejection keeps the form open
//   saved?(window)      — extra notifications after a successful save
import { escapeHtml } from './utils.js';
import { createWish, validateWishInput, WISH_CATEGORIES, WISH_STATUSES, WISH_CURRENCIES, WISH_LIMITS } from './calendar-wishes-store.js';

export const SCHEDULE_TYPES = Object.freeze(['task', 'event']);

function panelOf(doc, html) {
  const wrap = doc.createElement('div');
  wrap.className = 'evm-create-panel';
  wrap.innerHTML = html;
  return wrap;
}
const tooLong = (panel, title, message) => title.length > 500 ? { message, field: panel.ownerDocument.querySelector('#evm-title') } : null;

// Same command and defaults as «Новая цель» in Goals; deadline, stages and
// skills stay in the full goal editor.
const goalType = {
  id: 'goal', label: 'Цель', heading: 'Новая цель', submitLabel: 'Создать цель',
  hint: 'Срок, этапы и навыки можно добавить позже в «Целях».',
  titleLabel: 'Название', titlePlaceholder: 'Например, выучить испанский до B1', titleRequired: 'Напиши, к чему хочешь прийти.',
  panel(doc) {
    return panelOf(doc, `<label class="evm-field" for="evm-goal-description"><span class="evm-field-label">Коротко о цели · необязательно</span>
      <textarea class="form-textarea" id="evm-goal-description" rows="3" maxlength="10000" placeholder="Что изменится, когда цель будет достигнута?"></textarea></label>`);
  },
  validate: (panel, title) => tooLong(panel, title, 'Сократи название цели до 500 символов.'),
  save(panel, { invoke, title }) {
    return invoke('save_calendar_goal', { id: null, title, targetValue: 1, unit: '', deadline: null, goalKind: 'goal',
      description: panel.querySelector('#evm-goal-description').value.trim(), criteria: '',
      parentGoalId: null, clearParent: false, currentValue: null });
  },
};

// Same command, fallback title and tags as the Notes pane.
const noteType = {
  id: 'note', label: 'Заметка', heading: 'Новая заметка', submitLabel: 'Создать заметку',
  hint: 'Мысль или детали на потом. Без названия возьмём первую строку текста.',
  titleLabel: 'Название · необязательно', titlePlaceholder: 'О чём эта заметка?', titleRequired: '',
  panel(doc) {
    return panelOf(doc, `<label class="evm-field" for="evm-note-text"><span class="evm-field-label">Текст</span>
      <textarea class="form-textarea" id="evm-note-text" rows="6" placeholder="Идея, наблюдение или детали на потом…"></textarea></label>`);
  },
  validate(panel, title) {
    const text = panel.querySelector('#evm-note-text');
    if (!title && !text.value.trim()) return { message: 'Добавь мысль или название заметки.', field: text };
    return tooLong(panel, title, 'Сократи название до 500 символов.');
  },
  save(panel, { invoke, title }) {
    const content = panel.querySelector('#evm-note-text').value;
    return invoke('create_note', { title: title || content.trim().split('\n')[0].slice(0, 100), content, tags: '', tabName: 'calendar', status: 'note', dueDate: null, reminderAt: null, priority: null });
  },
  saved(win) { win.dispatchEvent(new win.CustomEvent('hanni:calendar-notes-changed')); },
};

// Wishes remain in their existing synced store (#85); the shared Create modal
// is another entry point to that same model, not a parallel record type.
const wishType = {
  id: 'wish', label: 'Желание', heading: 'Новое желание', submitLabel: 'Сохранить желание',
  hint: 'Покупка, поездка или впечатление — без плана. Цену и ссылку можно добавить позже.',
  titleLabel: 'Что хочется?', titlePlaceholder: 'Например, новые кроссовки', titleRequired: 'Напиши, чего хочется.',
  panel(doc) {
    return panelOf(doc, `<label class="evm-field" for="evm-wish-category"><span class="evm-field-label">Категория</span><select class="form-select" id="evm-wish-category">${WISH_CATEGORIES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select></label>
      <div class="evm-wish-price"><label class="evm-field" for="evm-wish-price"><span class="evm-field-label">Цена · необязательно</span><input class="form-input" id="evm-wish-price" inputmode="decimal" placeholder="Например, 45 000"></label>
      <label class="evm-field" for="evm-wish-currency"><span class="evm-field-label">Валюта</span><select class="form-select" id="evm-wish-currency">${WISH_CURRENCIES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select></label></div>
      <label class="evm-field" for="evm-wish-url"><span class="evm-field-label">Ссылка · необязательно</span><input class="form-input" id="evm-wish-url" type="url" inputmode="url" maxlength="${WISH_LIMITS.url}" placeholder="https://"></label>
      <label class="evm-field" for="evm-wish-status"><span class="evm-field-label">Статус</span><select class="form-select" id="evm-wish-status">${WISH_STATUSES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}</select></label>
      <label class="evm-field" for="evm-wish-note"><span class="evm-field-label">Заметка · необязательно</span><textarea class="form-textarea" id="evm-wish-note" maxlength="${WISH_LIMITS.note}" rows="3" placeholder="Размер, цвет, где видел"></textarea></label>`);
  },
  input(panel, title) { return { title, category: panel.querySelector('#evm-wish-category').value, price: panel.querySelector('#evm-wish-price').value, currency: panel.querySelector('#evm-wish-currency').value,
    url: panel.querySelector('#evm-wish-url').value, status: panel.querySelector('#evm-wish-status').value, note: panel.querySelector('#evm-wish-note').value }; },
  validate(panel, title) {
    try { validateWishInput(this.input(panel, title)); return null; }
    catch (error) { const fields = { title: panel.ownerDocument.querySelector('#evm-title'), price: panel.querySelector('#evm-wish-price'), url: panel.querySelector('#evm-wish-url'), note: panel.querySelector('#evm-wish-note') };
      return { message: error.message, field: fields[error.field] || panel.querySelector('#evm-wish-category') }; }
  },
  save(panel, { invoke, title }) { return createWish(this.input(panel, title), { invoke }); },
};

export const CREATE_TYPES = Object.freeze([
  { id: 'task', label: 'Задача' },
  { id: 'event', label: 'Событие' },
  goalType,
  noteType,
  wishType,
]);

export const createType = id => CREATE_TYPES.find(type => type.id === id) || null;
export const createTypeButtons = ids => ids.map(id => `<button type="button" data-editor-type="${escapeHtml(id)}" aria-pressed="false">${escapeHtml(createType(id)?.label || id)}</button>`).join('');
