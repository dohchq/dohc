import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { createInlineSixEngine } from "./inline-six-model";
import type { EngineView, EngineWorkerRequest, EngineWorkerResponse } from "./engine-worker-types";

const send = (message: EngineWorkerResponse) => self.postMessage(message);
let renderView: ((view: EngineView) => void) | undefined;
let latestView: EngineView | undefined;
let visible = true;
let frame = 0;
let lastDraw = 0;
let rendered = false;

function draw(now: number) {
  frame = 0;
  if (!visible || !latestView || !renderView) return;
  if (now - lastDraw < 1000 / 60 - 1) { frame = requestAnimationFrame(draw); return; }
  lastDraw = now;
  renderView(latestView);
  if (!rendered) { rendered = true; send({ type: 'rendered' }); }
}
function requestDraw() {
  if (!frame && visible && renderView && latestView) frame = requestAnimationFrame(draw);
}

async function initialize(canvas: OffscreenCanvas, pixelRatio: number, studioUrl: string) {
  const studioTexture = await new HDRLoader().loadAsync(studioUrl);
  const { engine } = createInlineSixEngine();
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60);
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
  const cameraDirection = new THREE.Vector3(10, 6.5, 7).normalize();
  camera.position.copy(center).addScaledVector(cameraDirection, 14);
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
  await renderer.compileAsync(scene, camera);
  let width = 0, height = 0, distance = 0;
  renderView = view => {
    if (view.width !== width || view.height !== height) {
      width = view.width; height = view.height;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const limitingFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
      distance = radius / Math.sin(limitingFov) * .83;
    }
    camera.position.setFromSphericalCoords(distance, view.phi, view.theta).add(center);
    camera.lookAt(center);
    renderer.render(scene, camera);
  };
  canvas.addEventListener('webglcontextlost', () => { renderView = undefined; cancelAnimationFrame(frame); send({ type: 'error', message: 'WebGL context lost' }); });
  send({ type: 'ready' });
  requestDraw();
}

self.onmessage = ({ data }: MessageEvent<EngineWorkerRequest>) => {
  if (data.type === 'init') {
    void initialize(data.canvas, data.pixelRatio, data.studioUrl).catch(error => send({ type: 'error', message: String(error), stack: error instanceof Error ? error.stack : undefined }));
  } else if (data.type === 'view') {
    latestView = data.view;
    requestDraw();
  } else {
    visible = data.visible;
    if (!visible) { cancelAnimationFrame(frame); frame = 0; }
    else requestDraw();
  }
};
