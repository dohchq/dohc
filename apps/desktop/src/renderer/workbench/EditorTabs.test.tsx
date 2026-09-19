// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cornerRadius, EditorTabs } from "./EditorTabs";
import {
  CHATS_TAB_PATH,
  momentDiffTabPath,
  pluginDetailsTabPath,
  pluginPanelTabPath,
  siteTabPath,
} from "./workbenchState";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the strip reveals the active
  // tab with it. Nor pointer capture, which the scrollbar thumb drag uses.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

const noop = () => {};
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

  it("uses readable labels for plugin panel tabs", () => {
    const path = pluginPanelTabPath("hello/plugin", "main panel");
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

    const tab = screen.getByRole("tab", { name: "main panel" });
    expect(tab.title).toBe("hello/plugin — main panel");
  });

  // The row and the page both head a plugin with the name its manifest
  // declares. The tab is the third surface showing the same plugin, and it
  // reads from the same map the web app tabs take their titles from.
  it("names a plugin details tab with the display name the shell knows", () => {
    const path = pluginDetailsTabPath("hello-plugin", "hello-plugin");
    render(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={[{ path }]}
        activeTab={path}
        activeTabDirty={false}
        tabLabels={new Map([[path, "Hello Plugin"]])}
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Hello Plugin" });
    // The tooltip stays the id: it is what tells a plugin's two tabs apart.
    expect(tab.title, "ignore the label again: the tab falls back to 'hello-plugin'.").toBe("Plugin details: hello-plugin");
  });

  it("falls back to the plugin id until the shell knows a display name", () => {
    const path = pluginDetailsTabPath("hello-plugin", "hello-plugin");
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

    expect(screen.getByRole("tab", { name: "hello-plugin" })).toBeTruthy();
  });

  it("is a single horizontal row: overflow-x scrolls, overflow-y is locked", () => {
    renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("overflow-y-hidden");
    // The class is the hook the scrollbar-hiding rule in styles.css targets.
    expect(strip.className).toContain("dohc-tab-strip");
  });

  it("reveals the active tab when activation changes by any means", () => {
    const { rerender } = renderTabs("a.md");
    const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    // Mount reveals the initially active tab.
    expect(scroll).toHaveBeenCalledTimes(1);

    rerender(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={tabs}
        activeTab="c.md"
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
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenLastCalledWith(
      expect.objectContaining({ block: "nearest", inline: "nearest" }),
    );
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
          onCreateGroupRight={noop}
        />
      </div>
    );
    const view = render(strip(order));
    layOut();
    return {
      onMove,
      onMoveToGroup,
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

  it("moves a tab to an empty group when released over its editor body", () => {
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

  it("re-measures when the active tab becomes dirty", () => {
    const { rerender } = renderTabs("a.md");
    const strip = screen.getByRole("tablist");
    const thumb = screen.getByTestId("tab-strip-scrollbar");
    Object.defineProperty(strip, "scrollWidth", { value: 600 });
    Object.defineProperty(strip, "clientWidth", { value: 200 });
    expect(thumb.style.display).toBe("none");

    rerender(
      <EditorTabs
        groupId="left"
        groupNumber={1}
        tabs={tabs}
        activeTab="a.md"
        activeTabDirty
        recoveryPaths={new Set<string>()}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
        onMoveToGroup={noop}
        onCreateGroupRight={noop}
      />,
    );
    expect(thumb.style.display).toBe("");
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
    const onCloseGroup = vi.fn();
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
        onCloseGroup={onCloseGroup}
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
    fireEvent.click(screen.getByRole("button", { name: "Close editor group" }));
    expect(onCloseGroup).toHaveBeenCalledOnce();
    expect(onCloseGroup).toHaveBeenCalledWith("left");
  });

  it.each([
    ["Chats", CHATS_TAB_PATH],
    ["a site preview", siteTabPath("client-portal")],
    ["a plugin panel", pluginPanelTabPath("hello-plugin", "main")],
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
