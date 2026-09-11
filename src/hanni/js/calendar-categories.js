// calendar-categories.js — data layer for DB-managed calendar event categories.
// Shared by calendar-event-modal.js and calendar-category-manager.js.

import { invoke } from '../../state.js';

// Quick-pick palette for the color swatches (mirrors the seed colors).
export const CATEGORY_PALETTE = [
  '#2383e2', '#9065b0', '#448361', '#d9730d',
  '#cb8a05', '#c14c8a', '#d44c47', '#9B9B9B',
];

let _catsCache = null;

export async function loadCategories(force = false) {
  if (force || !_catsCache) {
    _catsCache = await invoke('list_event_categories').catch(() => []);
  }
  return _catsCache || [];
}

export function invalidateCategoriesCache() { _catsCache = null; }