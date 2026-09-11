import { invoke as defaultInvoke } from './state.js';
import { escapeHtml, initBlockEditor, blocksToPlainText } from './utils.js';
import { createCalendarDialog } from './calendar-dialog.js';

let nextInstance = 0;
// Window-local drafts retain the exact version they were based on, never a fresh replacement version.
const drafts = new Map(), pendingDrafts = new Map(), retainedEditors = new Map();
const keyOf = id => id == null ? 'new' : String(id);
const blockSignature = data => JSON.stringify((data?.blocks || []).map(({ id, ...block }) => block));
export function isCalendarNote(note) {
  const calendar = note && (note.tab_name === 'calendar' || (!note.tab_name && String(note.tags || '').split(',').some(tag => tag.trim().toLowerCase() === 'calendar')));
  return !!calendar && (!note.status || note.status === 'note');
}

/** Existing notes with explicit saves. This module owns UI drafts, not a second persisted note model. */
export async function mountCalendarNotes(element, dependencies = {}) {
  const api = dependencies.invoke || defaultInvoke, createEditor = dependencies.initBlockEditor || initBlockEditor;
  const document = element.ownerDocument, window = document.defaultView;
  const prefix = `calendar-notes-${++nextInstance}`;
  let disposed = false, revision = 0, opening = 0, session = null, catalogBusy = false;
  let notes = [], archived = false, lastArchived = null, retryOpen = undefined;
  element.classList.add('calendar-panels', 'calendar-notes');
  element.innerHTML = `<header class="cp-heading"><div><h2>Заметки</h2><p>Мысли, идеи и детали, которые хочется сохранить.</p></div><button type="button" class="cp-primary" data-new>Новая заметка</button></header>
    <p class="cp-message" data-message role="status" aria-live="polite"></p><button type="button" data-retry hidden>Повторить загрузку</button><button type="button" data-open-retry hidden>Повторить открытие заметки</button><button type="button" data-undo hidden>Вернуть из архива</button>
    <section class="cp-notes-catalog" aria-label="Сохранённые заметки"><div class="cp-notes-tools"><input type="search" data-search aria-label="Поиск по заметкам" placeholder="Найти заметку">
      <div class="cp-note-tabs" role="group" aria-label="Раздел заметок"><button type="button" data-filter="active" aria-pressed="true">Заметки</button><button type="button" data-filter="archive" aria-pressed="false">Архив</button></div></div><p class="cp-muted" data-count></p><div class="cp-note-list" data-list aria-busy="true"></div></section>`;
  const list = element.querySelector('[data-list]'), message = element.querySelector('[data-message]'), search = element.querySelector('[data-search]');
  const dateLabel = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''; };
  const current = value => !disposed && session === value && !value.closed;
  const restoreRow = id => (element.querySelector(`[data-note-id="${id}"]`) || element.querySelector('[data-new]'))?.focus();
  function renderList() {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.noteId : null;
    const query = search.value.trim().toLocaleLowerCase('ru');
    const visible = notes.filter(note => !!note.archived === archived && `${note.title}\n${note.content}\n${note.tags}`.toLocaleLowerCase('ru').includes(query));
    element.querySelector('[data-count]').textContent = visible.length ? `Найдено: ${visible.length}` : '';
    element.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.filter === 'archive') === archived)));
    element.querySelector('[data-new]').textContent = drafts.has('new') || retainedEditors.has('new') ? 'Продолжить черновик' : 'Новая заметка';
    list.replaceChildren();
    if (!visible.length) list.innerHTML = `<div class="cp-empty"><h3>${query ? 'Ничего не найдено' : archived ? 'Архив пуст' : 'Здесь будут твои заметки'}</h3><p>${query ? 'Попробуй другое слово.' : archived ? 'Заметки из архива можно восстановить.' : 'Нажми «Новая заметка», чтобы записать мысль. Название можно добавить позже.'}</p></div>`;
    visible.forEach(note => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'cp-note-card'; button.dataset.noteId = String(note.id);
      button.setAttribute('aria-current', String(session?.key === String(note.id)));
      button.innerHTML = `<span class="cp-note-title">${escapeHtml(note.title || 'Без названия')}</span>${note.content ? `<span class="cp-note-preview">${escapeHtml(note.content)}</span>` : ''}<span class="cp-note-meta">${note.pinned ? 'Закреплена · ' : ''}${escapeHtml(dateLabel(note.updated_at))}${drafts.has(String(note.id)) || retainedEditors.has(String(note.id)) ? ' · Есть черновик' : ''}</span>`;
      button.disabled = catalogBusy; button.onclick = () => openNote(note.id); list.append(button);
    });
    if (focused) list.querySelector(`[data-note-id="${focused}"]`)?.focus();
  }
  function destroy(value) {
    if (value.destroyed) return;
    value.destroyed = true; value.captureRevision++;
    const editor = value.editor;
    if (editor) Promise.resolve(editor.isReady).catch(() => {}).then(() => { try { editor.destroy(); } catch {} value.holder?.remove(); });
  }
  function controls(value) {
    const editable = !value.note?.archived && !value.invalid && !value.editorFailed;
    const pending = value.pending || value.dialog.pending;
    value.dialog.submit.hidden = !!value.note?.archived;
    value.dialog.submit.disabled = pending || !editable || !value.ready || value.conflict;
    value.title.readOnly = !editable || !value.ready;
    value.content.readOnly = !editable || !value.ready;
    value.holder?.toggleAttribute('inert', pending || !editable || !value.ready);
    value.discard.hidden = !drafts.has(value.key) && !value.conflict;
    value.discard.disabled = pending;
    if (value.archive) value.archive.disabled = pending;
    value.status.textContent = drafts.has(value.key) ? 'Черновик · не сохранён' : value.note ? 'Сохранено' : '';
  }
  function setBusy(value, busy) { value.pending = busy; value.dialog.setPending(busy); controls(value); }
  function remember(value) {
    if (value.committed || value.note?.archived || value.invalid || value.editorFailed || value.destroyed) return;
    const title = value.title.value, content = value.rich ? blocksToPlainText(value.output) : value.content.value;
    const changed = title !== value.base.title || (value.rich ? blockSignature(value.output) !== value.base.blocks : content !== value.base.content);
    if (changed) drafts.set(value.key, { title, content, rich: value.rich, blocks: value.rich ? value.output : null, base: value.base, baseUpdatedAt: value.baseUpdatedAt });
    else drafts.delete(value.key);
    if (current(value)) { controls(value); renderList(); }
  }
  async function capture(value) {
    remember(value);
    if (value.rich && value.ready && !value.note?.archived && !value.invalid && !value.editorFailed && !value.committed && !value.destroyed) {
      const token = ++value.captureRevision, output = await value.editor.save();
      if (value.destroyed || token !== value.captureRevision) return;
      if (!Array.isArray(output?.blocks)) throw new Error('Некорректный ответ редактора.');
      value.output = output; remember(value);
    }
  }
  function beforeClose(value) {
    value.closing = true;
    const previousWork = pendingDrafts.get(value.key);
    const work = (async () => {
      try { await previousWork; await capture(value); }
      catch {
        if (value.detached) {
          // Retain actual editor DOM for capture retry after pane disposal, without a native top layer.
          value.retained = true; value.holder.hidden = true; document.body.append(value.holder);
          retainedEditors.set(value.key, { async retry() { await capture(value); value.retained = false; retainedEditors.delete(value.key); destroy(value); } });
        } else throw new Error('Не удалось прочитать последний ввод. Заметка остаётся открытой — повтори закрытие или сохранение.');
      } finally { value.closing = false; }
    })();
    pendingDrafts.set(value.key, work);
    return work.finally(() => { if (pendingDrafts.get(value.key) === work) pendingDrafts.delete(value.key); });
  }
  async function showEditor(note = null) {
    const key = keyOf(note?.id), draft = drafts.get(key);
    let originalBlocks = null, invalid = false;
    if (note?.content_blocks) { try { originalBlocks = JSON.parse(note.content_blocks); invalid = !Array.isArray(originalBlocks?.blocks); } catch { invalid = true; } }
    const rich = draft ? (draft.rich ?? !!draft.blocks) : !!originalBlocks && !invalid;
    const value = { key, note, baseUpdatedAt: draft ? draft.baseUpdatedAt : note?.updated_at,
      base: draft?.base || { title: note?.title || '', content: note?.content || '', blocks: invalid ? '' : blockSignature(originalBlocks) },
      rich, output: draft ? draft.blocks : originalBlocks, invalid, editorFailed: false, ready: !rich || invalid,
      pending: false, closing: false, closed: false, detached: false, destroyed: false, retained: false, committed: false, captureRevision: 0,
      conflict: !!draft && draft.baseUpdatedAt !== note?.updated_at };
    const dialog = createCalendarDialog({ document, title: note?.archived ? 'Заметка в архиве' : note ? 'Заметка' : 'Новая заметка', hint: 'Название необязательно. Черновик остаётся в этом окне до сохранения.', submitLabel: note ? 'Сохранить изменения' : 'Сохранить заметку',
      isCurrent: () => !disposed && element.isConnected, returnFocus: () => restoreRow(note?.id), beforeClose: () => beforeClose(value),
      onPendingChange: () => controls(value),
      onClose: () => { value.closed = true; if (!value.retained) destroy(value); if (session === value) session = null; if (!disposed) renderList(); } });
    value.dialog = dialog; session = value;
    dialog.modal.classList.add('calendar-note-dialog'); dialog.modal.dataset.noteEditor = key;
    dialog.modal.querySelectorAll('[data-dialog-close]').forEach(button => { if (!button.classList.contains('calendar-editor-close')) button.textContent = 'Закрыть'; });
    dialog.body.innerHTML = `<p class="calendar-note-status" data-save-status role="status"></p>
      <label class="calendar-editor-field">Название · необязательно<input name="title" maxlength="500" placeholder="О чём эта заметка?" value="${escapeHtml(draft?.title ?? note?.title ?? '')}"></label>
      <label class="calendar-editor-field"${value.rich && !invalid ? ' hidden' : ''}>Заметка<textarea name="content" rows="10" placeholder="Идея, наблюдение или детали на потом…">${escapeHtml(draft?.content ?? note?.content ?? '')}</textarea></label>
      ${value.rich && !invalid ? `<div class="calendar-note-blocks" id="${prefix}-blocks-${++opening}" aria-label="Содержимое заметки"></div>` : ''}
      <button type="button" data-note-discard hidden>${note ? 'Отменить черновик и загрузить сохранённое' : 'Очистить черновик'}</button>`;
    value.title = dialog.form.elements.title; value.content = dialog.form.elements.content; value.status = dialog.body.querySelector('[data-save-status]'); value.discard = dialog.body.querySelector('[data-note-discard]'); value.holder = dialog.body.querySelector('.calendar-note-blocks');
    if (note) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.archive = ''; button.textContent = note.archived ? 'Восстановить' : 'В архив';
      dialog.submit.before(button); value.archive = button; button.addEventListener('click', () => changeArchive(value));
    }
    dialog.form.addEventListener('input', () => { if (!value.pending && !value.closing) remember(value); });
    value.discard.addEventListener('click', () => discardReload(value));
    dialog.form.addEventListener('submit', event => { event.preventDefault(); void save(value); });
    controls(value); dialog.open(note?.archived ? value.archive : note ? value.title : value.content);
    if (invalid) dialog.showError('Не удалось открыть форматирование заметки. Текст доступен для чтения; исходная запись сохранена.');
    else if (value.rich) {
      value.ready = false; controls(value);
      try {
        value.editor = createEditor(value.holder.id, value.output, () => {
          if (!current(value) || !value.ready || value.pending || value.closing || note.archived) return;
          void capture(value).catch(() => { if (current(value)) dialog.showError('Не удалось прочитать изменения редактора. Повтори сохранение или закрытие.'); });
        }, { readOnly: !!note.archived, placeholder: 'Запиши мысль…' });
        await value.editor.isReady;
        if (!current(value)) return;
        value.ready = true; controls(value);
      } catch { if (current(value)) { value.editorFailed = true; value.content.closest('label').hidden = false; value.holder.hidden = true; controls(value); dialog.showError('Редактор не загрузился. Исходная запись доступна только для чтения; закрой и открой её повторно.'); } }
    }
    if (current(value) && value.conflict) dialog.showError('Заметка изменилась в другом месте. Этот черновик основан на прежней версии. Отмени черновик и загрузи сохранённое перед редактированием новой версии.');
    if (current(value)) renderList();
  }
  async function openNote(id = null) {
    if (catalogBusy || session?.pending || session?.dialog.pending) return;
    const request = ++opening;
    if (session) { const previous = session; await previous.dialog.close(); if (previous.dialog.modal.isConnected) return; }
    try {
      const key = keyOf(id);
      await pendingDrafts.get(key);
      if (retainedEditors.has(key)) await retainedEditors.get(key).retry();
      const note = id == null ? null : await api('get_note', { id: String(id) });
      if (disposed || request !== opening) return;
      if (id != null && !isCalendarNote(note)) throw new Error('Not a calendar note');
      retryOpen = undefined; element.querySelector('[data-open-retry]').hidden = true;
      await showEditor(note);
    } catch { if (!disposed && request === opening) { retryOpen = id; message.textContent = 'Не удалось открыть заметку или прочитать её черновик. Последний ввод сохранён для повторной попытки.'; element.querySelector('[data-open-retry]').hidden = false; } }
  }
  async function discardReload(value) {
    if (!current(value) || value.pending || value.dialog.pending) return;
    setBusy(value, true);
    try {
      const fresh = value.note ? await api('get_note', { id: value.note.id }) : null;
      if (!current(value)) return;
      if (fresh && !isCalendarNote(fresh)) throw new Error('changed');
      drafts.delete(value.key); value.committed = true; setBusy(value, false);
      value.dialog.close({ skipBeforeClose: true, restoreFocus: false });
      await showEditor(fresh);
    } catch { if (current(value)) { setBusy(value, false); value.dialog.showError('Не удалось загрузить сохранённую версию. Черновик не удалён — повтори попытку.'); } }
  }
  function save(value) {
    if (!current(value) || value.pending || value.dialog.pending || value.conflict || value.note?.archived || value.invalid || value.editorFailed || !value.ready) return;
    setBusy(value, true); value.dialog.showError('');
    const work = (async () => {
      try {
        await capture(value);
        const content = value.rich ? blocksToPlainText(value.output) : value.content.value;
        const title = value.title.value.trim() || content.trim().split('\n')[0].slice(0, 100);
        if (!title && !content.trim()) { if (current(value)) { setBusy(value, false); value.dialog.showError('Добавь мысль или название заметки.', value.content); } return; }
        if (value.title.value.trim().length > 500) { if (current(value)) { setBusy(value, false); value.dialog.showError('Сократи название до 500 символов.', value.title); } return; }
        if (!current(value)) return;
        let id = value.note?.id;
        if (value.note) {
          const fresh = await api('get_note', { id });
          if (!current(value)) return;
          if (!isCalendarNote(fresh) || fresh.archived || fresh.updated_at !== value.baseUpdatedAt) { value.conflict = true; throw new Error('changed'); }
          await api('update_note', { id, title, content, tags: fresh.tags || '', pinned: null, archived: null, tabName: null, status: null, dueDate: null, reminderAt: null, contentBlocks: value.rich ? JSON.stringify(value.output) : null, priority: null });
        } else id = await api('create_note', { title, content, tags: '', tabName: 'calendar', status: 'note', dueDate: null, reminderAt: null, priority: null });
        value.committed = true; drafts.delete(value.key);
        if (current(value)) { setBusy(value, false); value.dialog.close({ skipBeforeClose: true }); await refresh('Заметка сохранена.'); }
        window.dispatchEvent(new window.Event('task-state-changed'));
      } catch (error) {
        if (current(value)) {
          setBusy(value, false);
          value.dialog.showError(error?.message === 'changed' ? 'Заметка изменилась в другом месте. Черновик сохранён на основе прежней версии. Отмени черновик и загрузи сохранённое перед новой записью.' : 'Не удалось сохранить. Черновик остался в форме — попробуй ещё раз.');
        }
      } finally { if (current(value)) setBusy(value, false); }
    })();
    pendingDrafts.set(value.key, work);
    void work.finally(() => { if (pendingDrafts.get(value.key) === work) pendingDrafts.delete(value.key); });
    return work;
  }
  async function changeArchive(value = null) {
    if (catalogBusy || value?.pending || value?.dialog.pending || (value && !current(value))) return;
    const id = value?.note?.id ?? lastArchived; if (id == null) return;
    if (value) setBusy(value, true); else catalogBusy = true;
    try {
      if (value) { await capture(value); if (!current(value)) return; if (drafts.has(value.key)) throw new Error('draft'); }
      const fresh = await api('get_note', { id });
      if (disposed || (value && !current(value))) return;
      if (!isCalendarNote(fresh) || (value ? !!fresh.archived !== !!value.note.archived || fresh.updated_at !== value.baseUpdatedAt : !fresh.archived)) throw new Error('changed');
      const isArchived = await api('toggle_note_archive', { id }); lastArchived = isArchived ? id : null;
      if (value) { value.committed = true; setBusy(value, false); value.dialog.close({ skipBeforeClose: true }); }
      if (!disposed) { if (!isArchived) archived = false; element.querySelector('[data-undo]').hidden = !lastArchived; await refresh(isArchived ? 'Заметка в архиве. Её можно вернуть.' : 'Заметка восстановлена.'); }
    } catch (error) {
      if (!disposed) {
        const text = error?.message === 'draft' ? 'Сначала сохрани или отмени черновик заметки.' : 'Не удалось изменить архив. Запись могла измениться; закрой и открой её повторно.';
        if (value && current(value)) { setBusy(value, false); value.dialog.showError(text); } else message.textContent = text;
      }
    } finally { catalogBusy = false; if (value && current(value)) setBusy(value, false); if (!disposed) renderList(); }
  }
  async function refresh(success = '') {
    const rev = ++revision; list.setAttribute('aria-busy', 'true'); message.textContent = 'Загружаем заметки…'; element.querySelector('[data-retry]').hidden = true;
    try {
      const [currentNotes, recentNotes] = await Promise.all([api('get_notes', { filter: 'tab:calendar', search: null }), api('get_notes', { filter: null, search: null })]);
      if (disposed || rev !== revision) return;
      notes = [...new Map([...recentNotes, ...currentNotes].filter(isCalendarNote).map(note => [String(note.id), note])).values()];
      notes.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updated_at).localeCompare(String(a.updated_at)));
      renderList(); message.textContent = [success, recentNotes.length >= 200 || currentNotes.length >= 200 ? 'Показаны последние заметки. Старые записи могут быть вне этого списка.' : ''].filter(Boolean).join(' ');
    } catch { if (!disposed && rev === revision) { message.textContent = 'Не удалось загрузить заметки. Это не означает, что они исчезли.'; element.querySelector('[data-retry]').hidden = false; } }
    finally { if (!disposed && rev === revision) list.removeAttribute('aria-busy'); }
  }
  search.addEventListener('input', renderList);
  element.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { archived = button.dataset.filter === 'archive'; renderList(); });
  element.querySelector('[data-new]').onclick = () => openNote();
  element.querySelector('[data-retry]').onclick = () => refresh();
  element.querySelector('[data-open-retry]').onclick = () => openNote(retryOpen);
  element.querySelector('[data-undo]').onclick = () => changeArchive();
  await refresh();
  return () => {
    disposed = true; revision++; opening++;
    if (session) { const old = session; old.detached = true; remember(old); old.dialog.dispose(); }
  };
}