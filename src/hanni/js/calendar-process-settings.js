// «Процессы задач» in Calendar settings (owner decision 2026-09-25): rename a
// process, add, rename, delete and reorder its stages, add a process. Nothing
// is written until «Сохранить процессы» (or the dialog's «Сохранить»);
// «Отменить изменения» rereads the stored version. Stage ids never change, so
// renaming keeps every task; a deleted stage stays on its tasks as «Стадия удалена».
import { DEFAULT_PROCESS_ID, PROCESS_LIMITS, ProcessValidationError, newProcessId, readProcessState, saveProcessState, validateProcesses } from './task-processes.js';

const clone = processes => processes.map(process => ({ ...process, stages: process.stages.map(stage => ({ ...stage })) }));

export function mountProcessSettings(element, { invoke, setPending = () => {} }) {
  const doc = element.ownerDocument;
  let saved = null, draft = [], busy = false, disposed = false, failed = false;
  element.className = 'calendar-setting calendar-processes';
  element.innerHTML = `<h3 id="calendar-processes-title">Процессы задач</h3>
    <p class="calendar-processes-hint">Стадии для задач с процессом. Переименование не меняет задачи. Если удалить стадию, её задачи покажут «Стадия удалена», пока ты не выберешь другую.</p>
    <p class="calendar-processes-status" data-processes-status role="status" aria-live="polite">Загружаем процессы…</p>
    <div class="calendar-processes-list" data-processes-list></div>
    <button type="button" class="calendar-processes-add" data-processes-add hidden>＋ Новый процесс</button>
    <p class="calendar-processes-error" data-processes-error role="alert" hidden></p>
    <div class="calendar-processes-actions"><button type="button" data-processes-save disabled>Сохранить процессы</button><button type="button" data-processes-cancel disabled>Отменить изменения</button><button type="button" data-processes-retry hidden>Повторить загрузку</button></div>`;
  const q = name => element.querySelector(`[data-processes-${name}]`);
  const list = q('list'), status = q('status'), error = q('error');
  const node = (tag, className, text) => { const value = doc.createElement(tag); if (className) value.className = className; if (text != null) value.textContent = text; return value; };
  const dirty = () => !!saved && JSON.stringify(draft) !== JSON.stringify(saved.state.processes);
  const isSaved = id => !!saved?.state.processes.some(process => process.id === id);
  const find = (processId, stageId) => { const process = draft.find(item => item.id === processId); return { process, index: process ? process.stages.findIndex(stage => stage.id === stageId) : -1 }; };
  const control = (processId, stageId, name) => element.querySelector(`[data-process-id="${processId}"] ${stageId ? `[data-stage-id="${stageId}"] ` : ''}[data-control="${name}"]`);
  const focus = (...targets) => { for (const [processId, stageId, name] of targets) { const target = control(processId, stageId, name); if (target && !target.disabled) { target.focus({ preventScroll: false }); return; } } };

  function updateActions() {
    const loaded = !!saved;
    q('save').disabled = busy || !dirty(); q('cancel').disabled = busy || !dirty();
    q('add').hidden = !loaded; q('add').disabled = busy || draft.length >= PROCESS_LIMITS.processes;
    q('retry').hidden = !failed || loaded;
  }
  function button(className, label, text, name, disabled = false) {
    const value = node('button', className, text); value.type = 'button'; value.dataset.control = name;
    value.title = label.split(':')[0]; value.setAttribute('aria-label', label); value.disabled = busy || disabled;
    return value;
  }
  function render() {
    if (disposed) return;
    list.replaceChildren(...draft.map(process => {
      const box = node('fieldset', 'cp-process'); box.dataset.processId = process.id; box.disabled = busy;
      const legend = node('legend', 'cp-legend', process.id === DEFAULT_PROCESS_ID ? 'Встроенный процесс' : isSaved(process.id) ? 'Процесс' : 'Новый процесс');
      const title = node('label', 'cp-title');
      const input = node('input'); input.type = 'text'; input.value = process.title; input.maxLength = PROCESS_LIMITS.title; input.dataset.control = 'process-title'; input.autocomplete = 'off'; input.placeholder = 'Например, Ремонт';
      input.addEventListener('input', () => { process.title = input.value; updateActions(); });
      title.append(node('span', 'cp-label', 'Название процесса'), input);
      const stages = node('ol', 'cp-stages'); stages.setAttribute('aria-label', `Стадии: ${process.title || 'процесс без названия'}`);
      process.stages.forEach((stage, index) => {
        const item = node('li', 'cp-stage'); item.dataset.stageId = stage.id;
        const name = stage.title || `стадия ${index + 1}`;
        const field = node('input'); field.type = 'text'; field.value = stage.title; field.maxLength = PROCESS_LIMITS.title; field.dataset.control = 'stage-title'; field.autocomplete = 'off'; field.placeholder = 'Название стадии';
        field.setAttribute('aria-label', `Стадия ${index + 1} из ${process.stages.length}`);
        field.addEventListener('input', () => { stage.title = field.value; updateActions(); });
        // Alt+↑ / Alt+↓ move the stage from its name field too.
        field.addEventListener('keydown', event => { if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); move(process.id, stage.id, event.key === 'ArrowUp' ? -1 : 1, 'stage-title'); } });
        item.append(node('span', 'cp-number', String(index + 1)), field,
          button('cp-icon', `Выше: ${name}`, '↑', 'stage-up', index === 0),
          button('cp-icon', `Ниже: ${name}`, '↓', 'stage-down', index === process.stages.length - 1),
          button('cp-icon cp-delete', `Удалить стадию: ${name}`, '×', 'stage-delete', process.stages.length === 1));
        stages.append(item);
      });
      const footer = node('div', 'cp-process-actions');
      footer.append(button('cp-add', `Добавить стадию: ${process.title || 'процесс'}`, '＋ Стадия', 'stage-add', process.stages.length >= PROCESS_LIMITS.stages));
      // Only a process that is not saved yet can be removed here.
      if (!isSaved(process.id)) footer.append(button('cp-remove', `Убрать новый процесс: ${process.title || 'без названия'}`, 'Убрать', 'process-remove'));
      box.append(legend, title, stages, footer);
      return box;
    }));
    updateActions();
  }
  function move(processId, stageId, delta, keep) {
    const { process, index } = find(processId, stageId), to = index + delta;
    if (!process || index < 0 || to < 0 || to >= process.stages.length) return;
    const [stage] = process.stages.splice(index, 1); process.stages.splice(to, 0, stage);
    render();
    // Focus stays with the moved stage; at an edge the other arrow takes it.
    focus([processId, stageId, keep], [processId, stageId, keep === 'stage-up' ? 'stage-down' : 'stage-up'], [processId, stageId, 'stage-title']);
    status.textContent = `Стадия «${stage.title}» теперь ${to + 1}-я.`;
  }
  function removeStage(processId, stageId) {
    const { process, index } = find(processId, stageId);
    if (!process || index < 0 || process.stages.length === 1) return;
    const [stage] = process.stages.splice(index, 1);
    render();
    const neighbour = process.stages[index] || process.stages[index - 1];
    focus([processId, neighbour?.id, 'stage-delete'], [processId, neighbour?.id, 'stage-title'], [processId, null, 'stage-add']);
    status.textContent = `Стадия «${stage.title || 'без названия'}» будет удалена после сохранения.`;
  }
  function addStage(processId) {
    const process = draft.find(item => item.id === processId);
    if (!process || process.stages.length >= PROCESS_LIMITS.stages) return;
    const id = newProcessId('s', draft.flatMap(item => item.stages.map(stage => stage.id)));
    process.stages.push({ id, title: '' });
    render(); focus([processId, id, 'stage-title']);
  }
  function addProcess() {
    if (draft.length >= PROCESS_LIMITS.processes) return;
    const id = newProcessId('p', draft.map(item => item.id));
    draft.push({ id, title: '', stages: [{ id: newProcessId('s', []), title: '' }] });
    render(); focus([id, null, 'process-title']);
  }
  function showError(message, target = null) {
    error.textContent = message; error.hidden = !message;
    element.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    if (target) { target.setAttribute('aria-invalid', 'true'); target.focus(); }
  }
  async function load() {
    failed = false; status.textContent = 'Загружаем процессы…'; showError(''); updateActions();
    try {
      const value = await readProcessState(invoke);
      if (disposed) return;
      saved = value; draft = clone(value.state.processes);
      status.textContent = `${draft.length === 1 ? 'Один процесс' : `Процессов: ${draft.length}`}.`;
    } catch (cause) {
      if (disposed) return;
      failed = true; saved = null; draft = [];
      status.textContent = '';
      showError(cause?.message || 'Не удалось загрузить процессы.');
    }
    render();
  }
  /** Validates the draft; an error is shown at its field, which gets focus. */
  function check() {
    try { return validateProcesses(draft); }
    catch (cause) {
      if (!(cause instanceof ProcessValidationError)) throw cause;
      const target = cause.stageId ? control(cause.processId, cause.stageId, 'stage-title') : cause.field === 'stages' ? control(cause.processId, null, 'stage-add') : control(cause.processId, null, 'process-title');
      showError(cause.message, target);
      return null;
    }
  }
  /** Saves a changed draft. `external`: the settings dialog owns the pending state. */
  async function save({ external = false } = {}) {
    if (disposed) return true;
    if (busy || !saved) return false;
    if (!dirty()) return true;
    const valid = check();
    if (!valid) return false;
    busy = true; showError(''); status.textContent = 'Сохраняем процессы…'; if (!external) setPending(true); render();
    try {
      saved = await saveProcessState(invoke, valid, saved.raw);
      if (disposed) return true;
      draft = clone(saved.state.processes);
      status.textContent = 'Процессы сохранены.';
      return true;
    } catch (cause) {
      if (!disposed) { status.textContent = ''; showError(cause?.message || 'Не удалось сохранить процессы. Изменения остались в форме.'); }
      return false;
    } finally {
      busy = false;
      if (!disposed) { if (!external) setPending(false); render(); }
    }
  }
  element.addEventListener('click', event => {
    const target = event.target.closest('[data-control]');
    if (!target || target.disabled || busy || !element.contains(target) || target.tagName !== 'BUTTON') return;
    const processId = target.closest('[data-process-id]')?.dataset.processId, stageId = target.closest('[data-stage-id]')?.dataset.stageId;
    const name = target.dataset.control;
    if (name === 'stage-up' || name === 'stage-down') move(processId, stageId, name === 'stage-up' ? -1 : 1, name);
    else if (name === 'stage-delete') removeStage(processId, stageId);
    else if (name === 'stage-add') addStage(processId);
    else if (name === 'process-remove') { draft = draft.filter(process => process.id !== processId); render(); q('add').focus(); }
  });
  q('add').addEventListener('click', addProcess);
  // The buttons are disabled once saved: focus moves to the confirmation.
  status.tabIndex = -1;
  q('save').addEventListener('click', () => { void save().then(ok => { if (ok && !disposed) status.focus({ preventScroll: true }); }); });
  q('cancel').addEventListener('click', () => { void load().then(() => { if (!disposed) { status.textContent = 'Изменения отменены.'; element.querySelector('[data-control="process-title"]')?.focus(); } }); });
  q('retry').addEventListener('click', () => void load());
  void load();
  return { dispose() { disposed = true; }, isDirty: dirty, check: () => !!check(), save, get ready() { return !!saved; } };
}
