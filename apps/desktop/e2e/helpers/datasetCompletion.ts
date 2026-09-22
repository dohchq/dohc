import { randomUUID } from "node:crypto";
import type { DatasetDefinition, DatasetField, DatasetOperation } from "@dohc/security-contract/dataset";

/** Two-file orders and an explicitly public product list; internal notes stay private. */
export function orderFormDefinition(): DatasetDefinition {
  const datasetId = randomUUID(), ordersId = randomUUID(), productsId = randomUUID();
  const field = (name: string, sqlColumn: string, type: DatasetField["type"], required = false, unique = false): DatasetField =>
    ({ fieldId: randomUUID(), name, sqlColumn, type, required, unique });
  const productFields = [field("Code", "id", "text", true, true), field("Label", "label", "text", true), field("Internal notes", "notes", "text")];
  const orderFields = [field("ID", "id", "text", true, true), field("Name", "name", "text", true),
    { ...field("Product", "product", "relation", true), relation: { datasetId, tableId: productsId, fieldId: productFields[0]!.fieldId, many: false } },
    field("Receipt", "receipt", "attachment", true), field("Reference photo", "photo", "attachment", true),
    ...Array.from({ length: 21 }, (_, index) => field(`Extra ${index + 1}`, `extra_${index + 1}`, "text"))];
  const operation = (tableId: string, name: string, kind: DatasetOperation["kind"], access: DatasetOperation["access"], fields: DatasetField[]): DatasetOperation =>
    ({ operationId: randomUUID(), name, label: name, tableId, kind, access, readOnly: kind === "read", fieldIds: fields.map(field => field.fieldId) });
  return { formatVersion: 1, datasetId, name: "Orders", schemaPath: "orders-data/schema.sql", operationsPath: "orders-data/operations.js",
    tables: [{ tableId: ordersId, name: "Orders", sqlName: "orders", primaryKey: "id", fields: orderFields },
      { tableId: productsId, name: "Products", sqlName: "products", primaryKey: "id", fields: productFields }],
    operations: [operation(ordersId, "orders.list", "read", "owner", orderFields), operation(ordersId, "orders.create", "create", "link", orderFields.slice(1)),
      operation(productsId, "products.create", "create", "owner", productFields), operation(productsId, "products.choices", "read", "link", productFields.slice(0,2))] };
}
