let nextDialog = 0;

/** Native transport and shared presentation only. Callers own data and save/retry state. */
export function createCalendarDialog({ document, title, hint = '', submitLabel = null, returnFocus, isCurrent = () => true, onClose, beforeClose, onPendingChange }) {
  const id = `calendar-editor-${++nextDialog}`;
  const previousFocus = document.activeElement;
  const modal = document.createElement('dialog');
  modal.className = 'calendar-editor-shell calendar-native-dialog';
  modal.setAttribute('aria-labelledby', `${id}-title`);
  modal.setAttribute('aria-describedby', `${id}-hint`);
  modal.innerHTML = `<header class="calendar-editor-header"><div><h2 id="${id}-title"></h2><p id="${id}-hint"></p></div><button type="button" class="calendar-editor-close" data-dialog-close aria-label="Закрыть">×</button></header>
    <form class="calendar-editor-form" novalidate><div class="calendar-editor-body"><fieldset class="calendar-editor-fields"></fieldset></div>
      <div class="calendar-editor-feedback"><p class="calendar-editor-error" data-dialog-error role="alert" hidden></p><button type="button" data-dialog-retry hidden>Повторить</button></div>
      <footer class="calendar-editor-actions"><button type="button" data-dialog-close>Отмена</button>${submitLabel ? '<button type="submit" class="calendar-editor-primary"></button>' : ''}</footer></form>`;
  modal.querySelector('h2').textContent = title;
  modal.querySelector(`#${id}-hint`).textContent = hint;
  const form = modal.querySelector('form'), body = modal.querySelector('fieldset'), error = modal.querySelector('[data-dialog-error]'), retry = modal.querySelector('[data-dialog-retry]');
  const submit = modal.querySelector('[type="submit"]');
  if (submit) submit.textContent = submitLabel;
  let pending = false, disposed = false, restore = true, closing = null, deferFinish = false;
  const api = {
    modal, form, body, error, retry, submit,
    setPending(value) {
      pending = value; body.disabled = value; body.toggleAttribute('inert', value); form.setAttribute('aria-busy', String(value));
      modal.querySelectorAll('[data-dialog-close], [data-dialog-retry], [type="submit"]').forEach(button => { button.disabled = value; });
      if (submit) submit.textContent = value ? 'Сохранение…' : submitLabel;
      onPendingChange?.(value);
    },
    showError(message, field = null) {
      error.textContent = message; error.hidden = !message;
      body.querySelectorAll('[aria-invalid]').forEach(node => { node.removeAttribute('aria-invalid'); node.removeAttribute('aria-describedby'); });
      if (!message || disposed) return;
      error.id = `${id}-error`;
      if (field) { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', error.id); field.focus(); }
      else { error.tabIndex = -1; error.focus(); }
    },
    open(focus = null) { document.body.append(modal); modal.showModal(); (focus || body.querySelector('input,button') || modal.querySelector('[data-dialog-close]')).focus(); },
    close({ skipBeforeClose = false, restoreFocus = true } = {}) {
      if (pending || disposed) return closing;
      if (!restoreFocus) restore = false;
      if (!beforeClose || skipBeforeClose) { modal.close(); return; }
      api.setPending(true);
      const attempt = Promise.resolve().then(() => beforeClose()).then(() => {
        if (!disposed && !deferFinish) { api.setPending(false); modal.close(); }
      }).catch(error => { if (!disposed && !deferFinish) { api.setPending(false); api.showError(error?.message || 'Не удалось сохранить черновик. Повтори закрытие.'); } });
      closing = attempt;
      void attempt.finally(() => { if (closing === attempt) closing = null; });
      return attempt;
    },
    dispose() {
      if (disposed) return;
      restore = false;
      if (!beforeClose) { if (modal.open) modal.close(); else finish(); return; }
      deferFinish = true; api.setPending(true);
      // Release the native top layer immediately, retaining editor DOM until capture completes.
      const captured = closing || Promise.resolve().then(() => beforeClose());
      if (modal.open) modal.close();
      return captured.catch(() => {}).finally(() => finish(true));
    },
    get pending() { return pending; },
  };
  function finish(force = false) {
    if (disposed || (deferFinish && force !== true)) return;
    disposed = true;
    const focused = document.activeElement;
    const outside = focused !== document.body && focused !== previousFocus && !modal.contains(focused);
    modal.remove(); onClose?.();
    if (restore && isCurrent() && !outside) {
      if (returnFocus) returnFocus(); else if (previousFocus?.isConnected) previousFocus.focus();
    }
  }
  modal.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => api.close()));
  // Forms inside the shell never navigate, including Enter in a picker search field.
  form.addEventListener('submit', event => event.preventDefault());
  modal.addEventListener('cancel', event => { event.preventDefault(); api.close(); });
  modal.addEventListener('close', finish, { once: true });
  return api;
}