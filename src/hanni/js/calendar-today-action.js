import { createUiCopy } from './ui-copy.js';
const uiCopy = value => createUiCopy(globalThis.document)(value);
import { mountCalendarNextAction } from './calendar-next-action.js';
import { mountCalendarRoutineChoices } from './calendar-routine-choices.js';
import { mountCalendarDashboardTasks } from './calendar-dashboard-tasks.js';
import { mountRecurringRun } from './calendar-routine-execution.js';

// Presentation only: recommendation, selection and execution share the existing stores.
export function mountCalendarTodayAction(element, dependencies) {
  const document = element.ownerDocument;
  const uiCopy = createUiCopy(document);
  let disposed = false, mode = 'recommendation', disposeRun = null, disposeChoices = null, disposeTasks = null, currentRecommendation = null;
  element.classList.add('calendar-today-action');
  element.innerHTML = `<header class="calendar-today-action__heading"><h2 tabindex="-1">${uiCopy("Что сделать сейчас")}</h2><button type="button" data-today-choose aria-expanded="false">${uiCopy("Выбрать другое")}</button></header>
    <div data-today-recommendation></div>
    <section data-today-choices hidden aria-label="${uiCopy("Выбрать дело")}"><div class="calendar-today-action__scopes" role="group" aria-label="${uiCopy("Что выбрать")}"><button type="button" data-today-scope="routines" aria-pressed="true">${uiCopy("Рутины")}</button><button type="button" data-today-scope="tasks" aria-pressed="false">${uiCopy("Задачи")}</button></div><div data-today-routines></div><div data-today-task-choices hidden></div></section>
    <div data-today-run hidden></div>`;
  const q = selector => element.querySelector(selector);
  const recommendation = q('[data-today-recommendation]'), choices = q('[data-today-choices]'), run = q('[data-today-run]'), choose = q('[data-today-choose]');
  const heading = q('.calendar-today-action__heading h2');
  heading.dataset.todayTitle = '';
  const focus = () => heading.focus({preventScroll:true});
  function syncCurrentTask(selection = currentRecommendation) {
    const candidate = mode === 'recommendation' && selection?.type === 'task' ? selection.task : null;
    const hasWork = Boolean(candidate?.has_work || Number(candidate?.actual_seconds) > 0 || Number(candidate?.actual_minutes) > 0);
    const task = candidate && (selection.action === 'open' || hasWork) ? candidate : null;
    heading.textContent = task ? uiCopy('Сейчас') : uiCopy('Что сделать сейчас');
    dependencies.onCurrentTaskChange?.(task);
  }
  function clearRun() { disposeRun?.(); disposeRun = null; run.replaceChildren(); dependencies.onRoutineFocusChange?.(null); }
  function setMode(next) {
    if (disposed || disposeRun?.isBusy?.()) return false;
    if (next !== 'run') clearRun();
    mode = next;
    recommendation.hidden = next !== 'recommendation'; choices.hidden = next !== 'choices'; run.hidden = next !== 'run';
    choose.textContent = next === 'choices' ? uiCopy('К рекомендации') : uiCopy('Выбрать другое');
    choose.setAttribute('aria-expanded', String(next === 'choices'));
    element.dataset.mode = next;
    syncCurrentTask();
    return true;
  }
  function openRoutine(options) {
    if (!setMode('run')) return false;
    controller.setCurrentTask(null);
    clearRun();
    dependencies.onRoutineFocusChange?.(options);
    const returnToRecommendation = () => {
      if (setMode('recommendation')) { void controller.refresh(); choose.focus({preventScroll:true}); }
    };
    disposeRun = mountRecurringRun(run, { document, invoke:dependencies.invoke, ...options,
      onClose:returnToRecommendation, onTerminal:returnToRecommendation,
    });
    return true;
  }
  const controller = mountCalendarNextAction(recommendation, {
    ...dependencies, hideHeading:true, onOpenSettings:null, openRoutine,
    onSelectionChange: selection => { currentRecommendation = selection; syncCurrentTask(selection); },
  });
  function selectScope(scope) {
    q('[data-today-routines]').hidden = scope !== 'routines';
    q('[data-today-task-choices]').hidden = scope !== 'tasks';
    element.querySelectorAll('[data-today-scope]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.todayScope === scope)));
    if (scope === 'routines' && !disposeChoices) disposeChoices = mountCalendarRoutineChoices(q('[data-today-routines]'), {
      invoke:dependencies.invoke, notifyChange:dependencies.notifyChange, openRoutine, openManager:dependencies.openRoutines,
    });
    if (scope === 'tasks' && !disposeTasks) {
      disposeTasks = mountCalendarDashboardTasks(q('[data-today-task-choices]'), {
        ...dependencies.taskOptions,
        openTask: row => {
          controller.setCurrentTask(row);
          if (setMode('recommendation')) focus();
        },
        executeAction:async (row, action) => {
          const result = await dependencies.taskOptions.executeAction(row, action);
          if (result !== false && !disposed && action === 'start') controller.setCurrentTask(row);
          if (result !== false && !disposed && ['start','finish'].includes(action)) { setMode('recommendation'); focus(); }
          return result;
        },
      });
      disposeTasks.showAll();
    }
  }
  const openChoices = (scope = 'routines') => {
    if (setMode('choices')) { selectScope(scope); q(`[data-today-scope="${scope}"]`).focus({preventScroll:true}); }
  };
  choose.onclick = () => {
    if (mode === 'choices') { if(setMode('recommendation')) choose.focus({preventScroll:true}); }
    else openChoices();
  };
  element.querySelectorAll('[data-today-scope]').forEach(button => { button.onclick = () => selectScope(button.dataset.todayScope); });
  const dispose = () => { disposed = true; controller(); clearRun(); disposeChoices?.(); disposeTasks?.(); };
  dispose.focus = focus;
  dispose.refresh = controller.refresh;
  dispose.setPreferences = controller.setPreferences;
  dispose.setFocusedTaskVisible = controller.setFocusedTaskVisible;
  dispose.openRoutine = openRoutine;
  dispose.choose = openChoices;
  // Restore the chosen run as a view only, before an automatic recommendation
  // can replace it. Existing native blocks continue without a new start.
  if (dependencies.initialTask?.source_type === 'schedule') {
    try {
      const [id,date] = JSON.parse(dependencies.initialTask.source_id);
      if (typeof id === 'string' && typeof date === 'string') openRoutine({id,date,start:false});
    } catch { /* An invalid device-local selection never starts work. */ }
  }
  return dispose;
}
