// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { describeApprovedDataset, parseDatasetDescription } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { datasetDefinitionFromDrafts } from "./collections/datasetDefinitionFromDrafts";
import { transactionalDescription } from "./transactionalCollectionModel";
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
function setup(overrides: Partial<React.ComponentProps<typeof TransactionalCollectionPage>> = {}) {
  const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page() : request.operationId === edit ? { id: 1, version: 3, priorValues: { [name]: "Alice" } } : { id: 1, version: 1 } }));
  const onError = vi.fn(), onNotice = vi.fn();
  const props = { workspaceId: "workspace-A", dataset: dataset(), tableId: id(2), invoke, onError, onNotice, ...overrides };
  return { invoke, onError, onNotice, props, ...render(<TransactionalCollectionPage {...props} />) };
}
afterEach(() => { cleanup(); resetKeptCollectionEditsForTests(); });

it("offers a calendar before the Collection has a date field, and asks for one", async () => {
  const onAddDateField = vi.fn();
  const { props, rerender } = setup({ onAddDateField });
  await screen.findByText("Alice");
  const layout = screen.getByLabelText("Collection layout");
  expect((within(layout).getByRole("option", { name: "Calendar" }) as HTMLOptionElement).disabled).toBe(false);
  fireEvent.change(layout, { target: { value: "calendar" } });
  expect(await screen.findByText("A calendar needs a date field.")).toBeTruthy();
  expect(screen.queryByLabelText("Calendar date")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a date field" }));
  expect(onAddDateField).toHaveBeenCalledOnce();

  // Once the Collection has a date field, the calendar uses it.
  const dated = dataset(), visit = id(7);
  dated.revision = 2; dated.revisionSha256 = "b".repeat(64);
  dated.tables[0]!.fields.push({ fieldId: visit, name: "Visit on", type: "date", required: false, unique: false });
  dated.operations.find(operation => operation.operationId === read)!.fieldIds.push(visit);
  rerender(<TransactionalCollectionPage {...props} dataset={dated} />);
  expect((screen.getByLabelText("Calendar date") as HTMLSelectElement).value).toBe(visit);
  expect(screen.queryByText("A calendar needs a date field.")).toBeNull();
});

it("asks for a date field without a button for someone who cannot change fields", async () => {
  setup();
  await screen.findByText("Alice");
  fireEvent.change(screen.getByLabelText("Collection layout"), { target: { value: "calendar" } });
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
  const table = screen.getByRole("table");
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
  const table = await screen.findByRole("table");
  expect(within(table).getByRole("columnheader", { name: /Membership number/ })).toBeTruthy();
  expect(await within(table).findByText("MEM-42")).toBeTruthy();
});

it("keeps an empty multi-select visible and editable", async () => {
  const description = dataset();
  description.tables[0]!.fields.find(field => field.fieldId === status)!.type = "multi-select";
  description.operations.find(operation => operation.operationId === edit)!.fieldIds.push(status);
  const invoke = vi.fn(async () => ({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [status]: [] } }], nextCursor: null } }));
  setup({ dataset: description, invoke });
  const cell = await screen.findByRole("button", { name: "Edit Status for record 1" });
  expect(cell.textContent).toBe("—");
  fireEvent.click(cell);
  expect(screen.getByRole("checkbox", { name: "Reviewed" })).toBeTruthy();
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
  await screen.findByText("File available when online");
  expect(screen.queryByText(fileId)).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Open record 1"}));
  expect(within(screen.getByRole("dialog",{name:"Record details"})).getByText("File available when online")).toBeTruthy();
  expect(readFile).not.toHaveBeenCalled();
});

describe("transactional Collection page", () => {
  it("retries from the original Notice with current copy metadata and the exact request", async () => {
    let writes = 0;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (++writes === 1) throw Error("Lost reply");
      return { result: { id: 2, version: 1 } };
    });
    const result = setup({ invoke });
    await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await screen.findByText("Change not confirmed");
    const retry = result.onError.mock.calls[0]![2];
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => retry()); expect(writes).toBe(1);
    const current = { ...dataset(), operations: dataset().operations.filter(operation => operation.operationId !== remove) };
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={current} copy={{ offline: false, savedAtMs: 2 }} />);
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => retry());
    await waitFor(() => expect(screen.queryByText("Change not confirmed")).toBeNull());
    const changes = invoke.mock.calls.filter(([input]) => input.operationId === create);
    expect(changes).toHaveLength(2); expect(changes[1]![0]).toEqual(changes[0]![0]);
    expect(result.onNotice).not.toHaveBeenCalled();
  });
  it.each([false, true])("invalidates an old revision's pending edit and stale retry after rule changes (in flight: %s)", async inFlight => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.revision === 1 ? "Alice" : "Current records") }) :
      inFlight ? pending.promise : Promise.reject(Error("Lost reply")));
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    if (!inFlight) await screen.findByText("dohc could not confirm this change.");
    const retry = result.onError.mock.calls[0]?.[2];
    const revision = { ...dataset(), revision: 2, revisionSha256: "b".repeat(64) };
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revision} />);
    await screen.findByText("Current records");
    expect(result.onError.mock.calls.at(-1)![0]).toContain("Check the records");
    expect(result.onError.mock.calls.at(-1)![2]).toBeNull();
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    // The edit stays open with what was typed, and without the old revision's error.
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(screen.queryByText("dohc could not confirm this change.")).toBeNull();
    await act(async () => { retry?.(); pending.resolve({ result: { id: 1, version: 3, priorValues: { [name]: "Alice" } } }); });
    expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)).toHaveLength(1);
    expect(result.onNotice).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
    expect(screen.getByText("Current records")).toBeTruthy();
  });
  it("keeps search, sort, cursor history and undo when records refresh", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page("Alice", true) : { id: 1, version: 3, priorValues: { [name]: "Alice" } } }));
    const result = setup({ invoke, recordsVersion: 1 }); await screen.findByText("Alice");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ali" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Amount" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Name for record 1" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Undo last edit" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));
    const count = invoke.mock.calls.length;
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={{ ...dataset(), name: "Updated title" }} recordsVersion={2} />);
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(count));
    expect(invoke.mock.calls.at(-1)![0].input).toEqual({ limit: 50, search: "Ali", sort: { fieldId: amount, direction: "asc" }, after: { id: 1, value: "Alice" } });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Ali");
    expect(screen.getByRole("button", { name: "Undo last edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(false);
  });

  const receipts: AppBackendJson[] = [null, {}, { id: 1, version: 3 }, { id: 1, version: 3, priorValues: "invalid" }];
  it.each(receipts)("accepts a committed custom edit without usable undo metadata: %j", async receipt => {
    const invoke = vi.fn(async (request: TransactionalInvoke) => ({ result: request.operationId === read ? page() : receipt }));
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit Name" })).toBeNull());
    expect(result.onNotice).not.toHaveBeenCalled();
    expect(result.onError).not.toHaveBeenCalled();
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });

  it("shows no notice for a change the page shows", async () => {
    const result = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Undo last edit" });
    expect(result.onNotice).not.toHaveBeenCalled();
  });
  it.each([
    [new Error("Lost reply"), "dohc could not confirm the change to People. Open it to check its records."],
    [Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" }), "People refused the change. Open it to check its records."],
  ])("reports a change that fails after its page closed, naming the Collection (%s)", async (failure, words) => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page() }) : answer.promise);
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === edit)).toBe(true));
    result.unmount();
    await act(async () => answer.reject(failure));
    expect(result.onError).toHaveBeenCalledOnce();
    expect(result.onError).toHaveBeenCalledWith(words, failure, null);
    expect(result.onNotice).not.toHaveBeenCalled();
  });
  it("tells the person which Collection a change saved in after its page closed", async () => {
    const answer = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page() }) : answer.promise);
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === edit)).toBe(true));
    result.unmount();
    // The page opens again unlocked while the change is still saving.
    render(<TransactionalCollectionPage {...result.props} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Edit Name for record 1" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => answer.resolve({ result: { id: 1, version: 3, priorValues: { [name]: "Alice" } } }));
    expect(result.onNotice).toHaveBeenCalledOnce();
    expect(result.onNotice).toHaveBeenCalledWith("Saved the edit in People");
    // The change went out once, the closed page read nothing more, and the open page shows no Undo for it.
    expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)).toHaveLength(1);
    expect(invoke.mock.calls.filter(([request]) => request.operationId === read)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });
  it("keeps an uncertain edit and its exact request while refreshing and browsing", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page("Alice", true) };
      throw Error("Connection ended");
    });
    const result = setup({ invoke, recordsVersion: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("dohc could not confirm this change.");
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    // Escape from the focused check mark closes the cell, and the page says the change still waits.
    const save = screen.getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Edit Name" })).toBeNull();
    await screen.findByText("Change not confirmed");
    const count = invoke.mock.calls.length;
    result.rerender(<TransactionalCollectionPage {...result.props} recordsVersion={2} />);
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(count));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getAllByRole("button", { name: "New record" })[0]!.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Try again" });
    const writes = invoke.mock.calls.filter(([input]) => input.operationId === edit);
    expect(writes).toHaveLength(2);
    expect(writes[1]![0]).toEqual(writes[0]![0]);
  });

  it("keeps creation outside management and returns focus when its disclosure closes", async () => {
    const onReviewSchema = vi.fn(); const onCustomize = vi.fn(); setup({onReviewSchema, onCustomize}); await screen.findByText("Alice");
    const manage = screen.getByLabelText("Manage Collection");
    const details = manage.closest("details")!;
    expect(screen.getAllByRole("button", { name: "New record"})[0]!.closest("details")).toBeNull();
    fireEvent.click(manage); expect(details.open).toBe(true);
    const fields = screen.getByRole("button",{name:"Fields and names"});
    fireEvent.click(fields); expect(onReviewSchema).toHaveBeenCalledOnce();
    fireEvent.click(manage); fireEvent.click(screen.getByRole("button",{name:"Customize…"})); expect(onCustomize).toHaveBeenCalledOnce();
    fireEvent.click(manage);
    fields.focus(); fireEvent.keyDown(fields,{key:"Escape"});
    expect(details.open).toBe(false); expect(document.activeElement).toBe(manage);
  });
  it("keeps saved filters when sorting and resets paging when switching views",async()=>{
    const activeView={viewId:id(30),name:"Pending",kind:"table" as const,search:"Alice",filters:[{fieldId:status,value:"New"}],sort:{fieldId:name,direction:"asc" as const}};
    const result=setup({activeView});await screen.findByText("Alice");
    expect(result.invoke.mock.calls[0]![0].input).toMatchObject({search:"Alice",filters:[{fieldId:status,value:"New"}],sort:{fieldId:name,direction:"asc"}});
    fireEvent.click(screen.getByRole("button",{name:"Amount"}));await waitFor(()=>expect(result.invoke.mock.calls.at(-1)![0].input).toMatchObject({filters:activeView.filters,sort:{fieldId:amount,direction:"asc"}}));
    result.rerender(<TransactionalCollectionPage {...result.props} activeView={{...activeView,viewId:id(31),search:"Bob"}}/>);
    await waitFor(()=>expect(result.invoke.mock.calls.at(-1)![0].input).toMatchObject({search:"Bob",sort:activeView.sort}));expect(result.invoke.mock.calls.at(-1)![0].input).not.toHaveProperty("after");
  });
  it("opens record details and edits through the existing versioned action", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const details = within(screen.getByRole("dialog", { name: "Record details" }));
    expect(details.getByText("Alice")).toBeTruthy();
    expect(details.queryByText("Private note")).toBeNull();
    fireEvent.click(details.getByRole("button", { name: "Edit Name" }));
    expect(document.activeElement).toBe(details.getByLabelText("Name"));
    fireEvent.change(details.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(details.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(result.invoke.mock.calls.some(([request]) => request.operationId === edit)).toBe(true));
    expect(result.invoke.mock.calls.find(([request]) => request.operationId === edit)?.[0].input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });
  });

  it("edits a field in place in record details: Escape closes only the field, Enter saves, and focus returns to its pencil", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open record 1" });
    open.focus(); fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "Record details" });
    const pencil = within(dialog).getByRole("button", { name: "Edit Name" });
    fireEvent.click(pencil);
    // The input opens where the value was, with the caret after it, and Cancel and Save take the pencil's place.
    const input = within(within(dialog).getByRole("form", { name: "Edit Name" })).getByLabelText<HTMLInputElement>("Name");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
    expect(within(input.closest("dd")!).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Cancel", "Save"]);
    expect(input.closest("td")).toBeNull();
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(dialog).queryByRole("form", { name: "Edit Name" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Record details" })).toBe(dialog);
    expect(within(dialog).getByText("Alice")).toBeTruthy();
    expect(document.activeElement).toBe(pencil);

    fireEvent.click(pencil);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Name"), { key: "Enter" });
    await waitFor(() => expect(invoke.mock.calls.find(([request]) => request.operationId === edit)?.[0].input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } }));
    await waitFor(() => expect(document.activeElement).toBe(pencil));
    expect(screen.getByRole("dialog", { name: "Record details" })).toBe(dialog);
    // The next Escape closes details, and focus returns to the row.
    fireEvent.keyDown(pencil, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });
  it("opens an edit with changes again in its cell when its page closes and opens again", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    // Another file opens in the tab group, then the Collection opens again.
    first.unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    const input = await screen.findByLabelText<HTMLInputElement>("Name");
    expect(input.value).toBe("Alicia");
    expect(input.closest("td")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    // The record's version is the one the edit opened with.
    await waitFor(() => expect(first.invoke.mock.calls.find(([request]) => request.operationId === edit)?.[0].input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Name for record 1" })));
  });
  it("opens an edit with changes again in record details when its page closes and opens again", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Open record 1" }));
    const before = screen.getByRole("dialog", { name: "Record details" });
    fireEvent.click(within(before).getByRole("button", { name: "Edit Name" }));
    fireEvent.change(within(before).getByLabelText("Name"), { target: { value: "Alicia" } });
    first.unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    const dialog = await screen.findByRole("dialog", { name: "Record details" });
    const input = within(within(dialog).getByRole("form", { name: "Edit Name" })).getByLabelText<HTMLInputElement>("Name");
    expect(input.value).toBe("Alicia");
    expect(document.activeElement).toBe(input);
    // Escape closes only the field, and focus goes to its pencil.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Edit Name" }));
  });
  it("keeps an edit it has not opened again when its page closes before its records load", async () => {
    const first = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    first.unmount();
    // The Collection opens again, and another file opens before its records load.
    render(<TransactionalCollectionPage {...first.props} invoke={() => new Promise<never>(() => undefined)} />).unmount();
    render(<TransactionalCollectionPage {...first.props} />);
    expect((await screen.findByLabelText<HTMLInputElement>("Name")).value).toBe("Alicia");
  });
  it("opens no edit again that was cancelled or has no changes, and flags a kept value whose field changed meanwhile", async () => {
    const reopen = async (props: React.ComponentProps<typeof TransactionalCollectionPage>, typed: string | null, cancel = false) => {
      const view = render(<TransactionalCollectionPage {...props} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
      if (typed !== null) fireEvent.change(screen.getByLabelText("Name"), { target: { value: typed } });
      if (cancel) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      view.unmount();
    };
    const { props } = setup(); cleanup();
    await reopen(props, null);
    await reopen(props, "Alicia", true);
    const unchanged = render(<TransactionalCollectionPage {...props} />);
    await screen.findByText("Alice");
    expect(screen.queryByLabelText("Name")).toBeNull();
    unchanged.unmount();
    await reopen(props, "Alicia");
    const retyped = dataset(); retyped.revision = 2; retyped.revisionSha256 = "b".repeat(64);
    retyped.tables[0]!.fields.find(field => field.fieldId === name)!.type = "number";
    render(<TransactionalCollectionPage {...props} dataset={retyped} />);
    const kept = await screen.findByLabelText<HTMLInputElement>("Name");
    expect(kept.readOnly).toBe(true); expect(kept.value).toBe("Alicia");
    expect(screen.getByText("This field changed, so this value can't be saved. Copy it if you need it, then clear it.")).toBeTruthy();
  });

  it("cancels a field open in details on Escape from Done, and the next Escape closes details", async () => {
    setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const dialog = screen.getByRole("dialog", { name: "Record details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Name" }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Alicia" } });
    const done = within(dialog).getByRole("button", { name: "Done" });
    done.focus();
    fireEvent.keyDown(done, { key: "Escape" });
    expect(within(dialog).queryByRole("form", { name: "Edit Name" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Record details" })).toBe(dialog);
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull();
  });

  it("unlocks the page when details closes during an attachment upload", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    setup({ dataset: description, uploadFile }); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const dialog = screen.getByRole("dialog", { name: "Record details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Amount" }));
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt")] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(uploadFile.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pendingUpload.reject(new DOMException("The upload was cancelled.", "AbortError")));
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes details on Escape and returns keyboard focus to the row", async () => {
    setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open record 1" });
    open.focus();
    fireEvent.click(open);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });
  it("clears previously displayed records when a read loses access", async () => {
    const result = setup(); await screen.findByText("Alice");
    result.invoke.mockRejectedValueOnce(Error("Access revoked"));
    fireEvent.click(screen.getByRole("button", {name:"Refresh"}));
    await waitFor(() => expect(result.onError).toHaveBeenCalled());
    expect(screen.queryByText("Alice")).toBeNull();
  });
  it("shows saved offline records without mutation controls and refreshes the copy", async () => {
    const onRefresh = vi.fn();
    setup({ copy: { offline: true, savedAtMs: 1_700_000_000_000, host: "sync.example.test" }, onRefresh, confirmDelete: async () => true });
    await screen.findByText("Alice");
    expect(screen.getByRole("status").textContent).toBe(`Offline copy · Read-only until sync.example.test is reachable · ${new Date(1_700_000_000_000).toLocaleString()}`);
    expect(screen.queryByRole("button", { name: "New record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Name for record 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete record 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("creates records with a staged attachment and locks saving until upload completes", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const result = setup({ dataset: description, uploadFile }); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!); fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt", { type: "text/plain" })] } });
    expect((screen.getByRole("button", { name: "Create record" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pendingUpload.resolve({ fileId: "1234567890abcdef", name: "receipt.txt", byteLength: 3, contentType: "text/plain", sha256: "a".repeat(64) }));
    expect(screen.getByText("receipt.txt · 3 bytes · Save to attach")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(result.invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(true));
    expect(result.invoke.mock.calls.find(([request]) => request.operationId === create)![0].input).toEqual({ values: { [name]: "Bob", [amount]: "1234567890abcdef", [status]: "New" } });
  });
  it("aborts pending attachment writes before switching workspaces", async () => {
    const description = dataset(); description.tables[0]!.fields.find(field => field.fieldId === amount)!.type = "attachment";
    const pendingUpload = deferred<import("@dohc/security-contract/app-backend").AppBackendFile>();
    const uploadFile = vi.fn<NonNullable<React.ComponentProps<typeof TransactionalCollectionPage>["uploadFile"]>>(() => pendingUpload.promise);
    const result = setup({ dataset: description, uploadFile }); await screen.findByText("Alice"); fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { files: [new File(["abc"], "receipt.txt")] } });
    result.rerender(<TransactionalCollectionPage {...result.props} workspaceId="workspace-b" />);
    expect(uploadFile.mock.calls[0]![1].aborted).toBe(true); await act(async () => pendingUpload.reject(new Error("Old workspace"))); expect(result.onError).not.toHaveBeenCalled();
    await screen.findByText("Alice"); expect(screen.queryByText("Uploading…")).toBeNull();
  });
  it("offers form creation only with a public create action and a connected handler", async () => {
    const onCreateForm = vi.fn(); const result = setup({ onCreateForm }); await screen.findByText("Alice");
    expect(screen.queryByRole("button", { name: "Create form" })).toBeNull();
    const description = dataset(); description.operations.find(operation => operation.operationId === create)!.access = "link";
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} />); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Create form" })); expect(onCreateForm).toHaveBeenCalledOnce();
  });
  it("shows only approved fields and actions with bounded cursor paging", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: page(request.input && typeof request.input === "object" && "after" in request.input ? "Bob" : "Alice", true) }));
    setup({ invoke });
    await screen.findByRole("button", { name: "Edit Name for record 1" });
    expect(screen.queryByText("Private note")).toBeNull(); expect(screen.queryByText("Do not show")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Status for record 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete record 1" })).toBeNull();
    expect(invoke.mock.calls[0]![0]).toMatchObject({ workspaceId: "workspace-A", datasetId: id(1), operationId: read, input: { limit: 50 }, revision: 1, revisionSha256: "a".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Bob");
    expect(invoke.mock.calls.at(-1)![0].input).toEqual({ limit: 50, after: { id: 1, value: "Alice" } });
    expect(screen.queryByText("Alice")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous" })); await screen.findByText("Alice");
  });

  it("edits a value in its cell: Enter saves, Escape cancels, and focus returns to the cell", async () => {
    const { invoke } = setup();
    const cell = await screen.findByRole("button", { name: "Edit Name for record 1" });
    const row = cell.closest("tr")!;
    fireEvent.click(cell);
    const form = screen.getByRole("form", { name: "Edit Name" }), input = within(form).getByLabelText<HTMLInputElement>("Name");
    // The input opens in the value's cell with the caret after the value, and Cancel and Save take the record actions' places.
    expect(cell.closest("td")!.contains(form)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
    expect(within(row).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["Edit Amount for record 1", "Cancel", "Save"]);
    // Focus leaving the cell keeps it open.
    act(() => input.blur());
    expect(screen.getByRole("form", { name: "Edit Name" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Edit Name" })).toBeNull();
    expect(document.activeElement).toBe(cell);
    expect(cell.textContent).toBe("Alice");

    fireEvent.click(cell);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    await waitFor(() => expect(invoke.mock.calls.find(([request]) => request.operationId === edit)?.[0].input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } }));
    await waitFor(() => expect(document.activeElement).toBe(cell));
    expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)).toHaveLength(1);
  });

  it("edits through the approved operation and reverses server-reported prior values", async () => {
    const { invoke } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Undo last edit" });
    const write = invoke.mock.calls.find(([request]) => request.operationId === edit)![0];
    expect(write.input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo last edit" }));
    await waitFor(() => expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)).toHaveLength(2));
    expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)[1]![0].input).toEqual({ id: 1, expectedVersion: 3, values: { [name]: "Alice" } });
  });

  it("keeps an edit that could not be confirmed in its cell, and its check mark sends the exact request again", async () => {
    let failed = false;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (!failed) { failed = true; throw new Error("Connection ended after commit"); }
      return { result: { id: 1, version: 3, priorValues: { [name]: "Alice" } } };
    });
    const { onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("dohc could not confirm this change.");
    const input = screen.getByLabelText<HTMLInputElement>("Name"), save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    expect(input.closest("td")!.contains(error)).toBe(true);
    expect([input.value, input.disabled, input.getAttribute("aria-describedby")]).toEqual(["Alicia", true, error.id]);
    expect(save.disabled).toBe(false); expect(document.activeElement).toBe(save);
    // The failure also takes a toast and a row in Notices, whose Try again sends the same change.
    expect(onError).toHaveBeenCalledWith("dohc could not confirm this change.", expect.objectContaining({ message: "Connection ended after commit" }), expect.any(Function));
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    expect((screen.getAllByRole("button", { name: "New record" })[0]! as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    await screen.findByRole("button", { name: "Undo last edit" });
    const writes = invoke.mock.calls.filter(([request]) => request.operationId === edit);
    expect(writes).toHaveLength(2); expect(writes[1]![0]).toEqual(writes[0]![0]);
    expect(screen.queryByRole("form", { name: "Edit Name" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Name for record 1" })));
    // The landed change's row in Notices sends nothing, and the next edit stays open.
    fireEvent.click(screen.getByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    await act(async () => onError.mock.calls[0]![2]!());
    expect(invoke.mock.calls.filter(([request]) => request.operationId === edit)).toHaveLength(2);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
  });

  it("creates typed values with declared defaults and rejects missing required input inline", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!); fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter Name.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(true));
    expect(invoke.mock.calls.find(([request]) => request.operationId === create)![0].input).toEqual({ values: { [name]: "Bob", [amount]: 12.5, [status]: "New" } });
  });

  it.each([[false, "1 record"], [true, "1 record on this page"]] as const)("counts the records, and says on this page only when another page exists (next page: %s)", async (next, words) => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? page("Alice", next) : { id: 1, version: 1 } }));
    setup({ invoke }); await screen.findByText("Alice");
    expect(screen.getByText(words, { selector: "footer span" })).toBeTruthy();
  });

  it("shows a field's error under the field, marks the field, and moves focus to it", async () => {
    setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getAllByRole("button", { name: "New record" })[0]!);
    const row = screen.getByRole("row", { name: "New record" });
    const field = within(row).getByLabelText("Name"), status = within(row).getByLabelText("Status");
    fireEvent.change(status, { target: { value: "" } });
    const createButton = screen.getByRole("button", { name: "Create record" });
    createButton.focus(); fireEvent.click(createButton);
    const [error, statusError] = await screen.findAllByRole("alert");
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Enter Name.", "Enter Status."]);
    expect(error!.querySelector("svg")).not.toBeNull();
    expect(field.closest("td")!.contains(error!)).toBe(true);
    expect(status.closest("td")!.contains(statusError!)).toBe(true);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error!.id);
    expect(status.getAttribute("aria-describedby")).toBe(statusError!.id);
    expect(document.activeElement).toBe(field);
    // Changing a field clears only its own error.
    fireEvent.change(field, { target: { value: "Bob" } });
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Enter Status."]);
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(status.getAttribute("aria-invalid")).toBe("true");

    // The one-field edit form does the same.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "" } });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus(); fireEvent.click(save);
    const editError = await screen.findByRole("alert");
    expect(editError.textContent).toBe("Enter Name.");
    expect(input.parentElement!.contains(editError)).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(editError.id);
    expect(document.activeElement).toBe(input);
  });

  it("shows an empty Collection's columns and adds a record in the table's New record row", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? { rows: [], nextCursor: null } : { id: 1, version: 1 } }));
    setup({ invoke });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toEqual(expect.arrayContaining(["Name", "Amount", "Status"]));
    expect(screen.queryByText(/on this page/)).toBeNull();

    fireEvent.click(within(table).getByRole("button", { name: "New record" }));
    const row = within(table).getByRole("row", { name: "New record" });
    expect(document.activeElement).toBe(within(row).getByLabelText("Name"));
    expect(screen.queryByRole("form", { name: "New record" })).toBeNull();
    fireEvent.keyDown(within(row).getByLabelText("Name"), { key: "Escape" });
    expect(within(table).queryByLabelText("Name")).toBeNull();
    expect(document.activeElement).toBe(within(table).getByRole("button", { name: "New record" }));

    fireEvent.click(within(table).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    await waitFor(() => expect(invoke.mock.calls.find(([request]) => request.operationId === create)?.[0].input).toEqual({ values: { [name]: "Bob", [amount]: null, [status]: "New" } }));
    await waitFor(() => expect(document.activeElement).toBe(within(table).getByRole("button", { name: "New record" })));
  });

  it("returns focus to the table's New record button once the read after a create lets it take focus", async () => {
    const reread = deferred<{ result: AppBackendJson }>();
    let reads = 0;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId !== read) return { result: { id: 1, version: 1 } };
      return ++reads === 1 ? { result: { rows: [], nextCursor: null } } : reread.promise;
    });
    setup({ invoke });
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    const button = await within(table).findByRole<HTMLButtonElement>("button", { name: "New record" });
    await waitFor(() => expect(reads).toBe(2));
    expect(button.disabled).toBe(true);
    await act(async () => reread.resolve({ result: { rows: [{ id: 1, version: 1, values: { [name]: "Bob" } }], nextCursor: null } }));
    expect(document.activeElement).toBe(within(table).getByRole("button", { name: "New record" }));
  });

  it("keeps the New record row open when the browser rejects a value, such as a half-typed number", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => ({ result: request.operationId === read ? { rows: [], nextCursor: null } : { id: 1, version: 1 } }));
    setup({ invoke });
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    // jsdom cannot hold a half-typed number, so the input reports the browser's rejection directly.
    vi.spyOn(screen.getByLabelText<HTMLInputElement>("Amount"), "reportValidity").mockReturnValue(false);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(false);
    expect(within(table).getByRole("row", { name: "New record" })).toBeTruthy();
  });

  it("keeps a refused edit draft editable and never treats it as an uncertain commit", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke) => {
      if (request.operationId === read) return { result: page() };
      throw Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" });
    });
    const { onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("The collection refused this change.");
    const input = screen.getByLabelText<HTMLInputElement>("Name");
    expect([input.value, input.disabled, input.getAttribute("aria-invalid")]).toEqual(["Alicia", false, "true"]);
    expect(document.activeElement).toBe(input);
    expect(onError).toHaveBeenCalledWith("The collection refused this change.", expect.objectContaining({ code: "operation_refused" }), null);
    expect(screen.queryByText("Change not confirmed")).toBeNull();
  });

  it("shows a reopen wait in the page, says when it ends, and loads the records from its Try again", async () => {
    const waiting = new Error("Error invoking remote method 'desktop:dataset': DatasetReopenWaitError [dataset_reopen_wait] [retryAfterMs=5000]: This Collection is waiting to reopen. Try again in 5 seconds.");
    const loaded = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn<(request: TransactionalInvoke) => Promise<{ result: AppBackendJson }>>()
      .mockRejectedValueOnce(waiting).mockReturnValueOnce(loaded.promise).mockResolvedValue({ result: page() });
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
      await act(async () => loaded.resolve({ result: page() }));
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

  it("reports malformed pages through Notices without rendering unapproved data", async () => {
    const { onError } = setup({ invoke: async () => ({ result: { rows: [{ id: 1, version: "bad", values: { [secret]: "Hidden" } }], nextCursor: null } }) });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByText("Hidden")).toBeNull();
    expect(onError.mock.calls[0]![2]).toBeTypeOf("function");
  });

  it("requires shell confirmation before using the approved delete operation", async () => {
    const confirmDelete = vi.fn(async () => true);
    const { invoke } = setup({ confirmDelete });
    fireEvent.click(await screen.findByRole("button", { name: "Delete record 1" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === remove)).toBe(true));
    expect(confirmDelete).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.find(([request]) => request.operationId === remove)![0].input).toEqual({ id: 1, expectedVersion: 2 });
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

  it("reports a completed old mutation to its own workspace and disables a stale retry after switching workspaces", async () => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.workspaceId) }) : pending.promise);
    const { props, rerender, onNotice, onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "changed" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const nextNotice = vi.fn();
    rerender(<TransactionalCollectionPage {...props} workspaceId="workspace-B" onNotice={nextNotice} />); await screen.findByText("workspace-B");
    await act(async () => { pending.resolve({ result: { id: 1, version: 3, priorValues: { [name]: "workspace-A" } } }); });
    // The notice goes to its own workspace's handler, which the shell drops once the window has left that workspace.
    expect(onNotice).toHaveBeenCalledWith("Saved the edit in People"); expect(nextNotice).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo last edit" })).toBeNull();
  });
});

it("draws each Button field as a labelled column before the record actions, and in the record's details", async () => {
  const render = vi.fn((field: string, row: { id: string | number }) => <button type="button">{`${field} for record ${String(row.id)}`}</button>);
  setup({ buttons: { fields: ["Mark paid"], render } });
  const cell = await screen.findByRole("button", { name: "Mark paid for record 1" });
  const headers = screen.getAllByRole("columnheader").map(header => header.textContent);
  expect(headers.slice(-2)).toEqual(["Mark paid", "Actions"]);
  // A button stores no value to sort by, so its header is a label.
  expect(within(screen.getAllByRole("columnheader").at(-2)!).queryByRole("button")).toBeNull();
  expect(cell.closest("td")?.nextElementSibling?.querySelector("[aria-label='Open record 1']")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
  const details = screen.getByRole("dialog", { name: "Record details" });
  expect(within(details).getByRole("button", { name: "Mark paid for record 1" })).toBeTruthy();
});

it("keeps an open record's details, and the focus in them, when the records are read again", async () => {
  const render = (field: string, row: { id: string | number }) => <button type="button">{`${field} for record ${String(row.id)}`}</button>;
  let text = "Alice";
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page(text) }));
  const { props, rerender } = setup({ invoke, buttons: { fields: ["Mark paid"], render } });
  fireEvent.click(await screen.findByRole("button", { name: "Open record 1" }));
  const details = screen.getByRole("dialog", { name: "Record details" });
  const button = within(details).getByRole("button", { name: "Mark paid for record 1" });
  button.focus();
  text = "Alice Paid";
  rerender(<TransactionalCollectionPage {...props} recordsVersion={1} />);
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Record details" })).getByText("Alice Paid")).toBeTruthy());
  expect(document.activeElement).toBe(button);
  // A record the new read no longer holds closes its details.
  invoke.mockResolvedValue({ result: { rows: [], nextCursor: null } });
  rerender(<TransactionalCollectionPage {...props} recordsVersion={2} />);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull());
});

it("shows records an automation changed in place, with no loading line, nothing disabled, and an open record kept open", async () => {
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page() }));
  const { props, rerender } = setup({ invoke });
  fireEvent.click(await screen.findByRole("button", { name: "Open record 1" }));
  const reread = deferred<{ result: AppBackendJson }>();
  invoke.mockReturnValueOnce(reread.promise);
  rerender(<TransactionalCollectionPage {...props} recordsChanged={1} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Loading records…")).toBeNull();
  expect(screen.getByRole("region", { name: "People", hidden: true }).getAttribute("aria-busy")).toBe("false");
  expect((screen.getAllByRole("button", { name: "New record", hidden: true })[0]! as HTMLButtonElement).disabled).toBe(false);
  // A record the read left out keeps its dialog open, which says so instead of showing old values.
  await act(async () => reread.resolve({ result: { rows: [], nextCursor: null } }));
  expect(within(screen.getByRole("dialog", { name: "Record details" })).getByRole("status").textContent).toBe("This record is no longer in this view. Close it, then search for it.");
  invoke.mockResolvedValueOnce({ result: page("Alice Paid") });
  rerender(<TransactionalCollectionPage {...props} recordsChanged={2} />);
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Record details" })).getByText("Alice Paid")).toBeTruthy());
  expect(screen.queryByText("Loading records…")).toBeNull();
});

it("finishes a read and a read in place asked for in one render, and leaves nothing loading or disabled", async () => {
  const invoke = vi.fn(async (): Promise<{ result: AppBackendJson }> => ({ result: page() }));
  const { props, rerender } = setup({ invoke });
  await screen.findByText("Alice");
  const read = deferred<{ result: AppBackendJson }>();
  invoke.mockReturnValueOnce(read.promise).mockResolvedValue({ result: page("Alice Paid") });
  rerender(<TransactionalCollectionPage {...props} recordsVersion={1} recordsChanged={1} />);
  expect(await screen.findByText("Loading records…")).toBeTruthy();
  await act(async () => read.resolve({ result: page() }));
  // The read in place waited for the other read, then ran.
  await screen.findByText("Alice Paid");
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(screen.queryByText("Loading records…")).toBeNull();
  expect((screen.getAllByRole("button", { name: "New record" })[0]! as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
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

it("shows the ⚡ button beside New record, and a ⚡ that names the automations on each field they set", async () => {
  setup({
    automationsButton: <button type="button">Automations</button>,
    fieldMarks: new Map([["Amount", ["Round the amount"]], ["Status", ["Review new people", "Stamp"]]]),
  });
  await screen.findByText("Alice");
  const header = screen.getByRole("heading", { name: "People" }).closest("header")!;
  expect(within(header).getAllByRole("button").map(button => button.textContent)).toEqual(["Automations", "New record"]);
  const marks = screen.getAllByRole("img", { name: "Automation" });
  expect(marks.map(mark => mark.closest("th")?.querySelector("button")?.textContent)).toEqual(["Amount", "Status"]);
  // Hovering or focusing a mark names the automations.
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(marks[1]!);
  expect(screen.getByRole("tooltip").textContent).toBe('"Review new people" and "Stamp" set this field');
  fireEvent.blur(marks[1]!);
  fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
  const details = screen.getByRole("dialog", { name: "Record details" });
  expect(within(details).getAllByRole("img", { name: "Automation" })).toHaveLength(2);
});

describe("when the Collection's fields change", () => {
  /** The next revision of the fixture, changed by `change`. */
  const revised = (revision: number, change: (next: TransactionalDatasetDescription) => void = () => undefined) => {
    const next = dataset(); next.revision = revision; next.revisionSha256 = String(revision % 10).repeat(64); change(next); return next;
  };
  const field = (description: TransactionalDatasetDescription, fieldId: string) => description.tables[0]!.fields.find(entry => entry.fieldId === fieldId)!;
  const operation = (description: TransactionalDatasetDescription, operationId: string) => description.operations.find(entry => entry.operationId === operationId)!;
  const retype = (fieldId: string, type: "text" | "number") => (next: TransactionalDatasetDescription) => { field(next, fieldId).type = type; };
  const reads = (invoke: { mock: { calls: Array<[TransactionalInvoke, ...unknown[]]> } }) => invoke.mock.calls.map(([request]) => request).filter(request => request.operationId === read);
  const CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";

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
    const table = screen.getByRole("table"), box = screen.getByRole<HTMLInputElement>("searchbox");
    fireEvent.change(box, { target: { value: "Alice B" } }); box.focus();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    // The rows stay without the retyped field's old number, and nothing says the page is loading.
    expect(screen.getByRole("table")).toBe(table);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
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
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(amount, "text"))} />);
    const details = within(screen.getByRole("dialog", { name: "Record details" }));
    expect(details.getByText("Alice")).toBeTruthy();
    expect(details.queryByText("5")).toBeNull();
    await act(async () => current.resolve({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: "five", [status]: "New" } }], nextCursor: null } }));
    expect(details.getByText("five")).toBeTruthy();
  });

  it("keeps a new record's typing, and asks to clear a value its field can no longer take before it saves the rest", async () => {
    const team = id(8);
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "7" } });
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => {
      retype(amount, "text")(next); field(next, name).name = "Full name";
      next.tables[0]!.fields.push({ fieldId: team, name: "Team", type: "text", required: false, unique: false, default: "Blue" });
      operation(next, read).fieldIds.push(team); operation(next, create).fieldIds.push(team);
    })} />);
    // A renamed field keeps its value. A field the rules add takes its default.
    expect(screen.getByLabelText<HTMLInputElement>("Full name").value).toBe("Bob");
    expect(screen.getByLabelText<HTMLInputElement>("Team").value).toBe("Blue");
    // The retyped field shows what was typed, read-only, with a way to copy it and one to clear it.
    const typed = screen.getByLabelText<HTMLInputElement>("Amount");
    expect(typed.readOnly).toBe(true); expect(typed.value).toBe("7");
    expect(screen.getByText(CHANGED)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy value" })).toBeTruthy();
    // Saving writes nothing under the new type: it points at the field instead.
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect(result.invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(false);
    expect(document.activeElement).toBe(typed);
    fireEvent.click(screen.getByRole("button", { name: "Clear value" }));
    const cleared = screen.getByLabelText<HTMLInputElement>("Amount");
    expect(cleared.readOnly).toBe(false); expect(cleared.value).toBe("");
    expect(document.activeElement).toBe(cleared);
    expect(screen.queryByText(CHANGED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(result.invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(true));
    expect(result.invoke.mock.calls.find(([request]) => request.operationId === create)![0]).toMatchObject({
      revision: 2, input: { values: { [name]: "Bob", [amount]: null, [status]: "New", [team]: "Blue" } },
    });
  });

  it("flags a typed value only while its field can't take it, through changes in a row", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Reviewed" } });
    const show = (description: TransactionalDatasetDescription) => result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} />);
    const flagged = () => screen.queryAllByRole("textbox").filter(input => (input as HTMLInputElement).readOnly).map(input => input.getAttribute("aria-label"));
    // New options that still hold the value, and a field that stops being required, flag nothing.
    show(revised(2, next => { field(next, status).options = ["Reviewed", "Done"]; field(next, name).required = false; }));
    expect(flagged()).toEqual([]);
    // Options without the value, and a field that changes type, flag it.
    show(revised(3, next => { field(next, status).options = ["New", "Done"]; retype(name, "number")(next); }));
    expect(flagged()).toEqual(["Name", "Status"]);
    // Once the fields take the values again, they are what was typed, with nothing flagged.
    show(revised(4));
    expect(flagged()).toEqual([]);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    expect(screen.getByLabelText<HTMLSelectElement>("Status").value).toBe("Reviewed");
  });

  it("keeps a cell being edited open, and saves it against the new rules once its old value is cleared", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => request.operationId === read
      ? { result: request.revision === 2 ? { rows: [{ id: 1, version: 2, values: { [name]: 42, [amount]: 5, [status]: "New" } }], nextCursor: null } : page() }
      : { result: { id: 1, version: 3 } });
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    screen.getByLabelText<HTMLInputElement>("Name").focus();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, retype(name, "number"))} />);
    const cell = within(screen.getByRole("form", { name: "Edit Name" }));
    expect(cell.getByLabelText<HTMLInputElement>("Name").readOnly).toBe(true);
    // The field that had focus keeps it, now showing what was typed.
    expect(document.activeElement).toBe(cell.getByLabelText("Name"));
    expect(cell.getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    await waitFor(() => expect(reads(invoke).at(-1)!.revision).toBe(2));
    fireEvent.click(cell.getByRole("button", { name: "Clear value" }));
    // Cleared, the cell shows the record's value under the new type, and its input takes focus.
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("42"));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "43" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === edit)).toBe(true));
    expect(invoke.mock.calls.find(([request]) => request.operationId === edit)![0]).toMatchObject({ revision: 2, input: { id: 1, expectedVersion: 2, values: { [name]: 43 } } });
  });

  it("keeps a form whose change the rules no longer allow, and says so beside it", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, next => { next.operations = next.operations.filter(entry => entry.operationId !== create); })} />);
    const form = within(screen.getByRole("form", { name: "New record" }));
    expect(form.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    expect(form.getByText("The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.")).toBeTruthy();
    expect(form.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(form.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New record" })).toBeNull();
  });

  it("keeps Undo last edit while its fields still take its values, and drops it once one can't", async () => {
    const result = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Undo last edit" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ali" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(reads(result.invoke).at(-1)!.input).toMatchObject({ search: "Ali" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open record 1" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const table = screen.getByRole("table");
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(screen.getByRole("table")).toBe(table);
    expect(screen.getByRole("dialog", { name: "Record details" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("Ali");
    await waitFor(() => expect(reads(result.invoke).at(-1)!.input).toMatchObject({ search: "Ali" }));
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: false, savedAtMs: 2 }} />);
    expect(screen.getByRole("table")).toBe(table);
    expect(screen.getByRole("dialog", { name: "Record details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo last edit" })).toBeTruthy();
  });

  it("keeps an open form's typing while the Collection is offline, and saves it once it is back", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    expect(screen.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(true);
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: false, savedAtMs: 2 }} />);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Bob");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create record" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(result.invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(true));
  });

  it("keeps a field being edited in record details, and its focus, when its edit is gone, offline, or its field is gone", async () => {
    const result = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const dialog = screen.getByRole("dialog", { name: "Record details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Name" }));
    const input = within(dialog).getByLabelText<HTMLInputElement>("Name");
    fireEvent.change(input, { target: { value: "Alicia" } }); input.focus();
    const show = (description: TransactionalDatasetDescription, offline = false) =>
      result.rerender(<TransactionalCollectionPage {...result.props} dataset={description} copy={offline ? { offline: true, savedAtMs: 1 } : undefined} />);
    // A rename elsewhere keeps the dialog and the focus in it.
    show(revised(2, next => { field(next, amount).name = "Total"; }));
    expect(screen.getByRole("dialog", { name: "Record details" })).toBe(dialog);
    expect(document.activeElement).toBe(input);
    show(revised(3, next => { next.operations = next.operations.filter(entry => entry.operationId !== edit); }));
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(within(dialog).getByText("The Collection's rules no longer allow this change. Copy what you need, then choose Cancel.")).toBeTruthy();
    show(revised(4), true);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(within(dialog).getByText("You can save this once the Collection is back online.")).toBeTruthy();
    show(revised(5, next => {
      next.tables[0]!.fields = next.tables[0]!.fields.filter(entry => entry.fieldId !== name);
      for (const entry of next.operations) entry.fieldIds = entry.fieldIds.filter(fieldId => fieldId !== name);
    }));
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(within(dialog).getByText(CHANGED)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear value" }));
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
  });

  it("offers the related records of a relation field's new table once its table changes", async () => {
    const team = id(8);
    const relation = (tableId: string) => (next: TransactionalDatasetDescription) => {
      next.tables[0]!.fields.push({ fieldId: team, name: "Team", type: "relation", required: false, unique: false, relation: { datasetId: id(1), tableId, fieldId: id(40), many: false } });
      operation(next, create).fieldIds.push(team);
    };
    const resolveRelation = vi.fn(async () => ({ options: [{ value: 1, label: resolveRelation.mock.calls.length > 1 ? "Blue team" : "Old team" }], hasMore: false }));
    const result = setup({ resolveRelation, dataset: revised(1, relation(id(41))) }); await screen.findByText("Alice");
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "New record" }));
    expect(await screen.findByRole("button", { name: "Old team" })).toBeTruthy();
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revised(2, relation(id(42)))} />);
    expect(await screen.findByRole("button", { name: "Blue team" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Old team" })).toBeNull();
  });

  it("reopens a kept edit in record details without values read under a field's old type, and reads the record again", async () => {
    const first = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "Open record 1" }));
    const before = screen.getByRole("dialog", { name: "Record details" });
    fireEvent.click(within(before).getByRole("button", { name: "Edit Name" }));
    fireEvent.change(within(before).getByLabelText("Name"), { target: { value: "Alicia" } });
    first.unmount();
    // Amount became text while the page was closed, and the record is no longer on the first page.
    const byId = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke): Promise<{ result: AppBackendJson }> =>
      (request.input as { filters?: unknown[] }).filters ? byId.promise : Promise.resolve({ result: { rows: [], nextCursor: null } }));
    const reopened = revised(2, next => { retype(amount, "text")(next); next.tables[0]!.primaryKeyFieldId = name; });
    render(<TransactionalCollectionPage {...first.props} invoke={invoke} dataset={reopened} />);
    const dialog = await screen.findByRole("dialog", { name: "Record details" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("Name").value).toBe("Alicia");
    expect(within(dialog).queryByText("5")).toBeNull();
    await act(async () => byId.resolve({ result: { rows: [{ id: 1, version: 2, values: { [name]: "Alice", [amount]: "five", [status]: "New" } }], nextCursor: null } }));
    expect(within(dialog).getByText("five")).toBeTruthy();
  });
});
