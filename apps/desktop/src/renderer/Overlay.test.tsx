// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
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

function FocusDialog({ removeOpener = false }: { removeOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  return <section data-focus-surface="test" tabIndex={-1} data-testid="surface">
    {(!removeOpener || !open) && <button onClick={() => setOpen(true)}>Open dialog</button>}
    {open && <Overlay onClose={() => setOpen(false)}><button autoFocus onClick={() => setOpen(false)}>Done</button></Overlay>}
  </section>;
}

it.each(["Escape", "Done", "backdrop"])("returns dialog focus after %s", async (action) => {
  render(<StrictMode><FocusDialog /></StrictMode>);
  const opener = screen.getByText("Open dialog");
  opener.focus();
  fireEvent.click(opener);
  expect(document.activeElement).toBe(screen.getByText("Done"));
  if (action === "Escape") fireEvent.keyDown(document, { key: "Escape" });
  else if (action === "Done") fireEvent.click(screen.getByText("Done"));
  else fireEvent.click(document.querySelector('[data-dohc-modal="true"]')!);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("returns to the containing surface when the dialog opener was removed", async () => {
  render(<FocusDialog removeOpener />);
  const opener = screen.getByText("Open dialog");
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(screen.getByText("Done"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("surface")));
});

it("returns nested dialogs to their own opener, then the outer opener", async () => {
  function Nested() {
    const [outer, setOuter] = useState(false);
    const [inner, setInner] = useState(false);
    return <><button onClick={() => setOuter(true)}>Outer opener</button>
      {outer && <Overlay onClose={() => setOuter(false)}>
        <button onClick={() => setInner(true)}>Inner opener</button>
        {inner && <Overlay onClose={() => setInner(false)}><button autoFocus>Inner content</button></Overlay>}
      </Overlay>}
    </>;
  }
  render(<Nested />);
  const outer = screen.getByText("Outer opener");
  outer.focus();
  fireEvent.click(outer);
  const inner = screen.getByText("Inner opener");
  inner.focus();
  fireEvent.click(inner);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(inner));
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(outer));
});
