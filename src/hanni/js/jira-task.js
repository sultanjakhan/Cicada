import { createCalendarDialog } from './calendar-dialog.js';
import { jiraErrorText } from './jira-import.js';

export const isJiraTask = record => record?.source_type === 'note' && /^jira:[a-f0-9]{64}$/.test(String(record.source_id));

export function openJiraTaskEditor(record, { document, invoke, returnFocus, onChanged, isCurrent = () => true }) {
  if (!isJiraTask(record)) return () => {};
  const window = document.defaultView;
  let snapshot = null, busy = false, disposed = false, mustRefresh = false;
  const dirty = () => !!snapshot && (title.value !== snapshot.title || transition.value !== '');
  const api = createCalendarDialog({
    document, title: 'Изменить в Jira', hint: record.title, returnFocus, isCurrent,
    beforeClose: () => { if (dirty()) throw new Error('Есть несохранённые изменения. Сохрани их в Jira или нажми «Отменить черновик».'); },
    onClose: () => { disposed = true; },
  });
  api.modal.classList.add('calendar-jira-editor');
  api.body.innerHTML = `<p class="calendar-jira-editor-hint">Изменения отправляются в Jira по кнопке. Этап работы и завершение задачи в Cicada изменяются отдельно.</p>
    <p data-jira-current role="status">Загружаем состояние Jira…</p>
    <label>Название в Jira<input type="text" maxlength="500" data-jira-title autocomplete="off"></label>
    <button type="button" data-jira-rename>Сохранить название в Jira</button>
    <label>Новый статус Jira<select data-jira-transition><option value="">Выбери переход</option></select></label>
    <button type="button" data-jira-move>Изменить статус в Jira</button>
    <p data-jira-editor-status role="status" aria-live="polite"></p>
    <div class="calendar-sync-actions"><button type="button" data-jira-refresh>Обновить из Jira</button><button type="button" data-jira-reset hidden>Отменить черновик</button></div>`;
  const q = name => api.body.querySelector(`[data-jira-${name}]`);
  const live = () => !disposed && api.modal.isConnected && isCurrent();
  const title = q('title'), transition = q('transition');
  const close = api.modal.querySelector('.calendar-editor-actions [data-dialog-close]');
  close.textContent = 'Закрыть';
  function render() {
    if (disposed) return;
    const allowed = !busy && snapshot?.editable === true && !mustRefresh;
    title.disabled = !allowed;
    transition.disabled = !allowed || !snapshot?.transitions?.length;
    q('rename').disabled = !allowed || !title.value.trim() || title.value.trim() === snapshot.title;
    q('move').disabled = !allowed || !transition.value;
    q('refresh').disabled = busy;
    q('reset').hidden = !dirty(); q('reset').disabled = busy;
  }
  function accept(next, { keepDraft = false } = {}) {
    const titleDraft = snapshot && title.value !== snapshot.title ? title.value : null;
    snapshot = next;
    title.value = keepDraft && titleDraft !== null ? titleDraft : next.title;
    q('current').textContent = `Сейчас в Jira: ${next.title} · Статус: ${next.status}`;
    transition.replaceChildren(new window.Option(next.transitions.length ? 'Выбери переход' : 'Доступных переходов нет', ''));
    for (const item of next.transitions) transition.append(new window.Option(`${item.status} · ${item.name}`, item.id));
    transition.value = '';
    mustRefresh = false;
  }
  const notify = () => {
    onChanged?.();
    window.dispatchEvent(new window.Event('hanni:jira-imported'));
  };
  async function perform(command, args, { mutation = false } = {}) {
    if (busy || !live()) return;
    busy = true; api.setPending(true); api.showError(''); render();
    q('editor-status').textContent = mutation ? 'Отправляем изменение в Jira…' : 'Обновляем состояние…';
    try {
      const next = await invoke(command, { itemId: String(record.source_id), ...args });
      if (!live()) return;
      accept(next, { keepDraft: command !== 'jira_task_rename' });
      q('editor-status').textContent = mutation ? 'Изменение подтверждено Jira.' : 'Состояние обновлено.';
      if (mutation || next.changed > 0) notify();
    } catch (cause) {
      if (!live()) return;
      const code = typeof cause === 'string' ? cause : cause?.message;
      // An ambiguous write must be read back before another explicit write is allowed.
      if (code === 'jira_write_outcome_unknown' || code === 'jira_task_conflict') mustRefresh = true;
      q('editor-status').textContent = '';
      api.showError(jiraErrorText(code));
    } finally {
      busy = false;
      if (!disposed) { api.setPending(false); render(); }
    }
  }
  title.addEventListener('input', render);
  transition.addEventListener('change', render);
  api.form.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target === title) event.preventDefault(); });
  q('rename').onclick = () => {
    if (!snapshot || busy || mustRefresh || q('rename').disabled) return;
    void perform('jira_task_rename', { title: title.value.trim(), expectedTitle: snapshot.title }, { mutation: true });
  };
  q('move').onclick = () => {
    if (!snapshot || busy || mustRefresh || q('move').disabled) return;
    void perform('jira_task_transition', { transitionId: transition.value, expectedStatus: snapshot.status }, { mutation: true });
  };
  q('refresh').onclick = () => void perform('jira_task_details', {});
  q('reset').onclick = () => { if (busy || !snapshot) return; title.value = snapshot.title; transition.value = ''; api.showError(''); render(); };
  api.open(); render();
  void perform('jira_task_details', {});
  return () => { disposed = true; api.modal.close(); };
}
