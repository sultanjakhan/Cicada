// Planning changes the existing task; it never creates an event or a timer block.
export async function planCalendarTaskForDay(invoke, id, date, isCurrent = () => true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Выбери день для задачи.');
  const task = await invoke('get_calendar_task', { id: String(id) });
  if (!isCurrent()) return false;
  if (!task || String(task.id) !== String(id) || task.archived || task.completed || task.status !== 'task') throw new Error('Задача уже недоступна. Обнови список.');
  if (task.due_date || task.date) throw new Error('У задачи уже есть дата. Обнови список перед переносом.');
  await invoke('save_calendar_task', {
    id: String(task.id), title: task.title, dueDate: date,
    estimateMinutes: task.duration_minutes ?? null, goalId: task.goal_id ?? null,
    expectedVersion: task.version,
  });
  return true;
}
