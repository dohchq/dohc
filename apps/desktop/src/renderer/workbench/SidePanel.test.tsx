// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidePanel } from "./SidePanel";

// Stuck-capture guards (codex P2): the resize handle must mirror the tab-drag
// guards — left button only, a buttons-up move ends the drag (missed release
// outside the window), and losing pointer capture ends it too. Without these,
// hovering the handle after a lost capture keeps resizing and persists bogus
// widths.

function renderPanel(onWidthChange: (width: number) => void) {
  render(
    <SidePanel title="Files" width={240} onWidthChange={onWidthChange}>
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
  it("drags with the left button: move streams clamped widths, release ends the drag", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, clientX: 240 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 320 });
    expect(onWidthChange).toHaveBeenCalledWith(320);
    fireEvent.pointerUp(handle);
    fireEvent.pointerMove(handle, { buttons: 0, clientX: 400 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("a non-left press never starts a resize", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, { button: 2, buttons: 2, clientX: 240 });
    fireEvent.pointerMove(handle, { buttons: 2, clientX: 320 });
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("a buttons-up move ends a drag whose release was missed", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, clientX: 240 });
    // The release happened outside the window: no pointerup arrived. The
    // first hover-back move carries buttons=0 and must END the drag, not
    // resize.
    fireEvent.pointerMove(handle, { buttons: 0, clientX: 480 });
    expect(onWidthChange).not.toHaveBeenCalled();
    // Still ended: a later left-down-less move does nothing either.
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 480 });
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("losing pointer capture ends the drag", () => {
    const onWidthChange = vi.fn();
    const handle = renderPanel(onWidthChange);
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, clientX: 240 });
    fireEvent.lostPointerCapture(handle);
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 360 });
    expect(onWidthChange).not.toHaveBeenCalled();
  });
});
