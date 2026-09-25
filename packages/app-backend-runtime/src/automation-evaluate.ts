import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { automationGuest } from "./automation-guest.js";
import { AUTOMATION_LIMITS, failure, itemLimitMs, notReached, subjectOf } from "./automation-protocol.js";
import type { AutomationError, AutomationOutcome, AutomationTimeSpent, AutomationWorkerItem, AutomationWorkerReply, CodeStepReturn } from "./automation-protocol.js";
import type { JsonValue } from "./protocol.js";

const GUEST_SOURCE = `(${automationGuest})`;
const KiB = 1024, MiB = KiB * KiB, WASM_PAGE = 64 * KiB;
/** The QuickJS build declares 16 MiB of initial memory, so a smaller memory cannot hold it. */
const INITIAL_MEMORY_BYTES = 16 * MiB;

// zod/mini keeps the worker small; English messages explain an invalid code step result.
z.config(en());
const nonEmpty = () => z.string().check(z.minLength(1));
const fieldValues = z.record(nonEmpty(), z.json());
const codeStepReturn: z.ZodMiniType<CodeStepReturn> = z.strictObject({
  set: z.optional(fieldValues),
  records: z.optional(z.array(z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("add"), collection: nonEmpty(), fields: fieldValues }),
    z.strictObject({ action: z.literal("change"), collection: nonEmpty(), id: nonEmpty(), fields: fieldValues }),
  ]))),
  output: z.optional(z.json()),
});

const codes = new Set<unknown>(["syntax", "runtime", "timeout", "memory", "too_large", "invalid_result"] satisfies AutomationError["code"][]);

/** Guest code can reach the guest's own built-ins, so the worker checks the reply's shape instead of trusting it. */
function outcome(reply: string): AutomationOutcome<JsonValue> | undefined {
  let parsed: { ok?: unknown; value?: JsonValue; error?: { code?: unknown; message?: unknown } };
  try { parsed = JSON.parse(reply); } catch { return undefined; }
  if (parsed?.ok === true && parsed.value !== undefined) return { ok: true, value: parsed.value };
  const { code, message } = parsed?.error ?? {};
  if (parsed?.ok === false && codes.has(code) && typeof message === "string") return failure(code as AutomationError["code"], message.slice(0, 1024));
  return undefined;
}

/** How deeply a JSON text nests lists and objects, read without parsing it. */
export function jsonDepth(json: string): number {
  let depth = 0, deepest = 0, quoted = false;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (quoted) {
      if (code === 0x5c) index++;
      else if (code === 0x22) quoted = false;
    } else if (code === 0x22) quoted = true;
    else if (code === 0x5b || code === 0x7b) deepest = Math.max(deepest, ++depth);
    else if (code === 0x5d || code === 0x7d) depth--;
  }
  return deepest;
}

function codeStep(outcome: AutomationOutcome<JsonValue>): AutomationOutcome<JsonValue> {
  if (!outcome.ok) return outcome;
  const parsed = codeStepReturn.safeParse(outcome.value);
  if (parsed.success) return { ok: true, value: parsed.data as JsonValue };
  const problems = parsed.error.issues.map(issue => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  return failure("invalid_result", `The code returned something the automation cannot use. ${problems.join("; ")}`.slice(0, 1024));
}

const sourceBytes = (item: AutomationWorkerItem) => item.kind === "text"
  ? item.parts.reduce((total, part) => total + Buffer.byteLength(part.kind === "text" ? part.text : part.expression), 0)
  : Buffer.byteLength(item.source);

let compiled: Promise<WebAssembly.Module> | undefined;
/**
 * A new QuickJS instance with its own capped WebAssembly memory, so it never reads memory another instance used.
 * QuickJS's own memory limit cannot measure allocations in this build, so the memory's cap is the bound.
 * The QuickJS code is compiled once.
 */
export async function newQuickJS(): Promise<QuickJSWASMModule> {
  compiled ??= (async () => {
    const wasmPath = createRequire(fileURLToPath(import.meta.resolve("quickjs-emscripten"))).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
    return WebAssembly.compile(await readFile(wasmPath));
  })();
  return newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, {
    wasmModule: await compiled,
    wasmMemory: new WebAssembly.Memory({ initial: INITIAL_MEMORY_BYTES / WASM_PAGE, maximum: AUTOMATION_LIMITS.memoryBytes / WASM_PAGE }),
  }));
}

export type Evaluated = { result: AutomationOutcome<JsonValue> } & AutomationTimeSpent;

/**
 * Evaluates one formula or code step in its own QuickJS runtime and context, as the dataset guest does for each
 * operation. Reading the scope has its own time limit; the item's limit starts once the scope is ready.
 * `clock` returns milliseconds. The result also says how long each part took.
 */
export function evaluateItem(quickjs: QuickJSWASMModule, scopeJson: string, item: AutomationWorkerItem, clock = () => performance.now()): Evaluated {
  const subject = subjectOf(item), limitMs = itemLimitMs(item);
  if (sourceBytes(item) > AUTOMATION_LIMITS.sourceBytes) {
    return { result: failure("too_large", `${subject} is longer than ${AUTOMATION_LIMITS.sourceBytes / KiB} KiB.`), prepareMs: 0, runMs: 0 };
  }
  const started = clock();
  let ready: number | undefined;
  const done = (result: AutomationOutcome<JsonValue>): Evaluated => {
    const ended = clock();
    return {
      result: item.kind === "code" ? codeStep(result) : result,
      prepareMs: (ready ?? ended) - started, runMs: ready === undefined ? 0 : ended - ready,
    };
  };
  const runtime = quickjs.newRuntime();
  try {
    runtime.setMaxStackSize(AUTOMATION_LIMITS.stackBytes);
    runtime.removeModuleLoader();
    let deadline = started + AUTOMATION_LIMITS.prepareMs;
    runtime.setInterruptHandler(() => clock() >= deadline);
    const vm = runtime.newContext();
    try {
      const guest = vm.evalCode(GUEST_SOURCE, "automation.js");
      let prepared = guest;
      if (!guest.error) {
        const args = [vm.newString(scopeJson), vm.newString(item.kind)];
        prepared = vm.callFunction(guest.value, vm.undefined, ...args);
        for (const handle of [guest.value, ...args]) handle.dispose();
      }
      // Native work, such as parsing a large scope, can finish past the limit without an interrupt.
      const prepareTimeout = clock() >= deadline
        ? failure("timeout", `Reading the record and step results took longer than ${AUTOMATION_LIMITS.prepareMs} ms.`) : undefined;
      if (prepared.error) {
        // No authored code has run yet, so only the scope's size can exhaust the limits.
        prepared.error.dispose();
        return done(prepareTimeout ?? failure("too_large", "The record and step results are too large to read."));
      }
      if (prepareTimeout || vm.typeof(prepared.value) !== "function") {
        try {
          return done(prepareTimeout ?? outcome(vm.typeof(prepared.value) === "string" ? vm.getString(prepared.value) : "")
            ?? failure("too_large", "The record and step results cannot be read."));
        } finally { prepared.value.dispose(); }
      }
      const timeout = () => failure("timeout", `${subject} ran longer than ${limitMs} ms, so it stopped. Check it for a loop that never ends.`);
      const source = item.kind === "text" ? JSON.stringify(item.parts) : item.source;
      const args = [vm.newString(source), vm.newNumber(AUTOMATION_LIMITS.resultBytes)];
      ready = clock();
      deadline = ready + limitMs;
      const result = vm.callFunction(prepared.value, vm.undefined, ...args);
      for (const handle of [prepared.value, ...args]) handle.dispose();
      if (result.error) {
        // Only an interrupt or exhausted memory escapes the guest's own error handling.
        result.error.dispose();
        return done(clock() >= deadline ? timeout() : failure("memory", `${subject} used more memory than it is allowed, so it stopped.`));
      }
      try {
        // Native work, such as converting a huge BigInt, can finish past the limit without an interrupt.
        if (clock() >= deadline) return done(timeout());
        const reply = vm.typeof(result.value) === "string" ? vm.getString(result.value) : "";
        if (Buffer.byteLength(reply) > AUTOMATION_LIMITS.resultBytes) {
          return done(failure("too_large", `${subject} produced more than ${AUTOMATION_LIMITS.resultBytes / KiB} KiB.`));
        }
        // The envelope adds one level. Deeper values cannot cross to the caller's thread.
        if (jsonDepth(reply) > AUTOMATION_LIMITS.resultDepth + 1) {
          return done(failure("invalid_result", `${subject} nested lists or objects more than ${AUTOMATION_LIMITS.resultDepth} levels deep.`));
        }
        return done(outcome(reply) ?? failure("invalid_result", `${subject} produced a value that cannot be saved.`));
      } finally { result.value.dispose(); }
    } finally { vm.dispose(); }
  } finally { runtime.dispose(); }
}

/**
 * Evaluates one request's items in order and replies after each. An item that starts after either of the request's
 * time budgets is spent does not run. When `evaluate` throws, the item fails, its result asks for a new worker, and
 * no later item runs here.
 */
export function answerItems(items: AutomationWorkerItem[], spent: AutomationTimeSpent, evaluate: (item: AutomationWorkerItem) => Evaluated,
  reply: (message: AutomationWorkerReply) => void): void {
  let { prepareMs, runMs } = spent;
  for (const item of items) {
    const skipped = notReached(item, { prepareMs, runMs });
    let evaluated: Evaluated;
    if (skipped) evaluated = { result: skipped, prepareMs: 0, runMs: 0 };
    else {
      const began = performance.now();
      try {
        evaluated = evaluate(item);
      } catch (error) {
        // An aborted QuickJS module cannot evaluate again. The restart travels on this item's own result, so it can
        // never reach the next request.
        return reply({
          kind: "result", restart: true, prepareMs: 0, runMs: performance.now() - began, result: error instanceof WebAssembly.RuntimeError
            ? failure("memory", `${subjectOf(item)} used more memory than it is allowed, so it stopped.`)
            : failure("runtime", `The evaluator failed while it ran ${subjectOf(item).toLowerCase()}.`),
        });
      }
    }
    prepareMs += evaluated.prepareMs;
    runMs += evaluated.runMs;
    reply({ kind: "result", ...evaluated });
  }
}
