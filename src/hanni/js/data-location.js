export function mountDataLocation(element, { invoke }) {
  const en = document.documentElement.lang.toLowerCase().startsWith('en');
  const text = en ? {
    title: 'Data folder', field: 'New local folder', placeholder: 'D:\\Cicada-data', action: 'Prepare move on next launch', loading: 'Loading…', hint: 'The external agent endpoint follows the default profile and remains available after the move.',
    empty: 'Enter an absolute path to the new folder.', checking: 'Checking folder…', ready: 'Ready. Data will move after restart. The original folder remains available for rollback.', error: 'Could not prepare the move.', current: 'Current folder:'
  } : {
    title: 'Папка данных', field: 'Новая локальная папка', placeholder: 'D:\\Cicada-data', action: 'Подготовить перенос при следующем запуске', loading: 'Загружаем…', hint: 'Внешняя точка подключения агента привязана к профилю по умолчанию и сохраняется после переноса.',
    empty: 'Укажи абсолютный путь к новой папке.', checking: 'Проверяем папку…', ready: 'Готово. Данные будут перенесены после перезапуска. Исходная папка останется доступной для отката.', error: 'Не удалось подготовить перенос.', current: 'Текущая папка:'
  };
  const section = document.createElement('section');
  section.className = 'data-location-settings';
  section.innerHTML = `<h3>${text.title}</h3><p class="calendar-setting-hint" data-location-current>${text.loading}</p><p class="calendar-setting-hint">${text.hint}</p>
    <label class="data-location-field">${text.field}<input type="text" data-location-input autocomplete="off" spellcheck="false" placeholder="${text.placeholder}"></label>
    <button type="button" data-location-prepare>${text.action}</button>
    <p class="calendar-settings-status" data-location-status role="status" aria-live="polite"></p>`;
  element.append(section);
  const current = section.querySelector('[data-location-current]');
  const input = section.querySelector('[data-location-input]');
  const action = section.querySelector('[data-location-prepare]');
  const status = section.querySelector('[data-location-status]');
  let disposed = false;
  invoke('get_data_location').then(value => { if (!disposed) { current.textContent = `${text.current} ${value.path}${value.restart_required ? (en ? ' · move will apply after restart' : ' · перенос будет применён после перезапуска') : ''}`; if(value.migration_error) status.textContent = en ? 'The move failed. The original folder stays active. Choose another empty folder.' : value.migration_error; } }).catch(error => { current.textContent = error?.message || (en ? 'Could not determine the data folder.' : 'Не удалось определить папку данных.'); });
  action.addEventListener('click', async () => {
    if (!input.value.trim()) { status.textContent = text.empty; return; }
    action.disabled = true; status.textContent = text.checking;
    try { const value = await invoke('prepare_data_location', { path: input.value.trim() }); status.textContent = text.ready; current.textContent = `${text.current} ${value.path} · ${en ? 'move will apply after restart' : 'перенос будет применён после перезапуска'}`; input.value = ''; }
    catch (error) { status.textContent = error?.message || text.error; }
    finally { action.disabled = false; }
  });
  return () => { disposed = true; section.remove(); };
}
