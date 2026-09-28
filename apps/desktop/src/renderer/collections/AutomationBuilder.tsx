import { automationReachCopy } from "../automationReachCopy";
import { AlertTriangle, ArrowDown, ArrowUp, Clock, Info, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { CollectionFieldType, FieldDefinition } from "@dohc/workspace-contracts";
import type { AutomationDiagnostic, AutomationScheduleTrigger, AutomationWeekday } from "@dohc/workspace-contracts/automations";
import { nextDue, UnknownTimeZoneError } from "@dohc/workspace-contracts/automation-schedule";
import type { CheckCollectionAutomationResult, ListAutomationGroupsResult, ListAutomationTargetsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { IconButton, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { RUN_TIME, Sentence, StatusLine } from "./AutomationParts";
import {
  conditionFormula,
  conditionRows,
  defaultValueFor,
  fieldAccess,
  idFor,
  literalFor,
  literalText,
  MAX_NAME_LENGTH,
  MAX_CODE_LENGTH,
  MAX_IF_DEPTH,
  MAX_STEPS,
  numberValue,
  reachPlaces,
  valueKindOf,
  valueKindsFor,
  type AutomationTable,
  type ConditionOperator,
  type ConditionRow,
  type ValueKind,
} from "./automationDraft";
import {
  automationSentence,
  collectionName,
  sentenceText,
  stepParts,
  triggerParts,
  type Automation,
  type AutomationStep,
  type AutomationTrigger,
  type AutomationValue,
  type ValidAutomationSummary,
} from "./automationSentence";

// The builder: When, Only if, and Do, with choices instead of formulas, and
// a formula wherever a person wants one. A trigger watches a record, a
// button, a schedule, or a Group's messages; in a dataset it watches one
// table, whose fields Only if and Set fields offer.
// An If holds a condition and its own Do and Otherwise steps, which edit
// like the automation's. Steps the builder cannot edit yet, such as a
// message, stay as they are and read as their sentence; the file edits
// them. A Find or an added record can name its result, and a later Set
// fields step in the same list can change it. Save runs the file
// contract's check through main first, so it never writes what the parser
// would refuse, and the panel writes the whole list over the content it
// read.

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;
type Target = Extract<ListAutomationTargetsResult, { collections: unknown }>["collections"][number];
type SetStep = Extract<AutomationStep, { kind: "set" }>;
type AddStep = Extract<AutomationStep, { kind: "add-record" }>;
type FindStep = Extract<AutomationStep, { kind: "find" }>;
type CodeStep = Extract<AutomationStep, { kind: "run" | "run-file" }>;
type YourStep = Extract<AutomationStep, { kind: "notify" | "wake-agent" }>;
type Group = Extract<ListAutomationGroupsResult, { groups: unknown }>["groups"][number];
type FieldValue = SetStep["values"][number];
type Reach = ValidAutomationSummary["reach"];

const inputClass =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink placeholder:text-subtle focus:border-ink";
const selectClass =
  "w-full rounded-md border border-line bg-bg px-1.5 py-1 text-[13px] text-ink focus:border-ink";
const formulaClass = `${inputClass} font-mono text-[12px]`;

const TRIGGER_LABELS = {
  "field-changed": "A field changes",
  "record-changed": "A record changes",
  "record-added": "A record is added",
  "record-removed": "A record is removed",
  "starts-matching": "A record starts to match",
  button: "Someone clicks a button",
  schedule: "On a schedule",
  "group-message": "Someone posts in a Group",
} as const;
type BuilderTrigger = keyof typeof TRIGGER_LABELS;

const FREQUENCY_LABELS: Record<AutomationScheduleTrigger["every"], string> = {
  hour: "Every hour",
  day: "Every day",
  weekday: "Every weekday",
  week: "Every week",
  month: "Every month",
};
const WEEKDAYS: ReadonlyArray<[AutomationWeekday, string]> = [
  ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"],
];
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => `:${String(index).padStart(2, "0")}`);
// Read once: the list does not change while dohc runs. Intl leaves out UTC, which schedules often use.
let timeZones: readonly string[] | null = null;
const timeZoneNames = () => (timeZones ??= ["UTC", ...Intl.supportedValuesOf("timeZone")]);
// The longest delay setTimeout keeps; a longer one fires at once.
const LONGEST_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * A schedule of `every`, keeping what `current` holds that still fits: its
 * minutes, its time zone, and its days for the same frequency. A new one
 * runs at 9:00 in this computer's time zone.
 */
function scheduleFor(every: AutomationScheduleTrigger["every"], current: AutomationTrigger): AutomationScheduleTrigger {
  const was = current.kind === "schedule" ? current : null;
  const timezone = was?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutes = was === null ? ":00" : was.at.slice(-3);
  const at = every === "hour" ? minutes : was !== null && was.every !== "hour" ? was.at : `09${minutes}`;
  if (every === "week") return { kind: "schedule", every, at, timezone, days: was?.every === "week" ? was.days : ["mon"] };
  if (every === "month") return { kind: "schedule", every, at, timezone, days: was?.every === "month" ? was.days : [1] };
  return { kind: "schedule", every, at, timezone };
}

/**
 * When a schedule runs next, as an instant and in the schedule's own time
 * zone, which its time is in, or why dohc cannot say. Null while its time is
 * still being chosen.
 */
function nextRunOf(schedule: AutomationScheduleTrigger): { at: number | null; text: string } | null {
  try {
    const next = nextDue(schedule, Date.now());
    return next === null
      ? { at: null, text: "This schedule has no next run." }
      : { at: next, text: `Next run ${new Intl.DateTimeFormat(undefined, { ...RUN_TIME, timeZone: schedule.timezone }).format(next)}, ${schedule.timezone}` };
  } catch (error) {
    if (error instanceof UnknownTimeZoneError) return { at: null, text: `This computer does not know the time zone ${schedule.timezone}.` };
    return null;
  }
}

const VALUE_KIND_LABELS: Record<ValueKind, string> = {
  any: "Any value",
  today: "Today",
  now: "Now",
  value: "A value",
  empty: "Empty",
  formula: "Formula",
};

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: "is",
  "is-not": "is not",
  contains: "contains",
};

// What the file contract's codes mean for a person building an automation.
const DIAGNOSTIC_SENTENCES: Partial<Record<AutomationDiagnostic["code"], string>> = {
  "empty-value": "Fill this in before you save.",
  "step-needs-record": "This trigger has no record to set fields on.",
  "too-long": "This is too long to save.",
  "duplicate-key": "A name is in this step twice.",
  "too-many-inputs": "An action takes at most 32 inputs.",
  "reserved-input-key": "__proto__, prototype, and constructor cannot name an input.",
  "invalid-operation-name": "An action or operation name starts with a letter and uses only letters, digits, _, ., and -, up to 64 characters.",
  "reserved-field-name": "id is the record's own id, so a step cannot set it.",
  "control-characters": "The name has characters dohc cannot show.",
  "too-many-steps": "An automation can have at most 25 steps.",
  "if-too-deep": "If steps can sit at most three deep.",
  "unexpected-formula-marker": "Only a value can be a formula, so this cannot start with =.",
  "unknown-binding": "No step before this one in its list names that result. Move this step after the step that names it.",
  "duplicate-value": "Another step already uses this name.",
  "invalid-template": "Check each {expression} in the message: close its brace and fix its formula. To write a brace itself, type {{ or }}.",
  "optional-chain-needs-parentheses": "Put parentheses around an expression with ?. before a /, as in {(record?.of) / 2}.",
  "invalid-binding-name": "A result name starts with a letter or _, then uses only letters, digits, and _. It cannot be a formula name such as today.",
  "invalid-time": "Write the time as HH:MM on a 24-hour clock, or :MM past each hour.",
  "invalid-timezone": "Choose a time zone by its name, such as Europe/London.",
  "invalid-path": "Write the path inside its folder, with / between folders, and no .. or leading /.",
};

/** What a file contract code means for a person building an automation. */
const unsaved = (code: AutomationDiagnostic["code"]) => DIAGNOSTIC_SENTENCES[code] ?? "dohc cannot save this step. Check its values.";

/** Why a part cannot be saved yet, and the id of the text its control points to. */
type Shown = { id: string; text: string } | null;

/** What marks a control whose part cannot be saved yet, for assistive technology. */
const invalid = (shown: Shown) => (shown === null ? {} : { "aria-invalid": true, "aria-describedby": shown.id });

/**
 * Why a part cannot be saved yet, beside the part. Its control points here
 * with aria-describedby; a refused Save announces how many there are, so
 * each one does not interrupt while the person types.
 */
function Problem({ shown }: { shown: Shown }) {
  if (shown === null) return null;
  return <p id={shown.id} data-problem className="m-0 mt-1 text-[11px] leading-snug text-danger">{shown.text}</p>;
}

/** A field of a Collection. While the Collection's fields load, `fields` is null. */
function FieldSelect(props: {
  label: string;
  fields: readonly FieldDefinition[] | null;
  value: string;
  collection: string;
  focusKey?: string;
  problem: Shown;
  onChange: (field: string) => void;
}) {
  const listed = props.fields?.some((field) => field.name === props.value) ?? false;
  const known = props.value === "" || props.fields === null || listed;
  return (
    <>
      <select
        aria-label={props.label}
        data-focus={props.focusKey}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={selectClass}
        {...invalid(props.problem)}
      >
        {props.value === "" ? <option value="" disabled>Choose a field</option> : null}
        {listed || props.value === "" ? null : <option value={props.value}>{props.value}</option>}
        {(props.fields ?? []).map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
      </select>
      {known || props.problem !== null ? null : (
        <StatusLine tone="warning" icon={AlertTriangle} label="Not a field">
          {props.value} is not a field in {props.collection}.
        </StatusLine>
      )}
      <Problem shown={props.problem} />
    </>
  );
}

/**
 * One typed value, as the field's type takes it: a select field offers its
 * options, a checkbox checked or unchecked, a date a date. A number is
 * typed as text, so a minus sign or an empty input stays while typing.
 */
function LiteralInput(props: {
  label: string;
  type: CollectionFieldType | null;
  options: readonly string[];
  text: string;
  problem?: Shown;
  onChange: (value: AutomationValue) => void;
}) {
  const { type, text } = props;
  const aria = invalid(props.problem ?? null);
  if (type === "select" || type === "multi-select") {
    return (
      <select
        aria-label={props.label}
        value={text}
        onChange={(event) => props.onChange(literalFor("select", event.target.value))}
        className={selectClass}
        {...aria}
      >
        {props.options.includes(text) ? null : <option value={text}>{text}</option>}
        {props.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (type === "checkbox") {
    return (
      <select
        aria-label={props.label}
        value={text === "true" ? "true" : "false"}
        onChange={(event) => props.onChange(literalFor(type, event.target.value))}
        className={selectClass}
        {...aria}
      >
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  }
  return (
    <input
      aria-label={props.label}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "number" ? "decimal" : undefined}
      value={text}
      onChange={(event) => props.onChange(literalFor(type, event.target.value))}
      className={inputClass}
      {...aria}
    />
  );
}

/**
 * A value. A select field's is one choice among Any value, its options,
 * Empty, and Formula, so "Status to Done" is one pick. Any other field
 * chooses a kind, then what was typed for "A value" or "Formula".
 */
function ValueInput(props: {
  label: string;
  field: FieldDefinition | undefined;
  value: AutomationValue | null;
  allowAny?: boolean;
  problem: Shown;
  onChange: (value: AutomationValue | null) => void;
}) {
  const type: CollectionFieldType | null = props.field?.type ?? null;
  const kind = valueKindOf(props.value);
  // The problem is with what was typed, so the input that holds it says so.
  const aria = invalid(props.problem);
  const formula = kind === "formula" && props.value?.kind === "formula" ? (
    <input
      aria-label={`${props.label}, formula`}
      value={props.value.expression}
      spellCheck={false}
      placeholder='dateAdd(today(), 3, "days")'
      onChange={(event) => props.onChange({ kind: "formula", expression: event.target.value })}
      className={formulaClass}
      {...aria}
    />
  ) : null;
  if (props.field?.type === "select") {
    const options = props.field.options;
    const text = literalText(props.value);
    const current = kind === "value" ? `option:${text}` : kind === "any" || kind === "empty" ? kind : "formula";
    return (
      <div className="flex flex-col gap-1">
        <select
          aria-label={props.label}
          value={current}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "any") props.onChange(null);
            else if (next === "empty") props.onChange({ kind: "literal", value: null });
            else if (next === "formula") props.onChange({ kind: "formula", expression: "" });
            else props.onChange({ kind: "literal", value: next.slice("option:".length) });
          }}
          className={selectClass}
          {...(formula === null ? aria : {})}
        >
          {props.allowAny ? <option value="any">Any value</option> : null}
          {kind === "value" && !options.includes(text) ? <option value={current}>{text}</option> : null}
          {options.map((option) => <option key={option} value={`option:${option}`}>{option}</option>)}
          <option value="empty">Empty</option>
          <option value="formula">Formula</option>
        </select>
        {formula}
        <Problem shown={props.problem} />
      </div>
    );
  }
  const kinds = valueKindsFor(type, props.allowAny ?? false);
  const choose = (next: ValueKind) => {
    if (next === "any") props.onChange(null);
    else if (next === "today") props.onChange({ kind: "formula", expression: "today()" });
    else if (next === "now") props.onChange({ kind: "formula", expression: "now()" });
    else if (next === "empty") props.onChange({ kind: "literal", value: null });
    else if (next === "formula") props.onChange({ kind: "formula", expression: "" });
    else props.onChange(type === "date" ? { kind: "literal", value: "" } : defaultValueFor(props.field));
  };
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`${props.label}, kind of value`}
        value={kinds.includes(kind) ? kind : "formula"}
        onChange={(event) => choose(event.target.value as ValueKind)}
        className={selectClass}
      >
        {kinds.map((option) => (
          <option key={option} value={option}>
            {option === "value" && type === "date" ? "A date" : VALUE_KIND_LABELS[option]}
          </option>
        ))}
      </select>
      {kind === "value" && props.field?.type === "multi-select" ? (
        // A multi-select field holds a list, so its value is several choices.
        <select
          aria-label={props.label}
          multiple
          value={props.value?.kind === "literal" && Array.isArray(props.value.value) ? props.value.value.map(String) : []}
          onChange={(event) => props.onChange({
            kind: "literal",
            value: [...event.target.selectedOptions].map((option) => option.value),
          })}
          className={selectClass}
          {...aria}
        >
          {props.field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : kind === "value" ? (
        <LiteralInput
          label={props.label}
          type={type}
          options={[]}
          text={literalText(props.value)}
          problem={props.problem}
          onChange={props.onChange}
        />
      ) : formula}
      <Problem shown={props.problem} />
    </div>
  );
}

type InputKind = "text" | "number" | "boolean" | "empty" | "list" | "formula";
const INPUT_KIND_LABELS: Record<InputKind, string> = {
  text: "Text", number: "Number", boolean: "Yes or no", empty: "Empty", list: "List", formula: "Formula",
};
// What each kind starts from when a person picks it.
const INPUT_KIND_STARTS: Record<InputKind, AutomationValue> = {
  text: { kind: "literal", value: "" },
  number: { kind: "literal", value: "" },
  boolean: { kind: "literal", value: true },
  empty: { kind: "literal", value: null },
  list: { kind: "literal", value: [] },
  formula: { kind: "formula", expression: "" },
};

/** The kind a value is: a number being typed is text the row marks as a number. */
function inputKindOf(value: AutomationValue, number: boolean): InputKind {
  if (value.kind === "formula") return "formula";
  if (number || typeof value.value === "number") return "number";
  if (typeof value.value === "boolean") return "boolean";
  if (value.value === null) return "empty";
  return Array.isArray(value.value) ? "list" : "text";
}

/**
 * An action input's value, as the kind the file wrote it: text, a number,
 * yes or no, empty, a list, or a formula. An action's input has no field
 * type, so the value keeps its kind until someone picks another. A number
 * stays the text typed until it reads as one.
 */
function ActionValueInput(props: {
  label: string;
  value: AutomationValue;
  number: boolean;
  problem: Shown;
  onChange: (value: AutomationValue, number: boolean) => void;
}) {
  const { value } = props;
  const kind = inputKindOf(value, props.number);
  const literal = value.kind === "literal" ? value.value : null;
  const aria = invalid(props.problem);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <select
          aria-label={`${props.label}, kind`}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as InputKind;
            props.onChange(INPUT_KIND_STARTS[next], next === "number");
          }}
          className={`${selectClass} w-auto`}
        >
          {Object.entries(INPUT_KIND_LABELS).map(([option, label]) => <option key={option} value={option}>{label}</option>)}
        </select>
        {value.kind === "formula" ? (
          <input
            aria-label={`${props.label}, formula`}
            value={value.expression}
            spellCheck={false}
            onChange={(event) => props.onChange({ kind: "formula", expression: event.target.value }, false)}
            className={formulaClass}
            {...aria}
          />
        ) : kind === "boolean" ? (
          <select
            aria-label={props.label}
            value={literal === true ? "true" : "false"}
            onChange={(event) => props.onChange({ kind: "literal", value: event.target.value === "true" }, false)}
            className={selectClass}
            {...aria}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : kind === "list" || kind === "empty" ? null : (
          <input
            aria-label={props.label}
            value={literal === null || Array.isArray(literal) ? "" : String(literal)}
            inputMode={kind === "number" ? "decimal" : undefined}
            spellCheck={false}
            onChange={(event) => props.onChange({ kind: "literal", value: event.target.value }, kind === "number")}
            className={inputClass}
            {...aria}
          />
        )}
      </div>
      {kind === "list" ? (
        <ListInput
          label={props.label}
          items={Array.isArray(literal) ? literal : []}
          onChange={(items) => props.onChange({ kind: "literal", value: items }, false)}
        />
      ) : null}
      <Problem shown={props.problem} />
    </div>
  );
}

/**
 * A list input's items, one field each. An item keeps its kind, a number
 * or yes or no too, until someone types in it; a typed item is text, and
 * may hold a comma or nothing at all.
 */
function ListInput(props: {
  label: string;
  items: ReadonlyArray<string | number | boolean | null>;
  onChange: (items: Array<string | number | boolean | null>) => void;
}) {
  const { items } = props;
  return (
    <div role="group" aria-label={`${props.label}, list`} className="flex flex-col gap-1">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            aria-label={`${props.label}, item ${index + 1}`}
            value={item === null ? "" : String(item)}
            spellCheck={false}
            onChange={(event) => props.onChange(items.map((old, at) => (at === index ? event.target.value : old)))}
            className={inputClass}
          />
          <IconButton
            aria-label={`Remove item ${index + 1} from ${props.label}`}
            title="Remove"
            onClick={() => props.onChange(items.filter((_, at) => at !== index))}
          >
            <Trash2 size={13} aria-hidden />
          </IconButton>
        </div>
      ))}
      <SecondaryButton size="compact" className="flex items-center gap-1 self-start" onClick={() => props.onChange([...items, ""])}>
        <Plus size={12} aria-hidden />
        Add item
      </SecondaryButton>
    </div>
  );
}

type ConditionMode = "always" | "rows" | "formula";
interface ConditionEntry { key: number; row: ConditionRow }
/**
 * A condition as the builder edits it: Always, rows that must all hold, or a
 * formula. `saved` is the rows the file's expression read as, and that
 * expression, which the rows write while nobody has changed them.
 */
interface ConditionDraft {
  mode: ConditionMode;
  formula: string;
  rows: ConditionEntry[];
  saved: { rows: ConditionEntry[]; expression: string } | null;
}

/** What a new comparison with `field` starts from: unchecked for a checkbox, as its control shows. */
const comparedValue = (field: FieldDefinition | undefined): ConditionRow["value"] => (field?.type === "checkbox" ? false : "");

/**
 * A condition: rows of field comparisons that must all hold, or a formula.
 * Only if can also be Always; what a record starts to match cannot.
 */
/**
 * Which condition an editor edits: Only if, what a record starts to match,
 * or the records a Find step reads. `number` and `key` name a Find's step.
 */
type ConditionPart =
  | { kind: "condition" }
  | { kind: "match" }
  | { kind: "find"; number: number; key: number; dataset: boolean }
  | { kind: "if"; number: number; key: number };

function ConditionEditor(props: {
  /** Which condition this is, which names its controls. */
  part: ConditionPart;
  condition: ConditionDraft;
  /** What the rows write, which a switch to Formula starts from. */
  expression: string | null;
  fields: readonly FieldDefinition[];
  collection: string;
  /** The key of the whole condition's problem; a row's is this key, "/", and the row's key. */
  problemKey: string;
  problem: (key: string) => Shown;
  newRow: () => ConditionEntry;
  focusAfter: (key: string, change: () => void) => void;
  onChange: (change: (current: ConditionDraft) => ConditionDraft) => void;
}) {
  const { condition, problem, onChange } = props;
  const only = props.part.kind === "condition";
  const find = props.part.kind === "find" ? props.part : null;
  const step = props.part.kind === "find" || props.part.kind === "if" ? props.part : null;
  const name = step ? `Step ${step.number}, condition` : only ? "Condition" : "Match condition";
  const part = step ? `${props.part.kind}-${step.key}` : props.part.kind;
  // What the executor can read: a document's Find checks one field; a dataset's compares fields with ==.
  const operators = find === null ? Object.keys(OPERATOR_LABELS) as ConditionOperator[] : find.dataset ? ["is" as const] : ["is" as const, "contains" as const];
  const most = find !== null && !find.dataset ? 1 : Infinity;
  const empty = find ? "All records" : only ? "Always" : null;
  return (
    <>
      <select
        aria-label={find ? `Step ${find.number}, records to find` : step ? `Step ${step.number}, if` : only ? "Condition" : "Match"}
        data-focus={`${part}-mode`}
        value={condition.mode}
        onChange={(event) => {
          const mode = event.target.value as ConditionMode;
          onChange((current) => ({
            ...current,
            mode,
            // A formula starts from what the rows said.
            formula: mode === "formula" && current.mode === "rows" ? (props.expression ?? "") : current.formula,
            rows: mode === "rows" && current.rows.length === 0 ? [props.newRow()] : current.rows,
          }));
        }}
        className={selectClass}
        {...(condition.mode === "formula" ? {} : invalid(problem(props.problemKey)))}
      >
        {empty === null ? null : <option value="always">{empty}</option>}
        <option value="rows">Fields match</option>
        <option value="formula">Formula</option>
      </select>
      {condition.mode === "rows" ? (
        <>
          {condition.rows.map(({ key, row }, index) => {
            const field = props.fields.find((candidate) => candidate.name === row.field);
            const replace = (next: ConditionRow) =>
              onChange((current) => ({ ...current, rows: current.rows.map((entry) => (entry.key === key ? { key, row: next } : entry)) }));
            return (
              <div key={key} className="flex items-start gap-1">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <FieldSelect
                    label={`${name} ${index + 1}, field`}
                    fields={props.fields}
                    value={row.field}
                    collection={props.collection}
                    focusKey={`${part}-${key}-first`}
                    problem={problem(`${props.problemKey}/${key}/field`)}
                    onChange={(next) => replace({ ...row, field: next, value: comparedValue(props.fields.find((candidate) => candidate.name === next)) })}
                  />
                  <select
                    aria-label={`${name} ${index + 1}, comparison`}
                    value={row.operator}
                    onChange={(event) => replace({ ...row, operator: event.target.value as ConditionOperator })}
                    className={selectClass}
                  >
                    {operators.includes(row.operator) ? null : <option value={row.operator}>{OPERATOR_LABELS[row.operator]}</option>}
                    {operators.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}
                  </select>
                  <LiteralInput
                    label={`${name} ${index + 1}, value`}
                    type={field?.type ?? null}
                    options={field?.type === "select" || field?.type === "multi-select" ? field.options : []}
                    text={row.value === null ? "" : String(row.value)}
                    problem={problem(`${props.problemKey}/${key}`)}
                    onChange={(value) => replace({
                      ...row,
                      value: value.kind === "literal" && !Array.isArray(value.value) ? value.value : null,
                    })}
                  />
                  <Problem shown={problem(`${props.problemKey}/${key}`)} />
                </div>
                <IconButton
                  aria-label={`Remove ${name.toLowerCase()} ${index + 1}`}
                  title="Remove"
                  data-focus={`${part}-${key}-remove`}
                  onClick={() => {
                    const neighbor = condition.rows[index + 1] ?? condition.rows[index - 1];
                    props.focusAfter(neighbor ? `${part}-${neighbor.key}-remove` : `${part}-mode`, () => onChange((current) => {
                      const rows = current.rows.filter((entry) => entry.key !== key);
                      return { ...current, rows, mode: rows.length === 0 && empty !== null ? "always" : current.mode };
                    }));
                  }}
                >
                  <Trash2 size={13} aria-hidden />
                </IconButton>
              </div>
            );
          })}
          {condition.rows.length < most ? (
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1 self-start"
              onClick={() => {
                const entry = props.newRow();
                props.focusAfter(`${part}-${entry.key}-first`, () => onChange((current) => ({ ...current, rows: [...current.rows, entry] })));
              }}
            >
              <Plus size={12} aria-hidden />
              Add condition
            </SecondaryButton>
          ) : null}
        </>
      ) : condition.mode === "formula" ? (
        <input
          aria-label={step ? `Step ${step.number}, condition formula` : only ? "Condition formula" : "Condition to match"}
          value={condition.formula}
          spellCheck={false}
          placeholder={only ? 'record.Priority == "High"' : 'record.Status == "Blocked"'}
          onChange={(event) => onChange((current) => ({ ...current, formula: event.target.value }))}
          className={formulaClass}
          {...invalid(problem(props.problemKey))}
        />
      ) : null}
      <Problem shown={problem(props.problemKey)} />
    </>
  );
}

function ToValue({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="shrink-0 pt-1 text-[12px] text-muted">to</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A field a step can set or a condition can read: any but a Button field. */
const holdsValue = (field: FieldDefinition) => field.type !== "button";

// A step or row keeps its key while the draft changes, so React keeps its
// controls and focus can follow it.
/** `number` marks an action input typed as a number, which the automation stores as one. */
interface Row { key: number; value: FieldValue; number?: boolean }
type Branch = "do" | "otherwise";
interface StepEntry {
  key: number;
  step: AutomationStep;
  rows: Row[];
  /** The saved automation's reach verdict for this step, until it is edited. */
  verdict: string | null;
  /** An If's Do and Otherwise steps, which the draft holds instead of the step's own lists; null for any other step. */
  branches: Record<Branch, StepEntry[]> | null;
  /** A code step's other source while the step uses this one: its code while it runs a file, or its file while it runs code. */
  other?: string;
  /** What a Find step reads, or when an If runs its Do steps, which the draft holds instead of the step's condition; null for any other step. */
  condition: ConditionDraft | null;
}
/**
 * A result an earlier step names: the records a Find found, or the record
 * an Add a record step added. `table` is the dataset table that holds them,
 * or null outside a dataset or while the step has none.
 */
interface Binding { name: string; kind: "records" | "record"; collection: string | null; table: string | null }
/** A list of steps: the automation's own, or an If's Do or Otherwise. */
type ListId = "do" | `${number}/${Branch}`;

let nextKey = 0;
const newKey = () => (nextKey += 1);
const blankRow = (): Row => ({ key: newKey(), value: { field: "", value: { kind: "literal", value: "" } } });

function entryOf(step: AutomationStep, verdict: string | null, dataset: boolean, branches: StepEntry["branches"] = null): StepEntry {
  // An action's input shows as rows too: each row's field is the input's key.
  const values = step.kind === "set" || step.kind === "add-record" ? step.values
    : step.kind === "invoke" ? step.input.map(({ key, value }) => ({ field: key, value })) : [];
  // "All records" is a Find of true.
  const condition = step.kind === "find"
    ? conditionDraftOf(step.condition === "true" ? null : step.condition, (rows) => findRowsFit(rows, dataset))
    : step.kind === "if" ? conditionDraftOf(step.if) : null;
  return { key: newKey(), step, rows: values.map((value) => ({ key: newKey(), value })), verdict, branches, condition };
}

/**
 * Entries for `steps`, each with its saved verdict. `first` is the place of
 * the list's first verdict among the automation's, which counts an If's
 * steps after the If and before the steps that follow it.
 */
function entriesOf(steps: readonly AutomationStep[], reach: Reach | null, first: number, dataset: boolean): StepEntry[] {
  let next = first;
  return reachPlaces(steps, first).map((places, index) => {
    const step = steps[index]!;
    const start = next;
    next += places.length;
    if (step.kind !== "if") return entryOf(step, verdictOf(places, reach), dataset);
    return entryOf(step, null, dataset, {
      do: entriesOf(step.do, reach, start, dataset),
      otherwise: entriesOf(step.otherwise, reach, start + reachPlaces(step.do).flat().length, dataset),
    });
  });
}

/** The result a step names, or null. */
function bindingOf(step: AutomationStep, table: AutomationTable | null, trigger: string | null): Binding | null {
  if (step.kind !== "find" && step.kind !== "add-record") return null;
  if (step.as === null) return null;
  const home = table === null ? null : (tableOfStep(step, table, trigger) ?? null);
  return { name: step.as, kind: step.kind === "find" ? "records" : "record", collection: step.collection, table: home };
}

/**
 * Each entry in reading order, with the list that holds it, its number
 * among all steps, and the results it can use: those named earlier in its
 * list or in a list around it. A result named inside an If stays there.
 */
function entriesInOrder(entries: readonly StepEntry[], table: AutomationTable | null, trigger: string | null) {
  const all: Array<{
    entry: StepEntry; list: readonly StepEntry[]; listId: ListId; index: number; number: number; scope: readonly Binding[];
    /** The Ifs around the entry. */
    depth: number;
  }> = [];
  const walk = (list: readonly StepEntry[], listId: ListId, outer: readonly Binding[], depth: number) => {
    let scope = outer;
    list.forEach((entry, index) => {
      all.push({ entry, list, listId, index, number: all.length + 1, scope, depth });
      if (entry.branches !== null) {
        walk(entry.branches.do, `${entry.key}/do`, scope, depth + 1);
        walk(entry.branches.otherwise, `${entry.key}/otherwise`, scope, depth + 1);
      }
      const bound = bindingOf(entry.step, table, trigger);
      if (bound !== null && bound.name !== "") scope = [...scope, bound];
    });
  };
  walk(entries, "do", [], 0);
  return all;
}

/** `entries` with the list `id` changed by `change`. */
function changeList(entries: StepEntry[], id: ListId, change: (list: StepEntry[]) => StepEntry[], here: ListId = "do"): StepEntry[] {
  if (here === id) return change(entries);
  return entries.map((entry) => (entry.branches === null ? entry : {
    ...entry,
    branches: {
      do: changeList(entry.branches.do, id, change, `${entry.key}/do`),
      otherwise: changeList(entry.branches.otherwise, id, change, `${entry.key}/otherwise`),
    },
  }));
}

const listProblem = (id: ListId) => `list:${id}`;

// File contract codes about a field's or an action input's name, not its value.
const NAME_CODES: ReadonlySet<AutomationDiagnostic["code"]> = new Set(["duplicate-key", "reserved-field-name", "reserved-input-key"]);

/**
 * Where a JSON Pointer from the automation lands in the builder: the key of
 * the part that shows its problem, and the name of an action input or field
 * the part does not show on its own. `edits` says which steps show rows, and
 * `part` which of a row's controls the problem is about.
 */
function placeOf(
  path: string,
  entries: readonly StepEntry[],
  edits: (entry: StepEntry) => boolean,
  part: "field" | "value" = "value",
): { key: string; name: string | null; step?: AutomationStep["kind"] } {
  const parts = path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const [head, option] = parts;
  if (head === "name") return { key: "name", name: null };
  if (head === "if") return { key: "if", name: null };
  if (head === "when") {
    const keys: Partial<Record<string, string>> = {
      to: "when/to", "field-changed": "when/field", "starts-matching": "when/condition", "record-changed": "when/fields", button: "when/button",
      at: "when/at", days: "when/days", timezone: "when/timezone", "group-message": "when/group", "starts-with": "when/startsWith",
    };
    return { key: keys[option ?? ""] ?? "when", name: null };
  }
  if (head !== "do") return { key: "save", name: null };
  let list = entries;
  let listId: ListId = "do";
  for (let at = 1; ; at += 2) {
    const entry = list[Number(parts[at])];
    if (entry === undefined) return { key: listProblem(listId), name: null };
    const [kind, name] = [parts[at + 1], parts[at + 2]];
    if (entry.branches !== null && (kind === "do" || kind === "otherwise")) {
      list = entry.branches[kind];
      listId = `${entry.key}/${kind}`;
      continue;
    }
    if (name === undefined) {
      // A Find's condition, a result's name, and a Set's records each have a control where the step edits.
      const control = kind === "find" || kind === "if" ? "condition" : kind === "run" || kind === "run-file" ? "source"
        : kind === "post" || kind === "notify" || kind === "wake-agent" ? "message" : kind === "group" ? "group"
        : kind === "as" || kind === "records" ? kind : null;
      return { key: control !== null && edits(entry) ? `step-${entry.key}/${control}` : `step-${entry.key}`, name: null, step: entry.step.kind };
    }
    if (kind !== "set" && kind !== "add-record" && kind !== "input") return { key: `step-${entry.key}`, name: null };
    const row = edits(entry) ? entry.rows.find(({ value }) => value.field === name) : undefined;
    return row === undefined ? { key: `step-${entry.key}`, name } : { key: `row-${row.key}/${part}`, name: null };
  }
}

type InvokeStep = Extract<AutomationStep, { kind: "invoke" }>;

/** An action step the builder edits: one in a dataset Collection's own list of steps. */
function editableAction(step: AutomationStep, table: AutomationTable | null): InvokeStep | null {
  return step.kind === "invoke" && table !== null ? step : null;
}

/** A step's saved verdict, from its places among the automation's verdicts, as one sentence; or null when it may run. */
function verdictOf(places: readonly number[], reach: Reach | null): string | null {
  if (reach === null || reach.kind !== "checked") return null;
  for (const place of places) {
    const verdict = reach.steps[place];
    if (verdict?.verdict === "stopped") return verdict.reason;
    if (verdict?.verdict === "held") {
      const reached = automationReachCopy(verdict);
      return `This step can now ${reached}, and waits for someone who can edit this Collection to allow it.`;
    }
  }
  return null;
}

/**
 * A trigger of `kind`, watching the table the current one names, or else
 * `own`: this Collection's dataset table, or null. A new one watches the
 * first of `fields`, or of `buttons`.
 */
function triggerFor(
  kind: BuilderTrigger,
  current: AutomationTrigger,
  fields: readonly FieldDefinition[],
  buttons: readonly FieldDefinition[],
  own: string | null,
): AutomationTrigger {
  const table = "table" in current && current.table !== null ? current.table : own;
  switch (kind) {
    case "field-changed":
      return current.kind === "field-changed" ? current : { kind, field: fields[0]?.name ?? "", to: null, table };
    case "record-changed":
      return current.kind === "record-changed" ? current : { kind, fields: null, table };
    case "button":
      return current.kind === "button" ? current : { kind, field: buttons[0]?.name ?? "", table };
    case "starts-matching":
      return current.kind === "starts-matching" ? current : { kind, condition: "", table };
    case "schedule":
      return current.kind === "schedule" ? current : scheduleFor("day", current);
    case "group-message":
      return current.kind === "group-message" ? current : { kind, group: "", startsWith: null };
    default:
      return { kind, table };
  }
}

/**
 * A step for this computer's person that the builder edits: notify you, or
 * wake your agent. `you` is how steps name that person, which the builder
 * writes and never shows; null where no step can name them that way.
 */
function yourStep(step: AutomationStep, you: string | null): YourStep | null {
  if (you === null) return null;
  if (step.kind === "wake-agent") return step.person === you ? step : null;
  if (step.kind !== "notify" || step.to.length !== 1) return null;
  const [person] = step.to;
  return person?.kind === "literal" && person.value === you ? step : null;
}

/** The trigger kind the builder edits, or null when only the file can. */
function builderTriggerOf(trigger: AutomationTrigger): BuilderTrigger | null {
  return trigger.kind in TRIGGER_LABELS ? (trigger.kind as BuilderTrigger) : null;
}

/**
 * A step the builder edits: fields set on a record, or a record added. In
 * a dataset, an Add record that names another Collection, or an operation
 * the dataset lacks, reads as its sentence and the file edits it.
 */
function editableStep(step: AutomationStep, table: AutomationTable | null, trigger: string | null): SetStep | AddStep | null {
  if (step.kind === "set") return step;
  return step.kind === "add-record" && inDataset(step, table, trigger) ? step : null;
}

/** A Find the builder edits: in a dataset, one on a table of its own, as an Add a record. */
function editableFind(step: AutomationStep, table: AutomationTable | null, trigger: string | null): FindStep | null {
  return step.kind === "find" && inDataset(step, table, trigger) ? step : null;
}

/** True outside a dataset, or for a step that stays in its dataset on a table the builder can name. */
function inDataset(step: AddStep | FindStep, table: AutomationTable | null, trigger: string | null): boolean {
  return table === null || (step.collection === null && tableOfStep(step, table, trigger) !== undefined);
}

/**
 * The dataset table a Find reads or an Add a record adds to: its
 * operation's, or else `trigger`, the table the trigger watches, which
 * saving pins it to. Null when the trigger watches no table, so the step
 * must choose one; undefined for an operation the dataset does not have.
 */
function tableOfStep(step: AddStep | FindStep, table: AutomationTable, trigger: string | null): string | null | undefined {
  return step.operation === null ? trigger : tableOfOperation(step.operation, table);
}

/** The dataset table that holds an operation, or undefined when the dataset has none of that name. */
function tableOfOperation(operation: string, table: AutomationTable): string | undefined {
  for (const [name, { operations }] of table.tables) {
    if (operations.some((candidate) => candidate.name === operation)) return name;
  }
  return undefined;
}

// The operation a step of each kind needs, and what a table without one cannot do.
const STEP_OPERATIONS = {
  find: { kind: "read", missing: "cannot find records" },
  "add-record": { kind: "create", missing: "cannot add records" },
} as const;

const BRANCH_LABELS: Record<Branch, string> = { do: "Do", otherwise: "Otherwise" };
// A result name the file contract takes, apart from the reserved names main's check reports.
const RESULT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

/**
 * The rows a Find can hold: in a dataset, fields compared with is; in a
 * document Collection, one field with is or contains. Other rows stay a
 * formula, which the executor refuses when it cannot read it.
 */
function findRowsFit(rows: readonly ConditionRow[], dataset: boolean): boolean {
  return dataset ? rows.every((row) => row.operator === "is") : rows.length === 1 && rows[0]!.operator !== "is-not";
}

/** A condition's draft: rows when rows wrote it and `fit` takes them, else a formula; Always when there is none. */
function conditionDraftOf(expression: string | null, fit: (rows: readonly ConditionRow[]) => boolean = () => true): ConditionDraft {
  const parsed = expression === null ? null : conditionRows(expression);
  const read = parsed !== null && fit(parsed) ? parsed : [];
  const rows = read.map((row) => ({ key: newKey(), row }));
  return {
    mode: expression === null ? "always" : rows.length > 0 ? "rows" : "formula",
    formula: expression ?? "",
    rows,
    saved: expression === null || rows.length === 0 ? null : { rows, expression },
  };
}

/** What the builder's controls hold, which the automation is built from. */
interface Draft {
  name: string;
  when: AutomationTrigger;
  /** Only if. */
  condition: ConditionDraft;
  /** What a record starts to match. While that trigger is chosen, its condition is built from this. */
  matching: ConditionDraft;
  steps: StepEntry[];
}

function draftOf(automation: Automation, reach: Reach | null, dataset: boolean): Draft {
  return {
    name: automation.name,
    when: automation.when,
    condition: conditionDraftOf(automation.if),
    matching: conditionDraftOf(automation.when.kind === "starts-matching" ? automation.when.condition : null),
    steps: entriesOf(automation.do, reach, automation.when.kind === "group-message" ? 1 : 0, dataset),
  };
}

export function AutomationBuilder(props: {
  workspaceId: string;
  collectionPath: string;
  /** The dataset table this Collection is, which a new trigger watches, or null for a document Collection. */
  table: AutomationTable | null;
  fields: readonly FieldDefinition[];
  /** The draft to start from: the saved automation, a new one with an empty id, or a draft kept from before. */
  automation: Automation;
  /** What counts as unchanged: the saved automation, or a new one's start. */
  baseline: Automation;
  /** Why the saved version does not run, such as a field the Collection lacks. */
  cannotRun: string | null;
  /** The saved version's reach, or null for a new automation. */
  reach: Reach | null;
  /** The dataset tables where Undo keeps the records an Add record step adds: no approved delete qualifies. */
  addsStay: readonly string[];
  takenIds: ReadonlySet<string>;
  saving: boolean;
  /** The file has entries dohc cannot read, so nothing can be saved now. */
  readOnly: boolean;
  /** Someone asked to leave: Back, Close, Cancel, or a notice. */
  leaveRequested: boolean;
  onLeave: () => void;
  onStay: () => void;
  onDraftChange: (draft: { automation: Automation; dirty: boolean }) => void;
  onSave: (automation: Automation) => void;
  onCancel: () => void;
  /** Opens a workspace file: the automations file, or a file a code step runs. */
  onOpenFile: (path: string) => void;
  /** Opens the dialog that adds fields, such as a Button field; undefined where this person cannot. */
  onOpenFields?: () => void;
  /** How a step names this computer's person, in a workspace proved never shared; otherwise null. */
  you: string | null;
  /** What stops or delays this workspace's schedules, from the panel; shown under a schedule. */
  scheduleHost: ReactNode;
  onError: ErrorReport;
}) {
  const { workspaceId, collectionPath, table, onError } = props;
  const isNew = props.automation.id === "";
  const problemIds = useId();
  const [draft, setDraft] = useState(() => draftOf(props.automation, props.reach, props.table !== null));
  const [attempted, setAttempted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saveChosen, setSaveChosen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  // The Groups a Group trigger or a Post in a Group step can name: null until main answers, "failed" when it
  // could not, and "unavailable" in a shared view, whose automations run on the owner's computer.
  const [groupList, setGroupList] = useState<readonly Group[] | null | "failed" | "unavailable">(null);
  const groups = groupList === "failed" || groupList === "unavailable" ? null : groupList;
  /** The first Group whose messages can start the automation, or that can take its post, as a step names it; "" when none can. */
  const firstGroup = (use: "read" | "post") => {
    const found = (groups ?? []).find((group) => (use === "read" ? group.readStopped : group.postStopped) === null);
    return found?.ref ?? "";
  };
  const [schemas, setSchemas] = useState(() => new Map<string, readonly FieldDefinition[]>([[collectionPath, props.fields.filter(holdsValue)]]));
  const [checked, setChecked] = useState<{
    key: string;
    diagnostics: AutomationDiagnostic[];
    formulaProblems: CheckCollectionAutomationResult["formulaProblems"];
    cannotRun: string | null;
    missingFiles: readonly string[];
  } | null>(null);
  // Counts Saves that found a problem, each of which moves focus to the first one shown and says how many there are.
  const [refused, setRefused] = useState(0);
  const [announced, setAnnounced] = useState("");
  // Answers for another workspace or Collection, or after the builder
  // closes, change nothing here.
  const scope = useRequestSequence([workspaceId, collectionPath]);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input[aria-label="Name"]')?.focus();
  }, []);
  // Moving, removing, or adding a step or row takes away or adds the control
  // that had focus, so focus goes to the control named `key` once the change
  // is on screen.
  const focusAfter = (key: string, change: () => void) => {
    flushSync(change);
    form.current?.querySelector<HTMLElement>(`[data-focus="${key}"]`)?.focus();
  };

  // A dataset table is the Collection a person sees, so it goes by the table's name.
  const own = table?.name ?? collectionName(collectionPath);
  // The table the trigger watches, whose record Only if reads and Set fields changes.
  const watchedBy = (trigger: AutomationTrigger) => (table !== null && "table" in trigger && trigger.table !== null ? trigger.table : own);
  const watched = watchedBy(draft.when);
  // A trigger moved to another table keeps names that table may lack, and
  // main cannot check a dataset's fields, so those names must change first.
  // On the table it was saved on, or a new one started on, a missing field only warns.
  const moved = watched !== watchedBy(props.baseline.when);
  const watchedFields = table === null ? props.fields : (table.tables.get(watched)?.fields ?? []);
  // The table a dataset step without an operation works on: the trigger's, or the only one. A schedule or a Group message has none.
  const triggerTable = table === null ? null
    : "table" in draft.when ? watched
    : table.tables.size === 1 ? table.name : null;
  const recordFields = watchedFields.filter(holdsValue);
  const buttonFields = watchedFields.filter((field) => !holdsValue(field));
  const typeIn = (fields: readonly FieldDefinition[] | null, field: string): CollectionFieldType | null =>
    fields?.find((candidate) => candidate.name === field)?.type ?? null;
  const ordered = entriesInOrder(draft.steps, table, triggerTable);
  const placedByKey = new Map(ordered.map((placed) => [placed.entry.key, placed]));
  /** The result a Set fields step changes, when the step names one its list has. */
  const recordsOf = (entry: StepEntry): Binding | undefined => {
    const records = entry.step.kind === "set" ? entry.step.records : null;
    return records === null ? undefined : placedByKey.get(entry.key)?.scope.find((bound) => bound.name === records);
  };
  /** The Collection a step's rows or condition name. */
  const targetOf = (entry: StepEntry) => {
    const { step } = entry;
    if (step.kind === "add-record" || step.kind === "find") return step.collection ?? collectionPath;
    return recordsOf(entry)?.collection ?? collectionPath;
  };
  /** The dataset table a step's rows or condition name, or null outside a dataset or while the step has none. */
  const datasetTableOf = (entry: StepEntry): string | null => {
    const { step } = entry;
    if (table === null) return null;
    if (step.kind === "find" || step.kind === "add-record") return tableOfStep(step, table, triggerTable) ?? null;
    return recordsOf(entry)?.table ?? null;
  };
  /** The fields a step's rows or condition name: a found or added record's, or the trigger record's. Null while they load. */
  const fieldsOf = (entry: StepEntry) => {
    if (entry.step.kind === "set" && entry.step.records === null) return recordFields;
    if (table === null) return schemas.get(targetOf(entry)) ?? null;
    const home = datasetTableOf(entry);
    return home === null ? [] : (table.tables.get(home)?.fields ?? []).filter(holdsValue);
  };
  // Number fields hold typed text in the draft; the automation holds numbers.
  const numbered = (fields: readonly FieldDefinition[] | null, values: readonly Row[]): FieldValue[] =>
    values.map(({ value: entry }) => {
      if (entry.value.kind !== "literal") return entry;
      const value = numberValue(typeIn(fields, entry.field), entry.value.value);
      return value === undefined ? entry : { field: entry.field, value: { kind: "literal", value } };
    });
  const rowValue = (row: ConditionRow, fields: readonly FieldDefinition[] | null = recordFields) =>
    numberValue(typeIn(fields, row.field), row.value) ?? row.value;
  // Rows nobody changed write the file's expression back as it was, such as "2" compared as text.
  const conditionOf = (condition: ConditionDraft, fields: readonly FieldDefinition[] | null = recordFields): string | null =>
    condition.mode === "always" ? null
      : condition.mode === "formula" ? condition.formula
      : condition.rows === condition.saved?.rows ? condition.saved.expression
      : conditionFormula(condition.rows.map(({ row }) => ({ ...row, value: rowValue(row, fields) })));
  const when: AutomationTrigger = draft.when.kind === "field-changed" && draft.when.to?.kind === "literal"
    ? {
        ...draft.when,
        to: { kind: "literal" as const, value: numberValue(typeIn(recordFields, draft.when.field), draft.when.to.value) ?? draft.when.to.value },
      }
    : draft.when.kind === "starts-matching" ? { ...draft.when, condition: conditionOf(draft.matching) ?? "" }
    : draft.when;
  const stepOf = (entry: StepEntry): AutomationStep => {
    const { step, rows, branches } = entry;
    if (step.kind === "if" && branches !== null) {
      return { ...step, if: entry.condition === null ? step.if : (conditionOf(entry.condition) ?? ""), do: branches.do.map(stepOf), otherwise: branches.otherwise.map(stepOf) };
    }
    if (step.kind === "find" && entry.condition !== null && editableFind(step, table, triggerTable) !== null) {
      return { ...step, condition: conditionOf(entry.condition, fieldsOf(entry)) ?? "true" };
    }
    const action = editableAction(step, table);
    if (action) {
      return { ...action, input: rows.map(({ value: entry, number }) => ({
        key: entry.field,
        value: number && entry.value.kind === "literal" ? { kind: "literal", value: numberValue("number", entry.value.value) ?? entry.value.value } : entry.value,
      })) };
    }
    const editable = editableStep(step, table, triggerTable);
    if (editable === null) return step;
    // A Set whose records moved to another table, as when its Find reads
    // another now, drops the old table's operation, so saving pins one there.
    const home = editable.kind === "set" && table !== null ? (editable.records === null ? watched : recordsOf(entry)?.table) : undefined;
    // An operation the dataset lacks is a problem for the file to show, not a move.
    const pinned = editable.kind === "set" && editable.operation !== null ? tableOfOperation(editable.operation, table!) : undefined;
    const kept = pinned !== undefined && home !== undefined && home !== null && pinned !== home ? { ...editable, operation: null } : editable;
    // A step nobody edited stays as the file holds it, such as a number field's "001".
    if (kept === editable && JSON.stringify(rows.map(({ value }) => value)) === JSON.stringify(editable.values)) return step;
    return { ...kept, values: numbered(fieldsOf(entry), rows) };
  };
  const automation: Automation = {
    ...props.automation,
    name: draft.name,
    when,
    if: conditionOf(draft.condition),
    do: draft.steps.map(stepOf),
  };
  const full = ordered.length >= MAX_STEPS;
  const editableOf = (entry: StepEntry) => editableStep(entry.step, table, triggerTable);
  const edits = (entry: StepEntry) =>
    entry.step.kind === "if" || entry.step.kind === "run" || entry.step.kind === "run-file" || entry.step.kind === "post" ||
    yourStep(entry.step, props.you) !== null || editableAction(entry.step, table) !== null || editableOf(entry) !== null || editableFind(entry.step, table, triggerTable) !== null;
  const dirty = JSON.stringify(automation) !== JSON.stringify(props.baseline);
  // What Save writes: a draft without a name takes its sentence, and a new
  // one an id from its name. Main checks exactly this.
  const finalName = automation.name.trim() || sentenceText(automationSentence(automation)).slice(0, MAX_NAME_LENGTH);
  const candidate: Automation = { ...automation, name: finalName, id: isNew ? idFor(finalName, props.takenIds) : automation.id };
  const automationKey = JSON.stringify(candidate);
  const draftKey = JSON.stringify(automation);
  // The draft main checks last: an answer for an older one, arriving late, never replaces it.
  const latestKey = useRef(automationKey);
  latestKey.current = automationKey;
  const latestCandidate = useRef(candidate);
  latestCandidate.current = candidate;
  useEffect(() => {
    props.onDraftChange({ automation, dirty });
  }, [draftKey, dirty]);

  // A schedule's next run moves on once it comes due, and when the window
  // gets focus, as after the computer sleeps or changes time zone. A wait
  // longer than a timer holds fires early, so each tick sets the next one.
  const [clock, setClock] = useState(0);
  const nextRunAt = draft.when.kind === "schedule" ? (nextRunOf(draft.when)?.at ?? null) : null;
  useEffect(() => {
    if (nextRunAt === null) return;
    const again = () => setClock((value) => value + 1);
    const timer = window.setTimeout(again, Math.min(Math.max(nextRunAt - Date.now(), 0) + 1, LONGEST_TIMEOUT_MS));
    window.addEventListener("focus", again);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", again);
    };
  }, [nextRunAt, clock]);

  // Leaving with nothing changed needs no question.
  useEffect(() => {
    if (props.leaveRequested && !dirty) props.onLeave();
    if (!props.leaveRequested) setSaveChosen(false);
  }, [props.leaveRequested]);

  // The Groups on this computer, read while a Group choice is on screen, and
  // again when the window gets focus, as after a Group or a share changes.
  const groupRequests = useRequestSequence([workspaceId, collectionPath]);
  // A failure is reported once, until a read succeeds again.
  const groupsFailed = useRef(false);
  // The reading that is on now: a Try again from an earlier one, as after its Group choices went, reads nothing.
  const groupsReading = useRef<object | null>(null);
  const readGroups = (reading: object) => {
    if (reading !== groupsReading.current) return;
    const token = groupRequests.next();
    const current = () => reading === groupsReading.current && groupRequests.isCurrent(token);
    void bridge()
      .listAutomationGroups({ workspaceId, collectionPath })
      .then((result) => {
        if (!current()) return;
        groupsFailed.current = false;
        setGroupList("groups" in result ? result.groups : "unavailable");
      })
      .catch((error: unknown) => {
        if (!current()) return;
        setGroupList((list) => (list === null || list === "failed" ? "failed" : list));
        if (groupsFailed.current) return;
        groupsFailed.current = true;
        onError("dohc could not list the Groups an automation can use.", error, () => readGroups(reading));
      });
  };
  const choosesGroups = draft.when.kind === "group-message" || ordered.some(({ entry }) => entry.step.kind === "post");
  useEffect(() => {
    if (!choosesGroups) return;
    const reading = {};
    groupsReading.current = reading;
    // Its first failure is reported, with a Try again that works.
    groupsFailed.current = false;
    const read = () => readGroups(reading);
    read();
    window.addEventListener("focus", read);
    return () => {
      groupsReading.current = null;
      window.removeEventListener("focus", read);
    };
  }, [workspaceId, collectionPath, choosesGroups]);

  // The Collections a Find or an Add a record step can reach. A dataset's
  // steps stay in its own tables, so it asks for none.
  useEffect(() => {
    if (table !== null) return;
    const epoch = scope.current();
    void bridge()
      .listAutomationTargets({ workspaceId, collectionPath })
      .then((result) => {
        if (scope.isCurrent(epoch) && "collections" in result) setTargets(result.collections);
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("dohc could not list the Collections an automation can change.", error);
      });
  }, [workspaceId, collectionPath]);

  // The fields of each other Collection a step adds records to.
  const targetPaths = useMemo(
    () => [...new Set(entriesInOrder(draft.steps, table, triggerTable).flatMap(({ entry: { step } }) =>
      ((step.kind === "add-record" || step.kind === "find") && step.collection !== null ? [step.collection] : [])))],
    [draft.steps],
  );
  useEffect(() => {
    const epoch = scope.current();
    for (const path of targetPaths) {
      if (schemas.has(path)) continue;
      void bridge()
        .getCollection({ workspaceId, collectionPath: path })
        .then((result) => {
          if (scope.isCurrent(epoch)) setSchemas((current) => new Map(current).set(path, result.schema.fields.filter(holdsValue)));
        })
        .catch((error: unknown) => {
          if (scope.isCurrent(epoch)) onError(`dohc could not read the fields of ${collectionName(path)}.`, error);
        });
    }
  }, [targetPaths.join("\n")]);

  /** Main's check of this exact automation: what the file contract refuses, and each formula's syntax. */
  const check = async (target: Automation, key: string) => {
    const result = await bridge().checkCollectionAutomation({ workspaceId, collectionPath, automation: target });
    return { key, diagnostics: result.diagnostics, formulaProblems: result.formulaProblems, cannotRun: result.cannotRun, missingFiles: result.missingFiles };
  };
  // Checked a moment after the person stops typing, so a formula's syntax
  // error shows as it happens.
  useEffect(() => {
    const epoch = scope.current();
    const timer = setTimeout(() => {
      void check(candidate, automationKey)
        .then((answer) => {
          if (scope.isCurrent(epoch) && answer.key === latestKey.current) setChecked(answer);
        })
        // Save checks again; a failure there is reported.
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [automationKey, workspaceId]);

  // What keeps the draft from saving, keyed by the part it belongs to.
  const problems = new Map<string, string>();
  const current = checked?.key === automationKey ? checked : null;
  const formulaProblem = (key: string, expression: string) => {
    if (expression.trim() === "") problems.set(key, "Write a formula.");
  };
  // Fields a record-changed trigger names that its table lacks, which stay chosen until someone clears them.
  const missingFields = draft.when.kind === "record-changed"
    ? (draft.when.fields ?? []).filter((name) => !recordFields.some((field) => field.name === name))
    : [];
  // What Chosen fields lists, in the order it keeps them.
  const fieldChoices = [...missingFields, ...recordFields.map((field) => field.name)];
  const lacks = (fields: readonly FieldDefinition[], name: string) => moved && name !== "" && !fields.some((field) => field.name === name);
  const notAField = (name: string) => `${name} is not a field in ${watched}. Choose a field.`;
  if (automation.when.kind === "field-changed") {
    if (automation.when.field === "") problems.set("when/field", "Choose a field.");
    else if (lacks(recordFields, automation.when.field)) problems.set("when/field", notAField(automation.when.field));
    if (automation.when.to?.kind === "formula") formulaProblem("when/to", automation.when.to.expression);
  }
  if (automation.when.kind === "record-changed" && automation.when.fields?.length === 0) problems.set("when/fields", "Choose at least one field.");
  const lost = moved ? missingFields : [];
  if (lost.length > 0) {
    problems.set("when/fields", `${lost.join(", ")} ${lost.length === 1 ? "is not a field" : "are not fields"} in ${watched}. Clear ${lost.length === 1 ? "it" : "them"}.`);
  }
  if (automation.when.kind === "button" && automation.when.field === "") problems.set("when/button", "Choose a button.");
  else if (automation.when.kind === "button" && lacks(buttonFields, automation.when.field)) {
    problems.set("when/button", `${automation.when.field} is not a button in ${watched}. Choose a button.`);
  }
  // A Find's rows name its Collection's fields, which a moved trigger does not change.
  const conditionProblems = (condition: ConditionDraft, key: string, fields: readonly FieldDefinition[] | null = recordFields) => {
    if (condition.mode === "formula") formulaProblem(key, condition.formula);
    if (condition.mode !== "rows") return;
    if (condition.rows.length === 0) problems.set(key, "Add a condition.");
    for (const { key: entry, row } of condition.rows) {
      if (row.field === "") problems.set(`${key}/${entry}`, "Choose a field.");
      else if (fields === recordFields && lacks(recordFields, row.field)) problems.set(`${key}/${entry}/field`, notAField(row.field));
      // Rows nobody changed write their own text back, which the file already takes.
      else if (condition.rows !== condition.saved?.rows && typeIn(fields, row.field) === "number" && row.value !== null &&
        typeof rowValue(row, fields) !== "number") {
        problems.set(`${key}/${entry}`, "Enter a number.");
      }
    }
  };
  const noRecord = automation.when.kind === "schedule" || automation.when.kind === "group-message";
  if (automation.when.kind === "group-message" && automation.when.group === "") problems.set("when/group", "Choose a Group.");
  if (automation.when.kind === "group-message" && /^\s/u.test(automation.when.startsWith ?? "")) {
    problems.set("when/startsWith", "Remove the space at the start.");
  }
  if (automation.when.kind === "schedule") {
    const schedule = automation.when;
    if (schedule.at === "") problems.set("when/at", "Choose a time.");
    if (schedule.every === "week" || schedule.every === "month") {
      if (schedule.days.length === 0) problems.set("when/days", "Choose at least one day.");
    }
  }
  conditionProblems(draft.condition, "if");
  // A schedule has no record, so rows that compare its fields cannot hold; that comes before what the rows lack.
  if (noRecord && draft.condition.mode === "rows") {
    problems.set("if", "This trigger has no record to compare. Choose Always, or write a formula.");
  }
  if (automation.when.kind === "starts-matching") conditionProblems(draft.matching, "when/condition");
  if (draft.steps.length === 0) problems.set(listProblem("do"), "Add a step.");
  for (const { entry } of ordered) {
    const { key, step, rows, branches } = entry;
    if (branches !== null && branches.do.length === 0) problems.set(listProblem(`${key}/do`), "Add a step.");
    const bound = bindingOf(step, table, triggerTable);
    if (step.kind === "find" && step.as === "") problems.set(`step-${key}/as`, "Name the result, so later steps can use it.");
    else if (bound !== null && !RESULT_NAME.test(bound.name)) {
      problems.set(`step-${key}/as`, "A result name starts with a letter or _, then uses only letters, digits, and _.");
    }
    if (step.kind === "post") {
      if (step.group === "") problems.set(`step-${key}/group`, "Choose a Group.");
      if (step.text.trim() === "") problems.set(`step-${key}/message`, "Write a message.");
    }
    if (yourStep(step, props.you)?.text.trim() === "") problems.set(`step-${key}/message`, "Write a message.");
    if (step.kind === "run" || step.kind === "run-file") {
      if (step.kind === "run" && step.code.trim() === "") problems.set(`step-${key}/source`, "Write the code this step runs.");
      else if (step.kind === "run" && step.code.length > MAX_CODE_LENGTH) {
        problems.set(`step-${key}/source`, `This code is longer than ${MAX_CODE_LENGTH.toLocaleString()} characters. Move it to a file.`);
      }
      if (step.kind === "run-file" && step.file.trim() === "") problems.set(`step-${key}/source`, "Name the file this step runs.");
      if (step.as !== null && !RESULT_NAME.test(step.as)) {
        problems.set(`step-${key}/as`, "A result name starts with a letter or _, then uses only letters, digits, and _.");
      }
    }
    const find = editableFind(step, table, triggerTable);
    // A step in a dataset whose trigger watches no table names its own.
    if ((find !== null || editableOf(entry)?.kind === "add-record") && table !== null && datasetTableOf(entry) === null) {
      problems.set(`step-${key}/table`, "Choose a table.");
    }
    if (find !== null && entry.condition !== null) {
      conditionProblems(entry.condition, `step-${key}/condition`, fieldsOf(entry));
      continue;
    }
    if (step.kind === "if" && entry.condition !== null) {
      conditionProblems(entry.condition, `step-${key}/condition`);
      if (noRecord && entry.condition.mode === "rows") {
        problems.set(`step-${key}/condition`, "This trigger has no record to compare. Write a formula.");
      }
      continue;
    }
    const action = editableAction(step, table);
    if (action !== null) {
      const seen = new Set<string>();
      rows.forEach(({ key: row, value: entry, number }) => {
        if (entry.field.trim() === "") problems.set(`row-${row}/field`, "Name this input.");
        else if (seen.has(entry.field)) problems.set(`row-${row}/field`, `${entry.field} is in this step twice.`);
        seen.add(entry.field);
        if (entry.value.kind === "formula") formulaProblem(`row-${row}/value`, entry.value.expression);
        if (number && entry.value.kind === "literal" && typeof numberValue("number", entry.value.value) !== "number") {
          problems.set(`row-${row}/value`, "Enter a number.");
        }
      });
      continue;
    }
    const editable = editableOf(entry);
    if (editable === null) continue;
    if (rows.length === 0) problems.set(`step-${key}/values`, editable.kind === "set" ? "Add a field to set." : "Add a field.");
    if (editable.kind === "set" && editable.records === null && automation.when.kind === "record-removed") {
      problems.set(`step-${key}`, "A removed record has no fields to set. Choose another trigger, or remove this step.");
    }
    const seen = new Set<string>();
    const fields = fieldsOf(entry);
    rows.forEach(({ key: row, value: entry }) => {
      if (entry.field === "") problems.set(`row-${row}/field`, "Choose a field.");
      else if (editable.kind === "set" && editable.records === null && lacks(recordFields, entry.field)) problems.set(`row-${row}/field`, notAField(entry.field));
      else if (seen.has(entry.field)) problems.set(`row-${row}/field`, `${entry.field} is in this step twice.`);
      seen.add(entry.field);
      if (entry.value.kind === "formula") formulaProblem(`row-${row}/value`, entry.value.expression);
      if (entry.value.kind === "literal" && typeIn(fields, entry.field) === "number" &&
        numberValue("number", entry.value.value) === undefined) {
        problems.set(`row-${row}/value`, "Enter a number.");
      }
    });
  }
  // A syntax error shows as the person types; the rest once they try to save.
  const syntaxKeys = new Set<string>();
  for (const found of current?.formulaProblems ?? []) {
    const { key, name, step: kind } = placeOf(found.path, draft.steps, edits);
    if (problems.has(key)) continue;
    problems.set(key, "code" in found ? unsaved(found.code)
      : kind === "run" ? `The code has a syntax error. ${found.problem}`
      : `${name === null ? "This formula" : `The formula for ${name}`} has a syntax error. ${found.problem}`);
    syntaxKeys.add(key);
  }
  // What main's check found that the builder did not: shown once the person tries to save.
  for (const diagnostic of current?.diagnostics ?? []) {
    const path = diagnostic.path.replace(/^\/automations\/0/u, "");
    const { key } = placeOf(path, draft.steps, edits, NAME_CODES.has(diagnostic.code) ? "field" : "value");
    if (!problems.has(key)) problems.set(key, unsaved(diagnostic.code));
  }
  const problem = (key: string): Shown => {
    const text = problems.get(key);
    return text !== undefined && (attempted || syntaxKeys.has(key)) ? { id: `${problemIds}${key.replace(/[^\w-]/gu, "_")}`, text } : null;
  };
  // A Save that found a problem moves focus to the first one on screen:
  // the control it describes, or else the first control of its step.
  useEffect(() => {
    if (refused === 0) return;
    const all = form.current?.querySelectorAll<HTMLElement>("[data-problem]") ?? [];
    const shown = all[0];
    if (!shown) return;
    // A space that comes and goes changes the text, so a second refusal with the same count is announced too.
    setAnnounced(`${all.length === 1 ? "1 problem. It is focused." : `${all.length} problems. The first is focused.`}${refused % 2 === 0 ? " " : ""}`);
    const control = form.current?.querySelector<HTMLElement>(`[aria-describedby="${shown.id}"]`) ??
      shown.closest("[data-step]")?.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)");
    control?.focus();
  }, [refused]);

  const save = async (): Promise<boolean> => {
    setAttempted(true);
    const refuse = () => {
      setRefused((count) => count + 1);
      return false;
    };
    if (problems.size > 0) return refuse();
    // Never write what the file contract refuses: check this exact draft.
    let answer = checked?.key === automationKey ? checked : null;
    if (answer === null) {
      const epoch = scope.current();
      setChecking(true);
      try {
        answer = await check(candidate, automationKey);
      } catch (error) {
        if (scope.isCurrent(epoch)) onError("dohc could not check this automation.", error, () => void save());
        return false;
      } finally {
        if (scope.isCurrent(epoch)) setChecking(false);
      }
      if (!scope.isCurrent(epoch)) return false;
      setChecked(answer);
    }
    if (answer.diagnostics.length > 0 || answer.formulaProblems.length > 0) return refuse();
    props.onSave(candidate);
    return true;
  };

  const setSteps = (id: ListId, change: (list: StepEntry[]) => StepEntry[]) =>
    setDraft((current) => ({ ...current, steps: changeList(current.steps, id, change) }));
  const setStep = (key: number, change: (entry: StepEntry) => StepEntry) =>
    setSteps(placedByKey.get(key)!.listId, (list) => list.map((entry) => (entry.key === key ? { ...change(entry), verdict: null } : entry)));
  const moveStep = (key: number, by: -1 | 1) => {
    const { list, listId, index } = placedByKey.get(key)!;
    const to = index + by;
    // Focus stays on the arrow that moved it, or the other one at an edge.
    const edge = to === 0 || to === list.length - 1;
    focusAfter(`step-${key}-${edge ? (by === -1 ? "down" : "up") : by === -1 ? "up" : "down"}`, () => setSteps(listId, (current) => {
      const steps = [...current];
      const [moved] = steps.splice(index, 1);
      if (moved) steps.splice(to, 0, moved);
      return steps;
    }));
  };
  const removeStep = (key: number) => {
    const { list, listId, index } = placedByKey.get(key)!;
    const neighbor = list[index + 1] ?? list[index - 1];
    focusAfter(neighbor ? `step-${neighbor.key}-remove` : `add-${listId}`, () =>
      setSteps(listId, (current) => current.filter((entry) => entry.key !== key)));
  };
  const addStep = (id: ListId, step: AutomationStep) => {
    // A new If starts with empty branches and one field row to fill in.
    const added: StepEntry = step.kind === "if"
      ? {
          ...entryOf(step, null, table !== null, { do: [], otherwise: [] }),
          // A trigger with no record has no fields to compare, so its If starts as a formula.
          condition: noRecord ? { mode: "formula", formula: "", rows: [], saved: null } : { mode: "rows", formula: "", rows: [newCondition()], saved: null },
        }
      : entryOf(step, null, table !== null);
    focusAfter(step.kind === "if" ? `if-${added.key}-mode` : `step-${added.key}-first`, () => setSteps(id, (current) => [...current, added]));
  };
  const setRows = (key: number, rows: Row[]) => setStep(key, (entry) => ({ ...entry, rows }));
  const newCondition = (): ConditionEntry => ({ key: newKey(), row: { field: recordFields[0]?.name ?? "", operator: "is", value: comparedValue(recordFields[0]) } });

  /**
   * A Group choice: Groups whose messages can start the automation for the
   * trigger, or that can take its post for a step. One that cannot is
   * offered disabled with why; a saved one stays chosen with why beside it.
   */
  const groupPicker = (label: string, value: string, use: "read" | "post", key: string, focus: string, onChange: (group: string) => void) => {
    const stopOf = (group: Group) => (use === "read" ? group.readStopped : group.postStopped);
    // A saved text names a Group as a run reads it: a slug first, then a name only one Group has.
    const named = (groups ?? []).filter((group) => group.name === value);
    const current = groups?.find((group) => group.slug === value) ?? (named.length === 1 ? named[0] : undefined);
    const ambiguous = current === undefined && named.length > 1;
    const stopped = current === undefined ? null : stopOf(current);
    return (
      <>
        <select
          aria-label={label}
          data-focus={focus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={selectClass}
          {...invalid(problem(key))}
        >
          {value === "" ? (
            <option value="" disabled>
              {groupList === "failed" ? "Groups could not be listed" : groupList === "unavailable" ? "Groups are unavailable here" : groups === null ? "Loading Groups" : "Choose a Group"}
            </option>
          ) : null}
          {value !== "" && current?.ref !== value ? <option value={value}>{value}</option> : null}
          {(groups ?? []).map((group) => {
            const stop = stopOf(group);
            const label = group.ref === group.name ? group.name : `${group.name}, ${group.slug}`;
            return (
              <option key={group.slug} value={group.ref} disabled={stop !== null && group.ref !== value}>
                {stop === null ? label : `${label} (${stop})`}
              </option>
            );
          })}
        </select>
        {groupList === "unavailable" ? (
          <p className="m-0 text-[12px] text-muted">Groups are unavailable in a shared view.</p>
        ) : groupList === "failed" ? (
          <p className="m-0 text-[12px] text-muted">dohc could not list this computer's Groups.</p>
        ) : stopped !== null ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="Out of reach">{stopped}</StatusLine>
        ) : ambiguous ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="More than one Group">More than one Group is called {value}. Choose one.</StatusLine>
        ) : value !== "" && groups !== null && current === undefined ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="No Group">This computer has no Group named {value}. Choose another.</StatusLine>
        ) : groups !== null && groups.length === 0 ? (
          <p className="m-0 text-[12px] text-muted">This workspace has no Groups yet. Create one, then choose it here.</p>
        ) : null}
        <Problem shown={problem(key)} />
      </>
    );
  };
  /**
   * A message: text with {expressions} for values, as the file keeps it.
   * Insert value adds a value at the end, written as an expression.
   */
  const messageEditor = (number: number, key: number, text: string, onChange: (text: string) => void, focus: string | null) => (
    <>
      <textarea
        aria-label={`Step ${number}, message`}
        data-focus={focus ?? undefined}
        value={text}
        rows={3}
        placeholder="Message"
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} resize-y`}
        {...invalid(problem(`step-${key}/message`))}
      />
      <select
        aria-label={`Step ${number}, insert value`}
        value=""
        onChange={(event) => {
          if (event.target.value !== "") onChange(`${text}{${event.target.value}}`);
        }}
        className={`${selectClass} w-auto self-start`}
      >
        <option value="" disabled>Insert value</option>
        {noRecord ? null : recordFields.map((field) => <option key={field.name} value={fieldAccess(field.name)}>{field.name}</option>)}
        {draft.when.kind === "group-message" ? <option value="message.body">The message</option> : null}
        <option value="today()">Today</option>
      </select>
      <Problem shown={problem(`step-${key}/message`)} />
    </>
  );
  /** One step: its controls, or its sentence where the builder cannot edit it yet. */
  const stepItem = ({ entry, list, listId, index, number, scope }: (typeof ordered)[number]): ReactNode => {
    const { key, step, rows } = entry;
    const editable = editableOf(entry);
    const find = editableFind(step, table, triggerTable);
    const action = editableAction(step, table);
    const yours = yourStep(step, props.you);
    const chosen = action === null ? undefined : table?.actions.find((candidate) => candidate.name === action.operation);
    const targetPath = targetOf(entry);
    // Main lists the Collections a step can change; a Find's read reach shows in its saved verdict.
    const targetStopped = step.kind === "add-record" && targetPath !== collectionPath
      ? (targets?.find((target) => target.path === targetPath)?.stopped ?? null)
      : null;
    const fields = fieldsOf(entry);
    const targetName = targetPath === collectionPath ? own : collectionName(targetPath);
    // The Collection a Find reads or an Add a record adds to.
    // A Find reads, so it offers what a Find can read, with why another cannot be; an Add a record offers what a step can change.
    const findStopped = step.kind === "find" ? (targets?.find((target) => target.path === targetPath)?.findStopped ?? null) : null;
    const choices = (targets ?? []).filter((target) => target.path !== collectionPath && (step.kind === "find" || target.stopped === null));
    const collectionPicker = (named: AddStep | FindStep) => table !== null ? tablePicker(named) : (
      <select
        aria-label={`Step ${number}, Collection`}
        data-focus={`step-${key}-first`}
        value={targetPath}
        onChange={(event) => setStep(key, (current) => ({ ...current, step: { ...named, collection: event.target.value === collectionPath ? null : event.target.value } }))}
        className={selectClass}
      >
        <option value={collectionPath}>{own}</option>
        {targetPath === collectionPath || choices.some((target) => target.path === targetPath)
          ? null : <option value={targetPath}>{collectionName(targetPath)}</option>}
        {choices.map((target) => {
          const stop = step.kind === "find" ? target.findStopped : null;
          return (
            <option key={target.path} value={target.path} disabled={stop !== null && target.path !== targetPath}>
              {stop === null ? target.name : `${target.name} (${stop})`}
            </option>
          );
        })}
      </select>
    );
    // In a dataset, the table the step works on: choosing one names that table's operation, which saving keeps.
    const tablePicker = (named: AddStep | FindStep) => {
      const needs = STEP_OPERATIONS[named.kind];
      const home = datasetTableOf(entry);
      return (
        <select
          aria-label={`Step ${number}, table`}
          data-focus={`step-${key}-first`}
          value={home ?? ""}
          onChange={(event) => {
            const chosen = event.target.value;
            const operation = chosen === triggerTable ? null
              : table!.tables.get(chosen)?.operations.find((candidate) => candidate.kind === needs.kind)?.name ?? null;
            setStep(key, (current) => ({ ...current, step: { ...named, operation } }));
          }}
          className={selectClass}
          {...invalid(problem(`step-${key}/table`))}
        >
          {home === null ? <option value="" disabled>Choose a table</option> : null}
          {[...table!.tables].map(([name, { operations }]) => {
            const able = name === triggerTable || operations.some((candidate) => candidate.kind === needs.kind);
            return <option key={name} value={name} disabled={!able}>{able ? name : `${name} (${needs.missing})`}</option>;
          })}
        </select>
      );
    };
    // The name later steps use for this step's result.
    const resultName = (named: FindStep | AddStep | CodeStep) => (
      <label className="flex items-center gap-1.5 text-[12px] text-muted">
        <span className="shrink-0">Name result</span>
        <input
          aria-label={`Step ${number}, result name`}
          value={named.as ?? ""}
          spellCheck={false}
          placeholder={named.kind === "find" ? "found" : "Optional"}
          onChange={(event) => setStep(key, (current) => ({
            ...current,
            step: named.kind === "find" ? { ...named, as: event.target.value } : { ...named, as: event.target.value === "" ? null : event.target.value },
          }))}
          className={`${inputClass} font-mono text-[12px]`}
          {...invalid(problem(`step-${key}/as`))}
        />
      </label>
    );
    const records = step.kind === "set" ? step.records : null;
    const recordsKnown = records === null || scope.some((bound) => bound.name === records);
    const hasRecord = !["record-removed", "schedule", "group-message"].includes(draft.when.kind);
    return (
      <div key={key} data-step data-testid={`builder-step-${number - 1}`} className={listId === "do" ? "rounded-lg border border-line bg-bg p-2" : "py-0.5"}>
        <div className="mb-1.5 flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
            {editable?.kind === "set" ? "Set fields"
            : editable?.kind === "add-record" ? "Add a record"
            : find !== null ? "Find records"
            : action !== null ? "Run an action"
            : step.kind === "run" || step.kind === "run-file" ? "Run code"
            : step.kind === "if" ? "If"
            : step.kind === "post" ? "Post in a Group"
            : yours?.kind === "notify" ? "Notify you"
            : yours?.kind === "wake-agent" ? "Wake your agent"
            : `Step ${number}`}
          </span>
          <IconButton
            aria-label={`Move step ${number} up`}
            title="Move up"
            data-focus={`step-${key}-up`}
            disabled={index === 0}
            onClick={() => moveStep(key, -1)}
          >
            <ArrowUp size={13} aria-hidden />
          </IconButton>
          <IconButton
            aria-label={`Move step ${number} down`}
            title="Move down"
            data-focus={`step-${key}-down`}
            disabled={index === list.length - 1}
            onClick={() => moveStep(key, 1)}
          >
            <ArrowDown size={13} aria-hidden />
          </IconButton>
          <IconButton
            aria-label={`Remove step ${number}`}
            title="Remove"
            data-focus={`step-${key}-remove`}
            onClick={() => removeStep(key)}
          >
            <Trash2 size={13} aria-hidden />
          </IconButton>
        </div>
        {targetStopped !== null ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="Out of reach">{targetStopped}</StatusLine>
        ) : entry.verdict !== null ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="Does not run">{entry.verdict}</StatusLine>
        ) : null}
        {editable?.kind === "add-record" && props.addsStay.includes(datasetTableOf(entry) ?? "") ? (
          <StatusLine tone="muted" icon={Info} label="Undo keeps records">
            Undo keeps the records this step adds. {datasetTableOf(entry) === own ? "This Collection" : datasetTableOf(entry)} has no delete action available to the automation.
          </StatusLine>
        ) : null}
        {/* Anyone who can write the dataset, through an app too, can start a dataset's automation. */}
        {table !== null && step.kind === "wake-agent" ? (
          <StatusLine tone="muted" icon={Info} label="Others can start this">
            Changes other people make can start this step, and their text reaches your agent as data.
          </StatusLine>
        ) : null}
        {action !== null ? (
          <div className="flex flex-col gap-2">
            <select
              aria-label={`Step ${number}, action`}
              data-focus={`step-${key}-first`}
              value={action.operation}
              onChange={(event) => setStep(key, (current) => ({ ...current, step: { ...action, operation: event.target.value } }))}
              className={selectClass}
            >
              {chosen === undefined ? <option value={action.operation}>{action.operation}</option> : null}
              {actionsByTable.map((candidate) => <option key={candidate.name} value={candidate.name}>
                {candidate.table === watched ? candidate.label : `${candidate.label} (${candidate.table})`}
              </option>)}
            </select>
            {chosen === undefined ? (
              <StatusLine tone="warning" icon={AlertTriangle} label="Not an action">
                {own} has no action named {action.operation}. Choose another.
              </StatusLine>
            ) : !chosen.reversible ? (
              <p className="m-0 text-[12px] text-muted">{chosen.label} can't be undone.</p>
            ) : null}
            {rows.map(({ key: rowKey, value: row }, rowIndex) => {
              const name = row.field || `input ${rowIndex + 1}`;
              const typed = rows[rowIndex]?.number ?? false;
              const replace = (value: FieldValue, isNumber = typed) =>
                setRows(key, rows.map((current) => (current.key === rowKey ? { key: rowKey, value, number: isNumber } : current)));
              return (
                <div key={rowKey} className="flex items-start gap-1">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <input
                      aria-label={`Step ${number}, input ${rowIndex + 1} name`}
                      data-focus={`row-${rowKey}-first`}
                      value={row.field}
                      spellCheck={false}
                      placeholder="id"
                      onChange={(event) => replace({ field: event.target.value, value: row.value })}
                      className={`${inputClass} font-mono text-[12px]`}
                      {...invalid(problem(`row-${rowKey}/field`))}
                    />
                    <Problem shown={problem(`row-${rowKey}/field`)} />
                    <ToValue>
                      <ActionValueInput
                        label={`Step ${number}, ${name}`}
                        value={row.value}
                        number={typed}
                        problem={problem(`row-${rowKey}/value`)}
                        onChange={(value, isNumber) => replace({ field: row.field, value }, isNumber)}
                      />
                    </ToValue>
                  </div>
                  <IconButton
                    aria-label={`Remove ${name} from step ${number}`}
                    title="Remove"
                    data-focus={`row-${rowKey}-remove`}
                    onClick={() => {
                      const neighbor = rows[rowIndex + 1] ?? rows[rowIndex - 1];
                      focusAfter(neighbor ? `row-${neighbor.key}-remove` : `step-${key}-add-field`, () =>
                        setRows(key, rows.filter((current) => current.key !== rowKey)));
                    }}
                  >
                    <Trash2 size={13} aria-hidden />
                  </IconButton>
                </div>
              );
            })}
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1 self-start"
              data-focus={`step-${key}-add-field`}
              onClick={() => {
                const row = blankRow();
                focusAfter(`row-${row.key}-first`, () => setRows(key, [...rows, row]));
              }}
            >
              <Plus size={12} aria-hidden />
              Add input
            </SecondaryButton>
          </div>
        ) : step.kind === "run" || step.kind === "run-file" ? (
          <div className="flex flex-col gap-2">
            <select
              aria-label={`Step ${number}, code source`}
              data-focus={`step-${key}-first`}
              value={step.kind}
              onChange={(event) => setStep(key, (current) => {
                if (event.target.value === current.step.kind || (current.step.kind !== "run" && current.step.kind !== "run-file")) return current;
                // The source it leaves stays in the draft, so switching back finds it again.
                const leaving = current.step;
                const kept = current.other ?? "";
                return leaving.kind === "run"
                  ? { ...current, step: { kind: "run-file", file: kept, as: leaving.as }, other: leaving.code }
                  : { ...current, step: { kind: "run", code: kept, as: leaving.as }, other: leaving.file };
              })}
              className={selectClass}
            >
              <option value="run">Code here</option>
              <option value="run-file">Code in a file</option>
            </select>
            {step.kind === "run" ? (
              <textarea
                aria-label={`Step ${number}, code`}
                value={step.code}
                rows={8}
                // Lines stay whole, so a syntax error's line is the line on screen.
                wrap="off"
                spellCheck={false}
                placeholder={"return { output: ctx.sum(ctx.trigger.record.Amounts) };"}
                onChange={(event) => setStep(key, (current) => ({ ...current, step: { ...step, code: event.target.value } }))}
                className={`${formulaClass} resize-y leading-snug`}
                {...invalid(problem(`step-${key}/source`))}
              />
            ) : (
              <div className="flex items-start gap-1.5">
                <input
                  aria-label={`Step ${number}, file`}
                  value={step.file}
                  spellCheck={false}
                  placeholder="scripts/total.js"
                  onChange={(event) => setStep(key, (current) => ({ ...current, step: { ...step, file: event.target.value } }))}
                  className={`${inputClass} font-mono text-[12px]`}
                  {...invalid(problem(`step-${key}/source`))}
                />
                <SecondaryButton
                  size="compact"
                  className="shrink-0"
                  disabled={step.file.trim() === "" || missing.has(step.file) || problems.has(`step-${key}/source`)}
                  onClick={() => props.onOpenFile(`${collectionPath}/${step.file}`)}
                >
                  Open file
                </SecondaryButton>
              </div>
            )}
            <Problem shown={problem(`step-${key}/source`)} />
            {step.kind === "run-file" && missing.has(step.file) ? (
              <StatusLine tone="warning" icon={AlertTriangle} label="No file">
                <p className="m-0">{own} has no file {step.file}. Create it to write the code there.</p>
                <SecondaryButton size="compact" className="mt-1" onClick={() => void createCodeFile(step.file, entry.other ?? "")}>
                  Create file
                </SecondaryButton>
              </StatusLine>
            ) : null}
            {resultName(step)}
            <Problem shown={problem(`step-${key}/as`)} />
          </div>
        ) : step.kind === "post" ? (
          <div className="flex flex-col gap-2">
            {groupPicker(`Step ${number}, Group`, step.group, "post", `step-${key}/group`, `step-${key}-first`,
              (group) => setStep(key, (current) => ({ ...current, step: { ...step, group } })))}
            {messageEditor(number, key, step.text, (text) => setStep(key, (current) => ({ ...current, step: { ...step, text } })), null)}
          </div>
        ) : yours !== null ? (
          messageEditor(number, key, yours.text, (text) => setStep(key, (current) => ({ ...current, step: { ...yours, text } })), `step-${key}-first`)
        ) : entry.branches !== null && entry.condition !== null && step.kind === "if" ? (
          <div className="flex flex-col gap-2">
            <ConditionEditor
              part={{ kind: "if", number, key }}
              condition={entry.condition}
              expression={conditionOf(entry.condition)}
              fields={recordFields}
              collection={watched}
              problemKey={`step-${key}/condition`}
              problem={problem}
              newRow={newCondition}
              focusAfter={focusAfter}
              onChange={(change) => setStep(key, (current) => ({ ...current, condition: change(current.condition!) }))}
            />
            {(["do", "otherwise"] as const).map((branch) => (
              <div
                key={branch}
                role="group"
                aria-label={`Step ${number}, ${BRANCH_LABELS[branch]}`}
                className="flex flex-col gap-2 border-l border-line pl-2"
              >
                <span className="text-[11px] font-medium text-muted">{BRANCH_LABELS[branch]}</span>
                {stepList(`${key}/${branch}`, entry.branches![branch])}
              </div>
            ))}
          </div>
        ) : find !== null && entry.condition !== null ? (
          <div className="flex flex-col gap-2">
            {collectionPicker(find)}
            <Problem shown={problem(`step-${key}/table`)} />
            {findStopped !== null ? <StatusLine tone="warning" icon={AlertTriangle} label="Out of reach">{findStopped}</StatusLine> : null}
            <ConditionEditor
              part={{ kind: "find", number, key, dataset: table !== null }}
              condition={entry.condition}
              expression={conditionOf(entry.condition, fields)}
              fields={fields ?? []}
              collection={targetName}
              problemKey={`step-${key}/condition`}
              problem={problem}
              newRow={() => ({ key: newKey(), row: { field: fields?.[0]?.name ?? "", operator: "is", value: comparedValue(fields?.[0]) } })}
              focusAfter={focusAfter}
              onChange={(change) => setStep(key, (current) => ({ ...current, condition: change(current.condition!) }))}
            />
            {resultName(find)}
            <Problem shown={problem(`step-${key}/as`)} />
          </div>
        ) : editable === null ? (
          <p className="m-0 break-words text-[12px] leading-snug text-muted">
            <Sentence parts={stepParts(step)} />
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {editable.kind === "add-record" ? (
              <>
                {collectionPicker(editable)}
                <Problem shown={problem(`step-${key}/table`)} />
              </>
            ) : null}
            {editable.kind === "set" && (scope.length > 0 || records !== null) ? (
              <>
                <select
                  aria-label={`Step ${number}, record`}
                  value={records ?? ""}
                  onChange={(event) => setStep(key, (current) => ({ ...current, step: { ...editable, records: event.target.value === "" ? null : event.target.value } }))}
                  className={selectClass}
                  {...invalid(problem(`step-${key}/records`))}
                >
                  {hasRecord || records === null ? <option value="">The trigger record</option> : null}
                  {recordsKnown ? null : <option value={records!}>{records}</option>}
                  {scope.map((bound) => (
                    <option key={bound.name} value={bound.name}>
                      {bound.kind === "records" ? `Records found as ${bound.name}` : `Record added as ${bound.name}`}
                    </option>
                  ))}
                </select>
                <Problem shown={problem(`step-${key}/records`)} />
              </>
            ) : null}
            {rows.map(({ key: rowKey, value: row }, rowIndex) => {
              const field = fields?.find((candidate) => candidate.name === row.field);
              const name = row.field || `field ${rowIndex + 1}`;
              const replace = (value: FieldValue) =>
                setRows(key, rows.map((current) => (current.key === rowKey ? { key: rowKey, value } : current)));
              return (
                <div key={rowKey} className="flex items-start gap-1">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <FieldSelect
                      label={`Step ${number}, field ${rowIndex + 1}`}
                      fields={fields}
                      value={row.field}
                      collection={step.kind === "set" && records === null ? watched : targetName}
                      focusKey={rowIndex === 0 && editable.kind === "set" ? `step-${key}-first` : `row-${rowKey}-first`}
                      problem={problem(`row-${rowKey}/field`)}
                      onChange={(next) => replace({
                        field: next,
                        value: defaultValueFor(fields?.find((candidate) => candidate.name === next)),
                      })}
                    />
                    <ToValue>
                      <ValueInput
                        label={`Step ${number}, ${name}`}
                        field={field}
                        value={row.value}
                        problem={problem(`row-${rowKey}/value`)}
                        onChange={(value) => replace({ field: row.field, value: value ?? { kind: "literal", value: null } })}
                      />
                    </ToValue>
                  </div>
                  <IconButton
                    aria-label={`Remove ${name} from step ${number}`}
                    title="Remove"
                    data-focus={`row-${rowKey}-remove`}
                    onClick={() => {
                      const neighbor = rows[rowIndex + 1] ?? rows[rowIndex - 1];
                      focusAfter(neighbor ? `row-${neighbor.key}-remove` : `step-${key}-add-field`, () =>
                        setRows(key, rows.filter((current) => current.key !== rowKey)));
                    }}
                  >
                    <Trash2 size={13} aria-hidden />
                  </IconButton>
                </div>
              );
            })}
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1 self-start"
              data-focus={`step-${key}-add-field`}
              onClick={() => {
                const row = blankRow();
                focusAfter(rows.length === 0 && editable.kind === "set" ? `step-${key}-first` : `row-${row.key}-first`, () => setRows(key, [...rows, row]));
              }}
            >
              <Plus size={12} aria-hidden />
              Add field
            </SecondaryButton>
            <Problem shown={problem(`step-${key}/values`)} />
            {editable.kind === "add-record" ? (
              <>
                {resultName(editable)}
                <Problem shown={problem(`step-${key}/as`)} />
              </>
            ) : null}
          </div>
        )}
        <Problem shown={problem(`step-${key}`)} />
      </div>
    );
  };
  /** A list of steps, and the buttons that add a step to its end. */
  const stepList = (listId: ListId, list: readonly StepEntry[]): ReactNode => {
    // The Ifs around this list: an If in a list three deep would be a fourth.
    const around = listId === "do" ? 0 : placedByKey.get(Number(listId.split("/")[0]))!.depth + 1;
    const deepest = around >= MAX_IF_DEPTH;
    return (
      <>
        {list.map((entry) => stepItem(placedByKey.get(entry.key)!))}
        <Problem shown={problem(listProblem(listId))} />
        <div className="flex flex-wrap gap-1.5">
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            data-focus={`add-${listId}`}
            aria-describedby={problem(listProblem(listId))?.id}
            disabled={full}
            onClick={() => addStep(listId, { kind: "set", values: [blankRow().value], records: null, operation: null })}
          >
            <Plus size={12} aria-hidden />
            Set fields
          </SecondaryButton>
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            disabled={full}
            onClick={() => addStep(listId, { kind: "add-record", values: [blankRow().value], collection: null, as: null, operation: null })}
          >
            <Plus size={12} aria-hidden />
            Add a record
          </SecondaryButton>
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            disabled={full}
            onClick={() => addStep(listId, { kind: "find", condition: "true", collection: null, as: "", operation: null })}
          >
            <Plus size={12} aria-hidden />
            Find records
          </SecondaryButton>
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            disabled={full || deepest}
            aria-describedby={deepest ? `${problemIds}deep-${listId.replace(/\W/gu, "_")}` : undefined}
            onClick={() => addStep(listId, { kind: "if", if: "", do: [], otherwise: [] })}
          >
            <Plus size={12} aria-hidden />
            If
          </SecondaryButton>
          {table !== null && table.actions.length > 0 ? (
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1"
              disabled={full}
              onClick={() => {
                // The trigger's table's first action, as its record is the one a new step names.
                const first = actionsByTable[0]!;
                addStep(listId, {
                  kind: "invoke",
                  operation: first.name,
                  // The action reads its record itself, so it takes the record's id, when the trigger has one in its table.
                  input: noRecord || draft.when.kind === "record-removed" || first.table !== watched
                    ? [] : [{ key: "id", value: { kind: "formula", expression: "record.id" } }],
                });
              }}
            >
              <Plus size={12} aria-hidden />
              Run an action
            </SecondaryButton>
          ) : null}
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            disabled={full}
            onClick={() => addStep(listId, { kind: "run", code: "", as: null })}
          >
            <Plus size={12} aria-hidden />
            Run code
          </SecondaryButton>
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            disabled={full}
            onClick={() => addStep(listId, { kind: "post", text: "", group: firstGroup("post") })}
          >
            <Plus size={12} aria-hidden />
            Post in a Group
          </SecondaryButton>
          {props.you !== null ? (
            <>
              <SecondaryButton
                size="compact"
                className="flex items-center gap-1"
                disabled={full}
                onClick={() => addStep(listId, { kind: "notify", text: "", to: [{ kind: "literal", value: props.you! }] })}
              >
                <Plus size={12} aria-hidden />
                Notify you
              </SecondaryButton>
              <SecondaryButton
                size="compact"
                className="flex items-center gap-1"
                disabled={full}
                onClick={() => addStep(listId, { kind: "wake-agent", text: "", person: props.you! })}
              >
                <Plus size={12} aria-hidden />
                Wake your agent
              </SecondaryButton>
            </>
          ) : null}
        </div>
        {full ? <p className="m-0 text-[12px] text-muted">An automation holds at most {MAX_STEPS} steps. Remove a step to add another.</p> : null}
        {deepest ? (
          <p id={`${problemIds}deep-${listId.replace(/\W/gu, "_")}`} className="m-0 text-[12px] text-muted">
            An If here would sit inside three others, and an automation allows three.
          </p>
        ) : null}
      </>
    );
  };

  // Main's answer for this draft; until it comes, what it said of the saved version, while nothing changed.
  // An unchanged automation keeps what the list said when main gives no reason, as for a dataset whose rules are not approved, which main's check cannot see.
  const cannotRun = current?.cannotRun ?? (dirty ? null : props.cannotRun);
  // Code files a step names that main could not find, from its last answer for this draft.
  const missing = new Set(current?.missingFiles ?? []);
  /** Creates a code file in this Collection's folder with the code the step held, if any, then opens it. */
  const createCodeFile = async (file: string, code: string) => {
    const epoch = scope.current();
    try {
      await bridge().createWorkspaceFile({ workspaceId, relativePath: `${collectionPath}/${file}`, initialText: code });
    } catch (error) {
      if (scope.isCurrent(epoch)) onError(`dohc could not create ${file}.`, error, () => void createCodeFile(file, code));
      return;
    }
    if (!scope.isCurrent(epoch)) return;
    props.onOpenFile(`${collectionPath}/${file}`);
    // Main checks the draft as it is now, so the step stops saying the file is missing and the rest still say so.
    try {
      const answer = await check(latestCandidate.current, latestKey.current);
      if (scope.isCurrent(epoch) && answer.key === latestKey.current) setChecked(answer);
    } catch {
      // The next check, as after an edit or at Save, says again.
    }
  };
  // Every table's actions, the trigger's table first, so a new step runs one on the trigger's record.
  const actionsByTable = [...(table?.actions ?? [])].sort((a, b) => Number(b.table === watched) - Number(a.table === watched));
  const trigger = draft.when;
  const nextRun = trigger.kind === "schedule" ? nextRunOf(trigger) : null;
  const builderTrigger = builderTriggerOf(trigger);
  const setWhen = (next: AutomationTrigger) => setDraft((current) => ({ ...current, when: next }));
  const waiting = props.reach?.kind === "waiting";

  return (
    <form
      ref={form}
      className="flex flex-col gap-4 px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {props.readOnly ? (
        <StatusLine tone="danger" icon={AlertTriangle} label="Cannot save">
          <p className="m-0">dohc cannot read every automation in automations.yaml, so you cannot save this now.</p>
          <SecondaryButton size="compact" className="mt-1" onClick={() => props.onOpenFile(`${collectionPath}/automations.yaml`)}>Open file</SecondaryButton>
        </StatusLine>
      ) : null}
      {/* Nothing changes while a save runs, or while the file cannot be saved. */}
      <fieldset disabled={props.saving || checking || props.readOnly} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        <input
          aria-label="Name"
          value={draft.name}
          maxLength={MAX_NAME_LENGTH}
          placeholder={sentenceText(automationSentence({ ...automation, name: "" }))}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          className={`${inputClass} font-medium`}
          {...invalid(problem("name"))}
        />
        <Problem shown={problem("name")} />
        {cannotRun ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="Does not run">{cannotRun}</StatusLine>
        ) : waiting ? (
          <StatusLine tone="muted" icon={Clock} label="Waiting">Waiting to check who can edit {own}.</StatusLine>
        ) : null}

        <section aria-label="When" className="flex flex-col gap-1.5">
          <SectionLabel>When</SectionLabel>
          <select
            aria-label="Trigger"
            value={builderTrigger ?? ""}
            onChange={(event) => {
              const kind = event.target.value as BuilderTrigger;
              setDraft((current) => ({
                ...current,
                when: kind === "group-message" && current.when.kind !== "group-message"
                  // A new Group trigger starts on the first Group whose messages can start it.
                  ? { kind, group: firstGroup("read"), startsWith: null }
                  : triggerFor(kind, current.when, recordFields, buttonFields, table?.name ?? null),
                // A record starts to match rows, until someone writes a formula.
                matching: kind === "starts-matching" && current.matching.mode === "always"
                  ? { mode: "rows", formula: "", rows: [newCondition()], saved: null }
                  : current.matching,
              }));
            }}
            className={selectClass}
          >
            {builderTrigger === null ? <option value="" disabled>{sentenceText(triggerParts(trigger))}</option> : null}
            {Object.entries(TRIGGER_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
          {table !== null && "table" in trigger && table.tables.size > 1 ? (
            <select
              aria-label="Table"
              value={watched}
              onChange={(event) => setWhen({ ...trigger, table: event.target.value })}
              className={selectClass}
            >
              {table.tables.has(watched) ? null : <option value={watched}>{watched}</option>}
              {[...table.tables.keys()].map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : null}
          {trigger.kind === "field-changed" ? (
            <>
              <FieldSelect
                label="Field that changes"
                fields={recordFields}
                value={trigger.field}
                collection={watched}
                problem={problem("when/field")}
                onChange={(field) => setWhen({ kind: "field-changed", field, to: null, table: trigger.table })}
              />
              <ToValue>
                <ValueInput
                  label="Changes to"
                  field={recordFields.find((field) => field.name === trigger.field)}
                  value={trigger.to}
                  allowAny
                  problem={problem("when/to")}
                  onChange={(to) => setWhen({ ...trigger, to })}
                />
              </ToValue>
            </>
          ) : trigger.kind === "record-changed" ? (
            <>
              <select
                aria-label="Which fields"
                value={trigger.fields === null ? "any" : "chosen"}
                onChange={(event) => setWhen({ ...trigger, fields: event.target.value === "any" ? null : [] })}
                className={selectClass}
                // With no field to check, the problem belongs to this choice.
                {...(fieldChoices.length === 0 ? invalid(problem("when/fields")) : {})}
              >
                <option value="any">Any field</option>
                <option value="chosen">Chosen fields</option>
              </select>
              {trigger.fields !== null ? (
                <div role="group" aria-label="Fields that change" className="flex flex-col gap-0.5 rounded-md border border-line bg-bg px-2 py-1">
                  {fieldChoices.map((name) => (
                    <label key={name} className="flex items-center gap-1.5 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        checked={trigger.fields!.includes(name)}
                        onChange={(event) => {
                          const chosen = trigger.fields ?? [];
                          setWhen({ ...trigger, fields: fieldChoices.filter((candidate) => (candidate === name ? event.target.checked : chosen.includes(candidate))) });
                        }}
                        {...invalid(problem("when/fields"))}
                      />
                      {name}
                    </label>
                  ))}
                </div>
              ) : null}
              {missingFields.length > 0 && problem("when/fields") === null ? (
                <StatusLine tone="warning" icon={AlertTriangle} label="Not a field">
                  {missingFields.join(", ")} {missingFields.length === 1 ? "is not a field" : "are not fields"} in {watched}.
                </StatusLine>
              ) : null}
              <Problem shown={problem("when/fields")} />
            </>
          ) : trigger.kind === "starts-matching" ? (
            <ConditionEditor
              part={{ kind: "match" }}
              condition={draft.matching}
              expression={conditionOf(draft.matching)}
              fields={recordFields}
              collection={watched}
              problemKey="when/condition"
              problem={problem}
              newRow={newCondition}
              focusAfter={focusAfter}
              onChange={(change) => setDraft((current) => ({ ...current, matching: change(current.matching) }))}
            />
          ) : trigger.kind === "schedule" ? (
            <>
              <select
                aria-label="Repeats"
                value={trigger.every}
                onChange={(event) => setWhen(scheduleFor(event.target.value as AutomationScheduleTrigger["every"], trigger))}
                className={selectClass}
              >
                {Object.entries(FREQUENCY_LABELS).map(([every, label]) => <option key={every} value={every}>{label}</option>)}
              </select>
              {trigger.every === "week" ? (
                <div role="group" aria-label="Days" className="flex flex-wrap gap-x-2.5 gap-y-1">
                  {WEEKDAYS.map(([day, label]) => (
                    <label key={day} className="flex items-center gap-1 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        checked={trigger.days.includes(day)}
                        onChange={(event) => setWhen({
                          ...trigger,
                          days: WEEKDAYS.flatMap(([candidate]) => ((candidate === day ? event.target.checked : trigger.days.includes(candidate)) ? [candidate] : [])),
                        })}
                        {...invalid(problem("when/days"))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              ) : trigger.every === "month" ? (
                <>
                  <div role="group" aria-label="Days of the month" className="grid grid-cols-7 gap-1">
                    {MONTH_DAYS.map((day) => (
                      <label key={day} className="flex items-center gap-1 font-mono text-[12px] text-ink">
                        <input
                          type="checkbox"
                          checked={trigger.days.includes(day)}
                          onChange={(event) => setWhen({
                            ...trigger,
                            days: MONTH_DAYS.filter((candidate) => (candidate === day ? event.target.checked : trigger.days.includes(candidate))),
                          })}
                          {...invalid(problem("when/days"))}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                  {trigger.days.some((day) => day > 28) ? (
                    <p className="m-0 text-[12px] text-muted">In a shorter month, a later day runs on the month's last day.</p>
                  ) : null}
                </>
              ) : null}
              <Problem shown={problem("when/days")} />
              {trigger.every === "hour" ? (
                <select
                  aria-label="Minutes past the hour"
                  value={trigger.at}
                  onChange={(event) => setWhen({ ...trigger, at: event.target.value })}
                  className={`${selectClass} font-mono`}
                  {...invalid(problem("when/at"))}
                >
                  {MINUTES.includes(trigger.at) ? null : <option value={trigger.at}>{trigger.at}</option>}
                  {MINUTES.map((minute) => <option key={minute} value={minute}>{minute}</option>)}
                </select>
              ) : (
                <input
                  aria-label="Time"
                  type="time"
                  value={trigger.at}
                  onChange={(event) => setWhen({ ...trigger, at: event.target.value })}
                  className={inputClass}
                  {...invalid(problem("when/at"))}
                />
              )}
              <Problem shown={problem("when/at")} />
              <select
                aria-label="Time zone"
                value={trigger.timezone}
                onChange={(event) => setWhen({ ...trigger, timezone: event.target.value })}
                className={selectClass}
                {...invalid(problem("when/timezone"))}
              >
                {/* A zone the file names another way, such as Asia/Calcutta, stays as written. */}
                {timeZoneNames().includes(trigger.timezone) ? null : <option value={trigger.timezone}>{trigger.timezone}</option>}
                {timeZoneNames().map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
              <Problem shown={problem("when/timezone")} />
              {nextRun === null ? null : <StatusLine tone="muted" icon={Clock} label="Schedule">{nextRun.text}</StatusLine>}
              {props.scheduleHost}
            </>
          ) : trigger.kind === "group-message" ? (
            <>
              {groupPicker("Group", trigger.group, "read", "when/group", "group-first", (group) => setWhen({ ...trigger, group }))}
              <input
                aria-label="Starts with"
                value={trigger.startsWith ?? ""}
                placeholder="Starts with, such as /task"
                onChange={(event) => setWhen({ ...trigger, startsWith: event.target.value === "" ? null : event.target.value })}
                className={inputClass}
                {...invalid(problem("when/startsWith"))}
              />
              <Problem shown={problem("when/startsWith")} />
              {props.scheduleHost}
            </>
          ) : trigger.kind === "button" ? (
            <>
              {buttonFields.length > 0 || trigger.field !== "" ? (
                <FieldSelect
                  label="Button"
                  fields={buttonFields}
                  value={trigger.field}
                  collection={watched}
                  problem={problem("when/button")}
                  onChange={(field) => setWhen({ ...trigger, field })}
                />
              ) : <Problem shown={problem("when/button")} />}
              {buttonFields.length === 0 ? (
                <StatusLine tone="muted" icon={Info} label="No button">
                  <p className="m-0">{watched} has no Button field. Add one, then choose it here.</p>
                  {props.onOpenFields && watched === own ? (
                    <SecondaryButton size="compact" className="mt-1" onClick={props.onOpenFields}>Edit fields</SecondaryButton>
                  ) : null}
                </StatusLine>
              ) : null}
            </>
          ) : null}
          <Problem shown={problem("when")} />
        </section>

        <section aria-label="Only if" className="flex flex-col gap-1.5">
          <SectionLabel>Only if</SectionLabel>
          <ConditionEditor
            part={{ kind: "condition" }}
            condition={draft.condition}
            expression={automation.if}
            fields={recordFields}
            collection={watched}
            problemKey="if"
            problem={problem}
            newRow={newCondition}
            focusAfter={focusAfter}
            onChange={(change) => setDraft((current) => ({ ...current, condition: change(current.condition) }))}
          />
        </section>

        <section aria-label="Do" className="flex flex-col gap-2">
          <SectionLabel>Do</SectionLabel>
          {stepList("do", draft.steps)}
        </section>
      </fieldset>

      <Problem shown={problem("save")} />
      <p role="status" className="sr-only">{announced}</p>
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <SecondaryButton size="compact" onClick={props.onCancel}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" size="compact" disabled={props.saving || checking || props.readOnly}>Save</PrimaryButton>
      </div>

      {props.leaveRequested && dirty && !saveChosen ? (
        <Overlay onClose={props.onStay}>
          <div
            data-testid="automation-unsaved"
            role="dialog"
            aria-modal="true"
            aria-labelledby="automation-unsaved-title"
            className="w-[min(420px,calc(100vw-32px))] rounded border border-line bg-panel p-4 shadow-xl"
          >
            <h3 id="automation-unsaved-title" className="m-0 text-sm font-semibold text-ink">Save your changes?</h3>
            <p className="m-0 mt-2 text-[13px] text-muted">
              {automation.name.trim() || "This automation"} has changes you have not saved.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton onClick={props.onStay} className="h-8 py-0">Keep editing</SecondaryButton>
              <SecondaryButton onClick={props.onLeave} className="h-8 py-0">Discard</SecondaryButton>
              <PrimaryButton
                onClick={() => {
                  setSaveChosen(true);
                  void save().then((saved) => {
                    if (!saved) props.onStay();
                  });
                }}
                className="h-8 py-0 text-xs"
                disabled={props.readOnly}
              >
                Save
              </PrimaryButton>
            </div>
          </div>
        </Overlay>
      ) : null}
    </form>
  );
}
