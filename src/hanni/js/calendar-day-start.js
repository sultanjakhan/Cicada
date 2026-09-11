const TZ_INSTANT = /(?:Z|[+-]\d{2}:\d{2})$/i;

function localDate(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function localTime(value) {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

/** Projects only confirmed starts from the local day-start ledger. */
export function projectDayStarts(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!parsed || !Array.isArray(parsed.entries)) return [];
  const rows = parsed.entries.map(entry => {
    const startedAtUtc = entry?.started_at_utc;
    if (typeof entry?.id !== 'string' || !entry.id || typeof startedAtUtc !== 'string' || !TZ_INSTANT.test(startedAtUtc)) return null;
    const instant = new Date(startedAtUtc);
    if (Number.isNaN(instant.getTime())) return null;
    return { id: entry.id, date: localDate(instant), time: localTime(instant), startedAtUtc, epoch: instant.getTime() };
  }).filter(Boolean).sort((left, right) => left.epoch - right.epoch || left.id.localeCompare(right.id));
  const seen = new Set();
  return rows.filter(row => !seen.has(row.id) && seen.add(row.id)).map(({ epoch, ...row }) => row);
}

/** Builds a non-interactive Calendar label for a confirmed start. */
export function renderDayStartMarker(marker, { compact = false } = {}) {
  const root = document.createElement(compact ? 'span' : 'div');
  root.className = 'calv-day-start';
  root.dataset.dayStartMarker = marker.id;
  const time = document.createElement('time');
  time.dateTime = marker.startedAtUtc;
  const label = `Начало дня · ${marker.time}`;
  time.textContent = compact ? marker.time : label;
  time.setAttribute('aria-label', label);
  root.append(time);
  return root;
}