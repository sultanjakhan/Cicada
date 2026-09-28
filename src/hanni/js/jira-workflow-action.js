import { createCalendarDialog } from './calendar-dialog.js';
import { jiraErrorText } from './jira-import.js';
import { isJiraTask } from './jira-task.js';

const workflowErrors = {
  jira_workflow_conflict: 'Настройка статусов Jira изменилась. Обнови задачу перед следующим действием.',
  jira_workflow_unmapped: 'Не удалось определить действие для этого статуса. Обнови задачи Jira и проверь назначение статусов в настройках подключения.',
  jira_workflow_action_unavailable: 'Из текущего статуса Jira это действие недоступно. Открой задачу и проверь доступные переходы.',
  jira_write_outcome_unknown: 'Jira могла принять изменение, но подтверждение не получено. Таймер не изменён. Обнови состояние Jira перед следующей попыткой.',
};

function workflowError(cause) {
  const code = typeof cause === 'string' ? cause : cause?.message;
  return Object.assign(new Error(workflowErrors[code] || jiraErrorText(code)), { jiraWorkflow: true, refreshRequired: true });
}

export function chooseJiraWorkflowTransition(snapshot, action, document = globalThis.document) {
  if (!document) throw 'jira_workflow_action_unavailable';
  return new Promise(resolve => {
    let selected = null;
    const api = createCalendarDialog({ document, title: 'Выбери переход Jira', hint: snapshot.title,
      submitLabel: { start: 'Начать задачу', finish: 'Завершить задачу', review: 'Отправить на проверку' }[action],
      onClose: () => resolve(selected) });
    const text = document.createElement('p');
    text.textContent = `Сейчас: ${snapshot.status}. Jira предлагает несколько переходов для этого действия.`;
    const label = document.createElement('label'); label.textContent = 'Переход';
    const select = document.createElement('select'); select.dataset.jiraWorkflowTransition = '';
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Выбери переход'; select.append(placeholder);
    for (const transition of snapshot.transitions) {
      const option = document.createElement('option'); option.value = transition.id;
      option.textContent = `${transition.status} · ${transition.name}`; select.append(option);
    }
    label.append(select); api.body.append(text, label); api.submit.disabled = true;
    select.addEventListener('change', () => { api.submit.disabled = !select.value; });
    api.form.addEventListener('submit', event => {
      event.preventDefault();
      if (!snapshot.transitions.some(item => item.id === select.value)) return;
      selected = select.value; api.close();
    });
    api.open(select);
  });
}

/** A Jira write only follows this explicit user action; a rejected write is never replayed. */
export async function confirmJiraWorkflowAction(invoke, task, action, options = {}) {
  if (!isJiraTask(task)) return true;
  let requested = false;
  try {
    const current = await invoke('get_calendar_task', { id: String(task.source_id) });
    if (!current?.jira_workflow_revision || !current.jira_status) throw 'jira_workflow_unmapped';
    const args = { itemId: String(task.source_id), action, expectedStatus: current.jira_status,
      expectedRevision: current.jira_workflow_revision, transitionId: null };
    requested = true;
    let snapshot = await invoke('jira_task_workflow_action', args);
    if (snapshot?.workflowOutcome === 'choose') {
      const choose = options.chooseTransition || ((next, kind) => chooseJiraWorkflowTransition(next, kind, options.document));
      const transitionId = await choose(snapshot, action);
      if (!transitionId) return false;
      if (!snapshot.transitions.some(item => item.id === transitionId)) throw 'jira_transition_invalid';
      snapshot = await invoke('jira_task_workflow_action', { ...args, transitionId,
        expectedStatus: snapshot.status, expectedRevision: snapshot.workflowRevision });
    }
    if (snapshot?.workflowOutcome !== 'confirmed') throw 'jira_write_outcome_unknown';
    return true;
  } catch (cause) {
    const code = typeof cause === 'string' ? cause : cause?.message;
    throw workflowError(requested && !workflowErrors[code] && jiraErrorText(code) === jiraErrorText(undefined) ? 'jira_write_outcome_unknown' : cause);
  }
}

export function jiraLocalExecutionError(action) {
  return Object.assign(new Error({
    start: 'Статус Jira подтверждён. Запуск таймера не подтверждён — обнови задачу перед продолжением.',
    finish: 'Статус завершения подтверждён Jira. Завершение в Cicada не подтверждено — обнови задачу перед следующей попыткой.',
    review: 'Задача отправлена на проверку в Jira. Пауза таймера не подтверждена — обнови задачу и проверь таймер.',
  }[action]), { jiraWorkflow: true, refreshRequired: true });
}
