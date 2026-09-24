// Wishes (#85): purchases, trips and experiences kept apart from goals — one
// action, no plan. No DOM imports, so any Create surface can save a wish.
//
// Storage: the SQLite ui_state key below. It is one of the relayed UI keys in
// mvp_sync_db.rs, where every wish is its own sync record keyed by its id, so
// devices merge independent edits. Every write here is read → change →
// compare-and-swap; a concurrent change on another device fails with a clear
// message instead of being overwritten.
export const WISHES_STATE_KEY = 'calendar_wishes_v1';
const VERSION = 1;
export const WISH_CATEGORIES = Object.freeze([['clothes', 'Одежда'], ['tech', 'Техника'], ['home', 'Дом'], ['travel', 'Поездки'], ['experience', 'Опыт'], ['other', 'Другое']]);
export const WISH_STATUSES = Object.freeze([['want', 'Хочу'], ['saving', 'Коплю'], ['bought', 'Куплено'], ['dropped', 'Передумал']]);
export const WISH_CURRENCIES = Object.freeze([['KZT', '₸'], ['USD', '$'], ['EUR', '€'], ['RUB', '₽']]);
export const WISH_LIMITS = Object.freeze({ title: 200, url: 2000, note: 2000, price: 1e12, id: 128 });
export const wishCategoryLabel = id => CATEGORY.get(id) || CATEGORY.get('other');
export const wishStatusLabel = id => STATUS.get(id) || STATUS.get('want');
/** Wishes still in play; bought and dropped ones are kept as history. */
export const isOpenWish = wish => wish.status === 'want' || wish.status === 'saving';
const CATEGORY = new Map(WISH_CATEGORIES), STATUS = new Map(WISH_STATUSES), CURRENCY = new Map(WISH_CURRENCIES);
let writeQueue = Promise.resolve();

const text = value => String(value ?? '').trim();
const uid = () => globalThis.crypto?.randomUUID?.() || `wish-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class WishValidationError extends Error {
  constructor(field, message) { super(message); this.name = 'WishValidationError'; this.field = field; }
}

/** http(s) only; returns the normalized URL or '' for an empty value. */
export function normalizeWishUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.length > WISH_LIMITS.url) throw new WishValidationError('url', `Сократи ссылку до ${WISH_LIMITS.url} символов.`);
  let url;
  try { url = new URL(raw); } catch { throw new WishValidationError('url', 'Ссылка должна начинаться с http:// или https://.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WishValidationError('url', 'Можно сохранить только ссылку http:// или https://.');
  if (!url.hostname) throw new WishValidationError('url', 'В ссылке не хватает адреса сайта.');
  if (url.href.length > WISH_LIMITS.url) throw new WishValidationError('url', `Сократи ссылку до ${WISH_LIMITS.url} символов.`);
  return url.href;
}

/**
 * Validates user input for create and edit. Only the title is required; a
 * blank price is null (no price), the currency defaults to ₸ and the status to
 * «Хочу». Throws WishValidationError with the offending `field`.
 */
export function validateWishInput(input = {}) {
  const title = text(input.title);
  if (!title) throw new WishValidationError('title', 'Напиши, чего хочется.');
  if (title.length > WISH_LIMITS.title) throw new WishValidationError('title', `Сократи название до ${WISH_LIMITS.title} символов.`);
  const category = CATEGORY.has(input.category) ? input.category : 'other';
  let price = null;
  const rawPrice = typeof input.price === 'string' ? input.price.trim().replace(/\s/g, '').replace(',', '.') : input.price;
  if (rawPrice !== '' && rawPrice != null) {
    price = typeof rawPrice === 'number' ? rawPrice : /^\d+(\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
    if (!Number.isFinite(price) || price < 0) throw new WishValidationError('price', 'Цена — число от нуля. Или оставь поле пустым.');
    if (price > WISH_LIMITS.price) throw new WishValidationError('price', 'Цена слишком большая.');
    price = Math.round(price * 100) / 100;
  }
  const currency = CURRENCY.has(input.currency) ? input.currency : 'KZT';
  const url = normalizeWishUrl(input.url);
  const note = text(input.note);
  if (note.length > WISH_LIMITS.note) throw new WishValidationError('note', `Сократи заметку до ${WISH_LIMITS.note} символов.`);
  const status = STATUS.has(input.status) ? input.status : 'want';
  return { title, category, price, currency, url, note, status };
}

export function emptyWishState() { return { version: VERSION, wishes: [] }; }

/** Keeps unknown fields of each wish so an older client never erases newer data. */
export function normalizeWishState(raw) {
  if (raw == null || raw === '') return emptyWishState();
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object' || source.version !== VERSION || !Array.isArray(source.wishes)) throw new Error('Неподдерживаемый формат желаний. Сохранение остановлено, чтобы не потерять данные.');
  const seen = new Set();
  const wishes = source.wishes.flatMap(wish => {
    const id = typeof wish?.id === 'string' ? wish.id.trim() : '', title = text(wish?.title);
    if (!id || id.length > WISH_LIMITS.id || !title || seen.has(id)) return [];
    seen.add(id);
    let url = '';
    try { url = normalizeWishUrl(wish.url); } catch { url = ''; }
    const price = wish.price == null || wish.price === '' ? null : Number(wish.price);
    return [{ ...wish, id, title: title.slice(0, WISH_LIMITS.title), category: CATEGORY.has(wish.category) ? wish.category : 'other',
      price: Number.isFinite(price) && price >= 0 && price <= WISH_LIMITS.price ? price : null, currency: CURRENCY.has(wish.currency) ? wish.currency : 'KZT',
      url, note: text(wish.note).slice(0, WISH_LIMITS.note), status: STATUS.has(wish.status) ? wish.status : 'want',
      goalId: wish.goalId == null || wish.goalId === '' ? null : String(wish.goalId), createdAt: text(wish.createdAt), updatedAt: text(wish.updatedAt) }];
  });
  return { ...source, version: VERSION, wishes };
}

export const WISH_STALE_MESSAGE = 'Желания изменены на другом устройстве. Текст остался в форме — открой желание заново и повтори.';
const errorText = cause => typeof cause === 'string' ? cause : cause?.message;

/** Serialized read → change → CAS write. `change` may return a value for the caller. */
export async function mutateWishes(invoke, change) {
  if (typeof invoke !== 'function') throw new Error('Не хватает native API.');
  const work = writeQueue.catch(() => {}).then(async () => {
    const raw = await invoke('get_ui_state', { key: WISHES_STATE_KEY });
    const next = structuredClone(normalizeWishState(raw));
    const result = change(next);
    const normalized = normalizeWishState(next);
    try { await invoke('set_ui_state', { key: WISHES_STATE_KEY, value: JSON.stringify(normalized), expectedValue: raw ?? '' }); }
    catch (cause) { if (errorText(cause) === 'mvp_sync_stale_ui_state') throw new Error(WISH_STALE_MESSAGE); throw cause; }
    globalThis.window?.dispatchEvent(new globalThis.window.CustomEvent('hanni:wishes-changed'));
    return { state: normalized, result };
  });
  writeQueue = work;
  return work;
}

export async function readWishes(invoke) { return normalizeWishState(await invoke('get_ui_state', { key: WISHES_STATE_KEY })).wishes; }

const missing = () => new Error('Это желание уже удалено на другом устройстве.');
const assertUnchanged = (current, original) => {
  if (!current) throw missing();
  if (original && JSON.stringify(current) !== JSON.stringify(original)) throw new Error('Это желание изменено на другом устройстве. Текст остался в форме — открой желание заново перед сохранением.');
};

/**
 * Public entry point for any Create surface (the shared «＋ Создать» of #97):
 * validates, then appends one wish and notifies open lists with the window
 * event `hanni:wishes-changed`. Validation fails before any native call with a
 * WishValidationError whose `field` is 'title', 'price', 'url' or 'note'.
 *   await createWish({ title, category, price, currency, url, note, status }, { invoke })
 */
export async function createWish(input, { invoke, now = () => new Date() } = {}) {
  const value = validateWishInput(input);
  const stamp = now().toISOString();
  const wish = { id: uid(), ...value, goalId: null, createdAt: stamp, updatedAt: stamp };
  await mutateWishes(invoke, state => { state.wishes.push(wish); });
  return wish;
}
export async function updateWish(id, input, { invoke, original = null, now = () => new Date() } = {}) {
  const value = validateWishInput(input);
  const { result } = await mutateWishes(invoke, state => {
    const at = state.wishes.findIndex(wish => wish.id === String(id));
    assertUnchanged(state.wishes[at], original);
    state.wishes[at] = { ...state.wishes[at], ...value, updatedAt: now().toISOString() };
    return state.wishes[at];
  });
  return result;
}
export async function setWishStatus(id, status, { invoke, now = () => new Date() } = {}) {
  if (!STATUS.has(status)) throw new Error('Неизвестный статус желания.');
  const { result } = await mutateWishes(invoke, state => {
    const wish = state.wishes.find(item => item.id === String(id));
    if (!wish) throw missing();
    wish.status = status; wish.updatedAt = now().toISOString(); return wish;
  });
  return result;
}
export async function deleteWish(id, { invoke } = {}) {
  await mutateWishes(invoke, state => { state.wishes = state.wishes.filter(wish => wish.id !== String(id)); });
}
/** Records the goal created from a wish; the wish itself stays as the source. */
export async function markWishConverted(id, goalId, { invoke, now = () => new Date() } = {}) {
  if (goalId == null || goalId === '') throw new Error('Не хватает созданной цели.');
  const { result } = await mutateWishes(invoke, state => {
    const wish = state.wishes.find(item => item.id === String(id));
    if (!wish) throw missing();
    wish.goalId = String(goalId); wish.convertedAt = now().toISOString(); wish.updatedAt = wish.convertedAt; return wish;
  });
  return result;
}

export const wishPriceLabel = wish => wish.price == null ? '' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(wish.price)} ${CURRENCY.get(wish.currency) || '₸'}`;
/**
 * Goal draft for «Превратить в цель». The note and link go to the description;
 * a price becomes the numeric target (saving up), which the editor shows
 * before anything is saved.
 */
export function wishGoalDraft(wish) {
  const lines = [wish.note, wish.url ? `Ссылка: ${wish.url}` : ''].filter(Boolean);
  const draft = { title: wish.title.slice(0, 500), description: lines.join('\n').slice(0, 10000) };
  if (wish.price > 0) Object.assign(draft, { targetValue: wish.price, unit: CURRENCY.get(wish.currency) || '₸' });
  return draft;
}
