// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionalRecordDetailsDialog, type TransactionalRecordDetailsDialogProps } from "./TransactionalRecordDetailsDialog";
import { downloadCollectionFile } from "./transactionalCollectionResources";
import { deferred } from "../testing/deferred";

vi.mock("./transactionalCollectionResources", async importOriginal => ({ ...await importOriginal<typeof import("./transactionalCollectionResources")>(), downloadCollectionFile: vi.fn() }));
const base: TransactionalRecordDetailsDialogProps = {
  scope: { workspaceId: "workspace-a", datasetId: "dataset", revision: 1, revisionSha256: "a".repeat(64) },
  row: { id: "person-1", version: 2, values: { name: "A long\ncomplete note", file: "abcdefghijklmnop", secret: "Hidden value" } },
  fields: [
    { fieldId: "name", name: "Name", type: "text", required: true, unique: false },
    { fieldId: "file", name: "Receipt", type: "attachment", required: false, unique: false },
    { fieldId: "secret", name: "Private note", type: "text", required: false, unique: false },
  ],
  readOperation: { operationId: "read", name: "read", label: "Read", tableId: "table", kind: "read", access: "owner", readOnly: true, fieldIds: ["name", "file"] },
  operations: [
    { operationId: "edit", name: "edit", label: "Edit", tableId: "table", kind: "edit", access: "owner", readOnly: false, fieldIds: ["name", "secret"] },
    { operationId: "approve", name: "approve", label: "Approve", tableId: "table", kind: "action", access: "owner", readOnly: false, fieldIds: [] },
    { operationId: "other", name: "other", label: "Other table action", tableId: "other", kind: "action", access: "owner", readOnly: false, fieldIds: [] },
  ],
  canEdit: () => true, onEdit: vi.fn(), onAction: vi.fn(), onError: vi.fn(), onClose: vi.fn(),
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("record details", () => {
  it("projects read fields, shows complete values, and opens only permitted edits or same-table actions", () => {
    render(<TransactionalRecordDetailsDialog {...base} />);
    const dialog = within(screen.getByRole("dialog", { name: "Record details" }));
    expect(dialog.getByText("A long complete note").textContent).toBe("A long\ncomplete note");
    expect(dialog.queryByText("Private note")).toBeNull();
    expect(dialog.queryByText("Hidden value")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Open Other table action" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Edit Name" }));
    expect(base.onEdit).toHaveBeenCalledWith(base.fields[0], base.operations[0]);
    fireEvent.click(dialog.getByRole("button", { name: "Open Approve" }));
    expect(base.onAction).toHaveBeenCalledWith(base.operations[1]);
  });

  it("keeps offline details read-only and does not attempt file download", () => {
    const readFile = vi.fn();
    render(<TransactionalRecordDetailsDialog {...base} offline readFile={readFile} />);
    expect(screen.getByText("Offline copy · Read-only")).toBeTruthy();
    expect(screen.getByText("File available when online")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("downloads through the exact read projection and safe byte helper", async () => {
    const response = { file: { fileId: "abcdefghijklmnop", name: "receipt.txt", byteLength: 3, contentType: "text/plain", sha256: "b".repeat(64) }, bytesBase64: "YWJj" };
    const readFile = vi.fn(async () => response);
    render(<TransactionalRecordDetailsDialog {...base} readFile={readFile} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Receipt" }));
    await waitFor(() => expect(downloadCollectionFile).toHaveBeenCalledWith("abcdefghijklmnop", response));
    expect(readFile).toHaveBeenCalledWith({ ...base.scope, fileId: "abcdefghijklmnop", read: { operationId: "read", fieldId: "file", input: { limit: 1, filters: [{ fieldId: "file", value: "abcdefghijklmnop" }] } } }, expect.any(AbortSignal));
  });

  it("aborts an old workspace attachment response before downloading or showing an error", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<TransactionalRecordDetailsDialogProps["readFile"]>>>>();
    const readFile = vi.fn<NonNullable<TransactionalRecordDetailsDialogProps["readFile"]>>(() => pending.promise);
    const view = render(<TransactionalRecordDetailsDialog {...base} readFile={readFile} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Receipt" }));
    view.rerender(<TransactionalRecordDetailsDialog {...base} scope={{ ...base.scope, workspaceId: "workspace-b" }} readFile={readFile} />);
    expect(readFile.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => pending.reject(Error("Old workspace")));
    expect(base.onError).not.toHaveBeenCalled();
    expect(downloadCollectionFile).not.toHaveBeenCalled();
  });
});
