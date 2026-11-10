import {accountDeletionKey, presentsAccountDeletionKey, ACCOUNT_DELETION_KEY_HEADER, ACCOUNT_DELETION_PATH} from "@dohc/security-contract/account-deletion";
import { createAppLaunchHandler } from "./appLaunch";
import { createNamedAppMaterialResolver } from "./namedAppMaterial";
import { createAppDiscovery } from "./appDiscovery";
import type { AppLaunchConfig } from "./appLaunchConfig";
import {parsePublicEditRelease, type PublicEditRelease} from "@dohc/security-contract";
import {createNamedRecipientChatClient} from "./namedRecipientChat";
import {createPushClient} from "./pushClient";
import {createNamedRecipientDocumentsClient} from "./namedRecipientDocuments";
import type {NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { LINK_SECRET_PATTERN, SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { TokenBucketLimiter, readBoundedJson } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core";
import { RELAY_API_VERSION, RELAY_API_VERSION_HEADER, SHARE_WEB_API_VERSION, SHARE_WEB_API_VERSION_HEADER } from "@dohc/workspace-contracts/relay-values";
import { createAccountAuthHandler, type AccountAuthConfig } from "./accountAuth";
import { isSessionDiscriminator } from "./sessionDiscriminator";
import { createNamedLiveBrowserClient, type NamedLiveBrowserClientLimits, type NamedLiveBrowserSessionContext } from "./namedLiveBrowserClient";
import {createNamedLiveTicketClient} from "./namedLiveTicketClient";
import {createLinkLiveClient} from "./linkLiveClient";
import {linkRefusalBody, parseLinkRefusal} from "@dohc/security-contract/link-refusal";
import {linkChatRefusalBody, opaqueLinkRefusal as refused} from "./linkRefusal";
import {SHARE_WEB_CSP, SHARE_WEB_SECURITY_HEADERS} from "./securityHeaders";
export {SHARE_WEB_CSP, SHARE_WEB_SECURITY_HEADERS} from "./securityHeaders";
import {serveRemoteMcp} from "./remoteMcp";
import {createAgentChatClient} from "./agentChatClient";
import {
  MCP_CORS_HEADERS, MCP_PATH_PREFIX, PERSONAL_MCP_PATH_PREFIX, type SignInPagePolicy, createMcpSignIn, isMcpCorsPath, mcpChallenge,
  mcpLinkSecret, mcpPersonalWorkspace, signInPagePolicy,
} from "./mcpSignIn";
import {servePersonalMcp} from "./personalMcp";
import {createPersonalAgentClient} from "./personalAgentClient";
import {COLLECTION_WRITES_PATH, MAX_COLLECTION_WRITE_ENVELOPE_BYTES} from "./collectionWrites";
import { viewerPage } from "../viewer/src/pages";
import { serveWorkLinkPage } from "./workLinkPage";
import { SHARE_WEB_API_VERSIONS, mcpApiVersions, shareWebApiVersionRefusal } from "./apiVersion";

export const LINK_SESSION_HEADER = "x-dohc-link-session";

const REFUSAL_VALUE = { ok: false, error: "not found" };
const REFUSAL_BODY = JSON.stringify(REFUSAL_VALUE);
const MAX_EXCHANGE_BODY_BYTES = 8 * 1024;
const MAX_DISCUSSION_ENVELOPE_BYTES = 16 * 1024;
// The relay's own bound on a link post: an 8,000-byte body, escaped, and its fields.
const MAX_LINK_CHAT_POST_BYTES = 64 * 1024;
const LINK_CHAT_POST_FIELDS = new Set(["channelWireId", "threadId", "body", "claimedName", "idempotencyKey"]);
const MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const EXCHANGE_BUCKET_CAPACITY = 12;
const EXCHANGE_REFILL_PER_SECOND = 0.2;
const EXCHANGE_MAX_IPS = 10_000;
// Match the relay's global app admission budget.
export const EXCHANGE_GLOBAL_BUCKET_CAPACITY = 2_400;
const EXCHANGE_GLOBAL_REFILL_PER_SECOND = 40;
const MAX_EXCHANGES_IN_FLIGHT = 64;
const DEFAULT_MAX_SESSIONS = 10_000;
export const MAX_SESSIONS_PER_GRANT = 512;
const MAX_BLOB_PROXIES_PER_SESSION = 8;
const MAX_BLOB_PROXIES_PER_GRANT = 24;
const MAX_ACTIVITY_HOLDS_PER_SESSION = 8;
const MAX_ACTIVITY_HOLDS_PER_GRANT = 24;
const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 10_000;
const LINK_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
export const LINK_SESSION_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const PROFILE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const RASTER_SIGNATURE_BYTES = 12;
const DISCUSSION_CURSOR = /^[A-Za-z0-9_-]{1,1024}$/u;
const DISCUSSION_LIMIT = /^[1-9][0-9]{0,2}$/u;
const DISCUSSION_REVISION = /^(?:0|[1-9][0-9]{0,15})$/u;
const DISCUSSION_HOLD = /^(?:0|[1-9][0-9]{0,4})$/u;
const MAX_DISCUSSION_ACTIVITY_HOLD_MS = 30_000;
// A Collection write arrives and commits within the relay's own deadline for it.
const COLLECTION_WRITE_TIMEOUT_MS = 60_000;
// The relay's direct-write rate per link: a burst of 30, then one every two seconds.
const COLLECTION_WRITE_BUCKET_CAPACITY = 30;
const COLLECTION_WRITE_REFILL_PER_SECOND = 0.5;
// Large bodies held in memory at once, for Collection writes and for MCP
// requests that carry one: one per link, and a few in all, as the relay holds.
const LARGE_BODIES_IN_FLIGHT = 4;
const MCP_REQUEST_TIMEOUT_MS = 35_000;
// Refused MCP bearers per client address: a burst of 30, then one every two seconds.
export const MCP_FAILED_SIGN_IN_CAPACITY = 30;
const MCP_FAILED_SIGN_IN_REFILL_PER_SECOND = 0.5;

type RelayFetch = (request: Request) => Promise<Response>;

interface ShareWebSession {
  discriminator: string;
  grantId: string;
  capabilityToken: string;
  expiresAtMs: number;
  createdAtMs: number;
}

type RefreshAttempt =
  | { status: "refreshed"; session: ShareWebSession }
  | { status: "invalid" }
  | { status: "unavailable" };

interface BrowserSession {
  discriminator: string;
  token: string;
  session: ShareWebSession;
}

/**
 * An agent's access on one MCP request: its access token and the MCP address
 * it called. The relay checks both on every call, so nothing here is cached.
 */
interface AgentCaller {
  accessToken: string;
  resource: string;
  /** Counts this token's calls, as a session counts a browser's. */
  key: string;
  /** Counts every agent's MCP requests on this address, before the relay names the grant. */
  addressKey: string;
  /**
   * The link's grant, from the relay's share answer for this token. Every
   * per-link limit after that counts the agent with the link's browsers.
   */
  grantId: string | null;
  /** Set when the relay no longer knows the token for this address. */
  invalid: boolean;
}

type LinkCaller = BrowserSession | AgentCaller;

/**
 * The limits' identity for a caller's link. An agent's MCP request reads the
 * share first, so its grant is known before any per-link limit applies.
 */
function linkKeyOf(caller: LinkCaller): string {
  return "session" in caller ? caller.session.grantId : caller.grantId ?? caller.addressKey;
}

/** Keeps an agent's grant from the relay's share answer, and removes it from the answer. */
function takeAgentGrant(agent: AgentCaller, meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta) return null;
  const { grantId, ...rest } = meta;
  if (typeof grantId === "string" && grantId.length > 0) agent.grantId = grantId;
  return rest;
}

/** One relay call made with a browser session's link capability. */
interface RelayCall {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Sends the relay exchange key. */
  exchangeKey?: boolean;
  /** Extends the deadline by the time the relay may hold the read open. */
  holdMs?: number;
  /** Replaces the relay deadline, for a call the relay may take longer to answer. */
  timeoutMs?: number;
  /** Admits the call against a per-session and per-grant in-flight limit. */
  limiter?: ShareWebInFlightLimiter;
  /** Reads the whole relay body, up to the proxy limit, inside the deadline. */
  buffered?: boolean;
  /** Refuses when the session changed before the call answered. */
  ifSessionChanged?: boolean;
  /**
   * Answers a lost or unreadable relay answer as 503 `link_unavailable`, not as
   * a refusal: a write may have landed, and a read's failure says nothing about the link.
   */
  retryable?: boolean;
  /** Answers a relay 200. `holdSlot` keeps the limiter slot until its release runs. */
  ok?(relayResponse: Response, holdSlot: () => () => void, signal: AbortSignal): Response | Promise<Response>;
  /** Translates a relay refusal, or returns null for the generic refusal. */
  refusal?(relayResponse: Response): Promise<Response | null>;
}

export interface CreateShareWebApplicationOptions {
  appLaunch?: AppLaunchConfig;
  publicEditRelease?: PublicEditRelease;
  relayUrl: string;
  publicRelayUrl: string;
  relayExchangeKey?: string;
  publicHosts: ReadonlySet<string>;
  internalHosts?: ReadonlySet<string>;
  fetchRelay?: RelayFetch;
  nowMs?: () => number;
  newSessionToken?: () => string;
  newProfileSecret?: () => string;
  maxSessions?: number;
  viewerAssetsDir?: string;
  relayTimeoutMs?: number;
  accountAuth?: AccountAuthConfig;
  fetchAuth?: RelayFetch;
  namedBrowserSessionLimits?: NamedLiveBrowserClientLimits;
  namedLiveTickets?: boolean;
  namedRecipientBrowserLimits?: NamedLiveBrowserLimits;
  deleteAccountGateways?(userId: string, workspaceIds: readonly string[]): void;
  linkLive?: {publicOrigin: string; requests: NamedLiveBrowserClientLimits; editor: NamedLiveBrowserLimits};
}

export type LinkBrowserMaterial =
  | { ok: true; grantId?: string; capabilityToken: string; profileSecret: string; setCookie: string | null; currentCapability(): Promise<string | null> }
  | { ok: false; status: 404 | 503 };

export interface ShareWebApplication {
  handle(request: Request): Promise<Response>;
  resolveNamedBrowserSession(request: Request, discriminator: string): Promise<NamedLiveBrowserSessionContext | null>;
  linkLive?: ReturnType<typeof createLinkLiveClient>;
  resolveLinkBrowserMaterial(
    discriminator: string,
    cookie: string | null,
    signal: AbortSignal,
  ): Promise<LinkBrowserMaterial>;
}

class ShareWebSessionStore {
  private readonly sessions = new Map<string, ShareWebSession>();

  constructor(private readonly maxSessions: number) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
      throw new Error("maxSessions must be a positive integer");
    }
  }

  deleteGrants(grantIds: readonly string[]) {
    for (const [key, session] of this.sessions) if (grantIds.includes(session.grantId)) this.sessions.delete(key);
  }

  set(token: string, session: ShareWebSession, nowMs: number): void {
    this.prune(nowMs);
    while (this.countForGrant(session.grantId) >= MAX_SESSIONS_PER_GRANT) {
      if (!this.evictOldestFromGrant(session.grantId)) break;
    }
    while (this.sessions.size >= this.maxSessions) {
      if (!this.evictOldestFromLargestGrant()) break;
    }
    this.sessions.set(sessionKey(session.discriminator, token), session);
  }

  get(discriminator: string, token: string, nowMs: number): ShareWebSession | null {
    const key = sessionKey(discriminator, token);
    const session = this.sessions.get(key);
    if (
      !session ||
      session.expiresAtMs + LINK_SESSION_RENEWAL_GRACE_MS < nowMs
    ) {
      if (session) this.sessions.delete(key);
      return null;
    }
    return session;
  }

  deleteIfCapability(
    discriminator: string,
    token: string,
    capabilityToken: string,
  ): void {
    const key = sessionKey(discriminator, token);
    if (this.sessions.get(key)?.capabilityToken === capabilityToken) {
      this.sessions.delete(key);
    }
  }

  replaceCapability(
    discriminator: string,
    token: string,
    expectedCapabilityToken: string,
    capabilityToken: string,
    expiresAtMs: number,
  ): ShareWebSession | null {
    const session = this.sessions.get(sessionKey(discriminator, token));
    if (!session || session.capabilityToken !== expectedCapabilityToken) return null;
    session.capabilityToken = capabilityToken;
    session.expiresAtMs = expiresAtMs;
    return session;
  }

  isCurrent(
    discriminator: string,
    token: string,
    capabilityToken: string,
    nowMs: number,
  ): boolean {
    return this.get(discriminator, token, nowMs)?.capabilityToken === capabilityToken;
  }

  private prune(nowMs: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAtMs + LINK_SESSION_RENEWAL_GRACE_MS < nowMs) {
        this.sessions.delete(key);
      }
    }
  }

  private countForGrant(grantId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.grantId === grantId) count += 1;
    }
    return count;
  }

  private evictOldestFromGrant(grantId: string): boolean {
    for (const [key, session] of this.sessions) {
      if (session.grantId !== grantId) continue;
      this.sessions.delete(key);
      return true;
    }
    return false;
  }

  private evictOldestFromLargestGrant(): boolean {
    const grants = new Map<string, { count: number; oldestKey: string }>();
    for (const [key, session] of this.sessions) {
      const grant = grants.get(session.grantId);
      if (grant) {
        grant.count += 1;
      } else {
        grants.set(session.grantId, { count: 1, oldestKey: key });
      }
    }

    let largest: { count: number; oldestKey: string } | null = null;
    for (const grant of grants.values()) {
      if (!largest || grant.count > largest.count) largest = grant;
    }
    return largest ? this.sessions.delete(largest.oldestKey) : false;
  }
}

class ShareWebInFlightLimiter {
  private readonly inFlightBySession = new Map<string, number>();
  private readonly inFlightByGrant = new Map<string, number>();

  constructor(
    private readonly maxPerSession: number,
    private readonly maxPerGrant: number,
  ) {}

  acquire(sessionIdentity: string, grantIdentity: string): (() => void) | null {
    const sessionInFlight = this.inFlightBySession.get(sessionIdentity) ?? 0;
    const grantInFlight = this.inFlightByGrant.get(grantIdentity) ?? 0;
    if (
      sessionInFlight >= this.maxPerSession ||
      grantInFlight >= this.maxPerGrant
    ) {
      return null;
    }
    this.inFlightBySession.set(sessionIdentity, sessionInFlight + 1);
    this.inFlightByGrant.set(grantIdentity, grantInFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(this.inFlightBySession, sessionIdentity);
      this.release(this.inFlightByGrant, grantIdentity);
    };
  }

  private release(inFlightByIdentity: Map<string, number>, identity: string): void {
    const remaining = (inFlightByIdentity.get(identity) ?? 1) - 1;
    if (remaining === 0) {
      inFlightByIdentity.delete(identity);
    } else {
      inFlightByIdentity.set(identity, remaining);
    }
  }
}

function sessionKey(discriminator: string, token: string): string {
  return `${discriminator}:${createHash("sha256").update(token).digest("base64url")}`;
}

/** Admits one large body per link, and a few in all: a release, or null when full. */
function largeBodyAdmission(limit = LARGE_BODIES_IN_FLIGHT): (grantId: string) => (() => void) | null {
  const holding = new Set<string>();
  return (grantId) => {
    if (holding.has(grantId) || holding.size >= limit) return null;
    holding.add(grantId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holding.delete(grantId);
    };
  };
}

function linkDiscriminator(grantId: string): string {
  return createHash("sha256").update(grantId).digest("base64url").slice(0, 12);
}

function cookieName(discriminator: string): string {
  return `dohc_share_${discriminator}`;
}

function profileCookieName(discriminator: string): string {
  return `dohc_share_profile_${discriminator}`;
}

// Every response the viewer origin serves carries the security headers. Only
// the MCP sign-in pages name their own policy, so the consent form can post
// back here and follow its redirect to the agent.
function response(
  body: BodyInit | null,
  init: { status?: number; headers?: HeadersInit; page?: SignInPagePolicy } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(SHARE_WEB_SECURITY_HEADERS)) headers.set(key, value);
  if (init.page) {
    headers.set("content-security-policy", init.page.contentSecurityPolicy);
    headers.set("referrer-policy", init.page.referrerPolicy);
  }
  return new Response(body, { status: init.status ?? 200, headers });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return response(JSON.stringify(body), { status: init.status, headers });
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) cookies.set(name, value);
  }
  return cookies;
}

async function exchangeInput(request: Request): Promise<string | null> {
  try {
    const input = asRecord(await readBoundedJson(request, MAX_EXCHANGE_BODY_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(DEFAULT_RELAY_REQUEST_TIMEOUT_MS)])));
    if (!input) return null;
    const secret = input.secret;
    return typeof secret === "string" && LINK_SECRET_PATTERN.test(secret)
      ? secret
      : null;
  } catch {
    return null;
  }
}

async function discussionInput(request: Request): Promise<string | null> {
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_DISCUSSION_ENVELOPE_BYTES) return null;
    const body = asRecord(JSON.parse(text));
    if (!body) return null;
    if (
      Object.keys(body).some(
        (key) => key !== "body" && key !== "idempotencyKey" && key !== "claimedName",
      ) ||
      typeof body.body !== "string" ||
      typeof body.idempotencyKey !== "string" ||
      (Object.hasOwn(body, "claimedName") && typeof body.claimedName !== "string")
    ) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function logRelayPath(request: Request): string {
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ["since", "limit", "hold", "current"]) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const serialized = query.toString();
  return `/sync/link/log${serialized ? `?${serialized}` : ""}`;
}

function discussionRelayPath(request: Request): string | null {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (
      key !== "session" &&
      key !== "cursor" &&
      key !== "limit" &&
      key !== "direction"
    ) {
      return null;
    }
  }
  if (
    url.searchParams.getAll("session").length > 1 ||
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("direction").length > 1
  ) {
    return null;
  }
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  const direction = url.searchParams.get("direction");
  if (
    (cursor !== null && !DISCUSSION_CURSOR.test(cursor)) ||
    (limit !== null && (!DISCUSSION_LIMIT.test(limit) || Number(limit) > 100)) ||
    (direction !== null &&
      direction !== "oldest-first" &&
      direction !== "newest-first")
  ) {
    return null;
  }
  const relaySearch = new URLSearchParams();
  if (cursor !== null) relaySearch.set("cursor", cursor);
  if (direction !== null) relaySearch.set("direction", direction);
  if (limit !== null) relaySearch.set("limit", limit);
  const serialized = relaySearch.toString();
  return `/sync/link/discussion${serialized ? `?${serialized}` : ""}`;
}

function discussionActivityRelayPath(
  request: Request,
): { path: string; holdMs: number } | null {
  const url = new URL(request.url);
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== "since" && key !== "hold" && key !== "limit",
    ) ||
    url.searchParams.getAll("since").length !== 1 ||
    url.searchParams.getAll("hold").length !== 1 ||
    url.searchParams.getAll("limit").length !== 1
  ) {
    return null;
  }
  const since = url.searchParams.get("since")!;
  const hold = url.searchParams.get("hold")!;
  const limit = url.searchParams.get("limit")!;
  if (
    !DISCUSSION_REVISION.test(since) ||
    !Number.isSafeInteger(Number(since)) ||
    !DISCUSSION_HOLD.test(hold) ||
    Number(hold) > MAX_DISCUSSION_ACTIVITY_HOLD_MS ||
    !DISCUSSION_LIMIT.test(limit) ||
    Number(limit) > 100
  ) {
    return null;
  }
  const relaySearch = new URLSearchParams({ since, hold, limit });
  return {
    path: `/sync/link/discussion/activity?${relaySearch}`,
    holdMs: Number(hold),
  };
}

function hasOnlySessionQuery(request: Request, discriminator: string): boolean {
  const params = new URL(request.url).searchParams;
  const session = params.get("session");
  return (
    [...params.keys()].every((key) => key === "session") &&
    params.getAll("session").length <= 1 &&
    (session === null || session === discriminator)
  );
}

async function discussionState(
  relayResponse: Response,
): Promise<
  | { state: "blocked" | "paused"; activityRevision: number }
  | { state: "limit-reached" }
  | null
> {
  // The relay error code is the contract; its message text is not.
  try {
    const record = asRecord(await relayResponse.json());
    if (!record || record.ok !== false || typeof record.error !== "string") return null;
    if (relayResponse.status === 403) {
      const state =
        record.code === "link_discussion_blocked"
          ? "blocked"
          : record.code === "link_discussion_paused"
            ? "paused"
            : null;
      if (
        state === null ||
        Object.keys(record).sort().join(",") !== "activityRevision,code,error,ok" ||
        typeof record.activityRevision !== "number" ||
        !Number.isSafeInteger(record.activityRevision) ||
        record.activityRevision < 0
      ) {
        return null;
      }
      return { state, activityRevision: record.activityRevision };
    }
    if (
      relayResponse.status === 413 &&
      Object.keys(record).sort().join(",") === "code,error,ok" &&
      record.code === "discussion_limit_reached"
    ) {
      return { state: "limit-reached" };
    }
    return null;
  } catch {
    return null;
  }
}

async function discussionRefusal(relayResponse: Response): Promise<Response | null> {
  if (relayResponse.status !== 403 && relayResponse.status !== 413) return null;
  const state = await discussionState(relayResponse);
  return state && jsonResponse(
    { ok: false, ...state },
    { status: state.state === "limit-reached" ? 413 : 403 },
  );
}

// A Group's channel read through its link: the channel, a page of messages
// newest first with `before`, or new ones with `since` and an optional hold.
function linkChatReadPath(request: Request, channels: boolean): { path: string; holdMs: number } | null {
  const params = new URL(request.url).searchParams;
  const allowed = channels ? ["session"] : ["session", "channelWireId", "before", "since", "hold", "limit"];
  if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) return null;
  if (channels) return { path: "/sync/link/chat/channels", holdMs: 0 };
  const channelWireId = params.get("channelWireId");
  const cursor = (key: string) => params.get(key) === null || /^(?:0|[1-9][0-9]{0,15})$/u.test(params.get(key)!);
  const hold = params.get("hold") ?? "0";
  if (!channelWireId || channelWireId.length > 256 || !cursor("before") || !cursor("since") ||
      !DISCUSSION_HOLD.test(hold) || Number(hold) > MAX_DISCUSSION_ACTIVITY_HOLD_MS ||
      (params.has("limit") && (!DISCUSSION_LIMIT.test(params.get("limit")!) || Number(params.get("limit")) > 100))) return null;
  const relaySearch = new URLSearchParams({ channelWireId });
  for (const key of ["before", "since", "hold", "limit"]) {
    const value = params.get(key);
    if (value !== null) relaySearch.set(key, value);
  }
  return { path: `/sync/link/chat/messages?${relaySearch}`, holdMs: Number(hold) };
}

// Only what a post is: its channel, an optional thread, the body, a retry
// key and the link holder's optional name.
async function linkChatPostInput(request: Request): Promise<string | null> {
  try {
    const value = asRecord(await readBoundedJson(request, MAX_LINK_CHAT_POST_BYTES, request.signal));
    if (
      !value || Object.keys(value).some((key) => !LINK_CHAT_POST_FIELDS.has(key)) ||
      typeof value.channelWireId !== "string" || typeof value.body !== "string" || typeof value.idempotencyKey !== "string" ||
      (Object.hasOwn(value, "threadId") && typeof value.threadId !== "string") ||
      (Object.hasOwn(value, "claimedName") && typeof value.claimedName !== "string")
    ) {
      return null;
    }
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

async function linkChatRefusal(relayResponse: Response): Promise<Response | null> {
  const refusal = linkChatRefusalBody(await relayResponse.json().catch(() => null), relayResponse.status);
  return refusal ? jsonResponse(refusal, { status: relayResponse.status }) : null;
}

// A Collection write's answers, as `parseCollectionWriteOutcome` reads them.
// Only the receipt's own fields pass: the relay's words, never its headers.
async function acceptedCollectionWrite(relayResponse: Response): Promise<Response> {
  const receipt = asRecord(await relayResponse.json().catch(() => null));
  if (receipt?.ok !== true || typeof receipt.submitId !== "string") return jsonResponse(linkRefusalBody("link_unavailable"), {status: 503});
  // A retry the relay already recorded is accepted the same way. The paths
  // are the writer's own, so the answer stays small.
  return jsonResponse({ ok: true, outcome: "accepted", submitId: receipt.submitId });
}

async function collectionWriteRefusal(relayResponse: Response): Promise<Response | null> {
  if (![400, 403, 409, 413, 429].includes(relayResponse.status)) return null;
  const record = asRecord(await relayResponse.json().catch(() => null));
  if (!record || typeof record.error !== "string") return null;
  // The relay limits a link's writes only after it verified the link.
  if (relayResponse.status === 429) {
    return record.code === "collection_write_rate_limited" ? writesRateLimited() : null;
  }
  // A stale base names the file and its current content, so the writer
  // keeps their text and reads the winner before trying again.
  if (relayResponse.status === 409 && record.code === "stale") {
    const current = record.currentBlobSha256;
    if (typeof record.path !== "string" || !(current === null || (typeof current === "string" && SHA256_HEX_PATTERN.test(current)))) {
      return null;
    }
    return jsonResponse({ ok: false, outcome: "stale", path: record.path, currentBlobSha256: current }, { status: 409 });
  }
  return jsonResponse({ ok: false, outcome: "refused", reason: record.error.slice(0, 1024) }, { status: 403 });
}

const writesRateLimited = (): Response => jsonResponse(linkRefusalBody("link_read_rate_limited"), {status: 429});

function relayJson(relayResponse: Response): Response {
  return response(relayResponse.body, {
    headers: { "content-type": "application/json" },
  });
}

function relayRequest(relayUrl: string, path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, `${relayUrl.replace(/\/+$/u, "")}/`), init);
}

function boundedRelayRequest(
  clientSignal: AbortSignal | undefined,
  relayUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): { request: Request; dispose: () => void } {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  return {
    request: relayRequest(relayUrl, path, {
      ...init,
      signal: clientSignal ? AbortSignal.any([clientSignal, deadline.signal]) : deadline.signal,
    }),
    // Disposing ends only the deadline: a streamed body outlives it but still
    // stops when the browser leaves.
    dispose: () => clearTimeout(timer),
  };
}

async function completeRelayResponse(relayResponse: Response): Promise<Response> {
  const declaredLength = relayResponse.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^[0-9]+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_RELAY_RESPONSE_BYTES
  ) {
    await relayResponse.body?.cancel().catch(() => undefined);
    throw new Error("relay response exceeds the public proxy limit");
  }

  const reader = relayResponse.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  if (reader) {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (read.value.byteLength === 0) continue;
      if (read.value.byteLength > MAX_RELAY_RESPONSE_BYTES - bufferedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("relay response exceeds the public proxy limit");
      }
      chunks.push(read.value);
      bufferedBytes += read.value.byteLength;
    }
  }

  let chunkIndex = 0;
  const body = bufferedBytes === 0
    ? null
    : new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[chunkIndex++];
          if (chunk) controller.enqueue(chunk);
          if (chunkIndex === chunks.length) controller.close();
        },
        cancel() {
          chunks.length = 0;
        },
      });
  return new Response(body, {
    status: relayResponse.status,
    statusText: relayResponse.statusText,
    headers: relayResponse.headers,
  });
}

function sessionCookie(
  discriminator: string,
  token: string,
  expiresAtMs: number,
  nowMs: number,
): string {
  const maxAge = Math.max(
    1,
    Math.ceil(
      (expiresAtMs + LINK_SESSION_RENEWAL_GRACE_MS - nowMs) / 1_000,
    ),
  );
  return (
    `${cookieName(discriminator)}=${token}; Path=/; Max-Age=${maxAge}; ` +
    "Secure; HttpOnly; SameSite=Strict"
  );
}

function profileCookie(discriminator: string, secret: string): string {
  return (
    `${profileCookieName(discriminator)}=${secret}; Path=/; ` +
    `Max-Age=${PROFILE_COOKIE_MAX_AGE_SECONDS}; ` +
    "Secure; HttpOnly; SameSite=Strict"
  );
}

function parsedRelaySession(
  value: unknown,
  nowMs: number,
  release?: PublicEditRelease,
): { grantId: string; capabilityToken: string; expiresAtMs: number } | null {
  const relaySession = asRecord(value);
  if (!relaySession || (relaySession.access === "edit" && !release)) return null;
  const grantId = relaySession.grantId;
  const capabilityToken = relaySession.capabilityToken;
  const expiresAtMs = relaySession.capabilityExpiresAtMs;
  if (
    typeof grantId !== "string" ||
    grantId.length === 0 ||
    typeof capabilityToken !== "string" ||
    !LINK_SECRET_PATTERN.test(capabilityToken) ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    return null;
  }
  return { grantId, capabilityToken, expiresAtMs };
}

function parsedRelayHandoff(
  value: unknown,
  nowMs: number,
): { code: string; expiresAtMs: number } | null {
  const handoff = asRecord(value);
  if (!handoff) return null;
  if (
    handoff.ok !== true ||
    typeof handoff.code !== "string" ||
    !LINK_SECRET_PATTERN.test(handoff.code) ||
    typeof handoff.expiresAtMs !== "number" ||
    !Number.isSafeInteger(handoff.expiresAtMs) ||
    handoff.expiresAtMs <= nowMs
  ) {
    return null;
  }
  return { code: handoff.code, expiresAtMs: handoff.expiresAtMs };
}

function contentTypeForAsset(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function rasterContentType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const gifSignature = String.fromCharCode(...bytes.subarray(0, 6));
  if (
    bytes.length >= 6 &&
    (gifSignature === "GIF87a" || gifSignature === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function bodyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function streamingBlobResponse(
  relayResponse: Response,
  release: () => void,
): Promise<Response> {
  if (!relayResponse.body) {
    release();
    return response(null, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
      },
    });
  }

  const reader = relayResponse.body.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let upstreamDone = false;
  try {
    while (bufferedBytes < RASTER_SIGNATURE_BYTES && !upstreamDone) {
      const read = await reader.read();
      upstreamDone = read.done;
      if (read.value && read.value.byteLength > 0) {
        buffered.push(read.value);
        bufferedBytes += read.value.byteLength;
      }
    }
  } catch (error) {
    release();
    throw error;
  }

  const signature = new Uint8Array(
    Math.min(bufferedBytes, RASTER_SIGNATURE_BYTES),
  );
  let signatureOffset = 0;
  for (const chunk of buffered) {
    const remaining = signature.byteLength - signatureOffset;
    if (remaining <= 0) break;
    const included = chunk.subarray(0, remaining);
    signature.set(included, signatureOffset);
    signatureOffset += included.byteLength;
  }
  const raster = rasterContentType(signature);
  let bufferedIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex++]!);
        return;
      }
      if (upstreamDone) {
        release();
        controller.close();
        return;
      }
      try {
        const read = await reader.read();
        upstreamDone = read.done;
        if (read.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(read.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason: unknown) {
      release();
      await reader.cancel(reason);
    },
  });
  return response(body, {
    headers: raster
      ? { "content-type": raster }
      : {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
        },
  });
}

export function createShareWebApplication({
  relayUrl,
  publicRelayUrl,
  relayExchangeKey,
  publicHosts,
  internalHosts,
  fetchRelay: sendToRelay = (request) => fetch(request),
  nowMs = () => Date.now(),
  newSessionToken = () => randomBytes(32).toString("base64url"),
  newProfileSecret = () => randomBytes(32).toString("base64url"),
  maxSessions = DEFAULT_MAX_SESSIONS,
  viewerAssetsDir,
  relayTimeoutMs = DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  accountAuth,
  fetchAuth,
  namedBrowserSessionLimits,
  namedLiveTickets,
  namedRecipientBrowserLimits,
  deleteAccountGateways,
  linkLive: linkLiveConfig,
  publicEditRelease: releaseInput,
  appLaunch: appLaunchConfig,
}: CreateShareWebApplicationOptions): ShareWebApplication {
  const apiVersions = SHARE_WEB_API_VERSIONS;
  if (SHARE_WEB_API_VERSION < apiVersions.min || SHARE_WEB_API_VERSION > apiVersions.max) {
    throw new TypeError("Share-web API version range must include the compiled version.");
  }
  // Every relay request names the relay API version this build speaks.
  const fetchRelay: RelayFetch = (request) => {
    const headers = new Headers(request.headers);
    headers.set(RELAY_API_VERSION_HEADER, String(RELAY_API_VERSION));
    return sendToRelay(new Request(request, { headers }));
  };
  const publicEditRelease = parsePublicEditRelease(releaseInput);
  if (publicEditRelease && !linkLiveConfig) throw new TypeError("Public Edit release requires configured link live limits.");
  if (namedBrowserSessionLimits && (!accountAuth || !relayExchangeKey || !publicHosts.has(new URL(accountAuth.publicOrigin).host))) {
    throw new TypeError("Named browser sessions require configured account auth and relay exchange.");
  }
  const namedBrowser = namedBrowserSessionLimits ? createNamedLiveBrowserClient({
    relayUrl, publicOrigin: accountAuth!.publicOrigin, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits, fetchRelay,
  }) : undefined;
  if (namedLiveTickets && !namedBrowser) throw new TypeError("Named live tickets require named browser sessions.");
  const namedTickets = namedLiveTickets ? createNamedLiveTicketClient({
    relayUrl, publicOrigin: accountAuth!.publicOrigin, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits!, fetchRelay,
  }) : undefined;
  if (namedRecipientBrowserLimits && !namedTickets) throw new TypeError("Named recipient editing requires named live tickets.");
  const namedDocuments = namedRecipientBrowserLimits ? createNamedRecipientDocumentsClient({
    relayUrl, publicOrigin: accountAuth!.publicOrigin, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits!,
    browserLimits: namedRecipientBrowserLimits, fetchRelay,
  }) : undefined;
  const namedChat = namedBrowserSessionLimits ? createNamedRecipientChatClient({
    relayUrl, publicOrigin: accountAuth!.publicOrigin, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits, fetchRelay,
  }) : undefined;
  const push = namedBrowserSessionLimits ? createPushClient({
    relayUrl, publicOrigin: accountAuth!.publicOrigin, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits, fetchRelay,
  }) : undefined;
  const accountHandler = accountAuth ? createAccountAuthHandler({
    ...accountAuth,
    fetchAuth,
    maxRequestBytes: MAX_EXCHANGE_BODY_BYTES,
    maxResponseBytes: MAX_RELAY_RESPONSE_BYTES,
    timeoutMs: DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  }) : undefined;
  const sessions = new ShareWebSessionStore(maxSessions);
  const exchangeRateLimiter = new TokenBucketLimiter(EXCHANGE_BUCKET_CAPACITY, EXCHANGE_REFILL_PER_SECOND, EXCHANGE_MAX_IPS);
  const exchangeGlobalRateLimiter = new TokenBucketLimiter(EXCHANGE_GLOBAL_BUCKET_CAPACITY, EXCHANGE_GLOBAL_REFILL_PER_SECOND, 1);
  const exchangeAddressProbes = new TokenBucketLimiter(600, 10, EXCHANGE_MAX_IPS);
  const exchangeAddressInFlight = new Map<string, number>();
  let exchangesInFlight = 0;
  const blobProxyLimiter = new ShareWebInFlightLimiter(
    MAX_BLOB_PROXIES_PER_SESSION,
    MAX_BLOB_PROXIES_PER_GRANT,
  );
  const activityHoldLimiter = new ShareWebInFlightLimiter(
    MAX_ACTIVITY_HOLDS_PER_SESSION,
    MAX_ACTIVITY_HOLDS_PER_GRANT,
  );
  const refreshes = new Map<string, Promise<RefreshAttempt>>();
  const mcpLimiter = new ShareWebInFlightLimiter(4, 16);
  // Only a refused bearer spends from its address; a valid one never does.
  const mcpFailedSignIns = new TokenBucketLimiter(MCP_FAILED_SIGN_IN_CAPACITY, MCP_FAILED_SIGN_IN_REFILL_PER_SECOND, EXCHANGE_MAX_IPS);
  // One pool for every large body, whether it arrives as a Collection write
  // or as an MCP request that carries one. Either spends one of the link's
  // write tokens first. The one write an MCP request makes uses the token
  // and slot that request already took.
  const admitLargeBody = largeBodyAdmission();
  const writesInsideAdmittedRequests = new WeakSet<Request>();
  // A link's browsers and agents spend one budget, by its grant, before a
  // body is read. The relay limits the whole link again.
  const collectionWriteRateLimiter = new TokenBucketLimiter(COLLECTION_WRITE_BUCKET_CAPACITY, COLLECTION_WRITE_REFILL_PER_SECOND, EXCHANGE_MAX_IPS);
  let mcpRequests = 0;
  // An MCP request's internal calls to the link handlers carry their agent
  // here, never in a header or cookie a client could send.
  const agentCallers = new WeakMap<Request, AgentCaller>();
  // A personal agent signs in with the browser's account, on the origin its cookies belong to.
  const mcpSignIn = createMcpSignIn({relayUrl, exchangeKey: relayExchangeKey, fetchRelay, nowMs, timeoutMs: relayTimeoutMs,
    admit: (clientIp) => exchangeAddressProbes.allow(clientIp, nowMs()) && exchangeGlobalRateLimiter.allow("global", nowMs()),
    ...(accountAuth && accountHandler ? {account: {publicOrigin: accountAuth.publicOrigin, handle: accountHandler}} : {})});
  if (linkLiveConfig &&(!relayExchangeKey || !publicHosts.has(new URL(linkLiveConfig.publicOrigin).host))) throw new TypeError("Link editing requires configured relay exchange and public Host.");
  const linkLive = linkLiveConfig && publicEditRelease ? createLinkLiveClient({relayUrl, publicOrigin: linkLiveConfig.publicOrigin, exchangeKey: relayExchangeKey!,
    limits: linkLiveConfig.requests, browserLimits: linkLiveConfig.editor, fetchRelay, resolveMaterial: resolveLinkBrowserMaterial}) : undefined;

  function readBrowserSession(discriminator: string, cookies: Map<string, string>): BrowserSession | null {
    if (!isSessionDiscriminator(discriminator)) return null;
    const token = cookies.get(cookieName(discriminator));
    if (!token) return null;
    const session = sessions.get(discriminator, token, nowMs());
    return session ? { discriminator, token, session } : null;
  }

  function readSession(request: Request) {
    return readBrowserSession(
      request.headers.get(LINK_SESSION_HEADER) ??
        new URL(request.url).searchParams.get("session") ?? "",
      parseCookies(request.headers.get("cookie")),
    );
  }

  async function serveViewer(pathname: string): Promise<Response> {
    if (!viewerAssetsDir) return refused();
    const page = !pathname.startsWith("/s/assets/");
    const relative = page ? viewerPage(pathname) : pathname.slice("/s/".length);
    if (relative.includes("..") || relative.includes("\\")) return refused();
    try {
      const bytes = await readFile(join(viewerAssetsDir, relative));
      const result = response(bodyBuffer(bytes), {
        headers: { "content-type": contentTypeForAsset(relative) },
      });
      if (page && appLaunchConfig) result.headers.set("content-security-policy", SHARE_WEB_CSP.replace("form-action 'none'", `form-action https://*.${appLaunchConfig.appDomain}`));
      return result;
    } catch {
      return refused();
    }
  }

  async function refreshSession(
    authenticated: BrowserSession,
  ): Promise<
    | { ok: true; headers: Record<string, string> }
    | { ok: false; status: 404 | 503 }
  > {
    const checkedAtMs = nowMs();
    if (
      authenticated.session.expiresAtMs - checkedAtMs >
      LINK_REFRESH_WINDOW_MS
    ) {
      return { ok: true, headers: {} };
    }

    const key = sessionKey(authenticated.discriminator, authenticated.token);
    const capabilityBeforeRefresh = authenticated.session.capabilityToken;
    let refresh = refreshes.get(key);
    if (!refresh) {
      const expectedCapabilityToken = capabilityBeforeRefresh;
      const pending = (async (): Promise<RefreshAttempt> => {
        const boundedRelay = boundedRelayRequest(
          undefined,
          relayUrl,
          "/sync/link-refresh",
          {
            method: "POST",
            headers: {
              authorization: `LinkCapability ${expectedCapabilityToken}`,
              ...(relayExchangeKey
                ? { "x-dohc-relay-exchange-key": relayExchangeKey }
                : {}),
            },
          },
          relayTimeoutMs,
        );
        let relayResponse: Response | undefined;
        try {
          relayResponse = await fetchRelay(boundedRelay.request);
          if (relayResponse.status === 404) return { status: "invalid" };
          if (relayResponse.status !== 200) return { status: "unavailable" };
          const refreshed = parsedRelaySession(
            await readBoundedJson(relayResponse, MAX_RELAY_RESPONSE_BYTES, boundedRelay.request.signal),
            nowMs(),
            publicEditRelease,
          );
          if (!refreshed || refreshed.grantId !== authenticated.session.grantId) {
            return { status: "unavailable" };
          }
          const session = sessions.replaceCapability(
            authenticated.discriminator,
            authenticated.token,
            expectedCapabilityToken,
            refreshed.capabilityToken,
            refreshed.expiresAtMs,
          );
          return session
            ? { status: "refreshed", session }
            : { status: "unavailable" };
        } catch {
          return { status: "unavailable" };
        } finally {
          await relayResponse?.body?.cancel().catch(() => undefined);
          boundedRelay.dispose();
        }
      })();
      const tracked = pending.finally(() => {
        if (refreshes.get(key) === tracked) refreshes.delete(key);
      });
      refreshes.set(key, tracked);
      refresh = tracked;
    }

    const attempt = await refresh;
    if (attempt.status === "invalid") {
      sessions.deleteIfCapability(
        authenticated.discriminator,
        authenticated.token,
        capabilityBeforeRefresh,
      );
      return { ok: false, status: 404 };
    }
    if (attempt.status === "unavailable") {
      if (authenticated.session.expiresAtMs <= nowMs()) {
        return { ok: false, status: 503 };
      }
      return { ok: true, headers: {} };
    }
    return {
      ok: true,
      headers: {
        "set-cookie": sessionCookie(
          authenticated.discriminator,
          authenticated.token,
          attempt.session.expiresAtMs,
          nowMs(),
        ),
      },
    };
  }

  async function resolveLinkBrowserMaterial(
    discriminator: string,
    cookie: string | null,
    signal: AbortSignal,
  ): Promise<LinkBrowserMaterial> {
    signal.throwIfAborted();
    const cookies = parseCookies(cookie);
    const authenticated = readBrowserSession(discriminator, cookies);
    const profileSecret = cookies.get(profileCookieName(discriminator));
    if (!authenticated || !profileSecret || !LINK_SECRET_PATTERN.test(profileSecret)) {
      return { ok: false, status: 404 };
    }
    let abort = (): void => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const refreshed = await Promise.race([refreshSession(authenticated), cancelled]);
      signal.throwIfAborted();
      if (!refreshed.ok) return refreshed;
      const capabilityToken = authenticated.session.capabilityToken;
      if (!sessions.isCurrent(discriminator, authenticated.token, capabilityToken, nowMs())) {
        return { ok: false, status: 404 };
      }
      return { ok: true, grantId: authenticated.session.grantId, capabilityToken, profileSecret, setCookie: refreshed.headers["set-cookie"] ?? null,
        async currentCapability() {
          await refreshes.get(sessionKey(discriminator, authenticated.token));
          const current = sessions.get(discriminator, authenticated.token, nowMs());
          return current === authenticated.session && current.expiresAtMs > nowMs() ? current.capabilityToken : null;
        } };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // A browser calls with its session's capability; an agent with its own
  // token and address, which the relay checks again on every call.
  async function callRelay(request: Request, caller: LinkCaller, call: RelayCall): Promise<Response> {
    const browser = "session" in caller ? caller : null;
    const agent = "session" in caller ? null : caller;
    const refreshed = browser ? await refreshSession(browser) : {ok: true as const, headers: {} as Record<string, string>};
    if (!refreshed.ok) return refreshed.status === 503
      ? jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}) : refused();
    const capabilityToken = browser?.session.capabilityToken ?? "";
    const credential: Record<string, string> = agent
      ? {authorization: `DohcAgent ${agent.accessToken}`, "x-dohc-agent-resource": agent.resource, "x-dohc-relay-exchange-key": relayExchangeKey ?? ""}
      : {authorization: `LinkCapability ${capabilityToken}`};
    const current = (): boolean =>
      !browser || sessions.isCurrent(browser.discriminator, browser.token, capabilityToken, nowMs());
    // Only an answer for a still-current session renews its cookie. A cookie
    // for a dead session could overwrite a newer one.
    const answer = (result: Response): Response => {
      if (current()) {
        for (const [name, value] of Object.entries(refreshed.headers)) result.headers.set(name, value);
      }
      return result;
    };
    // A renewal replaces the capability without ending the grant, so a
    // retryable call it superseded tries again instead of ending the link.
    // A renewal can overtake any call, so a failed retryable one always checks.
    const superseded = (failed = false): Response | null => {
      if (!browser || !(call.ifSessionChanged || (failed && call.retryable)) || current()) return null;
      const renewed = call.retryable &&
        sessions.get(browser.discriminator, browser.token, nowMs())?.grantId === browser.session.grantId;
      return renewed ? jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}) : refused();
    };
    const release = !call.limiter ? () => {} : browser
      ? call.limiter.acquire(sessionKey(browser.discriminator, browser.token), browser.session.grantId)
      : call.limiter.acquire(agent?.key ?? "", linkKeyOf(caller));
    // A full limiter is busy, not a refusal: the link still opens.
    if (!release) return answer(call.retryable
      ? jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}) : refused());
    let slotHeld = false;
    const holdSlot = (): (() => void) => {
      slotHeld = true;
      return release;
    };
    const bounded = boundedRelayRequest(
      request.signal,
      relayUrl,
      call.path,
      {
        method: call.method,
        headers: {
          ...credential,
          ...(call.exchangeKey && relayExchangeKey
            ? { "x-dohc-relay-exchange-key": relayExchangeKey }
            : {}),
          ...call.headers,
        },
        body: call.body,
      },
      (call.timeoutMs ?? relayTimeoutMs) + (call.holdMs ?? 0),
    );
    try {
      let relayResponse = await fetchRelay(bounded.request);
      // Only share metadata identifies the session itself; target refusals do not.
      if (relayResponse.status === 404) {
        if (call.path === "/sync/link/share") {
          if (browser) sessions.deleteIfCapability(browser.discriminator, browser.token, capabilityToken);
          if (agent) agent.invalid = true;
        }
        const stale = superseded(true);
        await relayResponse.body?.cancel().catch(() => undefined);
        return stale ?? refused();
      }
      if (relayResponse.status >= 500) {
        await relayResponse.body?.cancel().catch(() => undefined);
        return superseded(true) ?? answer(jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}));
      }
      if (call.buffered) relayResponse = await completeRelayResponse(relayResponse);
      const stale = superseded();
      if (stale) {
        await relayResponse.body?.cancel().catch(() => undefined);
        return stale;
      }
      if (relayResponse.status === 200) {
        return answer(await (call.ok ?? relayJson)(relayResponse, holdSlot, bounded.request.signal));
      }
      if ([400, 403, 409, 413, 429].includes(relayResponse.status) && relayResponse.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
        // An unreadable refusal says nothing about the link when the call is retryable.
        const value = await readBoundedJson(relayResponse, 4096, bounded.request.signal).catch((error: unknown) => {
          if (call.retryable) throw error;
          return null;
        });
        const detail = parseLinkRefusal(value, relayResponse.status);
        if (detail) return answer(jsonResponse(linkRefusalBody(detail), {status: relayResponse.status}));
        const translated = await call.refusal?.(Response.json(value, {status: relayResponse.status}));
        if (translated) return answer(translated);
      }
      await relayResponse.body?.cancel().catch(() => undefined);
      // A proxy's busy answer carries no refusal, so a retryable call tries again.
      return answer(call.retryable && relayResponse.status === 429
        ? jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}) : refused());
    } catch {
      return superseded(true) ?? answer(call.retryable
        ? jsonResponse(linkRefusalBody("link_unavailable"), {status: 503}) : refused());
    } finally {
      bounded.dispose();
      if (!slotHeld) release();
    }
  }

  if (appLaunchConfig && !publicHosts.has(new URL(appLaunchConfig.viewerOrigin).host)) throw new TypeError("App viewer origin must be an exact configured public Host.");
  if (appLaunchConfig && accountAuth && accountAuth.publicOrigin !== appLaunchConfig.viewerOrigin) throw new TypeError("Named app accounts must use the app viewer origin.");
  const resolveNamedAppMaterial = appLaunchConfig && accountAuth && relayExchangeKey ? createNamedAppMaterialResolver({
    relayUrl, publicOrigin: appLaunchConfig.viewerOrigin, exchangeKey: relayExchangeKey, fetchRelay,
    async resolveAccount(cookie, signal) {
      const response = await accountHandler!(new Request(new URL("/api/account/session", accountAuth!.publicOrigin), {headers: {cookie, host: new URL(accountAuth!.publicOrigin).host}, signal}));
      const body: unknown = await response.json();
      return response.ok && body && typeof body === "object" && "user" in body && body.user && typeof body.user === "object" && "id" in body.user && typeof body.user.id === "string" ? body.user.id : null;
    },
  }) : undefined;
  const appLaunch = appLaunchConfig ? createAppLaunchHandler({config: appLaunchConfig, relayUrl, fetchRelay, nowMs, resolveMaterial: resolveLinkBrowserMaterial, resolveNamedMaterial: resolveNamedAppMaterial}) : undefined;
  const discoverApps = createAppDiscovery({viewerOrigin: appLaunchConfig?.viewerOrigin, relayUrl, fetchRelay, resolveMaterial: resolveLinkBrowserMaterial});
  const viewerHost = appLaunchConfig ? new URL(appLaunchConfig.viewerOrigin).host : undefined;
  const route = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === ACCOUNT_DELETION_PATH) {
      if (!internalHosts?.has((request.headers.get("host") ?? "").toLowerCase()) || request.method !== "POST" || !relayExchangeKey || relayExchangeKey.length < 32 || !presentsAccountDeletionKey(request.headers.get(ACCOUNT_DELETION_KEY_HEADER),accountDeletionKey(relayExchangeKey))) return refused();
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || !("userId" in body) || typeof body.userId !== "string" || body.userId.length > 1024) return refused();
      const list = (name: string): string[] | null => {const value = (body as Record<string, unknown>)[name]; return Array.isArray(value) && value.length <= 8 && value.every(id => typeof id === "string" && id.length <= 1024) ? value : null;};
      const workspaceIds=list("workspaceIds"), grantIds=list("grantIds"), publicationIds=list("publicationIds");
      if (!workspaceIds || !grantIds || !publicationIds) return refused();
      sessions.deleteGrants(grantIds);
      appLaunch?.deleteAccount(body.userId,grantIds,publicationIds);
      deleteAccountGateways?.(body.userId,workspaceIds);
      return Response.json({finished:true});
    }
    const { pathname, search } = new URL(request.url);
    const host = (request.headers.get("host") ?? "").toLowerCase();
    const appRequest = appLaunch?.matches(request) ?? false;
    if (!appRequest && !publicHosts.has(host)) return refused();
    const viewerAppRoute = pathname === "/api/apps/launch" || pathname === "/api/apps/summary";
    if (viewerAppRoute ? viewerHost === undefined || request.headers.get("host") === viewerHost : !appRequest) {
      const refusal = shareWebApiVersionRefusal(request, apiVersions);
      if (refusal) return refusal;
    }
    if (appRequest) return appLaunch!.handle(request);
    const agentOrigin = linkLiveConfig?.publicOrigin ?? `https://${request.headers.get("host")}`;
    if (isMcpCorsPath(pathname) && request.method === "OPTIONS") return response(null, {status: 204});
    if (pathname === "/api/mcp" && request.method === "GET" && !search) return jsonResponse({
      api: "share-web", apiVersions, versionHeader: SHARE_WEB_API_VERSION_HEADER, defaultVersion: 1, mcpApiVersions: mcpApiVersions(apiVersions),
      endpoint: "/mcp/s/<secret>", transport: "streamable-http", authorizationServer: "/.well-known/oauth-authorization-server",
      authentication: "Replace <secret> with the text after # in the share link. The endpoint uses the standard MCP sign-in: " +
        "it answers 401 with its protected resource metadata, and a person allows the agent on the consent page.",
    });
    const signIn = await mcpSignIn.handle(request, agentOrigin);
    if (signIn) {
      const page = signInPagePolicy(signIn);
      return response(signIn.body, {status: signIn.status, headers: signIn.headers, ...(page ? {page} : {})});
    }
    const personal = pathname.startsWith(PERSONAL_MCP_PATH_PREFIX);
    if (personal || pathname.startsWith(MCP_PATH_PREFIX)) {
      const secret = personal ? null : mcpLinkSecret(pathname);
      if ((personal ? mcpPersonalWorkspace(pathname) === null || !mcpSignIn.offersPersonal(agentOrigin) : !secret) ||
          search || !relayExchangeKey) return refused();
      // The address names the link, or the workspace a personal agent signed
      // in at, in its one spelling; the bearer is the credential. The relay
      // checks the token against this exact address, in its own family, on
      // every call, so neither family's token works at the other's address.
      const resourcePath = personal ? pathname : `${MCP_PATH_PREFIX}${secret}`;
      const resource = `${agentOrigin}${resourcePath}`;
      const challenge = (invalidToken: boolean) => {
        const result = mcpChallenge(agentOrigin, resourcePath, invalidToken);
        return response(result.body, {status: result.status, headers: result.headers});
      };
      const clientIp = request.headers.get("x-dohc-share-web-client-ip") ?? "unknown";
      const authorization = request.headers.get("authorization");
      // A request with no token never reaches the relay, so a sign-in can always start.
      if (authorization !== null && !mcpFailedSignIns.has(clientIp, nowMs())) return jsonResponse(REFUSAL_VALUE, {status: 429});
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(authorization ?? "")?.[1];
      if (!bearer) {
        if (authorization !== null) mcpFailedSignIns.allow(clientIp, nowMs());
        return challenge(authorization !== null);
      }
      if (mcpRequests >= 64) return refused();
      const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
      const caller: AgentCaller = {accessToken: bearer, resource, key: `agent:${digest(bearer)}`,
        addressKey: `${personal ? "agent-personal" : "agent-link"}:${digest(resource)}`, grantId: null, invalid: false};
      const release = mcpLimiter.acquire(caller.key, caller.addressKey);
      if (!release) return refused();
      mcpRequests++;
      const deadlineAtMs = Date.now() + MCP_REQUEST_TIMEOUT_MS;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]);
      let holdsLargeBody = false;
      try {
        if (personal) {
          const result = await servePersonalMcp(request, {signal, deadlineAtMs,
            // A write's large body spends the token's write budget and one of the few slots. The relay limits the agent too.
            admitLargeBody: () => collectionWriteRateLimiter.allow(caller.key, nowMs()) ? admitLargeBody(caller.key) : null,
            client: createPersonalAgentClient({relayUrl, exchangeKey: relayExchangeKey, accessToken: bearer, resource, fetchRelay})});
          // The token expired or was revoked, or names another address: the client refreshes or signs in again.
          if (!result) {
            mcpFailedSignIns.allow(clientIp, nowMs());
            return challenge(true);
          }
          return response(result.body, {status: result.status, headers: result.headers});
        }
        const result = await serveRemoteMcp(request, {
          signal, deadlineAtMs, liveLimits: linkLiveConfig?.editor,
          ...(linkLive ? {live: linkLive.agent({accessToken: bearer, resource})} : {}),
          agentChat: createAgentChatClient({relayUrl, exchangeKey: relayExchangeKey, accessToken: bearer, resource, fetchRelay}),
          // A write follows the request's link probe, which names the grant.
          admitLargeBody: () => {
            if (!caller.grantId || !collectionWriteRateLimiter.allow(caller.grantId, nowMs())) return null;
            const lease = admitLargeBody(caller.grantId);
            holdsLargeBody = lease !== null;
            return lease;
          },
          request: (path, init = {}) => {
            const internal = new Request(new URL(path, agentOrigin), {
              ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
              headers: {host: new URL(agentOrigin).host, "content-type": "application/json", [SHARE_WEB_API_VERSION_HEADER]: String(SHARE_WEB_API_VERSION)},
            });
            agentCallers.set(internal, caller);
            if (holdsLargeBody) writesInsideAdmittedRequests.add(internal);
            return route(internal);
          },
        });
        // The token expired or was revoked, or names another address: the client refreshes or signs in again.
        if (caller.invalid) {
          mcpFailedSignIns.allow(clientIp, nowMs());
          return challenge(true);
        }
        return response(result.body, {status: result.status, headers: result.headers});
      } catch {
        return refused();
      }
      finally {mcpRequests--; release();}
    }
    if (pathname === "/api/apps") return discoverApps(request);

    if (pathname === "/api/live/link-document" || pathname === "/api/live/link-ticket") {
      if (!linkLive) return refused();
      const result = await linkLive.handle(request);
      return response(result.body, {status: result.status, headers: result.headers});
    }

    if (pathname === "/api/live/named-session") {
      if (!namedBrowser) return refused();
      const result = await namedBrowser.bootstrap(request);
      return response(result.body, { status: result.status, headers: result.headers });
    }

    if (pathname === "/api/live/named-ticket") {
      if (!namedTickets) return refused();
      const result = await namedTickets(request);
      return response(result.body, {status: result.status, headers: result.headers});
    }

    if (pathname === "/api/live/named-documents") {
      if (!namedDocuments) return refused();
      const result = await namedDocuments(request);
      return response(result.body, {status: result.status, headers: result.headers});
    }

    if (pathname.startsWith("/api/named-chat/")) {
      if (!namedChat) return refused();
      const result = await namedChat(request);
      return response(result.body, {status: result.status, headers: result.headers});
    }

    if (pathname.startsWith("/api/push/")) {
      if (!push) return refused();
      const result = await push(request);
      return response(result.body, {status: result.status, headers: result.headers});
    }

    if (pathname.startsWith("/api/account/")) {
      if (!accountHandler) return refused();
      const accountResponse = await accountHandler(request);
      return response(accountResponse.body, {
        status: accountResponse.status,
        headers: accountResponse.headers,
      });
    }

    if (request.method === "GET" && (pathname === "/s" || pathname.startsWith("/s/"))) {
      const viewer = await serveViewer(pathname);
      if (!pathname.startsWith("/s/assets/")) viewer.headers.set("link", '</api/mcp>; rel="service-desc"; type="application/json"');
      return viewer;
    }

    if (pathname === "/l" || pathname.startsWith("/l/")) return serveWorkLinkPage(request, pathname, agentOrigin);

    if (pathname === "/api/exchange" && request.method === "POST") {
      const clientIp = request.headers.get("x-dohc-share-web-client-ip") ?? "unknown";
      const addressPending = exchangeAddressInFlight.get(clientIp) ?? 0;
      if (addressPending >= 16 || exchangesInFlight >= MAX_EXCHANGES_IN_FLIGHT || !exchangeAddressProbes.allow(clientIp, nowMs()) ||
          !exchangeGlobalRateLimiter.allow("global", nowMs())) return jsonResponse(REFUSAL_VALUE, {status: 429});
      exchangeAddressInFlight.set(clientIp, addressPending + 1);
      exchangesInFlight++;
      try {
        const malformed = () => exchangeRateLimiter.allow(clientIp, nowMs()) ? refused() : jsonResponse(REFUSAL_VALUE, {status: 429});
        const secret = await exchangeInput(request);
        if (!secret) return malformed();
        try {
          const bounded = boundedRelayRequest(request.signal, relayUrl, "/sync/link-exchange", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-dohc-relay-client-ip": clientIp,
                ...(relayExchangeKey
                  ? { "x-dohc-relay-exchange-key": relayExchangeKey }
                  : {}),
              },
              body: JSON.stringify({ secret }),
            }, relayTimeoutMs);
          let exchanged: ReturnType<typeof parsedRelaySession>;
          let relayResponse: Response | undefined;
          try {
            relayResponse = await fetchRelay(bounded.request);
            if (relayResponse.status !== 200) {
              return relayResponse.status === 429 ? jsonResponse(REFUSAL_VALUE, {status: 429}) : refused();
            }
            exchanged = parsedRelaySession(await readBoundedJson(relayResponse, MAX_RELAY_RESPONSE_BYTES, bounded.request.signal), nowMs(), publicEditRelease);
          } finally {
            await relayResponse?.body?.cancel().catch(() => undefined);
            bounded.dispose();
          }
          if (!exchanged) return refused();
          const discriminator = linkDiscriminator(exchanged.grantId);
          const token = newSessionToken();
          if (!/^[A-Za-z0-9_-]{16,}$/u.test(token)) return refused();
          const cookies = parseCookies(request.headers.get("cookie"));
          const existingProfile = cookies.get(profileCookieName(discriminator));
          const profile =
            existingProfile && LINK_SECRET_PATTERN.test(existingProfile)
              ? existingProfile
              : newProfileSecret();
          if (!LINK_SECRET_PATTERN.test(profile)) return refused();
          sessions.set(
            token,
            {
              discriminator,
              grantId: exchanged.grantId,
              capabilityToken: exchanged.capabilityToken,
              expiresAtMs: exchanged.expiresAtMs,
              createdAtMs: nowMs(),
            },
            nowMs(),
          );
          const responseHeaders = new Headers();
          responseHeaders.append(
            "set-cookie",
            sessionCookie(discriminator, token, exchanged.expiresAtMs, nowMs()),
          );
          responseHeaders.append(
            "set-cookie",
            profileCookie(discriminator, profile),
          );
          return jsonResponse(
            { ok: true, session: discriminator },
            { headers: responseHeaders },
          );
        } catch {
          return refused();
        }
      } finally {
        exchangesInFlight--;
        const remaining = exchangeAddressInFlight.get(clientIp)! - 1;
        if (remaining) exchangeAddressInFlight.set(clientIp, remaining); else exchangeAddressInFlight.delete(clientIp);
      }
    }

    if (pathname === "/api/handoff" && request.method === "POST") {
      if (!request.headers.has(LINK_SESSION_HEADER)) return refused();
      const authenticated = readSession(request);
      if (!authenticated) return refused();
      return await callRelay(request, authenticated, {
        path: "/sync/link-handoff",
        method: "POST",
        exchangeKey: true,
        ok: async (relayResponse, _holdSlot, signal) => {
          try {
            const handoff = parsedRelayHandoff(await readBoundedJson(relayResponse, MAX_RELAY_RESPONSE_BYTES, signal), nowMs());
            if (!handoff) return refused();
            return jsonResponse({
              ok: true,
              code: handoff.code,
              relayUrl: publicRelayUrl,
              expiresAtMs: handoff.expiresAtMs,
            });
          } finally {
            await relayResponse.body?.cancel().catch(() => undefined);
          }
        },
      });
    }

    if (pathname === COLLECTION_WRITES_PATH) {
      // Only the viewer page, or this server's own MCP tools: never another
      // site, and never a published app, whose origin differs and which never
      // holds the link's cookies.
      const agent = agentCallers.get(request);
      const fetchSite = request.headers.get("sec-fetch-site");
      if (
        request.method !== "POST" || search ||
        (!agent && (request.headers.get("origin") !== agentOrigin || (fetchSite !== null && fetchSite !== "same-origin") ||
          !request.headers.has(LINK_SESSION_HEADER))) ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refused();
      }
      const browser = agent ? null : readSession(request);
      const caller = agent ?? browser;
      if (!caller) return refused();
      // A browser writes with its profile; an agent's token names its own principal.
      const profileSecret = browser
        ? parseCookies(request.headers.get("cookie")).get(profileCookieName(browser.discriminator))
        : undefined;
      if (browser && (!profileSecret || !LINK_SECRET_PATTERN.test(profileSecret))) return refused();
      // Only a link the relay says can write now spends its tokens and holds a
      // body slot, one per link, shared by its browsers and agents. The relay
      // decides again, inside its commit.
      const admitted = writesInsideAdmittedRequests.has(request);
      let writable = false;
      const probe = await callRelay(request, caller, {
        path: "/sync/link/share",
        buffered: true,
        retryable: true,
        ok: async (relayResponse) => {
          const answer = asRecord(await relayResponse.json().catch(() => null));
          const meta = agent ? takeAgentGrant(agent, answer) : answer;
          writable = meta?.access === "edit" && asRecord(meta.effectiveSelector)?.versionId === null;
          return response(null);
        },
      });
      if (!writable) return probe.status === 200 ? refused() : probe;
      const renewed = (result: Response): Response => {
        const cookie = probe.headers.get("set-cookie");
        if (cookie && browser && sessions.isCurrent(browser.discriminator, browser.token, browser.session.capabilityToken, nowMs())) {
          result.headers.set("set-cookie", cookie);
        }
        return result;
      };
      if (!admitted && !collectionWriteRateLimiter.allow(linkKeyOf(caller), nowMs())) return renewed(writesRateLimited());
      const release = admitted ? () => {} : admitLargeBody(linkKeyOf(caller));
      if (!release) return renewed(writesRateLimited());
      try {
        // Only what a write is. Who writes comes from the capability and the
        // profile, or the agent's token, and no cookie or account reaches the relay.
        let body: string;
        try {
          const value = asRecord(await readBoundedJson(request, MAX_COLLECTION_WRITE_ENVELOPE_BYTES,
            AbortSignal.any([request.signal, AbortSignal.timeout(COLLECTION_WRITE_TIMEOUT_MS)])));
          if (!value || Object.keys(value).some((key) => key !== "submitId" && key !== "changes")) return renewed(refused());
          body = JSON.stringify(value);
        } catch {
          return renewed(refused());
        }
        return renewed(await callRelay(request, caller, {
          path: "/sync/link/collection-writes",
          method: "POST",
          headers: { ...(profileSecret ? { "x-dohc-link-profile-secret": profileSecret } : {}), "content-type": "application/json" },
          body,
          buffered: true,
          retryable: true,
          timeoutMs: COLLECTION_WRITE_TIMEOUT_MS,
          ok: acceptedCollectionWrite,
          refusal: collectionWriteRefusal,
        }));
      } finally {
        release();
      }
    }

    if (pathname === "/api/view/chat/channels" || pathname === "/api/view/chat/messages") {
      const agent = agentCallers.get(request);
      const browser = agent ? null : readSession(request);
      const caller = agent ?? browser;
      if (!caller) return refused();
      const cookieProfile = browser ? parseCookies(request.headers.get("cookie")).get(profileCookieName(browser.discriminator)) : undefined;
      const profileSecret = cookieProfile && LINK_SECRET_PATTERN.test(cookieProfile) ? cookieProfile : null;
      if (request.method === "GET") {
        const channels = pathname === "/api/view/chat/channels";
        const read = linkChatReadPath(request, channels);
        if (!read) return refused();
        return await callRelay(request, caller, {
          path: read.path, holdMs: read.holdMs, buffered: true, ifSessionChanged: true, retryable: true,
          // The channel answer names this profile's name, once set.
          ...(channels && profileSecret ? { headers: { "x-dohc-link-profile-secret": profileSecret } } : {}),
          ...(read.holdMs > 0 ? { limiter: activityHoldLimiter } : {}),
        });
      }
      // Only the viewer page, as for Collection writes. An agent posts
      // through its own agent chat.
      const fetchSite = request.headers.get("sec-fetch-site");
      if (
        !browser || request.method !== "POST" || pathname !== "/api/view/chat/messages" || search ||
        request.headers.get("origin") !== agentOrigin || (fetchSite !== null && fetchSite !== "same-origin") ||
        !request.headers.has(LINK_SESSION_HEADER) || !profileSecret ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return refused();
      }
      const body = await linkChatPostInput(request);
      if (body === null) return refused();
      // Who posts comes from the capability and the profile alone; the relay
      // checks the link's access again inside its write.
      return await callRelay(request, browser, {
        path: "/sync/link/chat/messages",
        method: "POST",
        headers: { "x-dohc-link-profile-secret": profileSecret, "content-type": "application/json" },
        body,
        buffered: true,
        ifSessionChanged: true,
        retryable: true,
        refusal: linkChatRefusal,
      });
    }

    if (
      pathname === "/api/view/discussion" ||
      pathname === "/api/view/discussion/activity"
    ) {
      const isActivity = pathname === "/api/view/discussion/activity";
      if (
        (isActivity && request.method !== "GET") ||
        (!isActivity && request.method !== "GET" && request.method !== "POST")
      ) {
        return refused();
      }
      const agent = agentCallers.get(request);
      const browser = agent ? null : readSession(request);
      const caller = agent ?? browser;
      if (!caller) return refused();

      let relayPath: string;
      let holdMs = 0;
      if (isActivity) {
        const parsedPath = discussionActivityRelayPath(request);
        if (!parsedPath) return refused();
        relayPath = parsedPath.path;
        holdMs = parsedPath.holdMs;
      } else if (request.method === "GET") {
        const parsedPath = discussionRelayPath(request);
        if (!parsedPath) return refused();
        relayPath = parsedPath;
      } else {
        if (
          !relayExchangeKey ||
          (browser ? !hasOnlySessionQuery(request, browser.discriminator) : search !== "")
        ) {
          return refused();
        }
        relayPath = "/sync/link/discussion";
      }

      // A browser reads and posts with its profile; an agent's token names its own principal.
      const profileSecret = browser
        ? parseCookies(request.headers.get("cookie")).get(profileCookieName(browser.discriminator))
        : undefined;
      if (browser && (!profileSecret || !LINK_SECRET_PATTERN.test(profileSecret))) return refused();
      let appendBody: string | null = null;
      if (request.method === "POST") {
        appendBody = await discussionInput(request);
        if (appendBody === null) return refused();
      }

      return await callRelay(request, caller, {
        path: relayPath,
        method: request.method,
        headers: {
          ...(profileSecret ? { "x-dohc-link-profile-secret": profileSecret } : {}),
          ...(appendBody === null ? {} : { "content-type": "application/json" }),
        },
        ...(appendBody === null ? {} : { body: appendBody, exchangeKey: true }),
        holdMs,
        buffered: true,
        retryable: true,
        ...(isActivity
          ? { limiter: activityHoldLimiter, ifSessionChanged: true }
          : { ifSessionChanged: true, refusal: discussionRefusal }),
      });
    }

    if (pathname.startsWith("/api/view/")) {
      const authenticated = agentCallers.get(request) ?? readSession(request);
      if (!authenticated || request.method !== "GET") return refused();
      if (pathname === "/api/view/meta") {
        // The share's answer says whether the link has a channel, so a lost one is retryable.
        const agent = agentCallers.get(request);
        return await callRelay(request, authenticated, { path: "/sync/link/share", retryable: true,
          // An agent's answer names its grant, which share-web keeps.
          ...(agent ? { buffered: true, ok: async (relayResponse: Response) => {
            const answer = takeAgentGrant(agent, asRecord(await relayResponse.json().catch(() => null)));
            return answer ? jsonResponse(answer) : jsonResponse(linkRefusalBody("link_unavailable"), {status: 503});
          } } : {}) });
      }
      if (pathname === "/api/view/current") {
        const collectionPath = new URL(request.url).searchParams.get("collectionPath");
        const query = collectionPath === null ? "" : `?${new URLSearchParams({ collectionPath })}`;
        return await callRelay(request, authenticated, { path: `/sync/link/current${query}`, retryable: true });
      }
      if (pathname === "/api/view/log") {
        const hold = new URL(request.url).searchParams.get("hold") ?? "0";
        if (!DISCUSSION_HOLD.test(hold) || Number(hold) > MAX_DISCUSSION_ACTIVITY_HOLD_MS) {
          return refused();
        }
        return await callRelay(request, authenticated, {
          path: logRelayPath(request),
          holdMs: Number(hold),
          ifSessionChanged: true,
          retryable: true,
          ...(Number(hold) > 0 ? { limiter: activityHoldLimiter } : {}),
        });
      }
      const sha = pathname.slice("/api/view/blob/".length);
      if (!pathname.startsWith("/api/view/blob/") || !SHA256_HEX_PATTERN.test(sha)) {
        return refused();
      }
      return await callRelay(request, authenticated, {
        path: `/sync/link/blobs/${sha}`,
        limiter: blobProxyLimiter,
        retryable: true,
        ok: (relayResponse, holdSlot) => streamingBlobResponse(relayResponse, holdSlot()),
      });
    }

    return refused();
  };
  // A browser MCP client reads every answer on its paths, refusals and the
  // 401 challenge included.
  const handle = async (request: Request): Promise<Response> => {
    const result = await route(request);
    if (!isMcpCorsPath(new URL(request.url).pathname)) return result;
    const headers = new Headers(result.headers);
    for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) headers.set(key, value);
    return new Response(result.body, {status: result.status, statusText: result.statusText, headers});
  };
  return { handle, resolveLinkBrowserMaterial, ...(linkLive ? {linkLive} : {}),
    resolveNamedBrowserSession: (request, discriminator) => namedBrowser?.resolve(request, discriminator) ?? Promise.resolve(null) };
}

export const shareWebRefusalBody = REFUSAL_BODY;

/**
 * The routes that authenticate before they read, then bound the body and its
 * deadline: an agent's MCP request and a Collection write can carry megabytes.
 */
export function streamsRequestBody(url: URL): boolean {
  return url.pathname.startsWith(MCP_PATH_PREFIX) || url.pathname.startsWith(PERSONAL_MCP_PATH_PREFIX) || url.pathname === COLLECTION_WRITES_PATH;
}
