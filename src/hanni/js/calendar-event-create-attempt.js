// One unresolved ordinary-event attempt, like the ordinary-note recovery boundary.
// The immutable request survives a rejected acknowledgement and a reopened editor.
export const EVENT_CREATE_PENDING_KEY = 'calendar_event_create_pending_local_v1';
const operationId = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
export function readEventCreateAttempt(storage) {
  const raw = storage.getItem(EVENT_CREATE_PENDING_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (value.version !== 1 || !operationId(value.operationId)
    || !value.payload || !value.originalDraft || !value.draft || typeof value.startNow !== 'boolean') throw Error('event_create_invalid_attempt');
  if (value.nextIntent && (!operationId(value.nextIntent.operationId) || value.nextIntent.operationId === value.operationId || typeof value.nextIntent.receiptId !== 'string' || !value.nextIntent.receiptId)) throw Error('event_create_invalid_attempt');
  return value;
}
export function writeEventCreateAttempt(storage, attempt) {
  const current = readEventCreateAttempt(storage);
  if (current && current.operationId !== attempt.operationId) throw Error('event_create_other_attempt');
  storage.setItem(EVENT_CREATE_PENDING_KEY, JSON.stringify(attempt));
}
export function clearEventCreateAttempt(storage, attempt) {
  const current = readEventCreateAttempt(storage);
  if (current && current.operationId !== attempt.operationId) throw Error('event_create_other_attempt');
  storage.removeItem(EVENT_CREATE_PENDING_KEY);
}
// Only a separately confirmed, durable intent may replace the active operation.
// Keep one prior snapshot during recovery; the original native receipt is never changed.
export function activateSeparateEventAttempt(storage, previous, next) {
  const current = readEventCreateAttempt(storage);
  if (!current || current.operationId !== previous.operationId || !current.nextIntent
    || current.nextIntent.operationId !== next.operationId) throw Error('event_create_other_attempt');
  const replacement = { ...next, previousAttempt: { operationId: current.operationId, payload: current.payload,
    originalDraft: current.originalDraft, draft: next.draft, receiptId: current.nextIntent.receiptId } };
  storage.setItem(EVENT_CREATE_PENDING_KEY, JSON.stringify(replacement));
  return replacement;
}
export async function readCreatedEvent(invoke, id) {
  if (typeof id !== 'string' || !id) throw Error('event_create_invalid_receipt');
  const events = await invoke('get_all_events');
  if (!Array.isArray(events)) throw Error('event_create_invalid_readback');
  const event = events.find(row => String(row.id) === id);
  // A successfully read list plus the committed receipt distinguishes absence
  // (including archived rows excluded by get_all_events) from transport UNKNOWN.
  if (!event || event.archived) return { id, state: 'missing', event: event || null };
  if (event.readonly || !Number.isSafeInteger(event.version) || event.version < 1) throw Error('event_create_invalid_readback');
  return { id, state: 'available', event };
}
export async function recoverEventCreateAttempt(invoke, attempt) {
  const id = await invoke('create_event', { ...attempt.payload, operationId: attempt.operationId, recoverOnly: true });
  return id == null ? null : readCreatedEvent(invoke, id);
}
export function matchesCreatedEvent(event, payload) {
  return event.title === payload.title && event.description === payload.description && event.date === payload.date
    && (event.time || '') === payload.time && Number(event.duration_minutes) === payload.durationMinutes
    && event.category === payload.category && event.color === payload.color && Number(event.priority) === payload.priority;
}
