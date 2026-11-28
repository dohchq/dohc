import {
  LIVE_CONNECTION_LIMIT_CLOSE_CODE,
  LiveConnectionLimitError,
  NOTE_FORMAT_OFF,
  TRY_AGAIN_LATER_CLOSE_CODE,
  type LiveConnectionLimitCode,
} from "@dohc/live-session-contract/live-connection";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountSessions,
  ResolveAccountSession,
  SessionKind,
  StoredAccountSession,
} from "@dohc/workspace-auth/session";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { readBoundedJson, refuseDeviceControl, type TokenBucketLimiter } from "@dohc/service-http";
import {
  parseLiveTicketAudience,
  parseLiveTicketToken,
  type RedeemedLiveTicket,
} from "@dohc/live-session-contract/live-ticket";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { accountIsFenced } from "./storage/accountDeletion";
import { hiddenFile } from "./accountFeed";
import {
  createLiveFrameSession,
  LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES,
  LiveFrameError,
  type LiveFrameSessionPolicy,
} from "@dohc/live-session-contract/live-frame";
import {
  parseLiveUpdateIdentifier,
  parseLiveUpdateDigest,
  type LiveDocumentKey,
} from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { SyncRelayStorage } from "./storage.js";
import { createLiveOpenRefusalLog, liveOpenFailureWords } from "./liveOpenRefusalLog";
import type { createLiveTickets } from "./liveTickets.js";
import {
  liveBrowserActor,
  type LiveBrowserContext,
  type LiveTicketScope,
  type PersonalLiveContext,
} from "./liveBrowserContext.js";
import { type LinkAuthorityResolver, type PersonalAuthority } from "./linkAuthority.js";
import type { PersonalAgents } from "./personalAgents.js";
import { errorResponse, relayError, RelayError } from "./errors.js";
import type { CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity.js";
import {
  captureNamedLiveFrameHost,
  captureOwnerLiveFrameHost,
  untilAborted,
  type NamedFrameValidationBudget,
  type NamedFrameHostBounds,
  type NamedFrameNativeHost,
} from "./namedLiveFrameHost.js";
import {
  createNamedLiveFrameSession,
  type NamedFrameHostSession,
} from "./namedLiveFrameSession.js";
import type { createLiveMembershipRegistry, LiveMembershipSession } from "./liveMembership.js";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { authorizeLinkShareAction, authorizeNamedLiveEditShareGrant } from "./shareAuthorization";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth";
import {
  memberEditGrant,
  type PhoneMemberLiveSession,
  type PhoneMemberLiveSessions,
} from "./phonePages";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  linkRefusal,
  liveNoteRefusal,
  namedLiveStoppedRefusal,
  unboundLinkRefusal,
  type LiveNoteStanding,
  type SessionHostBlock,
} from "./linkRefusal";
import { personalLiveRefusal } from "./personalLiveDocumentRoutes";
import { accountDisplayName } from "./accountDisplayName";
import type { TrustedLiveAccount } from "./storage/liveAuthorSnapshot";
import { liveEditors } from "./liveEditors.js";
import type { LiveRooms } from "./liveRoom.js";
import { isObjectMutationFenced } from "./storage/serviceHostEnrollment";

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
  /** The frame bytes one person, one share, or the people other than the owner in one workspace may hold. */
  readonly maxBufferedBytesPerPrincipal: number;
  readonly maxBufferedBytesPerShare: number;
  readonly maxBufferedBytesPerWorkspace: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly upgradeTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly drainTimeoutMs: number;
}
export function parseNamedLiveRouteLimits(value: unknown): NamedLiveRouteLimits {
  const names = [
    "maxConnections",
    "maxConnectionsPerWorkspace",
    "reservedOwnerConnections",
    "maxConnectionsPerSession",
    "maxConnectionsPerPrincipal",
    "maxConnectionsPerGrant",
    "maxPendingRequests",
    "maxRequestBytes",
    "maxResponseBytes",
    "maxBufferedBytes",
    "maxBufferedBytesPerPrincipal",
    "maxBufferedBytesPerShare",
    "maxBufferedBytesPerWorkspace",
    "maxPendingBytes",
    "maxFragments",
    "maxBufferedChunks",
    "upgradeTimeoutMs",
    "idleTimeoutMs",
    "drainTimeoutMs",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== names.sort().join()
  )
    throw new TypeError("Invalid named route limits.");
  const limits = { ...value } as NamedLiveRouteLimits;
  if (
    Object.values(limits).some(
      (number) => !Number.isSafeInteger(number) || number < 0 || number > 2_147_483_647,
    )
  )
    throw new TypeError("Invalid named route limits.");
  if (
    Object.entries(limits).some(
      ([key, value]) => key !== "reservedOwnerConnections" && value < 1,
    ) ||
    limits.reservedOwnerConnections >=
      Math.min(limits.maxConnections, limits.maxConnectionsPerWorkspace) ||
    Math.max(
      limits.maxBufferedBytesPerPrincipal,
      limits.maxBufferedBytesPerShare,
      limits.maxBufferedBytesPerWorkspace,
    ) > limits.maxBufferedBytes
  )
    throw new TypeError("Invalid named route limits.");
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
  phoneBearer?: boolean;
  /** Desktop or phone Bearer sign-in and uncached session table, paired so keepalive cannot outlive sign-out. */
  resolveAccountSession?: ResolveAccountSession;
  accountSessions?: Pick<AccountSessions, "read">;
  phoneSessions?: Pick<PhoneMemberLiveSessions, "has" | "take">;
  sessions?: {
    resolve(
      request: Request,
      discriminator: string,
      access?: "read" | "edit",
    ): Promise<LiveBrowserContext | null>;
  };
  tickets: ReturnType<typeof createLiveTickets>;
  membership?: Pick<ReturnType<typeof createLiveMembershipRegistry>, "join">;
  /** Shared notes' live rooms, when they are on. */
  rooms?: LiveRooms;
  /** Whether the session host cannot continue the document until its owner or operator acts. */
  sessionHostBlocked?: (document: {
    workspaceId: string;
    objectId: string;
  }) => SessionHostBlock | undefined;
  /** Where the note stands while it is not live, when its record answers. */
  liveNote?: (document: { workspaceId: string; objectId: string }) => LiveNoteStanding | undefined;
};
type OwnerRouteOptions = LiveRouteOptions & {
  kind: "owner";
  /** The Bearer sign-in, a phone's included, or the owner's browser cookie. A phone and a browser also present a ticket for the page. */
  resolveAccountSession: ResolveAccountSession;
  /** Reads sign-ins with no cache. Without it and `tickets`, no phone or browser connects. */
  accountSessions?: Pick<AccountSessions, "read">;
  tickets?: Pick<ReturnType<typeof createLiveTickets>, "redeem">;
  /** When on, a desktop or browser owner edits in the note's room and is sent its unsaved edits. */
  rooms?: LiveRooms;
};

/** Ends owner connections when their sign-in, or a phone's access to a workspace, ends. */
export interface OwnerLiveSockets {
  stopSession(userId: string, sessionId: string): void;
  stopPhoneWorkspace(userId: string, workspaceId: string): void;
}

/** How often a phone or desktop sign-in is read again, and how long that read may take before it counts as failed. */
export const OWNER_SESSION_CHECK_MS = 60_000;
const OWNER_SESSION_READ_DEADLINE_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

interface OwnerSession {
  readonly sessionId: string;
  readonly clientKind: SessionKind;
  readonly expiresAtMs: number;
}
interface ConnectionScope {
  readonly userId?: string;
  readonly workspaceId: string;
  /** An owner or desktop sign-in, and a check of the page it has open. */
  readonly session?: OwnerSession;
  readonly recheck?: () => void;
}

const sessionStands = (
  stored: StoredAccountSession | undefined,
  userId: string,
  session: OwnerSession,
) =>
  stored !== undefined &&
  stored.userId === userId &&
  stored.clientKind === session.clientKind &&
  Date.now() < Math.min(stored.expiresAtMs, session.expiresAtMs);
/**
 * A personal agent's routes, which share-web calls over the relay exchange
 * key with the agent's bearer: `POST /sync/live/personal-tickets` and the
 * `/sync/live/personal?workspaceId=` socket.
 */
type PersonalRouteOptions = LiveRouteOptions & {
  kind: "personal";
  tickets: ReturnType<typeof createLiveTickets>;
  linkAuthority: Pick<LinkAuthorityResolver, "personal" | "freshPersonal">;
  personalAgents: Pick<PersonalAgents, "register">;
  /** Admits requests per connection, with the personal agent tools. */
  limiter: TokenBucketLimiter;
  /** Whether the self-hosted live host is the configured host, the only one that hosts documents for agents. */
  supported(): boolean;
  sessionHostBlocked?: (document: {
    workspaceId: string;
    objectId: string;
  }) => SessionHostBlock | undefined;
};
export function createNamedLiveRoutes(options: BrowserRouteOptions) {
  return createLiveRoutes(options);
}
export function createOwnerLiveRoutes(options: Omit<OwnerRouteOptions, "kind">) {
  return createLiveRoutes({ ...options, kind: "owner" });
}
export function createPersonalLiveRoutes(options: Omit<PersonalRouteOptions, "kind">) {
  return createLiveRoutes({ ...options, kind: "personal" });
}
class NoteFormatOff extends Error {}
const personalUnavailable = (error: unknown) =>
  error instanceof RelayError && error.code === "personal_agent_unavailable";
const personalLiveContext = (
  authority: PersonalAuthority,
  workspaceId: string,
): PersonalLiveContext => ({
  kind: "personal",
  workspaceId,
  agentId: authority.agentId,
  connectionId: authority.connectionId,
  accessTokenHash: authority.check.accessTokenHash,
  resourceHash: authority.check.resourceHash,
  fenceEpoch: authority.fenceEpoch,
});
function createLiveRoutes(input: BrowserRouteOptions | OwnerRouteOptions | PersonalRouteOptions) {
  const options =
    input.kind === "owner" || input.kind === "personal"
      ? { ...input }
      : {
          ...input,
          sessions: input.sessions
            ? { resolve: input.sessions.resolve.bind(input.sessions) }
            : undefined,
        };
  const limits = parseNamedLiveRouteLimits(options.limits),
    hosts = new Set(options.hosts);
  const kind = options.kind;
  const desktop = options.kind === "named" && options.desktopBearer === true;
  const phone = options.kind === "named" && options.phoneBearer === true;
  const bearerNamed = desktop || phone;
  if (options.kind !== "owner" && options.kind !== "personal") {
    if (desktop && phone) throw new TypeError("A named live route is desktop or phone, not both.");
    if (!bearerNamed && (options.resolveAccountSession || options.accountSessions))
      throw new TypeError("Only desktop or phone live routes check account sessions.");
    if (desktop && Boolean(options.resolveAccountSession) !== Boolean(options.accountSessions))
      throw new TypeError(
        "Desktop live routes require both resolveAccountSession and accountSessions.",
      );
    if (
      phone &&
      (!options.resolveAccountSession || !options.accountSessions || !options.phoneSessions)
    )
      throw new TypeError(
        "Phone live routes require resolveAccountSession, accountSessions, and phoneSessions.",
      );
    if (!phone && (!options.sessions || options.phoneSessions))
      throw new TypeError("Non-phone live routes require sessions and forbid phoneSessions.");
  }
  const routeKind = phone ? "phone" : desktop ? "desktop" : kind;
  // Browsers reach named (not desktop/phone) and link routes through the share page's
  // gateway, which pings them; desktop and phone sockets are pinged from here,
  // while share-web's agent client opens link routes directly and keeps the idle close.
  const gatewayFronted = !bearerNamed && (kind === "named" || kind === "link");
  if (kind !== "named" && kind !== "link" && kind !== "owner" && kind !== "personal")
    throw new TypeError("Explicit live route kind required.");
  const origin = parseLiveTicketAudience(options.publicOrigin),
    keyHash = hashRelayExchangeKey(options.exchangeKey);
  if (
    !origin.startsWith("https:") ||
    options.exchangeKey.length < 32 ||
    hosts.size === 0 ||
    [...hosts].some((host) => !host || new URL(`http://${host}`).host !== host)
  ) {
    throw new TypeError(
      "Named routes require explicit relay hosts, HTTPS audience, and exchange key.",
    );
  }
  const frames = { ...options.frames, receive: { ...options.frames.receive } },
    bounds = { ...options.bounds };
  createLiveFrameSession("server", frames).close();
  if (frames.receive.maxFrameBytes > limits.maxPendingBytes)
    throw new TypeError("Named route send capacity is smaller than one frame.");
  // Only the owner route admits an agent declaration, so only it must receive the largest declared submission.
  if (
    kind === "owner" &&
    (frames.receive.maxFrameBytes < LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES ||
      frames.maxControlBytes < LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES)
  ) {
    throw new TypeError("The owner route must receive the largest declared submission.");
  }
  const wsOptions = {
    noServer: true as const,
    clientTracking: false,
    perMessageDeflate: false as const,
    autoPong: false,
    maxPayload: frames.receive.maxFrameBytes,
    maxFragments: limits.maxFragments,
    maxBufferedChunks: limits.maxBufferedChunks,
    closeTimeout: limits.drainTimeoutMs,
    handleProtocols: () => "dohc-live-v1",
  };
  const server = new WebSocketServer(wsOptions);
  const connections = new Set<() => void>(),
    admission = options.admission ?? createLiveConnectionAdmission();
  const buffers = admission.buffers(limits.maxBufferedBytes),
    validationBuffers = admission.validationBuffers(limits.maxBufferedBytes);
  // Each connection's stop, under the account, sign-in, and workspace it was opened for.
  const connectionScopes = new Map<() => void, ConnectionScope>();
  const shutdown = new AbortController();
  const accountSessions =
    options.kind === "owner" || bearerNamed ? options.accountSessions : undefined;
  const namedResolveAccountSession = bearerNamed ? options.resolveAccountSession : undefined;
  const ownerTickets = options.kind === "owner" ? options.tickets : undefined;
  // A phone, browser or desktop sign-in is read again on this schedule however busy its connection is. A read that fails closes them all.
  async function checkTrackedSessions() {
    const tracked = [...connectionScopes].flatMap(([stop, scope]) =>
      scope.session && scope.userId && (bearerNamed || scope.session.clientKind !== "desktop")
        ? [{ stop, userId: scope.userId, session: scope.session, recheck: scope.recheck }]
        : [],
    );
    if (!tracked.length) return;
    let stored: Map<string, StoredAccountSession> | undefined;
    try {
      stored = await untilAborted(
        accountSessions!.read([...new Set(tracked.map(({ session }) => session.sessionId))]),
        AbortSignal.timeout(OWNER_SESSION_READ_DEADLINE_MS),
      );
    } catch {
      stored = undefined;
    }
    for (const { stop, userId, session, recheck } of tracked) {
      try {
        if (
          !sessionStands(stored?.get(session.sessionId), userId, session) ||
          accountIsFenced(storage, userId)
        )
          throw new Error();
        recheck?.();
      } catch {
        stop();
      }
    }
  }
  const sessionChecks = accountSessions
    ? setInterval(() => void checkTrackedSessions(), OWNER_SESSION_CHECK_MS)
    : undefined;
  sessionChecks?.unref();
  const storage = options.storage,
    editors = liveEditors(storage);
  const captureNative = async (binding: LiveObjectBinding, signal: AbortSignal) => {
      if (storage.liveNoteFormatOff(binding)) throw new NoteFormatOff();
      return options.captureNative(binding, signal);
    },
    validate = options.validate;
  const sessionHostBlocked = options.kind === "owner" ? undefined : options.sessionHostBlocked;
  const liveNote = "liveNote" in options ? options.liveNote : undefined;
  const accountSnapshot = async (accountId: string): Promise<TrustedLiveAccount> => ({
    accountId,
    name: (await accountDisplayName(options.lookupUserDisplayName, accountId)) ?? "Unnamed",
  });

  // Whether the caller's scope reaches a current binding of the document, as a ticket for it needs.
  const reaches = (scope: LiveTicketScope, objectId: string) =>
    storage.resolveLiveObjectHostBinding(scope, objectId).kind === "current";
  const namedReaches = (
    context: NamedLiveBrowserContext,
    document: { workspaceId: string; objectId: string },
  ) => {
    const authority = authorizeNamedLiveEditShareGrant({
      storage,
      actorUserId: context.userId,
      grantId: context.grantId,
    });
    if (!authority.ok || "kind" in authority.effectiveSelector) return false;
    const path = storage.objectMoment({ ...document, versionId: "main" })?.path;
    return (
      !!path &&
      visibleSharePath(authority.effectiveSelector, path) !== null &&
      storage.objectIdAtPathInVersion({
        workspaceId: document.workspaceId,
        versionId: "main",
        path,
      }) === document.objectId
    );
  };

  let closed = false,
    pendingRequests = 0;
  const refusal = () =>
    Response.json(
      { ok: false, error: "not found" },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  const trusted = (headers: Headers) =>
    hosts.has(headers.get("host") ?? "") &&
    (bearerNamed
      ? (!headers.has("origin") || headers.get("origin") === origin) &&
        /^Bearer [^\s]+$/.test(headers.get("authorization") ?? "") &&
        !headers.has("cookie")
      : headers.get("origin") === origin &&
        verifyRelayExchangeKey(headers.get("x-dohc-relay-exchange-key"), keyHash));
  // A link route forwards only the headers present, so the agent resolver sees exactly what was sent, and refuses a cookie.
  const credentials = (headers: Headers): Record<string, string> =>
    (kind === "owner" && headers.has("authorization")) || bearerNamed
      ? { authorization: headers.get("authorization") ?? "" }
      : kind === "named" || kind === "owner"
        ? { cookie: headers.get("cookie") ?? "" }
        : Object.fromEntries(
            [
              "authorization",
              "cookie",
              "x-dohc-link-profile-secret",
              "x-dohc-agent-resource",
              "x-dohc-relay-exchange-key",
            ].flatMap((name): [string, string][] => {
              const value = headers.get(name);
              return value === null ? [] : [[name, value]];
            }),
          );
  const sessionId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{12}$/.test(value);
  const answer = (minted: object) => {
    const body = JSON.stringify(minted);
    if (Buffer.byteLength(body) > limits.maxResponseBytes) return refusal();
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  };
  server.on("wsClientError", (_error, socket) =>
    refuseDeviceControl(socket, limits.drainTimeoutMs),
  );

  // A link page stops editing on a 404 and tries again on a 503, so a relay that is stopping,
  // full, slow or failing answers 503 to a caller someone has vouched for. share-web sends a
  // holder's capability only for a browser session it holds; an agent's token is vouched for
  // once it resolves here. Anyone else gets the same 404 in every state.
  const busy = (vouched: boolean) =>
    kind === "link" && vouched ? linkRefusal("link_live_unavailable") : refusal();
  const toldToTryAgain = createLiveOpenRefusalLog();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      options.kind === "owner" ||
      bearerNamed ||
      url.pathname !== `/sync/live/${kind}-tickets` ||
      url.search ||
      request.method !== "POST" ||
      !trusted(request.headers) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      request.signal.aborted
    )
      return refusal();
    let vouched = (request.headers.get("authorization") ?? "").startsWith("LinkCapability ");
    if (closed || storage.unavailable.aborted || pendingRequests >= limits.maxPendingRequests) {
      if (kind === "link" && vouched)
        toldToTryAgain(
          closed
            ? "the relay is stopping"
            : storage.unavailable.aborted
              ? "the relay's storage is unavailable"
              : "too many opens are waiting",
        );
      return busy(vouched);
    }
    pendingRequests++;
    const controller = new AbortController(),
      signal = AbortSignal.any([
        request.signal,
        storage.unavailable,
        shutdown.signal,
        controller.signal,
      ]);
    const timer = setTimeout(() => controller.abort(), limits.upgradeTimeoutMs);
    let cancel!: () => void;
    const cancelled = new Promise<Response>((done) => {
      cancel = () => {
        if (kind === "link" && vouched && !request.signal.aborted)
          toldToTryAgain("the open ran out of time or the relay is stopping");
        done(busy(vouched && !request.signal.aborted));
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
    // Once the request is well formed, a throw is the relay's own failure, not a refusal.
    let wellFormed = false;
    const work = (async () => {
      try {
        const check = storage.captureStanding();
        const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
        if (!input || typeof input !== "object" || Array.isArray(input)) return refusal();
        if (options.kind === "personal") {
          if (Object.keys(input).sort().join() !== "objectId,workspaceId") return refusal();
          const { objectId, workspaceId } = input as Record<string, unknown>;
          parseLiveUpdateIdentifier(objectId);
          parseLiveUpdateIdentifier(workspaceId);
          // The account's fence, read from Postgres once the body is in. The mint's transaction authorizes at it.
          const authority = await options.linkAuthority.personal(
            new Request(request.url, { headers: credentials(request.headers), signal }),
          );
          signal.throwIfAborted();
          check();
          if (!options.limiter.allow(authority.callerKey, Date.now()))
            throw relayError("link_read_rate_limited");
          if (!options.supported()) return refusal();
          const context = personalLiveContext(authority, workspaceId as string);
          const block = sessionHostBlocked?.({
            workspaceId: workspaceId as string,
            objectId: objectId as string,
          });
          // A held document the agent reaches gives the reason its open gives. Anything else reads as not found.
          if (block)
            return block === "held" && reaches(context, objectId as string)
              ? personalLiveRefusal("live-edit-unadmitted")
              : refusal();
          const minted = await options.tickets.mint({ objectId }, context, signal);
          signal.throwIfAborted();
          check();
          return minted
            ? answer({ expiresAtMs: minted.expiresAtMs, token: minted.token })
            : refusal();
        }
        if (Object.keys(input).sort().join() !== "discriminator,objectId") return refusal();
        const { discriminator, objectId } = input as Record<string, unknown>;
        if (!sessionId(discriminator)) return refusal();
        parseLiveUpdateIdentifier(objectId);
        wellFormed = true;
        const authenticated = new Request(request.url, {
          headers: credentials(request.headers),
          signal,
        });
        const context = await options.sessions!.resolve(authenticated, discriminator, "read");
        signal.throwIfAborted();
        check();
        if (!context || context.kind !== kind) return refusal();
        vouched = true;
        const document = { workspaceId: context.workspaceId, objectId: objectId as string };
        const blocked = () => sessionHostBlocked?.(document);
        if (context.kind === "link") {
          const authority = authorizeLinkShareAction({
            storage,
            grantId: context.grantId,
            action: "read",
          });
          if (!authority.ok) return refusal();
          const path = storage.objectMoment({
            workspaceId: context.workspaceId,
            objectId: objectId as string,
            versionId: authority.effectiveSelector.versionId ?? "main",
          })?.path;
          if (
            !path ||
            createAccountlessPathProjection(authority.effectiveSelector).projectPath(path) ===
              null ||
            storage.objectIdAtPathInVersion({
              workspaceId: context.workspaceId,
              versionId: authority.effectiveSelector.versionId ?? "main",
              path,
            }) !== objectId
          )
            return refusal();
          if (authority.effectiveSelector.access === "view") return linkRefusal("link_view_access");
          if (authority.effectiveSelector.access === "comment")
            return linkRefusal("link_comment_access");
          const binding = storage.resolveLiveObjectHostBinding(context, objectId as string);
          // A note paused after its file moved has no binding, and only its owner can start it again.
          if (binding.kind === "refused") {
            if (binding.reason !== "host-unavailable" && binding.reason !== "stale-document")
              return refusal();
            const block = blocked(),
              note = liveNote?.(document);
            toldToTryAgain(
              `the note has no binding (${binding.reason}), host says ${block ?? "stopped"}`,
            );
            return unboundLinkRefusal(note, block);
          }
        } else if (namedReaches(context, document)) {
          const note = liveNote?.(document);
          if (note)
            return note === "starting" && blocked() !== "held"
              ? linkRefusal("link_live_starting")
              : namedLiveStoppedRefusal();
        }
        const block = blocked();
        if (block && context.kind === "link") toldToTryAgain(`the host says ${block}`);
        // A link holder's reach was checked above. An invited editor learns why only for a document they reach.
        if (context.kind === "link") {
          const refused = liveNoteRefusal(liveNote?.(document), block);
          if (refused) return refused;
        } else if (block)
          return block === "held" && reaches(context, objectId as string)
            ? namedLiveStoppedRefusal()
            : refusal();
        const minted = await options.tickets.mint({ objectId }, context, signal);
        signal.throwIfAborted();
        check();
        if (minted) return answer(minted);
        // A link that has taken as many browsers as it may can't take this one. Trying again can't help.
        return context.kind === "link" && storage.liveLinkFull(context)
          ? linkRefusal("link_full")
          : refusal();
      } catch (error) {
        // A personal agent learns when to try again: its account can't be read now, or it asked too often.
        if (kind === "personal")
          return !signal.aborted &&
            error instanceof RelayError &&
            (error.statusCode === 503 || error.statusCode === 429)
            ? errorResponse(error)
            : refusal();
        const failed =
          vouched && wellFormed && !(error instanceof RelayError && error.statusCode < 500);
        if (kind === "link" && failed && !signal.aborted)
          toldToTryAgain(`the open failed: ${liveOpenFailureWords(error)}`);
        return busy(failed);
      } finally {
        pendingRequests--;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    })();
    return Promise.race([work, cancelled]);
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let headers: Headers;
    let discriminator = "",
      token = "",
      personalWorkspaceId = "";
    let ownerTarget: LiveDocumentKey | undefined,
      ownerBrowser = false,
      ownerPhone = false;
    try {
      headers = new Headers();
      const selected = new Set([
        "host",
        "origin",
        "cookie",
        "authorization",
        "x-dohc-link-profile-secret",
        "x-dohc-agent-resource",
        "sec-websocket-protocol",
        "x-dohc-relay-exchange-key",
      ]);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!.toLowerCase();
        if (!selected.has(name)) continue;
        if (headers.has(name)) throw new Error();
        headers.set(name, request.rawHeaders[index + 1]!);
      }
      if (kind === "owner") {
        const url = new URL(request.url ?? "", "https://owner.invalid");
        const path = /^\/sync\/workspaces\/([^/]+)\/live\/owner$/.exec(url.pathname);
        // A desktop offers only the live protocol. A phone, and the owner's browser, also offer one ticket for the page.
        const offered = (headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((value) => value.trim());
        const ticketed = offered.filter((value) => value.startsWith("dohc-live-ticket."));
        ownerBrowser = !headers.has("authorization");
        if (
          !path ||
          request.method !== "GET" ||
          !hosts.has(headers.get("host") ?? "") ||
          (ownerBrowser
            ? !headers.has("cookie") ||
              headers.get("origin") !== origin ||
              !verifyRelayExchangeKey(headers.get("x-dohc-relay-exchange-key"), keyHash) ||
              ticketed.length !== 1
            : (headers.has("origin") && headers.get("origin") !== origin) ||
              !/^Bearer [^\s]+$/.test(headers.get("authorization") ?? "")) ||
          offered.filter((value) => value === "dohc-live-v1").length !== 1 ||
          ticketed.length > 1 ||
          offered.length !== 1 + ticketed.length ||
          [...url.searchParams.keys()].sort().join() !== "lineageClaimId,objectId"
        )
          throw new Error();
        if (ticketed[0] !== undefined) {
          token = ticketed[0].slice("dohc-live-ticket.".length);
          parseLiveTicketToken(token);
        }
        ownerTarget = {
          workspaceId: parseLiveUpdateIdentifier(decodeURIComponent(path[1]!)),
          mainVersionId: "main",
          objectId: parseLiveUpdateIdentifier(url.searchParams.get("objectId")),
          lineageClaimId: parseLiveUpdateDigest(url.searchParams.get("lineageClaimId")),
        };
      } else {
        if (kind === "personal") {
          const url = new URL(request.url ?? "", "https://personal.invalid");
          if (
            url.pathname !== "/sync/live/personal" ||
            [...url.searchParams.keys()].join() !== "workspaceId"
          )
            throw new Error();
          personalWorkspaceId = parseLiveUpdateIdentifier(url.searchParams.get("workspaceId"));
        } else {
          const path = new RegExp(`^/sync/live/${routeKind}\\?session=([A-Za-z0-9_-]{12})$`).exec(
            request.url ?? "",
          );
          if (!path) throw new Error();
          discriminator = path[1]!;
        }
        const protocols = headers
          .get("sec-websocket-protocol")
          ?.split(",")
          .map((value) => value.trim());
        if (
          request.method !== "GET" ||
          !trusted(headers) ||
          protocols?.length !== 2 ||
          protocols.filter((value) => value === "dohc-live-v1").length !== 1
        )
          throw new Error();
        const credential = protocols.find((value) => value.startsWith("dohc-live-ticket."));
        token = credential?.slice("dohc-live-ticket.".length) ?? "";
        parseLiveTicketToken(token);
      }
    } catch {
      refuseDeviceControl(socket, limits.drainTimeoutMs);
      return;
    }
    if (closed || storage.unavailable.aborted || head.length > limits.maxPendingBytes) {
      refuseDeviceControl(socket, limits.drainTimeoutMs);
      return;
    }
    const releaseConnection = admission.reserve([["connections", limits.maxConnections]]);
    const releaseRefusal = !releaseConnection
      ? admission.reserve([["upgrade-refusals", limits.maxPendingRequests]])
      : undefined;
    if (!releaseConnection && !releaseRefusal) {
      refuseDeviceControl(socket, limits.drainTimeoutMs);
      return;
    }
    socket.pause();
    const lifetime = new AbortController(),
      signal = AbortSignal.any([lifetime.signal, storage.unavailable, shutdown.signal]);
    let ws: WebSocket | undefined,
      host: NamedFrameHostSession | undefined,
      session: ReturnType<typeof createNamedLiveFrameSession> | undefined;
    let membership: LiveMembershipSession | undefined;
    let reserveBytes: (size: number) => () => void = buffers.reserve;
    let validationBudget: NamedFrameValidationBudget | undefined;
    let closingForLimit = false;
    let done = false,
      opening = true,
      releaseAuthority: (() => void) | undefined,
      releaseEditor: (() => void) | undefined;
    // A personal session's running-work registration, and the document whose demand its close renews.
    let unregister: (() => void) | undefined,
      personalDocument: { workspaceId: string; objectId: string } | undefined;
    let timer = setTimeout(stop, limits.upgradeTimeoutMs);
    let sessionExpiry: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let trackedBearer: { readonly userId: string; readonly session: OwnerSession } | undefined;
    async function release() {
      if (opening || !done) return;
      await session?.settled();
      if (closingForLimit && ws && ws.readyState !== WebSocket.CLOSED)
        await new Promise<void>((resolve) => ws!.once("close", resolve));
      connectionScopes.delete(stop);
      if (!connections.delete(stop)) return;
      releaseEditor?.();
      releaseAuthority?.();
      releaseConnection?.();
      releaseRefusal?.();
      // The host keeps an agent's document while it is in use, so a close counts as use. An owner's Stop still holds.
      if (personalDocument)
        try {
          storage.renewPersonalSessionDemand({ ...personalDocument, nowMs: Date.now() });
        } catch {
          /* Storage is closing. */
        }
    }
    const refuseLimit = (code: LiveConnectionLimitCode) =>
      refuseOpen(LIVE_CONNECTION_LIMIT_CLOSE_CODE, code);
    const refuseRetryable = (error: unknown) => {
      if (error instanceof LiveConnectionLimitError) {
        refuseLimit(error.code);
        return true;
      }
      if (error instanceof NoteFormatOff) {
        refuseOpen(TRY_AGAIN_LATER_CLOSE_CODE, NOTE_FORMAT_OFF);
        return true;
      }
      // A WebSocket has no status, so a personal agent's 503 is the close that says to try again later.
      if (personalUnavailable(error)) {
        refuseOpen(TRY_AGAIN_LATER_CLOSE_CODE, "personal_agent_unavailable");
        return true;
      }
      return false;
    };
    function refuseOpen(closeCode: number, reason: string) {
      if (done || socket.destroyed) return;
      if (!ws)
        server.handleUpgrade(request, socket, Buffer.alloc(0), (accepted) => {
          ws = accepted;
          accepted.on("error", stop);
        });
      if (ws) {
        closingForLimit = true;
        ws.close(closeCode, reason);
        socket.resume();
        const deadline = setTimeout(() => ws?.terminate(), limits.drainTimeoutMs);
        deadline.unref();
        ws.once("close", () => clearTimeout(deadline));
      }
      stop();
    }
    // Marks the connection closing, which a phone's guard refuses from then on, then closes the capture before the transport.
    function stop() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(sessionExpiry);
      clearInterval(keepalive);
      lifetime.abort();
      signal.removeEventListener("abort", stop);
      host?.invalidated.removeEventListener("abort", stop);
      membership?.invalidated.removeEventListener("abort", stop);
      membership?.close();
      unregister?.();
      host?.close();
      session?.close();
      if (ws) {
        if (!closingForLimit) ws.terminate();
      } else refuseDeviceControl(socket, limits.drainTimeoutMs);
      void release();
    }
    const touch = () => {
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(stop, limits.idleTimeoutMs);
      timer.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    connections.add(stop);
    socket.once("close", stop);
    socket.once("error", stop);
    try {
      const check = storage.captureStanding();
      const authenticated = new Request(new URL(request.url!, `https://${headers.get("host")}`), {
        headers: credentials(headers),
        signal,
      });
      function reserve(
        reservations: [string, number, LiveConnectionLimitCode][],
        principal: string,
        workspaceId: string,
        shareId?: string,
      ) {
        if (!releaseConnection) throw new LiveConnectionLimitError("live_total_limit");
        const release = admission.reserve([
          [
            JSON.stringify(["workspace", workspaceId]),
            limits.maxConnectionsPerWorkspace,
            "live_workspace_limit",
          ],
          ...(kind === "owner"
            ? []
            : ([
                [
                  "non-owner",
                  limits.maxConnections - limits.reservedOwnerConnections,
                  "live_total_limit",
                ],
                [
                  JSON.stringify(["non-owner-workspace", workspaceId]),
                  limits.maxConnectionsPerWorkspace - limits.reservedOwnerConnections,
                  "live_workspace_limit",
                ],
              ] as [string, number, LiveConnectionLimitCode][])),
          ...reservations,
        ]);
        if (!release) throw new Error("Live connection limit reached.");
        releaseAuthority = release;
        const scopes: [string, number][] = [[principal, limits.maxBufferedBytesPerPrincipal]];
        if (kind !== "owner")
          scopes.push([
            JSON.stringify(["workspace", workspaceId]),
            limits.maxBufferedBytesPerWorkspace,
          ]);
        if (shareId)
          scopes.push([
            JSON.stringify(["share", workspaceId, shareId]),
            limits.maxBufferedBytesPerShare,
          ]);
        reserveBytes = (size) => buffers.reserve(size, scopes);
        validationBudget = {
          reserve: () => admission.reserve([[JSON.stringify(["validation", principal]), 1]]),
          maxBytes: limits.maxBufferedBytes,
          reserveBytes: validationBuffers.reserve,
        };
      }
      if (options.kind === "owner") {
        const document = ownerTarget!;
        const account = ownerBrowser
          ? await options.resolveAccountSession(authenticated)
          : await bearerAccountSession(storage, options.resolveAccountSession, authenticated);
        signal.throwIfAborted();
        check();
        const actor = { userId: account.userId };
        ownerPhone = account.clientKind === "phone";
        if (
          ownerBrowser &&
          (account.clientKind !== "browser" || accountIsFenced(storage, actor.userId))
        )
          throw new Error();
        const ticketed = ownerPhone || ownerBrowser;
        const ownerSession: OwnerSession = {
          sessionId: account.sessionId,
          clientKind: account.clientKind,
          expiresAtMs: account.expiresAtMs,
        };
        // Registered before the ticket is spent, so a revoke or Show on phone turned off from here on ends it.
        connectionScopes.set(stop, {
          userId: account.userId,
          workspaceId: document.workspaceId,
          session: ownerSession,
          recheck: () => host?.assertCurrent(),
        });
        // A phone or the owner's browser opens only with a ticket for this page. A desktop never sends one.
        if (ticketed !== (token !== "") || (ticketed && (!accountSessions || !ownerTickets)))
          throw new Error();
        // A sign-in that outlasts any timer ends at a periodic check instead.
        const remainingMs = Math.max(0, account.expiresAtMs - Date.now());
        if (ticketed && remainingMs <= MAX_TIMER_MS) {
          sessionExpiry = setTimeout(stop, remainingMs);
          sessionExpiry.unref();
        }
        let ticket: RedeemedLiveTicket | null = null;
        if (ticketed) {
          ticket = await ownerTickets!.redeem(
            token,
            {
              kind: "owner",
              workspaceId: document.workspaceId,
              userId: account.userId,
              sessionId: account.sessionId,
              sessionExpiresAtMs: account.expiresAtMs,
            },
            signal,
          );
          signal.throwIfAborted();
          check();
          if (
            !ticket ||
            ticket.audience !== origin ||
            ticket.authority.principalKind !== "owner" ||
            ticket.authority.principalId !== account.userId ||
            ticket.binding.objectId !== document.objectId ||
            ticket.binding.lineageClaimId !== document.lineageClaimId ||
            hiddenFile(ticket.binding.currentPath)
          )
            throw new Error();
        }
        // Checked on every admission of a ticketed connection: closing, its sign-in's expiry, the
        // account's fence and ownership, and a phone's Show on phone. A move or rename changes the binding,
        // which the capture's own check compares, so a hidden path needs no check here.
        const guard = ticketed
          ? () => {
              if (
                done ||
                Date.now() >= account.expiresAtMs ||
                accountIsFenced(storage, account.userId) ||
                !storage.workspaceIsOwnedBy(document.workspaceId, account.userId) ||
                (ownerPhone && !storage.showsOnPhone(account.userId, document.workspaceId))
              )
                throw new Error("The owner's access ended.");
            }
          : undefined;
        if (!storage.workspaceIsOwnedBy(document.workspaceId, actor.userId)) throw new Error();
        const current = storage.resolveCurrentLiveDocumentBinding({
          document,
          actor: { kind: "owner", userId: actor.userId },
        });
        if (current.kind !== "current") throw new Error();
        if (
          ticket &&
          (JSON.stringify(ticket.binding) !== JSON.stringify(current.binding) ||
            ticket.hostEpoch !== current.host.hostEpoch)
        )
          throw new Error();
        reserve(
          [
            [
              JSON.stringify([
                "owner-document",
                actor.userId,
                document.workspaceId,
                document.objectId,
              ]),
              limits.maxConnectionsPerSession,
              "live_session_limit",
            ],
            [
              JSON.stringify(["principal", "named", actor.userId]),
              limits.maxConnectionsPerPrincipal,
              "live_person_limit",
            ],
          ],
          JSON.stringify(["principal", "named", actor.userId]),
          document.workspaceId,
        );
        // Counted before capture, so the host cannot unload the document while this connection opens.
        releaseEditor = editors.acquire(document);
        if (isObjectMutationFenced(storage, document.workspaceId, document.objectId))
          throw new Error();
        const native = await captureNative(current.binding, signal);
        signal.throwIfAborted();
        check();
        if (
          !isDeepStrictEqual(
            { ...native.binding, selectorPaths: current.binding.selectorPaths },
            current.binding,
          )
        )
          throw new Error("Native owner target changed.");
        const refreshed = storage.resolveCurrentLiveDocumentBinding({
          document,
          actor: { kind: "owner", userId: actor.userId },
        });
        if (!isDeepStrictEqual(refreshed, current))
          throw new Error("Owner binding changed during capture.");
        const trustedAccount = await accountSnapshot(actor.userId);
        signal.throwIfAborted();
        check();
        if (ticketed) {
          // The sign-in, read again from the table now that capture has waited.
          const stored = await untilAborted(accountSessions!.read([account.sessionId]), signal);
          signal.throwIfAborted();
          check();
          if (
            !sessionStands(stored.get(account.sessionId), account.userId, ownerSession) ||
            hiddenFile(current.binding.currentPath)
          )
            throw new Error();
        }
        // The capture checks the page's authority and the guard again before it returns.
        const captured = captureOwnerLiveFrameHost({
          authenticatedUserId: actor.userId,
          trustedAccount,
          storage,
          native,
          bounds,
          validate,
          reserveBytes,
          validationBudget,
          ...(guard ? { guard } : {}),
          personOnly: ownerBrowser,
        });
        // A phone or browser stays on its own capture until it reads which room rows the host has saved.
        host =
          options.rooms && !ticketed ? options.rooms.join(captured, { owner: true }) : captured;
      } else if (options.kind === "personal") {
        // The account's fence, read from Postgres for this open.
        const linkAuthority = options.linkAuthority;
        const authority = await untilAborted(linkAuthority.personal(authenticated), signal);
        signal.throwIfAborted();
        check();
        const context = personalLiveContext(authority, personalWorkspaceId);
        connectionScopes.set(stop, {
          userId: authority.ownerUserId,
          workspaceId: context.workspaceId,
        });
        if (!options.supported()) {
          stop();
          return;
        }
        // Registered before the ticket is spent, so a registry that isn't caught up refuses without spending it. Sign-out,
        // removal, a narrowed reach, a lowered level, a newer fence, or the listener going down end the session from here.
        unregister = options.personalAgents.register({
          agentId: context.agentId,
          ownerUserId: authority.ownerUserId,
          connectionId: context.connectionId,
          fenceEpoch: context.fenceEpoch,
          workspaceIds: [context.workspaceId],
          kind: "live",
          needs: "edit",
          terminate: stop,
        });
        const ticket = await options.tickets.redeem(token, context, signal);
        signal.throwIfAborted();
        check();
        if (
          !ticket ||
          ticket.audience !== origin ||
          ticket.authority.principalKind !== "personal" ||
          ticket.authority.principalId !== context.agentId ||
          ticket.authority.grantId !== null ||
          ticket.binding.workspaceId !== context.workspaceId
        ) {
          stop();
          return;
        }
        personalDocument = {
          workspaceId: ticket.binding.workspaceId,
          objectId: ticket.binding.objectId,
        };
        const principal = JSON.stringify(["principal", "personal", context.agentId]);
        reserve(
          [
            [
              JSON.stringify(["session", "personal", context.connectionId, context.workspaceId]),
              limits.maxConnectionsPerSession,
              "live_session_limit",
            ],
            [principal, limits.maxConnectionsPerPrincipal, "live_person_limit"],
          ],
          principal,
          context.workspaceId,
        );
        releaseEditor = editors.acquire(ticket.binding);
        if (isObjectMutationFenced(storage, ticket.binding.workspaceId, ticket.binding.objectId)) {
          stop();
          return;
        }
        const native = await captureNative(ticket.binding, signal);
        signal.throwIfAborted();
        check();
        host = captureNamedLiveFrameHost({
          ticket,
          actor: liveBrowserActor(context),
          storage,
          native,
          bounds,
          validate,
          reserveBytes,
          validationBudget,
          fresh: () => linkAuthority.freshPersonal(authority),
        });
      } else {
        let boundPhone: PhoneMemberLiveSession | undefined;
        let context = phone ? null : await options.sessions!.resolve(authenticated, discriminator);
        signal.throwIfAborted();
        check();
        if (!phone && (!context || context.kind !== kind)) {
          stop();
          return;
        }
        if (namedResolveAccountSession) {
          if (phone && !options.phoneSessions!.has(discriminator)) {
            stop();
            return;
          }
          const account = await bearerAccountSession(
            storage,
            namedResolveAccountSession,
            authenticated,
          );
          signal.throwIfAborted();
          check();
          if (phone) {
            const taken =
              account.clientKind === "phone"
                ? options.phoneSessions!.take({
                    discriminator,
                    userId: account.userId,
                    sessionId: account.sessionId,
                    token,
                  })
                : null;
            if (!taken) {
              stop();
              return;
            }
            boundPhone = taken;
            context = {
              kind: "named",
              userId: taken.userId,
              workspaceId: taken.workspaceId,
              shareId: taken.shareId,
              grantId: taken.grantId,
            };
          } else if (context!.kind !== "named" || account.userId !== context!.userId) {
            stop();
            return;
          }
          trackedBearer = {
            userId: account.userId,
            session: {
              sessionId: account.sessionId,
              clientKind: account.clientKind,
              expiresAtMs: account.expiresAtMs,
            },
          };
        }
        if (!context) {
          stop();
          return;
        }
        const guard = boundPhone
          ? (path = boundPhone.path) => {
              if (
                done ||
                Date.now() >= trackedBearer!.session.expiresAtMs ||
                accountIsFenced(storage, boundPhone.userId) ||
                !storage.showsOnPhone(boundPhone.userId, boundPhone.workspaceId) ||
                !memberEditGrant(storage, { ...boundPhone, path })
              )
                throw new Error("The phone member's access ended.");
            }
          : undefined;
        // Registered before the ticket is spent, so a sign-out or Show on phone turned off from here on ends this connection.
        connectionScopes.set(stop, {
          workspaceId: context.workspaceId,
          ...(context.kind === "named" ? { userId: context.userId } : {}),
          ...(trackedBearer
            ? { session: trackedBearer.session, recheck: () => host?.assertCurrent() }
            : {}),
        });
        if (trackedBearer) {
          const remainingMs = Math.max(0, trackedBearer.session.expiresAtMs - Date.now());
          if (remainingMs <= MAX_TIMER_MS) {
            sessionExpiry = setTimeout(stop, remainingMs);
            sessionExpiry.unref();
          }
        }
        guard?.();
        const principalKey =
          context.kind === "named"
            ? context.userId
            : "agentConnectionId" in context
              ? `agent:${context.agentConnectionId}`
              : context.profileTokenHash;
        const reservations: [string, number, LiveConnectionLimitCode][] = [
          [
            JSON.stringify([
              "session",
              context.kind,
              principalKey,
              context.workspaceId,
              context.grantId,
              boundPhone ? boundPhone.sessionId : discriminator,
            ]),
            limits.maxConnectionsPerSession,
            "live_session_limit",
          ],
          [
            JSON.stringify(
              context.kind === "named"
                ? ["principal", "named", context.userId]
                : ["principal", "link", context.workspaceId, context.grantId, principalKey],
            ),
            limits.maxConnectionsPerPrincipal,
            "live_person_limit",
          ],
          [
            JSON.stringify(["grant", context.workspaceId, context.grantId]),
            limits.maxConnectionsPerGrant,
            "live_grant_limit",
          ],
        ];
        const ticket = await options.tickets.redeem(token, context, signal);
        signal.throwIfAborted();
        check();
        if (
          !ticket ||
          ticket.audience !== origin ||
          ticket.authority.principalKind !== context.kind ||
          (context.kind === "named" && ticket.authority.principalId !== context.userId) ||
          ticket.authority.grantId !== context.grantId ||
          ticket.binding.workspaceId !== context.workspaceId ||
          (boundPhone &&
            (ticket.binding.objectId !== boundPhone.objectId ||
              ticket.binding.lineageClaimId !== boundPhone.lineageClaimId ||
              hiddenFile(ticket.binding.currentPath)))
        ) {
          stop();
          return;
        }
        reserve(reservations, reservations[1]![0], context.workspaceId, context.shareId);
        releaseEditor = editors.acquire(ticket.binding);
        if (isObjectMutationFenced(storage, ticket.binding.workspaceId, ticket.binding.objectId)) {
          stop();
          return;
        }
        const native = await captureNative(ticket.binding, signal);
        signal.throwIfAborted();
        check();
        const trustedAccount =
          context.kind === "named" ? await accountSnapshot(context.userId) : undefined;
        signal.throwIfAborted();
        check();
        if (trackedBearer) {
          const stored = await untilAborted(
            accountSessions!.read([trackedBearer.session.sessionId]),
            signal,
          );
          signal.throwIfAborted();
          check();
          if (
            !sessionStands(
              stored.get(trackedBearer.session.sessionId),
              trackedBearer.userId,
              trackedBearer.session,
            ) ||
            accountIsFenced(storage, trackedBearer.userId) ||
            (boundPhone &&
              (!storage.showsOnPhone(boundPhone.userId, boundPhone.workspaceId) ||
                hiddenFile(ticket.binding.currentPath)))
          ) {
            stop();
            return;
          }
        }
        const captured = captureNamedLiveFrameHost({
          ticket,
          actor: liveBrowserActor(context),
          ...(trustedAccount ? { trustedAccount } : {}),
          storage,
          native,
          bounds,
          validate,
          reserveBytes,
          validationBudget,
          ...(guard ? { guard: () => guard(ticket.binding.currentPath), personOnly: true } : {}),
        });
        host = options.rooms ? options.rooms.join(captured) : captured;
        host.assertCurrent();
        membership = options.membership?.join({
          ticket,
          invalidated: host.invalidated,
          assertCurrent: host.assertCurrent.bind(host),
        });
      }
      host.invalidated.addEventListener("abort", stop, { once: true });
      host.assertCurrent();
      membership?.invalidated.addEventListener("abort", stop, { once: true });
      if (
        done ||
        host.invalidated.aborted ||
        socket.destroyed ||
        !socket.readable ||
        !socket.writable
      ) {
        stop();
        return;
      }
      server.handleUpgrade(request, socket, head, (accepted) => {
        ws = accepted;
        accepted.binaryType = "nodebuffer";
        if (done) {
          accepted.terminate();
          return;
        }
        accepted.on("error", stop);
        accepted.once("close", stop);
        let controlBytes = 0,
          controlFrames = 0;
        accepted.on("ping", (bytes) => {
          if (
            done ||
            controlFrames >= frames.maxControlFrames ||
            bytes.length > frames.maxControlBytes - controlBytes ||
            accepted.bufferedAmount > limits.maxPendingBytes - bytes.length
          ) {
            stop();
            return;
          }
          if (gatewayFronted || ownerBrowser) {
            try {
              host!.assertCurrent();
            } catch {
              stop();
              return;
            }
            touch();
          }
          let releaseBytes: () => void;
          try {
            releaseBytes = reserveBytes(bytes.length);
          } catch {
            refuseLimit("live_buffer_limit");
            return;
          }
          controlBytes += bytes.length;
          controlFrames++;
          try {
            accepted.pong(bytes, undefined, (error) => {
              releaseBytes();
              controlBytes -= bytes.length;
              controlFrames--;
              if (error) stop();
            });
          } catch {
            releaseBytes();
            stop();
          }
        });
        if (bearerNamed || ownerPhone) {
          let pendingPing: Buffer | undefined;
          accepted.on("pong", (bytes) => {
            if (done || !pendingPing || !Buffer.isBuffer(bytes) || !bytes.equals(pendingPing))
              return;
            pendingPing = undefined;
            try {
              if (
                trackedBearer &&
                (Date.now() >= trackedBearer.session.expiresAtMs ||
                  accountIsFenced(storage, trackedBearer.userId))
              )
                throw new Error();
              host!.assertCurrent();
            } catch {
              stop();
              return;
            }
            touch();
          });
          keepalive = setInterval(
            () => {
              if (done || accepted.readyState !== WebSocket.OPEN) {
                stop();
                return;
              }
              if (pendingPing || accepted.bufferedAmount > limits.maxPendingBytes - 8) return;
              const nonce = randomBytes(8);
              let releasePing: () => void;
              try {
                releasePing = reserveBytes(nonce.length);
              } catch {
                return;
              }
              pendingPing = nonce;
              try {
                accepted.ping(nonce, undefined, (error) => {
                  releasePing();
                  if (error) stop();
                });
              } catch {
                releasePing();
                stop();
              }
            },
            Math.max(1, Math.floor(limits.idleTimeoutMs / 2)),
          );
          keepalive.unref();
        }
        session = createNamedLiveFrameSession({
          host: host!,
          frames,
          membership,
          reserveBytes,
          failed(error) {
            if (error instanceof LiveFrameError && error.limit) {
              const { name, unit, limit, actual } = error.limit;
              console.error(
                `[sync-relay] live frame refused: ${name} is ${String(limit)} ${unit}, the frame needed ${String(actual)} ${unit}`,
              );
            }
            refuseRetryable(error);
          },
          transport: {
            send(bytes) {
              if (
                done ||
                accepted.readyState !== WebSocket.OPEN ||
                accepted.bufferedAmount > limits.maxPendingBytes - bytes.length
              )
                return Promise.reject(new Error("Named transport unavailable."));
              host!.assertCurrent();
              let releaseBytes: () => void;
              try {
                releaseBytes = reserveBytes(bytes.length);
              } catch (error) {
                return Promise.reject(error);
              }
              return new Promise<void>((resolve, reject) => {
                try {
                  accepted.send(bytes, { binary: true, compress: false }, (error) => {
                    releaseBytes();
                    if (error) reject(error);
                    else {
                      touch();
                      resolve();
                    }
                  });
                } catch (error) {
                  releaseBytes();
                  reject(error);
                }
              });
            },
            close: stop,
          },
        });
        accepted.on("message", (bytes, binary) => {
          if (!binary || !Buffer.isBuffer(bytes) || bytes.length === 0) {
            stop();
            return;
          }
          touch();
          session!.receive(bytes);
        });
        touch();
        socket.resume();
      });
      if (!ws) stop();
    } catch (error) {
      if (!refuseRetryable(error)) stop();
    } finally {
      opening = false;
      void release();
    }
  }
  return {
    handle,
    handleUpgrade,
    deleteAccount(userId: string, workspaceIds: readonly string[]) {
      for (const stop of connections) {
        const scope = connectionScopes.get(stop);
        if (scope && (scope.userId === userId || workspaceIds.includes(scope.workspaceId))) stop();
      }
    },
    stopSession(userId: string, sessionId: string) {
      for (const [stop, scope] of connectionScopes)
        if (scope.userId === userId && scope.session?.sessionId === sessionId) stop();
    },
    stopPhoneWorkspace(userId: string, workspaceId: string) {
      for (const [stop, scope] of connectionScopes)
        if (
          scope.userId === userId &&
          scope.workspaceId === workspaceId &&
          scope.session?.clientKind === "phone"
        )
          stop();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sessionChecks);
      shutdown.abort();
      for (const stop of [...connections]) stop();
      server.close();
    },
  };
}
