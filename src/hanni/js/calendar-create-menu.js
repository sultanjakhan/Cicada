import { ICONS } from './icons.js';

const choices = [
  ['task', 'Задача', 'Конкретное дело', ICONS.check],
  ['event', 'Событие', 'Встреча или время в календаре', ICONS.calendar],
  ['goal', 'Цель', 'Результат, к которому идёшь', ICONS.flag],
  ['note', 'Заметка', 'Мысль или детали на потом', ICONS.note],
  ['wish', 'Желание', 'То, чего хочется, без обязательств', ICONS.heart],
  ['routine', 'Рутина', 'Повторяющееся дело или шаги', ICONS.cycle],
];
let sequence = 0;

export function openCalendarCreateMenu(trigger, { onSelect, initialKind = 'task', isCurrent = () => true, onClose } = {}) {
  const document = trigger.ownerDocument, window = document.defaultView;
  let closed = false;
  const menu = document.createElement('div'); menu.className = 'calendar-create-menu';
  menu.id = `calendar-create-menu-${++sequence}`; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Что создать');
  const buttons = choices.map(([kind, label, hint, icon]) => {
    const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
    button.setAttribute('role', 'menuitem'); button.dataset.createKind = kind;
    button.innerHTML = `<span class="calendar-create-menu__icon" aria-hidden="true">${icon}</span><span><strong>${label}</strong><small>${hint}</small></span>`;
    button.addEventListener('click', () => {
      if (!isCurrent() || !trigger.isConnected) { close(false); return; }
      close(false); onSelect?.(kind);
    });
    menu.append(button); return button;
  });
  function close(restore = true) {
    if (closed) return;
    closed = true; observer.disconnect(); menu.remove();
    trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-controls');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize);
    if (restore && trigger.isConnected && isCurrent()) trigger.focus({ preventScroll:true });
    onClose?.();
  }
  function keys(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!menu.contains(event.target) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
  const outside = event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(false); };
  const scroll = event => { if (!menu.contains(event.target)) close(); };
  const resize = () => close();
  const observer = new window.MutationObserver(() => { if (!trigger.isConnected || !isCurrent()) close(false); });
  document.body.append(menu);
  const anchor = trigger.getBoundingClientRect(), rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8))}px`;
  trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', menu.id);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keys, true);
  document.addEventListener('scroll', scroll, true); window.addEventListener('resize', resize);
  observer.observe(document.body, { childList:true, subtree:true });
  (buttons.find(button => button.dataset.createKind === initialKind) || buttons[0]).focus({ preventScroll:true });
  return close;
}
