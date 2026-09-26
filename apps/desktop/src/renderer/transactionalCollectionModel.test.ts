import { expect, it } from "vitest";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import { isGeneratedRecordIdField, type TransactionalField } from "./transactionalCollectionModel";

it("identifies generated text keys without hiding user-supplied keys or namesakes", () => {
  const table = { tableId: "table", primaryKeyFieldId: "primary" };
  const field: TransactionalField = { fieldId: "primary", name: "Renamed identity", type: "text", required: true, unique: true };
  const create: DatasetOperation = { operationId: "create", name: "create", label: "Create", tableId: "table", kind: "create", access: "owner", readOnly: false, fieldIds: ["user-field"] };
  expect(isGeneratedRecordIdField(field, table, [create])).toBe(true);
  expect(isGeneratedRecordIdField(field, table, [])).toBe(true);
  expect(isGeneratedRecordIdField(field, table, [{ ...create, fieldIds: ["primary"] }])).toBe(false);
  expect(isGeneratedRecordIdField({ ...field, type: "number" }, table, [create])).toBe(false);
  expect(isGeneratedRecordIdField({ ...field, fieldId: "user-field", name: "Record ID" }, table, [create])).toBe(false);
  expect(isGeneratedRecordIdField(field, { tableId: "table" }, [create])).toBe(false);
});
