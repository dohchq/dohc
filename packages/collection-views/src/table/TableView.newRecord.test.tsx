// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSchema, CollectionValue } from "@dohc/workspace-contracts";
import { TableView, type TableNewRecord, type TableNewRecordStatus, type TableViewProps } from "./TableView";
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

type Save = { values: Record<string, CollectionValue>; report: (status: TableNewRecordStatus) => boolean };

/** A host that takes new records: what it was asked to save, and the table's own way to start the row. */
function host(extra: Partial<TableNewRecord> = {}) {
  const saves: Save[] = [];
  let start: (() => void) | null = null;
  const dropped = vi.fn();
  const newRecord: TableNewRecord = {
    save: (values, report) => {
      saves.push({ values: { ...values }, report });
    },
    bind: (starts) => {
      start = starts;
      return () => {
        start = null;
      };
    },
    onValueDropped: dropped,
    ...extra,
  };
  return { newRecord, saves, dropped, start: () => act(() => start?.()) };
}

function setup(props: Partial<TableViewProps> = {}) {
  const made = host();
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

    // A select opens its picker, and the pick stays in the row.
    key("Enter");
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

  it("saves the record with everything typed on Enter, then starts the next row", () => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    type("5", "Enter");

    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk", estimate: 5 }]);
    // The row waits for the host with what was typed, and takes no typing.
    expect(newRow().querySelector("[data-new-record-status='pending']")).not.toBeNull();
    expect(cells()[0]!.textContent).toBe("Milk");
    key("x");
    expect(document.querySelector("[data-cell-editor]")).toBeNull();

    act(() => void saves[0]!.report({ state: "saved" }));
    expect(newRows()).toHaveLength(1);
    expect(cells().map((cell) => cell.textContent)).toEqual(["", "", "", ""]);
    expect(selected()).toBe(cells()[0]);
    expect(document.activeElement).toBe(editorInput());
    expect(editorInput().value).toBe("");
    expect(saves).toHaveLength(1);
  });

  it("does not start another row when the cursor moved on before the record saved", () => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Enter");
    press(screen.getByText("Task a"));
    act(() => void saves[0]!.report({ state: "saved" }));
    expect(newRows()).toHaveLength(0);
    expect(selected()?.textContent).toBe("Task a");
  });

  it.each([
    ["a press on another row", () => press(screen.getByText("Task a"))],
    ["a press on a header, which sorts", () => press(screen.getByRole("button", { name: /estimate/ }))],
    ["a press outside the table", () => press(document.body)],
    ["Tab past its last cell", () => { key("ArrowRight"); key("ArrowRight"); key("Tab"); }],
    ["Escape with no editor open", () => key("Escape")],
    ["the arrow up", () => key("ArrowUp")],
  ])("saves the row when it is left by %s", (_way, leave) => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    leave();
    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk" }]);
    // Leaving again while the host has the row sends nothing more.
    press(document.body);
    expect(saves).toHaveLength(1);
  });

  it("saves the text of an editor still open when a press leaves the row", () => {
    const { saves } = setup();
    press(addRow());
    fireEvent.change(editorInput(), { target: { value: "Milk" } });
    const outside = document.body.appendChild(document.createElement("button"));
    press(outside);
    outside.remove();
    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk" }]);
  });

  it("saves the row when the table closes, with the text of an editor still open", async () => {
    const { saves, unmount } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    fireEvent.change(editorInput(), { target: { value: "58" } });
    unmount();
    await Promise.resolve();
    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk", estimate: 58 }]);
    // The row is gone, so the host reports the outcome its own way.
    expect(saves[0]!.report({ state: "refused", reason: "No." })).toBe(false);
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

  it("keeps the row and what was typed when the host cannot save it, with why, Try again and Discard", () => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Enter");
    act(() => void saves[0]!.report({ state: "refused", reason: "dohc could not create this record." }));

    const note = screen.getByRole("note");
    expect(note.textContent).toContain("dohc could not create this record.");
    expect(newRow().getAttribute("aria-describedby")).toBe(note.id);
    expect(cells()[0]!.textContent).toBe("Milk");
    // Nothing shows as saved, and leaving the row as it is sends nothing more.
    expect(newRow().querySelector("[data-new-record-status]")).toBeNull();
    press(screen.getByText("Task a"));
    expect(saves).toHaveLength(1);

    // Tab on the row's last cell reaches Try again, then Discard.
    press(cells()[3]!);
    fireEvent.keyDown(document.querySelector("[data-cell-editor] input, [data-cell-editor] [tabindex]") ?? grid(), { key: "Escape" });
    key("Tab");
    const again = within(note).getByRole("button", { name: "Try again" });
    expect(document.activeElement).toBe(again);
    fireEvent.keyDown(again, { key: "Tab" });
    expect(document.activeElement).toBe(within(note).getByRole("button", { name: "Discard" }));

    fireEvent.click(again);
    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk" }, { title: "Milk" }]);
    expect(screen.queryByRole("note")).toBeNull();
    // The second try is with the host: Try again is gone, so nothing sends it twice.
    press(document.body);
    expect(saves).toHaveLength(2);

    act(() => void saves[1]!.report({ state: "refused", reason: "No." }));
    fireEvent.click(within(screen.getByRole("note")).getByRole("button", { name: "Discard" }));
    expect(newRows()).toHaveLength(0);
    expect(saves).toHaveLength(2);
  });

  it("saves a refused row again once it changed, when it is left", () => {
    const { saves } = setup();
    press(addRow());
    type("Milk", "Enter");
    act(() => void saves[0]!.report({ state: "refused", reason: "No." }));
    press(cells()[0]!);
    type("Bread", "Tab");
    press(document.body);
    expect(saves.map((save) => save.values)).toEqual([{ title: "Milk" }, { title: "Bread" }]);
  });

  it("leaves a save the host could not confirm to the host's own Try again and Discard", () => {
    const { saves } = setup();
    const retry = vi.fn(), discard = vi.fn();
    press(addRow());
    type("Milk", "Enter");
    act(() => void saves[0]!.report({ state: "unconfirmed", reason: "dohc could not confirm the new record.", retry, discard }));

    const note = screen.getByRole("note");
    expect(note.getAttribute("data-new-record-status")).toBe("unconfirmed");
    // The row takes no typing while its save may have happened.
    press(cells()[0]!);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    fireEvent.click(within(note).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard new record" }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(newRows()).toHaveLength(0);
    expect(saves).toHaveLength(1);
  });

  it("moves the cursor to a value that stops the save, and says why on that cell", () => {
    const made = host({
      save: (_values, report) => void report({ state: "invalid", field: "estimate", reason: "Enter estimate." }),
    });
    render(<TableView schema={schema} records={records()} onCellChange={vi.fn(() => 1)} onOpenRecord={vi.fn()} newRecord={made.newRecord} />);
    press(addRow());
    type("Milk", "Enter");

    expect(selected()).toBe(cells()[1]);
    expect(cells()[1]!.getAttribute("aria-invalid")).toBe("true");
    const note = screen.getByRole("note");
    expect(note.textContent).toBe("Enter estimate.");
    expect(cells()[1]!.getAttribute("aria-describedby")).toBe(note.id);
    expect(cells()[0]!.textContent).toBe("Milk");

    // A press on another row leaves the cursor on that cell: the row is not saved and not left.
    press(screen.getByText("Task a"));
    expect(selected()).toBe(cells()[1]);
    // A value in the cell takes the words away.
    key("5");
    type("5", "Tab");
    expect(cells()[1]!.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
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
    const { again, dropped } = setup();
    press(addRow());
    type("Milk", "Tab");
    key("5");
    type("5", "Tab");

    again({ schema: makeSchema([FIELDS[0]!, FIELDS[2]!, { name: "status", type: "select", options: ["todo"] }]) });
    expect(dropped.mock.calls).toEqual([["estimate", 5]]);
    expect(cells().map((cell) => cell.textContent)).toEqual(["Milk", "", ""]);
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

  it("removes the row and gives the host its values when the host stops taking new records", () => {
    const { again, dropped, saves } = setup();
    press(addRow());
    type("Milk", "Tab");
    again({ newRecord: undefined, onNewRecord: undefined });
    expect(newRows()).toHaveLength(0);
    expect(dropped.mock.calls).toEqual([["title", "Milk"]]);
    expect(saves).toHaveLength(0);
  });
});
