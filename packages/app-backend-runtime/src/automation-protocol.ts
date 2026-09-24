import type { JsonValue } from "./protocol.js";

const KiB = 1024, MiB = 1024 * KiB;

/**
 * Automation evaluation limits, each no looser than its dataset guest counterpart in `DEFAULT_LIMITS`.
 * The scope is host data, like `queryBytes`.
 */
export const AUTOMATION_LIMITS = Object.freeze({
  /** Processor time for one formula, including its fresh context. */
  formulaMs: 100,
  /** Processor time for one code step. */
  codeMs: 1000,
  /** Wall time for one request, like the dataset guest's `deadlineMs`. Items it does not reach time out. */
  requestMs: 8000,
  /**
   * The worker's whole WebAssembly memory. QuickJS itself uses about 7 MiB, so one formula or code step
   * can use about 17 MiB, less its scope. QuickJS's own memory limit cannot measure allocations in this
   * build, so this cap is the bound.
   */
  memoryBytes: 24 * MiB,
  stackBytes: 256 * KiB,
  /** One expression, code step, or message text's parts together. */
  sourceBytes: 64 * KiB,
  textParts: 1024,
  scopeBytes: 256 * KiB,
  resultBytes: 64 * KiB,
  /** How deeply a result's lists and objects can nest. */
  resultDepth: 64,
  formulasPerBatch: 64,
});

export type JsonObject = { [key: string]: JsonValue };

/**
 * The names a formula reads without declaring them: the scope's values and the helpers.
 * A step result cannot be bound to one of them. This matches the automations file contract's list.
 */
export const AUTOMATION_SCOPE_NAMES: readonly string[] = Object.freeze([
  "record", "previous", "trigger", "person", "now", "message",
  "today", "dateAdd", "dateBetween", "formatDate", "lower", "upper", "trim", "contains", "join", "length", "sum", "min", "max", "round",
]);

/**
 * What a formula or code step can read. `bindings` holds earlier step results by the name each step
 * binds with `as`; formulas read each one as a name of its own. `now` is the run's time on the computer
 * that runs the automation, as ISO 8601 with that computer's UTC offset, such as `2026-09-24T09:30:00.000+08:00`.
 */
export interface AutomationScope {
  /** Absent when the trigger has no record, such as a schedule. Formulas then read `null`. */
  record?: JsonObject;
  /** Absent when there are no earlier values, such as for a new record. Formulas then read `{}`. */
  previous?: JsonObject;
  trigger: { kind: string; [fact: string]: JsonValue };
  person: { id: string; name: string } | null;
  /** The Group message that triggered the run. Formulas read `null` for other triggers. */
  message?: JsonObject;
  bindings?: JsonObject;
  now: string;
}

/** One part of message text. This matches `AutomationTextPart` from the automations file contract. */
export type AutomationTextPart = { kind: "text"; text: string } | { kind: "expression"; expression: string };

/** `expression` is JavaScript such as `record.Status == "Done"`. `text` is message text, already split into parts. */
export type AutomationFormula =
  | { kind: "expression"; source: string }
  | { kind: "text"; parts: AutomationTextPart[] };

export type AutomationErrorCode = "syntax" | "runtime" | "timeout" | "memory" | "too_large" | "invalid_result";
export interface AutomationError { code: AutomationErrorCode; message: string }
export type AutomationOutcome<T> = { ok: true; value: T } | { ok: false; error: AutomationError };

/** A record change a code step asks for. `collection` is the Collection's workspace path; `id` names the record to change. */
export type AutomationRecordChange =
  | { action: "add"; collection: string; fields: JsonObject }
  | { action: "change"; collection: string; id: string; fields: JsonObject };
/** What a code step returns. The executor applies it with its own checks; the evaluator never writes. */
export interface CodeStepReturn {
  set?: JsonObject;
  records?: AutomationRecordChange[];
  output?: JsonValue;
}

export type AutomationWorkerItem = AutomationFormula | { kind: "code"; source: string };
export type AutomationWorkerRequest = { scope: AutomationScope; items: AutomationWorkerItem[] };
/**
 * The worker answers each item in order with `result`. It sends `restart` after an item that broke its
 * QuickJS module, and `refused` instead of any result when the scope binds a name QuickJS already defines.
 */
export type AutomationWorkerReply =
  | { kind: "ready" }
  | { kind: "result"; result: AutomationOutcome<JsonValue> }
  | { kind: "restart" }
  | { kind: "refused"; message: string };

export const subjectOf = (item: { kind: AutomationWorkerItem["kind"] }) => item.kind === "code" ? "The code" : "The formula";
export const itemLimitMs = (item: { kind: AutomationWorkerItem["kind"] }) =>
  item.kind === "code" ? AUTOMATION_LIMITS.codeMs : AUTOMATION_LIMITS.formulaMs;
export const failure = (code: AutomationErrorCode, message: string) => ({ ok: false, error: { code, message } }) as const;
