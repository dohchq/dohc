import { createHash, randomBytes } from "node:crypto";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_DOCUMENT_BYTES, APP_PUBLICATION_MAX_BLOB_BYTES } from "@dohc/security-contract/app-publication";
import { readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import { createAppDocument, type AppDocumentFile } from "@dohc/app-browser/document";
import { parseAppLaunchConfig, type AppLaunchConfig } from "./appLaunchConfig";
import { isSessionDiscriminator } from "./sessionDiscriminator";
import type { LinkBrowserMaterial } from "./server";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { forwardAppCollection } from "./appCollectionProxy";
import { forwardAppBackend } from "./appBackendProxy";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PUBLICATION = /^[a-f0-9]{64}$/;
const COOKIE = "__Host-dohc-app";
const MAX_BUNDLE = APP_PUBLICATION_MAX_BUNDLE_BYTES, MAX_DOCUMENT = APP_PUBLICATION_MAX_DOCUMENT_BYTES;
const MAX_LAUNCHES = 512, MAX_PENDING = 4, HANDOFF_MS = 30_000, SESSION_MS = 10 * 60_000;
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
const refusal = () => Response.json({ ok: false, error: "not found" }, { status: 404, headers });
const unavailable = () => new Response(null, {status: 503, headers});
class RelayUnavailable extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys;
interface Descriptor { publicationId: string; authorityRevision: number; files: Omit<AppDocumentFile, "bytes">[] }
export type AppNamedBrowserMaterial =
  | { ok: true; kind: "named"; setCookie: string | null; fetchRelay(request: Request): Promise<Response> }
  | { ok: false; status: 401 | 403 | 404 | 503 };
type LaunchMaterial = Extract<LinkBrowserMaterial | AppNamedBrowserMaterial, { ok: true }>;
const namedMaterial = (material: LaunchMaterial): material is Extract<AppNamedBrowserMaterial, { ok: true }> => "kind" in material && material.kind === "named";
interface Launch { origin: string; publicationId: string; material: LaunchMaterial; revision: number; expires: number; handoffHash?: string; cookieHash?: string; proofHash?: string; staged?: ReturnType<typeof createAppDocument>; stagedExpires?: number }

async function boundedBytes(response: Request | Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
  try { while (true) { signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
    length += next.value.byteLength; if (length > max) throw new Error("Byte limit exceeded."); parts.push(next.value); }
    return Buffer.concat(parts, length);
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); }
}

/** Server-only launch bindings. Restart drops sessions; the viewer must issue a fresh handoff. */
export function createAppLaunchHandler(options: { config: AppLaunchConfig; relayUrl: string; nowMs?: () => number;
  fetchRelay(request: Request): Promise<Response>;
  resolveMaterial(discriminator: string, cookie: string | null, signal: AbortSignal): Promise<LinkBrowserMaterial>;
  resolveNamedMaterial?(workspaceId: string, publicationId: string, cookie: string | null, signal: AbortSignal): Promise<AppNamedBrowserMaterial> }) {
  const config = parseAppLaunchConfig(options.config), viewerHost = new URL(config.viewerOrigin).host;
  const now = options.nowMs ?? Date.now, launches = new Map<string, Launch>();
  const stagedSlots = new Set<Launch>();
  const issueRate = new TokenBucketLimiter(12, 0.2, 2048), sessionRate = new TokenBucketLimiter(12, 0.2, MAX_LAUNCHES);
  const collectionRate = new TokenBucketLimiter(12, 0.2, MAX_LAUNCHES); let pending = 0, statusPending = 0, collectionPending = 0;
  const hostPattern = new RegExp(`^[a-f0-9]{48}\\.${config.appDomain.replaceAll(".", "\\.")}$`);
  const appHost = (host: string) => hostPattern.test(host);
  async function fetchForLaunch(launch: Pick<Launch, "material">, request: Request) {
    const material = launch.material;
    if (namedMaterial(material)) {
      try { return await material.fetchRelay(request); }
      catch { throw new RelayUnavailable(); }
    }
    const capability = await material.currentCapability();
    if (!capability) return refusal();
    const send = (token: string) => {
      const headers = new Headers(request.headers);
      headers.set("authorization", `LinkCapability ${token}`);
      headers.set("x-dohc-link-profile-secret", material.profileSecret);
      return options.fetchRelay(new Request(request.clone(), {headers}));
    };
    try {
      const response = await send(capability);
      if (![401, 403, 404].includes(response.status)) return response;
      const current = await material.currentCapability();
      if (!current || current === capability) return response;
      await response.body?.cancel().catch(() => {});
      return await send(current);
    } catch { throw new RelayUnavailable(); }
  }
  async function relay(launch: Pick<Launch, "publicationId" | "material">, suffix: string, signal: AbortSignal) {
    return fetchForLaunch(launch, new Request(new URL(`/sync/link/app-publications/${launch.publicationId}${suffix}`, options.relayUrl),
      {signal, redirect: "manual"}));
  }
  async function descriptor(launch: Pick<Launch, "publicationId" | "material"> & { revision?: number }, signal: AbortSignal): Promise<Descriptor> {
    const response = await relay(launch, "", signal);
    try {
      if (response.status === 429 || response.status >= 500) throw new RelayUnavailable();
      if (response.status !== 200 || response.redirected || response.headers.has("location")) throw new Error("Unavailable publication.");
      const value = await readBoundedJson(response, 4096, signal);
      if (!exact(value, "authorityRevision,files,publicationId") || value.publicationId !== launch.publicationId ||
          !Number.isSafeInteger(value.authorityRevision) || (value.authorityRevision as number) < 1 ||
          (launch.revision !== undefined && launch.revision !== value.authorityRevision) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2) throw new Error("Invalid publication.");
      let total = 0; const paths = new Set<string>();
      for (const file of value.files) {
        if (!exact(file, "byteLength,contentType,path,sha256") || typeof file.path !== "string" || paths.has(file.path) ||
            !["bundle.js", "bundle.css"].includes(file.path) || file.contentType !== (file.path === "bundle.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8") ||
            typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0) throw new Error("Invalid bundle.");
        paths.add(file.path); if ((file.byteLength as number) > APP_PUBLICATION_MAX_BLOB_BYTES) throw new Error("Bundle file exceeds blob limit."); total += file.byteLength as number;
      }
      if (!paths.has("bundle.js") || total > MAX_BUNDLE) throw new Error("Invalid bundle size.");
      return value as unknown as Descriptor;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  async function document(launch: Launch, signal: AbortSignal) {
    const current = await descriptor(launch, signal), files: AppDocumentFile[] = [];
    for (const file of current.files) {
      const response = await relay(launch, `/blobs/${file.sha256}?authorityRevision=${launch.revision}`, signal);
      try { if (response.status === 429 || response.status >= 500) throw new RelayUnavailable();
        if (response.status !== 200 || response.redirected || response.headers.has("location") || !["text/javascript; charset=utf-8", "text/css; charset=utf-8"].includes(response.headers.get("content-type") ?? "")) throw new Error("Unavailable bundle.");
        files.push({ ...file, bytes: await boundedBytes(response, file.byteLength, signal) });
      } finally { await response.body?.cancel().catch(() => {}); }
    }
    return createAppDocument(files, { maxBundleBytes: MAX_BUNDLE, maxDocumentBytes: MAX_DOCUMENT });
  }
  function prune() { for (const [host, launch] of launches) {
    if (launch.stagedExpires !== undefined && launch.stagedExpires <= now()) {launch.staged = undefined; stagedSlots.delete(launch);}
    if (launch.expires <= now()) {launch.staged = undefined; stagedSlots.delete(launch); launches.delete(host);}
  } }
  return { matches(request: Request) { return appHost(request.headers.get("host") ?? "") || new URL(request.url).pathname === "/api/apps/launch"; },
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url), host = request.headers.get("host") ?? ""; prune();
      const statusRequest = url.pathname === "/status" && appHost(host);
      const collectionRequest = ["/collection", "/backend"].includes(url.pathname) && appHost(host);
      if (request.method !== "POST" || url.search || request.signal.aborted) return refusal();
      if (statusRequest ? statusPending >= 64 : collectionRequest ? collectionPending >= 16 : pending >= MAX_PENDING) return unavailable();
      const issue = host === viewerHost && url.pathname === "/api/apps/launch";
      if (!issue && !appHost(host)) return refusal();
      if (issue && !issueRate.allow(request.headers.get("x-dohc-share-web-client-ip") ?? "unknown", now())) return unavailable();
      if (statusRequest) statusPending++; else if (collectionRequest) collectionPending++; else pending++; const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
      try {
        if (issue) {
          if (request.headers.get("origin") !== config.viewerOrigin || request.headers.get("content-type") !== "application/json" || launches.size >= MAX_LAUNCHES) return refusal();
          const body = await readBoundedJson(request, 1024, signal);
          if (!body || typeof body !== "object" || Array.isArray(body) || !("publicationId" in body) || typeof body.publicationId !== "string" || body.publicationId.length !== 64 || !PUBLICATION.test(body.publicationId)) return refusal();
          const issueBody = body as Record<string, unknown>;
          let material: LinkBrowserMaterial | AppNamedBrowserMaterial;
          if (exact(issueBody, "discriminator,publicationId") && typeof issueBody.discriminator === "string" && isSessionDiscriminator(issueBody.discriminator)) {
            material = await options.resolveMaterial(issueBody.discriminator, request.headers.get("cookie"), signal);
          } else if (exact(issueBody, "publicationId,workspaceId") && typeof issueBody.workspaceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(issueBody.workspaceId) && !issueBody.workspaceId.includes("\n") && options.resolveNamedMaterial) {
            material = await options.resolveNamedMaterial(issueBody.workspaceId, issueBody.publicationId as string, request.headers.get("cookie"), signal);
          } else return refusal();
          if (!material.ok) return material.status === 503 ? unavailable() : refusal();
          const current = await descriptor({ publicationId: body.publicationId, material }, signal);
          signal.throwIfAborted(); if (launches.size >= MAX_LAUNCHES) return refusal(); const handoff = token(), launchHost = `${randomBytes(24).toString("hex")}.${config.appDomain}`;
          launches.set(launchHost, { origin: `https://${launchHost}`, publicationId: body.publicationId, material,
            revision: current.authorityRevision, expires: now() + HANDOFF_MS, handoffHash: hash(handoff) });
          return Response.json({ action: `https://${launchHost}/bootstrap`, handoff }, { headers: { ...headers, ...(material.setCookie ? { "set-cookie": material.setCookie } : {}) } });
        }
        const launch = launches.get(host); if (!launch) return refusal();
        if (url.pathname === "/bootstrap") {
          const origin = request.headers.get("origin");
          // The viewer's no-referrer policy makes cross-site form POSTs use Origin: null.
          if ((origin !== config.viewerOrigin && origin !== "null") || request.headers.get("content-type") !== "application/x-www-form-urlencoded" || !launch.handoffHash) return refusal();
          const form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(request, 128, signal)));
          const handoff = form.get("handoff"); if ([...form.keys()].join() !== "handoff" || !handoff || !TOKEN.test(handoff) || hash(handoff) !== launch.handoffHash) return refusal();
          if (stagedSlots.size >= 2) {
            const oldestReady = [...stagedSlots].find(value => value.staged !== undefined);
            if (!oldestReady) return unavailable();
            oldestReady.staged = undefined; stagedSlots.delete(oldestReady);
          }
          stagedSlots.add(launch);
          // Consume before awaiting authority or bytes: concurrent redemptions have one winner.
          delete launch.handoffHash;
          let doc: ReturnType<typeof createAppDocument>;
          try {doc = await document(launch, signal); signal.throwIfAborted();}
          catch (error) {stagedSlots.delete(launch); throw error;}
          launch.staged = doc; launch.stagedExpires = now() + HANDOFF_MS;
          if (launch.expires <= now()) { launch.staged = undefined; stagedSlots.delete(launch); launches.delete(host); return refusal(); }
          const cookie = token(), proof = token(); launch.cookieHash = hash(cookie); launch.proofHash = hash(proof); launch.expires = now() + SESSION_MS;
          const script = `(()=>{const proof=${JSON.stringify(proof)};let stopped=false;const frame=document.createElement('iframe');frame.title='Shared app';frame.sandbox='allow-scripts allow-forms allow-downloads';frame.style='display:block;border:0;width:100%;height:100vh';const lifetime=new AbortController();(${attachAppCollectionBroker.toString()})(frame,(body,signal)=>fetch(body.op.startsWith('backend.')?'/backend':'/collection',{method:'POST',headers:{'content-type':'application/json','x-dohc-app-proof':proof},credentials:'same-origin',cache:'no-store',body:JSON.stringify(body),signal}),lifetime.signal);const stop=()=>{stopped=true;lifetime.abort();frame.remove();document.getElementById('status').textContent='This app session ended. Reopen the share link.';};const call=path=>fetch(path,{method:'POST',headers:{'x-dohc-app-proof':proof},credentials:'same-origin',cache:'no-store'});const readDocument=async()=>{let r=await call('/document');if(r.status===503)r=await call('/document');return r;};readDocument().then(async r=>{if(!r.ok)throw Error();const html=await r.text();if(stopped)return;frame.srcdoc=html;document.body.append(frame);document.getElementById('status').textContent='';}).catch(stop);let misses=0;const poll=async()=>{if(stopped)return;try{const r=await call('/status');if(r.status===404){stop();return;}if(!r.ok)throw Error();misses=0;}catch{if(++misses>=2)stop();}if(!stopped)setTimeout(poll,15000);};setTimeout(poll,15000);setTimeout(stop,${SESSION_MS});addEventListener('pagehide',stop,{once:true});})();`;
          const source = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
          const csp = `default-src 'none'; script-src ${source} ${doc.scriptSources.join(" ")}; style-src 'unsafe-inline'; connect-src https: http: wss: ws:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
          return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared app</title></head><body style="margin:0"><p id="status" role="status" style="margin:0">Opening app</p><script>${script}</script></body></html>`,
            { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cross-origin-opener-policy": "same-origin", "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "set-cookie": `${COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` } });
        }
        const cookies = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
        const cookie = cookies.length === 1 ? cookies[0]!.slice(COOKIE.length + 1) : "", proof = request.headers.get("x-dohc-app-proof") ?? "";
        if (!launch.cookieHash || !TOKEN.test(cookie) || hash(cookie) !== launch.cookieHash || !TOKEN.test(proof) || hash(proof) !== launch.proofHash || request.headers.get("origin") !== launch.origin) return refusal();
        if (!(collectionRequest ? collectionRate : sessionRate).allow(host, now())) return unavailable();
        if (url.pathname === "/collection" && !namedMaterial(launch.material)) return await forwardAppCollection({request,relayUrl:options.relayUrl,publicationId:launch.publicationId,
          authorityRevision:launch.revision,capability:launch.material.capabilityToken,profileSecret:launch.material.profileSecret,signal,fetchRelay:request => fetchForLaunch(launch, request)});
        if (url.pathname === "/backend") return await forwardAppBackend({request,relayUrl:options.relayUrl,publicationId:launch.publicationId,
          authorityRevision:launch.revision,...(namedMaterial(launch.material)?{}:{capability:launch.material.capabilityToken,profileSecret:launch.material.profileSecret}),signal,fetchRelay:request => fetchForLaunch(launch, request)});
        if (url.pathname === "/status") { await descriptor(launch, signal); return new Response(null, { status: 204, headers }); }
        if (url.pathname !== "/document") return refusal();
        await descriptor(launch, signal); signal.throwIfAborted();
        const doc = launch.staged; launch.staged = undefined; stagedSlots.delete(launch);
        if (!doc) return refusal();
        if (launch.expires <= now()) return refusal();
        return new Response(doc.html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      } catch (error) { return error instanceof RelayUnavailable ? unavailable() : refusal(); } finally { if (statusRequest) statusPending--; else if (collectionRequest) collectionPending--; else pending--; }
    }
  };
}
