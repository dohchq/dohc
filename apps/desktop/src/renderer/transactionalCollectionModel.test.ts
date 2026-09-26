import { expect, it } from "vitest";
import { isGeneratedRecordIdField, type TransactionalField } from "./transactionalCollectionModel";

it("hides only fields explicitly marked as generated record identities", () => {
  const field: TransactionalField = { fieldId: "primary", name: "Renamed identity", type: "text", required: true, unique: true, generated: "record-id" };
  expect(isGeneratedRecordIdField(field)).toBe(true);
  const { generated: _, ...userField } = field;
  expect(isGeneratedRecordIdField(userField)).toBe(false);
  expect(isGeneratedRecordIdField({ ...userField, name: "Record ID" })).toBe(false);
});
