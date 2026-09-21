import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAppDocument } from "@dohc/app-browser/document";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_DOCUMENT_BYTES } from "@dohc/security-contract/app-publication";
import { APP_BACKEND_REQUEST_BYTES, APP_BACKEND_RESULT_BYTES, APP_BACKEND_UPLOAD_REQUEST_BYTES,
  parseAppBackendInvokeRequest, parseAppBackendUploadRequest } from "@dohc/security-contract/app-backend";
import type { LocalAppBackendHost } from "./localAppBackend";

type Backend = Pick<LocalAppBackendHost, "browserPublication" | "request" | "readBrowserFile">;
export interface LocalAppLaunchHost {
  launch(publicationId: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
const MAX_SESSIONS = 16, HANDOFF_MS = 30_000, SESSION_MS = 30 * 60_000;
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
export async function createLocalAppLaunchHost(options: { backend: Backend; lifetime: AbortSignal }): Promise<LocalAppLaunchHost> {
  options.lifetime.throwIfAborted();
  const sessions = new Set<() => Promise<void>>();
  let closed = false, preparing = 0, staged = 0;
  const close = async () => { closed = true; await Promise.all([...sessions].map(stop => stop())); };
  options.lifetime.addEventListener("abort", () => { void close(); }, { once: true });
  return {
    close,
    async launch(publicationId, signal) {
      signal.throwIfAborted(); options.lifetime.throwIfAborted();
      if (closed || sessions.size + preparing >= MAX_SESSIONS || staged >= 2) throw Error("Close another app before opening this one.");
      preparing++; staged++;
      let stageReleased = false;
      const releaseStage = () => { if (!stageReleased) { stageReleased = true; staged--; } };
      try {
        const { authorityRevision, files } = options.backend.browserPublication(publicationId);
        const document = createAppDocument(files, { maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES, maxDocumentBytes: APP_PUBLICATION_MAX_DOCUMENT_BYTES });
        let stagedHtml: string | undefined = document.html;
        const handoff = token(), proof = token(), controller = new AbortController();
        const requestSignal = AbortSignal.any([signal, options.lifetime, controller.signal]);
        let handoffDigest: string | null = digest(handoff), origin = "", pending = 0, tokens = 12, updated = Date.now();
        let expires = Date.now() + HANDOFF_MS;
        const common = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
        const reply = (response: ServerResponse, status: number, body?: unknown) => {
          response.writeHead(status, { ...common, ...(body === undefined ? {} : { "content-type": "application/json" }) });
          response.end(body === undefined ? undefined : JSON.stringify(body));
        };
        const current = () => {
          requestSignal.throwIfAborted();
          if (Date.now() >= expires) throw Error("The local app session expired.");
          const latest = options.backend.browserPublication(publicationId);
          if (latest.authorityRevision !== authorityRevision) throw Error("The local app approval changed.");
        };
        const script = `(()=>{const handoff=location.hash.slice(1);history.replaceState(null,'','/bootstrap');const lifetime=new AbortController();let frame,stopped=false;const stop=()=>{stopped=true;lifetime.abort();frame?.remove();document.getElementById('status').textContent='This app session ended. Open the app again in dohc.';};addEventListener('pagehide',stop,{once:true});fetch('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handoff}),signal:lifetime.signal}).then(async r=>{if(!r.ok)throw Error();const value=await r.json();if(stopped)return;const proof=value.proof;frame=document.createElement('iframe');frame.title='Local app';frame.sandbox='allow-scripts allow-forms allow-downloads';frame.style='display:block;border:0;width:100%;height:100vh';(${attachAppCollectionBroker.toString()})(frame,(body,signal)=>fetch('/backend',{method:'POST',headers:{'content-type':'application/json','x-dohc-app-proof':proof},body:JSON.stringify(body),signal}),lifetime.signal);frame.srcdoc=value.html;document.body.append(frame);document.getElementById('status').textContent='';const poll=async()=>{if(stopped)return;try{const r=await fetch('/status',{method:'POST',headers:{'x-dohc-app-proof':proof},signal:lifetime.signal});if(!r.ok){stop();return;}}catch{stop();return;}setTimeout(poll,15000);};setTimeout(poll,15000);setTimeout(stop,${SESSION_MS});}).catch(stop);})();`;
        const scriptHash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
        const csp = `default-src 'none'; script-src ${scriptHash} ${document.scriptSources.join(" ")}; style-src 'unsafe-inline'; connect-src http: https: ws: wss:; img-src data: blob: http: https:; font-src data: http: https:; media-src data: blob: http: https:; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local app</title></head><body style="margin:0"><p id="status" role="status">Opening app</p><script>${script}</script></body></html>`;
        const server = createServer(async (request, response) => {
          const abort = new AbortController(), requestAborted = () => abort.abort();
          request.once("aborted", requestAborted);
          const activeSignal = AbortSignal.any([requestSignal, abort.signal, AbortSignal.timeout(15_000)]);
          let admitted = false;
          try {
            const url = new URL(request.url ?? "/", origin);
            if (request.headers.host !== new URL(origin).host || url.origin !== origin || url.search || url.hash || !["/bootstrap", "/session", "/backend", "/status"].includes(url.pathname)) return reply(response, 404);
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
              current(); handoffDigest = null; expires = Date.now() + SESSION_MS;
              const html = stagedHtml; stagedHtml = undefined; releaseStage();
              return reply(response, 200, { proof, html });
            }
            if (handoffDigest !== null || typeof request.headers["x-dohc-app-proof"] !== "string" || digest(request.headers["x-dohc-app-proof"]) !== digest(proof)) return reply(response, 404);
            if (url.pathname === "/status") return reply(response, 204);
            if (url.pathname !== "/backend") return reply(response, 404);
            const now = Date.now(); tokens = Math.min(12, tokens + (now - updated) / 5000); updated = now;
            if (pending >= 4 || tokens < 1) return reply(response, 429);
            tokens--; pending++; admitted = true;
            const body = await readJson(request, APP_BACKEND_UPLOAD_REQUEST_BYTES, activeSignal);
            if (!body || typeof body !== "object" || Array.isArray(body)) return reply(response, 400);
            const row = body as Record<string, unknown>;
            if (typeof row.id !== "string" || row.id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(row.id)) return reply(response, 400);
            if (row.op !== "backend.upload" && Buffer.byteLength(JSON.stringify(row)) > APP_BACKEND_REQUEST_BYTES) return reply(response, 413);
            let result: unknown;
            if (row.op === "backend.invoke" && exact(row, ["id", "op", "operation", "idempotencyKey", "input"])) {
              const input = parseAppBackendInvokeRequest({ authorityRevision: authorityRevision, operation: row.operation, idempotencyKey: row.idempotencyKey, input: row.input });
              result = await options.backend.request(publicationId, "invoke", input, activeSignal);
            } else if (row.op === "backend.upload" && exact(row, ["id", "op", "idempotencyKey", "name", "contentType", "bytesBase64"])) {
              const input = parseAppBackendUploadRequest({ authorityRevision: authorityRevision, idempotencyKey: row.idempotencyKey, name: row.name, contentType: row.contentType, bytesBase64: row.bytesBase64 });
              result = await options.backend.request(publicationId, "upload", input, activeSignal);
            } else if (row.op === "backend.file" && exact(row, ["id", "op", "fileId", "operation", "input"])) {
              if (typeof row.fileId !== "string" || row.fileId.length > 128 || !/^[A-Za-z0-9_-]{16,128}$/.test(row.fileId)) return reply(response, 400);
              const input = parseAppBackendInvokeRequest({ authorityRevision: authorityRevision, idempotencyKey: "file-read", operation: row.operation, input: row.input });
              result = await options.backend.readBrowserFile(publicationId, { authorityRevision: input.authorityRevision, fileId: row.fileId, operation: input.operation, input: input.input }, activeSignal);
            } else return reply(response, 400);
            activeSignal.throwIfAborted(); current();
            if (Buffer.byteLength(JSON.stringify(result)) > (row.op === "backend.file" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : APP_BACKEND_RESULT_BYTES)) return reply(response, 503);
            return reply(response, 200, result);
          } catch (error) { if (!response.headersSent && !response.destroyed) reply(response, error instanceof RangeError ? 413 : 404); }
          finally { request.removeListener("aborted", requestAborted); if (admitted) pending--; }
        });
        server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 16;
        let stopped: Promise<void> | undefined;
        const stop = () => stopped ??= Promise.resolve().then(async () => {
          requestSignal.removeEventListener("abort", onAbort); controller.abort(); sessions.delete(stop); clearInterval(expiry); stagedHtml = undefined; releaseStage();
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        });
        const onAbort = () => { void stop(); };
        const expiry = setInterval(() => { if (Date.now() >= expires) void stop(); }, 1000); expiry.unref();
        try {
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
          const address = server.address(); if (!address || typeof address === "string") throw Error("Could not open the local app.");
          origin = `http://127.0.0.1:${address.port}`;
          sessions.add(stop); requestSignal.addEventListener("abort", onAbort, { once: true });
          if (requestSignal.aborted || closed) { await stop(); throw Error("The local app session ended."); }
          return origin + "/bootstrap#" + handoff;
        } catch (error) { await stop(); throw error; }
      } catch (error) { releaseStage(); throw error; }
      finally { preparing--; }
    },
  };
}
