// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionActionDialog, type CollectionActionDialogProps } from "./CollectionActionDialog";
import { deferred } from "../testing/deferred";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
const dataset: CollectionActionDialogProps["dataset"] = { datasetId: "data", name: "Event", revision: 1, revisionSha256: "a".repeat(64), tables: [], operations: [{ operationId: "action", name: "draw", label: "Draw winner", kind: "action", access: "owner", readOnly: false, tableId: "table", fieldIds: [] }] };
function setup(overrides: Partial<CollectionActionDialogProps> = {}) {
  const invoke = vi.fn<CollectionActionDialogProps["invoke"]>(async () => ({ result: { winner: "Alice" } })), onSettled = vi.fn(), onClose = vi.fn();
  const props = { workspaceId: "a", dataset, operationId: "action", invoke, onSettled, onClose, ...overrides };
  return { props, invoke, onSettled, onClose, ...render(<CollectionActionDialog {...props} />) };
}
afterEach(cleanup);
describe("CollectionActionDialog", () => {
  it("cancels a running action and retries an unknown outcome with the same key", async () => {
    const first = deferred<{ result: AppBackendJson }>();
    const invoke = vi.fn<CollectionActionDialogProps["invoke"]>().mockImplementationOnce((_request, signal) => {
      signal.addEventListener("abort", () => first.reject(signal.reason), { once: true });
      return first.promise;
    }).mockResolvedValue({ result: { winner: "Alice" } });
    const { onClose, onSettled } = setup({ invoke });
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invoke.mock.calls[0]![1].aborted).toBe(true);
    await screen.findByText("Action cancelled");
    expect(screen.getByText(/may have changed records/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Action completed");
    expect(invoke.mock.calls[1]![0]).toEqual(invoke.mock.calls[0]![0]);
    expect(invoke.mock.calls[1]![1].aborted).toBe(false);
  });
  it("reports a confirmed completion when cancellation arrives too late", async () => {
    const response = deferred<{ result: AppBackendJson }>();
    const { onSettled } = setup({ invoke: () => response.promise });
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => response.resolve({ result: { winner: "Alice" } }));
    await screen.findByText("Action completed before cancellation");
    expect(screen.getByLabelText("Action result").textContent).toContain("Alice");
    expect(onSettled).toHaveBeenCalledOnce();
    expect(screen.queryByText("Action cancelled")).toBeNull();
  });
  it("labels custom input as advanced and validates JSON before invoking", async () => {
    const { invoke, onSettled } = setup(); fireEvent.change(screen.getByLabelText("Advanced JSON input"), { target: { value: "{" } }); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    expect(screen.getByRole("alert").textContent).toContain("valid JSON"); expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Advanced JSON input"), { target: { value: '{"prize":1}' } }); fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await screen.findByText("Action completed"); expect(invoke.mock.calls[0]![0]).toMatchObject({ workspaceId: "a", datasetId: "data", operationId: "action", input: { prize: 1 }, revision: 1 }); expect(onSettled).toHaveBeenCalledOnce();
  });
  it("retains the exact request and key after uncertain results", async () => {
    const invoke = vi.fn<CollectionActionDialogProps["invoke"]>().mockRejectedValueOnce(new Error("connection closed")).mockResolvedValue({ result: null }); setup({ invoke });
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    // The cause stays readable and copyable beside the uncertainty warning.
    await screen.findByText("connection closed"); expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" })); await screen.findByText("Action completed"); expect(invoke.mock.calls[1]![0]).toEqual(invoke.mock.calls[0]![0]);
  });
  it("unlocks refused input without replaying its failed key", async () => {
    const invoke = vi.fn<CollectionActionDialogProps["invoke"]>().mockRejectedValueOnce(Object.assign(new Error("invalid prize"), { code: "operation_refused" })).mockResolvedValue({ result: null });
    setup({ invoke }); fireEvent.click(screen.getByRole("button", { name: "Run action" })); await screen.findByText("The Collection refused this action.");
    expect((screen.getByLabelText("Advanced JSON input") as HTMLTextAreaElement).disabled).toBe(false); fireEvent.click(screen.getByRole("button", { name: "Run action" })); await screen.findByText("Action completed"); expect(invoke.mock.calls[1]![0].idempotencyKey).not.toBe(invoke.mock.calls[0]![0].idempotencyKey);
  });
  it("shows a definite refusal even when Cancel races its response", async () => {
    const response = deferred<{ result: AppBackendJson }>();
    setup({ invoke: () => response.promise });
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => response.reject(Object.assign(new Error("Choose an available prize."), { code: "operation_refused" })));
    expect(screen.getByRole("alert").textContent).toContain("Choose an available prize.");
    expect(screen.queryByText(/may have changed records/)).toBeNull();
    expect(screen.queryByText("Action cancelled")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((screen.getByLabelText("Advanced JSON input") as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Run action" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("aborts and drops results when its workspace changes", async () => {
    const pending = deferred<{ result: AppBackendJson }>(), invoke = vi.fn<CollectionActionDialogProps["invoke"]>(() => pending.promise); const { props, rerender, onSettled } = setup({ invoke });
    fireEvent.click(screen.getByRole("button", { name: "Run action" })); rerender(<CollectionActionDialog {...props} workspaceId="b" />); expect(invoke.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pending.resolve({ result: null })); expect(onSettled).not.toHaveBeenCalled(); expect(screen.queryByText("Action completed")).toBeNull();
  });
});
