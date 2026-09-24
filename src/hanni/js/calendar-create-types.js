// Record types of the shared «Создать» dialog (#97). Task and Event use the
// scheduling editor in calendar-event-modal.js. Every other type owns a small
// field panel and saves through an existing native command.
//
// Extension point: to offer another type (for example the wish from #85), add
// one entry below. The dialog renders its button, shows only its panel, reuses
// the shared title field and calls `save` on Enter or the primary button.
//   id, label           — stable key and button text
//   heading, hint       — dialog heading and short explanation
//   submitLabel         — primary button text
//   titleLabel, titlePlaceholder, titleRequired — shared title field; an empty
//                         titleRequired makes the title optional
//   panel(doc, context) — returns the panel element with the type's own fields
//   goalsLoaded?(panel, goals|null, context) — the dialog's goal list, or null
//   validate?(panel, title) — { message, field } to stop saving, else null
//   save(panel, { invoke, title }) — persists; a rejection keeps the form open
//   saved?(window)      — extra notifications after a successful save
import { escapeHtml } from './utils.js';

export const SCHEDULE_TYPES = Object.freeze(['task', 'event']);

function field(doc, html) {
  const wrap = doc.createElement('div');
  wrap.className = 'evm-create-panel';
  wrap.innerHTML = html;
  return wrap;
}

function goalPath(goal, byId) {
  const path = [], seen = new Set();
  for (let current = goal; current && !seen.has(String(current.id)); current = byId.get(String(current.parent_goal_id))) {
    seen.add(String(current.id)); path.unshift(current.title || 'Без названия');
  }
  return path.join(' → ');
}

const goalType = {
  id: 'goal', label: 'Цель', heading: 'Новая цель', submitLabel: 'Создать цель',
  hint: 'Сохрани, к чему хочешь прийти. Срок, этапы и навыки можно добавить позже в «Целях».',
  titleLabel: 'Название', titlePlaceholder: 'Например, выучить испанский до уровня B1', titleRequired: 'Напиши, к чему хочешь прийти.',
  panel(doc) {
    return field(doc, `<label class="evm-field" for="evm-goal-description"><span class="evm-field-label">Коротко о цели · необязательно</span>
        <textarea class="form-textarea" id="evm-goal-description" rows="3" maxlength="10000" placeholder="Что изменится, когда цель будет достигнута?"></textarea></label>
      <label class="evm-field" for="evm-goal-parent"><span class="evm-field-label">Родительская цель · необязательно</span>
        <select class="form-select" id="evm-goal-parent" disabled><option value="">Загружаем цели…</option></select></label>`);
  },
  goalsLoaded(panel, goals, context) {
    const select = panel.querySelector('#evm-goal-parent'), previous = select.value || context.parentGoalId || '';
    const { Option } = panel.ownerDocument.defaultView;
    select.replaceChildren(new Option('Верхний уровень', ''));
    // Only a long-term goal can contain a subgoal (save_calendar_goal enforces it).
    const byId = new Map((goals || []).map(goal => [String(goal.id), goal]));
    for (const goal of (goals || []).filter(goal => (goal.goal_kind || 'goal') === 'goal')) select.add(new Option(goalPath(goal, byId), String(goal.id)));
    select.value = [...select.options].some(option => option.value === String(previous)) ? String(previous) : '';
    select.disabled = false;
  },
  validate(panel, title) {
    if (title.length > 500) return { message: 'Сократи название цели до 500 символов.', field: panel.ownerDocument.querySelector('#evm-title') };
    return null;
  },
  save(panel, { invoke, title }) {
    const parent = panel.querySelector('#evm-goal-parent').value;
    return invoke('save_calendar_goal', { id: null, title, targetValue: 1, unit: '', deadline: null, goalKind: 'goal',
      description: panel.querySelector('#evm-goal-description').value.trim(), criteria: '',
      parentGoalId: parent ? String(parent) : null, clearParent: false, currentValue: null });
  },
};

const noteType = {
  id: 'note', label: 'Заметка', heading: 'Новая заметка', submitLabel: 'Создать заметку',
  hint: 'Мысль или детали на потом. Название можно не писать — возьмём первую строку текста.',
  titleLabel: 'Название · необязательно', titlePlaceholder: 'О чём эта заметка?', titleRequired: '',
  panel(doc) {
    return field(doc, `<label class="evm-field" for="evm-note-text"><span class="evm-field-label">Текст</span>
      <textarea class="form-textarea" id="evm-note-text" rows="6" placeholder="Идея, наблюдение или детали на потом…"></textarea></label>`);
  },
  validate(panel, title) {
    const text = panel.querySelector('#evm-note-text');
    if (!title && !text.value.trim()) return { message: 'Добавь мысль или название заметки.', field: text };
    if (title.length > 500) return { message: 'Сократи название до 500 символов.', field: panel.ownerDocument.querySelector('#evm-title') };
    return null;
  },
  save(panel, { invoke, title }) {
    const content = panel.querySelector('#evm-note-text').value;
    // Same fallback title and tags as the Notes pane.
    return invoke('create_note', { title: title || content.trim().split('\n')[0].slice(0, 100), content, tags: '', tabName: 'calendar', status: 'note', dueDate: null, reminderAt: null, priority: null });
  },
  saved(win) { win.dispatchEvent(new win.CustomEvent('hanni:calendar-notes-changed')); },
};

export const CREATE_TYPES = Object.freeze([
  { id: 'task', label: 'Задача' },
  { id: 'event', label: 'Событие' },
  goalType,
  noteType,
]);

export const createType = id => CREATE_TYPES.find(type => type.id === id) || null;
export const createTypeButtons = ids => ids.map(id => `<button type="button" data-editor-type="${escapeHtml(id)}">${escapeHtml(createType(id)?.label || id)}</button>`).join('');
