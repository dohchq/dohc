// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetDescription, DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import { CollectionFieldsDialog, type CollectionFieldsDialogProps } from "./CollectionFieldsDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "People", revision: 1, revisionSha256: "a".repeat(64), operations: [],
  tables: [{ tableId: id(2), name: "People", fields: [{ fieldId: id(3), name: "Name", type: "text", required: false, unique: false }] }] };
function preparation(): DatasetMigrationPreparation {
  const revision: DatasetRevision = { datasetId: id(1), revision: 1, revisionSha256: dataset.revisionSha256, definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64),
    definition: { formatVersion: 1, datasetId: id(1), name: "People", schemaPath: "people/schema.sql", operationsPath: "people/operations.js", operations: [],
      tables: [{ ...dataset.tables[0]!, sqlName: "people", primaryKey: "name", fields: [{ ...dataset.tables[0]!.fields[0]!, sqlColumn: "name" }] }] } };
  const next = structuredClone(revision); next.revision = 2; next.revisionSha256 = "e".repeat(64);
  next.definition.tables[0]!.fields.push({ fieldId: id(4), name: "Note", type: "text", required: false, unique: false, sqlColumn: "note" });
  const expected = { workspaceId: "w", datasetId: id(1), hostEpoch: "epoch", revision: 4, digest: "f".repeat(64), approvedRevisionHash: dataset.revisionSha256 };
  return { preparationId: id(9), previousRevision: revision, revision: next, expected,
    sourceDigest: "a".repeat(64), approvalDigest: "b".repeat(64), schemaSql: "schema", operationSource: "source", migrationSql: "ALTER TABLE people ADD note TEXT;", expiresAtMs: Date.now() + 600_000,
    candidate: {candidateId: id(10), expected, approvedRevisionHash: next.revisionSha256, checkpointSha256: "a".repeat(64), expiresAtMs: Date.now() + 600_000,
      preview: {tables: [{table: "people", beforeRows: 0, afterRows: 0, changedRows: 0}], firstPage: {changes: [], nextCursor: null}}} };
}
function setup(overrides: Partial<CollectionFieldsDialogProps> = {}) {
  const props: CollectionFieldsDialogProps = { workspaceId: "w", dataset, tableId: id(2), onPrepare: vi.fn(async () => preparation()), onApprove: vi.fn(async () => {}),
    onDiscard: vi.fn(async () => {}), onLoadPreview: vi.fn(async () => ({changes: [], nextCursor: null})), onClose: vi.fn(), onError: vi.fn(), onReviewSource: vi.fn(), ...overrides };
  return { props, ...render(<CollectionFieldsDialog {...props} />) };
}
afterEach(cleanup);

it("adds a field without source paths and approves only the captured revision", async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await screen.findByText("People · Note");
  expect(props.onPrepare).toHaveBeenCalledWith({ kind: "addField", tableId: id(2), field: { name: "Note", type: "text", required: false, unique: false } }, expect.any(AbortSignal));
  expect(screen.queryByLabelText("Collection definition")).toBeNull();
  expect(screen.getByText(/Approval applies this exact result/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this change/ }));
  fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
  await waitFor(() => expect(props.onApprove).toHaveBeenCalledWith({ workspaceId: "w", preparationId: id(9), revisionSha256: "e".repeat(64), approvalDigest: "b".repeat(64) }, expect.any(AbortSignal)));
});

it("renames using the existing field ID and offers source review", async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText("Change"), { target: { value: "renameField" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Full name" } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await waitFor(() => expect(props.onPrepare).toHaveBeenCalledWith({ kind: "renameField", tableId: id(2), fieldId: id(3), name: "Full name" }, expect.any(AbortSignal)));
  cleanup(); const next = setup(); fireEvent.click(screen.getByRole("button", { name: "Review source change" })); expect(next.props.onReviewSource).toHaveBeenCalledOnce();
});

it("validates required defaults before capture and keeps retry on Notices", async () => {
  const onPrepare = vi.fn().mockRejectedValueOnce(new Error("Custom actions")).mockResolvedValue(preparation());
  const { props } = setup({ onPrepare });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  expect(screen.getByRole("alert").textContent).toContain("needs a default"); expect(onPrepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).toBeNull();
  const retry = vi.mocked(props.onError).mock.calls[0]![2]!;
  await act(async () => retry());
  await screen.findByText("People · Note");
});

it("discards stale review responses after workspace switching", async () => {
  let resolve!: (value: DatasetMigrationPreparation) => void;
  const onPrepare = vi.fn<CollectionFieldsDialogProps["onPrepare"]>(() => new Promise(res => { resolve = res; }));
  const { props, rerender } = setup({ onPrepare });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  rerender(<CollectionFieldsDialog {...props} workspaceId="other" />);
  await act(async () => resolve(preparation()));
  expect(onPrepare.mock.calls[0]![1].aborted).toBe(true);
  expect(screen.queryByText("People · Note")).toBeNull();
  expect(props.onError).not.toHaveBeenCalled();
});
