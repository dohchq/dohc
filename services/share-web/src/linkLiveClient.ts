import type {IncomingMessage} from "node:http";
import {WebSocket} from "ws";
import {readBoundedJson} from "@dohc/service-http";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveTicketToken} from "@dohc/live-session-contract/live-ticket";
import type {LinkBrowserMaterial} from "./server";
import type {LiveGatewayOptions, LiveGatewaySession, LiveGatewayHostRoute} from "./liveGateway";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "../viewer/src/namedLiveBrowserTransport";
import {isSessionDiscriminator} from "./sessionDiscriminator";

const exact = (value: unknown, keys: string): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
function browserRequest(request: IncomingMessage, origin: string, signal: AbortSignal): Request | null {
  const cookies: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === "cookie") cookies.push(request.rawHeaders[i + 1]!);
  return cookies.length === 1 ? new Request(new URL("/api/live/link", origin), {signal, headers: {cookie: cookies[0]!, host: new URL(origin).host, origin}}) : null;
}

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
  async function relayRequest(request: Request, discriminator: string, path: string, body: unknown, signal: AbortSignal) {
    const material = await options.resolveMaterial(discriminator, request.headers.get("cookie"), signal);
    signal.throwIfAborted();
    if (!material.ok) return null;
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > limits.maxRequestBytes) return null;
    const response = await options.fetchRelay(new Request(new URL(path, relay), {method: "POST", redirect: "manual", signal, body: encoded,
      headers: {"content-type": "application/json", authorization: `Bearer ${material.capabilityToken}`,
        "x-dohc-link-profile-secret": material.profileSecret, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey}}));
    try {
      signal.throwIfAborted();
      if (response.status !== 200 || response.redirected || response.headers.has("location") ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
      return {value: await readBoundedJson(response, limits.maxResponseBytes, signal), setCookie: material.setCookie};
    } finally {await response.body?.cancel().catch(() => {});}
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url), document = url.pathname === "/api/live/link-document";
    if ((!document && url.pathname !== "/api/live/link-ticket") || url.search || request.method !== "POST" ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || request.signal.aborted || pending >= limits.maxPendingRequests) return refused();
    pending++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limits.timeoutMs)]);
    try {
      const body = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (!exact(body, document ? "discriminator,path" : "discriminator,objectId") || typeof body.discriminator !== "string" || !isSessionDiscriminator(body.discriminator)) return refused();
      if (document ? typeof body.path !== "string" || body.path.length > 1024 || !/\.md$/i.test(body.path) : !parseLiveUpdateIdentifier(body.objectId)) return refused();
      const result = await relayRequest(request, body.discriminator, document ? "/sync/live/link-document" : "/sync/live/link-tickets", body, signal);
      if (!result) return refused();
      let output: unknown;
      if (document) {
        if (!exact(result.value, "objectId")) return refused();
        output = {objectId: parseLiveUpdateIdentifier(result.value.objectId), limits: browserLimits};
      } else {
        if (!exact(result.value, "expiresAtMs,token") || typeof result.value.expiresAtMs !== "number" || !Number.isSafeInteger(result.value.expiresAtMs) || result.value.expiresAtMs <= Date.now()) return refused();
        parseLiveTicketToken(result.value.token); output = result.value;
      }
      signal.throwIfAborted();
      const encoded = JSON.stringify(output);
      if (Buffer.byteLength(encoded) > browserLimits.maxHttpResponseBytes) return refused();
      return new Response(encoded, {headers: {"content-type": "application/json", "cache-control": "private, no-store",
        ...(result.setCookie ? {"set-cookie": result.setCookie} : {})}});
    } catch {return refused();}
    finally {pending--;}
  }
  const resolveSession: LiveGatewayOptions["resolveSession"] = async (incoming, discriminator, signal): Promise<LiveGatewaySession | null> => {
    const request = browserRequest(incoming, options.publicOrigin, signal);
    if (!request || pending >= limits.maxPendingRequests) return null;
    pending++;
    try {
      const result = await relayRequest(request, discriminator, "/sync/live/link-session", {discriminator}, signal);
      if (!result || !exact(result.value, "grantId,kind,principalId,sessionId,shareId,workspaceId") || result.value.kind !== "link") return null;
      const value = result.value;
      return {kind: "link", workspaceId: parseLiveUpdateIdentifier(value.workspaceId), shareId: parseLiveUpdateIdentifier(value.shareId),
        grantId: parseLiveUpdateIdentifier(value.grantId), principalId: parseLiveUpdateIdentifier(value.principalId), sessionId: parseLiveUpdateIdentifier(value.sessionId)};
    } catch {return null;}
    finally {pending--;}
  };
  const openHostRoute: LiveGatewayOptions["openHostRoute"] = async (input, signal, receive) => {
    const request = browserRequest(input.request, options.publicOrigin, signal);
    if (!request) return null;
    const material = await options.resolveMaterial(input.discriminator, request.headers.get("cookie"), signal);
    if (!material.ok || signal.aborted) return null;
    return new Promise<LiveGatewayHostRoute | null>(done => {
      const url = new URL("/sync/live/link", relay); url.protocol = relay.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("session", input.discriminator);
      const invalidated = new AbortController(); let socket: WebSocket | undefined, settled = false;
      const finish = (value: LiveGatewayHostRoute | null) => {if (!settled) {settled = true; done(value);}};
      const stop = () => {invalidated.abort(); socket?.terminate(); finish(null);};
      try {
        socket = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${input.ticketToken}`], {...receive, followRedirects: false, handshakeTimeout: limits.timeoutMs,
          headers: {origin: options.publicOrigin, authorization: `Bearer ${material.capabilityToken}`, "x-dohc-link-profile-secret": material.profileSecret,
            "x-dohc-relay-exchange-key": options.exchangeKey}});
        socket.on("error", stop); socket.once("close", () => {invalidated.abort(); signal.removeEventListener("abort", stop); finish(null);});
        socket.once("unexpected-response", (_request, response) => {response.destroy(); stop();});
        signal.addEventListener("abort", stop, {once: true}); if (signal.aborted) {stop(); return;}
        socket.once("open", () => {socket!.pause(); if (signal.aborted || socket!.protocol !== "dohc-live-v1" || socket!.extensions) {stop(); return;}
          finish({socket: socket!, invalidated: invalidated.signal});});
      } catch {stop();}
    });
  };
  return {handle, resolveSession, openHostRoute};
}
