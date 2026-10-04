// Personal file import only: no registry, executor, model or general task enumeration.
export const MAX_IMPORT_BYTES = 65536;
const error = message => { throw new Error(message); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

// JSON.parse alone loses duplicate keys, including escaped spellings.
export function parsePersonalJson(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) error('Файл слишком большой. Максимум 64 КБ.');
  let pos = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(raw[pos] || '\0')) pos++; };
  function string() {
    const start = pos++;
    while (pos < raw.length) { const c = raw[pos++]; if (c === '\\') pos++; else if (c === '"') return JSON.parse(raw.slice(start, pos)); }
    error('Некорректная строка JSON.');
  }
  function value(depth = 0) {
    if (depth > 32) error('Слишком глубокий JSON.');
    whitespace();
    if (raw[pos] === '"') return string();
    if (raw[pos] === '{') {
      pos++; whitespace(); const out = Object.create(null); const keys = new Set();
      if (raw[pos] === '}') { pos++; return out; }
      while (true) {
        whitespace(); if (raw[pos] !== '"') error('Ожидалось имя поля.'); const key = string();
        if (keys.has(key)) error('Повторяющееся поле JSON.'); keys.add(key);
        whitespace(); if (raw[pos++] !== ':') error('Ожидалось двоеточие.'); out[key] = value(depth + 1); whitespace();
        const c = raw[pos++]; if (c === '}') return out; if (c !== ',') error('Некорректный объект JSON.');
      }
    }
    if (raw[pos] === '[') {
      pos++; whitespace(); const out = []; if (raw[pos] === ']') { pos++; return out; }
      while (true) { out.push(value(depth + 1)); whitespace(); const c = raw[pos++]; if (c === ']') return out; if (c !== ',') error('Некорректный массив JSON.'); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(pos));
    if (!token) error('Некорректное значение JSON.'); pos += token[0].length; return JSON.parse(token[0]);
  }
  const parsed = value(); whitespace(); if (pos !== raw.length) error('Лишние данные после JSON.'); return parsed;
}

export function validatePersonalFile(raw) {
  const file = parsePersonalJson(raw);
  if (!exact(file, ['schemaVersion', 'kind', 'namespace', 'tasks', 'archiveTemplates']) || file.schemaVersion !== 1 || file.kind !== 'personal-native-tasks' || file.namespace !== 'personal-backlog' || !Array.isArray(file.tasks) || file.tasks.length < 1 || file.tasks.length > 100 || !Array.isArray(file.archiveTemplates) || file.archiveTemplates.length > 50) error('Неизвестный формат личного импорта.');
  const ids = new Set();
  for (const task of file.tasks) {
    if (!exact(task, ['externalId', 'title', 'projects', 'status', 'operation', 'waitingFor', 'result', 'dependsOn']) || !slug(task.externalId) || ids.has(task.externalId) || !text(task.title, 500) || !task.title.trim() || task.title !== task.title.trim() || !Array.isArray(task.projects) || task.projects.length > 2 || new Set(task.projects).size !== task.projects.length || task.projects.some(p => !['cicada', 'agent-city'].includes(p)) || !['planned', 'waiting', 'decision-needed'].includes(task.status) || !['operation', 'waitingFor', 'result'].every(key => text(task[key], 4000)) || !Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(id => !slug(id) || id === task.externalId)) error('Некорректная личная задача.');
    ids.add(task.externalId);
  }
  const visited = new Set();
  const visit = (id, trail = new Set()) => { if (trail.has(id)) error('Циклические зависимости.'); if (visited.has(id)) return; const task = file.tasks.find(t => t.externalId === id); if (!task) error('Неизвестная зависимость.'); for (const dep of task.dependsOn) visit(dep, new Set([...trail, id])); visited.add(id); };
  for (const id of ids) visit(id);
  const archived = new Set();
  for (const item of file.archiveTemplates) {
    if (!exact(item, ['id', 'expectedVersion', 'personalTemplateConfirmed']) || typeof item.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.id) || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1 || item.personalTemplateConfirmed !== true || archived.has(item.id)) error('Для архива нужны явные ID личных шаблонов и версии.'); archived.add(item.id);
  }
  return file;
}

export function nativeTaskFields(file, task) {
  const marker = `personal-import:${file.namespace}:${task.externalId}`;
  return { marker, title: task.title, tags: ['calendar', 'task-sphere:personal', marker, ...[...task.projects].sort().map(p => `project:${p}`)].join(','),
    content: [`Статус плана: ${{ planned: 'Запланировано', waiting: 'Ожидание', 'decision-needed': 'Нужно решение' }[task.status]}`, task.operation, task.waitingFor && `Ожидание: ${task.waitingFor}`, task.result && `Подтверждено: ${task.result}`, task.dependsOn.length && `Зависит от: ${task.dependsOn.join(', ')}`].filter(Boolean).join('\n\n') };
}
// Only these project tokens belong to this importer. Native process, stage,
// waiting, history, kind, personal sphere and all custom tokens stay user-owned.
const ownedProject = token => ['project:cicada', 'project:agent-city'].includes(token.trim());
export function mergePersonalTaskFields(fields, before) {
  if (!before) return fields;
  const current = String(before.tags).split(',');
  const desired = fields.tags.split(',').filter(ownedProject);
  const existing = current.filter(ownedProject).map(token => token.trim());
  if (JSON.stringify([...existing].sort()) === JSON.stringify([...desired].sort())) return { ...fields, tags: before.tags };
  return { ...fields, tags: [...current.filter(token => !ownedProject(token)), ...desired].join(',') };
}
const snapshot = note => JSON.stringify({ id: note.id, version: note.version, title: note.title, content: note.content, tags: note.tags, archived: !!note.archived, status: note.status, completed: !!note.completed });
const matches = (note, fields) => note.title === fields.title && note.content === fields.content && note.tags === fields.tags;
function own(note, fields) {
  if (!note || typeof note.id !== 'string' || !Number.isSafeInteger(note.version) || note.archived || note.completed || note.status !== 'task' || !String(note.tags).split(',').some(tag => tag.trim() === fields.marker) || !String(note.tags).split(',').some(tag => /^task-sphere:(personal|home|health|growth)$/.test(tag.trim())) || String(note.tags).split(',').some(tag => /^(jira|investlink|task-sphere:work)/i.test(tag.trim()))) error('Запись импорта изменилась или недоступна.');
}
async function findOwn(invoke, fields) {
  const rows = await invoke('get_notes', { filter: 'personal-import', search: fields.marker });
  if (!Array.isArray(rows) || rows.length > 1) error('Неоднозначный внешний ID.');
  if (!rows.length) return null;
  const note = rows[0]; own(note, fields); return note;
}
export async function previewPersonalImport(invoke, raw) {
  const file = validatePersonalFile(raw); const rows = [];
  for (const task of file.tasks) {
    const sourceFields = nativeTaskFields(file, task); const before = await findOwn(invoke, sourceFields); const fields = mergePersonalTaskFields(sourceFields, before);
    rows.push({ externalId: task.externalId, fields, before, baseline: before ? snapshot(before) : null, action: !before ? 'create' : matches(before, fields) ? 'skip' : 'update' });
  }
  // Explicit IDs only. No templates/remote sources are enumerated.
  const archives = [];
  for (const item of file.archiveTemplates) {
    const note = await invoke('get_note', { id: item.id, personalOnly: true });
    if (!note || note.id !== item.id || note.version !== item.expectedVersion || note.archived || note.completed || !['task', 'note'].includes(note.status) || String(note.tags).split(',').some(t => /^(?:jira|investlink|task-sphere:work|personal-import:)/i.test(t))) error('Личный шаблон изменился или не подходит для архива.');
    archives.push({ id: item.id, before: note, baseline: snapshot(note) });
  }
  return { raw, rows, archives };
}

// A fresh domain read must match the reviewed plan; no silently expanded writes.
let activeImport = false;
export async function applyPersonalImport(invoke, preview, options = {}) {
  if (activeImport) error('Другой личный импорт ещё выполняется.');
  activeImport = true;
  try { return await applyReviewedImport(invoke, preview, options); }
  finally { activeImport = false; }
}
async function applyReviewedImport(invoke, preview, { saveRecovery } = {}) {
  if (typeof saveRecovery !== 'function') error('Нужно сохранить export и план восстановления.');
  const current = await previewPersonalImport(invoke, preview.raw);
  if (JSON.stringify(current) !== JSON.stringify(preview)) error('Данные изменились. Повтори предварительный просмотр.');
  const report = { schemaVersion: 1, kind: 'personal-import-recovery', backup: null, before: current.rows.filter(r => r.before).map(r => r.before), templateExport: current.archives.map(r => r.before), created: [], replayed: [], updated: [], archived: [], phase: 'prepared', rollback: 'Восстановить штатную резервную копию; либо вручную проверить версии и восстановить экспорт. Автоматический SQL rollback не выполняется.' };
  // Export must be saved/acknowledged BEFORE any domain mutation.
  await saveRecovery(structuredClone(report));
  if (!current.rows.some(r => r.action !== 'skip') && !current.archives.length) return { ...report, phase: 'unchanged' };
  report.backup = await invoke('create_backup');
  if (typeof report.backup !== 'string' || !report.backup) error('Создание backup не подтверждено.');
  await saveRecovery(structuredClone(report));
  try {
    for (const row of current.rows) {
      if (row.action === 'skip') continue;
      const fresh = await findOwn(invoke, row.fields);
      if ((fresh ? snapshot(fresh) : null) !== row.baseline) error('Задача изменилась после preview.');
      let id;
      if (row.action === 'create') {
        const receipt = await invoke('create_note', { title: row.fields.title, content: row.fields.content, tags: row.fields.tags, status: 'task', dueDate: null, priority: null, personalImportReceipt: true });
        if (!exact(receipt, ['schemaVersion', 'id', 'created', 'marker']) || receipt.schemaVersion !== 1 || typeof receipt.id !== 'string' || !receipt.id || typeof receipt.created !== 'boolean' || receipt.marker !== row.fields.marker) error('Native idempotent create receipt не подтверждён.');
        id = receipt.id;
        report[receipt.created ? 'created' : 'replayed'].push({ externalId: row.externalId, id });
      } else {
        id = fresh.id;
        await invoke('update_note', { id, title: row.fields.title, content: row.fields.content, tags: row.fields.tags, archived: null, dueDate: null, contentBlocks: null, priority: null, expectedVersion: fresh.version });
        report.updated.push({ externalId: row.externalId, id });
      }
      const readback = await invoke('get_note', { id }); own(readback, row.fields);
      if (!matches(readback, row.fields)) error('Readback задачи не совпал.');
      await saveRecovery(structuredClone(report));
    }
    // Archiving is a separate explicit final phase; never toggle/recreate automatically.
    for (const row of current.archives) {
      const fresh = await invoke('get_note', { id: row.id, personalOnly: true });
      if (snapshot(fresh) !== row.baseline) error('Шаблон изменился после preview.');
      await invoke('update_note', { id: fresh.id, title: fresh.title, content: fresh.content, tags: fresh.tags, archived: true, dueDate: null, contentBlocks: null, priority: null, expectedVersion: fresh.version });
      report.archived.push({ id: fresh.id });
      const readback = await invoke('get_note', { id: fresh.id, personalOnly: true });
      if (!readback.archived || readback.title !== fresh.title || readback.content !== fresh.content || readback.tags !== fresh.tags) error('Readback архива не совпал.');
      await saveRecovery(structuredClone(report));
    }
    for (const row of current.rows) { const note = await findOwn(invoke, row.fields); own(note, row.fields); if (!matches(note, row.fields)) error('Итоговый readback не совпал.'); }
    report.phase = 'complete'; await saveRecovery(structuredClone(report)); return report;
  } catch (cause) {
    report.phase = 'partial'; report.error = 'Импорт остановлен. Сохрани отчёт и повтори preview; подтверждённые записи не дублируются.';
    await saveRecovery(structuredClone(report));
    const failure = new Error(report.error); failure.cause = cause; failure.report = report; throw failure;
  }
}
