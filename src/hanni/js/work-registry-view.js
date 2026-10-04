import { registryStatusLabel, registryFreshnessLabel } from './work-registry-labels.js';
import { createRegistryStore, validateRegistry, freshness } from './work-registry.js';

export function mountWorkRegistry(host, { invoke }) {
  const d = host.ownerDocument, store = createRegistryStore(invoke);
  let disposed = false, preview = null, busy = false;
  const root = d.createElement('details'), summary = d.createElement('summary'); summary.textContent = 'Импортированный рабочий реестр';
  const hint = d.createElement('p'); hint.textContent = 'Снимки engineering-задач, опубликованные родителем. Это не live-поток и не запуск исполнителя.';
  const label = d.createElement('label'); label.textContent = 'JSON снимка';
  const input = d.createElement('textarea'); input.rows = 5; input.maxLength = 1048576; label.append(input);
  const check = d.createElement('button'); check.type = 'button'; check.textContent = 'Предварительный просмотр';
  const save = d.createElement('button'); save.type = 'button'; save.textContent = 'Импортировать просмотренный снимок'; save.disabled = true;
  const status = d.createElement('p'); status.setAttribute('role','status');
  const list = d.createElement('div'); list.setAttribute('aria-label','Импортированные работы');
  function render(snapshots) {
    list.replaceChildren();
    for (const s of snapshots) {
      const source = d.createElement('p'); source.textContent = `Источник: ${s.source.publisherId} • опубликован ${s.publishedAt} • снимок ${s.sequence}`; list.append(source);
      const ol = d.createElement('ul');
      for (const t of s.tasks) {
        const row = d.createElement('li');
        row.textContent = `${t.title} — ${registryStatusLabel(t.status)} • ${registryFreshnessLabel(freshness(s,t))} • ${t.lastUpdated}${t.parentTaskId ? ` • подзадача ${t.parentTaskId}, ${t.relationship}` : ''} • источник: ${t.provenance.reference}`;
        for (const [key,title] of [['operation','Операция'],['waitingFor','Ожидает'],['result','Результат']]) if (t[key]) { const p = d.createElement('p'); p.textContent = `${title}: ${t[key]}`; row.append(p); }
        ol.append(row);
      }
      list.append(ol);
    }
  }
  input.addEventListener('input', () => { preview = null; save.disabled = true; });
  check.addEventListener('click', () => { try { preview = validateRegistry(input.value); render([preview]); status.textContent = 'Предпросмотр. Данные ещё не сохранены.'; save.disabled = false; } catch { preview = null; save.disabled = true; status.textContent = 'Снимок некорректен или содержит неподдерживаемые поля. Ничего не сохранено.'; } });
  save.addEventListener('click', async () => {
    if (!preview || busy) return; busy = true; save.disabled = check.disabled = input.disabled = true;
    try { const result = await store.import(JSON.stringify(preview)); if (!disposed) { render(Object.values(await store.load())); status.textContent = result.changed ? 'Снимок сохранён. Задачи и ручные шаги не изменены.' : 'Этот снимок уже сохранён.'; preview = null; input.value = ''; d.defaultView.dispatchEvent(new d.defaultView.CustomEvent('hanni:work-registry-changed')); } }
    catch { if (!disposed) status.textContent = 'Импорт не подтверждён. Проверь sequence или перечитай состояние.'; }
    finally { busy = false; if (!disposed) { check.disabled = input.disabled = false; save.disabled = !preview; } }
  });
  root.append(summary,hint,label,check,save,status,list); host.append(root);
  void store.load().then(all => { if (!disposed) render(Object.values(all)); }, () => { if (!disposed) status.textContent = 'Сохранённый реестр недоступен. Импорт не выполнялся.'; });
  return () => { disposed = true; };
}
