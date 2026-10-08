import { createUiCopy } from './ui-copy.js';
import {
  ALL_TASK_FILTERS, DEFAULT_TASK_FILTERS, VIEW_LIMITS, newTaskFilterViewId,
  readTaskFilterViews, saveTaskFilterViews, taskFilters,
} from './task-filter-views.js';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// A saved view contains filter settings only. Applying it never mutates tasks.
export function mountTaskFilterTabs(host, { invoke, state, onApply }) {
  const doc = host.ownerDocument;
  const uiCopy = createUiCopy(doc);
  const errorText = error => uiCopy.format(error?.copyKey || error?.message || 'повторите попытку', ...(error?.parameters || []));
  host.classList.add('ct-view-tabs');
  const tabs = doc.createElement('div');
  tabs.className = 'ct-view-tabs-list';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', uiCopy("Подборки задач"));
  const actions = doc.createElement('div');
  actions.className = 'ct-view-tabs-actions';
  const editorHost = doc.createElement('div');
  const status = doc.createElement('p');
  status.className = 'ct-view-tabs-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.tabIndex = -1;
  host.append(tabs, actions, editorHost, status);

  const currentFilters = () => {
    try { return taskFilters(state); }
    catch { return null; }
  };
  let snapshot = null;
  let selected = state.taskViewId || (same(currentFilters(), ALL_TASK_FILTERS) ? 'all'
    : same(currentFilters(), DEFAULT_TASK_FILTERS) ? 'active' : null);
  let editor = null;
  let busy = false;
  let loading = false;
  let stale = true;
  let disposed = false;
  let request = 0;
  let message = '';

  const button = (label, key, action) => {
    const item = doc.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.dataset[key] = '';
    item.addEventListener('click', action);
    return item;
  };
  const focusEnabled = (...controls) => {
    const target = controls.find(item => item && !item.disabled);
    target?.focus({preventScroll:true});
    return target;
  };
  const viewById = id => snapshot?.state.views.find(view => view.id === id);
  const selectedFilters = () => selected === 'all' ? ALL_TASK_FILTERS
    : selected === 'active' ? DEFAULT_TASK_FILTERS : viewById(selected)?.filters;
  const modified = () => !!selectedFilters() && !same(currentFilters(), selectedFilters());

  function drawTabs() {
    const focusedId = doc.activeElement?.dataset?.taskViewId;
    const entries = [
      { id:'all', title:uiCopy("Все"), filters:ALL_TASK_FILTERS },
      { id:'active', title:uiCopy("Активные"), filters:DEFAULT_TASK_FILTERS },
      ...(snapshot?.state.views || []),
    ];
    tabs.replaceChildren(...entries.map(view => {
      const item = button(view.title, 'taskViewTab', () => {
        if (busy || editor) return;
        selected = view.id;
        state.taskViewId = selected;
        if (!stale) message = '';
        onApply(view.filters);
        draw();
      });
      item.dataset.taskViewId = view.id;
      const current = selected === view.id;
      item.setAttribute('aria-pressed', String(current));
      if (current && modified()) item.textContent += uiCopy(" · изменено");
      item.disabled = busy || !!editor;
      return item;
    }));
    if (focusedId) [...tabs.querySelectorAll('[data-task-view-id]')]
      .find(item => item.dataset.taskViewId === focusedId)?.focus({preventScroll:true});
  }

  function drawEditor(focusKey = null) {
    const keys = ['name','save','cancel','remove','confirm-remove','keep'];
    const activeKey = keys.find(key => doc.activeElement === editorHost.querySelector('[data-task-view-' + key + ']'));
    const activeInput = activeKey === 'name'
      ? {start:doc.activeElement.selectionStart, end:doc.activeElement.selectionEnd} : null;
    if (activeInput && editor) editor.inputSelection = activeInput;
    editorHost.replaceChildren();
    if (!editor) return;
    const form = doc.createElement('form');
    form.className = 'ct-view-editor';
    form.dataset.taskViewEditor = editor.mode;
    const label = doc.createElement('label');
    label.textContent = editor.mode === 'new' ? uiCopy("Название подборки") : uiCopy("Изменить подборку");
    const input = doc.createElement('input');
    input.type = 'text';
    input.required = true;
    input.maxLength = VIEW_LIMITS.title;
    input.value = editor.title;
    input.disabled = busy;
    input.dataset.taskViewName = '';
    input.addEventListener('input', () => { editor.title = input.value; });
    label.append(input);
    const note = doc.createElement('span');
    note.className = 'ct-view-editor-note';
    note.textContent = uiCopy("Сохранятся фильтры, выбранные при открытии формы.");
    const save = button(uiCopy("Сохранить"), 'taskViewSave', () => {});
    save.type = 'submit';
    const cancel = button(uiCopy("Отмена"), 'taskViewCancel', () => cancelEditor());
    save.disabled = busy || stale || editor.targetChanged;
    cancel.disabled = busy;
    form.append(label, note, save, cancel);
    if (editor.mode === 'edit') {
      const remove = button(uiCopy("Удалить подборку"), 'taskViewRemove', () => {
        if (busy) return;
        editor.confirming = true;
        drawEditor('keep');
      });
      remove.disabled = busy || stale || editor.targetChanged;
      form.append(remove);
      if (editor.confirming) {
        const confirmation = doc.createElement('span');
        confirmation.className = 'ct-view-delete-confirmation';
        confirmation.textContent = uiCopy.format("Удалить подборку «{0}»? Задачи останутся.", editor.title.trim());
        const yes = button(uiCopy("Подтвердить удаление"), 'taskViewConfirmRemove', () => void removeView());
        const no = button(uiCopy("Не удалять"), 'taskViewKeep', () => {
          editor.confirming = false;
          drawEditor('remove');
        });
        yes.disabled = busy || stale || editor.targetChanged;
        no.disabled = busy;
        form.append(confirmation, yes, no);
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!busy) void saveView();
    });
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        event.stopPropagation();
        if (editor.confirming) {
          editor.confirming = false;
          drawEditor('remove');
        } else {
          cancelEditor();
        }
      }
    });
    editorHost.append(form);
    const targetKey = focusKey || activeKey;
    const target = targetKey && editorHost.querySelector('[data-task-view-' + targetKey + ']');
    if (target && !target.disabled) {
      target.focus({preventScroll:true});
      if (targetKey === 'name' && editor.inputSelection) {
        input.setSelectionRange(editor.inputSelection.start, editor.inputSelection.end);
      }
    } else if (busy && activeKey) {
      status.focus({preventScroll:true});
    } else if (focusKey) {
      focusEnabled(input, status);
    }
  }

  function draw() {
    if (disposed) return;
    // Empty status is hidden by CSS; populate it before it becomes a focus target.
    status.textContent = message || (busy ? (editor?.confirming ? (uiCopy.locale === 'en' ? 'Deleting view…' : 'Удаляем подборку…') : (uiCopy.locale === 'en' ? 'Saving view…' : 'Сохраняем подборку…'))
      : loading ? uiCopy("Загружаем подборки…") : '');
    drawTabs();
    const actionKeys = ['create','edit','reload'];
    const activeAction = actionKeys.find(key => doc.activeElement === actions.querySelector('[data-task-view-' + key + ']'));
    actions.replaceChildren();
    const create = button(uiCopy("Сохранить текущие фильтры"), 'taskViewCreate', () => openEditor('new'));
    create.disabled = busy || loading || stale || !!editor || (snapshot?.state.views.length || 0) >= VIEW_LIMITS.views;
    const edit = button(uiCopy("Изменить подборку"), 'taskViewEdit', () => openEditor('edit'));
    edit.disabled = busy || loading || stale || !!editor || !viewById(selected);
    const reload = button(uiCopy("Обновить подборки"), 'taskViewReload', () => void reloadViews());
    reload.disabled = busy || loading;
    actions.append(create, edit, reload);
    if (activeAction) {
      const next = actions.querySelector('[data-task-view-' + activeAction + ']');
      if (next && !next.disabled) next.focus({preventScroll:true});
      else if (busy || loading) status.focus({preventScroll:true});
    }
    drawEditor();
  }

  function cancelEditor() {
    if (busy) return;
    const mode = editor?.mode;
    editor = null;
    if (!stale) message = '';
    draw();
    focusEnabled(
      actions.querySelector(mode === 'edit' ? '[data-task-view-edit]' : '[data-task-view-create]'),
      actions.querySelector('[data-task-view-reload]'),
      [...tabs.querySelectorAll('[data-task-view-id]')].find(item => item.dataset.taskViewId === selected),
    );
  }

  function openEditor(mode) {
    if (busy || stale || !snapshot || editor) return;
    const view = mode === 'edit' ? viewById(selected) : null;
    if (mode === 'edit' && !view) return;
    let filters;
    try { filters = taskFilters(state); }
    catch (error) {
      message = uiCopy.format("Нельзя сохранить текущие фильтры: {0}", errorText(error));
      draw();
      return;
    }
    editor = {
      mode, id:view?.id || null, title:view?.title || '',
      filters, base:view ? structuredClone(view) : null,
      confirming:false, targetChanged:false,
    };
    message = '';
    draw();
    editorHost.querySelector('[data-task-view-name]')?.focus();
  }

  async function reloadViews() {
    if (busy || loading || disposed) return;
    const reloadHadFocus = doc.activeElement === actions.querySelector('[data-task-view-reload]');
    loading = true;
    const currentRequest = ++request;
    draw();
    try {
      const result = await readTaskFilterViews(invoke);
      if (disposed || currentRequest !== request) return;
      snapshot = result;
      stale = false;
      if (editor?.mode === 'new' && editor.id && viewById(editor.id)) {
        const exact = same(viewById(editor.id), {
          id:editor.id, title:editor.title.trim(), filters:editor.filters,
        });
        if (exact) {
          selected = editor.id;
          state.taskViewId = selected;
          const filters = editor.filters;
          editor = null;
          onApply(filters);
          message = uiCopy("Подборка уже сохранена.");
        } else {
          editor.targetChanged = true;
          message = uiCopy("Идентификатор черновика уже занят. Отмените правку и создайте подборку заново.");
        }
      } else if (editor?.mode === 'edit' && !same(editor.base, viewById(editor.id))) {
        editor.targetChanged = true;
        message = uiCopy("Эта подборка изменилась или удалена. Отмените правку и откройте её заново.");
      } else {
        if (editor) editor.targetChanged = false;
        message = '';
      }
      if (selected && !['all','active'].includes(selected) && !viewById(selected)) {
        selected = null;
        state.taskViewId = null;
        if (!editor) message = uiCopy("Выбранная подборка удалена. Текущие фильтры сохранены на экране.");
      }
    } catch (error) {
      if (disposed || currentRequest !== request) return;
      stale = true;
      message = uiCopy.format("Не удалось загрузить подборки: {0} Нажмите «Обновить подборки».", errorText(error));
    } finally {
      if (!disposed && currentRequest === request) {
        const restoreReloadFocus = reloadHadFocus && doc.activeElement === status;
        loading = false;
        draw();
        if (restoreReloadFocus) {
          focusEnabled(actions.querySelector('[data-task-view-reload]'));
        }
      }
    }
  }

  async function commit(views, afterSave) {
    if (busy || stale || !snapshot || editor?.targetChanged) return;
    busy = true;
    draw();
    try {
      const result = await saveTaskFilterViews(invoke, { ...snapshot.state, views }, snapshot.raw);
      if (disposed) return;
      snapshot = result;
      stale = false;
      const applied = afterSave();
      editor = null;
      message = '';
      if (applied) onApply(applied);
    } catch (error) {
      if (disposed) return;
      stale = error?.code === 'conflict';
      message = stale
        ? uiCopy("Подборки изменились в другом окне. Нажмите «Обновить подборки»; черновик останется открытым.")
        : uiCopy.format("Не удалось сохранить подборку: {0} Черновик сохранён на экране.", errorText(error));
    } finally {
      if (!disposed) {
        busy = false;
        draw();
        if (editor?.confirming) {
          focusEnabled(editorHost.querySelector('[data-task-view-keep]'), editorHost.querySelector('[data-task-view-name]'));
        } else if (editor) {
          const input = editorHost.querySelector('[data-task-view-name]');
          if (focusEnabled(input) && editor.inputSelection) {
            input.setSelectionRange(editor.inputSelection.start, editor.inputSelection.end);
          }
        } else {
          focusEnabled(
            selected && [...tabs.querySelectorAll('[data-task-view-id]')].find(item => item.dataset.taskViewId === selected),
            actions.querySelector('[data-task-view-create]'),
            actions.querySelector('[data-task-view-reload]'),
          );
        }
      }
    }
  }

  async function saveView() {
    if (!editor || busy || stale || editor.targetChanged) return;
    const title = editor.title.trim();
    if (!title || title.length > VIEW_LIMITS.title) {
      message = uiCopy.format("Укажите название до {0} символов.", VIEW_LIMITS.title);
      draw();
      return;
    }
    const draft = editor;
    const id = draft.id || newTaskFilterViewId(snapshot.state.views.map(view => view.id));
    draft.id = id;
    const view = { id, title, filters:draft.filters };
    const views = draft.mode === 'edit'
      ? snapshot.state.views.map(item => item.id === id ? view : item)
      : [...snapshot.state.views, view];
    await commit(views, () => { selected = id; state.taskViewId = id; return draft.filters; });
  }

  async function removeView() {
    if (!editor || editor.mode !== 'edit' || !editor.confirming || busy || stale || editor.targetChanged) return;
    const id = editor.id;
    await commit(snapshot.state.views.filter(item => item.id !== id), () => {
      selected = null;
      state.taskViewId = null;
      return null;
    });
  }

  void reloadViews();
  return {
    update() { if (!disposed) drawTabs(); },
    dispose() { disposed = true; request++; host.replaceChildren(); },
  };
}
