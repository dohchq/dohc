// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import { ConnectedTransactionalCollection } from "./ConnectedTransactionalCollection";

const backend = vi.hoisted(() => ({ dataset: vi.fn(), createWorkspaceFile: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
vi.mock("./TransactionalCollectionPage", () => ({ TransactionalCollectionPage: (props: { onTransferCsv?(): void; onPendingResponses?(): void; onExportRecovery?(): void }) => <>
  {props.onTransferCsv && <button onClick={props.onTransferCsv}>Import or export CSV</button>}
  {props.onPendingResponses && <button onClick={props.onPendingResponses}>Pending responses</button>}
  {props.onExportRecovery && <button onClick={props.onExportRecovery}>Export recovery</button>}
</> }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "Fundraiser", revision: 1, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "Registrations", fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }] }], operations: [{ operationId: id(4), tableId: id(2), name: "create", label: "Create", kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
async function setup() {
  backend.dataset.mockImplementation(async input => input.action === "describe" ? { kind: "description", dataset } : { kind: "invoked", result: { id: "created", version: 1 } });
  const props = { workspaceId: "workspace-a", datasetId: id(1), tableId: id(2), onError: vi.fn(), onFormCreated: vi.fn() };
  const rendered = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Import or export CSV" }));
  fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: "Name\nAlice" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview CSV" }));
  return { ...rendered, props };
}
describe("connected CSV transfers", () => {
  it("saves a scoped durable report before invoking its approved create operation", async () => {
    const saved = deferred<{ path: string }>(); backend.createWorkspaceFile.mockImplementation(() => saved.promise);
    await setup(); fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(backend.createWorkspaceFile).toHaveBeenCalledOnce());
    expect(backend.dataset.mock.calls.filter(([input]) => input.action === "invoke")).toHaveLength(0);
    const request = backend.createWorkspaceFile.mock.calls[0]![0];
    expect(request.workspaceId).toBe("workspace-a"); expect(request.relativePath).toMatch(/^Registrations-import-[0-9a-f-]+\.json$/);
    const report = JSON.parse(request.initialText);
    await act(async () => saved.resolve({ path: request.relativePath }));
    await waitFor(() => expect(backend.dataset.mock.calls.filter(([input]) => input.action === "invoke")).toHaveLength(1));
    expect(backend.dataset.mock.calls.find(([input]) => input.action === "invoke")![0]).toMatchObject({ workspaceId: "workspace-a", operationId: id(4), idempotencyKey: report.rows[0].idempotencyKey });
    expect(screen.getByText(`Saved in this workspace: ${request.relativePath}`)).toBeTruthy();
  });
  it("does not begin import or repaint after the workspace changes during report save", async () => {
    const saved = deferred<{ path: string }>(); backend.createWorkspaceFile.mockImplementation(() => saved.promise);
    const { rerender, props } = await setup(); fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(backend.createWorkspaceFile).toHaveBeenCalledOnce());
    rerender(<ConnectedTransactionalCollection {...props} workspaceId="workspace-b" />);
    await act(async () => saved.resolve({ path: "old-report.json" }));
    expect(backend.dataset.mock.calls.filter(([input]) => input.action === "invoke")).toHaveLength(0);
    expect(screen.queryByText("Saved in this workspace: old-report.json")).toBeNull(); expect(props.onError).not.toHaveBeenCalled();
  });
});

it("opens archived metadata without running records and offers owner restore", async () => {
  backend.dataset.mockImplementation(async input => input.action === "describe" ? { kind: "description", dataset: { ...dataset, archived: true, operations: [] } } : { kind: "lifecycle-updated", archived: false, generation: 2 });
  const onLifecycleChanged = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onLifecycleChanged={onLifecycleChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore Collection" }));
  await waitFor(() => expect(onLifecycleChanged).toHaveBeenCalledOnce());
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "invoke")).toBe(false);
  expect(backend.dataset).toHaveBeenCalledWith({ action: "describe", workspaceId: "workspace-a", datasetId: id(1), includeArchived: true });
});

it("loads owner pending responses and requires confirmation before clearing a saved retry", async () => {
  let cleared = false;
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "pendingAttempts") return { kind: "pending-attempts", datasetId: dataset.datasetId, entries: cleared ? [] : [{ reference: "b".repeat(64), operation: "Submit", recordedAtMs: 1000, revision: 2, outcome: "committed", attachmentCount: 0 }], nextAfter: null };
    cleared = true; return { kind: "attempt-reconciled", cleared: true };
  });
  const onNotice = vi.fn(), onError = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={onError} onNotice={onNotice} onFormCreated={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear retry" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "reconcileAttempt")).toBe(false);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear retry" }));
  await screen.findByText("No pending responses. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "pendingAttempts", workspaceId: "workspace-a", datasetId: id(1), limit: 50 });
  expect(backend.dataset).toHaveBeenCalledWith({ action: "reconcileAttempt", workspaceId: "workspace-a", datasetId: id(1), reference: "b".repeat(64), acknowledge: true });
  expect(onNotice).toHaveBeenCalledWith("Cleared the saved response's retry"); expect(onError).not.toHaveBeenCalled();
});

it.each([{ owner: false, offline: false }, { owner: true, offline: true }])("hides pending review and recovery export for $owner owner and $offline offline", async ({ owner, offline }) => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset, copy: { offline } });
  render(<ConnectedTransactionalCollection owner={owner} workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText("Opening collection…")).toBeNull());
  expect(screen.queryByRole("button", { name: "Pending responses" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export recovery" })).toBeNull();
});

it("reports the saved recovery file through the shell notice callback", async () => {
  backend.dataset.mockImplementation(async input => input.action === "describe" ? { kind: "description", dataset } : { kind: "exported", savedPath: "C:/private/fundraiser.dohc-recovery" });
  const onNotice = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onNotice={onNotice} onFormCreated={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Export recovery" }));
  fireEvent.click(screen.getByRole("button", { name: "Save recovery file" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Saved recovery file: C:/private/fundraiser.dohc-recovery"));
});
