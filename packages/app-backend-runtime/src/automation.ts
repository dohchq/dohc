import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { AUTOMATION_LIMITS, AUTOMATION_SCOPE_NAMES, failure, itemLimitMs, NOT_JSON, notReached, SCOPE_DEPTH, scopeTooDeep, scopeTooLarge, subjectOf } from "./automation-protocol.js";
import type { AutomationFormula, AutomationOutcome, AutomationScope, AutomationTextPart, AutomationTimeSpent, AutomationWorkerItem, AutomationWorkerReply, CodeStepReturn } from "./automation-protocol.js";
import type { JsonValue } from "./protocol.js";

export { AUTOMATION_LIMITS, AUTOMATION_SCOPE_NAMES } from "./automation-protocol.js";
export type { AutomationError, AutomationErrorCode, AutomationFormula, AutomationOutcome, AutomationRecordChange, AutomationScope, AutomationTextPart, CodeStepReturn, JsonObject } from "./automation-protocol.js";
export type { JsonValue } from "./protocol.js";

/** Time an item gets beyond its limits before its worker is replaced. */
const WATCHDOG_GRACE_MS = 2000;
/** An idle worker exits after this long, which returns its memory. */
const IDLE_MS = 30_000;
const KiB = 1024;

export interface AutomationEvaluatorOptions {
  /** The compiled worker. Electron hosts pass the staged file; Node resolves it from this package. */
  entryPath?: string;
  idleMs?: number;
}

/**
 * The scope and formulas must be plain JSON data: no bigints, functions, symbols, class instances, or cycles.
 * When the queue is full, every item returns `busy`; the caller runs the automation again later.
 */
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
 * The UTF-8 bytes JSON.stringify writes for a string, with its quotes. It stops counting past `limit`.
 * Quotes, backslashes, and control characters are escaped, and a lone surrogate is written as \uXXXX.
 */
function jsonStringBytes(text: string, limit: number): number {
  let bytes = text.length + 2;
  if (bytes > limit) return bytes;
  bytes = 2;
  for (let index = 0; index < text.length && bytes <= limit; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

const typeName = (value: unknown) => {
  if (typeof value !== "object" || value === null) return typeof value;
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : Object.prototype.toString.call(value).slice(8, -1);
};

/**
 * Measures the scope's JSON size in UTF-8 bytes and its nesting, and stops past either limit, so this thread
 * never walks or copies much more than the limits allow. The worker measures both again from the JSON text.
 * A value JSON cannot hold, such as a bigint, a date, or an instance of an Array subclass, is a problem for the
 * caller to fix.
 */
function measureScope(scope: AutomationScope): "fits" | "too_large" | "too_deep" | { problem: string } {
  const limit = AUTOMATION_LIMITS.scopeBytes;
  let size = 0;
  const pending: Array<[value: unknown, depth: number]> = [[scope, 1]];
  while (pending.length > 0) {
    const [value, depth] = pending.pop()!;
    if (typeof value === "string") size += jsonStringBytes(value, limit - size);
    else if (typeof value === "number") size += Number.isFinite(value) ? String(value).length : 4;
    else if (typeof value === "boolean") size += value ? 4 : 5;
    // JSON.stringify writes null, and `undefined` in a list, as null. It leaves out an undefined property.
    else if (value === null || value === undefined) size += 4;
    else if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
      if (depth > SCOPE_DEPTH) return "too_deep";
      size += Math.max(2, value.length + 1);
      for (let index = 0; index < value.length && size <= limit; index++) pending.push([value[index], depth + 1]);
    } else if (typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      if (depth > SCOPE_DEPTH) return "too_deep";
      let keys = 0;
      for (const key in value) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) continue;
        keys++;
        // The key, its colon, and the comma after its value.
        size += jsonStringBytes(key, limit - size) + 2;
        if (size > limit) break;
        pending.push([item, depth + 1]);
      }
      size += keys === 0 ? 2 : 1;
    } else return { problem: `${NOT_JSON} It holds a value of type ${typeName(value)}.` };
    if (size > limit) return "too_large";
  }
  return "fits";
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
    const thread = new Worker(entryPath, { resourceLimits: { maxOldGenerationSizeMb: 96 } });
    thread.unref();
    const settle = () => thread.off("message", onReady).off("error", onError).off("exit", onExit);
    const onReady = () => { settle(); resolve(thread); };
    const onError = (error: Error) => { settle(); reject(error); };
    const onExit = () => onError(new Error("The automation worker stopped before it was ready."));
    thread.on("message", onReady).on("error", onError).on("exit", onExit);
  });

  /**
   * Sends items to the worker and reports each result. It adds the time each item took to `spent`, and resolves
   * early when the worker is replaced.
   */
  async function dispatch(scope: AutomationScope, items: AutomationWorkerItem[], report: (offset: number, result: AutomationOutcome<JsonValue>) => void, spent: AutomationTimeSpent): Promise<void> {
    if (closed) throw new Error("The automation evaluator is closed.");
    clearTimeout(idle);
    const thread = worker ??= start();
    thread.catch(() => { if (worker === thread) worker = undefined; });
    const active = await thread;
    return new Promise((resolve, reject) => {
      let received = 0, itemStarted = performance.now();
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
      // Without the worker's own times, the item's whole wait counts as running time.
      const record = (result: AutomationOutcome<JsonValue>, times?: AutomationTimeSpent) => {
        spent.prepareMs += times?.prepareMs ?? 0;
        spent.runMs += times?.runMs ?? performance.now() - itemStarted;
        report(received++, result);
      };
      const accept = (result: AutomationOutcome<JsonValue>, times?: AutomationTimeSpent) => {
        record(result, times);
        if (received < items.length) arm();
        else { rest(); resolve(); }
      };
      // The item in flight fails. The caller sends the items after it to a new worker.
      const replace = (result: AutomationOutcome<JsonValue>) => {
        settle();
        void stop(thread);
        spent.runMs += performance.now() - itemStarted;
        report(received, result);
        resolve();
      };
      // Guest limits stop runaway JavaScript. This catches native work that never checks them.
      const arm = () => {
        clearTimeout(watchdog);
        itemStarted = performance.now();
        const item = items[received]!, limitMs = itemLimitMs(item);
        watchdog = setTimeout(() => replace(failure("timeout", `${subjectOf(item)} ran longer than ${limitMs} ms, so it stopped. Check it for a loop that never ends.`)),
          AUTOMATION_LIMITS.prepareMs + limitMs + WATCHDOG_GRACE_MS);
      };
      const onMessage = (reply: AutomationWorkerReply) => {
        if (reply.kind === "result" && !reply.restart) accept(reply.result, reply);
        else if (reply.kind === "result") {
          // The item broke the worker. The caller sends the items after it to a new worker.
          settle();
          void stop(thread);
          record(reply.result, reply);
          resolve();
        } else if (reply.kind === "restart") {
          settle();
          void stop(thread);
          // A worker that fails before it finishes any item would fail again, so its items fail instead.
          // The request then has no items left, so the time this took is not counted.
          if (received === 0) items.forEach((item, offset) => report(offset, failure("runtime", `The evaluator stopped before it ran ${subjectOf(item).toLowerCase()}.`)));
          resolve();
        }
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
      try { active.postMessage({ scope, items, spent: { ...spent } }); } catch (error) { rest(); reject(error); }
    });
  }

  /**
   * A full queue answers before the evaluator reads the scope or the formulas, so a request it turns away costs
   * nothing and gets `busy` even for input it would reject. It returns nothing when the request can wait.
   */
  function busy(count: number): AutomationOutcome<never>[] | undefined {
    if (closed) throw new Error("The automation evaluator is closed.");
    if (queued < AUTOMATION_LIMITS.queuedRequests) return undefined;
    return Array.from({ length: count }, () => failure("busy", `The evaluator already has ${AUTOMATION_LIMITS.queuedRequests} runs waiting. Try this run again later.`));
  }

  /** Called at once after `busy` returns nothing, so the queue cannot fill in between. */
  async function run(scope: AutomationScope, items: AutomationWorkerItem[]): Promise<AutomationOutcome<JsonValue>[]> {
    const problem = scopeProblem(scope);
    if (problem) throw new Error(problem);
    const guards = items.flatMap(item => "when" in item ? item.when ?? [] : []);
    const measured = measureScope(guards.length ? { ...scope, ...{ formulaGuards: guards } } : scope);
    if (typeof measured === "object") throw new Error(measured.problem);
    const results: Array<AutomationOutcome<JsonValue> | undefined> = measured === "too_large" ? items.map(scopeTooLarge)
      : measured === "too_deep" ? items.map(scopeTooDeep) : items.map(() => undefined);
    if (results.every(result => result !== undefined)) return results as AutomationOutcome<JsonValue>[];
    queued++;
    const done = queue.then(async () => {
      const spent: AutomationTimeSpent = { prepareMs: 0, runMs: 0 };
      for (;;) {
        const waiting: number[] = [];
        for (const [index, item] of items.entries()) {
          if (results[index] !== undefined) continue;
          const guards = "when" in item ? item.when ?? [] : [];
          // Dispatch the preceding formulas before deciding a dependent branch.
          if (guards.some(guard => results[guard.index] === undefined)) break;
          if (guards.some(guard => {
            const result = results[guard.index]!;
            return !result.ok || ("truthy" in guard ? Boolean(result.value) !== guard.truthy : !isDeepStrictEqual(result.value, guard.equals));
          })) {
            results[index] = { ok: true, value: null };
            continue;
          }
          // A skipped formula costs no source check, scope preparation, or runtime.
          const refused = tooLarge(item) ?? notReached(item, spent);
          if (refused) results[index] = refused;
          else waiting.push(index);
        }
        if (waiting.length === 0) return results as AutomationOutcome<JsonValue>[];
        const runnable = waiting.map(index => {
          const item = items[index]!;
          if (!("when" in item)) return item;
          const { when: _when, ...formula } = item;
          return formula;
        });
        await dispatch(scope, runnable, (offset, result) => { results[waiting[offset]!] = result; }, spent);
      }
    }).finally(() => { queued--; });
    queue = done.catch(() => undefined);
    return done;
  }

  return {
    async evaluate(scope, formulas) {
      const full = busy(formulas.length);
      if (full) return full;
      if (formulas.length > AUTOMATION_LIMITS.formulasPerBatch) throw new Error(`One run can evaluate at most ${AUTOMATION_LIMITS.formulasPerBatch} formulas.`);
      if (!formulas.every(isFormula)) throw new Error("A formula is not an expression or message text parts.");
      if (!formulas.every((formula, index) => formula.when === undefined || (Array.isArray(formula.when)
        && formula.when.length <= index && formula.when.every(guard => guard !== null && typeof guard === "object"
          && Number.isSafeInteger(guard.index) && guard.index >= 0 && guard.index < index
          && ("truthy" in guard ? typeof guard.truthy === "boolean" && !("equals" in guard) : "equals" in guard && guard.equals !== undefined))))) {
        throw new Error("A formula guard must refer to an earlier formula and require truthiness or a JSON value.");
      }
      return formulas.length === 0 ? [] : run(scope, [...formulas]);
    },
    async runCode(scope, source) {
      const full = busy(1);
      if (full) return full[0]!;
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
