// One unresolved ordinary-event attempt, like the ordinary-note recovery boundary.
// The immutable request survives a rejected acknowledgement and a reopened editor.
export const EVENT_CREATE_PENDING_KEY = 'calendar_event_create_pending_local_v1';
export function readEventCreateAttempt(storage) {
  const raw = storage.getItem(EVENT_CREATE_PENDING_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (value.version !== 1 || typeof value.operationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.operationId)
    || !value.payload || !value.originalDraft || !value.draft || typeof value.startNow !== 'boolean') throw Error('event_create_invalid_attempt');
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
export async function readCreatedEvent(invoke, id) {
  if (typeof id !== 'string' || !id) throw Error('event_create_invalid_receipt');
  const events = await invoke('get_all_events');
  const event = events.find(row => String(row.id) === id);
  if (!event || event.archived || event.readonly || !Number.isSafeInteger(event.version) || event.version < 1) throw Error('event_create_unavailable');
  return event;
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
