import { WebContentsView, session, type WebContents } from "electron";
import type { AppBrokerLocalRejectionReason, AppBrokerObservation } from "@dohc/app-browser/broker";
import type {
  AppFrontendBackendExpectation,
  AppFrontendBrokerCall,
  AppFrontendDiagnostic,
  AppFrontendStep,
  AppFrontendStepResult,
} from "@dohc/cli/app-publication";
import { appViewNavigationAllowed, hardenAppSession } from "./appViews";

export interface BackendFailureHint {
  reasonCode: NonNullable<AppFrontendBrokerCall["reasonCode"]>;
  diagnosticCode: AppFrontendDiagnostic["code"];
  detail?: string;
  remedy: string;
}

export interface AppFrontendBrowserSession {
  url: string;
  stop(): Promise<void>;
}

export interface AppFrontendBrowserVerifyInput {
  startSession: () => Promise<AppFrontendBrowserSession>;
  expectStartupBackend?: readonly AppFrontendBackendExpectation[];
  steps?: readonly AppFrontendStep[];
  timeoutMs: number;
  signal: AbortSignal;
  consumeBackendHint: (op: string, operation?: string) => BackendFailureHint | undefined;
  scrub: (value: string) => string;
}

export interface AppFrontendBrowserVerifyOutput {
  ok: boolean;
  stage: "runtime" | "steps" | "complete";
  startupOk: boolean;
  stepsOk: boolean;
  handshake: { delivered: boolean; messageCount: number };
  brokerCalls: AppFrontendBrokerCall[];
  steps: AppFrontendStepResult[];
  diagnostics: AppFrontendDiagnostic[];
  externalRequestsBlocked: number;
}

class DeadlineExceededError extends Error {}

const VERIFY_PARTITION = "dohc-app-verify";
const IDLE_SETTLE_MS = 150;
const MAX_ITEMS = 64;
const BLOCK_WEBRTC_SCRIPT = `(() => {
  for (const name of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
    "RTCDataChannel",
    "RTCSessionDescription",
    "RTCIceCandidate",
    "RTCIceTransport",
    "RTCSctpTransport",
  ]) {
    if (name in globalThis) {
      try {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      } catch {}
    }
  }
})();`;
const ALLOWED_PATHS = new Set([
  "/bootstrap",
  "/session",
  "/resume",
  "/backend",
  "/events",
  "/status",
  "/close",
]);

const LOCAL_REMEDY: Record<AppBrokerLocalRejectionReason, string> = {
  invalid_id:
    "Include a non-empty alphanumeric request id (up to 64 chars) on every broker message.",
  duplicate_id: "Use a unique request id per in-flight message on the dohc-app-channel port.",
  unserializable: "Send plain JSON-serializable objects over the dohc-app-channel port.",
  payload_too_large: "Reduce the payload size sent over the dohc-app-channel port.",
  invalid_keys:
    "Match the exact broker message keys (for backend.invoke: id, op, operation, idempotencyKey, input, optional dataset/readOnly).",
  rate_limited:
    "Reduce concurrent or rapid broker calls so requests stay within the broker rate limit.",
};

const STEP_REMEDY = {
  step_text_mismatch: "Update the UI so the target element renders the expected text.",
  step_not_fillable: "Target an enabled input, textarea, or select element.",
  step_not_clickable: "Target an enabled clickable element in the rendered DOM.",
  step_selector_not_found: "Ensure the selector matches an element in the rendered DOM.",
  expected_backend_missing: "Trigger the expected broker request on click and handle its response.",
  verification_timeout: "Fix slow or stalled app startup/requests, or raise timeoutMs.",
} as const;

let queue: Promise<void> = Promise.resolve();
let sessionConfigured = false;
let activeRun: {
  origin: string;
  webContentsId: number;
  view: WebContentsView;
  onExternalBlocked(): void;
} | null = null;

function allowRequestUrl(raw: string, resourceType: string, origin: string): boolean {
  if (resourceType === "subFrame") return raw === "about:srcdoc" || raw === "about:blank";
  if (
    raw === "about:blank" ||
    raw === "about:srcdoc" ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:")
  )
    return true;
  try {
    const parsed = new URL(raw);
    return (
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      ALLOWED_PATHS.has(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function ensureVerifySession(): Electron.Session {
  const isolated = session.fromPartition(VERIFY_PARTITION);
  if (sessionConfigured) return isolated;
  sessionConfigured = true;
  hardenAppSession(isolated);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const run = activeRun;
    if (
      !run ||
      (details.webContentsId !== undefined && details.webContentsId !== run.webContentsId)
    )
      return callback({ cancel: true });
    if (allowRequestUrl(details.url, details.resourceType, run.origin)) return callback({});
    run.onExternalBlocked();
    callback({ cancel: true });
  });
  return isolated;
}

const matchesExpectation = (call: AppFrontendBrokerCall, exp: AppFrontendBackendExpectation) =>
  (exp.op === undefined || call.op === exp.op) &&
  (exp.operation === undefined || call.operation === exp.operation) &&
  (exp.status === undefined || call.status === exp.status) &&
  (exp.refusalCode === undefined || call.refusalCode === exp.refusalCode);

const describeExpectation = (exp: AppFrontendBackendExpectation) =>
  [
    exp.op,
    exp.operation,
    exp.status !== undefined ? `HTTP ${exp.status}` : undefined,
    exp.refusalCode,
  ]
    .filter(Boolean)
    .join(" ") || "backend call";

export function unmatchedExpectations(
  calls: readonly AppFrontendBrokerCall[],
  expected: readonly AppFrontendBackendExpectation[],
): AppFrontendBackendExpectation[] {
  const matchCall = new Array<number>(calls.length).fill(-1);
  const matchedExp = new Array<boolean>(expected.length).fill(false);
  const augment = (ei: number, seen: Uint8Array): boolean => {
    for (let ci = 0; ci < calls.length; ci++) {
      if (seen[ci] || !matchesExpectation(calls[ci]!, expected[ei]!)) continue;
      seen[ci] = 1;
      if (matchCall[ci] === -1 || augment(matchCall[ci]!, seen)) {
        matchCall[ci] = ei;
        return true;
      }
    }
    return false;
  };
  for (let ei = 0; ei < expected.length; ei++) {
    matchedExp[ei] = augment(ei, new Uint8Array(calls.length));
  }
  return expected.filter((_, ei) => !matchedExp[ei]);
}

const stepExpression = (step: AppFrontendStep): string => {
  const sel = JSON.stringify(step.selector);
  if (step.kind === "waitFor") {
    const textCheck =
      step.textIncludes !== undefined
        ? `if(!(el.textContent||"").includes(${JSON.stringify(step.textIncludes)}))return "text";`
        : "";
    return `(()=>{try{const el=document.querySelector(${sel});if(!el)return "missing";${textCheck}return "ok";}catch{return "invalid";}})()`;
  }
  if (step.kind === "click") {
    return `(()=>{try{const el=document.querySelector(${sel});if(!el)return "missing";if(el instanceof HTMLElement){if(("disabled" in el&&Boolean(el.disabled))||el.matches(":disabled")||el.getAttribute("aria-disabled")==="true")return "disabled";el.focus();el.click();return "ok";}return "not_clickable";}catch{return "invalid";}})()`;
  }
  return `(()=>{try{const el=document.querySelector(${sel});if(!el)return "missing";const val=${JSON.stringify(step.value)};const fire=(t)=>{t.focus();t.dispatchEvent(new Event("input",{bubbles:true}));t.dispatchEvent(new Event("change",{bubbles:true}));};if(el instanceof HTMLInputElement){if(el.disabled)return "disabled";const k=el.type==="checkbox"||el.type==="radio"?"checked":"value";const next=k==="checked"?val==="true"||val==="1":val;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,k)?.set?.call(el,next);if(k==="value"&&el.value!==val)return "not_fillable";fire(el);return "ok";}if(el instanceof HTMLTextAreaElement){if(el.disabled)return "disabled";Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set?.call(el,val);fire(el);return "ok";}if(el instanceof HTMLSelectElement){if(el.disabled)return "disabled";Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")?.set?.call(el,val);if(el.value!==val)return "not_fillable";fire(el);return "ok";}return "not_fillable";}catch{return "invalid";}})()`;
};

export function runAppFrontendBrowserVerification(
  input: AppFrontendBrowserVerifyInput,
): Promise<AppFrontendBrowserVerifyOutput> {
  const run = queue.catch(() => {}).then(() => executeVerification(input));
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function executeVerification(
  input: AppFrontendBrowserVerifyInput,
): Promise<AppFrontendBrowserVerifyOutput> {
  input.signal.throwIfAborted();
  const isolated = ensureVerifySession();
  const clearSession = async (bestEffort: boolean) => {
    const step = (work: Promise<unknown>) => (bestEffort ? work.catch(() => {}) : work);
    await step(isolated.closeAllConnections());
    await step(isolated.clearStorageData());
    await step(isolated.clearCache());
  };
  await clearSession(false);
  input.signal.throwIfAborted();

  let launchedSession: AppFrontendBrowserSession | undefined;
  try {
    launchedSession = await input.startSession();
    input.signal.throwIfAborted();
  } catch (error) {
    await launchedSession?.stop().catch(() => {});
    throw error;
  }

  const launchUrl = new URL(launchedSession.url);
  const origin = launchUrl.origin;
  await isolated.setProxy({
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:1",
    proxyBypassRules: `<-loopback>,${launchUrl.host}`,
  });
  input.signal.throwIfAborted();
  const deadlineAt = Date.now() + input.timeoutMs;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  const handshake = { delivered: false, messageCount: 0 };
  const recordedCalls: Array<{ startSeq: number; call: AppFrontendBrokerCall }> = [];
  const startedSeqById = new Map<string, number>();
  let callSeq = 0;
  const diagnostics: AppFrontendDiagnostic[] = [];
  const stepResults: AppFrontendStepResult[] = [];
  const iframeSessions = new Set<string>();
  const mainContextIds = new Set<number>();
  const cspSeen = new Set<string>();
  const waiters = new Set<() => void>();
  let mainFrameId: string | undefined;
  let externalRequestsBlocked = 0;
  let inFlight = 0;
  let lastBrokerChangeAt = Date.now();
  let closingView = false;
  let startupFinished = false;

  const notify = () => {
    for (const wake of waiters) wake();
  };
  const clean = (raw: string | undefined) => {
    const text = raw ? input.scrub(raw) : "";
    return text.length ? text : undefined;
  };
  const pushCall = (startSeq: number, call: AppFrontendBrokerCall) => {
    if (recordedCalls.length < MAX_ITEMS) recordedCalls.push({ startSeq, call });
  };
  const pushDiag = (diag: AppFrontendDiagnostic) => {
    if (diagnostics.length < MAX_ITEMS) diagnostics.push(diag);
    notify();
  };
  const errorCount = () => diagnostics.filter((item) => item.severity === "error").length;
  const buildOutput = (
    ok: boolean,
    stage: AppFrontendBrowserVerifyOutput["stage"],
    startupOk: boolean,
    stepsOk: boolean,
  ): AppFrontendBrowserVerifyOutput => ({
    ok,
    stage,
    startupOk,
    stepsOk,
    handshake,
    brokerCalls: recordedCalls.slice(0, MAX_ITEMS).map((entry) => entry.call),
    steps: stepResults,
    diagnostics,
    externalRequestsBlocked,
  });

  const view = new WebContentsView({
    webPreferences: {
      partition: VERIFY_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
    },
  });
  const wc: WebContents = view.webContents;
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  const closeViewNow = () => {
    if (closingView || wc.isDestroyed()) return;
    closingView = true;
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch {}
    try {
      wc.close({ waitForBeforeUnload: false });
    } catch {}
  };

  const raceDeadline = async <T>(promise: Promise<T>): Promise<T> => {
    input.signal.throwIfAborted();
    const left = remainingMs();
    if (left <= 0) {
      closeViewNow();
      throw new DeadlineExceededError();
    }
    promise.catch(() => {});
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        closeViewNow();
        reject(input.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        cleanup();
        closeViewNow();
        reject(new DeadlineExceededError());
      }, left);
      input.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  };

  activeRun = {
    origin,
    webContentsId: wc.id,
    view,
    onExternalBlocked() {
      if (++externalRequestsBlocked === 1) {
        pushDiag({
          code: "external_network_blocked",
          severity: "warning",
          detail: "Blocked an external network request during offline verification.",
          remedy: "Handle offline network failures or bundle required assets with the app.",
        });
      }
    },
  };

  const cdpRaw = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    if (wc.isDestroyed() || !wc.debugger.isAttached())
      return Promise.reject(new Error("Verifier debugger is closed."));
    return sessionId
      ? wc.debugger.sendCommand(method, params, sessionId)
      : wc.debugger.sendCommand(method, params);
  };
  const cdp = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    raceDeadline(cdpRaw(method, params, sessionId));

  const waitUntil = async (predicate: () => boolean, maxMs: number): Promise<boolean> => {
    const end = Math.min(deadlineAt, Date.now() + Math.max(0, maxMs));
    while (!predicate()) {
      input.signal.throwIfAborted();
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          input.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(left, 50));
        waiters.add(finish);
        input.signal.addEventListener("abort", finish, { once: true });
      });
    }
    return true;
  };
  const waitBrokerIdle = async (): Promise<boolean> => {
    const settled = await waitUntil(
      () => inFlight === 0 && Date.now() - lastBrokerChangeAt >= IDLE_SETTLE_MS,
      remainingMs(),
    );
    if (!settled) {
      pushDiag({
        code: "verification_timeout",
        severity: "error",
        detail: "In-flight broker requests did not settle before timeout.",
        remedy: STEP_REMEDY.verification_timeout,
      });
    }
    return settled;
  };

  const waitExpectations = async (
    afterStartSeq: number,
    expected: readonly AppFrontendBackendExpectation[],
  ) => {
    const missing = () =>
      unmatchedExpectations(
        recordedCalls.filter((entry) => entry.startSeq > afterStartSeq).map((entry) => entry.call),
        expected,
      );
    if (missing().length) {
      await waitUntil(() => missing().length === 0 && inFlight === 0, remainingMs());
      if (missing().length === 0) await waitBrokerIdle();
    }
    return missing();
  };

  const handleBrokerEvent = (raw: string) => {
    let event: AppBrokerObservation;
    try {
      event = JSON.parse(raw) as AppBrokerObservation;
    } catch {
      return;
    }
    lastBrokerChangeAt = Date.now();
    if (event.kind === "handshake-delivered") {
      handshake.delivered = true;
      return notify();
    }
    if (event.kind === "started") {
      handshake.messageCount++;
      inFlight++;
      startedSeqById.set(event.id, ++callSeq);
      return notify();
    }
    if (event.kind === "aborted") {
      inFlight = Math.max(0, inFlight - 1);
      startedSeqById.delete(event.id);
      return notify();
    }
    const opMeta = event.operation ? { operation: event.operation } : {};
    if (event.kind === "rejected") {
      handshake.messageCount++;
      pushCall(++callSeq, {
        op: event.op,
        ...opMeta,
        status: event.status,
        ok: false,
        rejectedBy: "broker",
        reasonCode: event.reason,
      });
      return pushDiag({
        code: `broker_${event.reason}`,
        severity: "error",
        op: event.op,
        ...opMeta,
        detail: clean(`Broker rejected ${event.op} (${event.reason}).`),
        remedy: LOCAL_REMEDY[event.reason],
      });
    }
    inFlight = Math.max(0, inFlight - 1);
    const startSeq = startedSeqById.get(event.id) ?? ++callSeq;
    startedSeqById.delete(event.id);
    if (event.ok) {
      pushCall(startSeq, { op: event.op, ...opMeta, status: event.status, ok: true });
      return notify();
    }
    if (event.status === 409 && event.refusalCode) {
      pushCall(startSeq, {
        op: event.op,
        ...opMeta,
        status: 409,
        ok: false,
        rejectedBy: "backend",
        reasonCode: "refused",
        refusalCode: event.refusalCode,
      });
      return notify();
    }
    const hint = input.consumeBackendHint(event.op, event.operation);
    pushCall(startSeq, {
      op: event.op,
      ...opMeta,
      status: event.status,
      ok: false,
      rejectedBy: "backend",
      reasonCode: hint?.reasonCode ?? "runtime_error",
    });
    pushDiag({
      code: hint?.diagnosticCode ?? "broker_runtime_error",
      severity: "error",
      op: event.op,
      ...opMeta,
      detail: clean(hint?.detail ?? `${event.op} failed with HTTP ${event.status}.`),
      remedy:
        hint?.remedy ??
        "Check the operation name, payload shape, and Collection backend implementation.",
    });
  };

  const handleCdpMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const isMain = !sessionId || sessionId === "";
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") iframeSessions.delete(params.sessionId);
      return;
    }
    if (method === "Target.attachedToTarget") {
      const childId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!childId) return;
      if ((params.targetInfo as { type?: string } | undefined)?.type === "iframe")
        iframeSessions.add(childId);
      void Promise.allSettled([
        cdpRaw("Runtime.enable", {}, childId),
        cdpRaw("Log.enable", {}, childId),
        cdpRaw("Audits.enable", {}, childId),
        cdpRaw("Page.enable", {}, childId),
        cdpRaw("Page.addScriptToEvaluateOnNewDocument", { source: BLOCK_WEBRTC_SCRIPT }, childId),
        cdpRaw("Runtime.evaluate", { expression: BLOCK_WEBRTC_SCRIPT }, childId),
      ]).finally(() => {
        void cdpRaw("Runtime.runIfWaitingForDebugger", {}, childId).catch(() => {});
      });
      return;
    }
    if (isMain && method === "Page.frameNavigated") {
      const frame = params.frame as { id?: string; parentId?: string } | undefined;
      if (frame?.id && !frame.parentId) mainFrameId = frame.id;
      return;
    }
    if (isMain && method === "Runtime.executionContextCreated") {
      const ctx = params.context as
        | { id?: number; auxData?: { isDefault?: boolean; frameId?: string } }
        | undefined;
      if (
        typeof ctx?.id === "number" &&
        ctx.auxData?.isDefault &&
        (!mainFrameId || ctx.auxData.frameId === mainFrameId)
      )
        mainContextIds.add(ctx.id);
      return;
    }
    if (isMain && method === "Runtime.executionContextDestroyed") {
      if (typeof params.executionContextId === "number")
        mainContextIds.delete(params.executionContextId);
      return;
    }
    if (isMain && method === "Runtime.executionContextsCleared") {
      mainContextIds.clear();
      return;
    }
    if (method === "Runtime.bindingCalled") {
      if (
        isMain &&
        params.name === "__dohcVerifyObserve" &&
        typeof params.payload === "string" &&
        typeof params.executionContextId === "number" &&
        mainContextIds.has(params.executionContextId)
      )
        handleBrokerEvent(params.payload);
      return;
    }
    if (method === "Audits.issueAdded") {
      const issue = params.issue as {
        code?: string;
        details?: {
          contentSecurityPolicyViolationDetails?: {
            violatedDirective?: string;
            effectiveDirective?: string;
            isReportOnly?: boolean;
            sourceCodeLocation?: { lineNumber?: number; columnNumber?: number };
          };
        };
      };
      const csp =
        issue?.code === "ContentSecurityPolicyIssue"
          ? issue.details?.contentSecurityPolicyViolationDetails
          : undefined;
      if (!csp || csp.isReportOnly) return;
      const directive = csp.violatedDirective || csp.effectiveDirective || undefined;
      const loc = csp.sourceCodeLocation;
      const line =
        typeof loc?.lineNumber === "number" && loc.lineNumber >= 0 ? loc.lineNumber + 1 : undefined;
      const column =
        typeof loc?.columnNumber === "number" && loc.columnNumber >= 0
          ? loc.columnNumber + 1
          : undefined;
      const key = `${directive ?? ""}:${line ?? ""}:${column ?? ""}`;
      if (cspSeen.has(key)) return;
      cspSeen.add(key);
      pushDiag({
        code: "csp_violation",
        severity: "error",
        ...(directive ? { directive: directive.slice(0, 64) } : {}),
        ...(line ? { line } : {}),
        ...(column ? { column } : {}),
        detail: clean(
          directive
            ? `Blocked by CSP directive ${directive}.`
            : "Blocked by Content Security Policy.",
        ),
        remedy:
          "Keep scripts in module files listed in app.publish.json and prevent native form submission with event.preventDefault().",
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params.entry as { source?: string; level?: string; text?: string } | undefined;
      if (
        entry?.level === "error" &&
        entry.source === "security" &&
        entry.text?.includes("Content Security Policy") &&
        cspSeen.size === 0
      ) {
        cspSeen.add("log");
        pushDiag({
          code: "csp_violation",
          severity: "error",
          detail: clean(entry.text),
          remedy:
            "Keep scripts in module files listed in app.publish.json and prevent native form submission with event.preventDefault().",
        });
      }
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails as {
        text?: string;
        lineNumber?: number;
        columnNumber?: number;
        exception?: { className?: string; description?: string };
      };
      const rejection = (d?.text ?? "").includes("in promise");
      const cls = d?.exception?.className;
      pushDiag({
        code: rejection ? "unhandled_rejection" : "page_exception",
        severity: "error",
        ...(typeof cls === "string" && /^[A-Za-z0-9_$.]{1,64}$/.test(cls)
          ? { errorName: cls }
          : {}),
        ...(typeof d?.lineNumber === "number" && d.lineNumber >= 0
          ? { line: d.lineNumber + 1 }
          : {}),
        ...(typeof d?.columnNumber === "number" && d.columnNumber >= 0
          ? { column: d.columnNumber + 1 }
          : {}),
        detail: clean(d?.exception?.description?.split("\n")[0] || d?.text || "Uncaught exception"),
        remedy: rejection
          ? "Handle rejected promises and surface backend or UI errors cleanly."
          : "Fix the uncaught JavaScript exception in the app frontend.",
      });
      return;
    }
    if (
      method === "Runtime.consoleAPICalled" &&
      params.type === "error" &&
      Array.isArray(params.args)
    ) {
      const joined = params.args
        .map((arg: { value?: unknown; description?: string; type?: string }) =>
          typeof arg.value === "string"
            ? arg.value
            : arg.value !== undefined
              ? JSON.stringify(arg.value)
              : (arg.description ?? arg.type ?? ""),
        )
        .join(" ");
      pushDiag({
        code: "console_error",
        severity: "error",
        detail: clean(joined || "console.error called"),
        remedy: "Fix the error logged to console.error during frontend execution.",
      });
    }
  };

  try {
    const waitNotLoading = async () => {
      if (!wc.isLoading() || wc.isDestroyed()) return;
      await raceDeadline(
        new Promise<void>((resolve) => {
          const done = () => {
            wc.removeListener("did-stop-loading", done);
            wc.removeListener("destroyed", done);
            resolve();
          };
          wc.once("did-stop-loading", done);
          wc.once("destroyed", done);
        }),
      );
    };
    // Electron 43 creates the initial RenderFrameHost on the first navigation; a fresh WebContentsView
    // can emit did-stop-loading for its initial empty entry and reject loadURL with ERR_FAILED (-2).
    for (let attempt = 0; attempt < 3; attempt++) {
      await waitNotLoading();
      try {
        await raceDeadline(wc.loadURL("data:text/html,"));
        break;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (attempt === 2 || code !== "ERR_FAILED" || wc.isDestroyed()) throw error;
      }
    }
    await waitNotLoading();
    const gateNav = (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
      if (!appViewNavigationAllowed(details.url, details.isMainFrame, origin))
        details.preventDefault();
    };
    wc.on("will-navigate", gateNav);
    wc.on("will-redirect", gateNav);
    wc.on("will-frame-navigate", gateNav);

    wc.debugger.attach("1.3");
    wc.debugger.on("message", handleCdpMessage);
    await cdp("Page.enable");
    const initTree = (await cdp("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    mainFrameId = initTree.frameTree?.frame?.id;
    await cdp("Runtime.enable");
    await cdp("Runtime.addBinding", { name: "__dohcVerifyObserve" });
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: BLOCK_WEBRTC_SCRIPT });
    await cdp("Log.enable");
    await cdp("Audits.enable");
    await cdp("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await raceDeadline(wc.loadURL(launchedSession.url));

    if (!(await waitUntil(() => handshake.delivered, remainingMs()))) {
      pushDiag({
        code: "handshake_not_delivered",
        severity: "error",
        detail: "The app iframe did not complete initial load and broker handoff before timeout.",
        remedy: "Check that index.html loads cleanly and listens for the dohc-app-channel message.",
      });
    } else if (await waitBrokerIdle()) {
      const missingStartup = await waitExpectations(0, input.expectStartupBackend ?? []);
      for (const expected of missingStartup) {
        pushDiag({
          code: "expected_backend_missing",
          severity: "error",
          ...(expected.op ? { op: expected.op } : {}),
          ...(expected.operation ? { operation: expected.operation } : {}),
          detail: clean(`Expected startup ${describeExpectation(expected)} did not complete.`),
          remedy: "Listen for the dohc-app-channel port and send the expected startup request.",
        });
      }
    }

    const startupOk = handshake.delivered && errorCount() === 0;
    const steps = input.steps ?? [];
    if (!startupOk) return buildOutput(false, "runtime", false, steps.length === 0);
    startupFinished = true;
    if (steps.length === 0) return buildOutput(true, "complete", true, true);

    const resolveAppWorld = async (): Promise<{ sessionId?: string; contextId: number } | null> => {
      for (const childId of iframeSessions) {
        try {
          const tree = (await cdp("Page.getFrameTree", {}, childId)) as {
            frameTree?: { frame?: { id?: string } };
          };
          const frameId = tree.frameTree?.frame?.id;
          if (frameId) {
            const world = (await cdp(
              "Page.createIsolatedWorld",
              { frameId, worldName: "dohc-app-verify" },
              childId,
            )) as { executionContextId: number };
            return { sessionId: childId, contextId: world.executionContextId };
          }
        } catch (error) {
          if (error instanceof DeadlineExceededError || input.signal.aborted) throw error;
        }
      }
      const tree = (await cdp("Page.getFrameTree")) as {
        frameTree?: { childFrames?: Array<{ frame?: { id?: string; url?: string } }> };
      };
      const frameId = (
        tree.frameTree?.childFrames?.find((item) => item.frame?.url === "about:srcdoc") ??
        tree.frameTree?.childFrames?.[0]
      )?.frame?.id;
      if (!frameId) return null;
      const world = (await cdp("Page.createIsolatedWorld", {
        frameId,
        worldName: "dohc-app-verify",
      })) as { executionContextId: number };
      return { contextId: world.executionContextId };
    };

    const appWorld = await resolveAppWorld();
    if (!appWorld) {
      pushDiag({
        code: "verification_timeout",
        severity: "error",
        detail: "Could not attach to the app iframe to run verification steps.",
        remedy: "Ensure the app renders its document inside the sandboxed frame.",
      });
      return buildOutput(false, "steps", true, false);
    }

    const pollEval = async (
      expr: string,
      stopWhen: (v: string) => boolean,
      maxMs: number,
      onBeforeEval?: () => void,
    ): Promise<string> => {
      const end = Math.min(deadlineAt, Date.now() + maxMs);
      let last = "invalid";
      let evaluated = false;
      while (true) {
        input.signal.throwIfAborted();
        if (evaluated && Date.now() >= end) return last;
        let res: { result?: { value?: string }; exceptionDetails?: { text?: string } };
        try {
          onBeforeEval?.();
          res = (await cdp(
            "Runtime.evaluate",
            {
              expression: expr,
              contextId: appWorld.contextId,
              returnByValue: true,
              awaitPromise: false,
            },
            appWorld.sessionId,
          )) as { result?: { value?: string }; exceptionDetails?: { text?: string } };
        } catch (error) {
          if (error instanceof DeadlineExceededError && evaluated) return last;
          throw error;
        }
        if (res.exceptionDetails)
          throw new Error(res.exceptionDetails.text ?? "Step evaluation failed.");
        last = res.result?.value ?? "invalid";
        evaluated = true;
        if (stopWhen(last) || Date.now() >= end) return last;
        const pause = Math.min(50, Math.max(0, end - Date.now()));
        if (pause <= 0) return last;
        await new Promise<void>((r) => setTimeout(r, pause));
      }
    };

    let stepsOk = true;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      const beforeErrors = errorCount();
      const beforeDiagLen = diagnostics.length;
      const failStep = (
        code: AppFrontendDiagnostic["code"],
        remedy: string,
        detail?: string,
        recorded = false,
      ) => {
        stepsOk = false;
        stepResults.push({ index, kind: step.kind, ok: false, code, remedy });
        if (!recorded)
          pushDiag({
            code,
            severity: "error",
            stepIndex: index,
            ...(detail ? { detail: clean(detail) } : {}),
            remedy,
          });
      };

      let clickStartSeq = callSeq;
      const status = await pollEval(
        stepExpression(step),
        step.kind === "waitFor" ? (v) => v === "ok" || v === "invalid" : (v) => v !== "missing",
        step.kind === "waitFor" ? remainingMs() : 3000,
        step.kind === "click"
          ? () => {
              clickStartSeq = callSeq;
            }
          : undefined,
      );
      if (status !== "ok") {
        const code: keyof typeof STEP_REMEDY =
          step.kind === "waitFor" && status === "text"
            ? "step_text_mismatch"
            : step.kind === "fill" && status !== "missing" && status !== "invalid"
              ? "step_not_fillable"
              : step.kind === "click" && (status === "disabled" || status === "not_clickable")
                ? "step_not_clickable"
                : "step_selector_not_found";
        const context =
          step.kind === "waitFor" && status === "text"
            ? `selector ${step.selector} missing text ${step.textIncludes ?? ""}`
            : `selector ${step.selector} (${status})`;
        failStep(code, STEP_REMEDY[code], `Step ${index} ${step.kind} failed: ${context}.`);
        break;
      }

      if (step.kind === "fill") {
        lastBrokerChangeAt = Date.now();
        await waitBrokerIdle();
      } else if (step.kind === "click") {
        lastBrokerChangeAt = Date.now();
        if (await waitBrokerIdle()) {
          if (
            step.expectBackend &&
            (await waitExpectations(clickStartSeq, [step.expectBackend])).length
          ) {
            failStep(
              "expected_backend_missing",
              STEP_REMEDY.expected_backend_missing,
              `Clicking ${step.selector} did not start and complete ${describeExpectation(step.expectBackend)}.`,
            );
            break;
          }
        }
      }

      if (errorCount() > beforeErrors) {
        const firstErr = diagnostics
          .slice(beforeDiagLen)
          .find((item) => item.severity === "error")!;
        if (firstErr.stepIndex === undefined) firstErr.stepIndex = index;
        failStep(firstErr.code, firstErr.remedy, undefined, true);
        break;
      }
      stepResults.push({ index, kind: step.kind, ok: true });
    }

    const ok = startupOk && stepsOk && errorCount() === 0;
    return buildOutput(ok, ok ? "complete" : "steps", startupOk, stepsOk);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      pushDiag({
        code: "verification_timeout",
        severity: "error",
        detail: "Verification exceeded timeoutMs before completing.",
        remedy: STEP_REMEDY.verification_timeout,
      });
      return buildOutput(false, startupFinished ? "steps" : "runtime", startupFinished, false);
    }
    throw error;
  } finally {
    activeRun = null;
    if (!wc.isDestroyed()) {
      const closed = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        wc.once("destroyed", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      closeViewNow();
      await closed;
    }
    await launchedSession.stop().catch(() => {});
    await isolated
      .setProxy({
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:1",
        proxyBypassRules: "<-loopback>",
      })
      .catch(() => {});
    await clearSession(true);
  }
}
