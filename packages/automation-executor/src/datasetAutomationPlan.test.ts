import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetOperation } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { chatDirectoryOf } from "./automationChat";
import { datasetFindOf, datasetSubscriptionFor } from "./automationPlan";
import { reachStepId } from "./automationReach";
import {
  datasetAutomationProblem,
  datasetEffectKey,
  datasetFieldWritesOf,
  datasetIrreversibleActions,
  datasetOperationsOf,
  datasetReachSteps,
  datasetStepsOf,
  pinDatasetOperations,
  type DatasetRules,
} from "./datasetAutomationPlan";

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

function automation(steps: string, when = "field-changed: Status"): Automation {
  const parsed = parseAutomationsFile(`version: 1\nautomations:\n  - id: a\n    name: A\n    when:\n      ${when}\n    do:\n${steps}`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error(JSON.stringify(parsed));
  return parsed.entries[0].automation;
}

describe("dataset automation steps", () => {
  it.each([false, true])("reaches only the action in a destination dataset with generated operations %s", (generated) => {
    const invoking = automation("      - invoke: invoices.markPaid\n        collection: Budget\n");
    const rules = { definition, generated, sourceCollection: "Source" };
    const steps = datasetReachSteps(invoking, { path: "Budget", name: "Budget" }, rules, { workspaceId: "workspace", grants: [] }, null)!;
    expect(steps).toMatchObject([{ kind: "dataset-operation", operation: { name: "invoices.markPaid" } }]);
    const ownSteps = datasetReachSteps(invoking, { path: "Budget", name: "Budget" }, { ...rules, sourceCollection: "Budget" }, { workspaceId: "workspace", grants: [] }, null)!;
    expect(ownSteps.filter((step) => step.kind === "dataset-field")).toHaveLength(4);
    expect(steps.map(reachStepId)).toEqual(ownSteps.filter((step) => step.kind === "dataset-operation" && step.operation.name === "invoices.markPaid").map(reachStepId));
  });

  it("keeps only fields read by destination Find and reread operations, with stable verdict identities", () => {
    const narrow: DatasetRules = { definition: { ...definition, operations: definition.operations.map((operation) =>
      operation.kind === "read" ? { ...operation, fieldIds: [STATUS] } : operation) }, generated: true, sourceCollection: "Source" };
    const found = automation("      - invoke: invoices.markPaid\n        collection: Budget\n      - find: 'true'\n        collection: Budget\n        as: found\n        operation: invoices.list\n");
    const added = automation("      - add-record: {Status: Open}\n        collection: Budget\n        as: added\n        operation: invoices.create\n");
    for (const automation of [found, added]) {
      const steps = datasetReachSteps(automation, { path: "Budget", name: "Budget" }, narrow, { workspaceId: "workspace", grants: [] }, null)!;
      expect(steps.filter((step) => step.kind === "dataset-field")).toMatchObject([{ field: { fieldId: STATUS } }]);
      const ownSteps = datasetReachSteps(automation, { path: "Budget", name: "Budget" }, { ...narrow, sourceCollection: "Budget" }, { workspaceId: "workspace", grants: [] }, null)!;
      expect(ownSteps.map(reachStepId)).toEqual(expect.arrayContaining(steps.map(reachStepId)));
    }
  });

  it("treats an explicit self destination like an omitted destination", () => {
    const omitted = automation("      - add-record:\n          Status: Open\n        operation: invoices.create\n      - find: 'record.Status == \"Open\"'\n        as: found\n        operation: invoices.list\n");
    const explicit: Automation = { ...omitted, do: omitted.do.map((step) => step.kind === "add-record" || step.kind === "find" ? { ...step, collection: "Budget" } : step) };
    expect(datasetStepsOf(explicit, generated)).toEqual(datasetStepsOf(omitted, generated));
    const elsewhere: Automation = { ...explicit, do: explicit.do.map((step) => step.kind === "add-record" ? { ...step, collection: "Elsewhere" } : step) };
    expect(datasetAutomationProblem(elsewhere, generated)).toContain("only its own records");
    expect(datasetAutomationProblem(explicit, authored)).toContain("written or changed outside dohc");
  });

  it("does not borrow a read from another table with the same field ID", () => {
    const other = { ...twoTables, tables: twoTables.tables.map((table) => table.tableId === REFUNDS
      ? { ...table, fields: table.fields.map((field) => field.fieldId === REFUND_STATUS ? { ...field, fieldId: STATUS } : field) }
      : table), operations: twoTables.operations.map((operation) => operation.tableId === REFUNDS ? { ...operation, fieldIds: [STATUS] } : operation) };
    const add = automation("      - add-record:\n          Status: Open\n        operation: refunds.create\n", "field-changed: Status\n      table: Invoices");
    const steps = datasetReachSteps(add, { path: "Budget", name: "Budget" }, { definition: other, generated: true }, { workspaceId: "workspace", grants: [] }, null)!;
    expect(steps.find((step) => step.kind === "dataset-field" && step.tableId === REFUNDS && step.field.fieldId === STATUS)).toMatchObject({ reads: [] });
  });

  it.each(["Acme Inc.", "Aux", "Notes: Q1", "Trailing "])("allows omitted and exact self destinations in %s", (path) => {
    const rules = { ...generated, definition: { ...definition, schemaPath: `${path}/schema.sql` } };
    const omitted = automation("      - add-record: {Status: Open}\n        operation: invoices.create\n      - find: 'true'\n        as: found\n        operation: invoices.list\n");
    expect(datasetAutomationProblem(omitted, rules)).toBeNull();
    const explicit = { ...omitted, do: omitted.do.map((step) => step.kind === "add-record" || step.kind === "find" ? { ...step, collection: path } : step) };
    expect(datasetAutomationProblem(explicit, rules)).toBeNull();
  });

  it.each(["budget", "Budget/"])("rejects a differently spelled self destination %s", (path) => {
    for (const step of ["add-record: {Status: Open}\n        operation: invoices.create", "find: 'true'\n        as: found\n        operation: invoices.list"]) {
      const base = automation(`      - ${step}\n`);
      const plan = { ...base, do: base.do.map((entry) => entry.kind === "add-record" || entry.kind === "find" ? { ...entry, collection: path } : entry) };
      expect(datasetAutomationProblem(plan, generated)).toContain("only its own records");
    }
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

  it("claims no ledger subscription for a schedule or a Group message, which the engine claims", () => {
    for (const when of ["{schedule: day, timezone: UTC}", "group-message: Team"]) {
      expect(datasetSubscriptionFor(automation("      - notify: Check\n        to: [user_ana]\n", when), definition)).toBeNull();
    }
  });

  it.each([
    "record-added: null", "record-changed: null", "record-removed: null", "field-changed: Status",
    'starts-matching: record.Status == "Done"', "button: Ask", "{schedule: day, timezone: UTC}", "group-message: Team",
  ])("allows a wake on every supported trigger, including both branches: %s", (when) => {
    const wake = automation("      - wake-agent: Review this\n        person: user_ana\n").do;
    const started = automation("      - notify: Done\n        to: [user_ana]\n", when);
    for (const steps of everywhere(wake, started.do)) {
      expect(datasetAutomationProblem({ ...started, do: steps }, generated)).toBeNull();
      if (started.when.kind === "starts-matching") {
        expect(datasetAutomationProblem({ ...started, do: steps }, authored)).toContain("cannot read a record to check a condition");
      } else {
        expect(datasetAutomationProblem({ ...started, do: steps }, authored)).toBeNull();
      }
    }
  });

  it("counts every edit, create, and read on the watched table among what a code step can call, for presses and the share warning", () => {
    const code = automation("      - run: \"return { set: { Status: 'Done' } }\"\n");
    const all = ["invoices.list", "invoices.status", "invoices.edit", "invoices.create"];
    expect(datasetOperationsOf(code, generated).sort()).toEqual([...all].sort());
    const reached = datasetReachSteps(code, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, null)!
      .flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : []);
    expect(reached.sort()).toEqual([...all].sort());
    // Without a code step, only what the steps name and read.
    const set = automation("      - set:\n          Status: Done\n        operation: invoices.status\n");
    expect(datasetOperationsOf(set, generated).sort()).toEqual(["invoices.list", "invoices.status"]);
    // On operations someone wrote, code changes no record, so it can call none.
    expect(datasetOperationsOf(code, { definition, generated: false })).toEqual([]);
    // A schedule watches no table: its code reads and changes the only one, so every editor must be able to read its fields.
    const nightly = automation("      - run: \"return {}\"\n", "schedule: day\n      timezone: UTC");
    expect(datasetReachSteps(nightly, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, null)!
      .flatMap((step) => step.kind === "dataset-field" ? [step.field.name] : [])).toEqual(["ID", "Status", "Notes", "Finished on"]);
    // Code never picks an action, so a press of its button has none to warn about.
    expect(datasetIrreversibleActions(code, definition)).toEqual([]);
  });

  it("runs code steps on datasets, in branches too", () => {
    const code = automation("      - run: \"return { set: { Status: 'Done' } }\"\n").do;
    const base = automation("      - set:\n          Status: Done\n        operation: invoices.edit\n");
    for (const steps of everywhere(code, base.do)) expect(datasetAutomationProblem({ ...base, do: steps }, generated)).toBeNull();
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
    expect(datasetStepsOf(posting, authored).trigger?.read).toBeNull();
    expect(datasetStepsOf(posting, generated).trigger?.read?.name).toBe("invoices.list");
    expect(datasetOperationsOf(posting, authored)).toEqual([]);
    const steps = datasetReachSteps(posting, { path: "Budget", name: "Budget" }, authored, { workspaceId: "workspace", grants: [] }, null)!;
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
    const steps = datasetReachSteps(invoking, { path: "Budget", name: "Budget" }, authored, { workspaceId: "workspace", grants: [] }, null)!;
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

  it("pins a Find only to a read in its trigger's table, where another table's read fits too", () => {
    const readable: DatasetDefinition = {
      ...twoTables,
      operations: [...twoTables.operations, { ...operation(24, "refunds.list", "read", [REFUND_STATUS]), tableId: REFUNDS }],
    };
    const find = (table: string) => automation("      - find: 'true'\n        as: all\n", `field-changed: Status\n      table: ${table}`);
    expect(pinDatasetOperations(find("Invoices"), { definition: readable, generated: true }).do[0]).toMatchObject({ operation: "invoices.list" });
    expect(pinDatasetOperations(find("Refunds"), { definition: readable, generated: true }).do[0]).toMatchObject({ operation: "refunds.list" });
  });

  it("pins an Add record only to a create in its own table, and names another table's that fits", () => {
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
    expect(datasetFindOf('record.Notes == message.body.slice(6) && record.Status == "Open"')).toEqual([
      { field: "Notes", value: { kind: "formula", expression: "message.body.slice(6)" } },
      { field: "Status", value: { kind: "literal", value: "Open" } },
    ]);
    expect(datasetFindOf("record.Notes == record.Status")).toHaveProperty("problem");
    expect(datasetFindOf('record.Status == "Open" || record.Notes == ""')).toHaveProperty("problem");
    expect(datasetFindOf('contains(record.Notes, "x")')).toHaveProperty("problem");
  });

  it("keys each effect in 66 characters, apart for each record, each added record, and each replan", () => {
    const key = datasetEffectKey("claim", "hash-1", 2, 0, "rec/1", 0);
    expect(key).toMatch(/^a\.[0-9a-f]{64}$/);
    expect(new Set([key, datasetEffectKey("claim", "hash-1", 2, 0, "rec/1", 1), datasetEffectKey("claim", "hash-1", 2, 0, 5, 0),
      datasetEffectKey("claim", "hash-1", 2, 0, null, 0), datasetEffectKey("claim", "hash-1", 2, 1, null, 0),
      datasetEffectKey("claim", "hash-2", 2, 0, "rec/1", 0)]).size).toBe(6);
    expect(datasetEffectKey("claim", "hash-1", 2, 0, "rec/1", 0)).toBe(key);
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
    const steps = datasetReachSteps(addThenSet, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, null)!;
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
    const steps = datasetReachSteps(telling, { path: "Budget", name: "Budget" }, generated, { workspaceId: "workspace", grants: [] }, chat)!;
    // A person a formula names is checked once the formula has run.
    expect(steps.slice(0, 3)).toEqual([
      { kind: "post", group: { channelWireId: "team-wire", name: "Team" } },
      { kind: "notify", person: { userId: "user-owner", name: "you" } },
      { kind: "personal", person: { userId: "user-owner", name: "you" } },
    ]);
    expect(steps.slice(3).every((step) => step.kind === "dataset-operation" || step.kind === "dataset-field")).toBe(true);
  });
});

describe("dataset automations with no trigger record", () => {
  const SCHEDULE = "{schedule: day, timezone: UTC}";
  const GROUP = "{group-message: Team}";
  const grants = { workspaceId: "workspace", grants: [] };
  const budget = { path: "Budget", name: "Budget" };
  // A two-table dataset whose Refunds can be read and changed too.
  const refunds: DatasetDefinition = {
    ...twoTables,
    operations: [
      ...twoTables.operations,
      { ...operation(24, "refunds.list", "read", [REFUND_STATUS]), tableId: REFUNDS },
      { ...operation(25, "refunds.edit", "edit", [REFUND_STATUS], true), tableId: REFUNDS },
    ],
  };
  const closeRefunds = `      - find: record.Status == "Open"
        as: open
        operation: refunds.list
      - set:
          Status: Closed
        records: open
        operation: refunds.edit
`;

  it.each([SCHEDULE, GROUP])("resolves each step's table from its operation, and reaches only those tables: %s", (when) => {
    const sweep = automation(closeRefunds, when);
    expect(datasetAutomationProblem(sweep, { definition: refunds, generated: true })).toBeNull();
    expect(datasetFieldWritesOf(sweep, { definition: refunds, generated: true })).toEqual([{ table: "Refunds", field: "Status" }]);
    const steps = datasetReachSteps(sweep, budget, { definition: refunds, generated: true }, grants, null)!;
    expect(steps.flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : [])).toEqual(["refunds.list", "refunds.edit"]);
    expect(steps.flatMap((step) => step.kind === "dataset-field" ? [step.field.fieldId] : [])).toEqual([id(22), REFUND_STATUS]);
  });

  it("reaches only its chats when it uses no table, and nothing when a formula names the person", () => {
    const told = automation("      - notify: Done\n        to: ['=message.authorUserId']\n", GROUP);
    expect(datasetAutomationProblem(told, generated)).toBeNull();
    expect(datasetReachSteps(told, budget, generated, grants, null)).toEqual([
      { kind: "read-group", group: { channelWireId: null, name: "Team" } },
    ]);
    const reminded = automation("      - notify: Check the invoices\n        to: ['=\"user_ana\"']\n", SCHEDULE);
    expect(datasetReachSteps(reminded, budget, generated, grants, null)).toEqual([]);
    // One whose operations do not resolve has no steps reach could vouch for.
    const gone = automation("      - add-record:\n          Status: New\n        operation: invoices.gone\n", SCHEDULE);
    expect(datasetReachSteps(gone, budget, generated, grants, null)).toBeNull();
  });

  it.each([SCHEDULE, GROUP])("runs an action, and refuses an input that uses trigger.record: %s", (when) => {
    const invoking = (input: string) => automation(`      - invoke: invoices.markPaid
        input:
          note: '${input}'
`, when);
    const actions: DatasetRules = { definition: { ...definition, operations: [...definition.operations,
      { ...operation(30, "invoices.markPaid", "action", [STATUS]) }] }, generated: false };
    expect(datasetAutomationProblem(invoking("=message.body"), actions)).toBeNull();
    // A formula that does not parse fails when it runs, as on any trigger.
    expect(datasetAutomationProblem(invoking("=message.body + "), actions)).toBeNull();
    expect(datasetAutomationProblem(invoking("=trigger.record.Status + \"\""), actions))
      .toMatch(/^A (schedule|Group message) starts this automation, so an action's input cannot use trigger\.record\./);
    expect(datasetReachSteps(invoking("Paid"), budget, actions, grants, null)!
      .flatMap((step) => step.kind === "dataset-operation" ? [step.operation.name] : [])).toEqual(["invoices.markPaid"]);
  });

  it("adds records with no operation named only when the dataset has one table", () => {
    const add = (definitionOf: DatasetDefinition) =>
      pinDatasetOperations(automation("      - add-record:\n          Status: New\n", SCHEDULE), { definition: definitionOf, generated: true }).do[0];
    expect(add(definition)).toMatchObject({ kind: "add-record", operation: "invoices.create" });
    expect(add(twoTables)).toMatchObject({ kind: "add-record", operation: null });
  });

  it.each([SCHEDULE, GROUP])("refuses a Find that compares with the trigger record, joined terms included: %s", (when) => {
    const find = (condition: string) => automation(`      - find: '${condition}'\n        as: same\n        operation: invoices.list\n`, when);
    expect(datasetAutomationProblem(find('record.Status == "Open" && record.Notes == ""'), generated)).toBeNull();
    for (const condition of ["record.Status == trigger.record.Status", 'record.Notes == "" && record.Status == trigger.record.Status']) {
      expect(datasetAutomationProblem(find(condition), generated)).toMatch(/starts this automation, so a Find cannot compare with trigger.record./);
    }
    // A record change has one to compare with.
    expect(datasetAutomationProblem({ ...find("record.Status == trigger.record.Status"), when: { kind: "record-added", table: null } }, generated)).toBeNull();
  });
});
