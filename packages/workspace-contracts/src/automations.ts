import { parseExpressionAt, tokenizer, tokTypes } from "acorn";
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
//   brace. The text after `{` must parse as one JavaScript expression,
//   followed by `}`, so a "}" inside the expression's strings, template
//   literals, regular expressions, or object literals does not end it. To
//   start a message with "=", write `{"="}`. The parser, acorn 8.18, reads
//   "/" after a keyword-named property that follows "?." as a regular
//   expression, so `{record?.of / 2}` needs parentheses:
//   `{(record?.of) / 2}`. Without them the automation turns off with
//   `optional-chain-needs-parentheses`.
// - All other text, such as a name or a reference, cannot start with "=".
//
// The writer quotes every formula. Quote a formula you write by hand when it
// contains " #": YAML reads the rest of an unquoted line as a comment.
//
// `as` names a step's result for later steps and formulas. A find step binds
// a list of records, an add-record step binds the one record it added, and a
// run step binds the value its code returns. Each step starts once the steps
// before it have landed and reads records as they are then, so it sees what
// those steps changed, in the trigger record and in the records a find or an
// add-record step bound. A later find queries again. A step can use only the
// results of steps that ran before it, and a formula gets a result only by
// writing its name; code gets every one. A name is a JavaScript
// identifier that is not in AUTOMATION_RESERVED_NAMES: a formula name, a
// reserved word, or a standard global such as Math.
//
// Fields, Groups, and Button fields are referenced by name. Collections are
// workspace-relative folder paths. A code file is relative to the
// Collection's folder and cannot leave it, so the people who can edit the
// automation are the people who can edit its code.
//
// A run step's code, or a run-file step's file, is the body of a function
// that reads `ctx`: `ctx.record`, `ctx.previous`, `ctx.trigger`,
// `ctx.person`, `ctx.message`, each earlier step's result by its `as` name,
// and the formula helpers. It returns nothing, or an object with any of
// `set`, the fields to set on the trigger record; `records`, a list of
// `{ action: "add", collection, fields }` and
// `{ action: "change", collection, id, fields }`; and `output`, the value
// `as` binds. It runs synchronously, for at most 1 second, with no network
// or files. The executor applies its changes with the checks a set or
// add-record step gets. On a dataset Collection, the changes stay in the
// table the automation watches, or the dataset's only table for a schedule
// or a Group message, and each goes through the approved operation the ⚡
// panel would pin for a step with the same fields. A schedule or a Group
// message has no trigger record: `ctx.record` is null, and "set" fails.
//
//       - run: |
//           const total = ctx.record.Price * ctx.record.Quantity;
//           return { set: { Total: total }, output: total };
//         as: total
//
// A dataset Collection changes its records only through its approved
// operations. A set, add-record, or find step on one names the operation it
// invokes with `operation`, and that operation's table is the step's table:
// operation names are unique within a dataset. A record trigger on a dataset
// with several tables names its table with `table`. Fields stay names, and
// the executor resolves names to field ids against the approved revision.
// This parser does not know whether a Collection is a dataset, so the
// executor refuses a missing or unknown operation or table.
//
//   - id: close-invoice
//     name: Close paid invoices
//     when:
//       field-changed: Paid
//       table: Invoices
//     do:
//       - set:
//           Status: Closed
//         operation: invoices.edit
//
// An invoke step uses `collection` as its destination, defaulting to the source.
// It runs one of that dataset's actions, the operations its
// author wrote for work a field edit cannot express. `input` maps each key
// of the action's input to a value or a formula, so the action learns which
// record to work on:
//
//       - invoke: invoices.markPaid
//         input:
//           id: '=record.id'
//
// An action runs in one transaction and can read its record there, so its
// input usually needs only the record's id.
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
// An action's input names what it works on, such as a record id and a date.
// More keys than this belong in the action's own reads.
export const MAX_ACTION_INPUT_KEYS = 32;
// Input keys are names in the action's code, like field names in a form.
// Like every length bound in this file, it counts UTF-16 code units.
export const MAX_ACTION_INPUT_KEY_LENGTH = 64;
// Keys that JSON objects reserve. The dataset host refuses an input key or
// an operation name part that is one, so the file refuses it first.
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
// A dataset operation's name, as the dataset host accepts it: a letter, then
// up to 63 letters, digits, "_", ".", or "-", with no reserved part.
const OPERATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
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

/** One key of an action's input, and the value it gets. */
interface AutomationInputValue {
  key: string;
  value: AutomationValue;
}

const AUTOMATION_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

const AUTOMATION_SCHEDULE_FREQUENCIES = ["hour", "day", "weekday", "week", "month"] as const;

// A schedule runs in `timezone`, an IANA time zone name or alias in any
// letter case, such as "Europe/London" or "Asia/Calcutta". The scheduler
// resolves it through Intl.DateTimeFormat. A fixed offset such as "+08:00"
// is refused because it ignores daylight saving time. `weekday` runs Monday
// to Friday in the schedule's time zone. `at` is "HH:MM" on a 24-hour clock,
// or ":MM" past each hour for an hourly schedule. `days` are in calendar
// order. A monthly day past the end of a shorter month, such as 31 in April,
// runs on that month's last day. Without `at` in the file, a schedule runs at
// "00:00" or ":00". Without `days`, a weekly schedule runs on Monday and a
// monthly schedule on the 1st. The parser fills these defaults in, so the
// model is explicit.
export type AutomationScheduleTrigger =
  | { kind: "schedule"; every: "hour" | "day" | "weekday"; at: string; timezone: string }
  | { kind: "schedule"; every: "week"; at: string; days: AutomationWeekday[]; timezone: string }
  | { kind: "schedule"; every: "month"; at: string; days: number[]; timezone: string };

// `table` names a dataset table, or is null for a document Collection or a
// dataset with one table.
type AutomationTrigger =
  | { kind: "record-added"; table: string | null }
  /** `fields` is null when any field change counts. */
  | { kind: "record-changed"; fields: string[] | null; table: string | null }
  | { kind: "record-removed"; table: string | null }
  /** `to` is null when any new value counts. */
  | { kind: "field-changed"; field: string; to: AutomationValue | null; table: string | null }
  /** Fires when a record that did not match the condition starts to match it. */
  | { kind: "starts-matching"; condition: string; table: string | null }
  | AutomationScheduleTrigger
  | { kind: "button"; field: string; table: string | null }
  | { kind: "group-message"; group: string; startsWith: string | null };

// `operation` names the approved dataset operation a step invokes, or is
// null for a document Collection.
type AutomationStep =
  /**
   * Sets fields on the triggering record, or on the record or records bound
   * to `records` by an earlier add-record or find step.
   */
  | { kind: "set"; values: AutomationFieldValue[]; records: string | null; operation: string | null }
  /** `collection` is null for this Collection. */
  | {
      kind: "add-record";
      values: AutomationFieldValue[];
      collection: string | null;
      as: string | null;
      operation: string | null;
    }
  | { kind: "find"; condition: string; collection: string | null; as: string; operation: string | null }
  /** Runs the dataset action named `operation` with `input` as its input. */
  | { kind: "invoke"; collection: string | null; operation: string; input: AutomationInputValue[] }
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
  // `{record?.of / 2}`: write `{(record?.of) / 2}`.
  "optional-chain-needs-parentheses",
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
  "too-many-inputs",
  // An input key that JSON objects reserve, such as __proto__.
  "reserved-input-key",
  // An operation or action name the dataset host would refuse.
  "invalid-operation-name",
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
  "record-added": ["table"],
  "record-changed": ["table"],
  "record-removed": ["table"],
  "field-changed": ["to", "table"],
  "starts-matching": ["table"],
  schedule: ["at", "days", "timezone"],
  button: ["table"],
  "group-message": ["starts-with"],
} as const satisfies Record<AutomationTrigger["kind"], readonly string[]>;

const STEP_OPTIONS = {
  set: ["records", "operation"],
  "add-record": ["collection", "as", "operation"],
  find: ["collection", "as", "operation"],
  invoke: ["collection", "input"],
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

function readOperationName(value: unknown, path: string, issues: Issues): string | null {
  const text = readReference(value, path, issues);
  if (text !== null && (!OPERATION_NAME_PATTERN.test(text) || text.split(".").some((part) => RESERVED_KEYS.has(part)))) {
    issues.push({ code: "invalid-operation-name", path });
    return null;
  }
  return text;
}

function readPath(value: unknown, path: string, issues: Issues): string | null {
  const text = readReference(value, path, issues);
  if (text !== null && !isNormalizedRelativePath(text)) {
    issues.push({ code: "invalid-path", path });
    return null;
  }
  return text;
}

// A condition is kept as written. Leading spaces do not hide a "=" from the
// check, because the expression would still start with one.
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
  const split = text === null ? null : splitTemplate(text);
  if (typeof split === "string") {
    issues.push({ code: split, path });
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

// An action's input. An absent `input` is an empty one.
function readInput(value: unknown, path: string, issues: Issues): AutomationInputValue[] | null {
  if (value === undefined) return [];
  if (value === null || (value instanceof Map && value.size === 0)) {
    issues.push({ code: "empty-value", path });
    return null;
  }
  if (!(value instanceof Map)) {
    issues.push({ code: "expected-mapping", path });
    return null;
  }
  if (value.size > MAX_ACTION_INPUT_KEYS) {
    issues.push({ code: "too-many-inputs", path });
    return null;
  }
  const input: AutomationInputValue[] = [];
  let valid = true;
  for (const [key, entry] of value) {
    const keyText = yamlKeyText(key);
    const keyPath = keyPointer(path, key);
    if (keyText === null) {
      issues.push({ code: "expected-text", path: keyPath });
      valid = false;
      continue;
    }
    // A key that starts with "=" is refused as a formula marker: only a
    // value can be a formula.
    const name = readText(keyText, keyPath, MAX_ACTION_INPUT_KEY_LENGTH, issues);
    const keyValue = readValue(entry, keyPath, issues);
    if (name !== null && RESERVED_KEYS.has(name)) {
      issues.push({ code: "reserved-input-key", path: keyPath });
      valid = false;
    } else if (input.some((existing) => existing.key === name)) {
      // Keys such as 2024 and "2024" differ in YAML but name one key.
      issues.push({ code: "duplicate-key", path: keyPath });
      valid = false;
    } else if (name !== null && keyValue !== null) {
      input.push({ key: name, value: keyValue });
    } else {
      valid = false;
    }
  }
  return valid ? input : null;
}

// A name or alias Intl knows, in any letter case. Intl resolves every fixed
// offset it accepts, however it is spelled, to "+HH:MM" or "-HH:MM".
function isTimeZoneName(value: string): boolean {
  try {
    const { timeZone } = new Intl.DateTimeFormat(undefined, { timeZone: value }).resolvedOptions();
    return !timeZone.startsWith("+") && !timeZone.startsWith("-");
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
  const table = readReference(entries.get("table"), pointer(path, "table"), issues);
  switch (kind) {
    case "record-added":
    case "record-removed":
      if (argument !== null) issues.push({ code: "expected-empty", path: argumentPath });
      return { kind, table };
    case "record-changed": {
      const fields = argument === null ? null : readFieldList(argument, argumentPath, issues);
      return { kind, fields, table };
    }
    case "field-changed": {
      const field = readReference(argument, argumentPath, issues);
      const to = entries.has("to") ? readValue(entries.get("to"), pointer(path, "to"), issues) : null;
      return field === null ? null : { kind, field, to, table };
    }
    case "starts-matching": {
      const condition = readCondition(argument, argumentPath, issues);
      return condition === null ? null : { kind, condition, table };
    }
    case "schedule":
      return readSchedule(argument, entries, path, issues);
    case "button": {
      const field = readReference(argument, argumentPath, issues);
      return field === null ? null : { kind, field, table };
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
  const operation = () => readOperationName(entries.get("operation"), option("operation"), issues);
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
      const operationName = operation();
      if (values === null) return null;
      return { kind, values, records: typeof records === "string" ? records : null, operation: operationName };
    }
    case "add-record": {
      const values = readFieldValues(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const as = bindName(entries.get("as"), option("as"), "record", scope, context);
      const operationName = operation();
      return values === null ? null : { kind, values, collection, as, operation: operationName };
    }
    case "find": {
      const condition = readCondition(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const as = bindName(required(entries, "as", path, issues), option("as"), "records", scope, context);
      const operationName = operation();
      return condition === null || as === null ? null : { kind, condition, collection, as, operation: operationName };
    }
    case "invoke": {
      const name = readOperationName(argument, argumentPath, issues);
      const collection = readPath(entries.get("collection"), option("collection"), issues);
      const input = readInput(entries.get("input"), option("input"), issues);
      return name === null || input === null ? null : { kind, collection, operation: name, input };
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

type TemplateProblem = "invalid-template" | "optional-chain-needs-parentheses";

// acorn 8.18 reads a "/" after a keyword-named property that follows "?.",
// as in "record?.of / 2", as the start of a regular expression. The text
// up to where parsing stopped holds that pattern when this is the cause.
// A comment inside the pattern gives plain invalid-template.
const OPTIONAL_PROPERTY_BEFORE_DIVISION = /\?\.\s*[\p{ID_Start}$_][\p{ID_Continue}$]*\s*\/(?![/*])/u;

function templateProblem(source: string, start: number, stop: number): TemplateProblem {
  return OPTIONAL_PROPERTY_BEFORE_DIVISION.test(source.slice(start, stop + 1))
    ? "optional-chain-needs-parentheses"
    : "invalid-template";
}

// The index of the "}" that ends the JavaScript expression starting at
// `start`, or the problem that stops one ending. acorn parses one expression
// in expression context, so a "}" inside a string, template literal, regular
// expression, or object literal does not end it. preserveParens keeps
// grouping parentheses in the tree, so the end of "(a + b)" includes its
// ")". acorn's tokenizer then reads the next token, skipping spaces and
// comments; that token must be "}".
function expressionEnd(source: string, start: number): number | TemplateProblem {
  let end: number;
  try {
    end = parseExpressionAt(source, start, { ecmaVersion: "latest", preserveParens: true }).end;
  } catch (error) {
    const stop = error instanceof SyntaxError && "pos" in error && typeof error.pos === "number" ? error.pos : start;
    return templateProblem(source, start, stop);
  }
  try {
    const next = tokenizer(source.slice(end), { ecmaVersion: "latest" }).getToken();
    return next.type === tokTypes.braceR ? end + next.start : templateProblem(source, start, end + next.start);
  } catch {
    return "invalid-template";
  }
}

function splitTemplate(template: string): AutomationTextPart[] | TemplateProblem {
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
    if (char === "}") return "invalid-template";
    if (char !== "{") {
      text += char;
      index += 1;
      continue;
    }
    const end = expressionEnd(template, index + 1);
    if (typeof end === "string") return end;
    if (text.length > 0) parts.push({ kind: "text", text });
    parts.push({ kind: "expression", expression: template.slice(index + 1, end) });
    text = "";
    index = end + 1;
  }
  if (text.length > 0) parts.push({ kind: "text", text });
  return parts;
}

/** Why a message template cannot be read, as the file contract's code, or null when it can. */
export function automationTextProblem(template: string): TemplateProblem | null {
  const split = splitTemplate(template);
  return typeof split === "string" ? split : null;
}

/**
 * Splits a message template into text and expressions, or returns null when
 * a brace is unmatched or an expression does not parse.
 */
export function automationTextParts(template: string): AutomationTextPart[] | null {
  const split = splitTemplate(template);
  return typeof split === "string" ? null : split;
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

function inputYaml(input: readonly AutomationInputValue[]): Map<string, unknown> | null {
  return input.length === 0 ? null : new Map(input.map(({ key, value }) => [key, valueYaml(value)]));
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
      return trigger.table === null ? trigger.kind : withOptions(trigger.kind, null, [["table", trigger.table]]);
    case "record-changed":
      return trigger.fields === null && trigger.table === null
        ? trigger.kind
        : withOptions(trigger.kind, trigger.fields, [["table", trigger.table]]);
    case "field-changed": {
      // `to: null` means the field was cleared, so it cannot pass through
      // withOptions, which leaves nulls out.
      const entries = withOptions(trigger.kind, trigger.field, []);
      if (trigger.to !== null) entries.set("to", valueYaml(trigger.to));
      if (trigger.table !== null) entries.set("table", trigger.table);
      return entries;
    }
    case "starts-matching":
      return withOptions(trigger.kind, trigger.condition, [["table", trigger.table]]);
    case "schedule":
      return withOptions(trigger.kind, trigger.every, [
        ["at", trigger.at],
        ["days", trigger.every === "week" || trigger.every === "month" ? trigger.days : null],
        ["timezone", trigger.timezone],
      ]);
    case "button":
      return withOptions(trigger.kind, trigger.field, [["table", trigger.table]]);
    case "group-message":
      return withOptions(trigger.kind, trigger.group, [["starts-with", trigger.startsWith]]);
  }
}

function stepYaml(step: AutomationStep): Map<string, unknown> {
  switch (step.kind) {
    case "set":
      return withOptions(step.kind, fieldValuesYaml(step.values), [
        ["records", step.records],
        ["operation", step.operation],
      ]);
    case "add-record":
      return withOptions(step.kind, fieldValuesYaml(step.values), [
        ["collection", step.collection],
        ["as", step.as],
        ["operation", step.operation],
      ]);
    case "find":
      return withOptions(step.kind, step.condition, [
        ["collection", step.collection],
        ["as", step.as],
        ["operation", step.operation],
      ]);
    case "invoke":
      return withOptions(step.kind, step.operation, [["collection", step.collection], ["input", inputYaml(step.input)]]);
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
 * would turn off. An invalid entry with a key written twice is refused with
 * its `duplicate-key` diagnostics, because YAML keeps only one of the values.
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
    const path = pointer("/automations", index);
    const changed = [{ code: "changed-on-reread" as const, path }];
    if (entry.status === "invalid") {
      if (sameData(loaded.list[index], entry.raw)) return [];
      // Paths follow the entry's place in this write, not where it was read.
      const repeated: Issues = [];
      reportRepeatedKeys(entry.raw, path, repeated);
      return repeated.length > 0 ? repeated : changed;
    }
    if (again?.status === "invalid") return again.diagnostics;
    return again !== undefined && sameData(again.automation, entry.automation) ? [] : changed;
  });
  return diagnostics.length === 0 ? { status: "ok", text } : { status: "refused", diagnostics };
}
