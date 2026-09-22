import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
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
    expect(manifest.dataset).toEqual({ kind: "dataset", datasetId: id(1), revision: 1, revisionSha256: approvedRevision.revisionSha256, operationIds: [id(7)] });
    expect(manifest.inputs).toEqual(["apps/register/frontend.js", "apps/register/frontend.css"]);
    const built = await compileClosedApp({ entryPath: manifest.entryPath, packageMap: {}, inputs: manifest.inputs.map((path: string) => {
      const bytes = new TextEncoder().encode(files[path.split("/").at(-1)!]!);
      return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
    }), bounds: { maxInputFiles: 10, maxInputBytes: 100000, maxOutputBytes: 100000 } });
    const source = built.files.map(file => new TextDecoder().decode(file.bytes)).join("\n");
    expect(source).not.toMatch(/PRIVATE_SQL|PRIVATE_RULES|Private note|private\/schema|private\/operations/);
    expect(built.files.map(file => file.path).sort()).toEqual(["bundle.css", "bundle.js"]);
  });

  it.each([[], [id(4), id(4)], [id(6)], [id(5)]].map(fieldIds => ({ fieldIds })))("rejects empty, duplicate, unauthorized or missing-required fields $fieldIds", ({ fieldIds }) => {
    expect(() => generate({ fieldIds })).toThrow();
  });

  it("rejects nonpublic actions and relations with a custom app path", () => {
    const privateRevision = structuredClone(approvedRevision); privateRevision.definition.operations[0]!.access = "owner";
    expect(() => generate({ approvedRevision: privateRevision })).toThrow(/public create/);
    const related = structuredClone(approvedRevision);
    related.definition.tables[0]!.fields[1] = { ...related.definition.tables[0]!.fields[1]!, type: "relation", relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } };
    expect(() => generate({ approvedRevision: related })).toThrow(/custom app/);
  });

  it("permits omitted defaulted fields and safely embeds hostile labels", () => {
    const value = structuredClone(approvedRevision); value.definition.tables[0]!.fields[1]!.default = "Anonymous";
    value.definition.tables[0]!.fields[2]!.name = '</script><img src=x onerror="alert(1)">';
    const { files } = generate({ approvedRevision: value, fieldIds: [id(5)] });
    expect(files["frontend.js"]).not.toContain("</script>");
    expect(files["frontend.js"]).toContain("\\u003c/script>");
  });
});
