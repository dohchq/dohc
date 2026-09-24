import { parentPort } from "node:worker_threads";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { evaluateItem, jsonDepth, newQuickJS } from "./automation-evaluate.js";
import type { Evaluated } from "./automation-evaluate.js";
import { AUTOMATION_LIMITS, failure, NOT_JSON, notReached, SCOPE_DEPTH, scopeTooDeep, scopeTooLarge, subjectOf } from "./automation-protocol.js";
import type { AutomationWorkerReply, AutomationWorkerRequest } from "./automation-protocol.js";

const port = parentPort;
if (!port) throw new Error("The automation worker must run in a worker thread.");

// A binding named after one of QuickJS's globals would hide a built-in, so the worker refuses it.
const globals = await (async () => {
  const quickjs = await newQuickJS();
  // A first evaluation compiles QuickJS's code paths, so a cold worker's first formula does not spend its time on that.
  evaluateItem(quickjs, JSON.stringify({ trigger: { kind: "button" }, person: null, now: "2026-01-01T00:00:00Z" }), { kind: "expression", source: "today()" });
  const vm = quickjs.newContext();
  try {
    const names = vm.unwrapResult(vm.evalCode("Object.getOwnPropertyNames(globalThis)"));
    try { return new Set(vm.dump(names) as string[]); } finally { names.dispose(); }
  } finally { vm.dispose(); }
})();

const reply = (message: AutomationWorkerReply) => port.postMessage(message);
// Requests run one at a time: the next message waits until this one has replied for every item.
let requests = Promise.resolve();
// An unexpected failure asks for a new worker, so the request's remaining items still get results.
port.on("message", (request: AutomationWorkerRequest) => {
  requests = requests.then(() => answer(request)).catch(() => reply({ kind: "restart" }));
});

async function answer({ scope, items, spent }: AutomationWorkerRequest): Promise<void> {
  const taken = Object.keys(scope.bindings ?? {}).find(name => globals.has(name));
  if (taken !== undefined) {
    return reply({ kind: "refused", message: `The step result name ${JSON.stringify(taken)} belongs to a JavaScript built-in. Bind it with another name.` });
  }
  let scopeJson: string;
  try { scopeJson = JSON.stringify(scope); } catch { return reply({ kind: "refused", message: NOT_JSON }); }
  const scopeFailure = Buffer.byteLength(scopeJson) > AUTOMATION_LIMITS.scopeBytes ? scopeTooLarge()
    : jsonDepth(scopeJson) > SCOPE_DEPTH ? scopeTooDeep() : undefined;
  // Each request gets its own QuickJS instance and memory, so no request reads memory another used.
  let quickjs: QuickJSWASMModule;
  try { quickjs = await newQuickJS(); } catch { return reply({ kind: "restart" }); }
  let { prepareMs, runMs } = spent;
  for (const item of items) {
    const skipped = scopeFailure ?? notReached(item, { prepareMs, runMs });
    let evaluated: Evaluated;
    if (skipped) evaluated = { result: skipped, prepareMs: 0, runMs: 0 };
    else {
      const began = performance.now();
      try {
        evaluated = evaluateItem(quickjs, scopeJson, item);
      } catch (error) {
        // An aborted QuickJS module cannot evaluate again. Report this item and ask for a new worker.
        reply({
          kind: "result", prepareMs: 0, runMs: performance.now() - began, result: error instanceof WebAssembly.RuntimeError
            ? failure("memory", `${subjectOf(item)} used more memory than it is allowed, so it stopped.`)
            : failure("runtime", `The evaluator failed while it ran ${subjectOf(item).toLowerCase()}.`),
        });
        return reply({ kind: "restart" });
      }
    }
    prepareMs += evaluated.prepareMs;
    runMs += evaluated.runMs;
    reply({ kind: "result", ...evaluated });
  }
}
reply({ kind: "ready" });
