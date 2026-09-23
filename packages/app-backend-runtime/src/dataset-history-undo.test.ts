import { expect, it } from "vitest";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { datasetHistoryUndo } from "./dataset-history-undo.js";

const hash = "a".repeat(64);
const approved = { revision: 2, revisionSha256: hash, definition: {
  tables: [{ tableId: "table", fields: [{ fieldId: "name", name: "Name" }] }],
  operations: [{ operationId: "edit-id", name: "edit", tableId: "table", kind: "edit", readOnly: false, reversible: true, fieldIds: ["name"] }],
} } as DatasetRevision;
const receipt = JSON.stringify({ id: "record", version: 3, priorValues: { name: "Alice" } });
it("returns bounded approved prior values and the receipt version", () => {
  expect(datasetHistoryUndo(approved, "edit", hash, receipt)).toEqual({ operationId: "edit-id", revision: 2, revisionSha256: hash, recordId: "record", expectedVersion: 3, fields: [{ fieldId: "name", name: "Name", value: "Alice" }] });
});
it("does not expose prior values after a rule change or without explicit reversal support", () => {
  expect(datasetHistoryUndo(approved, "edit", "b".repeat(64), receipt)).toBeUndefined();
  for (const override of [{ reversible: undefined }, { kind: "action" }, { kind: "delete" }, { fieldIds: [] }]) {
    const changed = structuredClone(approved); Object.assign(changed.definition.operations[0]!, override);
    expect(datasetHistoryUndo(changed, "edit", hash, receipt)).toBeUndefined();
  }
});
it.each(["null", "{}", JSON.stringify({ id: 1, version: 3 }), JSON.stringify({ id: 1, version: 3, priorValues: { secret: "private" } }), JSON.stringify({ id: 1, version: 3, priorValues: { name: "a".repeat(17000) } })])("omits an unusable edit receipt", value => {
  expect(datasetHistoryUndo(approved, "edit", hash, value)).toBeUndefined();
});
