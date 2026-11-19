import * as T from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { createDifferential, type DriveModel } from "./drive-models";
import { createInlineSixEngine } from "./inline-six-model";
import { createWheel } from "./wheel-model";
import { stageFigure } from "./figure-studio";
import type { FigureCommand, FigureKind, FigureView } from "./figure-messages";

function buildModel(kind: FigureKind): DriveModel & { setEdge?: (strength: number) => void } {
  if (kind === "wheel") return createWheel();
  if (kind === "drive") return createDifferential();
  const { engine, dispose } = createInlineSixEngine();
  return { root: engine, dispose, update() {} };
}

export function renderFigure(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  kind: FigureKind,
  deviceRatio: number,
  initialView: FigureView,
  lighting: ArrayBuffer,
  presented: () => void,
  failed: (message: string) => void,
) {
  const renderer = new T.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  const model = buildModel(kind);
  model.update(0);
  const hdr = new HDRLoader().parse(lighting);
  const texture = new T.DataTexture(hdr.data, hdr.width, hdr.height, T.RGBAFormat, hdr.type);
  texture.flipY = true;
  texture.colorSpace = T.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = T.LinearFilter;
  texture.needsUpdate = true;
  const scene = new T.Scene();
  const studio = stageFigure(renderer, scene, model.root, texture, { animated: kind !== "engine" });
  const direction =
    kind === "engine"
      ? new T.Vector3(-8, 8, 10)
      : kind === "drive"
        ? new T.Vector3(5, 4.4, 6)
        : new T.Vector3(-Math.sin(0.42), 0.12, Math.cos(0.42));
  const orbit = new T.Spherical().setFromVector3(direction);
  const camera = new T.PerspectiveCamera(kind === "wheel" ? 30 : 33, 1, 0.1, 70);
  const halfFov = T.MathUtils.degToRad(camera.fov / 2);
  const distance =
    kind === "wheel"
      ? new T.Box3().setFromObject(model.root).getSize(new T.Vector3()).y /
        (2 * Math.tan(halfFov) * 0.55)
      : (studio.radius / Math.sin(halfFov)) * 0.83;
  if (kind === "wheel") scene.environmentRotation.y = 3;
  let view = initialView;
  let elapsed = 0;
  let frame = 0;
  let requestedAt = 0;
  let previous = 0;
  let drawn = false;
  let disposed = false;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  let pendingDraw: WebGLSync | null = null;
  let slowFrames = 0;
  let orbitChanged = false;
  let ratio = Math.min(deviceRatio, 1.25);
  function size() {
    if (!view.width || !view.height) return;
    renderer.setDrawingBufferSize(view.width, view.height, ratio);
    camera.aspect = view.width / view.height;
    if (kind !== "wheel")
      camera.fov = T.MathUtils.radToDeg(
        2 * Math.atan(Math.tan(halfFov) / Math.min(1, camera.aspect)),
      );
    camera.updateProjectionMatrix();
  }
  function theme() {
    studio.setDark(view.dark);
    model.setEdge?.(view.dark ? 0.35 : 0);
  }
  function requestDraw() {
    if (!frame && !disposed && view.visible && view.width && view.height) {
      if (!requestedAt) requestedAt = performance.now();
      frame = requestAnimationFrame(draw);
    }
  }
  function draw(now: number) {
    frame = 0;
    if (pendingDraw) {
      if (gl.clientWaitSync(pendingDraw, 0, 0) === gl.TIMEOUT_EXPIRED) {
        requestDraw();
        return;
      }
      gl.deleteSync(pendingDraw);
      pendingDraw = null;
    }
    const interval = previous ? now - previous : 0;
    if (drawn && interval > 0 && (view.animate || orbitChanged)) {
      if (view.animate && !orbitChanged && interval < 1000 / 60 - 1) {
        requestDraw();
        return;
      }
      const dt = Math.min(interval / 1000, 0.25);
      if (view.animate) {
        elapsed += dt;
        if (kind === "engine") orbit.theta -= (2 * Math.PI * dt) / 22;
        else model.update(elapsed);
      }
      const activeInterval = view.animate ? interval : Math.min(interval, now - requestedAt);
      slowFrames = activeInterval > 32 ? slowFrames + 1 : 0;
      if (slowFrames >= 3 && ratio > 0.65) {
        ratio = Math.max(0.65, ratio * 0.7);
        slowFrames = 0;
        size();
      }
    }
    orbitChanged = false;
    previous = now;
    camera.position.setFromSphericalCoords(distance, orbit.phi, orbit.theta).add(studio.center);
    camera.lookAt(studio.center);
    renderer.render(scene, camera);
    pendingDraw = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    requestedAt = 0;
    if (!drawn) {
      drawn = true;
      presented();
    }
    if (view.animate) requestDraw();
  }
  function lost() {
    failed("WebGL context lost");
  }
  canvas.addEventListener("webglcontextlost", lost);
  size();
  theme();
  requestDraw();
  return {
    command(command: FigureCommand) {
      if (command.type === "orbit") {
        orbitChanged = true;
        orbit.theta += command.theta;
        orbit.phi = T.MathUtils.clamp(
          orbit.phi + command.phi,
          kind === "drive" ? 0.15 : 0.2,
          Math.PI * (kind === "drive" ? 0.85 : 0.8),
        );
      } else {
        const prior = view;
        view = command.view;
        if (prior.animate !== view.animate || prior.visible !== view.visible) {
          previous = 0;
          slowFrames = 0;
        }
        if (prior.width !== view.width || prior.height !== view.height) size();
        if (prior.dark !== view.dark) theme();
        if (!view.visible) {
          cancelAnimationFrame(frame);
          frame = 0;
          requestedAt = 0;
        }
      }
      requestDraw();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      if (pendingDraw) gl.deleteSync(pendingDraw);
      canvas.removeEventListener("webglcontextlost", lost);
      model.dispose();
      studio.dispose();
      renderer.dispose();
    },
  };
}
