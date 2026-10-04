import { createUiCopy } from './ui-copy.js';
import { registryStatusLabel, registryFreshnessLabel } from './work-registry-labels.js';
import { createRegistryStore, validateRegistry, freshness } from './work-registry.js';

export function mountWorkRegistry(host, { invoke }) {
  const d = host.ownerDocument, store = createRegistryStore(invoke);
  const copy = createUiCopy(d);
  let disposed = false, preview = null, busy = false;
  const root = d.createElement('details'), summary = d.createElement('summary'); summary.textContent = copy("Импортированный рабочий реестр");
  const hint = d.createElement('p'); hint.textContent = copy("Снимки engineering-задач, опубликованные родителем. Это не live-поток и не запуск исполнителя.");
  const label = d.createElement('label'); label.textContent = copy("JSON снимка");
  const input = d.createElement('textarea'); input.rows = 5; input.maxLength = 1048576; label.append(input);
  const check = d.createElement('button'); check.type = 'button'; check.textContent = copy("Предварительный просмотр");
  const save = d.createElement('button'); save.type = 'button'; save.textContent = copy("Импортировать просмотренный снимок"); save.disabled = true;
  const status = d.createElement('p'); status.setAttribute('role','status');
  const list = d.createElement('div'); list.setAttribute('aria-label',copy("Импортированные работы"));
  function render(snapshots) {
    list.replaceChildren();
    for (const s of snapshots) {
      const source = d.createElement('p'); source.textContent = `${copy("Источник: ")}${s.source.publisherId}${copy(" • опубликован ")}${s.publishedAt}${copy(" • снимок ")}${s.sequence}`; list.append(source);
      const ol = d.createElement('ul');
      for (const t of s.tasks) {
        const row = d.createElement('li');
        row.textContent = `${t.title} — ${registryStatusLabel(t.status, d.documentElement.lang)} • ${registryFreshnessLabel(freshness(s,t), d.documentElement.lang)} • ${t.lastUpdated}${t.parentTaskId ? `${copy(" • подзадача ")}${t.parentTaskId}, ${t.relationship}` : ''}${copy(" • источник: ")}${t.provenance.reference}`;
        for (const [key,title] of [['operation',copy("Операция")],['waitingFor',copy("Ожидает")],['result',copy("Результат")]]) if (t[key]) { const p = d.createElement('p'); p.textContent = `${title}: ${t[key]}`; row.append(p); }
        ol.append(row);
      }
      list.append(ol);
    }
  }
  input.addEventListener('input', () => { preview = null; save.disabled = true; });
  check.addEventListener('click', () => { try { preview = validateRegistry(input.value); render([preview]); status.textContent = copy("Предпросмотр. Данные ещё не сохранены."); save.disabled = false; } catch { preview = null; save.disabled = true; status.textContent = copy("Снимок некорректен или содержит неподдерживаемые поля. Ничего не сохранено."); } });
  save.addEventListener('click', async () => {
    if (!preview || busy) return; busy = true; save.disabled = check.disabled = input.disabled = true;
    try { const result = await store.import(JSON.stringify(preview)); if (!disposed) { render(Object.values(await store.load())); status.textContent = result.changed ? copy("Снимок сохранён. Задачи и ручные шаги не изменены.") : copy("Этот снимок уже сохранён."); preview = null; input.value = ''; d.defaultView.dispatchEvent(new d.defaultView.CustomEvent('hanni:work-registry-changed')); } }
    catch { if (!disposed) status.textContent = copy("Импорт не подтверждён. Проверь sequence или перечитай состояние."); }
    finally { busy = false; if (!disposed) { check.disabled = input.disabled = false; save.disabled = !preview; } }
  });
  root.append(summary,hint,label,check,save,status,list); host.append(root);
  void store.load().then(all => { if (!disposed) render(Object.values(all)); }, () => { if (!disposed) status.textContent = copy("Сохранённый реестр недоступен. Импорт не выполнялся."); });
  return () => { disposed = true; };
}
