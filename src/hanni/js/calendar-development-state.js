// Pure goal-development state helpers. No DOM or native imports, so Goals, the
// goal popup and the dashboard glance read stages and progress the same way.
export const DEVELOPMENT_STATE_KEY = 'calendar_development_v1';
export const VERSION = 1;

const text = value => String(value ?? '').trim();
export const validDevelopmentDate = value => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), parsed = new Date(`${value}T12:00:00`);
  return parsed.getFullYear() === year && parsed.getMonth() + 1 === month && parsed.getDate() === day;
};
export const percentOf = (done, total) => total ? Math.round(done / total * 100) : null;

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
      if (!id || !title || stageSeen.has(id) || !validDevelopmentDate(text(stage.deadline))) return [];
      stageSeen.add(id);
      const skillIds = [...new Set(Array.isArray(stage.skillIds) ? stage.skillIds.map(String).filter(id => ids.has(id)) : [])];
      const focusId = skillIds.includes(String(stage.focusId || '')) ? String(stage.focusId) : null;
      return [{ id, title: title.slice(0, 160), outcome: text(stage.outcome).slice(0, 900), deadline: text(stage.deadline), skillIds, focusId, status: stage.status === 'completed' ? 'completed' : 'active' }];
    }) : [];
    goals[goalId] = { skills, stages, activeStageId: stages.some(stage => stage.id === String(value.activeStageId || '')) ? String(value.activeStageId) : null, focusId: ids.has(String(value.focusId || '')) ? String(value.focusId) : null };
  }
  return { version: VERSION, goals };
}

/** Reads a stored value for display only; a malformed value shows no stages instead of failing a list. */
export function readDevelopmentState(raw) {
  try { return normalizeDevelopmentState(raw); } catch { return emptyDevelopmentState(); }
}

export function developmentOf(state, goalId) { return state.goals[String(goalId)] || { skills: [], stages: [], activeStageId: null, focusId: null }; }
export function skillConfirmed(skill) { return Boolean(skill.evidence); }
export function stageProgress(stage, skills) {
  const set = new Set(stage.skillIds); const selected = skills.filter(skill => set.has(skill.id));
  const done = selected.filter(skillConfirmed).length;
  return { done, total: selected.length, percent: percentOf(done, selected.length) };
}
/** The stage shown as current: the active one, if it still exists. */
export function activeStageOf(state, goalId) {
  const ext = developmentOf(state, goalId);
  return ext.stages.find(item => item.id === ext.activeStageId) || null;
}

export const formatNumber = value => Number.isFinite(Number(value)) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(value)) : String(value ?? '');

/** Real current/target values only for goals that use a measurable result. */
export function goalNumericProgress(goal) {
  if (!goal || goal.goal_kind !== 'goal') return null;
  const target = Number(goal.target_value), current = Number(goal.current_value);
  const measurable = !!String(goal.unit || '').trim() || (Number.isFinite(target) && target !== 1) || (goal.current_value != null && Number.isFinite(current) && current > 0);
  if (!measurable || !Number.isFinite(target) || target <= 0) return null;
  const value = goal.current_value == null || !Number.isFinite(current) ? 0 : current;
  const unit = String(goal.unit || '').trim();
  return { done: value, total: target, percent: Math.max(0, Math.min(100, Math.round(value / target * 100))), scope: 'numeric', unit,
    label: `${formatNumber(value)} из ${formatNumber(target)}${unit ? ` ${unit}` : ''}` };
}

/**
 * Current stage and the most specific honest progress for a goal glance:
 * skills of the active stage, else skills of the whole goal, else a real
 * current/target value. No data means no progress (never an invented 0%).
 */
export function goalGlance(state, goal) {
  const ext = developmentOf(state, goal?.id);
  const stage = activeStageOf(state, goal?.id);
  let progress = null;
  if (stage) {
    const value = stageProgress(stage, ext.skills);
    if (value.total) progress = { ...value, scope: 'stage', label: `${value.done} из ${value.total} навыков этапа подтверждено` };
  }
  if (!progress && ext.skills.length) {
    const done = ext.skills.filter(skillConfirmed).length;
    progress = { done, total: ext.skills.length, percent: percentOf(done, ext.skills.length), scope: 'goal', label: `${done} из ${ext.skills.length} навыков цели подтверждено` };
  }
  if (!progress) progress = goalNumericProgress(goal);
  return { stage, hasStages: ext.stages.length > 0, progress, skills: ext.skills.length };
}
