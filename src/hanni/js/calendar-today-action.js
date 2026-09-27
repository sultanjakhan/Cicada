import { mountCalendarNextAction } from './calendar-next-action.js';
import { mountCalendarRoutineChoices } from './calendar-routine-choices.js';
import { mountCalendarDashboardTasks } from './calendar-dashboard-tasks.js';
import { mountRecurringRun } from './calendar-routine-execution.js';

// Presentation only: recommendation, selection and execution share the existing stores.
export function mountCalendarTodayAction(element, dependencies) {
  const document = element.ownerDocument;
  let disposed = false, mode = 'recommendation', disposeRun = null, disposeChoices = null, disposeTasks = null;
  element.classList.add('calendar-today-action');
  element.innerHTML = `<header class="calendar-today-action__heading"><h2 tabindex="-1">Что сделать сейчас</h2><button type="button" data-today-choose aria-expanded="false">Выбрать другое</button></header>
    <div data-today-recommendation></div>
    <section data-today-choices hidden aria-label="Выбрать дело"><div class="calendar-today-action__scopes" role="group" aria-label="Что выбрать"><button type="button" data-today-scope="routines" aria-pressed="true">Рутины</button><button type="button" data-today-scope="tasks" aria-pressed="false">Задачи</button></div><div data-today-routines></div><div data-today-task-choices hidden></div></section>
    <div data-today-run hidden></div>
    <footer class="calendar-today-action__footer"><button type="button" data-today-settings>Настроить рекомендации</button><button type="button" data-today-all-tasks>Все задачи</button></footer>`;
  const q = selector => element.querySelector(selector);
  const recommendation = q('[data-today-recommendation]'), choices = q('[data-today-choices]'), run = q('[data-today-run]'), choose = q('[data-today-choose]');
  const focus = () => q('.calendar-today-action__heading h2').focus({preventScroll:true});
  function clearRun() { disposeRun?.(); disposeRun = null; run.replaceChildren(); dependencies.onRoutineFocusChange?.(null); }
  function setMode(next) {
    if (disposed || disposeRun?.isBusy?.()) return false;
    if (next !== 'run') clearRun();
    mode = next;
    recommendation.hidden = next !== 'recommendation'; choices.hidden = next !== 'choices'; run.hidden = next !== 'run';
    choose.textContent = next === 'choices' ? 'К рекомендации' : 'Выбрать другое';
    choose.setAttribute('aria-expanded', String(next === 'choices'));
    element.dataset.mode = next;
    return true;
  }
  function openRoutine(options) {
    if (!setMode('run')) return false;
    clearRun();
    dependencies.onRoutineFocusChange?.(options);
    disposeRun = mountRecurringRun(run, { document, invoke:dependencies.invoke, ...options, onClose:() => {
      if (setMode('recommendation')) { void controller.refresh(); choose.focus({preventScroll:true}); }
    }});
    return true;
  }
  const controller = mountCalendarNextAction(recommendation, {
    ...dependencies, hideHeading:true, onOpenSettings:null, openRoutine,
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
        executeAction:async (row, action) => {
          const result = await dependencies.taskOptions.executeAction(row, action);
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
  q('[data-today-settings]').onclick = event => dependencies.onOpenSettings?.(event.currentTarget);
  q('[data-today-all-tasks]').onclick = () => dependencies.openTasks?.();
  const dispose = () => { disposed = true; controller(); clearRun(); disposeChoices?.(); disposeTasks?.(); };
  dispose.focus = focus;
  dispose.refresh = controller.refresh;
  dispose.setPreferences = controller.setPreferences;
  dispose.openRoutine = openRoutine;
  dispose.choose = openChoices;
  return dispose;
}
