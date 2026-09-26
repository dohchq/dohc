import { automationReachCopy } from "../automationReachCopy";
import { AlertTriangle, ArrowDown, ArrowUp, Clock, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { CollectionFieldType, FieldDefinition } from "@dohc/workspace-contracts";
import type { AutomationDiagnostic } from "@dohc/workspace-contracts/automations";
import type { ListAutomationTargetsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { IconButton, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { Sentence, StatusLine } from "./AutomationParts";
import {
  conditionFormula,
  conditionRows,
  defaultValueFor,
  idFor,
  literalFor,
  literalText,
  MAX_NAME_LENGTH,
  numberValue,
  reachPlaces,
  valueKindOf,
  valueKindsFor,
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
// a formula wherever a person wants one. Steps the builder cannot edit yet,
// such as Find and If, stay as they are and read as their sentence; the
// file edits them. Save runs the file contract's check through main first,
// so it never writes what the parser would refuse, and the panel writes the
// whole list over the content it read.

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;
type Target = Extract<ListAutomationTargetsResult, { collections: unknown }>["collections"][number];
type SetStep = Extract<AutomationStep, { kind: "set" }>;
type AddStep = Extract<AutomationStep, { kind: "add-record" }>;
type FieldValue = SetStep["values"][number];
type Reach = ValidAutomationSummary["reach"];

const inputClass =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink placeholder:text-subtle focus:border-ink";
const selectClass =
  "w-full rounded-md border border-line bg-bg px-1.5 py-1 text-[13px] text-ink focus:border-ink";
const formulaClass = `${inputClass} font-mono text-[12px]`;

const TRIGGER_LABELS = {
  "field-changed": "A field changes",
  "record-changed": "Any field changes",
  "record-added": "A record is added",
  "record-removed": "A record is removed",
  "starts-matching": "A record starts to match",
} as const;
type BuilderTrigger = keyof typeof TRIGGER_LABELS;

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
  "duplicate-key": "A field is in this step twice.",
  "reserved-field-name": "id is the record's own id, so a step cannot set it.",
  "control-characters": "The name has characters dohc cannot show.",
  "too-many-steps": "An automation can have at most 25 steps.",
  "if-too-deep": "If steps can sit at most three deep.",
  "unexpected-formula-marker": "Only a value can be a formula, so this cannot start with =.",
};

/** Where a file contract diagnostic belongs in the builder, and what it says. */
function diagnosticProblem(diagnostic: AutomationDiagnostic): [string, string] {
  const path = diagnostic.path.replace(/^\/automations\/0/u, "");
  const step = /^\/do\/(\d+)/u.exec(path);
  const key = step ? `do/${step[1]}` : path.startsWith("/when") ? "when" : path.startsWith("/if") ? "if" : "save";
  return [key, DIAGNOSTIC_SENTENCES[diagnostic.code] ?? `dohc cannot save this: ${diagnostic.code} at ${path || "/"}.`];
}

/** Why a part cannot be saved yet, beside the part. */
function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return <p role="alert" className="m-0 mt-1 text-[11px] leading-snug text-danger">{text}</p>;
}

/** A field of a Collection. While the Collection's fields load, `fields` is null. */
function FieldSelect(props: {
  label: string;
  fields: readonly FieldDefinition[] | null;
  value: string;
  collection: string;
  focusKey?: string;
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
      >
        {props.value === "" ? <option value="" disabled>Choose a field</option> : null}
        {listed || props.value === "" ? null : <option value={props.value}>{props.value}</option>}
        {(props.fields ?? []).map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
      </select>
      {known ? null : (
        <StatusLine tone="warning" icon={AlertTriangle} label="Not a field">
          {props.value} is not a field in {props.collection}.
        </StatusLine>
      )}
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
  onChange: (value: AutomationValue) => void;
}) {
  const { type, text } = props;
  if (type === "select" || type === "multi-select") {
    return (
      <select
        aria-label={props.label}
        value={text}
        onChange={(event) => props.onChange(literalFor("select", event.target.value))}
        className={selectClass}
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
  problem: string | null;
  onChange: (value: AutomationValue | null) => void;
}) {
  const type: CollectionFieldType | null = props.field?.type ?? null;
  const kind = valueKindOf(props.value);
  const formula = kind === "formula" && props.value?.kind === "formula" ? (
    <input
      aria-label={`${props.label}, formula`}
      value={props.value.expression}
      spellCheck={false}
      placeholder='dateAdd(today(), 3, "days")'
      onChange={(event) => props.onChange({ kind: "formula", expression: event.target.value })}
      className={formulaClass}
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
        >
          {props.allowAny ? <option value="any">Any value</option> : null}
          {kind === "value" && !options.includes(text) ? <option value={current}>{text}</option> : null}
          {options.map((option) => <option key={option} value={`option:${option}`}>{option}</option>)}
          <option value="empty">Empty</option>
          <option value="formula">Formula</option>
        </select>
        {formula}
        <Problem text={props.problem} />
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
        >
          {props.field.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : kind === "value" ? (
        <LiteralInput
          label={props.label}
          type={type}
          options={[]}
          text={literalText(props.value)}
          onChange={props.onChange}
        />
      ) : formula}
      <Problem text={props.problem} />
    </div>
  );
}

/** "Status to Done": the value's control after a visible "to". */
function ToValue({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="shrink-0 pt-1 text-[12px] text-muted">to</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// A step or row keeps its key while the draft changes, so React keeps its
// controls and focus can follow it.
interface Row { key: number; value: FieldValue }
interface StepEntry {
  key: number;
  step: AutomationStep;
  rows: Row[];
  /** The saved automation's reach verdict for this step, until it is edited. */
  verdict: string | null;
}

let nextKey = 0;
const newKey = () => (nextKey += 1);
const blankRow = (): Row => ({ key: newKey(), value: { field: "", value: { kind: "literal", value: "" } } });

function entryOf(step: AutomationStep, verdict: string | null): StepEntry {
  const values = step.kind === "set" || step.kind === "add-record" ? step.values : [];
  return { key: newKey(), step, rows: values.map((value) => ({ key: newKey(), value })), verdict };
}

/** Each step's saved verdict as one sentence, or null when it may run. */
function verdictsOf(automation: Automation, reach: Reach | null): Array<string | null> {
  if (reach === null || reach.kind !== "checked") return automation.do.map(() => null);
  return reachPlaces(automation.do).map((places) => {
    for (const place of places) {
      const verdict = reach.steps[place];
      if (verdict?.verdict === "stopped") return verdict.reason;
      if (verdict?.verdict === "held") {
        const reached = automationReachCopy(verdict);
        return `This step can now ${reached}, and waits for someone who can edit this Collection to allow it.`;
      }
    }
    return null;
  });
}

/** Every formula in an automation, for the syntax check. */
function formulasOf(automation: Automation): string[] {
  const formulas: string[] = [];
  const add = (expression: string) => {
    if (expression.trim() !== "") formulas.push(expression);
  };
  const when = automation.when;
  if (when.kind === "field-changed" && when.to?.kind === "formula") add(when.to.expression);
  if (when.kind === "starts-matching") add(when.condition);
  if (automation.if !== null) add(automation.if);
  for (const step of automation.do) {
    if (step.kind !== "set" && step.kind !== "add-record") continue;
    for (const { value } of step.values) if (value.kind === "formula") add(value.expression);
  }
  return formulas;
}

function triggerFor(kind: BuilderTrigger, current: AutomationTrigger, fields: readonly FieldDefinition[]): AutomationTrigger {
  switch (kind) {
    case "field-changed":
      return current.kind === "field-changed" ? current : { kind, field: fields[0]?.name ?? "", to: null, table: null };
    case "record-changed":
      return { kind, fields: null, table: null };
    case "starts-matching":
      return current.kind === "starts-matching" ? current : { kind, condition: "", table: null };
    default:
      return { kind, table: null };
  }
}

/** The trigger kind the builder edits, or null when only the file can. */
function builderTriggerOf(trigger: AutomationTrigger): BuilderTrigger | null {
  if (trigger.kind === "record-changed") return trigger.fields === null ? trigger.kind : null;
  return trigger.kind in TRIGGER_LABELS ? (trigger.kind as BuilderTrigger) : null;
}

/** A step the builder edits: fields set on the trigger record, or a record added. */
function editableStep(step: AutomationStep): SetStep | AddStep | null {
  if (step.kind === "set") return step.records === null ? step : null;
  return step.kind === "add-record" ? step : null;
}

type ConditionMode = "always" | "rows" | "formula";
interface ConditionEntry { key: number; row: ConditionRow }

/** What the builder's controls hold, which the automation is built from. */
interface Draft {
  name: string;
  when: AutomationTrigger;
  conditionMode: ConditionMode;
  conditionFormula: string;
  rows: ConditionEntry[];
  steps: StepEntry[];
}

function draftOf(automation: Automation, reach: Reach | null): Draft {
  const rows = automation.if === null ? [] : (conditionRows(automation.if) ?? []);
  const verdicts = verdictsOf(automation, reach);
  return {
    name: automation.name,
    when: automation.when,
    conditionMode: automation.if === null ? "always" : rows.length > 0 ? "rows" : "formula",
    conditionFormula: automation.if ?? "",
    rows: rows.map((row) => ({ key: newKey(), row })),
    steps: automation.do.map((step, index) => entryOf(step, verdicts[index] ?? null)),
  };
}

export function AutomationBuilder(props: {
  workspaceId: string;
  collectionPath: string;
  fields: readonly FieldDefinition[];
  /** The draft to start from: the saved automation, a new one with an empty id, or a draft kept from before. */
  automation: Automation;
  /** What counts as unchanged: the saved automation, or a new one's start. */
  baseline: Automation;
  /** Why the saved version does not run, such as a field the Collection lacks. */
  cannotRun: string | null;
  /** The saved version's reach, or null for a new automation. */
  reach: Reach | null;
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
  onOpenFile: () => void;
  onError: ErrorReport;
}) {
  const { workspaceId, collectionPath, onError } = props;
  const isNew = props.automation.id === "";
  const [draft, setDraft] = useState(() => draftOf(props.automation, props.reach));
  const [attempted, setAttempted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saveChosen, setSaveChosen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [schemas, setSchemas] = useState(() => new Map<string, readonly FieldDefinition[]>([[collectionPath, props.fields]]));
  const [checked, setChecked] = useState<{
    key: string;
    diagnostics: AutomationDiagnostic[];
    formulas: ReadonlyMap<string, string>;
  } | null>(null);
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

  const own = collectionName(collectionPath);
  const typeOf = (collection: string, field: string): CollectionFieldType | null =>
    schemas.get(collection)?.find((candidate) => candidate.name === field)?.type ?? null;
  const targetOf = (step: AutomationStep) =>
    step.kind === "add-record" ? (step.collection ?? collectionPath) : collectionPath;
  // Number fields hold typed text in the draft; the automation holds numbers.
  const numbered = (collection: string, values: readonly Row[]): FieldValue[] =>
    values.map(({ value: entry }) => {
      if (entry.value.kind !== "literal") return entry;
      const value = numberValue(typeOf(collection, entry.field), entry.value.value);
      return value === undefined ? entry : { field: entry.field, value: { kind: "literal", value } };
    });
  const rowValue = (row: ConditionRow) => numberValue(typeOf(collectionPath, row.field), row.value) ?? row.value;
  const when = draft.when.kind === "field-changed" && draft.when.to?.kind === "literal"
    ? {
        ...draft.when,
        to: { kind: "literal" as const, value: numberValue(typeOf(collectionPath, draft.when.field), draft.when.to.value) ?? draft.when.to.value },
      }
    : draft.when;
  const automation: Automation = {
    ...props.automation,
    name: draft.name,
    when,
    if: draft.conditionMode === "always"
      ? null
      : draft.conditionMode === "rows"
        ? conditionFormula(draft.rows.map(({ row }) => ({ ...row, value: rowValue(row) })))
        : draft.conditionFormula,
    do: draft.steps.map(({ step, rows }) => {
      const editable = editableStep(step);
      return editable ? { ...editable, values: numbered(targetOf(step), rows) } : step;
    }),
  };
  const dirty = JSON.stringify(automation) !== JSON.stringify(props.baseline);
  // What Save writes: a draft without a name takes its sentence, and a new
  // one an id from its name. Main checks exactly this.
  const finalName = automation.name.trim() || sentenceText(automationSentence(automation)).slice(0, MAX_NAME_LENGTH);
  const candidate: Automation = { ...automation, name: finalName, id: isNew ? idFor(finalName, props.takenIds) : automation.id };
  const automationKey = JSON.stringify(candidate);
  const draftKey = JSON.stringify(automation);
  useEffect(() => {
    props.onDraftChange({ automation, dirty });
  }, [draftKey, dirty]);

  // Leaving with nothing changed needs no question.
  useEffect(() => {
    if (props.leaveRequested && !dirty) props.onLeave();
    if (!props.leaveRequested) setSaveChosen(false);
  }, [props.leaveRequested]);

  // The Collections an Add a record step can reach.
  useEffect(() => {
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
    () => [...new Set(draft.steps.flatMap(({ step }) => (step.kind === "add-record" && step.collection !== null ? [step.collection] : [])))],
    [draft.steps],
  );
  useEffect(() => {
    const epoch = scope.current();
    for (const path of targetPaths) {
      if (schemas.has(path)) continue;
      void bridge()
        .getCollection({ workspaceId, collectionPath: path })
        .then((result) => {
          if (scope.isCurrent(epoch)) setSchemas((current) => new Map(current).set(path, result.schema.fields));
        })
        .catch((error: unknown) => {
          if (scope.isCurrent(epoch)) onError(`dohc could not read the fields of ${collectionName(path)}.`, error);
        });
    }
  }, [targetPaths.join("\n")]);

  /** Main's check of this exact automation: what the file contract refuses, and each formula's syntax. */
  const check = async (target: Automation, key: string) => {
    const formulas = formulasOf(target);
    const result = await bridge().checkCollectionAutomation({ workspaceId, automation: target, formulas });
    const answer = {
      key,
      diagnostics: result.diagnostics,
      formulas: new Map(formulas.flatMap((formula, index) => {
        const problem = result.formulaProblems[index];
        return problem ? [[formula, `This formula has a syntax error. ${problem}`] as const] : [];
      })),
    };
    return answer;
  };
  // Checked a moment after the person stops typing, so a formula's syntax
  // error shows as it happens.
  useEffect(() => {
    const epoch = scope.current();
    const timer = setTimeout(() => {
      void check(candidate, automationKey)
        .then((answer) => {
          if (scope.isCurrent(epoch)) setChecked(answer);
        })
        // Save checks again; a failure there is reported.
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [automationKey, workspaceId]);

  // What keeps the draft from saving, keyed by the part it belongs to.
  const problems = new Map<string, string>();
  const syntaxErrors = checked?.key === automationKey ? checked.formulas : new Map<string, string>();
  const formulaProblem = (key: string, expression: string) => {
    if (expression.trim() === "") problems.set(key, "Write a formula.");
    else if (syntaxErrors.has(expression)) problems.set(key, syntaxErrors.get(expression)!);
  };
  if (automation.when.kind === "field-changed") {
    if (automation.when.field === "") problems.set("when/field", "Choose a field.");
    if (automation.when.to?.kind === "formula") formulaProblem("when/to", automation.when.to.expression);
  }
  if (automation.when.kind === "starts-matching") formulaProblem("when/condition", automation.when.condition);
  if (automation.if !== null && draft.conditionMode === "formula") formulaProblem("if", automation.if);
  draft.rows.forEach(({ row }, index) => {
    if (typeOf(collectionPath, row.field) === "number" && typeof rowValue(row) !== "number") {
      problems.set(`if/${index}`, "Enter a number.");
    }
  });
  if (draft.steps.length === 0) problems.set("do", "Add a step.");
  draft.steps.forEach(({ step, rows }, index) => {
    const editable = editableStep(step);
    if (editable === null) return;
    if (rows.length === 0) problems.set(`do/${index}/values`, editable.kind === "set" ? "Add a field to set." : "Add a field.");
    if (editable.kind === "set" && automation.when.kind === "record-removed") {
      problems.set(`do/${index}`, "A removed record has no fields to set. Choose another trigger, or remove this step.");
    }
    const seen = new Set<string>();
    const collection = targetOf(step);
    rows.forEach(({ value: entry }, row) => {
      if (entry.field === "") problems.set(`do/${index}/${row}/field`, "Choose a field.");
      else if (seen.has(entry.field)) problems.set(`do/${index}/${row}/field`, `${entry.field} is in this step twice.`);
      seen.add(entry.field);
      if (entry.value.kind === "formula") formulaProblem(`do/${index}/${row}/value`, entry.value.expression);
      if (entry.value.kind === "literal" && typeOf(collection, entry.field) === "number" &&
        numberValue("number", entry.value.value) === undefined) {
        problems.set(`do/${index}/${row}/value`, "Enter a number.");
      }
    });
  });
  // What main's check found that the builder did not: shown once the person tries to save.
  if (checked?.key === automationKey) {
    for (const diagnostic of checked.diagnostics) {
      const [key, sentence] = diagnosticProblem(diagnostic);
      if (!problems.has(key)) problems.set(key, sentence);
    }
  }
  const syntaxSentences = new Set(syntaxErrors.values());
  // A syntax error shows as the person types; the rest once they try to save.
  const problem = (key: string): string | null => {
    const text = problems.get(key) ?? null;
    return text !== null && (attempted || syntaxSentences.has(text)) ? text : null;
  };

  const save = async (): Promise<boolean> => {
    setAttempted(true);
    if (problems.size > 0) return false;
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
    if (answer.diagnostics.length > 0 || answer.formulas.size > 0) return false;
    props.onSave(candidate);
    return true;
  };

  const setStep = (key: number, change: (entry: StepEntry) => StepEntry) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((entry) => (entry.key === key ? { ...change(entry), verdict: null } : entry)),
    }));
  const moveStep = (key: number, by: -1 | 1) => {
    const index = draft.steps.findIndex((entry) => entry.key === key);
    const to = index + by;
    // Focus stays on the arrow that moved it, or the other one at an edge.
    const edge = to === 0 || to === draft.steps.length - 1;
    focusAfter(`step-${key}-${edge ? (by === -1 ? "down" : "up") : by === -1 ? "up" : "down"}`, () => setDraft((current) => {
      const steps = [...current.steps];
      const [moved] = steps.splice(index, 1);
      if (moved) steps.splice(to, 0, moved);
      return { ...current, steps };
    }));
  };
  const removeStep = (key: number) => {
    const index = draft.steps.findIndex((entry) => entry.key === key);
    const neighbor = draft.steps[index + 1] ?? draft.steps[index - 1];
    focusAfter(neighbor ? `step-${neighbor.key}-remove` : "add-step", () =>
      setDraft((current) => ({ ...current, steps: current.steps.filter((entry) => entry.key !== key) })));
  };
  const addStep = (step: AutomationStep) => {
    const entry = entryOf(step, null);
    focusAfter(`step-${entry.key}-first`, () => setDraft((current) => ({ ...current, steps: [...current.steps, entry] })));
  };
  const setRows = (key: number, rows: Row[]) => setStep(key, (entry) => ({ ...entry, rows }));
  const newCondition = (): ConditionEntry => ({ key: newKey(), row: { field: props.fields[0]?.name ?? "", operator: "is", value: "" } });

  const trigger = draft.when;
  const builderTrigger = builderTriggerOf(trigger);
  const reachable = (targets ?? []).filter((target) => target.stopped === null && target.path !== collectionPath);
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
          <SecondaryButton size="compact" className="mt-1" onClick={props.onOpenFile}>Open file</SecondaryButton>
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
        />
        {props.cannotRun ? (
          <StatusLine tone="warning" icon={AlertTriangle} label="Does not run">{props.cannotRun}</StatusLine>
        ) : waiting ? (
          <StatusLine tone="muted" icon={Clock} label="Waiting">Waiting to check who can edit {own}.</StatusLine>
        ) : null}

        <section aria-label="When" className="flex flex-col gap-1.5">
          <SectionLabel>When</SectionLabel>
          <select
            aria-label="Trigger"
            value={builderTrigger ?? ""}
            onChange={(event) => setWhen(triggerFor(event.target.value as BuilderTrigger, draft.when, props.fields))}
            className={selectClass}
          >
            {builderTrigger === null ? <option value="" disabled>{sentenceText(triggerParts(trigger))}</option> : null}
            {Object.entries(TRIGGER_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
          {trigger.kind === "field-changed" ? (
            <>
              <FieldSelect
                label="Field that changes"
                fields={props.fields}
                value={trigger.field}
                collection={own}
                onChange={(field) => setWhen({ kind: "field-changed", field, to: null, table: trigger.table })}
              />
              <Problem text={problem("when/field")} />
              <ToValue>
                <ValueInput
                  label="Changes to"
                  field={props.fields.find((field) => field.name === trigger.field)}
                  value={trigger.to}
                  allowAny
                  problem={problem("when/to")}
                  onChange={(to) => setWhen({ ...trigger, to })}
                />
              </ToValue>
            </>
          ) : trigger.kind === "starts-matching" ? (
            <>
              <input
                aria-label="Condition to match"
                value={trigger.condition}
                spellCheck={false}
                placeholder='record.Status == "Blocked"'
                onChange={(event) => setWhen({ ...trigger, condition: event.target.value })}
                className={formulaClass}
              />
              <Problem text={problem("when/condition")} />
            </>
          ) : null}
          <Problem text={problem("when")} />
        </section>

        <section aria-label="Only if" className="flex flex-col gap-1.5">
          <SectionLabel>Only if</SectionLabel>
          <select
            aria-label="Condition"
            data-focus="condition-mode"
            value={draft.conditionMode}
            onChange={(event) => {
              const mode = event.target.value as ConditionMode;
              setDraft((current) => ({
                ...current,
                conditionMode: mode,
                // A formula starts from what the rows said.
                conditionFormula: mode === "formula" && current.conditionMode === "rows" ? (automation.if ?? "") : current.conditionFormula,
                rows: mode === "rows" && current.rows.length === 0 ? [newCondition()] : current.rows,
              }));
            }}
            className={selectClass}
          >
            <option value="always">Always</option>
            <option value="rows">Fields match</option>
            <option value="formula">Formula</option>
          </select>
          {draft.conditionMode === "rows" ? (
            <>
              {draft.rows.map(({ key, row }, index) => {
                const field = props.fields.find((candidate) => candidate.name === row.field);
                const replace = (next: ConditionRow) =>
                  setDraft((current) => ({ ...current, rows: current.rows.map((entry) => (entry.key === key ? { key, row: next } : entry)) }));
                return (
                  <div key={key} className="flex items-start gap-1">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <FieldSelect
                        label={`Condition ${index + 1}, field`}
                        fields={props.fields}
                        value={row.field}
                        collection={own}
                        focusKey={`condition-${key}-first`}
                        onChange={(name) => replace({ ...row, field: name, value: "" })}
                      />
                      <select
                        aria-label={`Condition ${index + 1}, comparison`}
                        value={row.operator}
                        onChange={(event) => replace({ ...row, operator: event.target.value as ConditionOperator })}
                        className={selectClass}
                      >
                        {Object.entries(OPERATOR_LABELS).map(([operator, label]) => (
                          <option key={operator} value={operator}>{label}</option>
                        ))}
                      </select>
                      <LiteralInput
                        label={`Condition ${index + 1}, value`}
                        type={field?.type ?? null}
                        options={field?.type === "select" || field?.type === "multi-select" ? field.options : []}
                        text={row.value === null ? "" : String(row.value)}
                        onChange={(value) => replace({
                          ...row,
                          value: value.kind === "literal" && !Array.isArray(value.value) ? value.value : null,
                        })}
                      />
                      <Problem text={problem(`if/${index}`)} />
                    </div>
                    <IconButton
                      aria-label={`Remove condition ${index + 1}`}
                      title="Remove"
                      data-focus={`condition-${key}-remove`}
                      onClick={() => {
                        const neighbor = draft.rows[index + 1] ?? draft.rows[index - 1];
                        focusAfter(neighbor ? `condition-${neighbor.key}-remove` : "condition-mode", () => setDraft((current) => {
                          const rows = current.rows.filter((entry) => entry.key !== key);
                          return { ...current, rows, conditionMode: rows.length === 0 ? "always" : current.conditionMode };
                        }));
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
                onClick={() => {
                  const entry = newCondition();
                  focusAfter(`condition-${entry.key}-first`, () => setDraft((current) => ({ ...current, rows: [...current.rows, entry] })));
                }}
              >
                <Plus size={12} aria-hidden />
                Add condition
              </SecondaryButton>
            </>
          ) : draft.conditionMode === "formula" ? (
            <input
              aria-label="Condition formula"
              value={draft.conditionFormula}
              spellCheck={false}
              placeholder='record.Priority == "High"'
              onChange={(event) => setDraft((current) => ({ ...current, conditionFormula: event.target.value }))}
              className={formulaClass}
            />
          ) : null}
          <Problem text={problem("if")} />
        </section>

        <section aria-label="Do" className="flex flex-col gap-2">
          <SectionLabel>Do</SectionLabel>
          {draft.steps.map((entry, index) => {
            const { key, step, rows } = entry;
            const editable = editableStep(step);
            const targetPath = targetOf(step);
            const targetStopped = step.kind === "add-record" && targetPath !== collectionPath
              ? (targets?.find((target) => target.path === targetPath)?.stopped ?? null)
              : null;
            const fields = schemas.get(targetPath) ?? null;
            return (
              <div key={key} data-testid={`builder-step-${index}`} className="rounded-lg border border-line bg-bg p-2">
                <div className="mb-1.5 flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                    {editable?.kind === "set" ? "Set fields" : editable?.kind === "add-record" ? "Add a record" : `Step ${index + 1}`}
                  </span>
                  <IconButton
                    aria-label={`Move step ${index + 1} up`}
                    title="Move up"
                    data-focus={`step-${key}-up`}
                    disabled={index === 0}
                    onClick={() => moveStep(key, -1)}
                  >
                    <ArrowUp size={13} aria-hidden />
                  </IconButton>
                  <IconButton
                    aria-label={`Move step ${index + 1} down`}
                    title="Move down"
                    data-focus={`step-${key}-down`}
                    disabled={index === draft.steps.length - 1}
                    onClick={() => moveStep(key, 1)}
                  >
                    <ArrowDown size={13} aria-hidden />
                  </IconButton>
                  <IconButton
                    aria-label={`Remove step ${index + 1}`}
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
                {editable === null ? (
                  <p className="m-0 break-words text-[12px] leading-snug text-muted">
                    <Sentence parts={stepParts(step)} />
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {editable.kind === "add-record" ? (
                      <select
                        aria-label={`Step ${index + 1}, Collection`}
                        data-focus={`step-${key}-first`}
                        value={targetPath}
                        onChange={(event) => setStep(key, (current) => ({
                          ...current,
                          step: { ...editable, collection: event.target.value === collectionPath ? null : event.target.value },
                        }))}
                        className={selectClass}
                      >
                        <option value={collectionPath}>{own}</option>
                        {targetStopped !== null ? <option value={targetPath}>{collectionName(targetPath)}</option> : null}
                        {reachable.map((target) => <option key={target.path} value={target.path}>{target.name}</option>)}
                      </select>
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
                              label={`Step ${index + 1}, field ${rowIndex + 1}`}
                              fields={fields}
                              value={row.field}
                              collection={collectionName(targetPath)}
                              focusKey={rowIndex === 0 && editable.kind === "set" ? `step-${key}-first` : `row-${rowKey}-first`}
                              onChange={(next) => replace({
                                field: next,
                                value: defaultValueFor(fields?.find((candidate) => candidate.name === next)),
                              })}
                            />
                            <Problem text={problem(`do/${index}/${rowIndex}/field`)} />
                            <ToValue>
                              <ValueInput
                                label={`Step ${index + 1}, ${name}`}
                                field={field}
                                value={row.value}
                                problem={problem(`do/${index}/${rowIndex}/value`)}
                                onChange={(value) => replace({ field: row.field, value: value ?? { kind: "literal", value: null } })}
                              />
                            </ToValue>
                          </div>
                          <IconButton
                            aria-label={`Remove ${name} from step ${index + 1}`}
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
                      Add field
                    </SecondaryButton>
                    <Problem text={problem(`do/${index}/values`)} />
                  </div>
                )}
                <Problem text={problem(`do/${index}`)} />
              </div>
            );
          })}
          <Problem text={problem("do")} />
          <div className="flex flex-wrap gap-1.5">
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1"
              data-focus="add-step"
              onClick={() => addStep({ kind: "set", values: [blankRow().value], records: null, operation: null })}
            >
              <Plus size={12} aria-hidden />
              Set fields
            </SecondaryButton>
            <SecondaryButton
              size="compact"
              className="flex items-center gap-1"
              onClick={() => addStep({ kind: "add-record", values: [blankRow().value], collection: null, as: null, operation: null })}
            >
              <Plus size={12} aria-hidden />
              Add a record
            </SecondaryButton>
          </div>
        </section>
      </fieldset>

      <Problem text={problem("save")} />
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
