import {LIVE_CONNECTION_LIMIT_CLOSE_CODE, LiveConnectionLimitError, type LiveConnectionLimitCode} from "@dohc/live-session-contract/live-connection";
import { isDeepStrictEqual } from "node:util";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { readBoundedJson, refuseDeviceControl } from "@dohc/service-http";
import { parseLiveTicketAudience, parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import { createLiveFrameSession, LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, type LiveFrameSessionPolicy } from "@dohc/live-session-contract/live-frame";
import { parseLiveUpdateIdentifier, parseLiveUpdateDigest, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { SyncRelayStorage } from "./storage.js";
import type { createLiveTickets } from "./liveTickets.js";
import { liveBrowserActor, type LiveBrowserContext } from "./liveBrowserContext.js";
import type { CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity.js";
import { captureNamedLiveFrameHost, captureOwnerLiveFrameHost, type NamedFrameValidationBudget, type NamedFrameHostBounds, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { createNamedLiveFrameSession, type NamedFrameHostSession } from "./namedLiveFrameSession.js";
import type { createLiveMembershipRegistry, LiveMembershipSession } from "./liveMembership.js";
import {createLiveConnectionAdmission} from "./liveConnectionAdmission";
import {authorizeLinkShareAction} from "./shareAuthorization";
import {createAccountlessPathProjection} from "./accountlessPathProjection";
import {linkRefusal} from "./linkRefusal";
import { accountDisplayName } from "./accountDisplayName";
import type { TrustedLiveAccount } from "./storage/liveAuthorSnapshot";
import { liveEditors } from "./liveEditors.js";

export interface NamedLiveRouteLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerWorkspace: number;
  readonly reservedOwnerConnections: number;
  readonly maxConnectionsPerSession: number;
  readonly maxConnectionsPerPrincipal: number;
  readonly maxConnectionsPerGrant: number;
  readonly maxPendingRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxPendingBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly upgradeTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly drainTimeoutMs: number;
}
export function parseNamedLiveRouteLimits(value: unknown): NamedLiveRouteLimits {
  const names = ["maxConnections", "maxConnectionsPerWorkspace", "reservedOwnerConnections", "maxConnectionsPerSession", "maxConnectionsPerPrincipal", "maxConnectionsPerGrant",
    "maxPendingRequests", "maxRequestBytes", "maxResponseBytes", "maxBufferedBytes", "maxPendingBytes", "maxFragments", "maxBufferedChunks",
    "upgradeTimeoutMs", "idleTimeoutMs", "drainTimeoutMs"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.sort().join()) throw new TypeError("Invalid named route limits.");
  const limits = { ...value } as NamedLiveRouteLimits;
  if (Object.values(limits).some(number => !Number.isSafeInteger(number) || number < 0 || number > 2_147_483_647)) throw new TypeError("Invalid named route limits.");
  if (Object.entries(limits).some(([key, value]) => key !== "reservedOwnerConnections" && value < 1) ||
    limits.reservedOwnerConnections >= Math.min(limits.maxConnections, limits.maxConnectionsPerWorkspace)) throw new TypeError("Invalid named route limits.");
  return limits;
}

interface LiveRouteOptions {
  storage: SyncRelayStorage;
  hosts: ReadonlySet<string>;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveRouteLimits;
  frames: LiveFrameSessionPolicy;
  bounds: NamedFrameHostBounds;
  captureNative(binding: LiveObjectBinding, signal: AbortSignal): Promise<NamedFrameNativeHost>;
  validate: CapacityLiveAdmissionValidator;
  lookupUserDisplayName?: (userId: string) => Promise<string | null> | string | null;
  admission?: ReturnType<typeof createLiveConnectionAdmission>;
}
type BrowserRouteOptions = LiveRouteOptions & {
  kind: "named" | "link";
  desktopBearer?: boolean;
  sessions: { resolve(request: Request, discriminator: string, access?: "read" | "edit"): Promise<LiveBrowserContext | null> };
  tickets: ReturnType<typeof createLiveTickets>;
  membership?: Pick<ReturnType<typeof createLiveMembershipRegistry>, "join">;
  /** Whether the session host cannot continue the document until its owner or operator acts. */
  sessionHostBlocked?: (document: {workspaceId: string; objectId: string}) => boolean;
};
type OwnerRouteOptions = LiveRouteOptions & { kind: "owner"; resolveActor: ResolveActor };
export function createNamedLiveRoutes(options: BrowserRouteOptions) { return createLiveRoutes(options); }
export function createOwnerLiveRoutes(options: Omit<OwnerRouteOptions, "kind">) {
  return createLiveRoutes({ ...options, kind: "owner" });
}
function createLiveRoutes(input: BrowserRouteOptions | OwnerRouteOptions) {
  const options = input.kind === "owner" ? {...input, resolveActor: input.resolveActor.bind(input)} :
    {...input, sessions: {resolve: input.sessions.resolve.bind(input.sessions)}};
  const limits = parseNamedLiveRouteLimits(options.limits), hosts = new Set(options.hosts);
  const kind = options.kind;
  const desktop = options.kind === "named" && options.desktopBearer === true;
  const routeKind = desktop ? "desktop" : kind;
  if (kind !== "named" && kind !== "link" && kind !== "owner") throw new TypeError("Explicit live route kind required.");
  const origin = parseLiveTicketAudience(options.publicOrigin), keyHash = hashRelayExchangeKey(options.exchangeKey);
  if (!origin.startsWith("https:") || options.exchangeKey.length < 32 || hosts.size === 0 || [...hosts].some(host => !host || new URL(`http://${host}`).host !== host)) {
    throw new TypeError("Named routes require explicit relay hosts, HTTPS audience, and exchange key.");
  }
  const frames = { ...options.frames, receive: { ...options.frames.receive } }, bounds = { ...options.bounds };
  createLiveFrameSession("server", frames).close();
  if (frames.receive.maxFrameBytes > limits.maxPendingBytes) throw new TypeError("Named route send capacity is smaller than one frame.");
  // Only the owner route admits an agent declaration, so only it must receive the largest declared submission.
  if (kind === "owner" && (frames.receive.maxFrameBytes < LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES ||
    frames.maxControlBytes < LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES)) {
    throw new TypeError("The owner route must receive the largest declared submission.");
  }
  const wsOptions = { noServer: true as const, clientTracking: false, perMessageDeflate: false as const, autoPong: false,
    maxPayload: frames.receive.maxFrameBytes, maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks,
    closeTimeout: limits.drainTimeoutMs, handleProtocols: () => "dohc-live-v1" };
  const server = new WebSocketServer(wsOptions);
  const connections = new Set<() => void>(), admission = options.admission ?? createLiveConnectionAdmission();
  const buffers = admission.buffers(limits.maxBufferedBytes), validationBuffers = admission.validationBuffers(limits.maxBufferedBytes);
  const connectionScopes = new Map<() => void, {userId?: string; workspaceId: string}>();
  const shutdown = new AbortController();
  const storage = options.storage, editors = liveEditors(storage);
  const captureNative = options.captureNative.bind(options), validate = options.validate;
  const sessionHostBlocked = options.kind === "owner" ? undefined : options.sessionHostBlocked;
  const accountSnapshot = async (accountId: string): Promise<TrustedLiveAccount> => ({accountId,
    name: await accountDisplayName(options.lookupUserDisplayName,accountId) ?? "Unnamed"});

  let closed = false, pendingRequests = 0;
  const refusal = () => Response.json({ ok: false, error: "not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  const trusted = (headers: Headers) => hosts.has(headers.get("host") ?? "") && (desktop
    ? (!headers.has("origin") || headers.get("origin") === origin) && /^Bearer [^\s]+$/.test(headers.get("authorization") ?? "") && !headers.has("cookie")
    : headers.get("origin") === origin && verifyRelayExchangeKey(headers.get("x-dohc-relay-exchange-key"), keyHash));
  const credentials = (headers: Headers): Record<string, string> => (kind === "owner" || desktop) ? { authorization: headers.get("authorization") ?? "" } : kind === "named" ? { cookie: headers.get("cookie") ?? "" } :
    { authorization: headers.get("authorization") ?? "", "x-dohc-link-profile-secret": headers.get("x-dohc-link-profile-secret") ?? "" };
  const sessionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{12}$/.test(value);
  server.on("wsClientError", (_error, socket) => refuseDeviceControl(socket, limits.drainTimeoutMs));

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (options.kind === "owner" || desktop || closed || storage.unavailable.aborted || url.pathname !== `/sync/live/${kind}-tickets` || url.search || request.method !== "POST" || !trusted(request.headers) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || pendingRequests >= limits.maxPendingRequests || request.signal.aborted) return refusal();
    pendingRequests++;
    const controller = new AbortController(), signal = AbortSignal.any([request.signal, storage.unavailable, shutdown.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), limits.upgradeTimeoutMs);
    let cancel!: () => void;
    const cancelled = new Promise<Response>(done => { cancel = () => done(refusal()); signal.addEventListener("abort", cancel, { once: true }); });
    const work = (async () => {
      try {
        const check = storage.captureStanding();
        const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "discriminator,objectId") return refusal();
        const { discriminator, objectId } = input as Record<string, unknown>;
        if (!sessionId(discriminator)) return refusal();
        parseLiveUpdateIdentifier(objectId);
        const authenticated = new Request(request.url, { headers: credentials(request.headers), signal });
        const context = await options.sessions.resolve(authenticated, discriminator, "read"); signal.throwIfAborted(); check();
        if (!context || context.kind !== kind) return refusal();
        if (context.kind === "link") {
          const authority = authorizeLinkShareAction({storage, grantId: context.grantId, action: "read"});
          if (!authority.ok) return refusal();
          const path = storage.objectMoment({workspaceId: context.workspaceId, objectId: objectId as string,
            versionId: authority.effectiveSelector.versionId ?? "main"})?.path;
          if (!path || createAccountlessPathProjection(authority.effectiveSelector).projectPath(path) === null ||
              storage.objectIdAtPathInVersion({workspaceId: context.workspaceId, versionId: authority.effectiveSelector.versionId ?? "main", path}) !== objectId) return refusal();
          if (authority.effectiveSelector.access === "view") return linkRefusal("link_view_access");
          if (authority.effectiveSelector.access === "comment") return linkRefusal("link_comment_access");
          const binding = storage.resolveLiveObjectHostBinding(context, objectId as string);
          if (binding.kind === "refused") return binding.reason === "host-unavailable" || binding.reason === "stale-document"
            ? linkRefusal("link_live_unavailable") : refusal();
        }
        if (sessionHostBlocked?.({workspaceId: context.workspaceId, objectId: objectId as string}))
          return context.kind === "link" ? linkRefusal("link_live_unavailable") : refusal();
        const minted = await options.tickets.mint({ objectId }, context, signal); signal.throwIfAborted(); check();
        if (!minted) return refusal();
        const body = JSON.stringify(minted);
        if (Buffer.byteLength(body) > limits.maxResponseBytes) return refusal();
        return new Response(body, { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      } catch { return refusal(); }
      finally { pendingRequests--; clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    })();
    return Promise.race([work, cancelled]);
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let headers: Headers;
    let discriminator = "", token = "";
    let ownerTarget: {document: LiveDocumentKey; shareId: string} | undefined;
    try {
      headers = new Headers();
      const selected = new Set(["host", "origin", "cookie", "authorization", "x-dohc-link-profile-secret", "sec-websocket-protocol", "x-dohc-relay-exchange-key"]);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!.toLowerCase();
        if (!selected.has(name)) continue;
        if (headers.has(name)) throw new Error();
        headers.set(name, request.rawHeaders[index + 1]!);
      }
      if (kind === "owner") {
        const url = new URL(request.url ?? "", "https://owner.invalid");
        const path = /^\/sync\/workspaces\/([^/]+)\/live\/owner$/.exec(url.pathname);
        if (!path || request.method !== "GET" || !hosts.has(headers.get("host") ?? "") ||
            (headers.has("origin") && headers.get("origin") !== origin) ||
            !/^Bearer [^\s]+$/.test(headers.get("authorization") ?? "") ||
            headers.get("sec-websocket-protocol") !== "dohc-live-v1" ||
            [...url.searchParams.keys()].sort().join() !== "lineageClaimId,objectId,shareId") throw new Error();
        ownerTarget = {document: {workspaceId: parseLiveUpdateIdentifier(decodeURIComponent(path[1]!)), mainVersionId: "main",
          objectId: parseLiveUpdateIdentifier(url.searchParams.get("objectId")),
          lineageClaimId: parseLiveUpdateDigest(url.searchParams.get("lineageClaimId"))},
          shareId: parseLiveUpdateIdentifier(url.searchParams.get("shareId"))};
      } else {
        const path = new RegExp(`^/sync/live/${routeKind}\\?session=([A-Za-z0-9_-]{12})$`).exec(request.url ?? "");
        const protocols = headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim());
        if (!path || request.method !== "GET" || !trusted(headers) || protocols?.length !== 2 || protocols.filter(value => value === "dohc-live-v1").length !== 1) throw new Error();
        discriminator = path[1]!;
        const credential = protocols.find(value => value.startsWith("dohc-live-ticket."));
        token = credential?.slice("dohc-live-ticket.".length) ?? "";
        parseLiveTicketToken(token);
      }
    } catch { refuseDeviceControl(socket, limits.drainTimeoutMs); return; }
    if (closed || storage.unavailable.aborted || head.length > limits.maxPendingBytes) {
      refuseDeviceControl(socket, limits.drainTimeoutMs); return;
    }
    const releaseConnection = admission.reserve([["connections", limits.maxConnections]]);
    const releaseRefusal = !releaseConnection ? admission.reserve([["upgrade-refusals", limits.maxPendingRequests]]) : undefined;
    if (!releaseConnection && !releaseRefusal) {refuseDeviceControl(socket, limits.drainTimeoutMs); return;}
    socket.pause();
    const lifetime = new AbortController(), signal = AbortSignal.any([lifetime.signal, storage.unavailable, shutdown.signal]);
    let ws: WebSocket | undefined, host: NamedFrameHostSession | undefined, session: ReturnType<typeof createNamedLiveFrameSession> | undefined;
    let membership: LiveMembershipSession | undefined;
    let reserveBytes: (size: number) => () => void = buffers.reserve;
    let validationBudget: NamedFrameValidationBudget | undefined;
    let closingForLimit = false;
    let done = false, opening = true, releaseAuthority: (() => void) | undefined, releaseEditor: (() => void) | undefined;
    let timer = setTimeout(stop, limits.upgradeTimeoutMs);
    async function release() {
      if (opening || !done) return;
      await session?.settled();
      if (closingForLimit && ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => ws!.once("close", resolve));
      connectionScopes.delete(stop);
      if (!connections.delete(stop)) return;
      releaseEditor?.(); releaseAuthority?.(); releaseConnection?.(); releaseRefusal?.();
    }
    function refuseLimit(code: LiveConnectionLimitCode) {
      if (done || socket.destroyed) return;
      if (!ws) server.handleUpgrade(request, socket, Buffer.alloc(0), accepted => { ws = accepted; accepted.on("error", stop); });
      if (ws) {
        closingForLimit = true;
        ws.close(LIVE_CONNECTION_LIMIT_CLOSE_CODE, code);
        socket.resume();
        const deadline = setTimeout(() => ws?.terminate(), limits.drainTimeoutMs); deadline.unref();
        ws.once("close", () => clearTimeout(deadline));
      }
      stop();
    }
    function stop() {
      if (done) return;
      done = true; clearTimeout(timer); lifetime.abort();
      signal.removeEventListener("abort", stop);
      host?.invalidated.removeEventListener("abort", stop);
      membership?.invalidated.removeEventListener("abort", stop);
      membership?.close();
      session?.close(); host?.close();
      if (ws) { if (!closingForLimit) ws.terminate(); } else refuseDeviceControl(socket, limits.drainTimeoutMs);
      void release();
    }
    const touch = () => { if (done) return; clearTimeout(timer); timer = setTimeout(stop, limits.idleTimeoutMs); timer.unref(); };
    signal.addEventListener("abort", stop, { once: true });
    connections.add(stop); socket.once("close", stop); socket.once("error", stop);
    try {
      const check = storage.captureStanding();
      const authenticated = new Request(new URL(request.url!, `https://${headers.get("host")}`), { headers: credentials(headers), signal });
      function reserve(reservations: [string, number, LiveConnectionLimitCode][], principal: string, workspaceId: string, shareId?: string) {
        if (!releaseConnection) throw new LiveConnectionLimitError("live_total_limit");
        const release = admission.reserve([
          [JSON.stringify(["workspace", workspaceId]), limits.maxConnectionsPerWorkspace, "live_workspace_limit"],
          ...(kind === "owner" ? [] : [
            ["non-owner", limits.maxConnections - limits.reservedOwnerConnections, "live_total_limit"],
            [JSON.stringify(["non-owner-workspace", workspaceId]), limits.maxConnectionsPerWorkspace - limits.reservedOwnerConnections, "live_workspace_limit"],
          ] as [string, number, LiveConnectionLimitCode][]),
          ...reservations,
        ]);
        if (!release) throw new Error("Live connection limit reached.");
        releaseAuthority = release;
        const scopes: [string, number][] = [[principal, Math.max(1, Math.floor(limits.maxBufferedBytes *
          Math.min(1, limits.maxConnectionsPerPrincipal / limits.maxConnections)))]];
        if (kind !== "owner") scopes.push([JSON.stringify(["workspace", workspaceId]), Math.max(1, Math.floor(limits.maxBufferedBytes *
          Math.min(1, (limits.maxConnectionsPerWorkspace - limits.reservedOwnerConnections) / limits.maxConnections)))]);
        if (shareId) scopes.push([JSON.stringify(["share", workspaceId, shareId]), Math.max(1, Math.floor(limits.maxBufferedBytes *
          Math.min(1, limits.maxConnectionsPerGrant / limits.maxConnections)))]);
        reserveBytes = size => buffers.reserve(size, scopes);
        validationBudget = {reserve: () => admission.reserve([[JSON.stringify(["validation", principal]), 1]]),
          maxBytes: limits.maxBufferedBytes, reserveBytes: validationBuffers.reserve};
      }
      if (options.kind === "owner") {
        const {document, shareId} = ownerTarget!;
        const actor = await options.resolveActor(authenticated, document.workspaceId); signal.throwIfAborted(); check();
        connectionScopes.set(stop, {userId: actor.userId, workspaceId: document.workspaceId});
        if (actor.workspaceId !== document.workspaceId || !storage.workspaceIsOwnedBy(document.workspaceId, actor.userId)) throw new Error();
        const current = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: actor.userId, shareId}});
        if (current.kind !== "current") throw new Error();
        reserve([
          [JSON.stringify(["owner-document", actor.userId, document.workspaceId, document.objectId]), limits.maxConnectionsPerSession, "live_session_limit"],
          [JSON.stringify(["principal", "named", actor.userId]), limits.maxConnectionsPerPrincipal, "live_person_limit"],
          [JSON.stringify(["owner-share", document.workspaceId, shareId]), limits.maxConnectionsPerGrant, "live_grant_limit"],
        ], JSON.stringify(["principal", "named", actor.userId]), document.workspaceId);
        // Counted before capture, so the host cannot unload the document while this connection opens.
        releaseEditor = editors.acquire(document);
        const native = await captureNative(current.binding, signal); signal.throwIfAborted(); check();
        if (!isDeepStrictEqual({...native.binding, selectorPaths: current.binding.selectorPaths}, current.binding)) throw new Error("Native owner target changed.");
        const refreshed = storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: actor.userId, shareId}});
        if (!isDeepStrictEqual(refreshed, current)) throw new Error("Owner binding changed during capture.");
        const trustedAccount = await accountSnapshot(actor.userId); signal.throwIfAborted(); check();
        host = captureOwnerLiveFrameHost({authenticatedUserId: actor.userId, trustedAccount, shareId, storage, native, bounds, validate, reserveBytes, validationBudget});
      } else {
        const context = await options.sessions.resolve(authenticated, discriminator); signal.throwIfAborted(); check();
        if (!context || context.kind !== kind) { stop(); return; }
        connectionScopes.set(stop, {workspaceId: context.workspaceId, ...(context.kind === "named" ? {userId: context.userId} : {})});
        const principalKey = context.kind === "named" ? context.userId : context.profileTokenHash;
        const reservations: [string, number, LiveConnectionLimitCode][] = [
          [JSON.stringify(["session", context.kind, principalKey, context.workspaceId, context.grantId, discriminator]), limits.maxConnectionsPerSession, "live_session_limit"],
          [JSON.stringify(context.kind === "named" ? ["principal", "named", context.userId] :
            ["principal", "link", context.workspaceId, context.grantId, principalKey]), limits.maxConnectionsPerPrincipal, "live_person_limit"],
          [JSON.stringify(["grant", context.workspaceId, context.grantId]), limits.maxConnectionsPerGrant, "live_grant_limit"],
        ];
        const ticket = await options.tickets.redeem(token, context, signal); signal.throwIfAborted(); check();
        if (!ticket || ticket.audience !== origin || ticket.authority.principalKind !== context.kind ||
          (context.kind === "named" && ticket.authority.principalId !== context.userId) ||
          ticket.authority.grantId !== context.grantId || ticket.binding.workspaceId !== context.workspaceId) { stop(); return; }
        reserve(reservations, reservations[1]![0], context.workspaceId, context.shareId);
        releaseEditor = editors.acquire(ticket.binding);
        const native = await captureNative(ticket.binding, signal); signal.throwIfAborted(); check();
        const trustedAccount = context.kind === "named" ? await accountSnapshot(context.userId) : undefined;
        signal.throwIfAborted(); check();
        host = captureNamedLiveFrameHost({ ticket, actor: liveBrowserActor(context), ...(trustedAccount ? {trustedAccount} : {}), storage, native, bounds, validate, reserveBytes, validationBudget });
        host.assertCurrent();
        membership = options.membership?.join({ ticket, invalidated: host.invalidated, assertCurrent: host.assertCurrent.bind(host) });
      }
      host.invalidated.addEventListener("abort", stop, { once: true });
      host.assertCurrent();
      membership?.invalidated.addEventListener("abort", stop, { once: true });
      if (done || host.invalidated.aborted || socket.destroyed || !socket.readable || !socket.writable) { stop(); return; }
      server.handleUpgrade(request, socket, head, accepted => {
        ws = accepted; accepted.binaryType = "nodebuffer";
        if (done) { accepted.terminate(); return; }
        accepted.on("error", stop); accepted.once("close", stop);
        let controlBytes = 0, controlFrames = 0;
        accepted.on("ping", bytes => {
          if (done || controlFrames >= frames.maxControlFrames || bytes.length > frames.maxControlBytes - controlBytes ||
            accepted.bufferedAmount > limits.maxPendingBytes - bytes.length) { stop(); return; }
          let releaseBytes: () => void;
          try { releaseBytes = reserveBytes(bytes.length); } catch { refuseLimit("live_buffer_limit"); return; }
          controlBytes += bytes.length; controlFrames++;
          try { accepted.pong(bytes, undefined, error => { releaseBytes(); controlBytes -= bytes.length; controlFrames--; if (error) stop(); }); }
          catch { releaseBytes(); stop(); }
        });
        session = createNamedLiveFrameSession({ host: host!, frames, membership, reserveBytes,
          failed(error) { if (error instanceof LiveConnectionLimitError) refuseLimit(error.code); }, transport: {
          send(bytes) {
            if (done || accepted.readyState !== WebSocket.OPEN || accepted.bufferedAmount > limits.maxPendingBytes - bytes.length) return Promise.reject(new Error("Named transport unavailable."));
            host!.assertCurrent();
            let releaseBytes: () => void;
            try { releaseBytes = reserveBytes(bytes.length); } catch (error) { return Promise.reject(error); }
            return new Promise<void>((resolve, reject) => {
              try { accepted.send(bytes, { binary: true, compress: false }, error => {
                releaseBytes(); if (error) reject(error); else { touch(); resolve(); }
              }); } catch (error) { releaseBytes(); reject(error); }
            });
          }, close: stop,
        } });
        accepted.on("message", (bytes, binary) => {
          if (!binary || !Buffer.isBuffer(bytes) || bytes.length === 0) { stop(); return; }
          touch(); session!.receive(bytes);
        });
        touch(); socket.resume();
      });
      if (!ws) stop();
    } catch (error) { if (error instanceof LiveConnectionLimitError) refuseLimit(error.code); else stop(); }
    finally { opening = false; void release(); }
  }
  return { handle, handleUpgrade,
    deleteAccount(userId: string, workspaceIds: readonly string[]) {
      for (const stop of connections) {
        const scope = connectionScopes.get(stop);
        if (scope && (scope.userId === userId || workspaceIds.includes(scope.workspaceId))) stop();
      }
    },
    close() { if (closed) return; closed = true; shutdown.abort(); for (const stop of [...connections]) stop(); server.close(); },
  };
}
