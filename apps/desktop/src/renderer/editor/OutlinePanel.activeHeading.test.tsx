// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { OutlinePanel } from "./OutlinePanel";
import type { OutlineHeading } from "./outline";

type FrameCallback = (time: number) => void;
type ResizeCallback = ResizeObserverCallback;
type ObserverMutationCallback = MutationCallback;

const frames = new Map<number, FrameCallback>();
const resizeCallbacks = new Set<ResizeCallback>();
const mutationCallbacks = new Set<ObserverMutationCallback>();
const mountedScrollers = new Set<HTMLElement>();
let nextFrame = 0;

function flushFrames(): void {
  while (frames.size > 0) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  frames.clear();
  resizeCallbacks.clear();
  mutationCallbacks.clear();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      private readonly callback: ResizeCallback;

      constructor(callback: ResizeCallback) {
        this.callback = callback;
        resizeCallbacks.add(callback);
      }

      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class MutationObserver {
      private readonly callback: ObserverMutationCallback;

      constructor(callback: ObserverMutationCallback) {
        this.callback = callback;
        mutationCallbacks.add(callback);
      }

      observe() {}
      takeRecords() {
        return [];
      }
      disconnect() {
        mutationCallbacks.delete(this.callback);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  for (const scroller of mountedScrollers) scroller.remove();
  mountedScrollers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type HeadingTop = number | "throw";

function resolveActiveHeadingByFullScan(
  tops: readonly number[],
  scrollTop: number,
  readingOffset: number,
): number {
  let active = 0;
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index]! <= scrollTop + readingOffset) active = index;
    else break;
  }
  return active;
}

function renderActiveHeadingHarness(initialTops: readonly number[]) {
  const headings: OutlineHeading[] = [
    { level: 1, text: "Intro", pos: 1 },
    { level: 2, text: "Plan", pos: 10 },
    { level: 2, text: "Review", pos: 20 },
    { level: 2, text: "Done", pos: 30 },
  ].slice(0, initialTops.length);
  let tops: HeadingTop[] = [...initialTops];
  const updateListeners = new Set<() => void>();
  const scroller = document.createElement("div");
  const editorContainer = document.createElement("div");
  const editorDom = document.createElement("div");
  const reactMount = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1_000 },
  });
  scroller.getBoundingClientRect = () =>
    ({
      bottom: 300,
      height: 200,
      left: 0,
      right: 600,
      top: 100,
      width: 600,
      x: 0,
      y: 100,
      toJSON: () => {},
    }) satisfies DOMRect;
  editorContainer.append(editorDom, reactMount);
  scroller.appendChild(editorContainer);
  document.body.appendChild(scroller);
  mountedScrollers.add(scroller);

  const coordsAtPos = vi.fn((pos: number) => {
    const top = tops[headings.findIndex((heading) => heading.pos === pos)] ?? 0;
    if (top === "throw") throw new RangeError("position is not rendered");
    return {
      bottom: 0,
      left: 0,
      right: 0,
      top: 100 + top - scroller.scrollTop,
    };
  });
  const doc = {
    content: { size: 1 },
    descendants(callback: (node: {
      type: { name: string };
      attrs: { level: number };
      textContent: string;
    }, pos: number) => void) {
      for (const heading of headings) {
        callback(
          {
            type: { name: "heading" },
            attrs: { level: heading.level },
            textContent: heading.text,
          },
          heading.pos,
        );
      }
    },
    textBetween: () => "Intro Plan Review",
  };
  const editor = {
    state: { doc },
    view: { coordsAtPos, dom: editorDom },
    on(event: string, callback: () => void) {
      if (event === "update") updateListeners.add(callback);
    },
    off(event: string, callback: () => void) {
      if (event === "update") updateListeners.delete(callback);
    },
  } as unknown as Editor;

  const view = render(
    <OutlinePanel editor={editor} containerRef={{ current: editorContainer }} />,
    { container: reactMount },
  );
  act(flushFrames);

  return {
    coordsAtPos,
    emitUpdate() {
      act(() => {
        for (const callback of [...updateListeners]) callback();
      });
      act(flushFrames);
    },
    mutateEditorDom() {
      act(() => {
        for (const callback of [...mutationCallbacks]) {
          callback([], {} as MutationObserver);
        }
        vi.advanceTimersByTime(200);
      });
      act(flushFrames);
    },
    resourceLoad() {
      act(() => {
        editorDom.dispatchEvent(new Event("load", { bubbles: false }));
      });
      act(flushFrames);
    },
    activeText() {
      return view.container
        .querySelector<HTMLButtonElement>('[aria-current="true"]')
        ?.textContent;
    },
    resize() {
      act(() => {
        for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
        vi.advanceTimersByTime(200);
      });
      act(flushFrames);
    },
    windowResize() {
      act(() => {
        window.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(200);
      });
      act(flushFrames);
    },
    scrollTo(scrollTop: number) {
      act(() => {
        scroller.scrollTop = scrollTop;
        scroller.dispatchEvent(new Event("scroll"));
      });
      act(flushFrames);
    },
    scrollEnd() {
      act(() => {
        scroller.dispatchEvent(new Event("scrollend"));
      });
      act(flushFrames);
    },
    setTops(next: readonly HeadingTop[]) {
      tops = [...next];
    },
  };
}

describe("OutlinePanel active heading measurements", () => {
  it("does not call coordsAtPos during a steady-state scroll frame", () => {
    const harness = renderActiveHeadingHarness([0, 200, 500]);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();

    harness.scrollTo(250);

    expect(harness.activeText()).toBe("Plan");
    expect(harness.coordsAtPos).not.toHaveBeenCalled();
  });

  it("recomputes offsets after a document update before resolving the active heading", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 600, 900]);
    harness.emitUpdate();

    const expected = resolveActiveHeadingByFullScan([0, 600, 900], 350, 72);
    expect(expected).toBe(0);
    // MUTATION: skip the update invalidation and the stale cache keeps Review active.
    expect(harness.activeText()).toBe(["Intro", "Plan", "Review"][expected]);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });

  it("matches a full scan when measured positions have a gap or fail", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400, 600]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    const outOfOrderTops = [0, 600, 300, 900];
    harness.setTops(outOfOrderTops);
    harness.emitUpdate();
    expect(resolveActiveHeadingByFullScan(outOfOrderTops, 350, 72)).toBe(0);
    // MUTATION: drop the nondecreasing clamp and binary search skips the gap.
    expect(harness.activeText()).toBe("Intro");

    harness.setTops([0, 200, "throw", 600]);
    harness.scrollTo(500);
    harness.emitUpdate();
    expect(harness.activeText()).toBe("Plan");
  });

  it("recomputes offsets after a resize", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 700, 1_000]);
    harness.resize();

    expect(harness.activeText()).toBe("Intro");
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });

  it("invalidates on window resize, media load, and async renderer changes", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 700, 1_000]);
    harness.windowResize();
    expect(harness.activeText()).toBe("Intro");

    harness.setTops([0, 200, 400]);
    harness.resourceLoad();
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 800, 1_100]);
    harness.mutateEditorDom();
    expect(harness.activeText()).toBe("Intro");
  });

  it("recomputes at scroll idle after an otherwise unobserved layout shift", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 800, 1_100]);
    harness.scrollEnd();

    expect(harness.activeText()).toBe("Intro");
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });
});
