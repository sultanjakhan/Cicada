// Manual field transfer follows the maintainer's documented LeechBlock options:
// https://www.proginosko.com/leechblock/documentation/
// https://www.proginosko.com/leechblock/examples/
// No extension detection, external commands, timer writes or application of rules.
export const FOCUS_ADAPTER_KEY = 'cicada_focus_adapter_local_v1';
export const emptyFocusConfig = () => ({ version: 1, platform: 'windows-firefox', sites: '', exceptions: '', times: '', days: [] });
const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validateFocusConfig(value, complete = false) {
  if (!value || Object.keys(value).sort().join() !== 'days,exceptions,platform,sites,times,version' || value.version !== 1 || !['windows-firefox', 'unsupported'].includes(value.platform)) throw Error('Неподдерживаемый формат настроек. Сохранение заблокировано.');
  for (const key of ['sites', 'exceptions']) {
    if (typeof value[key] !== 'string' || value[key].length > 4096 || value[key].split(/\s+/).filter(Boolean).some(site => !domain.test(site))) throw Error('Введи домены через пробел, без https://, путей и шаблонов.');
  }
  if (typeof value.times !== 'string' || value.times.length > 200 || (value.times && !value.times.split(',').every(period => {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(period);
    if (!m) return false;
    const [, h, m1, h2, m2] = m.map(Number);
    return h < 24 && m1 < 60 && h2 <= 24 && m2 < 60 && (h2 !== 24 || m2 === 0) && h * 60 + m1 < h2 * 60 + m2;
  }))) throw Error('Расписание: 0900-1200,1300-1700. Ночной период раздели у полуночи.');
  if (!Array.isArray(value.days) || value.days.length > 7 || value.days.some((day, i) => !Number.isInteger(day) || day < 0 || day > 6 || (i && day <= value.days[i - 1]))) throw Error('Неверные дни недели.');
  if (complete && (!value.sites.trim() || !value.exceptions.trim() || !value.times || !value.days.length)) throw Error('Укажи сайты, расписание, дни и исключения для связи перед экспортом.');
  return value;
}

export function focusRecipe(value) {
  validateFocusConfig(value, true);
  if (value.platform !== 'windows-firefox') throw Error('Эта платформа не поддерживается этим адаптером.');
  return `LeechBlock NG · Firefox / Windows · ручная настройка\nПодготовлено в Cicada. Не применено; защита не проверена.\nЭто инструкция для переноса полей, НЕ файл Import Options.\n\n1. В LeechBlock Options → General → Export сохрани резервную копию.\n2. Выбери отдельный неиспользуемый Block Set. Не заменяй другие наборы.\n3. What to Block — по одному значению на строку:\n${value.sites.trim().split(/\s+/).join('\n')}\n${value.exceptions.trim().split(/\s+/).map(site => '+' + site).join('\n')}\n\n4. When to Block → time periods: ${value.times}\nДни (локальное время браузера): ${value.days.map(day => DAYS[day]).join(', ')}\nTime limit: оставить пустым. Условие: within time periods OR after time limit.\n5. Не включай запрет доступа к Options, пароли или Lockdown. Проверь исключения для рабочей связи.\n6. Только отдельное действие Save Options в расширении применяет правила. Cicada этого не делает.\n7. В выбранном браузере проверь запрещённый сайт и все разрешённые каналы связи во время расписания; другие наборы могут перекрывать исключения. Приватные окна и другие браузеры не проверены.\nОтмена: очисти sites только этого набора и нажми Save Options либо восстанови резервную копию.\nПриложения, ОС, Android/iPad и лента внутри разрешённого сайта не управляются.\nДокументация: https://www.proginosko.com/leechblock/documentation/\n`;
}

export function mountFocusAdapterSettings(host, { invoke, setPending = () => {}, onDirty = () => {} }) {
  const d = host.ownerDocument;
  let disposed = false, busy = false, ready = false, raw = '', saved = null;
  const root = d.createElement('details'); root.className = 'data-source-settings'; root.dataset.focusAdapter = '';
  const heading = d.createElement('summary'); heading.textContent = 'Фокус: сайты в браузере';
  const hint = d.createElement('p'); hint.textContent = 'LeechBlock NG · ручная настройка. Наличие расширения неизвестно. Сохранение и экспорт не включают защиту и не меняют задачу или таймер. Приложения и другие устройства не управляются.';
  const fields = d.createElement('fieldset'); fields.className = 'data-source-setting';
  const legend = d.createElement('legend'); legend.textContent = 'Локальная конфигурация'; fields.append(legend);
  const inputs = {};
  function field(key, title, type = 'input') {
    const label = d.createElement('label'); label.className = 'data-source-field'; label.textContent = title;
    const input = d.createElement(type); input.dataset.focusField = key;
    if (type === 'input') { input.type = 'text'; input.maxLength = key === 'times' ? 200 : 4096; }
    label.append(input); fields.append(label); inputs[key] = input; return input;
  }
  const platform = field('platform', 'Поддержка', 'select');
  for (const [value, text] of [['windows-firefox', 'Windows · Firefox · вручную'], ['unsupported', 'Другая платформа · не поддерживается']]) { const option = d.createElement('option'); option.value = value; option.textContent = text; platform.append(option); }
  field('sites', 'Блокируемые домены (через пробел)');
  field('exceptions', 'Домены для связи — всегда разрешать в этом наборе');
  field('times', 'Время браузера: HHMM-HHMM, например 0900-1200');
  const days = d.createElement('fieldset'), dayTitle = d.createElement('legend'); dayTitle.textContent = 'Дни недели'; days.append(dayTitle);
  const checks = DAYS.map((text, day) => { const label = d.createElement('label'), input = d.createElement('input'); input.type = 'checkbox'; input.dataset.focusDay = day; label.className = 'calendar-settings-toggle'; label.append(input, d.createTextNode(text)); days.append(label); return input; }); fields.append(days);
  const actions = d.createElement('div'); actions.className = 'calendar-sync-actions';
  function button(key, text) { const b = d.createElement('button'); b.type = 'button'; b.dataset.focusAction = key; b.textContent = text; actions.append(b); return b; }
  const save = button('save', 'Сохранить конфигурацию'), reload = button('reload', 'Загрузить сохранённое'), exportButton = button('export', 'Подготовить инструкцию');
  const status = d.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const preview = d.createElement('pre'); preview.hidden = true;
  const download = d.createElement('a'); download.textContent = 'Скачать инструкцию .txt'; download.download = 'cicada-leechblock-manual.txt'; download.hidden = true;
  root.append(heading, hint, fields, actions, status, preview, download); host.append(root);
  const readForm = () => ({version: 1, platform: platform.value, sites: inputs.sites.value, exceptions: inputs.exceptions.value, times: inputs.times.value, days: checks.flatMap((input, day) => input.checked ? [day] : [])});
  const isDirty = () => saved !== null && JSON.stringify(readForm()) !== JSON.stringify(saved);
  function clearExport() { preview.hidden = download.hidden = true; download.removeAttribute('href'); }
  function controls() { fields.disabled = busy || !ready; save.disabled = busy || !ready; reload.disabled = confirmReload.disabled = busy; exportButton.disabled = busy || !ready || isDirty() || platform.value !== 'windows-firefox'; }
  function pending(value) { busy = value; setPending(value); controls(); }
  function paint(value) { for (const key of ['platform', 'sites', 'exceptions', 'times']) inputs[key].value = value[key]; checks.forEach((input, day) => { input.checked = value.days.includes(day); }); }
  fields.addEventListener('input', () => { confirmReload.hidden = true; clearExport(); controls(); status.textContent = platform.value === 'unsupported' ? 'Платформа не поддерживается. Можно сохранить черновик; экспорт недоступен. Защита не проверена.' : 'Черновик изменён. Защита не применена и не проверена.'; onDirty(); });
  async function load() {
    if (busy || disposed) return;
    pending(true); status.textContent = 'Загружаем конфигурацию…';
    try { const value = await invoke('get_ui_state', {key: FOCUS_ADAPTER_KEY}); const config = value ? validateFocusConfig(JSON.parse(value)) : emptyFocusConfig(); if (disposed) return; raw = value ?? ''; saved = config; paint(config); ready = true; clearExport(); status.textContent = `${raw ? 'Конфигурация загружена.' : 'Конфигурация ещё не сохранена.'} ${config.platform === 'unsupported' ? 'Платформа не поддерживается.' : 'Режим ручной.'} Применение не подтверждено; защита не проверена.`; }
    catch { if (!disposed) status.textContent = 'Загрузка не удалась. Черновик сохранён в форме; повтори загрузку. Неизвестные данные не перезаписаны.'; }
    finally { if (!disposed) { pending(false); onDirty(); } }
  }
  reload.addEventListener('click', () => { if (isDirty()) { status.textContent = 'Загрузка заменит черновик. Нажми «Отменить черновик и загрузить» для подтверждения.'; confirmReload.hidden = false; } else void load(); });
  const confirmReload = button('discard', 'Отменить черновик и загрузить'); confirmReload.hidden = true;
  confirmReload.addEventListener('click', () => { confirmReload.hidden = true; void load(); });
  save.addEventListener('click', async () => {
    if (!ready || busy) return;
    let next; try { next = validateFocusConfig(readForm()); } catch (error) { status.textContent = error.message; return; }
    pending(true); clearExport(); const value = JSON.stringify(next);
    try { await invoke('set_ui_state', {key: FOCUS_ADAPTER_KEY, value, expectedValue: raw}); const actual = await invoke('get_ui_state', {key: FOCUS_ADAPTER_KEY}); if (actual !== value) throw Error('readback'); if (disposed) return; raw = value; saved = next; status.textContent = 'Сохранено и перечитано на этом устройстве. Не применено; защита не проверена.'; }
    catch { if (!disposed) { ready = false; status.textContent = 'Сохранение не подтверждено. Черновик остался в форме. Загрузи сохранённое перед повторной записью; ограничения не применялись.'; } }
    finally { if (!disposed) { pending(false); onDirty(); } }
  });
  exportButton.addEventListener('click', () => { try { const text = focusRecipe(saved); preview.textContent = text; preview.hidden = download.hidden = false; download.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text); status.textContent = 'Инструкция подготовлена. Это не импорт настроек; перенеси поля вручную. Защита не проверена.'; } catch (error) { status.textContent = error.message; } });
  controls(); void load();
  const dispose = () => { disposed = true; };
  dispose.isDirty = () => saved !== null && JSON.stringify(readForm()) !== JSON.stringify(saved);
  return dispose;
}
