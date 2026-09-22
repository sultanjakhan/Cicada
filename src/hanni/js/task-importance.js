// Task importance is independent of its date and execution state.
export function renderTaskImportance(document, host, task, surface = host) {
  host.querySelectorAll('[data-important-badge]').forEach(label => label.remove());
  const important = task?.source_type === 'note'
    && Number.isFinite(Number(task?.priority)) && Number(task.priority) >= 5;
  surface.classList.toggle('task-important', important);
  if (!important) return;
  const label = document.createElement('span');
  label.className = 'task-importance-label';
  label.dataset.importantBadge = '';
  label.textContent = 'Важная задача';
  host.prepend(label);
}
