// ── icons.js — Shared minimalist SVG icons for toolbars/buttons ──
// All icons: 16x16, stroke 1.5, currentColor. Match the filter SVG in tab-food-recipes.js.

const SVG_ATTRS = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  calendar: `<svg ${SVG_ATTRS}><rect x="2" y="3.5" width="12" height="10.5" rx="2"/><path d="M5 2v3M11 2v3M2 7h12"/></svg>`,
  target: `<svg ${SVG_ATTRS}><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".75" fill="currentColor" stroke="none"/></svg>`,
  play: `<svg ${SVG_ATTRS}><path d="m5 3 8 5-8 5Z"/></svg>`,
  pause: `<svg ${SVG_ATTRS}><path d="M5.5 3v10M10.5 3v10"/></svg>`,
  check: `<svg ${SVG_ATTRS}><path d="m3 8 3.5 3.5L13 5"/></svg>`,
  switch: `<svg ${SVG_ATTRS}><path d="M2.5 5h11m-3-3 3 3-3 3M13.5 11h-11m3-3-3 3 3 3"/></svg>`,
  cycle: `<svg ${SVG_ATTRS}><path d="M13.5 6A5.6 5.6 0 0 0 4 3.7L2.5 5M2.5 1.5V5H6M2.5 10A5.6 5.6 0 0 0 12 12.3l1.5-1.3M10 11h3.5v3.5"/></svg>`,
  arrowRight: `<svg ${SVG_ATTRS}><path d="M2.5 8h11m-5-5 5 5-5 5"/></svg>`,
  chevronLeft: `<svg ${SVG_ATTRS}><path d="m10 3-5 5 5 5"/></svg>`,
  chevronRight: `<svg ${SVG_ATTRS}><path d="m6 3 5 5-5 5"/></svg>`,
  list: `<svg ${SVG_ATTRS}><path d="M6 4h7M6 8h7M6 12h7M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>`,
  share: `<svg ${SVG_ATTRS}><circle cx="12" cy="3.5" r="1.75"/><circle cx="4" cy="8" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/><path d="M5.5 7.1l5-2.7M5.5 8.9l5 2.7"/></svg>`,
  ban: `<svg ${SVG_ATTRS}><circle cx="8" cy="8" r="6"/><path d="M3.8 3.8l8.4 8.4"/></svg>`,
};

// Larger empty-state glyphs (Lucide-derived, 24 grid). Sized via CSS (.hanni-empty-icon svg).
const SVG24 = 'width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
export const EMPTY_ICONS = {
  utensils: `<svg ${SVG24}><path d="M7 2v7a2 2 0 0 0 4 0V2"/><path d="M9 9v13"/><path d="M17 2c-1.7 0-3 2.2-3 5s1.3 5 3 5"/><path d="M17 12v10"/></svg>`,
  box: `<svg ${SVG24}><path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`,
  searchX: `<svg ${SVG24}><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/><path d="m9 9 4 4"/><path d="m13 9-4 4"/></svg>`,
  clipboard: `<svg ${SVG24}><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>`,
};
