// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { CollectionMigrationReviewDialog, type CollectionMigrationReviewDialogProps } from "./CollectionMigrationReviewDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function prep(): DatasetMigrationPreparation {
  const base: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Fundraiser", schemaPath: "schema.sql", operationsPath: "operations.js", tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "name", fields: [{ fieldId: id(3), name: "Name", sqlColumn: "name", type: "text", required: true, unique: true }] }], operations: [{operationId:id(12),name:"read",label:"Read",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3)]}] };
  const next = structuredClone(base); next.tables[0]!.fields.push({ fieldId: id(4), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false });
  const revision = (definition: DatasetDefinition, number: number): DatasetRevision => ({ datasetId: definition.datasetId, definition, revision: number, revisionSha256: `${number}`.repeat(64), definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64) });
  const expected = { workspaceId: "workspace-a", datasetId: id(1), hostEpoch: "epoch", approvedRevisionHash: "a".repeat(64), revision: 1, digest: "e".repeat(64) };
  return { preparationId: id(10), previousRevision: revision(base, 1), revision: revision(next, 2), expected, sourceDigest: "f".repeat(64), approvalDigest: "1".repeat(64), schemaSql: "CREATE TABLE registrations...", operationSource: "export function create() {}", migrationSql: "ALTER TABLE registrations ADD receipt TEXT;", expiresAtMs: Date.now() + 30_000,
    candidate: {candidateId: id(11), expected, approvedRevisionHash: "2".repeat(64), checkpointSha256: "c".repeat(64), expiresAtMs: Date.now() + 30_000,
      preview: {tables: [{table: "registrations", beforeRows: 2, afterRows: 2, changedRows: 2}], firstPage: {changes: [{table: "registrations", kind: "update", key: {id: "one"}, before: {name: "Before"}, after: {name: "After"}}], nextCursor: "next"}}} };
}
function setup(overrides: Partial<CollectionMigrationReviewDialogProps> = {}) {
  const onPrepare = vi.fn<CollectionMigrationReviewDialogProps["onPrepare"]>(async () => prep()), onApprove = vi.fn<CollectionMigrationReviewDialogProps["onApprove"]>(async () => undefined), onDiscard = vi.fn<CollectionMigrationReviewDialogProps["onDiscard"]>(async () => undefined), onError = vi.fn(), onClose = vi.fn();
  const props = { workspaceId: "workspace-a", datasetId: id(1), onClose, onPrepare, onApprove, onDiscard, onLoadPreview: vi.fn(async () => ({changes: [], nextCursor: null})), onError, ...overrides };
  return { onPrepare, onApprove, onDiscard, onError, onClose, props, ...render(<CollectionMigrationReviewDialog {...props} />) };
}
afterEach(cleanup);
describe("CollectionMigrationReviewDialog", () => {
  it("requires fresh preparation after an uncertain approval instead of replaying migration SQL", async () => {
    const onApprove = vi.fn<CollectionMigrationReviewDialogProps["onApprove"]>().mockRejectedValue(new Error("Collection changed"));
    const { onPrepare, onError } = setup({ onApprove }); fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "migrations/002.sql" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByText("Registrations · Receipt"); expect((screen.getByRole("button", { name: "Approve change" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i })); fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce()); expect(screen.queryByRole("button", { name: "Approve change" })).toBeNull();
    await act(async () => onError.mock.calls[0]![2]()); expect(onApprove).toHaveBeenCalledOnce(); expect(onPrepare).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole("button", { name: "Approve change" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("captures two source paths, shows before/after fields and approves the exact review", async () => {
    const { onPrepare, onApprove, onClose } = setup(); fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "migrations/002.sql" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByText("Registrations · Receipt"); expect(onPrepare.mock.calls[0]![0]).toMatchObject({ workspaceId: "workspace-a", datasetId: id(1), descriptorPath: "dataset.json", migrationPath: "migrations/002.sql" });
    expect(screen.getByText("Added")).toBeTruthy(); expect(screen.getByText("ALTER TABLE registrations ADD receipt TEXT;")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i })); fireEvent.click(screen.getByRole("button", { name: "Approve change" })); await waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
    expect(onApprove.mock.calls[0]![0]).toEqual({ workspaceId: "workspace-a", preparationId: id(10), revisionSha256: "2".repeat(64), approvalDigest: "1".repeat(64) }); expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires safe distinct paths inline", () => {
    const { onPrepare } = setup(); fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "dataset.json" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(screen.getByRole("alert").textContent).toContain("separate"); expect(onPrepare).not.toHaveBeenCalled();
  });
  it("reports prepare failure through Notices and retries the same paths", async () => {
    const error = new Error("Collection changed"); const onPrepare = vi.fn<CollectionMigrationReviewDialogProps["onPrepare"]>().mockRejectedValueOnce(error).mockResolvedValue(prep()); const { onError } = setup({ onPrepare });
    fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "migrations/002.sql" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" })); await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull(); await act(async () => onError.mock.calls[0]![2]!()); await screen.findByText("Registrations · Receipt"); expect(onPrepare.mock.calls[1]![0]).toEqual(onPrepare.mock.calls[0]![0]);
  });
  it("aborts stale preparation after the workspace changes", async () => {
    let resolve!: (value: DatasetMigrationPreparation) => void; const onPrepare = vi.fn<CollectionMigrationReviewDialogProps["onPrepare"]>((_input, signal) => new Promise<DatasetMigrationPreparation>((res, _reject) => { resolve = res; signal.addEventListener("abort", () => undefined); })); const { props, rerender, onError } = setup({ onPrepare });
    fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "migrations/002.sql" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" })); rerender(<CollectionMigrationReviewDialog {...props} workspaceId="workspace-b" />); resolve(prep()); await act(async () => undefined); expect(onError).not.toHaveBeenCalled(); expect(screen.queryByText("Registrations · Receipt")).toBeNull();
  });
  it("requests cleanup when closing a prepared review", async () => {
    const { onDiscard, onClose } = setup(); fireEvent.change(screen.getByLabelText("Migration file"), { target: { value: "migrations/002.sql" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" })); await screen.findByText("Registrations · Receipt"); fireEvent.click(screen.getByRole("button", { name: "Discard review" })); await waitFor(() => expect(onDiscard).toHaveBeenCalledWith({ workspaceId: "workspace-a", preparationId: id(10) }, expect.any(AbortSignal))); expect(onClose).toHaveBeenCalledOnce();
  });
  it.each(["offline", "expired"])("dismisses without waiting for %s cleanup", async reason => {
    let reject!: (error: Error) => void;
    const onDiscard = vi.fn<CollectionMigrationReviewDialogProps["onDiscard"]>(() => new Promise((_resolve, fail) => { reject = fail; }));
    const initialPreparation = prep(); if (reason === "expired") initialPreparation.expiresAtMs = Date.now() - 1;
    const { onClose, onError, unmount } = setup({ initialPreparation, onDiscard });
    if (reason === "offline") fireEvent.click(screen.getByRole("button", { name: "Discard review" }));
    else fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce());
    unmount();
    await act(async () => reject(new Error(reason)));
    expect(onError).not.toHaveBeenCalled();
  });
  it("lets another review start while failed cleanup finishes", async () => {
    const onDiscard = vi.fn<CollectionMigrationReviewDialogProps["onDiscard"]>().mockRejectedValue(new Error("review expired"));
    const { onClose, onError } = setup({ initialPreparation: prep(), onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Review another change" }));
    expect(screen.getByRole("button", { name: "Review change" }).hasAttribute("disabled")).toBe(false);
    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  });
  it("shows a Collection rename in the captured review", () => {
    const initialPreparation=prep();initialPreparation.revision.definition.name="Community tournament";
    setup({initialPreparation,generatedChange:true});
    expect(screen.getByText("Collection name changed")).toBeTruthy();
    expect(screen.getByText("Fundraiser")).toBeTruthy();
    expect(screen.getAllByText("Community tournament").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Collection definition")).toBeNull();
  });
  it("shows an added button by its name and type, and a renamed button by its name", () => {
    const added=prep();added.revision.definition.tables[0]!.fields.push({fieldId:id(5),name:"Send receipt",type:"button"});
    setup({initialPreparation:added,generatedChange:true});
    expect(screen.getByText("Send receipt · button")).toBeTruthy();
    cleanup();
    const renamed=prep();renamed.previousRevision.definition.tables[0]!.fields.push({fieldId:id(5),name:"Send receipt",type:"button"});
    renamed.revision.definition.tables[0]!.fields.push({fieldId:id(5),name:"Email receipt",type:"button"});
    setup({initialPreparation:renamed,generatedChange:true});
    expect(screen.getByText("Name: Send receipt")).toBeTruthy();
    expect(screen.getByText("Name: Email receipt")).toBeTruthy();
  });
  it("shows actual record changes and pages the exact preparation", async () => {
    const onLoadPreview = vi.fn<CollectionMigrationReviewDialogProps["onLoadPreview"]>(async () => ({changes: [{table: "registrations", kind: "delete", key: {id: "two"}, before: {name: "Last record"}, after: null}], nextCursor: null}));
    setup({initialPreparation: prep(), onLoadPreview});
    expect(screen.getByText('"Before"')).toBeTruthy(); expect(screen.getByText('"After"')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name: "More changes"})); await screen.findByText('"Last record"');
    expect(onLoadPreview).toHaveBeenCalledWith({workspaceId: "workspace-a", preparationId: id(10), after: "next", limit: 50}, expect.any(AbortSignal));
  });
  it("refuses approval when the preview belongs to another checkpoint", () => {
    const initialPreparation = prep(); initialPreparation.candidate.expected = {...initialPreparation.expected, digest: "0".repeat(64)};
    const {onApprove} = setup({initialPreparation});
    fireEvent.click(screen.getByRole("checkbox", {name: /reviewed this change/i}));
    expect(screen.getByRole("button", {name: "Approve change"}).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/no matching data preview/)).toBeTruthy(); expect(onApprove).not.toHaveBeenCalled();
  });
  it("requires a new preview after its candidate expires", async () => {
    const initialPreparation = prep(); initialPreparation.candidate.expiresAtMs = Date.now() - 1;
    const {onApprove} = setup({initialPreparation});
    fireEvent.click(screen.getByRole("checkbox", {name: /reviewed this change/i})); fireEvent.click(screen.getByRole("button", {name: "Approve change"}));
    expect(await screen.findByText("This review expired. Prepare the change again.")).toBeTruthy(); expect(onApprove).not.toHaveBeenCalled();
  });
});
