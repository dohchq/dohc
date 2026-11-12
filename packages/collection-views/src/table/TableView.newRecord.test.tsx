// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSchema, CollectionValue } from "@dohc/workspace-contracts";
import { TableView, type TableNewRecord, type TableUnsavedRow, type TableViewProps } from "./TableView";
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

// Column order: title 0, estimate 1, done 2, status 3.
const FIELDS: CollectionSchema["fields"] = [
  { name: "title", type: "text" },
  { name: "estimate", type: "number" },
  { name: "done", type: "checkbox" },
  { name: "status", type: "select", options: ["todo", "doing"] },
];
const schema = makeSchema(FIELDS);
const records = (ids = ["a", "b"]) => ids.map((id) => makeRecord(`rec-${id}`, [indexedValue("title", `Task ${id}`), indexedValue("estimate", 3)]));

type Values = Record<string, CollectionValue>;
type Stop = { field: string; reason: string };

/**
 * A host that takes new records. `saves` holds what it took, in order. A
 * save it takes never answers the table again: the save is the host's.
 * `stops` answers a value that stops a save, before anything is taken.
 */
function host(extra: Partial<TableNewRecord> = {}, stops: (values: Values) => Stop | undefined = () => undefined) {
  const saves: Values[] = [];
  let table: { start(): void; shows(recordId: string): boolean } | null = null;
  const unsaved = vi.fn<(row: TableUnsavedRow) => string | void>();
  const newRecord: TableNewRecord = {
    save: (values) => {
      const stop = stops({ ...values });
      if (stop) return stop;
      saves.push({ ...values });
    },
    bind: (handle) => {
      table = handle;
      return () => {
        table = null;
      };
    },
    onUnsaved: unsaved,
    ...extra,
  };
  return { newRecord, saves, unsaved, start: () => act(() => table?.start()), shows: (recordId: string) => table?.shows(recordId) };
}

function setup(props: Partial<TableViewProps> = {}, extra: Partial<TableNewRecord> = {}, stops?: (values: Values) => Stop | undefined) {
  const made = host(extra, stops);
  const onNewRecord = vi.fn();
  const onCellChange = vi.fn(() => 1);
  const all: TableViewProps = { schema, records: records(), onCellChange, onOpenRecord: vi.fn(), onNewRecord, newRecord: made.newRecord, ...props };
  const view = render(<TableView {...all} />);
  return { ...made, ...view, onNewRecord, onCellChange, again: (next: Partial<TableViewProps>) => view.rerender(<TableView {...all} {...next} />) };
}

const grid = () => screen.getByRole("grid");
const newRows = () => [...document.querySelectorAll<HTMLElement>("[data-new-record]")];
const newRow = () => {
  const [row] = newRows();
  if (!row) throw new Error("no new row");
  return row;
};
/** The new row's field cells, without the gutter that holds Discard. */
const cells = () => within(newRow()).getAllByRole("gridcell").slice(1);
const selected = () => screen.getAllByRole("gridcell").find((cell) => cell.getAttribute("aria-selected") === "true") ?? null;
const editorInput = () => {
  const input = document.querySelector<HTMLInputElement>("[data-cell-editor] input");
  if (!input) throw new Error("no open editor");
  return input;
};
const addRow = () => screen.getByRole("button", { name: "New record" });
const key = (name: string, extra: Parameters<typeof fireEvent.keyDown>[1] = {}) => fireEvent.keyDown(grid(), { key: name, ...extra });
/** Types into the open editor and leaves it with a key. */
function type(text: string, leave: "Enter" | "Tab" | "Escape") {
  const input = editorInput();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: leave });
}
/** A press as the pointer makes it: down, which takes focus from an input elsewhere, then the click. */
function press(element: Element) {
  fireEvent.pointerDown(element);
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement && !element.contains(focused)) act(() => focused.blur());
  fireEvent.pointerUp(element);
  fireEvent.click(element);
}
/** A press outside the table, on something that takes focus from an open editor. */
function pressOutside() {
  const outside = document.body.appendChild(document.createElement("button"));
  press(outside);
  outside.remove();
}

describe("a new record's row", () => {
  it("adds one empty row above the New record row, in view, with the cursor in its first field", () => {
    const { onNewRecord, saves } = setup();
    press(addRow());

    const rows = screen.getAllByRole("row");
    // The header, two records, the new row, then the New record row.
    expect(rows).toHaveLength(5);
    expect(rows[3]).toBe(newRow());
    expect(within(rows[4]!).getByRole("button", { name: "New record" })).toBeDefined();
    expect(cells().map((cell) => cell.textContent)).toEqual(["", "", "", ""]);
    expect(selected()).toBe(cells()[0]);
    expect(document.activeElement).toBe(editorInput());
    // Below the two records, under the header: the grid scrolled to the row's end.
    expect(grid().scrollTop).toBe(2 * 32 + 32 + 32);
    expect(grid().getAttribute("aria-rowcount")).toBe("5");
    expect(onNewRecord).not.toHaveBeenCalled();
    expect(saves).toHaveLength(0);
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("starts from the host's own control, in an empty table too", () => {
    const { start } = setup({ records: [] });
    start();
    expect(newRows()).toHaveLength(1);
    expect(document.activeElement).toBe(editorInput());
  });

  it("works as a row does: Tab, Shift+Tab, arrows, typing to replace, Delete, and Space on a checkbox", () => {
    const { saves, onCellChange } = setup();
    press(addRow());
    type("Milk", "Tab");
    expect(cells()[0]!.textContent).toBe("Milk");
    expect(selected()).toBe(cells()[1]);
    expect(document.activeElement).toBe(grid());

    // A typed character opens the editor on it.
    key("5");
    expect(editorInput().value).toBe("5");
    type("58", "Tab");
    expect(cells()[1]!.textContent).toBe("58");
    expect(selected()).toBe(cells()[2]);

    key(" ");
    expect(within(cells()[2]!).getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
    key("ArrowLeft");
    expect(selected()).toBe(cells()[1]);
    key("Delete");
    expect(cells()[1]!.textContent).toBe("");
    key("Tab", { shiftKey: true });
    expect(selected()).toBe(cells()[0]);
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    expect(selected()).toBe(cells()[3]);

    // A select opens its picker with F2, and the pick stays in the row.
    key("F2");
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-cell-editor]")!).getByText("doing"));
    expect(cells()[3]!.textContent).toBe("doing");

    // Typing replaces what the cell holds.
    key("ArrowLeft");
    key("ArrowLeft");
    key("ArrowLeft");
    key("B");
    type("Bread", "Tab");
    expect(cells()[0]!.textContent).toBe("Bread");
    // The row holds what was typed. Nothing reached the host, and no record changed.
    expect(saves).toHaveLength(0);
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("takes three records typed with no pause: each Enter hands its row to the host and the next key lands in a fresh row", () => {
    // The host takes each save and answers nothing more, as a save that is still out.
    const { saves } = setup();
    press(addRow());
    for (const name of ["One", "Two", "Three"]) {
      fireEvent.change(editorInput(), { target: { value: name } });
      fireEvent.keyDown(editorInput(), { key: "Enter" });
      // The row left the table as the host took it. A fresh row has the cursor, with its first field's editor open and focused.
      expect(newRows()).toHaveLength(1);
      expect(cells().map((cell) => cell.textContent)).toEqual(["", "", "", ""]);
      expect(selected()).toBe(cells()[0]);
      expect(document.activeElement).toBe(editorInput());
      expect(editorInput().value).toBe("");
      // No row shows a save.
      expect(document.querySelector("[data-new-record-status]")).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
    }
    expect(saves).toEqual([{ title: "One" }, { title: "Two" }, { title: "Three" }]);
  });

  it("keeps a row whose save a value stops, sends nothing for it, and goes on typing in it", () => {
    // Every record after the first needs an estimate.
    const { saves } = setup({}, {}, (values) => (values.title !== "One" && values.estimate === undefined ? { field: "estimate", reason: "Enter estimate." } : undefined));
    press(addRow());
    type("One", "Enter");
    type("Two", "Enter");
    // The host took nothing for the second. Its row stays with what was typed, and the cursor is on the cell that says why.
    expect(saves).toEqual([{ title: "One" }]);
    expect(newRows()).toHaveLength(1);
    expect(cells()[0]!.textContent).toBe("Two");
    expect(selected()).toBe(cells()[1]);
    expect(cells()[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("note").textContent).toBe("Enter estimate.");
    // Typing goes on in the row: the next key opens the cell that stopped the save.
    key("5");
    expect(editorInput().value).toBe("5");
    type("5", "Enter");
    expect(saves).toEqual([{ title: "One" }, { title: "Two", estimate: 5 }]);
    expect(screen.queryByRole("note")).toBeNull();
    // The third follows in a fresh row.
    type("Three", "Tab");
    key("7");
    type("7", "Enter");
    expect(saves).toEqual([{ title: "One" }, { title: "Two", estimate: 5 }, { title: "Three", estimate: 7 }]);
    expect(cells().map((cell) => cell.textContent)).toEqual(["", "", "", ""]);
  });

  it.each([
    ["a press on another row", () => press(screen.getByText("Task a"))],
    ["a press on a header, which sorts", () => press(screen.getByRole("button", { name: /estimate/ }))],
    ["a press outside the table", () => press(document.body)],
    ["Tab past its last cell", () => { key("ArrowRight"); key("ArrowRight"); key("Tab"); }],
    ["Escape with no editor open", () => key("Escape")],
    ["the arrow up", () => key("ArrowUp")],
  ])("saves the row once when it is left by %s, and starts no new row", (_way, leave) => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    leave();
    expect(saves).toEqual([{ title: "Milk" }]);
    // The row is the host's now: it is gone, and nothing makes a second record of it.
    expect(newRows()).toHaveLength(0);
    press(document.body);
    key("Enter");
    expect(saves).toHaveLength(1);
  });

  it("saves the text of an editor still open when a press leaves the row", () => {
    const { saves } = setup();
    press(addRow());
    fireEvent.change(editorInput(), { target: { value: "Milk" } });
    pressOutside();
    expect(saves).toEqual([{ title: "Milk" }]);
    expect(newRows()).toHaveLength(0);
  });

  it("saves the row once when the table closes, with the text of an editor still open", async () => {
    const { saves, unmount } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    fireEvent.change(editorInput(), { target: { value: "58" } });
    unmount();
    await Promise.resolve();
    expect(saves).toEqual([{ title: "Milk", estimate: 58 }]);
  });

  it("makes one record of a row saved with Enter, whatever happens to the table after", async () => {
    const { saves, unmount } = setup();
    press(addRow());
    type("Milk", "Enter");
    // The fresh row holds nothing, so closing the table saves nothing more.
    unmount();
    await Promise.resolve();
    expect(saves).toEqual([{ title: "Milk" }]);
  });

  it.each([
    ["Escape", () => { fireEvent.keyDown(editorInput(), { key: "Escape" }); key("Escape"); }],
    ["a press away", () => press(screen.getByText("Task a"))],
    ["the table closing", () => undefined],
  ])("removes a row with nothing typed in it on %s, and makes no record", async (_way, leave) => {
    const { saves, unmount } = setup();
    press(addRow());
    leave();
    if (_way === "the table closing") unmount();
    await Promise.resolve();
    expect(newRows()).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });

  it("cancels only the open edit on Escape, and removes the row and what it holds with Discard", () => {
    const { saves } = setup();
    press(addRow());
    // An empty row offers no Discard.
    expect(screen.queryByRole("button", { name: "Discard new record" })).toBeNull();
    type("Milk", "Tab");
    key("5");
    type("58", "Escape");
    expect(newRows()).toHaveLength(1);
    expect(cells().map((cell) => cell.textContent)).toEqual(["Milk", "", "", ""]);
    expect(saves).toHaveLength(0);

    // By the keyboard alone: back from the first cell is Discard, and Tab comes back to the cell.
    key("ArrowLeft");
    key("Tab", { shiftKey: true });
    const discard = screen.getByRole("button", { name: "Discard new record" });
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(discard, { key: "Tab" });
    expect(selected()).toBe(cells()[0]);
    expect(document.activeElement).toBe(grid());
    key("ArrowLeft");
    expect(document.activeElement).toBe(discard);

    fireEvent.click(discard);
    expect(newRows()).toHaveLength(0);
    expect(document.activeElement).toBe(grid());
    press(document.body);
    expect(saves).toHaveLength(0);
  });

  it("moves the cursor to a value that stops the save, and says why on that cell", () => {
    const { saves } = setup({}, {}, (values) => (values.estimate === undefined ? { field: "estimate", reason: "Enter estimate." } : undefined));
    press(addRow());
    type("Milk", "Enter");

    expect(saves).toHaveLength(0);
    expect(selected()).toBe(cells()[1]);
    expect(cells()[1]!.getAttribute("aria-invalid")).toBe("true");
    const note = screen.getByRole("note");
    expect(note.textContent).toBe("Enter estimate.");
    expect(cells()[1]!.getAttribute("aria-describedby")).toBe(note.id);
    expect(cells()[0]!.textContent).toBe("Milk");

    // A press on another row leaves the cursor on that cell: the row is not saved and not left.
    press(screen.getByText("Task a"));
    expect(selected()).toBe(cells()[1]);
    expect(saves).toHaveLength(0);
    // A value in the cell takes the words away.
    key("5");
    type("5", "Tab");
    expect(cells()[1]!.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("hands the host a row that a value stops when the table closes, and creates nothing", async () => {
    const { saves, unsaved, unmount } = setup({}, {}, (values) => (values.estimate === undefined ? { field: "estimate", reason: "Enter estimate." } : undefined));
    press(addRow());
    type("Milk", "Tab");
    unmount();
    await Promise.resolve();
    // No row is left to say why, so the host keeps what the row held, with what stopped it.
    expect(saves).toHaveLength(0);
    expect(unsaved.mock.calls).toEqual([[{ values: { title: "Milk" }, stopped: { field: "estimate", reason: "Enter estimate." }, why: "closed" }]]);
  });

  it("keeps one new row: New record moves the cursor to the row that is open", () => {
    const { saves, start } = setup();
    press(addRow());
    type("Milk", "Tab");
    expect(selected()).toBe(cells()[1]);

    press(addRow());
    expect(newRows()).toHaveLength(1);
    expect(selected()).toBe(cells()[0]);
    expect(editorInput().value).toBe("Milk");
    fireEvent.keyDown(editorInput(), { key: "Tab" });

    start();
    expect(newRows()).toHaveLength(1);
    expect(document.activeElement).toBe(editorInput());
    expect(saves).toHaveLength(0);
  });

  it("keeps the row, its values and an open edit through a refresh and a sort", () => {
    const { again, saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    const input = editorInput();
    fireEvent.change(input, { target: { value: "58" } });

    // A refresh gives new records, and a sort gives them in another order.
    again({ records: records() });
    again({ records: records(["b", "c", "a"]), sort: [{ field: "title", direction: "desc" }] });

    expect(screen.getAllByRole("row").at(-2)).toBe(newRow());
    expect(cells()[0]!.textContent).toBe("Milk");
    expect(editorInput()).toBe(input);
    expect(input.value).toBe("58");
    expect(document.activeElement).toBe(input);
    expect(saves).toHaveLength(0);
  });

  it("gives the host a value whose field went away, and keeps the rest", () => {
    const { again, unsaved } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    type("5", "Tab");

    again({ schema: makeSchema([FIELDS[0]!, FIELDS[2]!, { name: "status", type: "select", options: ["todo"] }]) });
    expect(unsaved.mock.calls).toEqual([[{ values: { estimate: 5 }, why: "field" }]]);
    expect(cells().map((cell) => cell.textContent)).toEqual(["Milk", "", ""]);
  });

  it("gives back a value whose field stops taking one, says so on the row, and keeps the rest", () => {
    const first = host();
    const view = render(<TableView schema={schema} records={records()} onCellChange={vi.fn(() => 1)} onOpenRecord={vi.fn()} newRecord={first.newRecord} />);
    press(addRow());
    type("Milk", "Tab");
    key("5");
    type("5", "Tab");
    // The host builds its contract again: a new record no longer takes an estimate, though the table still shows the column.
    const next = host({ canEdit: (field) => field.name !== "estimate" });
    next.unsaved.mockReturnValue("A new record no longer takes estimate. dohc kept 5 in a notice.");
    view.rerender(<TableView schema={schema} records={records()} onCellChange={vi.fn(() => 1)} onOpenRecord={vi.fn()} newRecord={next.newRecord} />);
    expect(next.unsaved.mock.calls).toEqual([[{ values: { estimate: 5 }, why: "field" }]]);
    expect(cells().map((cell) => cell.textContent)).toEqual(["Milk", "", "", ""]);
    expect(screen.getByRole("note").textContent).toContain("A new record no longer takes estimate. dohc kept 5 in a notice.");
    // The save goes without it, once: nothing was dropped in silence.
    press(cells()[0]!);
    fireEvent.keyDown(editorInput(), { key: "Enter" });
    expect(next.saves).toEqual([{ title: "Milk" }]);
  });

  it("types only in the fields the host takes, and never in a button or a relation", () => {
    const made = host({ canEdit: (field) => field.name !== "title" });
    render(
      <TableView
        schema={makeSchema([...FIELDS, { name: "blocks", type: "relation", collection: "tasks", many: true }, { name: "Run", type: "button" }])}
        records={records()}
        onCellChange={vi.fn(() => 1)}
        relationExecutor={vi.fn()}
        renderButton={() => <button type="button">Run</button>}
        newRecord={made.newRecord}
      />,
    );
    press(addRow());
    // The first field that takes typing is the second: the cursor starts there.
    const fieldCells = within(newRow()).getAllByRole("gridcell");
    expect(selected()).toBe(fieldCells[1]);
    expect(editorInput()).toBeDefined();
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    press(fieldCells[0]!);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    press(fieldCells[4]!);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    // A record that does not exist yet has no button to press.
    expect(within(newRow()).queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("has the host make the record at once where the table has no field to type in", () => {
    const made = host();
    render(<TableView schema={makeSchema([{ name: "Run", type: "button" }])} records={[]} newRecord={made.newRecord} />);
    fireEvent.click(addRow());
    expect(newRows()).toHaveLength(0);
    expect(made.saves).toEqual([{}]);
  });

  it("builds no column again and remounts no row, and typing draws no other row", () => {
    const renderButton = vi.fn(() => <button type="button">Run</button>);
    const made = host();
    render(
      <TableView
        schema={makeSchema([...FIELDS, { name: "Run", type: "button" }])}
        records={records()}
        onCellChange={vi.fn(() => 1)}
        renderButton={renderButton}
        newRecord={made.newRecord}
      />,
    );
    const row = screen.getByText("Task a").closest("[role='row']");
    const cell = screen.getByText("Task a").closest("button");
    press(addRow());
    // A column built again would draw each of its cells as a new element.
    expect(screen.getByText("Task a").closest("[role='row']")).toBe(row);
    expect(screen.getByText("Task a").closest("button")).toBe(cell);

    const drawn = renderButton.mock.calls.length;
    fireEvent.change(editorInput(), { target: { value: "Milk" } });
    fireEvent.change(editorInput(), { target: { value: "Milk and bread" } });
    expect(renderButton.mock.calls.length).toBe(drawn);
  });

  it("removes the row and gives the host its values to save when the host stops taking new records", () => {
    const { again, saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    again({ newRecord: undefined, onNewRecord: undefined });
    expect(newRows()).toHaveLength(0);
    expect(saves).toEqual([{ title: "Milk" }]);
  });

  it("creates nothing when the table closes over text its field cannot take, and hands the host all the row held", async () => {
    const { saves, unsaved, unmount } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("a");
    fireEvent.change(editorInput(), { target: { value: "abc" } });
    unmount();
    await Promise.resolve();
    expect(saves).toHaveLength(0);
    expect(unsaved.mock.calls).toEqual([[{ values: { title: "Milk" }, text: { field: "estimate", text: "abc" }, why: "closed" }]]);
  });

  it("hands the host text its field cannot take when that is all the row holds", async () => {
    const { saves, unsaved, again } = setup();
    press(addRow());
    fireEvent.keyDown(editorInput(), { key: "Tab" });
    key("a");
    fireEvent.change(editorInput(), { target: { value: "abc" } });
    // The host stops taking new records, as when a share's access ends.
    again({ newRecord: undefined, onNewRecord: undefined });
    await Promise.resolve();
    expect(saves).toHaveLength(0);
    expect(unsaved.mock.calls).toEqual([[{ values: {}, text: { field: "estimate", text: "abc" }, why: "closed" }]]);
  });

  it("saves the row on Enter with no editor open: a checkbox is not ticked, and a picker is not opened again", () => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    // On the checkbox, Space ticks it, and Enter saves the row.
    key("ArrowRight");
    key(" ");
    key(" ");
    key("Enter");
    expect(saves).toEqual([{ title: "Milk" }]);
    // Enter started the next row, whose box is not ticked.
    expect(within(cells()[2]!).getByRole<HTMLInputElement>("checkbox").checked).toBe(false);

    // On a select, F2 opens the picker. Once an option is picked, Enter saves the row.
    type("Bread", "Tab");
    key("ArrowRight");
    key("ArrowRight");
    key("F2");
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-cell-editor]")!).getByText("doing"));
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    key("Enter");
    expect(saves).toEqual([{ title: "Milk" }, { title: "Bread", status: "doing" }]);
    // The next row is empty: Escape closes its editor, and Enter on it saves nothing.
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    key("Enter");
    expect(saves).toHaveLength(2);
    expect(newRows()).toHaveLength(0);
  });

  it("answers the host whether a record's row is among the rows on screen", () => {
    const many = records(Array.from({ length: 60 }, (_, index) => String(index)));
    const { shows } = setup({ records: many });
    // The first rows are on screen. One loaded far below is not, and neither is one the table does not hold.
    expect(shows("rec-0")).toBe(true);
    expect(shows("rec-59")).toBe(false);
    expect(shows("rec-elsewhere")).toBe(false);
  });

  it("starts with each field's default, sends what the cells show, and counts untouched defaults as nothing typed", () => {
    const { saves } = setup({}, { defaults: { status: "todo", done: true } });
    press(addRow());
    // The defaults show as values of the row.
    expect(cells()[3]!.textContent).toBe("todo");
    expect(within(cells()[2]!).getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
    // A row that holds only its defaults is nothing typed: it goes, and makes no record.
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    key("Escape");
    expect(newRows()).toHaveLength(0);
    expect(saves).toHaveLength(0);

    // What is sent is what the cells show, defaults included. The next row starts from the defaults again.
    press(addRow());
    type("Milk", "Enter");
    expect(saves).toEqual([{ title: "Milk", status: "todo", done: true }]);
    expect(cells()[3]!.textContent).toBe("todo");

    // A cleared default is sent as an explicit empty value, and an unticked one as unticked.
    type("Bread", "Tab");
    key("ArrowRight");
    key(" ");
    key("ArrowRight");
    key("Delete");
    expect(cells()[3]!.textContent).toBe("");
    key("Enter");
    expect(saves[1]).toEqual({ title: "Bread", status: null, done: false });

    // Clearing a default is something typed: leaving the row saves it.
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    key("Delete");
    press(document.body);
    expect(saves[2]).toEqual({ status: null, done: true });
  });

  it("counts a field the person typed in as typed, whatever value it holds: text that equals the default makes a record", () => {
    const { saves } = setup({}, { defaults: { title: "Draft", status: "todo" } });
    press(addRow());
    // The editor opens on the default. Leaving it untouched is nothing typed.
    expect(editorInput().value).toBe("Draft");
    pressOutside();
    expect(newRows()).toHaveLength(0);
    expect(saves).toHaveLength(0);

    // The person types the title, and it comes to the same text as the default. That is their title.
    press(addRow());
    fireEvent.change(editorInput(), { target: { value: "Draf" } });
    fireEvent.change(editorInput(), { target: { value: "Draft" } });
    fireEvent.keyDown(editorInput(), { key: "Tab" });
    press(document.body);
    expect(saves).toEqual([{ title: "Draft", status: "todo" }]);

    // A default the person cleared and then chose again was set by them too.
    press(addRow());
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowRight");
    key("Delete");
    key("F2");
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-cell-editor]")!).getByText("todo"));
    expect(cells()[3]!.textContent).toBe("todo");
    press(document.body);
    expect(saves).toEqual([{ title: "Draft", status: "todo" }, { title: "Draft", status: "todo" }]);
  });
});
