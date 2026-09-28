import { mountCalendarNextAction } from './calendar-next-action.js';
import { mountCalendarRoutineChoices } from './calendar-routine-choices.js';
import { mountCalendarDashboardTasks } from './calendar-dashboard-tasks.js';
import { mountRecurringRun } from './calendar-routine-execution.js';

// Presentation only: recommendation, selection and execution share the existing stores.
export function mountCalendarTodayAction(element, dependencies) {
  const document = element.ownerDocument;
  let disposed = false, mode = 'recommendation', disposeRun = null, disposeChoices = null, disposeTasks = null, currentRecommendation = null, runningTaskCount = 0;
  element.classList.add('calendar-today-action');
  element.innerHTML = `<header class="calendar-today-action__heading"><h2 tabindex="-1">Что сделать сейчас</h2><button type="button" data-today-choose aria-expanded="false">Выбрать другое</button></header>
    <div class="calendar-today-action__parallel" data-today-parallel hidden><span data-today-running-count></span><button type="button" data-today-start-another aria-expanded="false">Начать ещё задачу</button></div>
    <div data-today-recommendation></div>
    <section data-today-choices hidden aria-label="Выбрать дело"><div class="calendar-today-action__scopes" role="group" aria-label="Что выбрать"><button type="button" data-today-scope="routines" aria-pressed="true">Рутины</button><button type="button" data-today-scope="tasks" aria-pressed="false">Задачи</button></div><div data-today-routines></div><div data-today-task-choices hidden></div></section>
    <div data-today-run hidden></div>`;
  const q = selector => element.querySelector(selector);
  const recommendation = q('[data-today-recommendation]'), choices = q('[data-today-choices]'), run = q('[data-today-run]'), choose = q('[data-today-choose]');
  const heading = q('.calendar-today-action__heading h2');
  const parallel = q('[data-today-parallel]'), startAnother = q('[data-today-start-another]');
  heading.dataset.todayTitle = '';
  const focus = () => heading.focus({preventScroll:true});
  function renderParallel() {
    parallel.hidden = runningTaskCount === 0 || mode === 'choices';
    q('[data-today-running-count]').textContent = `В работе: ${runningTaskCount}`;
    startAnother.setAttribute('aria-expanded', String(mode === 'choices'));
  }
  function syncCurrentTask(selection = currentRecommendation) {
    const candidate = mode === 'recommendation' && selection?.type === 'task' ? selection.task : null;
    const hasWork = Boolean(candidate?.has_work || Number(candidate?.actual_seconds) > 0 || Number(candidate?.actual_minutes) > 0);
    const task = candidate && (selection.action === 'open' || hasWork) ? candidate : null;
    heading.textContent = task ? 'Сейчас' : 'Что сделать сейчас';
    dependencies.onCurrentTaskChange?.(task);
  }
  function clearRun() { disposeRun?.(); disposeRun = null; run.replaceChildren(); dependencies.onRoutineFocusChange?.(null); }
  function setMode(next) {
    if (disposed || disposeRun?.isBusy?.()) return false;
    if (next !== 'run') clearRun();
    mode = next;
    recommendation.hidden = next !== 'recommendation'; choices.hidden = next !== 'choices'; run.hidden = next !== 'run';
    choose.textContent = next === 'choices' ? 'К рекомендации' : 'Выбрать другое';
    choose.setAttribute('aria-expanded', String(next === 'choices'));
    element.dataset.mode = next;
    renderParallel();
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
  startAnother.onclick = () => openChoices('tasks');
  choose.onclick = () => {
    if (mode === 'choices') { if(setMode('recommendation')) choose.focus({preventScroll:true}); }
    else openChoices();
  };
  element.querySelectorAll('[data-today-scope]').forEach(button => { button.onclick = () => selectScope(button.dataset.todayScope); });
  const dispose = () => { disposed = true; controller(); clearRun(); disposeChoices?.(); disposeTasks?.(); };
  dispose.setRunningTaskCount = count => { if (!disposed) { runningTaskCount = count; renderParallel(); } };
  dispose.focus = focus;
  dispose.refresh = controller.refresh;
  dispose.setPreferences = controller.setPreferences;
  dispose.setFocusedTaskVisible = controller.setFocusedTaskVisible;
  dispose.openRoutine = openRoutine;
  dispose.choose = openChoices;
  return dispose;
}
