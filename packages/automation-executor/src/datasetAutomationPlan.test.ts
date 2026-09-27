import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetOperation } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { chatDirectoryOf } from "./automationChat";
import { datasetFindOf, datasetSubscriptionFor } from "./automationPlan";
import { DATASET_WAKE_NEEDS_BUTTON, datasetAutomationProblem, datasetIrreversibleActions, datasetEffectKey, datasetOperationsOf, datasetReachSteps, datasetStepsOf, pinDatasetOperations } from "./datasetAutomationPlan";

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
    operation(14, "invoices.markPaid", "action", [STATUS]),
  ],
};
const generated = { definition, generated: true };
const authored = { definition, generated: false };

function automation(steps: string, when = "field-changed: Status"): Automation {
  const parsed = parseAutomationsFile(`version: 1\nautomations:\n  - id: a\n    name: A\n    when:\n      ${when}\n    do:\n${steps}`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error(JSON.stringify(parsed));
  return parsed.entries[0].automation;
}

describe("dataset automation steps", () => {
  it("refuses Group-message triggers on datasets", () => {
    const fromMessage = automation("      - add-record:\n          Status: New\n        operation: invoices.create\n", "group-message: Team");
    expect(datasetSubscriptionFor(fromMessage, definition))
      .toEqual({ problem: "This Collection's automations cannot start from Group messages. Choose a record change as the trigger." });
  });

  // Each chat step alone, then inside an If, then in its otherwise branch.
  const everywhere = (chat: Automation["do"], base: Automation["do"]) => [chat, [{ kind: "if" as const, if: "true", do: chat, otherwise: [] }],
    [{ kind: "if" as const, if: "false", do: base, otherwise: chat }]];

  it.each([
    "post: Done\n        group: Team",
    "direct-message: Done\n        to: [user_ana]",
    "notify: Done\n        to: [user_ana]",
  ])("runs chat steps on datasets, in branches too: %s", (step) => {
    const chat = automation("      - " + step + "\n").do;
    const base = automation("      - set:\n          Status: Done\n        operation: invoices.edit\n");
    for (const steps of everywhere(chat, base.do)) expect(datasetAutomationProblem({ ...base, do: steps }, generated)).toBeNull();
  });

  it("wakes an agent only from a button, since a commit does not say whether a person or an agent made it", () => {
    const wake = automation("      - wake-agent: Review this\n        person: user_ana\n").do;
    const changed = automation("      - set:\n          Status: Done\n        operation: invoices.edit\n");
    for (const steps of everywhere(wake, changed.do)) {
      expect(datasetAutomationProblem({ ...changed, do: steps }, generated)).toBe(DATASET_WAKE_NEEDS_BUTTON);
    }
    const pressed = automation("      - set:\n          Status: Done\n        operation: invoices.edit\n", "button: Ask");
    for (const steps of everywhere(wake, pressed.do)) expect(datasetAutomationProblem({ ...pressed, do: steps }, generated)).toBeNull();
  });

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
      .toMatch(/^This Collection needs a Find that checks fields with ==/);
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n        operation: invoices.status\n"), generated)).toBeNull();
  });

  it("runs only steps that touch no record on a dataset whose operations someone wrote", () => {
    const refusal = "Budget's operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.";
    expect(datasetAutomationProblem(automation("      - set:\n          Status: Done\n        operation: invoices.status\n"), authored)).toBe(refusal);
    expect(datasetAutomationProblem(automation("      - if: 'true'\n        do:\n          - post: Hi\n            group: Team\n        otherwise:\n          - add-record:\n              Status: New\n            operation: invoices.create\n"), authored))
      .toBe(refusal);
    expect(datasetAutomationProblem(automation("      - post: 'Invoice {record.id} changed'\n        group: Team\n"), authored)).toBeNull();
    expect(datasetAutomationProblem(automation("      - notify: '{previous.Status} is gone'\n        to: [user_ana]\n", "button: Ask"), authored)).toBeNull();
    expect(datasetAutomationProblem(automation("      - post: Done\n        group: Team\n", "starts-matching: record.id == \"a\""), authored))
      .toBe("Budget's operations were written or changed outside dohc, so dohc cannot read a record to check a condition. Choose a record change or a button as the trigger.");
  });

  it("says a Find cannot use these operations before it says how a Find must look", () => {
    expect(datasetAutomationProblem(automation("      - find: contains(record.Notes, \"late\")\n        as: late\n        operation: invoices.list\n"), authored))
      .toBe("Budget's operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.");
  });

  it("does not read the trigger record, or ask for a read, on a dataset whose operations someone wrote", () => {
    const posting = automation("      - post: 'Invoice {record.id} changed'\n        group: Team\n");
    expect(datasetStepsOf(posting, authored).triggerRead).toBeNull();
    expect(datasetStepsOf(posting, generated).triggerRead?.name).toBe("invoices.list");
    expect(datasetOperationsOf(posting, authored)).toEqual([]);
    const steps = datasetReachSteps(posting, { path: "Budget", name: "Budget" }, authored, { workspaceId: "workspace", grants: [] }, null);
    expect(steps.some((step) => step.kind === "dataset-operation")).toBe(false);
    expect(() => datasetStepsOf(automation("      - set:\n          Status: Done\n        operation: invoices.status\n"), authored)).toThrow(/Set fields, Add record, and Find/);
  });

  it("names each action a run can't undo once, by name, and tells apart two that share a label", () => {
    const shared: DatasetDefinition = { ...definition, operations: [...definition.operations,
      operation(15, "invoices.send", "action", [STATUS]), operation(16, "reminders.send", "action", [STATUS])].map((entry) => entry.kind === "action" ? { ...entry, label: "Send" } : entry) };
    const both = automation("      - invoke: invoices.send\n      - if: 'true'\n        do:\n          - invoke: reminders.send\n          - invoke: invoices.send\n", "button: Send");
    expect(datasetIrreversibleActions(both, shared)).toEqual([
      { name: "invoices.send", label: "Send (invoices.send)" },
      { name: "reminders.send", label: "Send (reminders.send)" },
    ]);
    expect(datasetIrreversibleActions(automation("      - invoke: invoices.markPaid\n", "button: Send"), definition)).toEqual([{ name: "invoices.markPaid", label: "invoices.markPaid" }]);
  });

  it("runs an action a step names, on any dataset, and says why a name is not one", () => {
    const invoking = automation("      - invoke: invoices.markPaid\n        input:\n          id: '=record.id'\n", "button: Mark paid");
    expect(datasetAutomationProblem(invoking, generated)).toBeNull();
    expect(datasetAutomationProblem(invoking, authored)).toBeNull();
    expect(datasetAutomationProblem(automation("      - invoke: invoices.gone\n"), authored)).toBe("Budget has no approved action named invoices.gone.");
    expect(datasetAutomationProblem(automation("      - invoke: invoices.edit\n"), authored))
      .toBe("invoices.edit is an approved edit, not an action. Use a step that changes fields for it.");
    // The action is an operation the run calls: reach checks it, and a presser must hold it.
    expect(datasetOperationsOf(invoking, authored)).toEqual(["invoices.markPaid"]);
    const steps = datasetReachSteps(invoking, { path: "Budget", name: "Budget" }, authored, { workspaceId: "workspace", grants: [] }, null);
    expect(steps.flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : [])).toEqual(["invoices.markPaid"]);
    expect(datasetStepsOf(invoking, authored).steps.get(0)?.operation.name).toBe("invoices.markPaid");
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
`), generated);
    const names = (steps: Automation["do"]): Array<string | null> => steps.flatMap((step) =>
      step.kind === "if" ? names(step.do) : "operation" in step ? [step.operation] : []);
    // invoices.edit is reversible and wins over the narrower invoices.status.
    expect(names(pinned.do)).toEqual(["invoices.edit", "invoices.edit", null]);
  });

  it("pins an Add record only to a create in its own table, and names another table's that fits", () => {
    const REFUNDS = id(20), REFUND_STATUS = id(21);
    const twoTables: DatasetDefinition = {
      ...definition,
      tables: [...definition.tables, { tableId: REFUNDS, name: "Refunds", sqlName: "refunds", primaryKey: "id", fields: [
        { fieldId: id(22), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        { fieldId: REFUND_STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
      ] }],
      // refunds.create fits Status with no extra field; invoices.create has Notes too.
      operations: [...definition.operations, { ...operation(23, "refunds.create", "create", [REFUND_STATUS]), tableId: REFUNDS }],
    };
    const add = (table: string, step = "Status: New", operationName = "") =>
      automation(`      - add-record:\n          ${step}\n${operationName ? `        operation: ${operationName}\n` : ""}`, `field-changed: Status\n      table: ${table}`);
    const pinnedOf = (built: Automation) => pinDatasetOperations(built, { definition: twoTables, generated: true }).do[0];
    const problemOf = (built: Automation) => datasetAutomationProblem(built, { definition: twoTables, generated: true });
    expect(pinnedOf(add("Invoices"))).toMatchObject({ kind: "add-record", operation: "invoices.create" });
    expect(pinnedOf(add("Refunds"))).toMatchObject({ kind: "add-record", operation: "refunds.create" });
    // Refunds has no Notes: a save does not move the step to Invoices, and
    // the step names the create that would fit, for a person to choose.
    const notes = add("Refunds", "Notes: seen");
    expect(pinnedOf(notes)).toMatchObject({ kind: "add-record", operation: null });
    expect(problemOf(pinDatasetOperations(notes, { definition: twoTables, generated: true }))).toBe("Name the approved operation step 1 uses, such as invoices.create.");
    // A step that names another table's create adds records there, and keeps it.
    const named = add("Invoices", "Status: New", "refunds.create");
    expect(pinnedOf(named)).toMatchObject({ operation: "refunds.create" });
    expect(problemOf(named)).toBeNull();
    // One whose create stopped fitting is pinned only within that create's table.
    const stale = add("Invoices", "Notes: seen", "refunds.create");
    expect(pinnedOf(stale)).toMatchObject({ operation: "refunds.create" });
    expect(problemOf(stale)).toBe("refunds.create is not an approved way to add records with Notes.");
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
    const steps = datasetReachSteps(addThenSet, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, null);
    // No trigger record to read: the create, the edit, and the read that checks the added record again.
    expect(steps.flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : [])).toEqual(["invoices.create", "invoices.edit", "invoices.list"]);
    expect(steps.flatMap((step) => step.kind === "dataset-field" ? [step.field.name] : [])).toEqual(["ID", "Status", "Notes", "Finished on"]);
  });

  it("checks the chats an automation reaches first, as a document Collection's, branches included", () => {
    const roster = { kind: "owner" as const, ownerUserId: "user-owner", grants: [] };
    const chat = chatDirectoryOf([{ id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team-wire", runningThreadId: null }], roster);
    const telling = automation(`      - set:
          Status: Done
        operation: invoices.edit
      - if: record.Notes == ""
        do:
          - post: Done
            group: Team
        otherwise:
          - notify: Done
            to: [user-owner, '="user-" + record.Notes']
      - wake-agent: Look
        person: user-owner
`, "button: Ask");
    const steps = datasetReachSteps(telling, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, chat);
    // A person a formula names is checked once the formula has run.
    expect(steps.slice(0, 3)).toEqual([
      { kind: "post", group: { channelWireId: "team-wire", name: "Team" } },
      { kind: "notify", person: { userId: "user-owner", name: "you" } },
      { kind: "personal", person: { userId: "user-owner", name: "you" } },
    ]);
    expect(steps.slice(3).every((step) => step.kind === "dataset-operation" || step.kind === "dataset-field")).toBe(true);
  });
});
