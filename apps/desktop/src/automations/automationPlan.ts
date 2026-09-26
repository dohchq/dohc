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
import type { Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord, CollectionValue } from "@dohc/workspace-contracts/collection";
import type { AutomationChangeKind, AutomationClaim } from "@dohc/workspace-engine-client";
import { derivedRecordId } from "../workspaces/collectionRecordEdits";
import type { ReachCollection, ReachStep } from "./automationReach";

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
  return createHash("sha256")
    .update(JSON.stringify([automation.when, automation.if, automation.do]))
    .digest("hex")
    .slice(0, 16);
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

const RECORD_TRIGGERS = new Set<AutomationTrigger["kind"]>([
  "record-added", "record-changed", "field-changed", "record-removed", "starts-matching",
]);

/**
 * Why this executor cannot run an automation yet, or null when it can. The
 * executor subscribes only automations it can run; the ⚡ panel shows the
 * reason for the rest.
 */
export function unsupportedReason(automation: Automation): string | null {
  if (!RECORD_TRIGGERS.has(automation.when.kind)) {
    return "dohc can run automations that start from a record change. Other triggers come later.";
  }
  const DATASET = "dohc cannot run automations on dataset tables and operations yet.";
  if ("table" in automation.when && automation.when.table !== null) return DATASET;
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  let finds = 0;
  let formulas = (automation.if === null ? 0 : 1) +
    (automation.when.kind === "field-changed" && automation.when.to?.kind === "formula" ? 1 : 0) +
    (automation.when.kind === "starts-matching" ? 2 : 0);
  for (const { step } of everyStep(steps)) {
    switch (step.kind) {
      case "notify":
      case "post":
      case "direct-message":
      case "wake-agent":
        return "dohc cannot send messages from automations yet.";
      case "run":
      case "run-file":
        return "dohc cannot run code steps yet.";
      case "find": {
        if (step.operation !== null) return DATASET;
        finds += 1;
        const query = findQueryOf(step.condition);
        if ("problem" in query) return query.problem;
        break;
      }
      case "if":
        formulas += 1;
        break;
      case "set":
      case "add-record":
        if (step.operation !== null) return DATASET;
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

/** The engine subscription an automation's trigger needs. */
export function subscriptionFor(trigger: AutomationTrigger): { kinds: AutomationChangeKind[]; fields?: string[] } {
  switch (trigger.kind) {
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

/** The Collections each step reaches, for the reach check (ADR 0012). */
export function reachStepsOf(
  automation: Automation,
  collection: ReachCollection,
  collectionNamed: (path: string) => ReachCollection,
): ReachStep[] {
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  const target = (path: string | null) => (path === null ? collection : collectionNamed(path));
  const reach: ReachStep[] = [];
  for (const { step } of everyStep(steps)) {
    if (step.kind === "set") {
      const bound = step.records === null ? null : bindings.get(step.records);
      reach.push({ kind: "change-records", collection: target(bound ? bound.collection : null) });
    } else if (step.kind === "add-record") {
      reach.push({ kind: "change-records", collection: target(step.collection) });
    } else if (step.kind === "find") {
      reach.push({ kind: "find-records", collection: target(step.collection) });
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

/** `ms` as ISO 8601 on this computer's clock, with its UTC offset. */
export function localIsoTime(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, -1);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${local}${sign}${hours}:${minutes}`;
}

type Fact = AutomationClaim["change"]["fields"][number];

function factValue(side: Fact["previous"]): { value: JsonValue } | null | "truncated" {
  if (side === null) return null;
  return "truncated" in side ? "truncated" : { value: side.value };
}

/** What the read phase found: the trigger record and each Find's records. */
export interface RunInputs {
  automation: Automation;
  claim: AutomationClaim;
  /** Null when the trigger record was removed. */
  record: RunRecord | null;
  found: ReadonlyMap<number, readonly RunRecord[]>;
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
  | { kind: "to" }
  | { kind: "matched-before" }
  | { kind: "matches" }
  | { kind: "if"; ordinal: number }
  | { kind: "value"; ordinal: number; field: string }
  // One answer per record a Find returned, in order.
  | { kind: "values"; ordinal: number; field: string };

export interface EvaluationRequest {
  scope: AutomationScope;
  formulas: AutomationFormula[];
  slots: Slot[];
}

function previousValues(claim: AutomationClaim): JsonObject {
  const previous: JsonObject = {};
  for (const fact of claim.change.fields) {
    const side = factValue(fact.previous);
    if (side !== null && side !== "truncated") previous[fact.field] = side.value;
  }
  return previous;
}

// The trigger record as it was before the change, for starts-matching.
function recordBefore(record: RunRecord, claim: AutomationClaim): JsonObject {
  const before = recordScope(record);
  for (const fact of claim.change.fields) {
    const side = factValue(fact.previous);
    if (side === "truncated") continue;
    if (side === null) delete before[fact.field];
    else before[fact.field] = side.value;
  }
  return before;
}

/** One evaluator request for every formula in the run. `nowMs` is when the change was claimed. */
export function evaluationRequest(inputs: RunInputs, nowMs: number): EvaluationRequest {
  const { automation, claim, record, found } = inputs;
  const formulas: AutomationFormula[] = [];
  const slots: Slot[] = [];
  const add = (slot: Slot, source: string, when: NonNullable<AutomationFormula["when"]> = []) => {
    const index = formulas.length;
    slots.push(slot);
    formulas.push({ kind: "expression", source, ...(when.length ? { when } : {}) });
    return index;
  };
  const conditions: NonNullable<AutomationFormula["when"]> = [];
  if (automation.if !== null) conditions.push({ index: add({ kind: "only-if" }, automation.if), truthy: true });
  const trigger = automation.when;
  if (trigger.kind === "field-changed" && trigger.to?.kind === "formula") add({ kind: "to" }, trigger.to.expression);
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed") {
    add({ kind: "matched-before" }, `((record) => (${trigger.condition}\n))(${BEFORE_BINDING})`);
    add({ kind: "matches" }, trigger.condition);
  } else if (trigger.kind === "starts-matching") {
    add({ kind: "matches" }, trigger.condition);
  }
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  const addSteps = (entries: readonly OrderedStep[], when: NonNullable<AutomationFormula["when"]>) => {
    for (const entry of entries) {
      const { ordinal, step } = entry;
      if ("then" in entry) {
        const index = add({ kind: "if", ordinal }, entry.step.if, when);
        addSteps(entry.then, [...when, { index, truthy: true }]);
        addSteps(entry.otherwise, [...when, { index, truthy: false }]);
        continue;
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
    bound[name] = binding.kind === "find" ? (found.get(binding.ordinal) ?? []).map(recordScope) : null;
  }
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed" && record) {
    bound[BEFORE_BINDING] = recordBefore(record, claim);
  }
  const triggerRecord = record ? recordScope(record) : null;
  const scope: AutomationScope = {
    ...(triggerRecord ? { record: triggerRecord } : {}),
    previous: previousValues(claim),
    trigger: {
      kind: trigger.kind,
      change: claim.change.kind,
      fields: claim.change.fields.map((fact) => fact.field),
      record: triggerRecord,
    },
    // Claims do not yet name the person who made the change.
    person: null,
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
  | { kind: "add"; collectionPath: string; recordId: string; name: string; fields: Array<{ field: string; value: JsonValue }> };

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
    case "to":
      return "The value this automation waits for";
    case "matched-before":
    case "matches":
      return "The condition this automation waits for";
    case "if":
      return `The condition in step ${slot.ordinal + 1}`;
    default:
      return `The formula for "${slot.field}" in step ${slot.ordinal + 1}`;
  }
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
  const slotKey = (slot: Slot) =>
    slot.kind === "value" || slot.kind === "values"
      ? `${slot.kind}:${slot.ordinal}:${slot.field}`
      : slot.kind === "if" ? `if:${slot.ordinal}` : slot.kind;
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
    answers.set(slotKey(slot), result.value);
  }
  const { automation, claim, record, found } = inputs;
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
              fields: fieldsFor(target.id, target.values, step.values.map(({ field, value }) => ({
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
              fields: fieldsFor(record.id, record.values, step.values.map(({ field, value }) => ({ field, after: valueOf(ordinal, field, value) }))),
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
