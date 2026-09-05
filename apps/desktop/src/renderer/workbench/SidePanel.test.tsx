// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidePanel } from "./SidePanel";

// Stuck-capture guards: the resize handle must mirror the tab-drag
// guards — left button only, a buttons-up move ends the drag (missed release
// outside the window), and losing pointer capture ends it too. Without these,
// hovering the handle after a lost capture keeps resizing and persists bogus
// widths.

function renderPanel(onWidthChange: (width: number) => void, width = 240) {
  render(
    <SidePanel title="Files" width={width} onWidthChange={onWidthChange}>
      <div />
    </SidePanel>,
  );
  return screen.getByTestId("sidebar-resize");
}

beforeEach(() => {
  // jsdom has no pointer-capture implementation; the guards only call these.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("sidebar resize guards", () => {
  it("supports keyboard resizing and reports its current value", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange, 400);

    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenCalledWith(416);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenCalledWith(384);
    fireEvent.keyDown(handle, { key: "PageUp" });
    expect(onWidthChange).toHaveBeenCalledWith(528);
    fireEvent.keyDown(handle, { key: "PageDown" });
    expect(onWidthChange).toHaveBeenCalledWith(272);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onWidthChange).toHaveBeenCalledWith(160);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onWidthChange).toHaveBeenCalledWith(2400);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onWidthChange).toHaveBeenCalledTimes(6);
  });

  it("previews every move locally and commits one clamped width on release", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    const panel = screen.getByTestId("side-panel");
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      clientX: 240,
      pointerId: 1,
    });
    for (const clientX of [300, 420, 1200]) {
      fireEvent.pointerMove(handle, { buttons: 1, clientX, pointerId: 1 });
      expect(panel.style.width).toBe(`${clientX}px`);
    }
    expect(onWidthChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onWidthChange).toHaveBeenCalledWith(1200);
    expect(onWidthChange).toHaveBeenCalledTimes(1);

    fireEvent.pointerMove(handle, { buttons: 1, clientX: 400, pointerId: 1 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("a non-left press never starts a resize", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, {
      button: 2,
      buttons: 2,
      clientX: 240,
      pointerId: 2,
    });
    fireEvent.pointerMove(handle, { buttons: 2, clientX: 320, pointerId: 2 });
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("a buttons-up move commits a drag whose release was missed", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      clientX: 240,
      pointerId: 3,
    });
    // The release happened outside the window: no pointerup arrived. The
    // first hover-back move carries buttons=0 and publishes its final width.
    fireEvent.pointerMove(handle, { buttons: 0, clientX: 480, pointerId: 3 });
    expect(onWidthChange).toHaveBeenCalledOnce();
    expect(onWidthChange).toHaveBeenCalledWith(480);
    // Still ended: a later left-down-less move does nothing either.
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 600, pointerId: 3 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pointer cancel", (handle: HTMLElement) => fireEvent.pointerCancel(handle, { pointerId: 4 })],
    [
      "lost pointer capture",
      (handle: HTMLElement) => fireEvent.lostPointerCapture(handle, { pointerId: 4 }),
    ],
    ["window blur", () => fireEvent(window, new Event("blur"))],
  ])("%s commits the last locally previewed width", (_name, finish) => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      clientX: 240,
      pointerId: 4,
    });
    fireEvent.pointerMove(handle, {
      buttons: 1,
      clientX: 360,
      pointerId: 4,
    });
    expect(screen.getByTestId("side-panel").style.width).toBe("360px");

    finish(handle);

    expect(onWidthChange).toHaveBeenCalledOnce();
    expect(onWidthChange).toHaveBeenCalledWith(360);
  });

  it("drops a local preview when a keyed workspace surface unmounts", () => {
    const onWidthChange = vi.fn();
    const view = render(
      <SidePanel key="workspace-a" title="Files" width={240} onWidthChange={onWidthChange}>
        <div />
      </SidePanel>,
    );
    const handle = screen.getByTestId("sidebar-resize");
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 5 });
    fireEvent.pointerMove(handle, {
      buttons: 1,
      clientX: 420,
      pointerId: 5,
    });
    expect(screen.getByTestId("side-panel").style.width).toBe("420px");

    view.rerender(
      <SidePanel key="workspace-b" title="Files" width={280} onWidthChange={onWidthChange}>
        <div />
      </SidePanel>,
    );

    expect(screen.getByTestId("side-panel").style.width).toBe("280px");
    expect(onWidthChange).not.toHaveBeenCalled();
  });
});
