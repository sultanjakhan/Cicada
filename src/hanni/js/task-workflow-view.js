import { mountTaskResultReview } from './task-result-review.js';
import { createWorkflowStore } from './task-workflow.js';
import { readTaskRunStatus } from './task-run-exchange.js';
import { readRegistryTask } from './work-registry.js';
import { registryStatusLabel, registryFreshnessLabel } from './work-registry-labels.js';

const labels = { planned: 'Запланирован', running: 'В работе', blocked: 'Жду ответа', done: 'Готов' };

/** Manual product progress, independent of task stages, timers and executor telemetry. */
export function mountTaskWorkflow(host, { record, invoke, onClean = () => {}, onState = () => {}, review = null }) {
  const document = host.ownerDocument;
  const store = createWorkflowStore(record, invoke);
  let disposed = false, busy = false, loadedResult = '', confirmedState = null, runStatus = null, runReadFailed = false;
  const focus = document.createElement('section');
  focus.className = 'task-next-step';
  focus.setAttribute('aria-label', 'Ближайший шаг задачи');
  const next = document.createElement('p');
  const waiting = document.createElement('p'); waiting.hidden = true;
  const openSteps = document.createElement('button'); openSteps.type = 'button';
  openSteps.textContent = 'Указать ближайший шаг';
  focus.append(next, waiting, openSteps);
  const details = document.createElement('details'); details.className = 'task-workflow';
  const heading = document.createElement('summary'); heading.textContent = 'Шаги и результат';
  const content = document.createElement('div');
  const description = document.createElement('p'); description.textContent = 'Отмечай ход работы вручную. Шаги не меняют этап или таймер задачи.';
  const list = document.createElement('ol'); list.setAttribute('aria-label', 'Шаги задачи');
  const addLabel = document.createElement('label'); addLabel.textContent = 'Следующий шаг';
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = 2000; addLabel.append(input);
  const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Добавить шаг';
  const resultLabel = document.createElement('label'); resultLabel.textContent = 'Результат задачи';
  const result = document.createElement('textarea'); result.rows = 3; result.maxLength = 10000; resultLabel.append(result);
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Сохранить результат';
  const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = 'Отменить ввод';
  const execution = document.createElement('p');
  const registry = document.createElement('div');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить чтение'; retry.hidden = true;
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Обновить состояние';
  content.append(description, list, addLabel, add, resultLabel, save, discard, execution, registry, refresh, status, retry);
  details.append(heading, content); host.append(focus);
  // Review is a task-level decision, so it must remain visible while the
  // optional manual steps disclosure stays closed.
  const reviewStop = review ? mountTaskResultReview(host, review) : null;
  host.append(details);
  openSteps.addEventListener('click', () => {
    details.open = true;
    (list.querySelector('select') || input).focus();
  });
  function notifyClean() {
    if (!disposed && !busy && !input.value.trim() && result.value.trim() === loadedResult) onClean();
  }
  function controls(disabled) {
    busy = disabled; content.setAttribute('aria-busy', String(disabled));
    openSteps.disabled = disabled;
    for (const item of content.querySelectorAll('button,input,textarea,select')) item.disabled = disabled;
  }
  function paint(state, { restoreDraft = true } = {}) {
    confirmedState = state;onState(state,false);
    const running = state.steps.filter(step => step.status === 'running');
    const current = running[0];
    const planned = state.steps.find(step => step.status === 'planned');
    const blocked = state.steps.filter(step => step.status === 'blocked');
    next.textContent = current ? `Сейчас: ${current.title}${running.length > 1 ? ` · ещё в работе: ${running.length - 1}` : ''}` : planned ? `Ближайший шаг: ${planned.title}`
      : state.steps.length === 0 ? 'Ближайший шаг ещё не указан.'
      : blocked.length ? 'Незавершённые шаги ждут ответа.' : `Все сохранённые шаги выполнены: ${state.steps.length}.`;
    waiting.hidden = blocked.length === 0;
    waiting.textContent = blocked.length ? `Ждём ответа: ${blocked[0].title}${blocked.length > 1 ? ` · ещё ожидают: ${blocked.length - 1}` : ''}` : '';
    openSteps.textContent = current || planned ? 'Выбрать другой шаг' : 'Указать ближайший шаг';
    list.replaceChildren();
    heading.textContent = `Шаги и результат · ${state.steps.filter(step => step.status === 'done').length}/${state.steps.length}`;
    for (const step of state.steps) {
      const row = document.createElement('li');
      const title = document.createElement('span'); title.textContent = step.title;
      const select = document.createElement('select'); select.setAttribute('aria-label', `Статус шага: ${step.title}`);
      for (const [value, label] of Object.entries(labels)) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
      }
      select.value = step.status;
      select.addEventListener('change', () => void write(() => store.setStep(step.id, select.value), 'Статус шага сохранён.'));
      row.append(title, select); list.append(row);
    }
    loadedResult = state.result;
    if (restoreDraft) result.value = state.result;
    // No polling or pretend activity. An unattached runner is explicitly absent.
    const reportedLabels = { running: 'В работе', waiting: 'Ожидание', done: 'Завершён', error: 'Ошибка', cancelled: 'Отменён' };
    execution.textContent = runReadFailed ? 'Статус внешнего исполнителя недоступен. Расходы неизвестны.' : runStatus
      ? runStatus.report
        ? `Последний импортированный отчёт ${runStatus.report.agent}: ${reportedLabels[runStatus.report.status]} · ${runStatus.runId}. Токены: ${runStatus.report.inputTokens ?? 'неизвестно'} / ${runStatus.report.outputTokens ?? 'неизвестно'}. Стоимость не сообщена.`
        : `Попытка ${runStatus.runId} подготовлена. Отчёта о выполнении нет. Расходы неизвестны.`
      : state.run
      ? `Последнее событие ${state.run.executor}: ${labels[state.run.status]} · ${state.run.runId}${state.run.summary ? ` · ${state.run.summary}` : ''}`
      : 'Внешний исполнитель не связан. Автоматическое выполнение не запускалось.';
  }
  async function load() {
    if (disposed || busy) return;
    controls(true); openSteps.disabled = true; next.textContent = 'Читаем ближайший шаг…'; status.textContent = 'Загрузка шагов…';
    try {
      const [state, external, imported] = await Promise.all([store.load(), readTaskRunStatus(record, invoke).then(value => ({ value }), () => ({ failed: true })), readRegistryTask(record, invoke).then(rows => ({ rows }), () => ({ failed: true }))]);
      if (disposed) return;
      runStatus = external.value ?? null; runReadFailed = !!external.failed;
      registry.replaceChildren();
      if (imported.failed) registry.textContent = 'Импортированный реестр недоступен. Статус исполнения неизвестен.';
      for (const {snapshot,task,freshness} of imported.rows ?? []) {
        const p = document.createElement('p');
        p.textContent = `Импортированный отчёт — ${registryStatusLabel(task.status)} • ${registryFreshnessLabel(freshness)}. Последнее наблюдение: ${task.lastUpdated}. Источник отчёта: ${snapshot.source.publisherId}. Основание: ${task.provenance.reference}${task.operation ? ` • операция: ${task.operation}` : ''}${task.waitingFor ? ` • ожидание: ${task.waitingFor}` : ''}${task.result ? ` • результат: ${task.result}` : ''}`;
        registry.append(p);
      }
      paint(state, { restoreDraft: result.value.trim() === loadedResult }); status.textContent = ''; retry.hidden = true;
    } catch { if (!disposed) { onState(confirmedState,true);next.textContent = confirmedState ? 'Ближайший шаг не обновлён. Ниже — последнее подтверждённое состояние.' : 'Ближайший шаг неизвестен: не удалось прочитать данные.'; status.textContent = 'Не удалось прочитать шаги. Сохранение недоступно.'; retry.hidden = false; } }
    finally { if (!disposed) { controls(false); openSteps.disabled = !retry.hidden; if (!retry.hidden) { add.disabled = true; save.disabled = true; } } }
  }
  async function write(change, message) {
    if (disposed || busy) return;
    controls(true); status.textContent = 'Сохранение…';
    try {
      const state = await change();
      if (disposed) return false;
      paint(state, { restoreDraft: false }); status.textContent = message; retry.hidden = true;
      return true;
    } catch { if (!disposed) { if (confirmedState) paint(confirmedState, { restoreDraft: false }); status.textContent = 'Не удалось сохранить. Данные не подтверждены; перечитай состояние и повтори.'; retry.hidden = false; } return false; }
    finally { if (!disposed) { controls(false); notifyClean(); } }
  }
  add.addEventListener('click', async () => { if (await write(() => store.addStep(input.value), 'Шаг сохранён.')) { input.value = ''; notifyClean(); } });
  save.addEventListener('click', () => void write(() => store.saveResult(result.value), 'Результат сохранён.'));
  discard.addEventListener('click', () => { input.value = ''; result.value = loadedResult; status.textContent = 'Несохранённый ввод отменён.'; notifyClean(); });
  input.addEventListener('input', notifyClean);
  result.addEventListener('input', notifyClean);
  retry.addEventListener('click', () => void load());
  refresh.addEventListener('click', () => void load());
  void load();
  const dispose = () => { disposed = true; reviewStop?.(); };
  dispose.beforeClose = () => {
    reviewStop?.beforeClose();
    if (busy) throw new Error('Дождись сохранения шагов.');
    if (input.value.trim() || result.value.trim() !== loadedResult) throw new Error('Сохрани шаг или результат перед закрытием.');
  };
  return dispose;
}
