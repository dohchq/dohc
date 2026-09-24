import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { AUTOMATION_LIMITS, AUTOMATION_SCOPE_NAMES, failure, itemLimitMs, subjectOf } from "./automation-protocol.js";
import type { AutomationFormula, AutomationOutcome, AutomationScope, AutomationTextPart, AutomationWorkerItem, AutomationWorkerReply, CodeStepReturn } from "./automation-protocol.js";
import type { JsonValue } from "./protocol.js";

export { AUTOMATION_LIMITS, AUTOMATION_SCOPE_NAMES } from "./automation-protocol.js";
export type { AutomationError, AutomationErrorCode, AutomationFormula, AutomationOutcome, AutomationRecordChange, AutomationScope, AutomationTextPart, CodeStepReturn, JsonObject } from "./automation-protocol.js";
export type { JsonValue } from "./protocol.js";

/** Time an item gets beyond its limit before its worker is replaced. */
const WATCHDOG_GRACE_MS = 2000;
/** An idle worker exits after this long, which returns its memory. */
const IDLE_MS = 30_000;
/** Requests waiting or running. When the queue is full, a new request fails at once instead of waiting. */
const QUEUE_LIMIT = 16;
const KiB = 1024;

export interface AutomationEvaluatorOptions {
  /** The compiled worker. Electron hosts pass the staged file; Node resolves it from this package. */
  entryPath?: string;
  idleMs?: number;
}

/** The scope and formulas must be plain JSON data: no functions, class instances, dates, maps, or cycles. */
export interface AutomationEvaluator {
  /** Evaluates one run's formulas in one request. Each result is a JSON value or an error. */
  evaluate(scope: AutomationScope, formulas: readonly AutomationFormula[]): Promise<AutomationOutcome<JsonValue>[]>;
  /** Runs a code step's function body with a frozen `ctx`. The result says what to change; nothing is written. */
  runCode(scope: AutomationScope, source: string): Promise<AutomationOutcome<CodeStepReturn>>;
  close(): Promise<void>;
}

/** The guest's date helpers read `now` as a real ISO 8601 time with a UTC offset. */
function isInstant(value: unknown): boolean {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value) : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match.slice(1).map(part => Number(part ?? 0));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCMonth() === month! - 1 && date.getUTCDate() === day && hour! < 24 && minute! < 60 && second! < 60 &&
    offsetMinutes! < 60 && offsetHours! * 60 + offsetMinutes! <= 14 * 60;
}

/** A binding is read as a name of its own. The worker also refuses names that QuickJS's globals use. */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function scopeProblem(scope: AutomationScope): string | undefined {
  if (!isInstant(scope.now)) return "The automation scope needs `now` with a UTC offset.";
  const taken = Object.keys(scope.bindings ?? {}).find(name => !BINDING_NAME.test(name) || AUTOMATION_SCOPE_NAMES.includes(name));
  return taken === undefined ? undefined : `The automation scope cannot bind the name ${JSON.stringify(taken)}.`;
}

const isTextPart = (part: AutomationTextPart) =>
  (part.kind === "text" && typeof part.text === "string") || (part.kind === "expression" && typeof part.expression === "string");
const isFormula = (formula: AutomationFormula) => formula.kind === "expression" ? typeof formula.source === "string"
  : formula.kind === "text" && Array.isArray(formula.parts) && formula.parts.every(isTextPart);

/**
 * Counts a lower bound of the scope's JSON size and stops past the limit, so this thread never
 * walks or copies much more than the limit allows. The worker measures the exact size.
 */
function scopeTooLarge(scope: AutomationScope): boolean {
  let size = 0;
  const pending: unknown[] = [scope];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") size += value.length + 2;
    else if (Array.isArray(value)) {
      size += 2;
      for (let index = 0; index < value.length && size <= AUTOMATION_LIMITS.scopeBytes; index++) { size += 1; pending.push(value[index]); }
    } else if (value !== null && typeof value === "object") {
      size += 2;
      for (const key in value) {
        size += key.length + 4;
        if (size > AUTOMATION_LIMITS.scopeBytes) break;
        pending.push((value as Record<string, unknown>)[key]);
      }
    } else size += 1;
    if (size > AUTOMATION_LIMITS.scopeBytes) return true;
  }
  return false;
}

/** Refuses an item that is too large before it is copied. String lengths are lower bounds of UTF-8 sizes. */
function tooLarge(item: AutomationWorkerItem): AutomationOutcome<JsonValue> | undefined {
  let length: number;
  if (item.kind === "text") {
    if (item.parts.length > AUTOMATION_LIMITS.textParts) return failure("too_large", `The message has more than ${AUTOMATION_LIMITS.textParts} parts.`);
    length = 0;
    for (const part of item.parts) length += (part.kind === "text" ? part.text : part.expression).length;
  } else length = item.source.length;
  return length > AUTOMATION_LIMITS.sourceBytes ? failure("too_large", `${subjectOf(item)} is longer than ${AUTOMATION_LIMITS.sourceBytes / KiB} KiB.`) : undefined;
}

/**
 * Evaluates formulas and code steps in a worker thread, off the caller's thread. Requests run one at a time,
 * and each formula runs in its own QuickJS context. A runaway formula returns a timeout error and the worker
 * keeps serving. If the worker stops answering, a new worker evaluates the formulas it did not reach.
 */
export function createAutomationEvaluator(options: AutomationEvaluatorOptions = {}): AutomationEvaluator {
  const entryPath = options.entryPath ?? fileURLToPath(import.meta.resolve("@dohc/app-backend-runtime/automation-worker"));
  const idleMs = options.idleMs ?? IDLE_MS;
  let worker: Promise<Worker> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let closed = false;

  const stop = async (thread: Promise<Worker>) => {
    if (worker === thread) worker = undefined;
    await thread.then(active => active.terminate(), () => undefined);
  };

  const start = () => new Promise<Worker>((resolve, reject) => {
    const thread = new Worker(entryPath, { resourceLimits: { maxOldGenerationSizeMb: 32 } });
    thread.unref();
    const settle = () => thread.off("message", onReady).off("error", onError).off("exit", onExit);
    const onReady = () => { settle(); resolve(thread); };
    const onError = (error: Error) => { settle(); reject(error); };
    const onExit = () => onError(new Error("The automation worker stopped before it was ready."));
    thread.on("message", onReady).on("error", onError).on("exit", onExit);
  });

  /** Sends items to the worker and reports each result. It resolves early when the worker is replaced. */
  async function dispatch(scope: AutomationScope, items: AutomationWorkerItem[], report: (offset: number, result: AutomationOutcome<JsonValue>) => void, budget: { deadline?: number }): Promise<void> {
    if (closed) throw new Error("The automation evaluator is closed.");
    clearTimeout(idle);
    const thread = worker ??= start();
    thread.catch(() => { if (worker === thread) worker = undefined; });
    const active = await thread;
    const deadline = budget.deadline ??= performance.now() + AUTOMATION_LIMITS.requestMs;
    return new Promise((resolve, reject) => {
      let received = 0;
      let watchdog: NodeJS.Timeout | undefined;
      const settle = () => {
        clearTimeout(watchdog);
        active.off("message", onMessage).off("messageerror", onMessageError).off("error", onFailure).off("exit", onFailure);
      };
      const rest = () => {
        settle();
        idle = setTimeout(() => void stop(thread), idleMs);
        idle.unref();
      };
      const accept = (result: AutomationOutcome<JsonValue>) => {
        report(received++, result);
        if (received < items.length) arm();
        else { rest(); resolve(); }
      };
      // The item in flight fails. The caller sends the items after it to a new worker.
      const replace = (result: AutomationOutcome<JsonValue>) => {
        settle();
        void stop(thread);
        report(received, result);
        resolve();
      };
      // Guest limits stop runaway JavaScript. This catches native work that never checks them.
      const arm = () => {
        clearTimeout(watchdog);
        const item = items[received]!, limitMs = itemLimitMs(item);
        watchdog = setTimeout(() => replace(performance.now() >= deadline
          ? failure("timeout", `${subjectOf(item)} stopped because the run took longer than ${AUTOMATION_LIMITS.requestMs / 1000} s.`)
          : failure("timeout", `${subjectOf(item)} ran longer than ${limitMs} ms, so it stopped. Check it for a loop that never ends.`)),
        Math.max(0, Math.min(limitMs + WATCHDOG_GRACE_MS, deadline - performance.now())));
      };
      const onMessage = (reply: AutomationWorkerReply) => {
        if (reply.kind === "result") accept(reply.result);
        else if (reply.kind === "restart") { settle(); void stop(thread); resolve(); }
        else if (reply.kind === "refused") { rest(); reject(new Error(reply.message)); }
      };
      // A reply this thread cannot read fails its item. The worker goes on with the next one.
      const onMessageError = () => accept(failure("invalid_result", `${subjectOf(items[received]!)} produced a value that cannot be read.`));
      const onFailure = () => {
        if (!closed) return replace(failure("runtime", `The evaluator stopped while it ran ${subjectOf(items[received]!).toLowerCase()}.`));
        settle();
        reject(new Error("The automation evaluator is closed."));
      };
      active.on("message", onMessage).on("messageerror", onMessageError).on("error", onFailure).on("exit", onFailure);
      arm();
      try { active.postMessage({ scope, items }); } catch (error) { rest(); reject(error); }
    });
  }

  async function run(scope: AutomationScope, items: AutomationWorkerItem[]): Promise<AutomationOutcome<JsonValue>[]> {
    if (closed) throw new Error("The automation evaluator is closed.");
    const problem = scopeProblem(scope);
    if (problem) throw new Error(problem);
    const results = scopeTooLarge(scope)
      ? items.map(() => failure("too_large", `The record and step results are larger than ${AUTOMATION_LIMITS.scopeBytes / KiB} KiB.`))
      : items.map(tooLarge);
    if (results.every(result => result !== undefined)) return results as AutomationOutcome<JsonValue>[];
    if (queued >= QUEUE_LIMIT) throw new Error(`The automation evaluator already has ${QUEUE_LIMIT} runs waiting. Try again.`);
    queued++;
    const done = queue.then(async () => {
      const budget: { deadline?: number } = {};
      for (;;) {
        const waiting = results.flatMap((result, index) => result ? [] : [index]);
        if (waiting.length === 0) return results as AutomationOutcome<JsonValue>[];
        if (budget.deadline !== undefined && performance.now() >= budget.deadline) {
          for (const index of waiting) {
            results[index] = failure("timeout", `${subjectOf(items[index]!)} did not run because the run took longer than ${AUTOMATION_LIMITS.requestMs / 1000} s.`);
          }
          continue;
        }
        await dispatch(scope, waiting.map(index => items[index]!), (offset, result) => { results[waiting[offset]!] = result; }, budget);
      }
    }).finally(() => { queued--; });
    queue = done.catch(() => undefined);
    return done;
  }

  return {
    async evaluate(scope, formulas) {
      if (formulas.length > AUTOMATION_LIMITS.formulasPerBatch) throw new Error(`One run can evaluate at most ${AUTOMATION_LIMITS.formulasPerBatch} formulas.`);
      if (!formulas.every(isFormula)) throw new Error("A formula is not an expression or message text parts.");
      return formulas.length === 0 ? [] : run(scope, [...formulas]);
    },
    async runCode(scope, source) {
      if (typeof source !== "string") throw new Error("A code step's source must be text.");
      const [result] = await run(scope, [{ kind: "code", source }]);
      // The worker checked the shape of a successful result.
      return result as AutomationOutcome<CodeStepReturn>;
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      if (worker) await stop(worker);
    },
  };
}
