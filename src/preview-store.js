// Development-only UI adapter. Never imported by the production build.
export function previewStore(storage = sessionStorage) {
  const key = 'hanni-mvp-preview-v1';
  const read = () => JSON.parse(storage.getItem(key) || '[]');
  const write = items => storage.setItem(key, JSON.stringify(items));
  function current(items, id, version) {
    const item = items.find(value => value.id === id);
    if (!item) throw new Error('Запись больше не существует. Обнови календарь.');
    if (item.version !== version) throw new Error('Запись уже изменена. Закрой редактор и открой её снова.');
    return item;
  }
  return {
    preview: true,
    async list() { return read(); },
    async save(input) {
      const items = read();
      const old = input.id ? current(items, input.id, input.expected_version) : null;
      const { expected_version, ...fields } = input;
      const item = { ...fields, id: old?.id || crypto.randomUUID(), version: (old?.version || 0) + 1, created_at: old?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      write([...items.filter(value => value.id !== item.id), item]);
      return item;
    },
    async complete(item) {
      if (item.kind !== 'task') throw new Error('Завершать можно только задачи.');
      return this.save({ ...item, completed: !item.completed, expected_version: item.version });
    },
    async remove(item) {
      const items = read();
      current(items, item.id, item.version);
      write(items.filter(value => value.id !== item.id));
    },
    async backup() { throw new Error('Резервные копии доступны в приложении.'); },
  };
}
