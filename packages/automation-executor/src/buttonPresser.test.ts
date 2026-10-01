import { expect, it } from "vitest";
import { describeDatasetRevision, datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
import { AutomationRunWait, describeButtonPresser } from "./buttonPresser";
import { canPressInventory, type AutomationInventory } from "./automationInventory";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Data", schemaPath: "Data/schema.sql", operationsPath: "Data/operations.js",
  tables: [{ tableId: id(2), name: "Rows", sqlName: "rows", primaryKey: "id", fields: [{ fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true }] }],
  operations: [
    { operationId: id(4), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3)] },
    { operationId: id(5), name: "ownerRead", label: "Private owner label", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] },
  ] };
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "CREATE TABLE rows(id TEXT PRIMARY KEY NOT NULL) STRICT;", operationSource: generateDatasetOperations(definition) });
const authority: RelayButtonAuthority = { workspaceId: "w", userId: "person", grantId: "source", grantGeneration: 1, hostGeneration: 1,
  automationId: "collection:source#press", collectionPath: "Source", definitionHash: "0".repeat(16), confirmed: [],
  principals: [{ grantId: "first", userId: "person", access: "view" }, { grantId: "second", userId: "person", access: "edit" }] };

it("unions only the presser's current grants and filters owner-only operations", () => {
  const host = { revision: () => revision, dataGrants: () => ({ workspaceId: "w", grants: [
    { principalKey: datasetPrincipalKey("w", "first", "person"), operationIds: [id(4)] },
    { principalKey: datasetPrincipalKey("w", "second", "person"), operationIds: [id(5)] },
    { principalKey: datasetPrincipalKey("w", "owner", "owner"), operationIds: [id(4), id(5)] },
  ] }) };
  expect(describeButtonPresser(host, authority, id(1)).operations.map(value => value.operationId)).toEqual([id(4)]);
  expect(() => describeButtonPresser(host, { ...authority, workspaceId: "forged" }, id(1))).toThrow();
  expect(() => describeButtonPresser(host, { ...authority, principals: [{ grantId: "owner", userId: "owner", access: "edit" }] }, id(1))).toThrow();
});

it("does not authorize the same operation name or id in another dataset", async () => {
  const inventory: AutomationInventory = { targets: new Map(), destinations: new Map(), datasets: new Map(), reach: [
    { kind: "dataset-operation", collection: { path: "Other", name: "Other" }, datasetId: id(20), operation: definition.operations[0]!, operations: definition.operations, grants: { workspaceId: "w", grants: [] } },
  ] };
  const host = { revision: () => revision, dataGrants: () => ({ workspaceId: "w", grants: [{ principalKey: datasetPrincipalKey("w", "first", "person"), operationIds: [id(4)] }] }) };
  expect(await canPressInventory(inventory, async () => describeButtonPresser(host, authority, id(1)))).toBe(false);
});

it("keeps unavailable host permissions unknown through inventory admission", async () => {
  const host = { revision: () => revision, dataGrants: () => { throw Error("store unavailable"); } };
  expect(() => describeButtonPresser(host, authority, id(1))).toThrow(AutomationRunWait);
  const inventory: AutomationInventory = { targets: new Map(), destinations: new Map(), datasets: new Map(), reach: [
    { kind: "dataset-operation", collection: { path: "Data", name: "Data" }, datasetId: id(1), operation: definition.operations[0]!, operations: definition.operations, grants: { workspaceId: "w", grants: [] } },
  ] };
  await expect(canPressInventory(inventory, async () => describeButtonPresser(host, authority, id(1)))).rejects.toBeInstanceOf(AutomationRunWait);
});
