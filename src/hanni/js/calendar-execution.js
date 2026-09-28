// Several tasks may run at once (owner decision 2026-09-24). Starting work never
// pauses another task; reading or selecting a task never calls these helpers.
import { confirmJiraWorkflowAction, jiraLocalExecutionError } from './jira-workflow-action.js';
import { isJiraTask } from './jira-task.js';

export const sourceKey = row => row ? `${row.source_type}:${String(row.source_id)}` : '';

/** Every running block, newest first. Older mocks and hosts expose only the single-row command. */
export async function readActiveBlocks(invoke) {
  try {
    const rows = await invoke('get_active_blocks', {});
    if (Array.isArray(rows)) return rows;
  } catch (error) {
    const message = typeof error === 'string' ? error : error?.message;
    if (!String(message || '').includes('get_active_blocks')) throw error;
  }
  const active = await invoke('get_active_block', {});
  return active ? [active] : [];
}

/** Starts the task beside any other running work. The same running task is a no-op. */
export async function startCalendarExecution(invoke, task, options = {}) {
  const running = (await readActiveBlocks(invoke)).find(block => sourceKey(block) === sourceKey(task));
  if (running) return running.id;
  if (!await confirmJiraWorkflowAction(invoke, task, 'start', options)) return null;
  try {
    return await invoke('start_task_block', { sourceType: task.source_type, sourceId: String(task.source_id), completionDate: task.completion_date || task.date || localDay() });
  } catch (error) { if (isJiraTask(task)) throw jiraLocalExecutionError('start'); throw error; }
}

/** Confirm the Jira destination before stopping this task's captured blocks or completing locally. */
export async function finishCalendarExecution(invoke, task, options = {}) {
  if (!isJiraTask(task) && options.blockId != null) return invoke('finish_task_block', { blockId: options.blockId });
  const own = (await readActiveBlocks(invoke)).filter(block => sourceKey(block) === sourceKey(task));
  if (!await confirmJiraWorkflowAction(invoke, task, 'finish', options)) return false;
  try {
    // A concurrently restarted block must be rejected by completion, not paused here.
    for (const block of own) await invoke('pause_task_block', { blockId: Number(block.id) });
    await invoke('complete_calendar_task', { id: String(task.source_id) });
    return true;
  } catch (error) {
    if (isJiraTask(task)) throw jiraLocalExecutionError('finish');
    if (own.length) throw Object.assign(new Error('Не удалось завершить задачу после паузы. Обнови задачу и повтори завершение.'), { refreshRequired: true });
    throw error;
  }
}

export async function reviewCalendarExecution(invoke, task, options = {}) {
  if (!isJiraTask(task)) throw new Error('Отправка на проверку доступна для задач Jira.');
  const own = (await readActiveBlocks(invoke)).filter(block => sourceKey(block) === sourceKey(task));
  if (!await confirmJiraWorkflowAction(invoke, task, 'review', options)) return false;
  try { for (const block of own) await invoke('pause_task_block', { blockId: Number(block.id) }); }
  catch { throw jiraLocalExecutionError('review'); }
  return true;
}

/** Pauses only this task's running block(s); other running tasks stay untouched. */
export async function pauseCalendarExecution(invoke, task) {
  const own = (await readActiveBlocks(invoke)).filter(block => sourceKey(block) === sourceKey(task));
  for (const block of own) await invoke('pause_task_block', { blockId: Number(block.id) });
  return own.length;
}
const localDay=()=>{const date=new Date();return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
