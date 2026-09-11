export function mountCalendarGridViewport(host) {
  const viewport = host.closest('.uni-content');
  const win = host.ownerDocument.defaultView;
  let frame = null;
  let observedSticky = null;
  function fit() {
    const grid = host.querySelector('.calv-time-scroll');
    const sticky = grid?.querySelector('.calv-time-sticky');
    if (sticky !== observedSticky) {
      if (observedSticky) observer?.unobserve(observedSticky);
      if (sticky) observer?.observe(sticky);
      observedSticky = sticky;
    }
    if (!grid || !viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const rect = grid.getBoundingClientRect();
    if (!bounds.height || !rect.width) return;
    // Outer scrolling must not resize its own content and move the scroll boundary.
    const top = rect.top + viewport.scrollTop;
    let bottom = Math.min(win.innerHeight, bounds.bottom);
    const launcher = host.ownerDocument.querySelector('.task-widget')?.getBoundingClientRect();
    if (launcher?.height && launcher.right > rect.left && launcher.left < rect.right && launcher.top > top) {
      bottom = Math.min(bottom, launcher.top);
    }
    const stickyHeight = sticky?.getBoundingClientRect().height || 0;
    // Keep at least one hour below sticky rows; the outer pane can scroll in small windows.
    const minimum = Math.min(bounds.height, stickyHeight + 80);
    const height = Math.round(Math.max(minimum, Math.min(bounds.height, bottom - top - 12)));
    const value = `${height}px`;
    if (grid.style.maxHeight !== value) grid.style.maxHeight = value;
  }
  function schedule() {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => { frame = null; fit(); });
  }
  const observer = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  observer?.observe(host);
  if (viewport) observer?.observe(viewport);
  const launcher = host.ownerDocument.querySelector('.task-widget');
  if (launcher) observer?.observe(launcher);
  win.addEventListener('resize', schedule);
  return {
    fit,
    dispose() {
      observer?.disconnect();
      win.removeEventListener('resize', schedule);
      if (frame !== null) win.cancelAnimationFrame(frame);
    },
  };
}