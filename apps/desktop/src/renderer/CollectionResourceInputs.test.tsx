// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBackendFile, AppBackendJson } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { CollectionAttachmentCell, CollectionAttachmentInput, CollectionRelationInput } from "./CollectionResourceInputs";
import { downloadCollectionFile, type CollectionResources } from "./transactionalCollectionResources";
import { DeleteCollectionRecordDialog } from "./DeleteCollectionRecordDialog";

const scope = { workspaceId: "workspace-a", datasetId: "dataset-a", revision: 2, revisionSha256: "a".repeat(64) };
const field = { fieldId: "receipt", name: "Receipt", type: "attachment" as const, required: false, unique: false };
const stored: AppBackendFile = { fileId: "1234567890abcdef", name: "receipt.txt", byteLength: 3, contentType: "text/plain", sha256: "a".repeat(64) };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Collection file controls", () => {
  it("uploads with an exact retry key and stages the server file ID until save", async () => {
    const upload = vi.fn<NonNullable<CollectionResources["uploadFile"]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(stored);
    const onError = vi.fn(), onChange = vi.fn(), onBusy = vi.fn();
    render(<CollectionAttachmentInput scope={scope} field={field} value={null} disabled={false} onChange={onChange} onError={onError} onBusy={onBusy} upload={upload} />);
    fireEvent.change(screen.getByLabelText("Receipt"), { target: { files: [new File(["abc"], "receipt.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce()); expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => onError.mock.calls[0]![2]());
    expect(upload.mock.calls[1]![0]).toEqual(upload.mock.calls[0]![0]); expect(upload.mock.calls[0]![0]).toMatchObject({ ...scope, fieldId: "receipt" });
    expect(onChange).toHaveBeenCalledWith(stored.fileId); expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false, true, false]);
  });
  it("rejects an empty file inline without calling the host", () => {
    const upload = vi.fn(); render(<CollectionAttachmentInput scope={scope} field={field} value={null} disabled={false} onChange={vi.fn()} onError={vi.fn()} onBusy={vi.fn()} upload={upload} />);
    fireEvent.change(screen.getByLabelText("Receipt"), { target: { files: [new File([], "empty.txt")] } });
    expect(screen.getByRole("alert").textContent).toContain("nonempty"); expect(upload).not.toHaveBeenCalled();
  });
  it("aborts an upload after unmount and cannot apply its returned ID", async () => {
    const pending = deferred<AppBackendFile>(), onChange = vi.fn(), onError = vi.fn();
    const upload = vi.fn<NonNullable<CollectionResources["uploadFile"]>>(() => pending.promise);
    const result = render(<CollectionAttachmentInput scope={scope} field={field} value={null} disabled={false} onChange={onChange} onError={onError} onBusy={vi.fn()} upload={upload} />);
    fireEvent.change(screen.getByLabelText("Receipt"), { target: { files: [new File(["abc"], "receipt.txt")] } }); result.unmount();
    expect(upload.mock.calls[0]![1].aborted).toBe(true); await act(async () => pending.resolve(stored)); expect(onChange).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });
  it("downloads returned bytes through a blob URL and revokes it", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:verified-file"), revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe("receipt.txt"); expect(this.href).toBe("blob:verified-file"); });
    const read = vi.fn<NonNullable<CollectionResources["readFile"]>>(async () => ({ file: stored, bytesBase64: "YWJj" }));
    render(<CollectionAttachmentCell scope={scope} fieldName="Receipt" fileId={stored.fileId} disabled={false} read={read} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Receipt" })); await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(read.mock.calls[0]![0]).toEqual({ ...scope, fileId: stored.fileId }); expect(createObjectURL.mock.calls[0]![0]).toBeInstanceOf(Blob); expect(revokeObjectURL).toHaveBeenCalledWith("blob:verified-file");
    expect(() => downloadCollectionFile(stored.fileId, { file: { ...stored, fileId: "differentfile12345" }, bytesBase64: "YWJj" })).toThrow("invalid file");
  });
  it("drops a pending download after unmount", async () => {
    const pending = deferred<{ file: AppBackendFile; bytesBase64: string }>(), onError = vi.fn();
    const read = vi.fn<NonNullable<CollectionResources["readFile"]>>(() => pending.promise);
    const result = render(<CollectionAttachmentCell scope={scope} fieldName="Receipt" fileId={stored.fileId} disabled={false} read={read} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Receipt" })); result.unmount();
    expect(read.mock.calls[0]![1].aborted).toBe(true); await act(async () => pending.reject(new Error("old request"))); expect(onError).not.toHaveBeenCalled();
  });
});

describe("Collection relation controls", () => {
  const relationField = { ...field, fieldId: "team", name: "Team", type: "relation" as const, relation: { datasetId: "dataset-a", tableId: "teams", fieldId: "key", many: true } };
  it("uses a bounded search and preserves numeric and text record identities", async () => {
    const resolve = vi.fn<NonNullable<CollectionResources["resolveRelation"]>>(async () => ({ options: [{ value: 1, label: "Numeric team" }, { value: "1", label: "Text team" }], hasMore: true }));
    const onChange = vi.fn();
    function Input() { const [value, setValue] = useState<AppBackendJson>([]); return <CollectionRelationInput scope={scope} field={relationField} value={value} disabled={false} onChange={next => { onChange(next); setValue(next); }} onError={vi.fn()} resolve={resolve} />; }
    render(<Input />); fireEvent.click(await screen.findByRole("button", { name: "Numeric team" })); fireEvent.click(screen.getByRole("button", { name: "Text team" }));
    expect(onChange.mock.calls.at(-1)![0]).toEqual([1, "1"]); expect(resolve.mock.calls[0]![0]).toEqual({ ...scope, fieldId: "team", search: "", limit: 20 });
    fireEvent.change(screen.getByLabelText("Search Team"), { target: { value: "other" } }); fireEvent.click(screen.getByRole("button", { name: "Find records" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2)); expect(resolve.mock.calls[1]![0].search).toBe("other"); expect(screen.getByText("More records match. Narrow your search.")).toBeTruthy();
  });
  it("aborts superseded searches and does not show their stale options", async () => {
    const first = deferred<{ options: Array<{ value: string; label: string }>; hasMore: boolean }>();
    const resolve = vi.fn<NonNullable<CollectionResources["resolveRelation"]>>().mockImplementationOnce(() => first.promise).mockResolvedValue({ options: [{ value: "new", label: "New team" }], hasMore: false });
    render(<CollectionRelationInput scope={scope} field={relationField} value={null} disabled={false} onChange={vi.fn()} onError={vi.fn()} resolve={resolve} />);
    fireEvent.change(screen.getByLabelText("Search Team"), { target: { value: "new" } }); fireEvent.click(screen.getByRole("button", { name: "Find records" }));
    await screen.findByRole("button", { name: "New team" }); expect(resolve.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => first.resolve({ options: [{ value: "old", label: "Old team" }], hasMore: false })); expect(screen.queryByText("Old team")).toBeNull();
  });
});

it("requires a visible delete confirmation without promising record restoration", () => {
  const onConfirm = vi.fn(), onCancel = vi.fn(); render(<DeleteCollectionRecordDialog collectionName="Registrations" recordId={1} onConfirm={onConfirm} onCancel={onCancel} />);
  expect(screen.getByRole("dialog").textContent).toContain("You cannot undo this deletion in dohc."); expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete record" })); expect(onConfirm).toHaveBeenCalledOnce();
});
