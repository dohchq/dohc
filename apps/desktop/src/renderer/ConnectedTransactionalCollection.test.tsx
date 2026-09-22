// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import { ConnectedTransactionalCollection } from "./ConnectedTransactionalCollection";

const backend = vi.hoisted(() => ({ dataset: vi.fn(), createWorkspaceFile: vi.fn(), listCollections: vi.fn(), listWorkspaceFiles: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
vi.mock("./TransactionalCollectionPage", () => ({ TransactionalCollectionPage: (props: { recordsVersion?: number; onRefresh?(): void; onTransferCsv?(): void; onPendingResponses?(): void; onExportRecovery?(): void }) => <>
  <input aria-label="Collection view state" data-records-version={props.recordsVersion} defaultValue="" />
  <button onClick={props.onRefresh}>Refresh records</button>
  {props.onTransferCsv && <button onClick={props.onTransferCsv}>Import or export CSV</button>}
  {props.onPendingResponses && <button onClick={props.onPendingResponses}>Pending responses</button>}
  {props.onExportRecovery && <button onClick={props.onExportRecovery}>Export recovery</button>}
</> }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "Fundraiser", revision: 1, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "Registrations", fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }] }], operations: [{ operationId: id(4), tableId: id(2), name: "create", label: "Create", kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("keeps the page mounted through successful and failed metadata refreshes", async () => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  const onError = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={onError} onFormCreated={vi.fn()} />);
  const input = await screen.findByLabelText("Collection view state");
  fireEvent.change(input, { target: { value: "pending edit and current search" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("2"));
  expect(screen.getByLabelText("Collection view state")).toBe(input);
  backend.dataset.mockRejectedValueOnce(Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Collection view state")).toBe(input);
  expect(input.getAttribute("data-records-version")).toBe("3");
  expect((input as HTMLInputElement).value).toBe("pending edit and current search");
});
async function setup() {
  backend.listCollections.mockResolvedValue({ collections: [] }); backend.listWorkspaceFiles.mockResolvedValue({ files: [] });
  backend.dataset.mockImplementation(async input => input.action === "describe" ? { kind: "description", dataset } : { kind: "invoked", result: { id: "created", version: 1 } });
  const props = { workspaceId: "workspace-a", datasetId: id(1), tableId: id(2), onError: vi.fn(), onFormCreated: vi.fn() };
  const rendered = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Import or export CSV" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "CSV or saved import report" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "CSV or saved import report" }));
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

it("keeps archived offline Collections read-only until refresh reaches the host", async () => {
  backend.dataset.mockResolvedValueOnce({ kind: "description", dataset: { ...dataset, archived: true }, copy: { offline: true } })
    .mockResolvedValue({ kind: "description", dataset: { ...dataset, archived: true } });
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} />);
  const restore = await screen.findByRole("button", { name: "Restore Collection" });
  expect(restore.hasAttribute("disabled")).toBe(true);
  fireEvent.click(restore); expect(backend.dataset.mock.calls.some(([input]) => input.action === "restore")).toBe(false);
  expect(screen.getByRole("status").textContent).toContain("Offline copy");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Restore Collection" }).hasAttribute("disabled")).toBe(false));
});

it("cancels an unconfirmed response only after owner acknowledgement and reports confirmation", async () => {
  let cancelled = false;
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "pendingAttempts") return { kind: "pending-attempts", datasetId: dataset.datasetId, entries: cancelled ? [] : [{ reference: "c".repeat(64), operation: "Submit", recordedAtMs: null, revision: null, outcome: "unconfirmed", attachmentCount: 0 }], nextAfter: null };
    cancelled = true; return { kind: "attempt-cancelled", cancelled: true };
  });
  const onNotice = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onNotice={onNotice} onFormCreated={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel response" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "cancelAttempt")).toBe(false);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel response" }));
  await screen.findByText("No pending responses. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "cancelAttempt", workspaceId: "workspace-a", datasetId: id(1), reference: "c".repeat(64), acknowledge: true });
  expect(onNotice).toHaveBeenCalledWith("Cancelled the pending response");
});

const deletionPreview = () => ({ kind: "delete-preview", cursor: { workspaceId: "workspace-a", datasetId: id(1), hostEpoch: "host", approvedRevisionHash: "a".repeat(64), revision: 3, digest: "b".repeat(64) }, reviewToken: "c".repeat(64), name: "Fundraiser", archived: true, generation: 2, reason: "done", apps: [{ appId: "form", binding: { operationIds: [id(4)] } }], nextCursor: null, irreversible: true });
it("deletes an archived Collection with its reviewed cursor and updates the shell", async () => {
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset: { ...dataset, archived: true } };
    if (input.action === "deletePreview") return deletionPreview();
    return { kind: "deleted", deleted: true, datasetId: id(1) };
  });
  const onNotice = vi.fn(), onLifecycleChanged = vi.fn(), onError = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onNotice={onNotice} onLifecycleChanged={onLifecycleChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));
  await screen.findByText("form");
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "delete")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Collection permanently" }));
  await screen.findByText("Collection deleted");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "delete", workspaceId: "workspace-a", datasetId: id(1), expected: deletionPreview().cursor, reviewToken: "c".repeat(64), acknowledge: true });
  expect(onLifecycleChanged).toHaveBeenCalledOnce(); expect(onNotice).toHaveBeenCalledWith("Collection deleted"); expect(onError).not.toHaveBeenCalled();
});
it.each([{ owner: false, offline: false }, { owner: true, offline: true }])("hides permanent delete for $owner owner and $offline offline", async ({ owner, offline }) => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset: { ...dataset, archived: true }, copy: { offline } });
  render(<ConnectedTransactionalCollection owner={owner} workspaceId="workspace-a" datasetId={id(1)} tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} />);
  await screen.findByText("Fundraiser is archived");
  expect(screen.queryByRole("button", { name: "Delete permanently…" })).toBeNull();
});
it("does not report permanent deletion in a different workspace", async () => {
  const pending = deferred<{ kind: string; deleted: true; datasetId: string }>();
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset: { ...dataset, archived: true } };
    if (input.action === "deletePreview") return deletionPreview();
    return pending.promise;
  });
  const props = { workspaceId: "workspace-a", datasetId: id(1), tableId: id(2), onError: vi.fn(), onFormCreated: vi.fn(), onNotice: vi.fn(), onLifecycleChanged: vi.fn() };
  const view = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" })); await screen.findByText("form");
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Delete Collection permanently" }));
  view.rerender(<ConnectedTransactionalCollection {...props} workspaceId="workspace-b" />);
  await act(async () => pending.resolve({ kind: "deleted", deleted: true, datasetId: id(1) }));
  expect(props.onNotice).not.toHaveBeenCalled(); expect(props.onLifecycleChanged).not.toHaveBeenCalled(); expect(props.onError).not.toHaveBeenCalled();
  expect(screen.queryByText("Collection deleted")).toBeNull();
});
