import type { ListCollectionAutomationsResult } from "../../ipc/bridgeContract";

// An automation in plain words, as the ⚡ panel lists it: "When Status
// becomes Done, set Finished on to today". Main parses automations.yaml, so
// these are type-only views of what it sends; the renderer never loads the
// file contract.

export type AutomationsFile = Exclude<ListCollectionAutomationsResult, { status: "unavailable" }>;
export type AutomationSummary = Extract<AutomationsFile, { status: "read" }>["automations"][number];
export type ValidAutomationSummary = Extract<AutomationSummary, { valid: true }>;
export type Automation = ValidAutomationSummary["automation"];
export type AutomationTrigger = Automation["when"];
export type AutomationStep = Automation["do"][number];
export type AutomationValue = Extract<AutomationStep, { kind: "set" }>["values"][number]["value"];

/** A run of words, or a formula shown as code. */
export type SentencePart = { kind: "text"; text: string } | { kind: "code"; text: string };

// A step list longer than this reads as "and 2 more steps".
const STEPS_SHOWN = 2;

const text = (value: string): SentencePart => ({ kind: "text", text: value });
const code = (value: string): SentencePart => ({ kind: "code", text: value });

/** The last folder of a Collection path, which is how the sidebar names it. */
export function collectionName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function literalText(value: unknown): string {
  if (value === null) return "empty";
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.map(literalText).join(", ");
  return String(value);
}

/** A value: today() and now() read as words, other formulas as code. */
export function valueParts(value: AutomationValue): SentencePart[] {
  if (value.kind === "literal") return [text(literalText(value.value))];
  const expression = value.expression.trim();
  if (expression === "today()") return [text("today")];
  if (expression === "now()") return [text("now")];
  return [code(expression)];
}

const WEEKDAY_NAMES: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

export function triggerParts(trigger: AutomationTrigger): SentencePart[] {
  switch (trigger.kind) {
    case "record-added":
      return [text("When a record is added")];
    case "record-removed":
      return [text("When a record is removed")];
    case "record-changed":
      return [text(trigger.fields === null ? "When a record changes" : `When ${orList(trigger.fields)} changes`)];
    case "field-changed":
      if (trigger.to === null) return [text(`When ${trigger.field} changes`)];
      if (trigger.to.kind === "literal" && trigger.to.value === null) return [text(`When ${trigger.field} is cleared`)];
      return [text(`When ${trigger.field} becomes `), ...valueParts(trigger.to)];
    case "starts-matching":
      return [text("When a record starts to match "), code(trigger.condition)];
    case "schedule":
      if (trigger.every === "week") {
        return [text(`Every ${trigger.days.map((day) => WEEKDAY_NAMES[day] ?? day).join(", ")} at ${trigger.at}`)];
      }
      if (trigger.every === "month") return [text(`Every month on day ${trigger.days.join(", ")} at ${trigger.at}`)];
      return [text(`Every ${trigger.every} at ${trigger.at}`)];
    case "button":
      return [text(`When someone clicks ${trigger.field}`)];
    case "group-message":
      return [text(`When someone posts in ${trigger.group}`)];
  }
}

function fieldValuesParts(values: Extract<AutomationStep, { kind: "set" }>["values"]): SentencePart[] {
  return values.flatMap(({ field, value }, index) => {
    const joint = index === 0 ? [] : [text(" and ")];
    if (value.kind === "literal" && value.value === null) return [...joint, text(`clear ${field}`)];
    return [...joint, text(`set ${field} to `), ...valueParts(value)];
  });
}

export function stepParts(step: AutomationStep): SentencePart[] {
  switch (step.kind) {
    case "set":
      return [...fieldValuesParts(step.values), ...(step.records === null ? [] : [text(` on ${step.records}`)])];
    case "add-record":
      return [text(step.collection === null ? "add a record" : `add a record to ${collectionName(step.collection)}`)];
    case "find":
      return [
        text(step.collection === null ? "find records where " : `find records in ${collectionName(step.collection)} where `),
        code(step.condition),
      ];
    case "if":
      return [
        text("if "),
        code(step.if),
        text(`, run ${plural(step.do.length, "step", "steps")}`),
        ...(step.otherwise.length === 0 ? [] : [text(`, otherwise ${plural(step.otherwise.length, "step", "steps")}`)]),
      ];
    case "notify":
      return [text(`notify ${plural(step.to.length, "person", "people")}`)];
    case "post":
      return [text(`post in ${step.group}`)];
    case "direct-message":
      return [text("send a direct message")];
    case "wake-agent":
      return [text("wake an agent")];
    case "run":
      return [text("run code")];
    case "run-file":
      return [text(`run ${step.file}`)];
  }
}

/** The whole automation: its trigger, its condition, and its first steps. */
export function automationSentence(automation: Automation): SentencePart[] {
  const shown = automation.do.slice(0, STEPS_SHOWN);
  const more = automation.do.length - shown.length;
  return [
    ...triggerParts(automation.when),
    ...(automation.if === null ? [] : [text(", only if "), code(automation.if)]),
    ...shown.flatMap((step, index) => [text(index === 0 ? ", " : ", then "), ...stepParts(step)]),
    ...(more > 0 ? [text(`, and ${plural(more, "more step", "more steps")}`)] : []),
  ];
}

/** The sentence as plain text, for tooltips and accessible names. */
export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.map((part) => part.text).join("");
}
