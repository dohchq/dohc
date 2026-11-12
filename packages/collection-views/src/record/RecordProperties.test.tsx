// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionRecord } from "@dohc/workspace-contracts";
import { CellStatusNote, RecordProperties, type RecordPropertiesProps } from "./RecordProperties";
import type { CollectionCellChange, TableCellStatus, TableCellStatuses, TableHostCell } from "../table/TableView";
import { indexedValue, makeRecord, makeSchema } from "../testSupport";

afterEach(cleanup);

const schema = makeSchema([
  { name: "title", type: "text" },
  { name: "estimate", type: "number" },
  { name: "done", type: "checkbox" },
  { name: "due", type: "date" },
  { name: "status", type: "select", options: ["todo", "doing"] },
  { name: "tags", type: "multi-select", options: ["alpha", "beta", "gamma"] },
  { name: "owner", type: "person" },
  { name: "link", type: "url" },
  { name: "notes", type: "text" },
]);
const record = (id = "rec-a", title = "Task a"): CollectionRecord => makeRecord(id, [
  indexedValue("title", title),
  indexedValue("estimate", 3),
  indexedValue("done", false),
  indexedValue("due", "2026-11-08"),
  indexedValue("status", "todo"),
  indexedValue("tags", ["alpha"]),
  indexedValue("owner", "user-1"),
  indexedValue("link", "https://example.com"),
  indexedValue("notes", null),
]);

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

function renderProperties(props: Partial<RecordPropertiesProps> = {}) {
  const changes: CollectionCellChange[] = [];
  const onCellChange = (change: CollectionCellChange) => changes.push(change);
  const all: RecordPropertiesProps = { schema, record: record(), onCellChange, ...props };
  const view = render(<RecordProperties {...all} />);
  return { changes, rerender: (next: Partial<RecordPropertiesProps>) => view.rerender(<RecordProperties {...all} {...next} />) };
}

const row = (name: string) => screen.getByRole("group", { name });
/** The control that opens a row's editor. */
const value = (name: string) => within(row(name)).getAllByRole("button")[0]!;
const editor = (name: string) => row(name).querySelector<HTMLElement>("[data-cell-editor]");
const openEditor = (name: string) => {
  fireEvent.click(value(name));
  return editor(name)!;
};

describe("a record's properties", () => {
  it("shows one row per field in the schema's order, named through fieldLabel, with each value as its cell draws it", () => {
    renderProperties({ omitFields: ["title"], fieldLabel: (field) => (field === "due" ? "Due date" : field), personLabel: (id) => (id === "user-1" ? "Ada" : null) });
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("data-property"))).toEqual(["estimate", "done", "due", "status", "tags", "owner", "link", "notes"]);
    expect(screen.queryByRole("group", { name: "title" })).toBeNull();
    expect(row("Due date").textContent).toContain("Nov 8");
    expect(row("status").textContent).toContain("todo");
    expect(row("tags").textContent).toContain("alpha");
    expect(row("owner").textContent).toContain("Ada");
    expect(within(row("done")).getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
    // An empty value says so, and still opens its editor.
    expect(value("notes").textContent).toBe("Empty");
  });

  it("saves text on Enter, on a press away, and not on Escape, and returns focus to the value", () => {
    const { changes } = renderProperties();
    const input = within(openEditor("title")).getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("Task a");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([{ recordId: "rec-a", recordPath: "tasks/rec-a.md", field: "title", value: "Renamed" }]);
    expect(editor("title")).toBeNull();
    expect(document.activeElement).toBe(value("title"));

    const away = within(openEditor("notes")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(away, { target: { value: "Kept" } });
    fireEvent.blur(away);
    expect(changes[1]).toMatchObject({ field: "notes", value: "Kept" });
    expect(editor("notes")).toBeNull();

    const cancelled = within(openEditor("title")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(cancelled, { target: { value: "Dropped" } });
    fireEvent.keyDown(cancelled, { key: "Escape" });
    expect(editor("title")).toBeNull();
    expect(changes).toHaveLength(2);
    expect(document.activeElement).toBe(value("title"));
  });

  it("keeps a number that does not parse open and says why", () => {
    const { changes } = renderProperties();
    const input = within(openEditor("estimate")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "many" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(editor("estimate")!).getByRole("alert").textContent).toBe("This value is not a number. Enter a number.");
    expect(changes).toEqual([]);
    // The editor holds what it cannot save, so a press on another value comes back to it.
    fireEvent.click(value("title"));
    expect(editor("title")).toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([expect.objectContaining({ field: "estimate", value: 8 })]);
  });

  it("ticks a checkbox, and opens the pickers the table opens for a date, an option and a person", () => {
    const { changes } = renderProperties({ people: [{ id: "user-1", name: "Ada" }, { id: "user-2", name: "Grace" }] });
    fireEvent.click(within(row("done")).getByRole("checkbox"));
    expect(changes.at(-1)).toMatchObject({ field: "done", value: true });

    fireEvent.click(within(openEditor("due")).getByRole("gridcell", { name: "November 9, 2026" }));
    expect(changes.at(-1)).toMatchObject({ field: "due", value: "2026-11-09" });
    expect(editor("due")).toBeNull();

    fireEvent.click(within(within(openEditor("status")).getByRole("listbox", { name: "status options" })).getByRole("option", { name: "doing" }));
    expect(changes.at(-1)).toMatchObject({ field: "status", value: "doing" });

    fireEvent.click(within(within(openEditor("owner")).getByRole("listbox", { name: "People for owner" })).getByRole("option", { name: "Grace" }));
    expect(changes.at(-1)).toMatchObject({ field: "owner", value: "user-2" });
    expect(changes).toHaveLength(4);
  });

  it("saves tags once, when the picker closes on a press away", () => {
    const { changes } = renderProperties();
    const list = within(within(openEditor("tags")).getByRole("listbox", { name: "tags options" }));
    fireEvent.click(list.getByRole("option", { name: "beta" }));
    fireEvent.click(list.getByRole("option", { name: "gamma" }));
    expect(changes).toEqual([]);
    fireEvent.pointerDown(document.body);
    expect(changes).toEqual([expect.objectContaining({ field: "tags", value: ["alpha", "beta", "gamma"] })]);
    expect(editor("tags")).toBeNull();
  });

  it("opens a link from its text and edits it from beside the text", () => {
    const onOpenLink = vi.fn();
    const { changes } = renderProperties({ onOpenLink });
    const link = within(row("link")).getByRole("link");
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("https://example.com");
    expect(editor("link")).toBeNull();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onOpenLink).toHaveBeenCalledTimes(2);
    fireEvent.click(within(row("link")).getByRole("button", { name: "Edit link" }));
    const input = within(editor("link")!).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "https://dohc.example" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([expect.objectContaining({ field: "link", value: "https://dohc.example" })]);
  });

  it("offers no editor and no toggle where canEditCell refuses, or with no onCellChange, and pauses with editingDisabled", () => {
    const view = renderProperties({ canEditCell: (_record, field) => field.name === "title" });
    expect(within(row("title")).getAllByRole("button")).toHaveLength(1);
    for (const name of ["estimate", "due", "status", "tags", "owner", "notes"]) expect(within(row(name)).queryByRole("button")).toBeNull();
    expect(within(row("done")).getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
    fireEvent.click(row("estimate").querySelector("[data-property-value]")!);
    expect(editor("estimate")).toBeNull();

    // An open editor stays, with what it holds, while editing is paused.
    const input = within(openEditor("title")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Held" } });
    view.rerender({ canEditCell: (_record, field) => field.name === "title", editingDisabled: true });
    expect(within(editor("title")!).getByRole<HTMLInputElement>("textbox").value).toBe("Held");
    expect(editor("title")!.matches(":disabled")).toBe(true);
    expect(view.changes).toEqual([]);

    cleanup();
    render(<RecordProperties schema={schema} record={record()} />);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
  });

  it("shows a change the host has not confirmed in each state, with its actions", () => {
    const retry = vi.fn(), discard = vi.fn(), dismiss = vi.fn();
    const { store, set } = statusStore({ "rec-a:title": { state: "pending", value: "Sending" } });
    renderProperties({ cellStatuses: store });
    // The value the person gave shows in place of the stored one, and the editor opens on it.
    expect(value("title").textContent).toBe("Sending");
    expect(row("title").querySelector('[data-cell-status="pending"]')?.textContent).toBe("Saving");
    expect(within(openEditor("title")).getByRole<HTMLInputElement>("textbox").value).toBe("Sending");
    fireEvent.keyDown(within(editor("title")!).getByRole("textbox"), { key: "Escape" });

    set({ "rec-a:title": { state: "waiting", value: "Sending", reason: "Waiting for an earlier change to this record." } });
    expect(within(row("title")).getByRole("note").textContent).toBe("Waiting for an earlier change to this record.");
    expect(within(within(row("title")).getByRole("note")).queryByRole("button")).toBeNull();

    set({ "rec-a:title": { state: "unconfirmed", value: "Sending", reason: "dohc could not confirm this change.", retry, discard } });
    const note = within(within(row("title")).getByRole("note"));
    expect(row("title").querySelector('[data-cell-status="unconfirmed"]')?.textContent).toContain("dohc could not confirm this change.");
    fireEvent.click(note.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    // The note goes with the action, so focus moves to the value first.
    expect(document.activeElement).toBe(value("title"));
    fireEvent.click(note.getByRole("button", { name: "Discard" }));
    expect(discard).toHaveBeenCalledOnce();

    set({ "rec-a:estimate": { state: "refused", value: "many", reason: "Enter a value estimate can take.", dismiss } });
    expect(within(row("title")).queryByRole("note")).toBeNull();
    expect(value("title").textContent).toBe("Task a");
    const refused = within(within(row("estimate")).getByRole("note"));
    expect(row("estimate").textContent).toContain("Enter a value estimate can take.");
    fireEvent.click(refused.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("draws a host's cell and editor, and never opens the shared text editor on one", () => {
    const close = vi.fn();
    const file: TableHostCell = {
      cell: (shown, tabStop) => <button type="button" tabIndex={tabStop ? undefined : -1} className="dohc-row-open-target">File of {shown.id}</button>,
      editor: (shown, done) => <button type="button" onClick={() => { close(shown.id); done(); }}>Choose a file</button>,
    };
    const readOnly: TableHostCell = { cell: () => <span>Related</span> };
    renderProperties({ hostCells: new Map([["notes", file], ["owner", readOnly]]) });
    // The host's control is the row's Tab stop, and the row still says the value is empty.
    const control = within(row("notes")).getByRole("button", { name: "File of rec-a" });
    expect(control.tabIndex).toBe(0);
    expect(row("notes").textContent).toContain("Empty");
    fireEvent.click(control);
    expect(within(editor("notes")!).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(editor("notes")!).getByRole("button", { name: "Choose a file" }));
    expect(close).toHaveBeenCalledExactlyOnceWith("rec-a");
    expect(editor("notes")).toBeNull();
    // A typed character changes a host's value only in the host's editor.
    fireEvent.keyDown(control, { key: "x" });
    expect(editor("notes")).toBeNull();
    // A host cell with no editor opens nothing.
    fireEvent.click(within(row("owner")).getByText("Related"));
    expect(editor("owner")).toBeNull();
  });

  it("is reached and worked by keyboard: each value is a Tab stop, a typed character starts an edit, and Tab saves and moves on", () => {
    const { changes } = renderProperties({ canEditCell: (_record, field) => field.name !== "estimate", onOpenLink: () => undefined });
    // Every control that edits is in the Tab order. A row that cannot change has none.
    expect(value("title").tabIndex).toBe(0);
    expect(within(row("done")).getByRole<HTMLInputElement>("checkbox").tabIndex).toBe(0);
    expect(within(row("link")).getByRole("link").tabIndex).toBe(0);
    expect(within(row("estimate")).queryByRole("button")).toBeNull();

    // A typed character replaces the text and starts the edit.
    fireEvent.keyDown(value("title"), { key: "N" });
    const input = within(editor("title")!).getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("N");
    fireEvent.change(input, { target: { value: "New" } });
    // Tab saves and goes to the next row's value, past the row with nothing to focus.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(changes).toEqual([expect.objectContaining({ field: "title", value: "New" })]);
    expect(editor("title")).toBeNull();
    expect(document.activeElement).toBe(within(row("done")).getByRole("checkbox"));

    // Shift+Tab from an editor goes back.
    const due = openEditor("due");
    fireEvent.keyDown(within(due).getByRole("grid"), { key: "Tab", shiftKey: true });
    expect(editor("due")).toBeNull();
    expect(document.activeElement).toBe(within(row("done")).getByRole("checkbox"));

    // A shortcut and Space are not typing.
    fireEvent.keyDown(value("title"), { key: "a", ctrlKey: true });
    fireEvent.keyDown(value("title"), { key: " " });
    expect(editor("title")).toBeNull();
  });

  it("keeps Escape in an open editor from reaching what holds the properties", () => {
    const onKeyDown = vi.fn();
    render(<div onKeyDown={onKeyDown}><RecordProperties schema={schema} record={record()} onCellChange={() => 0} /></div>);
    fireEvent.keyDown(within(openEditor("title")).getByRole("textbox"), { key: "Escape" });
    expect(editor("title")).toBeNull();
    fireEvent.keyDown(within(openEditor("status")).getByRole("combobox"), { key: "Escape" });
    expect(editor("status")).toBeNull();
    expect(onKeyDown).not.toHaveBeenCalled();
    // With no editor open, Escape is the holder's.
    fireEvent.keyDown(value("title"), { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("keeps what is typed through a new read of the same record, and hands it to the host when the record changes", () => {
    const onDraftAbandoned = vi.fn();
    const view = renderProperties({ onDraftAbandoned });
    const input = within(openEditor("title")).getByRole<HTMLInputElement>("textbox");
    fireEvent.change(input, { target: { value: "Half typed" } });
    view.rerender({ onDraftAbandoned, record: record("rec-a", "Changed elsewhere") });
    expect(within(editor("title")!).getByRole<HTMLInputElement>("textbox")).toBe(input);
    expect(input.value).toBe("Half typed");
    // Another record in the same place has no editor open, and the host keeps the text.
    view.rerender({ onDraftAbandoned, record: record("rec-b", "Task b") });
    expect(editor("title")).toBeNull();
    expect(onDraftAbandoned).toHaveBeenCalledExactlyOnceWith({ recordId: "rec-a", field: "title", text: "Half typed" });
    expect(view.changes).toEqual([]);
  });

  it("starts another record's tags from that record's own value, not from picks saved on the record before it", () => {
    // The host numbers its saves, and its index shows none of them yet.
    const view = renderProperties();
    fireEvent.click(within(within(openEditor("tags")).getByRole("listbox", { name: "tags options" })).getByRole("option", { name: "beta" }));
    fireEvent.pointerDown(document.body);
    expect(view.changes).toEqual([expect.objectContaining({ recordId: "rec-a", field: "tags", value: ["alpha", "beta"] })]);
    // Another record takes the first one's place, with no remount.
    view.rerender({ record: record("rec-b", "Task b") });
    fireEvent.click(within(within(openEditor("tags")).getByRole("listbox", { name: "tags options" })).getByRole("option", { name: "gamma" }));
    fireEvent.pointerDown(document.body);
    expect(view.changes[1]).toMatchObject({ recordId: "rec-b", field: "tags", value: ["alpha", "gamma"] });
    // The first record still starts its next edit from what it saved.
    view.rerender({ record: record() });
    fireEvent.click(within(within(openEditor("tags")).getByRole("listbox", { name: "tags options" })).getByRole("option", { name: "gamma" }));
    fireEvent.pointerDown(document.body);
    expect(view.changes[2]).toMatchObject({ recordId: "rec-a", field: "tags", value: ["alpha", "beta", "gamma"] });
  });

  it("draws a button field through renderButton", () => {
    const fields = makeSchema([{ name: "title", type: "text" }, { name: "stamp", type: "button" }]);
    render(<RecordProperties schema={fields} record={makeRecord("rec-a", [indexedValue("title", "Task a")])} onCellChange={() => 0}
      renderButton={(field, shown) => <button type="button">Run {field.name} on {shown.id}</button>} />);
    fireEvent.click(within(row("stamp")).getByRole("button", { name: "Run stamp on rec-a" }));
    expect(editor("stamp")).toBeNull();
  });
});

describe("one cell's unconfirmed change, outside the properties", () => {
  it("shows nothing, then the change's state and actions", () => {
    const dismiss = vi.fn(), onAct = vi.fn();
    const { store, set } = statusStore();
    const { container } = render(<CellStatusNote statuses={store} recordId="rec-a" field="title" onAct={onAct} />);
    expect(container.textContent).toBe("");
    set({ "rec-a:title": { state: "pending", value: "x" } });
    expect(container.querySelector('[data-cell-status="pending"]')).toBeTruthy();
    set({ "rec-a:title": { state: "refused", value: "", reason: "Enter a name.", dismiss } });
    expect(screen.getByRole("note").textContent).toContain("Enter a name.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAct).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
