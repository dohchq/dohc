// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { TextNotSavedError } from "./shell/copyDetails";
import { describeApprovedDataset, parseDatasetDescription } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { datasetDefinitionFromDrafts } from "./collections/datasetDefinitionFromDrafts";
import { transactionalDescription } from "./transactionalCollectionModel";
import { admitCollectionChanges, closeCollectionChangeShellsForTests, openCollectionChangeShell } from "./collectionChangeShells";
import { collectionWriteFailures, resetCollectionFieldWritesForTests } from "./collections/recordFieldWrites";
import { resetKeptCollectionEditsForTests, TransactionalCollectionPage, type TransactionalDatasetDescription, type TransactionalInvoke } from "./TransactionalCollectionPage";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const name = id(3), amount = id(4), status = id(5), secret = id(6);
const read = id(10), edit = id(11), create = id(12), remove = id(13);
function dataset(): TransactionalDatasetDescription {
  return { datasetId: id(1), name: "Event", revision: 1, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "People", fields: [
    { fieldId: name, name: "Name", type: "text", required: true, unique: false },
    { fieldId: amount, name: "Amount", type: "number", required: false, unique: false },
    { fieldId: status, name: "Status", type: "select", options: ["New", "Reviewed"], required: true, unique: false, default: "New" },
    { fieldId: secret, name: "Private note", type: "text", required: false, unique: false },
  ] }], operations: [
    { operationId: read, name: "list", label: "Read", kind: "read", access: "owner", readOnly: true, tableId: id(2), fieldIds: [name, amount, status] },
    { operationId: edit, name: "edit", label: "Edit", kind: "edit", access: "owner", readOnly: false, reversible: true, tableId: id(2), fieldIds: [name, amount] },
    { operationId: create, name: "create", label: "Create", kind: "create", access: "owner", readOnly: false, tableId: id(2), fieldIds: [name, amount, status] },
    { operationId: remove, name: "delete", label: "Delete", kind: "delete", access: "owner", readOnly: false, tableId: id(2), fieldIds: [] },
  ] };
}
const page = (text = "Alice", next = false): AppBackendJson => ({ rows: [{ id: 1, version: 2, values: { [name]: text, [amount]: 5, [status]: "New", [secret]: "Do not show" } }], nextCursor: next ? { id: 1, value: "Alice" } : null });
/** Two records, so one record's change can wait while the other's goes. */
const twoRecords = (): AppBackendJson => ({ rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: 5, [status]: "New" } }, { id: 2, version: 4, values: { [name]: "Bea", [amount]: 7, [status]: "New" } }], nextCursor: null });
const receipt = (version = 3, record = 1): AppBackendJson => ({ id: record, version, priorValues: { [name]: "Alice" } });
function setup(overrides: Partial<React.ComponentProps<typeof TransactionalCollectionPage>> = {}) {
  const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page() : request.operationId === edit ? receipt() : { id: 1, version: 1 } }));
  const onError = vi.fn(), onNotice = vi.fn();
  const props = { workspaceId: "workspace-A", dataset: dataset(), tableId: id(2), invoke, onError, onNotice, ...overrides };
  // The window shows the page's workspace and main has admitted it, so its changes send, and report to its shell once the page has closed.
  openCollectionChangeShell(props.workspaceId, { onError: props.onError, onSettled: props.onSettled, onNotice: props.onNotice });
  admitCollectionChanges(props.workspaceId);
  return { invoke, onError, onNotice, props, ...render(<TransactionalCollectionPage {...props} />) };
}
/** A command in the page's one actions menu, which this opens when it is closed. */
function command(name: string | RegExp): HTMLElement {
  if (!screen.queryByRole("menu", { name: "Manage Collection", hidden: true })) fireEvent.click(screen.getByRole("button", { name: "Manage Collection", hidden: true }));
  return screen.getByRole("menuitem", { name, hidden: true });
}
/** The names of the commands the open actions menu lists under each section label. */
const commandsBySection = () => within(screen.getByRole("menu", { name: "Manage Collection" })).getAllByRole("group").map(group =>
  [document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent, within(group).getAllByRole("menuitem").map(item => item.textContent)]);
const viewTab = (name: string) => within(screen.getByTestId("collection-view-switcher")).getByRole<HTMLButtonElement>("button", { name });
/** The tabs, without the open tab's menu button. */
const viewTabs = () => within(screen.getByTestId("collection-view-switcher")).getAllByRole("button").filter(tab => tab.hasAttribute("aria-pressed"));
type Invoke = { mock: { calls: Array<[TransactionalInvoke, ...unknown[]]> } };
const sent = (invoke: Invoke, operationId: string) => invoke.mock.calls.map(([request]) => request).filter(request => request.operationId === operationId);

// The table's virtualizer reads offsetWidth and offsetHeight, which jsdom reports as 0, so every element
// gets a nonzero box and the rows render (CollectionPage.test.tsx precedent).
const offsetDescriptors = { offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"), offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth") };
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
});
afterEach(async () => {
  cleanup();
  // A table that closes hands a new row it still holds to its queue, a moment after it closes. That is taken before the queues are cleared.
  await Promise.resolve();
  resetKeptCollectionEditsForTests();
  // The list of unsaved Collection changes outlives a page, and a test.
  resetCollectionFieldWritesForTests();
  for (const [key, descriptor] of Object.entries(offsetDescriptors)) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
});

// The shared table, as a person finds its parts.
const grid = () => screen.getByRole("grid");
const badge = id(9);
/** The same Collection with a field its create needs and its table cannot show, so a new record opens in the panel. */
function needingPanel(description: TransactionalDatasetDescription): TransactionalDatasetDescription {
  description.tables[0]!.fields.push({ fieldId: badge, name: "Badge", type: "text", required: true, unique: false });
  description.operations.find(operation => operation.operationId === create)?.fieldIds.push(badge);
  return description;
}
/** The table's new row. */
const newRow = () => document.querySelector<HTMLElement>("[data-new-record]");
/** The new row's field cells, after the cell that holds Discard. */
const newRowCells = () => within(newRow()!).getAllByRole("gridcell").slice(1);
/** What the new row says of a save that did not happen. */
const newRowNote = () => document.querySelector<HTMLElement>("[data-new-record-status]:not([data-new-record-status='pending'])");
const cellEditor = (root: ParentNode = document) => root.querySelector<HTMLInputElement>("[data-cell-editor] input")!;
/** Starts the table's new row, types in its first field, and leaves that field with a key. */
function typeNewRow(text: string, leave: "Enter" | "Tab" = "Enter", root: HTMLElement = document.body): void {
  fireEvent.click(within(within(root).getByRole("grid")).getByRole("button", { name: "New record" }));
  fireEvent.change(cellEditor(root), { target: { value: text } });
  fireEvent.keyDown(cellEditor(root), { key: leave });
}
/** The panel of a record that does not exist yet. */
const draftPanel = () => screen.getByRole("complementary", { name: "New record" });
const noDraftPanel = () => screen.queryByRole("complementary", { name: "New record" }) === null;
const draftField = (field: string) => within(draftPanel()).getByRole("group", { name: field });
/** What a field of the new record shows. */
const draftValue = (field: string) => draftField(field).querySelector("[data-property-value]")!.textContent;
/** Types a value into a field of the new record in the panel, and saves the field with Enter. */
function typeDraft(field: string, text: string): void {
  fireEvent.click(within(draftField(field)).getAllByRole("button")[0]!);
  const input = cellEditor(draftField(field));
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}
/** The cell of the record in row `row` under the column named `field`. */
function cell(field: string, row = 0): HTMLElement {
  const column = within(grid()).getAllByRole("columnheader").findIndex(header => header.textContent === field);
  const found = column < 0 ? undefined : grid().querySelectorAll<HTMLElement>(`[role="row"][data-index="${row}"] [role="gridcell"]`)[column];
  if (!found) throw new Error(`no ${field} cell in row ${row}`);
  return found;
}
const editor = () => grid().querySelector<HTMLElement>("[data-cell-editor]");
const editorInput = () => editor()!.querySelector<HTMLInputElement>("input")!;
/** Opens a cell's editor, types a value, and saves with Enter. */
function type(field: string, value: string, row = 0): void {
  fireEvent.click(cell(field, row));
  const input = editorInput();
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}
/** What a cell says about a change its host has not confirmed, or null. */
const mark = (field: string, row = 0) => cell(field, row).querySelector("[data-cell-status]")?.getAttribute("data-cell-status") ?? null;
const why = (field: string, row = 0) => cell(field, row).querySelector("[data-cell-status]")?.getAttribute("title") ?? null;
const press = (key: string) => fireEvent.keyDown(grid(), { key });
/** The page's own controls work once a full read of records ends. */
const loaded = () => waitFor(() => expect(screen.getByRole("region", { name: "People" }).getAttribute("aria-busy")).toBe("false"));
/** The record panel. A test that gives the page a ⚡ panel names the one it means. */
const panel = () => screen.getByRole("complementary");
/** Opens Alice's record in the panel, as a person does from its row. */
const openPanel = () => { fireEvent.click(screen.getByRole("button", { name: "Open Alice" })); return panel(); };
/** A field's row in the panel. */
const property = (field: string) => within(panel()).getByRole("group", { name: field });
/** The control that opens a panel field's editor. */
const propertyValue = (field: string) => within(property(field)).getAllByRole("button")[0]!;
const propertyEditor = (field: string) => property(field).querySelector<HTMLElement>("[data-cell-editor]");
const propertyInput = (field: string) => propertyEditor(field)!.querySelector<HTMLInputElement>("input")!;
/** What a panel field says about a change its host has not confirmed, or null. */
const propertyMark = (field: string) => property(field).querySelector("[data-cell-status]")?.getAttribute("data-cell-status") ?? null;
/** Opens a panel field's editor, types a value, and saves with Enter. */
function typeInPanel(field: string, value: string): void {
  fireEvent.click(propertyValue(field));
  const input = propertyInput(field);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}
/** The control that opens the record's name for typing. */
const nameButton = () => within(within(panel()).getByRole("heading")).getByRole("button");
/** Opens the record's name in the panel's heading and types into it, without saving. */
function typeName(text: string): void {
  fireEvent.click(nameButton());
  fireEvent.change(within(panel()).getByRole("textbox", { name: "Name" }), { target: { value: text } });
}
const LEFT_OPEN = "This edit was still open, so dohc did not save it.";
/** A command in the panel's menu, which this opens. */
function recordCommand(name: string): HTMLElement {
  fireEvent.click(within(panel()).getByRole("button", { name: "Record actions" }));
  return screen.getByRole("menuitem", { name });
}

it("offers a calendar before the Collection has a date field, and asks for one", async () => {
  const onAddDateField = vi.fn();
  const { props, rerender } = setup({ onAddDateField });
  await screen.findByText("Alice");
  expect(viewTab("Calendar").disabled).toBe(false);
  fireEvent.click(viewTab("Calendar"));
  expect(await screen.findByText("A calendar needs a date field.")).toBeTruthy();
  expect(viewTab("Calendar").getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: /^Date / })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a date field" }));
  expect(onAddDateField).toHaveBeenCalledOnce();

  // Once the Collection has a date field, the calendar uses it.
  const dated = dataset(), visit = id(7);
  dated.revision = 2; dated.revisionSha256 = "b".repeat(64);
  dated.tables[0]!.fields.push({ fieldId: visit, name: "Visit on", type: "date", required: false, unique: false });
  dated.operations.find(operation => operation.operationId === read)!.fieldIds.push(visit);
  rerender(<TransactionalCollectionPage {...props} dataset={dated} />);
  expect(screen.getByRole("button", { name: "Date Visit on" }).title).toBe("Calendar date");
  expect(screen.queryByText("A calendar needs a date field.")).toBeNull();
});

it("asks for a date field without a button for someone who cannot change fields", async () => {
  setup();
  await screen.findByText("Alice");
  fireEvent.click(viewTab("Calendar"));
  expect(await screen.findByText("A calendar needs a date field.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add a date field" })).toBeNull();
});

it.each(["Record ID", "Membership number"])("hides only the generated primary key column (%s)", async primaryName => {
  const definition = datasetDefinitionFromDrafts({ name: "People", schemaPath: "schema.sql", operationsPath: "operations.js",
    fields: [{ name: "Name", type: "text", required: true, unique: false }] });
  const primary = definition.tables[0]!.fields[0]!;
  primary.name = primaryName;
  const userField = definition.tables[0]!.fields[1]!;
  if (primaryName !== "Record ID") userField.name = "Record ID";
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SELECT 1;", operationSource: "globalThis.operations={};" });
  const description = transactionalDescription(parseDatasetDescription(describeApprovedDataset(revision, definition.operations.filter(operation => operation.kind !== "create"))));
  const invoke = vi.fn(async () => ({ result: { rows: [{ id: "generated-uuid", version: 1, values: { [primary.fieldId]: "generated-uuid", [userField.fieldId]: "Alice" } }], nextCursor: null } }));
  setup({ dataset: description, tableId: definition.tables[0]!.tableId, invoke });
  await screen.findByText("Alice");
  const table = grid();
  if (primaryName === "Record ID") {
    expect(within(table).queryByRole("columnheader", { name: /Record ID/ })).toBeNull();
  } else {
    expect(within(table).queryByRole("columnheader", { name: /Membership number/ })).toBeNull();
    expect(within(table).getByRole("columnheader", { name: /Record ID/ })).toBeTruthy();
  }
  expect(within(table).queryByText("generated-uuid")).toBeNull();
  expect(description.operations.find(operation => operation.kind === "read")!.fieldIds).toContain(primary.fieldId);
});

it.each([false, true])("preserves user-supplied text keys in filtered descriptions (create visible: %s)", async createVisible => {
  const definition = datasetDefinitionFromDrafts({ name: "People", schemaPath: "schema.sql", operationsPath: "operations.js",
    fields: [{ name: "Name", type: "text", required: true, unique: false }] });
  const primary = definition.tables[0]!.fields[0]!;
  if (primary.type === "button") throw new Error("Expected a column");
  delete primary.generated;
  primary.name = "Membership number";
  const createOperation = definition.operations.find(operation => operation.kind === "create")!;
  createOperation.fieldIds = [...createOperation.fieldIds, primary.fieldId];
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SELECT 1;", operationSource: "globalThis.operations={};" });
  const operations = definition.operations.filter(operation => createVisible || operation.kind !== "create");
  const description = transactionalDescription(parseDatasetDescription(describeApprovedDataset(revision, operations)));
  const invoke = vi.fn(async () => ({ result: { rows: [{ id: "MEM-42", version: 1, values: { [primary.fieldId]: "MEM-42" } }], nextCursor: null } }));
  setup({ dataset: description, tableId: definition.tables[0]!.tableId, invoke });
  const table = await screen.findByRole("grid");
  expect(within(table).getByRole("columnheader", { name: /Membership number/ })).toBeTruthy();
  expect(await within(table).findByText("MEM-42")).toBeTruthy();
});

it("keeps an empty multi-select editable, with the options picker the document table uses", async () => {
  const description = dataset();
  description.tables[0]!.fields.find(field => field.fieldId === status)!.type = "multi-select";
  description.operations.find(operation => operation.operationId === edit)!.fieldIds.push(status);
  const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [status]: [] } }], nextCursor: null } : receipt() }));
  setup({ dataset: description, invoke });
  await screen.findByText("Alice");
  expect(cell("Status").textContent).toBe("");
  fireEvent.click(cell("Status"));
  fireEvent.click(screen.getByRole("option", { name: "Reviewed" }));
  // A Data Collection's options are part of its approved rules, so the picker offers none to create.
  fireEvent.change(within(editor()!).getByRole("combobox"), { target: { value: "Later" } });
  expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();
  // The picks save once, when the picker closes.
  expect(sent(invoke, edit)).toHaveLength(0);
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
  expect(sent(invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [status]: ["Reviewed"] } });
});

it("names the server that holds an owner's Collection beside its copy on this device", async () => {
  setup({copy:{offline:false,savedAtMs:1,host:"sync.example.test"}}); await screen.findByText("Alice");
  expect(screen.getByText(`On sync.example.test · Saved on this device · ${new Date(1).toLocaleString()}`).getAttribute("role")).toBe("status");
});

it("labels saved-page coverage without implying the entire Collection is downloaded", async () => {
  const copy = {offline:true,savedAtMs:1,coverage:"saved-pages" as const};
  setup({copy}); await screen.findByText("Alice");
  const label = "Offline · Saved pages only";
  expect(screen.getByText(`${label} · ${new Date(1).toLocaleString()}`).getAttribute("role")).toBe("status");
  expect(screen.queryByText(/Offline copy · Read-only|^Saved on this device/)).toBeNull();
});

it("shows offline attachments as unavailable and never asks the host for file bytes", async () => {
  const fileId = "private-file-12345678", attachment = id(40), description = dataset();
  description.tables[0]!.fields.push({fieldId:attachment,name:"Receipt",type:"attachment",required:false,unique:false});
  description.operations.find(operation=>operation.operationId===read)!.fieldIds.push(attachment);
  const readFile=vi.fn();
  const invoke=vi.fn(async()=>({result:{rows:[{id:1,version:2,values:{[name]:"Alice",[attachment]:fileId}}],nextCursor:null}}));
  setup({dataset:description,invoke,readFile,copy:{offline:true,savedAtMs:1}});
  expect(within(await screen.findByRole("grid")).getByText("File available when online")).toBeTruthy();
  expect(screen.queryByText(fileId)).toBeNull();
  expect(within(openPanel()).getByText("File available when online")).toBeTruthy();
  expect(readFile).not.toHaveBeenCalled();
});

describe("a Data Collection's table", () => {
  it("shows only approved fields, and gives a field with no edit operation no way to change it, by click or by key", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: page(request.input && typeof request.input === "object" && "after" in request.input ? "Bob" : "Alice", true) }));
    setup({ invoke });
    await screen.findByText("Alice");
    expect(screen.queryByText("Private note")).toBeNull(); expect(screen.queryByText("Do not show")).toBeNull();
    expect(invoke.mock.calls[0]![0]).toMatchObject({ workspaceId: "workspace-A", datasetId: id(1), operationId: read, input: { limit: 50 }, revision: 1, revisionSha256: "a".repeat(64) });
    // The owner may read Status and has no operation that edits it.
    expect(within(cell("Status")).queryByRole("button")).toBeNull();
    fireEvent.click(cell("Status"));
    expect(cell("Status").getAttribute("aria-selected")).toBe("true");
    for (const key of ["Enter", "R", "Delete", "Backspace", " "]) press(key);
    expect(editor()).toBeNull();
    expect(sent(invoke, edit)).toHaveLength(0);
    // A field with one opens its editor on a click.
    fireEvent.click(cell("Name"));
    expect(editorInput().value).toBe("Alice");
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    // Without the shell's confirmation there is no delete.
    expect(within(openPanel()).queryByRole("button", { name: "Record actions" })).toBeNull();
  });

  it("pages 50 records at a time with Previous and Next, outside the table", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: page(request.input && typeof request.input === "object" && "after" in request.input ? "Bob" : "Alice", true) }));
    setup({ invoke });
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Bob");
    expect(invoke.mock.calls.at(-1)![0].input).toEqual({ limit: 50, after: { id: 1, value: "Alice" } });
    expect(screen.queryByText("Alice")).toBeNull();
    expect(grid().contains(screen.getByRole("button", { name: "Previous" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Previous" })); await screen.findByText("Alice");
  });

  it.each([[false, "1 record"], [true, "1 record on this page"]] as const)("counts the records, and says on this page only when another page exists (next page: %s)", async (next, words) => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page("Alice", next) : { id: 1, version: 1 } }));
    setup({ invoke }); await screen.findByText("Alice");
    // The count sits beside the Collection's name, and nowhere else.
    expect(screen.getByTestId("collection-record-count").textContent).toBe(words);
    expect(screen.getByRole("heading", { level: 1, name: "People" }).closest("header")!.contains(screen.getByTestId("collection-record-count"))).toBe(true);
    expect(screen.queryAllByText(/\brecords?\b/).filter(element => element.closest("footer"))).toEqual([]);
  });

  it("saves a cell with the record's version: Enter saves, Escape cancels, and the keys go back to the table", async () => {
    const { invoke } = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    const input = editorInput();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(cell("Name").textContent).toBe("Alice");
    expect(sent(invoke, edit)).toHaveLength(0);

    type("Name", "Alicia");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    const request = sent(invoke, edit)[0]!;
    expect(request).toMatchObject({ workspaceId: "workspace-A", datasetId: id(1), revision: 1, revisionSha256: "a".repeat(64), input: { id: 1, expectedVersion: 2, values: { [name]: "Alicia" } } });
    expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.activeElement).toBe(grid());
    // There is no Save or Cancel step, and nothing on the page waits.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect((screen.getAllByRole("button", { name: "New record" })[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves a value when a press lands away from its editor, and sends nothing for a value the cell already has", async () => {
    const { invoke } = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    fireEvent.blur(editorInput());
    fireEvent.click(cell("Amount"));
    fireEvent.keyDown(editorInput(), { key: "Enter" });
    expect(sent(invoke, edit)).toHaveLength(0);
    fireEvent.click(cell("Name"));
    fireEvent.change(editorInput(), { target: { value: "Alicia" } });
    fireEvent.blur(editorInput());
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    expect(sent(invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });
  });

  it("shows a change on its cell until a read shows it, and reads once when the changes are all confirmed", async () => {
    let stored = "Alice";
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page(stored) }) : answer.promise);
    const { onNotice } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    // The cell shows what the person gave, marked as not confirmed yet. Nothing says the page is saving or loading.
    expect(cell("Name").textContent).toBe("AliciaSaving");
    expect(mark("Name")).toBe("pending");
    expect(screen.getByRole("region", { name: "People" }).getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByText("Loading records…")).toBeNull();
    stored = "Alicia";
    await act(async () => answer.resolve({ result: receipt() }));
    await waitFor(() => expect(mark("Name")).toBeNull());
    expect(cell("Name").textContent).toBe("Alicia");
    expect(sent(invoke, read)).toHaveLength(2);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("draws only the changed cell when a change's status changes", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: twoRecords() }) : answer.promise);
    // The page draws each Button cell, so the calls count how often the table draws its cells.
    const draw = vi.fn((field: string, row: { id: string | number }) => <button type="button">{`${field} for record ${String(row.id)}`}</button>);
    setup({ invoke, buttons: { fields: ["Mark paid"], render: draw } });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    expect(mark("Name")).toBe("pending");
    const drawn = draw.mock.calls.length;
    await act(async () => answer.reject(new Error("Lost reply")));
    expect(mark("Name")).toBe("unconfirmed");
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    expect(mark("Name")).toBe("pending");
    expect(draw.mock.calls.length).toBe(drawn);
  });

  it("sends a record's changes in the order made, and the second with the version the first's receipt reports", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() })
      : sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt(4) }));
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    // One request is in flight. The second change waits its turn on its cell.
    expect(sent(invoke, edit)).toHaveLength(1);
    expect([mark("Name"), mark("Amount")]).toEqual(["pending", "pending"]);
    const reads = sent(invoke, read).length;
    await act(async () => first.resolve({ result: receipt(7) }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit).map(request => request.input)).toEqual([
      { id: 1, expectedVersion: 2, values: { [name]: "Alicia" } },
      { id: 1, expectedVersion: 7, values: { [amount]: 9 } },
    ]);
    // The queue went on without waiting for a read.
    expect(invoke.mock.calls.findIndex(([request]) => request.operationId === edit && request.input !== sent(invoke, edit)[0]!.input)).toBe(reads + 1);
    await waitFor(() => expect([mark("Name"), mark("Amount")]).toEqual([null, null]));
    expect(sent(invoke, read)).toHaveLength(reads + 1);
  });

  it("waits for a read before a record's next change when a custom edit's receipt reports no version", async () => {
    let version = 2;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: { rows: [{ id: 1, version, values: { [name]: "Alice", [amount]: 5, [status]: "New" } }], nextCursor: null } };
      version++;
      return { result: null };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 3, values: { [amount]: 9 } });
  });

  it("keeps a change dohc could not confirm on its cell with Try again, holds that record's later changes, and lets another record's go", async () => {
    let fail = true;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: twoRecords() };
      if (fail && (request.input as { id: number }).id === 1) throw new Error("Connection ended after commit");
      return { result: receipt(9, (request.input as { id: number }).id) };
    });
    const { onError } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    // The cell keeps what was typed and says so. Nothing presents it as saved.
    expect(cell("Name").textContent).toContain("Alicia");
    expect(why("Name")).toBe("dohc could not confirm this change.");
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
    // The failure also takes a toast and a row in Notices, whose Try again sends the same change.
    expect(onError).toHaveBeenCalledWith("dohc could not confirm this change.", expect.objectContaining({ message: "Connection ended after commit" }), expect.any(Function), expect.any(String));

    // A later change to the same record waits, and says so. The page does not lock.
    type("Amount", "9");
    expect(mark("Amount")).toBe("waiting");
    expect(why("Amount")).toBe("Waiting for an earlier change to this record");
    expect(cell("Amount").textContent).toContain("9");
    expect((screen.getAllByRole("button", { name: "New record" })[0] as HTMLButtonElement).disabled).toBe(false);
    // Another record's change goes through.
    type("Name", "Beatrice", 1);
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 2, expectedVersion: 4, values: { [name]: "Beatrice" } });
    expect(mark("Amount")).toBe("waiting");

    // Try again sends the exact request, with its key. The record's held change follows with the receipt's version.
    fail = false;
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(4));
    const writes = sent(invoke, edit);
    expect(writes[2]).toEqual(writes[0]);
    expect(writes[3]!.input).toEqual({ id: 1, expectedVersion: 9, values: { [amount]: 9 } });
    // The row the failure left in Notices sends nothing once the change has landed.
    await act(async () => onError.mock.calls[0]![2]!());
    expect(sent(invoke, edit)).toHaveLength(4);
  });

  it("keeps a refused change's value on its cell with the reason, and opens the next edit from what was typed", async () => {
    const refusal = Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" });
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw refusal;
    });
    const { onError } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("refused"));
    expect(why("Name")).toBe("The Collection refused this change. This record changed. Refresh the table.");
    expect(cell("Name").textContent).toContain("Alicia");
    expect(onError).toHaveBeenCalledWith("The Collection refused this change.", refusal, null);
    // A refusal is an answer, so nothing offers to send it again.
    expect(within(cell("Name")).queryByRole("button", { name: "Try again" })).toBeNull();
    // The record is read again, so the person sees what it holds now.
    await waitFor(() => expect(sent(invoke, read)).toHaveLength(2));
    fireEvent.click(cell("Name"));
    expect(editorInput().value).toBe("Alicia");
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    // The selected cell says why under it, for the keyboard and a screen reader.
    expect(screen.getByRole("note").textContent).toBe("The Collection refused this change. This record changed. Refresh the table.Dismiss");
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Dismiss" }));
    expect(mark("Name")).toBeNull();
    expect(cell("Name").textContent).toBe("Alice");
  });

  it("does not send a value its field can't take, and says what to enter on the cell", async () => {
    const { invoke } = setup();
    await screen.findByText("Alice");
    type("Name", "");
    expect(mark("Name")).toBe("refused");
    expect(why("Name")).toBe("Enter Name.");
    expect(sent(invoke, edit)).toHaveLength(0);
    // The same value again takes the cell back to what the record holds.
    type("Name", "Alice");
    expect(mark("Name")).toBeNull();
    expect(sent(invoke, edit)).toHaveLength(0);
  });

  it("keeps an open editor's text through a read of the records", async () => {
    const { invoke, props, rerender } = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    const input = editorInput();
    fireEvent.change(input, { target: { value: "Alic" } });
    invoke.mockResolvedValueOnce({ result: page("Changed by an automation") });
    rerender(<TransactionalCollectionPage {...props} recordsChanged={1} />);
    await waitFor(() => expect(sent(invoke, read)).toHaveLength(2));
    await screen.findByText("Changed by an automation");
    expect(editorInput()).toBe(input);
    expect(input.value).toBe("Alic");
    expect(document.activeElement).toBe(input);
  });

  it("keeps a queued change while the Collection is offline, says so on its cell, and sends it once it is back", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: twoRecords() })
      : sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt(5, 2) }));
    const { props, rerender } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Name", "Beatrice", 1);
    expect(sent(invoke, edit)).toHaveLength(1);
    rerender(<TransactionalCollectionPage {...props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(mark("Name", 1)).toBe("waiting");
    expect(why("Name", 1)).toBe("Waiting for the Collection to come back online");
    // An offline copy takes no edit: no editor opens, and nothing is sent.
    fireEvent.click(cell("Amount"));
    expect(editor()).toBeNull();
    await act(async () => first.resolve({ result: receipt() }));
    expect(sent(invoke, edit)).toHaveLength(1);
    rerender(<TransactionalCollectionPage {...props} copy={{ offline: false, savedAtMs: 2 }} />);
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 2, expectedVersion: 4, values: { [name]: "Beatrice" } });
  });

  it("keeps changes not sent or not confirmed when its page closes and opens again", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    let fail = true;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return Promise.resolve({ result: twoRecords() });
      if ((request.input as { id: number }).id === 2) return first.promise;
      return fail ? Promise.reject(new Error("Lost reply")) : Promise.resolve({ result: receipt() });
    });
    const view = setup({ invoke });
    await screen.findByText("Alice");
    // Record 2's change is in flight, and record 1's waits behind it, unsent.
    type("Name", "Beatrice", 1);
    type("Name", "Alicia");
    expect(sent(invoke, edit)).toHaveLength(1);
    // Another file opens in the tab group, then the Collection opens again.
    view.unmount();
    render(<TransactionalCollectionPage {...view.props} />);
    await screen.findByText("Alicia");
    expect(cell("Name", 1).textContent).toContain("Beatrice");
    expect([mark("Name", 1), mark("Name")]).toEqual(["pending", "pending"]);
    expect(cell("Name").textContent).toContain("Alicia");
    // The request in flight ended in the open page, which shows it, so no notice says it saved.
    await act(async () => first.resolve({ result: receipt(5, 2) }));
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    expect(view.onNotice).not.toHaveBeenCalled();
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });

    // A change dohc could not confirm is kept too, with its exact request.
    cleanup();
    render(<TransactionalCollectionPage {...view.props} />);
    await screen.findByText("Bea");
    expect(mark("Name")).toBe("unconfirmed");
    expect(cell("Name").textContent).toContain("Alicia");
    fail = false;
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(3));
    expect(sent(invoke, edit)[2]).toEqual(sent(invoke, edit)[1]);
    await waitFor(() => expect(mark("Name")).toBeNull());
  });

  it("tells the person which Collection a change saved in when its page stays closed", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page() }) : answer.promise);
    const result = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    result.unmount();
    await act(async () => answer.resolve({ result: receipt() }));
    expect(result.onNotice).toHaveBeenCalledOnce();
    expect(result.onNotice).toHaveBeenCalledWith("Saved the edit in People");
    // The change went out once, and the closed page read nothing more.
    expect(sent(invoke, edit)).toHaveLength(1);
    expect(sent(invoke, read)).toHaveLength(1);
  });

  it.each([
    [new Error("Lost reply"), "dohc could not confirm the change to People. Open it to check its records."],
    [Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" }), "People refused the change. Open it to check its records."],
  ])("reports a change that fails after its page closed, naming the Collection (%s)", async (failure, words) => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page() }) : answer.promise);
    const result = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    result.unmount();
    await act(async () => answer.reject(failure));
    // A change dohc could not confirm keeps a Try again on its row in Notices. A refusal is an answer, so it has none.
    expect(result.onError).toHaveBeenCalledOnce();
    expect(result.onError.mock.calls[0]).toEqual(failure.message === "Lost reply" ? [words, failure, expect.any(Function), expect.any(String)] : [words, failure, null]);
    expect(result.onNotice).not.toHaveBeenCalled();
    // The page opens again with what was typed on its cell, and never as saved.
    render(<TransactionalCollectionPage {...result.props} />);
    await screen.findByText("Alicia");
    expect(mark("Name")).toBe(failure.message === "Lost reply" ? "unconfirmed" : "refused");
  });

  it("reports a completed old change to its own workspace, and shows nothing of it in the next one", async () => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.workspaceId) }) : pending.promise);
    const { props, rerender, onNotice, onError } = setup({ invoke });
    await screen.findByText("workspace-A");
    type("Name", "changed");
    const nextNotice = vi.fn();
    openCollectionChangeShell("workspace-B", { onError: vi.fn(), onNotice: nextNotice });
    rerender(<TransactionalCollectionPage {...props} workspaceId="workspace-B" />); await screen.findByText("workspace-B");
    expect(mark("Name")).toBeNull();
    await act(async () => { pending.resolve({ result: { id: 1, version: 3, priorValues: { [name]: "workspace-A" } } }); });
    // The notice goes to its own workspace's shell, and never to the next one's.
    expect(onNotice).toHaveBeenCalledWith("Saved the edit in People"); expect(nextNotice).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
    expect(cell("Name").textContent).toBe("workspace-B");
    expect(sent(invoke, read)).toHaveLength(2);
  });

  it("reverses the last edit from its receipt's prior values and version", async () => {
    const { invoke } = setup();
    await screen.findByText("Alice");
    type("Name", "Alicia");
    fireEvent.click(await screen.findByRole("button", { name: "Undo last edit" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 3, values: { [name]: "Alice" } });
    // A reversal is not itself reversed.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull());
  });

  const receipts: AppBackendJson[] = [null, {}, { id: 1, version: 3 }, { id: 1, version: 3, priorValues: "invalid" }];
  it.each(receipts)("accepts a committed custom edit without usable undo metadata: %j", async result => {
    const invoke = vi.fn(async (request: TransactionalInvoke) => ({ result: request.operationId === read ? page() : result }));
    const view = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(sent(invoke, read)).toHaveLength(2));
    await waitFor(() => expect(mark("Name")).toBeNull());
    expect(view.onNotice).not.toHaveBeenCalled();
    expect(view.onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Changes dohc did not confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });

  it("keeps search, sort, cursor history and undo when records refresh", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page("Alice", true) : receipt() }));
    const result = setup({ invoke, recordsVersion: 1 }); await screen.findByText("Alice");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ali" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(invoke.mock.calls.at(-1)![0].input).toMatchObject({ search: "Ali" }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: /Amount/ }).getAttribute("aria-sort")).toBe("ascending"));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false));
    type("Name", "Alicia");
    await screen.findByRole("button", { name: "Undo last edit" });
    await waitFor(() => expect(mark("Name")).toBeNull());
    const count = invoke.mock.calls.length;
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={{ ...dataset(), name: "Updated title" }} recordsVersion={2} />);
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(count));
    expect(invoke.mock.calls.at(-1)![0].input).toEqual({ limit: 50, search: "Ali", sort: { fieldId: amount, direction: "asc" }, after: { id: 1, value: "Alice" } });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Ali");
    expect(screen.getByRole("button", { name: "Undo last edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false);
  });

  it("sorts by one field from its header, and clears the sort on the third press", async () => {
    const { invoke } = setup();
    await screen.findByText("Alice");
    const sorts = () => (invoke.mock.calls.at(-1)![0].input as { sort?: unknown }).sort;
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(sorts()).toEqual({ fieldId: amount, direction: "asc" }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(sorts()).toEqual({ fieldId: amount, direction: "desc" }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(invoke.mock.calls).toHaveLength(4));
    expect(sorts()).toBeUndefined();
  });

  it("gives a field it can't sort by a header with no sort control", async () => {
    const description = dataset();
    description.tables[0]!.fields.find(field => field.fieldId === status)!.type = "multi-select";
    const invoke = vi.fn(async () => ({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [status]: ["New"] } }], nextCursor: null } }));
    setup({ dataset: description, invoke });
    await screen.findByText("Alice");
    expect(screen.getByRole("button", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Status" })).toBeNull();
    expect(within(grid()).getAllByRole("columnheader").map(header => header.textContent)).toEqual(["", "Name", "Amount", "Status"]);
  });

  it("keeps creation outside the actions menu, runs a command and closes, and returns focus to its button on Escape", async () => {
    const onReviewSchema = vi.fn(); const onCustomize = vi.fn(); setup({onReviewSchema, onCustomize}); await screen.findByText("Alice");
    const manage = screen.getByRole("button", { name: "Manage Collection" });
    expect(manage.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(manage);
    const menu = screen.getByRole("menu", { name: "Manage Collection" });
    expect(within(menu).queryByRole("menuitem", { name: "New record" })).toBeNull();
    expect(menu.contains(screen.getAllByRole("button", { name: "New record"})[0]!)).toBe(false);
    fireEvent.click(command("Fields and names")); expect(onReviewSchema).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(command("Customize…")); expect(onCustomize).toHaveBeenCalledOnce();
    const fields = command("Fields and names");
    fields.focus(); fireEvent.keyDown(fields,{key:"Escape"});
    expect(screen.queryByRole("menu")).toBeNull(); await waitFor(() => expect(document.activeElement).toBe(manage));
  });
  it("lists every command the page was given under View and Collection, and none it was not", async () => {
    const description = dataset(); description.operations.find(operation => operation.operationId === create)!.access = "link";
    const handlers = { onReviewSchema: vi.fn(), onRefresh: vi.fn(), onCustomize: vi.fn(), onCreateForm: vi.fn(), onManageAccess: vi.fn(), onTransferCsv: vi.fn(), onHistory: vi.fn(),
      onPendingResponses: vi.fn(), onExportRecovery: vi.fn(), onOpenSource: vi.fn(), onArchive: vi.fn() };
    const onToggle = vi.fn(), manage = vi.fn();
    const full = setup({ dataset: description, ...handlers, automations: { open: false, count: 2, onToggle, close: vi.fn() },
      views: { list: [], busy: false, select: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), setField: vi.fn(), edit: vi.fn(), manage } });
    await screen.findByText("Alice");
    command("Refresh");
    expect(commandsBySection()).toEqual([
      ["View", ["Fields and names", "Views", "Refresh"]],
      ["Collection", ["Automations2", "Customize…", "Create form", "Manage access", "Import or export CSV", "History", "Pending responses", "Export recovery", "Open source", "Archive"]],
    ]);
    const runs: Array<[string | RegExp, () => void]> = [["Fields and names", handlers.onReviewSchema], ["Views", manage], ["Refresh", handlers.onRefresh], [/^Automations/, onToggle], ["Customize…", handlers.onCustomize],
      ["Create form", handlers.onCreateForm], ["Manage access", handlers.onManageAccess], ["Import or export CSV", handlers.onTransferCsv], ["History", handlers.onHistory],
      ["Pending responses", handlers.onPendingResponses], ["Export recovery", handlers.onExportRecovery], ["Open source", handlers.onOpenSource], ["Archive", handlers.onArchive]];
    for (const [name, handler] of runs) { fireEvent.click(command(name)); expect(handler, String(name)).toHaveBeenCalledOnce(); }
    full.unmount();
    // A page given nothing still reads its records again, and offers nothing else.
    setup(); await screen.findByText("Alice");
    command("Refresh");
    expect(commandsBySection()).toEqual([["View", ["Refresh"]]]);
  });
  it("holds the commands that need records after a read failed and says to refresh first, and Refresh reads again", async () => {
    const description = dataset(); description.operations.find(operation => operation.operationId === create)!.access = "link";
    const handlers = { onReviewSchema: vi.fn(), onTransferCsv: vi.fn(), onCreateForm: vi.fn(), onHistory: vi.fn() };
    const invoke = vi.fn<(request: TransactionalInvoke) => Promise<{ result: AppBackendJson }>>().mockRejectedValueOnce(new Error("The worker stopped.")).mockResolvedValue({ result: page() });
    setup({ dataset: description, invoke, ...handlers });
    await screen.findByText("dohc could not load People.");
    for (const name of ["Fields and names", "Import or export CSV", "Create form"]) {
      const row = command(name);
      expect(row.getAttribute("aria-disabled"), name).toBe("true");
      expect(document.getElementById(row.getAttribute("aria-describedby")!)!.textContent, name).toBe("dohc could not load the records. Refresh first.");
      fireEvent.click(row);
    }
    expect(handlers.onReviewSchema).not.toHaveBeenCalled(); expect(handlers.onTransferCsv).not.toHaveBeenCalled(); expect(handlers.onCreateForm).not.toHaveBeenCalled();
    // What needs no records still runs, and Refresh is what the reason names.
    expect(command("History").getAttribute("aria-disabled")).toBeNull();
    expect(command("Refresh").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(command("Refresh"));
    await screen.findByText("Alice");
    expect(command("Fields and names").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(command("Fields and names")); expect(handlers.onReviewSchema).toHaveBeenCalledOnce();
  });
  it("holds the menu's commands while a new record is open in the panel and says why, except what needs no records", async () => {
    const handlers = { onReviewSchema: vi.fn(), onOpenSource: vi.fn(), onArchive: vi.fn() };
    const onToggle = vi.fn();
    setup({ ...handlers, dataset: needingPanel(dataset()), automations: { open: false, count: 0, onToggle, close: vi.fn() } }); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    for (const name of ["Fields and names", "Refresh", "Archive"]) {
      const row = command(name);
      expect(row.getAttribute("aria-disabled"), name).toBe("true");
      expect(document.getElementById(row.getAttribute("aria-describedby")!)!.textContent, name).toBe("Create or cancel the new record first.");
      fireEvent.click(row);
    }
    expect(handlers.onReviewSchema).not.toHaveBeenCalled(); expect(handlers.onArchive).not.toHaveBeenCalled();
    // The tabs and the search wait too, as the dropdowns and the search did.
    expect(viewTabs().every(tab => (tab as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Search collection").disabled).toBe(true);
    expect(command("Open source").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(command("Open source")); expect(handlers.onOpenSource).toHaveBeenCalledOnce();
    fireEvent.click(command("Automations")); expect(onToggle).toHaveBeenCalledOnce();
  });
  const pendingView = { viewId: id(30), name: "Pending", kind: "table" as const, search: "", filters: [], sort: null };
  const statusBoard = { viewId: id(31), name: "By status", kind: "board" as const, search: "", filters: [], sort: null, groupBy: status };
  const savedViews = () => ({ list: [pendingView, statusBoard], busy: false, select: vi.fn(), create: vi.fn(async () => null), rename: vi.fn(async () => null), remove: vi.fn(), setField: vi.fn(), edit: vi.fn(), manage: vi.fn() });
  it("shows All records and each saved view as tabs to someone who can save views, and opens the one pressed", async () => {
    const views = savedViews();
    const result = setup({ views }); await screen.findByText("Alice");
    expect(viewTabs().map(tab => [tab.textContent, tab.getAttribute("aria-pressed")])).toEqual([["All records", "true"], ["Pending", "false"], ["By status", "false"]]);
    // All records is every record as a table. It is not a saved view, so it has no menu.
    expect(screen.queryByRole("button", { name: "View actions" })).toBeNull();
    fireEvent.contextMenu(viewTab("All records"));
    expect(screen.queryByRole("menu")).toBeNull();
    // A view's layout is the view's: no dropdown chooses a saved view or a layout.
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(viewTab("Pending"));
    expect(views.select).toHaveBeenLastCalledWith(id(30));
    result.rerender(<TransactionalCollectionPage {...result.props} activeView={pendingView} />);
    await screen.findByText("Alice");
    expect(viewTab("Pending").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(viewTab("All records"));
    expect(views.select).toHaveBeenLastCalledWith(null);
  });
  it("adds a view from +, and renames, edits and deletes the open one from its tab's menu", async () => {
    const views = savedViews(), onAddDateField = vi.fn();
    setup({ views, activeView: pendingView, onAddDateField }); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Add a view" }));
    const popover = within(screen.getByRole("dialog", { name: "Add a view" }));
    fireEvent.click(popover.getByRole("radio", { name: "Board" }));
    // A board groups by a field the table can sort.
    expect(within(popover.getByLabelText("Group by")).getAllByRole("option").map(option => option.textContent)).toEqual(["Name", "Amount", "Status"]);
    fireEvent.change(popover.getByLabelText("Group by"), { target: { value: status } });
    fireEvent.click(popover.getByRole("button", { name: "Create view" }));
    await waitFor(() => expect(views.create).toHaveBeenCalledExactlyOnceWith({ name: "Board", kind: "board", groupBy: status }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a view" })).toBeNull());
    // The table has no date field, so a calendar asks for one the existing way.
    fireEvent.click(screen.getByRole("button", { name: "Add a view" }));
    fireEvent.click(screen.getByRole("radio", { name: "Calendar" }));
    expect(screen.getByText("This Collection has no date field.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a date field" }));
    expect(onAddDateField).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add a view" }), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Rename", "Edit view…", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit view…" }));
    expect(views.edit).toHaveBeenCalledExactlyOnceWith(id(30));
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const rename = within(screen.getByRole("dialog", { name: "Rename Pending" }));
    expect(rename.getByLabelText<HTMLInputElement>("Name").maxLength).toBe(100);
    fireEvent.change(rename.getByLabelText("Name"), { target: { value: "Waiting" } });
    fireEvent.click(rename.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(views.rename).toHaveBeenCalledExactlyOnceWith(id(30), "Waiting"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A deleted view comes back from its notice's Undo, so Delete asks nothing.
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(views.remove).toHaveBeenCalledExactlyOnceWith(id(30));
  });
  it("holds the tabs and their controls while the views file is read or written", async () => {
    setup({ views: { ...savedViews(), busy: true }, activeView: pendingView }); await screen.findByText("Alice");
    expect(viewTabs().every(tab => (tab as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add a view" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "View actions" }).disabled).toBe(true);
    const row = command("Views");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(row.getAttribute("aria-describedby")!)!.textContent).toBe("dohc is reading the saved views.");
  });
  it("keeps saved filters when sorting and resets paging when switching views",async()=>{
    const activeView={viewId:id(30),name:"Pending",kind:"table" as const,search:"Alice",filters:[{fieldId:status,value:"New"}],sort:{fieldId:name,direction:"asc" as const}};
    const result=setup({activeView});await screen.findByText("Alice");
    expect(result.invoke.mock.calls[0]![0].input).toMatchObject({search:"Alice",filters:[{fieldId:status,value:"New"}],sort:{fieldId:name,direction:"asc"}});
    // The header shows the view's sort.
    expect(screen.getByRole("columnheader",{name:/Name/}).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button",{name:"Amount"}));await waitFor(()=>expect(result.invoke.mock.calls.at(-1)![0].input).toMatchObject({filters:activeView.filters,sort:{fieldId:amount,direction:"asc"}}));
    result.rerender(<TransactionalCollectionPage {...result.props} activeView={{...activeView,viewId:id(31),search:"Bob"}}/>);
    await waitFor(()=>expect(result.invoke.mock.calls.at(-1)![0].input).toMatchObject({search:"Bob",sort:activeView.sort}));expect(result.invoke.mock.calls.at(-1)![0].input).not.toHaveProperty("after");
  });
});

describe("a Data Collection's files and relations", () => {
  const receiptField = id(40), team = id(41);
  function withResources(): TransactionalDatasetDescription {
    const description = dataset();
    description.tables[0]!.fields.push({ fieldId: receiptField, name: "Receipt", type: "attachment", required: false, unique: false },
      { fieldId: team, name: "Team", type: "relation", required: false, unique: false, relation: { datasetId: id(1), tableId: id(50), fieldId: id(51), many: false } });
    for (const operation of description.operations) if (operation.operationId === read || operation.operationId === edit) operation.fieldIds.push(receiptField, team);
    return description;
  }
  const stored = (version = 2): AppBackendJson => ({ rows: [{ id: 1, version, values: { [name]: "Alice", [receiptField]: "1234567890abcdef", [team]: 7 } }], nextCursor: null });

  it("never opens the table's text editor on a file or a relation, and saves each from its own editor", async () => {
    const uploadFile = vi.fn(async () => ({ fileId: "fedcba0987654321", name: "new.txt", byteLength: 3, contentType: "text/plain", sha256: "b".repeat(64) }));
    const resolveRelation = vi.fn(async () => ({ options: [{ value: 7, label: "Blue team" }, { value: 8, label: "Red team" }], hasMore: false }));
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? stored(sent(invoke, edit).length + 2) : { id: 1, version: sent(invoke, edit).length + 2 } }));
    setup({ dataset: withResources(), invoke, uploadFile, readFile: vi.fn(), resolveRelation });
    await screen.findByText("Alice");
    // A typed character and Delete start nothing on either cell.
    fireEvent.click(cell("Amount"));
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    press("ArrowRight");
    for (const field of ["Receipt", "Team"]) {
      press("ArrowRight");
      expect(cell(field).getAttribute("aria-selected")).toBe("true");
      press("x"); press("Delete");
      expect(editor()).toBeNull();
    }
    expect(sent(invoke, edit)).toHaveLength(0);

    // A relation opens the search of its related table. A press on a record changes only the editor, and Save sends it.
    press("Enter");
    expect(within(editor()!).queryByRole("textbox")).toBeNull();
    expect(within(editor()!).getByRole("searchbox", { name: "Search Team" })).toBeTruthy();
    fireEvent.click(await within(editor()!).findByRole("button", { name: "Red team" }));
    expect(sent(invoke, edit)).toHaveLength(0);
    // A press on another cell keeps the editor, and its unsaved value, and goes to Save.
    fireEvent.click(cell("Name"));
    const save = within(editor()!).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(save);
    fireEvent.click(save);
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    expect(sent(invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [team]: 8 } });
    expect(editor()).toBeNull();

    // A file opens its upload. The file is staged on the server, and attached only by Save.
    await waitFor(() => expect(mark("Team")).toBeNull());
    fireEvent.click(within(cell("Receipt")).getByRole("button", { name: "Change Receipt" }));
    expect(within(editor()!).queryByRole("textbox")).toBeNull();
    fireEvent.change(within(editor()!).getByLabelText("Receipt"), { target: { files: [new File(["abc"], "new.txt", { type: "text/plain" })] } });
    await within(editor()!).findByText("new.txt · 3 bytes · Save to attach");
    expect(sent(invoke, edit)).toHaveLength(1);
    fireEvent.click(within(editor()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 3, values: { [receiptField]: "fedcba0987654321" } });
  });

  it("downloads a file from its cell through the table's read action, and leaves the record as it was on Cancel", async () => {
    const readFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["readFile"]>>(async () => { throw new Error("offline"); });
    const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: stored() }));
    const { onError } = setup({ dataset: withResources(), invoke, uploadFile: vi.fn(), readFile, resolveRelation: vi.fn(async () => ({ options: [], hasMore: false })) });
    await screen.findByText("Alice");
    fireEvent.click(within(cell("Receipt")).getByRole("button", { name: "Download Receipt" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(readFile.mock.calls[0]![0]).toMatchObject({ workspaceId: "workspace-A", fileId: "1234567890abcdef", read: { operationId: read, fieldId: receiptField } });
    // The press downloads. It opens no editor.
    expect(editor()).toBeNull();
    fireEvent.click(within(cell("Receipt")).getByRole("button", { name: "Change Receipt" }));
    fireEvent.click(within(editor()!).getByRole("button", { name: "Remove file" }));
    fireEvent.click(within(editor()!).getByRole("button", { name: "Cancel" }));
    expect(editor()).toBeNull();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("offers no way in to a file or a relation the page has no handler for", async () => {
    setup({ dataset: withResources(), invoke: vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: stored() })) });
    await screen.findByText("Alice");
    expect(within(cell("Receipt")).queryByRole("button")).toBeNull();
    expect(cell("Receipt").textContent).toBe("Attached file");
    for (const field of ["Receipt", "Team"]) { fireEvent.click(cell(field)); press("Enter"); expect(editor()).toBeNull(); }
  });
});

describe("a Data Collection's record panel and forms", () => {
  it("opens a record in a panel beside the table, with the fields the person may read and no key or version", async () => {
    setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open Alice" });
    open.focus(); fireEvent.click(open);
    const record = screen.getByRole("complementary", { name: "Alice" });
    // The panel is no dialog, and it takes focus without holding it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(record.getAttribute("aria-modal")).toBeNull();
    expect(document.activeElement).toBe(record);
    expect(within(record).getByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(within(record).getByText("People")).toBeTruthy();
    // The record's name is the heading, not a row. The other fields it may read follow in the table's order.
    expect(within(record).getAllByRole("group").map(group => document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent)).toEqual(["Amount", "Status"]);
    expect(within(record).queryByText("Private note")).toBeNull();
    expect(within(record).queryByText("Do not show")).toBeNull();
    expect(record.textContent).not.toMatch(/version|record 1/i);
    // A Data record has no page to open.
    expect(within(record).queryByRole("button", { name: "Open as page" })).toBeNull();
    // The open record's row is marked, and the table beside the panel still takes an edit.
    expect(grid().querySelector('[role="row"][aria-current="true"]')?.getAttribute("data-index")).toBe("0");
    fireEvent.click(cell("Amount"));
    expect(editor()).not.toBeNull();
    expect(panel()).toBe(record);
  });

  it("edits a field in the panel through the queue, with no Save step, and shows the change on the field and on its cell until the host confirms it", async () => {
    const write = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() }) : write.promise);
    setup({ invoke }); await screen.findByText("Alice");
    const record = openPanel();
    typeInPanel("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    expect(sent(invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [amount]: 9 } });
    expect(within(record).queryByRole("button", { name: "Save" })).toBeNull();
    expect(propertyEditor("Amount")).toBeNull();
    expect([propertyMark("Amount"), mark("Amount")]).toEqual(["pending", "pending"]);
    expect(property("Amount").textContent).toContain("9");
    expect(cell("Amount").textContent).toContain("9");
    await act(async () => write.resolve({ result: { id: 1, version: 3, priorValues: { [amount]: 5 } } }));
    await waitFor(() => expect([propertyMark("Amount"), mark("Amount")]).toEqual([null, null]));
  });

  it("shows a change dohc could not confirm on the field and on its cell, and Try again in the panel sends the exact request again", async () => {
    let failed = false;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (!failed) { failed = true; throw new Error("Connection ended after commit"); }
      return { result: { id: 1, version: 3, priorValues: { [amount]: 5 } } };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    openPanel();
    typeInPanel("Amount", "9");
    await waitFor(() => expect(propertyMark("Amount")).toBe("unconfirmed"));
    const note = within(within(property("Amount")).getByRole("note"));
    expect(within(property("Amount")).getByRole("note").textContent).toContain("dohc could not confirm this change.");
    expect(mark("Amount")).toBe("unconfirmed");
    // The field and the cell say it, so the page does not list the change as well.
    expect(strip()).toBeNull();
    expect(note.getByRole("button", { name: "Discard" })).toBeTruthy();
    fireEvent.click(note.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]).toEqual(sent(invoke, edit)[0]);
    await waitFor(() => expect([propertyMark("Amount"), mark("Amount")]).toEqual([null, null]));
  });

  it("keeps a refused value on the field and on its cell, with why, until it is dismissed", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke) => {
      if (request.operationId === read) return { result: page() };
      throw Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" });
    });
    const { onError } = setup({ invoke });
    await screen.findByText("Alice");
    openPanel();
    typeInPanel("Amount", "9");
    await waitFor(() => expect(propertyMark("Amount")).toBe("refused"));
    expect(within(property("Amount")).getByRole("note").textContent).toContain("The Collection refused this change. This record changed. Refresh the table.");
    expect(property("Amount").textContent).toContain("9");
    expect(mark("Amount")).toBe("refused");
    expect(onError).toHaveBeenCalledWith("The Collection refused this change.", expect.objectContaining({ code: "operation_refused" }), null);
    fireEvent.click(within(within(property("Amount")).getByRole("note")).getByRole("button", { name: "Dismiss" }));
    expect([propertyMark("Amount"), mark("Amount")]).toEqual([null, null]);
    expect(property("Amount").textContent).toContain("5");
  });

  it("changes the record's name in the heading by a cell's rules, and keeps a name the field can't take with why", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    const record = openPanel();
    fireEvent.click(nameButton());
    const input = within(record).getByRole<HTMLInputElement>("textbox", { name: "Name" });
    expect(input.value).toBe("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent(invoke, edit)[0]?.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } }));
    await waitFor(() => expect(mark("Name")).toBeNull());
    // Name is required, so an empty one is not sent. The heading says why, as the cell does.
    fireEvent.click(nameButton());
    fireEvent.change(within(panel()).getByRole("textbox", { name: "Name" }), { target: { value: "" } });
    fireEvent.keyDown(within(panel()).getByRole("textbox", { name: "Name" }), { key: "Enter" });
    expect(within(panel()).getByRole("note").textContent).toContain("Enter Name.");
    expect(why("Name")).toBe("Enter Name.");
    expect(sent(invoke, edit)).toHaveLength(1);
  });

  it("heads a record that has no name as Untitled, and shows its key nowhere", async () => {
    const optional = dataset();
    optional.tables[0]!.fields.find(entry => entry.fieldId === name)!.required = false;
    const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: { rows: [{ id: 41, version: 2, values: { [name]: null, [amount]: 5, [status]: "New" } }], nextCursor: null } }));
    setup({ dataset: optional, invoke });
    // The table's Open control and the panel call the record the same thing for a screen reader.
    fireEvent.click(await screen.findByRole("button", { name: "Open record 41" }));
    const record = screen.getByRole("complementary", { name: "record 41" });
    expect(within(record).getByRole("heading", { name: "Untitled" })).toBeTruthy();
    expect(record.textContent).not.toContain("41");
    // The name can still be given there.
    fireEvent.click(nameButton());
    expect(within(record).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("");
  });

  it("closes the innermost thing on Escape: an open editor, the open name, then the panel, and returns focus to what opened it", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open Alice" });
    open.focus(); fireEvent.click(open);
    const record = panel();
    const value = propertyValue("Amount");
    fireEvent.click(value);
    fireEvent.change(propertyInput("Amount"), { target: { value: "9" } });
    fireEvent.keyDown(propertyInput("Amount"), { key: "Escape" });
    expect(propertyEditor("Amount")).toBeNull();
    expect(panel()).toBe(record);
    expect(document.activeElement).toBe(value);

    fireEvent.click(nameButton());
    fireEvent.change(within(record).getByRole("textbox", { name: "Name" }), { target: { value: "Alicia" } });
    fireEvent.keyDown(within(record).getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(within(record).queryByRole("textbox")).toBeNull();
    expect(panel()).toBe(record);
    expect(document.activeElement).toBe(nameButton());

    fireEvent.keyDown(nameButton(), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(sent(invoke, edit)).toHaveLength(0);
  });

  it("closes an open table editor on the first Escape and the record on the second, and returns focus to what opened the record", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open Alice" });
    open.focus(); fireEvent.click(open);
    const record = panel();
    fireEvent.click(cell("Amount"));
    fireEvent.change(editorInput(), { target: { value: "9" } });
    fireEvent.keyDown(editorInput(), { key: "Escape" });
    expect(editor()).toBeNull();
    expect(panel()).toBe(record);
    expect(document.activeElement).toBe(grid());
    // An input method's Escape belongs to its composition.
    fireEvent.keyDown(grid(), { key: "Escape", keyCode: 229 });
    expect(panel()).toBe(record);
    press("Escape");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(sent(invoke, edit)).toHaveLength(0);
  });

  it("closes the open record before the table clears its selection: one Escape on the table closes the record, and the next clears the selected cell", async () => {
    setup(); await screen.findByText("Alice");
    fireEvent.click(cell("Status"));
    fireEvent.keyDown(grid(), { key: "Enter", ctrlKey: true });
    expect(document.activeElement).toBe(panel());
    grid().focus();
    press("Escape");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(cell("Status").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(grid());
    press("Escape");
    expect(cell("Status").getAttribute("aria-selected")).toBeNull();
  });

  it("closes the record on Escape from any control of its page, after an open menu has taken its own", async () => {
    setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open Alice" });
    open.focus(); fireEvent.click(open);
    const record = panel();
    // The page's menu closes on its own Escape, and the record stays.
    fireEvent.keyDown(command("Refresh"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(panel()).toBe(record);
    const search = screen.getByRole("searchbox");
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("saves a name being typed on its own record when a press on another record takes the panel, and keeps one unsent when the panel goes with no press", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? twoRecords() : receipt() }));
    const { props, rerender } = setup({ invoke }); await screen.findByText("Alice");
    openPanel();
    typeName("Alicia");
    // A press on another record's Open leaves the name first, which saves it by a cell's rules, on the record it was typed for.
    fireEvent.blur(within(panel()).getByRole("textbox", { name: "Name" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Bea" }));
    expect(within(panel()).getByRole("heading").textContent).toBe("Bea");
    await waitFor(() => expect(sent(invoke, edit).map(request => request.input)).toEqual([{ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } }]));
    typeName("Beatrice");
    // The ⚡ panel takes the record's place. No press landed away from the name, so nothing saved it.
    rerender(<TransactionalCollectionPage {...props} automations={{ open: true, count: 1, onToggle: vi.fn(), close: vi.fn() }} panel={<aside aria-label="Automations" />} />);
    expect(screen.getAllByRole("complementary").map(side => side.getAttribute("aria-label"))).toEqual(["Automations"]);
    expect([mark("Name", 1), why("Name", 1)]).toEqual(["refused", LEFT_OPEN]);
    expect(cell("Name", 1).textContent).toContain("Beatrice");
    expect(sent(invoke, edit)).toHaveLength(1);
  });

  it("keeps the record one copy of a tab still shows in the tab's saved entry when another copy closes its own, and never makes one copy follow the other", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? twoRecords() : receipt() }));
    const { props } = setup({ invoke }); cleanup();
    // Two editor groups show the Collection's tab. The tab has one saved entry, which both copies read and write.
    function TwoCopies() {
      const [kept, setKept] = useState<string | null>(null);
      return <>
        {["Left", "Right"].map(group => <div key={group} data-testid={group}><TransactionalCollectionPage {...props} initialOpenRecord={kept} onOpenRecordChange={setKept} /></div>)}
        <output aria-label="Kept record">{kept ?? "none"}</output>
      </>;
    }
    render(<TwoCopies />);
    const copy = (group: string) => within(screen.getByTestId(group));
    const kept = () => screen.getByRole("status", { name: "Kept record" }).textContent;
    await waitFor(() => expect(screen.getAllByText("Alice")).toHaveLength(2));
    fireEvent.click(copy("Left").getByRole("button", { name: "Open Alice" }));
    expect(kept()).toBe("1");
    expect(copy("Right").queryByRole("complementary")).toBeNull();
    // The entry holds the record a person opened last, in either copy.
    fireEvent.click(copy("Right").getByRole("button", { name: "Open Bea" }));
    expect(kept()).toBe("2");
    expect(copy("Left").getByRole("complementary", { name: "Alice" })).toBeTruthy();
    // The right copy closes its record. The left one still shows a record, so the entry holds that one.
    fireEvent.click(within(copy("Right").getByRole("complementary")).getByRole("button", { name: "Close record" }));
    expect(kept()).toBe("1");
    expect(copy("Right").queryByRole("complementary")).toBeNull();
    expect(copy("Left").getByRole("complementary", { name: "Alice" })).toBeTruthy();
    fireEvent.click(within(copy("Left").getByRole("complementary")).getByRole("button", { name: "Close record" }));
    expect(kept()).toBe("none");
  });

  it("opens the selected cell's record on Ctrl+Enter, and replaces the panel's record when another opens", async () => {
    const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: twoRecords() }));
    setup({ invoke }); await screen.findByText("Alice");
    fireEvent.click(cell("Status"));
    fireEvent.keyDown(grid(), { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "Alice" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Bea" }));
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getByRole("complementary", { name: "Bea" })).toBeTruthy();
    expect(property("Amount").textContent).toContain("7");
    expect([...grid().querySelectorAll('[role="row"][aria-current="true"]')].map(row => row.getAttribute("data-index"))).toEqual(["1"]);
  });

  it("keeps the table's rows as they are when the panel opens, resizes and closes", async () => {
    setup(); await screen.findByText("Alice");
    const row = grid().querySelector('[role="row"][data-index="0"]')!, amountCell = cell("Amount"), value = within(amountCell).getByRole("button");
    const record = openPanel();
    fireEvent.keyDown(within(record).getByRole("separator", { name: "Resize record" }), { key: "ArrowLeft" });
    fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(grid().querySelector('[role="row"][data-index="0"]')).toBe(row);
    expect(cell("Amount")).toBe(amountCell);
    expect(within(cell("Amount")).getByRole("button")).toBe(value);
  });

  it("tells its host which record is open, and opens it again when the page starts with it", async () => {
    const onOpenRecordChange = vi.fn();
    const first = setup({ onOpenRecordChange }); await screen.findByText("Alice");
    openPanel();
    expect(onOpenRecordChange).toHaveBeenLastCalledWith("1");
    // Text being typed is no part of what the host keeps.
    fireEvent.click(propertyValue("Amount"));
    fireEvent.change(propertyInput("Amount"), { target: { value: "9" } });
    expect(onOpenRecordChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(propertyInput("Amount"), { key: "Escape" });
    fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
    expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
    first.unmount();
    // The host kept the record with the tab. The page starts with it and takes no focus for it.
    render(<TransactionalCollectionPage {...first.props} initialOpenRecord="1" />);
    const record = await screen.findByRole("complementary", { name: "Alice" });
    expect(document.activeElement).not.toBe(record);
    expect(within(record).getByRole("heading", { name: "Alice" })).toBeTruthy();
    expect(onOpenRecordChange).toHaveBeenCalledTimes(2);
  });

  describe("a record that is not among the table's", () => {
    const keyed = () => { const description = dataset(); description.tables[0]!.primaryKeyFieldId = name; return description; };
    const bea: AppBackendJson = { rows: [{ id: 2, version: 4, values: { [name]: "Bea", [amount]: 7, [status]: "New" } }], nextCursor: null };
    const byKey = (request: TransactionalInvoke) => (request.input as { filters?: unknown[] }).filters !== undefined;

    it("is read by its key, shows as loading until then, and takes a change as a record of the table does", async () => {
      const answer = deferred<{ result: AppBackendJson }>();
      const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> =>
        byKey(request) ? answer.promise : Promise.resolve({ result: request.operationId === read ? page() : { id: 2, version: 5, priorValues: { [amount]: 7 } } }));
      setup({ dataset: keyed(), invoke, initialOpenRecord: "2" });
      await screen.findByText("Alice");
      const record = screen.getByRole("complementary", { name: "Record" });
      expect(record.getAttribute("aria-busy")).toBe("true");
      expect(within(record).queryByRole("heading")).toBeNull();
      await waitFor(() => expect(sent(invoke, read).some(request => JSON.stringify(request.input) === JSON.stringify({ limit: 1, filters: [{ fieldId: name, value: 2 }] }))).toBe(true));
      await act(async () => answer.resolve({ result: bea }));
      expect(screen.getByRole("complementary", { name: "Bea" })).toBe(record);
      typeInPanel("Amount", "8");
      await waitFor(() => expect(sent(invoke, edit)[0]?.input).toEqual({ id: 2, expectedVersion: 4, values: { [amount]: 8 } }));
    });

    it("keeps a confirmed value on its field, with no word that it is still saving: after the table's read leaves the record out, and after the read of the record fails", async () => {
      const lookups: Array<ReturnType<typeof deferred<{ result: AppBackendJson }>>> = [];
      const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
        if (!byKey(request)) return Promise.resolve({ result: request.operationId === read ? page() : { id: 2, version: 5, priorValues: { [amount]: 7 } } });
        lookups.push(deferred<{ result: AppBackendJson }>());
        return lookups.at(-1)!.promise;
      });
      const { props, rerender } = setup({ dataset: keyed(), invoke, initialOpenRecord: "2" });
      await screen.findByText("Alice");
      await waitFor(() => expect(lookups).toHaveLength(1));
      await act(async () => lookups[0]!.resolve({ result: bea }));
      typeInPanel("Amount", "8");
      // The change is confirmed, the table's records are read again without the record, and the read of the record has not answered.
      await waitFor(() => expect(lookups).toHaveLength(2));
      expect(property("Amount").textContent).toContain("8");
      expect(propertyMark("Amount")).toBeNull();
      // That read fails. The field still shows what the Collection confirmed.
      await act(async () => lookups[1]!.reject(new Error("Lost reply")));
      expect(property("Amount").textContent).toContain("8");
      expect(propertyMark("Amount")).toBeNull();
      expect(screen.getByRole("complementary", { name: "Bea" })).toBeTruthy();
      // The record's next change goes with the version its receipt gave, not the one the failed read never brought.
      typeInPanel("Amount", "9");
      await waitFor(() => expect(sent(invoke, edit).at(-1)?.input).toEqual({ id: 2, expectedVersion: 5, values: { [amount]: 9 } }));
      // A later read of the record shows it.
      await waitFor(() => expect(lookups).toHaveLength(3));
      await act(async () => lookups[2]!.resolve({ result: { rows: [{ id: 2, version: 6, values: { [name]: "Bea", [amount]: 9, [status]: "New" } }], nextCursor: null } }));
      expect(propertyMark("Amount")).toBeNull();
      expect(property("Amount").textContent).toContain("9");
    });

    it("says in one line that a record is gone, could not be read, or was never one, and offers Close", async () => {
      const onOpenRecordChange = vi.fn();
      const gone = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: byKey(request) ? { rows: [], nextCursor: null } : page() }));
      setup({ dataset: keyed(), invoke: gone, initialOpenRecord: "2", onOpenRecordChange });
      expect((await within(await screen.findByRole("complementary")).findByText("This record is no longer in this Collection.")).getAttribute("role")).toBe("status");
      fireEvent.click(within(panel()).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
      cleanup(); resetKeptCollectionEditsForTests();

      const failing = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => { if (byKey(request)) throw new Error("Lost reply"); return { result: page() }; });
      setup({ dataset: keyed(), invoke: failing, initialOpenRecord: "2" });
      expect((await within(await screen.findByRole("complementary")).findByText("dohc could not read this record. Close it, then open it again.")).getAttribute("role")).toBe("status");
      cleanup(); resetKeptCollectionEditsForTests();

      // A kept key that names no record is never sent to the Collection.
      const foreign = vi.fn(async (_request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: page() }));
      setup({ dataset: keyed(), invoke: foreign, initialOpenRecord: "{not a key" });
      expect((await within(await screen.findByRole("complementary")).findByText("This record is no longer in this Collection.")).getAttribute("role")).toBe("status");
      expect(foreign.mock.calls.some(([request]) => byKey(request))).toBe(false);
    });

    it("ignores a by-key answer that comes after the panel shows another record, after it closed, and after the page left for another workspace, Collection or table", async () => {
      const answers: Array<ReturnType<typeof deferred<{ result: AppBackendJson }>>> = [];
      const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
        if (!byKey(request)) return Promise.resolve({ result: page() });
        answers.push(deferred<{ result: AppBackendJson }>());
        return answers.at(-1)!.promise;
      });
      const view = setup({ dataset: keyed(), invoke, initialOpenRecord: "2" });
      await screen.findByText("Alice");
      await waitFor(() => expect(answers).toHaveLength(1));
      // Another record opens before the answer for the first.
      openPanel();
      expect(screen.getByRole("complementary", { name: "Alice" })).toBeTruthy();
      await act(async () => answers[0]!.resolve({ result: bea }));
      expect(screen.getByRole("complementary", { name: "Alice" })).toBeTruthy();
      expect(screen.queryByText("Bea")).toBeNull();
      // The panel closes before the answer.
      view.unmount(); resetKeptCollectionEditsForTests();
      const closed = setup({ dataset: keyed(), invoke, initialOpenRecord: "2" });
      await screen.findByText("Alice");
      await waitFor(() => expect(answers).toHaveLength(2));
      fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
      await act(async () => answers[1]!.resolve({ result: bea }));
      expect(screen.queryByRole("complementary")).toBeNull();
      closed.unmount(); resetKeptCollectionEditsForTests();
      // The page leaves for another workspace, another Collection, or another table before the answer.
      const elsewhere: Array<Partial<React.ComponentProps<typeof TransactionalCollectionPage>>> = [
        { workspaceId: "workspace-B" }, { dataset: { ...keyed(), datasetId: id(77) } }, { tableId: id(78) }];
      for (const [index, other] of elsewhere.entries()) {
        const left = setup({ dataset: keyed(), invoke, initialOpenRecord: "2" });
        await screen.findByRole("complementary", { name: "Record" });
        await waitFor(() => expect(answers).toHaveLength(3 + index));
        left.rerender(<TransactionalCollectionPage {...left.props} {...other} initialOpenRecord={null} />);
        await act(async () => answers[2 + index]!.resolve({ result: bea }));
        expect(screen.queryByRole("complementary")).toBeNull();
        expect(screen.queryByText("Bea")).toBeNull();
        left.unmount(); resetKeptCollectionEditsForTests();
      }
    });
  });

  it("says a record a read left out is no longer in this view, keeps it open, and gives the table focus when it closes", async () => {
    let rows = page();
    const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: rows }));
    const { props, rerender } = setup({ invoke }); await screen.findByText("Alice");
    const record = openPanel();
    // The record leaves this page of records, so its row and its Open control go.
    rows = { rows: [{ id: 2, version: 4, values: { [name]: "Bea", [amount]: 7, [status]: "New" } }], nextCursor: null };
    rerender(<TransactionalCollectionPage {...props} recordsVersion={1} />);
    await screen.findByText("Bea");
    expect(panel()).toBe(record);
    expect(within(record).getByRole("status").textContent).toBe("This record is no longer in this view. Close it, then search for it.");
    expect(within(record).queryByRole("heading")).toBeNull();
    fireEvent.click(within(record).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(grid());
  });

  it("starts at the width its host kept, and tells the host the width once a resize ends", async () => {
    const onRecordPanelWidthChange = vi.fn();
    setup({ initialRecordPanelWidth: 420, onRecordPanelWidthChange }); await screen.findByText("Alice");
    const record = openPanel();
    expect(record.style.width).toBe("420px");
    fireEvent.keyDown(within(record).getByRole("separator", { name: "Resize record" }), { key: "ArrowLeft" });
    expect(onRecordPanelWidthChange).toHaveBeenCalledExactlyOnceWith(436);
    expect(panel().style.width).toBe("436px");
  });

  it("shows one side panel at a time: asks the ⚡ panel to close first, opens no record while that panel stays, and closes when the ⚡ panel opens", async () => {
    const close = vi.fn<(then: () => void) => void>(), onOpenRecordChange = vi.fn();
    const automations = (open: boolean) => ({ open, count: 1, onToggle: vi.fn(), close });
    const drawer = <aside aria-label="Automations" />;
    const { props, rerender } = setup({ automations: automations(true), panel: drawer, onOpenRecordChange });
    await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open Alice" }));
    // The ⚡ panel holds a draft and has not closed: no record opens, and nothing of the draft is lost.
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("complementary").map(side => side.getAttribute("aria-label"))).toEqual(["Automations"]);
    expect(onOpenRecordChange).not.toHaveBeenCalled();
    // It closes, and the record opens in its place.
    rerender(<TransactionalCollectionPage {...props} automations={automations(false)} panel={null} />);
    await act(async () => close.mock.calls[0]![0]());
    expect(screen.getAllByRole("complementary").map(side => side.getAttribute("aria-label"))).toEqual(["Alice"]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith("1");
    // The ⚡ panel opens again and takes the place back.
    rerender(<TransactionalCollectionPage {...props} automations={automations(true)} panel={drawer} />);
    expect(screen.getAllByRole("complementary").map(side => side.getAttribute("aria-label"))).toEqual(["Automations"]);
    expect(onOpenRecordChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps text typed in a panel field and not saved when its page closes, and shows it on its cell", async () => {
    const first = setup(); await screen.findByText("Alice");
    openPanel();
    fireEvent.click(propertyValue("Amount"));
    fireEvent.change(propertyInput("Amount"), { target: { value: "9" } });
    first.unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    await screen.findByText("Alice");
    expect([mark("Amount"), why("Amount")]).toEqual(["refused", "This edit was still open, so dohc did not save it."]);
    expect(cell("Amount").textContent).toContain("9");
    expect(sent(first.invoke, edit)).toHaveLength(0);
  });

  it("opens a new record in the panel again with what was typed when its page closes and opens again, even when it closed before its records loaded", async () => {
    const first = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    typeDraft("Name", "Bob");
    first.unmount();
    // The Collection opens again, and another file opens before its records load.
    render(<TransactionalCollectionPage {...first.props} invoke={() => new Promise<never>(() => undefined)} />).unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    await screen.findByRole("complementary", { name: "New record" });
    expect(draftValue("Name")).toBe("Bob");
  });
  it("opens no new record again that was cancelled or has no changes, and flags a kept value whose field changed meanwhile", async () => {
    const reopen = async (props: React.ComponentProps<typeof TransactionalCollectionPage>, typed: string | null, cancel = false) => {
      const view = render(<TransactionalCollectionPage {...props} />);
      await screen.findByText("Alice");
      fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
      if (typed !== null) typeDraft("Name", typed);
      if (cancel) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      view.unmount();
    };
    const { props } = setup({ dataset: needingPanel(dataset()) }); cleanup();
    await reopen(props, null);
    await reopen(props, "Bob", true);
    const unchanged = render(<TransactionalCollectionPage {...props} />);
    await screen.findByText("Alice");
    expect(noDraftPanel()).toBe(true);
    unchanged.unmount();
    await reopen(props, "Bob");
    const retyped = needingPanel(dataset()); retyped.revision = 2; retyped.revisionSha256 = "b".repeat(64);
    retyped.tables[0]!.fields.find(field => field.fieldId === name)!.type = "number";
    render(<TransactionalCollectionPage {...props} dataset={retyped} />);
    const kept = within(await screen.findByRole("complementary", { name: "New record" })).getByLabelText<HTMLInputElement>("Name");
    expect(kept.readOnly).toBe(true); expect(kept.value).toBe("Bob");
    expect(screen.getByText("This field changed, so this value can't be saved. Copy it if you need it, then clear it.")).toBeTruthy();
  });
  it("keeps text left in an open editor of the new record when its page closes, with text its field cannot take", async () => {
    const first = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    // Nothing is saved to the draft yet: the name is still in its open editor.
    fireEvent.click(within(draftField("Name")).getAllByRole("button")[0]!);
    fireEvent.change(cellEditor(draftField("Name")), { target: { value: "Bob" } });
    first.unmount();
    const again = render(<TransactionalCollectionPage {...first.props} />);
    await screen.findByRole("complementary", { name: "New record" });
    expect(draftValue("Name")).toBe("Bob");
    // A word in a number field is kept as the word, with its field, and stops Create record until it is a number.
    typeDraft("Badge", "A1");
    fireEvent.click(within(draftField("Amount")).getAllByRole("button")[0]!);
    fireEvent.change(cellEditor(draftField("Amount")), { target: { value: "abc" } });
    again.unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    await screen.findByRole("complementary", { name: "New record" });
    expect(draftValue("Name")).toBe("Bob");
    expect(draftValue("Amount")).toBe("abc");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(within(draftField("Amount")).getByRole("alert").textContent).toBe("Enter a number.");
    expect(sent(first.invoke, create)).toHaveLength(0);
  });
  it("saves the table's new row when its page closes, and opens nothing again", async () => {
    const first = setup(); await screen.findByText("Alice");
    typeNewRow("Bob", "Tab");
    expect(sent(first.invoke, create)).toHaveLength(0);
    first.unmount();
    await waitFor(() => expect(sent(first.invoke, create)).toHaveLength(1));
    expect(sent(first.invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: null, [status]: "New" } });
    render(<TransactionalCollectionPage {...first.props} />);
    await screen.findByText("Alice");
    expect(newRow()).toBeNull();
    expect(noDraftPanel()).toBe(true);
  });

  it("stops an upload when the panel closes, and holds none of the page's controls for it", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const { onError } = setup({ dataset: description, uploadFile }); await screen.findByText("Alice");
    const record = openPanel();
    // A file's value is drawn and changed by the page's own cell and editor, never the shared text editor.
    fireEvent.click(within(property("Amount")).getByRole("button", { name: "Add Amount" }));
    expect(propertyEditor("Amount")!.querySelector('input[type="text"]')).toBeNull();
    fireEvent.change(propertyEditor("Amount")!.querySelector('input[type="file"]')!, { target: { files: [new File(["abc"], "receipt.txt")] } });
    expect(uploadFile).toHaveBeenCalledOnce();
    fireEvent.click(within(record).getByRole("button", { name: "Close record" }));
    expect(uploadFile.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pendingUpload.reject(new DOMException("The upload was cancelled.", "AbortError")));
    expect(onError).not.toHaveBeenCalled();
    expect(command("Refresh").getAttribute("aria-disabled")).toBeNull();
  });

  it("downloads a record's file from the panel through the table's read action", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: "abcdefghijklmnop", [status]: "New" } }], nextCursor: null } }));
    const readFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["readFile"]>>(() => new Promise(() => undefined));
    const view = setup({ dataset: description, invoke, readFile }); await screen.findByText("Alice");
    openPanel();
    fireEvent.click(within(property("Amount")).getByRole("button", { name: "Download Amount" }));
    expect(readFile).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-A", datasetId: id(1), revision: 1, revisionSha256: "a".repeat(64), fileId: "abcdefghijklmnop",
      read: { operationId: read, fieldId: amount, input: { limit: 1, filters: [{ fieldId: amount, value: "abcdefghijklmnop" }] } } }, expect.any(AbortSignal));
    // The press downloads the file. It opens no editor.
    expect(propertyEditor("Amount")).toBeNull();
    // An answer for the old workspace is stopped before it downloads or reports anything.
    view.rerender(<TransactionalCollectionPage {...view.props} workspaceId="workspace-B" />);
    expect(readFile.mock.calls[0]![1].aborted).toBe(true);
    expect(view.onError).not.toHaveBeenCalled();
  });

  it("opens a custom action from the panel only for the record's own table, keeps the panel open, and lists no action in an offline copy", async () => {
    const description = dataset();
    description.operations.push(
      { operationId: id(20), name: "approve", label: "Approve", kind: "action", access: "owner", readOnly: false, tableId: id(2), fieldIds: [] },
      { operationId: id(21), name: "other", label: "Other table action", kind: "action", access: "owner", readOnly: false, tableId: id(9), fieldIds: [] },
      // An action that changes nothing is still among an offline copy's operations.
      { operationId: id(22), name: "summarize", label: "Summarize", kind: "action", access: "owner", readOnly: true, tableId: id(2), fieldIds: [] });
    const onCustomAction = vi.fn();
    const view = setup({ dataset: description, onCustomAction }); await screen.findByText("Alice");
    const record = openPanel();
    expect(within(record).queryByRole("button", { name: "Open Other table action" })).toBeNull();
    expect(within(record).getByRole("button", { name: "Open Summarize" })).toBeTruthy();
    fireEvent.click(within(record).getByRole("button", { name: "Open Approve" }));
    expect(onCustomAction).toHaveBeenCalledExactlyOnceWith(id(20));
    expect(panel()).toBe(record);
    view.rerender(<TransactionalCollectionPage {...view.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(panel()).toBe(record);
    expect(within(record).queryByRole("button", { name: /^Open / })).toBeNull();
    expect(within(record).queryByText("Open an action to review its inputs before running it.")).toBeNull();
  });

  it("says why Delete record waits for the records while they load", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const reload = deferred<{ result: AppBackendJson }>(), pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    let reads = 0;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read && ++reads === 2 ? reload.promise : Promise.resolve({ result: page() }));
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const view = setup({ dataset: description, invoke, uploadFile, confirmDelete: vi.fn(async () => false) }); await screen.findByText("Alice");
    openPanel();
    view.rerender(<TransactionalCollectionPage {...view.props} recordsVersion={1} />);
    await waitFor(() => expect(reads).toBe(2));
    let remove = recordCommand("Delete record…");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.textContent).toContain("Wait for the records to load.");
    fireEvent.keyDown(remove, { key: "Escape" });
    await act(async () => reload.resolve({ result: page() }));
    await loaded();
    remove = recordCommand("Delete record…");
    expect(remove.getAttribute("aria-disabled")).toBeNull();
  });

  it("closes the panel on Escape and returns keyboard focus to the row", async () => {
    setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open Alice" });
    open.focus();
    fireEvent.click(open);
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("deletes a record from the panel's menu, after the shell's confirmation, with the approved operation and the record's version", async () => {
    let asked: (confirmed: boolean) => void = () => undefined;
    const confirmDelete = vi.fn(() => new Promise<boolean>(resolve => { asked = resolve; }));
    const { invoke } = setup({ confirmDelete });
    await screen.findByText("Alice");
    // No row of the table carries a delete control.
    expect(within(grid()).queryByRole("button", { name: /Delete/ })).toBeNull();
    openPanel();
    fireEvent.click(recordCommand("Delete record…"));
    expect(confirmDelete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 1, version: 2 }));
    // A second press while the shell asks does nothing, and nothing is deleted before the answer.
    fireEvent.click(recordCommand("Delete record…"));
    expect(confirmDelete).toHaveBeenCalledOnce();
    expect(sent(invoke, remove)).toHaveLength(0);
    expect(screen.getByRole("complementary", { name: "Alice" })).toBeTruthy();
    await act(async () => asked(true));
    await waitFor(() => expect(sent(invoke, remove)).toHaveLength(1));
    expect(sent(invoke, remove)[0]!.input).toEqual({ id: 1, expectedVersion: 2 });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("deletes nothing when the shell's confirmation is cancelled, and a deletion follows the record's queued change", async () => {
    const answers: Array<(confirmed: boolean) => void> = [];
    const confirmDelete = vi.fn(() => new Promise<boolean>(resolve => { answers.push(resolve); }));
    const { invoke } = setup({ confirmDelete });
    await screen.findByText("Alice");
    openPanel();
    fireEvent.click(recordCommand("Delete record…"));
    await act(async () => answers[0]!(false));
    expect(screen.getByRole("complementary", { name: "Alice" })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Close record" }));
    type("Name", "Alicia");
    openPanel();
    fireEvent.click(recordCommand("Delete record…"));
    await act(async () => answers[1]!(true));
    await waitFor(() => expect(sent(invoke, remove)).toHaveLength(1));
    // The deletion uses the version the edit left the record at.
    expect(sent(invoke, remove)[0]!.input).toEqual({ id: 1, expectedVersion: 3 });
  });

  it("clears previously displayed records when a read loses access", async () => {
    const result = setup(); await screen.findByText("Alice");
    result.invoke.mockRejectedValueOnce(Error("Access revoked"));
    fireEvent.click(command("Refresh"));
    await waitFor(() => expect(result.onError).toHaveBeenCalled());
    expect(screen.queryByText("Alice")).toBeNull();
  });
  it("shows saved offline records with no way to change them, and refreshes the copy", async () => {
    const onRefresh = vi.fn();
    const { invoke } = setup({ copy: { offline: true, savedAtMs: 1_700_000_000_000, host: "sync.example.test" }, onRefresh, confirmDelete: async () => true });
    await screen.findByText("Alice");
    expect(screen.getByRole("status").textContent).toBe(`Offline copy · Read-only until sync.example.test is reachable · ${new Date(1_700_000_000_000).toLocaleString()}`);
    expect(screen.queryByRole("button", { name: "New record" })).toBeNull();
    for (const field of ["Name", "Amount", "Status"]) {
      fireEvent.click(cell(field));
      for (const key of ["Enter", "x", "Delete"]) press(key);
      expect(editor()).toBeNull();
    }
    // The panel shows the record with no way to change it, delete it, or run an action, and says why.
    const record = openPanel();
    expect(within(record).queryByRole("button", { name: "Record actions" })).toBeNull();
    expect(within(within(record).getByRole("heading")).queryByRole("button")).toBeNull();
    for (const field of ["Amount", "Status"]) expect(within(property(field)).queryByRole("button")).toBeNull();
    expect(within(record).getByText("Offline copy · Read-only")).toBeTruthy();
    fireEvent.click(within(record).getByRole("button", { name: "Close record" }));
    fireEvent.click(command("Refresh")); expect(onRefresh).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("starts a new row from the table's last row, saves it with one create on Enter, and starts the next row", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? { rows: [], nextCursor: null } : { id: 1, version: 1 } }));
    setup({ invoke });
    const table = await screen.findByRole("grid");
    // An empty Collection already shows its columns, and no count.
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toEqual(["", "Name", "Amount", "Status"]);
    expect(screen.queryByText(/on this page/)).toBeNull();
    const add = within(table).getByRole("button", { name: "New record" });
    add.focus(); fireEvent.click(add);
    // The row is in place, with the cursor in its first field. No form opens under the table and no panel beside it.
    expect(newRow()).not.toBeNull();
    expect(document.activeElement).toBe(cellEditor());
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    // Escape cancels the open edit only. The next one leaves the row, which goes with nothing typed in it.
    fireEvent.keyDown(cellEditor(), { key: "Escape" });
    expect(newRow()).not.toBeNull();
    fireEvent.keyDown(table, { key: "Escape" });
    expect(newRow()).toBeNull();
    expect(sent(invoke, create)).toHaveLength(0);

    typeNewRow("Bob");
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    expect(sent(invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: null, [status]: "New" } });
    // The records are read again once the Collection confirms the new one, and Enter starts the next row.
    await waitFor(() => expect(sent(invoke, read)).toHaveLength(2));
    // The next row holds only what a new record starts with.
    await waitFor(() => expect(newRow()?.textContent).toBe("New"));
    expect(document.activeElement).toBe(cellEditor());
    expect(sent(invoke, create)).toHaveLength(1);
  });

  it("stops the save at a required field left empty, says so on its cell, and sends one create with every value once it is filled", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    // Name is left empty, and Amount is typed.
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    fireEvent.keyDown(grid(), { key: "1" });
    fireEvent.change(cellEditor(), { target: { value: "12.5" } });
    fireEvent.keyDown(cellEditor(), { key: "Enter" });
    // Nothing is sent. The cursor is on the Name cell, which says it is required.
    expect(sent(invoke, create)).toHaveLength(0);
    const [nameCell, amountCell] = newRowCells();
    expect(nameCell!.getAttribute("aria-selected")).toBe("true");
    expect(nameCell!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(nameCell!.getAttribute("aria-describedby")!)!.textContent).toBe("Enter Name.");
    expect(amountCell!.textContent).toBe("12.5");
    fireEvent.keyDown(grid(), { key: "B" });
    fireEvent.change(cellEditor(), { target: { value: "Bob" } });
    fireEvent.keyDown(cellEditor(), { key: "Enter" });
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    expect(sent(invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: 12.5, [status]: "New" } });
  });

  it("starts a new row with each field's default, sends what its cells show, and makes no record from untouched defaults", async () => {
    const done = id(7);
    const description = dataset();
    description.tables[0]!.fields.push({ fieldId: done, name: "Done", type: "checkbox", required: false, unique: false, default: true });
    for (const operation of description.operations) if (operation.operationId === read || operation.operationId === create) operation.fieldIds.push(done);
    const { invoke } = setup({ dataset: description }); await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    // The row shows what a new record starts with: Status is New, and Done is ticked.
    expect(newRowCells()[2]!.textContent).toBe("New");
    expect(within(newRowCells()[3]!).getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
    // A row that holds only those is nothing typed: it goes, and makes no record.
    fireEvent.keyDown(cellEditor(), { key: "Escape" });
    fireEvent.keyDown(grid(), { key: "Escape" });
    expect(newRow()).toBeNull();
    expect(sent(invoke, create)).toHaveLength(0);

    // What is sent is what the cells show: the default left as it is, and the box the person unticked.
    typeNewRow("Bob", "Tab");
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: " " });
    expect(within(newRowCells()[3]!).getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
    fireEvent.keyDown(grid(), { key: "Enter" });
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    expect(sent(invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: null, [status]: "New", [done]: false } });
    await waitFor(() => expect(newRow()?.textContent).toBe("New"));

    // A cleared default is an explicit empty value. Status is required, so the save stops there and says so.
    fireEvent.change(cellEditor(), { target: { value: "Cy" } });
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "Delete" });
    expect(newRowCells()[2]!.textContent).toBe("");
    fireEvent.keyDown(grid(), { key: "Enter" });
    expect(sent(invoke, create)).toHaveLength(1);
    expect(newRowCells()[2]!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(newRowCells()[2]!.getAttribute("aria-describedby")!)!.textContent).toBe("Enter Status.");
  });

  it("sends a cleared default from the panel as an explicit empty value too", async () => {
    setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    expect(draftValue("Status")).toBe("New");
    fireEvent.click(within(draftField("Status")).getAllByRole("button")[0]!);
    fireEvent.click(within(draftField("Status").querySelector<HTMLElement>("[data-cell-editor]")!).getByText("Clear"));
    expect(draftValue("Status")).toBe("Empty");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(within(draftField("Status")).getByRole("alert").textContent).toBe("Enter Status.");
  });

  it("shows a new row that waits for the Collection with what was typed, takes no typing until it answers, and says when no row on screen shows the record", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() }) : answer.promise);
    const { onNotice } = setup({ invoke }); await screen.findByText("Alice");
    typeNewRow("Bob");
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    expect(newRow()!.querySelector("[data-new-record-status='pending']")).not.toBeNull();
    expect(newRowCells()[0]!.textContent).toBe("Bob");
    fireEvent.click(newRowCells()[0]!);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    // Leaving the row sends nothing more.
    fireEvent.pointerDown(document.body);
    expect(sent(invoke, create)).toHaveLength(1);
    // The Collection made the record, and this page of records does not hold it.
    await act(async () => answer.resolve({ result: { id: 7, version: 1 } }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Created a record. It is not among the records on screen."));
  });

  it("says on the new row that dohc could not confirm it, with Try again and Discard, and sends the exact request again", async () => {
    let writes = 0;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (++writes === 1) throw Error("Lost reply");
      return { result: { id: 1, version: 3 } };
    });
    const result = setup({ invoke });
    await screen.findByText("Alice");
    typeNewRow("Bob");
    await waitFor(() => expect(newRowNote()?.getAttribute("data-new-record-status")).toBe("unconfirmed"));
    expect(newRowNote()!.textContent).toContain("dohc could not confirm the new record.");
    expect(within(newRowNote()!).getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(newRowCells()[0]!.textContent).toBe("Bob");
    // The row shows the change, so the page's list does not.
    expect(strip()).toBeNull();
    // The row takes no typing while its save may have happened.
    fireEvent.click(newRowCells()[0]!);
    expect(document.querySelector("[data-cell-editor]")).toBeNull();
    fireEvent.click(within(newRowNote()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    const changes = sent(invoke, create);
    expect(changes[1]).toEqual(changes[0]);
    await waitFor(() => expect(newRowNote()).toBeNull());
    // The record is on this page of records, so no notice says it was made.
    expect(result.onNotice).not.toHaveBeenCalled();
  });

  it("opens a new record in the panel where its create needs a field the table cannot show, and sends one create from Create record", async () => {
    const { invoke } = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    const add = within(grid()).getByRole("button", { name: "New record" });
    add.focus(); fireEvent.click(add);
    // No row and no form: the panel, with a row for each field the create takes.
    expect(newRow()).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    const draft = draftPanel();
    expect(within(draft).getByRole("heading", { name: "New record" })).toBeTruthy();
    expect(within(draft).getAllByRole("group").map(row => row.getAttribute("data-property"))).toEqual([name, amount, status, badge]);
    expect(draftValue("Status")).toBe("New");
    // Focus is on its first field. A record that does not exist yet has no actions, and no page to open.
    expect(document.activeElement).toBe(within(draftField("Name")).getAllByRole("button")[0]);
    expect(within(draft).queryByRole("button", { name: "Record actions" })).toBeNull();
    expect(within(draft).queryByRole("button", { name: "Open as page" })).toBeNull();
    // Cancel lets it go, and focus returns to what opened it.
    fireEvent.click(within(draft).getByRole("button", { name: "Cancel" }));
    expect(noDraftPanel()).toBe(true);
    expect(document.activeElement).toBe(add);

    fireEvent.click(add);
    typeDraft("Name", "Bob"); typeDraft("Amount", "12.5"); typeDraft("Badge", "A1");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    expect(sent(invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: 12.5, [status]: "New", [badge]: "A1" } });
    await waitFor(() => expect(noDraftPanel()).toBe(true));
  });

  it("shows a field's error under the field in the panel, marks the field, and moves focus to it", async () => {
    setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    const createButton = screen.getByRole("button", { name: "Create record" });
    createButton.focus(); fireEvent.click(createButton);
    const [error, badgeError] = await screen.findAllByRole("alert");
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Enter Name.", "Enter Badge."]);
    expect(error!.querySelector("svg")).not.toBeNull();
    expect(draftField("Name").contains(error!)).toBe(true);
    expect(draftField("Badge").contains(badgeError!)).toBe(true);
    expect(draftField("Name").hasAttribute("data-invalid")).toBe(true);
    expect(draftField("Name").getAttribute("aria-describedby")).toBe(error!.id);
    expect(draftField("Badge").getAttribute("aria-describedby")).toBe(badgeError!.id);
    expect(document.activeElement).toBe(within(draftField("Name")).getAllByRole("button")[0]);
    // A value in a field clears only its own error. The panel keeps what it holds.
    typeDraft("Name", "Bob");
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Enter Badge."]);
    expect(draftField("Name").hasAttribute("data-invalid")).toBe(false);
    expect(draftField("Badge").hasAttribute("data-invalid")).toBe(true);
    expect(draftValue("Name")).toBe("Bob");
  });

  it("lists a new record from the panel that dohc could not confirm with Try again, and sends the exact request again", async () => {
    let writes = 0;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (++writes === 1) throw Error("Lost reply");
      return { result: { id: 2, version: 1 } };
    });
    const result = setup({ invoke, dataset: needingPanel(dataset()) });
    await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText("dohc could not confirm the new record.")).toBeTruthy();
    expect(noDraftPanel()).toBe(true);
    // The page does not lock while the change waits.
    expect((screen.getAllByRole("button", { name: "New record" })[0] as HTMLButtonElement).disabled).toBe(false);
    const retry = result.onError.mock.calls[0]![2];
    // An offline copy sends nothing, so the change keeps its Try again.
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    await act(async () => retry()); expect(writes).toBe(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    // Back online, under rules with the same revision, the row left in Notices sends the same request.
    const base = needingPanel(dataset());
    const current = { ...base, operations: base.operations.filter(operation => operation.operationId !== remove) };
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={current} copy={{ offline: false, savedAtMs: 2 }} />);
    await act(async () => retry());
    await waitFor(() => expect(screen.queryByRole("group", { name: "Changes dohc did not confirm" })).toBeNull());
    const changes = sent(invoke, create);
    expect(changes).toHaveLength(2); expect(changes[1]).toEqual(changes[0]);
    expect(result.onNotice).not.toHaveBeenCalled();
  });

  it("creates a record with a file its create requires from the panel, and keeps Create record from leaving a chosen file unsaved", async () => {
    const description = dataset(); const file = description.tables[0]!.fields.find(field => field.fieldId === amount)!; file.type = "attachment"; file.required = true;
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const result = setup({ dataset: description, uploadFile }); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    typeDraft("Name", "Bob");
    fireEvent.click(within(draftField("Amount")).getByRole("button", { name: "Add Amount" }));
    const editor = draftField("Amount").querySelector<HTMLElement>("[data-cell-editor]")!;
    fireEvent.change(within(editor).getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt", { type: "text/plain" })] } });
    // The file's own Save waits for the upload.
    expect(within(editor).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    await act(async () => pendingUpload.resolve({ fileId: "1234567890abcdef", name: "receipt.txt", byteLength: 3, contentType: "text/plain", sha256: "a".repeat(64) }));
    expect(screen.getByText("receipt.txt · 3 bytes · Save to attach")).toBeTruthy();
    // Create record does not leave the chosen file behind: focus goes to the file's Save, and nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(sent(result.invoke, create)).toHaveLength(0);
    expect(document.activeElement).toBe(within(editor).getByRole("button", { name: "Save" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    // A record that does not exist yet has no file to download.
    expect(draftValue("Amount")).toContain("File chosen");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: "1234567890abcdef", [status]: "New" } });
  });
  it("holds Create record and Cancel while a file of the new record uploads, and says why", async () => {
    const description = dataset(); const file = description.tables[0]!.fields.find(field => field.fieldId === amount)!; file.type = "attachment"; file.required = true;
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const result = setup({ dataset: description, uploadFile, confirmDelete: vi.fn(async () => false) }); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    typeDraft("Name", "Bob");
    fireEvent.click(within(draftField("Amount")).getByRole("button", { name: "Add Amount" }));
    const editor = draftField("Amount").querySelector<HTMLElement>("[data-cell-editor]")!;
    fireEvent.change(within(editor).getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt", { type: "text/plain" })] } });
    // The upload is out: a create now would go without the file, and Cancel would drop it with no word.
    const createButton = screen.getByRole<HTMLButtonElement>("button", { name: "Create record" });
    const cancel = within(draftPanel().querySelector<HTMLElement>("[data-record-actions]")!).getByRole<HTMLButtonElement>("button", { name: "Cancel" });
    expect(createButton.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(within(draftPanel().querySelector<HTMLElement>("[data-record-actions]")!).getByText("Wait for the file to upload.")).toBeTruthy();
    fireEvent.click(createButton);
    fireEvent.keyDown(draftPanel(), { key: "Escape" });
    expect(sent(result.invoke, create)).toHaveLength(0);
    expect(noDraftPanel()).toBe(false);
    // The page's own controls wait for it too, as they did for the form's upload.
    expect((screen.getAllByRole("button", { name: "New record" })[0] as HTMLButtonElement).disabled).toBe(true);
    // The file's own editor is not held, so its Cancel can still stop the upload.
    expect(within(editor).getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(false);
    await act(async () => pendingUpload.resolve({ fileId: "1234567890abcdef", name: "receipt.txt", byteLength: 3, contentType: "text/plain", sha256: "a".repeat(64) }));
    await waitFor(() => expect(cancel.disabled).toBe(false));
    expect(within(draftPanel().querySelector<HTMLElement>("[data-record-actions]")!).queryByText("Wait for the file to upload.")).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]!.input).toEqual({ values: { [name]: "Bob", [amount]: "1234567890abcdef", [status]: "New" } });
  });
  it("aborts a pending upload for a new record before switching workspaces", async () => {
    const description = dataset(); const file = description.tables[0]!.fields.find(field => field.fieldId === amount)!; file.type = "attachment"; file.required = true;
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const result = setup({ dataset: description, uploadFile }); await screen.findByText("Alice"); fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    fireEvent.click(within(draftField("Amount")).getByRole("button", { name: "Add Amount" }));
    fireEvent.change(within(draftField("Amount").querySelector<HTMLElement>("[data-cell-editor]")!).getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt")] } });
    result.rerender(<TransactionalCollectionPage {...result.props} workspaceId="workspace-b" />);
    expect(uploadFile.mock.calls[0]![1].aborted).toBe(true); await act(async () => pendingUpload.reject(new Error("Old workspace"))); expect(result.onError).not.toHaveBeenCalled();
    await screen.findByText("Alice"); expect(screen.queryByText("Uploading…")).toBeNull();
  });
  it("offers form creation only with a public create action and a connected handler", async () => {
    const onCreateForm = vi.fn(); const result = setup({ onCreateForm }); await screen.findByText("Alice");
    command("Refresh");
    expect(screen.queryByRole("menuitem", { name: "Create form" })).toBeNull();
    const description = dataset(); description.operations.find(operation => operation.operationId === create)!.access = "link";
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} />); await screen.findByText("Alice");
    fireEvent.click(command("Create form")); expect(onCreateForm).toHaveBeenCalledOnce();
    // Without a connected handler, a public create action offers no form.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} onCreateForm={undefined} />);
    command("Refresh");
    expect(screen.queryByRole("menuitem", { name: "Create form" })).toBeNull();
  });
});

describe("a Data Collection's reads", () => {
  it("shows a reopen wait in the page, says when it ends, and loads the records from its Try again", async () => {
    const waiting = new Error("Error invoking remote method 'desktop:dataset': DatasetReopenWaitError [dataset_reopen_wait] [retryAfterMs=5000]: This Collection is waiting to reopen. Try again in 5 seconds.");
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn<(request: TransactionalInvoke) => Promise<{ result: AppBackendJson }>>()
      .mockRejectedValueOnce(waiting).mockReturnValueOnce(answer.promise).mockResolvedValue({ result: page() });
    const onSettled = vi.fn();
    const identity = `collection-load:${id(1)}:${id(2)}`;
    // Only the page's timers are fake; Testing Library's async helpers need real ones, so this test uses act alone.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let retryFromToast: () => void;
    try {
      const { onError } = setup({ invoke, onSettled });
      await act(async () => {});
      const region = screen.getByRole("region", { name: "People" });
      expect(within(region).getByText("This Collection is waiting to reopen. Try again in 5 seconds.")).toBeTruthy();
      expect(onError).toHaveBeenCalledWith("dohc could not load People.", waiting, expect.any(Function), identity);
      // Records that could not load take no changes.
      expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "New record" })[0]!.disabled).toBe(true);
      retryFromToast = onError.mock.calls[0]![2]!;
      await act(() => vi.advanceTimersByTimeAsync(4999));
      expect(within(region).getByText("This Collection is waiting to reopen. Try again in 5 seconds.")).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(within(region).getByText("The wait has ended.")).toBeTruthy();
      fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
      expect(within(region).queryByText("The wait has ended.")).toBeNull();
      expect(within(region).getByText("Loading records…")).toBeTruthy();
      expect(onSettled).not.toHaveBeenCalled();
      await act(async () => answer.resolve({ result: page() }));
      expect(within(region).getByText("Alice")).toBeTruthy();
      expect(within(region).queryByRole("button", { name: "Try again" })).toBeNull();
      expect(onSettled).toHaveBeenCalledWith(identity);
      expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "New record" })[0]!.disabled).toBe(false);
    } finally { vi.useRealTimers(); }
    // The toast's Try again is the same load.
    expect(invoke).toHaveBeenCalledTimes(2);
    act(() => retryFromToast());
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  });

  it("shows any failed load in the page with the toast's Try again", async () => {
    const stopped = new Error("Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped] [retryAfterMs=5000]: The worker stopped.");
    const invoke = vi.fn<(request: TransactionalInvoke) => Promise<{ result: AppBackendJson }>>().mockRejectedValueOnce(stopped).mockResolvedValue({ result: page() });
    const { onError } = setup({ invoke });
    const region = screen.getByRole("region", { name: "People" });
    expect(await within(region).findByText("dohc could not load People.")).toBeTruthy();
    expect(onError).toHaveBeenCalledWith("dohc could not load People.", stopped, expect.any(Function), `collection-load:${id(1)}:${id(2)}`);
    expect(within(region).queryByText(/waiting to reopen/)).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText("Alice")).toBeTruthy();
    expect(within(region).queryByText("dohc could not load People.")).toBeNull();
  });

  it("drops the wait and its Notices row when a read in place finds the records", async () => {
    const invoke = vi.fn<(request: TransactionalInvoke) => Promise<{ result: AppBackendJson }>>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:dataset': DatasetReopenWaitError [dataset_reopen_wait] [retryAfterMs=5000]: This Collection is waiting to reopen. Try again in 5 seconds.")).mockResolvedValue({ result: page() });
    const onSettled = vi.fn();
    const { props, rerender } = setup({ invoke, onSettled });
    const region = screen.getByRole("region", { name: "People" });
    await within(region).findByText("This Collection is waiting to reopen. Try again in 5 seconds.");
    // An automation run changed records, so the page reads them again in place.
    rerender(<TransactionalCollectionPage {...props} onSettled={onSettled} recordsChanged={1} />);
    expect(await within(region).findByText("Alice")).toBeTruthy();
    expect(within(region).queryByText(/waiting to reopen/)).toBeNull();
    expect(onSettled).toHaveBeenCalledWith(`collection-load:${id(1)}:${id(2)}`);
  });

  it("says in the page when the read after a change fails, and keeps what was typed for the read that follows", async () => {
    let reads = 0, stored = "Alice";
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId !== read) { stored = "Alicia"; return { result: receipt() }; }
      if (++reads === 2) throw new Error("The worker stopped.");
      return { result: page(stored) };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    const region = screen.getByRole("region", { name: "People" });
    expect(await within(region).findByText("dohc could not load People.")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText("Alicia")).toBeTruthy();
    await waitFor(() => expect(mark("Name")).toBeNull());
  });

  it("reports malformed pages through Notices without rendering unapproved data", async () => {
    const { onError } = setup({ invoke: async () => ({ result: { rows: [{ id: 1, version: "bad", values: { [secret]: "Hidden" } }], nextCursor: null } }) });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("grid")).toBeNull(); expect(screen.queryByText("Hidden")).toBeNull();
    expect(onError.mock.calls[0]![2]).toBeTypeOf("function");
  });

  it("ignores a pending read when the workspace changes", async () => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.workspaceId === "workspace-A" ? pending.promise : Promise.resolve({ result: page("Workspace B") }));
    const { props, rerender } = setup({ invoke });
    rerender(<TransactionalCollectionPage {...props} workspaceId="workspace-B" />);
    await screen.findByText("Workspace B");
    await act(async () => { pending.resolve({ result: page("Workspace A") }); });
    expect(screen.queryByText("Workspace A")).toBeNull();
  });
});

it("draws each Button field as a labelled column after the fields, and in the record's details", async () => {
  const render = vi.fn((field: string, row: { id: string | number }) => <button type="button">{`${field} for record ${String(row.id)}`}</button>);
  setup({ buttons: { fields: ["Mark paid"], render } });
  const button = await screen.findByRole("button", { name: "Mark paid for record 1" });
  expect(cell("Mark paid").contains(button)).toBe(true);
  expect(screen.getAllByRole("columnheader").map(header => header.textContent)).toEqual(["", "Name", "Amount", "Status", "Mark paid"]);
  // A button stores no value to sort by, so its header is a label. Its cell takes no edit.
  expect(within(screen.getAllByRole("columnheader").at(-1)!).queryByRole("button")).toBeNull();
  fireEvent.click(cell("Mark paid"));
  press("Enter");
  expect(editor()).toBeNull();
  expect(within(within(openPanel()).getByTestId("record-buttons")).getByRole("button", { name: "Mark paid for record 1" })).toBeTruthy();
});

it("keeps an open record's panel, and the focus in it, when the records are read again", async () => {
  const render = (field: string, row: { id: string | number }) => <button type="button">{`${field} for record ${String(row.id)}`}</button>;
  let text = "Alice";
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page(text) }));
  const { props, rerender } = setup({ invoke, buttons: { fields: ["Mark paid"], render } });
  await screen.findByText("Alice");
  const record = openPanel();
  const button = within(record).getByRole("button", { name: "Mark paid for record 1" });
  button.focus();
  text = "Alice Paid";
  rerender(<TransactionalCollectionPage {...props} recordsVersion={1} />);
  await waitFor(() => expect(screen.getByRole("complementary", { name: "Alice Paid" })).toBe(record));
  expect(document.activeElement).toBe(button);
  // A record the new read no longer holds keeps its panel, which says so instead of showing old values.
  invoke.mockResolvedValue({ result: { rows: [], nextCursor: null } });
  rerender(<TransactionalCollectionPage {...props} recordsVersion={2} />);
  await waitFor(() => expect(within(panel()).getByRole("status").textContent).toBe("This record is no longer in this view. Close it, then search for it."));
});

it("shows records an automation changed in place, with no loading line, nothing disabled, and an open record kept open", async () => {
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page() }));
  const { props, rerender } = setup({ invoke });
  await screen.findByText("Alice");
  const record = openPanel();
  // An editor open in the panel stays open, with what it holds, while the record changes under it.
  fireEvent.click(propertyValue("Amount"));
  const input = propertyInput("Amount");
  fireEvent.change(input, { target: { value: "9" } });
  const reread = deferred<{ result: AppBackendJson }>();
  invoke.mockReturnValueOnce(reread.promise);
  rerender(<TransactionalCollectionPage {...props} recordsChanged={1} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Loading records…")).toBeNull();
  expect(screen.getByRole("region", { name: "People" }).getAttribute("aria-busy")).toBe("false");
  expect((screen.getAllByRole("button", { name: "New record" })[0]! as HTMLButtonElement).disabled).toBe(false);
  await act(async () => reread.resolve({ result: page("Alice Paid") }));
  expect(screen.getByRole("complementary", { name: "Alice Paid" })).toBe(record);
  expect(propertyInput("Amount")).toBe(input);
  expect(input.value).toBe("9");
  fireEvent.keyDown(input, { key: "Escape" });
  // A record the read left out keeps its panel open, which says so instead of showing old values.
  invoke.mockResolvedValueOnce({ result: { rows: [], nextCursor: null } });
  rerender(<TransactionalCollectionPage {...props} recordsChanged={2} />);
  await waitFor(() => expect(within(panel()).getByRole("status").textContent).toBe("This record is no longer in this view. Close it, then search for it."));
  invoke.mockResolvedValueOnce({ result: page("Alice Paid") });
  rerender(<TransactionalCollectionPage {...props} recordsChanged={3} />);
  await waitFor(() => expect(within(panel()).getByRole("heading", { name: "Alice Paid" })).toBeTruthy());
  expect(screen.queryByText("Loading records…")).toBeNull();
});

it("finishes a read and a read in place asked for in one render, and leaves nothing loading or disabled", async () => {
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page() }));
  const { props, rerender } = setup({ invoke });
  await screen.findByText("Alice");
  const first = deferred<{ result: AppBackendJson }>();
  invoke.mockReturnValueOnce(first.promise).mockResolvedValue({ result: page("Alice Paid") });
  rerender(<TransactionalCollectionPage {...props} recordsVersion={1} recordsChanged={1} />);
  expect(await screen.findByText("Loading records…")).toBeTruthy();
  await act(async () => first.resolve({ result: page() }));
  // The read in place waited for the other read, then ran.
  await screen.findByText("Alice Paid");
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(screen.queryByText("Loading records…")).toBeNull();
  expect((screen.getAllByRole("button", { name: "New record" })[0]! as HTMLButtonElement).disabled).toBe(false);
  expect(command("Refresh").getAttribute("aria-disabled")).toBeNull();
});

it("stands lines in for records not yet shown, and keeps the words while a shown page reloads", async () => {
  const first = deferred<{ result: AppBackendJson }>();
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page() }));
  invoke.mockReturnValueOnce(first.promise);
  const { props, rerender } = setup({ invoke });
  const opening = (await screen.findByText("Loading records…")).closest("[role=status]");
  expect(opening?.classList.contains("dohc-reveal-if-slow"), "a first open prints its loading words at once, over nothing").toBe(true);
  await act(async () => first.resolve({ result: page() }));
  await screen.findByText("Alice");
  const again = deferred<{ result: AppBackendJson }>();
  invoke.mockReturnValueOnce(again.promise);
  rerender(<TransactionalCollectionPage {...props} recordsVersion={1} />);
  expect((await screen.findByText("Loading records…")).tagName).toBe("P");
  expect(screen.getByText("Alice")).toBeTruthy();
  await act(async () => again.resolve({ result: page() }));
});

it("shows the ⚡ button before New record, and a ⚡ that names the automations on each field they set", async () => {
  const onToggle = vi.fn();
  setup({
    automations: { open: false, count: 2, onToggle, close: vi.fn() },
    fieldMarks: new Map([["Amount", ["Round the amount"]], ["Status", ["Review new people", "Stamp"]]]),
  });
  await screen.findByText("Alice");
  const toolbar = screen.getByTestId("collection-new-record").parentElement!;
  expect(within(toolbar).getAllByRole("button").map(button => button.textContent || button.getAttribute("aria-label"))).toEqual(["Search", "Automations2", "Manage Collection", "New record"]);
  fireEvent.click(screen.getByTestId("collection-automations-button"));
  expect(onToggle).toHaveBeenCalledOnce();
  const marks = within(grid()).getAllByTestId("table-field-mark");
  expect(marks.map(found => found.closest("button")?.textContent)).toEqual(["Amount", "Status"]);
  // The mark's words describe the field's sort control, and show on hover or keyboard focus.
  const sortStatus = screen.getByRole("button", { name: "Status" });
  expect(document.getElementById(sortStatus.getAttribute("aria-describedby")!)?.textContent).toBe('"Review new people" and "Stamp" set this field');
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(sortStatus);
  expect(screen.getByRole("tooltip").textContent).toBe('"Review new people" and "Stamp" set this field');
  fireEvent.blur(sortStatus);
  // The panel marks the same fields, with the same words.
  expect(within(openPanel()).getAllByTestId("table-field-mark").map(found => found.getAttribute("aria-label"))).toEqual(['"Round the amount" sets this field', '"Review new people" and "Stamp" set this field']);
});

describe("when the Collection's fields change", () => {
  /** The next revision of the fixture, changed by `change`. */
  const revised = (revision: number, change: (next: TransactionalDatasetDescription) => void = () => undefined) => {
    const next = dataset(); next.revision = revision; next.revisionSha256 = String(revision % 10).repeat(64); change(next); return next;
  };
  const field = (description: TransactionalDatasetDescription, fieldId: string) => description.tables[0]!.fields.find(entry => entry.fieldId === fieldId)!;
  const operation = (description: TransactionalDatasetDescription, operationId: string) => description.operations.find(entry => entry.operationId === operationId)!;
  const retype = (fieldId: string, type: "text" | "number") => (next: TransactionalDatasetDescription) => { field(next, fieldId).type = type; };
  const reads = (invoke: Invoke) => sent(invoke, read);
  const CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";
  const newRecord = () => fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));

  it("keeps the table, its search and its page, and reads the same records again in place", async () => {
    const current = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> =>
      request.revision === 2 ? current.promise : Promise.resolve({ result: page("Alice", true) }));
    const result = setup({ invoke }); await screen.findByText("Alice");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ali" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false));
    const table = grid(), box = screen.getByRole<HTMLInputElement>("searchbox");
    fireEvent.change(box, { target: { value: "Alice B" } }); box.focus();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    // The rows stay without the retyped field's old number, and nothing says the page is loading.
    expect(grid()).toBe(table);
    expect(within(table).getByText("Alice")).toBeTruthy();
    expect(within(table).queryByText("5")).toBeNull();
    expect(screen.queryByText("Loading records…")).toBeNull();
    expect(document.activeElement).toBe(box); expect(box.value).toBe("Alice B");
    expect(reads(invoke).at(-1)).toMatchObject({ revision: 2, input: { limit: 50, search: "Ali", after: { id: 1, value: "Alice" } } });
    await act(async () => current.resolve({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: "five", [status]: "New" } }], nextCursor: null } }));
    expect(within(table).getByText("five")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false);
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("goes back to the first page when the field it is sorted by changes", async () => {
    const invoke = vi.fn(async (_request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: page("Alice", true) }));
    const result = setup({ invoke }); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(reads(invoke).at(-1)!.input).toMatchObject({ sort: { fieldId: amount } }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false));
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    await waitFor(() => expect(reads(invoke).at(-1)!.revision).toBe(2));
    expect(reads(invoke).at(-1)!.input).toEqual({ limit: 50, sort: { fieldId: amount, direction: "asc" } });
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps an open record open, without the values of fields that changed, until the read fills them in", async () => {
    const current = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.revision === 2 ? current.promise : Promise.resolve({ result: page() }));
    const result = setup({ invoke }); await screen.findByText("Alice");
    const details = within(openPanel());
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    expect(details.getByText("Alice")).toBeTruthy();
    expect(details.queryByText("5")).toBeNull();
    await act(async () => current.resolve({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: "five", [status]: "New" } }], nextCursor: null } }));
    expect(details.getByText("five")).toBeTruthy();
  });

  it("drops a request sent under the old rules, never sends a value typed under a field's old type, and saves the next change under the new rules", async () => {
    const old = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return Promise.resolve({ result: request.revision === 1 ? twoRecords() : { rows: [{ id: 1, version: 2, values: { [name]: 42, [amount]: 5, [status]: "New" } }, { id: 2, version: 4, values: { [name]: 7, [amount]: 7, [status]: "New" } }], nextCursor: null } });
      return request.revision === 1 ? old.promise : Promise.resolve({ result: { id: 1, version: 3 } });
    });
    const result = setup({ invoke });
    await screen.findByText("Alice");
    // Record 2's change is in flight under revision 1. Record 1's waits behind it, unsent.
    type("Name", "Beatrice", 1);
    type("Name", "Alicia");
    expect(sent(invoke, edit)).toHaveLength(1);
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(name, "number"))} />);
    // The request in flight can't be confirmed under the new rules: a toast says to check the records, with nothing to retry.
    expect(result.onError.mock.calls.at(-1)![0]).toContain("Check the records");
    expect(result.onError.mock.calls.at(-1)![2]).toBeNull();
    expect(mark("Name", 1)).toBe("refused");
    expect(why("Name", 1)).toBe("The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.");
    // The change not sent yet was typed as text, and Name is a number now, so it is never sent. Both cells keep what was typed.
    expect(mark("Name")).toBe("refused");
    expect(why("Name")).toBe("This field changed, so dohc did not save this value. Enter a value the field takes.");
    expect([cell("Name").textContent, cell("Name", 1).textContent]).toEqual([expect.stringContaining("Alicia"), expect.stringContaining("Beatrice")]);
    await waitFor(() => expect(reads(invoke).at(-1)!.revision).toBe(2));
    // The old request's late answer changes nothing.
    await act(async () => old.resolve({ result: receipt(5, 2) }));
    expect(sent(invoke, edit)).toHaveLength(1);
    expect(result.onNotice).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
    expect(mark("Name", 1)).toBe("refused");
    // Dismissed, the cell shows what the record holds under the new type, and the next change saves under the new rules.
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(cell("Name").textContent).toBe("42"));
    type("Name", "43");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]).toMatchObject({ revision: 2, revisionSha256: "2".repeat(64), input: { id: 1, expectedVersion: 2, values: { [name]: 43 } } });
  });

  it("lists a value whose field is gone where the person can copy it, and clears it", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: twoRecords() })
      : sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt() }));
    const result = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Beatrice", 1);
    type("Amount", "9");
    // Amount leaves the Collection under the same revision's rules, before its change is sent.
    const without = dataset();
    without.tables[0]!.fields = without.tables[0]!.fields.filter(entry => entry.fieldId !== amount);
    for (const entry of without.operations) entry.fieldIds = entry.fieldIds.filter(fieldId => fieldId !== amount);
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={without} />);
    await act(async () => first.resolve({ result: receipt(5, 2) }));
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText("Amount of record 1")).toBeTruthy();
    expect(list.getByLabelText<HTMLInputElement>("Amount").value).toBe("9");
    expect(list.getByRole("alert").textContent).toBe("This field was removed, so dohc did not save this value.");
    expect(list.getByRole("button", { name: "Copy value" })).toBeTruthy();
    expect(sent(invoke, edit)).toHaveLength(1);
    fireEvent.click(list.getByRole("button", { name: "Clear value" }));
    expect(screen.queryByRole("group", { name: "Changes dohc did not confirm" })).toBeNull();
  });

  it("holds a change whose edit operation the rules took away, and gives its cell no way to change again", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: twoRecords() })
      : sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt() }));
    const result = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Beatrice", 1);
    type("Name", "Alicia");
    const readOnly = dataset();
    operation(readOnly, edit).fieldIds = [amount];
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={readOnly} />);
    await act(async () => first.resolve({ result: receipt(5, 2) }));
    await waitFor(() => expect(mark("Name")).toBe("refused"));
    expect(why("Name")).toBe("The Collection's rules no longer allow this change, so dohc did not save it.");
    expect(sent(invoke, edit)).toHaveLength(1);
    // The cell can't open an editor now, so the page lists the value with a copy of it.
    expect(within(screen.getByRole("group", { name: "Changes dohc did not confirm" })).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    fireEvent.click(cell("Name", 1));
    press("Enter");
    expect(editor()).toBeNull();
  });

  it("keeps a new record's typing in the panel, and asks to clear a value its field can no longer take before it saves the rest", async () => {
    const team = id(8);
    const result = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob"); typeDraft("Amount", "7"); typeDraft("Badge", "A1");
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={needingPanel(revised(2, next => {
      retype(amount, "text")(next); field(next, name).name = "Full name";
      next.tables[0]!.fields.push({ fieldId: team, name: "Team", type: "text", required: false, unique: false, default: "Blue" });
      operation(next, read).fieldIds.push(team); operation(next, create).fieldIds.push(team);
    }))} />);
    // A renamed field keeps its value. A field the rules add takes its default.
    expect(draftValue("Full name")).toBe("Bob");
    expect(draftValue("Team")).toBe("Blue");
    // The retyped field shows what was typed, read-only, with a way to copy it and one to clear it.
    const typed = within(draftPanel()).getByLabelText<HTMLInputElement>("Amount");
    expect(typed.readOnly).toBe(true); expect(typed.value).toBe("7");
    expect(screen.getByText(CHANGED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy value" })).toBeTruthy();
    // Create record writes nothing under the new type: it points at the field instead.
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(sent(result.invoke, create)).toHaveLength(0);
    expect(document.activeElement).toBe(typed);
    fireEvent.click(screen.getByRole("button", { name: "Clear value" }));
    // The field is a row again, with nothing in it, and the panel keeps focus.
    expect(draftValue("Amount")).toBe("Empty");
    expect(document.activeElement).toBe(draftPanel());
    expect(screen.queryByText(CHANGED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]).toMatchObject({
      revision: 2, input: { values: { [name]: "Bob", [amount]: null, [status]: "New", [team]: "Blue" } },
    });
  });

  it("flags a typed value only while its field can't take it, through changes in a row", async () => {
    const result = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob");
    fireEvent.click(within(draftField("Status")).getAllByRole("button")[0]!);
    fireEvent.click(within(draftField("Status").querySelector<HTMLElement>("[data-cell-editor]")!).getByText("Reviewed"));
    const show = (description: TransactionalDatasetDescription) => result.rerender(<TransactionalCollectionPage {...result.props} dataset={needingPanel(description)} />);
    const flagged = () => within(draftPanel()).queryAllByRole("textbox").filter(input => (input as HTMLInputElement).readOnly).map(input => input.getAttribute("aria-label"));
    // New options that still hold the value, and a field that stops being required, flag nothing.
    show(revised(2, next => { field(next, status).options = ["Reviewed", "Done"]; field(next, name).required = false; }));
    expect(flagged()).toEqual([]);
    // Options without the value, and a field that changes type, flag it.
    show(revised(3, next => { field(next, status).options = ["New", "Done"]; retype(name, "number")(next); }));
    expect(flagged()).toEqual(["Name", "Status"]);
    // Once the fields take the values again, they are what was typed, with nothing flagged.
    show(revised(4));
    expect(flagged()).toEqual([]);
    expect(draftValue("Name")).toBe("Bob");
    expect(draftValue("Status")).toBe("Reviewed");
  });

  it("keeps a new record whose change the rules no longer allow, and says so over its buttons", async () => {
    const result = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob");
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => { next.operations = next.operations.filter(entry => entry.operationId !== create); })} />);
    const draft = within(draftPanel());
    expect(draftValue("Name")).toBe("Bob");
    expect(draft.getByText("The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.")).toBeTruthy();
    expect(draft.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(draft.getByRole("button", { name: "Cancel" }));
    expect(noDraftPanel()).toBe(true);
  });

  it("keeps the table's new row and what it holds through a read in place, a sort, and a change to the fields, and reports a value whose field went", async () => {
    const result = setup(); await screen.findByText("Alice");
    typeNewRow("Bob", "Tab");
    fireEvent.keyDown(grid(), { key: "7" });
    fireEvent.change(cellEditor(), { target: { value: "7" } });
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    const held = () => newRowCells().map(cell => cell.textContent);
    // An automation changed records, so the page reads them again in place.
    result.rerender(<TransactionalCollectionPage {...result.props} recordsChanged={1} />);
    await waitFor(() => expect(reads(result.invoke)).toHaveLength(2));
    expect(held().slice(0, 2)).toEqual(["Bob", "7"]);
    // The table sorts, which reads the records again in another order.
    fireEvent.click(within(within(grid()).getAllByRole("columnheader")[1]!).getByRole("button"));
    await waitFor(() => expect(reads(result.invoke)).toHaveLength(3));
    await loaded();
    expect(held().slice(0, 2)).toEqual(["Bob", "7"]);
    // Amount leaves the Collection's reads and creates: its value goes to a notice, and the rest stays.
    result.rerender(<TransactionalCollectionPage {...result.props} recordsChanged={1} dataset={revised(2, next => { operation(next, read).fieldIds = [name, status]; operation(next, create).fieldIds = [name, status]; })} />);
    const words = "dohc did not save what you typed in the Amount field of the new record. The field changed, or a new record no longer takes it. You typed: Amount: 7";
    await waitFor(() => expect(result.onError).toHaveBeenCalledWith(words, expect.any(TextNotSavedError), null));
    expect(held()[0]).toBe("Bob");
    expect(sent(result.invoke, create)).toHaveLength(0);
  });

  it("gives back a value typed in a field the create no longer takes, says so on the row, and sends the rest", async () => {
    const result = setup(); await screen.findByText("Alice");
    typeNewRow("Bob", "Tab");
    fireEvent.keyDown(grid(), { key: "7" });
    fireEvent.change(cellEditor(), { target: { value: "7" } });
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    // The create stops taking Amount. The table still reads and shows the column.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => { operation(next, create).fieldIds = [name, status]; })} />);
    const words = "dohc did not save what you typed in the Amount field of the new record. The field changed, or a new record no longer takes it. You typed: Amount: 7";
    await waitFor(() => expect(result.onError).toHaveBeenCalledWith(words, expect.any(TextNotSavedError), null));
    // The row no longer shows a value it will not send, and says where the value went.
    expect(newRowCells().slice(0, 2).map(cell => cell.textContent)).toEqual(["Bob", ""]);
    expect(newRowNote()!.textContent).toContain("Amount changed, or a new record no longer takes it, so its value left this row. A notice has what you typed.");
    fireEvent.keyDown(grid(), { key: "Enter" });
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]).toMatchObject({ revision: 2, input: { values: { [name]: "Bob", [status]: "New" } } });
    expect(Object.keys((sent(result.invoke, create)[0]!.input as { values: object }).values)).toEqual([name, status]);
  });

  it("keeps a value an open editor saves into the row after the create stopped taking its field, and sends the rest", async () => {
    const result = setup(); await screen.findByText("Alice");
    typeNewRow("Bob", "Tab");
    fireEvent.keyDown(grid(), { key: "5" });
    fireEvent.change(cellEditor(), { target: { value: "58" } });
    // The create stops taking Amount while its editor is still open over the row.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => { operation(next, create).fieldIds = [name, status]; })} />);
    fireEvent.keyDown(cellEditor(), { key: "Enter" });
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(Object.keys((sent(result.invoke, create)[0]!.input as { values: object }).values)).toEqual([name, status]);
    const words = "dohc did not save part of the new record, because a new record in People no longer takes it. You typed: Amount: 58";
    expect(result.onError).toHaveBeenCalledWith(words, expect.any(TextNotSavedError), null);
  });

  it("sends no second create for a new row dohc could not confirm once the rules change: not on Enter, Try again, or close", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw new Error("Lost reply");
    });
    const result = setup({ invoke }); await screen.findByText("Alice");
    typeNewRow("Bob");
    await waitFor(() => expect(newRowNote()?.getAttribute("data-new-record-status")).toBe("unconfirmed"));
    // The first try may have run. The rules change, so its request can never be confirmed, and the queue lets it go.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2)} />);
    // The row goes: nothing is left on it to type in, to save with Enter, or to try again.
    await waitFor(() => expect(newRow()).toBeNull());
    fireEvent.keyDown(grid(), { key: "Enter" });
    // The page's list keeps what the row held, as for any change that may have run.
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe("Name: Bob, Status: New");
    expect(list.getByRole("alert").textContent).toBe("The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.");
    expect(list.queryByRole("button", { name: "Try again" })).toBeNull();
    result.unmount();
    await Promise.resolve();
    expect(sent(invoke, create)).toHaveLength(1);
  });

  it("sends no second create from the panel once the rules change while its create is out", async () => {
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> =>
      request.operationId === read ? Promise.resolve({ result: page() }) : new Promise<never>(() => undefined));
    const result = setup({ invoke, dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(1));
    // The rules change while the create is with the host. Its request can never be confirmed, and it may have run.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={needingPanel(revised(2))} />);
    // The panel goes: it offers no Create record that would send the record again under a new key.
    await waitFor(() => expect(noDraftPanel()).toBe(true));
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe("Name: Bob, Status: New, Badge: A1");
    expect(list.getByRole("alert").textContent).toBe("The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.");
    expect(list.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(sent(invoke, create)).toHaveLength(1);
  });

  it("sends no second create when the host answers a retried create with changed rules", async () => {
    let writes = 0;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (++writes === 1) throw new Error("Lost reply");
      throw Object.assign(new Error("The Collection's rules changed. Its owner must approve this access again."), { name: "DatasetHostError", code: "conflict" });
    });
    const result = setup({ invoke }); await screen.findByText("Alice");
    typeNewRow("Bob");
    await waitFor(() => expect(newRowNote()?.getAttribute("data-new-record-status")).toBe("unconfirmed"));
    fireEvent.click(within(newRowNote()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    // The same request went twice, and the first may have run: the row does not come back for typing.
    await waitFor(() => expect(newRow()).toBeNull());
    expect(sent(invoke, create)[1]).toEqual(sent(invoke, create)[0]);
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe("Name: Bob, Status: New");
    result.unmount();
    await Promise.resolve();
    expect(sent(invoke, create)).toHaveLength(2);
  });

  it("keeps Undo last edit while its fields still take its values, and drops it once one can't", async () => {
    const result = setup();
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await screen.findByRole("button", { name: "Undo last edit" });
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => { field(next, amount).name = "Total"; field(next, name).required = false; })} />);
    await waitFor(() => expect(reads(result.invoke).at(-1)!.revision).toBe(2));
    expect(screen.getByRole("button", { name: "Undo last edit" })).toBeTruthy();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(3, retype(name, "number"))} />);
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });

  it("shows the refusal when the view sorts or filters by a field that is gone", async () => {
    const activeView = { viewId: id(30), name: "By amount", kind: "table" as const, search: "", filters: [{ fieldId: amount, value: 5 }], sort: { fieldId: amount, direction: "asc" as const } };
    const refusal = Error("This view names a field that is gone.");
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => { if (request.revision === 2) throw refusal; return { result: page() }; });
    const result = setup({ invoke, activeView }); await screen.findByText("Alice");
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => {
      next.tables[0]!.fields = next.tables[0]!.fields.filter(entry => entry.fieldId !== amount);
      for (const entry of next.operations) entry.fieldIds = entry.fieldIds.filter(fieldId => fieldId !== amount);
    })} />);
    await waitFor(() => expect(result.onError).toHaveBeenCalledWith("dohc could not load People.", refusal, expect.any(Function), `collection-load:${id(1)}:${id(2)}`));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Loading records…")).toBeNull();
  });

  it("reads once for a burst of changes, and stops the reads each newer change makes stale", async () => {
    const pending = new Map<number, ReturnType<typeof deferred<{ result: AppBackendJson }>>>(), signals = new Map<number, AbortSignal>();
    const invoke = vi.fn((request: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }> => {
      if (request.revision === 1) return Promise.resolve({ result: page() });
      const reply = deferred<{ result: AppBackendJson }>(); pending.set(request.revision, reply); signals.set(request.revision, signal); return reply.promise;
    });
    const result = setup({ invoke }); await screen.findByText("Alice");
    for (const revision of [2, 3, 4]) result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(revision)} />);
    expect([2, 3, 4].map(revision => signals.get(revision)?.aborted)).toEqual([true, true, false]);
    await act(async () => { pending.get(4)!.resolve({ result: page("Current") }); pending.get(2)!.resolve({ result: page("Stale") }); });
    expect(screen.getByText("Current")).toBeTruthy(); expect(screen.queryByText("Stale")).toBeNull();
  });

  it("keeps everything while the Collection goes offline and comes back", async () => {
    const result = setup(); await screen.findByText("Alice");
    type("Name", "Alicia");
    await screen.findByRole("button", { name: "Undo last edit" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ali" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(reads(result.invoke).at(-1)!.input).toMatchObject({ search: "Ali" }));
    await loaded();
    const record = openPanel();
    const table = screen.getByRole("grid", { hidden: true });
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(screen.getByRole("grid", { hidden: true })).toBe(table);
    expect(panel()).toBe(record);
    expect(screen.getByRole<HTMLInputElement>("searchbox", { hidden: true }).value).toBe("Ali");
    await waitFor(() => expect(reads(result.invoke).at(-1)!.input).toMatchObject({ search: "Ali" }));
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: false, savedAtMs: 2 }} />);
    expect(screen.getByRole("grid", { hidden: true })).toBe(table);
    expect(panel()).toBe(record);
    expect(screen.getByRole("button", { name: "Undo last edit", hidden: true })).toBeTruthy();
  });

  it("pauses an open cell editor with what it holds while the Collection is offline, and saves it once it is back", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    const input = editorInput();
    fireEvent.change(input, { target: { value: "Alicia" } });
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(editorInput()).toBe(input);
    expect([input.value, input.matches(":disabled")]).toEqual(["Alicia", true]);
    fireEvent.blur(input);
    expect(sent(result.invoke, edit)).toHaveLength(0);
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: false, savedAtMs: 2 }} />);
    expect(editorInput()).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent(result.invoke, edit)).toHaveLength(1));
    expect(sent(result.invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });
  });

  it("keeps a new record's typing in the panel while the Collection is offline, and saves it once it is back", async () => {
    const result = setup({ dataset: needingPanel(dataset()) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(draftValue("Name")).toBe("Bob");
    expect(within(draftPanel()).getByText("You can save this once the Collection is back online.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(true);
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: false, savedAtMs: 2 }} />);
    expect(draftValue("Name")).toBe("Bob");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
  });

  it("keeps a field being edited in the panel, and its focus, through a field change, while offline, and when its edit is gone", async () => {
    const result = setup(); await screen.findByText("Alice");
    const record = openPanel();
    fireEvent.click(propertyValue("Amount"));
    const input = propertyInput("Amount");
    fireEvent.change(input, { target: { value: "9" } }); input.focus();
    const show = (description: TransactionalDatasetDescription, offline = false) =>
      result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} copy={offline ? { offline: true, savedAtMs: 1 } : undefined} />);
    // A rename elsewhere keeps the panel, the editor and the focus in it.
    show(revised(2, next => { field(next, status).name = "Stage"; }));
    expect(panel()).toBe(record);
    expect(within(record).getByRole("group", { name: "Stage" })).toBeTruthy();
    expect(propertyInput("Amount")).toBe(input);
    expect(document.activeElement).toBe(input);
    // Offline, the editor waits with what it holds.
    show(revised(3), true);
    expect(propertyInput("Amount")).toBe(input);
    expect([input.value, input.matches(":disabled")]).toEqual(["9", true]);
    // Back online with no edit action, saving keeps the value on the field and says why.
    show(revised(4, next => { next.operations = next.operations.filter(entry => entry.operationId !== edit); }));
    expect(propertyInput("Amount")).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(within(property("Amount")).getByRole("note").textContent).toContain("The Collection's rules no longer allow this change, so dohc did not save it.");
    expect(property("Amount").textContent).toContain("9");
    expect(sent(result.invoke, edit)).toHaveLength(0);
  });

  it.each([
    ["the Collection goes offline", (): Partial<React.ComponentProps<typeof TransactionalCollectionPage>> => ({ copy: { offline: true, savedAtMs: 1 } })],
    ["its edit is gone", (): Partial<React.ComponentProps<typeof TransactionalCollectionPage>> => ({ dataset: revised(2, next => { next.operations = next.operations.filter(entry => entry.operationId !== edit); }) })],
  ])("keeps a name being typed in the panel's heading on its field, and sends none of it, when %s", async (_when, change) => {
    const result = setup(); await screen.findByText("Alice");
    openPanel();
    typeName("Alicia");
    result.rerender(<TransactionalCollectionPage {...result.props} {...change()} />);
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(within(panel()).getByRole("heading").textContent).toBe("Alicia");
    expect(within(panel()).getByRole("note").textContent).toContain(LEFT_OPEN);
    expect([mark("Name"), why("Name")]).toEqual(["refused", LEFT_OPEN]);
    expect(sent(result.invoke, edit)).toHaveLength(0);
  });

  it("keeps a name being typed with the field it was typed for when another field becomes the record's name, and sends it to neither field", async () => {
    const result = setup(); await screen.findByText("Alice");
    openPanel();
    typeName("Alicia");
    // The rules stop showing Name, so Private note, the next text field, heads the record.
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => {
      operation(next, read).fieldIds = [amount, status, secret];
      operation(next, edit).fieldIds = [amount, secret];
    })} />);
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(within(strip()!).getByText("Name of record 1")).toBeTruthy();
    expect(within(strip()!).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(within(strip()!).getByRole("alert").textContent).toBe(LEFT_OPEN);
    expect(sent(result.invoke, edit)).toHaveLength(0);
  });

  it("keeps what was typed in a panel field where the person can copy it when the field goes", async () => {
    const result = setup(); await screen.findByText("Alice");
    openPanel();
    fireEvent.click(propertyValue("Amount"));
    fireEvent.change(propertyInput("Amount"), { target: { value: "9" } });
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => {
      next.tables[0]!.fields = next.tables[0]!.fields.filter(entry => entry.fieldId !== amount);
      for (const entry of next.operations) entry.fieldIds = entry.fieldIds.filter(fieldId => fieldId !== amount);
    })} />);
    expect(within(panel()).queryByRole("group", { name: "Amount" })).toBeNull();
    expect(within(strip()!).getByLabelText<HTMLInputElement>("Amount").value).toBe("9");
    expect(within(strip()!).getByRole("button", { name: "Copy value" })).toBeTruthy();
    expect(sent(result.invoke, edit)).toHaveLength(0);
  });

  it("keeps a value on its field in the panel, with why, when the rules change while its change is in flight", async () => {
    const old = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.revision === 1 ? "Alice" : "Current records") }) : old.promise);
    const result = setup({ invoke });
    await screen.findByText("Alice");
    openPanel();
    typeInPanel("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2)} />);
    expect(result.onError.mock.calls.at(-1)![0]).toContain("Check the records");
    // The value stays on the field, in the panel and in the table, and can be saved again under the new rules.
    expect(within(property("Amount")).getByRole("note").textContent).toContain("The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.");
    expect(property("Amount").textContent).toContain("9");
    expect(mark("Amount")).toBe("refused");
    await act(async () => old.resolve({ result: receipt() }));
    expect(sent(invoke, edit)).toHaveLength(1);
    expect(result.onNotice).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });

  it("offers the related records of a relation field's new table once its table changes", async () => {
    const team = id(8);
    const relation = (tableId: string) => (next: TransactionalDatasetDescription) => {
      next.tables[0]!.fields.push({ fieldId: team, name: "Team", type: "relation", required: false, unique: false, relation: { datasetId: id(1), tableId, fieldId: id(40), many: false } });
      operation(next, create).fieldIds.push(team);
    };
    const resolveRelation = vi.fn(async () => ({ options: [{ value: 1, label: resolveRelation.mock.calls.length > 1 ? "Blue team" : "Old team" }], hasMore: false }));
    const result = setup({ resolveRelation, dataset: needingPanel(revised(1, relation(id(41)))) }); await screen.findByText("Alice");
    newRecord();
    // The new record's relation opens the editor a record's does, in the panel.
    fireEvent.click(within(draftField("Team")).getByRole("button", { name: "Edit Team" }));
    expect(await screen.findByRole("button", { name: "Old team" })).toBeTruthy();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={needingPanel(revised(2, relation(id(42))))} />);
    expect(await screen.findByRole("button", { name: "Blue team" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Old team" })).toBeNull();
  });

  it("makes a record at once for a create action that takes no fields", async () => {
    const description = dataset(); description.operations.find(entry => entry.operationId === create)!.fieldIds = [];
    const result = setup({ dataset: description }); await screen.findByText("Alice");
    newRecord();
    // The table has no field to type in, so there is no row to offer and nothing to ask.
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]!.input).toEqual({ values: {} });
    expect(newRow()).toBeNull();
    expect(noDraftPanel()).toBe(true);
  });

  it("saves a value emptied under a field's old type as that field's empty value under its new one", async () => {
    const description = dataset(); description.operations.find(entry => entry.operationId === create)!.fieldIds.push(secret);
    const result = setup({ dataset: needingPanel(description) }); await screen.findByText("Alice");
    newRecord();
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    typeDraft("Private note", "x");
    typeDraft("Private note", "");
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={needingPanel(revised(2, next => { operation(next, create).fieldIds.push(secret); retype(secret, "number")(next); }))} />);
    // The emptied value is no value its field cannot take, so nothing is flagged.
    expect(within(draftPanel()).queryAllByRole("textbox")).toEqual([]);
    expect(draftValue("Private note")).toBe("Empty");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(sent(result.invoke, create)).toHaveLength(1));
    expect(sent(result.invoke, create)[0]).toMatchObject({ revision: 2, input: { values: { [name]: "Bob", [secret]: null } } });
  });

  it("leaves the caret where it is in a cell being edited when another field changes", async () => {
    const result = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    const input = editorInput();
    fireEvent.change(input, { target: { value: "Alicia" } });
    input.setSelectionRange(1, 1);
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    expect(editorInput()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect([input.value, input.selectionStart]).toEqual(["Alicia", 1]);
  });
});

/** One of two pages of the same table, by the element that holds it. */
function tableIn(root: HTMLElement) {
  const table = () => within(root).getByRole("grid");
  const at = (field: string, row = 0): HTMLElement => {
    const column = within(table()).getAllByRole("columnheader").findIndex(header => header.textContent === field);
    const found = column < 0 ? undefined : table().querySelectorAll<HTMLElement>(`[role="row"][data-index="${row}"] [role="gridcell"]`)[column];
    if (!found) throw new Error(`no ${field} cell in row ${row}`);
    return found;
  };
  return {
    cell: at,
    mark: (field: string, row = 0) => at(field, row).querySelector("[data-cell-status]")?.getAttribute("data-cell-status") ?? null,
    type(field: string, value: string, row = 0): void {
      fireEvent.click(at(field, row));
      const input = table().querySelector<HTMLInputElement>("[data-cell-editor] input")!;
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
    },
  };
}
const strip = () => screen.queryByRole("group", { name: "Changes dohc did not confirm" });
const NOT_FINISHED = "This edit was still open, so dohc did not save it.";
const RULES_CHANGED = "The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.";
const DISCARDED = "dohc could not confirm this change, and you discarded it. Check the record before you make the change again.";
const refusal = (words: string) => Object.assign(new Error(words), { code: "operation_refused" });

describe("one queue for a table's changes", () => {
  it("sends the changes not sent yet after its page closes and never opens again", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() })
      : sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt(4) }));
    const view = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    view.unmount();
    await act(async () => first.resolve({ result: receipt(3) }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 3, values: { [amount]: 9 } });
    await waitFor(() => expect(view.onNotice.mock.calls).toEqual([["Saved the edit in People"], ["Saved the edit in People"]]));
    // The closed page read nothing more.
    expect(sent(invoke, read)).toHaveLength(1);
  });

  it("shares one queue between two pages of a table opened one after the other, and each keeps working when the other closes", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    let stored = "Alice";
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page(stored) })
      : sent(invoke, edit).length === 1 ? answer.promise : Promise.resolve({ result: receipt(4) }));
    const first = setup({ invoke });
    await screen.findByText("Alice");
    const second = render(<TransactionalCollectionPage {...first.props} />);
    await waitFor(() => expect(screen.getAllByText("Alice")).toHaveLength(2));
    const a = tableIn(first.container), b = tableIn(second.container);
    a.type("Name", "Alicia");
    // The other page shows the same change on its cell.
    expect(b.mark("Name")).toBe("pending");
    expect(b.cell("Name").textContent).toContain("Alicia");
    // The first page closes. The change still ends, and the second page shows it and reads its records again.
    first.unmount();
    stored = "Alicia";
    await act(async () => answer.resolve({ result: receipt(3) }));
    await waitFor(() => expect(b.mark("Name")).toBeNull());
    expect(b.cell("Name").textContent).toBe("Alicia");
    expect(first.onNotice).not.toHaveBeenCalled();
    b.type("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toMatchObject({ id: 1, values: { [amount]: 9 } });
  });

  it("gives two pages of a table that open together one queue, which keeps sending when one of them closes", async () => {
    const answers = [deferred<{ result: AppBackendJson }>(), deferred<{ result: AppBackendJson }>()];
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() })
      : answers[sent(invoke, edit).length - 1]!.promise);
    const props = { workspaceId: "workspace-A", dataset: dataset(), tableId: id(2), invoke, onError: vi.fn(), onNotice: vi.fn() };
    openCollectionChangeShell(props.workspaceId, props);
    admitCollectionChanges(props.workspaceId);
    const left = <div key="left" data-testid="left"><TransactionalCollectionPage {...props} /></div>;
    const right = <div key="right" data-testid="right"><TransactionalCollectionPage {...props} /></div>;
    const view = render(<>{left}{right}</>);
    await waitFor(() => expect(screen.getAllByText("Alice")).toHaveLength(2));
    const a = tableIn(screen.getByTestId("left")), b = tableIn(screen.getByTestId("right"));
    a.type("Name", "Alicia");
    expect(b.mark("Name")).toBe("pending");
    b.type("Amount", "9");
    expect(a.mark("Amount")).toBe("pending");
    expect(sent(invoke, edit)).toHaveLength(1);
    // The left page closes. The right page's change still goes, after the left page's, on its receipt's version.
    view.rerender(<>{right}</>);
    await act(async () => answers[0]!.resolve({ result: receipt(3) }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 3, values: { [amount]: 9 } });
    await act(async () => answers[1]!.resolve({ result: receipt(4) }));
    await waitFor(() => expect([b.mark("Name"), b.mark("Amount")]).toEqual([null, null]));
    expect(props.onNotice).not.toHaveBeenCalled();
  });

  it("keeps the newer revision's rules when a page still on the older revision draws again, and sends an edit to a field only the newer one has", async () => {
    const tags = id(8), next = dataset();
    next.revision = 2; next.revisionSha256 = "b".repeat(64);
    next.tables[0]!.fields.push({ fieldId: tags, name: "Tags", type: "text", required: false, unique: false });
    for (const operationId of [read, edit]) next.operations.find(operation => operation.operationId === operationId)!.fieldIds.push(tags);
    const older = setup();
    await screen.findByText("Alice");
    const newer = render(<TransactionalCollectionPage {...older.props} dataset={next} />);
    await waitFor(() => expect(screen.getAllByText("Alice")).toHaveLength(2));
    older.rerender(<TransactionalCollectionPage {...older.props} />);
    tableIn(newer.container).type("Tags", "vip");
    await waitFor(() => expect(sent(older.invoke, edit)).toHaveLength(1));
    expect(sent(older.invoke, edit)[0]).toMatchObject({ revision: 2, revisionSha256: "b".repeat(64), input: { id: 1, expectedVersion: 2, values: { [tags]: "vip" } } });
    expect(newer.container.querySelector('[data-cell-status="refused"]')).toBeNull();
  });

  it.each([["first", 0], ["second", 1]] as const)("shows a new record the Collection refuses on the new row of the %s of two pages, which sent it, and nothing in the other", async (_which, maker) => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw refusal("Name is taken.");
    });
    const first = setup({ invoke });
    await screen.findByText("Alice");
    const second = render(<TransactionalCollectionPage {...first.props} />);
    await waitFor(() => expect(screen.getAllByText("Alice")).toHaveLength(2));
    const pages = [first.container, second.container];
    const sender = pages[maker]!, other = pages[1 - maker]!;
    typeNewRow("Bob", "Enter", sender);
    const note = () => sender.querySelector<HTMLElement>("[data-new-record-status]:not([data-new-record-status='pending'])");
    await waitFor(() => expect(note()?.textContent).toContain("The Collection refused this change. Name is taken."));
    // The row keeps what was typed, with Try again and Discard, and nothing shows it as saved.
    expect(sender.querySelector("[data-new-record]")!.textContent).toContain("Bob");
    expect(within(note()!).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(note()!).getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(other.querySelector("[data-new-record]")).toBeNull();
    expect(within(other).queryByRole("complementary")).toBeNull();
    expect(strip()).toBeNull();
    expect(sent(invoke, create)).toHaveLength(1);
    // Try again makes the record again, as one more create.
    fireEvent.click(within(note()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
  });

  it("drops a request sent under the old rules when its page opens again under new ones, and keeps what was typed", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw new Error("Lost reply");
    });
    const view = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    view.unmount();
    const next = dataset(); next.revision = 2; next.revisionSha256 = "b".repeat(64);
    render(<TransactionalCollectionPage {...view.props} dataset={next} />);
    await screen.findByText("Alicia");
    expect(mark("Name")).toBe("refused");
    expect(why("Name")).toBe(RULES_CHANGED);
    expect(sent(invoke, edit)).toHaveLength(1);
  });

  it("keeps a change dohc could not confirm, with its exact request, through Refresh and paging", async () => {
    let fail = true;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId !== read) { if (fail) throw new Error("Lost reply"); return { result: receipt() }; }
      const second = request.input !== null && typeof request.input === "object" && "after" in request.input;
      return { result: second ? { rows: [{ id: 2, version: 4, values: { [name]: "Bea", [amount]: 7, [status]: "New" } }], nextCursor: null } : page("Alice", true) };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    fireEvent.click(command("Refresh"));
    await waitFor(() => expect(sent(invoke, read)).toHaveLength(2));
    await loaded();
    expect(mark("Name")).toBe("unconfirmed");
    // On the next page no cell shows the change, so the page lists it above the table.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Bea");
    expect(within(strip()!).getByText("dohc could not confirm a change to record 1.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Alicia");
    expect(strip()).toBeNull();
    fail = false;
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]).toEqual(sent(invoke, edit)[0]);
  });

  it("keeps a confirmed value on its cell, and the next change on its receipt's version, when a read that started earlier returns the older record", async () => {
    const stale = deferred<{ result: AppBackendJson }>(), first = deferred<{ result: AppBackendJson }>(), second = deferred<{ result: AppBackendJson }>();
    let reads = 0;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return ++reads === 2 ? stale.promise : Promise.resolve({ result: page(reads > 2 ? "Alicia" : "Alice") });
      return sent(invoke, edit).length === 1 ? first.promise : second.promise;
    });
    const { props, rerender } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    // A read in place starts before the first change is confirmed, and answers after it.
    rerender(<TransactionalCollectionPage {...props} recordsChanged={1} />);
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => first.resolve({ result: receipt(7) }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    await act(async () => stale.resolve({ result: page("Alice") }));
    expect(cell("Name").textContent).toBe("AliciaSaving");
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 7, values: { [amount]: 9 } });
    await act(async () => second.resolve({ result: receipt(8) }));
    await waitFor(() => expect([mark("Name"), mark("Amount")]).toEqual([null, null]));
    expect(cell("Name").textContent).toBe("Alicia");
  });

  it("reverses only the last edit after several confirmed changes", async () => {
    let version = 2;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      const fields = Object.keys((request.input as { values: Record<string, AppBackendJson> }).values);
      return { result: { id: 1, version: ++version, priorValues: Object.fromEntries(fields.map(fieldId => [fieldId, fieldId === name ? "Alice" : 5])) } };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    const undo = await screen.findByRole<HTMLButtonElement>("button", { name: "Undo last edit" });
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(3));
    expect(sent(invoke, edit)[2]!.input).toEqual({ id: 1, expectedVersion: 4, values: { [amount]: 5 } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull());
  });

  it("sends nothing from Try again while the Collection is offline, and keeps the change for when it is back", async () => {
    let fail = true;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (fail) throw new Error("Lost reply");
      return { result: receipt() };
    });
    const { props, rerender } = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    rerender(<TransactionalCollectionPage {...props} copy={{ offline: true, savedAtMs: 1 }} />);
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    expect(mark("Name")).toBe("unconfirmed");
    expect(sent(invoke, edit)).toHaveLength(1);
    fail = false;
    rerender(<TransactionalCollectionPage {...props} copy={{ offline: false, savedAtMs: 2 }} />);
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]).toEqual(sent(invoke, edit)[0]);
  });
});

describe("what a change that did not save leaves for the person", () => {
  it("keeps text typed in a cell and not saved when its page closes, shows it on its cell, and never sends it by itself", async () => {
    const view = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    fireEvent.change(editorInput(), { target: { value: "Bob" } });
    view.unmount();
    render(<TransactionalCollectionPage {...view.props} />);
    await screen.findByText("Bob");
    expect(mark("Name")).toBe("refused");
    expect(why("Name")).toBe(NOT_FINISHED);
    expect(sent(view.invoke, edit)).toHaveLength(0);
    // The next edit of the cell starts from what was typed, and saves it.
    fireEvent.click(cell("Name"));
    expect(editorInput().value).toBe("Bob");
    fireEvent.keyDown(editorInput(), { key: "Enter" });
    await waitFor(() => expect(sent(view.invoke, edit)).toHaveLength(1));
    expect(sent(view.invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Bob" } });
  });

  it("sends nothing when its page closes under a focused cell editor, where the browser blurs the input as it removes it, and keeps the text on its cell", async () => {
    const view = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    const input = editorInput();
    fireEvent.change(input, { target: { value: "Bob" } });
    expect(document.activeElement).toBe(input);
    // Chromium has blurred a focused element as it left the page. jsdom does not, so the test does it for jsdom.
    const blurred = vi.fn();
    input.addEventListener("focusout", blurred);
    const removeChild = Node.prototype.removeChild;
    const removal = vi.spyOn(Node.prototype, "removeChild").mockImplementation(function (this: Node, child: Node) {
      if (input.isConnected && child.contains(input)) fireEvent.blur(input);
      return removeChild.call(this, child);
    } as typeof Node.prototype.removeChild);
    view.unmount();
    removal.mockRestore();
    expect(blurred).toHaveBeenCalled();
    expect(sent(view.invoke, edit)).toHaveLength(0);
    render(<TransactionalCollectionPage {...view.props} />);
    await screen.findByText("Bob");
    expect([mark("Name"), why("Name")]).toEqual(["refused", NOT_FINISHED]);
    expect(sent(view.invoke, edit)).toHaveLength(0);
  });

  it("saves the text of a cell editor that focus left while its page was open, as a press on another control does, before the page closes", async () => {
    const view = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    fireEvent.change(editorInput(), { target: { value: "Bob" } });
    fireEvent.blur(editorInput());
    view.unmount();
    await waitFor(() => expect(sent(view.invoke, edit)).toHaveLength(1));
    expect(sent(view.invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Bob" } });
  });

  it("lists a deletion the Collection refused, by the record's name and with why, until the person dismisses it", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === remove) throw refusal("Paid records stay.");
      return { result: page() };
    });
    const view = setup({ invoke, confirmDelete: async () => true });
    await screen.findByText("Alice");
    openPanel();
    fireEvent.click(recordCommand("Delete record…"));
    const words = "dohc did not delete Alice. The Collection refused this change. Paid records stay.";
    const line = await screen.findByText(words);
    expect(strip()!.contains(line)).toBe(true);
    // It stays after the page closes and opens again, since a deletion leaves no value on a cell.
    view.unmount();
    render(<TransactionalCollectionPage {...view.props} />);
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText(words)).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Dismiss" }));
    expect(strip()).toBeNull();
    expect(sent(invoke, remove)).toHaveLength(1);
  });

  it("keeps text typed in a cell and not saved on its record and field when the records are sorted another way", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      const { rows } = twoRecords() as { rows: AppBackendJson[] };
      const descending = (request.input as { sort?: { direction: string } }).sort?.direction === "desc";
      return { result: { rows: descending ? rows.reverse() : rows, nextCursor: null } };
    });
    const view = setup({ invoke });
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    fireEvent.change(editorInput(), { target: { value: "Alicia" } });
    view.unmount();
    // The page opens again in a saved view that sorts the other way, so Alice's record is in the second row.
    render(<TransactionalCollectionPage {...view.props} activeView={{ viewId: id(30), name: "Last first", kind: "table", search: "", filters: [], sort: { fieldId: name, direction: "desc" } }} />);
    await screen.findByText("Alicia");
    expect([cell("Name").textContent, mark("Name")]).toEqual(["Bea", null]);
    expect(cell("Name", 1).textContent).toContain("Alicia");
    expect([mark("Name", 1), why("Name", 1)]).toEqual(["refused", NOT_FINISHED]);
    // The header's next press clears the sort, and the text goes back to the first row with its record.
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(cell("Name").textContent).toContain("Alicia"));
    expect([mark("Name"), mark("Name", 1)]).toEqual(["refused", null]);
    expect(cell("Name", 1).textContent).toBe("Bea");
    expect(sent(invoke, edit)).toHaveLength(0);
  });

  it("keeps nothing of an open cell editor in which nothing was typed", async () => {
    const view = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    view.unmount();
    render(<TransactionalCollectionPage {...view.props} />);
    await screen.findByText("Alice");
    expect(mark("Name")).toBeNull();
  });

  it("lists text typed in an open cell above the table, with Copy and Clear, when its field is removed", async () => {
    const result = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Amount"));
    fireEvent.change(editorInput(), { target: { value: "12" } });
    const without = dataset();
    without.tables[0]!.fields = without.tables[0]!.fields.filter(entry => entry.fieldId !== amount);
    for (const entry of without.operations) entry.fieldIds = entry.fieldIds.filter(fieldId => fieldId !== amount);
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={without} />);
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText("Amount of record 1")).toBeTruthy();
    expect(list.getByLabelText<HTMLInputElement>("Amount").value).toBe("12");
    expect(list.getByRole("alert").textContent).toBe(NOT_FINISHED);
    expect(list.getByRole("button", { name: "Copy value" })).toBeTruthy();
    expect(sent(result.invoke, edit)).toHaveLength(0);
    fireEvent.click(list.getByRole("button", { name: "Clear value" }));
    expect(strip()).toBeNull();
  });

  it("lists text typed in an open cell above the table when a read no longer returns its record", async () => {
    const { invoke, props, rerender } = setup();
    await screen.findByText("Alice");
    fireEvent.click(cell("Name"));
    fireEvent.change(editorInput(), { target: { value: "Bob" } });
    invoke.mockResolvedValueOnce({ result: { rows: [], nextCursor: null } });
    rerender(<TransactionalCollectionPage {...props} recordsChanged={1} />);
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText("Name of record 1")).toBeTruthy();
    expect(list.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    expect(sent(invoke, edit)).toHaveLength(0);
  });

  it("shows the later value when an earlier change to the same cell is refused and the later one is confirmed", async () => {
    let stored = "Alice";
    const first = deferred<{ result: AppBackendJson }>(), second = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page(stored) })
      : sent(invoke, edit).length === 1 ? first.promise : second.promise);
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "first");
    type("Name", "second");
    await act(async () => first.reject(refusal("This record changed. Refresh the table.")));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    stored = "second";
    await act(async () => second.resolve({ result: receipt(3) }));
    await waitFor(() => expect(mark("Name")).toBeNull());
    expect(cell("Name").textContent).toBe("second");
    expect(strip()).toBeNull();
  });

  it("offers Try again above the table when a cell dohc could not confirm is edited again", async () => {
    let fail = true;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (fail) throw new Error("Lost reply");
      return { result: receipt(9) };
    });
    setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    expect(strip()).toBeNull();
    // The cell now shows the later value, which waits, so it can't offer the earlier change's Try again.
    type("Name", "Alison");
    expect(mark("Name")).toBe("waiting");
    const list = within(strip()!);
    expect(list.getByText("dohc could not confirm a change to record 1.")).toBeTruthy();
    fail = false;
    fireEvent.click(list.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(3));
    const writes = sent(invoke, edit);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[2]!.input).toEqual({ id: 1, expectedVersion: 9, values: { [name]: "Alison" } });
  });

  /** The fixture with a primary key the read returns, so one record can be read by it. */
  const member = id(9);
  function keyed(): TransactionalDatasetDescription {
    const description = dataset();
    description.tables[0]!.primaryKeyFieldId = member;
    description.tables[0]!.fields.push({ fieldId: member, name: "Member", type: "text", required: true, unique: true });
    description.operations.find(operation => operation.operationId === read)!.fieldIds.push(member);
    return description;
  }
  const byKey = (request: TransactionalInvoke) => request.input !== null && typeof request.input === "object" && "filters" in request.input;

  it("holds a record's next change until a read by its key returns its version, when the page's read leaves the record out", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    let moved = false;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return Promise.resolve({ result: byKey(request) ? { rows: [{ id: 1, version: 8, values: { [name]: "Alicia" } }], nextCursor: null } : moved ? { rows: [], nextCursor: null } : page() });
      return sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt(9) });
    });
    setup({ dataset: keyed(), invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    // The first change moves the record out of the page's search, and its receipt reports no version.
    moved = true;
    await act(async () => first.resolve({ result: null }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, read).filter(byKey).map(request => request.input)).toEqual([{ limit: 1, filters: [{ fieldId: member, value: 1 }] }]);
    expect(sent(invoke, edit)[1]!.input).toEqual({ id: 1, expectedVersion: 8, values: { [amount]: 9 } });
  });

  it("drops the changes queued for a record that is no longer in the Collection, and keeps what was typed", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    let gone = false;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return Promise.resolve({ result: gone ? { rows: [], nextCursor: null } : page() });
      return sent(invoke, edit).length === 1 ? first.promise : Promise.resolve({ result: receipt(9) });
    });
    setup({ dataset: keyed(), invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    type("Amount", "9");
    gone = true;
    await act(async () => first.resolve({ result: null }));
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByText("Amount of record 1")).toBeTruthy();
    expect(list.getByLabelText<HTMLInputElement>("Amount").value).toBe("9");
    expect(list.getByRole("alert").textContent).toBe("This record is no longer in the Collection, so dohc did not save this change.");
    expect(sent(invoke, edit)).toHaveLength(1);
  });

  it("drops a change its host refuses because the Collection's rules changed, keeps what was typed, and reads the Collection again", async () => {
    // What the renderer gets from main when the host answers a request that names rules it has replaced.
    const stale = new Error("Error invoking remote method 'dataset': DatasetHostError [conflict]: The Collection's rules changed. Its owner must approve this access again.");
    const onRefresh = vi.fn();
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw stale;
    });
    const { onError } = setup({ invoke, onRefresh });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("refused"));
    expect(why("Name")).toBe(RULES_CHANGED);
    expect(cell("Name").textContent).toContain("Alicia");
    // Nothing offers to send the same request again, and the page asks for the Collection's rules.
    expect(within(cell("Name")).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(onError.mock.calls.at(-1)![2]).toBeNull();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(sent(invoke, edit)).toHaveLength(1);
  });

  it("discards a change dohc could not confirm after Try again fails, keeps what was typed, and sends the next change with the version a fresh read returns", async () => {
    let version = 2;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: { rows: [{ id: 1, version, values: { [name]: "Alice", [amount]: 5, [status]: "New" } }], nextCursor: null } };
      // The change to Name lands, and its answer never arrives.
      if (Object.hasOwn((request.input as { values: Record<string, AppBackendJson> }).values, name)) { version = 5; throw new Error("Lost reply"); }
      return { result: receipt(6) };
    });
    const onSettled = vi.fn();
    const { onError } = setup({ invoke, onSettled });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    const reads = sent(invoke, read).length;
    fireEvent.click(within(cell("Name")).getByRole("button", { name: "Discard" }));
    // The cell keeps what was typed, and says to check the record. Its row in Notices goes.
    expect(mark("Name")).toBe("refused");
    expect(why("Name")).toBe(DISCARDED);
    expect(cell("Name").textContent).toContain("Alicia");
    expect(onSettled).toHaveBeenCalledWith(onError.mock.calls[0]![3]);
    await act(async () => onError.mock.calls[0]![2]!());
    expect(sent(invoke, edit)).toHaveLength(2);
    // The record's next change waits for a read, and goes with the version that read returns and a key of its own.
    type("Amount", "9");
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(3));
    expect(sent(invoke, read).length).toBeGreaterThan(reads);
    expect(sent(invoke, edit)[2]!.input).toEqual({ id: 1, expectedVersion: 5, values: { [amount]: 9 } });
    expect(sent(invoke, edit)[2]!.idempotencyKey).not.toBe(sent(invoke, edit)[0]!.idempotencyKey);
  });

  it("offers Discard on a new row dohc could not confirm, and keeps its values above the table once it is discarded", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      throw new Error("Lost reply");
    });
    setup({ invoke });
    await screen.findByText("Alice");
    typeNewRow("Bob");
    await waitFor(() => expect(newRowNote()?.getAttribute("data-new-record-status")).toBe("unconfirmed"));
    expect(strip()).toBeNull();
    fireEvent.click(within(newRowNote()!).getByRole("button", { name: "Discard" }));
    // The row goes. The record may have saved, so what it held stays for the person to check.
    expect(newRow()).toBeNull();
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe("Name: Bob, Status: New");
    expect(list.getByRole("alert").textContent).toBe(DISCARDED);
    fireEvent.click(list.getByRole("button", { name: "Clear value" }));
    expect(strip()).toBeNull();
    expect(sent(invoke, create)).toHaveLength(1);
  });

  /** A new record whose first answer is lost, and which the Collection then refuses. */
  function refusedCreate() {
    let writes = 0;
    return vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (++writes === 1) throw new Error("Lost reply");
      throw refusal("Name is taken.");
    });
  }
  /** Saves a new row named Bob, and waits for the row to say dohc could not confirm it. */
  async function createBob(): Promise<void> {
    typeNewRow("Bob");
    await waitFor(() => expect(newRowNote()?.getAttribute("data-new-record-status")).toBe("unconfirmed"));
  }

  const REFUSED_TAKEN = "The Collection refused this change. Name is taken.";
  /** The page's list holds the new record with why, to copy, and nothing on the page can send it again. */
  async function expectListedOnly(values: string) {
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe(values);
    expect(list.getByRole("alert").textContent).toBe(REFUSED_TAKEN);
    expect(list.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(newRow()).toBeNull();
    expect(noDraftPanel()).toBe(true);
  }

  it("never brings a new row back for typing once its answer was missing, even when the Collection then refuses the retry", async () => {
    const invoke = refusedCreate();
    const view = setup({ invoke });
    await screen.findByText("Alice");
    await createBob();
    fireEvent.click(within(newRowNote()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    // The first try may have run, whatever the retry answers. The row goes, and the page's list keeps what it held.
    await waitFor(() => expect(newRow()).toBeNull());
    await expectListedOnly("Name: Bob, Status: New");
    // Nothing sends a third create: not Enter, and not closing the page.
    fireEvent.keyDown(grid(), { key: "Enter" });
    view.unmount();
    await Promise.resolve();
    expect(sent(invoke, create)).toHaveLength(2);
  });

  it("opens no new record for typing when the Collection refuses a create whose answer was once missing, with no row left to show it", async () => {
    const invoke = refusedCreate();
    const view = setup({ invoke });
    await screen.findByText("Alice");
    await createBob();
    // The page closes and opens again: its list has the change the row showed.
    view.unmount();
    render(<TransactionalCollectionPage {...view.props} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "Changes dohc did not confirm" })).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    await expectListedOnly("Name: Bob, Status: New");
  });

  it("opens no new record for typing when the Collection refuses the retry of a panel's create whose answer was missing", async () => {
    const invoke = refusedCreate();
    setup({ invoke, dataset: needingPanel(dataset()) });
    await screen.findByText("Alice");
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    typeDraft("Name", "Bob"); typeDraft("Badge", "A1");
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    // dohc could not confirm it: the panel closes, and the list has the change with its Try again.
    fireEvent.click(within(await screen.findByRole("group", { name: "Changes dohc did not confirm" })).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    await expectListedOnly("Name: Bob, Status: New, Badge: A1");
    expect(sent(invoke, create)[1]).toEqual(sent(invoke, create)[0]);
  });

  it("keeps what a new row held in the list of unsaved changes when its table closes after the window showed another workspace", async () => {
    const view = setup();
    await screen.findByText("Alice");
    typeNewRow("Bob", "Tab");
    fireEvent.keyDown(grid(), { key: "a" });
    fireEvent.change(cellEditor(), { target: { value: "abc" } });
    // The window switches workspaces: this workspace's shell closes, and takes no notice.
    closeCollectionChangeShellsForTests();
    view.unmount();
    await Promise.resolve();
    // A word in a number field stops the save. Everything the row held is kept, with the word under its field.
    expect(sent(view.invoke, create)).toHaveLength(0);
    expect(collectionWriteFailures().map(failure => [failure.workspaceId, failure.collectionPath, failure.change.field, failure.change.value, failure.message])).toEqual([
      ["workspace-A", "People", "New record", { Name: "Bob", Status: "New", Amount: "abc" }, "dohc did not create this record. Enter a value Amount can take. Copy what you typed before discarding it."],
    ]);
    expect(view.onError).not.toHaveBeenCalled();
  });

  it("keeps a new row a required field stops in the list of unsaved changes when its table closes after the window showed another workspace", async () => {
    const view = setup();
    await screen.findByText("Alice");
    // Name is left empty, and Amount is typed.
    fireEvent.click(within(grid()).getByRole("button", { name: "New record" }));
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    fireEvent.keyDown(grid(), { key: "7" });
    fireEvent.change(cellEditor(), { target: { value: "7" } });
    fireEvent.keyDown(cellEditor(), { key: "Tab" });
    closeCollectionChangeShellsForTests();
    view.unmount();
    await Promise.resolve();
    expect(sent(view.invoke, create)).toHaveLength(0);
    expect(collectionWriteFailures().map(failure => [failure.workspaceId, failure.collectionPath, failure.change.field, failure.change.value, failure.message])).toEqual([
      ["workspace-A", "People", "New record", { Amount: 7, Status: "New" }, "dohc did not create this record. Enter Name. Copy what you typed before discarding it."],
    ]);
    expect(view.onError).not.toHaveBeenCalled();
  });

  it("keeps a new record the Collection refused after its page closed where the person can copy it", async () => {
    const invoke = refusedCreate();
    const view = setup({ invoke });
    await screen.findByText("Alice");
    await createBob();
    // The row the failure left in Notices sends the change again after the page closed.
    const [words, , retry, identity] = view.onError.mock.calls[0]!;
    expect([words, typeof identity]).toEqual(["dohc could not confirm this change.", "string"]);
    view.unmount();
    await act(async () => retry());
    await waitFor(() => expect(sent(invoke, create)).toHaveLength(2));
    await waitFor(() => expect(view.onError).toHaveBeenLastCalledWith("People refused the change. Open it to check its records.", expect.objectContaining({ code: "operation_refused" }), null));
    render(<TransactionalCollectionPage {...view.props} />);
    const list = within(await screen.findByRole("group", { name: "Changes dohc did not confirm" }));
    expect(list.getByLabelText<HTMLInputElement>("New record").value).toBe("Name: Bob, Status: New");
    expect(list.getByRole("alert").textContent).toBe("The Collection refused this change. Name is taken.");
    expect(list.getByRole("button", { name: "Copy value" })).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Clear value" }));
    expect(strip()).toBeNull();
  });

  it("lets the row a failure left in Notices send the change again after its page closed, and names the Collection", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    let fail = true;
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read ? Promise.resolve({ result: page() })
      : sent(invoke, edit).length === 1 ? answer.promise : fail ? Promise.reject(new Error("Lost reply")) : Promise.resolve({ result: receipt() }));
    const view = setup({ invoke });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    view.unmount();
    await act(async () => answer.reject(new Error("Lost reply")));
    expect(view.onError).toHaveBeenCalledExactlyOnceWith("dohc could not confirm the change to People. Open it to check its records.", expect.objectContaining({ message: "Lost reply" }), expect.any(Function), expect.any(String));
    fail = false;
    await act(async () => view.onError.mock.calls[0]![2]());
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(2));
    expect(sent(invoke, edit)[1]).toEqual(sent(invoke, edit)[0]);
    await waitFor(() => expect(view.onNotice).toHaveBeenCalledExactlyOnceWith("Saved the edit in People"));
  });

  it("sends null for a name cleared in the panel's heading, as the table does", async () => {
    const optional = dataset();
    optional.tables[0]!.fields.find(entry => entry.fieldId === name)!.required = false;
    const { invoke } = setup({ dataset: optional });
    await screen.findByText("Alice");
    const record = openPanel();
    fireEvent.click(nameButton());
    fireEvent.change(within(record).getByRole("textbox", { name: "Name" }), { target: { value: "" } });
    fireEvent.keyDown(within(record).getByRole("textbox", { name: "Name" }), { key: "Enter" });
    await waitFor(() => expect(sent(invoke, edit)).toHaveLength(1));
    expect(sent(invoke, edit)[0]!.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: null } });
  });

  it("lists a deletion that waits behind a change dohc could not confirm", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (request.operationId === edit) throw new Error("Lost reply");
      return { result: { id: 1, version: 1 } };
    });
    setup({ invoke, confirmDelete: async () => true });
    await screen.findByText("Alice");
    type("Name", "Alicia");
    await waitFor(() => expect(mark("Name")).toBe("unconfirmed"));
    openPanel();
    fireEvent.click(recordCommand("Delete record…"));
    const words = await screen.findByText("The deletion of record 1 is waiting for an earlier change to this record.");
    expect(strip()!.contains(words)).toBe(true);
    expect(sent(invoke, remove)).toHaveLength(0);
  });
});
