import { parentPort } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { en } from "zod/locales";
import * as z from "zod/mini";
import { automationGuest } from "./automation-guest.js";
import type { GuestKind } from "./automation-guest.js";
import { AUTOMATION_LIMITS } from "./automation-protocol.js";
import type { AutomationError, AutomationOutcome, AutomationWorkerReply, AutomationWorkerRequest, CodeStepReturn } from "./automation-protocol.js";
import type { JsonValue } from "./protocol.js";

const GUEST_SOURCE = `(${automationGuest})`;
const KiB = 1024;

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

const failure = (code: AutomationError["code"], message: string) => ({ ok: false, error: { code, message } }) as const;
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

const subjectOf = (kind: GuestKind) => kind === "code" ? "The code" : "The formula";

/**
 * Evaluates one run's formulas, or its code step, in a fresh QuickJS runtime. The run's items share
 * one context, one memory limit, and the scope; each item gets its own time limit.
 */
function evaluate(quickjs: QuickJSWASMModule, scopeJson: string, items: Array<{ kind: GuestKind; source: string }>): AutomationOutcome<JsonValue>[] {
  if (Buffer.byteLength(scopeJson) > AUTOMATION_LIMITS.scopeBytes) {
    return items.map(() => failure("too_large", `The record and step results are larger than ${AUTOMATION_LIMITS.scopeBytes / KiB} KiB.`));
  }
  const runtime = quickjs.newRuntime();
  try {
    runtime.setMemoryLimit(AUTOMATION_LIMITS.memoryBytes);
    runtime.setMaxStackSize(AUTOMATION_LIMITS.stackBytes);
    runtime.removeModuleLoader();
    // Preparing the scope gets a formula's time limit; each item then gets its own.
    let limitMs: number = AUTOMATION_LIMITS.formulaMs;
    let deadline = performance.now() + limitMs;
    runtime.setInterruptHandler(() => performance.now() >= deadline);
    const vm = runtime.newContext();
    try {
      const guest = vm.evalCode(GUEST_SOURCE, "automation.js");
      if (guest.error) { guest.error.dispose(); throw new Error("The automation guest could not start."); }
      const scope = vm.newString(scopeJson);
      const prepared = vm.callFunction(guest.value, vm.undefined, scope);
      guest.value.dispose(); scope.dispose();
      if (prepared.error) {
        // No authored code has run yet, so only the scope's size or nesting can exhaust the limits.
        prepared.error.dispose();
        const error = performance.now() >= deadline
          ? failure("timeout", `Reading the record and step results took longer than ${limitMs} ms.`)
          : failure("too_large", "The record and step results are too large or too deeply nested to read.");
        return items.map(() => error);
      }
      try {
        return items.map(({ kind, source }) => {
          const subject = subjectOf(kind);
          if (typeof source !== "string" || Buffer.byteLength(source) > AUTOMATION_LIMITS.sourceBytes) {
            return failure("too_large", `${subject} is longer than ${AUTOMATION_LIMITS.sourceBytes / KiB} KiB.`);
          }
          limitMs = kind === "code" ? AUTOMATION_LIMITS.codeMs : AUTOMATION_LIMITS.formulaMs;
          deadline = performance.now() + limitMs;
          const args = [vm.newString(kind), vm.newString(source)];
          const result = vm.callFunction(prepared.value, vm.undefined, ...args);
          for (const handle of args) handle.dispose();
          if (result.error) {
            // Only an interrupt or exhausted memory escapes the guest's own error handling.
            result.error.dispose();
            return performance.now() >= deadline
              ? failure("timeout", `${subject} ran longer than ${limitMs} ms, so it stopped. Check it for a loop that never ends.`)
              : failure("memory", `${subject} used more memory than it is allowed, so it stopped.`);
          }
          try {
            const reply = vm.typeof(result.value) === "string" ? vm.getString(result.value) : "";
            if (Buffer.byteLength(reply) > AUTOMATION_LIMITS.resultBytes) {
              return failure("too_large", `${subject} produced more than ${AUTOMATION_LIMITS.resultBytes / KiB} KiB.`);
            }
            return outcome(reply) ?? failure("invalid_result", `${subject} produced a value that cannot be saved.`);
          } finally { result.value.dispose(); }
        });
      } finally { prepared.value.dispose(); }
    } finally { vm.dispose(); }
  } finally { runtime.dispose(); }
}

function codeStep(outcome: AutomationOutcome<JsonValue>): AutomationOutcome<CodeStepReturn> {
  if (!outcome.ok) return outcome;
  const parsed = codeStepReturn.safeParse(outcome.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problems = parsed.error.issues.map(issue => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  return failure("invalid_result", `The code returned something the automation cannot use. ${problems.join("; ")}`.slice(0, 1024));
}

function handle(quickjs: QuickJSWASMModule, request: AutomationWorkerRequest): AutomationWorkerReply {
  const scopeJson = JSON.stringify(request.scope);
  if (request.kind === "code") return { kind: "code", result: codeStep(evaluate(quickjs, scopeJson, [{ kind: "code", source: request.source }])[0]!) };
  return { kind: "formulas", results: evaluate(quickjs, scopeJson, request.formulas) };
}

const port = parentPort;
if (!port) throw new Error("The automation worker must run in a worker thread.");
const quickjs = await getQuickJS();
port.on("message", (request: AutomationWorkerRequest) => port.postMessage(handle(quickjs, request)));
port.postMessage({ kind: "ready" } satisfies AutomationWorkerReply);
