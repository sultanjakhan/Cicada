import { createSharedResultReviewAdapter, prepareSharedResultReview } from './shared-result-review-adapter.js';
import { createNativeResultReviewAdapter, prepareNativeResultReview } from './native-result-review-adapter.js';

const sharedAbsent = error => error?.status === 404 && ['shared_task_not_found', 'no_review_result'].includes(error.code);
export const isCalendarReviewAbsent = sharedAbsent;
const exactId = id => { if (typeof id !== 'string' || !id) throw Error('Exact native task identity required'); return id; };

// Select an existing authority. No persistence, transport or result mapping lives here.
export function createCalendarReviewSource(invoke, { nativeReview = false, operationId = () => crypto.randomUUID() } = {}) {
  return {
    async read(taskId) {
      exactId(taskId);
      try { return await createSharedResultReviewAdapter(taskId, invoke, operationId).read(taskId); }
      catch (error) {
        if (!nativeReview || !sharedAbsent(error)) throw error;
        return createNativeResultReviewAdapter(taskId, invoke).read(taskId);
      }
    },
    async prepare(record) {
      exactId(record?.source_id);
      if (record.source_type !== 'note' || record.readonly) throw Error('Editable native task required');
      try { return await prepareSharedResultReview(record, invoke, operationId); }
      catch (error) {
        if (!nativeReview || !sharedAbsent(error)) throw error;
        return prepareNativeResultReview(record, invoke, operationId);
      }
    },
  };
}
