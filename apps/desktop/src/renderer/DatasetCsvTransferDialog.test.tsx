// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransactionalDatasetDescription } from "./transactionalCollectionModel";
import { DatasetCsvTransferDialog } from "./DatasetCsvTransferDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: TransactionalDatasetDescription = { datasetId: id(1), name: "Fundraiser", revision: 2, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "Registrations", fields: [
  { fieldId: id(3), name: "Name", type: "text", required: true, unique: false }, { fieldId: id(4), name: "Amount", type: "number", required: false, unique: false },
] }], operations: [
  { operationId: id(5), name: "create", label: "Create registration", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(3), id(4)] },
  { operationId: id(6), name: "read", label: "Read registrations", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
] };
function setup() {
  const onSave = vi.fn<(file: { name: string; content: string; contentType: string }, signal: AbortSignal) => Promise<void>>(async () => undefined), invoke = vi.fn(async () => ({ result: { rows: [], nextCursor: null } }));
  render(<DatasetCsvTransferDialog workspaceId="workspace-a" dataset={dataset} tableId={id(2)} invoke={invoke} onSave={onSave} onClose={vi.fn()} onError={vi.fn()} />);
  return { onSave, invoke };
}
describe("DatasetCsvTransferDialog", () => {
  afterEach(cleanup);
  it("previews an import and does not submit until the owner starts it", async () => {
    const { onSave, invoke } = setup();
    fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: "Name,Amount\nAlice,3" } }); fireEvent.click(screen.getByRole("button", { name: "Preview CSV" }));
    expect(screen.getByText("1 rows · 0 rows with input errors")).toBeTruthy(); expect(invoke).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce()); expect(onSave).toHaveBeenCalledOnce();
  });
  it("exports through the selected read action and saves the governed CSV", async () => {
    const { onSave, invoke } = setup(); fireEvent.click(screen.getByRole("button", { name: "Export CSV" })); fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[1]!);
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce()); await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: "Registrations.csv", contentType: "text/csv;charset=utf-8", content: "Name,Amount\r\n" });
  });
});
