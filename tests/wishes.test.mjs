import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><button id="new">Новое желание</button><main></main></body>', { url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
const store = await import('../src/hanni/js/calendar-wishes-store.js');
const { mountCalendarWishes } = await import('../src/hanni/js/calendar-wishes.js');
const { mountCalendarContextMenu } = await import('../src/hanni/js/calendar-context-menu.js');
const { WISHES_STATE_KEY, validateWishInput, normalizeWishState, normalizeWishUrl, createWish, updateWish, setWishStatus, deleteWish, markWishConverted, wishGoalDraft, wishPriceLabel, WISH_STALE_MESSAGE, WishValidationError } = store;
const document = dom.window.document;
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function backend(initial = null) {
  const state = { raw: initial == null ? null : JSON.stringify(initial), calls: [], before: new Map() };
  state.invoke = async (command, args) => {
    state.calls.push({ command, args: structuredClone(args) });
    if (state.before.has(command)) await state.before.get(command)(args);
    if (command === 'get_ui_state') { assert.equal(args.key, WISHES_STATE_KEY); return state.raw; }
    if (command === 'set_ui_state') {
      assert.equal(args.key, WISHES_STATE_KEY);
      if ((state.raw ?? '') !== args.expectedValue) throw 'mvp_sync_stale_ui_state';
      state.raw = args.value; return null;
    }
    throw new Error('Unexpected IPC ' + command);
  };
  state.wishes = () => JSON.parse(state.raw).wishes;
  state.writes = () => state.calls.filter(call => call.command === 'set_ui_state').length;
  return state;
}
const clock = () => new Date('2026-09-24T10:00:00.000Z');

test('wish input: only the title is required; price, link and note are optional and validated', () => {
  assert.deepEqual(validateWishInput({ title: '  Кроссовки  ' }), { title: 'Кроссовки', category: 'other', price: null, currency: 'KZT', url: '', note: '', status: 'want' });
  assert.deepEqual(validateWishInput({ title: 'Поездка', category: 'travel', price: '45 000', currency: 'USD', url: 'https://example.com/a b', note: ' в горы ', status: 'saving' }),
    { title: 'Поездка', category: 'travel', price: 45000, currency: 'USD', url: 'https://example.com/a%20b', note: 'в горы', status: 'saving' });
  assert.equal(validateWishInput({ title: 'Кофе', price: '1,5' }).price, 1.5);
  assert.equal(validateWishInput({ title: 'Кофе', price: 0 }).price, 0);
  assert.equal(validateWishInput({ title: 'Кофе', category: 'weapons', status: 'stolen', currency: 'BTC' }).category, 'other', 'unknown values fall back to defaults');
  const failure = (input, field) => assert.throws(() => validateWishInput(input), error => error instanceof WishValidationError && error.field === field);
  failure({ title: '   ' }, 'title');
  failure({ title: 'Я'.repeat(201) }, 'title');
  for (const price of ['abc', '-5', '1e3', '12.5.1', Number.NaN, 2e12]) failure({ title: 'Цена', price }, 'price');
  for (const url of ['javascript:alert(1)', 'ftp://example.com', 'example.com', 'https://', 'file:///etc/passwd', `https://example.com/${'a'.repeat(2000)}`]) failure({ title: 'Ссылка', url }, 'url');
  failure({ title: 'Заметка', note: 'з'.repeat(2001) }, 'note');
  assert.equal(normalizeWishUrl('  HTTP://Example.com/x  '), 'http://example.com/x');
  assert.equal(validateWishInput({ title: 'Я'.repeat(200) }).title.length, 200);
});

test('stored wishes are normalized without losing newer fields and an unknown version stops the write', () => {
  const state = normalizeWishState(JSON.stringify({ version: 1, extra: 'kept', wishes: [
    { id: 'a', title: 'Первое', category: 'home', price: '120', url: 'javascript:bad', status: 'bought', future: { x: 1 } },
    { id: 'a', title: 'Дубликат' }, { id: '', title: 'Без id' }, { id: 'b', title: '  ' }, { id: 7, title: 'Число' }, { id: 'c', title: 'Второе', price: -1, currency: 'XXX', goalId: 5 },
  ] }));
  assert.equal(state.extra, 'kept');
  assert.deepEqual(state.wishes.map(wish => wish.id), ['a', 'c']);
  assert.deepEqual(state.wishes[0].future, { x: 1 }, 'an older client keeps fields it does not know');
  assert.equal(state.wishes[0].url, ''); assert.equal(state.wishes[0].price, 120); assert.equal(state.wishes[0].status, 'bought');
  assert.equal(state.wishes[1].price, null); assert.equal(state.wishes[1].currency, 'KZT'); assert.equal(state.wishes[1].goalId, '5');
  assert.deepEqual(normalizeWishState(null), { version: 1, wishes: [] });
  assert.throws(() => normalizeWishState({ version: 2, wishes: [] }), /Неподдерживаемый формат желаний/);
  assert.throws(() => normalizeWishState({ version: 1, wishes: {} }), /Неподдерживаемый/);
});

test('create, edit, status, conversion and deletion write one compare-and-swap each', async () => {
  const data = backend(), events = [];
  const onChange = () => events.push('changed');
  dom.window.addEventListener('hanni:wishes-changed', onChange);
  const first = await createWish({ title: 'Кофемолка', category: 'home', price: '18000' }, { invoke: data.invoke, now: clock });
  assert.equal(first.createdAt, '2026-09-24T10:00:00.000Z'); assert.equal(first.status, 'want'); assert.equal(first.goalId, null);
  assert.deepEqual(data.calls.slice(0, 2).map(call => [call.command, call.args.expectedValue]), [['get_ui_state', undefined], ['set_ui_state', '']]);
  const second = await createWish({ title: 'Поездка' }, { invoke: data.invoke, now: clock });
  assert.notEqual(first.id, second.id);
  const edited = await updateWish(first.id, { title: 'Ручная кофемолка', category: 'home', price: '21000', status: 'saving' }, { invoke: data.invoke, original: data.wishes()[0], now: () => new Date('2026-09-25T00:00:00Z') });
  assert.equal(edited.title, 'Ручная кофемолка'); assert.equal(edited.createdAt, first.createdAt); assert.equal(edited.updatedAt, '2026-09-25T00:00:00.000Z');
  await setWishStatus(second.id, 'dropped', { invoke: data.invoke });
  await assert.rejects(setWishStatus(second.id, 'lost', { invoke: data.invoke }), /Неизвестный статус/);
  await markWishConverted(first.id, 42, { invoke: data.invoke });
  assert.equal(data.wishes()[0].goalId, '42'); assert.ok(data.wishes()[0].convertedAt);
  await assert.rejects(markWishConverted(first.id, '', { invoke: data.invoke }), /Не хватает созданной цели/);
  await deleteWish(second.id, { invoke: data.invoke });
  assert.deepEqual(data.wishes().map(wish => wish.title), ['Ручная кофемолка']);
  assert.equal(data.writes(), 6);
  assert.equal(events.length, 6, 'every write tells open lists to refresh');
  dom.window.removeEventListener('hanni:wishes-changed', onChange);
});

test('validation fails before any native call and parallel creates are serialized', async () => {
  const data = backend();
  await assert.rejects(createWish({ title: '' }, { invoke: data.invoke }), error => error.field === 'title');
  await assert.rejects(createWish({ title: 'Ссылка', url: 'javascript:x' }, { invoke: data.invoke }), error => error.field === 'url');
  assert.equal(data.calls.length, 0);
  await Promise.all(['А', 'Б', 'В'].map(title => createWish({ title }, { invoke: data.invoke })));
  assert.deepEqual(data.wishes().map(wish => wish.title), ['А', 'Б', 'В'], 'no create overwrote another');
});

test('a change from another device is never overwritten', async () => {
  const data = backend({ version: 1, wishes: [{ id: 'w', title: 'Старое', status: 'want' }] });
  const original = normalizeWishState(data.raw).wishes[0];
  data.before.set('set_ui_state', () => { data.raw = JSON.stringify({ version: 1, wishes: [{ id: 'w', title: 'С телефона', status: 'saving' }] }); });
  await assert.rejects(createWish({ title: 'Новое' }, { invoke: data.invoke }), new RegExp(WISH_STALE_MESSAGE.slice(0, 30)));
  data.before.delete('set_ui_state');
  assert.deepEqual(data.wishes().map(wish => wish.title), ['С телефона']);
  await assert.rejects(updateWish('w', { title: 'Локально' }, { invoke: data.invoke, original }), /изменено на другом устройстве/);
  await assert.rejects(setWishStatus('missing', 'bought', { invoke: data.invoke }), /уже удалено/);
  assert.equal(data.wishes()[0].title, 'С телефона');
});

test('conversion draft keeps the note and link and turns a price into a saving target', () => {
  assert.deepEqual(wishGoalDraft({ title: 'Ноутбук', note: 'Для дизайна', url: 'https://example.com/x', price: 650000, currency: 'KZT' }),
    { title: 'Ноутбук', description: 'Для дизайна\nСсылка: https://example.com/x', targetValue: 650000, unit: '₸' });
  assert.deepEqual(wishGoalDraft({ title: 'Опыт', note: '', url: '', price: null, currency: 'KZT' }), { title: 'Опыт', description: '' });
  assert.equal(wishGoalDraft({ title: 'Даром', price: 0, currency: 'USD' }).targetValue, undefined);
  assert.match(wishPriceLabel({ price: 45000, currency: 'KZT' }), /^45\s000 ₸$/);
  assert.equal(wishPriceLabel({ price: null }), '');
});

async function mountList(t, initial, dependencies = {}) {
  const data = backend(initial), host = document.querySelector('main'), opened = [];
  const controller = mountCalendarWishes(host, { invoke: data.invoke, mountMenu: mountCalendarContextMenu, getGoals: () => [{ id: 'g1', title: 'Накопить на ноутбук' }], returnFocus: () => document.getElementById('new').focus(), ...dependencies });
  t.after(() => { controller.dispose(); document.querySelectorAll('dialog, .calendar-record-menu').forEach(node => node.remove()); });
  await controller.ready; await settle();
  const submit = async modal => { modal.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  const menu = async (id, action) => { host.querySelector(`[data-wish-menu="${id}"]`).click(); document.querySelector(`.calendar-record-menu [data-menu-action="${action}"]`).click(); await settle(); };
  return { data, host, controller, submit, menu, opened };
}
const wish = (id, extra = {}) => ({ id, title: `Желание ${id}`, category: 'other', price: null, currency: 'KZT', url: '', note: '', status: 'want', goalId: null, createdAt: '2026-09-01T00:00:00Z', ...extra });

test('wish list: empty state, then a validated form adds a row and focuses it', async t => {
  const x = await mountList(t, null);
  assert.match(x.host.querySelector('.cp-wish-empty').textContent, /Желаний пока нет/);
  document.getElementById('new').focus();
  const modal = x.controller.openCreate(), fields = modal.form.elements;
  assert.deepEqual([...fields.category.options].map(option => option.textContent), ['Одежда', 'Техника', 'Дом', 'Поездки', 'Опыт', 'Другое']);
  assert.deepEqual([...fields.status.options].map(option => option.textContent), ['Хочу', 'Коплю', 'Куплено', 'Передумал']);
  assert.equal(fields.currency.value, 'KZT');
  fields.title.value = 'Беговые кроссовки'; fields.price.value = 'сорок'; await x.submit(modal.modal);
  assert.equal(fields.price.getAttribute('aria-invalid'), 'true'); assert.equal(document.activeElement, fields.price);
  assert.equal(x.data.writes(), 0);
  fields.price.value = '45 000'; fields.url.value = 'ftp://shop'; await x.submit(modal.modal);
  assert.equal(document.activeElement, fields.url); assert.equal(x.data.writes(), 0);
  fields.url.value = 'https://example.com/shoes'; fields.category.value = 'clothes'; await x.submit(modal.modal);
  assert.equal(modal.modal.isConnected, false);
  const row = x.host.querySelector('.cp-wish-row');
  assert.equal(row.querySelector('.cp-wish-row__title').textContent, 'Беговые кроссовки');
  assert.match(row.querySelector('.cp-wish-row__meta').textContent, /^Одежда · 45\s000 ₸$/);
  assert.equal(document.activeElement, row.querySelector('[data-wish-edit]'));
  assert.match(x.host.querySelector('[data-wish-message]').textContent, /Желание добавлено/);
});

test('wish status: saving first, bought folds into history and focus follows the row', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a'), wish('b', { status: 'saving', goalId: 'g1' }), wish('c', { status: 'dropped' })] });
  assert.deepEqual([...x.host.querySelectorAll('.cp-wish-rows:not(.cp-wish-rows--closed) .cp-wish-row')].map(row => row.dataset.wishId), ['b', 'a']);
  assert.match(x.host.querySelector('[data-wish-id="b"] .cp-wish-row__meta').textContent, /Цель: Накопить на ноутбук/);
  const toggle = x.host.querySelector('[data-wish-closed-toggle]');
  assert.equal(toggle.textContent, 'Показать куплено и передумал · 1'); assert.equal(x.host.querySelector('.cp-wish-rows--closed').hidden, true);
  const select = x.host.querySelector('[data-wish-status="a"]'); select.value = 'bought';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(x.data.wishes().find(item => item.id === 'a').status, 'bought');
  assert.equal(x.host.querySelector('.cp-wish-rows--closed').hidden, false);
  assert.equal(document.activeElement, x.host.querySelector('[data-wish-status="a"]'));
  assert.equal(x.host.querySelector('[data-wish-closed-toggle]').textContent, 'Скрыть куплено и передумал · 2');
  x.data.before.set('set_ui_state', () => { throw new Error('offline'); });
  const other = x.host.querySelector('[data-wish-status="b"]'); other.value = 'want';
  other.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(x.host.querySelector('[data-wish-status="b"]').value, 'saving', 'a failed write restores the shown status');
  assert.equal(x.host.querySelector('[data-wish-message]').getAttribute('role'), 'alert');
});

test('status change blocks an unseen target update before writing', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a')] });
  const select = x.host.querySelector('[data-wish-status="a"]');
  assert.equal(select.value, 'want');
  const remote = { version: 1, wishes: [wish('a', { status: 'bought', note: 'Remote purchase confirmed' })] };
  x.data.raw = JSON.stringify(remote);
  select.value = 'saving'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(x.data.writes(), 0, 'an unseen target edit is rejected before CAS');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  const message = x.host.querySelector('[data-wish-message]');
  assert.equal(message.getAttribute('role'), 'alert');
  assert.match(message.textContent, /изменено.*статус/);
});

test('ordinary status change preserves unrelated remote edits and unknown fields', async t => {
  const target = wish('a', { future: { retained: true } });
  const x = await mountList(t, { version: 1, wishes: [target, wish('b')] });
  const other = wish('b', { note: 'Remote note', future: { nested: ['kept'] } });
  x.data.raw = JSON.stringify({ version: 1, futureState: { retained: true }, wishes: [target, other] });
  const select = x.host.querySelector('[data-wish-status="a"]');
  select.value = 'saving'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(x.data.writes(), 1);
  assert.equal(x.data.wishes()[0].status, 'saving');
  assert.deepEqual(x.data.wishes()[0].future, target.future);
  assert.deepEqual(x.data.wishes()[1], normalizeWishState({ version: 1, wishes: [other] }).wishes[0]);
  assert.deepEqual(JSON.parse(x.data.raw).futureState, { retained: true });
  assert.equal(x.host.querySelector('[data-wish-message]').getAttribute('role'), 'status');
});

test('a status CAS race preserves the concurrent change and reports a status conflict', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a')] });
  const remote = { version: 1, wishes: [wish('a', { status: 'dropped', note: 'Concurrent decision' })] };
  x.data.before.set('set_ui_state', () => { x.data.raw = JSON.stringify(remote); });
  const select = x.host.querySelector('[data-wish-status="a"]');
  select.value = 'saving'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(x.data.writes(), 1, 'the single CAS attempt is rejected');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  const message = x.host.querySelector('[data-wish-message]');
  assert.equal(message.getAttribute('role'), 'alert');
  assert.match(message.textContent, /изменено.*статус/);
  assert.doesNotMatch(message.textContent, /Текст остался в форме/);
});

test('wish link opens through the native command and falls back to copying it', async t => {
  const urls = [];
  const x = await mountList(t, { version: 1, wishes: [wish('a', { url: 'https://example.com/a' })] }, { openUrl: async url => { urls.push(url); } });
  x.host.querySelector('[data-wish-link="a"]').click(); await settle();
  assert.deepEqual(urls, ['https://example.com/a']);
  x.controller.dispose();
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
  const y = await mountList(t, { version: 1, wishes: [wish('a', { url: 'https://example.com/a' })] }, { openUrl: async () => { throw new Error('open_url_unsupported'); } });
  y.host.querySelector('[data-wish-link="a"]').click(); await settle();
  assert.deepEqual(copied, ['https://example.com/a']);
  assert.match(y.host.querySelector('[data-wish-message]').textContent, /скопирована/);
});

test('wish deletion asks first and a remote change refreshes only when it may commit', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a'), wish('b')] });
  await x.menu('a', 'delete');
  const modal = document.querySelector('dialog[data-wish-delete]');
  assert.equal(x.data.writes(), 0);
  await x.submit(modal);
  assert.deepEqual(x.data.wishes().map(item => item.id), ['b']);
  assert.equal(x.host.querySelector('[data-wish-id="a"]'), null);
  x.data.raw = JSON.stringify({ version: 1, wishes: [wish('b'), wish('remote', { title: 'С телефона' })] });
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:calendar-refresh', { detail: { remoteSync: true, canCommit: () => false } })); await settle();
  assert.equal(x.host.querySelector('[data-wish-id="remote"]'), null);
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:calendar-refresh', { detail: { remoteSync: true, canCommit: () => true } })); await settle();
  assert.equal(x.host.querySelector('[data-wish-id="remote"] .cp-wish-row__title').textContent, 'С телефона');
});

test('deletion confirmation blocks an unseen target edit without writing', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a', { future: { revision: 1 } }), wish('b')] });
  await x.menu('a', 'delete');
  const modal = document.querySelector('dialog[data-wish-delete]');
  const changed = { version: 1, wishes: [wish('a', { title: 'Changed elsewhere', future: { revision: 2 } }), wish('b')] };
  x.data.raw = JSON.stringify(changed);
  await x.submit(modal);
  assert.equal(x.data.writes(), 0, 'an unseen edit is rejected before CAS');
  assert.deepEqual(JSON.parse(x.data.raw), changed);
  assert.equal(modal.isConnected, true);
  assert.match(modal.textContent, /изменено.*удален/);
});

test('deleting an unchanged target preserves an unrelated edit and unknown fields', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a'), wish('b')] });
  await x.menu('a', 'delete');
  const modal = document.querySelector('dialog[data-wish-delete]');
  const other = wish('b', { note: 'Remote note', future: { nested: ['kept'] } });
  x.data.raw = JSON.stringify({ version: 1, futureState: { retained: true }, wishes: [wish('a'), other] });
  await x.submit(modal);
  assert.equal(x.data.writes(), 1);
  assert.equal(modal.isConnected, false);
  assert.equal(x.data.wishes().length, 1);
  assert.deepEqual(x.data.wishes()[0], normalizeWishState({ version: 1, wishes: [other] }).wishes[0]);
  assert.deepEqual(JSON.parse(x.data.raw).futureState, { retained: true });
});

test('deletion CAS rejection preserves the concurrent record and shows deletion-specific feedback', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a'), wish('b')] });
  await x.menu('a', 'delete');
  const modal = document.querySelector('dialog[data-wish-delete]');
  const changed = { version: 1, wishes: [wish('a', { note: 'Concurrent edit' }), wish('b')] };
  x.data.before.set('set_ui_state', () => { x.data.raw = JSON.stringify(changed); });
  await x.submit(modal);
  assert.equal(x.data.writes(), 1, 'the single CAS attempt is rejected');
  assert.deepEqual(JSON.parse(x.data.raw), changed);
  assert.equal(modal.isConnected, true);
  assert.match(modal.textContent, /изменено.*удален/);
  assert.doesNotMatch(modal.textContent, /Текст остался в форме/);
});

test('a target removed while confirmation is open is reported without a write', async t => {
  const x = await mountList(t, { version: 1, wishes: [wish('a'), wish('b')] });
  await x.menu('a', 'delete');
  const modal = document.querySelector('dialog[data-wish-delete]');
  const changed = { version: 1, wishes: [wish('b')] };
  x.data.raw = JSON.stringify(changed);
  await x.submit(modal);
  assert.equal(x.data.writes(), 0);
  assert.deepEqual(JSON.parse(x.data.raw), changed);
  assert.equal(modal.isConnected, true);
  assert.match(modal.textContent, /уже удалено/);
});

async function conversionFixture(t, initial, goals = []) {
  let saved, creations = 0;
  const x = await mountList(t, initial, { getGoals: () => goals, convertToGoal: (_wish, done) => { saved = done; creations++; } });
  await x.menu('a', 'convert');
  assert.equal(typeof saved, 'function');
  return { ...x, finish: id => saved(id), creations: () => creations };
}

test('conversion preserves a changed goal association and retry never replaces it', async t => {
  const goals = [{ id: 'remote-goal', title: 'Remote goal' }, { id: 'local-goal', title: 'Local goal' }];
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a')] }, goals);
  const remote = { version: 1, wishes: [wish('a', { goalId: 'remote-goal' })] };
  x.data.raw = JSON.stringify(remote);
  await x.finish('local-goal'); await settle();
  assert.equal(x.data.writes(), 0, 'an unseen association is rejected before CAS');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  assert.equal(x.host.querySelector('[data-wish-message]').getAttribute('role'), 'alert');
  assert.match(x.host.querySelector('[data-wish-message]').textContent, /Связь.*не подтверждена/);
  x.host.querySelector('[data-wish-convert-retry]').click(); await settle();
  assert.equal(x.data.writes(), 0, 'pending retry retains the original reviewed association');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  assert.deepEqual(goals.map(g => g.id), ['remote-goal', 'local-goal']);
  assert.equal(x.creations(), 1);
});

test('ordinary conversion links the acknowledged goal exactly once', async t => {
  const goals = [{ id: 'new-goal', title: 'New goal' }];
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a')] }, goals);
  await x.finish('new-goal'); await settle();
  assert.equal(x.data.writes(), 1);
  assert.equal(x.data.wishes()[0].goalId, 'new-goal');
  assert.equal(x.data.wishes()[0].title, wish('a').title);
  assert.equal(x.host.querySelector('[data-wish-convert-retry]'), null);
  assert.match(x.host.textContent, /Цель: New goal/);
  assert.equal(x.creations(), 1); assert.equal(goals.length, 1);
});

test('conversion preserves unrelated wish edits and unknown fields', async t => {
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a'), wish('b')] });
  const target = wish('a', { note: 'Remote note', future: { retained: true } });
  const other = wish('b', { status: 'bought', future: ['kept'] });
  x.data.raw = JSON.stringify({ version: 1, futureState: { retained: true }, wishes: [target, other] });
  await x.finish('new-goal'); await settle();
  assert.equal(x.data.writes(), 1);
  const stored = x.data.wishes();
  assert.equal(stored[0].goalId, 'new-goal'); assert.equal(stored[0].note, target.note);
  assert.deepEqual(stored[0].future, target.future);
  assert.deepEqual(stored[1], normalizeWishState({ version: 1, wishes: [other] }).wishes[0]);
  assert.deepEqual(JSON.parse(x.data.raw).futureState, { retained: true });
});

test('same-goal retry after a lost write acknowledgement is read-only and keeps timestamps', async t => {
  const goals = [{ id: 'new-goal', title: 'New goal' }];
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a')] }, goals);
  x.data.before.set('set_ui_state', args => { x.data.raw = args.value; throw Error('synthetic lost acknowledgement'); });
  await x.finish('new-goal'); await settle();
  const committed = x.data.raw;
  assert.equal(x.data.wishes()[0].goalId, 'new-goal');
  assert.equal(x.data.writes(), 1);
  x.data.before.delete('set_ui_state');
  x.host.querySelector('[data-wish-convert-retry]').click(); await settle();
  assert.equal(x.data.raw, committed, 'retry does not rewrite convertedAt or updatedAt');
  assert.equal(x.data.writes(), 1, 'same link needs no second CAS');
  assert.equal(x.host.querySelector('[data-wish-convert-retry]'), null);
  assert.equal(x.creations(), 1); assert.equal(goals.length, 1);
});

test('conversion CAS race preserves both goals and retry cannot replace the raced link', async t => {
  const goals = [{ id: 'remote-goal', title: 'Remote goal' }, { id: 'local-goal', title: 'Local goal' }];
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a')] }, goals);
  const remote = { version: 1, wishes: [wish('a', { goalId: 'remote-goal', future: { retained: true } })] };
  x.data.before.set('set_ui_state', () => { x.data.raw = JSON.stringify(remote); });
  await x.finish('local-goal'); await settle();
  assert.equal(x.data.writes(), 1, 'single CAS attempt is rejected');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  assert.match(x.host.querySelector('[data-wish-message]').textContent, /Связь.*не подтверждена/);
  x.data.before.delete('set_ui_state');
  x.host.querySelector('[data-wish-convert-retry]').click(); await settle();
  assert.equal(x.data.writes(), 1, 'retry still checks the original association');
  assert.deepEqual(JSON.parse(x.data.raw), remote);
  assert.deepEqual(goals.map(g => g.id), ['remote-goal', 'local-goal']);
  assert.equal(x.creations(), 1);
});

test('a deleted linked goal can be intentionally replaced from the reviewed association', async t => {
  const goals = [];
  const x = await conversionFixture(t, { version: 1, wishes: [wish('a', { goalId: 'deleted-goal' })] }, goals);
  goals.push({ id: 'replacement-goal', title: 'Replacement goal' });
  await x.finish('replacement-goal'); await settle();
  assert.equal(x.data.writes(), 1); assert.equal(x.data.wishes()[0].goalId, 'replacement-goal');
  assert.equal(x.host.querySelector('[data-wish-convert-retry]'), null);
  assert.equal(x.creations(), 1); assert.equal(goals.length, 1);
});

test('a wish saved by another Create surface appears in the open list', async t => {
  const x = await mountList(t, null);
  await createWish({ title: 'Из общей кнопки Создать', category: 'experience' }, { invoke: x.data.invoke });
  await settle();
  assert.match(x.host.querySelector('.cp-wish-row__title').textContent, /Из общей кнопки Создать/);
  assert.match(x.host.querySelector('.cp-wish-row__meta').textContent, /Опыт/);
});

test('an unsupported stored format is reported and never overwritten', async t => {
  const x = await mountList(t, { version: 9, wishes: [] });
  assert.match(x.host.querySelector('[data-wish-message]').textContent, /Неподдерживаемый формат желаний/);
  assert.equal(x.host.querySelector('[data-wish-retry]').hidden, false);
  await assert.rejects(createWish({ title: 'Новое' }, { invoke: x.data.invoke }), /Неподдерживаемый/);
  assert.equal(x.data.writes(), 0);
});
