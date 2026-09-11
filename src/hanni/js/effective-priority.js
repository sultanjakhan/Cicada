// effective-priority.js — Combines manual priority + auto boosters into a
// single comparable number. Used by Calendar Список sort and by the
// picker so both surfaces order tasks the same way.

// Boost weights — tuned so manual priority still wins, but a category
// emphasis or an overdue task can push something past a higher-priority
// neighbour. Keep these in sync with project_effective_priority.md.
const OVERDUE_BOOST = 2;
const SOON_BOOST = 1;
const REFLECTION_PENALTY = 1;
const SOON_WINDOW_MIN = 60;

function timeToMin(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// item shape (loose): { priority, category, planned_time?, status_extra?,
//   overdue_date?, marks_previous_day?, source_type }
// weights: { [category]: number } from app_settings.task_category_weights.
export function effectivePriority(item, weights, nowMin) {
  let p = Number(item.priority || 0);

  if (item.status_extra === 'overdue' || item.overdue_date) p += OVERDUE_BOOST;

  if (nowMin != null) {
    const t = timeToMin(item.planned_time);
    if (t != null && t >= nowMin && (t - nowMin) <= SOON_WINDOW_MIN) p += SOON_BOOST;
  }

  if (weights && item.category != null) {
    const w = weights[item.category];
    if (typeof w === 'number') p += w - 1; // weight 1 = neutral
  }

  if (item.marks_previous_day) p -= REFLECTION_PENALTY;

  return p;
}

// Load category weights from app_settings (JSON). Missing → {}.
export async function loadCategoryWeights(invoke) {
  try {
    const raw = await invoke('get_app_setting', { key: 'task_category_weights' });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

export async function saveCategoryWeights(invoke, weights) {
  await invoke('set_app_setting', {
    key: 'task_category_weights',
    value: JSON.stringify(weights),
  });
}