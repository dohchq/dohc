// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetRecoveryPreparation } from "@dohc/cli/dataset";
import { deferred } from "../testing/deferred";
import { ConnectedCollectionRecoveryRestore } from "./ConnectedCollectionRecoveryRestore";

const backend = vi.hoisted(() => ({ dataset: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function recovery(workspaceId = "w"): DatasetRecoveryPreparation {
  return { transferId: id(8), manifestSha256: "a".repeat(64), sourceCursor: { workspaceId, datasetId: id(1), hostEpoch: "old", approvedRevisionHash: "b".repeat(64), revision: 3, digest: "c".repeat(64) },
    revision: { datasetId: id(1), revision: 1, revisionSha256: "b".repeat(64), definitionSha256: "d".repeat(64), schemaSha256: "e".repeat(64), operationsSha256: "f".repeat(64),
      definition: { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "data/schema.sql", operationsPath: "data/operations.js", operations: [{ operationId: id(4), name: "read", label: "Read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }],
        tables: [{ tableId: id(2), name: "People", sqlName: "people", primaryKey: "name", fields: [{ fieldId: id(3), name: "Name", type: "text", sqlColumn: "name", required: true, unique: true }] }] } } };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const props = { workspaceId: "w", onRestored: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
  return { props, ...render(<ConnectedCollectionRecoveryRestore {...props} />) };
}
it("claims the reviewed archive and selects its first table only after confirmation", async () => {
  const value = recovery();
  backend.dataset.mockImplementation(async input => input.action === "prepareRecovery" ? { kind: "recovery-prepared", recovery: value } : {
    kind: "recovery-claimed", transferId: value.transferId, manifestSha256: value.manifestSha256, sourceCursor: value.sourceCursor, targetCursor: { ...value.sourceCursor, hostEpoch: "new" } });
  const { props } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Choose recovery file" }));
  await screen.findByText("Registrations");
  expect(props.onRestored).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Restore Collection" }));
  await waitFor(() => expect(props.onRestored).toHaveBeenCalledWith(id(1), id(2)));
  expect(backend.dataset).toHaveBeenCalledWith({ action: "claimRecovery", workspaceId: "w", datasetId: id(1), transferId: value.transferId, manifestSha256: value.manifestSha256, sourceCursor: value.sourceCursor, oldHostStopped: true });
  expect(props.onClose).toHaveBeenCalledOnce(); expect(props.onError).not.toHaveBeenCalled();
});
it("discards a recovery from another workspace before allowing a claim", async () => {
  backend.dataset.mockImplementation(async input => input.action === "prepareRecovery" ? { kind: "recovery-prepared", recovery: recovery("other") } : { kind: "recovery-discarded" });
  const { props } = setup(); fireEvent.click(screen.getByRole("button", { name: "Choose recovery file" }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce());
  expect(backend.dataset).toHaveBeenCalledWith({ action: "discardRecovery", workspaceId: "w", transferId: id(8) });
  expect(screen.queryByRole("button", { name: "Restore Collection" })).toBeNull(); expect(props.onRestored).not.toHaveBeenCalled();
});
it("discards a late native file selection in its original workspace", async () => {
  const pending = deferred<unknown>();
  backend.dataset.mockImplementation(input => input.action === "prepareRecovery" ? pending.promise : Promise.resolve({ kind: "recovery-discarded" }));
  const { props, rerender } = setup(); fireEvent.click(screen.getByRole("button", { name: "Choose recovery file" }));
  rerender(<ConnectedCollectionRecoveryRestore {...props} workspaceId="other" />);
  await act(async () => pending.resolve({ kind: "recovery-prepared", recovery: recovery() }));
  expect(backend.dataset).toHaveBeenCalledWith({ action: "discardRecovery", workspaceId: "w", transferId: id(8) });
  expect(props.onRestored).not.toHaveBeenCalled(); expect(props.onError).not.toHaveBeenCalled();
});
it("does not announce a claim receipt for another workspace", async () => {
  const value = recovery();
  backend.dataset.mockImplementation(async input => input.action === "prepareRecovery" ? { kind: "recovery-prepared", recovery: value } : {
    kind: "recovery-claimed", transferId: value.transferId, manifestSha256: value.manifestSha256, sourceCursor: value.sourceCursor, targetCursor: { ...value.sourceCursor, workspaceId: "other" } });
  const { props } = setup(); fireEvent.click(screen.getByRole("button", { name: "Choose recovery file" })); await screen.findByText("Registrations");
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Restore Collection" }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce()); expect(props.onRestored).not.toHaveBeenCalled();
});
