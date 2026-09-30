import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetAutomationClaim } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition, DatasetOperation, DatasetTable } from "@dohc/security-contract/dataset";
import type { Automation } from "@dohc/workspace-contracts/automations";
import { chatReachStepsOf, datasetFindOf, operationsOf, shapeProblem, stepsInOrder, type DatasetFindFilter, type RunClaim } from "./automationPlan";
import type { ChatDirectory } from "./automationChat";
import { checkAutomationReach, datasetFieldKey, type ReachCollection, type ReachDatasetGrants, type ReachRoster, type ReachStep } from "./automationReach";

// How a dataset Collection's automation maps onto the dataset's approved
// operations. A dataset changes only through them, so each step names one:
// Set fields uses an edit whose fields cover the step's, Add record a create,
// and Find a read with equality filters. Each is called with the automation
// caller, which operation code sees as the automation, not the owner.
//
// Set fields, Add record, Find, and a code step's record changes run only
// through operations dohc generated, whose reads and edits dohc knows. On a dataset whose operations
// someone wrote, an automation runs its actions (invoke steps) and the steps
// that touch no record. It calls no other operation for its own purposes: it
// skips the trigger record's read, so formulas see the record's id and the
// change's facts, which the host decodes from the commit. A formula that
// reads another of the record's fields stops with an error (the evaluator's
// recordKeys). An action runs in its own transaction and reads what it needs.
//
// A code step names no operation, because its changes are known only once it
// runs. The run picks one for each change the way the panel pins a step's,
// in the table the automation watches, and checks its reach then.
//
// The ⚡ panel pins the operation each step uses when it saves. It prefers a
// reversible edit, then the operation with the fewest fields beyond the
// step's. The executor runs only the operation a step pins, and refuses the
// whole run when that operation does not fit.

type AutomationStep = Automation["do"][number];
type RecordStep = Extract<AutomationStep, { kind: "set" | "add-record" | "find" }>;
type InvokeStep = Extract<AutomationStep, { kind: "invoke" }>;
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
  /** Resolves only this destination's steps, retaining their original ordinals. */
  sourceCollection?: string;
}

/** Each step's operation and table, and the read that finds the trigger record. */
export interface DatasetSteps {
  /**
   * The table the trigger watches, and the read its record comes from. The
   * read is null for a record-removed trigger, and on a dataset whose
   * operations someone wrote. A schedule or a Group message has no trigger
   * record, so no trigger table either.
   */
  trigger: { table: DatasetTable; read: DatasetOperation | null } | null;
  steps: ReadonlyMap<number, { operation: DatasetOperation; table: DatasetTable }>;
  finds: ReadonlyMap<number, DatasetFindFilter[]>;
  /**
   * For each Set step, the read that shows its record again after someone
   * changed it; for each Add record step whose record later steps read, the
   * read that shows that record.
   */
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
 * The table a code step changes records in: the one the automation's
 * trigger watches, or for a schedule or a Group message, which watch none,
 * the dataset's only table, as the panel's Add record takes it. Undefined
 * when a trigger with no table meets a dataset with several.
 */
export function datasetCodeTable(automation: Automation, definition: DatasetDefinition): DatasetTable | undefined {
  const trigger = automation.when;
  return datasetTableNamed(definition, "table" in trigger ? trigger.table : null);
}

/**
 * The approved operation the run uses for a change a code step asked for,
 * as the panel would pin it for a step, in the table the automation
 * watches; or why none fits.
 */
export function datasetCodeOperation(
  definition: DatasetDefinition,
  table: DatasetTable,
  kind: Kind,
  names: readonly string[],
): DatasetOperation | { problem: string } {
  return candidates(definition, [table], kind, names)[0] ?? { problem: `${definition.name} has no approved ${fits(kind, names)}.` };
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
  { definition, generated, sourceCollection }: DatasetRules,
  pin: false | ((step: RecordStep) => boolean),
): { steps: DatasetSteps; pinned: Map<number, string> } | { problem: string } {
  const trigger = automation.when;
  // A schedule or a Group message has no trigger record, so its steps take
  // their tables from their operations.
  let table: DatasetTable | null = null;
  const destination = posix.dirname(definition.schemaPath);
  const ownsTrigger = sourceCollection === undefined || sourceCollection === destination;
  const destinations = recordStepDestinations(automation, sourceCollection ?? destination);
  if (ownsTrigger && "table" in trigger) {
    const named = datasetTableNamed(definition, trigger.table);
    if (named === undefined) {
      return { problem: trigger.table === null
        ? `${definition.name} has several tables. Name the one this automation watches.`
        : `${definition.name} has no table named ${trigger.table}.` };
    }
    table = named;
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
    if (step.kind !== "set" && step.collection !== null && step.collection !== posix.dirname(definition.schemaPath)) {
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
      if (target === undefined || target === null) return `Step ${ordinal + 1} changes records that no earlier step found or added.`;
      tables = [target];
    }
    const fitting = candidates(definition, tables, kind, names);
    const named = step.operation === null ? undefined : definition.operations.find((operation) => operation.name === step.operation);
    let chosen = named !== undefined && fitting.includes(named) ? named : undefined;
    // Pinning never moves an Add record or a Find to another table: it
    // stays in its operation's table, or the trigger's when it names none,
    // which is the table the ⚡ panel built it in. A trigger with no table
    // leaves the dataset's only table. With no fit there, a person names one.
    const home = step.kind === "set" ? null : (named ?? table ?? datasetTableNamed(definition, null))?.tableId;
    if (chosen === undefined && pin && pin(step) && home !== undefined) {
      chosen = fitting.find((operation) => home === null || operation.tableId === home);
    }
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
  // An invoke step names its action. Any table's action may run: the action
  // decides what it changes, and reach checks it like any other operation.
  const resolveAction = (ordinal: number, step: InvokeStep): string | null => {
    const action = definition.operations.find((operation) => operation.name === step.operation);
    if (action === undefined) return `${definition.name} has no approved action named ${step.operation}.`;
    if (action.kind !== "action") return `${step.operation} is an approved ${action.kind}, not an action. Use a step that changes fields for it.`;
    steps.set(ordinal, { operation: action, table: definition.tables.find((candidate) => candidate.tableId === action.tableId)! });
    return null;
  };
  for (const { ordinal, step } of ordered) {
    if (sourceCollection !== undefined && destinations.get(ordinal) !== destination) continue;
    if (step.kind === "invoke") {
      const problem = resolveAction(ordinal, step);
      if (problem !== null && !pin) return { problem };
      continue;
    }
    if (step.kind !== "set" && step.kind !== "add-record" && step.kind !== "find") continue;
    if (!generated && sourceCollection !== undefined) return { problem: GENERATED_ONLY(definition.name) };
    const problem = resolveStep(ordinal, step);
    // Pinning goes on past a step no operation fits, so the others still get theirs.
    if (problem !== null && !pin) return { problem };
  }

  // The trigger record is read through the widest read that shows the
  // fields its Set steps change, so formulas see as much of it as they can.
  let triggerRead: DatasetOperation | null = null;
  if (table !== null && trigger.kind !== "record-removed" && generated) {
    const names = setOn.get("trigger") ?? [];
    const reads = candidates(definition, [table], "read", names);
    triggerRead = reads.sort((left, right) => right.fieldIds.length - left.fieldIds.length || left.name.localeCompare(right.name))[0] ?? null;
    if (triggerRead === null && !pin) return { problem: `${definition.name} has no approved ${fits("read", names)} in ${table.name}.` };
  }
  const rereads = new Map<number, DatasetOperation>();
  for (const { ordinal, step } of ordered) {
    const own = steps.get(ordinal);
    if (own === undefined) continue;
    if (step.kind === "add-record" && step.as !== null) {
      // Later steps read the record an Add record step bound through the widest read of its table.
      const reader = candidates(definition, [own.table], "read", []).sort((left, right) => right.fieldIds.length - left.fieldIds.length || left.name.localeCompare(right.name))[0];
      if (reader) rereads.set(ordinal, reader);
    }
    if (step.kind !== "set") continue;
    const bound = step.records === null ? null : bindings.get(step.records) ?? null;
    const source = bound === null ? triggerRead : steps.get(bound)?.operation.kind === "read" ? steps.get(bound)!.operation : undefined;
    const reader = source ?? candidates(definition, [own.table], "read", step.values.map((entry) => entry.field))[0];
    if (reader) rereads.set(ordinal, reader);
  }
  return { steps: { trigger: table === null ? null : { table, read: triggerRead }, steps, finds, rereads }, pinned };
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

/** Why dohc cannot run an automation on this dataset, or null. */
export function datasetAutomationProblem(automation: Automation, dataset: DatasetRules): string | null {
  if (!dataset.generated) {
    const problem = authoredProblem(automation, dataset.definition.name);
    if (problem !== null) return problem;
  }
  const shape = shapeProblem(automation, (condition) => {
    const filters = datasetFindOf(condition);
    return "problem" in filters ? filters : filters.map((filter) => filter.value);
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
  if (!rules.generated && rules.sourceCollection === undefined) {
    const problem = authoredProblem(automation, rules.definition.name);
    if (problem !== null) throw new Error(problem);
  }
  const resolved = resolve(automation, rules, false);
  if ("problem" in resolved) throw new Error(resolved.problem);
  return resolved.steps;
}

/** Static destinations, including the destination inherited by a Set binding. */
export function recordStepDestinations(automation: Automation, source: string): Map<number, string> {
  const bindings = new Map<string, string>();
  const destinations = new Map<number, string>();
  for (const { ordinal, step } of stepsInOrder(automation)) {
    if (step.kind === "add-record" || step.kind === "find") {
      const path = step.collection ?? source;
      destinations.set(ordinal, path);
      if (step.as !== null) bindings.set(step.as, path);
    } else if (step.kind === "set") {
      destinations.set(ordinal, step.records === null ? source : bindings.get(step.records) ?? source);
    } else if (step.kind === "invoke") {
      destinations.set(ordinal, step.collection ?? source);
    } else if (step.kind === "run" || step.kind === "run-file") {
      destinations.set(ordinal, source);
    }
  }
  return destinations;
}

// Each operation a run can call, once each: the trigger record's read, each
// step's operation, and each read that checks a record again. A code step's
// changes are known only once it runs, so it can call every edit, create,
// and read on the table it changes records in. On a dataset whose
// operations someone wrote, it changes no record, so it calls none.
function invokedOperations(automation: Automation, { definition, generated, sourceCollection }: DatasetRules, { trigger, steps, rereads }: DatasetSteps): DatasetOperation[] {
  const codeTable = (sourceCollection === undefined || sourceCollection === posix.dirname(definition.schemaPath)) && generated && stepsInOrder(automation).some(({ step }) => step.kind === "run" || step.kind === "run-file")
    ? datasetCodeTable(automation, definition)
    : undefined;
  const code = codeTable === undefined
    ? []
    : definition.operations.filter((operation) => operation.tableId === codeTable.tableId && (operation.kind === "edit" || operation.kind === "create" || operation.kind === "read"));
  const operations = new Map<string, DatasetOperation>();
  for (const operation of [trigger?.read ?? null, ...[...steps.values()].map((step) => step.operation), ...rereads.values(), ...code]) {
    if (operation !== null) operations.set(operation.operationId, operation);
  }
  return [...operations.values()];
}

/**
 * Every approved operation a run of the automation can call, by name, once
 * each: the operations its steps name, the reads that find its trigger
 * record and check a record again, and those a code step can pick. A person
 * who presses its button must be able to use each of them. A name the rules do not approve is not one: the
 * automation cannot run, and says why.
 */
export function datasetOperationsOf(automation: Automation, rules: DatasetRules): string[] {
  const resolved = resolve(automation, rules, false);
  const reads = "problem" in resolved ? [] : invokedOperations(automation, rules, resolved.steps).map((operation) => operation.name);
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

/**
 * The actions an automation's steps run that dohc cannot undo, once each,
 * in step order, inside If branches too: those the rules give no reverse
 * action. Labels need not be unique, so an action whose label another shares
 * reads with its name.
 */
export function datasetIrreversibleActions(automation: Automation, definition: DatasetDefinition): Array<{ name: string; label: string }> {
  const actions = new Map<string, DatasetOperation>();
  for (const { step } of stepsInOrder(automation)) {
    if (step.kind !== "invoke") continue;
    const action = definition.operations.find((operation) => operation.name === step.operation && operation.kind === "action");
    if (action !== undefined && action.reversedBy === undefined) actions.set(action.name, action);
  }
  const shared = (label: string) => definition.operations.filter((operation) => operation.kind === "action" && operation.label === label).length > 1;
  return [...actions.values()].map((action) => ({ name: action.name, label: shared(action.label) ? `${action.label} (${action.name})` : action.label }));
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
 * operation, each read that checks a record again after someone changed
 * it, and each operation a code step can pick. Then fields its formulas can see:
 * every field in its own tables, and fields its reads expose in other Collections.
 * Formulas see these only while every editor can read them. A field that becomes readable because an
 * editor left waits for a current editor's confirmation, like a step. A
 * button holds no value, so formulas never see one. The chats come first so
 * a schema change cannot move their places. Null for an automation whose
 * operations do not resolve, since it runs nothing reach could vouch for.
 * One that uses no table, such as a schedule that only notifies, reaches
 * only its chats.
 */
export function datasetReachSteps(
  automation: Automation,
  collection: ReachCollection,
  rules: DatasetRules,
  grants: ReachDatasetGrants,
  chat: ChatDirectory | null,
): ReachStep[] | null {
  const { definition } = rules;
  const resolved = resolve(automation, rules, false);
  if ("problem" in resolved) return null;
  const { trigger, steps } = resolved.steps;
  const reach = (operation: DatasetOperation) => ({ operationId: operation.operationId, name: operation.name, label: operation.label, access: operation.access });
  // A code step on a generated dataset reads and changes its table's records, so their fields count too.
  const code = (rules.sourceCollection === undefined || rules.sourceCollection === posix.dirname(definition.schemaPath)) && rules.generated && stepsInOrder(automation).some(({ step }) => step.kind === "run" || step.kind === "run-file")
    ? datasetCodeTable(automation, definition)
    : undefined;
  const tables = new Map([...(trigger === null ? [] : [trigger.table]), ...[...steps.values()].map((step) => step.table), ...(code === undefined ? [] : [code])]
    .map((table) => [table.tableId, table] as const));
  const reads = definition.operations.filter((operation) => operation.kind === "read");
  const operations = invokedOperations(automation, rules, resolved.steps);
  const ownCollection = rules.sourceCollection === undefined || rules.sourceCollection === posix.dirname(definition.schemaPath);
  const invokedReads = operations.filter((operation) => operation.kind === "read");
  return [
    ...chatReachStepsOf(automation, chat),
    ...operations.map((operation): ReachStep => ({ kind: "dataset-operation", collection, datasetId: definition.datasetId, grants, operation: reach(operation) })),
    ...[...tables.values()].flatMap((own) => own.fields.flatMap((field): ReachStep[] => field.type === "button" ||
      (!ownCollection && !invokedReads.some((read) => read.tableId === own.tableId && read.fieldIds.includes(field.fieldId))) ? [] : [{
      kind: "dataset-field", collection, datasetId: definition.datasetId, tableId: own.tableId, grants, field: { fieldId: field.fieldId, name: field.name },
      reads: reads.filter((read) => read.tableId === own.tableId && read.fieldIds.includes(field.fieldId)).map(reach),
    }])),
  ];
}

/**
 * The approved deletes an Undo may use on a record an automation added to
 * `tableId`: the table's deletes that every editor of the automation can use
 * (ADR 0012), so an Undo deletes nothing its editors could not. The builder,
 * a run's plan, and Undo all ask this.
 */
export function datasetUndoDeletes(
  roster: ReachRoster,
  collection: ReachCollection,
  definition: DatasetDefinition,
  tableId: string,
  grants: ReachDatasetGrants,
  codeFiles: readonly string[] = [],
): DatasetOperation[] {
  const deletes = definition.operations.filter((operation) => operation.kind === "delete" && operation.tableId === tableId);
  const verdicts = checkAutomationReach(roster, {
    id: "", collection, codeFiles,
    steps: deletes.map((operation): ReachStep => ({
      kind: "dataset-operation", collection, datasetId: definition.datasetId, grants,
      operation: { operationId: operation.operationId, name: operation.name, label: operation.label, access: operation.access },
    })),
  });
  return deletes.filter((_, index) => verdicts[index]!.allowed);
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
 * changed no field and plans as a human trigger. The executor reads actor
 * attribution and chain depth from the dataset ledger claim.
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
    if (field === undefined || !readable.has(datasetFieldKey(claim.datasetId, table.tableId, field.fieldId))) continue;
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
 * no id yet, so its identity has an empty one, and `part`, the effect's place
 * among its step's effects, tells a code step's added records apart.
 */
export function datasetEffectKey(claimId: string, keySeed: string, ordinal: number, part: number, recordId: DatasetRecordId | null, replan: number, destination?: { datasetId: string; tableId: string }): string {
  const identity = JSON.stringify([claimId, keySeed, ordinal, part, destination?.datasetId ?? null, destination?.tableId ?? null, recordId, replan]);
  return `a.${createHash("sha256").update(identity).digest("hex")}`;
}
