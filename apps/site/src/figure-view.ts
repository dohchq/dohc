import type {
  FigureCommand,
  FigureKind,
  FigureRequest,
  FigureResponse,
  FigureView,
} from "./figure-messages";

export function mountFigure(host: HTMLElement, kind: FigureKind, onLoadEnd?: () => void) {
  const canvas = document.createElement("canvas");
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const loadedClass = kind === "engine" ? "engine-loaded" : "is-loaded";
  const interactive = kind !== "wheel";
  let worker: Worker | undefined;
  let player: ReturnType<typeof import("./figure-renderer").renderFigure> | undefined;
  let pointer: { id: number; x: number; y: number } | undefined;
  let visible = false;
  let started = false;
  let initialized = false;
  const view = (): FigureView => ({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    visible: visible && !document.hidden,
    animate: !motion.matches && !pointer,
    dark: document.documentElement.dataset.theme === "dark",
  });
  const command = (message: FigureCommand) => {
    if (!initialized) return;
    if (worker) worker.postMessage(message);
    else player?.command(message);
  };
  const sync = () => {
    if (visible && !document.hidden && !started) void initialize();
    else command({ type: "view", view: view() });
  };
  function rendered() {
    host.classList.add(loadedClass);
    onLoadEnd?.();
  }
  function failed(message: string) {
    if (signal.aborted) return;
    console.error(`Unable to render the ${kind} model`, message);
    const status = host.querySelector<HTMLElement>('[role="status"]');
    if (status)
      status.textContent = host.classList.contains(loadedClass)
        ? "The 3D preview stopped. Refresh to try again."
        : "The 3D preview could not load. Refresh to try again.";
    onLoadEnd?.();
    dispose();
  }
  const lighting = () =>
    fetch("/figure-reflections.hdr", { signal }).then((response) => {
      if (!response.ok) throw new Error(`Studio lighting: HTTP ${response.status}`);
      return response.arrayBuffer();
    });
  async function initialize() {
    started = true;
    try {
      if (canvas.transferControlToOffscreen && typeof Worker !== "undefined") {
        worker = new Worker(new URL("./figure-renderer.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.addEventListener(
          "message",
          ({ data }: MessageEvent<FigureResponse>) => {
            if (data.type === "rendered") rendered();
            else failed(data.message);
          },
          { signal },
        );
        worker.addEventListener("error", (event) => failed(event.message), { signal });
        const buffer = await lighting();
        if (signal.aborted) return;
        const offscreen = canvas.transferControlToOffscreen();
        worker.postMessage(
          {
            type: "init",
            canvas: offscreen,
            kind,
            pixelRatio: devicePixelRatio,
            view: view(),
            lighting: buffer,
          } satisfies FigureRequest,
          [offscreen, buffer],
        );
      } else {
        const [{ renderFigure }, buffer] = await Promise.all([
          import("./figure-renderer"),
          lighting(),
        ]);
        if (signal.aborted) return;
        player = renderFigure(canvas, kind, devicePixelRatio, view(), buffer, rendered, failed);
      }
      initialized = true;
    } catch (error) {
      failed(String(error));
    }
  }
  if (interactive) {
    canvas.tabIndex = 0;
    canvas.style.touchAction = "pan-y";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      kind === "engine"
        ? "DOHC inline-six engine model. Grab and hold to pause. Drag or use arrow keys to rotate."
        : "Cutaway differential and driveshaft 3D model. Drag or use arrow keys to rotate. Hold to pause.",
    );
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || pointer) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        sync();
      },
      { signal },
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        const scale = (Math.PI * 2 * 0.65) / Math.max(canvas.clientHeight, 1);
        command({
          type: "orbit",
          theta: (pointer.x - event.clientX) * scale,
          phi: (pointer.y - event.clientY) * scale,
        });
        pointer.x = event.clientX;
        pointer.y = event.clientY;
      },
      { signal },
    );
    const release = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) {
        pointer = undefined;
        sync();
      }
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const)
      canvas.addEventListener(name, release, { signal });
    canvas.addEventListener(
      "keydown",
      (event) => {
        const step = kind === "engine" ? 0.12 : 0.15;
        const theta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const phi = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        if (!theta && !phi) return;
        event.preventDefault();
        command({ type: "orbit", theta, phi });
      },
      { signal },
    );
  } else canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const resize = new ResizeObserver(sync);
  resize.observe(canvas);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    sync();
  });
  intersection.observe(host);
  const theme = new MutationObserver(sync);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", sync, { signal });
  motion.addEventListener("change", sync, { signal });
  function dispose() {
    if (signal.aborted) return;
    lifetime.abort();
    resize.disconnect();
    intersection.disconnect();
    theme.disconnect();
    worker?.terminate();
    player?.dispose();
    canvas.remove();
    host.classList.remove(loadedClass);
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return dispose;
}
