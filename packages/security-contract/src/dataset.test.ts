import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DATASET_METADATA_MAX_BYTES, datasetDefinitionDigestContent, datasetRevisionDigestContent,
  effectiveDatasetOperations, parseDatasetBinding, parseDatasetDefinition, parseDatasetRevision,
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

describe("dataset definition", () => {
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
      value => { value.operations[0]!.fieldIds = [id(3)]; },
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
