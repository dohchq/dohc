import { describe, expect, it, vi } from "vitest";
import { datasetColumnFields, parseDatasetDefinition } from "@dohc/security-contract/dataset";
import { datasetDefinitionFromDrafts } from "./datasetDefinitionFromDrafts";
import type { TransactionalFieldDraft } from "./datasetDefinitionFromDrafts";

const drafts: TransactionalFieldDraft[] = [
  { name: "Name", type: "text", required: true, unique: false },
  { name: "Status", type: "select", options: ["New", "Reviewed"], required: false, unique: false, default: "New" },
];
describe("datasetDefinitionFromDrafts", () => {
  it("creates a private transactional dataset with stable identity and explicit operations", () => {
    let next = 1;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`) });
    const definition = datasetDefinitionFromDrafts({ name: "Fundraiser", schemaPath: "fundraiser/schema.sql", operationsPath: "fundraiser/operations.js", fields: drafts });
    expect(parseDatasetDefinition(definition).tables[0]?.fields.map(field => field.name)).toEqual(["Record ID", "Name", "Status"]);
    expect(datasetColumnFields(definition.tables[0]!)[1]?.sqlColumn).toMatch(/^f_[0-9a-f]{32}$/);
    expect(definition.operations.map(operation => [operation.kind, operation.access])).toEqual([["read", "helper"], ["create", "link"], ["edit", "helper"], ["delete", "owner"]]);
    expect(definition.operations[1]?.fieldIds).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it("keeps typed defaults, constraints, and file fields in generated metadata", () => {
    const result = datasetDefinitionFromDrafts({ name: "People", schemaPath: "people/schema.sql", operationsPath: "people/operations.js", fields: [...drafts, { name: "Receipt", type: "attachment", required: true, unique: false }] });
    expect(datasetColumnFields(parseDatasetDefinition(result).tables[0]!)[1]?.required).toBe(true);
    expect(datasetColumnFields(result.tables[0]!)[2]?.default).toBe("New");
    expect(result.tables[0]?.fields[3]?.type).toBe("attachment");
    expect(result.operations[0]?.fieldIds).not.toContain(result.tables[0]?.fields[0]?.fieldId);
  });
});
