/** Read existing descriptions without interpreting markup as executable UI. */
export function taskDescription(record, document) {
  // Only EditorJS text fields have an inline-markup contract. Unknown tags are
  // literal text (including <TaskId>), never inferred to be disposable markup.
  const rich = value => {
    if (typeof value !== 'string') return '';
    const inline = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'mark', 'code', 'a', 'span']);
    const text = value.replace(/<\/?([a-z][a-z0-9_-]*)\b[^>]*>/gi, (token, tag) => {
      if (tag.toLowerCase() === 'br') return '\n';
      return inline.has(tag.toLowerCase()) ? '' : token;
    });
    // Decode entities in an inert text element; literal tags remain escaped.
    const decoder = document.createElement('textarea');
    decoder.innerHTML = text.replace(/</g, '&lt;');
    return decoder.value.trim();
  };
  for (const key of ['short_description', 'description', 'content']) {
    const value = record?.[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (key === 'content' && Array.isArray(parsed?.blocks)) {
        const text = parsed.blocks.map(block => rich(block?.data?.text ?? block?.data?.caption)).filter(Boolean).join('\n');
        if (text) return text;
        continue;
      }
    } catch { /* An unstructured field is literal text, not inferred HTML. */ }
    const text = value.trim();
    if (text) return text;
  }
  return '';
}
