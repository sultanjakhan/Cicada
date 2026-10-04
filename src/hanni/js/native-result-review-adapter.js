// Real native command binding, opt-in only. No profile/owner/path/dispatcher inputs.
const states = new Set(['awaiting_review', 'accepted', 'awaiting_dispatch']);
function projection(value, taskId) {
  if (value?.taskId !== taskId || !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1 || !Number.isSafeInteger(value.resultVersion) || value.resultVersion < 1 || typeof value.content !== 'string' || !states.has(value.reviewState) || !Array.isArray(value.history)) throw Error('Invalid native review projection');
  return structuredClone(value);
}
export function createNativeResultReviewAdapter(taskId, invoke) {
  if (typeof taskId !== 'string' || !taskId || typeof invoke !== 'function') throw Error('Existing native task identity required');
  const readBundle = async command => {
    const value = await invoke(command, { taskId });
    return { projection: projection(value?.projection, taskId), pending: value.pending };
  };
  return {
    async read(id) { if (id !== taskId) throw Error('Native task mismatch'); return (await readBundle('read_task_result_review')).projection; },
    async recover() {
      const value = await readBundle('recover_task_result_review');
      if (!Array.isArray(value.pending)) throw Error('Invalid native recovery');
      const pending = value.pending.filter(item => item.state === 'queued');
      if (pending.length > 1) throw Error('Ambiguous native review operation');
      for (const item of value.pending) if (item.request?.task_id !== taskId) throw Error('Native recovery task mismatch');
      return structuredClone(value);
    },
    async submit(request) {
      const fields = ['task_id', 'expected_revision', 'result_version', 'operation_id', 'action', ...(request?.action === 'rework' ? ['comment'] : [])];
      if (!request || request.task_id !== taskId || !['accept','rework'].includes(request.action) || Object.keys(request).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(request, key))) throw Error('Invalid native review request');
      const queued = await invoke('enqueue_task_result_review', { input: structuredClone(request) });
      if (queued?.kind !== 'queued' || queued.operation_id !== request.operation_id) throw Error('Unconfirmed native enqueue');
      // Applying a local user decision is not external dispatch and cannot start work.
      const receipt = await invoke('commit_task_result_review', { operationId: request.operation_id });
      if (receipt?.kind !== 'acknowledged' || receipt.operation_id !== request.operation_id) throw Error('Unconfirmed native receipt');
      projection(receipt.projection, taskId);
      // Original retry receipts may be older. Always render a fresh consistent read.
      return { kind: 'acknowledged', operation_id: request.operation_id, projection: (await readBundle('read_task_result_review')).projection };
    },
  };
}
// Call before mounting the existing review component. Cancellation/lifetime ownership
// of this preparation belongs to the caller; never mutate a mounted lifetime's drafts.
export async function prepareNativeResultReview(record, invoke, operationId) {
  if (record?.source_type !== 'note' || typeof record.source_id !== 'string' || !record.source_id || record.readonly) throw Error('Existing editable native task required');
  const taskId = record.source_id; // Exact native items.id, no synthetic ID/namespace mapping.
  const adapter = createNativeResultReviewAdapter(taskId, invoke);
  const recovered = await adapter.recover();
  const latest = recovered.pending.at(-1);
  const queued = recovered.pending.find(item => item.state === 'queued');
  const drafts = new Map();
  drafts.set(taskId, { comment: queued?.request.comment || (latest?.state === 'conflict' ? latest.request.comment || '' : ''), pending: queued ? structuredClone(queued.request) : null, outcome: queued ? 'queued' : null });
  return { taskId, adapter, drafts, operationId };
}
