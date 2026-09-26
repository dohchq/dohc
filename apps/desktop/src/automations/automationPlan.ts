import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseExpressionAt, tokenizer, tokTypes, type Expression } from "acorn";
import {
  AUTOMATION_LIMITS,
  type AutomationFormula,
  type AutomationOutcome,
  type AutomationScope,
  type JsonObject,
  type JsonValue,
} from "@dohc/app-backend-runtime/automation";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { automationTextParts, type Automation, type AutomationScheduleTrigger } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord, CollectionValue } from "@dohc/workspace-contracts/collection";
import type { AutomationChangeKind, AutomationClaim } from "@dohc/workspace-engine-client";
import { derivedRecordId } from "../workspaces/collectionRecordEdits";
import type { ReachCollection, ReachStep } from "./automationReach";
import {
  automationMessageId,
  automationNoticeId,
  automationThreadId,
  automationWakeThreadId,
  cutText,
  type AutomationNotice,
  type ChatDirectory,
} from "./automationChat";

// What one run of a Collection automation does, worked out before anything
// is written. The executor reads the trigger record and every Find, asks the
// evaluator for every formula in one request, and turns the answers into a
// plan: the record changes each step makes, in step order. The plan is saved
// before the first write, so a run that stops part way resumes with the same
// values instead of evaluating again.
//
// In every formula, `record` is the record a step is about: the trigger
// record, each record a Find checks, or each record a step changes among the
// records a Find returned. `trigger.record` is always the trigger record.
// Formulas read the records as they were when the run started. A record an
// earlier step added reads as null, because it does not exist yet.

type AutomationTrigger = Automation["when"];
type AutomationStep = Automation["do"][number];
type IfStep = Extract<AutomationStep, { kind: "if" }>;
type AutomationValue = Extract<AutomationStep, { kind: "set" }>["values"][number]["value"];

/** The claim prefix this executor drains, beside the plugin executor's "plugin:". */
export const COLLECTION_AUTOMATION_PREFIX = "collection:";
const MAX_FINDS = 5;
export const MAX_FOUND_RECORDS = 50;
// The field changes one run may plan. Every one is saved before and after it
// lands, so a run stays small enough to resume and to undo.
export const MAX_RUN_FIELD_WRITES = 200;
// The trigger record before its change, which a starts-matching condition
// is also checked against.
const BEFORE_BINDING = "__dohc_before";

export function collectionAutomationId(collectionPath: string, id: string): string {
  return `${COLLECTION_AUTOMATION_PREFIX}${collectionPath}#${id}`;
}

/** The Collection and automation an engine automation id names, or null. */
export function parseCollectionAutomationId(
  engineId: string,
): { collectionPath: string; id: string } | null {
  if (!engineId.startsWith(COLLECTION_AUTOMATION_PREFIX)) return null;
  const rest = engineId.slice(COLLECTION_AUTOMATION_PREFIX.length);
  // An automation id is a slug, so the last "#" ends the Collection path.
  const hash = rest.lastIndexOf("#");
  if (hash <= 0 || hash === rest.length - 1) return null;
  return { collectionPath: rest.slice(0, hash), id: rest.slice(hash + 1) };
}

/**
 * Names what an automation does: its trigger, condition, and steps. A new
 * name or the on and off switch keep the hash, so they never turn a retry
 * into a fresh run.
 */
export function definitionHash(automation: Automation): string {
  return definitionDigest(automation).slice(0, 16);
}

/** The whole SHA-256 that `definitionHash` shortens, as the dataset ledger keeps it. */
export function definitionDigest(automation: Automation): string {
  return createHash("sha256")
    .update(JSON.stringify([automation.when, automation.if, automation.do]))
    .digest("hex");
}

/**
 * The schedule a mark counts for. A changed time, day, or time zone is a
 * new schedule, so its mark starts again at the change.
 */
export function scheduleHash(trigger: AutomationScheduleTrigger): string {
  return createHash("sha256").update(JSON.stringify(trigger)).digest("hex").slice(0, 16);
}

/** The due time a schedule claim runs for, from its `schedule:<due ms>` key, or null. */
export function scheduleDueAt(claim: Pick<RunClaim, "trigger">): number | null {
  const key = claim.trigger && "key" in claim.trigger ? claim.trigger.key : null;
  const match = key === null ? null : /^schedule:(0|[1-9]\d{0,15})$/u.exec(key);
  const due = match ? Number(match[1]) : null;
  return due !== null && Number.isSafeInteger(due) ? due : null;
}

/**
 * The first skipped time a Run now claim runs for, from its key
 * `run-now:<notice id>`, whose notice id ends with `:<first skipped ms>`.
 */
export function runNowSkippedFrom(claim: Pick<RunClaim, "trigger">): number | null {
  const key = claim.trigger && "key" in claim.trigger ? claim.trigger.key : null;
  const match = key === null ? null : /^run-now:schedule-skipped:.+:(0|[1-9]\d{0,15})$/u.exec(key);
  const first = match ? Number(match[1]) : null;
  return first !== null && Number.isSafeInteger(first) ? first : null;
}

/** A step with its position among all steps, counted depth first. */
type OrderedStep =
  | { ordinal: number; step: Exclude<AutomationStep, IfStep> }
  | { ordinal: number; step: IfStep; then: OrderedStep[]; otherwise: OrderedStep[] };

function orderSteps(steps: readonly AutomationStep[], counter = { next: 0 }): OrderedStep[] {
  return steps.map((step): OrderedStep => {
    const ordinal = counter.next++;
    if (step.kind !== "if") return { ordinal, step };
    const then = orderSteps(step.do, counter);
    return { ordinal, step, then, otherwise: orderSteps(step.otherwise, counter) };
  });
}

/** Every step with its ordinal, depth first, as runs and keys count them. */
export function stepsInOrder(automation: Automation): Array<{ ordinal: number; step: AutomationStep }> {
  return [...everyStep(orderSteps(automation.do))].map(({ ordinal, step }) => ({ ordinal, step }));
}

function* everyStep(steps: readonly OrderedStep[]): Generator<OrderedStep> {
  for (const entry of steps) {
    yield entry;
    if ("then" in entry) {
      yield* everyStep(entry.then);
      yield* everyStep(entry.otherwise);
    }
  }
}

/** What a binding holds: the records a Find returned, or the record an add-record step adds. */
type Binding = { kind: "find" | "add"; ordinal: number; collection: string | null };

function bindingsOf(steps: readonly OrderedStep[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const { ordinal, step } of everyStep(steps)) {
    if (step.kind === "find") bindings.set(step.as, { kind: "find", ordinal, collection: step.collection });
    if (step.kind === "add-record" && step.as !== null) {
      bindings.set(step.as, { kind: "add", ordinal, collection: step.collection });
    }
  }
  return bindings;
}

function isFormula(value: AutomationValue): value is Extract<AutomationValue, { kind: "formula" }> {
  return value.kind === "formula";
}

/**
 * Why `source` is not exactly one JavaScript expression, or null when it
 * is. It only parses, so a formula that would loop costs nothing here.
 */
export function expressionProblem(source: string): string | null {
  try {
    const { end } = parseExpressionAt(source, 0, { ecmaVersion: "latest", preserveParens: true });
    const next = tokenizer(source.slice(end), { ecmaVersion: "latest" }).getToken();
    return next.type === tokTypes.eof ? null : `Unexpected text at character ${end + next.start + 1}.`;
  } catch (error) {
    return error instanceof SyntaxError ? error.message.replace(/\s*\(\d+:\d+\)$/u, ".") : "This is not a formula.";
  }
}

/** True when `source` is exactly one JavaScript expression, so it can sit inside another. */
function isOneExpression(source: string): boolean {
  try {
    const { end } = parseExpressionAt(source, 0, { ecmaVersion: "latest", preserveParens: true });
    return tokenizer(source.slice(end), { ecmaVersion: "latest" }).getToken().type === tokTypes.eof;
  } catch {
    return false;
  }
}

/** A Find condition as the one filter `collections.query` takes. */
type FindQuery =
  | { match: "all" }
  | {
      match: "field";
      field: string;
      operator: "equals" | "contains";
      value: { kind: "literal"; value: JsonValue } | { kind: "trigger-field"; field: string };
    };

const FIND_SHAPE =
  'A Find can check one field, such as record.Status == "Doing" or contains(record.Tags, "urgent").';

function propertyName(node: Expression, object: (inner: Expression) => boolean): string | null {
  if (node.type !== "MemberExpression" || node.optional || node.object.type === "Super") return null;
  if (!object(node.object)) return null;
  const { property } = node;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (node.computed && property.type === "Literal" && typeof property.value === "string") return property.value;
  return null;
}

const isName = (name: string) => (node: Expression) => node.type === "Identifier" && node.name === name;
const candidateField = (node: Expression) => propertyName(node, isName("record"));
const triggerField = (node: Expression) =>
  propertyName(node, (inner) => propertyName(inner, isName("trigger")) === "record");

function findValue(node: Expression): Extract<FindQuery, { match: "field" }>["value"] | null {
  if (node.type === "Literal") {
    const { value } = node;
    return value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
      ? { kind: "literal", value }
      : null;
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" &&
    typeof node.argument.value === "number") {
    return { kind: "literal", value: -node.argument.value };
  }
  const field = triggerField(node);
  return field === null ? null : { kind: "trigger-field", field };
}

/**
 * Reads a Find condition as a query: `true`, `record.F == value`, or
 * `contains(record.F, value)`, where the value is a literal or a field of
 * the trigger record (`trigger.record.F`). Anything else is a problem the
 * person has to fix, because `collections.query` takes one filter.
 */
export function findQueryOf(condition: string): FindQuery | { problem: string } {
  if (!isOneExpression(condition)) return { problem: FIND_SHAPE };
  let node = parseExpressionAt(condition, 0, { ecmaVersion: "latest" });
  while (node.type === "ParenthesizedExpression") node = node.expression;
  if (node.type === "Literal" && node.value === true) return { match: "all" };
  if (node.type === "BinaryExpression" && (node.operator === "==" || node.operator === "===") &&
    node.left.type !== "PrivateIdentifier") {
    for (const [side, other] of [[node.left, node.right], [node.right, node.left]] as const) {
      const field = candidateField(side);
      const value = field === null ? null : findValue(other);
      if (field !== null && value !== null) return { match: "field", field, operator: "equals", value };
    }
  }
  if (node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" &&
    node.callee.name === "contains" && node.arguments.length === 2) {
    const [target, search] = node.arguments;
    const field = target && target.type !== "SpreadElement" ? candidateField(target) : null;
    const value = field !== null && search && search.type !== "SpreadElement" ? findValue(search) : null;
    if (field !== null && value !== null) return { match: "field", field, operator: "contains", value };
  }
  return { problem: FIND_SHAPE };
}

/** A Find condition on a dataset as a read's equality filters: every field it checks, with its value. */
export type DatasetFindFilter = { field: string; value: Extract<FindQuery, { match: "field" }>["value"] };

const DATASET_FIND_SHAPE =
  'A Find on a dataset can check fields with ==, such as record.Status == "Doing" && record.Paid == false.';

/**
 * Reads a Find condition on a dataset: `true`, or `record.F == value` terms
 * joined by &&, where each value is a literal or a trigger record field.
 * A dataset's read compares whole values, so it offers no "contains".
 */
export function datasetFindOf(condition: string): DatasetFindFilter[] | { problem: string } {
  if (!isOneExpression(condition)) return { problem: DATASET_FIND_SHAPE };
  const filters: DatasetFindFilter[] = [];
  const visit = (node: Expression): boolean => {
    while (node.type === "ParenthesizedExpression") node = node.expression;
    if (node.type === "LogicalExpression" && node.operator === "&&") return visit(node.left) && visit(node.right);
    if (node.type !== "BinaryExpression" || (node.operator !== "==" && node.operator !== "===") || node.left.type === "PrivateIdentifier") return false;
    for (const [side, other] of [[node.left, node.right], [node.right, node.left]] as const) {
      const field = candidateField(side);
      const value = field === null ? null : findValue(other);
      if (field !== null && value !== null) {
        filters.push({ field, value });
        return true;
      }
    }
    return false;
  };
  const node = parseExpressionAt(condition, 0, { ecmaVersion: "latest", preserveParens: true });
  let bare: Expression = node;
  while (bare.type === "ParenthesizedExpression") bare = bare.expression;
  if (bare.type === "Literal" && bare.value === true) return [];
  return visit(node) ? filters : { problem: DATASET_FIND_SHAPE };
}

const RECORD_TRIGGERS = new Set<AutomationTrigger["kind"]>([
  "record-added", "record-changed", "field-changed", "record-removed", "starts-matching",
]);

/** The dataset operations an automation's steps invoke, by name, once each. */
export function operationsOf(automation: Automation): string[] {
  const names = new Set<string>();
  for (const { step } of everyStep(orderSteps(automation.do))) {
    if ((step.kind === "set" || step.kind === "add-record" || step.kind === "find") && step.operation !== null) names.add(step.operation);
  }
  return [...names];
}

const DATASET_GROUP_TRIGGER_UNSUPPORTED = "Automations on dataset Collections can't start from Group messages.";
export const RECORD_TRIGGERS_ONLY = "dohc can run automations that start from a record change. Other triggers come later.";

/**
 * Why this executor cannot run an automation yet, or null when it can. The
 * executor subscribes only automations it can run; the ⚡ panel shows the
 * reason for the rest.
 */
export function unsupportedReason(automation: Automation): string | null {
  const DATASET = "Only a dataset Collection's automations can name tables and operations.";
  if ("table" in automation.when && automation.when.table !== null) return DATASET;
  for (const { step } of stepsInOrder(automation)) {
    if ((step.kind === "set" || step.kind === "add-record" || step.kind === "find") && step.operation !== null) return DATASET;
  }
  return shapeProblem(automation, (condition) => {
    const query = findQueryOf(condition);
    return "problem" in query ? query.problem : null;
  });
}

/**
 * Why no executor can run an automation of this shape yet, whatever its
 * Collection keeps: its trigger, its steps, and its limits. `findProblem`
 * reads a Find condition the way the Collection's records can be queried.
 */
export function shapeProblem(automation: Automation, findProblem: (condition: string) => string | null): string | null {
  const scheduled = automation.when.kind === "schedule";
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  let finds = 0;
  let formulas = (automation.if === null ? 0 : 1) +
    (automation.when.kind === "field-changed" && automation.when.to?.kind === "formula" ? 1 : 0) +
    (automation.when.kind === "starts-matching" ? 2 : 0);
  for (const { step } of everyStep(steps)) {
    switch (step.kind) {
      case "wake-agent":
      case "post":
        formulas += 1;
        break;
      case "notify":
      case "direct-message":
        formulas += 1 + step.to.filter(isFormula).length;
        break;
      case "run":
      case "run-file":
        return "dohc cannot run code steps yet.";
      case "find": {
        finds += 1;
        formulas += 1;
        const problem = findProblem(step.condition);
        if (problem !== null) return problem;
        if (scheduled) {
          const query = findQueryOf(step.condition);
          if (!("problem" in query) && query.match === "field" && query.value.kind === "trigger-field") {
            return "A scheduled automation has no trigger record, so a Find cannot compare with trigger.record.";
          }
        }
        break;
      }
      case "if":
        formulas += 1;
        break;
      case "set":
      case "add-record":
        formulas += step.values.filter((entry) => isFormula(entry.value)).length;
        if (step.kind === "set" && step.records !== null && step.values.some((entry) => isFormula(entry.value)) &&
          bindings.get(step.records)?.kind === "find") {
          for (const entry of step.values) {
            if (isFormula(entry.value) && !isOneExpression(entry.value.expression)) {
              return `The formula for "${entry.field}" must be one expression.`;
            }
          }
        }
        break;
    }
  }
  if (finds > MAX_FINDS) return `An automation can use at most ${MAX_FINDS} Find steps.`;
  if (bindings.has(BEFORE_BINDING)) return `A step result cannot be named ${BEFORE_BINDING}.`;
  if (formulas > AUTOMATION_LIMITS.formulasPerBatch) {
    return `An automation can use at most ${AUTOMATION_LIMITS.formulasPerBatch} formulas.`;
  }
  if (automation.when.kind === "starts-matching" && !isOneExpression(automation.when.condition)) {
    return "The condition must be one expression.";
  }
  return null;
}

/**
 * Every field an automation names by name, with the Collection that must
 * have it: its trigger's fields, the fields its steps set or add, and the
 * field each Find checks. Fields that formulas read are not listed.
 */
export function fieldsNamedBy(automation: Automation, collectionPath: string): Array<{ collection: string; field: string }> {
  const named: Array<{ collection: string; field: string }> = [];
  const trigger = automation.when;
  if (trigger.kind === "field-changed") named.push({ collection: collectionPath, field: trigger.field });
  if (trigger.kind === "record-changed") {
    for (const field of trigger.fields ?? []) named.push({ collection: collectionPath, field });
  }
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  for (const { step } of everyStep(steps)) {
    if (step.kind === "set") {
      const bound = step.records === null ? null : bindings.get(step.records);
      const collection = bound?.collection ?? collectionPath;
      for (const { field } of step.values) named.push({ collection, field });
    } else if (step.kind === "add-record") {
      for (const { field } of step.values) named.push({ collection: step.collection ?? collectionPath, field });
    } else if (step.kind === "find") {
      const query = findQueryOf(step.condition);
      if ("match" in query && query.match === "field") {
        named.push({ collection: step.collection ?? collectionPath, field: query.field });
        if (query.value.kind === "trigger-field") named.push({ collection: collectionPath, field: query.value.field });
      }
    }
  }
  return named;
}

/** The engine subscription an automation's trigger needs, or null when a press or a due time claims instead of a change. */
export function subscriptionFor(trigger: AutomationTrigger): { kinds: AutomationChangeKind[]; fields?: string[] } | null {
  switch (trigger.kind) {
    case "schedule":
    case "button":
      return null;
    case "record-added":
      return { kinds: ["added"] };
    case "record-changed":
      return trigger.fields === null ? { kinds: ["changed"] } : { kinds: ["changed"], fields: trigger.fields };
    case "field-changed":
      return { kinds: ["changed"], fields: [trigger.field] };
    case "record-removed":
      return { kinds: ["removed"] };
    default:
      return { kinds: ["added", "changed"] };
  }
}

/**
 * The dataset ledger subscription a dataset Collection's automation needs:
 * its table, and its watched fields as field ids of the approved rules. Or
 * why the automation cannot watch the dataset.
 */
export function datasetSubscriptionFor(
  automation: Automation,
  definition: DatasetDefinition,
): { tableId: string; kinds: AutomationChangeKind[]; fieldIds: string[] | null } | { problem: string } {
  const trigger = automation.when;
  if (trigger.kind === "group-message") return { problem: DATASET_GROUP_TRIGGER_UNSUPPORTED };
  if (!RECORD_TRIGGERS.has(trigger.kind) || !("table" in trigger)) return { problem: RECORD_TRIGGERS_ONLY };
  const table = trigger.table === null
    ? (definition.tables.length === 1 ? definition.tables[0] : undefined)
    : definition.tables.find((candidate) => candidate.name === trigger.table);
  if (table === undefined) {
    return { problem: trigger.table === null
      ? `${definition.name} has several tables. Name the one this automation watches.`
      : `${definition.name} has no table named ${trigger.table}.` };
  }
  const subscription = subscriptionFor(trigger);
  if (subscription === null) return { problem: RECORD_TRIGGERS_ONLY };
  const { kinds, fields } = subscription;
  const fieldIds: string[] = [];
  for (const name of fields ?? []) {
    const field = table.fields.find((candidate) => candidate.name === name);
    if (field === undefined) return { problem: `${table.name} has no field named ${name}.` };
    fieldIds.push(field.fieldId);
  }
  return { tableId: table.tableId, kinds: [...kinds].sort(), fieldIds: fields === undefined ? null : fieldIds.sort() };
}

/** A post to the direct message with `userId`, as the reach check reads it. */
function directMessageReach(chat: ChatDirectory | null, userId: string): ReachStep {
  const target = chat?.directMessage(userId);
  return {
    kind: "post",
    group: target && !("problem" in target)
      ? { channelWireId: target.wireId, name: target.name }
      : { channelWireId: null, name: "a direct message" },
  };
}

/**
 * The Collections and chats each step reaches, for the reach check (ADR
 * 0012). A direct message to a person a formula names is checked once the
 * formula has run.
 */
export function reachStepsOf(
  automation: Automation,
  collection: ReachCollection,
  collectionNamed: (path: string) => ReachCollection,
  chat: ChatDirectory | null,
): ReachStep[] {
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  const target = (path: string | null) => (path === null ? collection : collectionNamed(path));
  const reach: ReachStep[] = [];
  if (automation.when.kind === "group-message") {
    const group = chat?.group(automation.when.group);
    reach.push({
      kind: "read-group",
      group: group && !("problem" in group)
        ? { channelWireId: group.wireId, name: group.name }
        : { channelWireId: null, name: automation.when.group },
    });
  }
  for (const { step } of everyStep(steps)) {
    if (step.kind === "set") {
      const bound = step.records === null ? null : bindings.get(step.records);
      reach.push({ kind: "change-records", collection: target(bound ? bound.collection : null) });
    } else if (step.kind === "add-record") {
      reach.push({ kind: "change-records", collection: target(step.collection) });
    } else if (step.kind === "find") {
      reach.push({ kind: "find-records", collection: target(step.collection) });
    } else if (step.kind === "post") {
      const group = chat?.group(step.group);
      reach.push({
        kind: "post",
        group: group && !("problem" in group)
          ? { channelWireId: group.wireId, name: group.name }
          : { channelWireId: null, name: step.group },
      });
    } else if (step.kind === "direct-message") {
      for (const person of step.to) {
        if (!isFormula(person) && typeof person.value === "string") reach.push(directMessageReach(chat, person.value));
      }
    } else if (step.kind === "wake-agent") {
      // A personal step: it acts as its person, so it reaches only what they do alone.
      reach.push({ kind: "personal", person: { userId: step.person, name: chat?.person(step.person) ?? "that person" } });
    } else if (step.kind === "notify") {
      for (const person of step.to) {
        if (isFormula(person) || typeof person.value !== "string") continue;
        reach.push({ kind: "notify", person: { userId: person.value, name: chat?.person(person.value) ?? "that person" } });
      }
    }
  }
  return reach;
}

/**
 * The fields an automation's steps set, with the Collection each is in:
 * null for the automation's own Collection, as a step names it. A step that
 * changes the records a Find or an added record bound sets fields in that
 * step's Collection.
 */
export function fieldWritesOf(automation: Automation): Array<{ collection: string | null; field: string }> {
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  const writes: Array<{ collection: string | null; field: string }> = [];
  for (const { step } of everyStep(steps)) {
    if (step.kind === "set") {
      const collection = step.records === null ? null : (bindings.get(step.records)?.collection ?? null);
      for (const { field } of step.values) writes.push({ collection, field });
    } else if (step.kind === "add-record") {
      for (const { field } of step.values) writes.push({ collection: step.collection, field });
    }
  }
  return writes;
}

/** The Collection each Find reads, with its query, in step order. */
export function findsOf(automation: Automation): Array<{ ordinal: number; collection: string | null; query: FindQuery }> {
  const finds: Array<{ ordinal: number; collection: string | null; query: FindQuery }> = [];
  for (const { ordinal, step } of everyStep(orderSteps(automation.do))) {
    if (step.kind !== "find") continue;
    const query = findQueryOf(step.condition);
    if ("problem" in query) throw new Error(query.problem);
    finds.push({ ordinal, collection: step.collection, query });
  }
  return finds;
}

function jsonValue(value: CollectionValue): JsonValue {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return value;
}

/** A record as formulas and the plan read it. */
export interface RunRecord {
  id: string;
  path: string;
  values: JsonObject;
}

export function runRecordOf(record: CollectionRecord): RunRecord {
  const values: JsonObject = {};
  for (const entry of record.values) values[entry.field] = jsonValue(entry.value);
  return { id: record.id, path: record.path, values };
}

const recordScope = (record: RunRecord): JsonObject => ({ ...record.values, id: record.id });

/**
 * `ms` as ISO 8601 with its UTC offset: on this computer's clock, or in
 * `timeZone` when given.
 */
export function localIsoTime(ms: number, timeZone?: string): string {
  const offset = timeZone === undefined ? -new Date(ms).getTimezoneOffset() : zoneOffsetMinutes(ms, timeZone);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, -1);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${local}${sign}${hours}:${minutes}`;
}

// The zone's UTC offset at `ms`, in whole minutes.
function zoneOffsetMinutes(ms: number, timeZone: string): number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const fields = new Map(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  const field = (type: Intl.DateTimeFormatPartTypes) => fields.get(type) ?? 0;
  const local = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return Math.round((local - Math.floor(ms / 1_000) * 1_000) / 60_000);
}

type Fact = AutomationClaim["change"]["fields"][number];

/** What planning reads from a claim: the Collection it is in, and what changed. */
export interface RunClaim {
  automationId: string;
  claimId: string;
  createdAtMs: number;
  trigger?: AutomationClaim["trigger"];
  collectionPath: string;
  change: {
    kind: AutomationClaim["change"]["kind"];
    fields: ReadonlyArray<Pick<Fact, "field" | "previous" | "next">>;
    fieldsOmitted: number;
  };
}

function factValue(side: Fact["previous"]): { value: JsonValue } | null | "truncated" {
  if (side === null) return null;
  return "truncated" in side ? "truncated" : { value: side.value };
}

/** What the read phase found: the trigger record and each Find's records. */
export interface RunInputs {
  automation: Automation;
  claim: RunClaim;
  /** Null when the trigger record was removed. */
  record: RunRecord | null;
  found: ReadonlyMap<number, readonly RunRecord[]>;
  /** Finds whose page has more matches. Their partial records must not enter the scope. */
  truncatedFinds?: ReadonlySet<number>;
  /** The Group message that started the run, with its whole body; null for a record change. */
  message: JsonObject | null;
  /** Where posts and direct messages go; null when the automation sends none. */
  chat: ChatDirectory | null;
  /** The person who pressed the button, or null for a change. */
  person: AutomationScope["person"];
}

/**
 * Whether the claim's change is the one the trigger names, before any
 * formula runs. A formula `to:`, and a starts-matching condition, are
 * checked after evaluation.
 */
export function triggerMatches(inputs: RunInputs): boolean {
  const { automation, claim, record } = inputs;
  const { change } = claim;
  const trigger = automation.when;
  switch (trigger.kind) {
    case "record-added":
      return change.kind === "added";
    case "record-removed":
      return change.kind === "removed";
    case "record-changed":
      return change.kind === "changed" && (trigger.fields === null || change.fieldsOmitted > 0 ||
        change.fields.some((fact) => trigger.fields!.includes(fact.field)));
    case "starts-matching":
      return change.kind === "added" || change.kind === "changed";
    case "group-message":
      return change.kind === "message";
    case "schedule":
      return change.kind === "schedule" && (scheduleDueAt(claim) !== null || runNowSkippedFrom(claim) !== null);
    case "button":
      return change.kind === "button";
    case "field-changed": {
      if (change.kind !== "changed") return false;
      const fact = change.fields.find((candidate) => candidate.field === trigger.field);
      if (!fact && change.fieldsOmitted === 0) return false;
      if (trigger.to === null || trigger.to.kind === "formula") return true;
      const next = fact ? factValue(fact.next) : "truncated";
      // A value too large for the claim is read from the record instead.
      const value = next === "truncated" ? { value: record?.values[trigger.field] ?? null } : next;
      return isDeepStrictEqual(value?.value ?? null, trigger.to.value);
    }
    default:
      return false;
  }
}

/** Where each formula's answer goes. */
type Slot =
  | { kind: "only-if" }
  | { kind: "find"; ordinal: number }
  | { kind: "to" }
  | { kind: "matched-before" }
  | { kind: "matches" }
  | { kind: "if"; ordinal: number }
  | { kind: "value"; ordinal: number; field: string }
  // One answer per record a Find returned, in order.
  | { kind: "values"; ordinal: number; field: string }
  | { kind: "text"; ordinal: number }
  // A direct message's person that a formula names.
  | { kind: "person"; ordinal: number; index: number };

export interface EvaluationRequest {
  scope: AutomationScope;
  formulas: AutomationFormula[];
  slots: Slot[];
}

function previousValues(claim: RunClaim): JsonObject {
  const previous: JsonObject = {};
  for (const fact of claim.change.fields) {
    const side = factValue(fact.previous);
    if (side !== null && side !== "truncated") previous[fact.field] = side.value;
  }
  return previous;
}

// The trigger record as it was before the change, for starts-matching.
function recordBefore(record: RunRecord, claim: RunClaim): JsonObject {
  const before = recordScope(record);
  for (const fact of claim.change.fields) {
    const side = factValue(fact.previous);
    if (side === "truncated") continue;
    if (side === null) delete before[fact.field];
    else before[fact.field] = side.value;
  }
  return before;
}

/** One evaluator request for every formula in the run. `nowMs` is when the change was claimed, or a schedule's due time. */
export function evaluationRequest(inputs: RunInputs, nowMs: number): EvaluationRequest {
  const { automation, claim, record, found, person } = inputs;
  const formulas: AutomationFormula[] = [];
  const slots: Slot[] = [];
  const findGuards: NonNullable<AutomationFormula["when"]> = [];
  const guarded = (when: NonNullable<AutomationFormula["when"]>) => {
    const guards = [...when, ...findGuards];
    return guards.length ? { when: guards } : {};
  };
  const add = (slot: Slot, source: string, when: NonNullable<AutomationFormula["when"]> = []) => {
    const index = formulas.length;
    slots.push(slot);
    formulas.push({ kind: "expression", source, ...guarded(when) });
    return index;
  };
  const conditions: NonNullable<AutomationFormula["when"]> = [];
  const trigger = automation.when;
  if (trigger.kind === "field-changed" && trigger.to?.kind === "formula") {
    const fact = claim.change.fields.find(candidate => candidate.field === trigger.field);
    const next = fact ? factValue(fact.next) : "truncated";
    const equals = next === "truncated" ? (record?.values[trigger.field] ?? null) : (next?.value ?? null);
    conditions.push({ index: add({ kind: "to" }, trigger.to.expression), equals });
  }
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed") {
    conditions.push({ index: add({ kind: "matched-before" }, `((record) => (${trigger.condition}\n))(${BEFORE_BINDING})`), truthy: false });
    conditions.push({ index: add({ kind: "matches" }, trigger.condition, conditions), truthy: true });
  } else if (trigger.kind === "starts-matching") {
    conditions.push({ index: add({ kind: "matches" }, trigger.condition), truthy: true });
  }
  if (automation.if !== null) conditions.push({ index: add({ kind: "only-if" }, automation.if, conditions), truthy: true });
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  const addSteps = (entries: readonly OrderedStep[], when: NonNullable<AutomationFormula["when"]>) => {
    for (const entry of entries) {
      const { ordinal, step } = entry;
      if (step.kind === "find" && inputs.truncatedFinds?.has(ordinal)) {
        // An inactive Find returns null. Only an active overflow stops later formulas.
        const index = add({ kind: "find", ordinal }, "true", when);
        findGuards.push({ index, truthy: false });
      }
      if ("then" in entry) {
        const index = add({ kind: "if", ordinal }, entry.step.if, when);
        addSteps(entry.then, [...when, { index, truthy: true }]);
        addSteps(entry.otherwise, [...when, { index, truthy: false }]);
        continue;
      }
      if (step.kind === "post" || step.kind === "direct-message" || step.kind === "notify" || step.kind === "wake-agent") {
        slots.push({ kind: "text", ordinal });
        formulas.push({ kind: "text", parts: automationTextParts(step.text) ?? [{ kind: "text", text: step.text }], ...guarded(when) });
        if (step.kind === "direct-message" || step.kind === "notify") {
          step.to.forEach((person, index) => {
            if (isFormula(person)) add({ kind: "person", ordinal, index }, person.expression, when);
          });
        }
      }
      if (step.kind !== "set" && step.kind !== "add-record") continue;
      const records = step.kind === "set" && step.records !== null && bindings.get(step.records)?.kind === "find"
        ? step.records
        : null;
      for (const { field, value } of step.values) {
        if (!isFormula(value)) continue;
        if (records === null) add({ kind: "value", ordinal, field }, value.expression, when);
        else add({ kind: "values", ordinal, field }, `(${records}).map((record) => (${value.expression}\n))`, when);
      }
    }
  };
  addSteps(steps, conditions);
  const bound: JsonObject = {};
  for (const [name, binding] of bindings) {
    if (binding.kind === "find" && inputs.truncatedFinds?.has(binding.ordinal)) continue;
    bound[name] = binding.kind === "find" ? (found.get(binding.ordinal) ?? []).map(recordScope) : null;
  }
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed" && record) {
    bound[BEFORE_BINDING] = recordBefore(record, claim);
  }
  const triggerRecord = record ? recordScope(record) : null;
  const { message } = inputs;
  const author = message && typeof message.authorUserId === "string" && typeof message.authorDisplayName === "string"
    ? { id: message.authorUserId, name: message.authorDisplayName }
    : null;
  const dueAt = scheduleDueAt(claim);
  const skippedFrom = runNowSkippedFrom(claim);
  const scope: AutomationScope = {
    ...(triggerRecord ? { record: triggerRecord } : {}),
    ...(message ? { message } : {}),
    previous: previousValues(claim),
    trigger: trigger.kind === "schedule" && (dueAt !== null || skippedFrom !== null)
      ? {
        kind: "schedule",
        dueAt: localIsoTime(dueAt ?? nowMs, trigger.timezone),
        // Run now from a skipped-run notice: when the skipped runs began.
        ...(skippedFrom !== null ? { skipped: localIsoTime(skippedFrom, trigger.timezone) } : {}),
      }
      : trigger.kind === "button"
        ? { kind: "button", field: trigger.field, pressedAt: localIsoTime(claim.createdAtMs), record: triggerRecord }
        : {
          kind: trigger.kind,
          change: claim.change.kind,
          fields: claim.change.fields.map((fact) => fact.field),
          record: triggerRecord,
        },
    // A press or Group message names the person who started it.
    person: person ?? author,
    bindings: bound,
    now: localIsoTime(nowMs),
  };
  return { scope, formulas, slots };
}

export interface PlannedField {
  field: string;
  before: JsonValue;
  after: JsonValue;
}

/**
 * A record a step changes: one that exists, found again by its id before the
 * write, or the one an earlier step adds.
 */
export type PlannedTarget = { recordId: string; collectionPath: string; path: string } | { addedBy: number };

export type PlannedEffect =
  | { kind: "set"; target: PlannedTarget; fields: PlannedField[] }
  | { kind: "add"; collectionPath: string; recordId: string; name: string; fields: Array<{ field: string; value: JsonValue }> }
  | {
      kind: "message";
      /** Also the idempotency key, so a retry writes the message once. */
      effectId: string;
      messageId: string;
      threadId: string;
      to:
        | { kind: "group"; channelId: string; lane: "posts" | "chat" }
        | { kind: "direct-message"; userId: string; threadId: string };
      /** The Group or direct message, as reach and run history name it. */
      name: string;
      channelWireId: string;
      body: string;
      /** A formula named the person, so their reach is checked once the plan names them. */
      byFormula?: boolean;
    }
  | {
      kind: "wake";
      /** Also the idempotency key, so a retry posts the message once and queues it once. */
      effectId: string;
      messageId: string;
      threadId: string;
      /** The person whose agent it wakes. */
      person: string;
      body: string;
    }
  | {
      kind: "notice";
      notice: AutomationNotice;
      /** The person, as reach and run history name them. */
      name: string;
      /** A formula named the person, so their reach is checked once the plan names them. */
      byFormula?: boolean;
    };

export interface PlannedStep {
  ordinal: number;
  effects: PlannedEffect[];
}

export type RunPlan =
  | { kind: "skip" }
  | { kind: "failed"; error: string; timedOut: boolean }
  | { kind: "plan"; steps: PlannedStep[] };

function slotSubject(slot: Slot): string {
  switch (slot.kind) {
    case "only-if":
      return 'The "Only if" condition';
    case "find":
      return `The Find in step ${slot.ordinal + 1}`;
    case "to":
      return "The value this automation waits for";
    case "matched-before":
    case "matches":
      return "The condition this automation waits for";
    case "if":
      return `The condition in step ${slot.ordinal + 1}`;
    case "text":
      return `The message in step ${slot.ordinal + 1}`;
    case "person":
      return `The person in step ${slot.ordinal + 1}`;
    default:
      return `The formula for "${slot.field}" in step ${slot.ordinal + 1}`;
  }
}

// A notice's title and body, as the relay bounds them.
const NOTICE_TITLE_MAX_CHARS = 120;
const NOTICE_BODY_MAX_CHARS = 500;
// A notice body keeps tabs and line feeds and no other control character.
const NOTICE_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

function noticeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(NOTICE_CONTROL_CHARS, "").trim();
}

/** The people a step names, once each, or why one is not a person. */
function peopleOf(
  to: readonly AutomationValue[],
  ordinal: number,
  answers: ReadonlyMap<string, JsonValue>,
): Map<string, boolean> | string {
  // Each person, and whether only a formula named them.
  const people = new Map<string, boolean>();
  for (const [index, person] of to.entries()) {
    const value = isFormula(person) ? (answers.get(`person:${ordinal}:${index}`) ?? null) : person.value;
    for (const userId of Array.isArray(value) ? value : [value]) {
      if (typeof userId !== "string" || userId.length === 0) {
        return `Step ${ordinal + 1} names a person that is not a person's id.`;
      }
      people.set(userId, (people.get(userId) ?? true) && isFormula(person));
    }
  }
  return people;
}

// A chat message's largest body, as the engine bounds it.
const MAX_MESSAGE_BODY_BYTES = 64 * 1024;

/** A message's evaluated text as the body it posts, or why it cannot be one. */
function messageBody(value: JsonValue): string | { problem: string } {
  if (typeof value !== "string") return { problem: "is not text." };
  const body = value.replace(/\r\n?/g, "\n").trimEnd();
  if (body.trim().length === 0) return { problem: "is empty." };
  if (Buffer.byteLength(body) > MAX_MESSAGE_BODY_BYTES) return { problem: "is longer than 64 KiB." };
  return body;
}

/** The people the run's formulas named for direct messages, so only their conversations are read. */
export function formulaPeople(request: EvaluationRequest, results: readonly AutomationOutcome<JsonValue>[]): string[] {
  const people = new Set<string>();
  request.slots.forEach((slot, index) => {
    const result = results[index];
    if (slot.kind !== "person" || !result?.ok) return;
    for (const value of Array.isArray(result.value) ? result.value : [result.value]) {
      if (typeof value === "string" && value.length > 0) people.add(value);
    }
  });
  return [...people];
}

export const AGENT_WAKES_AGENT =
  "Only a person's change can wake an agent for now. An agent or another automation made this change, so this automation did not wake an agent. That keeps agents and automations from starting each other forever.";

/**
 * Whether a person started this claim: a change that declared no actor, as a
 * person's write does, or one a person made. An agent's writes do not carry
 * their chain depth yet, so an agent's change, or an automation's change
 * that an agent's started, could wake the agent again without end.
 */
function startedByPerson(claim: RunClaim): boolean {
  return "actorKind" in claim.change && (claim.change.actorKind === null || claim.change.actorKind === "human");
}

/** The seed of every id and idempotency key a step's effects use. */
export function stepKey(claimId: string, hash: string, ordinal: number): string {
  return `${claimId}/${hash}/${ordinal}`;
}

/**
 * Turns the evaluator's answers into the run's plan: which branch each If
 * takes and the fields each step writes. A formula that failed fails the
 * run, and a condition that does not hold skips it.
 */
export function planRun(
  inputs: RunInputs,
  request: EvaluationRequest,
  results: readonly AutomationOutcome<JsonValue>[],
  key: { claimId: string; hash: string },
): RunPlan {
  const answers = new Map<string, JsonValue>();
  const slotKey = (slot: Slot) => {
    switch (slot.kind) {
      case "value":
      case "values":
        return `${slot.kind}:${slot.ordinal}:${slot.field}`;
      case "if":
      case "find":
      case "text":
        return `${slot.kind}:${slot.ordinal}`;
      case "person":
        return `person:${slot.ordinal}:${slot.index}`;
      default:
        return slot.kind;
    }
  };
  for (const [index, slot] of request.slots.entries()) {
    const result = results[index];
    if (!result) return { kind: "failed", error: "The evaluator did not answer every formula.", timedOut: false };
    if (!result.ok) {
      return {
        kind: "failed",
        error: `${slotSubject(slot)} failed. ${result.error.message}`,
        timedOut: result.error.code === "timeout",
      };
    }
    if (slot.kind === "find" && result.value) {
      return { kind: "failed", error: `A Find matched more than ${MAX_FOUND_RECORDS} records. Narrow its condition, then try again.`, timedOut: false };
    }
    answers.set(slotKey(slot), result.value);
  }
  const { automation, claim, record, found, chat } = inputs;
  const trigger = automation.when;
  if (trigger.kind === "field-changed" && trigger.to?.kind === "formula") {
    const fact = claim.change.fields.find((candidate) => candidate.field === trigger.field);
    const next = fact ? factValue(fact.next) : "truncated";
    const value = next === "truncated" ? (record?.values[trigger.field] ?? null) : (next?.value ?? null);
    if (!isDeepStrictEqual(value, answers.get("to") ?? null)) return { kind: "skip" };
  }
  if (trigger.kind === "starts-matching" && (!answers.get("matches") || answers.get("matched-before"))) {
    return { kind: "skip" };
  }
  if (automation.if !== null && !answers.get("only-if")) return { kind: "skip" };

  const planned: PlannedStep[] = [];
  const bindings = bindingsOf(orderSteps(automation.do));
  const valueOf = (ordinal: number, field: string, value: AutomationValue): JsonValue =>
    isFormula(value) ? (answers.get(`value:${ordinal}:${field}`) ?? null) : value.value;
  // Each field's value once the effects planned so far have landed, by
  // record id, so a later step on the same field expects what the earlier
  // one wrote. A record the run adds starts with no fields.
  const landed = new Map<string, Map<string, JsonValue>>();
  const addedIds = new Map<number, string>();
  let writes = 0;
  // Records key on their path and id together: dataset records of two tables can share an id.
  const keyOf = (target: RunRecord) => `${target.path}\u0000${target.id}`;
  const fieldsFor = (
    recordId: string,
    initial: JsonObject,
    values: ReadonlyArray<{ field: string; after: JsonValue }>,
  ): PlannedField[] => {
    const current = landed.get(recordId) ?? new Map<string, JsonValue>();
    landed.set(recordId, current);
    writes += values.length;
    return values.map(({ field, after }) => {
      const before = current.has(field) ? current.get(field)! : (initial[field] ?? null);
      current.set(field, after);
      return { field, before, after };
    });
  };
  const walk = (steps: readonly OrderedStep[]): string | null => {
    for (const entry of steps) {
      const { ordinal, step } = entry;
      if ("then" in entry) {
        const problem = walk(answers.get(`if:${ordinal}`) ? entry.then : entry.otherwise);
        if (problem !== null) return problem;
        continue;
      }
      if (step.kind === "wake-agent") {
        // Only a person's change wakes an agent until agents' writes carry
        // their chain depth (see startedByPerson).
        if (!startedByPerson(claim)) return AGENT_WAKES_AGENT;
        const body = messageBody(answers.get(`text:${ordinal}`) ?? null);
        if (typeof body !== "string") return `The message in step ${ordinal + 1} ${body.problem}`;
        const effectId = `${stepKey(key.claimId, key.hash, ordinal)}/wake`;
        planned.push({ ordinal, effects: [{
          kind: "wake",
          effectId,
          messageId: automationMessageId(effectId),
          threadId: automationWakeThreadId(claim.automationId),
          person: step.person,
          body,
        }] });
        continue;
      }
      if (step.kind === "notify") {
        const text = answers.get(`text:${ordinal}`) ?? null;
        if (typeof text !== "string") return `The message in step ${ordinal + 1} is not text.`;
        if (chat === null) return "dohc could not read who this workspace is shared with.";
        const people = peopleOf(step.to, ordinal, answers);
        if (typeof people === "string") return people;
        const seed = stepKey(key.claimId, key.hash, ordinal);
        const effects: PlannedEffect[] = [];
        for (const [userId, byFormula] of people) {
          const recipient = chat.noticeRecipient(userId);
          if ("problem" in recipient) return recipient.problem;
          effects.push({
            kind: "notice",
            name: recipient.name,
            ...(byFormula ? { byFormula } : {}),
            notice: {
              noticeId: automationNoticeId(seed, userId),
              kind: "automation-notify",
              title: cutText(automation.name.trim(), NOTICE_TITLE_MAX_CHARS),
              body: cutText(noticeText(text), NOTICE_BODY_MAX_CHARS),
              target: {
                // A notice for someone else names a path both can read.
                path: record?.path ?? claim.collectionPath,
                ...(record ? { record: record.id } : {}),
                automation: claim.automationId,
                run: claim.claimId,
              },
              recipientUserId: userId,
            },
          });
        }
        planned.push({ ordinal, effects });
        continue;
      }
      if (step.kind === "post" || step.kind === "direct-message") {
        const body = messageBody(answers.get(`text:${ordinal}`) ?? null);
        if (typeof body !== "string") return `The message in step ${ordinal + 1} ${body.problem}`;
        if (chat === null) return "dohc could not read this workspace's chats.";
        const seed = stepKey(key.claimId, key.hash, ordinal);
        const effects: PlannedEffect[] = [];
        if (step.kind === "post") {
          const group = chat.group(step.group);
          if ("problem" in group) return group.problem;
          const effectId = `${seed}/post`;
          effects.push({
            kind: "message",
            effectId,
            messageId: automationMessageId(effectId),
            threadId: automationThreadId(effectId),
            to: { kind: "group", channelId: group.channelId, lane: group.lane },
            name: group.name,
            channelWireId: group.wireId,
            body,
          });
        } else {
          const people = peopleOf(step.to, ordinal, answers);
          if (typeof people === "string") return people;
          for (const [userId, byFormula] of people) {
            const target = chat.directMessage(userId);
            if ("problem" in target) return target.problem;
            const effectId = `${seed}/dm/${userId}`;
            effects.push({
              kind: "message",
              effectId,
              messageId: automationMessageId(effectId),
              threadId: target.threadId,
              to: { kind: "direct-message", userId, threadId: target.threadId },
              name: target.name,
              channelWireId: target.wireId,
              body,
              ...(byFormula ? { byFormula } : {}),
            });
          }
        }
        planned.push({ ordinal, effects });
        continue;
      }
      if (step.kind === "add-record") {
        const recordId = derivedRecordId(stepKey(key.claimId, key.hash, ordinal));
        addedIds.set(ordinal, recordId);
        const values = step.values.map(({ field, value }) => ({ field, after: valueOf(ordinal, field, value) }));
        fieldsFor(recordId, {}, values);
        planned.push({
          ordinal,
          effects: [{
            kind: "add",
            collectionPath: step.collection ?? claim.collectionPath,
            recordId,
            // Each run's record gets its own name, the same on every attempt.
            name: `${automation.id}-${recordId.slice(4, 12)}`,
            fields: values.map(({ field, after }) => ({ field, value: after })),
          }],
        });
      } else if (step.kind === "set") {
        const bound = step.records === null ? null : bindings.get(step.records) ?? null;
        if (bound?.kind === "find") {
          const records = found.get(bound.ordinal) ?? [];
          const lists = new Map<string, JsonValue[]>();
          for (const { field, value } of step.values) {
            if (!isFormula(value)) continue;
            const list = answers.get(`values:${ordinal}:${field}`);
            if (!Array.isArray(list) || list.length !== records.length) {
              return `The formula for "${field}" in step ${ordinal + 1} did not give one value for each record.`;
            }
            lists.set(field, list);
          }
          const collectionPath = bound.collection ?? claim.collectionPath;
          planned.push({
            ordinal,
            effects: records.map((target, index) => ({
              kind: "set",
              target: { recordId: target.id, collectionPath, path: target.path },
              fields: fieldsFor(keyOf(target), target.values, step.values.map(({ field, value }) => ({
                field,
                after: isFormula(value) ? (lists.get(field)![index] ?? null) : value.value,
              }))),
            })),
          });
        } else if (bound?.kind === "add") {
          const recordId = addedIds.get(bound.ordinal);
          if (recordId === undefined) return `Step ${ordinal + 1} changes a record that no earlier step added.`;
          planned.push({
            ordinal,
            effects: [{
              kind: "set",
              target: { addedBy: bound.ordinal },
              fields: fieldsFor(recordId, {}, step.values.map(({ field, value }) => ({ field, after: valueOf(ordinal, field, value) }))),
            }],
          });
        } else {
          if (record === null) return "The record was removed, so the automation has no record to change.";
          planned.push({
            ordinal,
            effects: [{
              kind: "set",
              target: { recordId: record.id, collectionPath: claim.collectionPath, path: record.path },
              fields: fieldsFor(keyOf(record), record.values, step.values.map(({ field, value }) => ({ field, after: valueOf(ordinal, field, value) }))),
            }],
          });
        }
      }
      if (writes > MAX_RUN_FIELD_WRITES) {
        return `This run would change more than ${MAX_RUN_FIELD_WRITES} fields. Narrow its Find steps, or split it into smaller automations.`;
      }
    }
    return null;
  };
  const problem = walk(orderSteps(automation.do));
  return problem === null ? { kind: "plan", steps: planned } : { kind: "failed", error: problem, timedOut: false };
}
