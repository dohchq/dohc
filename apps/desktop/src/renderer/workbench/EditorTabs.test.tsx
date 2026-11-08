// @vitest-environment jsdom
import { editorTabTestId } from "../../testPins";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { useFocusSurface } from "../ui/focusReturn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cornerRadius, EditorTabs } from "./EditorTabs";
import { NARROW_GROUP_HIDDEN } from "./tabRowActions";
import { shortcutText } from "../../shortcuts/shortcutRegistry";
import {
  CHATS_TAB_PATH,
  GRAPH_TAB_PATH,
  HISTORY_TAB_PATH,
  chatTabPath,
  collectionTabPath,
  momentDiffTabPath,
  siteTabPath,
  transactionalCollectionTabPath,
  versionCompareTabPath,
} from "./workbenchState";

beforeEach(() => {
  // jsdom doesn't implement pointer capture, which the scrollbar thumb drag
  // uses.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

const noop = () => {};
// The split's chord, as its tab list row shows it after the name.
const SPLIT_KEYS = shortcutText("new-editor-group-right", undefined);
const tabs = [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }];

function renderTabs(activeTab: string) {
  return render(
    <EditorTabs
      groupId="left"
      groupNumber={1}
      tabs={tabs}
      activeTab={activeTab}
      activeTabDirty={false}
      recoveryPaths={new Set<string>()}
      onActivate={noop}
      onClose={noop}
      onContextMenu={noop}
      onMove={noop}
      onMoveToGroup={noop}
      onCreateGroupRight={noop}
    />,
  );
}

describe("EditorTabs strip scrolling", () => {
  it("gives every tab's close the tooltip Close", () => {
    renderTabs("b.md");
    for (const path of ["a.md", "b.md", "c.md"]) {
      expect(screen.getByRole("button", { name: `Close ${path}` }).getAttribute("title")).toBe("Close");
    }
  });

  it.each([
    [siteTabPath("apps/trip"), "Discovered name", "apps/trip"],
    [collectionTabPath("notes/旅"), "旅", "notes/旅"],
  ])("keeps the tab-strip title and tooltip for %s", (path, title, tooltip) => {
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }]}
        activeTab={path}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        tabLabels={new Map([[path, "Discovered name"]])}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );
    const tab = screen.getByTestId(editorTabTestId(path));
    expect(tab.textContent).toBe(title);
    expect(tab.getAttribute("title")).toBe(tooltip);
    expect(screen.getByRole("button", { name: "Close " + title })).toBeTruthy();
  });

  it.each([
    ["notes/旅.md", "tab-notes/旅.md"],
    ["notes/tab://example.md", "tab-notes/tab://example.md"],
    ["notes/dohc://example.md", "tab-notes/dohc://example.md"],
    [GRAPH_TAB_PATH, "tab-dohc://graph"],
    [HISTORY_TAB_PATH, "tab-dohc://history"],
    [CHATS_TAB_PATH, "tab-dohc://chats"],
    [chatTabPath({ kind: "new" }), "tab-dohc://chats/new"],
    [chatTabPath({ kind: "channel", id: "team/one" }), "tab-dohc://chats/channel/team%2Fone"],
    [chatTabPath({ kind: "dm", id: "person one" }), "tab-dohc://chats/dm/person%20one"],
    [siteTabPath("apps/trip"), "tab-dohc://app/apps%2Ftrip"],
    [collectionTabPath("notes/旅"), "tab-dohc://collection/notes%2F%E6%97%85"],
    [versionCompareTabPath("try/one"), "tab-dohc://versions/compare/try%2Fone"],
    [momentDiffTabPath("moment one"), "tab-dohc://moment-diff/moment%20one"],
    ["tab://collection/a/b", "tab-dohc://collection/a/b"],
    ["tab://collection/a%2fb", "tab-dohc://collection/a%2fb"],
    ["tab://versions/compare/a%2fb", "tab-dohc://versions/compare/a%2fb"],
    ["tab://moment-diff/%E0", "tab-dohc://moment-diff/%E0"],
    [
      transactionalCollectionTabPath("data/dataset.json", "00000000-0000-4000-8000-000000000002"),
      "tab-dohc://data-collection/data%2Fdataset.json/00000000-0000-4000-8000-000000000002",
    ],
  ])("keeps the pinned selector for %s", (path, testId) => {
    const onActivate = vi.fn();
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }]}
        activeTab={path}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={onActivate}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );
    const sharedId = editorTabTestId(path);
    expect(sharedId).toBe(testId);
    const tab = screen.getByTestId(sharedId);
    fireEvent.keyDown(tab, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith("left", path);
  });

  it("names data Collection tabs from discovery without changing their stable identity",()=>{
    const path=transactionalCollectionTabPath("data/dataset.json","00000000-0000-4000-8000-000000000002");
    const props={groupId:"left",groupNumber:1,tabs:[{path}],activeTab:path,activeTabDirty:false,recoveryPaths:new Set<string>(),onActivate:noop,onClose:noop,onContextMenu:noop,onMove:noop,onMoveToGroup:noop,onCreateGroupRight:noop};
    const mounted=render(<EditorTabs {...props}/>);
    expect(screen.getByTestId("tab-dohc://data-collection/data%2Fdataset.json/00000000-0000-4000-8000-000000000002").textContent).toContain("Collection");
    mounted.rerender(<EditorTabs {...props} tabLabels={new Map([[path,"Registrations"]])}/>);
    const tab=screen.getByTestId("tab-dohc://data-collection/data%2Fdataset.json/00000000-0000-4000-8000-000000000002");expect(tab.textContent).toContain("Registrations");expect(tab.title).toBe("Collection: Registrations");expect(tab.textContent).not.toContain("00000000");
  });
  it("names current history changes after their file, never the internal moment id", () => {
    const path = momentDiffTabPath("moment-ydoc-internal-hash");
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }]}
        activeTab={path}
        activeTabDirty={false}
        tabLabels={new Map([[path, "notes/plan.md"]])}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Diff: plan.md" });
    expect(tab.title).toBe("History diff: notes/plan.md");
    expect(tab.textContent).not.toContain("moment-ydoc");
  });

  it("gives an unresolved moment tab a neutral label instead of a raw id", () => {
    const path = momentDiffTabPath("moment-ydoc-internal-hash");
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }]}
        activeTab={path}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );

    expect(screen.getByRole("tab", { name: "History change" })).toBeTruthy();
  });

  it("is a single horizontal row: overflow-x scrolls, overflow-y is locked", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("overflow-y-hidden");
    // The class is the hook the scrollbar-hiding rule in styles.css targets.
    expect(strip.className).toContain("dohc-tab-strip");
  });

  describe("revealing the active tab", () => {
    // jsdom has no layout: five 100px tabs at 100px steps, then the strip's
    // 16px of trailing hairline, in a strip `width.current` wide.
    const fiveTabs = ["a.md", "b.md", "c.md", "d.md", "e.md"].map((path) => ({ path }));
    const width = { current: 250 };
    const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollLeft = options.left ?? 0;
    });
    // jsdom has no ResizeObserver: this one reports a resize when told to.
    const observers = new Set<ResizeObserverCallback>();
    class TestResizeObserver {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.callback);
      }
    }
    const resize = (next: number) => {
      width.current = next;
      for (const callback of [...observers]) callback([], {} as ResizeObserver);
    };
    beforeEach(() => {
      width.current = 250;
      observers.clear();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return Math.max(0, fiveTabs.findIndex((tab) => this.dataset.testid === `tab-${tab.path}`)) * 100;
      });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width.current);
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(516);
      HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
      scrollTo.mockClear();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    });

    function renderStrip(activeTab: string, activeTabDirty = false) {
      return (
        <EditorTabs
          groupId="left"
          groupNumber={1}
          tabs={fiveTabs}
          activeTab={activeTab}
          activeTabDirty={activeTabDirty}
          recoveryPaths={new Set<string>()}
          onActivate={noop}
          onClose={noop}
          onContextMenu={noop}
          onMove={noop}
          onMoveToGroup={noop}
          onCreateGroupRight={noop}
        />
      );
    }

    // Only the strip scrolls: scrollIntoView would scroll every scrolling
    // ancestor too, the window included. A revealed tab stops 49px from a
    // faded edge: the 40px fade and its 9px join.
    it("reveals the active tab clear of the fades when activation changes by any means, scrolling only the strip", () => {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
      const { rerender } = render(renderStrip("a.md"));
      const strip = screen.getByRole("tablist");
      // The first tab is already in view, so mounting scrolls nothing.
      expect(scrollTo).not.toHaveBeenCalled();

      // So is b.md, which ends 50px inside the strip's 250px view.
      rerender(renderStrip("b.md"));
      expect(scrollTo).not.toHaveBeenCalled();

      // d.md ends at 400px: its end 49px inside the view.
      rerender(renderStrip("d.md"));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 199, behavior: "smooth" });
      expect(scrollTo.mock.contexts[0]).toBe(strip);

      // b.md starts at 100px, left of the view: its start 49px inside.
      rerender(renderStrip("b.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 51, behavior: "smooth" });

      // e.md is last: the strip scrolls to its end, which has no fade.
      rerender(renderStrip("e.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 266, behavior: "smooth" });

      // a.md is first: back to the start.
      rerender(renderStrip("a.md"));
      expect(scrollTo).toHaveBeenCalledTimes(4);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "smooth" });
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(windowScroll).not.toHaveBeenCalled();
    });

    it("reveals the active tab at once when the strip narrows it out of view, and leaves an in-view one alone", () => {
      width.current = 516;
      const { rerender } = render(renderStrip("d.md"));
      const strip = screen.getByRole("tablist");
      expect(scrollTo).not.toHaveBeenCalled();

      // A split narrows the strip to 250px: d.md, ending at 400px, is out of
      // view, and comes back without an animation.
      resize(250);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 199, behavior: "auto" });

      // Widened, the tab is still in view: nothing scrolls.
      resize(300);
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // Scrolled away by hand, the strip stays put through scrolling and
      // re-renders that change neither the active tab nor the width.
      strip.scrollLeft = 0;
      fireEvent.scroll(strip);
      rerender(renderStrip("d.md", true));
      resize(300);
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // The next width change reveals it again.
      resize(260);
      expect(scrollTo).toHaveBeenCalledTimes(2);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 189, behavior: "auto" });
    });

    // Places the tabs a test names at [left, width] over `content` px of tabs
    // and trailing hairline, and answers where a tab sits in the view.
    function layOut(content: number, boxes: Record<string, [number, number]>) {
      const box = (el: HTMLElement) => boxes[el.dataset.testid?.slice(4) ?? ""] ?? [0, 0];
      vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return box(this)[0];
      });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return box(this)[1];
      });
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(content);
      return (path: string) => {
        const [left, size] = boxes[path] ?? [0, 0];
        const scrolled = screen.getByRole("tablist").scrollLeft;
        return { start: left - scrolled, end: left + size - scrolled };
      };
    }

    // The strip's end does not fade, so a last tab needs no margin there; the
    // 49px margin at its start does not fit beside a 224px tab in 250px.
    it("reveals a last tab with no room for its margin whole, at the strip's end", () => {
      const span = layOut(640, { "a.md": [0, 100], "e.md": [400, 224] });
      const { rerender } = render(renderStrip("a.md"));
      const strip = screen.getByRole("tablist");
      rerender(renderStrip("e.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 390, behavior: "smooth" });
      expect(span("e.md")).toEqual({ start: 10, end: 234 });

      // Already shown there, it does not move.
      rerender(renderStrip("a.md"));
      strip.scrollLeft = 390;
      scrollTo.mockClear();
      rerender(renderStrip("e.md"));
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("reveals a first tab with no room for its margin whole, at the strip's start", () => {
      const span = layOut(640, { "a.md": [0, 224], "e.md": [400, 100] });
      const { rerender } = render(renderStrip("e.md"));
      rerender(renderStrip("a.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "smooth" });
      expect(span("a.md")).toEqual({ start: 0, end: 224 });
    });

    // A 49px margin would scroll a tab's start out of a 40px strip.
    it("shows the start of a tab wider than a strip too narrow for its margin", () => {
      width.current = 40;
      const span = layOut(640, { "a.md": [0, 100], "c.md": [100, 100] });
      const { rerender } = render(renderStrip("a.md"));
      rerender(renderStrip("c.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 100, behavior: "smooth" });
      expect(span("c.md")).toEqual({ start: 0, end: 100 });
    });

    // A tab that can't clear both fades starts at the strip's start, and the
    // left fade gives way to it while the right one still shows more tabs.
    it("shows a tab wider than the strip from the strip's start, with no left fade", () => {
      width.current = 150;
      const span = layOut(640, { "a.md": [0, 100], "c.md": [100, 200] });
      const { rerender } = render(renderStrip("a.md"));
      const strip = screen.getByRole("tablist");
      rerender(renderStrip("c.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 100, behavior: "smooth" });
      expect(span("c.md")).toEqual({ start: 0, end: 200 });
      expect(strip.hasAttribute("data-overflow-left")).toBe(false);
      expect(strip.hasAttribute("data-overflow-right")).toBe(true);

      // Narrower still, it stays where it is.
      scrollTo.mockClear();
      resize(80);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(span("c.md")).toEqual({ start: 0, end: 200 });

      // Scrolled by hand off the strip's start, the left fade comes back.
      strip.scrollLeft = 30;
      fireEvent.scroll(strip);
      expect(strip.hasAttribute("data-overflow-left")).toBe(true);
    });

    it("reveals a middle tab with room for both margins clear of both fades, and leaves it where it is clear", () => {
      const span = layOut(640, { "a.md": [0, 100], "c.md": [300, 150] });
      const { rerender } = render(renderStrip("a.md"));
      const strip = screen.getByRole("tablist");
      rerender(renderStrip("c.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 249, behavior: "smooth" });
      expect(span("c.md")).toEqual({ start: 51, end: 201 });
      expect(strip.hasAttribute("data-overflow-left")).toBe(true);
      expect(strip.hasAttribute("data-overflow-right")).toBe(true);

      strip.scrollLeft = 250;
      scrollTo.mockClear();
      resize(251);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("reveals a middle tab with no room for both margins whole, clear of both fades or at the strip's start", () => {
      const span = layOut(640, { "a.md": [0, 100], "c.md": [300, 220], "d.md": [300, 160] });
      const { rerender } = render(renderStrip("a.md"));
      const strip = screen.getByRole("tablist");
      // 30px of room can't clear both fades: the tab starts at the strip's
      // start, with no left fade.
      rerender(renderStrip("c.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, behavior: "smooth" });
      expect(span("c.md")).toEqual({ start: 0, end: 220 });
      expect(strip.hasAttribute("data-overflow-left")).toBe(false);
      expect(strip.hasAttribute("data-overflow-right")).toBe(true);

      // 90px of room clears both 40px fades, if not the joins beside them:
      // the nearest such scroll, and none while the tab is already clear.
      rerender(renderStrip("d.md"));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 260, behavior: "smooth" });
      expect(span("d.md")).toEqual({ start: 40, end: 200 });
      strip.scrollLeft = 255;
      scrollTo.mockClear();
      resize(251);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  // styles.css shows each fade from the strip's attributes through a sibling
  // selector, so the fades follow the strip in its frame. They draw over the
  // other tabs and under the active one (z-10), and take no clicks.
  it("draws the edge fades after the strip, under the active tab, taking no clicks", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    const fades = [...screen.getByTestId("editor-tabs").querySelectorAll<HTMLElement>("[data-strip-fade]")];
    expect(fades.map((fade) => fade.dataset.stripFade)).toEqual(["left", "right"]);
    for (const fade of fades) {
      expect(fade.parentElement).toBe(strip.parentElement);
      expect(strip.compareDocumentPosition(fade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const drawn = (fade.className.includes("absolute") ? fade : fade.firstElementChild) as HTMLElement;
      expect(drawn.className.split(" ")).toEqual(expect.arrayContaining(["pointer-events-none", "z-[6]"]));
    }
    expect(screen.getByRole("tab", { selected: true }).className).toContain("z-10");
  });

  // A cut name's first two or three letters sit in the fade's solid outer
  // 16px, so no short fragment shows, and the fade runs to the strip's own
  // fill. The left fade runs rightward from the left edge, the right one
  // leftward from the right edge.
  it("fades each edge over 40px from the strip's own fill, solid over the outer 16px", () => {
    renderTabs("a.md");
    const frame = screen.getByTestId("editor-tabs");
    expect(frame.className.split(" ")).toContain("bg-panel");
    const drawn = (side: string) => {
      const fade = frame.querySelector<HTMLElement>(`[data-strip-fade="${side}"]`);
      return ((fade?.className.includes("absolute") ? fade : fade?.firstElementChild) as HTMLElement).className.split(" ");
    };
    for (const [side, direction] of [["left", "bg-linear-to-r"], ["right", "bg-linear-to-l"]] as const) {
      expect(drawn(side)).toEqual(
        expect.arrayContaining(["w-10", "from-panel", "from-40%", "to-transparent", direction, `${side}-0`]),
      );
    }
  });

  // The strip's buttons rest at the muted tone of the other tab-row controls.
  it("tones the strip's buttons muted at rest", () => {
    // An empty group's strip holds the group close.
    const group = (groupId: string, groupNumber: number, groupTabs: typeof tabs) => (
      <EditorTabs
        groupId={groupId}
        groupNumber={groupNumber}
        tabs={groupTabs}
        activeTab={groupTabs[0]?.path ?? null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
        onCloseGroup={noop}
      />
    );
    render(<>{group("left", 1, tabs)}{group("right", 2, [])}</>);
    const buttons = [
      screen.getByTestId("tabs-overflow"),
      ...screen.getAllByTestId("create-editor-group-right"),
      screen.getByRole("button", { name: "Close editor group" }),
    ];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      const classes = button.className.split(" ");
      expect(classes).toContain("text-muted");
      expect(classes.filter((name) => name.includes("text-subtle"))).toEqual([]);
    }
  });

  // The fades in styles.css read these: an edge the strip can still scroll
  // past fades, and an edge it has reached does not.
  it("marks the edges the strip can still scroll past", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    const edges = () => ({
      left: strip.hasAttribute("data-overflow-left"),
      right: strip.hasAttribute("data-overflow-right"),
    });
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 200 });
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: false, right: false });

    // A pixel over is rounding a fraction of one, not a hidden tab.
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 201 });
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: false, right: false });

    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 600 });
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: false, right: true });

    strip.scrollLeft = 200;
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: true, right: true });

    strip.scrollLeft = 400;
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: true, right: false });

    // A pixel short of an edge has reached it.
    strip.scrollLeft = 399;
    fireEvent.scroll(strip);
    expect(edges()).toEqual({ left: true, right: false });
  });

  it("translates a vertical wheel into horizontal scroll when overflowing", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    // jsdom has no layout: fake an overflowing strip.
    Object.defineProperty(strip, "scrollWidth", { value: 600 });
    Object.defineProperty(strip, "clientWidth", { value: 200 });

    const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(40);
    expect(wheel.defaultPrevented).toBe(true);

    // Horizontal trackpad pans keep their native scroll.
    const pan = new WheelEvent("wheel", { deltaX: 40, deltaY: 40, cancelable: true });
    strip.dispatchEvent(pan);
    expect(strip.scrollLeft).toBe(40);
    expect(pan.defaultPrevented).toBe(false);
  });

  it("leaves the wheel alone when the tabs fit", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    strip.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("dismisses the overflow menu when the group becomes empty", () => {
    const { rerender } = renderTabs("a.md");
    fireEvent.click(screen.getByTestId("tabs-overflow"));
    expect(screen.getByTestId("tabs-overflow-menu")).toBeTruthy();

    rerender(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[]}
        activeTab={null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );

    expect(screen.queryByTestId("tabs-overflow-menu")).toBeNull();
  });

  it("marks the overflow menu's active row apart from the current tab's row", async () => {
    const user = userEvent.setup();
    renderTabs("b.md");
    await user.click(screen.getByTestId("tabs-overflow"));
    const active = screen.getByRole("menuitem", { name: "a.md" });
    const current = screen.getByRole("menuitem", { name: "b.md" });
    expect(document.activeElement).toBe(active);
    // Both rows can hold the selected fill, so the keyboard's row line marks
    // the active one.
    expect(current.classList).toContain("bg-selected");
    expect(active.classList).toContain("focus:bg-selected");
    expect(active.classList).toContain("dohc-focus-row");
  });

  it("reports a press that ends in a release, Enter or Space, and an All tabs pick as a press after any activation", async () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    const user = userEvent.setup();
    const calls: string[] = [];
    const press = (target: HTMLElement, init: { ctrlKey?: boolean } = {}) => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 10, ...init });
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
    };
    try {
      render(
        <EditorTabs
          groupId="left"
          groupNumber={1}
          tabs={tabs}
          activeTab="a.md"
          activeTabDirty={false}
          recoveryPaths={new Set<string>()}
          onActivate={(_, path) => calls.push(`activate ${path}`)}
          onPress={(_, path) => calls.push(`press ${path}`)}
          onClose={(_, path) => calls.push(`close ${path}`)}
          onContextMenu={noop}
          onMove={noop}
          onMoveToGroup={noop}
          onCreateGroupRight={noop}
        />,
      );
      press(screen.getByTestId("tab-a.md"));
      press(screen.getByTestId("tab-b.md"));
      fireEvent.keyDown(screen.getByTestId("tab-a.md"), { key: "Enter" });
      fireEvent.keyDown(screen.getByTestId("tab-b.md"), { key: " " });
      const close = screen.getByRole("button", { name: "Close a.md" });
      press(close);
      fireEvent.click(close);
      // A macOS Control press opens the context menu.
      press(screen.getByTestId("tab-c.md"), { ctrlKey: true });
      // The shown tab, picked in All tabs.
      await user.click(screen.getByTestId("tabs-overflow"));
      await user.click(screen.getByRole("menuitem", { name: "a.md" }));
      expect(calls).toEqual([
        "press a.md",
        "activate b.md",
        "press b.md",
        "activate a.md",
        "press a.md",
        "activate b.md",
        "press b.md",
        "close a.md",
        "activate a.md",
        "press a.md",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the overflow menu clear of the window's right edge", async () => {
    const user = userEvent.setup();
    renderTabs("a.md");
    const trigger = screen.getByTestId("tabs-overflow");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
      { top: 40, bottom: 68, left: 992, right: 1020, width: 28, height: 28, x: 992, y: 40, toJSON: () => ({}) },
    );
    vi.stubGlobal("innerWidth", 1024);
    try {
      await user.click(trigger);
      expect(screen.getByTestId("tabs-overflow-menu").style.left).toBe(`${1024 - 12 - 240}px`);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("EditorTabs pointer drag", () => {
  const frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    for (const frame of frames.splice(0)) frame(0);
  };
  // jsdom has no Web Animations: the settle returns an inert animation. The
  // prototype assignment is not a Vitest stub, so it is restored by hand.
  const inertAnimation = () =>
    ({ cancel: vi.fn(), commitStyles: vi.fn(), addEventListener: vi.fn() }) as unknown as Animation;
  const animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) =>
      frames.push(frame),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.splice(id - 1, 1);
    });
    Element.prototype.animate = vi.fn(inertAnimation);
  });
  afterEach(() => {
    frames.length = 0;
    vi.unstubAllGlobals();
    if (animateDescriptor) {
      Object.defineProperty(Element.prototype, "animate", animateDescriptor);
    } else {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  // jsdom has no layout: lay the tabs out as 100px slots and give the strip
  // a 600px viewport, which is what the drag geometry reads.
  function layOut(paneWidth = 600) {
    Object.defineProperty(screen.getByRole("tablist"), "clientWidth", {
      configurable: true,
      value: paneWidth,
    });
    Object.defineProperty(screen.getByTestId("editor-tabs"), "clientWidth", {
      configurable: true,
      value: paneWidth,
    });
    screen.getAllByRole("tab").forEach((tab, index) => {
      Object.defineProperty(tab, "offsetLeft", { configurable: true, value: index * 100 });
      Object.defineProperty(tab, "offsetWidth", { configurable: true, value: 100 });
      Object.defineProperty(tab, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: index * 100, width: 100 }),
      });
    });
  }

  function renderGroup(order = tabs) {
    const onMove = vi.fn();
    const onMoveToGroup = vi.fn();
    const onPress = vi.fn();
    const strip = (current: typeof tabs) => (
      <div data-editor-group-id="left">
        <EditorTabs
          groupId="left"
          groupNumber={1}
          tabs={current}
          activeTab="a.md"
          activeTabDirty={false}
          recoveryPaths={new Set<string>()}
          onActivate={noop}
          onClose={noop}
          onContextMenu={noop}
          onMove={onMove}
          onMoveToGroup={onMoveToGroup}
          onPress={onPress}
          onCreateGroupRight={noop}
        />
      </div>
    );
    const view = render(strip(order));
    layOut();
    return {
      onMove,
      onMoveToGroup,
      onPress,
      unmount: view.unmount,
      reorder: (current: typeof tabs) => view.rerender(strip(current)),
    };
  }

  function dragTab(tab: HTMLElement, pointerId: number, toX: number) {
    vi.mocked(document.elementFromPoint).mockReturnValue(tab);
    fireEvent.pointerDown(tab, { button: 0, pointerId, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tab, { pointerId, buttons: 1, clientX: toX, clientY: 10 });
    flushFrames();
  }

  it("leaves a macOS Control press to the context menu instead of dragging", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    try {
      renderGroup();
      const second = screen.getByTestId("tab-b.md");
      vi.mocked(document.elementFromPoint).mockReturnValue(second);
      fireEvent.pointerDown(second, { button: 0, ctrlKey: true, pointerId: 3, clientX: 110, clientY: 10 });
      fireEvent.pointerMove(second, { pointerId: 3, buttons: 1, clientX: 260, clientY: 10 });
      flushFrames();
      expect(second.dataset.dragging).toBeUndefined();
      expect(second.style.transform).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves the pressed tab under the pointer and shifts the tabs it passes", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    const second = screen.getByTestId("tab-b.md");
    const third = screen.getByTestId("tab-c.md");

    dragTab(first, 4, 260);
    // Pressed 10px into the tab, so its left edge follows to 250px, and both
    // tabs whose midpoints it passed slide left by its width.
    expect(first.style.transform).toBe("translateX(250px)");
    expect(first.dataset.dragging).toBe("");
    expect(second.style.transform).toBe("translateX(-100px)");
    expect(third.style.transform).toBe("translateX(-100px)");
    // Nothing commits per move.
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 120, clientY: 10 });
    flushFrames();
    expect(first.style.transform).toBe("translateX(110px)");
    expect(second.style.transform).toBe("translateX(-100px)");
    expect(third.style.transform).toBe("");

    fireEvent.pointerUp(first, { pointerId: 4, clientX: 120, clientY: 10 });
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
    expect(first.dataset.dragging).toBeUndefined();
    expect(second.style.transform).toBe("");
    expect(third.style.transform).toBe("");
  });

  it("reports a press when a drag that moved the tab ends in a release, and none when it's cancelled", () => {
    const { onMove, onPress } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 260);
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 260, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 2);
    expect(onPress).toHaveBeenCalledExactlyOnceWith("left", "a.md");
    dragTab(first, 5, 260);
    fireEvent.pointerCancel(first, { pointerId: 5 });
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("counts the release position even when its frame never ran", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    vi.mocked(document.elementFromPoint).mockReturnValue(first);
    fireEvent.pointerDown(first, { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 260, clientY: 10 });
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 260, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 2);
  });

  it("settles the moved tab from where it was released into its new slot", () => {
    const { onMove, reorder } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 260);
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 260, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 2);
    // The commit re-renders the strip with the tab in its new slot.
    Object.defineProperty(first, "offsetLeft", { configurable: true, value: 200 });
    reorder([{ path: "b.md" }, { path: "c.md" }, { path: "a.md" }]);
    expect(first.style.transform).toBe("");
    // Released with its left edge at 250px and now laid out at 200px, it
    // slides the remaining 50px.
    expect(first.animate).toHaveBeenCalledWith(
      [{ transform: "translateX(50px)" }, { transform: "none" }],
      expect.objectContaining({ duration: 160 }),
    );
  });

  it("returns the tab to its slot when a commit never re-renders the strip", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 260);
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 260, clientY: 10 });
    expect(onMove).toHaveBeenCalledOnce();
    expect(first.style.transform).toBe("translateX(250px)");
    flushFrames();
    expect(first.style.transform).toBe("");
  });

  it("commits the last position when the pointer is cancelled", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    fireEvent.pointerCancel(first, { pointerId: 4 });
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
    expect(screen.getByTestId("tab-b.md").style.transform).toBe("");
  });

  it("ends a drag whose release was missed", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    // A buttons-up move is the first sign the mouse was released elsewhere.
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 0, clientX: 300, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
    expect(first.dataset.dragging).toBeUndefined();
    // Hovering afterwards reorders nothing.
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 260, clientY: 10 });
    flushFrames();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("drops the preview when the strip unmounts mid-drag", () => {
    const { onMove, unmount } = renderGroup();
    dragTab(screen.getByTestId("tab-a.md"), 4, 260);
    unmount();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("re-measures when the tab list changes under the drag", () => {
    const { onMove, reorder } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    const third = screen.getByTestId("tab-c.md");
    expect(screen.getByTestId("tab-b.md").style.transform).toBe("translateX(-100px)");
    // b closes: c now lays out in its slot, and the strip re-measures when
    // the new list renders.
    Object.defineProperty(third, "offsetLeft", { configurable: true, value: 100 });
    reorder([{ path: "a.md" }, { path: "c.md" }]);
    // The pointer is still 150px in; the remaining neighbour derives its
    // displacement from the fresh layout.
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 160, clientY: 10 });
    flushFrames();
    expect(screen.getByTestId("tab-c.md").style.transform).toBe("translateX(-100px)");
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 160, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
  });

  it("moves a tab to an empty group when released over its editor body, and reports the press there", () => {
    const onMove = vi.fn();
    const onMoveToGroup = vi.fn();
    const onPress = vi.fn();
    render(
      <>
        <div data-editor-group-id="left">
          <EditorTabs
            groupId="left"
            groupNumber={1}
            tabs={tabs}
            activeTab="a.md"
            activeTabDirty={false}
            recoveryPaths={new Set<string>()}
            onActivate={noop}
            onClose={noop}
            onContextMenu={noop}
            onMove={onMove}
            onMoveToGroup={onMoveToGroup}
            onPress={onPress}
            onCreateGroupRight={noop}
          />
        </div>
        <div data-editor-group-id="right">
          <div data-testid="empty-right-editor" />
        </div>
      </>,
    );
    layOut();
    const source = screen.getByTestId("tab-a.md");
    const target = screen.getByTestId("empty-right-editor");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(source, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(source, { pointerId: 7, buttons: 1, clientX: 500, clientY: 200 });
    flushFrames();
    // The source strip previews nothing for a move that belongs elsewhere.
    expect(source.style.transform).toBe("");
    fireEvent.pointerUp(source, { pointerId: 7, clientX: 500, clientY: 200 });

    expect(onMove).not.toHaveBeenCalled();
    expect(onMoveToGroup).toHaveBeenCalledOnce();
    expect(onMoveToGroup).toHaveBeenCalledWith("left", "right", "a.md", 0);
    // The tab now belongs to the group it was dropped on.
    expect(onPress).toHaveBeenCalledExactlyOnceWith("right", "a.md");
  });

  it("reaches the last slot with a tab wider than the room left beside it", () => {
    const { onMove } = renderGroup();
    // a is 200px wide in a 316px strip: clamped inside the strip, its centre
    // never passes c, so the slot comes from the unclamped pointer position.
    const [first, second, third] = screen.getAllByRole("tab");
    Object.defineProperty(screen.getByRole("tablist"), "clientWidth", { configurable: true, value: 316 });
    Object.defineProperty(first, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(second, "offsetLeft", { configurable: true, value: 200 });
    Object.defineProperty(third, "offsetLeft", { configurable: true, value: 300 });
    dragTab(first, 4, 400);
    expect(first.style.transform).toBe("translateX(116px)");
    expect(third.style.transform).toBe("translateX(-200px)");
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 400, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 2);
  });

  it("shows the committed order while the pointer is over another group", () => {
    const onMove = vi.fn();
    const onMoveToGroup = vi.fn();
    render(
      <>
        <div data-editor-group-id="left">
          <EditorTabs
            groupId="left"
            groupNumber={1}
            tabs={tabs}
            activeTab="a.md"
            activeTabDirty={false}
            recoveryPaths={new Set<string>()}
            onActivate={noop}
            onClose={noop}
            onContextMenu={noop}
            onMove={onMove}
            onMoveToGroup={onMoveToGroup}
            onCreateGroupRight={noop}
          />
        </div>
        <div data-editor-group-id="right">
          <div data-testid="empty-right-editor" />
        </div>
      </>,
    );
    layOut();
    const first = screen.getByTestId("tab-a.md");
    const second = screen.getByTestId("tab-b.md");
    dragTab(first, 4, 160);
    expect(second.style.transform).toBe("translateX(-100px)");

    vi.mocked(document.elementFromPoint).mockReturnValue(screen.getByTestId("empty-right-editor"));
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 700, clientY: 200 });
    flushFrames();
    expect(second.style.transform).toBe("");
    // The dragged tab returns home too, with its corners at rest.
    expect(first.style.transform).toBe("");
    expect(
      (first.querySelector('[data-tab-join="left"]')?.firstElementChild as HTMLElement).style
        .borderRadius,
    ).toBe("0px 0px 1px 0px");

    vi.mocked(document.elementFromPoint).mockReturnValue(first);
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 160, clientY: 10 });
    flushFrames();
    expect(second.style.transform).toBe("translateX(-100px)");
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 160, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
    expect(onMoveToGroup).not.toHaveBeenCalled();
  });

  it("follows the strip when it scrolls under a held pointer", () => {
    renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    expect(first.style.transform).toBe("translateX(150px)");
    const strip = screen.getByRole("tablist");
    strip.scrollLeft = 50;
    fireEvent.scroll(strip);
    flushFrames();
    // The pointer stayed put, so the tab moved 50px further into the content.
    expect(first.style.transform).toBe("translateX(200px)");
  });

  it("keeps the last painted position when cancelled with a move still queued", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    fireEvent.pointerMove(first, { pointerId: 4, buttons: 1, clientX: 260, clientY: 10 });
    fireEvent.pointerCancel(first, { pointerId: 4 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
  });

  it("stops a settling tab where it is when it is grabbed again", () => {
    const animation = { cancel: vi.fn(), commitStyles: vi.fn(), addEventListener: vi.fn() };
    Element.prototype.animate = vi.fn(() => animation as unknown as Animation);
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    // A short drag that changes nothing settles in place.
    dragTab(first, 4, 40);
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 40, clientY: 10 });
    expect(onMove).not.toHaveBeenCalled();
    expect(first.animate).toHaveBeenCalledOnce();

    fireEvent.pointerDown(first, { button: 0, pointerId: 5, clientX: 10, clientY: 10 });
    expect(animation.commitStyles).toHaveBeenCalledOnce();
    expect(animation.cancel).toHaveBeenCalledOnce();
    // A press that stays a click leaves no frozen transform behind.
    fireEvent.pointerUp(first, { pointerId: 5, clientX: 10, clientY: 10 });
    expect(first.style.transform).toBe("");
  });

  it("lands a neighbour that is still settling before it slides aside", () => {
    const neighbourAnimation = { cancel: vi.fn(), commitStyles: vi.fn(), addEventListener: vi.fn() };
    const { onMove, reorder } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    const second = screen.getByTestId("tab-b.md");
    // a moves past b and settles into its new slot.
    dragTab(first, 4, 160);
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 160, clientY: 10 });
    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
    Element.prototype.animate = vi.fn(() => neighbourAnimation as unknown as Animation);
    Object.defineProperty(first, "offsetLeft", { configurable: true, value: 100 });
    reorder([{ path: "b.md" }, { path: "a.md" }, { path: "c.md" }]);
    expect(first.animate).toHaveBeenCalledOnce();

    // Grabbing b while a still settles lands a first.
    layOut();
    dragTab(second, 5, 160);
    expect(neighbourAnimation.cancel).toHaveBeenCalledOnce();
    expect(neighbourAnimation.commitStyles).not.toHaveBeenCalled();
    expect(first.style.transform).toBe("translateX(-100px)");
  });

  it("starts a new drag after cancelling an unfinished pointer", () => {
    const { onMove } = renderGroup();
    const first = screen.getByTestId("tab-a.md");
    dragTab(first, 4, 160);
    onMove.mockClear();

    dragTab(first, 5, 160);
    fireEvent.pointerUp(first, { pointerId: 5, clientX: 160, clientY: 10 });

    expect(onMove).toHaveBeenCalledWith("left", "a.md", 1);
  });
});

describe("EditorTabs corner morph", () => {
  // The morph is the one rounded corner of each arc; the rest of the
  // shorthand stays square.
  function cornerWidths() {
    const active = screen.getByRole("tab", { selected: true });
    const radius = (selector: string, root: ParentNode = document) =>
      (root.querySelector(selector)?.firstElementChild as HTMLElement | null)?.style
        .borderRadius;
    return {
      joinLeft: radius('[data-tab-join="left"]', active),
      joinRight: radius('[data-tab-join="right"]', active),
      paneLeft: radius('[data-pane-corner="left"]'),
      paneRight: radius('[data-pane-corner="right"]'),
    };
  }

  function layOut(activeLeft: number) {
    Object.defineProperty(screen.getByTestId("editor-tabs"), "clientWidth", {
      configurable: true,
      value: 600,
    });
    const active = screen.getByRole("tab", { selected: true });
    Object.defineProperty(active, "offsetLeft", { configurable: true, value: activeLeft });
    Object.defineProperty(active, "offsetWidth", { configurable: true, value: 100 });
    fireEvent.scroll(screen.getByRole("tablist"));
  }

  it("squares the pane corner and the join beside a tab at the pane edge", () => {
    renderTabs("a.md");
    layOut(0);
    // A zero radius leaves a one-pixel rounding on the hairline corner.
    expect(cornerWidths()).toEqual({
      joinLeft: "0px 0px 1px 0px",
      joinRight: "0px 0px 0px 9px",
      paneLeft: "1px 0px 0px 0px",
      paneRight: "0px 9px 0px 0px",
    });
  });

  it("grows both radii over the 20px approach to the edge", () => {
    renderTabs("b.md");
    layOut(10);
    expect(cornerWidths().joinLeft).toBe("0px 0px 5px 0px");
    expect(cornerWidths().paneLeft).toBe("5px 0px 0px 0px");
    layOut(100);
    expect(cornerWidths().joinLeft).toBe("0px 0px 9px 0px");
    expect(cornerWidths().paneLeft).toBe("9px 0px 0px 0px");
  });

  it("follows the strip's scroll", () => {
    renderTabs("b.md");
    layOut(100);
    expect(cornerWidths().paneLeft).toBe("9px 0px 0px 0px");
    screen.getByRole("tablist").scrollLeft = 100;
    fireEvent.scroll(screen.getByRole("tablist"));
    expect(cornerWidths().paneLeft).toBe("1px 0px 0px 0px");
  });

  it("maps distance to radius", () => {
    expect(cornerRadius(-5)).toBe(0);
    expect(cornerRadius(0)).toBe(0);
    expect(cornerRadius(10)).toBe(4);
    expect(cornerRadius(20)).toBe(8);
    expect(cornerRadius(500)).toBe(8);
  });
});

describe("EditorTabs overlay scrollbar", () => {
  // jsdom has no layout: fake an overflowing strip, then poke the measure
  // via a scroll event (mount measured the un-faked zeros).
  function overflowStrip() {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    Object.defineProperty(strip, "scrollWidth", { value: 600 });
    Object.defineProperty(strip, "clientWidth", { value: 200 });
    fireEvent.scroll(strip);
    return strip;
  }

  it("stays hidden while the tabs fit", () => {
    renderTabs("a.md");
    fireEvent.scroll(screen.getByRole("tablist"));
    expect(screen.getByTestId("tab-strip-scrollbar").style.display).toBe("none");
  });

  it("paints a proportional thumb that tracks scrollLeft", () => {
    const strip = overflowStrip();
    const thumb = screen.getByTestId("tab-strip-scrollbar");
    expect(thumb.style.display).toBe("");
    // 200 of 600 visible -> thumb is a third of the 200px viewport…
    expect(parseFloat(thumb.style.width)).toBeCloseTo(200 / 3, 1);
    expect(thumb.style.transform).toBe("translateX(0px)");

    // …and scrolling 100 of the 400 overflow moves it a quarter of its
    // 133.33px travel.
    strip.scrollLeft = 100;
    fireEvent.scroll(strip);
    const translate = /translateX\(([\d.]+)px\)/.exec(thumb.style.transform);
    expect(parseFloat(translate?.[1] ?? "")).toBeCloseTo(100 / 3, 1);
  });

  it("translates a vertical wheel over the thumb into horizontal scroll", () => {
    const strip = overflowStrip();
    const thumb = screen.getByTestId("tab-strip-scrollbar");
    const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    thumb.dispatchEvent(wheel);
    expect(strip.scrollLeft).toBe(40);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("clamps the thumb to a narrow track", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    Object.defineProperty(strip, "scrollWidth", { value: 100 });
    Object.defineProperty(strip, "clientWidth", { value: 20 });
    fireEvent.scroll(strip);
    const thumb = screen.getByTestId("tab-strip-scrollbar");
    expect(parseFloat(thumb.style.width)).toBe(20);
    expect(thumb.style.transform).toBe("translateX(0px)");
  });

  it("scrolls the strip when the thumb is dragged", () => {
    const strip = overflowStrip();
    const thumb = screen.getByTestId("tab-strip-scrollbar");
    fireEvent.pointerDown(thumb, { button: 0, pointerId: 1, clientX: 10 });
    // 40px of pointer travel over the 133.33px track is 120px of the 400px
    // overflow.
    fireEvent.pointerMove(thumb, { pointerId: 1, buttons: 1, clientX: 50 });
    expect(strip.scrollLeft).toBeCloseTo(120, 1);
    fireEvent.pointerUp(thumb, { pointerId: 1 });

    // Released: plain pointer travel no longer scrolls.
    fireEvent.pointerMove(thumb, { pointerId: 1, buttons: 1, clientX: 90 });
    expect(strip.scrollLeft).toBeCloseTo(120, 1);
  });

  it("labels and invokes group-scoped controls", () => {
    const onCreateGroupRight = vi.fn();
    render(
      <EditorTabs
        groupId="left"
        groupNumber={2}
        tabs={tabs}
        activeTab="a.md"
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={onCreateGroupRight}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Editor group 2 tabs" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "All tabs in editor group 2" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "New editor group right" }),
    );
    expect(onCreateGroupRight).toHaveBeenCalledOnce();
    expect(onCreateGroupRight).toHaveBeenCalledWith("left");
  });

  // The strip's group close sat beside the active tab's close, with the same
  // X, so a group with tabs closes from its tab list.
  it("closes a group with tabs from the end of its tab list, not the strip", () => {
    const onActivate = vi.fn();
    const onCloseGroup = vi.fn();
    render(
      <EditorTabs
        groupId="left"
        groupNumber={2}
        tabs={tabs}
        activeTab="a.md"
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={onActivate}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
        onCloseGroup={onCloseGroup}
      />,
    );

    expect(screen.queryByRole("button", { name: "Close editor group" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All tabs in editor group 2" }));
    const menu = screen.getByRole("menu", { name: "Tabs in editor group 2" });
    expect(
      Array.from(menu.children, (row) => row.getAttribute("role") === "separator" ? "---" : row.textContent),
    ).toEqual(["a.md", "b.md", "c.md", "---", `New editor group right${SPLIT_KEYS}`, "Close group"]);
    const close = screen.getByRole("menuitem", { name: "Close group" });
    expect(close.getAttribute("aria-current")).toBeNull();
    fireEvent.click(close);
    expect(onCloseGroup).toHaveBeenCalledOnce();
    expect(onCloseGroup).toHaveBeenCalledWith("left");
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the strip's close button for an empty group, which has no tab list", () => {
    const onCloseGroup = vi.fn();
    const group = (groupId: string, groupNumber: number, groupTabs: typeof tabs) => (
      <EditorTabs
        groupId={groupId}
        groupNumber={groupNumber}
        tabs={groupTabs}
        activeTab={groupTabs[0]?.path ?? null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
        onCloseGroup={onCloseGroup}
      />
    );
    // A split, as the shell lays it out: a group with tabs, then an empty one.
    render(<>{group("left", 1, tabs)}{group("right", 2, [])}</>);

    const [tabbed, empty] = screen.getAllByTestId("editor-tabs");
    expect(within(tabbed!).queryByRole("button", { name: "Close editor group" })).toBeNull();
    expect(within(empty!).queryByTestId("tabs-overflow")).toBeNull();
    fireEvent.click(within(empty!).getByRole("button", { name: "Close editor group" }));
    expect(onCloseGroup).toHaveBeenCalledOnce();
    expect(onCloseGroup).toHaveBeenCalledWith("right");
  });

  it.each([
    ["with tabs", tabs],
    ["with no tabs", []],
  ])("offers no group close when the shell cannot close the group, %s", (_label, groupTabs) => {
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={groupTabs}
        activeTab={groupTabs[0]?.path ?? null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Close editor group" })).toBeNull();
    if (groupTabs.length === 0) return;
    fireEvent.click(screen.getByTestId("tabs-overflow"));
    expect(screen.queryByRole("menuitem", { name: "Close group" })).toBeNull();
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent))
      .toEqual(["a.md", "b.md", "c.md", `New editor group right${SPLIT_KEYS}`]);
  });

  // A narrow group hides Share file and New editor group right with a
  // container query, which jsdom can't evaluate, so this checks the class and
  // the rows that stand in for the buttons.
  it("offers Share file and New editor group right in the tab list, where a narrow group moves them", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    const onCreateGroupRight = vi.fn();
    const group = (activeTab: string) => (
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[...tabs, { path: siteTabPath("apps/trip") }]}
        activeTab={activeTab}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={onCreateGroupRight}
        onShare={onShare}
      />
    );
    const { rerender } = render(group("b.md"));
    expect(screen.getByTestId("create-editor-group-right").classList).toContain(NARROW_GROUP_HIDDEN);

    // The keyboard reaches both rows as it reaches a tab's.
    screen.getByTestId("tabs-overflow").focus();
    await user.keyboard("{Enter}");
    const share = screen.getByRole("menuitem", { name: "Share file" });
    const split = screen.getByRole("menuitem", { name: "New editor group right" });
    expect(share.querySelector("svg")?.getAttribute("class")).toContain("lucide-share-2");
    expect(split.querySelector("svg")?.getAttribute("class")).toContain("lucide-columns-2");
    expect(split.getAttribute("aria-keyshortcuts")).toBe("Control+\\");
    expect(split.textContent).toBe(`New editor group right${SPLIT_KEYS}`);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(share);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(split);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onShare).toHaveBeenCalledWith("b.md");

    await user.click(screen.getByTestId("tabs-overflow"));
    await user.click(screen.getByRole("menuitem", { name: "New editor group right" }));
    expect(onCreateGroupRight).toHaveBeenCalledWith("left");

    // A tab that opens only once can't open in a new group, from the row
    // either.
    rerender(group(siteTabPath("apps/trip")));
    await user.click(screen.getByTestId("tabs-overflow"));
    expect(screen.getByRole("menuitem", { name: "New editor group right" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps an empty group's New editor group right at every width", () => {
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[]}
        activeTab={null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );
    expect(screen.getByTestId("create-editor-group-right").classList).not.toContain(NARROW_GROUP_HIDDEN);
  });

  // Forced colors remove fills, so the mark is a border, which they keep, in
  // the system Highlight color. A strip with no tabs carries it too.
  it.each([
    ["with tabs", tabs],
    ["with no tabs", []],
  ])("draws the active-group mark as a border that forced colors keep, %s", (_label, groupTabs) => {
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={groupTabs}
        activeTab={groupTabs[0]?.path ?? null}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );
    const classes = screen.getByTestId("editor-tabs-active-group").className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["border-t-2", "border-accent", "forced-colors:border-[Highlight]"]));
    expect(classes.some((name) => name.startsWith("bg-"))).toBe(false);
  });

  it.each([
    ["Chats", CHATS_TAB_PATH],
    ["a site preview", siteTabPath("client-portal")],
  ])("disables Split Right when %s is the active tab", (_label, path) => {
    const onCreateGroupRight = vi.fn();
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }, { path: "a.md" }]}
        activeTab={path}
        activeTabDirty={false}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={onCreateGroupRight}
      />,
    );

    const split = screen.getByRole("button", {
      name: "New editor group right",
    });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(split);
    expect(onCreateGroupRight).not.toHaveBeenCalled();
  });
});

function KeyboardTabs({ focusableSurface = true }: { focusableSurface?: boolean } = {}) {
  const [paths, setPaths] = useState(tabs);
  const [active, setActive] = useState("a.md");
  const surface = useRef<HTMLElement>(null);
  useFocusSurface(surface, () => surface.current);
  return <section ref={surface} tabIndex={focusableSurface ? -1 : undefined} data-focus-surface="editor" data-active="true" data-testid="editor-surface">
    <EditorTabs groupId="left" groupNumber={1} tabs={paths} activeTab={active}
      activeTabDirty={false} recoveryPaths={new Set<string>()}
      onActivate={(_group, path) => setActive(path)}
      onClose={(_group, path) => {
        const next = paths.filter((tab) => tab.path !== path);
        setPaths(next);
        if (path === active) setActive(next[0]?.path ?? "");
      }}
      onContextMenu={noop} onMove={noop} onMoveToGroup={noop} onCreateGroupRight={noop} />
  </section>;
}
it("uses one tab stop and arrow, Home and End activation", () => {
  render(<KeyboardTabs />);
  screen.getByTestId("tab-a.md").focus();
  expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  expect(screen.getByRole("button", { name: "Close a.md" }).tabIndex).toBe(-1);
  for (const [key, path] of [["ArrowRight", "b.md"], ["End", "c.md"], ["Home", "a.md"], ["ArrowLeft", "c.md"]]) {
    fireEvent.keyDown(document.activeElement!, { key });
    expect(document.activeElement).toBe(screen.getByTestId(`tab-${path}`));
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  }
});
// The strip's scroller cuts off a tab's outset ring, and the pane edge the
// last strip button's.
it("draws the focus ring inside every tab and strip button", () => {
  // An empty group's strip holds the group close.
  render(
    <>
      <EditorTabs groupId="left" groupNumber={1} tabs={tabs} activeTab="b.md"
        activeTabDirty={false} recoveryPaths={new Set<string>()}
        onActivate={noop} onClose={noop} onContextMenu={noop} onMove={noop}
        onMoveToGroup={noop} onCreateGroupRight={noop} onCloseGroup={noop} />
      <EditorTabs groupId="right" groupNumber={2} tabs={[]} activeTab={null}
        activeTabDirty={false} recoveryPaths={new Set<string>()}
        onActivate={noop} onClose={noop} onContextMenu={noop} onMove={noop}
        onMoveToGroup={noop} onCreateGroupRight={noop} onCloseGroup={noop} />
    </>,
  );
  const controls = [
    ...screen.getAllByRole("tab"),
    screen.getByRole("button", { name: "Close editor group" }),
    ...screen.getAllByTestId("create-editor-group-right"),
    screen.getByTestId("tabs-overflow"),
  ];
  expect(controls).toHaveLength(7);
  for (const control of controls) {
    expect(control.className.split(" ")).toContain("focus-visible:-outline-offset-2");
  }
});
it("keeps focus on the surviving tab, then the editor when closing the last tab", async () => {
  render(<KeyboardTabs />);
  screen.getByTestId("tab-a.md").focus();
  for (const path of ["b.md", "c.md"]) {
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId(`tab-${path}`)));
  }
  fireEvent.keyDown(document.activeElement!, { key: "Delete" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("editor-surface")));
});
// ⌘⌫ deletes in Finder's file list; macOS has no such key for closing a tab.
it("leaves a focused tab open on ⌘⌫ on macOS", () => {
  vi.stubGlobal("dohcDesktop", { platform: "darwin" });
  try {
    render(<KeyboardTabs />);
    screen.getByTestId("tab-a.md").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Backspace", metaKey: true });
    expect(screen.getByTestId("tab-a.md")).toBeTruthy();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("returns from a removed close button to the surviving tab", async () => {
  render(<KeyboardTabs />);
  const close = screen.getByRole("button", { name: "Close a.md" });
  close.focus();
  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("tab-b.md")));
});

it("returns from the tab overflow menu on selection and Escape", async () => {
  render(<KeyboardTabs />);
  const trigger = screen.getByTestId("tabs-overflow");
  trigger.focus();
  fireEvent.click(trigger);
  const item = screen.getByRole("menuitem", { name: "b.md" });
  item.focus();
  fireEvent.click(item);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  const next = screen.getByRole("menuitem", { name: "a.md" });
  next.focus();
  fireEvent.keyDown(next, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("returns from the tab overflow menu after a pointer click on blank space", async () => {
  const user = userEvent.setup();
  render(<KeyboardTabs focusableSurface={false} />);
  const trigger = screen.getByTestId("tabs-overflow");
  await user.click(trigger);
  screen.getByRole("menuitem", { name: "b.md" }).focus();
  await user.pointer({ target: document.body, keys: "[MouseLeft>]" });
  expect(screen.queryByTestId("tabs-overflow-menu")).toBeNull();
  // A browser's press on blank space takes focus to the page after the close.
  trigger.blur();
  await user.pointer({ keys: "[/MouseLeft]" });
  expect(document.activeElement).toBe(trigger);
});

it("closes the tab overflow menu on a press on a tab, which takes focus", async () => {
  const user = userEvent.setup();
  render(<KeyboardTabs />);
  await user.click(screen.getByTestId("tabs-overflow"));
  await user.click(screen.getByTestId("tab-c.md"));
  expect(screen.queryByTestId("tabs-overflow-menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("tab-c.md"));
});
