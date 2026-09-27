import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringSourceId, unfinishedRun, availableGraphSteps } from './calendar-recurring-store.js';
import { startCalendarExecution, readActiveBlocks } from './calendar-execution.js';

const openDialogs = new WeakMap();

/** Mounts the shared routine runner into an existing surface; it never owns or pauses other work. */
export function mountRecurringRun(element, { document = element.ownerDocument, invoke, id, date, start = false, onClose, dialog = null } = {}) {
  const win = document.defaultView, store = createRecurringStore(invoke);
  const createRunOnRetry = start;
  let disposed = false, busy = false, observedRun = false, origin = date || store.today(), record = null, routineTitle = '', rows = [], activeBlocks = [], current = -1, readVersion = 0, rendered = '', clockTimer = null, error = '';
  const inline = !dialog;
  if (inline) element.classList.add('calendar-routine-inline');

  const notify = () => {
    win.dispatchEvent(new win.Event('task-state-changed'));
    win.dispatchEvent(new win.Event('hanni:recurring-changed'));
    win.dispatchEvent(new win.Event('hanni:calendar-refresh'));
  };
  const graph = () => record?.snapshot?.mode === 'graph';
  const available = () => graph() ? availableGraphSteps(record.snapshot, record.run) : [];
  const scheduleRow = index => rows.find(row => String(row.id) === recurringSourceId(id, origin, index));
  const setBusy = value => {
    busy = value;
    if (dialog) dialog.setPending(value);
    else {
      element.setAttribute('aria-busy', String(value));
      element.querySelectorAll('button').forEach(button => { button.disabled = value; });
    }
    render();
  };
  const showError = message => {
    error = message || '';
    if (dialog) dialog.showError(error);
    render();
  };
  const runButton = (label, action, index = current) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.setAttribute('aria-label', `${label}: ${record.run.steps[index].title}`);
    node.dataset.runAction = action; node.dataset.runStep = String(index);
    node.disabled = busy;
    node.addEventListener('click', () => { if (!busy) { current = index; void perform(action, index); } });
    return node;
  };
  function chooseCurrent() {
    if (!record) return;
    if (!graph()) { current = record.run.steps.findIndex(step => step.status === 'pending'); return; }
    const open = available();
    if (open.includes(current)) return;
    const active = open.find(index => scheduleRow(index)?.is_active);
    current = active ?? (open.length === 1 ? open[0] : -1);
  }
  function tick() {
    element.querySelectorAll('[data-run-clock]').forEach(node => {
      const index = Number(node.dataset.runClock), row = scheduleRow(index);
      const block = activeBlocks.find(value => value.source_type === 'schedule' && String(value.source_id) === recurringSourceId(id, origin, index));
      const elapsed = block ? Math.max(0, Math.floor((Date.now() - new Date(`${block.date}T${block.start_time}`).getTime()) / 1000)) : 0;
      const seconds = Math.max(0, Number(row?.actual_seconds) || 0) + (Number.isFinite(elapsed) ? elapsed : 0);
      node.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    });
  }
  function render() {
    if (disposed) return;
    const focused = element.contains(document.activeElement) ? {
      action: document.activeElement.dataset.runAction,
      step: document.activeElement.dataset.runStep,
      close: document.activeElement.hasAttribute('data-run-close'),
      retry: document.activeElement.hasAttribute('data-run-retry'),
    } : null;
    const expanded = element.querySelector('[data-run-plan]')?.open || false;
    const signature = JSON.stringify([record, rows.map(row => [row.id, row.is_active, row.has_work, row.actual_seconds]), current, busy, error]);
    if (signature === rendered) { tick(); return; }
    rendered = signature;
    element.replaceChildren();
    if (inline) {
      const header = document.createElement('header'); header.className = 'calendar-run-heading';
      const heading = document.createElement('h3'); heading.tabIndex = -1; heading.dataset.runHeading = '';
      heading.textContent = record?.snapshot?.title || routineTitle || 'Загружаем рутину…'; header.append(heading);
      const close = document.createElement('button'); close.type = 'button'; close.dataset.runClose = '';
      close.textContent = 'К рекомендации'; close.disabled = busy;
      close.addEventListener('click', () => { if (!busy) onClose?.(); }); header.append(close); element.append(header);
    } else if (record) dialog.modal.querySelector('h2').textContent = record.snapshot.title;

    if (!record) {
      const loading = document.createElement('p'); loading.textContent = error ? '' : 'Загружаем выполнение…'; element.append(loading);
    } else {
      chooseCurrent();
      const done = record.run.steps.filter(step => step.status === 'done').length;
      const skipped = record.run.steps.filter(step => step.status === 'skipped').length;
      const progress = document.createElement('p'); progress.className = 'calendar-run-progress';
      progress.textContent = `Выполнено ${done} из ${record.run.steps.length}${skipped ? ` · пропущено ${skipped}` : ''}${origin !== store.today() ? ` · Начато ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(origin + 'T12:00:00'))}` : ''}`;
      element.append(progress);
      const ready = graph() ? available() : current >= 0 ? [current] : [];
      const next = document.createElement('section'); next.className = 'calendar-run-ready'; next.dataset.runReady = '';
      const heading = document.createElement('h3'); heading.textContent = ready.length > 1 ? 'Выбери следующий шаг' : ready.length ? 'Текущий шаг' : 'Рутина завершена'; next.append(heading);
      if (ready.length > 1) { const hint = document.createElement('p'); hint.textContent = 'Эти шаги доступны сейчас. Выбери удобный порядок.'; next.append(hint); }
      for (const index of ready) {
        const step = record.run.steps[index], row = scheduleRow(index), stepConfig = record.snapshot.steps?.[index], check = graph() && stepConfig?.trackingMode === 'check';
        const card = document.createElement('article'); card.className = 'calendar-run-step'; card.dataset.runStepCard = String(index);
        if (index === current) card.setAttribute('aria-current', 'step');
        const title = document.createElement('strong'), name = document.createElement('span'); name.textContent = step.title; title.append(name); card.append(title);
        const status = document.createElement('p'); status.className = 'calendar-run-step__status';
        status.textContent = [row?.is_active ? 'В работе' : row?.has_work ? 'На паузе' : check ? 'Отметка без таймера' : 'С учётом времени', stepConfig?.optional ? 'По желанию' : ''].filter(Boolean).join(' · '); card.append(status);
        if (!check) { const time = document.createElement('span'); time.dataset.runClock = String(index); time.className = 'calendar-run-clock'; status.append(' · ', time); }
        const controls = document.createElement('div'); controls.className = 'calendar-run-actions';
        const primary = check ? runButton('Отметить шаг', 'complete', index) : runButton(row?.is_active ? 'Пауза' : row?.has_work ? 'Продолжить' : 'Начать шаг', row?.is_active ? 'pause' : 'start', index);
        primary.dataset.routineStep = String(index); primary.className = 'calendar-run-primary'; controls.append(primary);
        if ((row?.has_work || row?.is_active) && !check) controls.append(runButton(!graph() && record.run.steps.length === 1 ? 'Завершить' : 'Завершить шаг', 'finish', index));
        const skip = runButton('Пропустить', 'skip', index); skip.className = 'calendar-run-skip'; controls.append(skip); card.append(controls); next.append(card);
      }
      if (!ready.length) { const message = document.createElement('p'); message.textContent = 'Все шаги выполнены или пропущены. Можно вернуться к рекомендации.'; next.append(message); }
      element.append(next);
      const plan = document.createElement('details'); plan.dataset.runPlan = ''; plan.className = 'calendar-run-plan'; plan.open = expanded;
      const summary = document.createElement('summary'); summary.textContent = `Все шаги · ${record.run.steps.length}`; plan.append(summary);
      const list = document.createElement('ol'); list.className = 'calendar-routine-steps';
      record.run.steps.forEach((step, index) => {
        const row = scheduleRow(index), isAvailable = graph() && available().includes(index), dependencies = record.snapshot.steps?.[index]?.dependsOn || [];
        const item = document.createElement('li'), title = document.createElement('span'), status = document.createElement('small'); item.dataset.planStep = String(index);
        title.textContent = step.title;
        const waitingFor = dependencies.filter(dependency => !['done', 'skipped'].includes(record.run.steps[dependency]?.status));
        const graphStep = graph() ? record.snapshot.steps[index] : null;
        const stepStatus = step.status === 'done' ? 'Выполнено' : step.status === 'skipped' ? 'Пропущено' : row?.is_active ? 'В работе' : row?.has_work ? 'На паузе' : graph() ? (isAvailable ? `${graphStep?.optional ? 'По желанию · ' : ''}${graphStep?.trackingMode === 'check' ? 'Можно отметить' : 'Доступен'}` : `После: ${waitingFor.map(dependency => record.snapshot.steps[dependency]?.title || 'шага').join(', ')}`) : index === current ? 'Следующий шаг' : 'Ожидает';
        status.textContent = stepStatus; item.append(title, status); list.append(item);
      });
      plan.append(list); element.append(plan); tick();
    }
    if (error) {
      if (inline) { const alert = document.createElement('p'); alert.className = 'calendar-run-error'; alert.setAttribute('role', 'alert'); alert.textContent = error; element.append(alert); }
      const retry = dialog?.retry || document.createElement('button');
      if (inline) { retry.type = 'button'; retry.dataset.runRetry = ''; retry.textContent = 'Повторить загрузку'; element.append(retry); }
      retry.hidden = false; retry.disabled = busy;
      if (!retry.dataset.runRetryBound) { retry.dataset.runRetryBound = 'true'; retry.addEventListener('click', () => { if (!busy) void initialize(false); }); }
    } else if (dialog?.retry) dialog.retry.hidden = true;
    if (dialog) dialog.setPending(busy); else element.setAttribute('aria-busy', String(busy));
    if (focused && !busy) {
      if (focused.close) element.querySelector('[data-run-close]')?.focus({ preventScroll: true });
      else if (focused.retry) element.querySelector('[data-run-retry]')?.focus({ preventScroll: true });
      else element.querySelector(`[data-run-step="${focused.step}"][data-run-action="${focused.action}"]`)?.focus({ preventScroll: true });
    }
  }
  async function refresh() {
    const version = ++readVersion;
    const [state, nextRows, nextActive] = await Promise.all([store.read(), invoke('get_schedules', {}), readActiveBlocks(invoke)]);
    if (disposed || version !== readVersion) return false;
    if (!Array.isArray(nextRows)) throw Error('Не удалось прочитать шаги выполнения.');
    const run = state.days[origin]?.[id];
    if (!run?.run) {
      if (observedRun) { record = null; rows = []; activeBlocks = nextActive; current = -1; throw Error('Выполнение больше недоступно. Закрой его и выбери рутину заново.'); }
      throw Error('Выполнение ещё не начато. Нажми «Начать» у рутины.');
    }
    observedRun = true;
    record = run;
    routineTitle = run.snapshot?.title || routineTitle;
    rows = nextRows.filter(row => record?.run.steps.some((_step, index) => String(row.id) === recurringSourceId(id, origin, index)));
    activeBlocks = nextActive;
    if (!record) current = -1; else chooseCurrent();
    error = ''; render(); return true;
  }
  async function perform(action, expectedStep = current) {
    if (busy || disposed) return;
    setBusy(true); showError('');
    try {
      if (!await refresh() || disposed) return;
      if (!record) throw Error('Выполнение больше недоступно. Закрой окно и обнови рутины.');
      if (graph() && !available().includes(expectedStep)) throw Error('Шаг больше недоступен. Проверь зависимости и обнови выполнение.');
      if (current !== expectedStep) throw Error('Шаг уже изменился. Проверь текущее выполнение перед следующим действием.');
      if (current < 0) throw Error('Это выполнение уже закончено.');
      if (disposed) return;
      const sourceId = recurringSourceId(id, origin, current), row = rows.find(item => String(item.id) === sourceId);
      if (action === 'complete') {
        if (!graph() || record.snapshot.steps[current]?.trackingMode !== 'check') throw Error('Этот шаг нельзя отметить без таймера.');
        await invoke('complete_recurring_step', { sourceId });
      } else if (action === 'start') {
        await startCalendarExecution(invoke, { source_type: 'schedule', source_id: sourceId, title: row?.title || record.snapshot.title, completion_date: origin });
      } else if (action === 'skip') await invoke('skip_recurring_step', { sourceId });
      else {
        // Other tasks may run beside this step; act only on this step's own block.
        const active = (await readActiveBlocks(invoke)).find(block => block.source_type === 'schedule' && String(block.source_id) === sourceId);
        if (disposed) return;
        const blocks = await invoke('get_timeline_blocks', { date: origin });
        if (disposed) return;
        const blockId = row?.block_id ?? blocks.filter(block => block.source_type === 'schedule' && String(block.source_id) === sourceId).at(-1)?.id;
        if (action === 'pause') {
          if (active?.source_type !== 'schedule' || String(active.source_id) !== sourceId) throw Error('Состояние изменилось. Обнови выполнение.');
          if (disposed) return;
          await invoke('pause_task_block', { blockId: Number(active.id) });
        } else {
          if (blockId == null) throw Error('Сначала начни этот шаг.');
          if (disposed) return;
          await invoke('finish_task_block', { blockId: Number(blockId) });
        }
      }
      notify(); await refresh();
    } catch (cause) { showError(cause?.message || String(cause)); }
    finally {
      busy = false;
      if (!disposed) {
        if (dialog) dialog.setPending(false); else element.setAttribute('aria-busy', 'false');
        render();
        if (!error) {
          const target = element.querySelector(`[data-run-step="${expectedStep}"][data-run-action]`) || element.querySelector('[data-run-action]') || element.querySelector('[data-run-heading]');
          target?.focus({ preventScroll: true });
        }
      }
    }
  }
  const reportReadError = cause => { if (!disposed) showError(cause?.message || String(cause)); };
  const onExternal = () => { if (!busy && !disposed) void refresh().catch(reportReadError); };
  win.addEventListener('task-state-changed', onExternal); win.addEventListener('hanni:calendar-refresh', onExternal);
  if (inline) {
    element.setAttribute('aria-busy', 'true');
  }
  async function initialize(autoStart) {
    if (busy || disposed) return;
    setBusy(true);
    if (dialog?.retry) dialog.retry.disabled = true;
    showError('');
    let loaded = false, shouldFocusHeading = false;
    try {
      const state = await store.read();
      if (disposed) return;
      let created = false;
      if (!state.days[origin]?.[id]?.run) {
        const existing = unfinishedRun(state, id);
        if (existing) { origin = existing.date; observedRun = true; }
        else if (createRunOnRetry && !observedRun) {
          const result = await store.ensureRun(id, origin); origin = result.result.date; created = true;
          if (disposed) { notify(); return; }
        }
        else if (observedRun) throw Error('Выполнение больше недоступно. Закрой его и выбери рутину заново.');
        else throw Error('Выполнение ещё не начато. Закрой окно и нажми «Начать» у рутины.');
      } else observedRun = true;
      loaded = await refresh();
      if (loaded) {
        error = ''; render();
        shouldFocusHeading = inline;
      }
      if (autoStart && !disposed && loaded) {
        const needsChoice = graph() && available().length > 1;
        const selectedActive = current >= 0 && scheduleRow(current)?.is_active;
        const checkStep = graph() && current >= 0 && record.snapshot.steps[current]?.trackingMode === 'check';
        if (!needsChoice && !selectedActive && !checkStep && current >= 0) {
          setBusy(false);
          shouldFocusHeading = false;
          await perform('start');
        }
      }
      if (created && !disposed) notify();
    } catch (cause) { reportReadError(cause); }
    finally {
      if (!disposed) {
        if (dialog?.retry) dialog.retry.disabled = false;
        setBusy(false);
        if (shouldFocusHeading) element.querySelector('[data-run-heading]')?.focus({ preventScroll: true });
      }
    }
  }
  if (dialog?.retry) dialog.retry.onclick = () => { if (!dialog.retry.disabled) void initialize(false); };
  rendered = '';
  render();
  clockTimer = win.setInterval(tick, 1000);
  void initialize(start);

  const dispose = () => {
    if (disposed) return;
    disposed = true; ++readVersion; win.clearInterval(clockTimer);
    win.removeEventListener('task-state-changed', onExternal); win.removeEventListener('hanni:calendar-refresh', onExternal);
    if (inline) { element.classList.remove('calendar-routine-inline'); element.replaceChildren(); element.removeAttribute('aria-busy'); }
  };
  dispose.isBusy = () => busy;
  return dispose;
}

/** Existing modal API retained for the launcher, library and task details. */
export function openRecurringRun({ document, invoke, id, date, start = false, returnFocus }) {
  if (openDialogs.has(document)) return openDialogs.get(document);
  let disposeRunner = null;
  const dialog = createCalendarDialog({ document, title: 'Выполнение рутины', returnFocus, onClose: () => {
    disposeRunner?.(); openDialogs.delete(document);
  } });
  dialog.modal.classList.add('calendar-routine-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent = 'Закрыть';
  openDialogs.set(document, dialog);
  dialog.open();
  dialog.body.textContent = 'Загружаем выполнение…';
  disposeRunner = mountRecurringRun(dialog.body, { document, invoke, id, date, start, dialog });
  return dialog;
}
