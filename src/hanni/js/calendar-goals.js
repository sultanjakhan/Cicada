import { invoke as defaultInvoke } from '../../state.js';
import { escapeHtml } from './utils.js';
import { createCalendarDialog } from './calendar-dialog.js';

let nextInstance = 0;
const dateLabel = value => {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : value;
};
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
export function calendarGoalLinks(links, goalId) {
  const counts = { note: new Set(), event: new Set(), schedule: new Set() };
  links.filter(link => String(link.goal_id) === String(goalId)).forEach(link => counts[link.source_type]?.add(String(link.source_id)));
  return Object.entries(counts).filter(([, ids]) => ids.size).map(([kind, ids]) => {
    const forms = { note: ['задача', 'задачи', 'задач'], event: ['событие', 'события', 'событий'], schedule: ['повторение', 'повторения', 'повторений'] }[kind];
    return `${ids.size} ${plural(ids.size, forms)}`;
  }).join(' · ');
}
export function calendarGoalForest(goals) {
  const byId = new Map(goals.map(goal => [String(goal.id), { goal, children: [] }]));
  const roots = [];
  for (const item of byId.values()) {
    const parent = item.goal.parent_goal_id == null ? null : byId.get(String(item.goal.parent_goal_id));
    if (!parent || parent === item || item.goal.goal_kind !== 'goal' || parent.goal.goal_kind !== 'goal') roots.push(item);
    else parent.children.push(item);
  }
  const seen = new Set();
  const visit = (item, depth = 0, out = [], ancestorIds = [], path = []) => {
    if (seen.has(String(item.goal.id))) return out;
    seen.add(String(item.goal.id)); out.push({ ...item, depth, ancestorIds, path: [...path, item.goal.title || 'Без названия'] });
    item.children.forEach(child => visit(child, depth + 1, out, [...ancestorIds, String(item.goal.id)], [...path, item.goal.title || 'Без названия'])); return out;
  };
  const out = roots.flatMap(item => visit(item));
  for (const item of byId.values()) visit(item, 0, out);
  return out;
}

/** Calendar goal catalog. Selection is delegated to Calendar Now's serialized state owner. */
export async function mountCalendarGoals(element, dependencies = {}) {
  const api = dependencies.invoke || defaultInvoke;
  const document = element.ownerDocument, window = document.defaultView;
  const prefix = `calendar-goals-${++nextInstance}`;
  let disposed = false, revision = 0, busy = false, creating = false;
  let goals = [], links = [], selectedId = null, active = null, creationDialog = null;
  const collapsedGoalIds = new Set();
  element.classList.add('calendar-panels', 'calendar-goals');
  element.innerHTML = `<header class="cp-heading"><div><h2>Цели</h2><p>Сохрани то, к чему хочешь прийти. Задачи можно добавить позже.</p></div><button type="button" class="cp-primary" data-new>Новая цель</button></header>
    <p class="cp-message" data-message role="status" aria-live="polite"></p><button type="button" data-retry hidden>Повторить загрузку</button><div class="cp-goal-list" data-list aria-busy="true"></div>`;
  const list = element.querySelector('[data-list]'), message = element.querySelector('[data-message]');
  function renderCards() {
    list.innerHTML = '';
    const longTerm = calendarGoalForest(goals.filter(goal => goal.goal_kind === 'goal'));
    const daily = goals.filter(goal => goal.goal_kind === 'daily_norm');
    const unknown = goals.filter(goal => goal.goal_kind !== 'goal' && goal.goal_kind !== 'daily_norm');
    if (!goals.length) { list.innerHTML = '<div class="cp-empty"><h3>Начни с того, что важно тебе</h3><p>Можно сохранить идею без срока и без готового плана.</p></div>'; return; }
    const renderGroup = (title, rows) => {
      const heading = document.createElement('h3'); heading.className = 'cp-goal-group'; heading.textContent = title; list.append(heading);
      rows.forEach(row => {
      const goal = row.goal || row, depth = row.depth || 0;
      if (row.ancestorIds?.some(id => collapsedGoalIds.has(id))) return;
      const selected = goal.goal_kind !== 'daily_norm' && String(goal.id) === selectedId, summary = calendarGoalLinks(links, goal.id);
      const target = Number(goal.target_value), current = Number(goal.current_value);
      const numeric = goal.goal_kind === 'daily_norm' || !!goal.unit || (Number.isFinite(target) && target !== 1) || (Number.isFinite(current) && current > 0);
      const numericLine = numeric && Number.isFinite(target) ? (Number.isFinite(current) ? `Прогресс: ${current} из ${target} ${goal.unit || ''}` : `Цель: ${target} ${goal.unit || ''}`) : '';
      const card = document.createElement('article'); card.className = `cp-goal-card${selected ? ' is-primary' : ''}`; card.style.setProperty('--goal-depth', String(depth));
      card.dataset.goalId = String(goal.id);
      const path = row.path || [goal.title || 'Без названия'];
      card.innerHTML = `<header class="cp-goal-card__header"><div class="cp-card-top"><span class="cp-eyebrow">${selected ? 'Главная цель' : 'Сохранённая цель'}</span>${selected ? '<span class="cp-badge">На сейчас</span>' : ''}</div><h3>${escapeHtml(goal.title || 'Без названия')}</h3>${path.length > 1 ? `<p class="cp-goal-path">${escapeHtml(path.join(' → '))}</p>` : ''}</header>
        <div class="cp-goal-card__details">${goal.description ? `<p>${escapeHtml(goal.description)}</p>` : ''}
        ${goal.goal_kind === 'daily_norm' ? `<p>Каждый день: ${escapeHtml(String(goal.target_value))} ${escapeHtml(goal.unit || '')}</p>` : ''}
        ${goal.goal_kind === 'goal' && numericLine ? `<p>${escapeHtml(numericLine.trim())}</p>` : ''}
        ${goal.criteria ? `<p class="cp-muted">Критерии</p><ul>${goal.criteria.split('\n').filter(line => line.trim()).map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
        <p class="cp-goal-links">${summary ? `Связано: ${escapeHtml(summary)}` : 'Пока без задач — можно вернуться позже'}</p>
        ${goal.deadline ? `<p class="cp-muted">Срок: ${escapeHtml(dateLabel(goal.deadline))}</p>` : ''}</div>`;
      const actions = document.createElement('div'); actions.className = 'cp-card-actions';
      if (row.children?.length) {
        const collapse = document.createElement('button'); collapse.type = 'button'; collapse.dataset.goalCollapse = String(goal.id); collapse.setAttribute('aria-expanded', String(!collapsedGoalIds.has(String(goal.id))));
        collapse.textContent = collapsedGoalIds.has(String(goal.id)) ? 'Показать подцели' : 'Свернуть подцели';
        collapse.onclick = () => { const id = String(goal.id); if (collapsedGoalIds.has(id)) collapsedGoalIds.delete(id); else collapsedGoalIds.add(id); renderCards(); element.querySelector(`[data-goal-collapse="${id}"]`)?.focus(); };
        actions.append(collapse);
      }
      if (!selected && goal.goal_kind !== 'daily_norm' && dependencies.onSelectGoal) {
        const select = document.createElement('button'); select.type = 'button'; select.dataset.select = ''; select.textContent = 'Сделать главной'; select.disabled = busy || !!active;
        select.onclick = () => selectGoal(String(goal.id)); actions.append(select);
      }
      const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.editGoal = String(goal.id);
      edit.textContent = 'Редактировать'; edit.onclick = () => openCreation(goal);
      if (goal.goal_kind === 'goal') {
        const task = document.createElement('button'); task.type = 'button'; task.className = 'cp-primary'; task.textContent = 'Добавить задачу'; task.onclick = () => dependencies.onCreateTask?.({ goalId: goal.id, title: goal.title, path: path.join(' → ') });
        const child = document.createElement('button'); child.type = 'button'; child.textContent = 'Подцель'; child.onclick = () => openCreation(null, goal);
        actions.append(task, child);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.deleteGoal = String(goal.id);
      remove.textContent = 'Удалить'; remove.onclick = () => openDeletion(goal);
      actions.append(edit, remove);
      card.append(actions); list.append(card);
    }); };
    if (longTerm.length) renderGroup('Долгосрочные цели', longTerm);
    if (daily.length) renderGroup('Ежедневные нормы', daily);
    if (unknown.length) renderGroup('Без типа — выбери, как учитывать', unknown);
  }
  async function refresh(success = '') {
    const rev = ++revision; message.textContent = 'Загружаем цели…'; list.setAttribute('aria-busy', 'true'); element.querySelector('[data-retry]').hidden = true;
    const focused = document.activeElement?.closest?.('[data-goal-collapse], [data-edit-goal], [data-delete-goal], [data-select]');
    const focusSelector = focused && list.contains(focused) ? Object.entries(focused.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${value}"]`).join('') : '';
    try {
      const [loadedGoals, loadedLinks, raw, block] = await Promise.all([api('get_goals', { tabName: null }), api('get_calendar_task_goals'), api('get_ui_state', { key: 'calendar_now_v1' }), api('get_active_block')]);
      if (disposed || rev !== revision) return;
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.version !== 1) throw new Error('Unsupported calendar state');
      goals = loadedGoals; links = loadedLinks; selectedId = saved?.goalId == null ? null : String(saved.goalId); active = block;
      renderCards(); focusSelector && list.querySelector(focusSelector)?.focus(); message.textContent = active ? 'Задача сейчас выполняется. Поставь её на паузу, чтобы сменить главную цель.' : success;
    } catch {
      if (disposed || rev !== revision) return;
      message.textContent = 'Не удалось загрузить цели. Сохранённые цели остаются на месте.';
      element.querySelector('[data-retry]').hidden = false;
    } finally { if (!disposed && rev === revision) list.removeAttribute('aria-busy'); }
  }
  async function selectGoal(id) {
    if (busy || !dependencies.onSelectGoal) return;
    busy = true; renderCards(); message.textContent = 'Выбираем главную цель…';
    let selectionError = '';
    try {
      // Recheck at the action boundary; the callback performs the serialized final check.
      if (await api('get_active_block')) { await refresh(); return; }
      try { await dependencies.onSelectGoal(id); }
      catch (error) { selectionError = typeof error?.message === 'string' ? error.message : ''; throw error; }
      if (!disposed) await refresh('Главная цель выбрана. Задача начнётся только после нажатия «Начать».');
    } catch { if (!disposed) message.textContent = selectionError || 'Не удалось сменить главную цель. Повтори выбор; текущая задача сохранена.'; }
    finally { busy = false; if (!disposed) renderCards(); }
  }
  function openCreation(goal = null, initialParent = null) {
    if (creationDialog || disposed) return;
    const editor = createCalendarDialog({ document, title: goal ? 'Изменить цель' : 'Новая цель', hint: 'Сохрани то, к чему хочешь прийти. Срок можно добавить позже.', submitLabel: 'Сохранить цель',
      isCurrent: () => !disposed && element.isConnected, returnFocus: () => (goal ? element.querySelector(`[data-edit-goal="${goal.id}"]`) : element.querySelector('[data-new]'))?.focus(), onClose: () => { creationDialog = null; } });
    creationDialog = editor; editor.modal.dataset.goalCreate = '';
    editor.body.innerHTML = `<label class="calendar-editor-field" for="${prefix}-new-title">Что хочешь получить?<input id="${prefix}-new-title" name="title" required maxlength="500" placeholder="Например, подготовить учебный проект" autocomplete="off"></label>
      <label class="calendar-editor-field" for="${prefix}-new-deadline">Срок · необязательно<input id="${prefix}-new-deadline" name="deadline" type="date"></label>`;
    const extra = document.createElement('div');
    extra.className = 'calendar-goal-fields';
    extra.innerHTML = `<fieldset><legend>Как учитывать</legend><label><input type="radio" name="goal_kind" value="goal"> Долгосрочная цель</label><label><input type="radio" name="goal_kind" value="daily_norm"> Ежедневная норма</label></fieldset>
      <label class="calendar-editor-field">Желаемый результат<textarea name="description" maxlength="10000" placeholder="Что должно измениться?"></textarea></label>
      <label class="calendar-editor-field">Критерии — по одному на строку<textarea name="criteria" maxlength="10000" placeholder="Например: самостоятельно описываю API-контракт"></textarea></label>
      <label class="calendar-editor-field calendar-goal-numeric-toggle" data-numeric-toggle><input type="checkbox" name="numeric_progress"> Числовой прогресс</label>
      <div data-numeric-fields><label class="calendar-editor-field">Целевое значение<input type="number" name="target_value" min="0.001" step="any"></label>
      <label class="calendar-editor-field">Единица измерения<input name="unit" maxlength="100" placeholder="Например, л"></label><label class="calendar-editor-field">Текущий прогресс · необязательно<input type="number" name="current_value" min="0" step="any"></label></div><label class="calendar-editor-field" data-parent>Родительская цель<select name="parent_goal_id"><option value="">Верхний уровень</option></select></label>`;
    editor.body.append(extra);
    const fields = editor.form.elements;
    fields.title.value = goal?.title || ''; fields.deadline.value = goal?.deadline || '';
    fields.goal_kind.value = goal ? goal.goal_kind || '' : 'goal';
    fields.description.value = goal?.description || ''; fields.criteria.value = goal?.criteria || '';
    fields.target_value.value = goal?.target_value > 0 ? goal.target_value : 1; fields.unit.value = goal?.unit || '';
    fields.current_value.value = goal?.current_value ?? '';
    fields.numeric_progress.checked = fields.goal_kind.value === 'daily_norm' || !!(goal && (goal.unit || Number(goal.target_value) !== 1 || Number(goal.current_value) > 0));
    const parentSelect = fields.parent_goal_id; const blocked = new Set([String(goal?.id || '')]);
    let changed = true; while (changed) { changed = false; goals.forEach(item => { if (blocked.has(String(item.parent_goal_id)) && !blocked.has(String(item.id))) { blocked.add(String(item.id)); changed = true; } }); }
    const parentLabel = item => { const path = []; const seen = new Set(); let current = item; while (current && !seen.has(String(current.id))) { seen.add(String(current.id)); path.unshift(current.title || 'Без названия'); current = goals.find(candidate => String(candidate.id) === String(current.parent_goal_id)); } return path.join(' → '); };
    goals.filter(item => item.goal_kind === 'goal' && !blocked.has(String(item.id))).forEach(item => parentSelect.add(new window.Option(parentLabel(item), String(item.id))));
    parentSelect.value = String(goal?.parent_goal_id ?? initialParent?.id ?? '');
    const updateFields = () => {
      const isDaily = fields.goal_kind.value === 'daily_norm', numeric = isDaily || fields.numeric_progress.checked;
      editor.body.querySelector('[data-parent]').hidden = !fields.goal_kind.value || isDaily; parentSelect.disabled = !fields.goal_kind.value || isDaily; if (isDaily) parentSelect.value = '';
      editor.body.querySelector('[data-numeric-toggle]').hidden = isDaily; editor.body.querySelector('[data-numeric-fields]').hidden = !numeric;
      fields.target_value.required = numeric;
    };
    editor.form.querySelectorAll('[name=goal_kind]').forEach(input => input.addEventListener('change', updateFields)); fields.numeric_progress.addEventListener('change', updateFields); updateFields();
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); if (creating || disposed) return;
      editor.showError('');
      const titleInput = editor.form.elements.title, deadlineInput = editor.form.elements.deadline;
      const title = titleInput.value.trim(), deadlineValue = deadlineInput.value;
      if (!title) { editor.showError('Напиши, к чему хочешь прийти.', titleInput); return; }
      if (title.length > 500) { editor.showError('Сократи название цели до 500 символов.', titleInput); return; }
      const deadlineDate = deadlineValue ? new Date(`${deadlineValue}T12:00:00Z`) : null;
      if (deadlineInput.validity.badInput || !deadlineInput.validity.valid || (deadlineValue && (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineValue) || !Number.isFinite(deadlineDate.getTime()) || deadlineDate.toISOString().slice(0, 10) !== deadlineValue))) {
        editor.showError('Введи срок полностью или очисти поле даты.', deadlineInput); return;
      }
      const deadline = deadlineValue || null;
      if (!fields.goal_kind.value && !goal) { editor.showError('Выбери долгосрочную цель или ежедневную норму.', editor.body.querySelector('[name=goal_kind]')); return; }
      const numeric = fields.goal_kind.value === 'daily_norm' || fields.numeric_progress.checked;
      const targetValue = numeric ? Number(fields.target_value.value) : (goal?.target_value > 0 ? goal.target_value : 1);
      if (!Number.isFinite(targetValue) || targetValue <= 0) { editor.showError('Укажи положительное целевое значение.', fields.target_value); return; }
      creating = true; editor.setPending(true);
      try {
        const currentValue = numeric ? (fields.current_value.value === '' ? null : Number(fields.current_value.value)) : (goal?.current_value ?? null);
        if (currentValue != null && (!Number.isFinite(currentValue) || currentValue < 0)) { editor.showError('Укажи неотрицательный прогресс или очисти поле.', fields.current_value); return; }
        await api('save_calendar_goal', { id: goal?.id || null, title, targetValue, unit: numeric ? fields.unit.value.trim() : (goal?.unit || ''), deadline, goalKind: fields.goal_kind.value || null, description: fields.description.value.trim(), criteria: fields.criteria.value.trim(), parentGoalId: parentSelect.value ? Number(parentSelect.value) : null, clearParent: !!goal?.parent_goal_id && !parentSelect.value, currentValue });
        // Saving succeeded. Close before rereading: a failed refresh must not offer Create again.
        editor.setPending(false); editor.close();
        window.dispatchEvent(new window.Event('task-state-changed'));
        if (!disposed) await refresh('Цель сохранена. Можно выбрать её главной, когда будешь готов.');
      } catch { if (!disposed) { editor.setPending(false); editor.showError('Не удалось сохранить цель. Текст остался в форме — попробуй ещё раз.'); } }
      finally { creating = false; }
    });
    editor.open(editor.form.elements.title);
  }
  function openDeletion(goal) {
    if (creationDialog || disposed) return;
    const editor = createCalendarDialog({ document, title: 'Удалить цель?', submitLabel: 'Удалить цель',
      hint: 'Связанные задачи и события сохранятся без этой цели.', isCurrent: () => !disposed && element.isConnected,
      returnFocus: () => (element.querySelector(`[data-delete-goal="${goal.id}"]`) || element.querySelector('[data-new]'))?.focus(),
      onClose: () => { creationDialog = null; } });
    creationDialog = editor; editor.modal.dataset.goalDelete = ''; editor.body.textContent = goal.title;
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); if (creating || disposed) return;
      creating = true; editor.showError(''); editor.setPending(true);
      try {
        await api('delete_goal', { id: goal.id });
        editor.setPending(false); editor.close();
        window.dispatchEvent(new window.Event('task-state-changed'));
        if (!disposed) await refresh('Цель удалена. Задачи сохранены.');
      } catch { if (!disposed) { editor.setPending(false); editor.showError('Не удалось удалить цель. Попробуй ещё раз.'); } }
      finally { creating = false; }
    });
    editor.open(editor.modal.querySelector('[data-dialog-close]'));
  }
  element.querySelector('[data-new]').onclick = () => openCreation();
  element.querySelector('[data-retry]').onclick = () => refresh();
  const onChange = () => { if (!busy && !creating && !disposed) void refresh(); };
  window.addEventListener('task-state-changed', onChange);
  await refresh();
  return () => { disposed = true; revision++; creationDialog?.dispose(); window.removeEventListener('task-state-changed', onChange); };
}