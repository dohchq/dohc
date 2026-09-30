// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import type { ReactNode } from "react";
import type { AutomationRunSettledEvent, FindDatasetCollectionResult, ListCollectionAutomationsResult } from "../ipc/bridgeContract";
import { ConnectedTransactionalCollection } from "./ConnectedTransactionalCollection";
import { resetAutomationButtonsForTests } from "./collections/useAutomationButtons";
import { resetKeptAutomationDraftsForTests } from "./collections/AutomationsPanel";
import type { TransactionalButtons } from "./TransactionalCollectionPage";

const backend = vi.hoisted(() => ({ dataset: vi.fn(), createWorkspaceFile: vi.fn(), listCollections: vi.fn(), listWorkspaceFiles: vi.fn(),
  listAutomationButtons: vi.fn(), pressAutomationButton: vi.fn(), onCollectionAutomationsChanged: vi.fn(() => () => undefined),
  findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({ status: "unavailable" })),
  listCollectionAutomations: vi.fn(), listAutomationHolds: vi.fn(async () => ({ holds: [], stops: [], unreadable: false })),
  onAutomationRunsChanged: vi.fn(() => () => undefined), onAutomationHoldsChanged: vi.fn(() => () => undefined),
  settled: [] as Array<(event: AutomationRunSettledEvent) => void>,
  onAutomationRunSettled: vi.fn(), onAutomationRunWaiting: vi.fn(() => () => undefined),
  checkCollectionAutomation: vi.fn(async () => ({ diagnostics: [], formulaProblems: [], cannotRun: null, missingFiles: [] })),
  listAutomationGroups: vi.fn(async () => ({ groups: [] })),
  listAutomationTargets: vi.fn(async () => ({ collections: [] })),
  listAutomationPeople: vi.fn(async () => ({ status: "listed", people: [] })),
  readScheduleHost: vi.fn(async () => ({ kind: "this-computer" })), onScheduleHostChanged: vi.fn(() => () => undefined),
  onCloudSessionChanged: vi.fn(() => () => undefined),
  writeCollectionAutomations: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
vi.mock("./TransactionalCollectionPage", () => ({ TransactionalCollectionPage: (props: { automationsButton?: ReactNode; recordsVersion?: number; buttons?: TransactionalButtons; onRefresh?(): void; onHistory?(): void; onReviewSchema?(): void; onTransferCsv?(): void; onPendingResponses?(): void; onExportRecovery?(): void; onCustomize?(): void }) => <>
  {props.automationsButton}
  {props.buttons?.fields.map(field => <span key={field}>{props.buttons!.render(field, { id: 12, version: 1, values: {} })}</span>)}
  <input aria-label="Collection view state" data-records-version={props.recordsVersion} defaultValue="" />
  <button onClick={props.onRefresh}>Refresh records</button>
  {props.onHistory && <button onClick={props.onHistory}>History</button>}
  {props.onReviewSchema && <button onClick={props.onReviewSchema}>Fields and names</button>}
  {props.onTransferCsv && <button onClick={props.onTransferCsv}>Import or export CSV</button>}
  {props.onPendingResponses && <button onClick={props.onPendingResponses}>Pending responses</button>}
  {props.onExportRecovery && <button onClick={props.onExportRecovery}>Export recovery</button>}
  {props.onCustomize && <button onClick={props.onCustomize}>Customize…</button>}
</> }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "Fundraiser", revision: 1, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "Registrations", fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }] }], operations: [{ operationId: id(4), tableId: id(2), name: "create", label: "Create", kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }] };
// A builder left with changes keeps its draft for the next panel, so each test starts with none.
afterEach(() => { cleanup(); resetAutomationButtonsForTests(); resetKeptAutomationDraftsForTests(); vi.clearAllMocks(); backend.settled.length = 0; });

describe("a dataset table's buttons", () => {
  const withButton: DatasetDescription = { ...dataset, tables: [{ ...dataset.tables[0]!, fields: [...dataset.tables[0]!.fields, { fieldId: id(6), name: "Confirm", type: "button" }] }] };
  const settle = (event: AutomationRunSettledEvent) => { for (const listener of backend.settled) listener(event); };

  it("asks before a button runs an action that can't be undone, and presses naming the actions it agreed to", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.onAutomationRunSettled.mockImplementation((listener: (event: AutomationRunSettledEvent) => void) => { backend.settled.push(listener); return () => undefined; });
    backend.listAutomationButtons.mockResolvedValue({ buttons: [
      { field: "Confirm", table: "Registrations", state: { kind: "ready", automationId: "collection:Fundraiser#confirm", irreversible: [{ name: "registrations.receipt", label: "Send receipt" }] } },
    ] });
    backend.pressAutomationButton.mockResolvedValue({ busy: false, claimId: "claim-2", settled: null });
    render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onNotice={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Confirm for record 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(backend.pressAutomationButton).toHaveBeenCalledWith(expect.objectContaining({ field: "Confirm", confirmed: ["registrations.receipt"] })));
  });

  it("presses with the dataset, the table's name, and the record's key as JSON, runs until settled, says what ran, and reads the records again", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.onAutomationRunSettled.mockImplementation((listener: (event: AutomationRunSettledEvent) => void) => { backend.settled.push(listener); return () => undefined; });
    backend.listAutomationButtons.mockResolvedValue({ buttons: [
      { field: "Confirm", table: "Registrations", state: { kind: "ready", automationId: "collection:Fundraiser#confirm" } },
      { field: "Confirm", table: "Donors", state: { kind: "disabled", reason: "Only people who can edit Donors can use this button." } },
    ] });
    backend.pressAutomationButton.mockResolvedValue({ busy: false, claimId: "claim-1", settled: null });
    const onNotice = vi.fn();
    render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onNotice={onNotice} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Confirm for record 12" });
    expect(backend.listAutomationButtons).toHaveBeenCalledWith({ workspaceId: "workspace-a", datasetId: id(1) });
    // The state of this table's button, not another table's button of the same name.
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    await waitFor(() => expect(backend.pressAutomationButton).toHaveBeenCalledWith({
      workspaceId: "workspace-a", datasetId: id(1), table: "Registrations", field: "Confirm", recordId: "12", pressId: expect.any(String), confirmed: [],
    }));
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    const version = () => Number(screen.getByLabelText("Collection view state").getAttribute("data-records-version"));
    const before = version();
    act(() => settle({ workspaceId: "workspace-a", claimId: "claim-1", outcome: "done", error: null }));
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(onNotice).toHaveBeenCalledWith("Ran Confirm on record 12");
    // The run changed records without touching a file, so the table reads them again.
    expect(version()).toBe(before + 1);
  });

  it("asks main nothing about buttons for a table that has none", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    await screen.findByLabelText("Collection view state");
    expect(backend.listAutomationButtons).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /for record/ })).toBeNull();
  });
});
it("opens wrapped history through the real dialog and reverses the saved edit", async () => {
  let undone = false;
  const current: DatasetDescription = { ...dataset, operations: [...dataset.operations, { operationId: id(5), tableId: id(2), name: "edit", label: "Edit", kind: "edit", reversible: true, access: "owner", readOnly: false, fieldIds: [id(3)] }] };
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset: current };
    if (input.action === "history") return { kind: "history", datasetId: id(1), headRevision: undone ? 3 : 2, nextBeforeRevision: null,
      entries: undone ? [] : [{ revision: 2, operation: "edit", callerReference: "b".repeat(64), recordedAtMs: 1000, approvedRevisionHash: current.revisionSha256, changesetBytes: 80, attachmentCount: 0,
        undo: { operationId: id(5), revision: 1, revisionSha256: current.revisionSha256, recordId: "record", expectedVersion: 2, fields: [{ fieldId: id(3), name: "Name", value: "Original name" }] } }] };
    if (input.action === "invoke") { undone = true; return { kind: "invoked", result: { id: "record", version: 3 }, revision: 3, replayed: false }; }
    throw Error("Unexpected request");
  });
  const onError = vi.fn(), onNotice = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onNotice={onNotice} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  const history = within(screen.getByRole("dialog", { name: "Collection history" }));
  fireEvent.click(await history.findByText("edit", { exact: true }));
  expect(history.getByText('"Original name"')).toBeTruthy();
  fireEvent.click(history.getByRole("button", { name: "Undo edit" }));
  await history.findByText("No saved operations on this page. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "invoke", workspaceId: "workspace-a", datasetPath: "data/dataset.json", expectedDatasetId: id(1), revision: 1,
    revisionSha256: current.revisionSha256, operationId: id(5), idempotencyKey: expect.any(String), input: { id: "record", expectedVersion: 2, values: { [id(3)]: "Original name" } } });
  expect(onNotice).toHaveBeenCalledWith("Reversed the edit");
  expect(onError).not.toHaveBeenCalled();
});
it("keeps the page mounted through successful and failed metadata refreshes", async () => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  const onError = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
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
  const props = { workspaceId: "workspace-a", datasetPath: "data/dataset.json", tableId: id(2), onError: vi.fn(), onFormCreated: vi.fn(), onOpenFile: vi.fn(), onOpenScheduleSettings: vi.fn() };
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
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} onLifecycleChanged={onLifecycleChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore Collection" }));
  await waitFor(() => expect(onLifecycleChanged).toHaveBeenCalledOnce());
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "invoke")).toBe(false);
  expect(backend.dataset).toHaveBeenCalledWith({ action: "describe", workspaceId: "workspace-a", datasetPath: "data/dataset.json", includeArchived: true });
});

it("loads owner pending responses and requires confirmation before clearing a saved retry", async () => {
  let cleared = false;
  backend.dataset.mockImplementation(async input => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "pendingAttempts") return { kind: "pending-attempts", datasetId: dataset.datasetId, entries: cleared ? [] : [{ reference: "b".repeat(64), operation: "Submit", recordedAtMs: 1000, revision: 2, outcome: "committed", attachmentCount: 0 }], nextAfter: null };
    cleared = true; return { kind: "attempt-reconciled", cleared: true };
  });
  const onNotice = vi.fn(), onError = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onNotice={onNotice} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear retry" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "reconcileAttempt")).toBe(false);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear retry" }));
  await screen.findByText("No pending responses. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "pendingAttempts", workspaceId: "workspace-a", datasetPath: "data/dataset.json", expectedDatasetId: id(1), limit: 50 });
  expect(backend.dataset).toHaveBeenCalledWith({ action: "reconcileAttempt", workspaceId: "workspace-a", datasetPath: "data/dataset.json", expectedDatasetId: id(1), reference: "b".repeat(64), acknowledge: true });
  expect(onNotice).toHaveBeenCalledWith("Cleared the saved response's retry"); expect(onError).not.toHaveBeenCalled();
});

it.each([{ owner: false, offline: false }, { owner: true, offline: true }])("hides pending review and recovery export for $owner owner and $offline offline", async ({ owner, offline }) => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset, copy: { offline } });
  render(<ConnectedTransactionalCollection owner={owner} workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText("Opening collection…")).toBeNull());
  expect(screen.queryByRole("button", { name: "Pending responses" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export recovery" })).toBeNull();
});

it("reports the saved recovery file through the shell notice callback", async () => {
  backend.dataset.mockImplementation(async input => input.action === "describe" ? { kind: "description", dataset } : { kind: "exported", savedPath: "C:/private/fundraiser.dohc-recovery" });
  const onNotice = vi.fn();
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onNotice={onNotice} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Export recovery" }));
  fireEvent.click(screen.getByRole("button", { name: "Save recovery file" }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Saved recovery file: C:/private/fundraiser.dohc-recovery"));
});

it("keeps archived offline Collections read-only until refresh reaches the host", async () => {
  backend.dataset.mockResolvedValueOnce({ kind: "description", dataset: { ...dataset, archived: true }, copy: { offline: true } })
    .mockResolvedValue({ kind: "description", dataset: { ...dataset, archived: true } });
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
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
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onNotice={onNotice} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel response" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "cancelAttempt")).toBe(false);
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel response" }));
  await screen.findByText("No pending responses. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "cancelAttempt", workspaceId: "workspace-a", datasetPath: "data/dataset.json", expectedDatasetId: id(1), reference: "c".repeat(64), acknowledge: true });
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
  render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} onNotice={onNotice} onLifecycleChanged={onLifecycleChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));
  await screen.findByText("form");
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "delete")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete Collection permanently" }));
  await screen.findByText("Collection deleted");
  expect(backend.dataset).toHaveBeenCalledWith({ action: "delete", workspaceId: "workspace-a", datasetPath: "data/dataset.json", expectedDatasetId: id(1), expected: deletionPreview().cursor, reviewToken: "c".repeat(64), acknowledge: true });
  expect(onLifecycleChanged).toHaveBeenCalledOnce(); expect(onNotice).toHaveBeenCalledWith("Collection deleted"); expect(onError).not.toHaveBeenCalled();
});
it.each([{ owner: false, offline: false }, { owner: true, offline: true }])("hides permanent delete for $owner owner and $offline offline", async ({ owner, offline }) => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset: { ...dataset, archived: true }, copy: { offline } });
  render(<ConnectedTransactionalCollection owner={owner} workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
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
  const props = { workspaceId: "workspace-a", datasetPath: "data/dataset.json", tableId: id(2), onError: vi.fn(), onFormCreated: vi.fn(), onOpenFile: vi.fn(), onOpenScheduleSettings: vi.fn(), onNotice: vi.fn(), onLifecycleChanged: vi.fn() };
  const view = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" })); await screen.findByText("form");
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Delete Collection permanently" }));
  view.rerender(<ConnectedTransactionalCollection {...props} workspaceId="workspace-b" />);
  await act(async () => pending.resolve({ kind: "deleted", deleted: true, datasetId: id(1) }));
  expect(props.onNotice).not.toHaveBeenCalled(); expect(props.onLifecycleChanged).not.toHaveBeenCalled(); expect(props.onError).not.toHaveBeenCalled();
  expect(screen.queryByText("Collection deleted")).toBeNull();
});

// A dataset whose Registrations table has a Confirm action, and the approval that adds a Confirm button.
function buttonApproval() {
  const CONFIRM = { operationId: id(7), tableId: id(2), name: "registrations.confirm", label: "Confirm", kind: "action" as const, access: "owner" as const, readOnly: false, fieldIds: [] };
  const before: DatasetDescription = { ...dataset, operations: [...dataset.operations, CONFIRM] };
  const after: DatasetDescription = { ...before, revision: 2, revisionSha256: "e".repeat(64),
    tables: [{ ...before.tables[0]!, fields: [...before.tables[0]!.fields, { fieldId: id(8), name: "Confirm", type: "button" }] }] };
  const definition = { formatVersion: 1 as const, datasetId: id(1), name: "Fundraiser", schemaPath: "Fundraiser/schema.sql", operationsPath: "Fundraiser/operations.js",
    tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "name", fields: [{ fieldId: id(3), name: "Name", sqlColumn: "name", type: "text" as const, required: true, unique: true }] }],
    operations: [{ operationId: id(9), name: "read", label: "Read", tableId: id(2), kind: "read" as const, access: "owner" as const, readOnly: true, fieldIds: [id(3)] }] };
  const previousRevision = { datasetId: id(1), revision: 1, revisionSha256: before.revisionSha256, definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64), definition };
  const nextRevision = { ...structuredClone(previousRevision), revision: 2, revisionSha256: after.revisionSha256 };
  nextRevision.definition.tables[0]!.fields.push({ fieldId: id(8), name: "Confirm", type: "button" } as never);
  const expected = { workspaceId: "workspace-a", datasetId: id(1), hostEpoch: "epoch", revision: 4, digest: "f".repeat(64), approvedRevisionHash: before.revisionSha256 };
  const preparation = { preparationId: id(10), previousRevision, revision: nextRevision, expected, sourceDigest: "a".repeat(64), approvalDigest: "b".repeat(64),
    schemaSql: "schema", operationSource: "source", migrationSql: "SELECT 1;", expiresAtMs: Date.now() + 600_000,
    candidate: { candidateId: id(11), expected, approvedRevisionHash: after.revisionSha256, checkpointSha256: "a".repeat(64), expiresAtMs: Date.now() + 600_000,
      preview: { tables: [{ table: "registrations", beforeRows: 0, afterRows: 0, changedRows: 0 }], firstPage: { changes: [], nextCursor: null } } } };
  return { before, after, preparation, CONFIRM };
}

describe("a dataset table's ⚡ panel", () => {
  const onTable = (automationId: string, table: string): Extract<ListCollectionAutomationsResult, { status: "read" }>["automations"][number] => ({
    valid: true, automationId: `collection:Fundraiser#${automationId}`, definitionHash: "0123456789abcdef", cannotRun: null,
    reach: { kind: "checked", steps: [] }, lastRun: null,
    automation: { id: automationId, name: automationId, enabled: true, when: { kind: "record-added", table }, if: null,
      do: [{ kind: "set", values: [{ field: "Name", value: { kind: "literal", value: "Welcome" } }], records: null, operation: null }] },
  });
  const renderPage = () => render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={vi.fn()} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);

  it("names the automations file from Customize… once dohc finds the dataset's folder", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    renderPage();
    const customize = await screen.findByRole("button", { name: "Customize…" });
    customize.focus();
    fireEvent.click(customize);
    // The tab shows the table, so the dialog names it too.
    const dialog = await screen.findByRole("dialog", { name: "Customize Registrations" });
    expect(within(dialog).getByText("Fundraiser/automations.yaml")).toBeTruthy();
    // Without a workspace shell there is no agent to ask.
    expect(within(dialog).queryByTestId("ask-agent")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(customize);
  });

  it("finds the dataset's folder, counts this table's automations, and lists them in the panel", async () => {
    const donors = { tableId: id(9), name: "Donors", fields: dataset.tables[0]!.fields };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: { ...dataset, tables: [...dataset.tables, donors] } });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [onTable("welcome", "Registrations"), onTable("thank", "Donors")] });
    renderPage();
    const button = await screen.findByTestId("collection-automations-button");
    await waitFor(() => expect(button.textContent).toBe("Automations1"));
    expect(backend.findDatasetCollection).toHaveBeenCalledWith({ workspaceId: "workspace-a", datasetId: id(1) });
    expect(backend.listCollectionAutomations).toHaveBeenCalledWith({ workspaceId: "workspace-a", collectionPath: "Fundraiser" });
    fireEvent.click(button);
    await screen.findByTestId("automation-welcome");
    expect(screen.queryByTestId("automation-thank")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("collection-automations-panel")).toBeNull());
  });

  it.each([
    [{ status: "cannot-run", reason: "This Collection's rules are not approved yet, so its automations cannot run." }, "This Collection's rules are not approved yet, so its automations cannot run."],
    [{ status: "unavailable" }, "This Collection's automations run on its owner's computer."],
  ] as Array<[FindDatasetCollectionResult, string]>)("says why the panel has no automations to show when main answers %o", async (found, sentence) => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    backend.findDatasetCollection.mockResolvedValue(found);
    renderPage();
    fireEvent.click(await screen.findByTestId("collection-automations-button"));
    expect((await screen.findByTestId("collection-automations-panel")).textContent).toContain(sentence);
    expect(backend.listCollectionAutomations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close automations" }));
    expect(screen.queryByTestId("collection-automations-panel")).toBeNull();
  });

  it("opens the builder on a button nothing uses from Fields and names, with the button as its trigger", async () => {
    const withButton: DatasetDescription = { ...dataset, tables: [{ ...dataset.tables[0]!, fields: [...dataset.tables[0]!.fields, { fieldId: id(6), name: "Confirm", type: "button" }] }] };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [] });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [{ field: "Confirm", table: "Registrations", state: { kind: "no-automation", reason: "No automation uses this button." } }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose what it does: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Confirm");
    expect((within(panel).getByRole("combobox", { name: "Trigger" }) as HTMLSelectElement).value).toBe("button");
    expect((within(panel).getByRole("combobox", { name: "Button" }) as HTMLSelectElement).value).toBe("Confirm");
  });

  it("adds an action as a button, closes Fields after approval, and opens the builder on it, saving nothing before Save", async () => {
    const { before, after, preparation } = buttonApproval();
    let current = before;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "describe") return { kind: "description", dataset: current };
      if (input.action === "prepareSchemaChange") return { kind: "migration-prepared", ...preparation };
      if (input.action === "approveMigration") { current = after; return { kind: "migrated" }; }
      throw new Error(`Unexpected ${input.action}`);
    });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [] });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
    const onError = vi.fn();
    render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
    // A button changes only names, so its review asks for no confirmation checkbox.
    fireEvent.click(await screen.findByRole("button", { name: "Approve change" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fields and names" })).toBeNull());
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Confirm");
    expect((within(panel).getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value).toBe("registrations.confirm");
    expect((within(panel).getByRole("textbox", { name: "Step 1, input 1 name" }) as HTMLInputElement).value).toBe("id");
    expect((within(panel).getByRole("textbox", { name: "Step 1, id, formula" }) as HTMLInputElement).value).toBe("record.id");
    expect(document.activeElement).toBe(within(panel).getByRole("textbox", { name: "Name" }));
    expect(screen.queryByRole("heading", { name: "Review Collection change" })).toBeNull();
    expect(backend.writeCollectionAutomations).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("fills in the action named for a button nothing uses when Choose what it does opens the builder", async () => {
    const { before } = buttonApproval();
    const withButton: DatasetDescription = { ...before, tables: [{ ...before.tables[0]!, fields: [...before.tables[0]!.fields, { fieldId: id(8), name: "Confirm", type: "button" }] }] };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [] });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [{ field: "Confirm", table: "Registrations", state: { kind: "no-automation", reason: "No automation uses this button." } }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose what it does: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    const name = within(panel).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect((within(panel).getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value).toBe("registrations.confirm");
    expect((within(panel).getByRole("textbox", { name: "Step 1, input 1 name" }) as HTMLInputElement).value).toBe("id");
    expect((within(panel).getByRole("textbox", { name: "Step 1, id, formula" }) as HTMLInputElement).value).toBe("record.id");
  });

  it("fills in no step for a button whose name two actions share", async () => {
    const { before, CONFIRM } = buttonApproval();
    const twice: DatasetDescription = { ...before, operations: [...before.operations, { ...CONFIRM, operationId: id(12), name: "registrations.confirmAgain" }],
      tables: [{ ...before.tables[0]!, fields: [...before.tables[0]!.fields, { fieldId: id(8), name: "Confirm", type: "button" }] }] };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: twice });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [] });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [{ field: "Confirm", table: "Registrations", state: { kind: "no-automation", reason: "No automation uses this button." } }] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose what it does: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Confirm");
    expect(within(panel).queryByRole("combobox", { name: "Step 1, action" })).toBeNull();
  });

  it("neither refreshes nor opens the builder when the page closed before an approval finished", async () => {
    const { before, after, preparation } = buttonApproval();
    const approved = Promise.withResolvers<{ kind: "migrated" }>();
    let current = before;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "describe") return { kind: "description", dataset: current };
      if (input.action === "prepareSchemaChange") return { kind: "migration-prepared", ...preparation };
      if (input.action === "approveMigration") { current = after; return await approved.promise; }
      throw new Error(`Unexpected ${input.action}`);
    });
    backend.findDatasetCollection.mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "read", contentHash: "b".repeat(64), addsStay: [], automations: [] });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
    const onError = vi.fn();
    const { unmount } = render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve change" }));
    await waitFor(() => expect(backend.dataset.mock.calls.some(([input]) => input.action === "approveMigration")).toBe(true));
    const describes = backend.dataset.mock.calls.filter(([input]) => input.action === "describe").length;
    unmount();
    await act(async () => approved.resolve({ kind: "migrated" }));
    expect(backend.dataset.mock.calls.filter(([input]) => input.action === "describe")).toHaveLength(describes);
    expect(onError).not.toHaveBeenCalled();
  });

  it("says when dohc could not find the automations, through the error hook and in the panel, and tries again", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    backend.findDatasetCollection.mockRejectedValueOnce(new Error("engine stopped")).mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "missing" });
    const onError = vi.fn();
    render(<ConnectedTransactionalCollection workspaceId="workspace-a" datasetPath="data/dataset.json" tableId={id(2)} onError={onError} onFormCreated={vi.fn()} onOpenFile={vi.fn()} onOpenScheduleSettings={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("collection-automations-button"));
    const panel = await screen.findByTestId("collection-automations-panel");
    await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("false"));
    expect(panel.textContent).toContain("dohc could not read this Collection's automations.");
    expect(onError).toHaveBeenCalledWith("dohc could not read this Collection's automations.", expect.any(Error), expect.any(Function));
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No automations in this Collection yet.")).toBeTruthy();
  });
});
