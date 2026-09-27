import { createRecurringStore, recurringItems, unfinishedRun } from './calendar-recurring-store.js';

/** The existing routine store owns marks/runs; this picker owns no parallel state. */
export function mountCalendarRoutineChoices(element, { invoke, openRoutine, openManager, notifyChange, now = () => new Date() }) {
  const document = element.ownerDocument, window = document.defaultView;
  const store = createRecurringStore(invoke, { now });
  let disposed = false, busy = false, revision = 0, items = [], signature = '';
  element.className = 'calendar-routine-choices';
  element.innerHTML = '<div class="calendar-routine-choices__heading"><h3>Рутины</h3><button type="button" data-routine-manager>Мои рутины</button></div><p data-routine-empty>Загружаем рутины…</p><ul data-routine-list></ul><p role="alert" data-routine-error hidden></p><button type="button" data-routine-retry hidden>Повторить</button>';
  const list = element.querySelector('[data-routine-list]'), empty = element.querySelector('[data-routine-empty]'), error = element.querySelector('[data-routine-error]'), retry = element.querySelector('[data-routine-retry]');
  const fail = cause => { error.textContent = cause?.message || (typeof cause === 'string' ? cause : 'Не удалось загрузить рутины. Повтори попытку.'); error.hidden = false; retry.hidden = false; };
  const candidates = state => {
    const date = store.today();
    const values = recurringItems(state, date).filter(item => item.kind === 'action' && item.active && item.status === 'pending');
    // An unfinished chain remains resumable even on its next non-scheduled day.
    for (const plan of state.plans) if (plan.active && plan.kind === 'action' && !values.some(item => item.id === plan.id) && unfinishedRun(state, plan.id)) values.push(plan);
    return values.map(item => { const run = unfinishedRun(state, item.id); return { ...item, date:run?.date || date, resumable:!!run, runnable:['activity','chain','graph'].includes(item.mode) || !!run }; });
  };
  function paint() {
    if (disposed) return;
    const next = JSON.stringify(items);
    if (signature !== next) {
      const focused = document.activeElement?.dataset?.routineChoice;
      list.replaceChildren(...items.map(item => {
        const row = document.createElement('li'), info = document.createElement('span'), title = document.createElement('span'), kind = document.createElement('small'), button = document.createElement('button');
        title.textContent = item.title; kind.textContent = item.mode === 'graph' ? `${item.steps?.length || 0} связанных шагов` : item.mode === 'chain' ? `${item.steps?.length || 0} шагов` : item.runnable ? 'С учётом времени' : 'Отметка без таймера';
        info.append(title, kind); button.type = 'button'; button.dataset.routineChoice = item.id;
        button.textContent = item.resumable ? 'Продолжить' : item.runnable ? 'Начать' : 'Готово';
        button.setAttribute('aria-label', `${button.textContent}: ${item.title}`); row.append(info, button); return row;
      }));
      signature = next;
      if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.routineChoice === focused)?.focus();
    }
    empty.hidden = !!items.length; empty.textContent = 'На сегодня нет неотмеченных рутин.';
    element.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  }
  async function refresh() {
    if (disposed || busy) return;
    const request = ++revision;
    try { const state = await store.read(); if (disposed || request !== revision) return; items = candidates(state); error.hidden = retry.hidden = true; paint(); }
    catch (cause) { if (!disposed && request === revision) { empty.textContent = ''; fail(cause); } }
  }
  async function choose(id) {
    if (disposed || busy) return;
    busy = true; ++revision; paint(); error.hidden = retry.hidden = true;
    try {
      // Revalidate at the click, including marks synchronized since the last render.
      const fresh = candidates(await store.read()).find(item => item.id === id);
      if (disposed) return;
      if (!fresh) throw Error('Рутина уже отмечена или изменена. Обнови список.');
      if (fresh.runnable) await openRoutine({ id:fresh.id, date:fresh.date, start:true });
      else { await store.setStatus(fresh.id, 'done', fresh.date); notifyChange?.(); }
    } catch (cause) { if (!disposed) fail(cause); }
    finally {
      busy = false;
      if (!disposed) { paint(); if (error.hidden) await refresh(); }
    }
  }
  const onClick = event => { const button = event.target.closest('[data-routine-choice]'); if (button && !button.disabled) void choose(button.dataset.routineChoice); };
  const onRefresh = () => void refresh();
  list.addEventListener('click', onClick); retry.onclick = onRefresh;
  element.querySelector('[data-routine-manager]').onclick = () => { if (!busy) openManager?.(); };
  window.addEventListener('hanni:calendar-refresh', onRefresh); void refresh();
  return () => { disposed = true; ++revision; list.removeEventListener('click', onClick); window.removeEventListener('hanni:calendar-refresh', onRefresh); };
}
