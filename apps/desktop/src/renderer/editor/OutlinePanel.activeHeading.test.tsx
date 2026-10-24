// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { OutlinePanel } from "./OutlinePanel";
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

const DEFAULT_HEADINGS: OutlineHeading[] = [
  { level: 1, text: "Intro", pos: 1 },
  { level: 2, text: "Plan", pos: 10 },
  { level: 2, text: "Review", pos: 20 },
  { level: 2, text: "Done", pos: 30 },
];

// `tops` place each heading in the scroller's content, in pixels. The
// editor's posAtCoords answers with a position inside the last heading at or
// above the asked line, as a real hit test would. With margin hits on, a line
// in the 24 px above a heading answers with that heading's start instead.
function renderActiveHeadingHarness(
  initialTops: readonly number[],
  initialHeadings: readonly OutlineHeading[] = DEFAULT_HEADINGS.slice(0, initialTops.length),
) {
  let headings: OutlineHeading[] = [...initialHeadings];
  let tops: number[] = [...initialTops];
  let editorTop = 0;
  let editorHeight = 1_000;
  let unresolved: boolean | "throw" = false;
  let marginHits = false;
  let hitHeading: number | null = null;
  const folded = new Set<number>();
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
  const rect = (top: number, height: number) =>
    ({
      bottom: top + height,
      height,
      left: 0,
      right: 600,
      top,
      width: 600,
      x: 0,
      y: top,
      toJSON: () => {},
    }) satisfies DOMRect;
  scroller.getBoundingClientRect = () => rect(100, 200);
  editorDom.getBoundingClientRect = () =>
    rect(100 + editorTop - scroller.scrollTop, editorHeight);
  editorContainer.append(editorDom, reactMount);
  scroller.appendChild(editorContainer);
  document.body.appendChild(scroller);
  mountedScrollers.add(scroller);

  const posAtCoords = vi.fn(({ top }: { left: number; top: number }) => {
    if (unresolved === "throw") throw new RangeError("position is not rendered");
    if (unresolved) return null;
    if (hitHeading !== null) {
      const pos = headings[hitHeading]!.pos + 1;
      return { pos, inside: pos - 1 };
    }
    const contentTop = top - 100 + scroller.scrollTop;
    let reached = -1;
    for (const [index, headingTop] of tops.entries()) {
      if (headingTop <= contentTop) reached = index;
    }
    const next = headings[reached + 1];
    if (marginHits && next && tops[reached + 1]! - contentTop <= 24) {
      return { pos: next.pos, inside: -1 };
    }
    const pos = reached < 0 ? 0 : headings[reached]!.pos + 1;
    return { pos, inside: pos - 1 };
  });
  const nodeDOM = (pos: number) => {
    const index = headings.findIndex((heading) => heading.pos === pos);
    if (index < 0) return null;
    const element = document.createElement("h2");
    element.getBoundingClientRect = () =>
      folded.has(index) ? rect(0, 0) : rect(100 + tops[index]! - scroller.scrollTop, 30);
    return element;
  };
  const doc = {
    content: { size: 1_000 },
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
    view: { posAtCoords, nodeDOM, dom: editorDom, state: { doc } },
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
    posAtCoords,
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
    setTops(next: readonly number[]) {
      tops = [...next];
    },
    setEditorBox(top: number, height: number) {
      editorTop = top;
      editorHeight = height;
    },
    setUnresolved(next: boolean | "throw") {
      unresolved = next;
    },
    setMarginHits(next: boolean) {
      marginHits = next;
    },
    setHitHeading(index: number | null) {
      hitHeading = index;
    },
    fold(index: number) {
      folded.add(index);
    },
    replaceHeadings(next: readonly OutlineHeading[], nextTops: readonly number[]) {
      headings = [...next];
      tops = [...nextTops];
    },
    flushFrames() {
      act(flushFrames);
    },
  };
}

describe("OutlinePanel active heading", () => {
  it("keeps the active identity referentially stable when frames resolve the same heading", () => {
    const harness = renderActiveHeadingHarness([0, 500, 900]);
    expect(harness.activeText()).toBe("Intro");
    harness.posAtCoords.mockClear();
    harness.renderCommits.mockClear();

    harness.scrollTo(10);
    expect(harness.posAtCoords).toHaveBeenCalledTimes(1);
    expect(harness.renderCommits).not.toHaveBeenCalled();

    harness.scrollTo(20);
    expect(harness.renderCommits).not.toHaveBeenCalled();
  });

  it("reads one position per frame, however many headings the note has", () => {
    const headings = Array.from({ length: 400 }, (_, index) => ({
      level: 2,
      text: `Section ${index}`,
      pos: index * 10 + 1,
    }));
    const harness = renderActiveHeadingHarness(
      headings.map((_, index) => index * 100),
      headings,
    );
    harness.setEditorBox(0, 40_000);
    harness.posAtCoords.mockClear();

    harness.scrollTo(25_000);

    expect(harness.activeText()).toBe("Section 250");
    expect(harness.posAtCoords).toHaveBeenCalledTimes(1);
  });

  it("follows the reading line as the note scrolls", () => {
    const harness = renderActiveHeadingHarness([0, 200, 500]);
    expect(harness.activeText()).toBe("Intro");

    harness.scrollTo(250);
    expect(harness.activeText()).toBe("Plan");

    harness.scrollTo(430);
    expect(harness.activeText()).toBe("Review");

    harness.scrollTo(0);
    expect(harness.activeText()).toBe("Intro");
  });

  it("uses the first heading above the editor and the last below it", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.setEditorBox(300, 600);
    harness.posAtCoords.mockClear();

    harness.scrollTo(100);
    expect(harness.activeText()).toBe("Intro");

    harness.scrollTo(2_000);
    expect(harness.activeText()).toBe("Review");
    expect(harness.posAtCoords).not.toHaveBeenCalled();
  });

  it("keeps the active heading when the reading line resolves to no position", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setUnresolved(true);
    harness.scrollTo(10);
    expect(harness.activeText()).toBe("Review");

    harness.setUnresolved("throw");
    harness.scrollTo(20);
    expect(harness.activeText()).toBe("Review");
  });

  it("reaches a heading only once its top crosses the reading line", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.setMarginHits(true);

    // The line sits 10 px above Plan, where a hit resolves to Plan's start.
    harness.scrollTo(118);
    expect(harness.activeText()).toBe("Intro");

    harness.scrollTo(130);
    expect(harness.activeText()).toBe("Plan");
  });

  it("takes the last reached heading of a row, as in document order", () => {
    // Plan and Review sit side by side in one table row; the hit lands in
    // Plan's cell.
    const harness = renderActiveHeadingHarness([0, 200, 200]);
    harness.setHitHeading(1);

    harness.scrollTo(150);

    expect(harness.activeText()).toBe("Review");
  });

  it("walks back past every heading of a cell the line has not reached", () => {
    // Plan and Review sit low in a row's first cell; the hit lands in the
    // second cell, after both in document order.
    const harness = renderActiveHeadingHarness([0, 300, 400]);
    harness.setHitHeading(2);

    harness.scrollTo(100);

    expect(harness.activeText()).toBe("Intro");
  });

  it("walks back past a folded heading to the last drawn one", () => {
    // Plan is folded away; Review and Done sit low in a row's first cell and
    // the hit lands in the second cell.
    const harness = renderActiveHeadingHarness([0, 0, 300, 400]);
    harness.fold(1);
    harness.setHitHeading(3);

    harness.scrollTo(100);

    expect(harness.activeText()).toBe("Intro");
  });

  it("passes over a folded heading between headings of a row", () => {
    // Plan and Done share a row; Review, between them, is folded away.
    const harness = renderActiveHeadingHarness([0, 200, 0, 200]);
    harness.fold(2);
    harness.setHitHeading(1);

    harness.scrollTo(150);

    expect(harness.activeText()).toBe("Done");
  });

  it("does not redraw the list when an edit only moves later headings", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");
    harness.renderCommits.mockClear();

    harness.replaceHeadings(
      [
        { level: 1, text: "Intro", pos: 1 },
        { level: 2, text: "Plan", pos: 11 },
        { level: 2, text: "Review", pos: 21 },
      ],
      [0, 200, 400],
    );
    harness.emitDocumentTransaction({ mapPosition: (pos) => pos >= 5 ? pos + 1 : pos });

    expect(harness.renderCommits).not.toHaveBeenCalled();
    expect(harness.activeText()).toBe("Review");
  });

  it("recomputes after a document update before resolving the active heading", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 600, 900]);
    harness.emitUpdate();

    expect(harness.activeText()).toBe("Intro");
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

  it("blanks a removed active position until the next frame resolves it", () => {
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

  it("recomputes after a resize", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 700, 1_000]);
    harness.resize();

    expect(harness.activeText()).toBe("Intro");
  });

  it("recomputes on window resize, media load, and async renderer changes", () => {
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

  it("corrects an unobserved layout shift on the next scroll frame", () => {
    const harness = renderActiveHeadingHarness([0, 200, 400]);
    harness.scrollTo(350);
    expect(harness.activeText()).toBe("Review");

    harness.setTops([0, 800, 1_100]);
    harness.scrollTo(351);

    expect(harness.activeText()).toBe("Intro");
  });
});
