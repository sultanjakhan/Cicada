// A retry must never turn an uncertain archive into a restore. Re-read the same
// record/version and require the explicit target state before the guarded toggle.
export async function changeTaskArchive(invoke, record, archived) {
  if (!record || record.source_type !== 'note' || record.readonly || typeof archived !== 'boolean') throw new Error('invalid task archive request');
  const id = String(record.source_id);
  const current = await invoke('get_calendar_task', {id});
  if (!current || String(current.id) !== id || !Number.isSafeInteger(current.version)
    || (record.version != null && current.version !== record.version)
    || !!current.archived !== !!record.archived || !!current.archived === archived) throw new Error('task changed elsewhere');
  await invoke('toggle_note_archive', {id, expectedVersion:current.version});
  const saved = await invoke('get_calendar_task', {id});
  if (!saved || String(saved.id) !== id || !!saved.archived !== archived || saved.version !== current.version + 1) throw new Error('task archive outcome requires a fresh read');
  return saved;
}
