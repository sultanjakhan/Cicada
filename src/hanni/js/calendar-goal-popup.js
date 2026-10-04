// Third display level of a goal (#98): the full popup. The dashboard shows the
// title, stage and next task; the Goals list shows one row; everything else —
// result, criteria, progress, deadline, subgoals, linked tasks, stages, skills
// and the editors — lives here. Stage filters stay in the development section.
import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';
import { mountGoalDevelopment } from './calendar-development.js';
import { goalNumericProgress, formatNumber } from './calendar-development-state.js';
import {
  calendarGoalDescendants, calendarGoalPath, calendarGoalLinks, calendarGoalDateLabel, openCalendarGoalEditor, openCalendarGoalDeletion,
} from './calendar-goals.js';

const keyOf = row => `${row.source_type}:${String(row.source_id)}`;
const openTask = row => !row.completed && !row.archived && !['done', 'skipped'].includes(row.status_extra);

/**
 * Opens the goal popup. Callbacks that leave the popup (select as main, add a
 * task, open a task, open another goal) close it first so their own dialogs are
 * never stacked under it; the goal editors open on top and refresh it.
 */
export function openCalendarGoalPopup({ document, invoke, goal, selection = {}, primaryGoalId, isCurrent = () => true, returnFocus, onClose,
  onSelectGoal, onCreateTask, onCreateSkillTask, onOpenTask, onOpenGoal } = {}) {
  const window = document.defaultView;
  const goalId = String(goal.id);
  let current = goal, goals = [goal], links = [], tasks = [], primaryId = primaryGoalId === undefined ? undefined : primaryGoalId == null ? null : String(primaryGoalId);
  let loaded = false, missing = false, revision = 0, development = null, child = null, leaving = false, closed = false;
  const dialog = createCalendarDialog({ document, title: goal.title || 'Цель', isCurrent, returnFocus: () => { if (!leaving) returnFocus?.(); },
    onClose: () => { closed = true; revision++; child?.dispose(); development?.dispose(); window.removeEventListener('task-state-changed', onExternal); window.removeEventListener('hanni:calendar-refresh', onExternal); onClose?.(); } });
  dialog.modal.classList.add('calendar-development-dialog', 'calendar-goal-popup');
  const headingContext = dialog.modal.querySelector('.calendar-editor-header > div');
  headingContext.tabIndex = 0;
  headingContext.setAttribute('role', 'group');
  headingContext.setAttribute('aria-labelledby', dialog.modal.getAttribute('aria-labelledby'));
  dialog.modal.dataset.goalPopup = goalId;
  dialog.modal.querySelector('footer [data-dialog-close]').textContent = 'Закрыть';
  const heading = dialog.modal.querySelector('h2'), hint = dialog.modal.querySelector(`#${dialog.modal.getAttribute('aria-describedby')}`);
  dialog.body.innerHTML = `<div class="goal-popup">
    <div class="goal-popup__actions" role="group" aria-label="Действия с целью">
      <button type="button" data-goal-popup-action="task" hidden>Добавить задачу</button>
      <button type="button" data-goal-popup-action="edit">Редактировать</button>
      <button type="button" data-goal-popup-action="select" hidden>Сделать главной</button>
      <button type="button" data-goal-popup-action="complete" hidden>Отметить достигнутой</button>
      <button type="button" data-goal-popup-action="subgoal" hidden>Подцель</button>
      <button type="button" data-goal-popup-action="delete">Удалить</button>
    </div>
    <nav class="goal-popup__nav" aria-label="Содержимое цели">
      <button type="button" data-goal-popup-jump="overview">Результат</button>
      <button type="button" data-goal-popup-jump="development">Этапы и навыки</button>
      <button type="button" data-goal-popup-jump="related">Задачи и подцели</button>
    </nav>
    <p class="goal-popup__status" data-goal-popup-status role="status"></p>
    <div class="goal-popup__overview" data-goal-overview tabindex="-1" aria-busy="true"></div>
    <div class="goal-popup__workgrid">
      <div class="goal-popup__development" data-goal-development tabindex="-1" hidden></div>
      <div class="goal-popup__related" data-goal-related tabindex="-1"></div>
    </div>
  </div>`;
  const overview = dialog.body.querySelector('[data-goal-overview]'), related = dialog.body.querySelector('[data-goal-related]'), status = dialog.body.querySelector('[data-goal-popup-status]');
  const button = name => dialog.body.querySelector(`[data-goal-popup-action="${name}"]`);
  const refocus = target => () => { if (!closed && target?.isConnected && !target.hidden && !target.disabled) target.focus(); else if (!closed) dialog.modal.querySelector('[data-dialog-close]')?.focus(); };
  const path = () => calendarGoalPath(goals, current);
  const ancestors = () => {
    const rows = [], seen = new Set([goalId]);
    let parentId = current.parent_goal_id;
    while (parentId != null && !seen.has(String(parentId))) {
      const parent = goals.find(item => String(item.id) === String(parentId));
      if (!parent) break;
      seen.add(String(parent.id)); rows.unshift(parent); parentId = parent.parent_goal_id;
    }
    return rows;
  };
  const isGoal = () => current.goal_kind === 'goal';
  // The task dialog owns focus while open; closing it restores the same goal.
  const returnToGoal = () => onOpenGoal ? onOpenGoal(current, returnFocus) : returnFocus?.();
  const descendants = () => [...calendarGoalDescendants(goals, goalId)].filter(id => id !== goalId);
  const linkedTasks = () => {
    const ids = new Set([goalId, ...descendants()]);
    const linked = new Set(links.filter(link => ids.has(String(link.goal_id))).map(keyOf));
    return tasks.filter(row => row.source_type === 'note' && linked.has(keyOf(row)));
  };

  function leave(run) {
    if (closed) return;
    leaving = true; dialog.close(); run();
  }
  function renderHeader() {
    heading.textContent = current.title || 'Без названия';
    const kind = current.goal_kind === 'daily_norm' ? 'Ежедневная норма' : current.goal_kind === 'goal' ? '' : 'Тип не выбран';
    const parts = [String(primaryId) === goalId && isGoal() ? 'Главная цель' : kind, current.status === 'achieved' ? 'Достигнута' : '', current.deadline ? `до ${calendarGoalDateLabel(current.deadline)}` : ''].filter(Boolean);
    hint.textContent = parts.join(' · ');
  }
  function field(label, html, name) {
    return `<section class="goal-popup__field" data-goal-field="${name}"><h3>${label}</h3><div class="goal-popup__value">${html}</div></section>`;
  }
  function renderOverview() {
    renderHeader();
    const sections = [], relatedSections = [];
    const parents = ancestors();
    if (parents.length) sections.push(field('Входит в', `<nav class="goal-popup__breadcrumbs" aria-label="Родительские цели">${parents.map(item => onOpenGoal ? `<button type="button" data-goal-popup-parent="${escapeHtml(String(item.id))}" aria-haspopup="dialog">${escapeHtml(item.title || 'Без названия')}</button>` : `<span>${escapeHtml(item.title || 'Без названия')}</span>`).join('<span aria-hidden="true"> / </span>')}</nav>`, 'path'));
    if (String(current.description || '').trim()) sections.push(field('Результат', `<p class="goal-popup__text">${escapeHtml(current.description)}</p>`, 'description'));
    const criteria = String(current.criteria || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (criteria.length) sections.push(field('Готово, когда', `<ul class="goal-popup__list">${criteria.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`, 'criteria'));
    if (current.goal_kind === 'daily_norm') sections.push(field('Норма', `<p>Каждый день: ${escapeHtml(`${formatNumber(current.target_value)} ${current.unit || ''}`.trim())}</p>`, 'norm'));
    const numeric = goalNumericProgress(current);
    if (numeric) sections.push(field('Измеримый результат', `<div class="goal-popup__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${numeric.percent}" aria-label="${escapeHtml(numeric.label)}"><span class="goal-popup__track" aria-hidden="true"><span style="width:${numeric.percent}%"></span></span><span>${escapeHtml(numeric.label)}</span></div>`, 'progress'));
    if (current.achievement) sections.push(field(current.status === 'achieved' ? 'Полученный результат' : 'Последний сохранённый результат', `<p class="goal-popup__text">${escapeHtml(current.achievement)}</p>`, 'achievement'));
    sections.push(field('Срок', `<p>${current.deadline ? escapeHtml(calendarGoalDateLabel(current.deadline)) : 'Срок не задан'}</p>`, 'deadline'));
    const subgoals = goals.filter(item => String(item.parent_goal_id) === goalId && item.goal_kind === 'goal');
    if (subgoals.length) relatedSections.push(field('Подцели', `<ul class="goal-popup__rows">${subgoals.map(item => `<li><button type="button" data-goal-popup-subgoal="${escapeHtml(item.id)}" aria-haspopup="dialog"><span>${escapeHtml(item.title || 'Без названия')}</span>${item.status === 'achieved' ? '<small>Достигнута</small>' : item.deadline ? `<small>до ${escapeHtml(calendarGoalDateLabel(item.deadline))}</small>` : ''}</button></li>`).join('')}</ul>`, 'subgoals'));
    const childIds = descendants(), summary = calendarGoalLinks(links, goalId, childIds);
    const linked = linkedTasks(), open = linked.filter(openTask), done = linked.filter(row => !openTask(row));
    const renderTasks = rows => rows.map(row => `<li><button type="button" data-goal-popup-task="${escapeHtml(keyOf(row))}" aria-haspopup="dialog"><span>${escapeHtml(row.title || 'Без названия')}</span><small>${row.archived ? 'В архиве' : row.completed || row.status_extra === 'done' ? 'Выполнено' : row.status_extra === 'skipped' ? 'Пропущено' : row.date ? escapeHtml(calendarGoalDateLabel(row.date)) : 'Без даты'}</small></button></li>`).join('');
    relatedSections.unshift(field('Задачи', summary
      ? `<p class="goal-popup__muted">Связано${childIds.length ? ', включая подцели' : ''}: ${escapeHtml(summary)}</p>${open.length ? `<ul class="goal-popup__rows">${renderTasks(open)}</ul>` : '<p class="goal-popup__muted">Открытых задач нет.</p>'}${done.length ? `<p class="goal-popup__muted goal-popup__task-history">Завершённые</p><ul class="goal-popup__rows goal-popup__rows--done">${renderTasks(done)}</ul>` : ''}`
      : '<p class="goal-popup__muted">Пока нет связанных задач. Цель можно сохранить без задач.</p>', 'tasks'));
    const focused = overview.contains(document.activeElement) || related.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && Object.entries(focused.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${String(value).replace(/["\\]/g, '\\$&')}"]`).join('');
    overview.innerHTML = sections.join('');
    related.innerHTML = relatedSections.join('');
    // A refresh must not drop keyboard focus from a subgoal or task link.
    if (focused) (focusKey && dialog.body.querySelector(focusKey) || dialog.modal.querySelector('[data-dialog-close]'))?.focus();
    overview.setAttribute('aria-busy', 'false');
    button('select').hidden = !onSelectGoal || !isGoal() || current.status === 'achieved' || primaryId === undefined || String(primaryId) === goalId;
    button('complete').hidden = !isGoal();
    button('complete').disabled = !!current.goal_metadata_error;
    button('complete').textContent = current.status === 'achieved' ? 'Вернуть в работу' : 'Отметить достигнутой';
    button('task').hidden = !onCreateTask || !isGoal();
    button('subgoal').hidden = !isGoal();
    dialog.body.querySelector('[data-goal-popup-jump="development"]').hidden = !isGoal();
  }
  async function load(canCommit = null) {
    if (closed || (canCommit && !canCommit())) return;
    const own = ++revision;
    try {
      const [loadedGoals, loadedLinks, loadedTasks, raw] = await Promise.all([
        invoke('get_goals', { tabName: null }), invoke('get_calendar_task_goals'), invoke('get_calendar_tasks', { includeCompleted: true }),
        primaryGoalId === undefined ? invoke('get_ui_state', { key: 'calendar_now_v1' }).catch(() => null) : null,
      ]);
      if (closed || own !== revision || (canCommit && !canCommit())) return;
      const fresh = loadedGoals.find(item => String(item.id) === goalId);
      goals = loadedGoals; links = loadedLinks; tasks = Array.isArray(loadedTasks) ? loadedTasks : []; loaded = true;
      if (primaryGoalId === undefined) { try { const saved = raw ? JSON.parse(raw) : null; primaryId = saved?.goalId == null ? null : String(saved.goalId); } catch { primaryId = null; } }
      if (!fresh) {
        missing = true; overview.innerHTML = '<p class="goal-popup__muted">Эта цель удалена или больше недоступна.</p>'; related.replaceChildren();
        dialog.body.querySelector('.goal-popup__actions').hidden = true; development?.dispose(); development = null;
        dialog.body.querySelector('[data-goal-development]').hidden = true; return;
      }
      current = fresh; renderOverview(); await development?.refresh();
      status.textContent = current.goal_metadata_error ? 'Не удалось прочитать состояние и этапы цели. Данные цели доступны, сохранение этапов остановлено.' : '';
    } catch {
      if (closed || own !== revision) return;
      if (!loaded) overview.innerHTML = '<p class="goal-popup__muted" role="alert">Не удалось загрузить подробности цели. Закрой окно и открой его снова.</p>';
      overview.setAttribute('aria-busy', 'false');
    }
  }
  function mountDevelopment() {
    if (goal.goal_kind !== 'goal') return;
    const host = dialog.body.querySelector('[data-goal-development]'); host.hidden = false;
    void mountGoalDevelopment(host, { invoke, goal, embedded: true, getTasks: () => tasks,
      onOpenTask: row => { if (onOpenTask) leave(() => onOpenTask(row, returnToGoal)); }, onCreateTask: skill => {
      if (onCreateSkillTask) leave(() => onCreateSkillTask(current, skill, returnToGoal));
    } }).then(async value => {
      if (closed) { value.dispose(); return; }
      development = value;
      if (loaded) await value.refresh();
      if (selection.skillId) {
        const skill = [...host.querySelectorAll('[data-dev-skill]')].find(item => item.dataset.devSkill === selection.skillId);
        if (skill) { skill.scrollIntoView?.({ block: 'center' }); skill.focus(); }
      }
    }).catch(error => { if (!closed) dialog.showError(error?.message || String(error)); });
  }
  // Local task and goal changes, or a remote sync; quiet health refreshes change nothing shown here.
  const onExternal = event => {
    if (child || missing || (event.type === 'hanni:calendar-refresh' && !event.detail?.remoteSync)) return;
    void load(event.detail?.remoteSync ? event.detail.canCommit : null);
  };
  function openStatusEditor(target) {
    if (child || missing) return;
    const achieved = current.status === 'achieved', captured = current;
    const nextStatus = achieved ? 'active' : 'achieved';
    const pendingTasks = linkedTasks().filter(openTask).length;
    const pendingGoals = goals.filter(row => row.goal_kind === 'goal' && descendants().includes(String(row.id)) && row.status !== 'achieved').length;
    const editor = createCalendarDialog({ document, title: achieved ? 'Вернуть цель в работу?' : 'Цель достигнута?',
      hint: achieved ? 'Сохранённый результат останется в цели.' : 'Сверь результат с критериями. Статус меняется по твоему решению.',
      submitLabel: achieved ? 'Вернуть в работу' : 'Отметить достигнутой', returnFocus: refocus(target),
      onClose: () => { child = null; if (!closed) void load(); } });
    child = editor;
    editor.body.innerHTML = `${captured.criteria ? `<p class="goal-popup__text">${escapeHtml(captured.criteria)}</p>` : '<p>Критерии пока не заданы.</p>'}
      ${pendingTasks || pendingGoals ? `<p class="goal-popup__muted">Остались открытые задачи: ${pendingTasks}; подцели в работе: ${pendingGoals}. Их статус не изменится.</p>` : ''}
      ${achieved ? '' : `<label>Полученный результат (необязательно)<textarea name="achievement" rows="4" maxlength="2000">${escapeHtml(captured.achievement || '')}</textarea></label>`}`;
    editor.form.addEventListener('submit', async event => {
      event.preventDefault(); if (editor.pending) return;
      editor.setPending(true); editor.showError('');
      try {
        await invoke('set_calendar_goal_status', { id: goalId, status: nextStatus, expectedStatus: captured.status || 'active', expectedUpdatedAt: captured.updated_at || null,
          achievement: achieved ? null : editor.body.querySelector('[name=achievement]').value.trim() });
        editor.setPending(false); editor.close();
        window.dispatchEvent(new window.Event('task-state-changed'));
        await load();
      } catch (error) {
        editor.setPending(false);
        editor.showError(/stale|changed|reopen/.test(String(error)) ? 'Цель изменилась. Закрой это окно и проверь актуальные данные перед повторением.' : error?.message || String(error));
      }
    });
    editor.open();
  }
  dialog.body.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target || target.disabled || closed || dialog.pending) return;
    const action = target.dataset.goalPopupAction;
    if (target.dataset.goalPopupJump) {
      const host = dialog.body.querySelector(`[data-goal-${target.dataset.goalPopupJump}]`);
      if (host && !host.hidden) { host.scrollIntoView?.({ block:'start', behavior:'smooth' }); host.focus({preventScroll:true}); }
      return;
    }
    if (action === 'select') leave(() => onSelectGoal(goalId));
    else if (action === 'task') leave(() => onCreateTask({ goalId: current.id, title: current.title, path: path().join(' → ') }, returnToGoal));
    else if (action === 'complete') openStatusEditor(target);
    else if (action === 'edit' || action === 'subgoal') {
      if (child) return;
      child = openCalendarGoalEditor({ document, invoke, goal: action === 'edit' ? current : null, parent: action === 'subgoal' ? current : null, goals,
        returnFocus: refocus(target), onClose: () => { child = null; }, onSaved: () => load() });
    } else if (action === 'delete') {
      if (child) return;
      child = openCalendarGoalDeletion({ document, invoke, goal: current, returnFocus: refocus(target), onClose: () => { child = null; },
        onDeleted: () => { missing = true; dialog.close(); } });
    } else if (target.dataset.goalPopupSubgoal || target.dataset.goalPopupParent) {
      const nextId = target.dataset.goalPopupSubgoal || target.dataset.goalPopupParent;
      const next = goals.find(item => String(item.id) === nextId);
      if (next && onOpenGoal) leave(() => onOpenGoal(next, returnFocus));
    } else if (target.dataset.goalPopupTask) {
      const row = tasks.find(item => keyOf(item) === target.dataset.goalPopupTask);
      if (row && onOpenTask) leave(() => onOpenTask(row, returnToGoal));
    }
  });
  window.addEventListener('task-state-changed', onExternal);
  window.addEventListener('hanni:calendar-refresh', onExternal);
  renderHeader();
  dialog.open(dialog.modal.querySelector('[data-dialog-close]'));
  heading.tabIndex = -1; heading.focus();
  mountDevelopment();
  const ready = load();
  return { dialog, ready, close: () => dialog.close(), dispose: () => dialog.dispose(), refresh: load };
}
