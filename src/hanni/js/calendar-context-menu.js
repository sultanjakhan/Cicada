// Scoped to record rows: editable controls keep their native text menu.
export function mountCalendarContextMenu(element, options) {
  const document = element.ownerDocument, window = document.defaultView;
  let current = null, disposed = false;
  const editable = target => target?.isContentEditable || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const rowFor = target => target?.closest('[data-context-record]');
  const restore = state => {
    if (!disposed && element.isConnected) {
      if (options.restoreFocus) options.restoreFocus(state.row, state.trigger);
      else if (state.trigger.isConnected) state.trigger.focus();
    }
  };
  function close(returnFocus = true) {
    if (!current) return;
    const state = current; current = null;
    state.observer.disconnect(); state.menu.remove();
    if (state.trigger.hasAttribute('data-record-menu')) state.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', state.outside, true);
    document.removeEventListener('keydown', state.keys, true);
    window.removeEventListener('resize', state.dismiss);
    document.removeEventListener('scroll', state.scroll, true);
    if (returnFocus) restore(state);
  }
  function open(row, trigger, event) {
    const record = options.getRecord(row);
    if (!record) return false;
    const actions = options.getActions(record);
    if (!actions.length) return false;
    close(false);
    const menu = document.createElement('div'); menu.className = 'calendar-record-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Действия: ${record.title}`);
    const error = document.createElement('p'); error.className = 'calendar-record-menu-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const state = { row, trigger, menu, busy: false }; current = state;
    const buttons = actions.map(action => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1;
      button.textContent = action.label; button.dataset.menuAction = action.id;
      button.addEventListener('click', async () => {
        if (state.busy || current !== state) return;
        if (action.dialog) {
          close(false);
          try { await action.run(() => restore(state), () => !disposed && element.isConnected); }
          catch {
            if (!disposed && row.isConnected && open(row, trigger, event)) {
              const notice = current.menu.querySelector('[role=alert]'); notice.textContent = 'Не удалось открыть запись. Повтори действие.'; notice.hidden = false;
            }
          }
          return;
        }
        state.busy = true; menu.setAttribute('aria-busy', 'true'); error.hidden = true;
        buttons.forEach(item => { item.disabled = true; });
        try { await action.run(() => { if (current === state) restore(state); }); if (current === state) close(true); }
        catch { if (current === state) { error.textContent = 'Не удалось выполнить действие. Возможно, задача уже в работе. Обнови запись или повтори.'; error.hidden = false; } }
        finally {
          state.busy = false;
          if (current === state) { menu.removeAttribute('aria-busy'); buttons.forEach(item => { item.disabled = false; }); button.focus(); }
        }
      });
      menu.append(button); return button;
    });
    menu.append(error); document.body.append(menu);
    if (trigger.hasAttribute('data-record-menu')) trigger.setAttribute('aria-expanded', 'true');
    const position = trigger.getBoundingClientRect(), rect = menu.getBoundingClientRect();
    const fromPointer = event.type === 'contextmenu' && (event.clientX || event.clientY);
    const x = fromPointer ? event.clientX : position.left, y = fromPointer ? event.clientY : position.bottom;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    state.dismiss = () => close(true);
    state.outside = e => { if (!menu.contains(e.target)) close(!e.target.closest('button, a, input, textarea, select, [tabindex]')); };
    state.scroll = e => { if (!menu.contains(e.target)) close(true); };
    state.keys = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key === 'Tab') { close(true); return; }
      if (!menu.contains(e.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    state.observer = new window.MutationObserver(() => { if (!trigger.isConnected || !element.isConnected) close(menu.contains(document.activeElement)); });
    state.observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', state.outside, true);
    document.addEventListener('keydown', state.keys, true);
    document.addEventListener('scroll', state.scroll, true);
    window.addEventListener('resize', state.dismiss);
    buttons[0].focus(); return true;
  }
  function handle(event) {
    if (disposed || editable(event.target)) return;
    const row = rowFor(event.target); if (!row || !element.contains(row)) return;
    const more = event.target.closest('[data-record-menu]');
    if (event.type === 'click' && !more) return;
    if (event.type === 'keydown' && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const trigger = more || event.target.closest('button') || row.querySelector('button');
    if (trigger && open(row, trigger, event)) { event.preventDefault(); event.stopPropagation(); }
  }
  for (const name of ['click', 'contextmenu', 'keydown']) element.addEventListener(name, handle);
  const dispose = () => { disposed = true; close(false); for (const name of ['click', 'contextmenu', 'keydown']) element.removeEventListener(name, handle); };
  dispose.close = close;
  return dispose;
}