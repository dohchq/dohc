// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "./Overlay";

afterEach(() => {
  cleanup();
});

describe("Overlay", () => {
  it("claims focus when its child has no initial focus target", () => {
    render(
      <Overlay onClose={() => undefined}>
        <div>Loading settings...</div>
      </Overlay>,
    );

    const panel = document.querySelector<HTMLElement>(
      '[data-dohc-modal="true"] > div',
    );
    expect(document.activeElement).toBe(panel);
  });

  it("keeps focus claimed by a mounted dialog child", () => {
    function FocusedChild() {
      const buttonRef = useRef<HTMLButtonElement>(null);
      useLayoutEffect(() => buttonRef.current?.focus(), []);
      return (
        <button ref={buttonRef} type="button">
          Close dialog
        </button>
      );
    }

    render(
      <Overlay onClose={() => undefined}>
        <FocusedChild />
      </Overlay>,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close dialog" }),
    );
  });

  it("closes on Escape", () => {
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

  it("closes only the topmost of two nested overlays on Escape", () => {
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

  it("traps Tab focus inside the panel, wrapping both directions", () => {
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

  it("includes editable regions and skips hidden or inherited-disabled controls", () => {
    render(
      <Overlay onClose={() => undefined}>
        <fieldset disabled>
          <button type="button">Inherited disabled action</button>
        </fieldset>
        <button type="button" aria-hidden="true">
          Hidden action
        </button>
        <div contentEditable data-testid="editable-region" />
        <button type="button">Last</button>
      </Overlay>,
    );
    const editor = screen.getByTestId("editable-region");
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    expect(document.activeElement).toBe(editor);
  });
});
