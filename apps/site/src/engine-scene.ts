import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createInlineSixEngine } from "./inline-six-model";

export async function mountEngine(host: HTMLElement) {
  let cancelled = false;
  if (import.meta.hot) import.meta.hot.dispose(() => { cancelled = true; });
  // Poly Haven Studio Small 09, CC0: https://polyhaven.com/a/studio_small_09
  const studioTexture = await new HDRLoader().loadAsync("/engine-studio.hdr");
  if (cancelled || !host.isConnected) {
    studioTexture.dispose();
    return;
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    studioTexture.dispose();
    return;
  }
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.65;
  controls.autoRotateSpeed = 0.28;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI * 0.8;
  renderer.domElement.style.touchAction = "pan-y";
  const { engine, dispose: disposeModel } = createInlineSixEngine();
  scene.add(engine);
  const box = new THREE.Box3().setFromObject(engine);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const groundGeometry = new THREE.PlaneGeometry(30, 30);
  const groundMaterial = new THREE.ShadowMaterial({ opacity: 0.12, depthWrite: false });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y - 0.015;
  ground.receiveShadow = true;
  scene.add(ground);
  controls.target.copy(center);
  const cameraDirection = new THREE.Vector3(10, 6.5, 7).normalize();
  camera.position.copy(center).addScaledVector(cameraDirection, 14);
  controls.update();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(studioTexture);
  studioTexture.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.7;
  scene.environmentRotation.y = 0.75;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe9efff, 0x8c8274, 0.3));
  const key = new THREE.DirectionalLight(0xfff5e9, 1.6);
  key.position.set(-2, 10, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {
    left: -5,
    right: 5,
    top: 5,
    bottom: -5,
    near: 0.1,
    far: 22,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.normalBias = 0.025;
  key.shadow.bias = -0.0001;
  key.shadow.radius = 8;
  key.shadow.blurSamples = 12;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdbe6ff, 0.65);
  fill.position.set(5, 2, -3);
  scene.add(fill);
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let openingHold = 1.6;
  let dragging = false;
  let visible = true;
  let frame = 0;
  let last = 0;
  let disposed = false;
  function syncRotation() {
    controls.autoRotate = !motion.matches && !dragging && openingHold <= 0;
    requestDraw();
  }
  function draw(time: number) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    const dt = Math.min((time - last) / 1000, 0.05);
    last = time;
    if (!motion.matches && !dragging && openingHold > 0) {
      openingHold = Math.max(0, openingHold - dt);
      controls.autoRotate = openingHold === 0;
    }
    controls.update(dt);
    renderer.render(scene, camera);
    if (controls.autoRotate || (!motion.matches && !dragging && openingHold > 0))
      frame = requestAnimationFrame(draw);
  }
  function requestDraw() {
    if (!frame && !disposed && visible && !document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(draw);
    }
  }
  function fit() {
    const width = host.clientWidth,
      height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const limitingFov = Math.min(
      halfFov,
      Math.atan(Math.tan(halfFov) * camera.aspect),
    );
    const distance = (radius / Math.sin(limitingFov)) * 0.83;
    camera.position
      .sub(center)
      .normalize()
      .multiplyScalar(distance)
      .add(center);
    camera.updateProjectionMatrix();
    controls.update();
    requestDraw();
  }
  const resize = new ResizeObserver(fit);
  resize.observe(host);
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestDraw();
    else {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  intersection.observe(host);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (visible) requestDraw();
    },
    { signal },
  );
  motion.addEventListener("change", syncRotation, { signal });
  controls.addEventListener("start", () => {
    openingHold = 0;
    dragging = true;
    syncRotation();
  });
  controls.addEventListener("end", () => {
    dragging = false;
    syncRotation();
  });
  controls.addEventListener("change", () => {
    if (!controls.autoRotate) requestDraw();
  });
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute(
    "aria-label",
    "DOHC inline-six engine model. Grab and hold to pause. Drag or use arrow keys to rotate.",
  );
  renderer.domElement.addEventListener(
    "keydown",
    (event) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      event.preventDefault();
      openingHold = 0;
      const spherical = new THREE.Spherical().setFromVector3(
        camera.position.clone().sub(center),
      );
      if (event.key === "ArrowLeft") spherical.theta -= 0.12;
      if (event.key === "ArrowRight") spherical.theta += 0.12;
      if (event.key === "ArrowUp")
        spherical.phi = Math.max(controls.minPolarAngle, spherical.phi - 0.12);
      if (event.key === "ArrowDown")
        spherical.phi = Math.min(controls.maxPolarAngle, spherical.phi + 0.12);
      camera.position
        .copy(center)
        .add(new THREE.Vector3().setFromSpherical(spherical));
      controls.autoRotate = false;
      controls.update();
      syncRotation();
    },
    { signal },
  );
  renderer.domElement.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      dispose();
    },
    { once: true, signal },
  );
  syncRotation();
  host.classList.add("engine-loaded");
  fit();
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    lifetime.abort();
    resize.disconnect();
    intersection.disconnect();
    controls.dispose();
    disposeModel();
    groundGeometry.dispose();
    groundMaterial.dispose();
    environment.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    host.classList.remove("engine-loaded");
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
