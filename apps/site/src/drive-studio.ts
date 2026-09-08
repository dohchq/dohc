import * as T from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createDifferential } from './drive-models';

export async function mountDriveStudio(host: HTMLElement) {
  // Share the hero's CC0 Poly Haven studio for a consistent metal finish.
  const studio = await new HDRLoader().loadAsync('/engine-studio.hdr');
  if (!host.isConnected) { studio.dispose(); return () => {}; }
  let renderer: T.WebGLRenderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
  catch (error) { studio.dispose(); throw error; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.VSMShadowMap;
  const scene = new T.Scene();
  const pmrem = new T.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(studio);
  studio.dispose(); pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = .95;
  scene.environmentRotation.y = .7;
  const camera = new T.PerspectiveCamera(33, 1, .1, 70);
  camera.position.set(5, 7, 7);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.enableZoom = false;
  controls.enableDamping = false; controls.rotateSpeed = .65;
  controls.minPolarAngle = .15; controls.maxPolarAngle = Math.PI * .85;
  renderer.domElement.style.touchAction = 'pan-y';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('role', 'img');
  host.append(renderer.domElement);
  scene.add(new T.HemisphereLight(0xe9efff, 0x887f73, .55));
  const key = new T.DirectionalLight(0xfff7ee, 2.3);
  key.position.set(-3, 8, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: .1, far: 25 });
  key.shadow.camera.updateProjectionMatrix(); key.shadow.normalBias = .035;
  key.shadow.bias = -.00015;
  key.shadow.radius = 6; key.shadow.blurSamples = 12;
  scene.add(key);
  const fill = new T.DirectionalLight(0xe3ecff, .8); fill.position.set(4, 3, -5); scene.add(fill);
  const groundGeometry = new T.PlaneGeometry(30, 30);
  const groundMaterial = new T.ShadowMaterial({ opacity: .13, depthWrite: false });
  const ground = new T.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const model = createDifferential();
  scene.add(model.root); model.update(0);
  const bounds = new T.Box3().setFromObject(model.root);
  const center = bounds.getCenter(new T.Vector3());
  const radius = bounds.getBoundingSphere(new T.Sphere()).radius;
  ground.position.y = bounds.min.y - .14;
  controls.target.copy(center);
  camera.position.copy(center).add(new T.Vector3(5, 4.4, 6));
  renderer.domElement.setAttribute('aria-label', 'Cutaway differential and driveshaft 3D model. Drag or use arrow keys to rotate. Hold to pause.');
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
  function theme() { groundMaterial.opacity = document.documentElement.dataset.theme === 'dark' ? .3 : .13; requestDraw(); }
  const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  fit(); theme(); host.classList.add('is-loaded');
  function dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); lifetime.abort();
    resize.disconnect(); intersection.disconnect(); themeObserver.disconnect(); controls.dispose();
    model.dispose(); groundGeometry.dispose(); groundMaterial.dispose(); environment.dispose(); key.shadow.dispose();
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
