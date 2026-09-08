import type { EngineWorkerRequest, EngineWorkerResponse } from './engine-worker-types';

export function mountEngine(host: HTMLElement) {
  const canvas = document.createElement('canvas');
  if (!canvas.transferControlToOffscreen || typeof Worker === 'undefined') return;
  const worker = new Worker(new URL('./engine-renderer.worker.ts', import.meta.url), { type: 'module' });
  const send = (message: EngineWorkerRequest) => worker.postMessage(message);
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let theta = Math.atan2(10, 7);
  let phi = Math.atan2(Math.hypot(10, 7), 6.5);
  const clampPhi = (value: number) => Math.max(.2, Math.min(Math.PI * .8, value));
  canvas.style.touchAction = 'pan-y';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'DOHC inline-six engine model. Grab and hold to pause. Drag or use arrow keys to rotate.');
  host.append(canvas);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let ready = false, presented = false, disposed = false, visible = true, dragging = false;
  let frame = 0, last = 0, lastDraw = 0;
  let width = host.clientWidth, height = host.clientHeight;

  function draw(now: number) {
    frame = 0;
    if (!ready || disposed || !visible || document.hidden || !width || !height) return;
    if (now - lastDraw < 1000 / 60 - 1) { frame = requestAnimationFrame(draw); return; }
    lastDraw = now;
    if (presented && !motion.matches && !dragging) theta -= Math.PI * 2 / 60 * .28 * Math.min((now - last) / 1000, .05);
    last = now;
    send({ type: 'view', view: { width, height, theta, phi } });
    if (presented && !motion.matches && !dragging) frame = requestAnimationFrame(draw);
  }
  function requestDraw() {
    if (!frame && ready && !disposed && visible && !document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
  }
  function fit() {
    width = host.clientWidth; height = host.clientHeight;
    if (!width || !height || !ready) return;
    requestDraw();
  }
  function syncVisibility() {
    send({ type: 'visible', visible: visible && !document.hidden });
    if (visible && !document.hidden) requestDraw();
    else { cancelAnimationFrame(frame); frame = 0; }
  }
  const resize = new ResizeObserver(fit); resize.observe(host);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; syncVisibility(); });
  intersection.observe(host);
  document.addEventListener('visibilitychange', syncVisibility, { signal });
  motion.addEventListener('change', requestDraw, { signal });
  let pointer: { id: number; x: number; y: number } | undefined;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    dragging = true;
    requestDraw();
  }, { signal });
  canvas.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const scale = Math.PI * 2 * .65 / Math.max(height, 1);
    theta -= (event.clientX - pointer.x) * scale;
    phi = clampPhi(phi - (event.clientY - pointer.y) * scale);
    pointer.x = event.clientX; pointer.y = event.clientY;
    requestDraw();
  }, { signal });
  const release = (event: PointerEvent) => {
    if (event.pointerId !== pointer?.id) return;
    pointer = undefined;
    dragging = false;
    requestDraw();
  };
  canvas.addEventListener('pointerup', release, { signal });
  canvas.addEventListener('pointercancel', release, { signal });
  canvas.addEventListener('lostpointercapture', release, { signal });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') theta -= .12;
    if (event.key === 'ArrowRight') theta += .12;
    if (event.key === 'ArrowUp') phi = clampPhi(phi - .12);
    if (event.key === 'ArrowDown') phi = clampPhi(phi + .12);
    requestDraw();
  }, { signal });
  worker.addEventListener('message', ({ data }: MessageEvent<EngineWorkerResponse>) => {
    if (disposed) return;
    if (data.type === 'ready') {
      ready = true;
      fit();
    } else if (data.type === 'rendered') {
      presented = true;
      host.classList.add('engine-loaded');
      requestDraw();
    }
    else {
      console.error('Unable to render the dohc engine', data.message, data.stack ?? '');
      dispose();
    }
  }, { signal });
  worker.addEventListener('error', event => {
    console.error('Unable to render the dohc engine', event.error ?? event.message, event.filename, event.lineno, event.colno);
    dispose();
  }, { signal });
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: 'init', canvas: offscreen, pixelRatio: Math.min(devicePixelRatio, 1.75), studioUrl: new URL('/engine-studio.hdr', location.href).href } satisfies EngineWorkerRequest, [offscreen]);

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    lifetime.abort();
    resize.disconnect(); intersection.disconnect();
    worker.terminate(); canvas.remove();
    host.classList.remove('engine-loaded');
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return dispose;
}
