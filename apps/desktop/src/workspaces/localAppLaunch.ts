import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAppDocument } from "@dohc/app-browser/document";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { parseDatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import {
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
  APP_PUBLICATION_MAX_DOCUMENT_BYTES,
} from "@dohc/security-contract/app-publication";
import {
  APP_BACKEND_BULK_LIMITS,
  APP_BACKEND_REQUEST_BYTES,
  APP_BACKEND_RESULT_BYTES,
  APP_BACKEND_UPLOAD_BYTES,
  AppBackendLimitError,
  appBackendLimit,
  assertAppBackendUploadBytes,
  parseAppBackendFile,
  parseAppBackendInvokeRequest,
  parseAppBackendUploadMeta,
  parseAppBackendRefusal,
} from "@dohc/security-contract/app-backend";
import {
  APP_COLLECTION_REQUEST_BYTES,
  APP_COLLECTION_RESPONSE_BYTES,
  parseAppCollectionCreateRequest,
} from "@dohc/security-contract/app-publication";
import { isAppCollectionPageRequest } from "@dohc/security-contract/app-collection-checks";
import { palette } from "../renderer/tokens";
const BULK_INVOKE_REPLY_BYTES = APP_BACKEND_BULK_LIMITS.resultBytes + 4096;
export type LocalAppAction = "invoke" | "query" | "upload" | "attempt" | "list" | "create";
/** The workspace engine cannot answer now. The app may retry; this is not a refusal. */
export class LocalAppUnavailableError extends Error {}
export interface LocalAppLaunchBackend {
  browserPublication(publicationId: string): {
    authorityRevision: number;
    files: Parameters<typeof createAppDocument>[0];
  };
  assertBrowserPublication(publicationId: string, authorityRevision: number): void;
  checkBrowserPublication?(
    publicationId: string,
    authorityRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
  /** activated: a person's click or key press in the app frame started this request, as dohc's tab saw it. Always false for a session `launch` opened. */
  request(
    publicationId: string,
    action: LocalAppAction,
    input: unknown,
    signal?: AbortSignal,
    activated?: boolean,
  ): Promise<unknown>;
  readBrowserFile(
    publicationId: string,
    input: {
      authorityRevision: number;
      fileId: string;
      operation: string;
      input: unknown;
      dataset?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  datasetRevisions?(
    publicationId: string,
    authorityRevision: number,
  ): Record<string, number> | null;
  subscribeDatasetChanges?(
    publicationId: string,
    authorityRevision: number,
    onWake: () => void,
  ): () => void;
  localBudget?(): boolean;
}
export interface LocalAppLaunchHost {
  launch(publicationId: string, signal: AbortSignal): Promise<string>;
  /** keepAlive: dohc's own tab, which renews the session, gates the app frame's navigations in main, and credits a click in the frame. Main returns its URL only to the window that asked, and admits only a webview loading it; `/session` accepts only this origin. */
  launchSession(
    publicationId: string,
    signal: AbortSignal,
    options?: { keepAlive?: boolean; observeBroker?: boolean },
  ): Promise<LocalAppLaunchSession>;
  close(): Promise<void>;
}
export interface LocalAppLaunchSession {
  url: string;
  ended: AbortSignal;
  isAlive(): boolean;
  stop(): Promise<void>;
}
// An app's frame is transparent. Its document reports whether the app uses a light or dark color scheme, and the
// frame's background follows it, so an app that paints no background shows its own scheme's page, as in a browser
// tab. This page's own words, before the app opens and after it ends, get dohc's colors.
const BOOTSTRAP_STYLE =
  `body{margin:0}iframe{background:Canvas}body:not(:has(iframe)){background:${palette.light.bg};color:${palette.light.ink}}` +
  `@media (prefers-color-scheme:dark){body:not(:has(iframe)){background:${palette.dark.bg};color:${palette.dark.ink}}}` +
  `@media print{#status{display:none!important}body.dohc-printing iframe{height:var(--dohc-print-h,100vh)!important}}`;
const MAX_SESSIONS = 16,
  HANDOFF_MS = 30_000,
  SESSION_MS = 30 * 60_000,
  IDLE_MS = 90_000,
  LOCAL_MAX_PENDING = 12,
  LOCAL_BACKEND_BURST = 120,
  LOCAL_BACKEND_REFILL_MS = 50,
  FILE_BURST = 120,
  FILE_REFILL_MS = 250,
  MAX_EVENTS_PENDING = 2,
  MAX_EVENTS_HOLD_MS = 25_000;
const validEventAlias = (key: string) =>
  key === "" ||
  (/^[a-z][a-z0-9_-]{0,63}$/.test(key) &&
    key !== "__proto__" &&
    key !== "prototype" &&
    key !== "constructor");
function parseEventsRequest(
  value: unknown,
): { since: Record<string, number>; holdMs: number } | null {
  if (
    !exact(value, ["since"], ["holdMs"]) ||
    !value.since ||
    typeof value.since !== "object" ||
    Array.isArray(value.since)
  )
    return null;
  const entries = Object.entries(value.since as Record<string, unknown>);
  if (entries.length > 32) return null;
  const since: Record<string, number> = {};
  for (const [key, rev] of entries) {
    if (!validEventAlias(key) || typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0)
      return null;
    since[key] = rev;
  }
  const holdMs = Object.hasOwn(value, "holdMs") ? value.holdMs : MAX_EVENTS_HOLD_MS;
  if (
    typeof holdMs !== "number" ||
    !Number.isSafeInteger(holdMs) ||
    holdMs < 0 ||
    holdMs > MAX_EVENTS_HOLD_MS
  )
    return null;
  return { since, holdMs };
}
const diffDatasetRevisions = (revisions: Record<string, number>, since: Record<string, number>) =>
  Object.entries(revisions)
    .filter(([dataset, rev]) => rev > (Object.hasOwn(since, dataset) ? since[dataset]! : 0))
    .map(([dataset, revision]) => ({ dataset, revision }));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const exact = (
  value: unknown,
  keys: string[],
  optional: string[] = [],
): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => keys.includes(key) || optional.includes(key))
  );
};

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw Error("Invalid request type");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    signal.throwIfAborted();
    size += part.length;
    if (size > maxBytes) throw new RangeError("App request is too large");
    parts.push(Buffer.from(part));
  }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size)));
}

async function readBinary(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    signal.throwIfAborted();
    size += part.length;
    if (size > maxBytes)
      throw new AppBackendLimitError(
        appBackendLimit("Attachment upload", maxBytes, size, "bytes", true),
      );
    parts.push(Buffer.from(part));
  }
  signal.throwIfAborted();
  return Buffer.concat(parts, size);
}

/** Each approved local app gets its own loopback origin and an opaque, credential-free child frame. */
export async function createLocalAppLaunchHost(options: {
  backend: LocalAppLaunchBackend;
  lifetime: AbortSignal;
}): Promise<LocalAppLaunchHost> {
  options.lifetime.throwIfAborted();
  const sessions = new Set<() => Promise<void>>();
  // At most two launches hold a stage until their page loads. Later launches wait for a stage in the order they started.
  const waiting: { wake(): void; end(reason: unknown): void }[] = [];
  let closed = false,
    preparing = 0,
    staged = 0;
  const close = async () => {
    closed = true;
    for (const waiter of waiting.splice(0))
      waiter.end(options.lifetime.reason ?? Error("The local app session ended."));
    await Promise.all([...sessions].map((stop) => stop()));
  };
  options.lifetime.addEventListener(
    "abort",
    () => {
      void close();
    },
    { once: true },
  );
  const host: LocalAppLaunchHost = {
    close,
    async launch(publicationId, signal) {
      return (await host.launchSession(publicationId, signal)).url;
    },
    async launchSession(publicationId, signal, launchOptions) {
      signal.throwIfAborted();
      options.lifetime.throwIfAborted();
      if (closed || sessions.size + preparing >= MAX_SESSIONS)
        throw Error("Close another app before opening this one.");
      preparing++;
      let stageReleased = true;
      // A released stage passes straight to the next waiting launch, so no new launch can take it first.
      const releaseStage = () => {
        if (stageReleased) return;
        stageReleased = true;
        const next = waiting.shift();
        if (next) next.wake();
        else staged--;
      };
      try {
        if (staged < 2 && !waiting.length) staged++;
        else
          await new Promise<void>((resolve, reject) => {
            const cancel = AbortSignal.any([signal, options.lifetime]);
            const waiter = {
              wake() {
                cancel.removeEventListener("abort", abort);
                resolve();
              },
              end(reason: unknown) {
                cancel.removeEventListener("abort", abort);
                reject(reason);
              },
            };
            const abort = () => {
              waiting.splice(waiting.indexOf(waiter), 1);
              waiter.end(cancel.reason);
            };
            cancel.addEventListener("abort", abort, { once: true });
            waiting.push(waiter);
          });
        stageReleased = false;
        const { authorityRevision, files } = options.backend.browserPublication(publicationId);
        await options.backend.checkBrowserPublication?.(
          publicationId,
          authorityRevision,
          AbortSignal.any([signal, options.lifetime, AbortSignal.timeout(15_000)]),
        );
        const document = createAppDocument(files, {
          maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
          maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES,
        });
        let stagedHtml: string | undefined = document.html;
        const handoff = token(),
          proof = token(),
          controller = new AbortController(),
          ended = new AbortController();
        const requestSignal = AbortSignal.any([signal, options.lifetime, controller.signal]);
        const highBudget = options.backend.localBudget ? options.backend.localBudget() : true;
        const maxPending = highBudget ? LOCAL_MAX_PENDING : 4,
          backendBurst = highBudget ? LOCAL_BACKEND_BURST : 30,
          backendRefillMs = highBudget ? LOCAL_BACKEND_REFILL_MS : 2000,
          fileRefillMs = highBudget ? LOCAL_BACKEND_REFILL_MS : FILE_REFILL_MS;
        const callBudget = { burst: backendBurst, refillMs: backendRefillMs, tokens: backendBurst },
          fileBudget = { burst: FILE_BURST, refillMs: fileRefillMs, tokens: FILE_BURST };
        let handoffDigest: string | null = digest(handoff),
          origin = "",
          pending = 0,
          eventsPending = 0,
          updated = Date.now();
        let expires = Date.now() + HANDOFF_MS,
          hardExpires = expires;
        const common = {
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        };
        const reply = (
          response: ServerResponse,
          status: number,
          body?: unknown,
          extraHeaders?: Record<string, string>,
        ) => {
          response.writeHead(status, {
            ...common,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...extraHeaders,
          });
          response.end(body === undefined ? undefined : JSON.stringify(body));
        };
        const formatRateLimitDuration = (ms: number) => {
          const rounded = Math.max(1, Math.ceil(ms));
          if (rounded < 1000) return `${rounded} ms`;
          const seconds = rounded / 1000;
          return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1).replace(/\.0$/, "")} s`;
        };
        const current = () => {
          requestSignal.throwIfAborted();
          if (Date.now() >= expires) throw Error("The local app session expired.");
          options.backend.assertBrowserPublication(publicationId, authorityRevision);
        };
        const browserLifetime = launchOptions?.keepAlive
          ? ""
          : `const poll=async()=>{if(stopped)return;try{const r=await fetch('/status',{method:'POST',headers:{'x-dohc-app-proof':proof},signal:lifetime.signal});if(!r.ok){stop();return;}}catch{stop();return;}setTimeout(poll,15000);};setTimeout(poll,15000);setTimeout(stop,${SESSION_MS});`;
        const observe = launchOptions?.observeBroker
          ? "(event)=>{try{globalThis.__dohcVerifyObserve?.(JSON.stringify(event));}catch{}}"
          : "undefined";
        const brokerLimits = JSON.stringify({
          ...(highBudget ? { maxPending, backendBurst, backendRefillMs, fileRefillMs } : {}),
          invokeRequestBytes: APP_BACKEND_BULK_LIMITS.requestBytes,
          invokeResultBytes: BULK_INVOKE_REPLY_BYTES,
          trustRateLimitDetails: true,
        });
        const hasEvents = Boolean(
          options.backend.datasetRevisions &&
          options.backend.subscribeDatasetChanges &&
          options.backend.datasetRevisions(publicationId, authorityRevision) !== null,
        );
        const eventLoop = hasEvents
          ? `let since={},backoff=500;const watch=async()=>{while(!stopped&&!lifetime.signal.aborted){try{const er=await fetch('/events',{method:'POST',headers:{'content-type':'application/json','x-dohc-app-proof':proof},body:JSON.stringify({since,holdMs:${MAX_EVENTS_HOLD_MS}}),signal:lifetime.signal});if(er.status===204||er.status===404)return;if(!er.ok)throw Error();const payload=await er.json();if(stopped)return;backoff=500;if(Array.isArray(payload?.changed)){for(const item of payload.changed){if(item&&typeof item.dataset==='string'&&typeof item.revision==='number'){since[item.dataset]=Math.max(since[item.dataset]||0,item.revision);broker.notifyDatasetChanged(item.dataset,item.revision);}}}}catch{if(stopped||lifetime.signal.aborted)return;await new Promise(ok=>{const t=setTimeout(ok,backoff);lifetime.signal.addEventListener('abort',()=>{clearTimeout(t);ok();},{once:true});});backoff=Math.min(5000,backoff*2);}}};void watch();`
          : "";
        const script = `(()=>{
          const handoff=location.hash.slice(1),key='dohc-local-app-proof';history.replaceState(null,'','/bootstrap');
          const lifetime=new AbortController();let frame,proof,stopped=false;
          const readProof=()=>{try{return sessionStorage.getItem(key);}catch{return null;}};
          const saveProof=value=>{try{if(value)sessionStorage.setItem(key,value);else sessionStorage.removeItem(key);}catch{}};
          const stop=()=>{if(stopped)return;stopped=true;saveProof(null);if(proof)fetch('/close',{method:'POST',headers:{'x-dohc-app-proof':proof},keepalive:true}).catch(()=>{});lifetime.abort();frame?.remove();const status=document.getElementById('status');status.style.margin='';status.textContent='This app session ended. Open the app again in dohc.';};
          addEventListener('pagehide',()=>{stopped=true;lifetime.abort();frame?.remove();},{once:true});
          addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
          proof=handoff?null:readProof();
          const request=proof?fetch('/resume',{method:'POST',headers:{'x-dohc-app-proof':proof},signal:lifetime.signal}):fetch('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handoff}),signal:lifetime.signal});
          request.then(async r=>{if(!r.ok)throw Error();const value=await r.json();if(stopped)return;proof=value.proof;saveProof(proof);
            frame=document.createElement('iframe');frame.title='Local app';frame.sandbox='allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox';frame.style='display:block;border:0;width:100%;height:100vh';
            const broker=(${attachAppCollectionBroker.toString()})(frame,(body,signal,request)=>{if(body.op==='backend.upload'){const{bytes,...meta}=body;return fetch('/backend',{method:'POST',headers:{'content-type':'application/octet-stream','x-dohc-app-proof':proof,'x-dohc-app-activated':request.activated?'1':'0','x-dohc-app-meta':encodeURIComponent(JSON.stringify(meta))},body:bytes,signal});}return fetch(body.op==='backend.file'?'/file':'/backend',{method:'POST',headers:{'content-type':'application/json','x-dohc-app-proof':proof,'x-dohc-app-activated':request.activated?'1':'0'},body:JSON.stringify(body),signal});},lifetime.signal,${observe},${brokerLimits});
            addEventListener('message',event=>{const scheme=event.data?.kind==='dohc-color-scheme'?event.data.scheme:null;if(event.source===frame.contentWindow&&(scheme==='light'||scheme==='dark'))frame.style.colorScheme=scheme;},{signal:lifetime.signal});
            frame.srcdoc=value.html;document.body.append(frame);const status=document.getElementById('status');status.textContent='';status.style.margin='0';
            ${eventLoop}
            ${browserLifetime}
          }).catch(()=>{if(!stopped)stop();});
        })();`;
        const scriptHash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
        // In dohc's tab, main stops every navigation of the app frame and sends an outside link to the browser, so the
        // frame's navigations must reach main. A browser has no such gate, so there the frame stays on this origin, and
        // the app document opens a plain link to another site in a new tab.
        const frameSources = launchOptions?.keepAlive ? "'self' http: https: mailto:" : "'self'";
        const csp = `default-src 'none'; script-src ${scriptHash} ${document.scriptSources.join(" ")}; style-src 'unsafe-inline'; connect-src http: https: ws: wss:; img-src data: blob: http: https:; font-src data: http: https:; media-src data: blob: http: https:; frame-src ${frameSources}; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local app</title><style>${BOOTSTRAP_STYLE}</style></head><body><p id="status" role="status">Opening app</p><script>${script}</script></body></html>`;
        const server = createServer(async (request, response) => {
          const abort = new AbortController(),
            requestAborted = () => abort.abort(),
            responseClosed = () => {
              if (!response.writableEnded) abort.abort();
            };
          request.once("aborted", requestAborted);
          response.once("close", responseClosed);
          const timeoutMs =
            request.url === "/backend" &&
            request.headers["content-type"] === "application/octet-stream"
              ? 90_000
              : 15_000;
          let activeSignal = AbortSignal.any([
            requestSignal,
            abort.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          let admitted = false,
            eventsAdmitted = false;
          try {
            const url = new URL(request.url ?? "/", origin);
            if (
              request.headers.host !== new URL(origin).host ||
              url.origin !== origin ||
              url.search ||
              url.hash ||
              ![
                "/bootstrap",
                "/session",
                "/resume",
                "/backend",
                "/file",
                "/events",
                "/status",
                "/close",
              ].includes(url.pathname)
            )
              return reply(response, 404);
            current();
            if (request.method === "GET" && url.pathname === "/bootstrap") {
              response.writeHead(200, {
                ...common,
                "content-type": "text/html; charset=utf-8",
                "content-security-policy": csp,
                "cross-origin-opener-policy": "same-origin",
              });
              response.end(html);
              return;
            }
            if (request.method !== "POST" || request.headers.origin !== origin)
              return reply(response, 404);
            if (url.pathname === "/session") {
              if (!handoffDigest || pending >= maxPending) return reply(response, 404);
              pending++;
              admitted = true;
              const body = await readJson(request, 1024, activeSignal);
              if (
                !exact(body, ["handoff"]) ||
                typeof body.handoff !== "string" ||
                body.handoff.length !== 43 ||
                digest(body.handoff) !== handoffDigest
              )
                return reply(response, 404);
              current();
              handoffDigest = null;
              hardExpires = launchOptions?.keepAlive ? Infinity : Date.now() + SESSION_MS;
              expires = launchOptions?.keepAlive ? Infinity : Date.now() + IDLE_MS;
              const html = stagedHtml;
              stagedHtml = undefined;
              releaseStage();
              return reply(response, 200, { proof, html });
            }
            if (
              handoffDigest !== null ||
              typeof request.headers["x-dohc-app-proof"] !== "string" ||
              digest(request.headers["x-dohc-app-proof"]) !== digest(proof)
            )
              return reply(response, 404);
            if (url.pathname === "/close") {
              response.once("finish", () => {
                void stop();
              });
              return reply(response, 204);
            }
            expires = launchOptions?.keepAlive
              ? Infinity
              : Math.min(hardExpires, Date.now() + IDLE_MS);
            if (url.pathname === "/status") return reply(response, 204);
            if (url.pathname === "/events") {
              if (eventsPending >= MAX_EVENTS_PENDING) return reply(response, 429);
              eventsPending++;
              eventsAdmitted = true;
              activeSignal = AbortSignal.any([
                requestSignal,
                abort.signal,
                AbortSignal.timeout(MAX_EVENTS_HOLD_MS + 5_000),
              ]);
              const parsed = parseEventsRequest(await readJson(request, 4096, activeSignal));
              if (!parsed) return reply(response, 400);
              if (!options.backend.datasetRevisions || !options.backend.subscribeDatasetChanges)
                return reply(response, 204);
              const deadline = Date.now() + parsed.holdMs;
              let woken = false,
                wake: (() => void) | null = null;
              const unsubscribe = options.backend.subscribeDatasetChanges(
                publicationId,
                authorityRevision,
                () => {
                  woken = true;
                  wake?.();
                },
              );
              try {
                for (;;) {
                  woken = false;
                  activeSignal.throwIfAborted();
                  current();
                  const revisions = options.backend.datasetRevisions(
                    publicationId,
                    authorityRevision,
                  );
                  if (revisions === null) return reply(response, 204);
                  const changed = diffDatasetRevisions(revisions, parsed.since);
                  const remaining = deadline - Date.now();
                  if (changed.length > 0 || remaining <= 0)
                    return reply(response, 200, { changed });
                  if (woken) continue;
                  await new Promise<void>((resolve) => {
                    const finish = () => {
                      wake = null;
                      clearTimeout(timer);
                      activeSignal.removeEventListener("abort", finish);
                      resolve();
                    };
                    wake = finish;
                    const timer = setTimeout(finish, remaining);
                    timer.unref?.();
                    activeSignal.addEventListener("abort", finish, { once: true });
                    if (woken || activeSignal.aborted) finish();
                  });
                }
              } finally {
                wake = null;
                unsubscribe();
              }
            }
            if (!["/backend", "/file", "/resume"].includes(url.pathname))
              return reply(response, 404);
            const fileRoute = url.pathname === "/file",
              lane = fileRoute ? fileBudget : callBudget;
            const now = Date.now();
            for (const bucket of [callBudget, fileBudget])
              bucket.tokens = Math.min(
                bucket.burst,
                bucket.tokens + (now - updated) / bucket.refillMs,
              );
            updated = now;
            if (pending >= maxPending)
              return reply(response, 429, {
                code: "rate_limited",
                message: `Rate limit reached: at most ${maxPending} concurrent requests allowed (${pending} currently in flight). Wait for an active request to finish, then try again.`,
              });
            if (lane.tokens < 1) {
              const retryAfterMs = Math.max(1, Math.ceil((1 - lane.tokens) * lane.refillMs));
              return reply(
                response,
                429,
                {
                  code: "rate_limited",
                  message: `Rate limit reached: ${lane.burst} of ${lane.burst} ${fileRoute ? "file reads" : "requests"} used in the ${formatRateLimitDuration(lane.burst * lane.refillMs)} burst window (refills 1 ${fileRoute ? "file read" : "request"} every ${formatRateLimitDuration(lane.refillMs)}). Try again in ${formatRateLimitDuration(retryAfterMs)}.`,
                  retryAfterMs,
                },
                { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
              );
            }
            lane.tokens--;
            pending++;
            admitted = true;
            if (url.pathname === "/resume") {
              const latest = options.backend.browserPublication(publicationId);
              if (latest.authorityRevision !== authorityRevision) return reply(response, 404);
              const resumed = createAppDocument(latest.files, {
                maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
                maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES,
              });
              activeSignal.throwIfAborted();
              current();
              return reply(response, 200, { proof, html: resumed.html });
            }
            // The app frame has neither the proof nor this origin. Only dohc's tab can claim a click, though: a session
            // for a browser handed its URL, and so its proof, to whoever asked, an agent included, which can send this header.
            const activated =
              launchOptions?.keepAlive === true && request.headers["x-dohc-app-activated"] === "1";
            if (fileRoute && request.headers["content-type"] !== "application/json")
              return reply(response, 400);
            if (request.headers["content-type"] === "application/octet-stream") {
              const rawMeta = request.headers["x-dohc-app-meta"];
              if (typeof rawMeta !== "string" || !rawMeta || rawMeta.length > 4096)
                return reply(response, 400);
              let meta: unknown;
              try {
                meta = JSON.parse(decodeURIComponent(rawMeta));
              } catch {
                return reply(response, 400);
              }
              if (
                !exact(meta, ["id", "op", "idempotencyKey", "name", "contentType"], ["dataset"]) ||
                meta.op !== "backend.upload" ||
                typeof meta.id !== "string" ||
                meta.id.length > 64 ||
                !/^[A-Za-z0-9_-]+$/.test(meta.id)
              )
                return reply(response, 400);
              const bytes = await readBinary(request, APP_BACKEND_UPLOAD_BYTES, activeSignal);
              assertAppBackendUploadBytes(bytes.byteLength);
              const input = parseAppBackendUploadMeta({
                authorityRevision,
                idempotencyKey: meta.idempotencyKey,
                name: meta.name,
                contentType: meta.contentType,
                ...(Object.hasOwn(meta, "dataset") ? { dataset: meta.dataset } : {}),
              });
              const uploaded = await options.backend.request(
                publicationId,
                "upload",
                { ...input, bytes },
                activeSignal,
                activated,
              );
              activeSignal.throwIfAborted();
              current();
              if (Buffer.byteLength(JSON.stringify(uploaded)) > APP_BACKEND_RESULT_BYTES)
                return reply(response, 503);
              return reply(response, 200, uploaded);
            }
            const body = await readJson(
              request,
              APP_BACKEND_BULK_LIMITS.requestBytes,
              activeSignal,
            );
            if (!body || typeof body !== "object" || Array.isArray(body))
              return reply(response, 400);
            const row = body as Record<string, unknown>;
            if (
              typeof row.id !== "string" ||
              row.id.length > 64 ||
              !/^[A-Za-z0-9_-]+$/.test(row.id)
            )
              return reply(response, 400);
            if (fileRoute !== (row.op === "backend.file")) return reply(response, 400);
            const collection = row.op === "collection.list" || row.op === "collection.create";
            if (
              row.op !== "backend.invoke" &&
              Buffer.byteLength(JSON.stringify(row)) >
                (collection ? APP_COLLECTION_REQUEST_BYTES : APP_BACKEND_REQUEST_BYTES)
            )
              return reply(response, 413);
            let result: unknown;
            if (
              row.op === "collection.list" &&
              (exact(row, ["id", "op", "limit"]) || exact(row, ["id", "op", "limit", "afterPath"]))
            ) {
              if (!isAppCollectionPageRequest(row.limit, row.afterPath))
                return reply(response, 400);
              result = await options.backend.request(
                publicationId,
                "list",
                {
                  authorityRevision,
                  limit: row.limit,
                  ...(row.afterPath === undefined ? {} : { afterPath: row.afterPath }),
                },
                activeSignal,
                activated,
              );
            } else if (
              row.op === "collection.create" &&
              exact(row, ["id", "op", "idempotencyKey", "fields"])
            ) {
              const input = parseAppCollectionCreateRequest({
                authorityRevision,
                idempotencyKey: row.idempotencyKey,
                fields: row.fields,
              });
              result = await options.backend.request(
                publicationId,
                "create",
                input,
                activeSignal,
                activated,
              );
            } else if (
              row.op === "backend.attempt" &&
              exact(row, ["id", "op", "operation", "request"], ["dataset"])
            ) {
              const identity = parseAppBackendInvokeRequest({
                authorityRevision,
                operation: row.operation,
                idempotencyKey: "attempt",
                input: {},
                ...(Object.hasOwn(row, "dataset") ? { dataset: row.dataset } : {}),
              });
              result = await options.backend.request(
                publicationId,
                "attempt",
                {
                  authorityRevision,
                  operation: identity.operation,
                  ...(identity.dataset === undefined ? {} : { dataset: identity.dataset }),
                  ...parseDatasetAttemptRequest(row.request),
                },
                activeSignal,
                activated,
              );
            } else if (
              row.op === "backend.invoke" &&
              exact(
                row,
                ["id", "op", "operation", "idempotencyKey", "input"],
                ["dataset", "readOnly"],
              )
            ) {
              if (Object.hasOwn(row, "readOnly") && row.readOnly !== true)
                return reply(response, 400);
              const input = parseAppBackendInvokeRequest(
                {
                  authorityRevision: authorityRevision,
                  operation: row.operation,
                  idempotencyKey: row.idempotencyKey,
                  input: row.input,
                  ...(Object.hasOwn(row, "dataset") ? { dataset: row.dataset } : {}),
                },
                "bulk",
              );
              result = await options.backend.request(
                publicationId,
                row.readOnly === true ? "query" : "invoke",
                input,
                activeSignal,
                activated,
              );
            } else if (
              row.op === "backend.file" &&
              exact(row, ["id", "op", "fileId", "operation", "input"], ["dataset"])
            ) {
              if (
                typeof row.fileId !== "string" ||
                row.fileId.length > 128 ||
                !/^[A-Za-z0-9_-]{16,128}$/.test(row.fileId)
              )
                return reply(response, 400);
              const input = parseAppBackendInvokeRequest({
                authorityRevision: authorityRevision,
                idempotencyKey: "file-read",
                operation: row.operation,
                input: row.input,
                ...(Object.hasOwn(row, "dataset") ? { dataset: row.dataset } : {}),
              });
              const downloaded = await options.backend.readBrowserFile(
                publicationId,
                {
                  authorityRevision: input.authorityRevision,
                  fileId: row.fileId,
                  operation: input.operation,
                  input: input.input,
                  ...(input.dataset === undefined ? {} : { dataset: input.dataset }),
                },
                activeSignal,
              );
              activeSignal.throwIfAborted();
              current();
              if (
                !downloaded ||
                typeof downloaded !== "object" ||
                Array.isArray(downloaded) ||
                !("file" in downloaded) ||
                !("bytes" in downloaded) ||
                !(downloaded.bytes instanceof Uint8Array)
              )
                return reply(response, 503);
              const file = parseAppBackendFile(downloaded.file);
              if (
                downloaded.bytes.byteLength !== file.byteLength ||
                downloaded.bytes.byteLength > APP_BACKEND_UPLOAD_BYTES
              )
                return reply(response, 503);
              response.writeHead(200, {
                ...common,
                "content-type": "application/octet-stream",
                "x-dohc-app-file": encodeURIComponent(JSON.stringify(file)),
              });
              response.end(Buffer.from(downloaded.bytes));
              return;
            } else return reply(response, 400);
            activeSignal.throwIfAborted();
            current();
            const bulk =
              !!result &&
              typeof result === "object" &&
              (result as { profile?: unknown }).profile === "bulk";
            if (
              Buffer.byteLength(JSON.stringify(result)) >
              (collection
                ? APP_COLLECTION_RESPONSE_BYTES
                : bulk
                  ? BULK_INVOKE_REPLY_BYTES
                  : APP_BACKEND_RESULT_BYTES)
            )
              return reply(response, 503);
            return reply(response, 200, result);
          } catch (error) {
            if (
              eventsAdmitted &&
              !abort.signal.aborted &&
              !(error instanceof LocalAppUnavailableError)
            )
              isAlive();
            if (!response.headersSent && !response.destroyed) {
              if (isAppBackendRuntimeError(error)) {
                try {
                  activeSignal.throwIfAborted();
                  current();
                  return reply(response, 200, parseAppBackendRefusal(error.refusal), {
                    "x-dohc-app-refusal": "1",
                  });
                } catch {}
              }
              if (error instanceof AppBackendLimitError)
                return reply(response, 413, { error: error.message });
              reply(
                response,
                error instanceof RangeError
                  ? 413
                  : error instanceof LocalAppUnavailableError
                    ? 503
                    : 404,
              );
            }
          } finally {
            request.removeListener("aborted", requestAborted);
            response.removeListener("close", responseClosed);
            if (admitted) pending--;
            if (eventsAdmitted) eventsPending--;
          }
        });
        server.requestTimeout = 15_000;
        server.headersTimeout = 10_000;
        server.maxConnections = highBudget ? 24 : 16;
        let stopped: Promise<void> | undefined;
        const stop = () =>
          (stopped ??= Promise.resolve().then(async () => {
            if (!ended.signal.aborted) ended.abort("ended");
            requestSignal.removeEventListener("abort", onAbort);
            controller.abort();
            sessions.delete(stop);
            clearInterval(expiry);
            clearInterval(approvalCheck);
            stagedHtml = undefined;
            releaseStage();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }));
        const onAbort = () => {
          void stop();
        };
        const isAlive = () => {
          if (ended.signal.aborted || requestSignal.aborted) return false;
          if (Date.now() >= expires) {
            ended.abort("ended");
            void stop();
            return false;
          }
          try {
            options.backend.assertBrowserPublication(publicationId, authorityRevision);
          } catch (error) {
            if (error instanceof LocalAppUnavailableError) return true;
            ended.abort("needs-approval");
            void stop();
            return false;
          }
          return true;
        };
        const expiry = setInterval(isAlive, 1000);
        expiry.unref();
        let checking = false;
        const approvalCheck =
          launchOptions?.keepAlive && options.backend.checkBrowserPublication
            ? setInterval(() => {
                if (checking || !isAlive()) return;
                checking = true;
                void options.backend.checkBrowserPublication!(
                  publicationId,
                  authorityRevision,
                  AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]),
                )
                  .catch((error) => {
                    if (
                      !requestSignal.aborted &&
                      !(error instanceof LocalAppUnavailableError) &&
                      !(error instanceof DOMException && error.name === "TimeoutError")
                    ) {
                      ended.abort("needs-approval");
                      void stop();
                    }
                  })
                  .finally(() => {
                    checking = false;
                  });
              }, 15_000)
            : undefined;
        approvalCheck?.unref();
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") throw Error("Could not open the local app.");
          origin = `http://127.0.0.1:${address.port}`;
          sessions.add(stop);
          requestSignal.addEventListener("abort", onAbort, { once: true });
          if (requestSignal.aborted || closed) {
            await stop();
            throw Error("The local app session ended.");
          }
          return { url: origin + "/bootstrap#" + handoff, ended: ended.signal, isAlive, stop };
        } catch (error) {
          await stop();
          throw error;
        }
      } catch (error) {
        releaseStage();
        throw error;
      } finally {
        preparing--;
      }
    },
  };
  return host;
}
