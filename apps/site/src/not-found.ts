const path = document.querySelector<HTMLElement>('[data-missing-path]');
if (path && location.pathname !== '/') {
  let shown = location.pathname;
  try { shown = decodeURI(shown); } catch { /* Keep the encoded path. */ }
  path.textContent = shown;
  path.classList.add('not-found-path');
}

// The wheel draws over the page's own 0, which stays if WebGL is missing.
const host = document.querySelector<HTMLElement>('[data-wheel-host]');
if (host) {
  let disposed = false;
  let cleanup: (() => void) | undefined;
  void import('./wheel-studio').then(async ({ mountWheelStudio }) => {
    if (disposed) return;
    const dispose = await mountWheelStudio(host);
    if (disposed) dispose();
    else cleanup = dispose;
  }).catch(error => {
    if (!disposed) console.error('Unable to load the wheel model', error);
  });
  if (import.meta.hot) import.meta.hot.dispose(() => { disposed = true; cleanup?.(); });
}
