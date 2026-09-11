// Pure, testable security boundary for HTML produced by Marked.
export const MARKDOWN_SANITIZE_CONFIG = Object.freeze({
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li',
    'pre', 'code', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table',
    'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'button'],
  ALLOWED_ATTR: ['class', 'href', 'title', 'type', 'aria-label', 'data-href',
    'data-node-id', 'data-node-name'],
  ALLOW_DATA_ATTR: false,
});

function escapeText(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function sanitizeMarkdownHtml(html, sourceFallback = '', purifier = globalThis.DOMPurify) {
  if (!purifier || typeof purifier.sanitize !== 'function') return escapeText(sourceFallback);
  return purifier.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
}