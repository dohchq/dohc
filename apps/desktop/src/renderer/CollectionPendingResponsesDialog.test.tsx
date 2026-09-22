// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { CollectionPendingResponsesDialog, type CollectionPendingResponsesDialogProps, type PendingResponsesPage } from "./CollectionPendingResponsesDialog";
const datasetId = "00000000-0000-4000-8000-000000000001";
const saved = {reference: "a".repeat(64), operation: "Submit registration", recordedAtMs: 1000, revision: 3, outcome: "committed" as const, attachmentCount: 1};
afterEach(cleanup);
function fixture() {
  const onLoad = vi.fn<CollectionPendingResponsesDialogProps["onLoad"]>().mockResolvedValue({datasetId, entries: [saved], nextAfter: null});
  const onReconcile = vi.fn<CollectionPendingResponsesDialogProps["onReconcile"]>().mockResolvedValue({cleared: true});
  return {workspaceId: "w", datasetId, name: "Fundraiser", onLoad, onReconcile, onCancel: vi.fn<CollectionPendingResponsesDialogProps["onCancel"]>().mockResolvedValue({cancelled: true}), onClose: vi.fn(), onError: vi.fn()};
}
describe("CollectionPendingResponsesDialog", () => {
  it("requires an explicit warning acknowledgement before clearing the confirmed response", async () => {
    const props = fixture(); render(<CollectionPendingResponsesDialog {...props} />);
    await screen.findByText(/Saved in revision 3/);
    expect(screen.queryByText(saved.reference)).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Clear retry"}));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation.textContent).toContain("participant may not have seen");
    expect(confirmation.textContent).toContain("This cannot be undone");
    expect(props.onReconcile).not.toHaveBeenCalled();
    props.onLoad.mockResolvedValueOnce({datasetId, entries: [], nextAfter: null});
    fireEvent.click(within(confirmation).getByRole("button", {name: "Clear retry"}));
    await waitFor(() => expect(props.onReconcile).toHaveBeenCalledWith({workspaceId: "w", datasetId, reference: saved.reference, acknowledge: true}, expect.any(AbortSignal)));
    await screen.findByText("No pending responses. Refresh to check for changes.");
  });
  it("keeps unconfirmed attempts for the original app", async () => {
    const props = fixture(); props.onLoad.mockResolvedValue({datasetId, entries: [{...saved, outcome: "unconfirmed", recordedAtMs: null, revision: null, attachmentCount: 0}], nextAfter: null});
    render(<CollectionPendingResponsesDialog {...props} />);
    await screen.findByText("No saved result is confirmed yet.");
    expect(screen.getByText("Retry in the original app")).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Clear retry"})).toBeNull();
    expect(props.onCancel).not.toHaveBeenCalled();
  });
  it("requires an explicit irreversible cancellation and waits for host confirmation", async () => {
    const props = fixture(), pending = deferred<{cancelled: true}>();
    props.onLoad.mockResolvedValue({datasetId, entries: [{...saved, outcome: "unconfirmed", recordedAtMs: null, revision: null}], nextAfter: null});
    props.onCancel.mockImplementation(() => pending.promise);
    render(<CollectionPendingResponsesDialog {...props} />);
    fireEvent.click(await screen.findByRole("button", {name: "Cancel response"}));
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation.textContent).toContain("prevents its old retry from saving later"); expect(confirmation.textContent).toContain("cannot be undone");
    expect(props.onCancel).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", {name: "Cancel response"}));
    expect(props.onCancel).toHaveBeenCalledWith({workspaceId: "w", datasetId, reference: saved.reference, acknowledge: true}, expect.any(AbortSignal));
    expect(screen.getByText("No saved result is confirmed yet. 1 attached file.")).toBeTruthy();
    props.onLoad.mockResolvedValue({datasetId, entries: [], nextAfter: null});
    await act(async () => pending.resolve({cancelled: true}));
    await screen.findByText("No pending responses. Refresh to check for changes."); expect(props.onReconcile).not.toHaveBeenCalled();
  });
  it("ignores a previous workspace's late response and aborts its request", async () => {
    const props = fixture(), pending = deferred<PendingResponsesPage>();
    props.onLoad.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce({datasetId, entries: [], nextAfter: null});
    const view = render(<CollectionPendingResponsesDialog {...props} />);
    view.rerender(<CollectionPendingResponsesDialog {...props} workspaceId="other" />);
    expect(props.onLoad.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pending.resolve({datasetId, entries: [saved], nextAfter: null}));
    await screen.findByText("No pending responses. Refresh to check for changes.");
    expect(screen.queryByText("Submit registration")).toBeNull();
  });
});
