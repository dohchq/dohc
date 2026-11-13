// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { datasetDefinitionFromDrafts } from "./collections/datasetDefinitionFromDrafts";
import {
  resetKeptCollectionEditsForTests,
  TransactionalCollectionPage,
  type TransactionalDatasetDescription,
  type TransactionalInvoke,
} from "./TransactionalCollectionPage";

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

describe("transactional Collection page", () => {
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

describe("when the Collection's fields change", () => {
  /** The next revision of the fixture, changed by `change`. */
  const revised = (revision: number, change: (next: TransactionalDatasetDescription) => void = () => undefined) => {
    const next = dataset(); next.revision = revision; next.revisionSha256 = String(revision % 10).repeat(64); change(next); return next;
  };
  const field = (description: TransactionalDatasetDescription, fieldId: string) => description.tables[0]!.fields.find(entry => entry.fieldId === fieldId)!;
  const operation = (description: TransactionalDatasetDescription, operationId: string) => description.operations.find(entry => entry.operationId === operationId)!;
  const retype = (fieldId: string, type: "text" | "number") => (next: TransactionalDatasetDescription) => { field(next, fieldId).type = type; };
  const CHANGED = "This field changed, so this value can't be saved. Copy it if you need it, then clear it.";

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
});
