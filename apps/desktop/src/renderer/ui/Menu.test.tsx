// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_SEPARATOR, Menu, deleteShortcut, menuEnterFrom, moveInMenu, revealMenuRow, type MenuEntry, type MenuItem } from "./Menu";
import { Overlay } from "../Overlay";

function Harness(props: { items: readonly MenuEntry[]; closeOnPick?: boolean; children?: ReactNode }) {
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

  it("takes the Escape a dialog around it would otherwise close on", async () => {
    const user = userEvent.setup();
    const closeDialog = vi.fn();
    render(
      <Overlay onClose={closeDialog}>
        <Harness items={items} />
      </Overlay>,
    );
    await user.click(screen.getByTestId("row-menu"));
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(closeDialog).not.toHaveBeenCalled();

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("row-menu")));
    await user.keyboard("{Escape}");
    expect(closeDialog).toHaveBeenCalledOnce();
  });

  // Outside a dialog, the focus return puts focus on the trigger and the
  // browser's own Tab then moves on from it, so the key's default must stay.
  // user-event's Tab walker cannot stand in for it: it trips over rows this
  // handler unmounts.
  it("closes on Tab in either direction and hands the key on from the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByTestId("row-menu");
    for (const shiftKey of [true, false]) {
      await user.click(trigger);
      const row = screen.getByRole("menuitem", { name: "Rename" });
      expect(fireEvent.keyDown(row, { key: "Tab", shiftKey })).toBe(true);
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    }
  });

  // Inside a dialog, the trap decides first. A menu at the dialog's end
  // wraps Tab from its last row to the dialog's first control, and the menu
  // must not pull focus back to its trigger afterwards.
  it("leaves a dialog's Tab trap in charge of where focus goes", async () => {
    const user = userEvent.setup();
    render(
      <Overlay onClose={vi.fn()}>
        <button type="button">First</button>
        <Harness items={items} />
      </Overlay>,
    );
    const trigger = screen.getByTestId("row-menu");
    await user.click(trigger);
    const lastRow = screen.getByRole("menuitem", { name: "Delete" });
    lastRow.focus();
    expect(fireEvent.keyDown(lastRow, { key: "Tab" })).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));

    // Shift+Tab from a row is not at the trap's edge, so the trigger takes it.
    await user.click(trigger);
    expect(fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), { key: "Tab", shiftKey: true })).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps focus on its rows when the list itself is pressed", async () => {
    const user = userEvent.setup();
    render(
      <Harness items={items}>
        <div role="status">Copied</div>
      </Harness>,
    );
    await user.click(screen.getByTestId("row-menu"));
    // Default prevented: the press does not move focus to the page.
    expect(fireEvent.mouseDown(screen.getByRole("status"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("menu"))).toBe(false);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
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

  it("finds a row by its label's first letter, past a text icon before it", async () => {
    const user = userEvent.setup();
    render(<Harness items={[
      { id: "budget", label: "budget.csv", onSelect: vi.fn() },
      { id: "plan", label: "plan.md", icon: <span aria-hidden>🧭</span>, onSelect: vi.fn() },
    ]} />);
    screen.getByTestId("row-menu").focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("p");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "plan.md" }));
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

  it("separates groups with a line the keys step over, and marks the current and destructive rows", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          { id: "a", label: "a.md", onSelect: vi.fn(), current: true },
          MENU_SEPARATOR,
          { id: "forget", label: "Forget", onSelect: vi.fn(), danger: true },
        ]}
      />,
    );
    await user.click(screen.getByTestId("row-menu"));
    expect(screen.getByRole("separator")).toBeTruthy();
    const current = screen.getByRole("menuitem", { name: "a.md" });
    expect(current.getAttribute("aria-current")).toBe("true");
    const forget = screen.getByRole("menuitem", { name: "Forget" });
    expect(forget.className).toContain("text-danger");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(forget);
    // The current row keeps the selected fill after focus leaves it.
    expect(current.className.split(" ")).toContain("bg-selected");
    expect(forget.className.split(" ")).not.toContain("bg-selected");
  });

  it("keeps the checked row's selected fill whatever has focus", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          { id: "main", label: "Main", onSelect: vi.fn(), checked: false },
          { id: "draft", label: "Draft", onSelect: vi.fn(), checked: true },
        ]}
      />,
    );
    await user.click(screen.getByTestId("row-menu"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Main" }));
    expect(screen.getByRole("menuitemradio", { name: "Draft" }).className.split(" ")).toContain("bg-selected");
    expect(screen.getByRole("menuitemradio", { name: "Main" }).className.split(" ")).not.toContain("bg-selected");
  });

  // Opened with the mouse, a menu on its first row showed two active-looking
  // rows: the focused first row and the checked one.
  it.each([
    ["its checked row", true, "Draft"],
    ["its first row when no row is checked", false, "Main"],
  ])("opens a radio menu on %s", async (_case, draftChecked, focused) => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          { id: "main", label: "Main", onSelect: vi.fn(), checked: false },
          { id: "draft", label: "Draft", onSelect: vi.fn(), checked: draftChecked },
          MENU_SEPARATOR,
          { id: "new", label: "New version…", onSelect: vi.fn() },
        ]}
      />,
    );
    await user.click(screen.getByTestId("row-menu"));
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: focused }));
  });

  it("says why a disabled row cannot run on a second line, dimming only its icon and label", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          { id: "compare", label: "Compare", onSelect: vi.fn(), icon: <span aria-hidden>C</span> },
          { id: "merge", label: "Merge", onSelect: remove, icon: <span aria-hidden>M</span>, disabled: true,
            description: "Only versions made from Main can merge into Main." },
        ]}
      />,
    );
    await user.click(screen.getByTestId("row-menu"));
    const merge = screen.getByRole("menuitem", { name: "Merge" });
    expect(merge.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByText("Only versions made from Main can merge into Main.");
    expect(merge.getAttribute("aria-describedby")).toBe(reason.id);
    expect(merge.contains(reason)).toBe(true);
    // The row, its focus outline and the reason keep their strength.
    expect(merge.className).not.toContain("opacity");
    expect(reason.className).not.toContain("opacity");
    expect(screen.getByText("Merge").className.split(" ")).toContain("opacity-50");
    expect(screen.getByText("M").parentElement?.className.split(" ")).toContain("opacity-50");
    expect(screen.getByRole("menuitem", { name: "Compare" }).getAttribute("aria-describedby")).toBeNull();
    await user.keyboard("{End}{Enter}");
    expect(remove).not.toHaveBeenCalled();
  });

  // A browser paints :hover on a row that opens under a still pointer.
  it("paints hover only after the pointer moves over the list", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    screen.getByTestId("row-menu").focus();
    await user.keyboard("{Enter}");
    const second = screen.getByRole("menuitem", { name: "Duplicate" });
    expect(second.className).not.toContain("hover:bg-hover");
    fireEvent.mouseMove(screen.getByRole("menu"), { movementX: 0, movementY: 0 });
    expect(second.className).not.toContain("hover:bg-hover");
    fireEvent.mouseMove(screen.getByRole("menu"), { movementX: 2, movementY: 0 });
    expect(second.className).toContain("hover:bg-hover");
  });

  // A browser sends a still pointer's events to a row that opens under it.
  it("gives focus to the row under a moving pointer, not to one that opened under a still one", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    await user.click(screen.getByTestId("row-menu"));
    const first = screen.getByRole("menuitem", { name: "Rename" });
    const second = screen.getByRole("menuitem", { name: "Duplicate" });
    fireEvent.mouseMove(second, { movementX: 0, movementY: 0 });
    expect(document.activeElement).toBe(first);
    fireEvent.mouseMove(second, { movementX: 0, movementY: 3 });
    expect(document.activeElement).toBe(second);
  });

  it("opens from the owner's trigger, named apart from its list", async () => {
    const user = userEvent.setup();
    function Owned() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          label="Tabs in editor group 1"
          menuTestId="tabs-list"
          open={open}
          onOpenChange={setOpen}
          items={items}
          trigger={(trigger) => (
            <button {...trigger} type="button" aria-label="All tabs in editor group 1">
              v
            </button>
          )}
        />
      );
    }
    render(<Owned />);
    const trigger = screen.getByRole("button", { name: "All tabs in editor group 1" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(trigger);
    expect(screen.getByTestId("tabs-list")).toBe(screen.getByRole("menu", { name: "Tabs in editor group 1" }));
    await user.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens over its trigger when the window has more room there, entering from the trigger's side", async () => {
    const user = userEvent.setup();
    render(<Harness items={items} />);
    const trigger = screen.getByTestId("row-menu");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
      { top: 570, bottom: 594, left: 280, right: 304, width: 24, height: 24, x: 280, y: 570, toJSON: () => ({}) },
    );
    vi.stubGlobal("innerHeight", 600);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(92);
    try {
      await user.click(trigger);
      const menu = screen.getByRole("menu");
      expect(menu.style.bottom).toBe("34px");
      expect(menu.style.top).toBe("");
      expect(menu.style.maxHeight).toBe("554px");
      expect(menu.style.getPropertyValue("--dohc-menu-from")).toBe("4px");
      expect(menu.className).toContain("dohc-menu-in");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  describe("with a field in a row's place", () => {
    function Naming(props: { onSubmit: (name: string) => void; busy?: boolean; hint?: string }) {
      const [open, setOpen] = useState(false);
      const [name, setName] = useState<string | null>(null);
      const entries: MenuEntry[] = [
        { id: "rename", label: "Rename", onSelect: vi.fn() },
        name === null
          ? { id: "new", label: "New version…", testId: "new", onSelect: () => setName("") }
          : {
              id: "new",
              field: {
                label: "New version name",
                value: name,
                onChange: setName,
                onSubmit: () => props.onSubmit(name),
                onCancel: () => setName(null),
                busy: props.busy,
                hint: props.hint,
                testId: "new-input",
              },
            },
        { id: "remove", label: "Remove", onSelect: vi.fn() },
      ];
      return (
        <Menu
          label="Versions"
          testId="row-menu"
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setName(null);
          }}
          closeOnPick={false}
          items={entries}
        />
      );
    }

    it("takes typed letters, Space, Home and End, and keeps focus while the pointer crosses a row", async () => {
      const user = userEvent.setup();
      const submit = vi.fn();
      render(<Naming onSubmit={submit} />);
      await user.click(screen.getByTestId("row-menu"));
      await user.click(screen.getByTestId("new"));
      const input = screen.getByRole("textbox", { name: "New version name" });
      expect(document.activeElement).toBe(input);

      await user.keyboard("re draft");
      fireEvent.mouseMove(screen.getByRole("menuitem", { name: "Remove" }), { movementX: 4, movementY: 2 });
      await user.keyboard("{Home}x");
      expect(document.activeElement).toBe(input);
      expect((input as HTMLInputElement).value).toBe("xre draft");
      await user.keyboard("{Enter}");
      expect(submit).toHaveBeenCalledWith("xre draft");
    });

    it("names its hint as the field's description", async () => {
      const user = userEvent.setup();
      render(<Naming onSubmit={vi.fn()} hint="Starts as a copy of Main" />);
      await user.click(screen.getByTestId("row-menu"));
      await user.click(screen.getByTestId("new"));
      const hint = screen.getByText("Starts as a copy of Main");
      expect(screen.getByTestId("new-input").getAttribute("aria-describedby")).toBe(hint.id);
    });

    it("moves to the rows around it with the arrows, and back", async () => {
      const user = userEvent.setup();
      render(<Naming onSubmit={vi.fn()} />);
      await user.click(screen.getByTestId("row-menu"));
      await user.click(screen.getByTestId("new"));
      const input = screen.getByTestId("new-input");
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Remove" }));
      await user.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(input);
    });

    it("ends the typing on Escape with focus on its row, and closes on the next", async () => {
      const user = userEvent.setup();
      render(<Naming onSubmit={vi.fn()} />);
      const trigger = screen.getByTestId("row-menu");
      await user.click(trigger);
      await user.click(screen.getByTestId("new"));
      await user.keyboard("draft{Escape}");
      expect(screen.queryByTestId("new-input")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("new"));

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it("holds the value and keeps focus while the owner acts on it", async () => {
      const user = userEvent.setup();
      const submit = vi.fn();
      const { rerender } = render(<Naming onSubmit={submit} />);
      await user.click(screen.getByTestId("row-menu"));
      await user.click(screen.getByTestId("new"));
      await user.keyboard("draft");
      rerender(<Naming onSubmit={submit} busy />);
      const input = screen.getByTestId("new-input") as HTMLInputElement;
      await user.keyboard("s{Enter}");
      expect(input.value).toBe("draft");
      expect(submit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);

      // Escape holds too: a failure still has the typed name to show.
      await user.keyboard("{Escape}");
      expect(screen.getByTestId("new-input")).toBe(input);
      expect(screen.queryByRole("menu")).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });

    // While an IME composes, Enter takes a candidate, Escape drops the
    // composition, and the arrows move in the candidate list. Some browsers
    // mark those keys only with keyCode 229.
    it("leaves Enter, Escape and the arrows to an IME while it composes", async () => {
      const user = userEvent.setup();
      const submit = vi.fn();
      render(<Naming onSubmit={submit} />);
      await user.click(screen.getByTestId("row-menu"));
      await user.click(screen.getByTestId("new"));
      const input = screen.getByTestId("new-input");
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
          fireEvent.keyDown(input, { key, ...composition });
          expect(submit).not.toHaveBeenCalled();
          expect(screen.getByTestId("new-input")).toBe(input);
          expect(screen.queryByRole("menu")).not.toBeNull();
          expect(document.activeElement).toBe(input);
        }
      }
      fireEvent.keyDown(input, { key: "Enter" });
      expect(submit).toHaveBeenCalledOnce();
    });
  });
});

// The keys every menu shares, the Menu part and the editor menus alike.
describe("moveInMenu", () => {
  const labels = ["Text", "Heading 1", "Heading 2", "Duplicate", "Delete"];
  const key = (name: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  });

  it("wraps the arrows, jumps with Home and End, and finds the next row by its first letter", () => {
    expect(moveInMenu(key("ArrowDown"), 4, labels)).toBe(0);
    expect(moveInMenu(key("ArrowUp"), 0, labels)).toBe(4);
    expect(moveInMenu(key("Home"), 3, labels)).toBe(0);
    expect(moveInMenu(key("End"), 0, labels)).toBe(4);
    expect(moveInMenu(key("h"), 0, labels)).toBe(1);
    expect(moveInMenu(key("h"), 1, labels)).toBe(2);
    expect(moveInMenu(key("D"), 2, labels)).toBe(3);
    expect(moveInMenu(key("d"), 3, labels)).toBe(4);
  });

  it("answers null for other keys, a letter no row starts with, and an empty list", () => {
    expect(moveInMenu(key("Enter"), 0, labels)).toBeNull();
    expect(moveInMenu(key(" "), 0, labels)).toBeNull();
    expect(moveInMenu(key("z"), 0, labels)).toBeNull();
    expect(moveInMenu(key("ArrowDown"), 0, [])).toBeNull();
  });

  // Ctrl+N is New file and Ctrl+D a shortcut too: they belong to the app.
  it("leaves a letter held with Ctrl, Meta or Alt to the app's shortcuts", () => {
    expect(moveInMenu(key("h", { ctrlKey: true }), 0, labels)).toBeNull();
    expect(moveInMenu(key("d", { metaKey: true }), 0, labels)).toBeNull();
    expect(moveInMenu(key("d", { altKey: true }), 0, labels)).toBeNull();
  });
});

describe("menuEnterFrom", () => {
  it("starts the list 4px toward its trigger", () => {
    expect(menuEnterFrom("below")).toEqual({ "--dohc-menu-from": "-4px" });
    expect(menuEnterFrom("above")).toEqual({ "--dohc-menu-from": "4px" });
    expect(menuEnterFrom("right")).toEqual({ "--dohc-menu-from": "0px", "--dohc-menu-from-x": "-4px" });
    expect(menuEnterFrom("left")).toEqual({ "--dohc-menu-from": "0px", "--dohc-menu-from-x": "4px" });
  });
});

describe("deleteShortcut", () => {
  it("labels the key as the keyboard does: ⌫ on macOS, Del elsewhere", () => {
    expect(deleteShortcut("darwin")).toEqual({ label: "⌫", keys: "Backspace" });
    expect(deleteShortcut("win32")).toEqual({ label: "Del", keys: "Delete" });
    expect(deleteShortcut("linux")).toEqual({ label: "Del", keys: "Delete" });
  });
});

// jsdom has no layout: a 100px list with 4px padding over 28px rows.
describe("revealMenuRow", () => {
  function list() {
    const element = document.createElement("div");
    element.style.paddingTop = "4px";
    element.style.paddingBottom = "4px";
    Object.defineProperty(element, "clientHeight", { value: 100 });
    document.body.append(element);
    const rows = Array.from({ length: 8 }, (_, index) => {
      const row = document.createElement("div");
      Object.defineProperty(row, "offsetTop", { value: 4 + index * 28 });
      Object.defineProperty(row, "offsetHeight", { value: 28 });
      element.append(row);
      return row;
    });
    return { element, rows };
  }
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("scrolls just enough to show a row below or above the view, with the padding around it", () => {
    const { element, rows } = list();
    revealMenuRow(element, rows[7]);
    // The last row ends at 228, plus 4px of padding: 232 - 100.
    expect(element.scrollTop).toBe(132);
    revealMenuRow(element, rows[6]);
    expect(element.scrollTop).toBe(132);
    revealMenuRow(element, rows[1]);
    expect(element.scrollTop).toBe(28);
    revealMenuRow(element, rows[0]);
    expect(element.scrollTop).toBe(0);
  });

  it("shows a start element above the row too, such as its section label", () => {
    const { element, rows } = list();
    element.scrollTop = 132;
    revealMenuRow(element, rows[4], rows[2]);
    expect(element.scrollTop).toBe(56);
  });
});
