// Device-local product state. A task timer never implies an external agent run.
const statuses = new Set(['planned', 'running', 'blocked', 'done']);
const requireText = (value, limit = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Некорректное значение.');
  return value.trim();
};
// Local SQLite workflow identity only; not the cross-app taskKey/sourceNamespace.
export function workflowTaskId(record) {
  if (record?.source_type !== 'note') throw new Error('Шаги поддерживаются только для задач.');
  return `cicada:note:${encodeURIComponent(requireText(String(record.source_id ?? ''), 200))}`;
}
export const workflowKey = record => `calendar_task_workflow_v1:${workflowTaskId(record)}`;
export function emptyWorkflow(record) {
  return { version: 1, taskId: workflowTaskId(record), steps: [], result: '', run: null };
}
export function readWorkflow(raw, record) {
  if (raw == null || raw === '') return emptyWorkflow(record);
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value?.version !== 1 || value.taskId !== workflowTaskId(record) || !Array.isArray(value.steps) || value.steps.length > 100 || typeof value.result !== 'string' || value.result.length > 10000) throw new Error('Неизвестный формат шагов. Сохранение остановлено.');
  const ids = new Set();
  for (const step of value.steps) {
    requireText(step.id, 200); requireText(step.title);
    if (ids.has(step.id) || !statuses.has(step.status)) throw new Error('Некорректные шаги.');
    ids.add(step.id);
  }
  if (value.run !== null) {
    requireText(value.run?.runId, 200);
    if (!['codex', 'opencode'].includes(value.run.executor) || !statuses.has(value.run.status) || !Number.isSafeInteger(value.run.sequence) || value.run.sequence < 0 || typeof value.run.summary !== 'string' || value.run.summary.length > 10000) throw new Error('Некорректный запуск.');
    if (value.run.status === 'done' && !value.run.summary.trim()) throw new Error('У запуска нет результата.');
  }
  return structuredClone(value);
}
/** Every mutation re-reads and uses native compare-and-swap; conflicts never overwrite. */
export function createWorkflowStore(record, invoke, uuid = () => globalThis.crypto.randomUUID()) {
  const key = workflowKey(record);
  let queue = Promise.resolve();
  async function load() { return readWorkflow(await invoke('get_ui_state', { key }), record); }
  function mutate(change) {
    const pending = queue.then(async () => {
      const raw = await invoke('get_ui_state', { key });
      const next = readWorkflow(raw, record);
      change(next);
      readWorkflow(next, record);
      await invoke('set_ui_state', { key, value: JSON.stringify(next), expectedValue: raw ?? '' });
      return next;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    load,
    addStep(title) { return mutate(state => { state.steps.push({ id: uuid(), title: requireText(title), status: 'planned' }); }); },
    setStep(id, status) { return mutate(state => {
      const step = state.steps.find(step => step.id === id);
      if (!step || !statuses.has(status)) throw new Error('Шаг не найден или статус неизвестен.');
      step.status = status;
    }); },
    saveResult(result) { return mutate(state => {
      if (typeof result !== 'string' || result.length > 10000) throw new Error('Результат слишком длинный.');
      state.result = result.trim();
    }); },
    // Internal candidate protocol, NOT Agent City report-run payloads.
    // No production adapter uses this; it does not launch or call a model.
    attachRun({ taskId, runId, executor }) { return mutate(state => {
      if (taskId !== state.taskId || state.run) throw new Error('Запуск уже связан или относится к другой задаче.');
      if (!['codex', 'opencode'].includes(executor)) throw new Error('Неизвестный исполнитель.');
      state.run = { runId: requireText(runId, 200), executor, status: 'planned', sequence: 0, summary: '' };
    }); },
    applyRunEvent({ taskId, runId, sequence, status, summary = '' }) { return mutate(state => {
      if (taskId !== state.taskId || runId !== state.run?.runId) throw new Error('Событие относится к другому запуску.');
      if (!Number.isSafeInteger(sequence) || sequence <= state.run.sequence) throw new Error('Повторное или устаревшее событие.');
      if (state.run.status === 'done' || !statuses.has(status) || status === 'planned') throw new Error('Недопустимое состояние запуска.');
      if (typeof summary !== 'string' || summary.length > 10000 || (status === 'done' && !summary.trim())) throw new Error('Нет подтверждённого результата.');
      Object.assign(state.run, { sequence, status, summary: summary.trim() });
    }); },
  };
}
