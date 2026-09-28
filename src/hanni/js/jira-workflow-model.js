export const JIRA_WORKFLOW_ROLES = [
  ['ready', 'К выполнению'], ['working', 'Начатые'], ['review', 'На проверке'],
  ['completed', 'Сделано'], ['hidden', 'Только в «Все»'],
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

// Preview the saved task snapshot using draft rules; no titles leave this function.
export function workflowPreview(rows, scope, mappings) {
  const rules = new Map(mappings.map(status => [status.name, status.bucket]));
  const counts = { queue: 0, review: 0, completed: 0, all: 0, onlyAll: 0 };
  const seen = new Set();
  for (const row of rows) {
    if (!isWorkflowTask(row) || row.jira_workflow_scope !== scope || row.readonly || row.archived || seen.has(row.source_id)) continue;
    seen.add(row.source_id); counts.all++;
    const role = rules.get(row.jira_status);
    if (row.is_active) counts.queue++;
    else if (row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra) || role === 'completed') counts.completed++;
    else if (role === 'ready' || role === 'working') counts.queue++;
    else if (role === 'review') counts.review++;
    else counts.onlyAll++;
  }
  return counts;
}
