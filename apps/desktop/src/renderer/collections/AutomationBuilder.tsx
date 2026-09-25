import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionFieldType, FieldDefinition } from "@dohc/workspace-contracts";
import type { ListAutomationTargetsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
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
} from "./automationSentence";

// The builder: When, Only if, and Do, with choices instead of formulas, and
// a formula wherever a person wants one. Steps the builder cannot edit yet,
// such as Find and If, stay as they are and read as their sentence; the
// file edits them. Saving goes through the panel, which writes the whole
// list over the content it read.

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;
type Target = Extract<ListAutomationTargetsResult, { collections: unknown }>["collections"][number];
type SetStep = Extract<AutomationStep, { kind: "set" }>;
type AddStep = Extract<AutomationStep, { kind: "add-record" }>;
type FieldValue = SetStep["values"][number];

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
  onChange: (field: string) => void;
}) {
  const known = props.value === "" || props.fields === null || props.fields.some((field) => field.name === props.value);
  return (
    <>
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={selectClass}
      >
        {props.value === "" ? <option value="" disabled>Choose a field</option> : null}
        {props.fields?.some((field) => field.name === props.value) ? null : props.value === "" ? null : (
          <option value={props.value}>{props.value}</option>
        )}
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
 * options, a checkbox checked or unchecked, a number and a date their own
 * inputs. `single` picks one option of a multi-select, as a condition does.
 */
function LiteralInput(props: {
  label: string;
  type: CollectionFieldType | null;
  options: readonly string[];
  text: string;
  single?: boolean;
  onChange: (value: AutomationValue) => void;
}) {
  const { type, text } = props;
  const listed = type === "select" || (props.single === true && type === "multi-select");
  if (listed) {
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
      type={type === "number" ? "number" : type === "date" ? "date" : "text"}
      value={text}
      onChange={(event) => props.onChange(literalFor(type, event.target.value))}
      className={inputClass}
    />
  );
}

/** A value: its kind, and for "A value" and "Formula", what was typed. */
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
      {kind === "value" ? (
        <LiteralInput
          label={props.label}
          type={type}
          options={props.field?.type === "select" || props.field?.type === "multi-select" ? props.field.options : []}
          text={literalText(props.value)}
          onChange={props.onChange}
        />
      ) : kind === "formula" && props.value?.kind === "formula" ? (
        <input
          aria-label={`${props.label}, formula`}
          value={props.value.expression}
          spellCheck={false}
          placeholder='dateAdd(today(), 3, "days")'
          onChange={(event) => props.onChange({ kind: "formula", expression: event.target.value })}
          className={formulaClass}
        />
      ) : null}
      <Problem text={props.problem} />
    </div>
  );
}

function FieldRows(props: {
  step: number;
  values: readonly FieldValue[];
  fields: readonly FieldDefinition[] | null;
  collection: string;
  problem: (key: string) => string | null;
  onChange: (values: FieldValue[]) => void;
}) {
  const { values, fields } = props;
  const replace = (index: number, value: FieldValue) =>
    props.onChange(values.map((entry, at) => (at === index ? value : entry)));
  return (
    <div className="flex flex-col gap-2">
      {values.map((entry, index) => {
        const field = fields?.find((candidate) => candidate.name === entry.field);
        const name = entry.field || `field ${index + 1}`;
        return (
          <div key={index} className="flex items-start gap-1">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldSelect
                label={`Step ${props.step + 1}, field ${index + 1}`}
                fields={fields}
                value={entry.field}
                collection={props.collection}
                onChange={(next) => replace(index, {
                  field: next,
                  value: defaultValueFor(fields?.find((candidate) => candidate.name === next)),
                })}
              />
              <Problem text={props.problem(`do/${props.step}/${index}/field`)} />
              <ValueInput
                label={`Step ${props.step + 1}, ${name}`}
                field={field}
                value={entry.value}
                problem={props.problem(`do/${props.step}/${index}/value`)}
                onChange={(value) => replace(index, { field: entry.field, value: value ?? { kind: "literal", value: null } })}
              />
            </div>
            <IconButton
              aria-label={`Remove ${name} from step ${props.step + 1}`}
              title="Remove"
              onClick={() => props.onChange(values.filter((_entry, at) => at !== index))}
            >
              <Trash2 size={13} aria-hidden />
            </IconButton>
          </div>
        );
      })}
      <SecondaryButton
        size="compact"
        className="flex items-center gap-1 self-start"
        onClick={() => props.onChange([...values, { field: "", value: { kind: "literal", value: "" } }])}
      >
        <Plus size={12} aria-hidden />
        Add field
      </SecondaryButton>
      <Problem text={props.problem(`do/${props.step}/values`)} />
    </div>
  );
}

/** Every formula the draft holds, for the syntax check. */
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

/** What keeps the draft from saving, keyed by the part it belongs to. */
function problemsOf(automation: Automation, syntax: ReadonlyMap<string, string>): Map<string, string> {
  const problems = new Map<string, string>();
  const formula = (key: string, expression: string) => {
    if (expression.trim() === "") problems.set(key, "Write a formula.");
    else if (syntax.has(expression)) problems.set(key, syntax.get(expression)!);
  };
  const when = automation.when;
  if (when.kind === "field-changed") {
    if (when.field === "") problems.set("when/field", "Choose a field.");
    if (when.to?.kind === "formula") formula("when/to", when.to.expression);
  }
  if (when.kind === "starts-matching") formula("when/condition", when.condition);
  if (automation.if !== null) formula("if", automation.if);
  if (automation.do.length === 0) problems.set("do", "Add a step.");
  automation.do.forEach((step, index) => {
    if (step.kind !== "set" && step.kind !== "add-record") return;
    if (step.kind === "set" && step.values.length === 0) problems.set(`do/${index}/values`, "Add a field to set.");
    const seen = new Set<string>();
    step.values.forEach((entry, row) => {
      if (entry.field === "") problems.set(`do/${index}/${row}/field`, "Choose a field.");
      else if (seen.has(entry.field)) problems.set(`do/${index}/${row}/field`, `${entry.field} is in this step twice.`);
      seen.add(entry.field);
      if (entry.value.kind === "formula") formula(`do/${index}/${row}/value`, entry.value.expression);
    });
  });
  return problems;
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

export function AutomationBuilder(props: {
  workspaceId: string;
  collectionPath: string;
  fields: readonly FieldDefinition[];
  /** The automation to edit, or a new one with an empty id. */
  automation: Automation;
  /** Why the saved version does not run, such as a field the Collection lacks. */
  cannotRun: string | null;
  takenIds: ReadonlySet<string>;
  saving: boolean;
  onSave: (automation: Automation) => void;
  onCancel: () => void;
  onError: ErrorReport;
}) {
  const { workspaceId, collectionPath, onError } = props;
  const isNew = props.automation.id === "";
  const [draft, setDraft] = useState(props.automation);
  const [conditionMode, setConditionMode] = useState<ConditionMode>(() => {
    if (props.automation.if === null) return "always";
    return (conditionRows(props.automation.if)?.length ?? 0) > 0 ? "rows" : "formula";
  });
  const [rows, setRows] = useState<ConditionRow[]>(() =>
    props.automation.if === null ? [] : (conditionRows(props.automation.if) ?? []));
  const [attempted, setAttempted] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [schemas, setSchemas] = useState(() => new Map<string, readonly FieldDefinition[]>([[collectionPath, props.fields]]));
  const [syntax, setSyntax] = useState<ReadonlyMap<string, string>>(new Map());
  // Answers for another workspace or Collection, or after the builder
  // closes, change nothing here.
  const scope = useRequestSequence([workspaceId, collectionPath]);
  const nameInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const own = collectionName(collectionPath);
  const condition = conditionMode === "always" ? null : conditionMode === "rows" ? conditionFormula(rows) : (draft.if ?? "");
  const automation: Automation = { ...draft, if: condition };

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
    () => [...new Set(draft.do.flatMap((step) => (step.kind === "add-record" && step.collection !== null ? [step.collection] : [])))],
    [draft.do],
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

  // The evaluator the runs use checks each formula a moment after the
  // person stops typing.
  const formulas = formulasOf(automation);
  const formulasKey = JSON.stringify(formulas);
  useEffect(() => {
    if (formulas.length === 0) {
      setSyntax(new Map());
      return;
    }
    const epoch = scope.current();
    const timer = setTimeout(() => {
      void bridge()
        .checkAutomationFormulas({ workspaceId, formulas })
        .then(({ problems }) => {
          if (!scope.isCurrent(epoch)) return;
          setSyntax(new Map(formulas.flatMap((formula, index) => {
            const problem = problems[index];
            return problem ? [[formula, `This formula has a syntax error. ${problem}`] as const] : [];
          })));
        })
        // The file contract checks again on save.
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [formulasKey, workspaceId]);

  const problems = problemsOf(automation, syntax);
  const syntaxErrors = new Set(syntax.values());
  // A syntax error shows as the person types; the rest once they try to save.
  const problem = (key: string): string | null => {
    const text = problems.get(key) ?? null;
    return text !== null && (attempted || syntaxErrors.has(text)) ? text : null;
  };

  const setStep = (index: number, step: AutomationStep) =>
    setDraft((current) => ({ ...current, do: current.do.map((entry, at) => (at === index ? step : entry)) }));
  const moveStep = (index: number, by: -1 | 1) =>
    setDraft((current) => {
      const next = [...current.do];
      const [step] = next.splice(index, 1);
      if (step) next.splice(index + by, 0, step);
      return { ...current, do: next };
    });
  const newRow = (): ConditionRow => ({ field: props.fields[0]?.name ?? "", operator: "is", value: "" });

  const save = () => {
    setAttempted(true);
    if (problems.size > 0) return;
    const name = automation.name.trim() || sentenceText(automationSentence(automation)).slice(0, MAX_NAME_LENGTH);
    props.onSave({ ...automation, name, id: isNew ? idFor(name, props.takenIds) : automation.id });
  };

  const trigger = draft.when;
  const builderTrigger = builderTriggerOf(trigger);
  const reachable = (targets ?? []).filter((target) => target.stopped === null && target.path !== collectionPath);

  return (
    <form
      className="flex flex-col gap-4 px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        ref={nameInput}
        aria-label="Name"
        value={draft.name}
        maxLength={MAX_NAME_LENGTH}
        placeholder={sentenceText(automationSentence({ ...automation, name: "" }))}
        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        className={`${inputClass} font-medium`}
      />
      {props.cannotRun ? (
        <StatusLine tone="warning" icon={AlertTriangle} label="Does not run">{props.cannotRun}</StatusLine>
      ) : null}

      <section aria-label="When" className="flex flex-col gap-1.5">
        <SectionLabel>When</SectionLabel>
        <select
          aria-label="Trigger"
          value={builderTrigger ?? ""}
          onChange={(event) => setDraft((current) => ({
            ...current,
            when: triggerFor(event.target.value as BuilderTrigger, current.when, props.fields),
          }))}
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
              onChange={(field) => setDraft((current) => ({ ...current, when: { kind: "field-changed", field, to: null, table: null } }))}
            />
            <Problem text={problem("when/field")} />
            <ValueInput
              label="Changes to"
              field={props.fields.find((field) => field.name === trigger.field)}
              value={trigger.to}
              allowAny
              problem={problem("when/to")}
              onChange={(to) => setDraft((current) => ({ ...current, when: { ...trigger, to } }))}
            />
          </>
        ) : trigger.kind === "starts-matching" ? (
          <>
            <input
              aria-label="Condition to match"
              value={trigger.condition}
              spellCheck={false}
              placeholder='record.Status == "Blocked"'
              onChange={(event) => setDraft((current) => ({ ...current, when: { kind: "starts-matching", condition: event.target.value, table: null } }))}
              className={formulaClass}
            />
            <Problem text={problem("when/condition")} />
          </>
        ) : null}
      </section>

      <section aria-label="Only if" className="flex flex-col gap-1.5">
        <SectionLabel>Only if</SectionLabel>
        <select
          aria-label="Condition"
          value={conditionMode}
          onChange={(event) => {
            const mode = event.target.value as ConditionMode;
            // A formula starts from what the rows said.
            if (mode === "formula") setDraft((current) => ({ ...current, if: condition ?? "" }));
            if (mode === "rows" && rows.length === 0) setRows([newRow()]);
            setConditionMode(mode);
          }}
          className={selectClass}
        >
          <option value="always">Always</option>
          <option value="rows">Fields match</option>
          <option value="formula">Formula</option>
        </select>
        {conditionMode === "rows" ? (
          <>
            {rows.map((row, index) => {
              const field = props.fields.find((candidate) => candidate.name === row.field);
              const replace = (next: ConditionRow) =>
                setRows((current) => current.map((entry, at) => (at === index ? next : entry)));
              return (
                <div key={index} className="flex items-start gap-1">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <FieldSelect
                      label={`Condition ${index + 1}, field`}
                      fields={props.fields}
                      value={row.field}
                      collection={own}
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
                      single
                      onChange={(value) => replace({
                        ...row,
                        value: value.kind === "literal" && !Array.isArray(value.value) ? value.value : null,
                      })}
                    />
                  </div>
                  <IconButton
                    aria-label={`Remove condition ${index + 1}`}
                    title="Remove"
                    onClick={() => {
                      const next = rows.filter((_row, at) => at !== index);
                      setRows(next);
                      if (next.length === 0) setConditionMode("always");
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
              onClick={() => setRows((current) => [...current, newRow()])}
            >
              <Plus size={12} aria-hidden />
              Add condition
            </SecondaryButton>
          </>
        ) : conditionMode === "formula" ? (
          <>
            <input
              aria-label="Condition formula"
              value={draft.if ?? ""}
              spellCheck={false}
              placeholder='record.Priority == "High"'
              onChange={(event) => setDraft((current) => ({ ...current, if: event.target.value }))}
              className={formulaClass}
            />
            <Problem text={problem("if")} />
          </>
        ) : null}
      </section>

      <section aria-label="Do" className="flex flex-col gap-2">
        <SectionLabel>Do</SectionLabel>
        {draft.do.map((step, index) => {
          const editable = editableStep(step);
          const targetPath = step.kind === "add-record" ? (step.collection ?? collectionPath) : collectionPath;
          const stopped = step.kind === "add-record" && targetPath !== collectionPath
            ? (targets?.find((target) => target.path === targetPath)?.stopped ?? null)
            : null;
          return (
            <div key={index} data-testid={`builder-step-${index}`} className="rounded-lg border border-line bg-bg p-2">
              <div className="mb-1.5 flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                  {editable?.kind === "set" ? "Set fields" : editable?.kind === "add-record" ? "Add a record" : `Step ${index + 1}`}
                </span>
                <IconButton aria-label={`Move step ${index + 1} up`} title="Move up" disabled={index === 0} onClick={() => moveStep(index, -1)}>
                  <ArrowUp size={13} aria-hidden />
                </IconButton>
                <IconButton
                  aria-label={`Move step ${index + 1} down`}
                  title="Move down"
                  disabled={index === draft.do.length - 1}
                  onClick={() => moveStep(index, 1)}
                >
                  <ArrowDown size={13} aria-hidden />
                </IconButton>
                <IconButton
                  aria-label={`Remove step ${index + 1}`}
                  title="Remove"
                  onClick={() => setDraft((current) => ({ ...current, do: current.do.filter((_step, at) => at !== index) }))}
                >
                  <Trash2 size={13} aria-hidden />
                </IconButton>
              </div>
              {editable === null ? (
                <p className="m-0 break-words text-[12px] leading-snug text-muted">
                  <Sentence parts={stepParts(step)} />
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {editable.kind === "add-record" ? (
                    <>
                      <select
                        aria-label={`Step ${index + 1}, Collection`}
                        value={targetPath}
                        onChange={(event) => setStep(index, {
                          ...editable,
                          collection: event.target.value === collectionPath ? null : event.target.value,
                        })}
                        className={selectClass}
                      >
                        <option value={collectionPath}>{own}</option>
                        {stopped !== null ? <option value={targetPath}>{collectionName(targetPath)}</option> : null}
                        {reachable.map((target) => <option key={target.path} value={target.path}>{target.name}</option>)}
                      </select>
                      {stopped !== null ? (
                        <StatusLine tone="warning" icon={AlertTriangle} label="Out of reach">{stopped}</StatusLine>
                      ) : null}
                    </>
                  ) : null}
                  <FieldRows
                    step={index}
                    values={editable.values}
                    fields={schemas.get(targetPath) ?? null}
                    collection={collectionName(targetPath)}
                    problem={problem}
                    onChange={(values) => setStep(index, { ...editable, values })}
                  />
                </div>
              )}
            </div>
          );
        })}
        <Problem text={problem("do")} />
        <div className="flex flex-wrap gap-1.5">
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            onClick={() => setDraft((current) => ({
              ...current,
              do: [...current.do, { kind: "set", values: [{ field: "", value: { kind: "literal", value: "" } }], records: null, operation: null }],
            }))}
          >
            <Plus size={12} aria-hidden />
            Set fields
          </SecondaryButton>
          <SecondaryButton
            size="compact"
            className="flex items-center gap-1"
            onClick={() => setDraft((current) => ({
              ...current,
              do: [...current.do, { kind: "add-record", values: [], collection: null, as: null, operation: null }],
            }))}
          >
            <Plus size={12} aria-hidden />
            Add a record
          </SecondaryButton>
        </div>
      </section>

      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <SecondaryButton size="compact" onClick={props.onCancel}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" size="compact" disabled={props.saving}>Save</PrimaryButton>
      </div>
    </form>
  );
}
