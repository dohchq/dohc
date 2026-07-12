// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorTabs } from "./EditorTabs";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the strip reveals the active
  // tab with it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const noop = () => {};

function renderTabs(activeTab: string) {
  return render(
    <EditorTabs
      tabs={[{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }]}
      activeTab={activeTab}
      activeTabDirty={false}
      onActivate={noop}
      onClose={noop}
      onContextMenu={noop}
      onMove={noop}
    />,
  );
}

describe("EditorTabs strip scrolling", () => {
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
        tabs={[{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }]}
        activeTab="c.md"
        activeTabDirty={false}
        onActivate={noop}
        onClose={noop}
        onContextMenu={noop}
        onMove={noop}
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
});
