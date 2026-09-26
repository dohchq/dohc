// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { TransactionalCollectionPage, type TransactionalDatasetDescription, type TransactionalInvoke } from "./TransactionalCollectionPage";

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
afterEach(cleanup);

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
      return { result: { id: 1, version: 3, priorValues: { [name]: "Alice" } } };
    });
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Change not confirmed");
    const retry = result.onError.mock.calls[0]![2];
    result.rerender(<TransactionalCollectionPage {...result.props} copy={{ offline: true, savedAtMs: 1 }} />);
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => retry()); expect(writes).toBe(1);
    const current = { ...dataset(), operations: dataset().operations.filter(operation => operation.operationId !== remove) };
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={current} copy={{ offline: false, savedAtMs: 2 }} />);
    await screen.findByRole("button", { name: "Try again" });
    await act(async () => retry());
    await screen.findByRole("button", { name: "Undo last edit" });
    const changes = invoke.mock.calls.filter(([input]) => input.operationId === edit);
    expect(changes).toHaveLength(2); expect(changes[1]![0]).toEqual(changes[0]![0]);
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    expect(result.onNotice).toHaveBeenCalledWith("Saved the edit");
  });
  it.each([false, true])("invalidates an old revision's pending edit and stale retry after rule changes (in flight: %s)", async inFlight => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.revision === 1 ? "Alice" : "Current records") }) :
      inFlight ? pending.promise : Promise.reject(Error("Lost reply")));
    const result = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    if (!inFlight) await screen.findByText("Change not confirmed");
    const retry = result.onError.mock.calls[0]?.[2];
    const revision = { ...dataset(), revision: 2, revisionSha256: "b".repeat(64) };
    result.rerender(<TransactionalCollectionPage {...result.props} dataset={revision} />);
    await screen.findByText("Current records");
    expect(result.onError.mock.calls.at(-1)![0]).toContain("Check the records");
    expect(result.onError.mock.calls.at(-1)![2]).toBeNull();
    expect(screen.queryByText("Change not confirmed")).toBeNull();
    expect(screen.getByRole("button", { name: "New record" }).hasAttribute("disabled")).toBe(false);
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
    await waitFor(() => expect(result.onNotice).toHaveBeenCalledWith("Saved the edit"));
    expect(result.onError).not.toHaveBeenCalled();
    expect(screen.queryByText("Change not confirmed")).toBeNull();
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
    await screen.findByText("Change not confirmed");
    const count = invoke.mock.calls.length;
    result.rerender(<TransactionalCollectionPage {...result.props} recordsVersion={2} />);
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(count));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("button", { name: "New record" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Try again" });
    const writes = invoke.mock.calls.filter(([input]) => input.operationId === edit);
    expect(writes).toHaveLength(2);
    expect(writes[1]![0]).toEqual(writes[0]![0]);
  });

  it("keeps creation outside management and returns focus when its disclosure closes", async () => {
    const onReviewSchema = vi.fn(); setup({onReviewSchema}); await screen.findByText("Alice");
    const manage = screen.getByLabelText("Manage Collection");
    const details = manage.closest("details")!;
    expect(screen.getByRole("button",{name:"New record"}).closest("details")).toBeNull();
    fireEvent.click(manage); expect(details.open).toBe(true);
    const fields = screen.getByRole("button",{name:"Fields and names"});
    fireEvent.click(fields); expect(onReviewSchema).toHaveBeenCalledOnce();
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
    expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(result.invoke.mock.calls.some(([request]) => request.operationId === edit)).toBe(true));
    expect(result.invoke.mock.calls.find(([request]) => request.operationId === edit)?.[0].input).toEqual({ id: 1, expectedVersion: 2, values: { [name]: "Alicia" } });
  });

  it("closes details on Escape and returns keyboard focus to the row", async () => {
    setup(); await screen.findByText("Alice");
    const open = screen.getByRole("button", { name: "Open record 1" });
    fireEvent.click(open);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Record details" })).toBeNull();
    expect(document.activeElement).toBe(open);
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
    setup({ copy: { offline: true, savedAtMs: 1_700_000_000_000 }, onRefresh, confirmDelete: async () => true });
    await screen.findByText("Alice");
    expect(screen.getByText(/Offline copy · Read-only/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "New record" })); fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
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
    const result = setup({ dataset: description, uploadFile }); await screen.findByText("Alice"); fireEvent.click(screen.getByRole("button", { name: "New record" }));
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

  it("retains the exact mutation and retry key after a lost response", async () => {
    let failed = false;
    const invoke = vi.fn(async (request: TransactionalInvoke): Promise<{ result: AppBackendJson }> => {
      if (request.operationId === read) return { result: page() };
      if (!failed) { failed = true; throw new Error("Connection ended after commit"); }
      return { result: { id: 1, version: 3, priorValues: { [name]: "Alice" } } };
    });
    const { onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByRole("form", { name: "Edit Name" })).toBeNull();
    expect((screen.getByRole("button", { name: "New record" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Undo last edit" });
    const writes = invoke.mock.calls.filter(([request]) => request.operationId === edit);
    expect(writes[1]![0]).toEqual(writes[0]![0]);
  });

  it("creates typed values with declared defaults and rejects missing required input inline", async () => {
    const { invoke } = setup(); await screen.findByText("Alice");
    fireEvent.click(screen.getByRole("button", { name: "New record" })); fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter Name.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(invoke.mock.calls.some(([request]) => request.operationId === create)).toBe(true));
    expect(invoke.mock.calls.find(([request]) => request.operationId === create)![0].input).toEqual({ values: { [name]: "Bob", [amount]: 12.5, [status]: "New" } });
  });

  it("keeps a refused edit draft editable and never treats it as an uncertain commit", async () => {
    const invoke = vi.fn(async (request: TransactionalInvoke) => {
      if (request.operationId === read) return { result: page() };
      throw Object.assign(new Error("This record changed. Refresh the table."), { code: "operation_refused" });
    });
    const { onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alicia" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alicia");
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("Change not confirmed")).toBeNull();
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

  it("ignores a completed old mutation and disables a stale retry after switching workspaces", async () => {
    const pending = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn((request: TransactionalInvoke) => request.operationId === read ? Promise.resolve({ result: page(request.workspaceId) }) : pending.promise);
    const { props, rerender, onNotice, onError } = setup({ invoke });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Name for record 1" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "changed" } }); fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(<TransactionalCollectionPage {...props} workspaceId="workspace-B" />); await screen.findByText("workspace-B");
    await act(async () => { pending.resolve({ result: { id: 1, version: 3, priorValues: { [name]: "workspace-A" } } }); });
    expect(onNotice).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
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
