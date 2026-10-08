import { loadCalendarPreferences, normalizeLanguage } from './calendar-display-preferences.js';

export { normalizeLanguage } from './calendar-display-preferences.js';

// Native preferences are authoritative. Restoration never writes or claims a save.
export async function restoreLanguage(document, transport) {
  let language = 'ru', error = null;
  try { language = normalizeLanguage((await loadCalendarPreferences(transport)).language); }
  catch (cause) { error = cause; }
  document.documentElement.lang = language;
  return { language, error };
}

export function applySavedLanguage(document, preferences) {
  const language = normalizeLanguage(preferences.language);
  const changed = document.documentElement.lang !== language;
  document.documentElement.lang = language;
  return changed;
}
