// Task time of day, kind and sphere (#96). Rows come from the native task
// queries: `planned_time` (lists) or `time` (details), `task_kind`, `sphere`.
export const TASK_SPHERES = Object.freeze([
  ['work', 'Работа'], ['home', 'Дом'], ['health', 'Здоровье'], ['growth', 'Развитие'], ['personal', 'Личное'],
]);
const SPHERE_LABELS = new Map(TASK_SPHERES);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const sphereLabel = id => SPHERE_LABELS.get(id) || '';
// Older records and schedule projections carry no kind: they are normal.
export const isInstantTask = row => row?.source_type !== 'schedule' && row?.task_kind === 'instant';
// A time of day belongs to a dated task only.
export function taskTime(row) {
  const value = String(row?.planned_time ?? row?.time ?? '').slice(0, 5);
  return row?.date && TIME.test(value) ? value : '';
}
// Within one day timed tasks come first, ordered by time; untimed keep their order.
export function compareTaskTime(a, b) {
  const left = taskTime(a), right = taskTime(b);
  return left === right ? 0 : !left ? 1 : !right ? -1 : left.localeCompare(right);
}
