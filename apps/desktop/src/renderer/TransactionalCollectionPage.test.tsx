// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    { operationId: edit, name: "edit", label: "Edit", kind: "edit", access: "owner", readOnly: false, tableId: id(2), fieldIds: [name, amount] },
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

describe("transactional Collection page", () => {
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
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
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
