import { parentPort } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { automationGuest } from "./automation-guest.js";
import { AUTOMATION_LIMITS, failure, itemLimitMs, subjectOf } from "./automation-protocol.js";
import type { AutomationError, AutomationOutcome, AutomationWorkerItem, AutomationWorkerReply, AutomationWorkerRequest, CodeStepReturn } from "./automation-protocol.js";
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
function jsonDepth(json: string): number {
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

/** This thread's CPU time. A busy computer slows evaluation without using up its limit. */
const cpuMs = () => {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
};

const sourceBytes = (item: AutomationWorkerItem) => item.kind === "text"
  ? item.parts.reduce((total, part) => total + Buffer.byteLength(part.kind === "text" ? part.text : part.expression), 0)
  : Buffer.byteLength(item.source);

/** Evaluates one formula or code step in its own QuickJS runtime and context, as the dataset guest does for each operation. */
function evaluate(quickjs: QuickJSWASMModule, scopeJson: string, item: AutomationWorkerItem): AutomationOutcome<JsonValue> {
  const subject = subjectOf(item), limitMs = itemLimitMs(item);
  if (sourceBytes(item) > AUTOMATION_LIMITS.sourceBytes) {
    return failure("too_large", `${subject} is longer than ${AUTOMATION_LIMITS.sourceBytes / KiB} KiB.`);
  }
  const runtime = quickjs.newRuntime();
  try {
    runtime.setMaxStackSize(AUTOMATION_LIMITS.stackBytes);
    runtime.removeModuleLoader();
    const deadline = cpuMs() + limitMs;
    runtime.setInterruptHandler(() => cpuMs() >= deadline);
    const timeout = () => failure("timeout", `${subject} ran longer than ${limitMs} ms, so it stopped. Check it for a loop that never ends.`);
    // Only an interrupt or exhausted memory escapes the guest's own error handling.
    const stopped = () => cpuMs() >= deadline ? timeout() : failure("memory", `${subject} used more memory than it is allowed, so it stopped.`);
    const vm = runtime.newContext();
    try {
      const guest = vm.evalCode(GUEST_SOURCE, "automation.js");
      if (guest.error) { guest.error.dispose(); return stopped(); }
      const source = item.kind === "text" ? JSON.stringify(item.parts) : item.source;
      const args = [vm.newString(scopeJson), vm.newString(item.kind), vm.newString(source), vm.newNumber(AUTOMATION_LIMITS.resultBytes)];
      const result = vm.callFunction(guest.value, vm.undefined, ...args);
      for (const handle of [guest.value, ...args]) handle.dispose();
      if (result.error) { result.error.dispose(); return stopped(); }
      try {
        // Native work, such as converting a huge BigInt, can finish past the limit without an interrupt.
        if (cpuMs() >= deadline) return timeout();
        const reply = vm.typeof(result.value) === "string" ? vm.getString(result.value) : "";
        if (Buffer.byteLength(reply) > AUTOMATION_LIMITS.resultBytes) {
          return failure("too_large", `${subject} produced more than ${AUTOMATION_LIMITS.resultBytes / KiB} KiB.`);
        }
        // The envelope adds one level. Deeper values cannot cross to the caller's thread.
        if (jsonDepth(reply) > AUTOMATION_LIMITS.resultDepth + 1) {
          return failure("invalid_result", `${subject} nested lists or objects more than ${AUTOMATION_LIMITS.resultDepth} levels deep.`);
        }
        return outcome(reply) ?? failure("invalid_result", `${subject} produced a value that cannot be saved.`);
      } finally { result.value.dispose(); }
    } finally { vm.dispose(); }
  } finally { runtime.dispose(); }
}

function codeStep(outcome: AutomationOutcome<JsonValue>): AutomationOutcome<JsonValue> {
  if (!outcome.ok) return outcome;
  const parsed = codeStepReturn.safeParse(outcome.value);
  if (parsed.success) return { ok: true, value: parsed.data as JsonValue };
  const problems = parsed.error.issues.map(issue => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  return failure("invalid_result", `The code returned something the automation cannot use. ${problems.join("; ")}`.slice(0, 1024));
}

const port = parentPort;
if (!port) throw new Error("The automation worker must run in a worker thread.");
// QuickJS's own memory limit cannot measure allocations in this build, so a capped memory bounds every run.
const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, {
  wasmMemory: new WebAssembly.Memory({ initial: INITIAL_MEMORY_BYTES / WASM_PAGE, maximum: AUTOMATION_LIMITS.memoryBytes / WASM_PAGE }),
}));
// A binding named after one of QuickJS's globals would hide a built-in, so the worker refuses it.
const globals = (() => {
  const vm = quickjs.newContext();
  try {
    const names = vm.unwrapResult(vm.evalCode("Object.getOwnPropertyNames(globalThis)"));
    try { return new Set(vm.dump(names) as string[]); } finally { names.dispose(); }
  } finally { vm.dispose(); }
})();

const reply = (message: AutomationWorkerReply) => port.postMessage(message);
port.on("message", ({ scope, items }: AutomationWorkerRequest) => {
  const taken = Object.keys(scope.bindings ?? {}).find(name => globals.has(name));
  if (taken !== undefined) {
    return reply({ kind: "refused", message: `The step result name ${JSON.stringify(taken)} belongs to a JavaScript built-in. Bind it with another name.` });
  }
  const scopeJson = JSON.stringify(scope);
  const scopeTooLarge = Buffer.byteLength(scopeJson) > AUTOMATION_LIMITS.scopeBytes;
  for (const item of items) {
    let result: AutomationOutcome<JsonValue>;
    try {
      result = scopeTooLarge
        ? failure("too_large", `The record and step results are larger than ${AUTOMATION_LIMITS.scopeBytes / KiB} KiB.`)
        : evaluate(quickjs, scopeJson, item);
      if (item.kind === "code") result = codeStep(result);
    } catch (error) {
      // An aborted QuickJS module cannot evaluate again. Report this item and ask for a new worker.
      reply({ kind: "result", result: error instanceof WebAssembly.RuntimeError
        ? failure("memory", `${subjectOf(item)} used more memory than it is allowed, so it stopped.`)
        : failure("runtime", `The evaluator failed while it ran ${subjectOf(item).toLowerCase()}.`) });
      return reply({ kind: "restart" });
    }
    reply({ kind: "result", result });
  }
});
reply({ kind: "ready" });
