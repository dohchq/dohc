// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { CollectionHistoryRevisionDetails } from "./CollectionHistoryRevisionDetails";
import { deferred } from "../testing/deferred";

afterEach(cleanup);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "registrations/schema.sql", operationsPath: "registrations/rules.js",
  tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "id", fields: [{ fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true }] }],
  operations: [{ operationId: id(4), name: "read", label: "Read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }] };
const version = (revision: number) => ({ schemaSql: "schema", operationSource: `saved rules ${revision}`,
  revision: describeDatasetRevision({ definition, revision, schemaSql: "schema", operationSource: `saved rules ${revision}` }) });
const before = version(1), after = version(2);
it("compares immutable rules and reviews only the selected change, with field/source conflict paths", async () => {
  const restore = vi.fn(async () => {}), open = vi.fn(), fields = vi.fn(), review = vi.fn();
  render(<CollectionHistoryRevisionDetails beforeHash={before.revision.revisionSha256} afterHash={after.revision.revisionSha256}
    onLoadRevision={async hash => hash === before.revision.revisionSha256 ? before : after} onRestoreRevision={restore}
    onOpenSource={open} onEditFields={fields} onReviewSource={review} onError={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Review reversal" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Compare change" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review reversal" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith(before.revision.revisionSha256, after.revision.revisionSha256, expect.any(AbortSignal)));
  fireEvent.click(screen.getAllByText("Rules", { selector: "summary" })[0]!);
  expect(screen.getByText(before.operationSource)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Open current rules file" })[0]!);
  expect(open).toHaveBeenCalledWith(definition.operationsPath);
  fireEvent.click(screen.getByRole("button", { name: "Fields and names" })); expect(fields).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Review source migration" })); expect(review).toHaveBeenCalledOnce();
});
it("discards pending source replies when History closes and does not run stale retries", async () => {
  const pending = deferred<ReturnType<typeof version>>(), error = vi.fn(), load = vi.fn(() => pending.promise);
  const view = render(<CollectionHistoryRevisionDetails beforeHash={before.revision.revisionSha256} afterHash={after.revision.revisionSha256}
    onLoadRevision={load} onError={error} />);
  fireEvent.click(screen.getByRole("button", { name: "Compare change" })); view.unmount();
  expect(load.mock.calls[0]?.length).toBe(2);
  await act(async () => pending.reject(new Error("Offline")));
  expect(error).not.toHaveBeenCalled();
});
