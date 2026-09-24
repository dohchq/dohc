import {
  CORE_SCHEMA,
  dump,
  load,
  realMapTag,
  visit,
  YAMLException,
  type Document as YamlDocument,
} from "js-yaml";
import { hasPreferredNameControlCharacters } from "./chatIdentityValues";
import { RECORD_ID_FRONTMATTER_KEY } from "./collection";
import { isNormalizedRelativePath, yamlKeyText } from "./collectionValues";

// The on-disk contract for `automations.yaml`, the file in a Collection's
// folder that stores its automations. dohc writes it with
// writeAutomationsFile, and people and agents can edit it by hand.
//
//   version: 1
//   automations:
//     - id: finished-date
//       name: Stamp the finish date
//       when:
//         field-changed: Status
//         to: Done
//       do:
//         - set:
//             Finished on: =today()
//
// `when` holds one trigger and `do` holds steps that run in order. A trigger
// or step is a mapping with exactly one kind key, such as `field-changed` or
// `set`. The kind key holds the main argument, and the other keys are that
// kind's options. A trigger without an argument can be written as its kind
// alone: `when: record-added`.
//
// Values, conditions, and message text each follow one rule:
//
// - A value is a YAML scalar. Text that starts with "=" is a formula, and the
//   rest of it is a JavaScript expression: `Finished on: =today()`. Any other
//   scalar is itself. To store text that starts with "=", use a formula that
//   returns it: `="=5"`. The writer does this for a literal that starts
//   with "=".
// - A condition (`if`, `find`, `starts-matching`) is always an expression,
//   without "=".
// - Message text (`notify`, `post`, `direct-message`, `wake-agent`) is a
//   template. `{expression}` inserts a value, and `{{` and `}}` write one
//   brace. Braces inside an expression must balance.
//
// Fields, Groups, and Button fields are referenced by name. Collections are
// workspace-relative folder paths. A code file is relative to the
// Collection's folder and cannot leave it, so the people who can edit the
// automation are the people who can edit its code.
//
// An invalid automation turns off only itself and keeps its own diagnostics.
// A problem with the whole file, such as broken YAML or an unknown version,
// turns every automation off with one diagnostic. js-yaml cannot edit a
// document in place, so writeAutomationsFile rewrites the whole file. The
// output is deterministic, so a save changes only the lines of the
// automation that changed. Comments and hand formatting do not survive the
// first save through the writer.

const AUTOMATIONS_FILE_VERSION = 1;

// Airtable allows 50 automations in a base, which holds many tables. A
// Collection is one table, and past 50 the ⚡ panel stops being a list a
// person can scan.
export const MAX_AUTOMATIONS = 50;
// Airtable's cap on actions in one automation. Steps inside an if step
// count, and so does the if step itself.
export const MAX_AUTOMATION_STEPS = 25;
// An if step inside an if step inside an if step. Deeper branching reads
// better as separate automations with their own conditions.
export const MAX_IF_DEPTH = 3;
// An id is a slug such as `stamp-finish-date`: lowercase letters, digits, and
// single hyphens. Run history and record history key on it, so it stays short.
export const MAX_AUTOMATION_ID_LENGTH = 64;
// The name shows in the ⚡ panel, in record history, and as a chat author,
// so it has the same bound as other display names.
export const MAX_AUTOMATION_NAME_LENGTH = 120;
// Field, Group, and Collection names, file paths, and person ids. Real ones
// are far shorter; the bound stops a runaway value.
export const MAX_REFERENCE_LENGTH = 1_024;
// A formula or condition is one expression. Anything longer belongs in a
// code step.
export const MAX_EXPRESSION_LENGTH = 2_000;
// Message text and literal text values. An automation's message is a note,
// not a report; a report belongs in a file.
export const MAX_AUTOMATION_TEXT_LENGTH = 4_000;
// About 100 lines. Longer code reads and diffs better in its own file.
export const MAX_INLINE_CODE_LENGTH = 8_000;
// 50 automations of 25 typical steps take about 170 KB. Every computer that
// runs the Collection's automations parses the whole file whenever it
// changes, and at this bound a parse takes about 10 ms.
export const MAX_AUTOMATIONS_FILE_BYTES = 256 * 1024;

type AutomationLiteral = string | number | boolean | null;

type AutomationValue =
  | { kind: "literal"; value: AutomationLiteral }
  /** `expression` is the formula without its leading "=". */
  | { kind: "formula"; expression: string };

interface AutomationFieldValue {
  field: string;
  value: AutomationValue;
}

const AUTOMATION_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

const AUTOMATION_SCHEDULE_FREQUENCIES = ["hour", "day", "weekday", "week", "month"] as const;

// `at` is "HH:MM" on a 24-hour clock, or ":MM" past each hour for an hourly
// schedule. Without `at` in the file, a schedule runs at "00:00" or ":00".
// Without `days`, a weekly schedule runs on Monday and a monthly schedule on
// the 1st. The parser fills these defaults in, so the model is explicit.
type AutomationScheduleTrigger =
  | { kind: "schedule"; every: "hour" | "day" | "weekday"; at: string; timezone: string }
  | { kind: "schedule"; every: "week"; at: string; days: AutomationWeekday[]; timezone: string }
  | { kind: "schedule"; every: "month"; at: string; days: number[]; timezone: string };

type AutomationTrigger =
  | { kind: "record-added" }
  /** `fields` is null when any field change counts. */
  | { kind: "record-changed"; fields: string[] | null }
  | { kind: "record-removed" }
  /** `to` is null when any new value counts. */
  | { kind: "field-changed"; field: string; to: AutomationValue | null }
  /** Fires when a record that did not match the condition starts to match it. */
  | { kind: "starts-matching"; condition: string }
  | AutomationScheduleTrigger
  | { kind: "button"; field: string }
  | { kind: "group-message"; group: string; startsWith: string | null };

type AutomationStep =
  /**
   * Sets fields on the triggering record, or on the records bound to
   * `records` by an earlier find or add-record step.
   */
  | { kind: "set"; values: AutomationFieldValue[]; records: string | null }
  /** `collection` is null for this Collection. */
  | { kind: "add-record"; values: AutomationFieldValue[]; collection: string | null; as: string | null }
  | { kind: "find"; condition: string; collection: string | null; as: string }
  | { kind: "if"; if: string; do: AutomationStep[]; otherwise: AutomationStep[] }
  | { kind: "notify"; text: string; to: AutomationValue[] }
  | { kind: "post"; text: string; group: string }
  | { kind: "direct-message"; text: string; to: AutomationValue[] }
  /**
   * A personal step (ADR 0012): it uses the reach of `person`, a verified
   * user id. Whether the step may run is decided at run time.
   */
  | { kind: "wake-agent"; text: string; person: string }
  | { kind: "run"; code: string; as: string | null }
  /** `file` is relative to the Collection's folder. */
  | { kind: "run-file"; file: string; as: string | null };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  when: AutomationTrigger;
  /** The "Only if" condition, or null. */
  if: string | null;
  do: AutomationStep[];
}

export const AUTOMATION_DIAGNOSTIC_CODES = [
  // Problems with the whole file.
  "invalid-yaml",
  "file-too-large",
  "root-not-mapping",
  "unsupported-version",
  // Problems with a property, in the file or in one automation.
  "unknown-property",
  "missing-property",
  "expected-mapping",
  "expected-sequence",
  "expected-text",
  "expected-boolean",
  "expected-scalar",
  "expected-empty",
  "empty-value",
  "too-long",
  "duplicate-value",
  "control-characters",
  // Problems in one automation.
  "invalid-id",
  "missing-kind",
  "multiple-kinds",
  "unexpected-formula-marker",
  "number-not-finite",
  "invalid-template",
  "invalid-path",
  "reserved-field-name",
  "invalid-binding-name",
  "unknown-binding",
  "step-needs-record",
  "invalid-frequency",
  "invalid-time",
  "invalid-day",
  "invalid-timezone",
  "too-many-automations",
  "too-many-steps",
  "if-too-deep",
] as const;

export type AutomationDiagnosticCode = (typeof AUTOMATION_DIAGNOSTIC_CODES)[number];

export interface AutomationDiagnostic {
  code: AutomationDiagnosticCode;
  /** A JSON Pointer from the root of the file, such as "/automations/0/do/1". */
  path: string;
  /** The 1-based line of an `invalid-yaml` problem, when js-yaml reports one. */
  line?: number;
}

export type AutomationEntry =
  | { status: "valid"; automation: Automation }
  | {
      status: "invalid";
      /** The entry's `id` and `name` when they are text, for display. */
      id: string | null;
      name: string | null;
      diagnostics: AutomationDiagnostic[];
      /** The entry as YAML loaded it. The writer writes it back unchanged. */
      raw: unknown;
    };

// An unreadable file has no entries. Do not write over it without the
// person's agreement: the writer cannot keep what it could not read.
export type AutomationsFileParseResult =
  | { status: "read"; entries: AutomationEntry[] }
  | { status: "unreadable"; diagnostic: AutomationDiagnostic };

export type AutomationTextPart =
  | { kind: "text"; text: string }
  | { kind: "expression"; expression: string };

// Mappings load as Maps, so keys keep their order and a key such as
// "__proto__" stays data. Anchors and aliases are refused: the writer cannot
// keep them, and an alias can make a small file expensive to walk.
const AUTOMATIONS_YAML_SCHEMA = CORE_SCHEMA.withTags(realMapTag);
const MAX_YAML_DEPTH = 32;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A binding name is used in formulas, so it must be a JavaScript identifier.
const BINDING_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DAY_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const HOUR_TIME_PATTERN = /^:[0-5]\d$/;

const TRIGGER_OPTIONS = {
  "record-added": [],
  "record-changed": [],
  "record-removed": [],
  "field-changed": ["to"],
  "starts-matching": [],
  schedule: ["at", "days", "timezone"],
  button: [],
  "group-message": ["starts-with"],
} as const satisfies Record<AutomationTrigger["kind"], readonly string[]>;

const STEP_OPTIONS = {
  set: ["records"],
  "add-record": ["collection", "as"],
  find: ["collection", "as"],
  if: ["do", "otherwise"],
  notify: ["to"],
  post: ["group"],
  "direct-message": ["to"],
  "wake-agent": ["person"],
  run: ["as"],
  "run-file": ["as"],
} as const satisfies Record<AutomationStep["kind"], readonly string[]>;

// Triggers that have a triggering record, which a `set` step without
// `records` changes.
const RECORD_TRIGGERS: ReadonlySet<AutomationTrigger["kind"]> = new Set([
  "record-added",
  "record-changed",
  "field-changed",
  "starts-matching",
  "button",
]);

type Issues = AutomationDiagnostic[];
type BindingKind = "records" | "value";

// Any diagnostic discards the whole automation, so a reader returns null only
// where the caller needs a value to build the model.
interface StepContext {
  issues: Issues;
  hasRecord: boolean;
  stepCount: number;
  boundNames: Set<string>;
}

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isEmptyYamlDocument(text: string): boolean {
  return text.split(/\r?\n/u).every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith("#");
  });
}

function unreadable(
  code: AutomationDiagnosticCode,
  path: string,
  line?: number,
): AutomationsFileParseResult {
  return {
    status: "unreadable",
    diagnostic: line === undefined ? { code, path } : { code, path, line },
  };
}

// A mapping whose keys are all in `allowed`. Other keys are reported.
function readMapping(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: Issues,
): Map<string, unknown> | null {
  if (!(value instanceof Map)) {
    issues.push({ code: "expected-mapping", path });
    return null;
  }
  const entries = new Map<string, unknown>();
  for (const [key, entry] of value) {
    const text = yamlKeyText(key);
    if (text !== null && allowed.includes(text)) {
      entries.set(text, entry);
    } else {
      issues.push({ code: "unknown-property", path: pointer(path, text ?? "<non-text-key>") });
    }
  }
  return entries;
}

// A trigger or step: exactly one kind key, plus that kind's options.
function readKind<Kind extends string>(
  value: unknown,
  path: string,
  options: Readonly<Record<Kind, readonly string[]>>,
  issues: Issues,
): { kind: Kind; entries: Map<string, unknown> } | null {
  if (!(value instanceof Map)) {
    issues.push({ code: "expected-mapping", path });
    return null;
  }
  const kinds = [...value.keys()].filter(
    (key): key is Kind => typeof key === "string" && Object.hasOwn(options, key),
  );
  const [kind] = kinds;
  if (kind === undefined || kinds.length > 1) {
    issues.push({ code: kind === undefined ? "missing-kind" : "multiple-kinds", path });
    return null;
  }
  const entries = readMapping(value, path, [kind, ...options[kind]], issues);
  return entries === null ? null : { kind, entries };
}

// The value of a required key, or undefined after reporting it missing.
function required(
  entries: Map<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
): unknown {
  if (!entries.has(key)) issues.push({ code: "missing-property", path: pointer(path, key) });
  return entries.get(key);
}

// Readers take undefined for an absent key and return null without a
// diagnostic, so optional keys need no separate check.
function readText(value: unknown, path: string, max: number, issues: Issues): string | null {
  if (value === undefined) return null;
  if (value !== null && typeof value !== "string") {
    issues.push({ code: "expected-text", path });
    return null;
  }
  if (value === null || value.trim().length === 0) {
    issues.push({ code: "empty-value", path });
    return null;
  }
  if (value.length > max) {
    issues.push({ code: "too-long", path });
    return null;
  }
  return value;
}

function readReference(value: unknown, path: string, issues: Issues): string | null {
  return readText(value, path, MAX_REFERENCE_LENGTH, issues);
}

function readPath(value: unknown, path: string, issues: Issues): string | null {
  const text = readReference(value, path, issues);
  if (text !== null && !isNormalizedRelativePath(text)) {
    issues.push({ code: "invalid-path", path });
    return null;
  }
  return text;
}

function readCondition(value: unknown, path: string, issues: Issues): string | null {
  const text = readText(value, path, MAX_EXPRESSION_LENGTH, issues);
  if (text !== null && text.trimStart().startsWith("=")) {
    issues.push({ code: "unexpected-formula-marker", path });
    return null;
  }
  return text;
}

function readTemplate(value: unknown, path: string, issues: Issues): string | null {
  const text = readText(value, path, MAX_AUTOMATION_TEXT_LENGTH, issues);
  if (text !== null && automationTextParts(text) === null) {
    issues.push({ code: "invalid-template", path });
    return null;
  }
  return text;
}

function readValue(value: unknown, path: string, issues: Issues): AutomationValue | null {
  if (typeof value === "string" && value.startsWith("=")) {
    const expression = readText(value.slice(1), path, MAX_EXPRESSION_LENGTH, issues);
    return expression === null ? null : { kind: "formula", expression };
  }
  if (typeof value === "string" && value.length > MAX_AUTOMATION_TEXT_LENGTH) {
    issues.push({ code: "too-long", path });
    return null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push({ code: "number-not-finite", path });
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { kind: "literal", value };
  }
  issues.push({ code: "expected-scalar", path });
  return null;
}

function readSequence(value: unknown, path: string, issues: Issues): unknown[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    issues.push({ code: "expected-sequence", path });
    return null;
  }
  if (value.length === 0) {
    issues.push({ code: "empty-value", path });
    return null;
  }
  return value;
}

// People are verified user ids, or formulas that return them.
function readPeople(value: unknown, path: string, issues: Issues): AutomationValue[] | null {
  const items = readSequence(value, path, issues);
  if (items === null) return null;
  const people: AutomationValue[] = [];
  items.forEach((item, index) => {
    const itemPath = pointer(path, index);
    if (typeof item !== "string") {
      issues.push({ code: "expected-text", path: itemPath });
      return;
    }
    const person = item.startsWith("=")
      ? readValue(item, itemPath, issues)
      : readReference(item, itemPath, issues);
    if (typeof person === "string") people.push({ kind: "literal", value: person });
    else if (person !== null) people.push(person);
  });
  return people;
}

function readFieldList(value: unknown, path: string, issues: Issues): string[] | null {
  const items = readSequence(value, path, issues);
  if (items === null) return null;
  const fields: string[] = [];
  items.forEach((item, index) => {
    const field = readReference(item, pointer(path, index), issues);
    if (field !== null && fields.includes(field)) {
      issues.push({ code: "duplicate-value", path: pointer(path, index) });
    } else if (field !== null) {
      fields.push(field);
    }
  });
  return fields;
}

function readFieldValues(
  value: unknown,
  path: string,
  issues: Issues,
): AutomationFieldValue[] | null {
  if (value === null || (value instanceof Map && value.size === 0)) {
    issues.push({ code: "empty-value", path });
    return null;
  }
  if (!(value instanceof Map)) {
    issues.push({ code: "expected-mapping", path });
    return null;
  }
  const values: AutomationFieldValue[] = [];
  for (const [key, entry] of value) {
    const keyText = yamlKeyText(key);
    const fieldPath = pointer(path, keyText ?? "<non-text-key>");
    if (keyText === null) {
      issues.push({ code: "expected-text", path: fieldPath });
      continue;
    }
    const field = readReference(keyText, fieldPath, issues);
    const fieldValue = readValue(entry, fieldPath, issues);
    if (field === RECORD_ID_FRONTMATTER_KEY) {
      issues.push({ code: "reserved-field-name", path: fieldPath });
    } else if (values.some((existing) => existing.field === field)) {
      issues.push({ code: "duplicate-value", path: fieldPath });
    } else if (field !== null && fieldValue !== null) {
      values.push({ field, value: fieldValue });
    }
  }
  return values;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Days in calendar order, whatever order the file lists them in.
function readDays<Day extends string | number>(
  value: unknown,
  path: string,
  allowed: readonly Day[],
  issues: Issues,
): Day[] | null {
  const items = readSequence(value, path, issues);
  if (items === null) return null;
  const days = new Set<unknown>();
  items.forEach((item, index) => {
    const dayPath = pointer(path, index);
    if (!allowed.some((day) => day === item)) {
      issues.push({ code: "invalid-day", path: dayPath });
    } else if (days.has(item)) {
      issues.push({ code: "duplicate-value", path: dayPath });
    } else {
      days.add(item);
    }
  });
  return allowed.filter((day) => days.has(day));
}

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

function readSchedule(
  every: unknown,
  entries: Map<string, unknown>,
  path: string,
  issues: Issues,
): AutomationScheduleTrigger | null {
  const frequency = AUTOMATION_SCHEDULE_FREQUENCIES.find((candidate) => candidate === every);
  if (frequency === undefined) {
    issues.push({ code: "invalid-frequency", path: pointer(path, "schedule") });
    return null;
  }

  let at: string = frequency === "hour" ? ":00" : "00:00";
  if (entries.has("at")) {
    const rawAt = entries.get("at");
    const pattern = frequency === "hour" ? HOUR_TIME_PATTERN : DAY_TIME_PATTERN;
    if (typeof rawAt === "string" && pattern.test(rawAt)) at = rawAt;
    else issues.push({ code: "invalid-time", path: pointer(path, "at") });
  }

  const timezonePath = pointer(path, "timezone");
  const timezone = readReference(required(entries, "timezone", path, issues), timezonePath, issues);
  if (timezone !== null && !isTimeZone(timezone)) {
    issues.push({ code: "invalid-timezone", path: timezonePath });
  }
  if (timezone === null) return null;

  const rawDays = entries.get("days");
  const daysPath = pointer(path, "days");
  if (frequency === "week") {
    const days =
      rawDays === undefined ? ["mon" as const] : readDays(rawDays, daysPath, AUTOMATION_WEEKDAYS, issues);
    return days === null ? null : { kind: "schedule", every: frequency, at, days, timezone };
  }
  if (frequency === "month") {
    const days = rawDays === undefined ? [1] : readDays(rawDays, daysPath, MONTH_DAYS, issues);
    return days === null ? null : { kind: "schedule", every: frequency, at, days, timezone };
  }
  if (rawDays !== undefined) issues.push({ code: "unknown-property", path: daysPath });
  return { kind: "schedule", every: frequency, at, timezone };
}

function readTrigger(value: unknown, path: string, issues: Issues): AutomationTrigger | null {
  const shaped = typeof value === "string" ? new Map([[value, null]]) : value;
  const read = readKind(shaped, path, TRIGGER_OPTIONS, issues);
  if (read === null) return null;
  const { kind, entries } = read;
  const argument = entries.get(kind);
  const argumentPath = pointer(path, kind);
  switch (kind) {
    case "record-added":
    case "record-removed":
      if (argument !== null) issues.push({ code: "expected-empty", path: argumentPath });
      return { kind };
    case "record-changed": {
      const fields = argument === null ? null : readFieldList(argument, argumentPath, issues);
      return { kind, fields };
    }
    case "field-changed": {
      const field = readReference(argument, argumentPath, issues);
      const to = entries.has("to") ? readValue(entries.get("to"), pointer(path, "to"), issues) : null;
      return field === null ? null : { kind, field, to };
    }
    case "starts-matching": {
      const condition = readCondition(argument, argumentPath, issues);
      return condition === null ? null : { kind, condition };
    }
    case "schedule":
      return readSchedule(argument, entries, path, issues);
    case "button": {
      const field = readReference(argument, argumentPath, issues);
      return field === null ? null : { kind, field };
    }
    case "group-message": {
      const group = readReference(argument, argumentPath, issues);
      const startsWith = readText(
        entries.get("starts-with"),
        pointer(path, "starts-with"),
        MAX_AUTOMATION_TEXT_LENGTH,
        issues,
      );
      return group === null ? null : { kind, group, startsWith };
    }
  }
}

// Binds a step's result to `as`, so later steps can use it. Names are unique
// in the whole automation.
function bindName(
  value: unknown,
  path: string,
  kind: BindingKind,
  scope: Map<string, BindingKind>,
  context: StepContext,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !BINDING_NAME_PATTERN.test(value)) {
    context.issues.push({ code: "invalid-binding-name", path });
    return null;
  }
  if (context.boundNames.has(value)) {
    context.issues.push({ code: "duplicate-value", path });
    return null;
  }
  context.boundNames.add(value);
  scope.set(value, kind);
  return value;
}

// Steps in order. `outerScope` holds the names bound before this list. A name
// bound inside an if step is visible only later in the same branch.
function readSteps(
  value: unknown,
  path: string,
  context: StepContext,
  outerScope: ReadonlyMap<string, BindingKind>,
  ifDepth: number,
): AutomationStep[] | null {
  const items = readSequence(value, path, context.issues);
  if (items === null) return null;
  const scope = new Map(outerScope);
  const steps: AutomationStep[] = [];
  items.forEach((item, index) => {
    const stepPath = pointer(path, index);
    context.stepCount += 1;
    if (context.stepCount === MAX_AUTOMATION_STEPS + 1) {
      context.issues.push({ code: "too-many-steps", path: stepPath });
    }
    const step = readStep(item, stepPath, context, scope, ifDepth);
    if (step !== null) steps.push(step);
  });
  return steps;
}

function readStep(
  value: unknown,
  path: string,
  context: StepContext,
  scope: Map<string, BindingKind>,
  ifDepth: number,
): AutomationStep | null {
  const { issues } = context;
  const read = readKind(value, path, STEP_OPTIONS, issues);
  if (read === null) return null;
  const { kind, entries } = read;
  const argument = entries.get(kind);
  const argumentPath = pointer(path, kind);
  const option = (key: string) => pointer(path, key);
  switch (kind) {
    case "set": {
      const values = readFieldValues(argument, argumentPath, issues);
      const records = entries.get("records");
      if (records === undefined && !context.hasRecord) {
        issues.push({ code: "step-needs-record", path });
      }
      if (records !== undefined && (typeof records !== "string" || scope.get(records) !== "records")) {
        issues.push({ code: "unknown-binding", path: option("records") });
      }
      if (values === null) return null;
      return { kind, values, records: typeof records === "string" ? records : null };
    }
    case "add-record": {
      const values = readFieldValues(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const as = bindName(entries.get("as"), option("as"), "records", scope, context);
      return values === null ? null : { kind, values, collection, as };
    }
    case "find": {
      const condition = readCondition(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const as = bindName(required(entries, "as", path, issues), option("as"), "records", scope, context);
      return condition === null || as === null ? null : { kind, condition, collection, as };
    }
    case "if": {
      if (ifDepth >= MAX_IF_DEPTH) {
        issues.push({ code: "if-too-deep", path });
        return null;
      }
      const condition = readCondition(argument, argumentPath, issues);
      const branch = readSteps(required(entries, "do", path, issues), option("do"), context, scope, ifDepth + 1);
      const otherwise = entries.has("otherwise")
        ? readSteps(entries.get("otherwise"), option("otherwise"), context, scope, ifDepth + 1)
        : [];
      if (condition === null || branch === null || otherwise === null) return null;
      return { kind, if: condition, do: branch, otherwise };
    }
    case "notify":
    case "direct-message": {
      const text = readTemplate(argument, argumentPath, issues);
      const to = readPeople(required(entries, "to", path, issues), option("to"), issues);
      return text === null || to === null ? null : { kind, text, to };
    }
    case "post": {
      const text = readTemplate(argument, argumentPath, issues);
      const group = readReference(required(entries, "group", path, issues), option("group"), issues);
      return text === null || group === null ? null : { kind, text, group };
    }
    case "wake-agent": {
      const text = readTemplate(argument, argumentPath, issues);
      const person = readReference(required(entries, "person", path, issues), option("person"), issues);
      return text === null || person === null ? null : { kind, text, person };
    }
    case "run": {
      const code = readText(argument, argumentPath, MAX_INLINE_CODE_LENGTH, issues);
      const as = bindName(entries.get("as"), option("as"), "value", scope, context);
      return code === null ? null : { kind, code, as };
    }
    case "run-file": {
      const file = readPath(argument, argumentPath, issues);
      const as = bindName(entries.get("as"), option("as"), "value", scope, context);
      return file === null ? null : { kind, file, as };
    }
  }
}

function readAutomation(
  value: unknown,
  path: string,
  issues: Issues,
  seenIds: Set<string>,
): Automation | null {
  const entries = readMapping(value, path, ["id", "name", "enabled", "when", "if", "do"], issues);
  if (entries === null) return null;
  const property = (key: string) => pointer(path, key);

  const id = readText(
    required(entries, "id", path, issues),
    property("id"),
    MAX_AUTOMATION_ID_LENGTH,
    issues,
  );
  if (id !== null && !ID_PATTERN.test(id)) {
    issues.push({ code: "invalid-id", path: property("id") });
  } else if (id !== null && seenIds.has(id)) {
    issues.push({ code: "duplicate-value", path: property("id") });
  } else if (id !== null) {
    seenIds.add(id);
  }

  const name = readText(
    required(entries, "name", path, issues),
    property("name"),
    MAX_AUTOMATION_NAME_LENGTH,
    issues,
  );
  if (name !== null && hasPreferredNameControlCharacters(name)) {
    issues.push({ code: "control-characters", path: property("name") });
  }

  const enabled = entries.has("enabled") ? entries.get("enabled") : true;
  if (typeof enabled !== "boolean") {
    issues.push({ code: "expected-boolean", path: property("enabled") });
  }

  const rawWhen = required(entries, "when", path, issues);
  const when = rawWhen === undefined ? null : readTrigger(rawWhen, property("when"), issues);
  const condition = entries.has("if") ? readCondition(entries.get("if"), property("if"), issues) : null;
  const context: StepContext = {
    issues,
    // An unreadable trigger already fails the automation, so do not guess
    // whether it has a record.
    hasRecord: when === null || RECORD_TRIGGERS.has(when.kind),
    stepCount: 0,
    boundNames: new Set(),
  };
  const steps = readSteps(required(entries, "do", path, issues), property("do"), context, new Map(), 0);

  if (
    issues.length > 0 ||
    id === null ||
    name === null ||
    typeof enabled !== "boolean" ||
    when === null ||
    steps === null
  ) {
    return null;
  }
  return { id, name, enabled, when, if: condition, do: steps };
}

function invalidEntry(raw: unknown, diagnostics: AutomationDiagnostic[]): AutomationEntry {
  const text = (key: string) => {
    const value = raw instanceof Map ? raw.get(key) : undefined;
    return typeof value === "string" ? value : null;
  };
  return { status: "invalid", id: text("id"), name: text("name"), diagnostics, raw };
}

export function parseAutomationsFile(text: string): AutomationsFileParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_AUTOMATIONS_FILE_BYTES) {
    return unreadable("file-too-large", "");
  }
  if (isEmptyYamlDocument(text)) return { status: "read", entries: [] };

  let root: unknown;
  try {
    root = load(text, {
      schema: AUTOMATIONS_YAML_SCHEMA,
      maxAliases: 0,
      maxDepth: MAX_YAML_DEPTH,
    });
  } catch (error) {
    const line = error instanceof YAMLException && error.mark ? error.mark.line + 1 : undefined;
    return unreadable("invalid-yaml", "", line);
  }
  if (root === null) return { status: "read", entries: [] };
  if (!(root instanceof Map)) return unreadable("root-not-mapping", "");
  if (root.get("version") !== AUTOMATIONS_FILE_VERSION) {
    return unreadable("unsupported-version", "/version");
  }
  for (const key of root.keys()) {
    if (key !== "version" && key !== "automations") {
      return unreadable("unknown-property", pointer("", yamlKeyText(key) ?? "<non-text-key>"));
    }
  }
  const list = root.get("automations");
  if (list === undefined || list === null) return { status: "read", entries: [] };
  if (!Array.isArray(list)) return unreadable("expected-sequence", "/automations");

  const seenIds = new Set<string>();
  const entries = list.map((raw, index): AutomationEntry => {
    const path = pointer("/automations", index);
    if (index >= MAX_AUTOMATIONS) {
      return invalidEntry(raw, [{ code: "too-many-automations", path }]);
    }
    const issues: Issues = [];
    const automation = readAutomation(raw, path, issues, seenIds);
    return automation === null ? invalidEntry(raw, issues) : { status: "valid", automation };
  });
  return { status: "read", entries };
}

/**
 * Splits a message template into text and expressions, or returns null when
 * a brace is unmatched or an expression is empty.
 */
export function automationTextParts(template: string): AutomationTextPart[] | null {
  const parts: AutomationTextPart[] = [];
  let text = "";
  let index = 0;
  while (index < template.length) {
    const char = template[index];
    if ((char === "{" || char === "}") && template[index + 1] === char) {
      text += char;
      index += 2;
      continue;
    }
    if (char === "}") return null;
    if (char !== "{") {
      text += char;
      index += 1;
      continue;
    }
    let depth = 1;
    let end = index + 1;
    for (; end < template.length && depth > 0; end += 1) {
      if (template[end] === "{") depth += 1;
      else if (template[end] === "}") depth -= 1;
    }
    const expression = template.slice(index + 1, end - 1);
    if (depth > 0 || expression.trim().length === 0) return null;
    if (text.length > 0) parts.push({ kind: "text", text });
    parts.push({ kind: "expression", expression });
    text = "";
    index = end;
  }
  if (text.length > 0) parts.push({ kind: "text", text });
  return parts;
}

// The writer builds Maps so keys keep the order written here, and a field
// named "__proto__" or "2024" stays in place.
function valueYaml(value: AutomationValue): AutomationLiteral {
  if (value.kind === "formula") return `=${value.expression}`;
  if (typeof value.value === "string" && value.value.startsWith("=")) {
    return `=${JSON.stringify(value.value)}`;
  }
  return value.value;
}

function fieldValuesYaml(values: readonly AutomationFieldValue[]): Map<string, AutomationLiteral> {
  return new Map(values.map(({ field, value }) => [field, valueYaml(value)]));
}

// A kind key and its argument, then the options that are not null.
function withOptions(
  kind: string,
  argument: unknown,
  options: ReadonlyArray<readonly [string, unknown]>,
): Map<string, unknown> {
  const entries = new Map<string, unknown>([[kind, argument]]);
  for (const [key, value] of options) {
    if (value !== null) entries.set(key, value);
  }
  return entries;
}

function triggerYaml(trigger: AutomationTrigger): unknown {
  switch (trigger.kind) {
    case "record-added":
    case "record-removed":
      return trigger.kind;
    case "record-changed":
      return trigger.fields === null ? trigger.kind : withOptions(trigger.kind, trigger.fields, []);
    case "field-changed": {
      // `to: null` means the field was cleared, so it cannot pass through
      // withOptions, which leaves nulls out.
      const entries = withOptions(trigger.kind, trigger.field, []);
      if (trigger.to !== null) entries.set("to", valueYaml(trigger.to));
      return entries;
    }
    case "starts-matching":
      return withOptions(trigger.kind, trigger.condition, []);
    case "schedule":
      return withOptions(trigger.kind, trigger.every, [
        ["at", trigger.at],
        ["days", trigger.every === "week" || trigger.every === "month" ? trigger.days : null],
        ["timezone", trigger.timezone],
      ]);
    case "button":
      return withOptions(trigger.kind, trigger.field, []);
    case "group-message":
      return withOptions(trigger.kind, trigger.group, [["starts-with", trigger.startsWith]]);
  }
}

function stepYaml(step: AutomationStep): Map<string, unknown> {
  switch (step.kind) {
    case "set":
      return withOptions(step.kind, fieldValuesYaml(step.values), [["records", step.records]]);
    case "add-record":
      return withOptions(step.kind, fieldValuesYaml(step.values), [
        ["collection", step.collection],
        ["as", step.as],
      ]);
    case "find":
      return withOptions(step.kind, step.condition, [
        ["collection", step.collection],
        ["as", step.as],
      ]);
    case "if":
      return withOptions(step.kind, step.if, [
        ["do", step.do.map(stepYaml)],
        ["otherwise", step.otherwise.length === 0 ? null : step.otherwise.map(stepYaml)],
      ]);
    case "notify":
    case "direct-message":
      return withOptions(step.kind, step.text, [["to", step.to.map(valueYaml)]]);
    case "post":
      return withOptions(step.kind, step.text, [["group", step.group]]);
    case "wake-agent":
      return withOptions(step.kind, step.text, [["person", step.person]]);
    case "run":
      return withOptions(step.kind, step.code, [["as", step.as]]);
    case "run-file":
      return withOptions(step.kind, step.file, [["as", step.as]]);
  }
}

function automationYaml(automation: Automation): Map<string, unknown> {
  return new Map<string, unknown>([
    ["id", automation.id],
    ["name", automation.name],
    ...(automation.enabled ? [] : [["enabled", false] as const]),
    ["when", triggerYaml(automation.when)],
    ...(automation.if === null ? [] : [["if", automation.if] as const]),
    ["do", automation.do.map(stepYaml)],
  ]);
}

function indent(text: string): string {
  return text.replace(/^(?=.)/gmu, "  ");
}

// YAML 1.1 readers, such as PyYAML, read an unquoted 12:30 as the number 750.
const SEXAGESIMAL = /^\d+(?::\d+)+$/;

function quoteSexagesimal(documents: YamlDocument[]): void {
  visit(documents, (node) => {
    if (node.kind === "scalar" && SEXAGESIMAL.test(node.value)) node.style.singleQuoted = true;
  });
}

/**
 * The file text for these entries: valid automations in a fixed key order,
 * invalid entries as they were read, and a blank line between entries.
 */
export function writeAutomationsFile(entries: readonly AutomationEntry[]): string {
  const header = `version: ${AUTOMATIONS_FILE_VERSION}\n`;
  if (entries.length === 0) return `${header}automations: []\n`;
  const items = entries.map((entry) =>
    indent(
      dump([entry.status === "valid" ? automationYaml(entry.automation) : entry.raw], {
        schema: AUTOMATIONS_YAML_SCHEMA,
        lineWidth: -1,
        noRefs: true,
        transform: quoteSexagesimal,
      }),
    ),
  );
  return `${header}automations:\n${items.join("\n")}`;
}
