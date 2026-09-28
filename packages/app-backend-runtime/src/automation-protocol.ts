import type { JsonValue } from "./protocol.js";

const KiB = 1024, MiB = 1024 * KiB;

/**
 * Automation evaluation limits, each no looser than its dataset guest counterpart in `DEFAULT_LIMITS`.
 * The scope is host data, like `queryBytes`.
 */
export const AUTOMATION_LIMITS = Object.freeze({
  /** Time to read the scope into a formula or code step's fresh context, before its own time starts. */
  prepareMs: 1000,
  /** Time for one formula once its scope is ready. */
  formulaMs: 100,
  /** Time for one code step once its scope is ready. */
  codeMs: 1000,
  /**
   * Time one request's formulas and code steps can run, not counting reading the scope, like the dataset
   * guest's `deadlineMs`. Items that start after it is spent do not run.
   */
  requestMs: 8000,
  /** Time one request can spend reading the scope, over all its formulas. Items that start after it is spent do not run. */
  prepareRequestMs: 8000,
  /**
   * One request's WebAssembly memory. Each request gets a fresh one, so no request reads memory another used.
   * QuickJS itself uses about 7 MiB, so one formula or code step can use about 17 MiB, less its scope.
   * QuickJS's own memory limit cannot measure allocations in this build, so this cap is the bound.
   */
  memoryBytes: 24 * MiB,
  stackBytes: 256 * KiB,
  /** One expression, code step, or message text's parts together. */
  sourceBytes: 64 * KiB,
  textParts: 1024,
  scopeBytes: 256 * KiB,
  resultBytes: 64 * KiB,
  /** How deeply a result's lists and objects can nest. A value in the scope can nest as deeply. */
  resultDepth: 64,
  formulasPerBatch: 64,
  /** Requests waiting or running. When the queue is full, a new request returns `busy` for every item. */
  queuedRequests: 16,
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
  /**
   * Names of other steps' results this formula or code step cannot read,
   * because those steps have not run, each with why. Reading one throws a
   * ReferenceError with that text instead of reading nothing.
   */
  unavailable?: Record<string, string>;
  now: string;
  /**
   * The only keys of the trigger record that formulas may read, as `record`
   * and as `trigger.record`. Reading any other key stops the formula with an
   * error instead of reading nothing. Absent means every key.
   */
  recordKeys?: string[];
}

/** One part of message text. This matches `AutomationTextPart` from the automations file contract. */
export type AutomationTextPart = { kind: "text"; text: string } | { kind: "expression"; expression: string };

/** `expression` is JavaScript such as `record.Status == "Done"`. `text` is message text, already split into parts. */
export type AutomationFormula = (
  | { kind: "expression"; source: string }
  | { kind: "text"; parts: AutomationTextPart[] }
) & {
  /**
   * All guards must match earlier successful results. Otherwise this formula returns null without running.
   * Dependent formulas can share a guard object; its comparison value counts once toward the request's size.
   */
  when?: Array<{ index: number } & ({ truthy: boolean } | { equals: JsonValue })>;
};

export type AutomationErrorCode = "syntax" | "runtime" | "timeout" | "memory" | "too_large" | "invalid_result" | "busy";
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
/** Time a request has spent reading its scope and running its items, in milliseconds. */
export interface AutomationTimeSpent { prepareMs: number; runMs: number }
/** A run sends its scope on first use of a worker, then continues until end. `spent` includes earlier phases and workers. */
export type AutomationWorkerRequest =
  | { kind: "evaluate"; runId: number; scope?: AutomationScope; items: AutomationWorkerItem[]; spent: AutomationTimeSpent }
  | { kind: "end"; runId: number };
/**
 * The worker answers each item in order with `result` and the time the item took. A result with `restart` is the
 * last one this worker sends for the request: its item broke the worker's QuickJS instance. A plain `restart` means the
 * worker failed before it evaluated any item. `refused` replaces every result for a scope the worker cannot evaluate.
 */
export type AutomationWorkerReply =
  | { kind: "ready" }
  | ({ kind: "result"; result: AutomationOutcome<JsonValue>; restart?: true } & AutomationTimeSpent)
  | { kind: "restart" }
  | { kind: "refused"; message: string };

export const subjectOf = (item: { kind: AutomationWorkerItem["kind"] }) => item.kind === "code" ? "The code" : "The formula";
export const itemLimitMs = (item: { kind: AutomationWorkerItem["kind"] }) =>
  item.kind === "code" ? AUTOMATION_LIMITS.codeMs : AUTOMATION_LIMITS.formulaMs;
/** The worker refuses a request whose scope it cannot turn into JSON. */
export const NOT_JSON = "The automation scope must hold only JSON values.";
export const failure = (code: AutomationErrorCode, message: string) => ({ ok: false, error: { code, message } }) as const;

/** The scope object and its `record` or `bindings` object add two levels to the nesting of the values in them. */
export const SCOPE_DEPTH = AUTOMATION_LIMITS.resultDepth + 2;
export const scopeTooLarge = () => failure("too_large", `The record and step results are larger than ${AUTOMATION_LIMITS.scopeBytes / 1024} KiB.`);
export const scopeTooDeep = () => failure("too_large", `The record and step results nest lists or objects more than ${AUTOMATION_LIMITS.resultDepth} levels deep.`);

/** The failure for an item that starts after its request spent one of its time budgets, or nothing. */
export function notReached(item: AutomationWorkerItem, spent: AutomationTimeSpent) {
  if (spent.runMs >= AUTOMATION_LIMITS.requestMs) {
    return failure("timeout", `${subjectOf(item)} did not run because the run took longer than ${AUTOMATION_LIMITS.requestMs / 1000} s.`);
  }
  if (spent.prepareMs >= AUTOMATION_LIMITS.prepareRequestMs) {
    return failure("timeout", `${subjectOf(item)} did not run because reading the record and step results took longer than ${AUTOMATION_LIMITS.prepareRequestMs / 1000} s in all.`);
  }
  return undefined;
}
