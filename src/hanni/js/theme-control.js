// Uses the existing device preference; changing appearance never touches sync.
export function mountThemeControl(host, { getTheme, setTheme }) {
  const document = host.ownerDocument, window = document.defaultView;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'calendar-theme-control';
  button.dataset.homeTheme = '';
  const render = () => {
    const dark = getTheme() === 'dark';
    const en = document.documentElement.lang.startsWith('en');
    button.title = en ? (dark ? 'Switch to light theme' : 'Switch to dark theme') : (dark ? 'Включить светлую тему' : 'Включить тёмную тему');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(dark));
    button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" focusable="false">${dark ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10l2 2M5 19l2-2M17 7l2-2"/>' : '<path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z"/>'}</svg>`;
  };
  button.addEventListener('click', () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); render(); });
  window.addEventListener('hanni:theme-changed', render);
  host.append(button); render();
  return () => { window.removeEventListener('hanni:theme-changed', render); button.remove(); };
}

// Relocate the existing control, retaining its listeners and saved preference.
export function placeThemeControlNextToToday(root, todayControl) {
  const button=root.querySelector('[data-home-theme]');
  if(button&&todayControl)todayControl.after(button);
}
