const host = document.querySelector<HTMLElement>('[data-drive-model-host]');
if (host) {
  let disposed = false;
  let cleanup: (() => void) | undefined;
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    void import('./drive-studio').then(async ({ mountDriveStudio }) => {
      if (disposed) return;
      const dispose = await mountDriveStudio(host);
      if (disposed) dispose();
      else cleanup = dispose;
    }).catch(error => {
      if (disposed) return;
      const status = host.querySelector<HTMLElement>('[role="status"]');
      if (status) status.textContent = 'The 3D preview could not load. Refresh to try again.';
      console.error('Unable to load the drivetrain model', error);
    });
  }, { rootMargin: '200px' });
  observer.observe(host);
  if (import.meta.hot) import.meta.hot.dispose(() => { disposed = true; observer.disconnect(); cleanup?.(); });
}
