import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCalendarPreferences, saveCalendarPreferences, saveRecommendationPreferences, normalizeCalendarPreferences } from '../src/hanni/js/calendar-display-preferences.js';
import { restoreLanguage, applySavedLanguage } from '../src/hanni/js/language-preference.js';
import { createUiCopy } from '../src/hanni/js/ui-copy.js';

const doc = () => ({ documentElement: { lang: 'ru' } });
function nativeSnapshot(initial = null) {
  let raw = initial, beforeWrite = null, failure = null;
  const calls = [];
  const transport = async (command, args = {}) => {
    calls.push([command, args]);
    if (command === 'get_ui_state') return raw;
    if (command === 'get_app_setting') return null;
    if (command === 'set_ui_state') {
      beforeWrite?.(); beforeWrite = null;
      if (failure) throw failure;
      if (args.expectedValue !== (raw ?? '')) throw Error('mvp_sync_stale_ui_state');
      raw = args.value; return null;
    }
    throw Error(command);
  };
  return { transport, calls, read: () => raw, race: fn => { beforeWrite = fn; }, set: value => { raw = value; }, fail: error => { failure = error; } };
}

test('RU/EN preference uses native acknowledged snapshot and restores after a fresh startup', async () => {
  for (const language of ['ru', 'en']) {
    const store = nativeSnapshot();
    const base = await loadCalendarPreferences(store.transport);
    const saved = await saveCalendarPreferences({ ...base, language }, store.transport, { base });
    const first = doc(); applySavedLanguage(first, saved);
    assert.equal(first.documentElement.lang, language);
    const restarted = doc(); const result = await restoreLanguage(restarted, store.transport);
    assert.equal(result.error, null); assert.equal(restarted.documentElement.lang, language);
    assert.equal(createUiCopy(restarted)('Задачи'), language === 'en' ? 'Tasks' : 'Задачи');
    const writes = store.calls.filter(([command]) => command === 'set_ui_state');
    assert.equal(writes.length, 1); assert.equal(writes[0][1].key, 'calendar_preferences_v1');
  }
});

test('missing and corrupt language default to RU without writing; corrupt snapshots remain untouched', async () => {
  for (const initial of [null, '', JSON.stringify({ language: 'fr' }), JSON.stringify({ language: 9 }), '{bad', '[]']) {
    const store = nativeSnapshot(initial), document = doc();
    const result = await restoreLanguage(document, store.transport);
    assert.equal(document.documentElement.lang, 'ru');
    assert.equal(store.read(), initial); assert.equal(store.calls.some(([c]) => c === 'set_ui_state'), false);
    assert.equal(!!result.error, initial === '{bad' || initial === '[]');
  }
});

test('restore awaits native read before the first localized render; read error falls back without save', async () => {
  const document = doc(); let resolve;
  const restoring = restoreLanguage(document, () => new Promise(done => { resolve = done; }));
  let rendered = false;
  const render = restoring.then(() => { rendered = true; return createUiCopy(document)('Календарь'); });
  await Promise.resolve(); assert.equal(rendered, false);
  resolve(JSON.stringify({ language: 'en' })); assert.equal(await render, 'Calendar');
  const failed = await restoreLanguage(document, async () => { throw Error('native read failed'); });
  assert.ok(failed.error); assert.equal(document.documentElement.lang, 'ru');
});

test('failed/stale native language writes never apply or claim saved', async () => {
  const store = nativeSnapshot(JSON.stringify(normalizeCalendarPreferences({ language: 'ru' })));
  const base = await loadCalendarPreferences(store.transport), document = doc();
  store.fail(Error('disk full'));
  await assert.rejects(async () => { applySavedLanguage(document, await saveCalendarPreferences({ ...base, language: 'en' }, store.transport, { base })); }, /disk full/);
  assert.equal(document.documentElement.lang, 'ru'); assert.equal(JSON.parse(store.read()).language, 'ru');
  store.fail(null); store.race(() => store.set(JSON.stringify({ ...base, density: 'compact' })));
  await assert.rejects(() => saveCalendarPreferences({ ...base, language: 'en' }, store.transport, { base }), /Настройки изменились/);
  assert.equal(JSON.parse(store.read()).density, 'compact'); assert.equal(JSON.parse(store.read()).language, 'ru');
});

test('language save merges unrelated fresh settings; recommendation save preserves language', async () => {
  const store = nativeSnapshot(JSON.stringify(normalizeCalendarPreferences({ language: 'ru' })));
  const base = await loadCalendarPreferences(store.transport);
  store.set(JSON.stringify({ ...base, density: 'compact', recommendTasks: false }));
  await saveCalendarPreferences({ ...base, language: 'en' }, store.transport, { base });
  await saveRecommendationPreferences({ recommendRoutines: false }, store.transport);
  const saved = JSON.parse(store.read());
  assert.equal(saved.language, 'en'); assert.equal(saved.density, 'compact');
  assert.equal(saved.recommendTasks, false); assert.equal(saved.recommendRoutines, false);
});

test('stale no-op language form preserves a fresh choice; shared copy follows the restored language', async () => {
  const store = nativeSnapshot(JSON.stringify(normalizeCalendarPreferences({ language: 'en' })));
  const base = await loadCalendarPreferences(store.transport);
  store.set(JSON.stringify({ ...base, language: 'ru' }));
  // A no-op stale language form must preserve the fresh language choice.
  const saved = await saveCalendarPreferences({ ...base, density: 'compact' }, store.transport, { base });
  assert.equal(saved.language, 'ru');
  const document = doc(), copy = createUiCopy(document);
  document.documentElement.lang = 'en'; assert.equal(copy('Сегодня'), 'Today');
  document.documentElement.lang = 'ru'; assert.equal(copy('Сегодня'), 'Сегодня');
});
