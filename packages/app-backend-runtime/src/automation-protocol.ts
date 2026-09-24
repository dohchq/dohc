import type { JsonValue } from "./protocol.js";

/**
 * Automation evaluation limits, each no looser than its dataset guest counterpart in `DEFAULT_LIMITS`.
 * Memory covers one request: one run's formulas, or one code step. The scope is host data, like `queryBytes`.
 */
export const AUTOMATION_LIMITS = Object.freeze({
  formulaMs: 100,
  codeMs: 1000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  sourceBytes: 64 * 1024,
  scopeBytes: 256 * 1024,
  resultBytes: 64 * 1024,
  formulasPerBatch: 64,
});

export type JsonObject = { [key: string]: JsonValue };

/**
 * What a formula or code step can read. `now` is the run's time on the computer that runs
 * the automation, as ISO 8601 with that computer's UTC offset, such as `2026-09-24T09:30:00.000+08:00`.
 */
export interface AutomationScope {
  record: JsonObject;
  previous?: JsonObject;
  trigger: { kind: string; [fact: string]: JsonValue };
  results?: JsonObject;
  person: { id: string; name: string } | null;
  now: string;
}

/** `expression` is JavaScript such as `record.Status == "Done"`. `text` holds expressions in braces, such as `Hi {record.Name}`. */
export interface AutomationFormula {
  kind: "expression" | "text";
  source: string;
}

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

export type AutomationWorkerRequest = { scope: AutomationScope } & (
  | { kind: "formulas"; formulas: AutomationFormula[] }
  | { kind: "code"; source: string }
);
export type AutomationWorkerReply =
  | { kind: "ready" }
  | { kind: "formulas"; results: AutomationOutcome<JsonValue>[] }
  | { kind: "code"; result: AutomationOutcome<CodeStepReturn> };
