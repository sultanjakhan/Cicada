import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';

export const DEVELOPMENT_STATE_KEY = 'calendar_development_v1';
const VERSION = 1;
const MAX_IMPORT_BYTES = 200_000;
let developmentWriteQueue = Promise.resolve();

const uid = () => globalThis.crypto?.randomUUID?.() || `development-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const text = value => String(value ?? '').trim();
const date = value => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), parsed = new Date(`${value}T12:00:00`);
  return parsed.getFullYear() === year && parsed.getMonth() + 1 === month && parsed.getDate() === day;
};
const pct = (done, total) => total ? Math.round(done / total * 100) : null;

export function emptyDevelopmentState() { return { version: VERSION, goals: {} }; }

export function normalizeDevelopmentState(raw) {
  if (raw == null || raw === '') return emptyDevelopmentState();
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object' || source.version !== VERSION || !source.goals || typeof source.goals !== 'object' || Array.isArray(source.goals)) throw new Error('Неподдерживаемый формат развития. Сохранение остановлено, чтобы не потерять данные.');
  const goals = {};
  for (const [goalId, value] of Object.entries(source.goals || {})) {
    if (!goalId || !value || typeof value !== 'object') continue;
    const seen = new Set();
    const skills = Array.isArray(value.skills) ? value.skills.flatMap(skill => {
      const id = text(skill?.id), title = text(skill?.title), topic = text(skill?.topic);
      if (!id || !title || !topic || seen.has(id)) return [];
      const taskIds = [...new Set(Array.isArray(skill.taskIds) ? skill.taskIds.map(value => text(value)).filter(Boolean) : [])];
      seen.add(id); return [{ id, title: title.slice(0, 160), topic: topic.slice(0, 80), group: skill.group === 'soft' ? 'soft' : 'hard', level: Math.max(1, Math.min(4, Number(skill.level) || 1)), description: text(skill.description ?? skill.result).slice(0, 2000), practice: text(skill.practice ?? skill.exercise).slice(0, 2000), evidence: text(skill.evidence).slice(0, 2000), taskIds }];
    }) : [];
    const ids = new Set(skills.map(skill => skill.id));
    const stageSeen = new Set();
    const stages = Array.isArray(value.stages) ? value.stages.flatMap(stage => {
      const id = text(stage?.id), title = text(stage?.title);
      if (!id || !title || stageSeen.has(id) || !date(text(stage.deadline))) return [];
      stageSeen.add(id);
      const skillIds = [...new Set(Array.isArray(stage.skillIds) ? stage.skillIds.map(String).filter(id => ids.has(id)) : [])];
      const focusId = skillIds.includes(String(stage.focusId || '')) ? String(stage.focusId) : null;
      return [{ id, title: title.slice(0, 160), outcome: text(stage.outcome).slice(0, 900), deadline: text(stage.deadline), skillIds, focusId, status: stage.status === 'completed' ? 'completed' : 'active' }];
    }) : [];
    goals[goalId] = { skills, stages, activeStageId: stages.some(stage => stage.id === String(value.activeStageId || '')) ? String(value.activeStageId) : null, focusId: ids.has(String(value.focusId || '')) ? String(value.focusId) : null };
  }
  return { version: VERSION, goals };
}

export function validateDevelopmentImport(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json.length > MAX_IMPORT_BYTES) throw new Error('Файл слишком большой для импорта навыков.');
  let parsed; try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('Не удалось прочитать JSON.'); }
  const incoming = Array.isArray(parsed) ? { version: VERSION, goals: { imported: { skills: parsed, stages: [] } } } : Array.isArray(parsed?.skills) ? { version: VERSION, goals: { imported: { skills: parsed.skills, stages: [] } } } : parsed;
  const normalized = normalizeDevelopmentState(incoming);
  const all = Object.values(normalized.goals).flatMap(goal => goal.skills);
  if (!all.length) throw new Error('В JSON нет корректных навыков.');
  return normalized;
}

/** Idempotently records an already-created native task against a goal-local skill. Never creates a task itself. */
export async function attachDevelopmentTask(goalId, skillId, sourceId, { invoke } = {}) {
  if (!invoke || goalId == null || !text(skillId) || !text(sourceId)) throw new Error('Не хватает связи задачи и навыка.');
  const id = String(goalId), skill = String(skillId), task = String(sourceId);
  const work = developmentWriteQueue.catch(() => {}).then(async () => {
    const raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY });
    const latest = normalizeDevelopmentState(raw);
    const ext = latest.goals[id]; const row = ext?.skills.find(item => item.id === skill);
    if (!row) throw new Error('Навык уже изменён. Обнови цель и повтори привязку задачи.');
    if ((row.taskIds || []).includes(task)) return;
    row.taskIds = [...(row.taskIds || []), task];
    await invoke('set_ui_state', { key: DEVELOPMENT_STATE_KEY, value: JSON.stringify(latest), expectedValue: raw ?? '' });
    dispatchChange(id);
  });
  developmentWriteQueue = work;
  await work;
}

function extension(state, goalId) { return state.goals[String(goalId)] || { skills: [], stages: [], activeStageId: null, focusId: null }; }
function skillProgress(skill) { return Boolean(skill.evidence); }
function stageProgress(stage, skills) { const set = new Set(stage.skillIds); const selected = skills.filter(skill => set.has(skill.id)); const done = selected.filter(skillProgress).length; return { done, total: selected.length, percent: pct(done, selected.length) }; }
function topicList(skills) { return [...new Set(skills.map(skill => skill.topic))]; }
function assertUnchangedRecord(current, original) {
  if (original && JSON.stringify(current) !== JSON.stringify(original)) throw Error('Эта запись изменена на другом устройстве. Черновик остаётся в открытой форме. Открой запись заново перед повторным сохранением.');
}

function mountTopicFirstPicker(host, skills, { multiple = false, values = [] } = {}) {
  const selected = new Set(values); let topic = null, query = '';
  const draw = (restoreSearch = false) => {
    const filtered = skills.filter(skill => !query || `${skill.title} ${skill.topic}`.toLocaleLowerCase('ru').includes(query));
    const topics = topicList(filtered);
    const list = topic ? filtered.filter(skill => skill.topic === topic) : [];
    host.innerHTML = `<div class="dev-picker"><label>Найти навык или тему<input type="search" data-dev-picker-search placeholder="SQL, API или название"></label><div class="dev-picker-topics">${topics.map(name => `<button type="button" data-dev-topic="${escapeHtml(name)}" ${topic === name ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${escapeHtml(name)} <small>${filtered.filter(skill => skill.topic === name).length}</small></button>`).join('') || '<span>Ничего не найдено</span>'}</div>${topic ? `<div class="dev-picker-list"><div><strong>${escapeHtml(topic)}</strong><button type="button" data-dev-topic-back>Все темы</button></div>${list.map(skill => `<label><input type="${multiple ? 'checkbox' : 'radio'}" name="development-picker" value="${escapeHtml(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}>${escapeHtml(skill.title)}<small>Уровень ${skill.level}</small></label>`).join('')}</div>` : '<p class="dev-picker-hint">Сначала выбери тему. Поиск сузит список тем.</p>'}<div class="dev-picker-selection"><span>Выбрано: ${selected.size}</span><button type="button" data-dev-picker-clear>Очистить выбор</button></div></div>`;
    host.querySelector('[data-dev-picker-search]').value = query;
    host.querySelector('[data-dev-picker-search]').addEventListener('input', event => { query = event.target.value.toLocaleLowerCase('ru').trim(); topic = null; draw(true); });
    host.querySelectorAll('[data-dev-topic]').forEach(button => button.addEventListener('click', () => { topic = button.dataset.devTopic; draw(); }));
    host.querySelector('[data-dev-topic-back]')?.addEventListener('click', () => { topic = null; draw(); });
    host.querySelector('[data-dev-picker-clear]').addEventListener('click', () => { selected.clear(); draw(); });
    host.querySelectorAll('input[name="development-picker"]').forEach(input => input.addEventListener('change', () => { if (!multiple) selected.clear(); if (input.checked) selected.add(input.value); else selected.delete(input.value); draw(); }));
    if (restoreSearch) { const input = host.querySelector('[data-dev-picker-search]'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  };
  draw(); return { get values() { return [...selected]; } };
}

function dispatchChange(goalId) { window.dispatchEvent(new CustomEvent('hanni:development-changed', { detail: { goalId: String(goalId) } })); }

export async function mountGoalDevelopment(element, { invoke, goal, onCreateTask } = {}) {
  if (!element || !invoke || !goal?.id) throw new Error('Не хватает цели или native API.');
  let disposed = false, state = emptyDevelopmentState(), error = '', skillSearch = ''; const childDialogs = new Set();
  const goalId = String(goal.id);
  const current = () => !disposed && element.isConnected;
  const load = async () => {
    const raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY });
    state = normalizeDevelopmentState(raw);
  };
  const mutate = async change => {
    const work = developmentWriteQueue.catch(() => {}).then(async () => {
      const raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY });
      const fresh = normalizeDevelopmentState(raw);
      const next = structuredClone(fresh); const draft = extension(next, goalId); next.goals[goalId] = draft; change(draft, next);
      const normalized = normalizeDevelopmentState(next);
      await invoke('set_ui_state', { key: DEVELOPMENT_STATE_KEY, value: JSON.stringify(normalized), expectedValue: raw ?? '' });
      state = normalized; error = ''; dispatchChange(goalId); render();
    });
    developmentWriteQueue = work;
    try { await work; } catch (cause) { error = (cause?.message || cause) === 'mvp_sync_stale_ui_state' ? 'Цель изменена на другом устройстве. Черновик сохранён в открытом редакторе. Закрой его и открой цель заново перед повтором.' : 'Не удалось сохранить изменения. Ничего не применено — повтори действие.'; render(); if ((cause?.message || cause) === 'mvp_sync_stale_ui_state') throw Error(error); throw cause; }
  };
  const run = change => { void mutate(change).catch(() => {}); };
  const openDialog = ({ title, hint, submitLabel, draw, submit }) => {
    let api; api = createCalendarDialog({ document: element.ownerDocument, title, hint, submitLabel, returnFocus: () => element.querySelector('button')?.focus(), onClose: () => childDialogs.delete(api) }); childDialogs.add(api);
    api.body.innerHTML = draw();
    api.form.addEventListener('submit', async () => {
      if (api.pending) return; const data = new FormData(api.form); api.setPending(true); api.showError('');
      try { await submit(data); api.setPending(false); api.close({ skipBeforeClose: true }); }
      catch (cause) { api.setPending(false); api.showError(cause?.message || 'Не удалось сохранить.'); }
    });
    api.open(); return api;
  };
  const skillEditor = skill => openDialog({
    title: skill ? 'Изменить навык' : 'Добавить навык', hint: 'Тема нужна, чтобы группировать развитие. Подтверждение добавляется после практики.', submitLabel: 'Сохранить',
    draw: () => `<label>Название навыка<input name="title" required maxlength="160" value="${escapeHtml(skill?.title || '')}"></label><label>Тема<input name="topic" required maxlength="80" placeholder="SQL, API, требования…" value="${escapeHtml(skill?.topic || '')}"></label><label>Группа<select name="group"><option value="hard" ${(skill?.group || 'hard') === 'hard' ? 'selected' : ''}>Хард</option><option value="soft" ${skill?.group === 'soft' ? 'selected' : ''}>Софт</option></select></label><label>Какой результат подтверждает навык<textarea name="description" maxlength="2000" rows="3">${escapeHtml(skill?.description || '')}</textarea></label><label>Практика<textarea name="practice" maxlength="2000" rows="3">${escapeHtml(skill?.practice || '')}</textarea></label><label>Ориентир<select name="level">${[1,2,3,4].map(level => `<option value="${level}" ${Number(skill?.level || 1) === level ? 'selected' : ''}>Уровень ${level}</option>`).join('')}</select></label>`,
    submit: async data => { const title = text(data.get('title')), topic = text(data.get('topic')); if (!title || !topic) throw new Error('Заполни название и тему.'); await mutate(draft => { const at = draft.skills.findIndex(item => item.id === skill?.id); assertUnchangedRecord(draft.skills[at], skill); const row = { ...(at >= 0 ? draft.skills[at] : {}), id: skill?.id || uid(), title, topic, group:data.get('group') === 'soft' ? 'soft' : 'hard', description:text(data.get('description')), practice:text(data.get('practice')), level: Number(data.get('level')) || 1 }; if (at >= 0) draft.skills[at] = row; else draft.skills.push(row); }); },
  });
  const evidenceEditor = skill => openDialog({ title: 'Подтверждение навыка', hint: 'Опиши проверяемый результат: работа, ссылка или краткая проверка.', submitLabel: 'Сохранить подтверждение', draw: () => `<label>Результат<textarea name="evidence" maxlength="2000" rows="5">${escapeHtml(skill.evidence || '')}</textarea></label>`, submit: async data => mutate(draft => { const row = draft.skills.find(item => item.id === skill.id); assertUnchangedRecord(row, skill); row.evidence = text(data.get('evidence')); }) });
  const stageEditor = stage => {
    const ext = extension(state, goalId); let picker;
    const api = openDialog({ title: stage ? 'Изменить этап' : 'Новый этап', hint: 'Выбери часть навыков и необязательный срок. Общая цель не меняется.', submitLabel: 'Сохранить этап',
      draw: () => `<label>Название этапа<input name="title" required maxlength="160" value="${escapeHtml(stage?.title || '')}"></label><label>Результат этапа<textarea name="outcome" maxlength="900" rows="3">${escapeHtml(stage?.outcome || '')}</textarea></label><label>Срок<input name="deadline" type="date" value="${escapeHtml(stage?.deadline || '')}"></label><fieldset><legend>Навыки этапа</legend><div data-stage-topic-picker></div></fieldset>`,
      submit: async data => { const title = text(data.get('title')), outcome = text(data.get('outcome')), deadline = text(data.get('deadline')), skillIds = picker.values; if (!title) throw new Error('Дай этапу название.'); if (!skillIds.length) throw new Error('Выбери хотя бы один навык.'); if (!date(deadline)) throw new Error('Проверь срок этапа.'); await mutate(draft => { const old = draft.stages.find(item => item.id === stage?.id); assertUnchangedRecord(old, stage); const row = { id: stage?.id || uid(), title, outcome, deadline, skillIds, focusId: skillIds.includes(old?.focusId) ? old.focusId : null, status:old?.status || 'active' }; const at = draft.stages.findIndex(item => item.id === row.id); if (at >= 0) draft.stages[at] = row; else { draft.stages.push(row); draft.activeStageId = row.id; } }); },
    });
    picker = mountTopicFirstPicker(api.body.querySelector('[data-stage-topic-picker]'), ext.skills, { multiple:true, values:stage?.skillIds || [] }); return api;
  };
  const focusPicker = () => {
    const ext = extension(state, goalId); const active = ext.stages.find(stage => stage.id === ext.activeStageId) || null; const allowed = active ? new Set(active.skillIds) : null; const list = ext.skills.filter(skill => !allowed || allowed.has(skill.id)); let picker;
    const api = openDialog({ title: 'Навык на сейчас', hint: 'Выбор не меняет текущую задачу. Сначала выбери тему, затем навык.', submitLabel: 'Применить',
      draw: () => `<div data-focus-topic-picker></div>`,
      submit: async () => mutate(draft => { const id = picker.values[0] || ''; const target = draft.stages.find(stage => stage.id === draft.activeStageId); if (target) target.focusId = target.skillIds.includes(id) ? id : null; else draft.focusId = draft.skills.some(skill => skill.id === id) ? id : null; }),
    });
    picker = mountTopicFirstPicker(api.body.querySelector('[data-focus-topic-picker]'), list, { values:[active ? active.focusId : ext.focusId].filter(Boolean) }); return api;
  };
  const importSkills = () => {
    const api = openDialog({ title: 'Импорт навыков JSON', hint: 'Ожидается JSON с skills или development export. Импорт добавляет уникальные навыки к этой цели.', submitLabel: 'Импортировать', draw: () => '<label>JSON<textarea name="json" rows="10" required></textarea></label>', submit: async data => {
      const parsed = validateDevelopmentImport(text(data.get('json'))); const source = Object.values(parsed.goals).flatMap(item => item.skills); await mutate(draft => { const known = new Set(draft.skills.map(skill => `${skill.topic}\u0000${skill.title}`.toLowerCase())); for (const skill of source) { const key = `${skill.topic}\u0000${skill.title}`.toLowerCase(); if (!known.has(key)) { known.add(key); draft.skills.push({ ...skill, id: uid(), evidence: '', taskIds:[] }); } } });
    }}); return api;
  };
  function render() {
    if (!current()) return; const ext = extension(state, goalId); const active = ext.stages.find(stage => stage.id === ext.activeStageId) || null; const focusId = active ? active.focusId : ext.focusId; const focus = ext.skills.find(skill => skill.id === focusId); const totalDone = ext.skills.filter(skillProgress).length, totalPercent = pct(totalDone, ext.skills.length); const stageCards = ext.stages.map(stage => { const progress = stageProgress(stage, ext.skills); return `<article class="dev-stage ${stage.id === ext.activeStageId ? 'is-active' : ''}"><div><strong>${escapeHtml(stage.title)}</strong><span>${stage.status === 'completed' ? 'Завершён · ' : ''}${stage.outcome ? `${escapeHtml(stage.outcome)} · ` : ''}${stage.deadline ? `До ${escapeHtml(stage.deadline)} · ` : ''}${progress.total ? `${progress.done} из ${progress.total} · ${progress.percent}%` : 'Нет оценки — выбери навыки'}</span></div><div><button type="button" data-dev-stage-active="${escapeHtml(stage.id)}">${stage.id === ext.activeStageId ? 'Показан' : 'Показать'}</button><button type="button" data-dev-stage="${escapeHtml(stage.id)}">Изменить</button>${stage.status === 'completed' ? '' : `<button type="button" data-dev-stage-complete="${escapeHtml(stage.id)}">Завершить</button>`}<button type="button" data-dev-stage-delete="${escapeHtml(stage.id)}">Удалить</button></div></article>`; }).join('');
    const stageSkillIds = active ? new Set(active.skillIds) : null;
    const matched = ext.skills.filter(skill => (!stageSkillIds || stageSkillIds.has(skill.id)) && (!skillSearch || `${skill.title} ${skill.topic} ${skill.description||''}`.toLocaleLowerCase('ru').includes(skillSearch)));
    const skills = [['hard','Хард'],['soft','Софт']].map(([group,label]) => {
      const grouped=matched.filter(skill=>skill.group===group);if(!grouped.length)return '';
      return `<section class="dev-group"><header><h4>${label}</h4><span>${grouped.filter(skillProgress).length} / ${grouped.length}</span></header>${topicList(grouped).map(topic=>{
        const rows=grouped.filter(skill=>skill.topic===topic);
        return `<section class="dev-topic"><header><strong>${escapeHtml(topic)}</strong><span>${rows.filter(skillProgress).length} / ${rows.length}</span></header>${rows.map(skill=>`<article class="dev-skill"><button type="button" data-dev-skill="${escapeHtml(skill.id)}">${escapeHtml(skill.title)}</button><span>${skill.evidence?'Подтверждено':'Без подтверждения'}</span>${skill.description||skill.practice?`<p class="dev-skill-detail">${skill.description?escapeHtml(skill.description):''}${skill.description&&skill.practice?' · ':''}${skill.practice?`Практика: ${escapeHtml(skill.practice)}`:''}</p>`:''}<div><button type="button" data-dev-evidence="${escapeHtml(skill.id)}">${skill.evidence?'Изменить результат':'Подтвердить'}</button><button type="button" data-dev-task="${escapeHtml(skill.id)}">Задача</button><button type="button" data-dev-remove="${escapeHtml(skill.id)}">Исключить</button></div></article>`).join('')}</section>`;
      }).join('')}</section>`;
    }).join('');
    const intro = `<div class="calendar-development-intro">${goal.description?`<p>${escapeHtml(goal.description)}</p>`:''}${goal.criteria?`<p><strong>Критерии готовности</strong><br>${escapeHtml(goal.criteria)}</p>`:''}${goal.deadline?`<p>Срок цели: ${escapeHtml(goal.deadline)}</p>`:''}</div>`;
    element.innerHTML = `<section class="calendar-development" aria-label="Развитие цели"><header><div><p class="dev-eyebrow">Развитие цели</p><h2>${escapeHtml(goal.title || 'Цель')}</h2><span class="dev-total-progress">${totalPercent == null ? 'Навыков пока нет' : `${totalPercent}% · ${totalDone} из ${ext.skills.length} подтверждено`}</span></div><div><button type="button" data-dev-import>Импорт JSON</button><button type="button" data-dev-add>Добавить навык</button></div></header>${intro}${error ? `<p class="dev-error" role="alert">${escapeHtml(error)}</p>` : ''}<section class="dev-focus"><div><span>${active ? `Навык в этапе «${escapeHtml(active.title)}»` : 'Сейчас развиваю'}</span><strong>${focus ? `${escapeHtml(focus.topic)} · ${escapeHtml(focus.title)}` : active && !active.skillIds.length ? 'В этапе пока нет навыков' : 'Не выбрано'}</strong></div><button type="button" data-dev-focus>${focus ? 'Сменить или очистить' : 'Выбрать навык'}</button></section><section class="dev-stages"><header><h3>Этапы</h3><div>${active ? '<button type="button" data-dev-stage-clear>Вся цель</button>' : ''}<button type="button" data-dev-stage-add>Новый этап</button></div></header>${stageCards || '<p class="dev-empty">Раздели цель на ближайший результат и нужные навыки.</p>'}</section><section class="dev-skills"><header><h3>Навыки</h3><input type="search" data-dev-skill-search placeholder="Найти навык, тему или описание" value="${escapeHtml(skillSearch)}"><span>${matched.length} из ${ext.skills.length}</span></header>${skills || '<p class="dev-empty">В выбранном этапе нет подходящих навыков.</p>'}</section></section>`;
    const confirm = (title, hint, action) => openDialog({ title, hint, submitLabel:'Подтвердить', draw: () => '<p>Связанные задачи и подтверждения навыков сохранятся.</p>', submit: () => mutate(action) });
    element.querySelector('[data-dev-add]')?.addEventListener('click', () => skillEditor(null)); element.querySelector('[data-dev-import]')?.addEventListener('click', importSkills); element.querySelector('[data-dev-focus]')?.addEventListener('click', focusPicker); element.querySelector('[data-dev-stage-add]')?.addEventListener('click', () => stageEditor(null)); element.querySelector('[data-dev-stage-clear]')?.addEventListener('click', () => run(draft => { draft.activeStageId = null; })); element.querySelector('[data-dev-skill-search]')?.addEventListener('input', event => { skillSearch = event.target.value.toLocaleLowerCase('ru').trim(); render(); const input = element.querySelector('[data-dev-skill-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); });
    element.querySelectorAll('[data-dev-skill]').forEach(button => button.addEventListener('click', () => skillEditor(ext.skills.find(skill => skill.id === button.dataset.devSkill)))); element.querySelectorAll('[data-dev-evidence]').forEach(button => button.addEventListener('click', () => evidenceEditor(ext.skills.find(skill => skill.id === button.dataset.devEvidence)))); element.querySelectorAll('[data-dev-stage]').forEach(button => button.addEventListener('click', () => stageEditor(ext.stages.find(stage => stage.id === button.dataset.devStage)))); element.querySelectorAll('[data-dev-stage-active]').forEach(button => button.addEventListener('click', () => run(draft => { draft.activeStageId = button.dataset.devStageActive; }))); element.querySelectorAll('[data-dev-stage-complete]').forEach(button => button.addEventListener('click', () => confirm('Завершить этап?', 'Этап останется в истории цели.', draft => { const row = draft.stages.find(stage => stage.id === button.dataset.devStageComplete); if (row) row.status = 'completed'; if (draft.activeStageId === button.dataset.devStageComplete) draft.activeStageId = null; }))); element.querySelectorAll('[data-dev-stage-delete]').forEach(button => button.addEventListener('click', () => confirm('Удалить этап?', 'Навыки и их подтверждения останутся в цели.', draft => { draft.stages = draft.stages.filter(stage => stage.id !== button.dataset.devStageDelete); if (draft.activeStageId === button.dataset.devStageDelete) draft.activeStageId = null; }))); element.querySelectorAll('[data-dev-remove]').forEach(button => button.addEventListener('click', () => confirm('Исключить навык из цели?', 'Навык выйдет из этапов и фокуса, но связанные задачи не будут удалены.', draft => { const id = button.dataset.devRemove; draft.skills = draft.skills.filter(skill => skill.id !== id); for (const stage of draft.stages) { stage.skillIds = stage.skillIds.filter(value => value !== id); if (stage.focusId === id) stage.focusId = null; } if (draft.focusId === id) draft.focusId = null; }))); element.querySelectorAll('[data-dev-task]').forEach(button => button.addEventListener('click', () => { const skill = ext.skills.find(item => item.id === button.dataset.devTask); if (skill) onCreateTask?.({ goalId, skillId: skill.id, skillTitle: skill.title }); }));
  }
  await load(); render();
  const chooseStage = () => {
    const ext=extension(state,goalId);
    return openDialog({title:'Какой этап сейчас',hint:'Выбери ближайший этап или развитие всей цели. Текущая задача не изменится.',submitLabel:'Выбрать этап',
      draw:()=>`<div class="dev-stage-choices"><label><input type="radio" name="stage" value="" ${!ext.activeStageId?'checked':''}>Вся цель</label>${ext.stages.filter(stage=>stage.status!=='completed').map(stage=>`<label><input type="radio" name="stage" value="${escapeHtml(stage.id)}" ${stage.id===ext.activeStageId?'checked':''}><span><strong>${escapeHtml(stage.title)}</strong><small>${stage.skillIds.length} навыков${stage.deadline?' · до '+escapeHtml(stage.deadline):''}</small></span></label>`).join('')}</div>`,
      submit:async data=>mutate(draft=>{const id=String(data.get('stage')||'');if(id&&!draft.stages.some(stage=>stage.id===id&&stage.status!=='completed'))throw Error('Этот этап уже недоступен.');draft.activeStageId=id||null;}),
    });
  };
  return { dispose: () => { disposed = true; for (const api of childDialogs) api.dispose(); childDialogs.clear(); element.replaceChildren(); }, refresh: async () => { await load(); render(); }, openFocusPicker:focusPicker, openStagePicker:chooseStage, openStageEditor:id=>stageEditor(extension(state,goalId).stages.find(stage=>stage.id===id)||null) };
}

export async function mountGoalDevelopmentSummary(element, { invoke, goalId, onOpen } = {}) {
  if (!element || !invoke || goalId == null) throw new Error('Не хватает цели или native API.');
  const id = String(goalId),document=element.ownerDocument; let disposed = false,revision=0,editor=null;
  const progressView=(progress,label)=>`<div class="hero-progress"><div class="progress-label"><strong>${progress.total?progress.percent+'%':'—'}</strong><span>${progress.total?`${progress.done} из ${progress.total}`:'Без оценки'}</span></div><div class="progress-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent||0}"><span style="width:${progress.percent||0}%"></span></div><small>${label}</small></div>`;
  async function openFocusEditor(trigger){
    if(editor||disposed)return;
    const host=document.createElement('div');host.hidden=true;document.body.append(host);
    let controller=null;
    const handle={dispose:()=>{controller?.dispose();host.remove();}};editor=handle;
    try{
      controller=await mountGoalDevelopment(host,{invoke,goal:{id,title:''}});
      if(disposed||editor!==handle){handle.dispose();return;}
      const dialog=controller.openFocusPicker();
      dialog.modal.addEventListener('close',()=>{handle.dispose();if(editor===handle)editor=null;if(!disposed)(element.querySelector('[data-summary-action="focus"]')||trigger)?.focus();},{once:true});
    }catch(cause){handle.dispose();editor=null;throw cause;}
  }
  const render = async (canCommit = null) => {
    if (disposed || !element.isConnected) return;
    if (canCommit && !canCommit()) return;
    const own=++revision,state=normalizeDevelopmentState(await invoke('get_ui_state',{key:DEVELOPMENT_STATE_KEY}));
    if(disposed||own!==revision||!element.isConnected||(canCommit&&!canCommit()))return;
    const ext=extension(state,id),stage=ext.stages.find(item=>item.id===ext.activeStageId)||null,focus=ext.skills.find(skill=>skill.id===(stage?stage.focusId:ext.focusId));
    const total=ext.skills.length,done=ext.skills.filter(skillProgress).length,progress={total,done,percent:pct(done,total)};
    const focusBlock=`<div class="focus-copy"><small>Сейчас развиваю</small>${focus?`<button type="button" class="focus-topic" data-summary-action="focus" aria-haspopup="dialog" aria-label="${escapeHtml(focus.topic)}: выбрать навык" title="Выбрать навык">${escapeHtml(focus.topic)}</button><button type="button" class="focus-skill-title" data-summary-skill aria-haspopup="dialog" title="Открыть подробности навыка">${escapeHtml(focus.title)}</button>`:`<span class="focus-empty">Выбери навык ${stage?'из текущего этапа':'из цели'}</span><button type="button" class="text-button" data-summary-action="focus" aria-haspopup="dialog">Выбрать навык</button>`}</div>`;
    element.innerHTML=`<div class="calendar-development-summary"><div class="hero-bottom">${focusBlock}${progressView(progress,'навыков всей цели подтверждено')}</div></div>`;
    element.querySelector('[data-summary-skill]')?.addEventListener('click',()=>onOpen?.({goalId:id,skillId:focus.id}));
    const focusButton=element.querySelector('[data-summary-action="focus"]');
    focusButton.addEventListener('click',()=>void openFocusEditor(focusButton).catch(cause=>{const error=document.createElement('p');error.setAttribute('role','alert');error.textContent=cause?.message||String(cause);element.append(error);}));
  };
  const listener = event => { if (String(event.detail?.goalId) === id) void render().catch(()=>{}); };
  const onSync = event => { if (event.detail?.remoteSync) void render(event.detail.canCommit).catch(()=>{}); };
  window.addEventListener('hanni:development-changed', listener);
  window.addEventListener('hanni:calendar-refresh', onSync);
  try{await render();}catch(cause){window.removeEventListener('hanni:development-changed',listener);window.removeEventListener('hanni:calendar-refresh',onSync);throw cause;}
  return { dispose: () => { disposed = true;revision++;editor?.dispose();window.removeEventListener('hanni:development-changed', listener);window.removeEventListener('hanni:calendar-refresh',onSync); element.replaceChildren(); }, refresh: render };
}
