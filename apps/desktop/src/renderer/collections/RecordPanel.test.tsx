// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordPanel, type RecordPanelProps } from "./RecordPanel";

const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
/** The width of the row the panel shares with its view, which jsdom reports as 0. */
function room(width: number): void {
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
}
beforeEach(() => {
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  if (clientWidth) Object.defineProperty(Element.prototype, "clientWidth", clientWidth);
});

function setup(overrides: Partial<RecordPanelProps> = {}) {
  const onClose = vi.fn(), onWidthChange = vi.fn();
  const props: RecordPanelProps = { name: "Alice", collectionName: "People", width: 380, onWidthChange, onClose, ...overrides };
  const view = render(<div><button type="button">Beside the panel</button><RecordPanel {...props} /></div>);
  const panel = screen.getByRole("complementary", { name: props.name || "Record" });
  return { onClose, onWidthChange, props, panel, in: within(panel), rerender: (next: Partial<RecordPanelProps>) => view.rerender(<div><button type="button">Beside the panel</button><RecordPanel {...props} {...next} /></div>) };
}

describe("the record panel", () => {
  it("is a named region beside the page, not a dialog, with the Collection's name and what the host offers", () => {
    const onOpenAsPage = vi.fn(), remove = vi.fn();
    const view = setup({ properties: <p>Fields</p>, body: <p>Page text</p>, footer: "Offline copy · Read-only" });
    expect(view.panel.getAttribute("aria-modal")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.in.getByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(view.in.getByText("People")).toBeTruthy();
    expect(view.in.getByText("Fields")).toBeTruthy();
    expect(view.in.getByText("Page text")).toBeTruthy();
    expect(view.in.getByText("Offline copy · Read-only")).toBeTruthy();
    // A record with no page offers none, and a record with no commands has no menu.
    expect(view.in.queryByRole("button", { name: "Open as page" })).toBeNull();
    expect(view.in.queryByRole("button", { name: "Record actions" })).toBeNull();
    // Nothing holds focus in the panel: the page beside it takes it.
    screen.getByRole("button", { name: "Beside the panel" }).focus();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Beside the panel" }));

    view.rerender({ onOpenAsPage, commands: [{ id: "delete", label: "Delete record…", danger: true, onSelect: remove }] });
    fireEvent.click(view.in.getByRole("button", { name: "Open as page" }));
    expect(onOpenAsPage).toHaveBeenCalledOnce();
    fireEvent.click(view.in.getByRole("button", { name: "Record actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete record…" }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("closes on Close and on Escape, after an open menu has taken its own Escape", () => {
    const view = setup({ commands: [{ id: "delete", label: "Delete record…", onSelect: vi.fn() }] });
    fireEvent.click(view.in.getByRole("button", { name: "Close record" }));
    expect(view.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(view.in.getByRole("button", { name: "Record actions" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Delete record…" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(view.onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(view.in.getByRole("button", { name: "Record actions" }), { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledTimes(2);
    // Escape with focus on the page beside the panel is that page's key.
    fireEvent.keyDown(screen.getByRole("button", { name: "Beside the panel" }), { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves Escape to an editor inside it that takes the key", () => {
    const view = setup({ properties: <input aria-label="Open editor" onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} /> });
    fireEvent.keyDown(view.in.getByLabelText("Open editor"), { key: "Escape" });
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it("shows a name the host does not let open as a plain heading", () => {
    const view = setup({ onNameChange: vi.fn() });
    expect(within(view.in.getByRole("heading", { name: "Alice" })).queryByRole("button")).toBeNull();
  });

  it("changes the name in place by a cell's rules: Enter or a press away saves, Escape cancels, and the panel stays", () => {
    const onNameChange = vi.fn();
    const view = setup({ onNameChange, canRename: true, nameLabel: "Full name" });
    const open = () => {
      fireEvent.click(within(view.in.getByRole("heading")).getByRole("button", { name: "Alice" }));
      return view.in.getByRole<HTMLInputElement>("textbox", { name: "Full name" });
    };
    let input = open();
    expect(input.value).toBe("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNameChange).toHaveBeenCalledExactlyOnceWith("Alicia");
    expect(view.in.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(within(view.in.getByRole("heading")).getByRole("button"));

    input = open();
    fireEvent.change(input, { target: { value: "Dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.in.queryByRole("textbox")).toBeNull();
    expect(onNameChange).toHaveBeenCalledTimes(1);
    expect(view.onClose).not.toHaveBeenCalled();

    input = open();
    fireEvent.change(input, { target: { value: "By a press away" } });
    fireEvent.blur(input);
    expect(onNameChange).toHaveBeenLastCalledWith("By a press away");
    expect(onNameChange).toHaveBeenCalledTimes(2);

    // The same name saves nothing.
    fireEvent.keyDown(open(), { key: "Enter" });
    expect(onNameChange).toHaveBeenCalledTimes(2);
  });

  it("starts the name's input from the field's own text, and says when a record has none", () => {
    const view = setup({ name: "record 7", nameText: "", onNameChange: vi.fn(), canRename: true });
    expect(view.panel.getAttribute("aria-label")).toBe("record 7");
    fireEvent.click(within(view.in.getByRole("heading", { name: "Untitled" })).getByRole("button"));
    expect(view.in.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("");
  });

  it("keeps the name being typed through a new read, and hands it to the host when the panel goes", () => {
    const onNameAbandoned = vi.fn(), onNameChange = vi.fn();
    function Host() {
      const [open, setOpen] = useState(true);
      const [name, setName] = useState("Alice");
      return <>
        <button type="button" onClick={() => setName("Changed elsewhere")}>Read again</button>
        <button type="button" onClick={() => setOpen(false)}>Leave</button>
        {open ? <RecordPanel name={name} collectionName="People" width={380} onWidthChange={vi.fn()} onClose={vi.fn()} canRename onNameChange={onNameChange} onNameAbandoned={onNameAbandoned} /> : null}
      </>;
    }
    render(<Host />);
    fireEvent.click(within(screen.getByRole("heading")).getByRole("button"));
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "Half typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Half typed");
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onNameAbandoned).toHaveBeenCalledExactlyOnceWith("Half typed");
    expect(onNameChange).not.toHaveBeenCalled();
  });

  it("closes a name being typed when the host stops letting the name open, hands the host the text, and saves none of it", () => {
    const onNameChange = vi.fn(), onNameAbandoned = vi.fn();
    const view = setup({ onNameChange, onNameAbandoned, canRename: true });
    fireEvent.click(within(view.in.getByRole("heading")).getByRole("button"));
    fireEvent.change(view.in.getByRole("textbox", { name: "Name" }), { target: { value: "Half typed" } });
    view.rerender({ onNameChange, onNameAbandoned, canRename: false });
    expect(view.in.queryByRole("textbox")).toBeNull();
    expect(within(view.in.getByRole("heading", { name: "Alice" })).queryByRole("button")).toBeNull();
    expect(onNameAbandoned).toHaveBeenCalledExactlyOnceWith("Half typed");
    expect(onNameChange).not.toHaveBeenCalled();
    // An input in which nothing was typed leaves nothing to keep.
    view.rerender({ onNameChange, onNameAbandoned, canRename: true });
    fireEvent.click(within(view.in.getByRole("heading")).getByRole("button"));
    view.rerender({ onNameChange, onNameAbandoned, canRename: false });
    expect(view.in.queryByRole("textbox")).toBeNull();
    expect(onNameAbandoned).toHaveBeenCalledTimes(1);
  });

  it("keeps an open name with the field it opened on: when another field becomes the name, the first field's host gets the text and the new field gets nothing", () => {
    const first = { onNameChange: vi.fn(), onNameAbandoned: vi.fn() }, second = { onNameChange: vi.fn(), onNameAbandoned: vi.fn() };
    const view = setup({ ...first, nameField: "name", canRename: true });
    fireEvent.click(within(view.in.getByRole("heading")).getByRole("button"));
    fireEvent.change(view.in.getByRole("textbox", { name: "Name" }), { target: { value: "Half typed" } });
    view.rerender({ ...second, nameField: "notes", nameLabel: "Notes", name: "Call back", canRename: true });
    expect(view.in.queryByRole("textbox")).toBeNull();
    expect(view.in.getByRole("heading", { name: "Call back" })).toBeTruthy();
    expect(first.onNameAbandoned).toHaveBeenCalledExactlyOnceWith("Half typed");
    expect([first.onNameChange, second.onNameChange, second.onNameAbandoned].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("says in one line why it cannot show a record, and offers Close", () => {
    const view = setup({ unavailable: "This record is no longer in this Collection.", properties: <p>Fields</p>, onOpenAsPage: vi.fn(), commands: [{ id: "delete", label: "Delete record…", onSelect: vi.fn() }] });
    expect(view.in.getByRole("status").textContent).toBe("This record is no longer in this Collection.");
    expect(view.in.queryByText("Fields")).toBeNull();
    expect(view.in.queryByRole("heading")).toBeNull();
    expect(view.in.queryByRole("button", { name: "Record actions" })).toBeNull();
    expect(view.in.queryByRole("button", { name: "Open as page" })).toBeNull();
    fireEvent.click(view.in.getByRole("button", { name: "Close" }));
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it("shows a record still being read as loading, with its controls to close", () => {
    const view = setup({ name: "", loading: true, properties: <p>Fields</p> });
    expect(view.panel.getAttribute("aria-busy")).toBe("true");
    expect(view.in.getByRole("status").textContent).toBe("Opening record…");
    expect(view.in.queryByText("Fields")).toBeNull();
    expect(view.in.getByRole("button", { name: "Close record" })).toBeTruthy();
  });

  it("resizes by keyboard within its bounds, which keep room for the view beside it", () => {
    room(1000);
    const view = setup();
    const handle = view.in.getByRole("separator", { name: "Resize record" });
    expect(handle.tabIndex).toBe(0);
    expect([handle.getAttribute("aria-valuemin"), handle.getAttribute("aria-valuemax"), handle.getAttribute("aria-valuenow")]).toEqual(["320", "640", "380"]);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(396);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(364);
    fireEvent.keyDown(handle, { key: "End" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(640);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(320);
    // A width saved in a wider window gives way to the view.
    view.rerender({ width: 900 });
    expect(view.panel.style.width).toBe("640px");
  });

  it("follows a drag without telling the host until the drag ends", () => {
    room(1200);
    const view = setup();
    view.panel.getBoundingClientRect = () => ({ x: 820, y: 0, left: 820, top: 0, right: 1200, bottom: 800, width: 380, height: 800, toJSON: () => ({}) });
    const handle = view.in.getByRole("separator", { name: "Resize record" });
    fireEvent.pointerDown(handle, { button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 700, pointerId: 1 });
    expect(view.panel.style.width).toBe("500px");
    fireEvent.pointerMove(handle, { buttons: 1, clientX: 100, pointerId: 1 });
    expect(view.panel.style.width).toBe("840px");
    expect(view.onWidthChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(view.onWidthChange).toHaveBeenCalledExactlyOnceWith(840);
  });

  it("lies over the view from the right where the page is too narrow for both", () => {
    room(1000);
    const wide = setup();
    expect(wide.panel.className).toContain("relative");
    expect(wide.panel.className).not.toContain("absolute");
    cleanup();
    room(600);
    const narrow = setup({ width: 380 });
    expect(narrow.panel.className).toContain("absolute");
    expect(narrow.panel.className).toContain("right-0");
    expect(narrow.panel.style.width).toBe("380px");
    // It never grows past the page.
    expect(narrow.in.getByRole("separator").getAttribute("aria-valuemax")).toBe("600");
  });
});
