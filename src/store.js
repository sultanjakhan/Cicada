export async function createStore() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) return {
    preview: false,
    list: () => invoke('list_items'),
    save: input => invoke('save_item', { input }),
    complete: item => invoke('set_completed', { id: item.id, expectedVersion: item.version, completed: !item.completed }),
    remove: item => invoke('delete_item', { id: item.id, expectedVersion: item.version }),
    backup: () => invoke('create_backup'),
  };
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === '1') {
    const { previewStore } = await import('./preview-store.js');
    return previewStore();
  }
  throw new Error('Открой Cicada как приложение. Предпросмотр доступен только в режиме разработки.');
}
