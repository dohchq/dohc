// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./EditorTabs";
import {
  CHATS_TAB_PATH,
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

    // MUTATION (ignore the label again): the tab falls back to "hello-plugin".
    const tab = screen.getByRole("tab", { name: "Hello Plugin" });
    // The tooltip stays the id: it is what tells a plugin's two tabs apart.
    expect(tab.title).toBe("Plugin details: hello-plugin");
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
    // Scrollbar-hiding hook — styles.test.ts asserts the rule itself.
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
  it("keeps live reorder inside the source group", () => {
    const onMove = vi.fn();
    const onMoveToGroup = vi.fn();
    render(
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
      </div>,
    );
    const first = screen.getByTestId("tab-a.md");
    const second = screen.getByTestId("tab-b.md");
    const third = screen.getByTestId("tab-c.md");
    Object.defineProperty(second, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 100, width: 100 }),
    });
    Object.defineProperty(third, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 200, width: 100 }),
    });
    vi.mocked(document.elementFromPoint).mockReturnValue(first);

    fireEvent.pointerDown(first, { button: 0, pointerId: 4, clientX: 10 });
    fireEvent.pointerMove(first, {
      pointerId: 4,
      buttons: 1,
      clientX: 260,
      clientY: 10,
    });
    fireEvent.pointerUp(first, { pointerId: 4, clientX: 260, clientY: 10 });

    expect(onMove).toHaveBeenCalledWith("a.md", 2);
    expect(onMoveToGroup).not.toHaveBeenCalled();
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
    const source = screen.getByTestId("tab-a.md");
    const target = screen.getByTestId("empty-right-editor");
    vi.mocked(document.elementFromPoint).mockReturnValue(target);

    fireEvent.pointerDown(source, { button: 0, pointerId: 7, clientX: 10 });
    fireEvent.pointerMove(source, {
      pointerId: 7,
      buttons: 1,
      clientX: 500,
      clientY: 200,
    });
    fireEvent.pointerUp(source, {
      pointerId: 7,
      clientX: 500,
      clientY: 200,
    });

    expect(onMove).not.toHaveBeenCalled();
    expect(onMoveToGroup).toHaveBeenCalledOnce();
    expect(onMoveToGroup).toHaveBeenCalledWith("a.md", "right", 0);
  });

  it("starts a new drag after cancelling an unfinished pointer", () => {
    const onMove = vi.fn();
    render(
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
          onMoveToGroup={noop}
          onCreateGroupRight={noop}
        />
      </div>,
    );
    const first = screen.getByTestId("tab-a.md");
    const second = screen.getByTestId("tab-b.md");
    Object.defineProperty(second, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 100, width: 100 }),
    });
    vi.mocked(document.elementFromPoint).mockReturnValue(first);

    fireEvent.pointerDown(first, { button: 0, pointerId: 4, clientX: 10 });
    fireEvent.pointerMove(first, {
      pointerId: 4,
      buttons: 1,
      clientX: 160,
      clientY: 10,
    });
    onMove.mockClear();

    fireEvent.pointerDown(first, { button: 0, pointerId: 5, clientX: 10 });
    fireEvent.pointerMove(first, {
      pointerId: 5,
      buttons: 1,
      clientX: 160,
      clientY: 10,
    });
    fireEvent.pointerUp(first, { pointerId: 5, clientX: 160, clientY: 10 });

    expect(onMove).toHaveBeenCalledWith("a.md", 2);
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
    fireEvent.click(screen.getByRole("button", { name: "Close editor group" }));
    expect(onCloseGroup).toHaveBeenCalledOnce();
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
