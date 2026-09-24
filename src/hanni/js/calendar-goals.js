import { invoke as defaultInvoke } from './state.js';
import { escapeHtml } from './utils.js';
import { createCalendarDialog } from './calendar-dialog.js';
import { mountCalendarContextMenu } from './calendar-context-menu.js';
import { DEVELOPMENT_STATE_KEY, readDevelopmentState, developmentOf, goalNumericProgress, formatNumber } from './calendar-development-state.js';
import { mountCalendarWishes } from './calendar-wishes.js';
import { wishGoalDraft } from './calendar-wishes-store.js';

let nextInstance = 0;
export const calendarGoalDateLabel = value => {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : value;
};
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
export function calendarGoalLinks(links, goalId, descendantIds = []) {
  const goalIds = new Set([String(goalId), ...descendantIds.map(String)]);
  const counts = { note: new Set(), event: new Set(), schedule: new Set() };
  links.filter(link => goalIds.has(String(link.goal_id))).forEach(link => counts[link.source_type]?.add(String(link.source_id)));
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
/** Goal ids of a goal and all its subgoals (cycle-safe). */
export function calendarGoalDescendants(goals, goalId) {
  const ids = new Set([String(goalId)]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    goals.forEach(goal => { const id = String(goal.id); if (ids.has(String(goal.parent_goal_id)) && !ids.has(id)) { ids.add(id); expanded = true; } });
  }
  return ids;
}
export function calendarGoalPath(goals, goal) {
  const path = [], seen = new Set(); let current = goal;
  while (current && !seen.has(String(current.id))) { seen.add(String(current.id)); path.unshift(current.title || 'Без названия'); current = goals.find(candidate => String(candidate.id) === String(current.parent_goal_id)); }
  return path;
}

/** Shared goal editor (create, edit, subgoal, prefilled draft). Saving uses save_calendar_goal only. */
export function openCalendarGoalEditor({ document, invoke, goal = null, parent = null, draft = null, goals = [], returnFocus, isCurrent = () => true, onSaved, onSavingChange, onClose } = {}) {
  const window = document.defaultView, prefix = `calendar-goal-editor-${++nextInstance}`;
  let creating = false;
  const editor = createCalendarDialog({ document, title: goal ? 'Изменить цель' : parent ? 'Новая подцель' : 'Новая цель', hint: 'Сохрани то, к чему хочешь прийти. Срок можно добавить позже.', submitLabel: 'Сохранить цель',
    isCurrent, returnFocus, onClose });
  editor.modal.dataset.goalCreate = '';
  editor.body.innerHTML = `<label class="calendar-editor-field" for="${prefix}-new-title">Что хочешь получить?<input id="${prefix}-new-title" name="title" required maxlength="500" placeholder="Например, подготовить учебный проект" autocomplete="off"></label>
    <label class="calendar-editor-field" for="${prefix}-new-deadline">Срок · необязательно<input id="${prefix}-new-deadline" name="deadline" type="date"></label>`;
  const extra = document.createElement('div');
  extra.className = 'calendar-goal-fields';
  extra.innerHTML = `<fieldset ${goal?.goal_kind === 'daily_norm' ? '' : 'hidden'}><legend>Как учитывать</legend><label><input type="radio" name="goal_kind" value="goal"> Долгосрочная цель</label><label><input type="radio" name="goal_kind" value="daily_norm"> Ежедневная норма</label></fieldset>
    <label class="calendar-editor-field">Желаемый результат<textarea name="description" maxlength="10000" placeholder="Что должно измениться?"></textarea></label>
    <label class="calendar-editor-field">Критерии — по одному на строку<textarea name="criteria" maxlength="10000" placeholder="Например: самостоятельно описываю API-контракт"></textarea></label>
    <label class="calendar-editor-field calendar-goal-numeric-toggle" data-numeric-toggle><input type="checkbox" name="numeric_progress"> Числовой прогресс</label>
    <div data-numeric-fields><label class="calendar-editor-field">Целевое значение<input type="number" name="target_value" min="0.001" step="any"></label>
    <label class="calendar-editor-field">Единица измерения<input name="unit" maxlength="100" placeholder="Например, л"></label><label class="calendar-editor-field">Текущий прогресс · необязательно<input type="number" name="current_value" min="0" step="any"></label></div><label class="calendar-editor-field" data-parent>Родительская цель<select name="parent_goal_id"><option value="">Верхний уровень</option></select></label>`;
  editor.body.append(extra);
  const fields = editor.form.elements;
  fields.title.value = goal?.title || draft?.title || ''; fields.deadline.value = goal?.deadline || '';
  fields.goal_kind.value = goal ? goal.goal_kind || '' : 'goal';
  fields.description.value = goal?.description || draft?.description || ''; fields.criteria.value = goal?.criteria || '';
  fields.target_value.value = goal?.target_value > 0 ? goal.target_value : draft?.targetValue > 0 ? draft.targetValue : 1; fields.unit.value = goal?.unit || (!goal && draft?.unit) || '';
  fields.current_value.value = goal?.current_value ?? '';
  fields.numeric_progress.checked = fields.goal_kind.value === 'daily_norm' || !!(goal && (goal.unit || Number(goal.target_value) !== 1 || Number(goal.current_value) > 0)) || (!goal && draft?.targetValue > 0);
  const parentSelect = fields.parent_goal_id; const blocked = new Set([String(goal?.id || '')]);
  let changed = true; while (changed) { changed = false; goals.forEach(item => { if (blocked.has(String(item.parent_goal_id)) && !blocked.has(String(item.id))) { blocked.add(String(item.id)); changed = true; } }); }
  goals.filter(item => item.goal_kind === 'goal' && !blocked.has(String(item.id))).forEach(item => parentSelect.add(new window.Option(calendarGoalPath(goals, item).join(' → '), String(item.id))));
  parentSelect.value = String(goal?.parent_goal_id ?? parent?.id ?? '');
  const updateFields = () => {
    const isDaily = fields.goal_kind.value === 'daily_norm', numeric = isDaily || fields.numeric_progress.checked;
    editor.body.querySelector('[data-parent]').hidden = !fields.goal_kind.value || isDaily; parentSelect.disabled = !fields.goal_kind.value || isDaily; if (isDaily) parentSelect.value = '';
    editor.body.querySelector('[data-numeric-toggle]').hidden = isDaily; editor.body.querySelector('[data-numeric-fields]').hidden = !numeric;
    fields.target_value.required = numeric;
  };
  editor.form.querySelectorAll('[name=goal_kind]').forEach(input => input.addEventListener('change', updateFields)); fields.numeric_progress.addEventListener('change', updateFields); updateFields();
  editor.form.addEventListener('submit', async event => {
    event.preventDefault(); if (creating) return;
    editor.showError('');
    const titleInput = fields.title, deadlineInput = fields.deadline;
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
    const currentValue = numeric ? (fields.current_value.value === '' ? null : Number(fields.current_value.value)) : (goal?.current_value ?? null);
    if (currentValue != null && (!Number.isFinite(currentValue) || currentValue < 0)) { editor.showError('Укажи неотрицательный прогресс или очисти поле.', fields.current_value); return; }
    creating = true; onSavingChange?.(true); editor.setPending(true);
    try {
      const id = await invoke('save_calendar_goal', { id: goal?.id || null, title, targetValue, unit: numeric ? fields.unit.value.trim() : (goal?.unit || ''), deadline, goalKind: fields.goal_kind.value || null, description: fields.description.value.trim(), criteria: fields.criteria.value.trim(), parentGoalId: parentSelect.value ? String(parentSelect.value) : null, clearParent: !!goal?.parent_goal_id && !parentSelect.value, currentValue });
      // Saving succeeded. Close before rereading: a failed refresh must not offer Create again.
      editor.setPending(false); editor.close();
      window.dispatchEvent(new window.Event('task-state-changed'));
      await onSaved?.(goal?.id ?? id);
    } catch { if (editor.modal.isConnected) { editor.setPending(false); editor.showError('Не удалось сохранить цель. Текст остался в форме — попробуй ещё раз.'); } }
    finally { creating = false; onSavingChange?.(false); }
  });
  editor.open(fields.title);
  return editor;
}

export function openCalendarGoalDeletion({ document, invoke, goal, returnFocus, isCurrent = () => true, onDeleted, onSavingChange, onClose } = {}) {
  const window = document.defaultView;
  let deleting = false;
  const editor = createCalendarDialog({ document, title: 'Удалить цель?', submitLabel: 'Удалить цель',
    hint: 'Связанные задачи и события сохранятся без этой цели.', isCurrent, returnFocus, onClose });
  editor.modal.dataset.goalDelete = ''; editor.body.textContent = goal.title;
  editor.form.addEventListener('submit', async event => {
    event.preventDefault(); if (deleting) return;
    deleting = true; onSavingChange?.(true); editor.showError(''); editor.setPending(true);
    try {
      await invoke('delete_goal', { id: goal.id });
      editor.setPending(false); editor.close();
      window.dispatchEvent(new window.Event('task-state-changed'));
      await onDeleted?.(goal.id);
    } catch { if (editor.modal.isConnected) { editor.setPending(false); editor.showError('Не удалось удалить цель. Попробуй ещё раз.'); } }
    finally { deleting = false; onSavingChange?.(false); }
  });
  editor.open(editor.modal.querySelector('[data-dialog-close]'));
  return editor;
}

/**
 * Calendar goal catalog: one compact row per goal (title, one-line description,
 * current stage, deadline). The row opens the full goal popup; selection is
 * delegated to Calendar Now's serialized state owner.
 * `dependencies.state` keeps the Goals/Wishes choice across pane switches.
 */
export async function mountCalendarGoals(element, dependencies = {}) {
  const api = dependencies.invoke || defaultInvoke;
  const document = element.ownerDocument, window = document.defaultView;
  const viewState = dependencies.state || { view: 'goals' };
  let disposed = false, revision = 0, busy = false, creating = false;
  let goals = [], goalsLoaded = false, development = readDevelopmentState(null), selectedId = null, active = null, creationDialog = null, wishes = null;
  const collapsedGoalIds = new Set();
  element.classList.add('calendar-panels', 'calendar-goals');
  element.innerHTML = `<header class="cp-heading"><div><h2>Цели</h2><p data-goals-hint></p></div><button type="button" class="cp-primary" data-new></button></header>
    <div class="cp-goals-switch" role="group" aria-label="Что показать"><button type="button" data-goals-view="goals">Цели</button><button type="button" data-goals-view="wishes">Желания</button></div>
    <div data-goals-panel><p class="cp-message" data-message role="status" aria-live="polite"></p><button type="button" data-retry hidden>Повторить загрузку</button><div class="cp-goal-list" data-list aria-busy="true"></div></div>
    <div data-wishes-panel hidden></div>`;
  const list = element.querySelector('[data-list]'), message = element.querySelector('[data-message]');
  const goalById = id => goals.find(goal => String(goal.id) === String(id));
  const rowButton = (id, selector) => list.querySelector(`[data-goal-id="${String(id).replace(/["\\]/g, '\\$&')}"] ${selector}`);
  const focusMenu = id => (rowButton(id, '[data-record-menu]') || element.querySelector('[data-new]'))?.focus();
  function showView(view, focus = false) {
    viewState.view = view === 'wishes' ? 'wishes' : 'goals';
    const wishesView = viewState.view === 'wishes';
    element.querySelectorAll('[data-goals-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.goalsView === viewState.view)));
    element.querySelector('[data-goals-panel]').hidden = wishesView;
    const panel = element.querySelector('[data-wishes-panel]'); panel.hidden = !wishesView;
    element.querySelector('[data-goals-hint]').textContent = wishesView ? 'Покупки, поездки и впечатления без плана. Если нужно накопить — преврати желание в цель.' : 'Сохрани то, к чему хочешь прийти. Задачи можно добавить позже.';
    element.querySelector('[data-new]').textContent = wishesView ? 'Новое желание' : 'Новая цель';
    if (wishesView && !wishes) {
      wishes = mountCalendarWishes(panel, { invoke: api, mountMenu: mountCalendarContextMenu, getGoals: () => goalsLoaded ? goals : null,
        openGoal: dependencies.onOpenGoal ? (goal, returnFocus) => dependencies.onOpenGoal(goal, { primaryGoalId: selectedId, returnFocus }) : null, openUrl: dependencies.openUrl,
        returnFocus: () => element.querySelector('[data-new]')?.focus(),
        convertToGoal: (wish, done, restore) => openCreation(null, null, { draft: wishGoalDraft(wish), onSaved: done, returnFocus: restore }) });
    }
    if (focus) element.querySelector(`[data-goals-view="${viewState.view}"]`)?.focus();
  }
  function goalActions(goal, path) {
    const actions = [];
    if (goal.goal_kind === 'goal') {
      actions.push({ id: 'task', label: 'Добавить задачу', dialog: true, run: () => dependencies.onCreateTask?.({ goalId: goal.id, title: goal.title, path: path.join(' → ') }) });
      actions.push({ id: 'subgoal', label: 'Подцель', dialog: true, run: restore => openCreation(null, goal, { returnFocus: restore }) });
    }
    actions.push({ id: 'edit', label: 'Редактировать', dialog: true, run: restore => openCreation(goal, null, { returnFocus: restore }) });
    actions.push({ id: 'delete', label: 'Удалить', dialog: true, run: restore => openDeletion(goal, restore) });
    return actions;
  }
  const disposeMenu = mountCalendarContextMenu(list, {
    getRecord: row => { const goal = goalById(row.dataset.contextRecord); return goal ? { ...goal, title: goal.title || 'Без названия' } : null; },
    getActions: record => goalActions(goalById(record.id), calendarGoalPath(goals, goalById(record.id))),
    restoreFocus: row => focusMenu(row.dataset.contextRecord),
  });
  function openGoal(goal) {
    const id = String(goal.id), returnFocus = () => (rowButton(id, '[data-goal-open]') || element.querySelector('[data-new]'))?.focus();
    if (dependencies.onOpenGoal) dependencies.onOpenGoal(goal, { primaryGoalId: selectedId, returnFocus });
    else openCreation(goal, null, { returnFocus });
  }
  function rowMeta(goal, id) {
    const meta = [], ext = developmentOf(development, id), stage = ext.stages.find(item => item.id === ext.activeStageId);
    if (goal.goal_kind === 'daily_norm') meta.push(`Каждый день: ${formatNumber(goal.target_value)} ${goal.unit || ''}`.trim());
    else if (goal.goal_kind !== 'goal') meta.push('Тип не выбран');
    if (ext.stages.length) meta.push(stage ? `Этап: ${stage.title}` : 'Этап не выбран');
    const numeric = goalNumericProgress(goal);
    if (numeric) meta.push(numeric.label);
    if (goal.deadline) meta.push(`до ${calendarGoalDateLabel(goal.deadline)}`);
    return meta;
  }
  function renderCards() {
    list.innerHTML = '';
    const longTerm = calendarGoalForest(goals.filter(goal => goal.goal_kind === 'goal'));
    const daily = goals.filter(goal => goal.goal_kind === 'daily_norm');
    const unknown = goals.filter(goal => goal.goal_kind !== 'goal' && goal.goal_kind !== 'daily_norm');
    if (!goals.length) { list.innerHTML = '<div class="cp-empty"><h3>Начни с того, что важно тебе</h3><p>Можно сохранить идею без срока и без готового плана.</p></div>'; return; }
    const renderGroup = (title, rows) => {
      const heading = document.createElement('h3'); heading.className = 'cp-goal-group'; heading.textContent = title; list.append(heading);
      rows.forEach(row => {
        const goal = row.goal || row, depth = row.depth || 0, id = String(goal.id);
        if (row.ancestorIds?.some(ancestor => collapsedGoalIds.has(ancestor))) return;
        const selected = goal.goal_kind === 'goal' && id === selectedId, meta = rowMeta(goal, id);
        const description = String(goal.description || '').split('\n').find(line => line.trim())?.trim() || '';
        const card = document.createElement('article');
        card.className = `cp-goal-row${selected ? ' is-primary' : ''}${depth ? ' is-subgoal' : ''}`; card.style.setProperty('--goal-depth', String(depth));
        card.dataset.goalId = id; card.dataset.contextRecord = id;
        const lead = document.createElement('span'); lead.className = 'cp-goal-row__lead';
        if (row.children?.length) {
          const collapsed = collapsedGoalIds.has(id);
          const collapse = document.createElement('button'); collapse.type = 'button'; collapse.className = 'cp-goal-row__collapse'; collapse.dataset.goalCollapse = id;
          collapse.setAttribute('aria-expanded', String(!collapsed)); collapse.setAttribute('aria-label', `${collapsed ? 'Показать подцели' : 'Свернуть подцели'}: ${goal.title || 'Без названия'}`);
          collapse.innerHTML = '<span aria-hidden="true">▾</span>';
          collapse.onclick = () => { if (collapsedGoalIds.has(id)) collapsedGoalIds.delete(id); else collapsedGoalIds.add(id); renderCards(); element.querySelector(`[data-goal-collapse="${id}"]`)?.focus(); };
          lead.append(collapse);
        }
        const open = document.createElement('button'); open.type = 'button'; open.className = 'cp-goal-row__open'; open.dataset.goalOpen = id; open.setAttribute('aria-haspopup', 'dialog');
        open.innerHTML = `<span class="cp-goal-row__line"><span class="cp-goal-row__title">${escapeHtml(goal.title || 'Без названия')}</span>${selected ? '<span class="cp-goal-row__badge">Главная</span>' : ''}</span>${description ? `<span class="cp-goal-row__desc">${escapeHtml(description)}</span>` : ''}${meta.length ? `<span class="cp-goal-row__meta">${meta.map(escapeHtml).join(' · ')}</span>` : ''}`;
        open.onclick = () => openGoal(goal);
        const tools = document.createElement('span'); tools.className = 'cp-goal-row__tools';
        if (!selected && goal.goal_kind === 'goal' && dependencies.onSelectGoal) {
          const select = document.createElement('button'); select.type = 'button'; select.className = 'cp-goal-row__select'; select.dataset.select = id; select.textContent = 'Сделать главной'; select.disabled = busy || !!active;
          select.setAttribute('aria-label', `Сделать главной: ${goal.title || 'Без названия'}`);
          select.onclick = () => selectGoal(id); tools.append(select);
        }
        const more = document.createElement('button'); more.type = 'button'; more.className = 'cp-goal-row__more'; more.textContent = '⋯';
        more.dataset.recordMenu = ''; more.dataset.goalMenu = id; more.setAttribute('aria-label', `Действия: ${goal.title || 'Без названия'}`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        tools.append(more);
        card.append(lead, open, tools);
        card.addEventListener('click', event => { if (!event.target.closest('button, a, input, select, textarea')) open.click(); });
        list.append(card);
      });
    };
    if (longTerm.length) renderGroup('Долгосрочные цели', longTerm);
    if (daily.length) renderGroup('Ежедневные нормы', daily);
    if (unknown.length) renderGroup('Без типа — выбери, как учитывать', unknown);
  }
  async function refresh(success = '', canCommit = null) {
    if (canCommit && !canCommit()) return;
    const rev = ++revision; message.textContent = 'Загружаем цели…'; list.setAttribute('aria-busy', 'true'); element.querySelector('[data-retry]').hidden = true;
    const focused = document.activeElement?.closest?.('[data-goal-collapse], [data-goal-open], [data-goal-menu], [data-select]');
    const focusSelector = focused && list.contains(focused) ? Object.entries(focused.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${value}"]`).join('') : '';
    try {
      const [loadedGoals, raw, block, developmentRaw] = await Promise.all([api('get_goals', { tabName: null }), api('get_ui_state', { key: 'calendar_now_v1' }), api('get_active_block'), api('get_ui_state', { key: DEVELOPMENT_STATE_KEY }).catch(() => null)]);
      if (disposed || rev !== revision || (canCommit && !canCommit())) return;
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.version !== 1) throw new Error('Unsupported calendar state');
      goals = loadedGoals; goalsLoaded = true; selectedId = saved?.goalId == null ? null : String(saved.goalId); active = block; development = readDevelopmentState(developmentRaw);
      renderCards(); focusSelector && list.querySelector(focusSelector)?.focus(); message.textContent = active ? 'Задача сейчас выполняется. Поставь её на паузу, чтобы сменить главную цель.' : success;
      wishes?.render();
    } catch {
      if (disposed || rev !== revision || (canCommit && !canCommit())) return;
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
  function openCreation(goal = null, initialParent = null, { draft = null, onSaved = null, returnFocus = null } = {}) {
    if (creationDialog || disposed) return;
    creationDialog = openCalendarGoalEditor({ document, invoke: api, goal, parent: initialParent, draft, goals,
      isCurrent: () => !disposed && element.isConnected,
      returnFocus: returnFocus || (() => (goal ? rowButton(goal.id, '[data-record-menu]') : element.querySelector('[data-new]'))?.focus()),
      onSavingChange: value => { creating = value; },
      onClose: () => { creationDialog = null; },
      onSaved: async id => { await onSaved?.(id); if (!disposed) await refresh(draft ? 'Цель создана из желания.' : 'Цель сохранена. Можно выбрать её главной, когда будешь готов.'); } });
  }
  function openDeletion(goal, restore = null) {
    if (creationDialog || disposed) return;
    creationDialog = openCalendarGoalDeletion({ document, invoke: api, goal, isCurrent: () => !disposed && element.isConnected,
      returnFocus: () => (rowButton(goal.id, '[data-record-menu]') ? (restore || (() => focusMenu(goal.id)))() : element.querySelector('[data-new]')?.focus()),
      onSavingChange: value => { creating = value; }, onClose: () => { creationDialog = null; },
      onDeleted: async () => {
        if (disposed) return;
        await refresh('Цель удалена. Задачи сохранены.');
        // The deleted row took the restored focus with it.
        const focused = document.activeElement;
        if (!disposed && (!focused || focused === document.body || !focused.isConnected)) element.querySelector('[data-new]')?.focus();
      } });
  }
  element.querySelector('[data-new]').onclick = () => viewState.view === 'wishes' ? wishes?.openCreate() : openCreation();
  element.querySelectorAll('[data-goals-view]').forEach(button => { button.onclick = () => showView(button.dataset.goalsView, true); });
  element.querySelector('[data-retry]').onclick = () => refresh();
  const onChange = event => { if (!busy && !creating && !disposed) void refresh('', event.detail?.remoteSync ? event.detail.canCommit : null); };
  const onDevelopment = () => { if (!disposed && !busy && !creating) void refresh(); };
  window.addEventListener('task-state-changed', onChange);
  window.addEventListener('hanni:development-changed', onDevelopment);
  showView(viewState.view);
  await refresh();
  return () => { disposed = true; revision++; creationDialog?.dispose(); wishes?.dispose(); disposeMenu(); window.removeEventListener('task-state-changed', onChange); window.removeEventListener('hanni:development-changed', onDevelopment); };
}
