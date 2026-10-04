import { createUiCopy, copyForLanguage } from './ui-copy.js';
// Opt-in review seam. No IPC, executor, transport or persistence is inferred.
// A session Map has one current component owner per task. Late lifetimes cannot write it.
const sessionOwners = new WeakMap();
export function mountTaskResultReview(host, { taskId, adapter, drafts, operationId }) {
  const document = host.ownerDocument;
  const copy=createUiCopy(document);
  const section = document.createElement('section'); section.className = 'task-result-review';
  section.setAttribute('aria-label', copy("Проверка результата ИИ"));
  const revision = document.createElement('p');
  const result = document.createElement('pre');
  const state = document.createElement('p');
  const label = document.createElement('label'); label.textContent = copy("Замечание для доработки");
  const comment = document.createElement('textarea'); comment.maxLength = 8000; label.append(comment);
  let owners = sessionOwners.get(drafts);
  if (!owners) { owners = new Map(); sessionOwners.set(drafts, owners); }
  const owner = Symbol(taskId); owners.set(taskId, owner);
  const saved = drafts.get(taskId) || {};
  comment.value = saved.comment || '';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const history = document.createElement('ol'); history.setAttribute('aria-label', copy("История решений"));
  const button = (text, action) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', action); return b; };
  let snapshot = null, busy = false, disposed = false, unresolved = saved.pending || null, outcome = saved.outcome || null;
  const live = () => !disposed && owners.get(taskId) === owner;
  const remember = () => { if (live()) drafts.set(taskId, { comment: comment.value, pending: unresolved && structuredClone(unresolved), outcome }); };
  comment.addEventListener('input', remember);
  const accept = button(copy("Принять"), () => void decide('accept'));
  const rework = button(copy("Доработать"), () => void decide('rework'));
  const refresh = button(copy("Обновить результат"), () => void load());
  const retry = button(copy("Повторить отправку"), () => void send(unresolved)); retry.hidden = true;
  const cancel = button(copy("Отменить решение"), () => { if (!live() || busy || unresolved || (snapshot && snapshot.reviewState !== 'awaiting_review')) return; remember(); status.textContent = copy("Решение не отправлено. Замечание осталось в черновике."); });
  section.append(revision, result, state, label, accept, rework, cancel, refresh, retry, status, history); host.append(section);
  function controls() {
    section.setAttribute('aria-busy', String(busy));
    const actionable = snapshot?.reviewState === 'awaiting_review' && !unresolved;
    accept.disabled = rework.disabled = busy || !actionable;
    refresh.disabled = busy; cancel.disabled = busy || !!unresolved || (snapshot && snapshot.reviewState !== 'awaiting_review');
    comment.disabled = busy || !!unresolved;
    retry.hidden = !unresolved; retry.disabled = busy;
  }
  function paint(value) {
    if (value?.taskId !== taskId || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1 || !Number.isSafeInteger(value.resultVersion) || value.resultVersion < 1 || typeof value.content !== 'string' || !Array.isArray(value.history) || !['awaiting_review','accepted','awaiting_dispatch','running'].includes(value.reviewState)) throw Error('Invalid review projection');
    snapshot = structuredClone(value);
    revision.textContent = `${copy("Результат · ревизия ")}${value.resultVersion}${copy(" · версия задачи ")}${value.taskRevision}`;
    result.textContent = value.content;
    state.textContent = { awaiting_review: copy("Ожидает решения"), accepted: copy("Результат принят"), awaiting_dispatch: copy("Доработка подтверждена. Ожидает передачи исполнителю; работа ещё не началась."), running: copy("В работе · подтверждено исполнителем") }[value.reviewState];
    history.replaceChildren();
    for (const entry of value.history) {
      const row = document.createElement('li');
      row.textContent = `${entry.action}${copy(" · результат ")}${entry.resultVersion}${entry.comment ? ` · ${entry.comment}` : ''}`; history.append(row);
    }
  }
  async function load() {
    if (busy || !live()) return;
    busy = true; controls();
    try { const value = await adapter.read(taskId); if (live()) { paint(value); status.textContent = unresolved ? (outcome === 'queued' ? copy("Решение сохранено в локальной очереди. Подтверждения сервиса и запуска нет.") : copy("Исход отправки неизвестен. Повтор использует то же решение.")) : copy("Результат обновлён. Проверь ревизию перед решением."); } }
    catch { if (live()) { snapshot = null; status.textContent = copy("Результат недоступен. Решение не отправлено."); } }
    finally { busy = false; if (live()) controls(); }
  }
  async function decide(action) {
    if (busy || !live() || unresolved || snapshot?.reviewState !== 'awaiting_review') return;
    if (action === 'rework' && (!comment.value.trim() || comment.value.length > 8000)) { status.textContent = copy("Добавь замечание для доработки (до 8000 символов)."); return; }
    remember();
    await send({ task_id: taskId, expected_revision: snapshot.taskRevision, result_version: snapshot.resultVersion, operation_id: operationId(), action, ...(action === 'rework' ? { comment: comment.value.trim() } : {}) });
  }
  async function send(request) {
    if (!request || busy || !live()) return;
    unresolved = structuredClone(request); outcome = 'unknown'; remember();
    busy = true; controls();
    try {
      // Adapter resolves only after durable local enqueue or verified receipt.
      const response = await adapter.submit(structuredClone(request));
      if (!live()) return;
      if (response?.kind === 'queued') {
        unresolved = request; outcome = 'queued';
        status.textContent = copy("Решение сохранено в локальной очереди. Подтверждения сервиса и запуска нет.");
      } else if (response?.kind === 'acknowledged' && response.operation_id === request.operation_id) {
        paint(response.projection); unresolved = null; outcome = null;
        comment.value = ''; remember(); status.textContent = copy("Решение подтверждено сервисом.");
      } else throw Error('Unconfirmed decision');
    } catch (error) {
      if (live()) {
        unresolved = error?.status === 409 ? null : request; outcome = unresolved ? 'unknown' : null;
        if (error?.status === 409) snapshot = null;
        status.textContent = error?.status === 409 ? copy("Результат изменился (409). Обнови результат и проверь новую ревизию. Замечание сохранено.") : copy("Исход отправки неизвестен. Замечание сохранено; повтор отправит исходное решение.");
      }
    } finally { busy = false; remember(); if (live()) controls(); }
  }
  void load();
  const dispose = () => { remember(); disposed = true; if (owners.get(taskId) === owner) owners.delete(taskId); section.remove(); };
  dispose.beforeClose = () => { if (!live()) return; if (busy) throw Error(copy("Дождись завершения отправки решения.")); remember(); };
  return dispose;
}
