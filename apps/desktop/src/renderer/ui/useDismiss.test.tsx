// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDismiss } from "./useDismiss";

function Menu() {
  const [open, setOpen] = useState(true);
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useDismiss({ open, container, trigger, onClose: () => setOpen(false) });
  return (
    <div>
      <button type="button">Elsewhere</button>
      <div ref={container}>
        <button ref={trigger} type="button" onClick={() => setOpen((value) => !value)}>
          Trigger
        </button>
        {open ? (
          <div role="menu">
            <button type="button" onClick={() => setOpen(false)}>Item</button>
            <span>Label</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

afterEach(cleanup);

describe("useDismiss", () => {
  it("closes on a press outside, and stays open for a press inside", () => {
    render(<Menu />);
    fireEvent.pointerDown(screen.getByText("Label"));
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // A click in an embedded frame never reaches the page; the frame takes
  // focus from the window instead.
  it("closes when the window loses focus", () => {
    render(<Menu />);
    fireEvent.blur(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when focus moves outside, and stays open while it moves inside", () => {
    render(<Menu />);
    const item = screen.getByRole("button", { name: "Item" });
    fireEvent.focusOut(screen.getByRole("button", { name: "Trigger" }), { relatedTarget: item });
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.focusOut(item, { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // styles.css turns the titlebar's drag region off while this flag is set,
  // so a press there reaches the page.
  it("marks the root while any menu is open, until the last one closes", () => {
    const first = render(<Menu />);
    const second = render(<Menu />);
    expect(document.documentElement.dataset.menuOpen).toBe("");

    first.unmount();
    expect(document.documentElement.dataset.menuOpen).toBe("");
    second.unmount();
    expect(document.documentElement.dataset.menuOpen).toBeUndefined();
  });

  it("takes Escape only while focus is inside, and returns focus to the trigger", async () => {
    render(<Menu />);
    const escape = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(escape).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeNull();

    const item = screen.getByRole("button", { name: "Item" });
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Trigger" })));
  });
});

it("returns focus after selecting a menu item", async () => {
  render(<Menu />);
  const item = screen.getByText("Item");
  item.focus();
  fireEvent.click(item);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Trigger")));
});
it("keeps an intentional outside focus destination", async () => {
  render(<Menu />);
  screen.getByText("Item").focus();
  screen.getByText("Elsewhere").focus();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(screen.getByText("Elsewhere"));
});
