import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DATASET_METADATA_MAX_BYTES, datasetDefinitionDigestContent, datasetRevisionDigestContent,
  effectiveDatasetOperations, parseDatasetBinding, parseDatasetDefinition, parseDatasetDescription, parseDatasetRevision,
  parseDatasetBindingReference, parseAppDatasetCapability, resolveAppDatasetCapability, verifyAppDatasetCapability,
  type AppDatasetBinding, type DatasetDefinition, type DatasetField, type DatasetRevision,
} from "./dataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function definition(): DatasetDefinition {
  return {
    formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
    tables: [{ tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
      { fieldId: id(3), name: "Record ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    ] }],
    operations: [
      { operationId: id(5), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
      { operationId: id(6), name: "list", label: "View responses", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)] },
      { operationId: id(7), name: "remove", label: "Delete response", tableId: id(2), kind: "delete", access: "owner", readOnly: false, fieldIds: [] },
    ],
  };
}
function revision(): DatasetRevision {
  const result: DatasetRevision = { datasetId: id(1), revision: 1, revisionSha256: "0".repeat(64),
    definitionSha256: hash(datasetDefinitionDigestContent(definition())), schemaSha256: "b".repeat(64), operationsSha256: "c".repeat(64), definition: definition() };
  result.revisionSha256 = hash(datasetRevisionDigestContent(result));
  return result;
}
function binding(rev = revision()): AppDatasetBinding {
  return { kind: "dataset", datasetId: rev.datasetId, revision: rev.revision, revisionSha256: rev.revisionSha256, operationIds: rev.definition.operations.map(operation => operation.operationId) };
}

describe("dataset publication binding", () => {
  it("derives only selected dispatch metadata from the approved revision", () => {
    const approved = revision();
    const requested = { ...binding(approved), operationIds: [id(6), id(5)] };
    const capability = resolveAppDatasetCapability(requested, approved);
    expect(capability.operations).toEqual([
      { operationId: id(5), name: "submit", access: "link", readOnly: false },
      { operationId: id(6), name: "list", access: "helper", readOnly: true },
    ]);
    expect(capability).not.toHaveProperty("definition");
    expect(verifyAppDatasetCapability(capability, approved)).toEqual(capability);
    requested.operationIds.push(id(7));
    expect(capability.operationIds).toEqual([id(5), id(6)]);
  });

  it.each(["source", "schemaSql", "operations", "dataPath"])("refuses %s supplied by a consumer binding", key => {
    expect(() => parseDatasetBindingReference({ ...binding(), [key]: "replacement" })).toThrow();
  });

  it.each(["source", "schemaSql", "dataPath"])("refuses embedded %s in publication metadata", key => {
    const approved = revision();
    expect(() => parseAppDatasetCapability({ ...resolveAppDatasetCapability(binding(), approved), [key]: "replacement" })).toThrow();
  });

  it.each(["name", "access", "readOnly"])("rejects forged %s metadata even when transport syntax is valid", key => {
    const approved = revision();
    const capability = resolveAppDatasetCapability(binding(approved), approved);
    const operation = capability.operations[1]!;
    if (key === "name") operation.name = "replace";
    if (key === "access") operation.access = "link";
    if (key === "readOnly") operation.readOnly = false;
    expect(parseAppDatasetCapability(capability)).toEqual(capability);
    expect(() => verifyAppDatasetCapability(capability, approved)).toThrow();
  });

  it("rejects stale revisions, unknown operations, duplicate metadata and an expanded operation set", () => {
    const approved = revision();
    expect(() => resolveAppDatasetCapability({ ...binding(), revision: 2 }, approved)).toThrow();
    expect(() => resolveAppDatasetCapability({ ...binding(), revisionSha256: "e".repeat(64) }, approved)).toThrow();
    expect(() => resolveAppDatasetCapability({ ...binding(), operationIds: [id(99)] }, approved)).toThrow();
    const capability = resolveAppDatasetCapability({ ...binding(), operationIds: [id(5)] }, approved);
    expect(() => parseAppDatasetCapability({ ...capability, operations: [...capability.operations, capability.operations[0]] })).toThrow();
    expect(() => parseAppDatasetCapability({ ...capability, operationIds: [id(5), id(6)] })).toThrow();
  });
});

describe("dataset definition", () => {
  it("parses grant-filtered descriptions without accepting SQL columns or hidden fields", () => {
    const rev = revision(), op = rev.definition.operations[1]!;
    const description = { datasetId: rev.datasetId, name: rev.definition.name, revision: rev.revision, revisionSha256: rev.revisionSha256,
      tables: [{ tableId: rev.definition.tables[0]!.tableId, name: "People", fields: [
        { fieldId: id(3), name: "Record ID", type: "text", required: true, unique: true },
        { fieldId: id(4), name: "Name", type: "text", required: true, unique: false },
      ] }], operations: [op] };
    expect(parseDatasetDescription(description).tables[0]!.fields[0]).not.toHaveProperty("sqlColumn");
    expect(() => parseDatasetDescription({ ...description, tables: [{ ...description.tables[0], fields: [{ ...description.tables[0]!.fields[0], sqlColumn: "id" }] }] })).toThrow();
    expect(() => parseDatasetDescription({ ...description, operations: [{ ...op, fieldIds: [id(5)] }] })).toThrow();
  });
  it("accepts withheld relation targets but validates any disclosed target", () => {
    const rev = revision();
    const relationField = { fieldId: id(8), name: "Friends", type: "relation", required: false, unique: false, default: [] };
    const description = { datasetId: rev.datasetId, name: rev.definition.name, revision: rev.revision, revisionSha256: rev.revisionSha256,
      tables: [{ tableId: id(2), name: "People", fields: [relationField] }], operations: [{ ...rev.definition.operations[1]!, fieldIds: [id(8)] }] };
    expect(parseDatasetDescription(description).tables[0]!.fields[0]).toEqual(relationField);
    const exposed = { ...relationField, relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: true } };
    expect(() => parseDatasetDescription({ ...description, tables: [{ ...description.tables[0], fields: [exposed] }] })).toThrow();
    const draft = definition(); draft.tables[0]!.fields.push({ ...relationField, sqlColumn: "friends" } as DatasetField);
    expect(() => parseDatasetDefinition(draft)).toThrow();
  });
  it("creates an independent draft with stable identities across display renames", () => {
    const input = definition();
    const parsed = parseDatasetDefinition(input);
    input.name = "Fundraiser";
    input.tables[0]!.name = "Participants";
    input.tables[0]!.fields[1]!.name = "Full name";
    const renamed = parseDatasetDefinition(input);
    expect(renamed.datasetId).toBe(parsed.datasetId);
    expect(renamed.tables[0]!.tableId).toBe(parsed.tables[0]!.tableId);
    expect(renamed.tables[0]!.fields[1]!.fieldId).toBe(parsed.tables[0]!.fields[1]!.fieldId);
    expect(renamed.tables[0]!.fields[1]!.sqlColumn).toBe("name");
    expect(parsed.tables[0]!.fields[1]!.name).toBe("Name");
    expect(parsed).not.toHaveProperty("appRoot");
  });

  it("hashes a canonical detached definition independent of object and inventory ordering", () => {
    const first = definition();
    const second = Object.fromEntries(Object.entries(first).reverse()) as unknown as DatasetDefinition;
    second.tables = structuredClone(second.tables);
    second.tables[0]!.fields.reverse();
    second.operations = structuredClone(second.operations).reverse();
    second.operations.forEach(operation => operation.fieldIds.reverse());
    expect(datasetDefinitionDigestContent(first)).toBe(datasetDefinitionDigestContent(second));
    expect(second.tables[0]!.fields[0]!.name).toBe("Name");
  });

  it("accepts authored text or numeric record keys and TypeScript operation source", () => {
    const value = definition();
    value.operationsPath = "data/operations.ts";
    value.tables[0]!.fields[0]!.type = "number";
    value.operations[0]!.fieldIds = [id(3), id(4)];
    expect(parseDatasetDefinition(value).tables[0]!.fields[0]!.type).toBe("number");
    value.tables[0]!.fields[0]!.type = "checkbox";
    expect(() => parseDatasetDefinition(value)).toThrow();
    value.tables[0]!.fields[0]!.type = "text";
    value.operationsPath = "data/operations.txt";
    expect(() => parseDatasetDefinition(value)).toThrow();
  });

  it.each(["../schema.sql", "/schema.sql", "C:\\schema.sql", "data/./schema.sql", "data//schema.sql", ".dohc/schema.sql", ".env/schema.sql", "shared-with-me/schema.sql", "data/schema.json"])("rejects unsafe schema path %s", schemaPath => {
    expect(() => parseDatasetDefinition({ ...definition(), schemaPath })).toThrow();
  });

  it("rejects hostile shapes without executing getters or coercions", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "formatVersion", { enumerable: true, get() { calls++; return 1; } });
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const symbol = { ...definition(), [Symbol("secret")]: 1 };
    const sparse = definition(); sparse.tables = new Array(1);
    const ownToJSON = { ...definition(), toJSON() { calls++; return definition(); } };
    const inputs = [getter, circular, symbol, sparse, ownToJSON, Object.create(definition()), JSON.parse('{"__proto__":{}}'), { ...definition(), permission: "owner" },
      { ...definition(), name: "x".repeat(DATASET_METADATA_MAX_BYTES + 1) }];
    for (const input of inputs) expect(() => parseDatasetDefinition(input)).toThrow();
    expect(calls).toBe(0);
  });

  it("rejects duplicate identities, SQL collisions, missing references, and forged action kinds", () => {
    const variants: Array<(value: DatasetDefinition) => void> = [
      value => { value.datasetId += "\n"; },
      value => { value.tables[0]!.tableId = value.datasetId; },
      value => { value.tables[0]!.fields[1]!.fieldId = id(3); },
      value => { value.tables[0]!.fields[1]!.sqlColumn = "ID"; },
      value => { value.tables[0]!.sqlName = "dohc_history"; },
      value => { value.tables[0]!.fields[0]!.required = false; },
      value => { value.tables[0]!.primaryKey = "missing"; },
      value => { value.operations[0]!.fieldIds = [id(100)]; },
      value => { value.operations[0]!.kind = "edit"; value.operations[0]!.fieldIds = [id(3)]; },
      value => { value.operations[0]!.readOnly = true; },
      value => { value.operations[1]!.readOnly = false; },
      value => { value.operations[2]!.fieldIds = [id(4)]; },
      value => { value.operations[0]!.tableId = id(100); },
      value => { value.operations[0]!.name = "constructor.call"; },
    ];
    for (const change of variants) { const value = definition(); change(value); expect(() => parseDatasetDefinition(value)).toThrow(); }
  });

  it("validates typed defaults and rejects metadata from another field type", () => {
    const cases: Array<[Partial<DatasetField>, boolean]> = [
      [{ type: "number", default: 12 }, true], [{ type: "number", default: "12" }, false],
      [{ type: "number", default: Infinity }, false], [{ type: "checkbox", default: false }, true],
      [{ type: "checkbox", default: 0 }, false], [{ type: "date", default: "2024-02-29" }, true],
      [{ type: "date", default: "2025-02-29" }, false], [{ type: "url", default: "https://example.test" }, true],
      [{ type: "url", default: "javascript:alert(1)" }, false],
      [{ type: "select", options: ["A", "B"], default: "B" }, true],
      [{ type: "select", options: ["A", "A"] }, false], [{ type: "select", options: ["A"], default: "B" }, false],
      [{ type: "multi-select", options: ["A"], default: ["A"] }, true],
      [{ type: "multi-select", options: ["A"], default: ["A", "A"] }, false],
      [{ type: "text", options: ["A"] }, false], [{ type: "text", default: null }, false],
      [{ type: "text", required: false, default: null }, true],
      [{ type: "attachment", default: "file-from-another-app" }, false],
    ];
    for (const [patch, valid] of cases) {
      const value = definition(); Object.assign(value.tables[0]!.fields[1]!, patch);
      if (valid) expect(() => parseDatasetDefinition(value)).not.toThrow();
      else expect(() => parseDatasetDefinition(value)).toThrow();
    }
  });

  it("requires same-dataset relations to declared required unique scalar fields", () => {
    const value = definition();
    value.tables[0]!.fields.push({ fieldId: id(8), name: "Parent", sqlColumn: "parent_id", type: "relation", required: false, unique: false,
      relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } });
    expect(parseDatasetDefinition(value).tables[0]!.fields[2]!.relation!.fieldId).toBe(id(3));
    for (const patch of [{ datasetId: id(100) }, { tableId: id(100) }, { fieldId: id(100) }, { fieldId: id(4) }]) {
      const changed = structuredClone(value); Object.assign(changed.tables[0]!.fields[2]!.relation!, patch);
      expect(() => parseDatasetDefinition(changed)).toThrow();
    }
  });
});

describe("approved dataset consumer bindings", () => {
  it("pins exact dataset, revision, digest and declared operation subset", () => {
    const approved = revision(); const request = binding(approved); request.operationIds = [id(5)];
    expect(parseDatasetBinding(request, approved)).toEqual(request);
    for (const patch of [{ datasetId: id(100) }, { revision: 2 }, { revisionSha256: "d".repeat(64) }, { operationIds: [id(100)] },
      { operationIds: [id(5), id(5)] }, { schemaSql: "DROP TABLE people" }, { operationIds: [] }]) {
      expect(() => parseDatasetBinding({ ...request, ...patch }, approved)).toThrow();
    }
    const competitor = { ...approved, schemaSha256: "e".repeat(64) };
    competitor.revisionSha256 = hash(datasetRevisionDigestContent(competitor));
    expect(() => parseDatasetBinding(request, competitor)).toThrow();
  });

  it("intersects binding and trusted caller policy without granting helper source editing", () => {
    const approved = revision(); const request = binding(approved);
    expect(effectiveDatasetOperations(request, approved, { kind: "link", grantId: "g", principalId: "p" }).map(operation => operation.name)).toEqual(["submit"]);
    expect(effectiveDatasetOperations(request, approved, { kind: "named", userId: "u", grantId: "g", access: "view", helper: true }).map(operation => operation.name)).toEqual(["submit", "list"]);
    expect(effectiveDatasetOperations(request, approved, { kind: "named", userId: "u", grantId: "g", access: "edit", helper: false }).map(operation => operation.name)).toEqual(["submit"]);
    request.operationIds = [id(5)];
    expect(effectiveDatasetOperations(request, approved, { kind: "owner", userId: "u" }).map(operation => operation.name)).toEqual(["submit"]);
  });

  it("validates the revision envelope but never mistakes a digest for owner approval", () => {
    const approved = revision();
    expect(parseDatasetRevision(approved)).toEqual(approved);
    for (const patch of [{ datasetId: id(100) }, { revision: 0 }, { revision: 1.5 }, { revisionSha256: "a".repeat(64) + "\n" }, { approved: true }]) {
      expect(() => parseDatasetRevision({ ...approved, ...patch })).toThrow();
    }
    expect(datasetRevisionDigestContent({ ...approved, revisionSha256: "d".repeat(64) })).toBe(datasetRevisionDigestContent(approved));
  });
});
