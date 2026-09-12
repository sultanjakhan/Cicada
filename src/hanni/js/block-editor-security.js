// EditorJS does not sanitize initial tool data before rendering. Clean the HTML
// fields of the MVP's configured tools at both the display and save boundaries.
const INLINE_HTML = Object.freeze({
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'br', 'a', 'code', 'mark'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
});

function escapeText(value) {
  return value.replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function sanitizeBlockEditorData(value, purifier) {
  if (!Array.isArray(value?.blocks)) return value;
  const html = text => typeof text !== 'string' ? text :
    purifier?.sanitize ? purifier.sanitize(text, INLINE_HTML) : escapeText(text);
  const listItems = items => Array.isArray(items) ? items.map(item => {
    if (typeof item === 'string') return html(item); // Older EditorJS list data.
    if (!item || typeof item !== 'object') return item;
    return { ...item,
      ...(Object.hasOwn(item, 'content') ? { content: html(item.content) } : {}),
      ...(Object.hasOwn(item, 'text') ? { text: html(item.text) } : {}), // Legacy checklist-as-list.
      ...(Array.isArray(item.items) ? { items: listItems(item.items) } : {}) };
  }) : items;

  return { ...value, blocks: value.blocks.map(block => {
    if (!block?.data || typeof block.data !== 'object') return block;
    const data = { ...block.data };
    switch (block.type) {
      case 'paragraph': case 'header': data.text = html(data.text); break;
      case 'quote': data.text = html(data.text); data.caption = html(data.caption); break;
      case 'checklist':
        if (Array.isArray(data.items)) data.items = data.items.map(item =>
          item && typeof item === 'object' ? { ...item, text: html(item.text) } : item);
        break;
      case 'list': data.items = listItems(data.items); break;
      // Code is rendered as literal textarea content, not HTML. Preserve it and
      // all non-HTML metadata. New HTML-bearing tools need their own rule here.
    }
    return { ...block, data };
  }) };
}
