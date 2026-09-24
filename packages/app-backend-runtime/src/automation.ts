import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { AUTOMATION_LIMITS } from "./automation-protocol.js";
import type { AutomationFormula, AutomationOutcome, AutomationScope, AutomationWorkerReply, AutomationWorkerRequest, CodeStepReturn } from "./automation-protocol.js";
import type { JsonValue } from "./protocol.js";

export { AUTOMATION_LIMITS } from "./automation-protocol.js";
export type { AutomationError, AutomationErrorCode, AutomationFormula, AutomationOutcome, AutomationRecordChange, AutomationScope, CodeStepReturn, JsonObject } from "./automation-protocol.js";
export type { JsonValue } from "./protocol.js";

/** Time a request gets beyond its evaluation limits before its worker is replaced. */
const WATCHDOG_GRACE_MS = 2000;
/** An idle worker exits after this long, which returns its QuickJS memory. */
const IDLE_MS = 30_000;

export interface AutomationEvaluatorOptions {
  /** The compiled worker. Electron hosts pass the staged file; Node resolves it from this package. */
  entryPath?: string;
  idleMs?: number;
}

export interface AutomationEvaluator {
  /** Evaluates one run's formulas in one round trip. Each result is a JSON value or an error. */
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

/**
 * Evaluates formulas and code steps in a worker thread, off the caller's thread.
 * Requests run one at a time. A runaway evaluation returns a timeout error and the worker keeps serving;
 * if the worker stops answering, it is replaced.
 */
export function createAutomationEvaluator(options: AutomationEvaluatorOptions = {}): AutomationEvaluator {
  const entryPath = options.entryPath ?? fileURLToPath(import.meta.resolve("@dohc/app-backend-runtime/automation-worker"));
  const idleMs = options.idleMs ?? IDLE_MS;
  let worker: Promise<Worker> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let queue: Promise<unknown> = Promise.resolve();
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

  async function send(request: AutomationWorkerRequest, limitMs: number): Promise<AutomationWorkerReply> {
    if (closed) throw new Error("The automation evaluator is closed.");
    clearTimeout(idle);
    const thread = worker ??= start();
    thread.catch(() => { if (worker === thread) worker = undefined; });
    const active = await thread;
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(watchdog);
        active.off("message", onMessage).off("error", onError).off("exit", onExit);
      };
      const onMessage = (reply: AutomationWorkerReply) => {
        settle();
        idle = setTimeout(() => void stop(thread), idleMs);
        idle.unref();
        resolve(reply);
      };
      const onError = (error: Error) => { settle(); void stop(thread); reject(error); };
      const onExit = () => onError(new Error("The automation worker stopped."));
      // Guest limits stop runaway JavaScript. This catches work that never checks them, such as a huge BigInt.
      const watchdog = setTimeout(() => {
        settle();
        void stop(thread);
        const error = { code: "timeout", message: `The automation took longer than ${limitMs} ms, so it stopped.` } as const;
        resolve(request.kind === "code" ? { kind: "code", result: { ok: false, error } }
          : { kind: "formulas", results: request.formulas.map(() => ({ ok: false, error })) });
      }, limitMs + WATCHDOG_GRACE_MS);
      active.on("message", onMessage).on("error", onError).on("exit", onExit);
      try { active.postMessage(request); } catch (error) { settle(); reject(error); }
    });
  }

  function enqueue(request: AutomationWorkerRequest, limitMs: number): Promise<AutomationWorkerReply> {
    if (closed) return Promise.reject(new Error("The automation evaluator is closed."));
    if (!isInstant(request.scope.now)) return Promise.reject(new Error("The automation scope needs `now` with a UTC offset."));
    const reply = queue.then(() => send(request, limitMs));
    queue = reply.catch(() => undefined);
    return reply;
  }

  return {
    async evaluate(scope, formulas) {
      if (formulas.length > AUTOMATION_LIMITS.formulasPerBatch) throw new Error(`One run can evaluate at most ${AUTOMATION_LIMITS.formulasPerBatch} formulas.`);
      if (formulas.some(formula => formula.kind !== "expression" && formula.kind !== "text")) throw new Error("Unknown formula kind.");
      if (formulas.length === 0) return [];
      const reply = await enqueue({ kind: "formulas", scope, formulas: [...formulas] }, (formulas.length + 1) * AUTOMATION_LIMITS.formulaMs);
      return (reply as Extract<AutomationWorkerReply, { kind: "formulas" }>).results;
    },
    async runCode(scope, source) {
      const reply = await enqueue({ kind: "code", scope, source }, AUTOMATION_LIMITS.formulaMs + AUTOMATION_LIMITS.codeMs);
      return (reply as Extract<AutomationWorkerReply, { kind: "code" }>).result;
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      if (worker) await stop(worker);
    },
  };
}
