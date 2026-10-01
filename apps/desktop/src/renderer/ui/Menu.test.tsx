// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuItem } from "./Menu";

function Harness(props: { items: readonly MenuItem[]; closeOnPick?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">Elsewhere</button>
      <Menu label="Row actions" testId="row-menu" open={open} onOpenChange={setOpen} closeOnPick={props.closeOnPick} items={props.items}>
        {props.children}
      </Menu>
    </div>
  );
}

const rename = vi.fn();
const remove = vi.fn();
const items: MenuItem[] = [
  { id: "rename", label: "Rename", onSelect: rename },
  { id: "duplicate", label: "Duplicate", onSelect: vi.fn() },
  { id: "delete", label: "Delete", onSelect: remove, disabled: true },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Menu", () => {
  it("opens on the trigger, focuses the first row, and closes on Escape with focus back on the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByRole("button", { name: "Row actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Row actions" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes on a press outside and stays open for a press inside", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    await user.click(screen.getByTestId("row-menu"));

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves with the arrow keys, Home, End, and a typed letter, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByTestId("row-menu");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const [first, second, third] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(third);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(third);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("d");
    expect(document.activeElement).toBe(second);
    await user.keyboard("d");
    expect(document.activeElement).toBe(third);
  });

  it("picks with Enter and Space, closes, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByTestId("row-menu");

    await user.click(trigger);
    await user.keyboard("{Enter}");
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.keyboard(" ");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a disabled row reachable but never picks it", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    await user.click(screen.getByTestId("row-menu"));
    const disabled = screen.getByRole("menuitem", { name: "Delete" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");

    await user.keyboard("{End}{Enter}");
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeNull();
    await user.click(disabled);
    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("leaves closing to the owner when told to, and renders what the owner adds under the rows", async () => {
    const user = userEvent.setup();
    render(
      <Harness items={items} closeOnPick={false}>
        <div role="status">Copied</div>
      </Harness>,
    );
    await user.click(screen.getByTestId("row-menu"));
    await user.keyboard("{Enter}");
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu").contains(screen.getByRole("status"))).toBe(true);
  });

  it("marks a row with a checked state as a menuitemradio", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          { id: "main", label: "Main", onSelect: vi.fn(), checked: true },
          { id: "draft", label: "Draft", onSelect: vi.fn(), checked: false },
        ]}
      />,
    );
    await user.click(screen.getByTestId("row-menu"));
    expect(screen.getByRole("menuitemradio", { name: "Main", checked: true })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Draft", checked: false })).toBeTruthy();
  });
});
