// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import { TableView, type CollectionCellChange, type TableViewProps } from "./TableView";
import { indexedValue, makeQueryResult, makeRecord, makeSchema } from "../testSupport";

// The virtualizer measures its scroll element through offsetWidth and
// offsetHeight, which jsdom reports as 0. Give every element a nonzero box
// so rows render (CollectionPage.test.tsx precedent in apps/desktop).
const offsetDescriptors = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 900,
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(offsetDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
});

function makeRecords(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeRecord(`rec-${index}`, [indexedValue("title", `Task ${index}`)]),
  );
}

function scroller(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".overflow-auto");
  if (!element) throw new Error("no scroll element");
  return element;
}

describe("TableView paging", () => {
  it("calls onNearEnd when scrolling nears the end of the loaded rows", () => {
    const onNearEnd = vi.fn();
    const records = makeRecords(200);
    const { container } = render(
      <TableView schema={makeSchema()} records={records} onNearEnd={onNearEnd} />,
    );
    // The viewport renders the first ~26 rows of 200: nowhere near the end.
    expect(onNearEnd).not.toHaveBeenCalled();

    const element = scroller(container);
    element.scrollTop = records.length * 28;
    fireEvent.scroll(element);

    expect(onNearEnd).toHaveBeenCalled();
  });

  it("calls onNearEnd on first render when one page cannot outrun the viewport", () => {
    const onNearEnd = vi.fn();
    render(
      <TableView
        schema={makeSchema()}
        records={makeRecords(30)}
        onNearEnd={onNearEnd}
      />,
    );
    expect(onNearEnd).toHaveBeenCalled();
  });
});

describe("New record row", () => {
  it.each([0, 2])("ends the table with a New record row that adds one (%i records)", (count) => {
    const onNewRecord = vi.fn();
    render(<TableView schema={makeSchema([{ name: "title", type: "text" }])} records={makeRecords(count)} onNewRecord={onNewRecord} />);
    expect(screen.getByRole("columnheader", { name: /title/ })).toBeDefined();
    expect(screen.queryByText("No records in this collection yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New record" }));
    expect(onNewRecord).toHaveBeenCalledTimes(1);
  });

  it("disables the row while editing is paused, and has no row without the action", () => {
    const schema = makeSchema([{ name: "title", type: "text" }]);
    const { rerender } = render(<TableView schema={schema} records={[]} onNewRecord={vi.fn()} editingDisabled />);
    expect((screen.getByRole("button", { name: "New record" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<TableView schema={schema} records={[]} />);
    expect(screen.queryByRole("button", { name: "New record" })).toBeNull();
    expect(screen.getByText("No records in this collection yet.")).toBeDefined();
  });
});

describe("paused table editing", () => {
  it("keeps a typed multi-select option mounted and disabled until editing resumes", () => {
    const records = [makeRecord("rec-1", [indexedValue("tags", ["alpha"])])];
    const schema = makeSchema([{ name: "tags", type: "multi-select", options: ["alpha", "beta"] }]);
    const onCellChange = vi.fn(() => 1);
    const onCreateOption = vi.fn();
    const table = (editingDisabled: boolean) => (
      <TableView schema={schema} records={records} editingDisabled={editingDisabled}
        onCellChange={onCellChange} onCreateOption={onCreateOption} />
    );
    const view = render(table(false));
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    const input = screen.getByLabelText<HTMLInputElement>("Add option");
    fireEvent.change(input, { target: { value: "delta" } });
    view.rerender(table(true));
    expect(screen.getByLabelText("Add option")).toBe(input);
    expect(input.matches(":disabled")).toBe(true);
    fireEvent.blur(input);
    expect(onCreateOption).not.toHaveBeenCalled();
    expect(onCellChange).not.toHaveBeenCalled();

    view.rerender(table(false));
    expect(screen.getByLabelText("Add option")).toBe(input);
    expect(input.value).toBe("delta");
    expect(input.matches(":disabled")).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreateOption).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-1", recordPath: records[0]!.path, field: "tags", option: "delta",
      value: ["alpha", "delta"], previousValues: [["alpha"]],
    });
  });

  it("does not commit or close a text draft when pausing blurs its input", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Before")])];
    const schema = makeSchema([{ name: "title", type: "text" }]);
    const onCellChange = vi.fn(() => 1);
    const table = (editingDisabled: boolean) => (
      <TableView schema={schema} records={records} editingDisabled={editingDisabled} onCellChange={onCellChange} />
    );
    const view = render(table(false));
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Draft" } });
    view.rerender(table(true));
    fireEvent.blur(input);
    expect(onCellChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBe(input);
    view.rerender(table(false));
    expect(input.value).toBe("Draft");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-1", recordPath: records[0]!.path, field: "title", value: "Draft",
    });
  });
});

describe("button fields", () => {
  it("shows a button column as a label that neither sorts nor edits", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Invoice 12")])];
    const schema = makeSchema([
      { name: "title", type: "text" },
      { name: "Mark paid", type: "button" },
    ]);
    const onSortChange = vi.fn();
    const onCellChange = vi.fn(() => 1);
    render(
      <TableView
        schema={schema}
        records={records}
        onSortChange={onSortChange}
        onCellChange={onCellChange}
      />,
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["title", "Mark paid"]);
    expect(screen.queryByRole("button", { name: "Mark paid" })).toBeNull();
    fireEvent.click(headers[1]!);
    fireEvent.click(screen.getAllByText("Mark paid")[1]!);
    expect(onSortChange).not.toHaveBeenCalled();
    expect(onCellChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
  });

  it("lets the host draw each button cell for its record, and never a text field's", () => {
    const records = [makeRecord("rec-1", [indexedValue("title", "Invoice 12")])];
    const schema = makeSchema([
      { name: "title", type: "text" },
      { name: "Mark paid", type: "button" },
    ]);
    const renderButton = vi.fn((field: { name: string }, record: { id: string }) => (
      <button type="button">{`${field.name} for ${record.id}`}</button>
    ));
    render(<TableView schema={schema} records={records} renderButton={renderButton} />);
    expect(screen.getByRole("button", { name: "Mark paid for rec-1" })).toBeDefined();
    expect(renderButton.mock.calls.every(([field]) => field.name === "Mark paid")).toBe(true);
    expect(screen.getByText("Invoice 12")).toBeDefined();
  });
});

describe("field marks", () => {
  it("shows a field's mark after its name, and says what it means without renaming the sort control", () => {
    const schema = makeSchema([{ name: "title", type: "text" }, { name: "done", type: "checkbox" }]);
    const marks = new Map([["done", { icon: <svg data-testid="mark-icon" />, label: '"Stamp" sets this field' }]]);
    const onSortChange = vi.fn();
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} onSortChange={onSortChange} />);

    const done = screen.getByRole("button", { name: "done" });
    const description = document.getElementById(done.getAttribute("aria-describedby") ?? "");
    expect(description?.getAttribute("role")).toBe("tooltip");
    expect(description?.textContent).toBe('"Stamp" sets this field');
    expect(done.querySelector('[data-testid="mark-icon"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "title" }).hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getAllByTestId("table-field-mark")).toHaveLength(1);

    fireEvent.click(done);
    expect(onSortChange).toHaveBeenCalledWith([{ field: "done", direction: "asc" }]);
  });

  it("shows the words on hover and focus, keeps them while the pointer is on them, and hides them on Escape", () => {
    const schema = makeSchema([{ name: "done", type: "checkbox" }]);
    const marks = new Map([["done", { icon: <svg />, label: '"Stamp" sets this field' }]]);
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} />);
    const done = screen.getByRole("button", { name: "done" });
    const words = document.getElementById(done.getAttribute("aria-describedby") ?? "")!;
    const header = screen.getByRole("columnheader", { name: /done/ });
    expect(words.hidden).toBe(true);

    fireEvent.mouseEnter(header);
    expect(words.hidden).toBe(false);
    // The words sit inside the header, so moving onto them keeps them open.
    fireEvent.mouseOver(words);
    expect(words.hidden).toBe(false);
    fireEvent.mouseLeave(header);
    expect(words.hidden).toBe(true);

    // Focus that a pointer press gives, as when a click sorts the column, shows nothing.
    fireEvent.pointerDown(done);
    act(() => done.focus());
    fireEvent.pointerUp(done);
    expect(words.hidden).toBe(true);
    act(() => done.blur());
    act(() => done.focus());
    expect(words.hidden).toBe(false);
    // Escape on the sort control closes the words and nothing around them.
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(done, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(words.hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    act(() => done.blur());

    // Words the pointer opened close on Escape wherever focus is, and
    // leaving focus does not close words the pointer holds open.
    fireEvent.mouseEnter(header);
    act(() => done.focus());
    act(() => done.blur());
    expect(words.hidden).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(words.hidden).toBe(true);
  });

  it("closes every open mark's words with one Escape, even when the focused mark stops the key", () => {
    const schema = makeSchema([{ name: "title", type: "text" }, { name: "done", type: "checkbox" }]);
    const marks = new Map([
      ["title", { icon: <svg />, label: '"Name" sets this field' }],
      ["done", { icon: <svg />, label: '"Stamp" sets this field' }],
    ]);
    render(<TableView schema={schema} records={makeRecords(1)} fieldMarks={marks} />);
    const title = screen.getByRole("button", { name: "title" });
    const words = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-describedby") ?? "")!;
    const done = screen.getByRole("button", { name: "done" });
    act(() => title.focus());
    fireEvent.mouseEnter(screen.getByRole("columnheader", { name: /done/ }));
    expect([words(title).hidden, words(done).hidden]).toEqual([false, false]);

    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(title, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect([words(title).hidden, words(done).hidden]).toEqual([true, true]);
    // The focused mark still keeps the key from the surface around it.
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("selection and keys", () => {
  // Column order: title 0, estimate 1, done 2, status 3, tags 4, blocks 5, Mark paid 6.
  const schema = makeSchema([
    { name: "title", type: "text" },
    { name: "estimate", type: "number" },
    { name: "done", type: "checkbox" },
    { name: "status", type: "select", options: ["todo", "doing"] },
    { name: "tags", type: "multi-select", options: ["alpha", "beta"] },
    { name: "blocks", type: "relation", collection: "tasks", many: true },
    { name: "Mark paid", type: "button" },
  ]);
  const DONE = 2;
  const taskRecords = (ids: string[] = ["a", "b", "c"]) =>
    ids.map((id) =>
      makeRecord(`rec-${id}`, [
        indexedValue("title", `Task ${id}`),
        indexedValue("estimate", 3),
        indexedValue("done", false),
        indexedValue("status", "todo"),
        indexedValue("tags", ["alpha"]),
        indexedValue("blocks", ["rec-x"]),
      ]),
    );

  function setup(props: Partial<TableViewProps> = {}) {
    const onCellChange = vi.fn((_change: CollectionCellChange) => 1);
    const table = (extra: Partial<TableViewProps> = {}) => (
      <TableView schema={schema} records={taskRecords()} onCellChange={onCellChange} {...props} {...extra} />
    );
    const view = render(table());
    const grid = screen.getByRole("grid");
    const gutter = props.onOpenRecord ? 1 : 0;
    const cell = (row: number, column: number) => {
      const found = grid.querySelectorAll<HTMLElement>(`[role="row"][data-index="${row}"] [role="gridcell"]`)[column + gutter];
      if (!found) throw new Error(`no cell at row ${row}, column ${column}`);
      return found;
    };
    /** The selected cell as [row, column], read from the grid as assistive technology reads it. */
    const selection = () => {
      const active = grid.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) return null;
      expect(grid.getAttribute("aria-activedescendant")).toBe(active.id);
      expect(grid.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
      const row = active.parentElement!;
      return [Number(row.dataset.index), [...row.children].indexOf(active) - gutter];
    };
    /** Presses a key on the grid. False when the grid kept the key from the browser. */
    const press = (key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) =>
      fireEvent.keyDown(grid, { key, ...modifiers });
    const editorInput = () => grid.querySelector<HTMLInputElement>("[data-cell-editor] input");
    // A click on the checkbox cell's own padding selects it and opens nothing.
    const selectDone = (row = 0) => fireEvent.click(cell(row, DONE));
    return { view, table, grid, cell, selection, press, editorInput, selectDone, onCellChange };
  }

  it("selects a cell on click and rings it, and starts the edit only where the cell can be edited", () => {
    const readOnly = setup({ onCellChange: undefined });
    expect(readOnly.selection()).toBeNull();
    fireEvent.click(readOnly.cell(1, 0));
    expect(readOnly.selection()).toEqual([1, 0]);
    expect(readOnly.cell(1, 0).className).toContain("ring-2 ring-inset ring-accent");
    expect(readOnly.cell(0, 0).className).not.toContain("ring-2");
    expect(readOnly.editorInput()).toBeNull();
    cleanup();

    const editable = setup();
    fireEvent.click(screen.getByRole("button", { name: "Task b" }));
    expect(editable.selection()).toEqual([1, 0]);
    expect(editable.editorInput()?.value).toBe("Task b");
  });

  it("leaves the selection alone when a click lands in a dialog the host's button opened", () => {
    const { cell, selection } = setup({
      onCellChange: undefined,
      renderButton: () => createPortal(<button type="button">Confirm</button>, document.body),
    });
    fireEvent.click(cell(1, 0));
    // The dialog is the button cell's child in React, and outside it on the page.
    fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[0]!);
    expect(selection()).toEqual([1, 0]);
  });

  it("is one Tab stop, whatever the number of rows", () => {
    const { grid } = setup({ onOpenRecord: vi.fn() });
    expect(grid.tabIndex).toBe(0);
    const rowStops = [...grid.querySelectorAll<HTMLElement>('[role="row"][data-index] :is(button, input)')];
    expect(rowStops.length).toBeGreaterThan(0);
    expect(rowStops.every((control) => control.tabIndex === -1)).toBe(true);
  });

  it("moves the selection with the arrow keys and stops at the edges", () => {
    const { selection, press, selectDone, grid } = setup();
    // With nothing selected, an arrow key starts at the first cell.
    expect(press("ArrowDown")).toBe(false);
    expect(selection()).toEqual([0, 0]);
    expect(document.activeElement).toBe(grid);

    selectDone(1);
    press("ArrowRight");
    expect(selection()).toEqual([1, 3]);
    press("ArrowDown");
    press("ArrowDown");
    expect(selection()).toEqual([2, 3]);
    for (let step = 0; step < 5; step += 1) press("ArrowRight");
    expect(selection()).toEqual([2, 6]);
    for (let step = 0; step < 8; step += 1) press("ArrowLeft");
    expect(selection()).toEqual([2, 0]);
    for (let step = 0; step < 4; step += 1) press("ArrowUp");
    expect(selection()).toEqual([0, 0]);
    // A shortcut that uses an arrow key stays with the app.
    expect(press("ArrowDown", { ctrlKey: true })).toBe(true);
    expect(selection()).toEqual([0, 0]);
  });

  it("scrolls the cell a key selects into view, clear of the sticky header", () => {
    const { grid, press, selectDone, selection } = setup({ onOpenRecord: vi.fn() });
    Object.defineProperty(grid, "clientHeight", { configurable: true, value: 96 });
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 400 });
    selectDone();
    // Rows are 32 tall under a 32 header: 96 of height shows rows 0 and 1.
    press("ArrowDown");
    expect(grid.scrollTop).toBe(0);
    press("ArrowDown");
    expect(grid.scrollTop).toBe(32);
    // done ends at 36 + 260 + 180 + 180 = 656, past a width of 400.
    expect(grid.scrollLeft).toBe(256);
    press("ArrowUp");
    press("ArrowUp");
    expect(grid.scrollTop).toBe(0);
    press("ArrowLeft");
    expect(grid.scrollLeft).toBe(256);
    press("ArrowLeft");
    // The first field brings the Open gutter back with it.
    expect(grid.scrollLeft).toBe(0);
    expect(selection()).toEqual([0, 0]);
  });

  it("starts an edit with Enter, cancels it with Escape, and keeps the cell selected", () => {
    const { grid, cell, press, selection, editorInput, onCellChange } = setup();
    fireEvent.click(cell(0, 0));
    fireEvent.change(editorInput()!, { target: { value: "Abandoned" } });
    fireEvent.keyDown(editorInput()!, { key: "Escape" });
    expect(editorInput()).toBeNull();
    expect(onCellChange).not.toHaveBeenCalled();
    // One Escape closed the editor only. The grid has the keys again.
    expect(selection()).toEqual([0, 0]);
    expect(document.activeElement).toBe(grid);

    press("Enter");
    expect(editorInput()?.value).toBe("Task a");
    fireEvent.keyDown(editorInput()!, { key: "Escape" });
    press("Escape");
    expect(selection()).toBeNull();
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("saves once on Enter and moves down a row, staying on the last row", () => {
    const { cell, selection, editorInput, onCellChange, grid, press } = setup();
    fireEvent.click(cell(1, 0));
    fireEvent.change(editorInput()!, { target: { value: "Renamed" } });
    fireEvent.keyDown(editorInput()!, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-b", recordPath: "tasks/rec-b.md", field: "title", value: "Renamed",
    });
    expect(editorInput()).toBeNull();
    expect(selection()).toEqual([2, 0]);
    expect(document.activeElement).toBe(grid);

    press("Enter");
    fireEvent.keyDown(editorInput()!, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledTimes(2);
    expect(selection()).toEqual([2, 0]);
  });

  it("saves on Tab and Shift+Tab and moves sideways", () => {
    const { cell, selection, editorInput, onCellChange, press } = setup();
    fireEvent.click(cell(0, 0));
    fireEvent.change(editorInput()!, { target: { value: "Renamed" } });
    expect(fireEvent.keyDown(editorInput()!, { key: "Tab" })).toBe(false);
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ field: "title", value: "Renamed" }));
    expect(selection()).toEqual([0, 1]);

    press("Enter");
    fireEvent.change(editorInput()!, { target: { value: "8" } });
    fireEvent.keyDown(editorInput()!, { key: "Tab", shiftKey: true });
    expect(onCellChange).toHaveBeenLastCalledWith(expect.objectContaining({ field: "estimate", value: 8 }));
    expect(onCellChange).toHaveBeenCalledTimes(2);
    expect(selection()).toEqual([0, 0]);
  });

  it("moves with Tab across rows, and lets Tab leave at the first and last cell", () => {
    const { press, selectDone, selection } = setup();
    selectDone();
    for (let step = 0; step < 4; step += 1) expect(press("Tab")).toBe(false);
    expect(selection()).toEqual([0, 6]);
    expect(press("Tab")).toBe(false);
    expect(selection()).toEqual([1, 0]);
    expect(press("Tab", { shiftKey: true })).toBe(false);
    expect(selection()).toEqual([0, 6]);
    for (let step = 0; step < 6; step += 1) press("Tab", { shiftKey: true });
    expect(selection()).toEqual([0, 0]);
    // fireEvent returns true when the grid left the key to the browser.
    expect(press("Tab", { shiftKey: true })).toBe(true);
    selectDone(2);
    for (let step = 0; step < 4; step += 1) press("Tab");
    expect(selection()).toEqual([2, 6]);
    expect(press("Tab")).toBe(true);
    // With nothing selected, Tab passes through the grid.
    press("Escape");
    expect(press("Tab")).toBe(true);
    expect(selection()).toBeNull();
  });

  it("replaces a text-like value with a typed character, and leaves other cells and shortcuts alone", () => {
    const { press, selectDone, selection, editorInput, onCellChange } = setup();
    selectDone();
    // A checkbox takes no text.
    press("x");
    expect(editorInput()).toBeNull();
    press("ArrowLeft");
    expect(press("7")).toBe(false);
    expect(editorInput()?.value).toBe("7");
    fireEvent.change(editorInput()!, { target: { value: "75" } });
    fireEvent.keyDown(editorInput()!, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ field: "estimate", value: 75 }));
    expect(selection()).toEqual([1, 1]);

    // Ctrl+V is the app's key, and a select opens no text editor.
    expect(press("v", { ctrlKey: true })).toBe(true);
    press("ArrowRight");
    press("ArrowRight");
    press("d");
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
  });

  it("clears a value with Delete or Backspace, except a relation, a checkbox, and a button", () => {
    const { press, selectDone, onCellChange, view, table } = setup({
      relationExecutor: vi.fn(async () => makeQueryResult([])),
    });
    selectDone();
    const cleared = () => onCellChange.mock.calls.map(([change]) => [change.field, change.value]);
    press("Delete");
    press("ArrowRight");
    press("Delete");
    press("ArrowRight");
    press("Backspace");
    press("ArrowRight");
    press("Delete");
    press("ArrowRight");
    press("Delete");
    for (let step = 0; step < 6; step += 1) press("ArrowLeft");
    press("Backspace");
    press("ArrowRight");
    press("Delete");
    expect(cleared()).toEqual([["status", null], ["tags", []], ["title", null], ["estimate", null]]);
    expect(onCellChange.mock.calls[0]?.[0]).toEqual({
      recordId: "rec-a", recordPath: "tasks/rec-a.md", field: "status", value: null,
    });

    // An empty cell has nothing to clear, and a paused table changes nothing.
    onCellChange.mockClear();
    view.rerender(table({ records: [makeRecord("rec-a", [indexedValue("tags", [])])] }));
    press("Delete");
    for (let step = 0; step < 3; step += 1) press("ArrowRight");
    press("Delete");
    view.rerender(table({ editingDisabled: true }));
    press("Delete");
    press("Enter");
    press("x");
    expect(onCellChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
  });

  it("opens the selected row's record with Ctrl+Enter or ⌘+Enter, and toggles a checkbox with Enter or Space", () => {
    const onOpenRecord = vi.fn((_record: CollectionRecord) => {});
    const { press, selectDone, onCellChange } = setup({ onOpenRecord });
    selectDone(1);
    expect(press("Enter", { ctrlKey: true })).toBe(false);
    press("Enter", { metaKey: true });
    expect(onOpenRecord.mock.calls.map(([record]) => record.id)).toEqual(["rec-b", "rec-b"]);
    expect(onCellChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cell-editor]")).toBeNull();

    press("Enter");
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith({
      recordId: "rec-b", recordPath: "tasks/rec-b.md", field: "done", value: true,
    });
    expect(press(" ")).toBe(false);
    expect(onCellChange).toHaveBeenCalledTimes(2);

    // On any other cell Space changes nothing, and never scrolls the table.
    press("ArrowLeft");
    expect(press(" ")).toBe(false);
    expect(onCellChange).toHaveBeenCalledTimes(2);
    expect(onOpenRecord).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
  });

  it("keeps a number editor that cannot save open, even when another cell is clicked", () => {
    const { cell, selection, editorInput, onCellChange, grid, press } = setup();
    fireEvent.click(cell(0, 1));
    const input = editorInput()!;
    fireEvent.change(input, { target: { value: "twelve" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("This value is not a number. Enter a number.");
    expect(editorInput()).toBe(input);
    expect(selection()).toEqual([0, 1]);

    act(() => grid.focus());
    fireEvent.click(cell(2, 0));
    expect(editorInput()).toBe(input);
    expect(input.value).toBe("twelve");
    expect(document.activeElement).toBe(input);
    expect(selection()).toEqual([0, 1]);
    expect(onCellChange).not.toHaveBeenCalled();

    // Escape still cancels, from the input or from the grid.
    act(() => grid.focus());
    press("Escape");
    expect(editorInput()).toBeNull();
    expect(selection()).toEqual([0, 1]);
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("saves once when a click away blurs the editor, and leaves focus where the click put it", () => {
    const { cell, selection, editorInput, onCellChange, grid } = setup();
    fireEvent.click(cell(0, 0));
    const input = editorInput()!;
    fireEvent.change(input, { target: { value: "Renamed" } });
    act(() => input.blur());
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ field: "title", value: "Renamed" }));
    expect(editorInput()).toBeNull();
    expect(selection()).toEqual([0, 0]);
    expect(document.activeElement).not.toBe(grid);
  });

  it("keeps the selection on its record through a refresh that reorders rows, without remounting cells", () => {
    const { view, table, cell, press, selectDone, selection, grid } = setup();
    selectDone(1);
    const rowB = cell(1, 0).firstElementChild;
    press("ArrowLeft");
    press("ArrowLeft");
    // Moving the selection redraws the ring. The cells stay the same nodes.
    expect(cell(1, 0).firstElementChild).toBe(rowB);
    expect(selection()).toEqual([1, 0]);

    view.rerender(table({ records: taskRecords(["c", "a", "b"]) }));
    expect(selection()).toEqual([2, 0]);
    expect(cell(2, 0).textContent).toBe("Task b");
    // A record that leaves takes the selection with it.
    view.rerender(table({ records: taskRecords(["c", "a"]) }));
    expect(selection()).toBeNull();
    expect(grid.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("keeps an open edit through a refresh that moves its row and a scroll past it", () => {
    const onCellChange = vi.fn((_change: CollectionCellChange) => 1);
    const table = (records: CollectionRecord[]) => (
      <TableView schema={makeSchema([{ name: "title", type: "text" }])} records={records} onCellChange={onCellChange} />
    );
    const view = render(table(makeRecords(200)));
    fireEvent.click(screen.getByRole("button", { name: "Task 3" }));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Draft" } });

    view.rerender(table(makeRecords(200).reverse()));
    const element = scroller(view.container);
    element.scrollTop = 100 * 32;
    fireEvent.scroll(element);
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toBe("Draft");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recordId: "rec-3", value: "Draft" }));
  });

  it("shows the host's names for fields and records, while keys drive edits and sort", () => {
    const names: Record<string, string> = { "f-1": "Name", "f-2": "Shipped", "f-3": "Mark paid" };
    const idSchema = makeSchema([
      { name: "f-1", type: "text" },
      { name: "f-2", type: "checkbox" },
      { name: "f-3", type: "button" },
    ]);
    const onCellChange = vi.fn((_change: CollectionCellChange) => 1);
    const onSortChange = vi.fn();
    render(
      <TableView
        schema={idSchema}
        records={[makeRecord("rec-1", [indexedValue("f-1", "Invoice 12"), indexedValue("f-2", false)])]}
        fieldLabel={(field) => names[field] ?? field}
        recordName={(record) => `Invoice for ${record.id}`}
        onCellChange={onCellChange}
        onSortChange={onSortChange}
        onOpenRecord={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["", "Name", "Shipped", "Mark paid"]);
    expect(screen.queryByText(/^f-\d$/)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Shipped" })).toBeDefined();
    // The button cell's fallback text is the name too: once in the header, once in the cell.
    expect(screen.getAllByText("Mark paid")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open Invoice for rec-1" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSortChange).toHaveBeenCalledExactlyOnceWith([{ field: "f-1", direction: "asc" }]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shipped" }));
    fireEvent.click(screen.getByRole("button", { name: "Invoice 12" }));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Invoice 13" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellChange.mock.calls.map(([change]) => [change.field, change.value])).toEqual([
      ["f-2", true],
      ["f-1", "Invoice 13"],
    ]);
  });
});
