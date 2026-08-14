// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "./Overlay";

afterEach(() => {
  cleanup();
});

describe("Overlay", () => {
  it("closes on Escape (CodeRabbit #779 R32)", () => {
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <button type="button">First</button>
        <button type="button">Second</button>
      </Overlay>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the topmost of two nested overlays on Escape (#779 round 4 finding 4)", () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(
      <>
        <Overlay onClose={onCloseOuter}>
          <button type="button">Outer</button>
        </Overlay>
        <Overlay onClose={onCloseInner}>
          <button type="button">Inner</button>
        </Overlay>
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it("traps Tab focus inside the panel, wrapping both directions (CodeRabbit #779 R32)", () => {
    render(
      <Overlay onClose={() => undefined}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Overlay>,
    );
    const first = screen.getByText("First");
    const last = screen.getByText("Last");

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
