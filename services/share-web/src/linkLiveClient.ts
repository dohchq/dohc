import {LIVE_CONNECTION_LIMIT_CLOSE_CODE, liveConnectionLimitMessage} from "@dohc/live-session-contract/live-connection";
import {createHash} from "node:crypto";
import type {IncomingMessage} from "node:http";
import {WebSocket} from "ws";
import {readBoundedJson} from "@dohc/service-http";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveTicketToken} from "@dohc/live-session-contract/live-ticket";
import type {LinkBrowserMaterial} from "./server";
import type {LiveGatewayOptions, LiveGatewaySession, LiveGatewayHostRoute} from "./liveGateway";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import {isSessionDiscriminator} from "./sessionDiscriminator";
import {linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";

type HostReceive = Parameters<LiveGatewayOptions["openHostRoute"]>[2];
/** The credential headers one relay call carries, and a renewed viewer cookie to pass on. */
type RelayCredential = {headers: Record<string, string>; setCookie: string | null};

/** A connected agent's live document access, with its own token on every relay call. */
export interface LinkLiveAgentAccess {
  document(path: string, signal: AbortSignal): Promise<Response>;
  ticket(objectId: string, signal: AbortSignal): Promise<Response>;
  open(ticketToken: string, signal: AbortSignal, receive: HostReceive): Promise<LiveGatewayHostRoute | null>;
}

const exact = (value: unknown, keys: string): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal, refusal: () => T): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<T>(resolve => {abort = () => resolve(refusal()); signal.addEventListener("abort", abort, {once: true});});
  if (signal.aborted) abort();
  try {return await Promise.race([work, cancelled]);}
  finally {signal.removeEventListener("abort", abort);}
}
function browserRequest(request: IncomingMessage, origin: string, signal: AbortSignal): Request | null {
  const cookies: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === "cookie") cookies.push(request.rawHeaders[i + 1]!);
  return cookies.length === 1 ? new Request(new URL("/api/live/link", origin), {signal, headers: {cookie: cookies[0]!, host: new URL(origin).host, origin}}) : null;
}
// Only what a live request is: its session, and a document path or an object.
const liveInput = (document: boolean, body: unknown): body is Record<string, unknown> =>
  exact(body, document ? "discriminator,path" : "discriminator,objectId") && typeof body.discriminator === "string" && isSessionDiscriminator(body.discriminator) &&
  (document ? typeof body.path === "string" && body.path.length <= 1024 && /\.md$/i.test(body.path) : !!parseLiveUpdateIdentifier(body.objectId));

/** Viewer credentials stay in protected cookies and private relay requests. */
export function createLinkLiveClient(options: {relayUrl: string; publicOrigin: string; exchangeKey: string;
  limits: NamedLiveBrowserClientLimits; browserLimits: NamedLiveBrowserLimits;
  resolveMaterial(discriminator: string, cookie: string | null, signal: AbortSignal): Promise<LinkBrowserMaterial>;
  fetchRelay(request: Request): Promise<Response>}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), browserLimits = parseNamedLiveBrowserLimits(options.browserLimits);
  const relay = new URL(options.relayUrl), origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32 ||
    !["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash) throw new TypeError("Invalid link live configuration.");
  const refused = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: {"cache-control": "private, no-store"}});
  let pending = 0;
  async function holder(discriminator: string, cookie: string | null, signal: AbortSignal): Promise<RelayCredential | null> {
    const material = await options.resolveMaterial(discriminator, cookie, signal);
    signal.throwIfAborted();
    return material.ok ? {setCookie: material.setCookie,
      headers: {authorization: `LinkCapability ${material.capabilityToken}`, "x-dohc-link-profile-secret": material.profileSecret}} : null;
  }
  async function relayRequest(credential: RelayCredential | null, path: string, body: unknown, signal: AbortSignal) {
    if (!credential) return null;
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > limits.maxRequestBytes) return null;
    const response = await options.fetchRelay(new Request(new URL(path, relay), {method: "POST", redirect: "manual", signal, body: encoded,
      headers: {"content-type": "application/json", ...credential.headers, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey}}));
    try {
      signal.throwIfAborted();
      if (response.redirected || response.headers.has("location") ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
      const value = await readBoundedJson(response, limits.maxResponseBytes, signal);
      if (response.status !== 200) {
        const code = parseLinkRefusal(value, response.status);
        return code ? {refusal: Response.json(linkRefusalBody(code), {status: response.status, headers: {"cache-control": "private, no-store"}})} : null;
      }
      return {value, setCookie: credential.setCookie};
    } finally {await response.body?.cancel().catch(() => {});}
  }
  // One admission for every live request, from a viewer or an agent.
  function admitted(parent: AbortSignal, run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (parent.aborted || pending >= limits.maxPendingRequests) return Promise.resolve(refused());
    pending++;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(limits.timeoutMs)]);
    const work = (async () => {
      try {return await run(signal);}
      catch {return refused();}
      finally {pending--;}
    })();
    // A transport that ignores cancellation keeps its admission slot until it settles.
    return untilAborted(work, signal, refused);
  }
  async function answer(document: boolean, body: Record<string, unknown>, credential: RelayCredential | null, signal: AbortSignal): Promise<Response> {
    const result = await relayRequest(credential, document ? "/sync/live/link-document" : "/sync/live/link-tickets", body, signal);
    if (!result) return refused();
    if (result.refusal) return result.refusal;
    let output: unknown;
    if (document) {
      if (!exact(result.value, "objectId")) return refused();
      output = {objectId: parseLiveUpdateIdentifier(result.value.objectId), limits: browserLimits};
    } else {
      if (!exact(result.value, "expiresAtMs,publicPrincipalId,token") || typeof result.value.expiresAtMs !== "number" || !Number.isSafeInteger(result.value.expiresAtMs) || result.value.expiresAtMs <= Date.now()) return refused();
      parseLiveTicketToken(result.value.token); parseLiveUpdateIdentifier(result.value.publicPrincipalId); output = result.value;
    }
    signal.throwIfAborted();
    const encoded = JSON.stringify(output);
    if (Buffer.byteLength(encoded) > browserLimits.maxHttpResponseBytes) return refused();
    return new Response(encoded, {headers: {"content-type": "application/json", "cache-control": "private, no-store",
      ...(result.setCookie ? {"set-cookie": result.setCookie} : {})}});
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url), document = url.pathname === "/api/live/link-document";
    if ((!document && url.pathname !== "/api/live/link-ticket") || url.search || request.method !== "POST" ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refused();
    return admitted(request.signal, async signal => {
      const body = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (!liveInput(document, body)) return refused();
      return answer(document, body, await holder(String(body.discriminator), request.headers.get("cookie"), signal), signal);
    });
  }
  const resolveSession: LiveGatewayOptions["resolveSession"] = async (incoming, discriminator, signal): Promise<LiveGatewaySession | null> => {
    const request = browserRequest(incoming, options.publicOrigin, signal);
    if (!request || pending >= limits.maxPendingRequests) return null;
    pending++;
    const work = (async (): Promise<LiveGatewaySession | null> => {
    try {
      const result = await relayRequest(await holder(discriminator, request.headers.get("cookie"), signal), "/sync/live/link-session", {discriminator}, signal);
      if (!result || "refusal" in result || !exact(result.value, "grantId,kind,principalId,sessionId,shareId,workspaceId") || result.value.kind !== "link") return null;
      const value = result.value;
      return {kind: "link", workspaceId: parseLiveUpdateIdentifier(value.workspaceId), shareId: parseLiveUpdateIdentifier(value.shareId),
        grantId: parseLiveUpdateIdentifier(value.grantId), principalId: parseLiveUpdateIdentifier(value.principalId), sessionId: parseLiveUpdateIdentifier(value.sessionId)};
    } catch {return null;}
    finally {pending--;}
    })();
    return untilAborted(work, signal, () => null);
  };
  const openHostRoute: LiveGatewayOptions["openHostRoute"] = async (input, signal, receive) => {
    const request = browserRequest(input.request, options.publicOrigin, signal);
    if (!request) return null;
    return openRoute(await holder(input.discriminator, request.headers.get("cookie"), signal).catch(() => null), input.discriminator, input.ticketToken, signal, receive);
  };
  function openRoute(credential: RelayCredential | null, discriminator: string, ticketToken: string, signal: AbortSignal, receive: HostReceive) {
    if (!credential || signal.aborted) return Promise.resolve(null);
    return new Promise<LiveGatewayHostRoute | null>(done => {
      const url = new URL("/sync/live/link", relay); url.protocol = relay.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("session", discriminator);
      const invalidated = new AbortController(); let socket: WebSocket | undefined, settled = false;
      const finish = (value: LiveGatewayHostRoute | null) => {if (!settled) {settled = true; done(value);}};
      const stop = () => {invalidated.abort(); socket?.terminate(); finish(null);};
      try {
        socket = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${ticketToken}`], {...receive, followRedirects: false, handshakeTimeout: limits.timeoutMs,
          headers: {origin: options.publicOrigin, ...credential.headers, "x-dohc-relay-exchange-key": options.exchangeKey}});
        socket.on("error", stop); socket.once("close", (code, reason) => {if (code !== LIVE_CONNECTION_LIMIT_CLOSE_CODE || !liveConnectionLimitMessage(reason.toString())) invalidated.abort(); signal.removeEventListener("abort", stop); finish(null);});
        socket.once("unexpected-response", (_request, response) => {response.destroy(); stop();});
        signal.addEventListener("abort", stop, {once: true}); if (signal.aborted) {stop(); return;}
        socket.once("open", () => {socket!.pause(); if (signal.aborted || socket!.protocol !== "dohc-live-v1" || socket!.extensions) {stop(); return;}
          finish({socket: socket!, invalidated: invalidated.signal});});
      } catch {stop();}
    });
  }
  /**
   * An agent's live access through its MCP request. The token and address go
   * on every relay call and socket, as on its other link routes, and the
   * session name comes from the address, so it is the same on every request.
   */
  function agent(input: {accessToken: string; resource: string}): LinkLiveAgentAccess {
    const discriminator = createHash("sha256").update(input.resource).digest("base64url").slice(0, 12);
    const credential: RelayCredential = {setCookie: null,
      headers: {authorization: `DohcAgent ${input.accessToken}`, "x-dohc-agent-resource": input.resource}};
    const call = (document: boolean, body: Record<string, unknown>, signal: AbortSignal) =>
      admitted(signal, async admittedSignal => liveInput(document, body) ? answer(document, body, credential, admittedSignal) : refused());
    return {
      document: (path, signal) => call(true, {discriminator, path}, signal),
      ticket: (objectId, signal) => call(false, {discriminator, objectId}, signal),
      open: (ticketToken, signal, receive) => openRoute(credential, discriminator, ticketToken, signal, receive),
    };
  }
  return {handle, resolveSession, openHostRoute, agent};
}
