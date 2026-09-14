export function mountSyncConflicts(element, { invoke, setPending = () => {}, isBlocked = () => false }) {
  const document = element.ownerDocument, window = document.defaultView;
  let disposed = false, busy = false, request = 0, offset = 0, total = 0, entries = [], selected = null;
  element.classList.add('calendar-sync-conflicts');
  element.innerHTML = `<p class="calendar-sync-hint">Сравни названия и фрагменты полей перед выбором. Выбор текущей версии закрывает только эту запись на этом устройстве.</p>
    <p data-conflicts-message role="status" aria-live="polite"></p>
    <div class="calendar-sync-actions"><button type="button" data-conflicts-refresh>Обновить список</button><button type="button" data-conflicts-back hidden>К списку</button></div>
    <ol data-conflicts-list></ol><section data-conflicts-detail hidden></section>
    <div class="calendar-sync-actions" data-conflicts-pages><button type="button" data-conflicts-previous>Назад</button><span data-conflicts-page></span><button type="button" data-conflicts-next>Далее</button></div>`;
  const q = name => element.querySelector(`[data-conflicts-${name}]`);
  const reasons = {
    mvp_sync_conflict_deleted:'Запись уже удалена. Сохранённая версия не может отменить удаление.',
    mvp_sync_conflict_identity:'Версии относятся к разным записям. Замена недоступна.',
    content_sync_parent_missing:'Связанная задача или цель ещё не получена. Обнови список после синхронизации.',
    content_sync_dependent_records:'У записи есть связанные задачи или цели. Сначала обнови их связи.',
    content_sync_goal_cycle:'Такая связь создаст замкнутую цепочку целей. Выбери другую родительскую цель.',
    content_sync_invalid_parent:'Выбранная родительская цель не поддерживает эту связь.',
    mvp_sync_conflict_active_timer:'Сначала приостанови текущую задачу, затем обнови список.',
    mvp_sync_conflict_execution:'Сохранённая версия содержит старый запуск задачи. Автоматическая замена недоступна.',
    mvp_sync_conflict_unknown:'Формат записи пока не поддерживается. Доступен только просмотр.',
  };
  function setBusy(value) { busy = value; setPending(value); for (const button of element.querySelectorAll('button')) button.disabled = value; if (!value) renderButtons(); }
  function renderButtons() {
    q('previous').disabled = busy || offset === 0;
    q('next').disabled = busy || offset + entries.length >= total;
    if (selected) {
      q('keep').disabled = busy || !selected.can_keep_current;
      q('use').disabled = busy || !selected.can_use_incoming;
    }
  }
  function message(text, error = false) { q('message').textContent = text; q('message').classList.toggle('calendar-sync-conflicts__error', error); }
  function preview(title, value) {
    const box = document.createElement('div'), heading = document.createElement('h5'); heading.textContent = title; box.append(heading);
    const states = { absent:'Записи нет на этом устройстве.', deleted:'Запись удалена.', unknown:'Эту версию нельзя безопасно отобразить.' };
    if (states[value?.state]) { const state = document.createElement('p'); state.textContent = states[value.state]; box.append(state); }
    else if (!value?.fields?.length) { const state = document.createElement('p'); state.textContent = 'Настройки или связи записи.'; box.append(state); }
    for (const field of value?.fields || []) {
      const line = document.createElement('p'), label = document.createElement('strong'), content = document.createElement('span');
      label.textContent = `${field.label}: `; content.textContent = field.value; line.append(label, content); box.append(line);
    }
    const updated = value?.updated_at ? new Date(value.updated_at) : null;
    if (updated && Number.isFinite(updated.getTime())) { const time = document.createElement('p'); time.className = 'calendar-sync-hint'; time.textContent = `Изменено: ${updated.toLocaleString('ru-RU')}`; box.append(time); }
    return box;
  }
  function show(item) {
    selected = item; q('list').hidden = true; q('pages').hidden = true; q('back').hidden = false; q('detail').hidden = false; q('detail').replaceChildren();
    const heading = document.createElement('h4'); heading.textContent = item.label; q('detail').append(heading);
    const comparison = document.createElement('div'); comparison.className = 'calendar-sync-conflicts__comparison';
    comparison.append(preview('На этом устройстве', item.current), preview(item.source === 'pending' ? 'Входящая версия' : 'Сохранённая версия', item.incoming)); q('detail').append(comparison);
    if (item.reason) { const reason = document.createElement('p'); reason.className = 'calendar-sync-hint'; reason.textContent = reasons[item.reason] || 'Эту версию пока нельзя безопасно применить. Обнови список после синхронизации.'; q('detail').append(reason); }
    const actions = document.createElement('div'); actions.className = 'calendar-sync-actions';
    for (const [name, label, choice] of [['keep','Оставить текущее','current'],['use','Использовать эту версию','incoming']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset[`conflicts${name[0].toUpperCase()}${name.slice(1)}`] = ''; button.textContent = label; button.onclick = () => void resolve(choice); actions.append(button);
    }
    q('detail').append(actions); message(''); renderButtons();
  }
  function renderList() {
    selected = null; q('detail').hidden = true; q('detail').replaceChildren(); q('back').hidden = true; q('list').hidden = false; q('pages').hidden = total <= 25; q('list').replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('li'), button = document.createElement('button'), hint = document.createElement('span');
      button.type = 'button'; button.textContent = entry.label; button.onclick = () => show(entry); hint.textContent = entry.source === 'pending' ? 'Ожидает безопасного применения' : 'Сохранена альтернативная версия'; row.append(button, hint); q('list').append(row);
    }
    q('page').textContent = total ? `${offset + 1}–${offset + entries.length} из ${total}` : '';
    renderButtons();
  }
  async function refresh({ preserveMessage = false } = {}) {
    if (disposed || busy || isBlocked()) return;
    const own = ++request; setBusy(true); if (!preserveMessage) message('Загружаем версии…');
    try {
      const result = await invoke('mvp_sync_conflicts_list', { offset, limit:25 });
      if (disposed || own !== request) return;
      if (!result || !Array.isArray(result.entries) || !Number.isSafeInteger(result.total)) throw Error('invalid list');
      entries = result.entries; total = result.total; renderList(); if (!preserveMessage) message(total ? `Сохранено версий: ${total}` : 'Неразобранных версий нет.');
    } catch { if (!disposed && own === request) message('Не удалось загрузить версии. Попробуй ещё раз.', true); }
    finally { if (!disposed && own === request) setBusy(false); }
  }
  async function resolve(choice) {
    if (disposed || busy || isBlocked() || !selected) return;
    const chosen = selected;
    if (choice === 'incoming' ? !chosen.can_use_incoming : !chosen.can_keep_current) return;
    const own = ++request; setBusy(true); message('Сохраняем выбор…');
    try {
      const result = await invoke('mvp_sync_conflict_resolve', { token:chosen.token, expected:chosen.expected, choice });
      if (disposed || own !== request) return;
      if (result?.resolved !== true) throw Error('unconfirmed');
      message(choice === 'incoming' ? 'Выбранная версия сохранена. Изменение ожидает синхронизации.' : 'Текущая версия сохранена.');
      selected = null; offset = 0; window.dispatchEvent(new window.Event('hanni:sync-check-status'));
      setBusy(false); await refresh({ preserveMessage:true });
    } catch (error) {
      if (!disposed && own === request) {
        const stale = typeof error === 'string' ? error === 'mvp_sync_conflict_stale' : error?.message === 'mvp_sync_conflict_stale';
        message(stale ? 'Запись изменилась, пока ты сравнивал версии. Обнови список и выбери заново.' : 'Не удалось применить выбор. Записи сохранены; обнови список.', true);
        if (selected) selected = { ...selected, can_keep_current:false, can_use_incoming:false };
      }
    } finally { if (!disposed && own === request) setBusy(false); }
  }
  q('refresh').onclick = () => void refresh(); q('back').onclick = () => { if (!busy) { renderList(); message(''); } };
  q('previous').onclick = () => { offset = Math.max(0, offset - 25); void refresh(); };
  q('next').onclick = () => { offset += 25; void refresh(); };
  renderButtons();
  return { refresh, dispose() { disposed = true; ++request; if (busy) setPending(false); } };
}
