import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';

import {
  DEVELOPMENT_STATE_KEY, VERSION, emptyDevelopmentState, normalizeDevelopmentState, readDevelopmentState, developmentOf as extension,
  skillConfirmed as skillProgress, stageProgress, percentOf as pct, validDevelopmentDate as date, goalGlance, formatNumber,
} from './calendar-development-state.js';

export { DEVELOPMENT_STATE_KEY, emptyDevelopmentState, normalizeDevelopmentState };
const MAX_IMPORT_BYTES = 200_000;
let developmentWriteQueue = Promise.resolve();

const uid = () => globalThis.crypto?.randomUUID?.() || `development-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const text = value => String(value ?? '').trim();

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
function linkedTaskRows(skill, getTasks) {
  const ids = new Set((skill?.taskIds || []).map(value => String(value)));
  if (!ids.size) return [];
  let rows = [];
  try { const value = getTasks?.(); rows = Array.isArray(value) ? value : []; } catch { rows = []; }
  return rows.filter(task => task?.source_type === 'note' && task.source_id != null && ids.has(String(task.source_id)));
}

/**
 * Full goal development: focus, stages (the stage filter scopes the skill list) and skills.
 * `embedded` drops the goal title and intro when a surrounding popup already shows them.
 */
export async function mountGoalDevelopment(element, { invoke, goal, onCreateTask, getTasks = () => [], onOpenTask, embedded = false } = {}) {
  if (!element || !invoke || !goal?.id) throw new Error('Не хватает цели или native API.');
  let disposed = false, state = emptyDevelopmentState(), error = '', skillSearch = '', localStageId; const childDialogs = new Set();
  const goalId = String(goal.id);
  const current = () => !disposed && element.isConnected;
  const load = async () => {
    const raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY });
    state = normalizeDevelopmentState(raw);
    const ext = extension(state, goalId);
    if (localStageId === undefined || (localStageId !== null && !ext.stages.some(stage => stage.id === localStageId))) localStageId = ext.activeStageId || null;
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
    const api = openDialog({ title: stage ? 'Изменить этап' : 'Новый этап', hint: 'Этап — промежуточный результат. Навыки и срок можно добавить по желанию.', submitLabel: 'Сохранить этап',
      draw: () => `<label>Название этапа<input name="title" required maxlength="160" value="${escapeHtml(stage?.title || '')}"></label><label>Промежуточный результат<textarea name="outcome" maxlength="900" rows="3">${escapeHtml(stage?.outcome || '')}</textarea></label><label>Срок (необязательно)<input name="deadline" type="date" value="${escapeHtml(stage?.deadline || '')}"></label><fieldset><legend>Навыки этапа (необязательно)</legend><div data-stage-topic-picker></div></fieldset>`,
      submit: async data => { const title = text(data.get('title')), outcome = text(data.get('outcome')), deadline = text(data.get('deadline')), skillIds = picker.values; if (!title) throw new Error('Дай этапу название.'); if (!date(deadline)) throw new Error('Проверь срок этапа.'); await mutate(draft => { const old = draft.stages.find(item => item.id === stage?.id); assertUnchangedRecord(old, stage); const row = { id: stage?.id || uid(), title, outcome, deadline, skillIds, focusId: skillIds.includes(old?.focusId) ? old.focusId : null, status:old?.status || 'active' }; const at = draft.stages.findIndex(item => item.id === row.id); if (at >= 0) draft.stages[at] = row; else draft.stages.push(row); }); },
    });
    picker = mountTopicFirstPicker(api.body.querySelector('[data-stage-topic-picker]'), ext.skills, { multiple:true, values:stage?.skillIds || [] }); return api;
  };
  const focusPicker = () => {
    const ext = extension(state, goalId); const active = ext.stages.find(stage => stage.id === localStageId) || null; const allowed = active ? new Set(active.skillIds) : null; const list = ext.skills.filter(skill => !allowed || allowed.has(skill.id)); let picker;
    const api = openDialog({ title: 'Навык на сейчас', hint: 'Выбор не меняет текущую задачу. Сначала выбери тему, затем навык.', submitLabel: 'Применить',
      draw: () => `<div data-focus-topic-picker></div>`,
      submit: async () => mutate(draft => { const id = picker.values[0] || ''; const target = draft.stages.find(stage => stage.id === localStageId); if (target) target.focusId = target.skillIds.includes(id) ? id : null; else draft.focusId = draft.skills.some(skill => skill.id === id) ? id : null; }),
    });
    picker = mountTopicFirstPicker(api.body.querySelector('[data-focus-topic-picker]'), list, { values:[active ? active.focusId : ext.focusId].filter(Boolean) }); return api;
  };
  const importSkills = () => {
    const api = openDialog({ title: 'Импорт навыков JSON', hint: 'Ожидается JSON с skills или development export. Импорт добавляет уникальные навыки к этой цели.', submitLabel: 'Импортировать', draw: () => '<label>JSON<textarea name="json" rows="10" required></textarea></label>', submit: async data => {
      const parsed = validateDevelopmentImport(text(data.get('json'))); const source = Object.values(parsed.goals).flatMap(item => item.skills); await mutate(draft => { const known = new Set(draft.skills.map(skill => `${skill.topic}\u0000${skill.title}`.toLowerCase())); for (const skill of source) { const key = `${skill.topic}\u0000${skill.title}`.toLowerCase(); if (!known.has(key)) { known.add(key); draft.skills.push({ ...skill, id: uid(), evidence: '', taskIds:[] }); } } });
    }}); return api;
  };
  function render() {
    if (!current()) return;
    const ext = extension(state, goalId);
    const active = ext.stages.find(stage => stage.id === localStageId) || null;
    const currentStage = ext.stages.find(stage => stage.id === ext.activeStageId) || null;
    const focusId = active ? active.focusId : ext.focusId;
    const focus = ext.skills.find(skill => skill.id === focusId);
    const totalDone = ext.skills.filter(skillProgress).length, totalPercent = pct(totalDone, ext.skills.length);
    const blank = !ext.skills.length && !ext.stages.length;
    const stageCards = ext.stages.map(stage => {
      const progress = stageProgress(stage, ext.skills), viewing = stage.id === localStageId, currentStageId = stage.id === ext.activeStageId;
      const status = `${currentStageId ? 'Текущий · ' : ''}${stage.status === 'completed' ? 'Завершён' : 'В работе'}`;
      const progressText = progress.total ? ` · Навыки: ${progress.done} из ${progress.total} подтверждено` : '';
      return `<article class="dev-stage ${viewing ? 'is-active is-viewing' : ''} ${currentStageId ? 'is-current' : ''}"><div><strong>${escapeHtml(stage.title)}</strong><span>${status}${stage.deadline ? ` · До ${escapeHtml(stage.deadline)}` : ''}${progressText}</span>${stage.outcome ? `<p class="dev-stage-outcome">${escapeHtml(stage.outcome)}</p>` : ''}</div><div><button type="button" data-dev-stage-active="${escapeHtml(stage.id)}" aria-pressed="${viewing}">${viewing ? 'Показан' : 'Показать'}</button><details class="dev-stage-actions"><summary aria-label="Действия с этапом: ${escapeHtml(stage.title)}">⋯</summary><div>${currentStageId ? '' : `<button type="button" data-dev-stage-current="${escapeHtml(stage.id)}">Сделать текущим</button>`}<button type="button" data-dev-stage="${escapeHtml(stage.id)}">Изменить</button>${stage.status === 'completed' ? `<button type="button" data-dev-stage-reopen="${escapeHtml(stage.id)}">Возобновить</button>` : `<button type="button" data-dev-stage-complete="${escapeHtml(stage.id)}">Завершить</button>`}<button type="button" data-dev-stage-delete="${escapeHtml(stage.id)}">Удалить</button></div></details></div></article>`;
    }).join('');
    const stageSkillIds = active ? new Set(active.skillIds) : null;
    const matched = ext.skills.filter(skill => (!stageSkillIds || stageSkillIds.has(skill.id)) && (!skillSearch || `${skill.title} ${skill.topic} ${skill.description||''}`.toLocaleLowerCase('ru').includes(skillSearch)));
    const skills = [['hard','Хард'],['soft','Софт']].map(([group,label]) => {
      const grouped=matched.filter(skill=>skill.group===group);if(!grouped.length)return '';
      return `<section class="dev-group"><header><h4>${label}</h4><span>${grouped.filter(skillProgress).length} / ${grouped.length}</span></header>${topicList(grouped).map(topic=>{
        const rows=grouped.filter(skill=>skill.topic===topic);
        return `<section class="dev-topic"><header><strong>${escapeHtml(topic)}</strong><span>${rows.filter(skillProgress).length} / ${rows.length}</span></header>${rows.map(skill=>{ const linked = linkedTaskRows(skill, getTasks); const taskLinks = linked.length ? `<div class="dev-skill-tasks" aria-label="Задачи навыка">${linked.map(task=>{ const done = Boolean(task.completed) || ['done','completed'].includes(String(task.status_extra || task.status || '').toLowerCase()); return `<button type="button" class="dev-task-link ${done ? 'is-completed' : ''}" data-dev-task-link="${escapeHtml(String(task.source_id))}">${escapeHtml(task.title || `Задача ${task.source_id}`)}${done ? ' · Выполнено' : ''}</button>`; }).join('')}</div>` : ''; return `<article class="dev-skill"><button type="button" data-dev-skill="${escapeHtml(skill.id)}">${escapeHtml(skill.title)}</button><span>${skill.evidence?'Подтверждено':'Без подтверждения'}</span>${skill.description||skill.practice?`<p class="dev-skill-detail">${skill.description?escapeHtml(skill.description):''}${skill.description&&skill.practice?' · ':''}${skill.practice?`Практика: ${escapeHtml(skill.practice)}`:''}</p>`:''}${taskLinks}<div><button type="button" data-dev-evidence="${escapeHtml(skill.id)}">${skill.evidence?'Изменить результат':'Подтвердить'}</button><button type="button" data-dev-task="${escapeHtml(skill.id)}">Задача</button><button type="button" data-dev-remove="${escapeHtml(skill.id)}">Исключить</button></div></article>`; }).join('')}</section>`;
      }).join('')}</section>`;
    }).join('');
    const intro = embedded ? '' : `<div class="calendar-development-intro">${goal.description?`<p>${escapeHtml(goal.description)}</p>`:''}${goal.criteria?`<p><strong>Критерии готовности</strong><br>${escapeHtml(goal.criteria)}</p>`:''}${goal.deadline?`<p>Срок цели: ${escapeHtml(goal.deadline)}</p>`:''}</div>`;
    const plan = blank ? `<section class="dev-plan-empty" data-dev-plan><p>Добавь ближайший промежуточный результат. Навык можно привязать позже.</p><div><button type="button" data-dev-stage-add>Добавить этап</button><button type="button" data-dev-add>Добавить навык</button></div></section>` : '';
    const focusBlock = (!ext.skills.length ? '' : `<section class="dev-focus"><div><span>${active ? `Навык в этапе «${escapeHtml(active.title)}»` : 'Сейчас развиваю'}</span><strong>${focus ? `${escapeHtml(focus.topic)} · ${escapeHtml(focus.title)}` : active && !active.skillIds.length ? 'В этапе пока нет навыков' : 'Не выбрано'}</strong></div><button type="button" data-dev-focus>${focus ? 'Сменить или очистить' : 'Выбрать навык'}</button></section>`) + `${currentStage?.status === 'completed' ? `<p class="dev-stage-completed" data-dev-stage-completed>Текущий этап «${escapeHtml(currentStage.title)}» завершён. Покажи следующий этап и нажми «Сделать текущим».</p>` : ''}`;
    const stageBlock = blank ? '' : `<section class="dev-stages"><header><h3>Этапы</h3><div>${active ? '<button type="button" data-dev-stage-clear>Вся цель</button>' : ''}<button type="button" data-dev-stage-add>Добавить этап</button></div></header>${stageCards || '<p class="dev-empty">Раздели цель на ближайший результат.</p>'}</section>`;
    const skillsBlock = blank ? '' : `<section class="dev-skills"><header><h3>Навыки</h3>${ext.skills.length ? `<input type="search" data-dev-skill-search placeholder="Найти навык, тему или описание" value="${escapeHtml(skillSearch)}"><span>${matched.length} из ${ext.skills.length}</span>` : ''}</header>${skills || '<p class="dev-empty">В выбранном этапе пока нет навыков. Добавь навык по желанию.</p>'}</section>`;
    element.innerHTML = `<section class="calendar-development" aria-label="План цели"><header><div>${embedded ? '<h3 class="dev-title">План цели</h3>' : `<p class="dev-eyebrow">План цели</p><h2>${escapeHtml(goal.title || 'Цель')}</h2>`}<span class="dev-total-progress">${totalPercent == null ? '' : `${totalPercent}% · ${totalDone} из ${ext.skills.length} подтверждено`}</span></div> <div>${blank ? '' : '<button type="button" data-dev-add>Добавить навык</button>'}<button type="button" class="dev-text-action" data-dev-import>Импорт JSON</button></div></header>${intro}${error ? `<p class="dev-error" role="alert">${escapeHtml(error)}</p>` : ''}${plan}${focusBlock}${stageBlock}${skillsBlock}</section>`;
    const confirm = (title, hint, action) => openDialog({ title, hint, submitLabel:'Подтвердить', draw: () => '<p>Связанные задачи и подтверждения навыков сохранятся.</p>', submit: () => mutate(action) });
    element.querySelectorAll('[data-dev-add]').forEach(button => button.addEventListener('click', () => skillEditor(null))); element.querySelector('[data-dev-import]')?.addEventListener('click', importSkills); element.querySelector('[data-dev-focus]')?.addEventListener('click', focusPicker); element.querySelectorAll('[data-dev-stage-add]').forEach(button => button.addEventListener('click', () => stageEditor(null))); element.querySelector('[data-dev-stage-clear]')?.addEventListener('click', () => { localStageId = null; render(); }); element.querySelector('[data-dev-skill-search]')?.addEventListener('input', event => { skillSearch = event.target.value.toLocaleLowerCase('ru').trim(); render(); const input = element.querySelector('[data-dev-skill-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); });
    element.querySelectorAll('[data-dev-skill]').forEach(button => button.addEventListener('click', () => skillEditor(ext.skills.find(skill => skill.id === button.dataset.devSkill)))); element.querySelectorAll('[data-dev-evidence]').forEach(button => button.addEventListener('click', () => evidenceEditor(ext.skills.find(skill => skill.id === button.dataset.devEvidence)))); element.querySelectorAll('[data-dev-stage]').forEach(button => button.addEventListener('click', () => stageEditor(ext.stages.find(stage => stage.id === button.dataset.devStage)))); element.querySelectorAll('[data-dev-stage-active]').forEach(button => button.addEventListener('click', () => { localStageId = button.dataset.devStageActive; render(); })); element.querySelectorAll('[data-dev-stage-current]').forEach(button => button.addEventListener('click', () => { localStageId = button.dataset.devStageCurrent; run(draft => { draft.activeStageId = button.dataset.devStageCurrent; }); })); element.querySelectorAll('[data-dev-stage-complete]').forEach(button => button.addEventListener('click', () => confirm('Завершить этап?', 'Этап останется текущим, пока ты явно не выберешь следующий.', draft => { const row = draft.stages.find(stage => stage.id === button.dataset.devStageComplete); if (row) row.status = 'completed'; }))); element.querySelectorAll('[data-dev-stage-reopen]').forEach(button => button.addEventListener('click', () => run(draft => { const row = draft.stages.find(stage => stage.id === button.dataset.devStageReopen); if (row) row.status = 'active'; }))); element.querySelectorAll('[data-dev-stage-delete]').forEach(button => button.addEventListener('click', () => confirm('Удалить этап?', 'Навыки и их подтверждения останутся в цели.', draft => { const id = button.dataset.devStageDelete; draft.stages = draft.stages.filter(stage => stage.id !== id); if (draft.activeStageId === id) draft.activeStageId = null; if (localStageId === id) localStageId = null; }))); element.querySelectorAll('[data-dev-remove]').forEach(button => button.addEventListener('click', () => confirm('Исключить навык из цели?', 'Навык выйдет из этапов и фокуса, но связанные задачи не будут удалены.', draft => { const id = button.dataset.devRemove; draft.skills = draft.skills.filter(skill => skill.id !== id); for (const stage of draft.stages) { stage.skillIds = stage.skillIds.filter(value => value !== id); if (stage.focusId === id) stage.focusId = null; } if (draft.focusId === id) draft.focusId = null; }))); element.querySelectorAll('[data-dev-task]').forEach(button => button.addEventListener('click', () => { const skill = ext.skills.find(item => item.id === button.dataset.devTask); if (skill) onCreateTask?.({ goalId, skillId: skill.id, skillTitle: skill.title }); })); element.querySelectorAll('[data-dev-task-link]').forEach(button => button.addEventListener('click', () => { const task = linkedTaskRows(ext.skills.find(skill => (skill.taskIds || []).some(id => String(id) === String(button.dataset.devTaskLink))), getTasks).find(row => String(row.source_id) === String(button.dataset.devTaskLink)); if (task) onOpenTask?.(task); }));
  }
  await load(); render();
  const chooseStage = () => {
    const ext=extension(state,goalId);
    return openDialog({title:'Какой этап сейчас',hint:'Выбери ближайший этап или развитие всей цели. Текущая задача не изменится.',submitLabel:'Выбрать этап',
      draw:()=>`<div class="dev-stage-choices"><label><input type="radio" name="stage" value="" ${!ext.activeStageId?'checked':''}>Вся цель</label>${ext.stages.map(stage=>`<label><input type="radio" name="stage" value="${escapeHtml(stage.id)}" ${stage.id===ext.activeStageId?'checked':''}><span><strong>${escapeHtml(stage.title)}</strong><small>${stage.status === 'completed' ? 'Завершён' : 'В работе'} · ${stage.skillIds.length} навыков${stage.deadline?' · до '+escapeHtml(stage.deadline):''}</small></span></label>`).join('')}</div>`,
      submit:async data=>mutate(draft=>{const id=String(data.get('stage')||'');if(id&&!draft.stages.some(stage=>stage.id===id))throw Error('Этот этап уже недоступен.');localStageId=id||null;draft.activeStageId=id||null;}),
    });
  };
  return { dispose: () => { disposed = true; for (const api of childDialogs) api.dispose(); childDialogs.clear(); element.replaceChildren(); }, refresh: async () => { await load(); render(); }, openFocusPicker:focusPicker, openStagePicker:chooseStage, openStageEditor:id=>stageEditor(extension(state,goalId).stages.find(stage=>stage.id===id)||null) };
}

/**
 * Dashboard glance of a goal: the current stage (or «Этап не выбран») and one
 * small progress indicator when real data exists. Read-only; details and the
 * stage and skill pickers live in the goal popup.
 */
export async function mountGoalGlance(element, { invoke, goal } = {}) {
  if (!element || !invoke || goal?.id == null) throw new Error('Не хватает цели или native API.');
  const id = String(goal.id);
  let current = goal, state = emptyDevelopmentState(), disposed = false, revision = 0, loaded = false;
  const countText = progress => progress.scope === 'numeric'
    ? `${formatNumber(progress.done)} / ${formatNumber(progress.total)}${progress.unit ? ` ${progress.unit}` : ''}`
    : `${progress.done} / ${progress.total}`;
  function draw() {
    if (disposed) return;
    const { stage, progress } = goalGlance(state, current);
    const stageLine = stage
      ? `<p class="calendar-goal-glance__stage" data-glance-stage><span class="calendar-goal-glance__label">Этап:</span> <span class="calendar-goal-glance__value" title="${escapeHtml(stage.title)}">${escapeHtml(stage.title)}</span></p>`
      : `<p class="calendar-goal-glance__stage is-empty" data-glance-stage>${loaded ? 'Этап не выбран' : ''}</p>`;
    const bar = progress ? `<div class="calendar-goal-glance__progress" data-glance-progress role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent ?? 0}" aria-label="${escapeHtml(progress.label)}" title="${escapeHtml(progress.label)}"><span class="calendar-goal-glance__track" aria-hidden="true"><span style="width:${progress.percent ?? 0}%"></span></span><span class="calendar-goal-glance__count" aria-hidden="true">${escapeHtml(countText(progress))}</span></div>` : '';
    element.innerHTML = `<div class="calendar-goal-glance" data-goal-glance="${escapeHtml(id)}">${stageLine}${bar}</div>`;
  }
  async function load(canCommit = null) {
    if (disposed || (canCommit && !canCommit())) return;
    const own = ++revision;
    let raw;
    try { raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY }); } catch { return; }
    if (disposed || own !== revision || (canCommit && !canCommit())) return;
    state = readDevelopmentState(raw); loaded = true; draw();
  }
  const listener = event => { if (String(event.detail?.goalId) === id) void load(); };
  const onSync = event => { if (event.detail?.remoteSync) void load(event.detail.canCommit); };
  window.addEventListener('hanni:development-changed', listener);
  window.addEventListener('hanni:calendar-refresh', onSync);
  draw(); await load();
  return {
    dispose: () => { disposed = true; revision++; window.removeEventListener('hanni:development-changed', listener); window.removeEventListener('hanni:calendar-refresh', onSync); element.replaceChildren(); },
    refresh: load,
    // A goal record edit (for example its current value) redraws without another read.
    update: next => { if (next && String(next.id) === id && JSON.stringify(next) !== JSON.stringify(current)) { current = next; draw(); } },
  };
}
