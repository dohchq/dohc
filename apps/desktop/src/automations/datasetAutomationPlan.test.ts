import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetOperation } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { datasetFindOf } from "./automationPlan";
import { datasetAutomationProblem, datasetEffectKey, datasetReachSteps, pinDatasetOperations } from "./datasetAutomationPlan";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const TABLE = id(2), STATUS = id(4), NOTES = id(5), FINISHED = id(6);
const operation = (number: number, name: string, kind: DatasetOperation["kind"], fieldIds: string[], reversible = false): DatasetOperation => ({
  operationId: id(number), name, label: name, tableId: TABLE, kind, access: "owner", readOnly: kind === "read", fieldIds, ...(reversible ? { reversible: true as const } : {}),
});
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
    { fieldId: NOTES, name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
    { fieldId: FINISHED, name: "Finished on", sqlColumn: "finished", type: "date", required: false, unique: false },
  ] }],
  operations: [
    operation(10, "invoices.list", "read", [STATUS, NOTES, FINISHED]),
    operation(11, "invoices.status", "edit", [STATUS]),
    operation(12, "invoices.edit", "edit", [STATUS, NOTES], true),
    operation(13, "invoices.create", "create", [STATUS, NOTES]),
  ],
};
const generated = { definition, generated: true };

function automation(steps: string, when = "field-changed: Status"): Automation {
  const parsed = parseAutomationsFile(`version: 1\nautomations:\n  - id: a\n    name: A\n    when:\n      ${when}\n    do:\n${steps}`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error(JSON.stringify(parsed));
  return parsed.entries[0].automation;
}

describe("dataset automation steps", () => {
  it("says which approved operation a step lacks, in the words the step card shows", () => {
    expect(datasetAutomationProblem(automation("      - set:\n          Finished on: '=today()'\n        operation: invoices.edit\n"), generated))
      .toBe("Budget has no approved edit that changes Finished on.");
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n"), generated))
      .toBe("Name the approved operation step 1 uses, such as invoices.edit.");
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n        operation: invoices.gone\n"), generated))
      .toBe("Budget has no approved operation named invoices.gone.");
    expect(datasetAutomationProblem(automation("      - set:\n          Notes: x\n        operation: invoices.status\n"), generated))
      .toBe("invoices.status is not an approved edit that changes Notes.");
    expect(datasetAutomationProblem(automation("      - add-record:\n          Finished on: '2026-09-25'\n        operation: invoices.create\n"), generated))
      .toBe("Budget has no approved way to add records with Finished on.");
    expect(datasetAutomationProblem(automation("      - find: contains(record.Notes, \"late\")\n        as: late\n        operation: invoices.list\n"), generated))
      .toMatch(/^A Find on a dataset can check fields with ==/);
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n        operation: invoices.status\n"), { definition, generated: false }))
      .toBe("Budget's operations were written or changed outside dohc, so automations cannot use them yet.");
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n        operation: invoices.status\n"), generated)).toBeNull();
  });

  it("pins a reversible edit first, then the one with the fewest fields beyond the step's", () => {
    const pinned = pinDatasetOperations(automation(`      - set:
          Status: Done
      - if: record.Notes == ""
        do:
          - set:
              Notes: seen
            operation: invoices.status
      - set:
          Finished on: '2026-09-25'
`), definition);
    const names = (steps: Automation["do"]): Array<string | null> => steps.flatMap((step) =>
      step.kind === "if" ? names(step.do) : "operation" in step ? [step.operation] : []);
    // invoices.edit is reversible and wins over the narrower invoices.status.
    expect(names(pinned.do)).toEqual(["invoices.edit", "invoices.edit", null]);
  });

  it("reads a Find as equality filters joined by &&, and offers no contains", () => {
    expect(datasetFindOf("true")).toEqual([]);
    expect(datasetFindOf('record.Status == "Open" && (record.Notes === trigger.record.Notes)')).toEqual([
      { field: "Status", value: { kind: "literal", value: "Open" } },
      { field: "Notes", value: { kind: "trigger-field", field: "Notes" } },
    ]);
    expect(datasetFindOf('record.Status == "Open" || record.Notes == ""')).toHaveProperty("problem");
    expect(datasetFindOf('contains(record.Notes, "x")')).toHaveProperty("problem");
  });

  it("keys each effect in 66 characters, apart for each record and each replan", () => {
    const key = datasetEffectKey("claim", "hash-1", 2, "rec/1", 0);
    expect(key).toMatch(/^a\.[0-9a-f]{64}$/);
    expect(new Set([key, datasetEffectKey("claim", "hash-1", 2, "rec/1", 1), datasetEffectKey("claim", "hash-1", 2, 5, 0),
      datasetEffectKey("claim", "hash-1", 2, null, 0), datasetEffectKey("claim", "hash-2", 2, "rec/1", 0)]).size).toBe(5);
    expect(datasetEffectKey("claim", "hash-1", 2, "rec/1", 0)).toBe(key);
  });

  it("checks every operation a run can call, the read a stale record needs included, and every field its formulas could see", () => {
    const addThenSet = automation(`      - add-record:
          Status: New
        as: added
        operation: invoices.create
      - set:
          Notes: seen
        records: added
        operation: invoices.edit
`, "record-removed: null");
    const steps = datasetReachSteps(addThenSet, { path: "Budget", name: "Budget" }, definition, { workspaceId: "workspace", grants: [] });
    // No trigger record to read: the create, the edit, and the read that checks the added record again.
    expect(steps.flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : [])).toEqual(["invoices.create", "invoices.edit", "invoices.list"]);
    expect(steps.flatMap((step) => step.kind === "dataset-field" ? [step.field.name] : [])).toEqual(["ID", "Status", "Notes", "Finished on"]);
  });
});
