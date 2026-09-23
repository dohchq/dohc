import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { createInlineSixEngine } from "./inline-six-model";
import { stageFigure, type FigureStudio } from "./figure-studio";
import type { EngineView, EngineWorkerRequest, EngineWorkerResponse } from "./engine-worker-types";

const send = (message: EngineWorkerResponse) => self.postMessage(message);
let renderView: ((view: EngineView) => void) | undefined;
let latestView: EngineView | undefined;
let visible = true;
let frame = 0;
let lastDraw = 0;
let rendered = false;
let dark = false;
let studio: FigureStudio | undefined;

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
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60);
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  studio = stageFigure(renderer, scene, engine, studioTexture);
  studioTexture.dispose();
  studio.setDark(dark);
  const { center } = studio;
  const distance = studio.radius / Math.sin(halfFov) * .83;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(10, 6.5, 7).normalize(), distance);
  camera.lookAt(center);
  await renderer.compileAsync(scene, camera);
  let width = 0, height = 0;
  renderView = view => {
    if (view.width !== width || view.height !== height) {
      width = view.width; height = view.height;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Keep the square preview's perspective and object-fit: contain framing.
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfFov) / Math.min(1, camera.aspect)));
      camera.updateProjectionMatrix();
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
  } else if (data.type === 'theme') {
    dark = data.dark;
    studio?.setDark(dark);
    requestDraw();
  } else if (data.type === 'view') {
    latestView = data.view;
    requestDraw();
  } else {
    visible = data.visible;
    if (!visible) { cancelAnimationFrame(frame); frame = 0; }
    else requestDraw();
  }
};
