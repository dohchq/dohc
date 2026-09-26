import { generateDatasetOperations } from "./datasetOperations";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { datasetRevisionsPreserveAccess, DATASET_METADATA_MAX_BYTES, datasetDefinitionDigestContent, datasetRevisionDigestContent, parseDatasetDefinition, parseDatasetDescription, parseDatasetRevision, parseDatasetBindingReference, parseAppDatasetCapability, datasetColumnFields, describeApprovedDataset, type AppDatasetBinding, type DatasetColumnField, type DatasetDefinition, type DatasetField, type DatasetRevision } from "./dataset";
import { effectiveDatasetOperations, parseDatasetBinding, resolveAppDatasetCapability, verifyAppDatasetCapability } from "./datasetAuthorization";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function column(field: DatasetField | undefined): DatasetColumnField {
  if (!field || field.type === "button") throw new Error("Expected a column field.");
  return field;
}
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
  it("accepts explicit reversible edits and rejects reversal on other operation kinds", () => {
    const value = definition();
    value.operations[0] = { ...value.operations[0]!, kind: "edit", reversible: true };
    expect(parseDatasetDefinition(value).operations[0]!.reversible).toBe(true);
    for (const kind of ["read", "create", "delete", "action"] as const) {
      expect(() => parseDatasetDefinition({ ...value, operations: [{ ...value.operations[0], kind }] })).toThrow();
    }
    expect(() => parseDatasetDefinition({ ...value, operations: [{ ...value.operations[0], reversible: false }] })).toThrow();
  });
  it("accepts archived owner metadata with no runnable actions but still validates its fields", () => {
    const approved = revision();
    const archived = { datasetId: approved.datasetId, name: approved.definition.name, revision: 1, revisionSha256: approved.revisionSha256,
      archived: true, operations: [], tables: approved.definition.tables.map(table => ({ tableId: table.tableId, name: table.name,
        fields: datasetColumnFields(table).map(({ sqlColumn: _column, ...field }) => field) })) };
    expect(parseDatasetDescription(archived)).toEqual(archived);
    expect(() => parseDatasetDescription({ ...archived, archived: false })).toThrow();
    const invalid = structuredClone(archived); invalid.tables[0]!.fields[0]!.fieldId = "invalid";
    expect(() => parseDatasetDescription(invalid)).toThrow();
  });
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
  it("narrows create fields in approved app bindings and preserves them in publication verification", () => {
    const approved = revision(), base = binding(approved);
    const restricted = { ...base, createFields: [{ operationId: id(5), fieldIds: [id(4)] }] };
    expect(parseDatasetBinding(restricted, approved)).toEqual(restricted);
    const capability = resolveAppDatasetCapability(restricted, approved);
    expect(verifyAppDatasetCapability(capability, approved).createFields).toEqual(restricted.createFields);
    expect(() => parseDatasetBinding({ ...base, createFields: [{ operationId: id(6), fieldIds: [id(4)] }] }, approved)).toThrow();
    expect(() => parseDatasetBinding({ ...base, createFields: [{ operationId: id(5), fieldIds: [id(3)] }] }, approved)).toThrow();
    expect(() => parseDatasetBindingReference({ ...base, createFields: [{ operationId: id(5), fieldIds: [id(4),id(4)] }] })).toThrow();
    expect(() => parseDatasetBindingReference({ ...base, operationIds: [id(6)], createFields: [{ operationId: id(5), fieldIds: [id(4)] }] })).toThrow();
  });
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
    expect(column(renamed.tables[0]!.fields[1]).sqlColumn).toBe("name");
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
      value => { column(value.tables[0]!.fields[1]).sqlColumn = "ID"; },
      value => { value.tables[0]!.sqlName = "dohc_history"; },
      value => { column(value.tables[0]!.fields[0]).required = false; },
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
    expect(column(parseDatasetDefinition(value).tables[0]!.fields[2]).relation!.fieldId).toBe(id(3));
    for (const patch of [{ datasetId: id(100) }, { tableId: id(100) }, { fieldId: id(100) }, { fieldId: id(4) }]) {
      const changed = structuredClone(value); Object.assign(column(changed.tables[0]!.fields[2]).relation!, patch);
      expect(() => parseDatasetDefinition(changed)).toThrow();
    }
  });
});

describe("dataset buttons", () => {
  const button = { fieldId: id(20), name: "Send receipt", type: "button" as const };
  function withButton(): DatasetDefinition {
    const value = definition(); value.tables[0]!.fields.push({ ...button });
    value.tables.push({ tableId: id(30), name: "Notes", sqlName: "notes", primaryKey: "id", fields: [
      { fieldId: id(31), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: id(32), name: "Archive", type: "button" },
    ] });
    return value;
  }
  function approvedWithButton(): DatasetRevision {
    const result = revision(); result.definition = withButton();
    result.definitionSha256 = hash(datasetDefinitionDigestContent(result.definition));
    result.revisionSha256 = hash(datasetRevisionDigestContent(result));
    return result;
  }

  it("parses a button as an id, a name and its type, with no column", () => {
    expect(parseDatasetDefinition(withButton()).tables[0]!.fields[2]).toEqual(button);
    for (const extra of [{ sqlColumn: "send_receipt" }, { required: false }, { unique: false }, { default: null }, { options: ["Now"] }, { relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } }]) {
      const value = withButton(); Object.assign(value.tables[0]!.fields[2]!, extra);
      expect(() => parseDatasetDefinition(value)).toThrow();
    }
    for (const patch of [{ name: "Name" }, { fieldId: id(4) }, { fieldId: id(2) }, { fieldId: "button" }, { name: "" }]) {
      const value = withButton(); Object.assign(value.tables[0]!.fields[2]!, patch);
      expect(() => parseDatasetDefinition(value)).toThrow();
    }
  });

  it("refuses an operation that lists a button, in a definition, an approval, a binding, and a description", () => {
    const approved = approvedWithButton();
    expect(parseDatasetRevision(approved)).toEqual(approved);
    for (const kind of ["create", "read", "edit", "action"] as const) {
      const allowed = withButton();
      allowed.operations[0] = { ...allowed.operations[0]!, kind, readOnly: kind === "read", fieldIds: [id(4)] };
      expect(parseDatasetDefinition(allowed).operations[0]!.fieldIds).toEqual([id(4)]);
      const listed = structuredClone(allowed); listed.operations[0]!.fieldIds.push(id(20));
      expect(() => parseDatasetDefinition(listed)).toThrow();
      expect(() => parseDatasetRevision({ ...approved, definition: listed })).toThrow();
    }
    expect(() => parseDatasetBinding({ ...binding(approved), createFields: [{ operationId: id(5), fieldIds: [id(20)] }] }, approved)).toThrow();
    const description = describeApprovedDataset(approved, approved.definition.operations);
    expect(() => parseDatasetDescription({ ...description, operations: [{ ...description.operations[1]!, fieldIds: [id(3), id(20)] }] })).toThrow();
  });

  it("refuses a relation to a button", () => {
    const value = withButton();
    value.tables[0]!.fields.push({ fieldId: id(8), name: "Parent", sqlColumn: "parent_id", type: "relation", required: false, unique: false,
      relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } });
    expect(parseDatasetDefinition(value)).toBeTruthy();
    column(value.tables[0]!.fields[3]).relation!.fieldId = id(20);
    expect(() => parseDatasetDefinition(value)).toThrow();
  });

  it("describes a visible table's buttons, though no operation lists them", () => {
    const approved = approvedWithButton(), [submit, list] = approved.definition.operations;
    const helper = describeApprovedDataset(approved, [list!]);
    expect(helper.tables).toEqual([{ tableId: id(2), name: "People", fields: [
      { fieldId: id(3), name: "Record ID", type: "text", required: true, unique: true },
      { fieldId: id(4), name: "Name", type: "text", required: true, unique: false },
      button,
    ] }]);
    expect(parseDatasetDescription(helper)).toEqual(helper);
    const link = describeApprovedDataset(approved, [submit!]);
    expect(link.tables[0]!.fields.map(field => field.fieldId)).toEqual([id(4), id(20)]);
    expect(parseDatasetDescription(link)).toEqual(link);
    expect(JSON.stringify(link)).not.toContain("Archive");
    expect(describeApprovedDataset(approved, []).tables).toEqual([]);
    expect(() => parseDatasetDescription({ ...link, tables: [{ ...link.tables[0]!, fields: [link.tables[0]!.fields[0]!, { ...button, sqlColumn: "send_receipt" }] }] })).toThrow();
  });

  it("keeps access when a revision adds, renames or removes a button", () => {
    const before = revision(), after = approvedWithButton();
    after.revision = 2; after.definition.tables.pop();
    expect(datasetRevisionsPreserveAccess(before, after)).toBe(true);
    const renamed = structuredClone(after); renamed.definition.tables[0]!.fields[2]!.name = "Email receipt";
    expect(datasetRevisionsPreserveAccess(after, renamed)).toBe(true);
    expect(datasetRevisionsPreserveAccess(after, before)).toBe(true);
    const changedSource = structuredClone(after); changedSource.operationsSha256 = "e".repeat(64);
    expect(datasetRevisionsPreserveAccess(before, changedSource)).toBe(false);
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


it("permits only display names and source locations in access-preserving revisions", () => {
  const before = revision(), after = structuredClone(before);
  after.revision = 2; after.revisionSha256 = "a".repeat(64); after.definitionSha256 = "d".repeat(64);
  after.definition.name = "Fundraiser"; after.definition.tables[0].name = "Registrations";
  after.definition.tables[0].fields[1].name = "Full name";
  after.definition.schemaPath = "revision-2/schema.sql"; after.definition.operationsPath = "revision-2/operations.js";
  expect(datasetRevisionsPreserveAccess(before,after)).toBe(true);
  const changes: Array<(value: DatasetRevision) => void> = [
    value => { value.schemaSha256 = "e".repeat(64); },
    value => { value.operationsSha256 = "e".repeat(64); },
    value => { column(value.definition.tables[0].fields[1]).required = false; },
    value => { column(value.definition.tables[0].fields[1]).unique = true; },
    value => { column(value.definition.tables[0].fields[1]).default = "changed"; },
    value => { value.definition.tables[0].fields[1].type = "number"; },
    value => { column(value.definition.tables[0].fields[1]).sqlColumn = "other"; },
    value => { value.definition.operations[0].fieldIds.push(id(3)); },
    value => { value.definition.operations[0].access = "owner"; },
    value => { value.definition.operations[0].name = "other"; },
    value => { value.definition.operations[0].label = "Other"; },
    value => { value.definition.operations[0].readOnly = true; value.definition.operations[0].kind = "read"; },
  ];
  for (const change of changes) {
    const changed = structuredClone(after); change(changed);
    expect(datasetRevisionsPreserveAccess(before,changed)).toBe(false);
  }
});

it("allows only the explicitly approved link reads and their exact fields", () => {
  const approved = revision();
  approved.operationsSha256 = hash(generateDatasetOperations(approved.definition));
  const request = binding(approved);
  request.linkReads = [{ operationId: id(6), fieldIds: [id(3), id(4)] }];
  const caller = { kind: "link" as const, grantId: "g", principalId: "p" };
  expect(effectiveDatasetOperations(request, approved, caller)).toEqual([approved.definition.operations[0], { ...approved.definition.operations[1], access: "link" }]);
  const capability = resolveAppDatasetCapability(request, approved);
  expect(verifyAppDatasetCapability(capability, approved)).toEqual(capability);
  expect(capability.operations.find(operation => operation.operationId === id(6))?.fields).toEqual([
    { fieldId: id(3), name: "Record ID" }, { fieldId: id(4), name: "Name" },
  ]);
  for (const linkReads of [
    [{ operationId: id(5), fieldIds: [id(4)] }],
    [{ operationId: id(7), fieldIds: [] }],
    [{ operationId: id(99), fieldIds: [] }],
    [{ operationId: id(6), fieldIds: [id(3), id(4), id(99)] }],
    [{ operationId: id(6), fieldIds: [id(4)] }],
  ]) expect(() => parseDatasetBinding({ ...request, linkReads }, approved)).toThrow();
  expect(() => parseDatasetBinding({ ...request, operationIds: [id(5)] }, approved)).toThrow();
  expect(effectiveDatasetOperations({ ...request, linkReads: [] }, approved, caller).map(operation => operation.name)).toEqual(["submit"]);
});

it("rejects authored reads and reads omitting the primary key even with exact field approval", () => {
  const approved = revision(), request = binding(approved);
  request.linkReads = [{ operationId: id(6), fieldIds: [id(3), id(4)] }];
  expect(() => parseDatasetBinding(request, approved)).toThrow();
  approved.definition.operations[1]!.fieldIds = [id(4)];
  approved.operationsSha256 = hash(generateDatasetOperations(approved.definition));
  request.linkReads[0]!.fieldIds = [id(4)];
  expect(() => parseDatasetBinding(request, approved)).toThrow();
});
it("gives named app recipients approved reads alongside link creates without helper access", () => {
  const approved = revision();
  approved.operationsSha256 = hash(generateDatasetOperations(approved.definition));
  const request = { ...binding(approved), linkReads: [{ operationId: id(6), fieldIds: [id(3), id(4)] }] };
  expect(effectiveDatasetOperations(request, approved, { kind: "named", userId: "u", grantId: "g", access: "view", helper: false }).map(operation => operation.name)).toEqual(["submit", "list"]);
});
