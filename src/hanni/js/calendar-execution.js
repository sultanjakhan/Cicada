// Several tasks may run at once (owner decision 2026-09-24). Starting work never
// pauses another task; reading or selecting a task never calls these helpers.
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
export async function startCalendarExecution(invoke, task) {
  const running = (await readActiveBlocks(invoke)).find(block => sourceKey(block) === sourceKey(task));
  if (running) return running.id;
  return invoke('start_task_block', { sourceType: task.source_type, sourceId: String(task.source_id), completionDate: task.completion_date || task.date || localDay() });
}

/** Pauses only this task's running block(s); other running tasks stay untouched. */
export async function pauseCalendarExecution(invoke, task) {
  const own = (await readActiveBlocks(invoke)).filter(block => sourceKey(block) === sourceKey(task));
  for (const block of own) await invoke('pause_task_block', { blockId: Number(block.id) });
  return own.length;
}
const localDay=()=>{const date=new Date();return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
