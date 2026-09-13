import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';

export const DEVELOPMENT_STATE_KEY = 'calendar_development_v1';
const VERSION = 1;
const MAX_IMPORT_BYTES = 200_000;
let developmentWriteQueue = Promise.resolve();

const uid = () => globalThis.crypto?.randomUUID?.() || `development-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const text = value => String(value ?? '').trim();
const date = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).valueOf()));
const pct = (done, total) => total ? Math.round(done / total * 100) : null;

export function emptyDevelopmentState() { return { version: VERSION, goals: {} }; }

export function normalizeDevelopmentState(raw) {
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object' || (source.version != null && source.version !== VERSION)) return emptyDevelopmentState();
  const goals = {};
  for (const [goalId, value] of Object.entries(source.goals || {})) {
    if (!goalId || !value || typeof value !== 'object') continue;
    const seen = new Set();
    const skills = Array.isArray(value.skills) ? value.skills.flatMap(skill => {
      const id = text(skill?.id), title = text(skill?.title), topic = text(skill?.topic);
      if (!id || !title || !topic || seen.has(id)) return [];
      const taskIds = [...new Set(Array.isArray(skill.taskIds) ? skill.taskIds.map(value => text(value)).filter(Boolean) : [])];
      seen.add(id); return [{ id, title: title.slice(0, 160), topic: topic.slice(0, 80), level: Math.max(1, Math.min(4, Number(skill.level) || 1)), evidence: text(skill.evidence).slice(0, 2000), taskIds }];
    }) : [];
    const ids = new Set(skills.map(skill => skill.id));
    const stageSeen = new Set();
    const stages = Array.isArray(value.stages) ? value.stages.flatMap(stage => {
      const id = text(stage?.id), title = text(stage?.title);
      if (!id || !title || stageSeen.has(id) || !date(text(stage.deadline))) return [];
      stageSeen.add(id);
      const skillIds = [...new Set(Array.isArray(stage.skillIds) ? stage.skillIds.map(String).filter(id => ids.has(id)) : [])];
      const focusId = skillIds.includes(String(stage.focusId || '')) ? String(stage.focusId) : null;
      return [{ id, title: title.slice(0, 160), outcome: text(stage.outcome).slice(0, 900), deadline: text(stage.deadline), skillIds, focusId }];
    }) : [];
    goals[goalId] = { skills, stages, activeStageId: stages.some(stage => stage.id === String(value.activeStageId || '')) ? String(value.activeStageId) : null, focusId: ids.has(String(value.focusId || '')) ? String(value.focusId) : null };
  }
  return { version: VERSION, goals };
}

export function validateDevelopmentImport(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json.length > MAX_IMPORT_BYTES) throw new Error('Файл слишком большой для импорта навыков.');
  let parsed; try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('Не удалось прочитать JSON.'); }
  const incoming = Array.isArray(parsed) ? { version: VERSION, goals: { imported: { skills: parsed, stages: [] } } } : parsed;
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
    const latest = normalizeDevelopmentState(await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY }));
    const ext = latest.goals[id]; const row = ext?.skills.find(item => item.id === skill);
    if (!row) throw new Error('Навык уже изменён. Обнови цель и повтори привязку задачи.');
    if ((row.taskIds || []).includes(task)) return;
    row.taskIds = [...(row.taskIds || []), task];
    await invoke('set_ui_state', { key: DEVELOPMENT_STATE_KEY, value: JSON.stringify(latest) });
    dispatchChange(id);
  });
  developmentWriteQueue = work;
  await work;
}

function extension(state, goalId) { return state.goals[String(goalId)] || { skills: [], stages: [], activeStageId: null, focusId: null }; }
function skillProgress(skill) { return Boolean(skill.evidence); }
function stageProgress(stage, skills) { const set = new Set(stage.skillIds); const selected = skills.filter(skill => set.has(skill.id)); const done = selected.filter(skillProgress).length; return { done, total: selected.length, percent: pct(done, selected.length) }; }
function topicList(skills) { return [...new Set(skills.map(skill => skill.topic))]; }

function dispatchChange(goalId) { window.dispatchEvent(new CustomEvent('hanni:development-changed', { detail: { goalId: String(goalId) } })); }

export async function mountGoalDevelopment(element, { invoke, goal, onCreateTask } = {}) {
  if (!element || !invoke || !goal?.id) throw new Error('Не хватает цели или native API.');
  let disposed = false, state = emptyDevelopmentState(), error = '';
  const goalId = String(goal.id);
  const current = () => !disposed && element.isConnected;
  const load = async () => {
    const raw = await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY });
    state = normalizeDevelopmentState(raw);
  };
  const mutate = async change => {
    const work = developmentWriteQueue.catch(() => {}).then(async () => {
      const fresh = normalizeDevelopmentState(await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY }));
      const next = structuredClone(fresh); const draft = extension(next, goalId); next.goals[goalId] = draft; change(draft, next);
      const normalized = normalizeDevelopmentState(next);
      await invoke('set_ui_state', { key: DEVELOPMENT_STATE_KEY, value: JSON.stringify(normalized) });
      state = normalized; error = ''; dispatchChange(goalId); render();
    });
    developmentWriteQueue = work;
    try { await work; } catch (cause) { error = 'Не удалось сохранить изменения. Ничего не применено — повтори действие.'; render(); throw cause; }
  };
  const openDialog = ({ title, hint, submitLabel, draw, submit }) => {
    const api = createCalendarDialog({ document: element.ownerDocument, title, hint, submitLabel, returnFocus: () => element.querySelector('button')?.focus() });
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
    draw: () => `<label>Название навыка<input name="title" required maxlength="160" value="${escapeHtml(skill?.title || '')}"></label><label>Тема<input name="topic" required maxlength="80" placeholder="SQL, API, требования…" value="${escapeHtml(skill?.topic || '')}"></label><label>Ориентир<select name="level">${[1,2,3,4].map(level => `<option value="${level}" ${Number(skill?.level || 1) === level ? 'selected' : ''}>Уровень ${level}</option>`).join('')}</select></label>`,
    submit: async data => { const title = text(data.get('title')), topic = text(data.get('topic')); if (!title || !topic) throw new Error('Заполни название и тему.'); await mutate(draft => { const row = { id: skill?.id || uid(), title, topic, level: Number(data.get('level')) || 1, evidence: skill?.evidence || '' }; const at = draft.skills.findIndex(item => item.id === row.id); if (at >= 0) draft.skills[at] = row; else draft.skills.push(row); }); },
  });
  const evidenceEditor = skill => openDialog({ title: 'Подтверждение навыка', hint: 'Опиши проверяемый результат: работа, ссылка или краткая проверка.', submitLabel: 'Сохранить подтверждение', draw: () => `<label>Результат<textarea name="evidence" maxlength="2000" rows="5">${escapeHtml(skill.evidence || '')}</textarea></label>`, submit: async data => mutate(draft => { const row = draft.skills.find(item => item.id === skill.id); if (!row) throw new Error('Навык уже изменён. Обнови страницу.'); row.evidence = text(data.get('evidence')); }) });
  const stageEditor = stage => {
    const ext = extension(state, goalId); const selected = new Set(stage?.skillIds || []);
    return openDialog({ title: stage ? 'Изменить этап' : 'Новый этап', hint: 'Выбери часть навыков и необязательный срок. Общая цель не меняется.', submitLabel: 'Сохранить этап',
      draw: () => `<label>Название этапа<input name="title" required maxlength="160" value="${escapeHtml(stage?.title || '')}"></label><label>Результат этапа<textarea name="outcome" maxlength="900" rows="3">${escapeHtml(stage?.outcome || '')}</textarea></label><label>Срок<input name="deadline" type="date" value="${escapeHtml(stage?.deadline || '')}"></label><fieldset><legend>Навыки этапа</legend><div class="dev-skill-checks">${topicList(ext.skills).map(topic => `<section><strong>${escapeHtml(topic)}</strong>${ext.skills.filter(skill => skill.topic === topic).map(skill => `<label><input type="checkbox" name="skill" value="${escapeHtml(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}>${escapeHtml(skill.title)}</label>`).join('')}</section>`).join('') || '<p>Сначала добавь хотя бы один навык.</p>'}</div></fieldset>`,
      submit: async data => { const title = text(data.get('title')), outcome = text(data.get('outcome')), deadline = text(data.get('deadline')), skillIds = data.getAll('skill').map(String); if (!title) throw new Error('Дай этапу название.'); if (!skillIds.length) throw new Error('Выбери хотя бы один навык.'); if (!date(deadline)) throw new Error('Проверь срок этапа.'); await mutate(draft => { const old = draft.stages.find(item => item.id === stage?.id); const row = { id: stage?.id || uid(), title, outcome, deadline, skillIds, focusId: skillIds.includes(old?.focusId) ? old.focusId : null }; const at = draft.stages.findIndex(item => item.id === row.id); if (at >= 0) draft.stages[at] = row; else { draft.stages.push(row); draft.activeStageId = row.id; } }); },
    });
  };
  const focusPicker = () => {
    const ext = extension(state, goalId); const active = ext.stages.find(stage => stage.id === ext.activeStageId) || null; const allowed = active ? new Set(active.skillIds) : null;
    return openDialog({ title: 'Навык на сейчас', hint: 'Выбор не меняет текущую задачу. Можно очистить фокус.', submitLabel: 'Применить',
      draw: () => `<label><input type="radio" name="focus" value="" ${(active ? !active.focusId : !ext.focusId) ? 'checked' : ''}>Очистить выбранный навык</label>${topicList(ext.skills.filter(skill => !allowed || allowed.has(skill.id))).map(topic => `<fieldset><legend>${escapeHtml(topic)}</legend>${ext.skills.filter(skill => skill.topic === topic && (!allowed || allowed.has(skill.id))).map(skill => `<label><input type="radio" name="focus" value="${escapeHtml(skill.id)}" ${(active ? active.focusId : ext.focusId) === skill.id ? 'checked' : ''}>${escapeHtml(skill.title)}</label>`).join('')}</fieldset>`).join('') || '<p>В активном этапе нет навыков. Измени его состав.</p>'}`,
      submit: async data => mutate(draft => { const id = String(data.get('focus') || ''); const target = draft.stages.find(stage => stage.id === draft.activeStageId); if (target) target.focusId = target.skillIds.includes(id) ? id : null; else draft.focusId = draft.skills.some(skill => skill.id === id) ? id : null; }),
    });
  };
  const importSkills = () => {
    const api = openDialog({ title: 'Импорт навыков JSON', hint: 'Ожидается JSON с skills или development export. Импорт добавляет уникальные навыки к этой цели.', submitLabel: 'Импортировать', draw: () => '<label>JSON<textarea name="json" rows="10" required></textarea></label>', submit: async data => {
      const parsed = validateDevelopmentImport(text(data.get('json'))); const source = Object.values(parsed.goals).flatMap(item => item.skills); await mutate(draft => { const known = new Set(draft.skills.map(skill => `${skill.topic}\u0000${skill.title}`.toLowerCase())); for (const skill of source) { const key = `${skill.topic}\u0000${skill.title}`.toLowerCase(); if (!known.has(key)) { known.add(key); draft.skills.push({ ...skill, id: uid(), evidence: '' }); } } });
    }}); return api;
  };
  function render() {
    if (!current()) return; const ext = extension(state, goalId); const active = ext.stages.find(stage => stage.id === ext.activeStageId) || null; const focusId = active ? active.focusId : ext.focusId; const focus = ext.skills.find(skill => skill.id === focusId); const stageCards = ext.stages.map(stage => { const progress = stageProgress(stage, ext.skills); return `<article class="dev-stage ${stage.id === ext.activeStageId ? 'is-active' : ''}"><div><strong>${escapeHtml(stage.title)}</strong><span>${stage.outcome ? `${escapeHtml(stage.outcome)} · ` : ''}${stage.deadline ? `До ${escapeHtml(stage.deadline)} · ` : ''}${progress.total ? `${progress.done} из ${progress.total} · ${progress.percent}%` : 'Нет оценки — выбери навыки'}</span></div><div><button type="button" data-dev-stage-active="${escapeHtml(stage.id)}">${stage.id === ext.activeStageId ? 'Показан' : 'Показать'}</button><button type="button" data-dev-stage="${escapeHtml(stage.id)}">Изменить</button></div></article>`; }).join('');
    const skills = topicList(ext.skills).map(topic => `<section class="dev-topic"><h4>${escapeHtml(topic)}</h4>${ext.skills.filter(skill => skill.topic === topic).map(skill => `<article class="dev-skill"><button type="button" data-dev-skill="${escapeHtml(skill.id)}">${escapeHtml(skill.title)}</button><span>${skill.evidence ? 'Подтверждено' : 'Без подтверждения'}</span><div><button type="button" data-dev-evidence="${escapeHtml(skill.id)}">${skill.evidence ? 'Изменить результат' : 'Подтвердить'}</button><button type="button" data-dev-task="${escapeHtml(skill.id)}">Задача</button></div></article>`).join('')}</section>`).join('');
    element.innerHTML = `<section class="calendar-development" aria-label="Развитие цели"><header><div><p class="dev-eyebrow">Развитие цели</p><h2>${escapeHtml(goal.title || 'Цель')}</h2></div><div><button type="button" data-dev-import>Импорт JSON</button><button type="button" data-dev-add>Добавить навык</button></div></header>${error ? `<p class="dev-error" role="alert">${escapeHtml(error)}</p>` : ''}<section class="dev-focus"><div><span>${active ? `Навык в этапе «${escapeHtml(active.title)}»` : 'Сейчас развиваю'}</span><strong>${focus ? `${escapeHtml(focus.topic)} · ${escapeHtml(focus.title)}` : active && !active.skillIds.length ? 'В этапе пока нет навыков' : 'Не выбрано'}</strong></div><button type="button" data-dev-focus>${focus ? 'Сменить или очистить' : 'Выбрать навык'}</button></section><section class="dev-stages"><header><h3>Этапы</h3><div>${active ? '<button type="button" data-dev-stage-clear>Вся цель</button>' : ''}<button type="button" data-dev-stage-add>Новый этап</button></div></header>${stageCards || '<p class="dev-empty">Раздели цель на ближайший результат и нужные навыки.</p>'}</section><section class="dev-skills"><header><h3>Навыки</h3><span>${ext.skills.length}</span></header>${skills || '<p class="dev-empty">Добавь первый навык вручную или импортируй JSON.</p>'}</section></section>`;
    element.querySelector('[data-dev-add]')?.addEventListener('click', () => skillEditor(null)); element.querySelector('[data-dev-import]')?.addEventListener('click', importSkills); element.querySelector('[data-dev-focus]')?.addEventListener('click', focusPicker); element.querySelector('[data-dev-stage-add]')?.addEventListener('click', () => stageEditor(null)); element.querySelector('[data-dev-stage-clear]')?.addEventListener('click', () => void mutate(draft => { draft.activeStageId = null; }));
    element.querySelectorAll('[data-dev-skill]').forEach(button => button.addEventListener('click', () => skillEditor(ext.skills.find(skill => skill.id === button.dataset.devSkill)))); element.querySelectorAll('[data-dev-evidence]').forEach(button => button.addEventListener('click', () => evidenceEditor(ext.skills.find(skill => skill.id === button.dataset.devEvidence)))); element.querySelectorAll('[data-dev-stage]').forEach(button => button.addEventListener('click', () => stageEditor(ext.stages.find(stage => stage.id === button.dataset.devStage)))); element.querySelectorAll('[data-dev-stage-active]').forEach(button => button.addEventListener('click', () => void mutate(draft => { draft.activeStageId = button.dataset.devStage; }))); element.querySelectorAll('[data-dev-task]').forEach(button => button.addEventListener('click', () => { const skill = ext.skills.find(item => item.id === button.dataset.devTask); if (skill) onCreateTask?.({ goalId, skillId: skill.id, skillTitle: skill.title }); }));
  }
  await load(); render();
  return { dispose: () => { disposed = true; element.replaceChildren(); }, refresh: async () => { await load(); render(); } };
}

export async function mountGoalDevelopmentSummary(element, { invoke, goalId, onOpen } = {}) {
  if (!element || !invoke || goalId == null) throw new Error('Не хватает цели или native API.');
  const id = String(goalId); let disposed = false;
  const render = async () => {
    if (disposed || !element.isConnected) return; const state = normalizeDevelopmentState(await invoke('get_ui_state', { key: DEVELOPMENT_STATE_KEY })); const ext = extension(state, id); const stage = ext.stages.find(item => item.id === ext.activeStageId) || ext.stages[0]; const focus = ext.skills.find(skill => skill.id === (stage?.focusId || ext.focusId)); const progress = stage ? stageProgress(stage, ext.skills) : null;
    element.innerHTML = `<section class="calendar-development-summary">${stage ? `<div><span>Текущий этап</span><strong>${escapeHtml(stage.title)}</strong><small>${stage.deadline ? `До ${escapeHtml(stage.deadline)} · ` : ''}${progress.total ? `${progress.percent}% · ${progress.done}/${progress.total}` : 'Настрой навыки'}</small></div>` : '<div><span>Развитие</span><strong>Настрой ближайший этап</strong><small>Выбери навыки и срок</small></div>'}<div>${focus ? `<span>${escapeHtml(focus.topic)}</span><strong>${escapeHtml(focus.title)}</strong>` : '<span>Навык не выбран</span>'}<button type="button" data-development-open>Открыть</button></div></section>`;
    element.querySelector('[data-development-open]')?.addEventListener('click', () => onOpen?.({ goalId: id }));
  };
  const listener = event => { if (String(event.detail?.goalId) === id) void render(); };
  window.addEventListener('hanni:development-changed', listener); await render();
  return { dispose: () => { disposed = true; window.removeEventListener('hanni:development-changed', listener); element.replaceChildren(); }, refresh: render };
}
