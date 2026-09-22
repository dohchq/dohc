// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetHistoryPage } from "@dohc/cli/dataset";
import { deferred } from "../testing/deferred";
import { CollectionHistoryDialog, type CollectionHistoryDialogProps } from "./CollectionHistoryDialog";

const datasetId = "00000000-0000-4000-8000-000000000001";
const entry = (revision: number) => ({ revision, operation: "submit", callerReference: "a".repeat(64), recordedAtMs: 1000, approvedRevisionHash: "b".repeat(64), changesetBytes: 80, attachmentCount: 1 });
const reversal = { operationId: "00000000-0000-4000-8000-000000000002", revision: 1, revisionSha256: "b".repeat(64), recordId: "record", expectedVersion: 3,
  fields: [{ fieldId: "00000000-0000-4000-8000-000000000003", name: "Name", value: "Alice" }] };
afterEach(cleanup);
describe("CollectionHistoryDialog", () => {
  it("shows prior values and reverses with the saved record version through the approved operation", async () => {
    const onUndo = vi.fn(async () => {}), onChanged = vi.fn();
    const onLoad = vi.fn(async () => ({ datasetId, headRevision: 3, entries: [{ ...entry(3), undo: reversal }], nextBeforeRevision: null }));
    render(<CollectionHistoryDialog workspaceId="a" datasetId={datasetId} name="Fundraiser" onLoad={onLoad} onUndo={onUndo} onChanged={onChanged} onClose={vi.fn()} onError={vi.fn()} />);
    const prior = await screen.findByText('"Alice"'); expect(prior).toBeTruthy();
    fireEvent.click(screen.getByText("submit"));
    fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onUndo).toHaveBeenCalledWith({ workspaceId: "a", datasetId, revision: 1, revisionSha256: reversal.revisionSha256, operationId: reversal.operationId,
      idempotencyKey: expect.any(String), input: { id: "record", expectedVersion: 3, values: { [reversal.fields[0]!.fieldId]: "Alice" } } }, expect.any(AbortSignal));
    expect(onLoad).toHaveBeenCalledTimes(2);
  });
  it("keeps the same undo request after a lost reply and leaves refused prior values visible", async () => {
    const onUndo = vi.fn().mockRejectedValueOnce(Error("Offline")).mockRejectedValueOnce(Object.assign(Error("Record changed"), { code: "operation_refused" }));
    const onError = vi.fn();
    const onLoad = vi.fn(async () => ({ datasetId, headRevision: 3, entries: [{ ...entry(3), undo: reversal }], nextBeforeRevision: null }));
    render(<CollectionHistoryDialog workspaceId="a" datasetId={datasetId} name="Fundraiser" onLoad={onLoad} onUndo={onUndo} onClose={vi.fn()} onError={onError} />);
    fireEvent.click(await screen.findByText("submit")); fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onUndo.mock.calls[1]![0]).toBe(onUndo.mock.calls[0]![0]);
    expect(onError.mock.calls[1]![2]).toBeNull();
    expect(screen.queryByText("Undo not confirmed")).toBeNull();
    expect(screen.getByText('"Alice"')).toBeTruthy();
  });
  it("shows saved-operation details and pages by revision", async () => {
    const onLoad = vi.fn<CollectionHistoryDialogProps["onLoad"]>().mockResolvedValueOnce({ datasetId, headRevision: 3, entries: [entry(3), entry(2)], nextBeforeRevision: 2 }).mockResolvedValueOnce({ datasetId, headRevision: 3, entries: [entry(1)], nextBeforeRevision: null });
    render(<CollectionHistoryDialog workspaceId="a" datasetId={datasetId} name="Fundraiser" onLoad={onLoad} onClose={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("3"); expect(screen.getAllByText("Caller reference")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Older operations" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2)); expect(onLoad.mock.calls[1]![0]).toMatchObject({ datasetId, beforeRevision: 2, limit: 50 });
    await waitFor(() => expect(screen.queryByText("3")).toBeNull()); expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });
  it("discards old workspace replies and offers a scoped retry for current failures", async () => {
    const pending = deferred<DatasetHistoryPage>(), onError = vi.fn();
    const onLoad = vi.fn<CollectionHistoryDialogProps["onLoad"]>().mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error("Offline"));
    const props = { workspaceId: "a", datasetId, name: "Fundraiser", onLoad, onClose: vi.fn(), onError };
    const view = render(<CollectionHistoryDialog {...props} />);
    view.rerender(<CollectionHistoryDialog {...props} workspaceId="b" />);
    expect(onLoad.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pending.resolve({ datasetId, headRevision: 99, entries: [entry(99)], nextBeforeRevision: null }));
    expect(screen.queryByText("99")).toBeNull(); await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    onLoad.mockResolvedValueOnce({ datasetId, headRevision: 0, entries: [], nextBeforeRevision: null });
    await act(async () => onError.mock.calls[0]![2]()); expect(onLoad.mock.calls.at(-1)![0].workspaceId).toBe("b");
  });
});
