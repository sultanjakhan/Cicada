// ── js/emoji-picker.js — Notion-style emoji picker (singleton) ──

import { EMOJI_CATEGORIES } from './emoji-data.js';

const RECENT_KEY = 'hanni_recent_emojis';
const MAX_RECENT = 20;

let pickerEl = null;
let overlayEl = null;
let currentCallback = null;

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function addRecent(emoji) {
  const list = getRecent().filter(e => e !== emoji);
  list.unshift(emoji);
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function buildHTML() {
  const cats = EMOJI_CATEGORIES.filter(c => c.id !== 'recent');
  const catBtns = cats.map(c =>
    `<button class="emoji-cat-btn" data-cat="${c.id}" title="${c.label}">${c.icon}</button>`
  ).join('');
  const sections = cats.map(c =>
    `<div id="emoji-sec-${c.id}"><div class="emoji-section-label">${c.label}</div>` +
    `<div class="emoji-section-grid">${c.emojis.map(em =>
      `<button class="emoji-pick-btn" data-name="${em.n}">${em.e}</button>`
    ).join('')}</div></div>`
  ).join('');

  return `<div class="emoji-picker-search"><input type="text" placeholder="Поиск эмодзи..."></div>
    <div class="emoji-picker-cats"><button class="emoji-cat-btn" data-cat="recent" title="Недавние">🕐</button>${catBtns}</div>
    <div class="emoji-picker-grid">
      <div id="emoji-sec-recent" class="hidden"><div class="emoji-section-label">Недавние</div>
        <div class="emoji-section-grid" id="emoji-recent-grid"></div></div>
      ${sections}
    </div>`;
}

function createPicker() {
  overlayEl = document.createElement('div');
  overlayEl.className = 'emoji-picker-overlay';
  overlayEl.addEventListener('click', hideEmojiPicker);

  pickerEl = document.createElement('div');
  pickerEl.className = 'emoji-picker';
  pickerEl.addEventListener('mousedown', (e) => e.stopPropagation());
  pickerEl.addEventListener('click', (e) => e.stopPropagation());
  pickerEl.innerHTML = buildHTML();

  // Category navigation
  pickerEl.querySelectorAll('.emoji-cat-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sec = document.getElementById(`emoji-sec-${btn.dataset.cat}`);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pickerEl.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Emoji selection
  pickerEl.querySelector('.emoji-picker-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-pick-btn');
    if (!btn) return;
    e.stopPropagation();
    const emoji = btn.textContent;
    addRecent(emoji);
    if (currentCallback) currentCallback(emoji);
    hideEmojiPicker();
  });

  // Search
  const input = pickerEl.querySelector('.emoji-picker-search input');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    const grid = pickerEl.querySelector('.emoji-picker-grid');
    const sections = grid.querySelectorAll('[id^="emoji-sec-"]');
    if (!q) {
      sections.forEach(s => { s.classList.remove('hidden'); s.querySelectorAll('.emoji-pick-btn').forEach(b => b.classList.remove('hidden')); });
      return;
    }
    sections.forEach(sec => {
      if (sec.id === 'emoji-sec-recent') { sec.classList.add('hidden'); return; }
      const btns = sec.querySelectorAll('.emoji-pick-btn');
      let visible = 0;
      btns.forEach(b => {
        const match = (b.dataset.name || '').includes(q) || b.textContent.includes(q);
        b.classList.toggle('hidden', !match);
        if (match) visible++;
      });
      sec.classList.toggle('hidden', visible === 0);
    });
  });

  // Escape to close
  pickerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideEmojiPicker();
  });

  overlayEl.appendChild(pickerEl);
  document.body.appendChild(overlayEl);
}

function populateRecent() {
  const recent = getRecent();
  const sec = document.getElementById('emoji-sec-recent');
  const grid = document.getElementById('emoji-recent-grid');
  if (!sec || !grid) return;
  if (!recent.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  grid.innerHTML = recent.map(e => `<button class="emoji-pick-btn">${e}</button>`).join('');
}

export function showEmojiPicker(anchorEl, onSelect) {
  if (!pickerEl) createPicker();
  currentCallback = onSelect;
  populateRecent();

  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;

  // Viewport clamp
  if (top + 380 > window.innerHeight) top = rect.top - 384;
  if (left + 320 > window.innerWidth) left = window.innerWidth - 324;
  if (top < 4) top = 4;
  if (left < 4) left = 4;

  pickerEl.style.top = `${top}px`;
  pickerEl.style.left = `${left}px`;

  overlayEl.classList.remove('hidden');
  pickerEl.classList.remove('hidden');

  // Reset search and focus
  const input = pickerEl.querySelector('.emoji-picker-search input');
  input.value = '';
  input.dispatchEvent(new Event('input'));
  setTimeout(() => input.focus(), 50);
}

export function hideEmojiPicker() {
  if (overlayEl) overlayEl.classList.add('hidden');
  if (pickerEl) pickerEl.classList.add('hidden');
  currentCallback = null;
}