import { parentPort } from "node:worker_threads";
import type { QuickJSWASMModule } from "quickjs-emscripten";
import { answerItems, evaluateItem, jsonDepth, newQuickJS } from "./automation-evaluate.js";
import { AUTOMATION_LIMITS, NOT_JSON, SCOPE_DEPTH, scopeTooDeep, scopeTooLarge } from "./automation-protocol.js";
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

let prepared: { runId: number; scopeJson: string; quickjs: QuickJSWASMModule } | undefined;
const reply = (message: AutomationWorkerReply) => {
  if (message.kind === "restart" || (message.kind === "result" && message.restart)) prepared = undefined;
  port.postMessage(message);
};
// Requests run one at a time: the next message waits until this one has replied for every item.
let requests = Promise.resolve();
// An unexpected failure asks for a new worker, so the request's remaining items still get results. It can only come
// before the request's last result, because nothing runs after that.
port.on("message", (request: AutomationWorkerRequest) => {
  requests = requests.then(() => answer(request)).catch(() => reply({ kind: "restart" }));
});

async function answer(request: AutomationWorkerRequest): Promise<void> {
  if (request.kind === "end") {
    if (prepared?.runId === request.runId) prepared = undefined;
    return;
  }
  const { scope, items, spent, runId } = request;
  if (scope !== undefined) {
    prepared = undefined;
    const taken = Object.keys(scope.bindings ?? {}).find(name => globals.has(name));
    if (taken !== undefined) {
      return reply({ kind: "refused", message: `The step result name ${JSON.stringify(taken)} belongs to a JavaScript built-in. Bind it with another name.` });
    }
    let scopeJson: string;
    try { scopeJson = JSON.stringify(scope); } catch { return reply({ kind: "refused", message: NOT_JSON }); }
    const scopeFailure = Buffer.byteLength(scopeJson) > AUTOMATION_LIMITS.scopeBytes ? scopeTooLarge()
      : jsonDepth(scopeJson) > SCOPE_DEPTH ? scopeTooDeep() : undefined;
    if (scopeFailure) return answerItems(items, spent, () => ({ result: scopeFailure, prepareMs: 0, runMs: 0 }), reply);
    // Only phases of this run share the instance. Each formula still gets a fresh runtime and context.
    let quickjs: QuickJSWASMModule;
    try { quickjs = await newQuickJS(); } catch { return reply({ kind: "restart" }); }
    prepared = { runId, scopeJson, quickjs };
  }
  if (prepared?.runId !== runId) return reply({ kind: "refused", message: "The automation run is no longer prepared." });
  const { quickjs, scopeJson } = prepared;
  answerItems(items, spent, item => evaluateItem(quickjs, scopeJson, item), reply);
}
reply({ kind: "ready" });
