'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = name => fs.readFileSync(path.resolve(__dirname, '../src/hanni/js', name + '.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let sequence = 0;
async function setup(t, { realEditor = false } = {}) {
  const dom = new JSDOM('<main></main><button id="outside">Вне</button>', { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window, root = w.document.querySelector('main');
  const vendor = name => fs.readFileSync(path.resolve(__dirname, '../src/public/vendor', name + '.min.js'), 'utf8');
  w.eval(vendor('purify'));
  if (realEditor) {
    Object.defineProperties(w, { crypto: { value: require('node:crypto').webcrypto }, structuredClone: { value: structuredClone } });
    const observer = class { observe() {} unobserve() {} disconnect() {} };
    Object.assign(w, { ResizeObserver: observer, IntersectionObserver: observer,
      matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    w.document.execCommand = () => false; w.document.queryCommandState = () => false;
    for (const name of ['editorjs', 'header', 'list', 'checklist', 'quote', 'code', 'delimiter', 'marker', 'inline-code']) w.eval(vendor(name));
    // Execute the actual app factory and its tool configuration, without importing unrelated browser globals.
    const utils = read('utils'), start = utils.indexOf('export function initBlockEditor('), end = utils.indexOf('// ── Tab block editor', start);
    assert.ok(start >= 0 && end > start);
    w.eval(utils.slice(start, end).replace('export function', 'function') + '; window.createActualEditor = initBlockEditor;');
  }
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('button')?.focus(); };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const source = read('calendar-notes').replace(/^import .*state\.js';\r?$/m, 'const defaultInvoke = () => { throw new Error("Inject API"); };')
    .replace(/^import .*utils\.js';\r?$/m, 'const initBlockEditor = () => {}; const escapeHtml = value => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); const blocksToPlainText = value => (value?.blocks || []).map(b => b.data.text || b.data.code || "").join("\\n");')
    .replace("'./calendar-dialog.js'", JSON.stringify(data(read('calendar-dialog'))))
    .replace("'./block-editor-security.js'", () => JSON.stringify(data(read('block-editor-security'))));
  const module = await import(data(source) + '#' + sequence++);
  const rows = [
    { id: 1, title: 'Plain', content: 'Исходный текст', tab_name: 'calendar', status: 'note', tags: 'tag,keep', pinned: true, priority: 4, due_date: '2027-01-01', reminder_at: 'later', archived: false, updated_at: '2026-09-06T13:00:00.000000100+05:00' },
    { id: 2, title: 'Rich', content: 'Rich original', tab_name: 'calendar', status: 'note', tags: 'rich,keep', archived: false, updated_at: 'rich-v1', content_blocks: JSON.stringify({ time: 10, version: '2.31', blocks: [{ type: 'paragraph', data: { text: 'Rich original' } }, { type: 'code', data: { code: 'const x = 1;' } }] }) },
    { id: 3, title: 'Invalid', content: 'Readonly fallback', tab_name: 'calendar', status: 'note', updated_at: 'bad-v1', content_blocks: '{invalid' },
    { id: 4, title: 'Archived', content: 'Архив', tab_name: 'calendar', status: 'note', archived: true, updated_at: 'archive-v1' },
    { id: 5, title: 'Other', content: 'Не в календаре', tab_name: 'other', status: 'note', updated_at: 'other-v1' },
  ];
  const before = new Map(), calls = [], editors = []; let editorFailure = false, version = 0;
  const invoke = async (name, args) => {
    calls.push({ name, args: structuredClone(args) }); if (before.has(name)) await before.get(name)(args);
    if (name === 'get_notes') return structuredClone(rows);
    if (name === 'get_note') { const row = rows.find(row => String(row.id) === String(args.id)); if (!row) throw new Error('missing'); return structuredClone(row); }
    if (name === 'create_note') { const id = 100 + rows.length; rows.push({ id, title: args.title, content: args.content, tags: args.tags, tab_name: args.tabName, status: args.status, updated_at: 'created' }); return id; }
    if (name === 'update_note') {
      const row = rows.find(row => String(row.id) === String(args.id)); Object.assign(row, { title: args.title, content: args.content, tags: args.tags, updated_at: 'saved' + ++version });
      if (args.contentBlocks != null) row.content_blocks = args.contentBlocks; return;
    }
    if (name === 'toggle_note_archive') { const row = rows.find(row => String(row.id) === String(args.id)); row.archived = !row.archived; row.updated_at = 'archive' + ++version; return row.archived; }
    throw new Error('Unexpected IPC ' + name);
  };
  const createEditor = (id, output, onChange, options) => {
    if (editorFailure) throw new Error('Editor unavailable');
    if (realEditor) {
      const editor = w.createActualEditor(id, output, onChange, options);
      editors.push(editor); return editor;
    }
    const holder = w.document.getElementById(id);
    holder.innerHTML = '<div contenteditable="true"></div>';
    const instance = { output: structuredClone(output), isReady: Promise.resolve(), destroyed: false, hold: null, fail: false, options,
      async save() { if (this.hold) await this.hold.promise; if (this.fail) throw new Error('Capture unavailable'); return { ...structuredClone(this.output), time: Date.now(), version: 'new-editor' }; },
      destroy() { this.destroyed = true; },
      type(text, notify = false) { this.output.blocks[0].data.text = text; holder.firstElementChild.textContent = text; holder.firstElementChild.dispatchEvent(new w.Event('input', { bubbles: true })); if (notify) onChange(this.output); },
    };
    editors.push(instance); return instance;
  };
  let dispose = await module.mountCalendarNotes(root, { invoke, initBlockEditor: createEditor });
  t.after(async () => { dispose(); await tick(); dom.window.close(); });
  const open = async (id = null) => { if (id === 4) root.querySelector('[data-filter="archive"]').click(); else root.querySelector('[data-filter="active"]').click(); root.querySelector(id == null ? '[data-new]' : `[data-note-id="${id}"]`).click(); await tick(); return w.document.querySelector('dialog[open][data-note-editor]'); };
  const set = (modal, name, value) => { const input = modal.querySelector(`[name="${name}"]`); input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const save = async modal => { modal.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await tick(); };
  const close = async modal => { modal.dispatchEvent(new w.Event('cancel', { cancelable: true })); await tick(); };
  const remount = async () => { dispose(); root.replaceChildren(); dispose = await module.mountCalendarNotes(root, { invoke, initBlockEditor: createEditor }); await tick(); };
  return { w, root, rows, before, calls, editors, open, set, save, close, remount, dispose: () => dispose(), failEditor: () => { editorFailure = true; } };
}

const hostileInline = '<b>Keep formatting</b><img src="x" onerror="window.__noteXss=1"><a href="javascript:alert(1)">js</a><a href="data:text/html,unsafe">data</a><a href="file:///example">file</a><a href="https://example.com/path">safe</a>';
const hostileBlocks = () => ({ time: 10, version: 'fixture', blocks: [
  { id: 'paragraph', type: 'paragraph', data: { text: hostileInline } },
  { id: 'header', type: 'header', data: { text: hostileInline, level: 2 } },
  { id: 'checklist', type: 'checklist', data: { items: [{ text: hostileInline, checked: true }] } },
  { id: 'quote', type: 'quote', data: { text: hostileInline, caption: hostileInline, alignment: 'left' } },
  { id: 'list', type: 'list', data: { style: 'unordered', items: [{ content: hostileInline, meta: {}, items: [{ content: hostileInline, meta: {}, items: [] }] }] } },
  { id: 'legacy-checklist', type: 'list', data: { style: 'checklist', items: [{ text: hostileInline, checked: false }] } },
  { id: 'legacy-list', type: 'list', data: { style: 'unordered', items: [hostileInline] } },
  { id: 'code', type: 'code', data: { code: '<script>literal example</script>' } },
] });
function assertSafeNoteDom(element) {
  // List/checklist tools use their own SVG controls; those are not user markup.
  assert.equal(element.querySelectorAll('img,script,iframe,object').length, 0);
  for (const node of element.querySelectorAll('*')) {
    assert.ok(![...node.attributes].some(attr => /^on/i.test(attr.name)), 'inline event handlers must be removed');
    if (node.hasAttribute('href')) assert.ok(!/^(?:javascript|data|file):/i.test(node.getAttribute('href')), 'unsafe URL scheme');
  }
}
test('security: stored rich blocks are safe before actual EditorJS renders them', async t => {
  const x = await setup(t, { realEditor: true });
  x.rows[1].content_blocks = JSON.stringify(hostileBlocks());
  const original = x.rows[1].content_blocks, modal = await x.open(2);
  await x.editors.at(-1).isReady; await tick();
  const renderedBlocks = modal.querySelectorAll('.ce-block__content');
  assert.equal(renderedBlocks.length, hostileBlocks().blocks.length);
  for (const block of renderedBlocks) assertSafeNoteDom(block);
  assert.ok(modal.querySelector('.calendar-note-blocks b'));
  assert.ok(modal.querySelector('.calendar-note-blocks a[href="https://example.com/path"]'));
  assert.equal(x.rows[1].content_blocks, original, 'opening a note must not write to storage');
  assert.equal(x.calls.some(call => call.name === 'update_note'), false);
  await x.save(modal); await tick();
  assert.ok(x.calls.some(call => call.name === 'update_note'), 'actual EditorJS output must save through the Notes flow');
  const reopened = await x.open(2); await x.editors.at(-1).isReady; await tick();
  for (const block of reopened.querySelectorAll('.ce-block__content')) assertSafeNoteDom(block);
});
test('security: rich editor output is cleaned again before storage and preserves code and metadata', async t => {
  const x = await setup(t), modal = await x.open(2), input = hostileBlocks();
  x.editors.at(-1).output = structuredClone(input);
  await x.save(modal);
  const saved = JSON.parse(x.rows[1].content_blocks);
  const fields = saved.blocks.flatMap(block => block.type === 'code' ? [] : [block.data.text, block.data.caption,
    ...(block.data.items || []).flatMap(item => [typeof item === 'string' ? item : item.text || item.content, ...(item.items || []).map(child => child.content)])]).filter(Boolean);
  const holder = x.w.document.createElement('div'); holder.innerHTML = fields.join(''); assertSafeNoteDom(holder);
  assert.deepEqual(saved.blocks.find(block => block.type === 'code'), input.blocks.find(block => block.type === 'code'));
  assert.equal(saved.blocks.find(block => block.type === 'checklist').data.items[0].checked, true);
  assert.equal(saved.blocks.find(block => block.type === 'header').data.level, 2);
  assert.equal(x.rows[1].tags, 'rich,keep');
});
test('security: missing purifier renders rich markup as literal text', async t => {
  const x = await setup(t, { realEditor: true }); x.w.DOMPurify = null;
  x.rows[1].content_blocks = JSON.stringify(hostileBlocks());
  const modal = await x.open(2); await x.editors.at(-1).isReady; await tick();
  for (const block of modal.querySelectorAll('.ce-block__content')) assertSafeNoteDom(block);
  assert.ok(modal.querySelector('.ce-paragraph').textContent.includes('<img'));
  assert.equal(modal.querySelectorAll('.ce-paragraph a').length, 0);
});

test('catalog mounts without empty editor, excludes other tabs, and new note focuses content with no phantom draft', async t => {
  const x = await setup(t); assert.equal(x.w.document.querySelector('dialog'), null); assert.equal(x.root.querySelector('[data-detail]'), null); assert.equal(x.root.querySelector('[data-note-id="5"]'), null);
  const modal = await x.open(); assert.equal(x.w.document.activeElement, modal.querySelector('[name=content]')); await x.close(modal);
  assert.equal(x.root.querySelector('[data-new]').textContent, 'Новая заметка'); assert.equal(x.calls.some(call => /create_|update_/.test(call.name)), false);
});

test('title or content is required; plain draft survives close, reopen and remount without DB autosave', async t => {
  const x = await setup(t); let modal = await x.open(); await x.save(modal); assert.match(modal.querySelector('[data-dialog-error]').textContent, /Добавь мысль/);
  x.set(modal, 'content', 'Одна мысль'); await x.close(modal); assert.match(x.root.querySelector('[data-new]').textContent, /Продолжить/);
  await x.remount(); modal = await x.open(); assert.equal(modal.querySelector('[name=content]').value, 'Одна мысль');
  assert.equal(x.calls.some(call => call.name === 'create_note'), false); await x.save(modal);
  assert.equal(x.calls.filter(call => call.name === 'create_note').length, 1); assert.equal(x.rows.at(-1).title, 'Одна мысль');
});

test('v1 draft retains its exact nanosecond base across conflict, close/reopen and remount until explicit discard/reload', async t => {
  const x = await setup(t); let modal = await x.open(1); x.set(modal, 'content', 'Мой старый черновик');
  Object.assign(x.rows[0], { content: 'Внешний v2', updated_at: '2026-09-06T13:00:00.000000200+05:00' });
  await x.save(modal); assert.equal(x.calls.some(call => call.name === 'update_note'), false); assert.equal(modal.querySelector('[type=submit]').disabled, true);
  await x.close(modal); await x.remount(); modal = await x.open(1);
  assert.equal(modal.querySelector('[name=content]').value, 'Мой старый черновик'); assert.equal(modal.querySelector('[type=submit]').disabled, true);
  await x.save(modal); assert.equal(x.rows[0].content, 'Внешний v2');
  modal.querySelector('[data-note-discard]').click(); await tick(); modal = x.w.document.querySelector('dialog[open]');
  assert.equal(modal.querySelector('[name=content]').value, 'Внешний v2'); assert.equal(modal.querySelector('[type=submit]').disabled, false);
  x.set(modal, 'content', 'Новый черновик'); await x.save(modal); assert.equal(x.rows[0].content, 'Новый черновик');
});

test('save preserves exact fresh tags and all unrelated metadata; fresh archive/status changes block it', async t => {
  const x = await setup(t); const metadata = structuredClone(x.rows[0]); let modal = await x.open(1); x.set(modal, 'title', 'New title'); await x.save(modal);
  const command = x.calls.find(call => call.name === 'update_note').args;
  assert.equal(command.tags, metadata.tags); for (const field of ['pinned', 'archived', 'tabName', 'status', 'dueDate', 'reminderAt', 'contentBlocks', 'priority']) assert.equal(command[field], null);
  for (const field of ['pinned', 'priority', 'due_date', 'reminder_at']) assert.equal(x.rows[0][field], metadata[field]);
  modal = await x.open(1); x.set(modal, 'content', 'Should not save'); x.rows[0].status = 'task'; await x.save(modal);
  assert.equal(x.calls.filter(call => call.name === 'update_note').length, 1);
});

test('external plain-to-rich conversion cannot hide or replace the original plain draft when its conflicted modal closes', async t => {
  const x = await setup(t); let modal = await x.open(1); x.set(modal, 'content', 'Мой plain черновик'); await x.close(modal);
  Object.assign(x.rows[0], { updated_at: 'converted-v2', content: 'Чужое rich содержимое', content_blocks: JSON.stringify({ blocks: [{ type: 'paragraph', data: { text: 'Чужое rich содержимое' } }] }) });
  modal = await x.open(1); assert.equal(modal.querySelector('[name=content]').closest('label').hidden, false); assert.equal(modal.querySelector('[name=content]').value, 'Мой plain черновик');
  assert.equal(modal.querySelector('[type=submit]').disabled, true); await x.close(modal); await x.remount(); modal = await x.open(1);
  assert.equal(modal.querySelector('[name=content]').value, 'Мой plain черновик'); assert.equal(x.calls.some(call => call.name === 'update_note'), false);
});

test('external rich-to-plain conversion preserves the rich draft format through conflict and another reopen', async t => {
  const x = await setup(t); let modal = await x.open(2); x.editors.at(-1).type('Мой rich черновик'); await x.close(modal);
  Object.assign(x.rows[1], { updated_at: 'converted-v2', content: 'Чужой plain', content_blocks: null });
  modal = await x.open(2); assert.ok(modal.querySelector('.calendar-note-blocks')); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Мой rich черновик');
  await x.close(modal); modal = await x.open(2); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Мой rich черновик'); assert.equal(modal.querySelector('[type=submit]').disabled, true);
});

test('rich immediate Escape captures the latest editor DOM before destroy and preserves real blocks on save', async t => {
  const x = await setup(t); let modal = await x.open(2); const editor = x.editors.at(-1); editor.type('Последние символы', false); await x.close(modal);
  assert.equal(editor.destroyed, true); modal = await x.open(2); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Последние символы');
  await x.save(modal); const saved = JSON.parse(x.rows[1].content_blocks);
  assert.equal(saved.blocks[0].data.text, 'Последние символы'); assert.deepEqual(saved.blocks[1], { type: 'code', data: { code: 'const x = 1;' } }); assert.equal(x.rows[1].tags, 'rich,keep');
});

test('untouched rich output with new time/version/generated IDs does not create a phantom draft', async t => {
  const x = await setup(t), modal = await x.open(2); x.editors.at(-1).output.blocks[0].id = 'generated'; await x.close(modal);
  assert.doesNotMatch(x.root.querySelector('[data-note-id="2"]').textContent, /Есть черновик/);
});

test('rich capture failure keeps regular close open and retry preserves last input', async t => {
  const x = await setup(t), modal = await x.open(2), editor = x.editors.at(-1); editor.type('Ещё текст'); editor.fail = true;
  await x.close(modal); assert.equal(modal.open, true); assert.equal(editor.destroyed, false); assert.match(modal.querySelector('[data-dialog-error]').textContent, /последний ввод/);
  editor.fail = false; await x.close(modal); await x.open(2); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Ещё текст');
});

test('pending rich close keeps all save/archive/close controls disabled and restores them after capture failure', async t => {
  const x = await setup(t), modal = await x.open(2), editor = x.editors.at(-1), gate = deferred(); editor.type('Последняя строка'); editor.hold = gate; editor.fail = true;
  modal.dispatchEvent(new x.w.Event('cancel', { cancelable: true })); await tick();
  for (const button of modal.querySelectorAll('[type=submit],[data-archive],[data-dialog-close]')) assert.equal(button.disabled, true);
  assert.equal(modal.querySelector('.calendar-note-blocks').hasAttribute('inert'), true);
  gate.resolve(); await tick(); assert.equal(modal.querySelector('[type=submit]').disabled, false); assert.equal(modal.querySelector('[data-archive]').disabled, false);
  editor.fail = false; await x.close(modal);
});

test('dispose releases native modal immediately and keeps editor DOM until latest capture settles; reopening waits', async t => {
  const x = await setup(t), modal = await x.open(2), editor = x.editors.at(-1), gate = deferred(); editor.type('Перед сменой панели'); editor.hold = gate;
  const outside = x.w.document.querySelector('#outside'); outside.focus(); await x.remount();
  assert.equal(modal.open, false); assert.equal(modal.isConnected, true); assert.equal(editor.destroyed, false); assert.equal(x.w.document.activeElement, outside);
  x.root.querySelector('[data-note-id="2"]').click(); await tick(); assert.equal(x.w.document.querySelector('dialog[open]'), null);
  gate.resolve(); await tick(); assert.equal(editor.destroyed, true); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Перед сменой панели');
});

test('failed dispose capture retains a hidden holder for retry without trapping the next pane', async t => {
  const x = await setup(t), modal = await x.open(2), editor = x.editors.at(-1); editor.type('Не потерять при ошибке'); editor.fail = true;
  await x.remount(); assert.equal(modal.open, false); assert.equal(editor.destroyed, false);
  await x.open(2); assert.equal(x.root.querySelector('[data-open-retry]').hidden, false); assert.equal(x.w.document.querySelector('dialog[open]'), null);
  editor.fail = false; x.root.querySelector('[data-open-retry]').click(); await tick(); assert.equal(editor.destroyed, true); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Не потерять при ошибке');
});

test('failed regular close followed by more rich typing and disposal retries capture instead of reusing a settled promise', async t => {
  const x = await setup(t), modal = await x.open(2), editor = x.editors.at(-1);
  editor.type('До ошибки'); editor.fail = true; await x.close(modal); assert.equal(modal.open, true);
  editor.type('Новый ввод после ошибки'); await x.remount();
  assert.equal(editor.destroyed, false); assert.equal(modal.open, false);
  editor.fail = false; await x.open(2);
  assert.equal(editor.destroyed, true); assert.equal(x.editors.at(-1).output.blocks[0].data.text, 'Новый ввод после ошибки');
});

test('invalid JSON and failed EditorJS initialization stay read-only without changing source blocks', async t => {
  const x = await setup(t); let modal = await x.open(3); assert.equal(modal.querySelector('[name=content]').readOnly, true); assert.equal(modal.querySelector('[type=submit]').disabled, true); await x.save(modal); await x.close(modal);
  x.failEditor(); modal = await x.open(2); assert.equal(modal.querySelector('[name=content]').closest('label').hidden, false); assert.equal(modal.querySelector('[name=content]').readOnly, true); await x.save(modal);
  assert.equal(x.calls.some(call => call.name === 'update_note'), false); assert.equal(x.rows[2].content_blocks, '{invalid');
});

test('archive checks rich dirty input, successful archive exposes undo and restoring does not edit metadata', async t => {
  const x = await setup(t); let modal = await x.open(2); x.editors.at(-1).type('Несохранённое'); modal.querySelector('[data-archive]').click(); await tick();
  assert.equal(x.calls.some(call => call.name === 'toggle_note_archive'), false); assert.match(modal.querySelector('[data-dialog-error]').textContent, /черновик/);
  modal.querySelector('[data-note-discard]').click(); await tick(); modal = x.w.document.querySelector('dialog[open]'); modal.querySelector('[data-archive]').click(); await tick();
  assert.equal(x.rows[1].archived, true); assert.equal(x.root.querySelector('[data-undo]').hidden, false);
  x.root.querySelector('[data-undo]').click(); await tick(); assert.equal(x.rows[1].archived, false); assert.equal(x.rows[1].tags, 'rich,keep');
});

test('pending save blocks double submit, close and editor; acknowledged create plus refresh failure never offers duplicate creation', async t => {
  const x = await setup(t), modal = await x.open(), gate = deferred(); x.set(modal, 'title', 'Только заголовок'); x.before.set('create_note', () => gate.promise);
  modal.querySelector('[type=submit]').click(); modal.querySelector('[type=submit]').click(); await tick();
  await x.close(modal); assert.equal(modal.open, true); assert.equal(modal.querySelector('fieldset').hasAttribute('inert'), true);
  x.before.set('get_notes', () => { throw new Error('read failure'); }); gate.resolve(); await tick();
  assert.equal(modal.open, false); assert.equal(x.calls.filter(call => call.name === 'create_note').length, 1); assert.equal(x.root.querySelector('[data-retry]').hidden, false);
  x.before.delete('get_notes'); x.root.querySelector('[data-retry]').click(); await tick(); assert.equal(x.calls.filter(call => call.name === 'create_note').length, 1);
});

test('disposing during fresh-read validation prevents a late update against another note', async t => {
  const x = await setup(t), modal = await x.open(1), gate = deferred(); x.set(modal, 'content', 'Не отправлять после ухода'); x.before.set('get_note', () => gate.promise);
  modal.querySelector('[type=submit]').click(); await tick(); x.dispose(); x.before.delete('get_note'); gate.resolve(); await tick();
  assert.equal(x.calls.some(call => call.name === 'update_note'), false); assert.equal(x.rows[0].content, 'Исходный текст');
});
