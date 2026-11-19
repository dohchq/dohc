// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountFigure } from "./figure-view";

let host, worker, appear, motion, dispose;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => motion);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new ArrayBuffer(32))),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback) {
        appear = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      constructor() {
        super();
        worker = this;
      }
      postMessage = vi.fn();
      terminate = vi.fn();
    },
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({}),
  });
});
afterEach(() => {
  dispose?.();
  host.remove();
  delete HTMLCanvasElement.prototype.transferControlToOffscreen;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function show(kind) {
  dispose = mountFigure(host, kind);
  expect(fetch).not.toHaveBeenCalled();
  appear(true);
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
}
const last = () => worker.postMessage.mock.lastCall[0];
function notify(data) {
  worker.dispatchEvent(new MessageEvent("message", { data }));
}

it("shows the live canvas only after the first frame and restores the poster after a renderer failure", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  host.innerHTML = '<img class="drive-model-poster" alt="Differential"><p role="status"></p>';
  await show("drive");
  expect(host.classList.contains("is-loaded")).toBe(false);
  notify({ type: "rendered" });
  expect(host.classList.contains("is-loaded")).toBe(true);
  notify({ type: "error", message: "WebGL context lost" });
  expect(host.classList.contains("is-loaded")).toBe(false);
  expect(host.querySelector("canvas")).toBeNull();
  expect(host.querySelector("img").alt).toBe("Differential");
  expect(host.querySelector('[role="status"]').textContent).toContain("stopped");
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("keeps the renderer's current theme, motion preference and visibility through startup and later changes", async () => {
  motion.matches = true;
  document.documentElement.dataset.theme = "dark";
  await show("engine");
  expect(last()).toMatchObject({
    type: "init",
    view: { animate: false, visible: true, dark: true },
  });
  appear(false);
  expect(last().view.visible).toBe(false);
  motion.matches = false;
  motion.dispatchEvent(new Event("change"));
  expect(last().view).toMatchObject({ animate: true, visible: false });
  document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  expect(last().view.dark).toBe(false);
  appear(true);
  expect(last().view.visible).toBe(true);
});

it("cancels startup cleanly if the figure is removed while the lighting downloads", async () => {
  let finish;
  vi.mocked(fetch).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  dispose = mountFigure(host, "engine");
  appear(true);
  dispose();
  finish(new Response(new ArrayBuffer(32)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(host.querySelector("canvas")).toBeNull();
  expect(worker.postMessage).not.toHaveBeenCalled();
});
