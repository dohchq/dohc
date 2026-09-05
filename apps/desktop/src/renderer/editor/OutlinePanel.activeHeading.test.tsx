// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { OUTLINE_GEOMETRY_HOT_MS, OutlinePanel } from "./OutlinePanel";
import type { OutlineHeading } from "./outline";

type FrameCallback = (time: number) => void;
type ResizeCallback = ResizeObserverCallback;
type ObserverMutationCallback = MutationCallback;
type TransactionCallback = (event: {
  transaction: {
    docChanged: boolean;
    mapping: { map: (pos: number) => number };
  };
}) => void;

const frames = new Map<number, FrameCallback>();
const resizeObservers = new Map<ResizeCallback, Set<Element>>();
const mutationObservers = new Map<
  ObserverMutationCallback,
  Array<{ target: Node; options: MutationObserverInit }>
>();
const resolutionCallbacks = new Set<() => void>();
const resolutionQueries: string[] = [];
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
  resizeObservers.clear();
  mutationObservers.clear();
  resolutionCallbacks.clear();
  resolutionQueries.length = 0;
  vi.stubGlobal("devicePixelRatio", 1);
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
        resizeObservers.set(callback, new Set());
      }

      observe(target: Element) {
        resizeObservers.get(this.callback)?.add(target);
      }
      unobserve(target: Element) {
        resizeObservers.get(this.callback)?.delete(target);
      }
      disconnect() {
        resizeObservers.delete(this.callback);
      }
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class MutationObserver {
      private readonly callback: ObserverMutationCallback;

      constructor(callback: ObserverMutationCallback) {
        this.callback = callback;
        mutationObservers.set(callback, []);
      }

      observe(target: Node, options: MutationObserverInit) {
        mutationObservers.get(this.callback)?.push({ target, options });
      }
      takeRecords() {
        return [];
      }
      disconnect() {
        mutationObservers.delete(this.callback);
      }
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener(event: string, callback: () => void) {
      if (event === "change" && query.startsWith("(resolution:")) {
        resolutionQueries.push(query);
        resolutionCallbacks.add(callback);
      }
    },
    removeEventListener(event: string, callback: () => void) {
      if (event === "change") resolutionCallbacks.delete(callback);
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
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
  let headings: OutlineHeading[] = [
    { level: 1, text: "Intro", pos: 1 },
    { level: 2, text: "Plan", pos: 10 },
    { level: 2, text: "Review", pos: 20 },
    { level: 2, text: "Done", pos: 30 },
  ].slice(0, initialTops.length);
  let tops: HeadingTop[] = [...initialTops];
  const updateListeners = new Set<() => void>();
  const transactionListeners = new Set<TransactionCallback>();
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
      if (event === "transaction") {
        transactionListeners.add(callback as TransactionCallback);
      }
    },
    off(event: string, callback: () => void) {
      if (event === "update") updateListeners.delete(callback);
      if (event === "transaction") {
        transactionListeners.delete(callback as TransactionCallback);
      }
    },
  } as unknown as Editor;

  const renderCommits = vi.fn();
  const view = render(
    <Profiler id="outline" onRender={renderCommits}>
      <OutlinePanel editor={editor} containerRef={{ current: editorContainer }} />
    </Profiler>,
    { container: reactMount },
  );
  act(flushFrames);

  return {
    coordsAtPos,
    renderCommits,
    emitUpdate(flush = true) {
      act(() => {
        for (const callback of [...updateListeners]) callback();
      });
      if (flush) act(flushFrames);
    },
    emitDocumentTransaction({
      flush = true,
      mapPosition = (pos) => pos,
    }: {
      flush?: boolean;
      mapPosition?: (pos: number) => number;
    } = {}) {
      act(() => {
        for (const callback of [...transactionListeners]) {
          callback({
            transaction: {
              docChanged: true,
              mapping: { map: mapPosition },
            },
          });
        }
      });
      if (flush) act(flushFrames);
    },
    mutateEditorDom() {
      act(() => {
        for (const callback of mutationObservers.keys()) {
          callback([], {} as MutationObserver);
        }
      });
      act(flushFrames);
    },
    insertPaneSibling() {
      const sibling = document.createElement("div");
      act(() => {
        scroller.appendChild(sibling);
        const record = {
          addedNodes: [sibling],
          attributeName: null,
          attributeNamespace: null,
          nextSibling: null,
          oldValue: null,
          previousSibling: editorContainer,
          removedNodes: [],
          target: scroller,
          type: "childList",
        } as unknown as MutationRecord;
        for (const [callback, observations] of mutationObservers) {
          if (observations.some(({ target, options }) =>
            target === scroller && options.childList
          )) {
            callback([record], {} as MutationObserver);
          }
        }
      });
      act(flushFrames);
      return sibling;
    },
    toggleDetailsOpen() {
      const details = document.createElement("details");
      editorDom.appendChild(details);
      act(() => {
        details.open = true;
        const record = {
          addedNodes: [],
          attributeName: "open",
          attributeNamespace: null,
          nextSibling: null,
          oldValue: null,
          previousSibling: null,
          removedNodes: [],
          target: details,
          type: "attributes",
        } as unknown as MutationRecord;
        for (const [callback, observations] of mutationObservers) {
          if (observations.some(({ target, options }) =>
            target === editorDom
            && options.attributes
            && options.subtree
            && options.attributeFilter?.includes("open")
          )) {
            callback([record], {} as MutationObserver);
          }
        }
      });
      act(flushFrames);
    },
    isResizeObserved(target: Element) {
      return [...resizeObservers.values()].some((targets) => targets.has(target));
    },
    resizeElement(target: Element) {
      act(() => {
        for (const [callback, targets] of resizeObservers) {
          if (targets.has(target)) callback([], {} as ResizeObserver);
        }
      });
      act(flushFrames);
    },
    changeDevicePixelRatio(next: number) {
      act(() => {
        vi.stubGlobal("devicePixelRatio", next);
        for (const callback of [...resolutionCallbacks]) callback();
      });
      act(flushFrames);
    },
    resolutionQueries() {
      return [...resolutionQueries];
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
        for (const callback of resizeObservers.keys()) {
          callback([], {} as ResizeObserver);
        }
      });
      act(flushFrames);
    },
    windowResize() {
      act(() => {
        window.dispatchEvent(new Event("resize"));
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
    setTops(next: readonly HeadingTop[]) {
      tops = [...next];
    },
    replaceHeadings(next: readonly OutlineHeading[], nextTops: readonly HeadingTop[]) {
      headings = [...next];
      tops = [...nextTops];
    },
    flushFrames() {
      act(flushFrames);
    },
    advanceTimers(milliseconds: number) {
      act(() => vi.advanceTimersByTime(milliseconds));
      act(flushFrames);
    },
  };
}

describe("OutlinePanel active heading measurements", () => {
  it("keeps the active identity referentially stable when frames resolve the same heading", () => {
    const harness = renderActiveHeadingHarness([0, 500, 900]);
    harness.coordsAtPos.mockClear();
    harness.renderCommits.mockClear();
    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS + 1);

    harness.scrollTo(10);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    expect(harness.renderCommits).not.toHaveBeenCalled();

    harness.coordsAtPos.mockClear();
    harness.scrollTo(20);
    expect(harness.coordsAtPos).not.toHaveBeenCalled();
    expect(harness.renderCommits).not.toHaveBeenCalled();
  });

  it("remeasures once at gesture start, then reads no layout on cold scroll frames", () => {
    const harness = renderActiveHeadingHarness([0, 200, 500]);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();
    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS + 1);

    harness.scrollTo(250);

    expect(harness.activeText()).toBe("Plan");
    expect(harness.coordsAtPos.mock.calls.map(([pos]) => pos)).toEqual([
      1,
      10,
      20,
    ]);
    harness.coordsAtPos.mockClear();

    harness.scrollTo(350);
    harness.scrollTo(430);

    expect(harness.activeText()).toBe("Review");
    expect(harness.coordsAtPos).not.toHaveBeenCalled();

    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS + 1);
    harness.scrollTo(250);
    expect(harness.coordsAtPos.mock.calls.map(([pos]) => pos)).toEqual([
      1,
      10,
      20,
    ]);
  });

  it("measures hot scroll frames directly, then settles once and re-arms the cache", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS + 1);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 800, 1_100]);
    harness.mutateEditorDom();
    expect(harness.activeText()).toBe("Intro");
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();

    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS / 2);
    harness.scrollTo(350);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();

    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS / 2);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();

    harness.scrollTo(360);
    expect(harness.activeText()).toBe("Intro");
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
    expect(harness.activeText(), "skip the update invalidation and the stale cache keeps Review active.").toBe(["Intro", "Plan", "Review"][expected]);
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });

  it("uses document-changing transactions even when update is suppressed", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.replaceHeadings(
      [
        { level: 1, text: "Replacement", pos: 1 },
        { level: 2, text: "Later", pos: 20 },
      ],
      [0, 900],
    );
    harness.emitDocumentTransaction();

    expect(harness.activeText()).toBe("Replacement");
  });

  it("maps active identity through an insertion before the active heading", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400, 700]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.replaceHeadings(
      [
        { level: 1, text: "Intro", pos: 1 },
        { level: 2, text: "Plan", pos: 10 },
        { level: 2, text: "Inserted", pos: 20 },
        { level: 2, text: "Review", pos: 30 },
        { level: 2, text: "Done", pos: 40 },
      ],
      [0, 200, 300, 400, 700],
    );
    const mapPosition = vi.fn((pos: number) => pos >= 20 ? pos + 10 : pos);
    harness.emitDocumentTransaction({ flush: false, mapPosition });

    expect(mapPosition).toHaveBeenCalledWith(20);
    expect(harness.activeText()).toBe("Review");
    harness.flushFrames();
    expect(harness.activeText()).toBe("Review");
  });

  it("blanks a removed active position until the new geometry lands", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400, 700]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.replaceHeadings(
      [
        { level: 1, text: "Intro", pos: 1 },
        { level: 2, text: "Plan", pos: 10 },
        { level: 2, text: "Done", pos: 30 },
      ],
      [0, 200, 400],
    );
    const mapPosition = vi.fn((pos: number) => pos === 20 ? 25 : pos);
    harness.emitDocumentTransaction({ flush: false, mapPosition });

    expect(mapPosition).toHaveBeenCalledWith(20);
    expect(harness.activeText()).toBeUndefined();
    harness.flushFrames();
    expect(harness.activeText()).toBe("Done");
  });

  it("matches a full scan when measured positions have a gap or fail", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400, 600]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    const outOfOrderTops = [0, 600, 300, 900];
    harness.setTops(outOfOrderTops);
    harness.emitUpdate();
    expect(resolveActiveHeadingByFullScan(outOfOrderTops, 350, 72)).toBe(0);
    expect(harness.activeText(), "drop the nondecreasing clamp and binary search skips the gap.").toBe("Intro");

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

  it("drops stale geometry as soon as a transition mutation arrives", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 800, 1_100]);
    harness.mutateEditorDom();
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
    harness.coordsAtPos.mockClear();
    harness.scrollTo(350);

    expect(harness.activeText()).toBe("Intro");
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });

  it("observes details toggles and device-pixel-ratio changes", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 800, 1_100]);
    harness.toggleDetailsOpen();
    expect(harness.activeText()).toBe("Intro");

    harness.setTops([0, 200, 400]);
    harness.changeDevicePixelRatio(2);
    expect(harness.activeText()).toBe("Review");
    expect(harness.resolutionQueries().at(-1)).toBe("(resolution: 2dppx)");

    harness.setTops([0, 800, 1_100]);
    harness.changeDevicePixelRatio(3);

    expect(harness.activeText()).toBe("Intro");
    expect(harness.resolutionQueries().at(-1)).toBe("(resolution: 3dppx)");
  });

  it("observes a pane sibling inserted after the last scroll", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    const sibling = harness.insertPaneSibling();
    expect(harness.isResizeObserved(sibling)).toBe(true);
    harness.setTops([0, 800, 1_100]);
    harness.resizeElement(sibling);

    expect(harness.activeText()).toBe("Intro");
  });

  it("corrects an unobservable idle layout shift on the next gesture's first frame", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.coordsAtPos.mockClear();

    harness.setTops([0, 800, 1_100]);
    harness.advanceTimers(OUTLINE_GEOMETRY_HOT_MS + 1);

    expect(harness.coordsAtPos).not.toHaveBeenCalled();
    harness.scrollTo(351);

    expect(harness.activeText(), "remove the gesture-start remeasure and the stale cache keeps Review active on this frame instead of correcting the idle shift.").toBe("Intro");
    expect(harness.coordsAtPos).toHaveBeenCalledTimes(3);
  });
});
