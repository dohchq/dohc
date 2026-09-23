import * as T from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDifferential } from './drive-models';
import { stageFigure } from './figure-studio';

export async function mountDriveStudio(host: HTMLElement) {
  // Share the hero's CC0 Poly Haven studio for a consistent metal finish.
  const studioTexture = await new HDRLoader().loadAsync('/engine-studio.hdr');
  if (!host.isConnected) { studioTexture.dispose(); return () => {}; }
  let renderer: T.WebGLRenderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
  catch (error) { studioTexture.dispose(); throw error; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  const scene = new T.Scene();
  const model = createDifferential();
  model.update(0);
  const studio = stageFigure(renderer, scene, model.root, studioTexture, { animated: true });
  studioTexture.dispose();
  const { center, radius } = studio;
  const camera = new T.PerspectiveCamera(33, 1, .1, 70);
  camera.position.copy(center).add(new T.Vector3(5, 4.4, 6));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.enableZoom = false;
  controls.enableDamping = false; controls.rotateSpeed = .65;
  controls.minPolarAngle = .15; controls.maxPolarAngle = Math.PI * .85;
  controls.target.copy(center);
  renderer.domElement.style.touchAction = 'pan-y';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Cutaway differential and driveshaft 3D model. Drag or use arrow keys to rotate. Hold to pause.');
  host.append(renderer.domElement);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let visible = false;
  let held = false;
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
    if (!motion.matches && !held) { elapsed += dt; model.update(elapsed); }
    renderer.render(scene, camera);
    if (!motion.matches && !held) frame = requestAnimationFrame(draw);
  }
  function requestDraw() {
    if (frame || disposed || !visible || document.hidden) return;
    previous = performance.now(); frame = requestAnimationFrame(draw);
  }
  function fit() {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const halfFov = T.MathUtils.degToRad(camera.fov / 2);
    const limitingFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
    camera.position.sub(center).normalize().multiplyScalar(radius / Math.sin(limitingFov) * .83).add(center);
    camera.updateProjectionMatrix(); controls.update(); requestDraw();
  }
  controls.addEventListener('start', () => { held = true; requestDraw(); });
  controls.addEventListener('end', () => { held = false; requestDraw(); });
  controls.addEventListener('change', requestDraw);
  renderer.domElement.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const spherical = new T.Spherical().setFromVector3(camera.position.clone().sub(center));
    if (event.key === 'ArrowLeft') spherical.theta -= .15;
    if (event.key === 'ArrowRight') spherical.theta += .15;
    if (event.key === 'ArrowUp') spherical.phi = Math.max(controls.minPolarAngle, spherical.phi - .15);
    if (event.key === 'ArrowDown') spherical.phi = Math.min(controls.maxPolarAngle, spherical.phi + .15);
    camera.position.copy(center).add(new T.Vector3().setFromSpherical(spherical)); controls.update(); requestDraw();
  }, { signal });
  const resize = new ResizeObserver(fit); resize.observe(host);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestDraw(); else { cancelAnimationFrame(frame); frame = 0; }
  });
  intersection.observe(host);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestDraw();
  }, { signal });
  motion.addEventListener('change', requestDraw, { signal });
  function theme() { studio.setDark(document.documentElement.dataset.theme === 'dark'); requestDraw(); }
  const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  fit(); theme(); host.classList.add('is-loaded');
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); lifetime.abort();
    resize.disconnect(); intersection.disconnect(); themeObserver.disconnect(); controls.dispose();
    model.dispose(); studio.dispose();
    renderer.dispose(); renderer.domElement.remove(); host.classList.remove('is-loaded');
  }
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); dispose();
    const status = host.querySelector<HTMLElement>('[role="status"]');
    if (status) status.textContent = 'The 3D preview stopped. Refresh to try again.';
  }, { signal });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return dispose;
}
