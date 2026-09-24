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

const TASK_LIMIT = 8;
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
  let running = false, loaded = false, missing = false, revision = 0, development = null, child = null, leaving = false, closed = false;
  const dialog = createCalendarDialog({ document, title: goal.title || 'Цель', isCurrent, returnFocus: () => { if (!leaving) returnFocus?.(); },
    onClose: () => { closed = true; revision++; child?.dispose(); development?.dispose(); window.removeEventListener('task-state-changed', onExternal); window.removeEventListener('hanni:calendar-refresh', onExternal); onClose?.(); } });
  dialog.modal.classList.add('calendar-development-dialog', 'calendar-goal-popup');
  dialog.modal.dataset.goalPopup = goalId;
  dialog.modal.querySelector('footer [data-dialog-close]').textContent = 'Закрыть';
  const heading = dialog.modal.querySelector('h2'), hint = dialog.modal.querySelector(`#${dialog.modal.getAttribute('aria-describedby')}`);
  dialog.body.innerHTML = `<div class="goal-popup">
    <div class="goal-popup__actions" role="group" aria-label="Действия с целью">
      <button type="button" data-goal-popup-action="select" hidden>Сделать главной</button>
      <button type="button" data-goal-popup-action="edit">Редактировать</button>
      <button type="button" data-goal-popup-action="task" hidden>Добавить задачу</button>
      <button type="button" data-goal-popup-action="subgoal" hidden>Подцель</button>
      <button type="button" data-goal-popup-action="delete">Удалить</button>
    </div>
    <p class="goal-popup__status" data-goal-popup-status role="status"></p>
    <div class="goal-popup__overview" data-goal-overview aria-busy="true"></div>
    <div class="goal-popup__development" data-goal-development hidden></div>
  </div>`;
  const overview = dialog.body.querySelector('[data-goal-overview]'), status = dialog.body.querySelector('[data-goal-popup-status]');
  const button = name => dialog.body.querySelector(`[data-goal-popup-action="${name}"]`);
  const refocus = target => () => { if (!closed && target?.isConnected && !target.hidden && !target.disabled) target.focus(); else if (!closed) dialog.modal.querySelector('[data-dialog-close]')?.focus(); };
  const path = () => calendarGoalPath(goals, current);
  const isGoal = () => current.goal_kind === 'goal';

  function leave(run) {
    if (closed) return;
    leaving = true; dialog.close(); run();
  }
  function renderHeader() {
    heading.textContent = current.title || 'Без названия';
    const kind = current.goal_kind === 'daily_norm' ? 'Ежедневная норма' : current.goal_kind === 'goal' ? '' : 'Тип не выбран';
    const parts = [String(primaryId) === goalId && isGoal() ? 'Главная цель' : kind, current.deadline ? `до ${calendarGoalDateLabel(current.deadline)}` : ''].filter(Boolean);
    hint.textContent = parts.join(' · ');
  }
  function field(label, html, name) {
    return `<section class="goal-popup__field" data-goal-field="${name}"><h3>${label}</h3><div class="goal-popup__value">${html}</div></section>`;
  }
  function renderOverview() {
    renderHeader();
    const sections = [];
    const trail = path();
    if (trail.length > 1) sections.push(field('Входит в', `<p>${trail.slice(0, -1).map(escapeHtml).join(' → ')}</p>`, 'path'));
    if (String(current.description || '').trim()) sections.push(field('Результат', `<p class="goal-popup__text">${escapeHtml(current.description)}</p>`, 'description'));
    const criteria = String(current.criteria || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (criteria.length) sections.push(field('Готово, когда', `<ul class="goal-popup__list">${criteria.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`, 'criteria'));
    if (current.goal_kind === 'daily_norm') sections.push(field('Норма', `<p>Каждый день: ${escapeHtml(`${formatNumber(current.target_value)} ${current.unit || ''}`.trim())}</p>`, 'norm'));
    const numeric = goalNumericProgress(current);
    if (numeric) sections.push(field('Прогресс', `<div class="goal-popup__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${numeric.percent}" aria-label="${escapeHtml(numeric.label)}"><span class="goal-popup__track" aria-hidden="true"><span style="width:${numeric.percent}%"></span></span><span>${escapeHtml(numeric.label)}</span></div>`, 'progress'));
    sections.push(field('Срок', `<p>${current.deadline ? escapeHtml(calendarGoalDateLabel(current.deadline)) : 'Срок не задан'}</p>`, 'deadline'));
    const subgoals = goals.filter(item => String(item.parent_goal_id) === goalId && item.goal_kind === 'goal');
    if (subgoals.length) sections.push(field('Подцели', `<ul class="goal-popup__rows">${subgoals.map(item => `<li><button type="button" data-goal-popup-subgoal="${escapeHtml(item.id)}" aria-haspopup="dialog"><span>${escapeHtml(item.title || 'Без названия')}</span>${item.deadline ? `<small>до ${escapeHtml(calendarGoalDateLabel(item.deadline))}</small>` : ''}</button></li>`).join('')}</ul>`, 'subgoals'));
    const descendants = [...calendarGoalDescendants(goals, goalId)].filter(id => id !== goalId);
    const summary = calendarGoalLinks(links, goalId, descendants);
    const ids = new Set([goalId, ...descendants]), linked = new Set(links.filter(link => ids.has(String(link.goal_id))).map(keyOf));
    const open = tasks.filter(row => row.source_type === 'note' && linked.has(keyOf(row)) && openTask(row));
    const taskRows = open.slice(0, TASK_LIMIT).map(row => `<li><button type="button" data-goal-popup-task="${escapeHtml(keyOf(row))}" aria-haspopup="dialog"><span>${escapeHtml(row.title || 'Без названия')}</span><small>${row.date ? escapeHtml(calendarGoalDateLabel(row.date)) : 'Без даты'}</small></button></li>`).join('');
    const more = open.length > TASK_LIMIT ? `<p class="goal-popup__muted">И ещё ${open.length - TASK_LIMIT} — все задачи цели во вкладке «Задачи».</p>` : '';
    sections.push(field('Задачи', summary
      ? `<p class="goal-popup__muted">Связано${descendants.length ? ', включая подцели' : ''}: ${escapeHtml(summary)}</p>${taskRows ? `<ul class="goal-popup__rows">${taskRows}</ul>` : '<p class="goal-popup__muted">Открытых задач нет.</p>'}${more}`
      : '<p class="goal-popup__muted">Пока нет связанных задач. Цель можно сохранить без задач.</p>', 'tasks'));
    const focused = overview.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && Object.entries(focused.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${String(value).replace(/["\\]/g, '\\$&')}"]`).join('');
    overview.innerHTML = sections.join('');
    // A refresh must not drop keyboard focus from a subgoal or task link.
    if (focused) (focusKey && overview.querySelector(focusKey) || dialog.modal.querySelector('[data-dialog-close]'))?.focus();
    overview.setAttribute('aria-busy', 'false');
    button('select').hidden = !onSelectGoal || !isGoal() || primaryId === undefined || String(primaryId) === goalId;
    button('select').disabled = running;
    button('select').title = running ? 'Поставь задачи на паузу, чтобы сменить главную цель' : '';
    button('task').hidden = !onCreateTask || !isGoal();
    button('subgoal').hidden = !isGoal();
  }
  async function load(canCommit = null) {
    if (closed || (canCommit && !canCommit())) return;
    const own = ++revision;
    try {
      const [loadedGoals, loadedLinks, loadedTasks, active, raw] = await Promise.all([
        invoke('get_goals', { tabName: null }), invoke('get_calendar_task_goals'), invoke('get_calendar_tasks', {}).catch(() => []),
        invoke('get_active_block').catch(() => null), primaryGoalId === undefined ? invoke('get_ui_state', { key: 'calendar_now_v1' }).catch(() => null) : null,
      ]);
      if (closed || own !== revision || (canCommit && !canCommit())) return;
      const fresh = loadedGoals.find(item => String(item.id) === goalId);
      goals = loadedGoals; links = loadedLinks; tasks = Array.isArray(loadedTasks) ? loadedTasks : []; running = !!active; loaded = true;
      if (primaryGoalId === undefined) { try { const saved = raw ? JSON.parse(raw) : null; primaryId = saved?.goalId == null ? null : String(saved.goalId); } catch { primaryId = null; } }
      if (!fresh) {
        missing = true; overview.innerHTML = '<p class="goal-popup__muted">Эта цель удалена или больше недоступна.</p>';
        dialog.body.querySelector('.goal-popup__actions').hidden = true; development?.dispose(); development = null;
        dialog.body.querySelector('[data-goal-development]').hidden = true; return;
      }
      current = fresh; renderOverview();
    } catch {
      if (closed || own !== revision) return;
      if (!loaded) overview.innerHTML = '<p class="goal-popup__muted" role="alert">Не удалось загрузить подробности цели. Закрой окно и открой его снова.</p>';
      overview.setAttribute('aria-busy', 'false');
    }
  }
  function mountDevelopment() {
    if (goal.goal_kind !== 'goal') return;
    const host = dialog.body.querySelector('[data-goal-development]'); host.hidden = false;
    void mountGoalDevelopment(host, { invoke, goal, embedded: true, onCreateTask: skill => {
      if (onCreateSkillTask) leave(() => onCreateSkillTask(current, skill, returnFocus));
    } }).then(value => {
      if (closed) { value.dispose(); return; }
      development = value;
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
  dialog.body.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target || target.disabled || closed || dialog.pending) return;
    const action = target.dataset.goalPopupAction;
    if (action === 'select') leave(() => onSelectGoal(goalId));
    else if (action === 'task') leave(() => onCreateTask({ goalId: current.id, title: current.title, path: path().join(' → ') }, returnFocus));
    else if (action === 'edit' || action === 'subgoal') {
      if (child) return;
      child = openCalendarGoalEditor({ document, invoke, goal: action === 'edit' ? current : null, parent: action === 'subgoal' ? current : null, goals,
        returnFocus: refocus(target), onClose: () => { child = null; }, onSaved: () => load() });
    } else if (action === 'delete') {
      if (child) return;
      child = openCalendarGoalDeletion({ document, invoke, goal: current, returnFocus: refocus(target), onClose: () => { child = null; },
        onDeleted: () => { missing = true; dialog.close(); } });
    } else if (target.dataset.goalPopupSubgoal) {
      const next = goals.find(item => String(item.id) === target.dataset.goalPopupSubgoal);
      if (next && onOpenGoal) leave(() => onOpenGoal(next, returnFocus));
    } else if (target.dataset.goalPopupTask) {
      const row = tasks.find(item => keyOf(item) === target.dataset.goalPopupTask);
      if (row && onOpenTask) leave(() => onOpenTask(row, returnFocus));
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
