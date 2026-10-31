import * as T from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { stageFigure } from './figure-studio';
import { createWheel } from './wheel-model';

/** The camera looks at the wheel a little from the left and above, so the
 * face stays readable and the tread shows on one side. */
const view = new T.Vector3(-Math.sin(.42), .12, Math.cos(.42)).normalize();
/** Share of the canvas height the wheel fills. */
const fill = .55;

export async function mountWheelStudio(host: HTMLElement) {
  // A 256 by 128 copy of the home page's studio: the same metal at 105 KB.
  const studioTexture = await new HDRLoader().loadAsync('/engine-studio-256.hdr');
  if (!host.isConnected) { studioTexture.dispose(); return () => {}; }
  let renderer: T.WebGLRenderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
  catch (error) { studioTexture.dispose(); throw error; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  const scene = new T.Scene();
  const model = createWheel();
  model.update(0);
  const studio = stageFigure(renderer, scene, model.root, studioTexture, { animated: true });
  studioTexture.dispose();
  // Face on, the home page's rotation reflects a dark wall; this one puts the softbox behind the camera.
  scene.environmentRotation.y = 3;
  const { center } = studio;
  const height = new T.Box3().setFromObject(model.root).getSize(new T.Vector3()).y;
  const camera = new T.PerspectiveCamera(30, 1, .1, 40);
  const distance = height / 2 / Math.tan(T.MathUtils.degToRad(camera.fov / 2)) / fill;
  camera.position.copy(center).addScaledVector(view, distance);
  camera.lookAt(center);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let visible = false;
  let disposed = false;
  let frame = 0;
  let previous = 0;
  let lastDraw = 0;
  let elapsed = 0;
  function draw(now: number) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    if (now - lastDraw < 1000 / 60 - 1) { frame = requestAnimationFrame(draw); return; }
    lastDraw = now;
    const dt = Math.min((now - previous) / 1000, .05); previous = now;
    if (!motion.matches) elapsed += dt;
    model.update(motion.matches ? 0 : elapsed);
    renderer.render(scene, camera);
    host.classList.add('is-loaded');
    if (!motion.matches) frame = requestAnimationFrame(draw);
  }
  function requestDraw() {
    if (frame || disposed || !visible || document.hidden) return;
    previous = performance.now(); frame = requestAnimationFrame(draw);
  }
  function fit() {
    const { clientWidth: width, clientHeight: height } = renderer.domElement;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix(); requestDraw();
  }
  const resize = new ResizeObserver(fit); resize.observe(renderer.domElement);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestDraw(); else { cancelAnimationFrame(frame); frame = 0; }
  });
  intersection.observe(host);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestDraw();
  }, { signal });
  motion.addEventListener('change', requestDraw, { signal });
  function theme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    studio.setDark(dark); model.setEdge(dark ? .35 : 0); requestDraw();
  }
  const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  fit(); theme();
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); lifetime.abort();
    resize.disconnect(); intersection.disconnect(); themeObserver.disconnect();
    model.dispose(); studio.dispose();
    renderer.dispose(); renderer.domElement.remove(); host.classList.remove('is-loaded');
  }
  // Without the canvas, the page's own 0 shows again.
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); dispose(); }, { signal });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return dispose;
}
