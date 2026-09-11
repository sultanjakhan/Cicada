// task-picker-view.js — Presentation for the "Запустить таск" picker body.
// Pure HTML building (no event wiring); the widget owns state and wiring.
import { invoke } from './state.js';
import { escapeHtml } from './utils.js';
import { rankTasks, nowMinutes } from './task-picker-sort.js';

// Mirrors SCH_CAT_ICONS in tab-calendar.js / calendar-task-list.js. Keep in sync.
const SCH_CAT_ICONS = {
  sport: '🔥', hygiene: '🫧', home: '🏡',
  practice: '🎯', challenge: '⚡', growth: '🌱', work: '⚙️', other: '◽',
};
const GROUP_TITLES = { event: 'События', schedule: 'Расписание', note: 'Задачи' };

function taskIcon(p) {
  if (p.source_type === 'schedule') return SCH_CAT_ICONS[p.category] || SCH_CAT_ICONS.other;
  if (p.source_type === 'event') return '📅';
  if (p.source_type === 'note') return '📝';
  return '•';
}

// Editable per-category weights, stored as JSON in app_settings; {} when unset.
export async function loadCategoryWeights() {
  try {
    const raw = await invoke('get_app_setting', { key: 'task_category_weights' });
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function fmtMins(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}ч${m ? ` ${m}м` : ''}` : `${m}м`;
}

// Priority dots (0..5), reusing the graph's .rt-dot visual. '' when priority 0.
function priorityDots(p) {
  const n = p.priority || 0;
  if (!n) return '';
  const dots = Array.from({ length: 5 }, (_, i) => `<span class="rt-dot${i < n ? ' on' : ''}"></span>`).join('');
  return `<span class="rt-dots tw-dots" title="Важность ${n}/5">${dots}</span>`;
}

// Right-side meta: ONLY execution time (⌀ average actual from history). No
// planned times — picker is a launcher, not a schedule view; "когда делать"
// belongs in notifications/calendar, not in every row.
function metaText(p, _nowMin, avgDur) {
  const avg = avgDur[`${p.source_type}:${p.source_id}`];
  if (avg) return `<span class="tw-meta" title="Среднее по истории">⌀ ${fmtMins(avg)}</span>`;
  if (p.duration_minutes) {
    return `<span class="tw-meta" title="Плановая длительность">~${fmtMins(p.duration_minutes)}</span>`;
  }
  return '';
}

// Build the picker body HTML and the flat index list used by click wiring.
// Order: Рутина → Закреплено → Просрочено → type groups, each composite-sorted.
// `routineHasRec` true means an active routine already owns the blue "сейчас".
export async function buildPickerBody({ startable, weights, pins, avgDur = {}, routineHtml, routineHasRec }) {
  const nowMin = nowMinutes();
  const ranked = rankTasks(startable, { nowMin, weights, pins });
  const pinned = ranked.filter(p => p._pinned);
  const overdue = ranked.filter(p => !p._pinned && p._overdue);
  const rest = ranked.filter(p => !p._pinned && !p._overdue);

  const groups = {
    event:    rest.filter(p => p.source_type === 'event'),
    schedule: rest.filter(p => p.source_type === 'schedule'),
    note:     rest.filter(p => p.source_type === 'note'),
  };
  const nonEmpty = Object.entries(groups).filter(([, items]) => items.length > 0);
  const orderedItems = [...pinned, ...overdue, ...nonEmpty.flatMap(([, items]) => items)];
  const showHeaders = nonEmpty.length > 1 || routineHtml || overdue.length > 0 || pinned.length > 0;

  // Fallback recommendation: when no active routine owns it, the top non-pinned task.
  const recPool = [...overdue, ...nonEmpty.flatMap(([, items]) => items)];
  const recItem = routineHasRec ? null : (recPool[0] || null);

  const itemHtml = (p, groupCls = '') => {
    const idx = orderedItems.indexOf(p);
    const isRec = p === recItem;
    const cls = isRec ? 'tw-item--recommended' : `${groupCls}${p._pinned ? ' tw-item--pinned' : ''}`;
    const recTitle = isRec ? ' title="Рекомендация: сделать сейчас"' : '';
    // ✓/✗ pair — for schedules answered by a single tap (instant/reflection):
    // ✓ marks done, ✗ marks "не выполнено". Both stopPropagation so they don't
    // trigger the row's start/toggle.
    const showPair = p.source_type === 'schedule' && (p.tracking_mode === 'check' || p.marks_previous_day);
    const pairHtml = showPair
      ? `<span class="tw-check" data-check-idx="${idx}" title="Сделал">✓</span>` +
        `<span class="tw-skip" data-skip-idx="${idx}" title="Не выполнено">✗</span>`
      : '';
    return `
    <button class="tw-item ${cls}" data-idx="${idx}"${recTitle}>
      <span class="tw-item-icon">${taskIcon(p)}</span>
      <span class="tw-item-title">${escapeHtml(p.title)}</span>
      ${priorityDots(p)}${metaText(p, nowMin, avgDur)}${isRec ? '<span class="tw-now">сейчас</span>' : ''}
      ${pairHtml}
      <span class="tw-pin ${p._pinned ? 'tw-pin--on' : ''}" data-pin-idx="${idx}"
            title="${p._pinned ? 'Открепить' : 'Закрепить'}">${p._pinned ? '★' : '☆'}</span>
    </button>`;
  };
  const section = (title, items, cls) => items.length
    ? `<div class="tw-group-header">${title}</div>${items.map(p => itemHtml(p, cls)).join('')}`
    : '';
  const groupsHtml = nonEmpty.map(([key, items]) => `
    ${showHeaders ? `<div class="tw-group-header">${GROUP_TITLES[key]}</div>` : ''}
    ${items.map(p => itemHtml(p)).join('')}`).join('');
  const isEmpty = orderedItems.length === 0 && !routineHtml;

  const bodyHtml = `${routineHtml}${isEmpty
    ? '<div class="tw-empty">Нет задач на сегодня</div>'
    : section('Закреплено', pinned, '') + section('⚠️ Просрочено', overdue, 'tw-item--overdue') + groupsHtml}`;
  return { bodyHtml, orderedItems };
}