// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "./Overlay";
import { Menu } from "./ui/Menu";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Overlay", () => {
  it("claims focus when its child has no initial focus target", () => {
    render(
      <Overlay onClose={() => undefined}>
        <div>Loading settings...</div>
      </Overlay>,
    );

    const panel = document.querySelector<HTMLElement>(
      '[data-dohc-modal="true"] > [data-focus-surface="dialog"]',
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

  it("closes on ⌘W on macOS, before the menu can close the tab behind it", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <button type="button">First</button>
      </Overlay>,
    );

    const notPrevented = fireEvent.keyDown(document, { key: "w", code: "KeyW", metaKey: true });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("takes ⌘W on macOS even without a close action", () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    render(
      <Overlay>
        <button type="button">First</button>
      </Overlay>,
    );

    expect(fireEvent.keyDown(document, { key: "w", code: "KeyW", metaKey: true })).toBe(false);
  });

  it("stays open on Ctrl+W on Windows", () => {
    vi.stubGlobal("dohcDesktop", { platform: "win32" });
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <button type="button">First</button>
      </Overlay>,
    );

    fireEvent.keyDown(document, { key: "w", code: "KeyW", ctrlKey: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open on a press outside its panel", () => {
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <input aria-label="Name" />
      </Overlay>,
    );

    fireEvent.click(document.querySelector('[data-dohc-modal="true"]')!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes a picker on a press outside its panel", () => {
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose} closeOnBackdrop>
        <button type="button">Result</button>
      </Overlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Result" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-dohc-modal="true"]')!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes an open menu on the first Escape and the overlay on the second", async () => {
    const user = userEvent.setup();
    function Dialog() {
      const [open, setOpen] = useState(true);
      const [menuOpen, setMenuOpen] = useState(false);
      return open ? (
        <Overlay onClose={() => setOpen(false)} panelProps={{ role: "dialog", "aria-label": "Actions" }}>
          <Menu label="Row actions" open={menuOpen} onOpenChange={setMenuOpen}
            items={[{ id: "rename", label: "Rename", onSelect: vi.fn() }]} />
        </Overlay>
      ) : null;
    }
    render(<Dialog />);
    const dialog = screen.getByRole("dialog", { name: "Actions" });
    const trigger = screen.getByRole("button", { name: "Row actions" });
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Actions" })).toBe(dialog);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
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

// Toasts sit above the dialog, outside its panel. F6 is the keyboard's way to
// them and back; Tab and Escape never leave the dialog and its toasts.
describe("Overlay with toasts above it", () => {
  function DialogWithToasts(props: { onClose: () => void; toasts?: boolean }) {
    return (
      <>
        <button type="button">Behind the dialog</button>
        <Overlay onClose={props.onClose}>
          <button type="button">First</button>
          <button type="button">Last</button>
        </Overlay>
        {props.toasts === false ? null : (
          <div data-dohc-toasts>
            <button type="button">Try again</button>
            <button type="button">Dismiss</button>
          </div>
        )}
      </>
    );
  }

  it("moves focus to the toasts on F6 and back to where it left the dialog", () => {
    render(<DialogWithToasts onClose={() => undefined} />);
    const last = screen.getByText("Last");
    last.focus();

    fireEvent.keyDown(document.activeElement!, { key: "F6" });
    expect(document.activeElement).toBe(screen.getByText("Try again"));
    fireEvent.keyDown(document.activeElement!, { key: "F6" });
    expect(document.activeElement).toBe(last);
  });

  it("cycles Tab among the toasts while they hold focus, never reaching the page behind", () => {
    render(<DialogWithToasts onClose={() => undefined} />);
    screen.getByText("First").focus();
    fireEvent.keyDown(document.activeElement!, { key: "F6" });
    const retry = screen.getByText("Try again");
    const dismiss = screen.getByText("Dismiss");
    expect(document.activeElement).toBe(retry);

    // jsdom has no native Tab, so this checks the wrap at each end.
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dismiss);
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(retry);
  });

  it("returns to the dialog on Escape from a toast instead of closing it", () => {
    const onClose = vi.fn();
    render(<DialogWithToasts onClose={onClose} />);
    const first = screen.getByText("First");
    first.focus();
    fireEvent.keyDown(document.activeElement!, { key: "F6" });

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog: the toasts are reached only by F6", () => {
    render(<DialogWithToasts onClose={() => undefined} />);
    const first = screen.getByText("First");
    const last = screen.getByText("Last");

    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("leaves focus in the dialog on F6 when no toast shows", () => {
    render(<DialogWithToasts onClose={() => undefined} toasts={false} />);
    const last = screen.getByText("Last");
    last.focus();

    fireEvent.keyDown(document.activeElement!, { key: "F6" });
    expect(document.activeElement).toBe(last);
  });
});

function FocusDialog({ removeOpener = false, picker = false }: { removeOpener?: boolean; picker?: boolean }) {
  const [open, setOpen] = useState(false);
  return <section data-focus-surface="test" tabIndex={-1} data-testid="surface">
    {(!removeOpener || !open) && <button onClick={() => setOpen(true)}>Open dialog</button>}
    {open && <Overlay onClose={() => setOpen(false)} closeOnBackdrop={picker}><button autoFocus onClick={() => setOpen(false)}>Done</button></Overlay>}
  </section>;
}

it.each(["Escape", "Done", "backdrop"])("returns dialog focus after %s", async (action) => {
  render(<StrictMode><FocusDialog picker={action === "backdrop"} /></StrictMode>);
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
