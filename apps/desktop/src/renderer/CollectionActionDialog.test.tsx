// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionActionDialog, type CollectionActionDialogProps } from "./CollectionActionDialog";
import { deferred } from "../testing/deferred";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
const dataset: CollectionActionDialogProps["dataset"] = { datasetId: "data", name: "Event", revision: 1, revisionSha256: "a".repeat(64), tables: [], operations: [{ operationId: "action", name: "draw", label: "Draw winner", kind: "action", access: "owner", readOnly: false, tableId: "table", fieldIds: [] }] };
function setup(overrides: Partial<CollectionActionDialogProps> = {}) {
  const invoke = vi.fn<CollectionActionDialogProps["invoke"]>(async () => ({ result: { winner: "Alice" } })), onCompleted = vi.fn(), onError = vi.fn(), onClose = vi.fn();
  const props = { workspaceId: "a", dataset, operationId: "action", invoke, onCompleted, onError, onClose, ...overrides };
  return { props, invoke, onCompleted, onError, onClose, ...render(<CollectionActionDialog {...props} />) };
}
afterEach(cleanup);
describe("CollectionActionDialog", () => {
  it("labels custom input as advanced and validates JSON before invoking", async () => {
    const { invoke, onCompleted } = setup(); fireEvent.change(screen.getByLabelText("Advanced JSON input"), { target: { value: "{" } }); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect(screen.getByRole("alert").textContent).toContain("valid JSON"); expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Advanced JSON input"), { target: { value: '{"prize":1}' } }); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await screen.findByText("Action completed"); expect(invoke.mock.calls[0]![0]).toMatchObject({ workspaceId: "a", datasetId: "data", operationId: "action", input: { prize: 1 }, revision: 1 }); expect(onCompleted).toHaveBeenCalledOnce();
  });
  it("retains the exact request and key after uncertain results", async () => {
    const invoke = vi.fn<CollectionActionDialogProps["invoke"]>().mockRejectedValueOnce(new Error("connection closed")).mockResolvedValue({ result: null }); setup({ invoke });
    fireEvent.click(screen.getByRole("button", { name: "Run action" })); fireEvent.click(await screen.findByRole("button", { name: "Try again" })); await screen.findByText("Action completed"); expect(invoke.mock.calls[1]![0]).toEqual(invoke.mock.calls[0]![0]);
  });
  it("unlocks refused input without replaying its failed key", async () => {
    const invoke = vi.fn<CollectionActionDialogProps["invoke"]>().mockRejectedValueOnce(Object.assign(new Error("invalid prize"), { code: "operation_refused" })).mockResolvedValue({ result: null });
    const { onError } = setup({ invoke }); fireEvent.click(screen.getByRole("button", { name: "Run action" })); await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect((screen.getByLabelText("Advanced JSON input") as HTMLTextAreaElement).disabled).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Run action" })); await screen.findByText("Action completed"); expect(invoke.mock.calls[1]![0].idempotencyKey).not.toBe(invoke.mock.calls[0]![0].idempotencyKey);
  });
  it("aborts and drops results when its workspace changes", async () => {
    const pending = deferred<{ result: AppBackendJson }>(), invoke = vi.fn<CollectionActionDialogProps["invoke"]>(() => pending.promise); const { props, rerender, onCompleted } = setup({ invoke });
    fireEvent.click(screen.getByRole("button", { name: "Run action" })); rerender(<CollectionActionDialog {...props} workspaceId="b" />); expect(invoke.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pending.resolve({ result: null })); expect(onCompleted).not.toHaveBeenCalled(); expect(screen.queryByText("Action completed")).toBeNull();
  });
});
