// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicExcalidrawScene } from "./excalidraw";

let currentState = { zoom: 0.1, scrollX: 1800, scrollY: 2800, width: 390, height: 600 };
const scrollToContent = vi.fn();
const updateScene = vi.fn(
  (update: { appState?: { zoom?: { value: number }; scrollX?: number; scrollY?: number } }) => {
    if (update.appState?.zoom) currentState.zoom = update.appState.zoom.value;
    if (typeof update.appState?.scrollX === "number")
      currentState.scrollX = update.appState.scrollX;
    if (typeof update.appState?.scrollY === "number")
      currentState.scrollY = update.appState.scrollY;
  },
);
const fakeApi = {
  getAppState: () => ({
    zoom: { value: currentState.zoom },
    scrollX: currentState.scrollX,
    scrollY: currentState.scrollY,
    width: currentState.width,
    height: currentState.height,
  }),
  scrollToContent,
  updateScene,
};

vi.mock("@excalidraw/excalidraw", () => ({
  restore: (value: unknown) => value,
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: typeof fakeApi) => void }) => {
    useEffect(() => {
      excalidrawAPI?.(fakeApi);
    }, [excalidrawAPI]);
    return <div data-testid="mock-excalidraw" />;
  },
}));

const { default: ExcalidrawView } = await import("./ExcalidrawView");

const scene = (): PublicExcalidrawScene => ({
  elements: [],
  appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  currentState = { zoom: 0.1, scrollX: 1800, scrollY: 2800, width: 390, height: 600 };
  scrollToContent.mockClear();
  updateScene.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps viewport center anchored on zoom, never zooms in on Zoom out, and preserves viewport on re-render", async () => {
  await act(async () => {
    root.render(<ExcalidrawView scene={scene()} />);
  });
  expect(scrollToContent).toHaveBeenCalledTimes(1);
  expect(scrollToContent).toHaveBeenCalledWith(undefined, {
    fitToViewport: true,
    viewportZoomFactor: 0.9,
    minZoom: 0.1,
    maxZoom: 1,
  });

  const zoomOut = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!;
  const zoomIn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;

  await act(async () => zoomOut.click());
  expect(currentState.zoom).toBe(0.1);
  expect(updateScene).not.toHaveBeenCalled();

  const centerSceneX = currentState.width / 2 / currentState.zoom - currentState.scrollX;
  const centerSceneY = currentState.height / 2 / currentState.zoom - currentState.scrollY;
  for (let step = 0; step < 4; step += 1) {
    await act(async () => zoomIn.click());
    expect((centerSceneX + currentState.scrollX) * currentState.zoom).toBeCloseTo(
      currentState.width / 2,
      5,
    );
    expect((centerSceneY + currentState.scrollY) * currentState.zoom).toBeCloseTo(
      currentState.height / 2,
      5,
    );
  }
  expect(currentState.zoom).toBeCloseTo(0.1 * 1.25 ** 4, 5);

  await act(async () => {
    root.render(<ExcalidrawView scene={scene()} />);
  });
  expect(scrollToContent).toHaveBeenCalledTimes(1);
});
