import type { DatasetDefinition, DatasetField, DatasetOperation, DatasetTable } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";

export interface TransactionalFieldDraft {
  name: string;
  type: Exclude<DatasetField["type"], "relation">;
  required: boolean;
  unique: boolean;
  options?: string[];
  default?: AppBackendJson;
}

/** Builds inspectable transactional metadata. The host still validates and approves it. */
export function datasetDefinitionFromDrafts(input: {
  datasetId?: string;
  name: string;
  schemaPath: string;
  operationsPath: string;
  tableId?: string;
  fields: readonly TransactionalFieldDraft[];
}): DatasetDefinition {
  const datasetId = input.datasetId ?? crypto.randomUUID();
  const tableId = input.tableId ?? crypto.randomUUID();
  const primaryFieldId = crypto.randomUUID();
  const primary: DatasetField = {
    fieldId: primaryFieldId, name: "Record ID", sqlColumn: "id", type: "text", required: true, unique: true,
  };
  const fields: DatasetField[] = [primary, ...input.fields.map(draft => {
    const fieldId = crypto.randomUUID();
    const sqlColumn = `f_${fieldId.replaceAll("-", "")}`;
    const field: DatasetField = {
      fieldId, name: draft.name.trim(), sqlColumn, type: draft.type,
      required: draft.required, unique: draft.unique,
      ...(draft.default === undefined ? {} : { default: draft.default }),
    };
    if (draft.type === "select" || draft.type === "multi-select") field.options = [...(draft.options ?? [])];
    return field;
  })];
  const table: DatasetTable = { tableId, name: input.name, sqlName: "records", primaryKey: "id", fields };
  const userFieldIds = fields.slice(1).map(field => field.fieldId);
  const op = (kind: DatasetOperation["kind"], access: DatasetOperation["access"], readOnly: boolean, label: string, operationName: string, fieldIds: string[]): DatasetOperation => ({
    operationId: crypto.randomUUID(), name: operationName, label, tableId, kind, access, readOnly, fieldIds,
  });
  return {
    formatVersion: 1, datasetId, name: input.name, schemaPath: input.schemaPath, operationsPath: input.operationsPath, tables: [table],
    operations: [
      op("read", "helper", true, "View records", "records.list", userFieldIds),
      op("create", "link", false, "Create record", "records.create", userFieldIds),
      op("edit", "helper", false, "Edit record", "records.edit", userFieldIds),
      op("delete", "owner", false, "Delete record", "records.delete", []),
    ],
  };
}
