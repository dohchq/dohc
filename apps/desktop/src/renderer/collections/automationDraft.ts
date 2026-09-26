import type { CollectionFieldType, FieldDefinition } from "@dohc/workspace-contracts";
import type { Automation, AutomationStep, AutomationValue } from "./automationSentence";

// The builder's model of the parts a person edits without writing a
// formula: "Only if" conditions as rows, and each value as a kind plus what
// was typed. Rows become one expression the file stores, and an expression
// in the shape rows write reads back as rows; anything else stays a formula.

// Mirrors of the file contract, which the renderer never loads.
const MAX_ID_LENGTH = 64;
export const MAX_NAME_LENGTH = 120;

export type ConditionOperator = "is" | "is-not" | "contains";

export interface ConditionRow {
  field: string;
  operator: ConditionOperator;
  value: string | number | boolean | null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** How a formula reads a record's field: `record.Status`, or `record["Finished on"]`. */
export function fieldAccess(field: string): string {
  return IDENTIFIER.test(field) ? `record.${field}` : `record[${JSON.stringify(field)}]`;
}

function conditionExpression(row: ConditionRow): string {
  const value = JSON.stringify(row.value);
  switch (row.operator) {
    case "is":
      return `${fieldAccess(row.field)} == ${value}`;
    case "is-not":
      return `${fieldAccess(row.field)} != ${value}`;
    case "contains":
      return `contains(${fieldAccess(row.field)}, ${value})`;
  }
}

/** The expression "Only if" stores for these rows: every row must hold. */
export function conditionFormula(rows: readonly ConditionRow[]): string {
  return rows.map(conditionExpression).join(" && ");
}

// One row as conditionFormula writes it, at the start of the text.
const FIELD = String.raw`record(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[("(?:[^"\\]|\\.)*")\])`;
const LITERAL = String.raw`("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)`;
const COMPARISON = new RegExp(String.raw`^${FIELD} (==|!=) ${LITERAL}`, "u");
const CONTAINS = new RegExp(String.raw`^contains\(${FIELD}, ${LITERAL}\)`, "u");

function fieldOf(plain: string | undefined, quoted: string | undefined): string {
  return plain ?? (JSON.parse(quoted!) as string);
}

/**
 * The rows an "Only if" expression was written from, or null when it is not
 * in that shape and stays a formula. An empty condition has no rows.
 */
export function conditionRows(expression: string): ConditionRow[] | null {
  const rows: ConditionRow[] = [];
  let rest = expression.trim();
  while (rest.length > 0) {
    const comparison = COMPARISON.exec(rest);
    const contains = comparison ? null : CONTAINS.exec(rest);
    const match = comparison ?? contains;
    if (!match) return null;
    const field = fieldOf(match[1], match[2]);
    const value = JSON.parse(comparison ? match[4]! : match[3]!) as ConditionRow["value"];
    const operator: ConditionOperator = contains ? "contains" : match[3] === "==" ? "is" : "is-not";
    rows.push({ field, operator, value });
    rest = rest.slice(match[0].length);
    if (rest.length === 0) break;
    if (!rest.startsWith(" && ")) return null;
    rest = rest.slice(4);
  }
  // Only an expression rows would write back exactly reads as rows.
  return conditionFormula(rows) === expression.trim() ? rows : null;
}

/** What a value is, as the builder offers it. */
export type ValueKind = "any" | "today" | "now" | "value" | "empty" | "formula";

export function valueKindOf(value: AutomationValue | null): ValueKind {
  if (value === null) return "any";
  if (value.kind === "formula") {
    const expression = value.expression.trim();
    return expression === "today()" ? "today" : expression === "now()" ? "now" : "formula";
  }
  return value.value === null ? "empty" : "value";
}

/** The kinds a field's value can take: dates offer today and now. */
export function valueKindsFor(type: CollectionFieldType | null, allowAny: boolean): ValueKind[] {
  return [
    ...(allowAny ? ["any" as const] : []),
    ...(type === "date" ? ["today" as const, "now" as const] : []),
    "value",
    "empty",
    "formula",
  ];
}

/**
 * A literal from what was typed. A number stays the text typed, so "-" and
 * an empty input keep their place while the person types; numberValue reads
 * it when the automation is built.
 */
export function literalFor(type: CollectionFieldType | null, text: string): AutomationValue {
  if (type === "checkbox") return { kind: "literal", value: text === "true" };
  if (type === "multi-select") {
    return { kind: "literal", value: text.split(",").map((item) => item.trim()).filter((item) => item.length > 0) };
  }
  return { kind: "literal", value: text };
}

/**
 * A number field's typed text as the number it stores, or undefined when it
 * is not a number yet. Any other value is itself.
 */
export function numberValue<Value>(type: CollectionFieldType | null, value: Value): Value | number | undefined {
  if (type !== "number" || typeof value !== "string") return value;
  const number = Number(value);
  return value.trim() === "" || !Number.isFinite(number) ? undefined : number;
}

/** What a literal shows in its input. */
export function literalText(value: AutomationValue | null): string {
  if (value === null || value.kind !== "literal" || value.value === null) return "";
  return Array.isArray(value.value) ? value.value.join(", ") : String(value.value);
}

/** The value a new field row starts with: today for a date, checked for a checkbox. */
export function defaultValueFor(field: FieldDefinition | undefined): AutomationValue {
  if (field?.type === "date") return { kind: "formula", expression: "today()" };
  if (field?.type === "checkbox") return { kind: "literal", value: true };
  if (field?.type === "select") return { kind: "literal", value: field.options[0] ?? "" };
  if (field?.type === "multi-select") return { kind: "literal", value: [] };
  return { kind: "literal", value: "" };
}

/** A new automation's id: its name as a slug, such as "stamp-the-finish-date", not yet taken. */
export function idFor(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "automation";
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = `${slug.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The automation a person starts from: when a field changes, set another.
 * It picks a select field to watch and a date field to set when the
 * Collection has them, so "when Status becomes Done, set Finished on to
 * today" is a few choices away.
 */
export function newAutomation(fields: readonly FieldDefinition[]): Automation {
  const watched = fields.find((field) => field.type === "select") ?? fields[0];
  const set = fields.find((field) => field.type === "date" && field !== watched) ??
    fields.find((field) => field !== watched) ?? watched;
  return {
    id: "",
    name: "",
    enabled: true,
    when: { kind: "field-changed", field: watched?.name ?? "", to: null, table: null },
    if: null,
    do: [{ kind: "set", values: [{ field: set?.name ?? "", value: defaultValueFor(set) }], records: null, operation: null }],
  };
}

/**
 * For each top-level step, the places of its reach verdicts among all of an
 * automation's verdicts, in the order the executor walks the steps: a
 * step, then the steps an If runs, then its otherwise steps.
 */
export function reachPlaces(steps: readonly AutomationStep[], first = 0): number[][] {
  let next = first;
  const walk = (list: readonly AutomationStep[], into: number[]) => {
    for (const step of list) {
      if (step.kind === "set" || step.kind === "add-record" || step.kind === "find" || step.kind === "post" || step.kind === "wake-agent") into.push(next++);
      if (step.kind === "direct-message" || step.kind === "notify") {
        for (const person of step.to) {
          if (person.kind === "literal" && typeof person.value === "string") into.push(next++);
        }
      }
      if (step.kind === "if") {
        walk(step.do, into);
        walk(step.otherwise, into);
      }
    }
  };
  return steps.map((step) => {
    const places: number[] = [];
    walk([step], places);
    return places;
  });
}
