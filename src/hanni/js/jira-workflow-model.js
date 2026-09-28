export const JIRA_WORKFLOW_ROLES = [
  ['ready', 'К выполнению'], ['working', 'Начатые'], ['review', 'На проверке'],
  ['completed', 'Сделано'], ['hidden', 'Скрыть из рабочей очереди'],
];

export const isWorkflowTask = row => row?.source_type === 'note' && /^jira:[a-f0-9]{64}$/.test(String(row.source_id ?? row.id));
export const jiraWorkflowRole = row => isWorkflowTask(row) ? row.jira_workflow_role || 'unassigned' : null;
export const jiraCanStart = row => !isWorkflowTask(row) || ['ready', 'working'].includes(jiraWorkflowRole(row));
export const inWorkingQueue = row => Boolean(row?.is_active) || jiraCanStart(row);
export const jiraIsCompleted = row => !row?.is_active && jiraWorkflowRole(row) === 'completed';

// Existing local work may be resumed; a newly recommended Jira task must be ready.
export function jiraCanRecommend(row) {
  if (!isWorkflowTask(row) || row.is_active) return true;
  const role = jiraWorkflowRole(row);
  return role === 'ready' || role === 'working' && Boolean(row.has_work || Number(row.actual_seconds) > 0 || Number(row.actual_minutes) > 0);
}
