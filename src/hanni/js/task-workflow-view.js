import { createUiCopy } from './ui-copy.js';
import { mountTaskResultReview } from './task-result-review.js';
import { createWorkflowStore } from './task-workflow.js';
import { readTaskRunStatus } from './task-run-exchange.js';
import { readRegistryTask } from './work-registry.js';
import { registryStatusLabel, registryFreshnessLabel } from './work-registry-labels.js';


/** Manual product progress, independent of task stages, timers and executor telemetry. */
export function mountTaskWorkflow(host, { record, invoke, onClean = () => {}, onState = () => {}, review = null }) {
  const document = host.ownerDocument;
  const copy = createUiCopy(document);
  const labels = { planned: copy("Запланирован"), running: copy("В работе"), blocked: copy("Жду ответа"), done: copy("Готов") };
  const store = createWorkflowStore(record, invoke);
  let disposed = false, busy = false, loadedResult = '', confirmedState = null, runStatus = null, runReadFailed = false;
  const focus = document.createElement('section');
  focus.className = 'task-next-step';
  focus.setAttribute('aria-label', copy("Ближайший шаг задачи"));
  const next = document.createElement('p');
  const waiting = document.createElement('p'); waiting.hidden = true;
  const openSteps = document.createElement('button'); openSteps.type = 'button';
  openSteps.textContent = copy("Указать ближайший шаг");
  focus.append(next, waiting, openSteps);
  const details = document.createElement('details'); details.className = 'task-workflow';
  const heading = document.createElement('summary'); heading.textContent = copy("Шаги и результат");
  const content = document.createElement('div');
  const description = document.createElement('p'); description.textContent = copy("Отмечай ход работы вручную. Шаги не меняют этап или таймер задачи.");
  const list = document.createElement('ol'); list.setAttribute('aria-label', copy("Шаги задачи"));
  const addLabel = document.createElement('label'); addLabel.textContent = copy("Следующий шаг");
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = 2000; addLabel.append(input);
  const add = document.createElement('button'); add.type = 'button'; add.textContent = copy("Добавить шаг");
  const resultLabel = document.createElement('label'); resultLabel.textContent = copy("Результат задачи");
  const result = document.createElement('textarea'); result.rows = 3; result.maxLength = 10000; resultLabel.append(result);
  const save = document.createElement('button'); save.type = 'button'; save.textContent = copy("Сохранить результат");
  const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = copy("Отменить ввод");
  const execution = document.createElement('p');
  const registry = document.createElement('div');
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = copy("Повторить чтение"); retry.hidden = true;
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = copy("Обновить состояние");
  content.append(description, list, addLabel, add, resultLabel, save, discard, execution, registry, refresh, status, retry);
  details.append(heading, content); host.append(focus, details);
  const reviewStop = review ? mountTaskResultReview(details, review) : null;
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
    next.textContent = current ? `${copy("Сейчас: ")}${current.title}${running.length > 1 ? `${copy(" · ещё в работе: ")}${running.length - 1}` : ''}` : planned ? `${copy("Ближайший шаг: ")}${planned.title}`
      : state.steps.length === 0 ? copy("Ближайший шаг ещё не указан.")
      : blocked.length ? copy("Незавершённые шаги ждут ответа.") : `${copy("Все сохранённые шаги выполнены: ")}${state.steps.length}.`;
    waiting.hidden = blocked.length === 0;
    waiting.textContent = blocked.length ? `${copy("Ждём ответа: ")}${blocked[0].title}${blocked.length > 1 ? `${copy(" · ещё ожидают: ")}${blocked.length - 1}` : ''}` : '';
    openSteps.textContent = current || planned ? copy("Выбрать другой шаг") : copy("Указать ближайший шаг");
    list.replaceChildren();
    heading.textContent = state.steps.length ? `${copy("Шаги и результат · выполнено ")}${state.steps.filter(step => step.status === 'done').length}${copy(" из ")}${state.steps.length}` : copy("Шаги и результат · шаги не указаны");
    for (const step of state.steps) {
      const row = document.createElement('li');
      const title = document.createElement('span'); title.textContent = step.title;
      const select = document.createElement('select'); select.setAttribute('aria-label', `${copy("Статус шага: ")}${step.title}`);
      for (const [value, label] of Object.entries(labels)) {
        const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
      }
      select.value = step.status;
      select.addEventListener('change', () => void write(() => store.setStep(step.id, select.value), copy("Статус шага сохранён.")));
      row.append(title, select); list.append(row);
    }
    loadedResult = state.result;
    if (restoreDraft) result.value = state.result;
    // No polling or pretend activity. An unattached runner is explicitly absent.
    const reportedLabels = { running: copy("В работе"), waiting: copy("Ожидание"), done: copy("Завершён"), error: copy("Ошибка"), cancelled: copy("Отменён") };
    execution.textContent = runReadFailed ? copy("Статус внешнего исполнителя недоступен. Расходы неизвестны.") : runStatus
      ? runStatus.report
        ? `${copy("Последний импортированный отчёт ")}${runStatus.report.agent}: ${reportedLabels[runStatus.report.status]} · ${runStatus.runId}. ${copy("Токены: ")}${runStatus.report.inputTokens ?? copy("неизвестно")} / ${runStatus.report.outputTokens ?? copy("неизвестно")}${copy(". Стоимость не сообщена.")}`
        : `${copy("Попытка ")}${runStatus.runId}${copy(" подготовлена. Отчёта о выполнении нет. Расходы неизвестны.")}`
      : state.run
      ? `${copy("Последнее событие ")}${state.run.executor}: ${labels[state.run.status]} · ${state.run.runId}${state.run.summary ? ` · ${state.run.summary}` : ''}`
      : copy("Внешний исполнитель не связан. Автоматическое выполнение не запускалось.");
  }
  async function load() {
    if (disposed || busy) return;
    controls(true); openSteps.disabled = true; next.textContent = copy("Читаем ближайший шаг…"); status.textContent = copy("Загрузка шагов…");
    try {
      const [state, external, imported] = await Promise.all([store.load(), readTaskRunStatus(record, invoke).then(value => ({ value }), () => ({ failed: true })), readRegistryTask(record, invoke).then(rows => ({ rows }), () => ({ failed: true }))]);
      if (disposed) return;
      runStatus = external.value ?? null; runReadFailed = !!external.failed;
      registry.replaceChildren();
      if (imported.failed) registry.textContent = copy("Импортированный реестр недоступен. Статус исполнения неизвестен.");
      for (const {snapshot,task,freshness} of imported.rows ?? []) {
        const p = document.createElement('p');
        p.textContent = `${copy("Импортированный отчёт — ")}${registryStatusLabel(task.status, document.documentElement.lang)} • ${registryFreshnessLabel(freshness, document.documentElement.lang)}${copy(". Последнее наблюдение: ")}${task.lastUpdated}${copy(". Источник отчёта: ")}${snapshot.source.publisherId}${copy(". Основание: ")}${task.provenance.reference}${task.operation ? `${copy(" • операция: ")}${task.operation}` : ''}${task.waitingFor ? `${copy(" • ожидание: ")}${task.waitingFor}` : ''}${task.result ? `${copy(" • результат: ")}${task.result}` : ''}`;
        registry.append(p);
      }
      paint(state, { restoreDraft: result.value.trim() === loadedResult }); status.textContent = ''; retry.hidden = true;
    } catch { if (!disposed) { onState(confirmedState,true);if (!confirmedState) heading.textContent = copy("Шаги и результат · данные недоступны");next.textContent = confirmedState ? copy("Ближайший шаг не обновлён. Ниже — последнее подтверждённое состояние.") : copy("Ближайший шаг неизвестен: не удалось прочитать данные."); status.textContent = copy("Не удалось прочитать шаги. Формат может быть новее этой версии; данные сохранены без изменений. Сохранение недоступно."); retry.hidden = false; } }
    finally { if (!disposed) { controls(false); openSteps.disabled = !retry.hidden; if (!retry.hidden) { for (const item of content.querySelectorAll('input,textarea,select')) item.disabled = true; add.disabled = true; save.disabled = true; } } }
  }
  async function write(change, message) {
    if (disposed || busy) return;
    controls(true); status.textContent = copy("Сохранение…");
    try {
      const state = await change();
      if (disposed) return false;
      paint(state, { restoreDraft: false }); status.textContent = message; retry.hidden = true;
      return true;
    } catch { if (!disposed) { if (confirmedState) paint(confirmedState, { restoreDraft: false }); status.textContent = copy("Не удалось сохранить. Данные не подтверждены; перечитай состояние и повтори."); retry.hidden = false; } return false; }
    finally { if (!disposed) { controls(false); notifyClean(); } }
  }
  add.addEventListener('click', async () => { if (await write(() => store.addStep(input.value), copy("Шаг сохранён."))) { input.value = ''; notifyClean(); } });
  save.addEventListener('click', () => void write(() => store.saveResult(result.value), copy("Результат сохранён.")));
  discard.addEventListener('click', () => { input.value = ''; result.value = loadedResult; status.textContent = copy("Несохранённый ввод отменён."); notifyClean(); });
  input.addEventListener('input', notifyClean);
  result.addEventListener('input', notifyClean);
  retry.addEventListener('click', () => void load());
  refresh.addEventListener('click', () => void load());
  void load();
  const dispose = () => { disposed = true; reviewStop?.(); };
  dispose.beforeClose = () => {
    reviewStop?.beforeClose();
    if (busy) throw new Error(copy("Дождись сохранения шагов."));
    if (input.value.trim() || result.value.trim() !== loadedResult) throw new Error(copy("Сохрани шаг или результат перед закрытием."));
  };
  return dispose;
}
