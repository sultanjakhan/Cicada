import { MAX_IMPORT_BYTES, previewPersonalImport, applyPersonalImport } from './personal-task-import.js';

export const personalImportErrorText = (value, language = 'ru') => {
  const message = typeof value === 'string' ? value : value?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : language.toLowerCase().startsWith('en') ? 'Import failed. Try preview again.' : 'Не удалось выполнить импорт. Повтори предварительный просмотр.';
};

export function mountPersonalTaskImport(host, { invoke, setPending = () => {}, onChanged = () => {} }) {
  const d = host.ownerDocument;
  const errorText = value => personalImportErrorText(value, d.documentElement.lang || 'ru');
  const details = d.createElement('details');
  const summary = d.createElement('summary'); summary.textContent = 'Импорт личных задач из файла';
  const hint = d.createElement('p'); hint.textContent = 'Предпросмотр ничего не записывает. Импорт создаёт резервную копию. Архив — только по явно указанным ID личных шаблонов.';
  const file = d.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', 'Файл личных задач');
  const previewButton = d.createElement('button'); previewButton.type = 'button'; previewButton.textContent = 'Предварительный просмотр';
  const apply = d.createElement('button'); apply.type = 'button'; apply.textContent = 'Создать backup и импортировать'; apply.disabled = true;
  const acknowledgement = d.createElement('label'); const checkbox = d.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = true;
  acknowledgement.append(checkbox, d.createTextNode('Я сохранил экспорт и план восстановления'));
  const exportButton = d.createElement('button'); exportButton.type = 'button'; exportButton.textContent = 'Сохранить экспорт и план восстановления'; exportButton.disabled = true;
  const list = d.createElement('ul'); const status = d.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.style.overflowWrap = 'anywhere';
  details.append(summary, hint, file, previewButton, list, exportButton, acknowledgement, apply, status); host.append(details);
  let plan = null, recovery = null, disposed = false, busy = false, exported = false;
  const save = async value => {
    const reportJson = JSON.stringify(value, null, 2);
    const result = await invoke('save_personal_import_recovery', { reportJson });
    if (!result || result.schemaVersion !== 1 || result.verified !== true || typeof result.path !== 'string' || !result.path || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) || result.bytes !== new TextEncoder().encode(reportJson).length) throw new Error('Сохранение и проверка экспорта не подтверждены.');
    return result;
  };
  function controls() {
    file.disabled = busy; previewButton.disabled = busy; checkbox.disabled = busy || !exported; exportButton.disabled = busy || (!plan && !recovery);
    apply.disabled = busy || !plan || !exported || !checkbox.checked;
  }
  file.addEventListener('change', () => { plan = null; recovery = null; exported = false; checkbox.checked = false; list.replaceChildren(); controls(); });
  checkbox.addEventListener('change', controls);
  exportButton.addEventListener('click', async () => {
    if (busy) return; busy = true; controls(); setPending(true);
    if (plan) recovery = { schemaVersion: 1, kind: 'personal-import-preview-export', before: plan.rows.filter(r => r.before).map(r => r.before), templateExport: plan.archives.map(r => r.before), actions: plan.rows.map(r => ({ externalId: r.externalId, action: r.action, title: r.fields.title })), rollback: 'Сохранить итоговый отчёт с путём штатного backup. Восстановление требует отдельного подтверждения; автоматического удаления нет.' };
    try { const receipt = await save(recovery); exported = true; status.textContent = `Экспорт сохранён и проверен: ${receipt.path}`; }
    catch (error) { exported = false; checkbox.checked = false; status.textContent = `Не удалось сохранить экспорт. ${errorText(error)} Повтори сохранение; импорт пока недоступен.`; }
    finally { busy = false; setPending(false); if (!disposed) controls(); }
  });
  previewButton.addEventListener('click', async () => {
    if (busy) return; busy = true; plan = null; recovery = null; exported = false; checkbox.checked = false; controls();
    try {
      const selected = file.files?.[0]; if (!selected || selected.size > MAX_IMPORT_BYTES) throw new Error('Выбери JSON до 64 КБ.');
      const result = await previewPersonalImport(invoke, await selected.text()); if (disposed) return; plan = result;
      list.replaceChildren();
      for (const row of plan.rows) { const li = d.createElement('li'); li.textContent = `${{ create: 'Создать', update: 'Обновить', skip: 'Уже записано' }[row.action]}: ${row.fields.title}`; const info = d.createElement('details'); const label = d.createElement('summary'); label.textContent = 'Описание и метки'; const content = d.createElement('pre'); content.style.whiteSpace = 'pre-wrap'; content.textContent = `${row.before && row.action === 'update' ? `Было: ${row.before.title}\n${row.before.content}\n\nСтанет: ` : ''}${row.fields.content}\n\nЛичная задача. Проекты: ${row.fields.tags.split(',').filter(tag => ['project:cicada', 'project:agent-city'].includes(tag)).map(tag => tag === 'project:cicada' ? 'Cicada' : 'Agent City').join(', ') || 'без проектов'}`; info.append(label, content); li.append(info); list.append(li); }
      for (const row of plan.archives) { const li = d.createElement('li'); li.textContent = `В архив: ${row.before.title} (версия ${row.before.version})`; list.append(li); }
      status.textContent = 'Проверь список, сохрани экспорт и подтверди его сохранение.';
    } catch (error) { if (!disposed) { list.replaceChildren(); status.textContent = errorText(error); } }
    finally { busy = false; if (!disposed) controls(); }
  });
  apply.addEventListener('click', async () => {
    if (busy || !plan || !exported || !checkbox.checked) return; busy = true; controls(); setPending(true);
    try {
      const report = await applyPersonalImport(invoke, plan, { saveRecovery: async value => { recovery = value; await save(value); } });
      await save(report); if (disposed) return;
      status.textContent = report.phase === 'unchanged' ? 'Все задачи уже записаны.' : 'Задачи записаны и перечитаны. Итоговый отчёт содержит путь backup.';
      plan = null; onChanged();
    } catch (error) {
      let exportFailed = false; try { if (recovery) await save(recovery); } catch { exportFailed = true; }
      if (!disposed) status.textContent = `${errorText(error)}${exportFailed ? ' Не удалось сохранить отчёт. Повтори его сохранение.' : ''}`;
      plan = null; onChanged();
    } finally { busy = false; setPending(false); if (!disposed) controls(); }
  });
  return () => { disposed = true; details.remove(); };
}
