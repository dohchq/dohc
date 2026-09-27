import { createHash } from "node:crypto";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetAutomationClaim } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition, DatasetOperation, DatasetTable } from "@dohc/security-contract/dataset";
import type { Automation } from "@dohc/workspace-contracts/automations";
import { chatReachStepsOf, datasetFindOf, operationsOf, shapeProblem, stepsInOrder, type DatasetFindFilter, type RunClaim } from "./automationPlan";
import type { ChatDirectory } from "./automationChat";
import type { ReachCollection, ReachDatasetGrants, ReachStep } from "./automationReach";

// How a dataset Collection's automation maps onto the dataset's approved
// operations. A dataset changes only through them, so each step names one:
// Set fields uses an edit whose fields cover the step's, Add record a create,
// and Find a read with equality filters. Each is called with the automation
// caller, which operation code sees as the automation, not the owner.
//
// Set fields, Add record, and Find run only through operations dohc
// generated, whose reads and edits dohc knows. On a dataset whose operations
// someone wrote, an automation runs only steps that touch no record, and the
// run calls no operation for its own purposes: it skips the trigger record's
// read, so formulas see the record's id and the change's facts, which the
// host decodes from the commit. A formula that reads another of the record's
// fields stops with an error (the evaluator's recordKeys).
//
// The ⚡ panel pins the operation each step uses when it saves. It prefers a
// reversible edit, then the operation with the fewest fields beyond the
// step's. The executor runs only the operation a step pins, and refuses the
// whole run when that operation does not fit.

type AutomationStep = Automation["do"][number];
type RecordStep = Extract<AutomationStep, { kind: "set" | "add-record" | "find" }>;
type Kind = "edit" | "create" | "read";

/** A dataset record's primary key value, as its operations take it. */
export type DatasetRecordId = string | number;

/**
 * A dataset record's identity within a run: its dataset, its table, and its
 * id with its type. Two tables can hold the same id.
 */
export function datasetRecordKey(datasetId: string, tableId: string, recordId: DatasetRecordId): string {
  return JSON.stringify([datasetId, tableId, recordId]);
}

/** A dataset's approved rules, and whether dohc generated its operations. */
export interface DatasetRules {
  definition: DatasetDefinition;
  generated: boolean;
}

/** Each step's operation and table, and the read that finds the trigger record. */
export interface DatasetSteps {
  table: DatasetTable;
  /**
   * The read the trigger record comes from. Null for a record-removed
   * trigger, and on a dataset whose operations someone wrote.
   */
  triggerRead: DatasetOperation | null;
  steps: ReadonlyMap<number, { operation: DatasetOperation; table: DatasetTable }>;
  finds: ReadonlyMap<number, DatasetFindFilter[]>;
  /** For each Set step, the read that shows its record again after someone changed it. */
  rereads: ReadonlyMap<number, DatasetOperation>;
}

const KIND_OF: Record<RecordStep["kind"], Kind> = { set: "edit", "add-record": "create", find: "read" };

/** A dataset's table by name, or its only table for null. */
export function datasetTableNamed(definition: DatasetDefinition, name: string | null): DatasetTable | undefined {
  return name === null
    ? (definition.tables.length === 1 ? definition.tables[0] : undefined)
    : definition.tables.find((table) => table.name === name);
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

function fits(kind: Kind, fields: readonly string[]): string {
  const named = listFormat.format(fields);
  switch (kind) {
    case "edit":
      return `edit that changes ${named}`;
    case "create":
      return fields.length === 0 ? "way to add records" : `way to add records with ${named}`;
    case "read":
      return fields.length === 0 ? "read" : `read that shows ${named}`;
  }
}

/** The step's field names as the table's field ids, or the first name the table lacks. */
function fieldIds(table: DatasetTable, names: readonly string[]): string[] | { missing: string } {
  const ids: string[] = [];
  for (const name of names) {
    const field = table.fields.find((candidate) => candidate.name === name);
    if (field === undefined) return { missing: name };
    ids.push(field.fieldId);
  }
  return ids;
}

/**
 * The operations that can run a step, best first: a reversible edit, then
 * the fewest fields beyond the step's, then by name. `tables` are the tables
 * the step may use: its one table, or every table for a step that names its
 * table only through its operation.
 */
function candidates(definition: DatasetDefinition, tables: readonly DatasetTable[], kind: Kind, names: readonly string[]): DatasetOperation[] {
  const found: Array<{ operation: DatasetOperation; extra: number }> = [];
  for (const operation of definition.operations) {
    const table = tables.find((candidate) => candidate.tableId === operation.tableId);
    if (operation.kind !== kind || table === undefined) continue;
    const ids = fieldIds(table, names);
    if ("missing" in ids || !ids.every((id) => operation.fieldIds.includes(id))) continue;
    found.push({ operation, extra: operation.fieldIds.length - new Set(ids).size });
  }
  return found
    .sort((left, right) =>
      Number(right.operation.reversible === true) - Number(left.operation.reversible === true) ||
      left.extra - right.extra ||
      left.operation.name.localeCompare(right.operation.name))
    .map(({ operation }) => operation);
}

/**
 * Resolves every step's operation against the approved rules. With `pin`,
 * a step whose operation is missing or does not fit gets the best one that
 * does, unless `pin` says to keep it as it is, and the result says which
 * name each step now pins. Without it, a step must already name an
 * operation that fits.
 */
function resolve(
  automation: Automation,
  { definition, generated }: DatasetRules,
  pin: false | ((step: RecordStep) => boolean),
): { steps: DatasetSteps; pinned: Map<number, string> } | { problem: string } {
  const trigger = automation.when;
  if (!("table" in trigger)) return { problem: "Automations on dataset Collections start only from a record change or a button." };
  const table = datasetTableNamed(definition, trigger.table);
  if (table === undefined) {
    return { problem: trigger.table === null
      ? `${definition.name} has several tables. Name the one this automation watches.`
      : `${definition.name} has no table named ${trigger.table}.` };
  }
  const ordered = stepsInOrder(automation);
  const bindings = new Map<string, number>();
  for (const { ordinal, step } of ordered) {
    if ((step.kind === "find" || step.kind === "add-record") && step.as !== null) bindings.set(step.as, ordinal);
  }
  // Fields a Set step changes on the records it names, which the records'
  // read must also show, so a changed record can be compared again.
  const setOn = new Map<number | "trigger", string[]>();
  for (const { step } of ordered) {
    if (step.kind !== "set") continue;
    const target = step.records === null ? "trigger" : bindings.get(step.records);
    if (target === undefined) continue;
    setOn.set(target, [...(setOn.get(target) ?? []), ...step.values.map((entry) => entry.field)]);
  }

  const steps = new Map<number, { operation: DatasetOperation; table: DatasetTable }>();
  const finds = new Map<number, DatasetFindFilter[]>();
  const pinned = new Map<number, string>();
  // One step's operation, or why it has none. A step no operation fits keeps what it names.
  const resolveStep = (ordinal: number, step: RecordStep): string | null => {
    if (step.kind !== "set" && step.collection !== null) {
      return `Automations on ${definition.name} can use only its own records for now.`;
    }
    const kind = KIND_OF[step.kind];
    let names: string[];
    let tables: readonly DatasetTable[];
    if (step.kind === "find") {
      const filters = datasetFindOf(step.condition);
      if ("problem" in filters) return filters.problem;
      finds.set(ordinal, filters);
      names = [...new Set([...filters.map((filter) => filter.field), ...(setOn.get(ordinal) ?? [])])];
      tables = definition.tables;
    } else if (step.kind === "add-record") {
      names = step.values.map((entry) => entry.field);
      tables = definition.tables;
    } else {
      names = step.values.map((entry) => entry.field);
      const bound = step.records === null ? null : bindings.get(step.records);
      const target = bound === undefined || bound === null ? table : steps.get(bound)?.table;
      if (target === undefined) return `Step ${ordinal + 1} changes records that no earlier step found or added.`;
      tables = [target];
    }
    const fitting = candidates(definition, tables, kind, names);
    const named = step.operation === null ? undefined : definition.operations.find((operation) => operation.name === step.operation);
    let chosen = named !== undefined && fitting.includes(named) ? named : undefined;
    // Pinning never moves an Add record to another table: it stays in its
    // operation's table, or the trigger's when it names none, which is the
    // table the ⚡ panel built it in. With no fit there, a person names one.
    const home = step.kind === "add-record" ? (named?.tableId ?? table.tableId) : null;
    if (chosen === undefined && pin && pin(step)) chosen = fitting.find((operation) => home === null || operation.tableId === home);
    if (chosen === undefined) {
      if (tables.length === 1) {
        const missing = fieldIds(tables[0]!, names);
        if ("missing" in missing) return `${tables[0]!.name} has no field named ${missing.missing}.`;
      }
      if (fitting.length === 0) return `${definition.name} has no approved ${fits(kind, names)}.`;
      if (step.operation === null) return `Name the approved operation step ${ordinal + 1} uses, such as ${fitting[0]!.name}.`;
      if (named === undefined) return `${definition.name} has no approved operation named ${step.operation}.`;
      return `${named.name} is not an approved ${fits(kind, names)}.`;
    }
    if (chosen.name !== step.operation) pinned.set(ordinal, chosen.name);
    steps.set(ordinal, { operation: chosen, table: definition.tables.find((candidate) => candidate.tableId === chosen.tableId)! });
    return null;
  };
  for (const { ordinal, step } of ordered) {
    if (step.kind !== "set" && step.kind !== "add-record" && step.kind !== "find") continue;
    const problem = resolveStep(ordinal, step);
    // Pinning goes on past a step no operation fits, so the others still get theirs.
    if (problem !== null && !pin) return { problem };
  }

  // The trigger record is read through the widest read that shows the
  // fields its Set steps change, so formulas see as much of it as they can.
  let triggerRead: DatasetOperation | null = null;
  if (trigger.kind !== "record-removed" && generated) {
    const names = setOn.get("trigger") ?? [];
    const reads = candidates(definition, [table], "read", names);
    triggerRead = reads.sort((left, right) => right.fieldIds.length - left.fieldIds.length || left.name.localeCompare(right.name))[0] ?? null;
    if (triggerRead === null && !pin) return { problem: `${definition.name} has no approved ${fits("read", names)} in ${table.name}.` };
  }
  const rereads = new Map<number, DatasetOperation>();
  for (const { ordinal, step } of ordered) {
    const own = steps.get(ordinal);
    if (step.kind !== "set" || own === undefined) continue;
    const bound = step.records === null ? null : bindings.get(step.records) ?? null;
    const source = bound === null ? triggerRead : steps.get(bound)?.operation.kind === "read" ? steps.get(bound)!.operation : undefined;
    const reader = source ?? candidates(definition, [own.table], "read", step.values.map((entry) => entry.field))[0];
    if (reader) rereads.set(ordinal, reader);
  }
  return { steps: { table, triggerRead, steps, finds, rereads }, pinned };
}

const GENERATED_ONLY = (name: string) =>
  `${name}'s operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.`;
const AUTHORED_MATCHING = (name: string) =>
  `${name}'s operations were written or changed outside dohc, so dohc cannot read a record to check a condition. Choose a record change or a button as the trigger.`;

/**
 * Why an automation cannot run on a dataset whose operations someone wrote,
 * or null: it has a step that changes or finds records, or a trigger that
 * needs the record read.
 */
function authoredProblem(automation: Automation, name: string): string | null {
  if (stepsInOrder(automation).some(({ step }) => step.kind === "set" || step.kind === "add-record" || step.kind === "find")) return GENERATED_ONLY(name);
  return automation.when.kind === "starts-matching" ? AUTHORED_MATCHING(name) : null;
}

export const DATASET_WAKE_NEEDS_BUTTON =
  "In this Collection, only a button can wake your agent, because dohc cannot tell a person's change from an agent's. Choose a button as the trigger.";

/** Why dohc cannot run an automation on this dataset, or null. */
export function datasetAutomationProblem(automation: Automation, dataset: DatasetRules): string | null {
  // Only a person's change wakes an agent. A dataset commit does not say
  // whether a person or an agent made it, and an agent's writes through the
  // CLI commit as the owner, so only a press, which a person makes, can.
  if (automation.when.kind !== "button" && stepsInOrder(automation).some(({ step }) => step.kind === "wake-agent")) {
    return DATASET_WAKE_NEEDS_BUTTON;
  }
  if (!dataset.generated) {
    const problem = authoredProblem(automation, dataset.definition.name);
    if (problem !== null) return problem;
  }
  const shape = shapeProblem(automation, (condition) => {
    const filters = datasetFindOf(condition);
    return "problem" in filters ? filters.problem : null;
  });
  if (shape !== null) return shape;
  const resolved = resolve(automation, dataset, false);
  return "problem" in resolved ? resolved.problem : null;
}

/**
 * Each step's operation, for a run. The executor has checked the automation
 * first; rules that changed since can still refuse it here.
 */
export function datasetStepsOf(automation: Automation, rules: DatasetRules): DatasetSteps {
  if (!rules.generated) {
    const problem = authoredProblem(automation, rules.definition.name);
    if (problem !== null) throw new Error(problem);
  }
  const resolved = resolve(automation, rules, false);
  if ("problem" in resolved) throw new Error(resolved.problem);
  return resolved.steps;
}

// Each operation a run can call, once each: the trigger record's read, each
// step's operation, and each read that checks a record again.
function invokedOperations({ triggerRead, steps, rereads }: DatasetSteps): DatasetOperation[] {
  const operations = new Map<string, DatasetOperation>();
  for (const operation of [triggerRead, ...[...steps.values()].map((step) => step.operation), ...rereads.values()]) {
    if (operation !== null) operations.set(operation.operationId, operation);
  }
  return [...operations.values()];
}

/**
 * Every approved operation a run of the automation can call, by name, once
 * each: the operations its steps name, and the reads that find its trigger
 * record and check a record again. A person who presses its button must be
 * able to use each of them. A name the rules do not approve is not one: the
 * automation cannot run, and says why.
 */
export function datasetOperationsOf(automation: Automation, rules: DatasetRules): string[] {
  const resolved = resolve(automation, rules, false);
  const reads = "problem" in resolved ? [] : invokedOperations(resolved.steps).map((operation) => operation.name);
  const approved = new Set(rules.definition.operations.map((operation) => operation.name));
  return [...new Set([...operationsOf(automation), ...reads])].filter((name) => approved.has(name));
}

/**
 * The fields each Set and Add record step writes, with the name of the
 * table its approved operation writes to. An automation whose operations do
 * not resolve writes nothing.
 */
export function datasetFieldWritesOf(automation: Automation, rules: DatasetRules): Array<{ table: string; field: string }> {
  const resolved = resolve(automation, rules, false);
  if ("problem" in resolved) return [];
  return stepsInOrder(automation).flatMap(({ ordinal, step }) => {
    const own = resolved.steps.steps.get(ordinal);
    return own !== undefined && (step.kind === "set" || step.kind === "add-record")
      ? step.values.map(({ field }) => ({ table: own.table.name, field }))
      : [];
  });
}

/** The table and Button field a button automation's trigger names in the rules, or null. */
export function datasetButtonOf(automation: Automation, definition: DatasetDefinition): { tableId: string; fieldId: string } | null {
  const trigger = automation.when;
  if (trigger.kind !== "button") return null;
  const table = datasetTableNamed(definition, trigger.table);
  const field = table?.fields.find((candidate) => candidate.type === "button" && candidate.name === trigger.field);
  return table && field ? { tableId: table.tableId, fieldId: field.fieldId } : null;
}

/**
 * The reach check's view of a dataset automation. First the chats it
 * reaches, as a document Collection's automation reaches them. Then each
 * operation it can call, once each: the trigger record's read, each step's
 * operation, and each read that checks a record again after someone changed
 * it. Then each field of the tables it uses, which its formulas see only
 * while every editor can read it; a field that becomes readable because an
 * editor left waits for a current editor's confirmation, like a step. A
 * button holds no value, so formulas never see one. The chats come first so
 * a schema change cannot move their places. An automation whose operations
 * do not resolve runs nothing, so it has no steps to check.
 */
export function datasetReachSteps(
  automation: Automation,
  collection: ReachCollection,
  rules: DatasetRules,
  grants: ReachDatasetGrants,
  chat: ChatDirectory | null,
): ReachStep[] {
  const { definition } = rules;
  const resolved = resolve(automation, rules, false);
  if ("problem" in resolved) return [];
  const { table, steps } = resolved.steps;
  const reach = (operation: DatasetOperation) => ({ operationId: operation.operationId, name: operation.name, access: operation.access });
  const tables = new Map([[table.tableId, table], ...[...steps.values()].map((step) => [step.table.tableId, step.table] as const)]);
  const reads = definition.operations.filter((operation) => operation.kind === "read");
  return [
    ...chatReachStepsOf(automation, chat),
    ...invokedOperations(resolved.steps).map((operation): ReachStep => ({ kind: "dataset-operation", collection, grants, operation: reach(operation) })),
    ...[...tables.values()].flatMap((own) => own.fields.flatMap((field): ReachStep[] => field.type === "button" ? [] : [{
      kind: "dataset-field", collection, grants, field: { fieldId: field.fieldId, name: field.name },
      reads: reads.filter((read) => read.fieldIds.includes(field.fieldId)).map(reach),
    }])),
  ];
}

/**
 * The automation with each step pinned to the operation the panel prefers,
 * where the step names none or one that no longer fits. A step no operation
 * fits keeps what it names, and the automation says why it cannot run. So
 * does a step `kept` answers true for, such as one the file already holds.
 */
export function pinDatasetOperations(
  automation: Automation,
  rules: DatasetRules,
  kept: (step: RecordStep) => boolean = () => false,
): Automation {
  const resolved = resolve(automation, rules, (step) => !kept(step));
  if ("problem" in resolved || resolved.pinned.size === 0) return automation;
  let counter = 0;
  const pin = (steps: readonly AutomationStep[]): AutomationStep[] => steps.map((step): AutomationStep => {
    const ordinal = counter++;
    if (step.kind === "if") {
      const then = pin(step.do);
      return { ...step, do: then, otherwise: pin(step.otherwise) };
    }
    const name = resolved.pinned.get(ordinal);
    return name !== undefined && (step.kind === "set" || step.kind === "add-record" || step.kind === "find") ? { ...step, operation: name } : step;
  });
  return { ...automation, do: pin(automation.do) };
}

/**
 * A dataset claim as planning reads a change: fields named as the approved
 * rules name them, each side wrapped as the engine wraps a fact. A press
 * changed no field, and a person made it. A commit does not say whether a
 * person or an agent made it, so its actor is left unknown.
 */
export function datasetRunClaim(claim: DatasetAutomationClaim, collectionPath: string, table: DatasetTable, readable: ReadonlySet<string>): RunClaim {
  const fact = claim.fact;
  if (fact === null) throw new Error(claim.error ?? "This change cannot be read.");
  const side = (present: boolean, value: JsonValue, truncated: boolean) =>
    !present ? null : truncated ? { truncated: true as const, bytes: 0 } : { value };
  const fields: RunClaim["change"]["fields"][number][] = [];
  for (const change of fact.kind === "button" ? [] : fact.fields) {
    const field = table.fields.find((candidate) => candidate.fieldId === change.fieldId);
    // A claim carries each watched field; formulas see only the readable ones.
    if (field === undefined || !readable.has(field.fieldId)) continue;
    const truncated = change.truncated === true;
    fields.push({
      field: field.name,
      previous: side(fact.kind !== "added", change.previous as JsonValue, truncated),
      next: side(fact.kind !== "removed", change.next as JsonValue, truncated),
    });
  }
  return {
    automationId: claim.automationId, claimId: claim.claimId, createdAtMs: claim.createdAtMs, collectionPath,
    change: { kind: fact.kind, fields, fieldsOmitted: 0, ...(fact.kind === "button" ? { actorKind: "human" as const } : {}) },
  };
}

/**
 * The idempotency key of one dataset effect: "a." and the hex SHA-256 of its
 * identity, 66 characters. A replan after a stale record sends different
 * content, so it raises `replan` and never reuses a key. An added record has
 * no id yet, so its identity ends with an empty one.
 */
export function datasetEffectKey(claimId: string, keySeed: string, ordinal: number, recordId: DatasetRecordId | null, replan: number): string {
  const identity = `${claimId}/${keySeed}/${ordinal}/${recordId ?? ""}/${replan}`;
  return `a.${createHash("sha256").update(identity).digest("hex")}`;
}
