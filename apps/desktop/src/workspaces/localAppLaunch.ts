import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAppDocument } from "@dohc/app-browser/document";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { parseDatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_DOCUMENT_BYTES } from "@dohc/security-contract/app-publication";
import { APP_BACKEND_REQUEST_BYTES, APP_BACKEND_RESULT_BYTES, APP_BACKEND_UPLOAD_REQUEST_BYTES,
  parseAppBackendInvokeRequest, parseAppBackendUploadRequest, parseAppBackendRefusal } from "@dohc/security-contract/app-backend";
import { APP_COLLECTION_REQUEST_BYTES, APP_COLLECTION_RESPONSE_BYTES, parseAppCollectionCreateRequest } from "@dohc/security-contract/app-publication";
import { isAppCollectionPageRequest } from "@dohc/security-contract/app-collection-checks";
import { palette } from "../renderer/tokens";
export type LocalAppAction = "invoke" | "upload" | "attempt" | "list" | "create";
/** The workspace engine cannot answer now. The app may retry; this is not a refusal. */
export class LocalAppUnavailableError extends Error {}
export interface LocalAppLaunchBackend {
  browserPublication(publicationId: string): { authorityRevision: number; files: Parameters<typeof createAppDocument>[0] };
  assertBrowserPublication(publicationId: string, authorityRevision: number): void;
  checkBrowserPublication?(publicationId: string, authorityRevision: number, signal: AbortSignal): Promise<void>;
  /** activated: a person's click or key press in the app frame started this request, as dohc's tab saw it. Always false for a session `launch` opened. */
  request(publicationId: string, action: LocalAppAction, input: unknown, signal?: AbortSignal, activated?: boolean): Promise<unknown>;
  readBrowserFile(publicationId: string, input: { authorityRevision: number; fileId: string; operation: string; input: unknown }, signal?: AbortSignal): Promise<unknown>;
}
export interface LocalAppLaunchHost {
  launch(publicationId: string, signal: AbortSignal): Promise<string>;
  /** keepAlive: dohc's own tab, which renews the session, gates the app frame's navigations in main, and credits a click in the frame. Main returns its URL only to the window that asked, and admits only a webview loading it; `/session` accepts only this origin. */
  launchSession(publicationId: string, signal: AbortSignal, options?: { keepAlive?: boolean }): Promise<LocalAppLaunchSession>;
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
const BOOTSTRAP_STYLE = `body{margin:0}iframe{background:Canvas}body:not(:has(iframe)){background:${palette.light.bg};color:${palette.light.ink}}` +
  `@media (prefers-color-scheme:dark){body:not(:has(iframe)){background:${palette.dark.bg};color:${palette.dark.ink}}}`;
const MAX_SESSIONS = 16, HANDOFF_MS = 30_000, SESSION_MS = 30 * 60_000, IDLE_MS = 90_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

async function readJson(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw Error("Invalid request type");
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) {
    signal.throwIfAborted(); size += part.length;
    if (size > maxBytes) throw new RangeError("App request is too large");
    parts.push(Buffer.from(part));
  }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size)));
}

/** Each approved local app gets its own loopback origin and an opaque, credential-free child frame. */
export async function createLocalAppLaunchHost(options: { backend: LocalAppLaunchBackend; lifetime: AbortSignal }): Promise<LocalAppLaunchHost> {
  options.lifetime.throwIfAborted();
  const sessions = new Set<() => Promise<void>>();
  // At most two launches hold a stage until their page loads. Later launches wait for a stage in the order they started.
  const waiting: { wake(): void; end(reason: unknown): void }[] = [];
  let closed = false, preparing = 0, staged = 0;
  const close = async () => {
    closed = true;
    for (const waiter of waiting.splice(0)) waiter.end(options.lifetime.reason ?? Error("The local app session ended."));
    await Promise.all([...sessions].map(stop => stop()));
  };
  options.lifetime.addEventListener("abort", () => { void close(); }, { once: true });
  const host: LocalAppLaunchHost = {
    close,
    async launch(publicationId, signal) { return (await host.launchSession(publicationId, signal)).url; },
    async launchSession(publicationId, signal, launchOptions) {
      signal.throwIfAborted(); options.lifetime.throwIfAborted();
      if (closed || sessions.size + preparing >= MAX_SESSIONS) throw Error("Close another app before opening this one.");
      preparing++;
      let stageReleased = true;
      // A released stage passes straight to the next waiting launch, so no new launch can take it first.
      const releaseStage = () => {
        if (stageReleased) return;
        stageReleased = true;
        const next = waiting.shift();
        if (next) next.wake(); else staged--;
      };
      try {
        if (staged < 2 && !waiting.length) staged++;
        else await new Promise<void>((resolve, reject) => {
          const cancel = AbortSignal.any([signal, options.lifetime]);
          const waiter = {
            wake() { cancel.removeEventListener("abort", abort); resolve(); },
            end(reason: unknown) { cancel.removeEventListener("abort", abort); reject(reason); },
          };
          const abort = () => { waiting.splice(waiting.indexOf(waiter), 1); waiter.end(cancel.reason); };
          cancel.addEventListener("abort", abort, { once: true });
          waiting.push(waiter);
        });
        stageReleased = false;
        const { authorityRevision, files } = options.backend.browserPublication(publicationId);
        await options.backend.checkBrowserPublication?.(publicationId, authorityRevision, AbortSignal.any([signal, options.lifetime, AbortSignal.timeout(15_000)]));
        const document = createAppDocument(files, { maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES, maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES });
        let stagedHtml: string | undefined = document.html;
        const handoff = token(), proof = token(), controller = new AbortController(), ended = new AbortController();
        const requestSignal = AbortSignal.any([signal, options.lifetime, controller.signal]);
        let handoffDigest: string | null = digest(handoff), origin = "", pending = 0, tokens = 30, updated = Date.now();
        let expires = Date.now() + HANDOFF_MS, hardExpires = expires;
        const common = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
        const reply = (response: ServerResponse, status: number, body?: unknown) => {
          response.writeHead(status, { ...common, ...(body === undefined ? {} : { "content-type": "application/json" }) });
          response.end(body === undefined ? undefined : JSON.stringify(body));
        };
        const current = () => {
          requestSignal.throwIfAborted();
          if (Date.now() >= expires) throw Error("The local app session expired.");
          options.backend.assertBrowserPublication(publicationId, authorityRevision);
        };
        const browserLifetime = launchOptions?.keepAlive ? "" : `const poll=async()=>{if(stopped)return;try{const r=await fetch('/status',{method:'POST',headers:{'x-dohc-app-proof':proof},signal:lifetime.signal});if(!r.ok){stop();return;}}catch{stop();return;}setTimeout(poll,15000);};setTimeout(poll,15000);setTimeout(stop,${SESSION_MS});`;
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
            (${attachAppCollectionBroker.toString()})(frame,(body,signal,request)=>fetch('/backend',{method:'POST',headers:{'content-type':'application/json','x-dohc-app-proof':proof,'x-dohc-app-activated':request.activated?'1':'0'},body:JSON.stringify(body),signal}),lifetime.signal);
            addEventListener('message',event=>{const scheme=event.data?.kind==='dohc-color-scheme'?event.data.scheme:null;if(event.source===frame.contentWindow&&(scheme==='light'||scheme==='dark'))frame.style.colorScheme=scheme;},{signal:lifetime.signal});
            frame.srcdoc=value.html;document.body.append(frame);const status=document.getElementById('status');status.textContent='';status.style.margin='0';
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
          const abort = new AbortController(), requestAborted = () => abort.abort();
          request.once("aborted", requestAborted);
          const activeSignal = AbortSignal.any([requestSignal, abort.signal, AbortSignal.timeout(15_000)]);
          let admitted = false;
          try {
            const url = new URL(request.url ?? "/", origin);
            if (request.headers.host !== new URL(origin).host || url.origin !== origin || url.search || url.hash || !["/bootstrap", "/session", "/resume", "/backend", "/status", "/close"].includes(url.pathname)) return reply(response, 404);
            current();
            if (request.method === "GET" && url.pathname === "/bootstrap") {
              response.writeHead(200, { ...common, "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cross-origin-opener-policy": "same-origin" });
              response.end(html); return;
            }
            if (request.method !== "POST" || request.headers.origin !== origin) return reply(response, 404);
            if (url.pathname === "/session") {
              if (!handoffDigest || pending >= 4) return reply(response, 404);
              pending++; admitted = true;
              const body = await readJson(request, 1024, activeSignal);
              if (!exact(body, ["handoff"]) || typeof body.handoff !== "string" || body.handoff.length !== 43 || digest(body.handoff) !== handoffDigest) return reply(response, 404);
              current(); handoffDigest = null; hardExpires = launchOptions?.keepAlive ? Infinity : Date.now() + SESSION_MS;
              expires = launchOptions?.keepAlive ? Infinity : Date.now() + IDLE_MS;
              const html = stagedHtml; stagedHtml = undefined; releaseStage();
              return reply(response, 200, { proof, html });
            }
            if (handoffDigest !== null || typeof request.headers["x-dohc-app-proof"] !== "string" || digest(request.headers["x-dohc-app-proof"]) !== digest(proof)) return reply(response, 404);
            if (url.pathname === "/close") { response.once("finish", () => { void stop(); }); return reply(response, 204); }
            expires = launchOptions?.keepAlive ? Infinity : Math.min(hardExpires, Date.now() + IDLE_MS);
            if (url.pathname === "/status") return reply(response, 204);
            if (url.pathname !== "/backend" && url.pathname !== "/resume") return reply(response, 404);
            const now = Date.now(); tokens = Math.min(30, tokens + (now - updated) / 2000); updated = now;
            if (pending >= 4 || tokens < 1) return reply(response, 429);
            tokens--; pending++; admitted = true;
            if (url.pathname === "/resume") {
              const latest = options.backend.browserPublication(publicationId);
              if (latest.authorityRevision !== authorityRevision) return reply(response, 404);
              const resumed = createAppDocument(latest.files, { maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES, maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES });
              activeSignal.throwIfAborted(); current();
              return reply(response, 200, { proof, html: resumed.html });
            }
            const body = await readJson(request, APP_BACKEND_UPLOAD_REQUEST_BYTES, activeSignal);
            // The app frame has neither the proof nor this origin. Only dohc's tab can claim a click, though: a session
            // for a browser handed its URL, and so its proof, to whoever asked, an agent included, which can send this header.
            const activated = launchOptions?.keepAlive === true && request.headers["x-dohc-app-activated"] === "1";
            if (!body || typeof body !== "object" || Array.isArray(body)) return reply(response, 400);
            const row = body as Record<string, unknown>;
            if (typeof row.id !== "string" || row.id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(row.id)) return reply(response, 400);
            const collection = row.op === "collection.list" || row.op === "collection.create";
            if (row.op !== "backend.upload" && Buffer.byteLength(JSON.stringify(row)) > (collection ? APP_COLLECTION_REQUEST_BYTES : APP_BACKEND_REQUEST_BYTES)) return reply(response, 413);
            let result: unknown;
            if (row.op === "collection.list" && (exact(row, ["id", "op", "limit"]) || exact(row, ["id", "op", "limit", "afterPath"]))) {
              if (!isAppCollectionPageRequest(row.limit, row.afterPath)) return reply(response, 400);
              result = await options.backend.request(publicationId, "list", { authorityRevision, limit: row.limit, ...(row.afterPath === undefined ? {} : { afterPath: row.afterPath }) }, activeSignal, activated);
            } else if (row.op === "collection.create" && exact(row, ["id", "op", "idempotencyKey", "fields"])) {
              const input = parseAppCollectionCreateRequest({ authorityRevision, idempotencyKey: row.idempotencyKey, fields: row.fields });
              result = await options.backend.request(publicationId, "create", input, activeSignal, activated);
            } else if (row.op === "backend.attempt" && exact(row, ["id", "op", "operation", "request"])) {
              const operation = parseAppBackendInvokeRequest({ authorityRevision, operation: row.operation, idempotencyKey: "attempt", input: {} }).operation;
              result = await options.backend.request(publicationId, "attempt", { authorityRevision, operation, ...parseDatasetAttemptRequest(row.request) }, activeSignal, activated);
            } else if (row.op === "backend.invoke" && exact(row, ["id", "op", "operation", "idempotencyKey", "input"])) {
              const input = parseAppBackendInvokeRequest({ authorityRevision: authorityRevision, operation: row.operation, idempotencyKey: row.idempotencyKey, input: row.input });
              result = await options.backend.request(publicationId, "invoke", input, activeSignal, activated);
            } else if (row.op === "backend.upload" && exact(row, ["id", "op", "idempotencyKey", "name", "contentType", "bytesBase64"])) {
              const input = parseAppBackendUploadRequest({ authorityRevision: authorityRevision, idempotencyKey: row.idempotencyKey, name: row.name, contentType: row.contentType, bytesBase64: row.bytesBase64 });
              result = await options.backend.request(publicationId, "upload", input, activeSignal, activated);
            } else if (row.op === "backend.file" && exact(row, ["id", "op", "fileId", "operation", "input"])) {
              if (typeof row.fileId !== "string" || row.fileId.length > 128 || !/^[A-Za-z0-9_-]{16,128}$/.test(row.fileId)) return reply(response, 400);
              const input = parseAppBackendInvokeRequest({ authorityRevision: authorityRevision, idempotencyKey: "file-read", operation: row.operation, input: row.input });
              result = await options.backend.readBrowserFile(publicationId, { authorityRevision: input.authorityRevision, fileId: row.fileId, operation: input.operation, input: input.input }, activeSignal);
            } else return reply(response, 400);
            activeSignal.throwIfAborted(); current();
            if (Buffer.byteLength(JSON.stringify(result)) > (row.op === "backend.file" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : collection ? APP_COLLECTION_RESPONSE_BYTES : APP_BACKEND_RESULT_BYTES)) return reply(response, 503);
            return reply(response, 200, result);
          } catch (error) {
            if (!response.headersSent && !response.destroyed) {
              if (isAppBackendRuntimeError(error)) {
                try { activeSignal.throwIfAborted(); current(); return reply(response, 409, parseAppBackendRefusal(error.refusal)); } catch {}
              }
              reply(response, error instanceof RangeError ? 413 : error instanceof LocalAppUnavailableError ? 503 : 404);
            }
          }
          finally { request.removeListener("aborted", requestAborted); if (admitted) pending--; }
        });
        server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 16;
        let stopped: Promise<void> | undefined;
        const stop = () => stopped ??= Promise.resolve().then(async () => {
          if (!ended.signal.aborted) ended.abort("ended");
          requestSignal.removeEventListener("abort", onAbort); controller.abort(); sessions.delete(stop); clearInterval(expiry); clearInterval(approvalCheck); stagedHtml = undefined; releaseStage();
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        });
        const onAbort = () => { void stop(); };
        const isAlive = () => {
          if (ended.signal.aborted || requestSignal.aborted) return false;
          if (Date.now() >= expires) { ended.abort("ended"); void stop(); return false; }
          try { options.backend.assertBrowserPublication(publicationId, authorityRevision); }
          catch (error) {
            if (error instanceof LocalAppUnavailableError) return true;
            ended.abort("needs-approval"); void stop(); return false;
          }
          return true;
        };
        const expiry = setInterval(isAlive, 1000); expiry.unref();
        let checking = false;
        const approvalCheck = launchOptions?.keepAlive && options.backend.checkBrowserPublication ? setInterval(() => {
          if (checking || !isAlive()) return;
          checking = true;
          void options.backend.checkBrowserPublication!(publicationId, authorityRevision, AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]))
            .catch(error => {
              if (!requestSignal.aborted && !(error instanceof LocalAppUnavailableError) &&
                  !(error instanceof DOMException && error.name === "TimeoutError")) { ended.abort("needs-approval"); void stop(); }
            }).finally(() => { checking = false; });
        }, 15_000) : undefined;
        approvalCheck?.unref();
        try {
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
          const address = server.address(); if (!address || typeof address === "string") throw Error("Could not open the local app.");
          origin = `http://127.0.0.1:${address.port}`;
          sessions.add(stop); requestSignal.addEventListener("abort", onAbort, { once: true });
          if (requestSignal.aborted || closed) { await stop(); throw Error("The local app session ended."); }
          return { url: origin + "/bootstrap#" + handoff, ended: ended.signal, isAlive, stop };
        } catch (error) { await stop(); throw error; }
      } catch (error) { releaseStage(); throw error; }
      finally { preparing--; }
    },
  };
  return host;
}
