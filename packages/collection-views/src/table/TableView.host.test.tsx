// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import {
  TableView,
  type CollectionCellChange,
  type TableCellStatus,
  type TableCellStatuses,
  type TableHostCell,
  type TableViewProps,
} from "./TableView";
import { indexedValue, makeRecord, makeSchema } from "../testSupport";

// The virtualizer measures its scroll element, which jsdom reports as 0, so
// every element gets a nonzero box (TableView.test.tsx precedent).
const offsetDescriptors = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

describe("what the host allows and has not confirmed", () => {
  // Column order: title 0, estimate 1, done 2, tags 3.
  const schema = makeSchema([
    { name: "title", type: "text" },
    { name: "estimate", type: "number" },
    { name: "done", type: "checkbox" },
    { name: "tags", type: "multi-select", options: ["alpha", "beta"] },
  ]);
  const records = () => ["a", "b"].map((id) => makeRecord(`rec-${id}`, [
    indexedValue("title", `Task ${id}`),
    indexedValue("estimate", 3),
    indexedValue("done", false),
    indexedValue("tags", ["alpha"]),
  ]));

  /** A host's unconfirmed cells, by `record:field`. */
  function statusStore(initial: Record<string, TableCellStatus> = {}) {
    let statuses = new Map(Object.entries(initial));
    const listeners = new Set<() => void>();
    const store: TableCellStatuses = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get: (recordId, field) => statuses.get(`${recordId}:${field}`),
    };
    const set = (next: Record<string, TableCellStatus>) => act(() => {
      statuses = new Map(Object.entries(next));
      for (const listener of listeners) listener();
    });
    return { store, set };
  }

  function setup(props: Partial<TableViewProps> = {}) {
    const onCellChange = vi.fn((_change: CollectionCellChange) => 1);
    const view = render(<TableView schema={schema} records={records()} onCellChange={onCellChange} {...props} />);
    const grid = screen.getByRole("grid");
    const cell = (row: number, column: number) => {
      const found = grid.querySelectorAll<HTMLElement>(`[role="row"][data-index="${row}"] [role="gridcell"]`)[column];
      if (!found) throw new Error(`no cell at row ${row}, column ${column}`);
      return found;
    };
    /** Presses a key on the grid. False when the grid kept the key from the browser. */
    const press = (key: string, modifiers: { shiftKey?: boolean } = {}) => fireEvent.keyDown(grid, { key, ...modifiers });
    const editor = () => grid.querySelector<HTMLElement>("[data-cell-editor]");
    return { view, grid, cell, press, editor, onCellChange };
  }

  it("gives a cell the host refuses no edit path, by click or by key", () => {
    // The host allows the title and the checkbox of the second record only.
    const canEditCell = (record: CollectionRecord, field: { name: string }) => record.id === "rec-b" && field.name !== "estimate";
    const { cell, press, editor, onCellChange } = setup({ canEditCell });
    expect(within(cell(0, 0)).queryByRole("button")).toBeNull();
    expect(within(cell(0, 2)).getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);

    fireEvent.click(cell(0, 0));
    expect(cell(0, 0).getAttribute("aria-selected")).toBe("true");
    for (const key of ["Enter", "x", "Delete", "Backspace"]) press(key);
    expect(editor()).toBeNull();
    fireEvent.click(cell(0, 2));
    press(" ");
    press("Enter");
    fireEvent.click(cell(1, 1));
    press("Enter");
    press("7");
    expect(editor()).toBeNull();
    expect(onCellChange).not.toHaveBeenCalled();

    // The cells it allows still edit.
    fireEvent.click(cell(1, 2));
    press(" ");
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recordId: "rec-b", field: "done", value: true }));
    fireEvent.click(cell(1, 0));
    expect(editor()).not.toBeNull();
  });

  it("makes a header the host cannot sort by a label, and gives its mark focus for its words", () => {
    const onSortChange = vi.fn();
    const marks = new Map([["tags", { icon: <svg />, label: '"Stamp" sets this field' }]]);
    setup({ onSortChange, fieldMarks: marks, canSortField: (field) => field.name !== "tags", sort: [{ field: "tags", direction: "asc" }] });
    expect(screen.queryByRole("button", { name: "tags" })).toBeNull();
    const header = screen.getAllByRole("columnheader")[3]!;
    expect(header.textContent).toContain("tags");
    expect(header.hasAttribute("aria-sort")).toBe(false);
    const mark = within(header).getByRole("img", { name: '"Stamp" sets this field' });
    expect(mark.tabIndex).toBe(0);
    fireEvent.focus(mark);
    expect(within(header).getByRole("tooltip").textContent).toBe('"Stamp" sets this field');
    fireEvent.click(screen.getByRole("button", { name: "title" }));
    expect(onSortChange).toHaveBeenCalledExactlyOnceWith([{ field: "title", direction: "asc" }]);
  });

  it("shows a pending change on its cell alone, with the value the person gave", () => {
    const drawn = vi.fn();
    const { store, set } = statusStore();
    // A host-drawn column counts how often the table draws a cell.
    const hostCells = new Map<string, TableHostCell>([["estimate", { cell: (record) => { drawn(record.id); return <span>host</span>; } }]]);
    const { cell } = setup({ cellStatuses: store, hostCells });
    expect(cell(0, 0).querySelector("[data-cell-status]")).toBeNull();
    drawn.mockClear();

    set({ "rec-a:title": { state: "pending", value: "Renamed" } });
    expect(cell(0, 0).textContent).toBe("RenamedSaving");
    expect(cell(0, 0).querySelector('[data-cell-status="pending"]')).not.toBeNull();
    expect(cell(1, 0).textContent).toBe("Task b");
    // No other cell drew again.
    expect(drawn).not.toHaveBeenCalled();

    set({});
    expect(cell(0, 0).textContent).toBe("Task a");
    expect(drawn).not.toHaveBeenCalled();
  });

  it("offers Try again on a cell the host could not confirm, by pointer and by Tab, without opening its editor", () => {
    const retry = vi.fn();
    const reason = "dohc could not confirm this change.";
    const { store } = statusStore({ "rec-a:title": { state: "unconfirmed", value: "Renamed", reason, retry } });
    const { grid, cell, press, editor } = setup({ cellStatuses: store });
    expect(cell(0, 0).textContent).toContain("Renamed");
    expect(cell(0, 0).querySelector("[data-cell-status]")?.textContent).toBe(reason);

    fireEvent.click(within(cell(0, 0)).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(cell(0, 0).hasAttribute("aria-selected")).toBe(false);

    // Selected from the keyboard, the cell says why under it, and Tab reaches the action.
    grid.focus();
    press("ArrowDown");
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(`${reason}Try again`);
    expect(cell(0, 0).getAttribute("aria-describedby")).toBe(note.id);
    expect(press("Tab")).toBe(false);
    const action = within(note).getByRole("button", { name: "Try again" });
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(grid);

    // Escape from the action goes back to the cell, and Tab goes on to the next one.
    press("Tab");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(grid);
    expect(cell(0, 0).getAttribute("aria-selected")).toBe("true");
    press("Tab");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(cell(0, 1).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("keeps its layers in a stacking context of its own, so its sticky header never covers its host's menus", () => {
    const { grid } = setup();
    expect(grid.classList.contains("isolate")).toBe(true);
    // Inside it, the header still sits above the editor that scrolls under it.
    fireEvent.click(grid.querySelectorAll<HTMLElement>('[role="row"][data-index="0"] [role="gridcell"]')[0]!);
    expect(grid.querySelector('[role="row"]')!.classList.contains("z-20")).toBe(true);
    expect(grid.querySelector("[data-cell-editor]")!.classList.contains("z-10")).toBe(true);
  });

  it("says why a change was refused, starts the next edit from what was typed, and dismisses it", () => {
    const dismiss = vi.fn();
    const { store, set } = statusStore({ "rec-a:title": { state: "refused", value: "Typed", reason: "Enter a shorter name.", dismiss } });
    const { cell, press, editor } = setup({ cellStatuses: store });
    expect(cell(0, 0).querySelector('[data-cell-status="refused"]')?.getAttribute("title")).toBe("Enter a shorter name.");

    fireEvent.click(cell(0, 0));
    expect(editor()!.querySelector("input")!.value).toBe("Typed");
    fireEvent.keyDown(editor()!.querySelector("input")!, { key: "Escape" });
    expect(screen.getByRole("note").textContent).toBe("Enter a shorter name.Dismiss");

    fireEvent.click(within(cell(0, 0)).getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalledOnce();
    // A change that waits says so, with nothing to press.
    set({ "rec-a:title": { state: "waiting", value: "Typed", reason: "Waiting for an earlier change to this record." } });
    expect(screen.getByRole("note").textContent).toBe("Waiting for an earlier change to this record.");
    expect(press("Tab")).toBe(false);
    expect(cell(0, 1).getAttribute("aria-selected")).toBe("true");
  });

  it("acts on the value the cell shows: Space ticks off a box whose tick is pending", () => {
    const { store } = statusStore({ "rec-a:done": { state: "pending", value: true } });
    const { cell, press, onCellChange } = setup({ cellStatuses: store });
    expect(within(cell(0, 2)).getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
    fireEvent.click(cell(0, 2));
    press(" ");
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ field: "done", value: false }));
  });

  it("lets the host draw a cell and its editor, and never opens its own editor there", () => {
    const hostEditor = vi.fn((record: CollectionRecord, close: () => void) => (
      <button type="button" onClick={close}>{`Attach to ${record.id}`}</button>
    ));
    const hostCells = new Map<string, TableHostCell>([
      ["title", { cell: (record) => <span>{`File of ${record.id}`}</span>, editor: hostEditor }],
      ["estimate", { cell: () => <span>Read only</span> }],
    ]);
    const { grid, cell, press, editor, onCellChange } = setup({ hostCells });
    expect(cell(0, 0).textContent).toBe("File of rec-a");
    expect(screen.queryByText("Task a")).toBeNull();

    // A typed character and Delete are the host's to take, in its editor.
    fireEvent.click(cell(0, 1));
    press("ArrowLeft");
    expect(cell(0, 0).getAttribute("aria-selected")).toBe("true");
    press("x");
    press("Delete");
    expect(editor()).toBeNull();
    expect(onCellChange).not.toHaveBeenCalled();

    press("Enter");
    const attach = within(editor()!).getByRole("button", { name: "Attach to rec-a" });
    expect(editor()!.querySelector("input")).toBeNull();
    attach.focus();
    fireEvent.click(attach);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(grid);

    // A host cell with no editor does not edit.
    fireEvent.click(cell(0, 1));
    press("Enter");
    expect(editor()).toBeNull();
  });

  it("says what the host gives for a table with no records, beside its New record row", () => {
    render(<TableView schema={schema} records={[]} onNewRecord={vi.fn()} emptyText="No records match. Try a shorter search." />);
    expect(screen.getByText("No records match. Try a shorter search.")).toBeDefined();
    expect(screen.getByRole("button", { name: "New record" })).toBeDefined();
  });
});
