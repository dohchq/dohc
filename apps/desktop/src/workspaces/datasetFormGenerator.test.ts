import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { DATASET_MAX_FIELDS, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { generateDatasetFormSources, type DatasetFormInput } from "./datasetFormGenerator";
import { compileClosedApp } from "./closedAppCompiler";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "private/schema.sql", operationsPath: "private/operations.js",
  tables: [{ tableId: id(2), name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    { fieldId: id(5), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false },
    { fieldId: id(6), name: "Private note", sqlColumn: "note", type: "text", required: false, unique: false },
  ] }], operations: [{ operationId: id(7), name: "register", label: "Register", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4), id(5)] }] };
const approvedRevision = describeDatasetRevision({ definition, revision: 1, schemaSql: "PRIVATE_SQL", operationSource: "PRIVATE_RULES" });
const generate = (input: Partial<DatasetFormInput> = {}) => generateDatasetFormSources({ approvedRevision, tableId: id(2), createOperationId: id(7),
  appRoot: "apps/register", fieldIds: [id(4), id(5)], ...input });

describe("dataset form generation", () => {
  it("emits a deterministic frontend-only binding and compiles without private sources", async () => {
    const { files } = generate();
    expect(generate().files).toEqual(files);
    expect(Object.keys(files).sort()).toEqual(["app.publish.json", "dohc.json", "frontend.css", "frontend.js"]);
    const manifest = JSON.parse(files["app.publish.json"]!);
    expect(manifest.dataset).toEqual({ kind: "dataset", datasetId: id(1), revision: 1, revisionSha256: approvedRevision.revisionSha256, operationIds: [id(7)], createFields: [{ operationId: id(7), fieldIds: [id(4), id(5)] }] });
    expect(manifest.inputs).toEqual(["frontend.js", "frontend.css"]);
    const built = await compileClosedApp({ entryPath: manifest.entryPath, packageMap: {}, inputs: manifest.inputs.map((path: string) => {
      const bytes = new TextEncoder().encode(files[path]!);
      return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
    }), bounds: { maxInputFiles: 10, maxInputBytes: 100000, maxOutputBytes: 100000 } });
    const source = built.files.map(file => new TextDecoder().decode(file.bytes)).join("\n");
    expect(source).not.toMatch(/PRIVATE_SQL|PRIVATE_RULES|Private note|private\/schema|private\/operations/);
    expect(built.files.map(file => file.path).sort()).toEqual(["bundle.css", "bundle.js"]);
  });

  it.each([[], [id(4), id(4)], [id(6)], [id(5)]].map(fieldIds => ({ fieldIds })))("rejects empty, duplicate, unauthorized or missing-required fields $fieldIds", ({ fieldIds }) => {
    expect(() => generate({ fieldIds })).toThrow();
  });

  it("rejects nonpublic create actions and relations without explicit public choices", () => {
    const privateRevision = structuredClone(approvedRevision); privateRevision.definition.operations[0]!.access = "owner";
    expect(() => generate({ approvedRevision: privateRevision })).toThrow(/public create/);
    const related = structuredClone(approvedRevision);
    related.definition.tables[0]!.fields[1] = { ...related.definition.tables[0]!.fields[1]!, type: "relation", relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } };
    expect(() => generate({ approvedRevision: related })).toThrow(/public read/);
  });

  it("permits omitted defaulted fields and safely embeds hostile labels", () => {
    const value = structuredClone(approvedRevision); value.definition.tables[0]!.fields[1]!.default = "Anonymous";
    value.definition.tables[0]!.fields[2]!.name = '</script><img src=x onerror="alert(1)">';
    const { files } = generate({ approvedRevision: value, fieldIds: [id(5)] });
    expect(files["frontend.js"]).not.toContain("</script>");
    expect(files["frontend.js"]).toContain("\\u003c/script>");
  });

  it("supports the complete dataset field envelope, including multiple upload fields", () => {
    const value = structuredClone(approvedRevision);
    value.definition.tables[0]!.fields = Array.from({ length: DATASET_MAX_FIELDS }, (_, index) => ({
      fieldId: id(100 + index), name: `Field ${index}`, sqlColumn: index === 0 ? "id" : `field_${index}`,
      type: index > 125 ? "attachment" as const : "text" as const, required: index === 0, unique: index === 0,
    }));
    const fieldIds = value.definition.tables[0]!.fields.map(field => field.fieldId);
    value.definition.operations[0]!.fieldIds = fieldIds;
    const { files } = generate({ approvedRevision: value, fieldIds });
    expect(JSON.parse(files["app.publish.json"]!).dataset.createFields[0].fieldIds).toHaveLength(DATASET_MAX_FIELDS);
    expect(files["frontend.js"]).toContain('"name":"Field 127"');
  });
  it("refuses impossible required-upload forms without limiting optional file controls", () => {
    const value = structuredClone(approvedRevision);
    const files = Array.from({ length: 33 }, (_, index) => ({ fieldId: id(100 + index), name: `Upload ${index}`, sqlColumn: `file_${index}`, type: "attachment" as const, required: true, unique: false }));
    value.definition.tables[0]!.fields.push(...files);
    value.definition.operations[0]!.fieldIds.push(...files.map(field => field.fieldId));
    const fieldIds = [id(4), ...files.map(field => field.fieldId)];
    expect(() => generate({ approvedRevision: value, fieldIds })).toThrow(/32 files/);
    files.forEach(field => { field.required = false; });
    expect(generate({ approvedRevision: value, fieldIds }).files["frontend.js"]).toContain('"name":"Upload 32"');
  });

  it("binds explicitly chosen public relation operations without embedding private data or source", () => {
    const value = structuredClone(approvedRevision);
    value.definition.tables[0]!.fields[1] = { ...value.definition.tables[0]!.fields[1]!, type: "relation", relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } };
    value.definition.operations.push({ operationId: id(8), name: "choices", label: "Public choices", tableId: id(2), kind: "read", access: "link", readOnly: true, fieldIds: [id(3)] });
    const relationChoices = [{ fieldId: id(4), operationId: id(8), labelFieldId: id(3) }];
    const files = generate({ approvedRevision: value, relationChoices }).files;
    expect(JSON.parse(files["app.publish.json"]!).dataset.operationIds).toEqual([id(7), id(8)]);
    expect(files["frontend.js"]).toContain('"operation":"choices"');
    expect(files["frontend.js"]).not.toMatch(/PRIVATE_SQL|PRIVATE_RULES|Private note/);
    for (const access of ["owner", "helper"] as const) {
      value.definition.operations[1]!.access = access;
      expect(() => generate({ approvedRevision: value, relationChoices })).toThrow(/public read/);
    }
    value.definition.operations[1]!.access = "link";
    value.definition.operations[1]!.fieldIds.push(id(6));
    expect(() => generate({ approvedRevision: value, relationChoices })).toThrow(/key and label/);
  });
});
