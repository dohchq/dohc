import { createAppLaunchHandler } from "./appLaunch";
import { createAppDiscovery } from "./appDiscovery";
import type { AppLaunchConfig } from "./appLaunchConfig";
import {parsePublicEditRelease, type PublicEditRelease} from "@dohc/security-contract";
import {createNamedRecipientDocumentsClient} from "./namedRecipientDocuments";
import type {NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { LINK_SECRET_PATTERN, SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { TokenBucketLimiter, readBoundedJson } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core";
import { createAccountAuthHandler, type AccountAuthConfig } from "./accountAuth";
import { isSessionDiscriminator } from "./sessionDiscriminator";
import { createNamedLiveBrowserClient, type NamedLiveBrowserClientLimits, type NamedLiveBrowserSessionContext } from "./namedLiveBrowserClient";
import {createNamedLiveTicketClient} from "./namedLiveTicketClient";
import {createLinkLiveClient} from "./linkLiveClient";
import {serveRemoteMcp} from "./remoteMcp";

export const LINK_SESSION_HEADER = "x-dohc-link-session";
export const SHARE_WEB_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SHARE_WEB_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": SHARE_WEB_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "private, no-store",
});

const REFUSAL_VALUE = { ok: false, error: "not found" };
const REFUSAL_BODY = JSON.stringify(REFUSAL_VALUE);
const MAX_EXCHANGE_BODY_BYTES = 8 * 1024;
const MAX_DISCUSSION_ENVELOPE_BYTES = 16 * 1024;
const MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const EXCHANGE_BUCKET_CAPACITY = 12;
const EXCHANGE_REFILL_PER_SECOND = 0.2;
const EXCHANGE_MAX_IPS = 10_000;
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

type RelayFetch = (request: Request) => Promise<Response>;

interface ShareWebSession {
  agentProfileSecret?: string;
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
  /** Admits the call against a per-session and per-grant in-flight limit. */
  limiter?: ShareWebInFlightLimiter;
  /** Reads the whole relay body, up to the proxy limit, inside the deadline. */
  buffered?: boolean;
  /** Refuses with this status when the session changed while the relay answered. */
  ifSessionChanged?: 404 | 409;
  /** Answers a relay 200. `holdSlot` keeps the limiter slot until its release runs. */
  ok?(relayResponse: Response, headers: Record<string, string>, holdSlot: () => () => void): Response | Promise<Response>;
  /** Translates a relay refusal, or returns null for the generic refusal. */
  refusal?(relayResponse: Response, headers: Record<string, string>): Promise<Response | null>;
}

export interface CreateShareWebApplicationOptions {
  appLaunch?: AppLaunchConfig;
  publicEditRelease?: PublicEditRelease;
  relayUrl: string;
  publicRelayUrl: string;
  relayExchangeKey?: string;
  publicHosts: ReadonlySet<string>;
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
  linkLive?: {publicOrigin: string; requests: NamedLiveBrowserClientLimits; editor: NamedLiveBrowserLimits};
}

export type LinkBrowserMaterial =
  | { ok: true; capabilityToken: string; profileSecret: string; setCookie: string | null; currentCapability(): Promise<string | null> }
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

function linkDiscriminator(grantId: string): string {
  return createHash("sha256").update(grantId).digest("base64url").slice(0, 12);
}

function cookieName(discriminator: string): string {
  return `dohc_share_${discriminator}`;
}

function profileCookieName(discriminator: string): string {
  return `dohc_share_profile_${discriminator}`;
}

// Every response the viewer origin serves carries the security headers.
function response(
  body: BodyInit | null,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(SHARE_WEB_SECURITY_HEADERS)) headers.set(key, value);
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

function refused(status: 404 | 409 | 429 | 503 = 404, headers: HeadersInit = {}): Response {
  return jsonResponse(REFUSAL_VALUE, { status, headers });
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
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_EXCHANGE_BODY_BYTES) return null;
    const input = asRecord(JSON.parse(text));
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

async function discussionRefusal(
  relayResponse: Response,
  headers: Record<string, string>,
): Promise<Response | null> {
  if (relayResponse.status !== 403 && relayResponse.status !== 413) return null;
  const state = await discussionState(relayResponse);
  return state && jsonResponse(
    { ok: false, ...state },
    { status: state.state === "limit-reached" ? 413 : 403, headers },
  );
}

function relayJson(relayResponse: Response, headers: Record<string, string>): Response {
  return response(relayResponse.body, {
    headers: { "content-type": "application/json", ...headers },
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
  extraHeaders: HeadersInit = {},
): Promise<Response> {
  if (!relayResponse.body) {
    release();
    return response(null, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        ...Object.fromEntries(new Headers(extraHeaders)),
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
      ? { "content-type": raster, ...Object.fromEntries(new Headers(extraHeaders)) }
      : {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
          ...Object.fromEntries(new Headers(extraHeaders)),
        },
  });
}

export function createShareWebApplication({
  relayUrl,
  publicRelayUrl,
  relayExchangeKey,
  publicHosts,
  fetchRelay = (request) => fetch(request),
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
  linkLive: linkLiveConfig,
  publicEditRelease: releaseInput,
  appLaunch: appLaunchConfig,
}: CreateShareWebApplicationOptions): ShareWebApplication {
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
  const accountHandler = accountAuth ? createAccountAuthHandler({
    ...accountAuth,
    fetchAuth,
    maxRequestBytes: MAX_EXCHANGE_BODY_BYTES,
    maxResponseBytes: MAX_RELAY_RESPONSE_BYTES,
    timeoutMs: DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  }) : undefined;
  const sessions = new ShareWebSessionStore(maxSessions);
  const exchangeRateLimiter = new TokenBucketLimiter(
    EXCHANGE_BUCKET_CAPACITY,
    EXCHANGE_REFILL_PER_SECOND,
    EXCHANGE_MAX_IPS,
  );
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
  let mcpRequests = 0;
  if (linkLiveConfig && (!relayExchangeKey || !publicHosts.has(new URL(linkLiveConfig.publicOrigin).host))) throw new TypeError("Link editing requires configured relay exchange and public Host.");
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
    const relative = pathname.startsWith("/s/assets/")
      ? pathname.slice("/s/".length)
      : "index.html";
    if (relative.includes("..") || relative.includes("\\")) return refused();
    try {
      const bytes = await readFile(join(viewerAssetsDir, relative));
      const result = response(bodyBuffer(bytes), {
        headers: { "content-type": contentTypeForAsset(relative) },
      });
      if (relative === "index.html" && appLaunchConfig) result.headers.set("content-security-policy", SHARE_WEB_CSP.replace("form-action 'none'", `form-action https://*.${appLaunchConfig.appDomain}`));
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
        try {
          const relayResponse = await fetchRelay(boundedRelay.request);
          if (relayResponse.status === 401) return { status: "invalid" };
          if (relayResponse.status !== 200) return { status: "unavailable" };
          const refreshed = parsedRelaySession(
            await relayResponse.json(),
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
      return { ok: true, capabilityToken, profileSecret, setCookie: refreshed.headers["set-cookie"] ?? null,
        async currentCapability() {
          await refreshes.get(sessionKey(discriminator, authenticated.token));
          const current = sessions.get(discriminator, authenticated.token, nowMs());
          return current === authenticated.session && current.expiresAtMs > nowMs() ? current.capabilityToken : null;
        } };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // A refusal that evicts or supersedes the session omits the refreshed
  // cookie: it names a dead session and could overwrite a newer one.
  async function callRelay(request: Request, browser: BrowserSession, call: RelayCall): Promise<Response> {
    const refreshed = await refreshSession(browser);
    if (!refreshed.ok) return refused(refreshed.status);
    const { headers } = refreshed;
    const release = call.limiter
      ? call.limiter.acquire(sessionKey(browser.discriminator, browser.token), browser.session.grantId)
      : () => {};
    if (!release) return refused(429, headers);
    let slotHeld = false;
    const holdSlot = (): (() => void) => {
      slotHeld = true;
      return release;
    };
    const capabilityToken = browser.session.capabilityToken;
    const bounded = boundedRelayRequest(
      request.signal,
      relayUrl,
      call.path,
      {
        method: call.method,
        headers: {
          authorization: `LinkCapability ${capabilityToken}`,
          ...(call.exchangeKey && relayExchangeKey
            ? { "x-dohc-relay-exchange-key": relayExchangeKey }
            : {}),
          ...call.headers,
        },
        body: call.body,
      },
      relayTimeoutMs + (call.holdMs ?? 0),
    );
    try {
      let relayResponse = await fetchRelay(bounded.request);
      if (call.buffered) relayResponse = await completeRelayResponse(relayResponse);
      if (
        call.ifSessionChanged &&
        !sessions.isCurrent(browser.discriminator, browser.token, capabilityToken, nowMs())
      ) {
        await relayResponse.body?.cancel().catch(() => undefined);
        return refused(call.ifSessionChanged);
      }
      if (relayResponse.status === 200) {
        return await (call.ok ?? relayJson)(relayResponse, headers, holdSlot);
      }
      const translated = await call.refusal?.(relayResponse, headers);
      if (translated) return translated;
      await relayResponse.body?.cancel().catch(() => undefined);
      if (relayResponse.status === 401) {
        sessions.deleteIfCapability(browser.discriminator, browser.token, capabilityToken);
        return refused(404);
      }
      if (relayResponse.status === 429) return refused(429, headers);
      return refused(
        relayResponse.status >= 400 && relayResponse.status < 500 ? 404 : 503,
        headers,
      );
    } catch {
      return refused(503, headers);
    } finally {
      bounded.dispose();
      if (!slotHeld) release();
    }
  }

  if (appLaunchConfig && !publicHosts.has(new URL(appLaunchConfig.viewerOrigin).host)) throw new TypeError("App viewer origin must be an exact configured public Host.");
  const appLaunch = appLaunchConfig ? createAppLaunchHandler({config: appLaunchConfig, relayUrl, fetchRelay, nowMs, resolveMaterial: resolveLinkBrowserMaterial}) : undefined;
  const discoverApps = createAppDiscovery({viewerOrigin: appLaunchConfig?.viewerOrigin, relayUrl, fetchRelay, resolveMaterial: resolveLinkBrowserMaterial});
  const handle = async (request: Request): Promise<Response> => {
    if (appLaunch?.matches(request)) return appLaunch.handle(request);
    if (!publicHosts.has((request.headers.get("host") ?? "").toLowerCase())) return refused();
    const { pathname, search } = new URL(request.url);
    const agentOrigin = linkLiveConfig?.publicOrigin ?? `https://${request.headers.get("host")}`;
    if (pathname === "/api/mcp" && request.method === "GET" && !search) return jsonResponse({
      endpoint: "/mcp", transport: "streamable-http", exchange: {path: "/api/mcp/exchange", method: "POST", body: {secret: "The secret after # in the share link"}},
      authentication: "Send the returned bearer in the Authorization header as Bearer <bearer>. Each exchange creates a separate agent identity. Keep and reuse the bearer.",
    });
    if (pathname === "/mcp") {
      if (search || request.headers.has("origin") && request.headers.get("origin") !== agentOrigin ||
        request.headers.get("sec-fetch-site") === "cross-site") return refused();
      const bearer = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16,256})$/u.exec(request.headers.get("authorization") ?? "");
      const session = bearer && sessions.get(bearer[1]!, bearer[2]!, nowMs());
      if (!session?.agentProfileSecret) return response(null, {status: 401, headers: {"www-authenticate": "Bearer"}});
      const discriminator = session.discriminator;
      if (mcpRequests >= 64) return refused(429);
      const release = mcpLimiter.acquire(sessionKey(discriminator, bearer![2]!), session.grantId);
      if (!release) return refused(429);
      mcpRequests++;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]);
      // Only server-held agent credentials cross into the shared link handlers.
      const cookie = `${cookieName(discriminator)}=${bearer![2]}; ${profileCookieName(discriminator)}=${session.agentProfileSecret}`;
      try {
        const result = await serveRemoteMcp(request, {
          signal, discriminator, cookie, linkLive, liveLimits: linkLiveConfig?.editor,
          request: (path, init = {}) => handle(new Request(new URL(path, agentOrigin), {
            ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
            headers: {host: new URL(agentOrigin).host, origin: agentOrigin, cookie, [LINK_SESSION_HEADER]: discriminator,
              "content-type": "application/json"},
          })),
        });
        return response(result.body, {status: result.status, headers: result.headers});
      } catch {return refused();}
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

    if ((pathname === "/api/exchange" || pathname === "/api/mcp/exchange") && request.method === "POST") {
      const agent = pathname === "/api/mcp/exchange";
      if (agent && (search || request.headers.has("origin") && request.headers.get("origin") !== agentOrigin || request.headers.get("sec-fetch-site") === "cross-site")) return refused();
      const clientIp = request.headers.get("x-dohc-share-web-client-ip") ?? "unknown";
      if (!exchangeRateLimiter.allow(clientIp, nowMs())) return refused();
      let secret: string | null = null;
      try {
        if (agent) {
          const input = asRecord(await readBoundedJson(request, MAX_EXCHANGE_BODY_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])));
          if (input && Object.keys(input).join() === "secret" && typeof input.secret === "string" && LINK_SECRET_PATTERN.test(input.secret)) secret = input.secret;
        } else secret = await exchangeInput(request);
      } catch {return refused();}
      if (!secret) return refused();
      try {
        const relayResponse = await fetchRelay(
          relayRequest(relayUrl, "/sync/link-exchange", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dohc-relay-client-ip": clientIp,
              ...(relayExchangeKey
                ? { "x-dohc-relay-exchange-key": relayExchangeKey }
                : {}),
            },
            body: JSON.stringify({ secret }),
          }),
        );
        if (relayResponse.status !== 200) return refused();
        const exchanged = parsedRelaySession(await relayResponse.json(), nowMs(), publicEditRelease);
        if (!exchanged) return refused();
        const discriminator = linkDiscriminator(exchanged.grantId);
        const token = newSessionToken();
        if (!/^[A-Za-z0-9_-]{16,}$/u.test(token)) return refused();
        const cookies = parseCookies(request.headers.get("cookie"));
        const existingProfile = agent ? undefined : cookies.get(profileCookieName(discriminator));
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
            ...(agent ? {agentProfileSecret: profile} : {}),
          },
          nowMs(),
        );
        if (agent) return jsonResponse({ok: true, bearer: `${discriminator}.${token}`, endpoint: "/mcp"});
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
    }

    if (pathname === "/api/handoff" && request.method === "POST") {
      if (!request.headers.has(LINK_SESSION_HEADER)) return refused();
      const authenticated = readSession(request);
      if (!authenticated) return refused();
      return await callRelay(request, authenticated, {
        path: "/sync/link-handoff",
        method: "POST",
        exchangeKey: true,
        ok: async (relayResponse, headers) => {
          const handoff = parsedRelayHandoff(await relayResponse.json(), nowMs());
          if (!handoff) return refused(503, headers);
          return jsonResponse(
            {
              ok: true,
              code: handoff.code,
              relayUrl: publicRelayUrl,
              expiresAtMs: handoff.expiresAtMs,
            },
            { headers },
          );
        },
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
      const authenticated = readSession(request);
      if (!authenticated) return refused();

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
          !hasOnlySessionQuery(request, authenticated.discriminator)
        ) {
          return refused();
        }
        relayPath = "/sync/link/discussion";
      }

      const profileSecret = parseCookies(request.headers.get("cookie")).get(
        profileCookieName(authenticated.discriminator),
      );
      if (!profileSecret || !LINK_SECRET_PATTERN.test(profileSecret)) return refused();
      let appendBody: string | null = null;
      if (request.method === "POST") {
        appendBody = await discussionInput(request);
        if (appendBody === null) return refused();
      }

      return await callRelay(request, authenticated, {
        path: relayPath,
        method: request.method,
        headers: {
          "x-dohc-link-profile-secret": profileSecret,
          ...(appendBody === null ? {} : { "content-type": "application/json" }),
        },
        ...(appendBody === null ? {} : { body: appendBody, exchangeKey: true }),
        holdMs,
        buffered: true,
        ...(isActivity
          ? { limiter: activityHoldLimiter, ifSessionChanged: 409 }
          : { ifSessionChanged: 404, refusal: discussionRefusal }),
      });
    }

    if (pathname.startsWith("/api/view/")) {
      const authenticated = readSession(request);
      if (!authenticated || request.method !== "GET") return refused();
      if (pathname === "/api/view/meta") {
        return await callRelay(request, authenticated, { path: "/sync/link/share" });
      }
      if (pathname === "/api/view/current") {
        return await callRelay(request, authenticated, { path: "/sync/link/current" });
      }
      if (pathname === "/api/view/log") {
        const hold = new URL(request.url).searchParams.get("hold") ?? "0";
        if (!DISCUSSION_HOLD.test(hold) || Number(hold) > MAX_DISCUSSION_ACTIVITY_HOLD_MS) {
          return refused();
        }
        return await callRelay(request, authenticated, {
          path: `/sync/link/log${search}`,
          holdMs: Number(hold),
          limiter: activityHoldLimiter,
          ifSessionChanged: 409,
        });
      }
      const sha = pathname.slice("/api/view/blob/".length);
      if (!pathname.startsWith("/api/view/blob/") || !SHA256_HEX_PATTERN.test(sha)) {
        return refused();
      }
      return await callRelay(request, authenticated, {
        path: `/sync/link/blobs/${sha}`,
        limiter: blobProxyLimiter,
        ok: (relayResponse, headers, holdSlot) =>
          streamingBlobResponse(relayResponse, holdSlot(), headers),
      });
    }

    return refused();
  };
  return { handle, resolveLinkBrowserMaterial, ...(linkLive ? {linkLive} : {}),
    resolveNamedBrowserSession: (request, discriminator) => namedBrowser?.resolve(request, discriminator) ?? Promise.resolve(null) };
}

export const shareWebRefusalBody = REFUSAL_BODY;
