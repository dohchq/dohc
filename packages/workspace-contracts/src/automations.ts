import {
  CORE_SCHEMA,
  defineMappingTag,
  dump,
  load,
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
//             Finished on: '=today()'
//
// `when` holds one trigger and `do` holds steps that run in order. A trigger
// or step is a mapping with exactly one kind key, such as `field-changed` or
// `set`. The kind key holds the main argument, and the other keys are that
// kind's options. A trigger without an argument can be written as its kind
// alone: `when: record-added`.
//
// Text that starts with "=" is a formula: a JavaScript expression after the
// "=". Only values take formulas.
//
// - A value is a scalar or a list of scalars. Text that starts with one "="
//   is a formula: `Finished on: =today()`. Text that starts with "==" is
//   literal text without its first "=", so `Code: ==5` stores "=5". Any other
//   scalar is itself. A list is always literal; its items follow the "=="
//   rule and cannot be formulas.
// - A formula in a trigger's `to:` computes the value the field must change
//   to. It is compared for equality; it is not a condition.
// - A condition (`if`, `find`, `starts-matching`) is always an expression, so
//   it has no "=".
// - Message text (`notify`, `post`, `direct-message`, `wake-agent`) is a
//   template. `{expression}` inserts a value, and `{{` and `}}` write one
//   brace. An expression ends at the first "}" outside its own braces,
//   strings, template literals, regular expressions, and comments. To start
//   a message with "=", write `{"="}`.
// - All other text, such as a name or a reference, cannot start with "=".
//
// The writer quotes every formula. Quote a formula you write by hand when it
// contains " #": YAML reads the rest of an unquoted line as a comment.
//
// `as` names a step's result for later steps and formulas. A find step binds
// a list of records, an add-record step binds the one record it added, and a
// run step binds the value its code returns. A name is a JavaScript
// identifier that is not in AUTOMATION_RESERVED_NAMES: a formula name, a
// reserved word, or a standard global such as Math.
//
// Fields, Groups, and Button fields are referenced by name. Collections are
// workspace-relative folder paths. A code file is relative to the
// Collection's folder and cannot leave it, so the people who can edit the
// automation are the people who can edit its code.
//
// An invalid automation turns off only itself and keeps its own diagnostics.
// That includes a key written twice inside it. A problem with the whole file,
// such as broken YAML, an unknown version, or a repeated top-level key, turns
// every automation off with one diagnostic.
//
// js-yaml cannot edit a document in place, so writeAutomationsFile rewrites
// the whole file. The output is deterministic, so a save changes only the
// lines of the automation that changed. Comments and hand formatting do not
// survive the first save through the writer. The writer reads its output
// back and refuses text that does not read as the same data.

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

// The names every formula can use: the values record, previous, trigger,
// person, and message (for a Group trigger), and the helpers. The evaluator
// provides exactly these.
export const AUTOMATION_FORMULA_NAMES = [
  "record",
  "previous",
  "trigger",
  "person",
  "message",
  "today",
  "now",
  "dateAdd",
  "dateBetween",
  "formatDate",
  "lower",
  "upper",
  "trim",
  "contains",
  "join",
  "length",
  "sum",
  "min",
  "max",
  "round",
] as const;

// Names a binding cannot take. A binding is a plain name in every later
// formula, so one of these would change what those formulas mean: the
// formula names, JavaScript's reserved words, including strict-mode ones,
// and the properties of the global object in ECMA-262 (with Annex B) and
// ECMA-402.
export const AUTOMATION_RESERVED_NAMES: readonly string[] = [
  ...AUTOMATION_FORMULA_NAMES,
  ...[
    "await break case catch class const continue debugger default delete do else enum",
    "export extends false finally for function if implements import in instanceof",
    "interface let new null package private protected public return static super switch",
    "this throw true try typeof var void while with yield arguments",
    "globalThis Infinity NaN undefined eval isFinite isNaN parseFloat parseInt decodeURI",
    "decodeURIComponent encodeURI encodeURIComponent escape unescape AggregateError Array",
    "ArrayBuffer AsyncDisposableStack BigInt BigInt64Array BigUint64Array Boolean DataView",
    "Date DisposableStack Error EvalError FinalizationRegistry Float16Array Float32Array",
    "Float64Array Function Int8Array Int16Array Int32Array Iterator Map Number Object",
    "Promise Proxy RangeError ReferenceError RegExp Set SharedArrayBuffer String",
    "SuppressedError Symbol SyntaxError TypeError Uint8Array Uint8ClampedArray Uint16Array",
    "Uint32Array URIError WeakMap WeakRef WeakSet Atomics JSON Math Reflect Intl",
  ]
    .join(" ")
    .split(" "),
];
const RESERVED_NAMES: ReadonlySet<string> = new Set(AUTOMATION_RESERVED_NAMES);

type AutomationScalar = string | number | boolean | null;

type AutomationValue =
  | { kind: "literal"; value: AutomationScalar | AutomationScalar[] }
  /** `expression` is the formula without its leading "=". */
  | { kind: "formula"; expression: string };

interface AutomationFieldValue {
  field: string;
  value: AutomationValue;
}

const AUTOMATION_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

const AUTOMATION_SCHEDULE_FREQUENCIES = ["hour", "day", "weekday", "week", "month"] as const;

// A schedule runs in `timezone`, an IANA name such as "Europe/London".
// `weekday` runs Monday to Friday there. `at` is "HH:MM" on a 24-hour clock,
// or ":MM" past each hour for an hourly schedule. `days` are in calendar
// order. A monthly day past the end of a shorter month, such as 31 in April,
// runs on that month's last day. Without `at` in the file, a schedule runs at
// "00:00" or ":00". Without `days`, a weekly schedule runs on Monday and a
// monthly schedule on the 1st. The parser fills these defaults in, so the
// model is explicit.
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
   * Sets fields on the triggering record, or on the record or records bound
   * to `records` by an earlier add-record or find step.
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
  "duplicate-key",
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
  // A write that would not read back as the same automation.
  "changed-on-reread",
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
      /** The entry as YAML loaded it. The writer writes the same data back. */
      raw: unknown;
    };

// An unreadable file has no entries. Do not write over it without the
// person's agreement: the writer cannot keep what it could not read.
export type AutomationsFileParseResult =
  | { status: "read"; entries: AutomationEntry[] }
  | { status: "unreadable"; diagnostic: AutomationDiagnostic };

export type AutomationsFileWriteResult =
  | { status: "ok"; text: string }
  /** The text would not read back as the same entries. Nothing was written. */
  | { status: "refused"; diagnostics: AutomationDiagnostic[] };

export type AutomationTextPart =
  | { kind: "text"; text: string }
  | { kind: "expression"; expression: string };

// Keys that a mapping repeats. js-yaml loads in json mode so a repeated key
// does not fail the whole file; this tag records it, and the reader turns
// off only the automation that holds it.
const REPEATED_KEYS = new WeakMap<Map<unknown, unknown>, unknown[]>();

// Mappings load as Maps, so keys keep their order and a key such as
// "__proto__" stays data.
const MAP_TAG = defineMappingTag<Map<unknown, unknown>>("tag:yaml.org,2002:map", {
  create: () => new Map(),
  addPair: (map, key, value) => {
    if (map.has(key)) REPEATED_KEYS.set(map, [...(REPEATED_KEYS.get(map) ?? []), key]);
    map.set(key, value);
    return "";
  },
  has: (map, key) => map.has(key),
  keys: (map) => map.keys(),
  get: (map, key) => map.get(key),
  identify: (data) => data instanceof Map,
});

// Anchors and aliases are refused: the writer cannot keep them, and an alias
// can make a small file expensive to walk.
const AUTOMATIONS_YAML_SCHEMA = CORE_SCHEMA.withTags(MAP_TAG);
const MAX_YAML_DEPTH = 32;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
// What a binding holds: one record, a list of records, or a code step's value.
type BindingKind = "record" | "records" | "value";

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

function keyPointer(parent: string, key: unknown): string {
  return pointer(parent, yamlKeyText(key) ?? "<non-text-key>");
}

function isEmptyYamlDocument(text: string): boolean {
  return text.split(/\r?\n/u).every((line) => {
    const trimmed = line.trim();
    return trimmed.length === 0 || trimmed.startsWith("#");
  });
}

function unreadable(code: AutomationDiagnosticCode, path: string, line?: number) {
  return {
    status: "unreadable" as const,
    diagnostic: line === undefined ? { code, path } : { code, path, line },
  };
}

function reportRepeatedKeys(value: unknown, path: string, issues: Issues): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => reportRepeatedKeys(item, pointer(path, index), issues));
  } else if (value instanceof Map) {
    for (const key of REPEATED_KEYS.get(value) ?? []) {
      issues.push({ code: "duplicate-key", path: keyPointer(path, key) });
    }
    for (const [key, entry] of value) reportRepeatedKeys(entry, keyPointer(path, key), issues);
  }
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
      issues.push({ code: "unknown-property", path: keyPointer(path, key) });
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

// Text in a place that takes no formula. Readers take undefined for an
// absent key and return null without a diagnostic, so optional keys need no
// separate check.
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
  if (value.startsWith("=")) {
    issues.push({ code: "unexpected-formula-marker", path });
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
  return readText(value, path, MAX_EXPRESSION_LENGTH, issues);
}

function readTemplate(value: unknown, path: string, issues: Issues): string | null {
  const text = readText(value, path, MAX_AUTOMATION_TEXT_LENGTH, issues);
  if (text !== null && automationTextParts(text) === null) {
    issues.push({ code: "invalid-template", path });
    return null;
  }
  return text;
}

function isFormula(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("=") && !value.startsWith("==");
}

// A literal scalar, or undefined after a diagnostic. Text that starts with
// "==" loses its first "="; text that starts with one "=" is a formula.
function readScalar(value: unknown, path: string, issues: Issues): AutomationScalar | undefined {
  if (isFormula(value)) {
    issues.push({ code: "unexpected-formula-marker", path });
    return undefined;
  }
  if (typeof value === "string") {
    const text = value.startsWith("==") ? value.slice(1) : value;
    if (text.length <= MAX_AUTOMATION_TEXT_LENGTH) return text;
    issues.push({ code: "too-long", path });
    return undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push({ code: "number-not-finite", path });
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  issues.push({ code: "expected-scalar", path });
  return undefined;
}

function readValue(value: unknown, path: string, issues: Issues): AutomationValue | null {
  if (isFormula(value)) {
    const expression = value.slice(1);
    if (expression.trim().length === 0) {
      issues.push({ code: "empty-value", path });
      return null;
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      issues.push({ code: "too-long", path });
      return null;
    }
    return { kind: "formula", expression };
  }
  if (Array.isArray(value)) {
    const items: AutomationScalar[] = [];
    value.forEach((item, index) => {
      const scalar = readScalar(item, pointer(path, index), issues);
      if (scalar !== undefined) items.push(scalar);
    });
    return items.length === value.length ? { kind: "literal", value: items } : null;
  }
  const scalar = readScalar(value, path, issues);
  return scalar === undefined ? null : { kind: "literal", value: scalar };
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
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push({ code: typeof item === "string" ? "empty-value" : "expected-text", path: itemPath });
      return;
    }
    const person = readValue(item, itemPath, issues);
    if (person !== null) people.push(person);
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
    const fieldPath = keyPointer(path, key);
    if (keyText === null) {
      issues.push({ code: "expected-text", path: fieldPath });
      continue;
    }
    const field = readReference(keyText, fieldPath, issues);
    const fieldValue = readValue(entry, fieldPath, issues);
    if (field === RECORD_ID_FRONTMATTER_KEY) {
      issues.push({ code: "reserved-field-name", path: fieldPath });
    } else if (values.some((existing) => existing.field === field)) {
      // Keys such as 2024 and "2024" differ in YAML but name one field.
      issues.push({ code: "duplicate-key", path: fieldPath });
    } else if (field !== null && fieldValue !== null) {
      values.push({ field, value: fieldValue });
    }
  }
  return values;
}

// An IANA name, spelled as IANA spells it. A fixed offset such as "+08:00"
// ignores daylight saving time, so it is refused. Intl may resolve a name to
// an alias from its own data, such as Asia/Kolkata to Asia/Calcutta, so only
// a difference in letter case counts as a misspelling.
function isTimeZoneName(value: string): boolean {
  if (!value.split("/").every((segment) => /^[A-Z]/.test(segment))) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return resolved === value || resolved.toLowerCase() !== value.toLowerCase();
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
  if (timezone !== null && !isTimeZoneName(timezone)) {
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

function isBindingName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BINDING_NAME_PATTERN.test(value) &&
    !RESERVED_NAMES.has(value)
  );
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
  if (!isBindingName(value)) {
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
      const bound = typeof records === "string" ? scope.get(records) : undefined;
      if (records !== undefined && bound !== "record" && bound !== "records") {
        issues.push({ code: "unknown-binding", path: option("records") });
      }
      if (values === null) return null;
      return { kind, values, records: typeof records === "string" ? records : null };
    }
    case "add-record": {
      const values = readFieldValues(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const as = bindName(entries.get("as"), option("as"), "record", scope, context);
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
  reportRepeatedKeys(value, path, issues);
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

// The `automations` list as YAML loaded it, or the problem with the file.
function loadAutomationList(
  text: string,
): { status: "read"; list: unknown[] } | ReturnType<typeof unreadable> {
  if (new TextEncoder().encode(text).byteLength > MAX_AUTOMATIONS_FILE_BYTES) {
    return unreadable("file-too-large", "");
  }
  if (isEmptyYamlDocument(text)) return { status: "read", list: [] };

  let root: unknown;
  try {
    root = load(text, {
      schema: AUTOMATIONS_YAML_SCHEMA,
      json: true,
      maxAliases: 0,
      maxDepth: MAX_YAML_DEPTH,
    });
  } catch (error) {
    const line = error instanceof YAMLException && error.mark ? error.mark.line + 1 : undefined;
    return unreadable("invalid-yaml", "", line);
  }
  if (root === null) return { status: "read", list: [] };
  if (!(root instanceof Map)) return unreadable("root-not-mapping", "");
  const [repeated] = REPEATED_KEYS.get(root) ?? [];
  if (repeated !== undefined) return unreadable("duplicate-key", keyPointer("", repeated));
  if (root.get("version") !== AUTOMATIONS_FILE_VERSION) {
    return unreadable("unsupported-version", "/version");
  }
  for (const key of root.keys()) {
    if (key !== "version" && key !== "automations") {
      return unreadable("unknown-property", keyPointer("", key));
    }
  }
  const list = root.get("automations");
  if (list === undefined || list === null) return { status: "read", list: [] };
  if (!Array.isArray(list)) return unreadable("expected-sequence", "/automations");
  return { status: "read", list };
}

function readEntries(list: readonly unknown[]): AutomationEntry[] {
  const seenIds = new Set<string>();
  return list.map((raw, index): AutomationEntry => {
    const path = pointer("/automations", index);
    if (index >= MAX_AUTOMATIONS) {
      return invalidEntry(raw, [{ code: "too-many-automations", path }]);
    }
    const issues: Issues = [];
    const automation = readAutomation(raw, path, issues, seenIds);
    return automation === null ? invalidEntry(raw, issues) : { status: "valid", automation };
  });
}

export function parseAutomationsFile(text: string): AutomationsFileParseResult {
  const loaded = loadAutomationList(text);
  return loaded.status === "read" ? { status: "read", entries: readEntries(loaded.list) } : loaded;
}

// Words after which "/" starts a regular expression instead of dividing.
const WORDS_BEFORE_REGEX = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const WORD_CHARACTER = /[\p{ID_Continue}$‌‍]/u;

function quotedEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index + 1;
    else if (char === "\n") return -1;
  }
  return -1;
}

function templateLiteralEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "`") {
      return index + 1;
    } else if (char === "$" && source[index + 1] === "{") {
      const end = expressionEnd(source, index + 2);
      if (end === -1) return -1;
      index = end;
    }
  }
  return -1;
}

function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "\n") {
      return -1;
    } else if (char === "[" || char === "]") {
      inClass = char === "[";
    } else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < source.length && WORD_CHARACTER.test(source[end]!)) end += 1;
      return end;
    }
  }
  return -1;
}

// The index of the "}" that ends a JavaScript expression starting at
// `start`, or -1. Braces inside strings, template literals, regular
// expressions, comments, and nested braces do not count.
function expressionEnd(source: string, start: number): number {
  let depth = 0;
  let regexAllowed = true;
  let index = start;
  while (index !== -1 && index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
    } else if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? -1 : newline;
    } else if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? -1 : close + 2;
    } else if (char === '"' || char === "'" || char === "`" || (char === "/" && regexAllowed)) {
      index =
        char === "`" ? templateLiteralEnd(source, index)
        : char === "/" ? regexEnd(source, index)
        : quotedEnd(source, index);
      regexAllowed = false;
    } else if (WORD_CHARACTER.test(char)) {
      let end = index + 1;
      while (end < source.length && WORD_CHARACTER.test(source[end]!)) end += 1;
      regexAllowed = WORDS_BEFORE_REGEX.has(source.slice(index, end));
      index = end;
    } else if (char === "}" && depth === 0) {
      return index;
    } else {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      regexAllowed = char !== ")" && char !== "]" && char !== "}";
      index += 1;
    }
  }
  return -1;
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
    const end = expressionEnd(template, index + 1);
    const expression = end === -1 ? "" : template.slice(index + 1, end);
    if (expression.trim().length === 0) return null;
    if (text.length > 0) parts.push({ kind: "text", text });
    parts.push({ kind: "expression", expression });
    text = "";
    index = end + 1;
  }
  if (text.length > 0) parts.push({ kind: "text", text });
  return parts;
}

// The writer builds Maps so keys keep the order written here, and a field
// named "__proto__" or "2024" stays in place.
function scalarYaml(value: AutomationScalar): AutomationScalar {
  return typeof value === "string" && value.startsWith("=") ? `=${value}` : value;
}

function valueYaml(value: AutomationValue): AutomationScalar | AutomationScalar[] {
  if (value.kind === "formula") return `=${value.expression}`;
  return Array.isArray(value.value) ? value.value.map(scalarYaml) : scalarYaml(value.value);
}

function fieldValuesYaml(values: readonly AutomationFieldValue[]): Map<string, unknown> {
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

// YAML 1.1 readers, such as PyYAML, read an unquoted 12:30 as the number 750.
const SEXAGESIMAL = /^\d+(?::\d+)+$/;

// Quotes every formula, and every clock time for YAML 1.1 readers.
function quoteScalars(documents: YamlDocument[]): void {
  visit(documents, (node) => {
    if (node.kind === "scalar" && (node.value.startsWith("=") || SEXAGESIMAL.test(node.value))) {
      node.style.singleQuoted = true;
    }
  });
}

function indent(text: string): string {
  return text.replace(/^(?=.)/gmu, "  ");
}

// Whether two loaded or modeled values hold the same data, including keys
// that a mapping repeats.
function sameData(left: unknown, right: unknown): boolean {
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) return false;
    if (!sameData(REPEATED_KEYS.get(left) ?? [], REPEATED_KEYS.get(right) ?? [])) return false;
    const rightEntries = [...right];
    return [...left].every(([key, value], index) => {
      const [rightKey, rightValue] = rightEntries[index]!;
      return sameData(key, rightKey) && sameData(value, rightValue);
    });
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameData(item, right[index]))
    );
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every((key) => Object.hasOwn(rightRecord, key) && sameData(leftRecord[key], rightRecord[key]))
    );
  }
  return Object.is(left, right);
}

/**
 * The file text for these entries: valid automations in a fixed key order,
 * invalid entries with the data they were read with, and a blank line
 * between entries. Refuses text that does not read back as the same entries,
 * such as a file over MAX_AUTOMATIONS_FILE_BYTES or an automation the parser
 * would turn off.
 */
export function writeAutomationsFile(entries: readonly AutomationEntry[]): AutomationsFileWriteResult {
  const header = `version: ${AUTOMATIONS_FILE_VERSION}\nautomations:`;
  const items = entries.map((entry) =>
    indent(
      dump([entry.status === "valid" ? automationYaml(entry.automation) : entry.raw], {
        schema: AUTOMATIONS_YAML_SCHEMA,
        lineWidth: -1,
        noRefs: true,
        transform: quoteScalars,
      }),
    ),
  );
  const text = items.length === 0 ? `${header} []\n` : `${header}\n${items.join("\n")}`;

  const loaded = loadAutomationList(text);
  if (loaded.status === "unreadable") return { status: "refused", diagnostics: [loaded.diagnostic] };
  const reread = readEntries(loaded.list);
  const diagnostics = entries.flatMap((entry, index): AutomationDiagnostic[] => {
    const again = reread[index];
    const changed = [{ code: "changed-on-reread" as const, path: pointer("/automations", index) }];
    if (entry.status === "invalid") return sameData(loaded.list[index], entry.raw) ? [] : changed;
    if (again?.status === "invalid") return again.diagnostics;
    return again !== undefined && sameData(again.automation, entry.automation) ? [] : changed;
  });
  return diagnostics.length === 0 ? { status: "ok", text } : { status: "refused", diagnostics };
}
