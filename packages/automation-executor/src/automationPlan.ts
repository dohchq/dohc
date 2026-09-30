import { MAX_FINDS, MAX_FOUND_RECORDS, MAX_RUN_FIELD_WRITES } from "./automationLimits";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, parseExpressionAt, tokenizer, tokTypes, type Expression } from "acorn";
import {
  AUTOMATION_LIMITS,
  type AutomationFormula,
  type AutomationOutcome,
  type AutomationScope,
  type AutomationTimeSpent,
  type CodeStepReturn,
  type JsonObject,
  type JsonValue,
} from "@dohc/app-backend-runtime/automation";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import {
  automationTextParts,
  automationTextProblem,
  type Automation,
  type AutomationDiagnosticCode,
  type AutomationScheduleTrigger,
} from "@dohc/workspace-contracts/automations";
import { RECORD_ID_FRONTMATTER_KEY, type CollectionRecord, type CollectionValue } from "@dohc/workspace-contracts/collection";
import type { AutomationChangeKind, AutomationClaim } from "@dohc/workspace-engine-client";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { derivedRecordId } from "./recordIds";
import type { ReachCollection, ReachStep } from "./automationReach";
import {
  automationMessageId,
  automationNoticeId,
  automationThreadId,
  automationWakeThreadId,
  cutText,
  GROUP_READ_ONLY,
  type AutomationNotice,
  type ChatDirectory,
} from "./automationChat";

// What each step of a Collection automation run does, worked out when the
// step starts. The executor checks the trigger and its conditions once, then
// runs the steps in order. Each step reads what it needs as it is now, after
// the steps before it landed, asks the evaluator for its formulas or its code,
// and turns the answers into its effects. The step is saved before its first
// effect, so a run that stops part way resumes with the same values instead of
// evaluating the step again.
//
// In every formula, `record` is the record a step is about: the trigger
// record, each record a Find checks, or each record a step changes among the
// records a Find returned. `trigger.record` is always the trigger record, with
// its values as the step read them. A Find's result keeps the records it
// found; a later step reads their values again, and a later Find queries
// again. A record an Add record step added reads with the values it has. A
// step reads only the results of steps that ran before it.
//
// The record changes a code step returns become the same effects as Set
// fields and Add record steps, and its step is saved with them: a run that
// resumes never runs that code again.

type AutomationTrigger = Automation["when"];
type AutomationStep = Automation["do"][number];
type IfStep = Extract<AutomationStep, { kind: "if" }>;
type AutomationValue = Extract<AutomationStep, { kind: "set" }>["values"][number]["value"];

/** The claim prefix this executor drains. */
export const COLLECTION_AUTOMATION_PREFIX = "collection:";
export const findOverflowError = (ordinal: number) =>
  `The Find in step ${ordinal + 1} matched more than ${MAX_FOUND_RECORDS} records. Narrow its condition, then try again.`;
// Keep the existing code-step output bound independent of Find paging.
export const MAX_CODE_RECORD_CHANGES = 50;
// The trigger record before its change, which a starts-matching condition
// is also checked against.
const BEFORE_BINDING = "__dohc_before";

/**
 * A Collection automation's engine id: its Collection's id, which a move
 * keeps, and its own id in automations.yaml. A document Collection's id is
 * the object id of its collection.yaml; a dataset Collection's is its
 * dataset id.
 */
export function collectionAutomationId(collectionId: string, id: string): string {
  return `${COLLECTION_AUTOMATION_PREFIX}${collectionId}#${id}`;
}

/** The Collection id and automation id an engine automation id names, or null. */
export function parseCollectionAutomationId(
  engineId: string,
): { collectionId: string; id: string } | null {
  if (!engineId.startsWith(COLLECTION_AUTOMATION_PREFIX)) return null;
  const rest = engineId.slice(COLLECTION_AUTOMATION_PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash <= 0 || hash === rest.length - 1) return null;
  const collectionId = rest.slice(0, hash);
  return /^[A-Za-z0-9_-]+$/u.test(collectionId) ? { collectionId, id: rest.slice(hash + 1) } : null;
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
export type OrderedStep =
  | { ordinal: number; step: Exclude<AutomationStep, IfStep> }
  | { ordinal: number; step: IfStep; then: OrderedStep[]; otherwise: OrderedStep[] };

export function orderSteps(steps: readonly AutomationStep[], counter = { next: 0 }): OrderedStep[] {
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

/**
 * What a binding holds: the records a Find returned, the record an
 * add-record step adds, or the value a code step returned.
 */
export type Binding = { kind: "find" | "add" | "code"; ordinal: number; collection: string | null };

function bindingsOf(steps: readonly OrderedStep[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const { ordinal, step } of everyStep(steps)) {
    if (step.kind === "find") bindings.set(step.as, { kind: "find", ordinal, collection: step.collection });
    if (step.kind === "add-record" && step.as !== null) {
      bindings.set(step.as, { kind: "add", ordinal, collection: step.collection });
    }
    if ((step.kind === "run" || step.kind === "run-file") && step.as !== null) {
      bindings.set(step.as, { kind: "code", ordinal, collection: null });
    }
  }
  return bindings;
}

/** The places of an automation's code steps among all its steps. */
export function codeStepOrdinals(automation: Automation): Set<number> {
  return new Set(stepsInOrder(automation).flatMap(({ ordinal, step }) => step.kind === "run" || step.kind === "run-file" ? [ordinal] : []));
}

/** Workspace paths of the code files an automation's steps run, once each. */
export function codeFilesOf(automation: Automation, collectionPath: string): string[] {
  return [...new Set(stepsInOrder(automation).flatMap(({ step }) => step.kind === "run-file" ? [`${collectionPath}/${step.file}`] : []))];
}

function isFormula(value: AutomationValue): value is Extract<AutomationValue, { kind: "formula" }> {
  return value.kind === "formula";
}

/**
 * Why `source` is not exactly one JavaScript expression, or null when it
 * is. It only parses, so a formula that would loop costs nothing here.
 */
function expressionProblem(source: string): string | null {
  try {
    const { end } = parseExpressionAt(source, 0, { ecmaVersion: "latest", preserveParens: true });
    const next = tokenizer(source.slice(end), { ecmaVersion: "latest" }).getToken();
    return next.type === tokTypes.eof ? null : `Unexpected text at character ${end + next.start + 1}.`;
  } catch (error) {
    return error instanceof SyntaxError ? error.message.replace(/\s*\(\d+:\d+\)$/u, ".") : "This is not a formula.";
  }
}

/** A JSON Pointer segment, as the file contract writes one. */
const pointerKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * A syntax error at its JSON Pointer from the automation: a formula's, in
 * the parser's words, or a message's, as the file contract's code.
 */
export type FormulaProblem = { path: string; problem: string } | { path: string; code: AutomationDiagnosticCode };

/**
 * The syntax error of every formula, condition, and message in an
 * automation, at its JSON Pointer from the automation, such as
 * "/do/1/do/0/set/Status": the path the file contract gives a problem
 * there. An empty one is left to the builder, which asks for it.
 */
export function formulaProblems(automation: Automation): FormulaProblem[] {
  const problems: FormulaProblem[] = [];
  const add = (path: string, expression: string) => {
    const problem = expression.trim() === "" ? null : expressionProblem(expression);
    if (problem !== null) problems.push({ path, problem });
  };
  const values = (path: string, entries: ReadonlyArray<{ key: string; value: AutomationValue }>) => {
    for (const { key, value } of entries) if (isFormula(value)) add(`${path}/${pointerKey(key)}`, value.expression);
  };
  const steps = (path: string, list: readonly AutomationStep[]) => list.forEach((step, index) => {
    const at = `${path}/${index}`;
    switch (step.kind) {
      case "set":
      case "add-record":
        values(`${at}/${step.kind}`, step.values.map(({ field, value }) => ({ key: field, value })));
        break;
      case "invoke":
        values(`${at}/input`, step.input);
        break;
      case "find":
        add(`${at}/find`, step.condition);
        break;
      case "if":
        add(`${at}/if`, step.if);
        steps(`${at}/do`, step.do);
        steps(`${at}/otherwise`, step.otherwise);
        break;
      case "run": {
        const problem = step.code.trim() === "" ? null : codeProblem(step.code);
        if (problem !== null) problems.push({ path: `${at}/run`, problem });
        break;
      }
      case "run-file":
        break;
      default: {
        // Every other step sends a message, whose {expressions} must parse.
        const code = step.text.trim() === "" ? null : automationTextProblem(step.text);
        if (code !== null) problems.push({ path: `${at}/${step.kind}`, code });
        if (step.kind === "notify" || step.kind === "direct-message") {
          values(`${at}/to`, step.to.map((value, key) => ({ key: String(key), value })));
        }
      }
    }
  });
  const when = automation.when;
  if (when.kind === "field-changed" && when.to !== null && isFormula(when.to)) add("/when/to", when.to.expression);
  if (when.kind === "starts-matching") add("/when/starts-matching", when.condition);
  if (automation.if !== null) add("/if", automation.if);
  steps("/do", automation.do);
  return problems;
}

/**
 * Why a code step's source does not parse as the function the guest builds
 * from it, a strict body with the parameter ctx, or null when it does. It
 * only parses; the code never runs.
 */
function codeProblem(source: string): string | null {
  try {
    // The guest's body starts with "use strict" on its own line, so a line here is one less.
    const wrapped = `(function (ctx) {"use strict";\n${source}\n})`;
    const [statement, ...more] = parse(wrapped, { ecmaVersion: "latest", sourceType: "script" }).body;
    // The one function must hold the whole source, so the source cannot close it early and add more.
    const whole = more.length === 0 && statement?.type === "ExpressionStatement" &&
      statement.expression.type === "FunctionExpression" && statement.expression.end === wrapped.length - 1;
    return whole ? null : "The code ends the step's function early. Remove the extra closing brace.";
  } catch (error) {
    if (!(error instanceof SyntaxError)) return "This is not code dohc can read.";
    // An error past the source's end, such as a block it never closes, is on its last line.
    const line = "loc" in error && typeof error.loc === "object" && error.loc !== null && "line" in error.loc && typeof error.loc.line === "number"
      ? Math.min(error.loc.line - 1, source.split(/\r\n?|\n|\u2028|\u2029/u).length) : null;
    const message = error.message.replace(/\s*\(\d+:\d+\)$/u, "");
    return line === null || line < 1 ? `${message}.` : `${message} on line ${line}.`;
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

/**
 * What a Find compares a field with: a literal, a field of the trigger
 * record, or a formula that does not read the record the Find checks, such
 * as `message.body.slice(6)`. A formula runs once, before the Find reads.
 */
export type FindValue =
  | { kind: "literal"; value: JsonValue }
  | { kind: "trigger-field"; field: string }
  | { kind: "formula"; expression: string };

/** A Find condition as the one filter `collections.query` takes. */
type FindQuery =
  | { match: "all" }
  | { match: "field"; field: string; operator: "equals" | "contains"; value: FindValue };

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

type AnyNode = { type: string; computed?: boolean; name?: unknown };
const isNode = (value: unknown): value is AnyNode & Record<string, unknown> =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The names an expression reads as variables, not as property names. */
function namesRead(node: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) namesRead(item, names);
  } else if (isNode(node)) {
    if (node.type === "Identifier" && typeof node.name === "string") names.add(node.name);
    for (const [key, child] of Object.entries(node)) {
      const propertyName = !node.computed && ((node.type === "MemberExpression" && key === "property") || (node.type === "Property" && key === "key"));
      if (!propertyName) namesRead(child, names);
    }
  }
  return names;
}

/** The text a string literal or a template with no substitutions spells, or null. */
function constantText(node: AnyNode & Record<string, unknown>): string | null {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  const [quasi] = Array.isArray(node.quasis) ? node.quasis : [];
  const cooked = isNode(quasi) && typeof quasi.value === "object" && quasi.value !== null && "cooked" in quasi.value ? quasi.value.cooked : null;
  return node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0 && typeof cooked === "string" ? cooked : null;
}

/**
 * Whether a formula reads the trigger record, as `trigger.record` or
 * `trigger["record"]`. It reads the spelling, so a formula that reaches the
 * record another way, or that is not a formula at all, fails when it runs
 * instead.
 */
function readsTriggerRecord(expression: string): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!isNode(node)) return false;
    const { object, property } = node;
    if (node.type === "MemberExpression" && isNode(object) && object.type === "Identifier" && object.name === "trigger" && isNode(property) &&
      (node.computed ? constantText(property) === "record" : property.type === "Identifier" && property.name === "record")) {
      return true;
    }
    return Object.values(node).some(visit);
  };
  if (!isOneExpression(expression)) return false;
  return visit(parseExpressionAt(expression, 0, { ecmaVersion: "latest" }));
}

function findValue(node: Expression, condition: string): FindValue | null {
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
  if (field !== null) return { kind: "trigger-field", field };
  // Anything else that does not read the record the Find checks is a
  // formula, such as a number the message names.
  return namesRead(node).has("record") ? null : { kind: "formula", expression: condition.slice(node.start, node.end) };
}

/**
 * Reads a Find condition as a query: `true`, `record.F == value`, or
 * `contains(record.F, value)`, where the value is a literal, a field of the
 * trigger record (`trigger.record.F`), or a formula that does not read
 * `record`. Anything else is a problem the person has to fix, because
 * `collections.query` takes one filter.
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
      const value = field === null ? null : findValue(other, condition);
      if (field !== null && value !== null) return { match: "field", field, operator: "equals", value };
    }
  }
  if (node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" &&
    node.callee.name === "contains" && node.arguments.length === 2) {
    const [target, search] = node.arguments;
    const field = target && target.type !== "SpreadElement" ? candidateField(target) : null;
    const value = field !== null && search && search.type !== "SpreadElement" ? findValue(search, condition) : null;
    if (field !== null && value !== null) return { match: "field", field, operator: "contains", value };
  }
  return { problem: FIND_SHAPE };
}

/** A Find condition on a dataset as a read's equality filters: every field it checks, with its value. */
export type DatasetFindFilter = { field: string; value: FindValue };

const DATASET_FIND_SHAPE =
  'This Collection needs a Find that checks fields with ==. Use a condition such as record.Status == "Doing" && record.Paid == false.';

/**
 * Reads a Find condition on a dataset: `true`, or `record.F == value` terms
 * joined by &&, where each value is a literal, a trigger record field, or a
 * formula that does not read `record`. A dataset's read compares whole
 * values, so it offers no "contains".
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
      const value = field === null ? null : findValue(other, condition);
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

/** The dataset operations an automation's steps invoke, by name, once each. */
export function operationsOf(automation: Automation): string[] {
  const names = new Set<string>();
  for (const { step } of everyStep(orderSteps(automation.do))) {
    if ((step.kind === "set" || step.kind === "add-record" || step.kind === "find") && step.operation !== null) names.add(step.operation);
    if (step.kind === "invoke") names.add(step.operation);
  }
  return [...names];
}

/**
 * Why this executor cannot run an automation yet, or null when it can. The
 * executor subscribes only automations it can run; the ⚡ panel shows the
 * reason for the rest.
 */
export function unsupportedReason(automation: Automation): string | null {
  const DATASET = "This document Collection's automations cannot name a table or a Collection action. Remove those names from the automation.";
  if ("table" in automation.when && automation.when.table !== null) return DATASET;
  for (const { step } of stepsInOrder(automation)) {
    if ((step.kind === "set" || step.kind === "add-record" || step.kind === "find") && step.operation !== null) return DATASET;
    if (step.kind === "invoke") return DATASET;
  }
  return shapeProblem(automation, (condition) => {
    const query = findQueryOf(condition);
    if ("problem" in query) return query;
    return query.match === "all" ? [] : [query.value];
  });
}

/**
 * Why a Find cannot compare with the trigger record: a schedule or a Group
 * message starts the automation, and neither has one. Null for a trigger
 * that has a record.
 */
function noTriggerRecord(trigger: AutomationTrigger): string | null {
  const starter = trigger.kind === "schedule" ? "A schedule" : trigger.kind === "group-message" ? "A Group message" : null;
  return starter === null
    ? null
    : `${starter} starts this automation, so a Find cannot compare with trigger.record. Compare with a value instead.`;
}

/**
 * Why no executor can run an automation of this shape yet, whatever its
 * Collection keeps: its trigger, its steps, and its limits. `findValues`
 * reads a Find condition the way the Collection's records can be queried,
 * and gives each value the Find compares a field with.
 */
export function shapeProblem(
  automation: Automation,
  findValues: (condition: string, ordinal: number) => readonly FindValue[] | { problem: string },
): string | null {
  const recordless = noTriggerRecord(automation.when);
  const steps = orderSteps(automation.do);
  const bindings = bindingsOf(steps);
  let finds = 0;
  let formulas = (automation.if === null ? 0 : 1) +
    (automation.when.kind === "field-changed" && automation.when.to?.kind === "formula" ? 1 : 0) +
    (automation.when.kind === "starts-matching" ? 2 : 0);
  for (const { step, ordinal } of everyStep(steps)) {
    switch (step.kind) {
      case "wake-agent":
      case "post":
        formulas += 1;
        break;
      case "notify":
      case "direct-message":
        formulas += 1 + step.to.filter(isFormula).length;
        break;
      case "invoke": {
        const inputs = step.input.flatMap((entry) => (isFormula(entry.value) ? [entry.value.expression] : []));
        formulas += inputs.length;
        if (recordless !== null && inputs.some(readsTriggerRecord)) {
          return `${automation.when.kind === "schedule" ? "A schedule" : "A Group message"} starts this automation, so an action's input cannot use trigger.record. Use a value instead.`;
        }
        break;
      }
      case "find": {
        finds += 1;
        formulas += 1;
        const values = findValues(step.condition, ordinal);
        if ("problem" in values) return values.problem;
        if (recordless !== null && values.some((value) => value.kind === "trigger-field" ||
          (value.kind === "formula" && readsTriggerRecord(value.expression)))) {
          return recordless;
        }
        formulas += values.filter((value) => value.kind === "formula").length;
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
 * its table, and its watched fields as field ids of the approved rules. Null
 * for a button, whose presses claim instead, and for a schedule or a Group
 * message, which the engine claims. Or why the automation cannot run on the
 * dataset.
 */
export function datasetSubscriptionFor(
  automation: Automation,
  definition: DatasetDefinition,
): { tableId: string; kinds: AutomationChangeKind[]; fieldIds: string[] | null } | { problem: string } | null {
  const trigger = automation.when;
  if (trigger.kind === "schedule" || trigger.kind === "group-message") return null;
  const table = trigger.table === null
    ? (definition.tables.length === 1 ? definition.tables[0] : undefined)
    : definition.tables.find((candidate) => candidate.name === trigger.table);
  if (table === undefined) {
    return { problem: trigger.table === null
      ? `${definition.name} has several tables. Name the one this automation watches.`
      : `${definition.name} has no table named ${trigger.table}.` };
  }
  if (trigger.kind === "button") {
    return table.fields.some((field) => field.type === "button" && field.name === trigger.field)
      ? null
      : { problem: `${table.name} has no button named ${trigger.field}.` };
  }
  const { kinds, fields } = subscriptionFor(trigger)!;
  const fieldIds: string[] = [];
  for (const name of fields ?? []) {
    const field = table.fields.find((candidate) => candidate.name === name);
    if (field === undefined) return { problem: `${table.name} has no field named ${name}.` };
    fieldIds.push(field.fieldId);
  }
  return { tableId: table.tableId, kinds: [...kinds].sort(), fieldIds: fields === undefined ? null : fieldIds.sort() };
}

/** A post to the direct message with `userId`, as the reach check reads it. */
export function directMessageReach(chat: ChatDirectory | null, userId: string): ReachStep {
  const target = chat?.directMessage(userId);
  return {
    kind: "post",
    group: target && !("problem" in target)
      ? { channelWireId: target.wireId, name: target.name }
      : { channelWireId: null, name: "a direct message" },
  };
}

/** The Group whose messages start the automation, as the reach check reads it. */
function groupTriggerReach(automation: Automation, chat: ChatDirectory | null): ReachStep[] {
  if (automation.when.kind !== "group-message") return [];
  const group = chat?.group(automation.when.group);
  return [{
    kind: "read-group",
    group: group && !("problem" in group)
      ? { channelWireId: group.wireId, name: group.name }
      : { channelWireId: null, name: automation.when.group },
  }];
}

/** The Group, people, or person's own reach one chat step reaches. Any other step reaches no chat. */
function chatReachOf(step: AutomationStep, chat: ChatDirectory | null): ReachStep[] {
  switch (step.kind) {
    case "post": {
      const group = chat?.group(step.group);
      return [{
        kind: "post",
        group: group && !("problem" in group)
          ? { channelWireId: group.wireId, name: group.name }
          : { channelWireId: null, name: step.group },
      }];
    }
    case "direct-message":
      return step.to.flatMap((person) => !isFormula(person) && typeof person.value === "string" ? [directMessageReach(chat, person.value)] : []);
    case "wake-agent":
      // A personal step: it acts as its person, so it reaches only what they do alone.
      return [{ kind: "personal", person: { userId: step.person, name: chat?.person(step.person) ?? "that person" } }];
    case "notify":
      return step.to.flatMap((person): ReachStep[] => isFormula(person) || typeof person.value !== "string"
        ? []
        : [{ kind: "notify", person: { userId: person.value, name: chat?.person(person.value) ?? "that person" } }]);
    default:
      return [];
  }
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
  const reach = groupTriggerReach(automation, chat);
  for (const { step } of everyStep(steps)) {
    if (step.kind === "set") {
      const bound = step.records === null ? null : bindings.get(step.records);
      reach.push({ kind: "change-records", collection: target(bound ? bound.collection : null) });
    } else if (step.kind === "add-record") {
      reach.push({ kind: "change-records", collection: target(step.collection) });
    } else if (step.kind === "find") {
      reach.push({ kind: "find-records", collection: target(step.collection) });
    } else if (step.kind === "run" || step.kind === "run-file") {
      // Code reads the trigger record, so everyone who can edit the code must
      // be able to view this Collection. What it changes is checked once it
      // has run.
      reach.push({ kind: "find-records", collection });
    } else {
      reach.push(...chatReachOf(step, chat));
    }
  }
  return reach;
}

/**
 * Only the chats an automation reaches, as reachStepsOf reads them: the
 * Group whose messages start it, then each step's Group, people, or person,
 * in step order.
 */
export function chatReachStepsOf(automation: Automation, chat: ChatDirectory | null): ReachStep[] {
  return [...groupTriggerReach(automation, chat), ...[...everyStep(orderSteps(automation.do))].flatMap(({ step }) => chatReachOf(step, chat))];
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
    // An invoke step runs an action, whose code decides which fields it
    // changes, so it names none here and the ⚡ marks show none for it.
  }
  return writes;
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
  /**
   * A dataset record's primary key as its operations take it, which formulas
   * read as `record.id`: a number stays a number. Absent for a document.
   */
  key?: string | number;
  path: string;
  values: JsonObject;
}

/** Which record a step's result names, without its values: a later step reads them again. */
export type RunRef = Pick<RunRecord, "id" | "key" | "path">;

export function runRecordOf(record: CollectionRecord): RunRecord {
  const values: JsonObject = {};
  for (const entry of record.values) values[entry.field] = jsonValue(entry.value);
  return { id: record.id, path: record.path, values };
}

export const refOf = ({ id, key, path }: RunRecord): RunRef => (key === undefined ? { id, path } : { id, key, path });

const recordScope = (record: RunRecord): JsonObject => ({ ...record.values, id: record.key ?? record.id });

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
    /** Who made the change, when that is known; left out when it is not. */
    actorKind?: AutomationClaim["change"]["actorKind"];
    /** The person the owner shared with, or the Edit share link, the relay accepted it from; left out when none. */
    sharedAuthor?: AutomationClaim["change"]["sharedAuthor"];
  };
}

function factValue(side: Fact["previous"]): { value: JsonValue } | null | "truncated" {
  if (side === null) return null;
  return "truncated" in side ? "truncated" : { value: side.value };
}

/** What every step of a run shares: its trigger, who or what started it, and where it sends. */
export interface RunContext {
  automation: Automation;
  claim: RunClaim;
  /** The Group message that started the run, with its whole body; null for a record change. */
  message: JsonObject | null;
  /**
   * The person who pressed the button or made the record change, or null
   * when nobody is known. A Group message's person is its author instead.
   */
  person: AutomationScope["person"];
  /** Where posts and direct messages go; null when the automation sends none. */
  chat: ChatDirectory | null;
  /** The time formulas read as `now`: when the change was claimed, or a schedule's due time. */
  nowMs: number;
  /**
   * The only keys of the trigger record formulas may read, when the run cannot
   * read the record's fields. A formula that reads another stops with an
   * error instead of reading nothing.
   */
  recordKeys?: string[];
  /** What the run's ids and idempotency keys derive from: the claim, and the run's key seed. */
  key: { claimId: string; hash: string };
}

/** How a run finds a record a code step names by its Collection and id. */
export const codeRecordKey = (collection: string, id: string, table?: string) => JSON.stringify([collection, id, table ?? null]);

/**
 * Whether the claim's change is the one the trigger names, before any
 * formula runs. A formula `to:`, and a starts-matching condition, are
 * checked by conditionsRequest.
 */
export function triggerMatches(automation: Automation, claim: RunClaim, record: RunRecord | null): boolean {
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
  | { kind: "to" }
  | { kind: "matched-before" }
  | { kind: "matches" }
  // The value a Find compares its filter at `index` with.
  | { kind: "find"; ordinal: number; index: number }
  | { kind: "if"; ordinal: number }
  | { kind: "value"; ordinal: number; field: string }
  // One answer per record the step changes, in order.
  | { kind: "values"; ordinal: number; field: string }
  // One key of an action's input.
  | { kind: "input"; ordinal: number; key: string }
  | { kind: "text"; ordinal: number }
  // A direct message's person that a formula names.
  | { kind: "person"; ordinal: number; index: number }
  // A code step's answer. Later steps read its output by `as`.
  | { kind: "code"; ordinal: number; as: string | null };

type Guards = NonNullable<AutomationFormula["when"]>;
/** A code step to run. */
type CodeItem = { kind: "code"; source: string };

export interface EvaluationRequest {
  scope: AutomationScope;
  /** Formulas, each guard naming an earlier one; or one code step. */
  items: AutomationFormula[] | [CodeItem];
  slots: Slot[];
}

/**
 * Evaluates a request: its formulas in one evaluator request, or its one
 * code step. Every request adds to `spent`, which every step of the run
 * shares, so a run's evaluator budget does not grow with its steps.
 */
export async function evaluateRequest(
  evaluator: AutomationFormulaEvaluator,
  automationId: string,
  request: EvaluationRequest,
  spent: AutomationTimeSpent,
): Promise<AutomationOutcome<JsonValue>[] | "busy"> {
  const [first] = request.items;
  if (first?.kind === "code") {
    const answer = await evaluator.runCode(automationId, request.scope, first.source, spent);
    return answer === "busy" ? "busy" : [answer as AutomationOutcome<JsonValue>];
  }
  if (request.items.length === 0) return [];
  return await evaluator.evaluate(automationId, request.scope, request.items as AutomationFormula[], spent);
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

/** The value the trigger's field changed to: from the claim, or from the record when the claim left it out. */
function changedTo(claim: RunClaim, field: string, record: RunRecord | null): JsonValue {
  const fact = claim.change.fields.find((candidate) => candidate.field === field);
  const next = fact ? factValue(fact.next) : "truncated";
  return next === "truncated" ? (record?.values[field] ?? null) : (next?.value ?? null);
}

/**
 * The formulas that decide whether a run goes ahead, checked once against
 * the trigger record before the first step: a formula `to:`, a
 * starts-matching condition before and after the change, and "Only if".
 */
export function conditionsRequest(ctx: RunContext, record: RunRecord | null): EvaluationRequest {
  const { automation, claim } = ctx;
  const items: AutomationFormula[] = [];
  const slots: Slot[] = [];
  const add = (slot: Slot, source: string, when: Guards = []) => {
    const index = items.length;
    slots.push(slot);
    items.push({ kind: "expression", source, ...(when.length > 0 ? { when: [...when] } : {}) });
    return index;
  };
  const conditions: Guards = [];
  const trigger = automation.when;
  if (trigger.kind === "field-changed" && trigger.to?.kind === "formula") {
    conditions.push({ index: add({ kind: "to" }, trigger.to.expression), equals: changedTo(claim, trigger.field, record) });
  }
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed") {
    conditions.push({ index: add({ kind: "matched-before" }, `((record) => (${trigger.condition}\n))(${BEFORE_BINDING})`), truthy: false });
    conditions.push({ index: add({ kind: "matches" }, trigger.condition, conditions), truthy: true });
  } else if (trigger.kind === "starts-matching") {
    conditions.push({ index: add({ kind: "matches" }, trigger.condition), truthy: true });
  }
  if (automation.if !== null) add({ kind: "only-if" }, automation.if, conditions);
  const bindings: JsonObject = {};
  if (trigger.kind === "starts-matching" && claim.change.kind === "changed" && record) {
    bindings[BEFORE_BINDING] = recordBefore(record, claim);
  }
  // No step has run yet.
  const unavailable = Object.fromEntries([...bindingsIn(automation)].map(([name, binding]) => [name,
    `${name} is step ${binding.ordinal + 1}'s result, and steps run only once this automation's conditions hold. Check it in an If step instead.`]));
  return { scope: runScope(ctx, record, bindings, unavailable), items, slots };
}

/** Whether the run goes ahead once its conditions have answered, or why it failed. */
export function conditionsHold(
  ctx: RunContext,
  record: RunRecord | null,
  request: EvaluationRequest,
  results: readonly AutomationOutcome<JsonValue>[],
): "go" | "skip" | { error: string; timedOut: boolean } {
  const answers = answersOf(request, results);
  if ("error" in answers) return answers;
  const { automation, claim } = ctx;
  const trigger = automation.when;
  if (trigger.kind === "field-changed" && trigger.to?.kind === "formula" &&
    !isDeepStrictEqual(changedTo(claim, trigger.field, record), answers.get("to") ?? null)) {
    return "skip";
  }
  if (trigger.kind === "starts-matching" && (!answers.get("matches") || answers.get("matched-before"))) return "skip";
  if (automation.if !== null && !answers.get("only-if")) return "skip";
  return "go";
}

/** What every formula in a run sees, with `bindings` for the earlier steps' results. */
function runScope(ctx: RunContext, record: RunRecord | null, bindings: JsonObject, unavailable: Readonly<Record<string, string>> = {}): AutomationScope {
  const { automation, claim, message, person, nowMs } = ctx;
  const trigger = automation.when;
  const triggerRecord = record ? recordScope(record) : null;
  const author = message && typeof message.authorUserId === "string" && typeof message.authorDisplayName === "string"
    ? { id: message.authorUserId, name: message.authorDisplayName }
    : null;
  const dueAt = scheduleDueAt(claim);
  const skippedFrom = runNowSkippedFrom(claim);
  return {
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
          // Who the relay accepted a live-shared change from. A link is its
          // grant and never a person, so it names no `person` below.
          author: claim.change.sharedAuthor ?? null,
        },
    // A press, a record change or a Group message names the person who started it.
    person: person ?? author,
    bindings,
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
    now: localIsoTime(nowMs),
    ...(ctx.recordKeys ? { recordKeys: ctx.recordKeys } : {}),
  };
}

/** An earlier step's result as a later step reads it. */
export type Bound =
  | { kind: "find"; records: readonly RunRecord[] }
  | { kind: "add"; record: RunRecord | null }
  | { kind: "code"; value: JsonValue };

/** What one step reads, as it was when the step started. */
export interface StepInputs {
  /** The trigger record now; null when the run has none or it is gone. */
  record: RunRecord | null;
  /** Each earlier step's result the step reads, by the name its step binds. */
  bound: ReadonlyMap<string, Bound>;
  /** Each result of a step that has not run, with why the step cannot read it. */
  unavailable: Readonly<Record<string, string>>;
}

// Built from entries, so a result named __proto__ is a name like any other.
function boundScope(bound: ReadonlyMap<string, Bound>): JsonObject {
  return Object.fromEntries([...bound].map(([name, value]): [string, JsonValue] => [name,
    value.kind === "find" ? value.records.map(recordScope) : value.kind === "add" ? (value.record ? recordScope(value.record) : null) : value.value]));
}

/**
 * The names a step's formulas read as variables, and the binding it changes
 * records of, so the step reads again only the earlier results it uses.
 * Code can read anything, so a code step reads every earlier result.
 */
export function namesUsed(step: AutomationStep): ReadonlySet<string> | "all" {
  if (step.kind === "run" || step.kind === "run-file") return "all";
  const sources: string[] = [];
  const formulas = (values: readonly AutomationValue[]) => {
    for (const value of values) if (isFormula(value)) sources.push(value.expression);
  };
  switch (step.kind) {
    case "if":
      sources.push(step.if);
      break;
    case "find":
      sources.push(step.condition);
      break;
    case "set":
    case "add-record":
      formulas(step.values.map((entry) => entry.value));
      break;
    case "invoke":
      formulas(step.input.map((entry) => entry.value));
      break;
    default:
      for (const part of automationTextParts(step.text) ?? []) if (part.kind === "expression") sources.push(part.expression);
      if (step.kind === "direct-message" || step.kind === "notify") formulas(step.to);
  }
  const names = new Set<string>();
  // Every name, a function's own parameters too: reading one result too many
  // costs a read, and one too few would leave it out. A formula that is not
  // one expression fails when it runs, and says why.
  for (const source of sources) {
    if (isOneExpression(source)) for (const name of namesRead(parseExpressionAt(source, 0, { ecmaVersion: "latest" }))) names.add(name);
  }
  if (step.kind === "set" && step.records !== null) names.add(step.records);
  return names;
}

/** An automation's bindings by name: which step makes each, as runs count steps. */
export function bindingsIn(automation: Automation): ReadonlyMap<string, Binding> {
  return bindingsOf(orderSteps(automation.do));
}

/**
 * Each result the step at `ordinal` does not get, with why: the step that
 * makes it comes later, or is in a branch this run did not take, or the
 * step's formulas never name it, so it was not read. Reading one stops the
 * formula or code with that text instead of reading nothing.
 */
export function unavailableTo(
  ordinal: number,
  bindings: ReadonlyMap<string, Binding>,
  done: ReadonlySet<string>,
  read: ReadonlySet<string> | "all",
): Record<string, string> {
  // Built from entries, so a result named __proto__ is a name like any other.
  return Object.fromEntries([...bindings].flatMap(([name, binding]): Array<[string, string]> => {
    const maker = `step ${binding.ordinal + 1}`;
    if (done.has(name)) {
      return read === "all" || read.has(name) ? [] : [[name, `${name} is ${maker}'s result, and a formula gets it only by naming it. Write ${name} in the formula.`]];
    }
    return [[name, binding.ordinal > ordinal
      ? `${name} is ${maker}'s result, and ${maker} comes after step ${ordinal + 1}.`
      : `${name} is ${maker}'s result, and ${maker} did not run.`]];
  }));
}

/**
 * One evaluator request for the values a Find compares fields with that
 * formulas give. `record` means the record the Find checks, which no value
 * can read, so these formulas reach the trigger record only as
 * `trigger.record`. They read earlier steps' results.
 */
export function findRequest(ctx: RunContext, ordinal: number, inputs: StepInputs, values: readonly FindValue[]): EvaluationRequest {
  const items: AutomationFormula[] = [];
  const slots: Slot[] = [];
  values.forEach((value, index) => {
    if (value.kind !== "formula") return;
    items.push({ kind: "expression", source: value.expression });
    slots.push({ kind: "find", ordinal, index });
  });
  const { record: _checked, ...scope } = runScope(ctx, inputs.record, boundScope(inputs.bound), inputs.unavailable);
  return { scope, items, slots };
}

/** The values a Find's filters compare with, once its formulas have answered. */
export function filterValues(values: readonly FindValue[], record: RunRecord | null, answers: ReadonlyMap<string, JsonValue>): JsonValue[] {
  return values.map((value, index) => {
    if (value.kind === "literal") return value.value;
    if (value.kind === "trigger-field") return record?.values[value.field] ?? null;
    return answers.get(`find:${index}`) ?? null;
  });
}

/**
 * One evaluator request for a step's formulas, or its code: a run-file
 * step's `source`, as the executor read it. Not for a Find: see findRequest.
 */
export function stepRequest(ctx: RunContext, entry: OrderedStep, inputs: StepInputs, source?: string): EvaluationRequest {
  const items: AutomationFormula[] = [];
  const slots: Slot[] = [];
  const add = (slot: Slot, source: string) => {
    slots.push(slot);
    items.push({ kind: "expression", source });
  };
  const { ordinal, step } = entry;
  const scope = runScope(ctx, inputs.record, boundScope(inputs.bound), inputs.unavailable);
  if ("then" in entry) {
    add({ kind: "if", ordinal }, entry.step.if);
  } else if (step.kind === "run" || step.kind === "run-file") {
    const code = step.kind === "run" ? step.code : source;
    if (code === undefined) throw new Error(`dohc did not read the code file step ${ordinal + 1} runs.`);
    return { scope, items: [{ kind: "code", source: code }], slots: [{ kind: "code", ordinal, as: step.as }] };
  } else if (step.kind === "post" || step.kind === "direct-message" || step.kind === "notify" || step.kind === "wake-agent") {
    slots.push({ kind: "text", ordinal });
    items.push({ kind: "text", parts: automationTextParts(step.text) ?? [{ kind: "text", text: step.text }] });
    if (step.kind === "direct-message" || step.kind === "notify") {
      step.to.forEach((person, index) => {
        if (isFormula(person)) add({ kind: "person", ordinal, index }, person.expression);
      });
    }
  } else if (step.kind === "invoke") {
    for (const { key, value } of step.input) if (isFormula(value)) add({ kind: "input", ordinal, key }, value.expression);
  } else if (step.kind === "set" || step.kind === "add-record") {
    // A Set on the records a Find returned gives each record its own value.
    const records = step.kind === "set" && step.records !== null && inputs.bound.get(step.records)?.kind === "find" ? step.records : null;
    for (const { field, value } of step.values) {
      if (!isFormula(value)) continue;
      if (records === null) add({ kind: "value", ordinal, field }, value.expression);
      else add({ kind: "values", ordinal, field }, `(${records}).map((record) => (${value.expression}\n))`);
    }
  }
  return { scope, items, slots };
}

function slotKey(slot: Slot): string {
  switch (slot.kind) {
    case "value":
    case "values":
      return `${slot.kind}:${slot.field}`;
    case "find":
      return `find:${slot.index}`;
    case "person":
      return `person:${slot.index}`;
    case "input":
      return `input:${slot.key}`;
    default:
      return slot.kind;
  }
}

/** Each formula's answer by its slot, or why one failed. */
export function answersOf(
  request: EvaluationRequest,
  results: readonly AutomationOutcome<JsonValue>[],
): Map<string, JsonValue> | { error: string; timedOut: boolean } {
  const answers = new Map<string, JsonValue>();
  let failure: { error: string; timedOut: boolean } | null = null;
  for (const [index, slot] of request.slots.entries()) {
    const result = results[index];
    if (!result) return failure ?? { error: "The evaluator did not answer every formula.", timedOut: false };
    if (result.ok) {
      answers.set(slotKey(slot), result.value);
      continue;
    }
    // A timeout counts toward switching the automation off, so another
    // formula's failure in the same request never hides one.
    const timedOut = result.error.code === "timeout";
    if (failure === null || (timedOut && !failure.timedOut)) failure = { error: `${slotSubject(slot)} failed. ${result.error.message}`, timedOut };
    if (timedOut) return failure;
  }
  return failure ?? answers;
}

export interface PlannedField {
  field: string;
  before: JsonValue;
  after: JsonValue;
}

/** A record a step changes, found again by its id before the write. */
export type PlannedTarget = { recordId: string; collectionPath: string; path: string };

export type PlannedEffect =
  | { kind: "set"; target: PlannedTarget; table?: string; fields: PlannedField[] }
  | { kind: "add"; collectionPath: string; table?: string; recordId: string; name: string; fields: Array<{ field: string; value: JsonValue }> }
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
    }
  /** A dataset action to run, by name, with its input as the formulas gave it. */
  | { kind: "invoke"; operation: string; input: JsonObject };

/**
 * What a completed step leaves for the steps after it: the records a Find
 * returned, which branch an If took, or the value a code step returned. A
 * record an Add record step added is known from what the run recorded.
 */
export type StepOutput =
  | { kind: "find"; records: RunRef[] }
  | { kind: "if"; branch: boolean }
  | { kind: "code"; value: JsonValue };

/** One step as planned: its effects, in order, and its result. */
export interface PlannedStep {
  ordinal: number;
  effects: PlannedEffect[];
  output?: StepOutput;
}

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
    case "input":
      return `The input "${slot.key}" in step ${slot.ordinal + 1}`;
    case "code":
      return `The code in step ${slot.ordinal + 1}`;
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
    const value = isFormula(person) ? (answers.get(`person:${index}`) ?? null) : person.value;
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

/** The people a step's formulas named for direct messages, so only their conversations are read. */
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

/**
 * A record change a code step asked for. `set` changes the trigger record,
 * which has `id` null; so does an added record, which has no id yet.
 */
export interface CodeChange {
  ordinal: number;
  action: "add" | "change";
  /** The Collection's workspace path. */
  collection: string;
  table?: string;
  id: string | null;
  fields: JsonObject;
}

/**
 * Every record change a code step asked for: `set` in `collectionPath`,
 * then `records` as the code listed them. Or why the changes break the code
 * step contract.
 */
export function codeChangesOf(
  request: EvaluationRequest,
  results: readonly AutomationOutcome<JsonValue>[],
  collectionPath: string,
): CodeChange[] | { problem: string } {
  const changes: CodeChange[] = [];
  for (const [index, slot] of request.slots.entries()) {
    const result = results[index];
    if (slot.kind !== "code" || !result?.ok || result.value === null) continue;
    // The evaluator checked the shape of a code step's answer.
    const answer = result.value as CodeStepReturn;
    const { ordinal } = slot;
    const own: CodeChange[] = [
      ...(answer.set === undefined ? [] : [{ ordinal, action: "change" as const, collection: collectionPath, id: null, fields: answer.set }]),
      ...(answer.records ?? []).map((change): CodeChange => ({
        ordinal, action: change.action, collection: change.collection, ...(change.table === undefined ? {} : { table: change.table }), id: change.action === "change" ? change.id : null, fields: change.fields,
      })),
    // A change of no fields changes nothing. An added record with none still adds one.
    ].filter((change) => change.action === "add" || Object.keys(change.fields).length > 0);
    const subject = `The code in step ${ordinal + 1}`;
    if (own.length > MAX_CODE_RECORD_CHANGES) {
      return { problem: `${subject} changes more than ${MAX_CODE_RECORD_CHANGES} records. Change at most ${MAX_CODE_RECORD_CHANGES} in one step.` };
    }
    if (own.some((change) => Object.hasOwn(change.fields, RECORD_ID_FRONTMATTER_KEY))) {
      return { problem: `${subject} sets ${RECORD_ID_FRONTMATTER_KEY}. A record's ${RECORD_ID_FRONTMATTER_KEY} cannot change.` };
    }
    changes.push(...own);
  }
  return changes;
}

/** The seed of every id and idempotency key a step's effects use. */
export function stepKey(claimId: string, hash: string, ordinal: number): string {
  return `${claimId}/${hash}/${ordinal}`;
}

/** How many field values a step's effects write, as the run's limit counts them. */
export function fieldWriteCount(effects: ReadonlyArray<{ kind: string; fields?: readonly unknown[]; values?: readonly unknown[] }>): number {
  let count = 0;
  for (const effect of effects) {
    if (effect.kind === "set" || effect.kind === "add" || effect.kind === "dataset-edit") count += effect.fields?.length ?? 0;
    else if (effect.kind === "dataset-create") count += effect.values?.length ?? 0;
  }
  return count;
}

export const tooManyWritesError = (ordinal: number) =>
  `Step ${ordinal + 1} would change more than ${MAX_RUN_FIELD_WRITES} fields across this run. Narrow its Find steps, or split it into smaller automations.`;

/**
 * Turns one step's answers into its effects and its result: which branch an
 * If takes, the fields a step writes, the messages it sends. Each field's
 * before value is what the step read when it started. `chat` names the
 * people the step's formulas named; `codeRecords` are the records its code
 * changes by id, as the step read them.
 */
export function planStep(
  ctx: RunContext,
  entry: OrderedStep,
  inputs: StepInputs,
  answers: ReadonlyMap<string, JsonValue>,
  extra: { chat: ChatDirectory | null; codeChanges: readonly CodeChange[]; codeRecords: ReadonlyMap<string, RunRecord> },
): { step: PlannedStep } | { problem: string } {
  const { automation, claim, key } = ctx;
  const { record } = inputs;
  const { chat } = extra;
  const { ordinal, step } = entry;
  const done = (effects: PlannedEffect[], output?: StepOutput) => ({ step: { ordinal, effects, ...(output ? { output } : {}) } });
  const seed = stepKey(key.claimId, key.hash, ordinal);
  const valueOf = (field: string, value: AutomationValue): JsonValue =>
    isFormula(value) ? (answers.get(`value:${field}`) ?? null) : value.value;
  const set = (target: RunRecord, collectionPath: string, values: ReadonlyArray<{ field: string; after: JsonValue }>): PlannedEffect => ({
    kind: "set",
    target: { recordId: target.id, collectionPath, path: target.path },
    fields: values.map(({ field, after }) => ({ field, before: target.values[field] ?? null, after })),
  });
  if ("then" in entry) return done([], { kind: "if", branch: Boolean(answers.get("if")) });
  switch (step.kind) {
    case "wake-agent": {
      // Any change can wake the agent. The wake message carries the claim's
      // depth plus one, and the agent's writes one more, so the chain stops
      // at the cap like any other.
      const body = messageBody(answers.get("text") ?? null);
      if (typeof body !== "string") return { problem: `The message in step ${ordinal + 1} ${body.problem}` };
      const effectId = `${seed}/wake`;
      return done([{
        kind: "wake",
        effectId,
        messageId: automationMessageId(effectId),
        threadId: automationWakeThreadId(claim.automationId),
        person: step.person,
        body,
      }]);
    }
    case "notify": {
      const text = answers.get("text") ?? null;
      if (typeof text !== "string") return { problem: `The message in step ${ordinal + 1} is not text.` };
      if (chat === null) return { problem: "dohc could not read who this workspace is shared with." };
      const people = peopleOf(step.to, ordinal, answers);
      if (typeof people === "string") return { problem: people };
      const effects: PlannedEffect[] = [];
      for (const [userId, byFormula] of people) {
        const recipient = chat.noticeRecipient(userId);
        if ("problem" in recipient) return { problem: recipient.problem };
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
      return done(effects);
    }
    case "post":
    case "direct-message": {
      const body = messageBody(answers.get("text") ?? null);
      if (typeof body !== "string") return { problem: `The message in step ${ordinal + 1} ${body.problem}` };
      if (chat === null) return { problem: "dohc could not read this workspace's chats." };
      if (step.kind === "post") {
        const group = chat.group(step.group);
        if ("problem" in group) return { problem: group.problem };
        if (group.readOnly) return { problem: GROUP_READ_ONLY };
        const effectId = `${seed}/post`;
        return done([{
          kind: "message",
          effectId,
          messageId: automationMessageId(effectId),
          threadId: automationThreadId(effectId),
          to: { kind: "group", channelId: group.channelId, lane: group.lane },
          name: group.name,
          channelWireId: group.wireId,
          body,
        }]);
      }
      const people = peopleOf(step.to, ordinal, answers);
      if (typeof people === "string") return { problem: people };
      const effects: PlannedEffect[] = [];
      for (const [userId, byFormula] of people) {
        const target = chat.directMessage(userId);
        if ("problem" in target) return { problem: target.problem };
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
      return done(effects);
    }
    case "invoke": {
      const input: JsonObject = {};
      for (const { key: name, value } of step.input) input[name] = isFormula(value) ? (answers.get(`input:${name}`) ?? null) : value.value;
      return done([{ kind: "invoke", operation: step.operation, input }]);
    }
    case "run":
    case "run-file": {
      // The code's changes as Set fields and Add record effects, in the order
      // the code listed them. Changes to one record merge into one write, so
      // each field keeps one idempotency key.
      const edits = new Map<string, { target: RunRecord; collectionPath: string; table?: string; values: Map<string, JsonValue> }>();
      const order: Array<PlannedEffect | { edit: string }> = [];
      for (const [index, change] of extra.codeChanges.entries()) {
        const values = Object.entries(change.fields).map(([field, after]) => ({ field, after }));
        if (change.action === "add") {
          const recordId = derivedRecordId(`${seed}/${index}`);
          order.push({
            kind: "add",
            collectionPath: change.collection,
            ...(change.table === undefined ? {} : { table: change.table }),
            recordId,
            name: `${automation.id}-${recordId.slice(4, 12)}`,
            fields: values.map(({ field, after }) => ({ field, value: after })),
          });
          continue;
        }
        const target = change.id === null ? record : (extra.codeRecords.get(codeRecordKey(change.collection, change.id, change.table)) ?? null);
        if (target === null) {
          const starter = automation.when.kind === "schedule" ? "A schedule" : automation.when.kind === "group-message" ? "A Group message" : null;
          return { problem: change.id === null
            ? starter === null
              ? `The code in step ${ordinal + 1} returned "set", but this run has no record to set fields on.`
              : `The code in step ${ordinal + 1} returned "set", but ${starter.toLowerCase()} starts this automation, so it has no record to set fields on. Change records by id in "records" instead.`
            : `The code in step ${ordinal + 1} changes record ${change.id}, which is not in ${change.collection}.` };
        }
        // Records key on their path and id together: dataset records of two tables can share an id.
        const edit = `${target.path}\u0000${target.id}`;
        if (!edits.has(edit)) {
          edits.set(edit, { target, collectionPath: change.collection, ...(change.table === undefined ? {} : { table: change.table }), values: new Map() });
          order.push({ edit });
        }
        for (const { field, after } of values) edits.get(edit)!.values.set(field, after);
      }
      const output: StepOutput | undefined = step.as === null ? undefined : { kind: "code", value: codeOutput(answers.get("code") ?? null) };
      return done(order.map((entry): PlannedEffect => {
        if (!("edit" in entry)) return entry;
        const { target, collectionPath, table, values } = edits.get(entry.edit)!;
        return { ...set(target, collectionPath, [...values].map(([field, after]) => ({ field, after }))), ...(table === undefined ? {} : { table }) };
      }), output);
    }
    case "add-record": {
      const recordId = derivedRecordId(seed);
      return done([{
        kind: "add",
        collectionPath: step.collection ?? claim.collectionPath,
        recordId,
        // Each run's record gets its own name, the same on every attempt.
        name: `${automation.id}-${recordId.slice(4, 12)}`,
        fields: step.values.map(({ field, value }) => ({ field, value: valueOf(field, value) })),
      }]);
    }
    case "set": {
      const bound = step.records === null ? null : inputs.bound.get(step.records);
      const binding = step.records === null ? null : bindingsIn(automation).get(step.records);
      const collectionPath = binding?.collection ?? claim.collectionPath;
      if (bound === undefined || bound?.kind === "code") return { problem: `Step ${ordinal + 1} changes records that no earlier step found or added.` };
      if (bound?.kind === "find") {
        const lists = new Map<string, JsonValue[]>();
        for (const { field, value } of step.values) {
          if (!isFormula(value)) continue;
          const list = answers.get(`values:${field}`);
          if (!Array.isArray(list) || list.length !== bound.records.length) {
            return { problem: `The formula for "${field}" in step ${ordinal + 1} did not give one value for each record.` };
          }
          lists.set(field, list);
        }
        return done(bound.records.map((target, index) => set(target, collectionPath, step.values.map(({ field, value }) => ({
          field,
          after: isFormula(value) ? (lists.get(field)![index] ?? null) : value.value,
        })))));
      }
      const target = bound === null ? record : bound.record;
      // A record an earlier step added and someone removed since has nothing to change.
      if (target === null && bound !== null) return done([]);
      if (target === null) return { problem: "The record was removed, so the automation has no record to change." };
      return done([set(target, collectionPath, step.values.map(({ field, value }) => ({ field, after: valueOf(field, value) })))]);
    }
    default:
      // A Find is planned by the executor, which queries its records.
      throw new Error(`Step ${ordinal + 1} is not planned here.`);
  }
}

// What a code step returned for later steps to read, as its binding.
function codeOutput(answer: JsonValue): JsonValue {
  return answer !== null && typeof answer === "object" && !Array.isArray(answer) ? ((answer as CodeStepReturn).output ?? null) : null;
}
