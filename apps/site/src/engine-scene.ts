import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createInlineSixEngine } from "./inline-six-model";

export function mountEngine(host: HTMLElement) {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    return;
  }
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.65;
  controls.autoRotateSpeed = 0.35;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI * 0.8;
  renderer.domElement.style.touchAction = "pan-y";
  const { engine, dispose: disposeModel } = createInlineSixEngine();
  scene.add(engine);
  const box = new THREE.Box3().setFromObject(engine);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  controls.target.copy(center);
  const cameraDirection = new THREE.Vector3(9, 6.5, 8).normalize();
  camera.position.copy(center).addScaledVector(cameraDirection, 14);
  controls.update();
  // Softboxes create long metal reflections without a downloaded environment map.
  const studio = new THREE.Scene();
  const enclosure = new THREE.Mesh(
    new THREE.BoxGeometry(30, 30, 30),
    new THREE.MeshBasicMaterial({ color: 0x30343a, side: THREE.BackSide }),
  );
  studio.add(enclosure);
  function softbox(
    position: number[],
    size: number[],
    brightness: number,
    color = 0xffffff,
  ) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(brightness),
      side: THREE.DoubleSide,
    });
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(size[0], size[1]),
      material,
    );
    panel.position.set(position[0], position[1], position[2]);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
  }
  softbox([-4, 7, 5], [5, 9], 4);
  softbox([6, 4, -2], [2, 8], 3.5, 0xd6e5ff);
  softbox([-5, 1, -6], [3, 7], 2.5);
  softbox([2, 7, 1], [6, 2], 3);
  softbox([1, -2, 7], [7, 2], 1.2, 0xffecd5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 1.1;
  pmrem.dispose();
  studio.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  });
  scene.add(new THREE.HemisphereLight(0xe9efff, 0x8c8274, 0.85));
  const key = new THREE.DirectionalLight(0xfff5e9, 3.2);
  key.position.set(-3, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
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
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdbe6ff, 1.3);
  fill.position.set(5, 2, -3);
  scene.add(fill);
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let hovered = host.matches(":hover");
  let dragging = false;
  let visible = true;
  let frame = 0;
  let last = 0;
  let disposed = false;
  function syncRotation() {
    controls.autoRotate = !motion.matches && !hovered && !dragging &&
      !renderer.domElement.matches(":focus-visible");
    requestDraw();
  }
  function draw(time: number) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    const dt = Math.min((time - last) / 1000, 0.05);
    last = time;
    controls.update(dt);
    renderer.render(scene, camera);
    if (controls.autoRotate)
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
  renderer.domElement.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    hovered = true;
    syncRotation();
  }, { signal });
  renderer.domElement.addEventListener("pointerleave", () => {
    hovered = false;
    syncRotation();
  }, { signal });
  renderer.domElement.addEventListener("focus", syncRotation, { signal });
  renderer.domElement.addEventListener("blur", syncRotation, { signal });
  controls.addEventListener("start", () => {
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
    "DOHC inline-six engine model. Hover or focus to pause. Drag or use arrow keys to rotate.",
  );
  renderer.domElement.addEventListener(
    "keydown",
    (event) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      event.preventDefault();
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
      requestDraw();
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
    environment.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    host.classList.remove("engine-loaded");
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
