import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const LINK_SESSION_HEADER = "x-dohc-link-session";
export const SHARE_WEB_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const REFUSAL_BODY = JSON.stringify({ ok: false, error: "not found" });
const MAX_EXCHANGE_BODY_BYTES = 8 * 1024;
const EXCHANGE_BUCKET_CAPACITY = 12;
const EXCHANGE_REFILL_PER_SECOND = 0.2;
const EXCHANGE_MAX_IPS = 10_000;
const DEFAULT_MAX_SESSIONS = 10_000;
const SESSION_DISCRIMINATOR = /^[A-Za-z0-9_-]{12}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

type RelayFetch = (request: Request) => Promise<Response>;

interface ShareWebSession {
  discriminator: string;
  capabilityToken: string;
  expiresAtMs: number;
  createdAtMs: number;
}

interface ExchangeBucket {
  tokens: number;
  updatedAtMs: number;
}

export interface CreateShareWebHandlerOptions {
  relayUrl: string;
  publicHosts: ReadonlySet<string>;
  fetchRelay?: RelayFetch;
  nowMs?: () => number;
  newSessionToken?: () => string;
  maxSessions?: number;
  viewerAssetsDir?: string;
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
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(sessionKey(session.discriminator, token), session);
  }

  get(discriminator: string, token: string, nowMs: number): ShareWebSession | null {
    const key = sessionKey(discriminator, token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAtMs <= nowMs) {
      if (session) this.sessions.delete(key);
      return null;
    }
    return session;
  }

  delete(discriminator: string, token: string): void {
    this.sessions.delete(sessionKey(discriminator, token));
  }

  private prune(nowMs: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAtMs <= nowMs) this.sessions.delete(key);
    }
  }
}

class ShareWebExchangeRateLimiter {
  private readonly buckets = new Map<string, ExchangeBucket>();

  allow(clientIp: string, nowMs: number): boolean {
    const key = clientIp || "unknown";
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= EXCHANGE_MAX_IPS) this.evictOldest();
      bucket = { tokens: EXCHANGE_BUCKET_CAPACITY, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
    bucket.tokens = Math.min(
      EXCHANGE_BUCKET_CAPACITY,
      bucket.tokens + elapsedSeconds * EXCHANGE_REFILL_PER_SECOND,
    );
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAtMs < oldestMs) {
        oldestKey = key;
        oldestMs = bucket.updatedAtMs;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
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

function securityHeaders(): Headers {
  return new Headers({
    "content-security-policy": SHARE_WEB_CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
}

function response(
  body: BodyInit | null,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = securityHeaders();
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  return new Response(body, { status: init.status ?? 200, headers });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  return response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  });
}

function refused(): Response {
  return response(REFUSAL_BODY, {
    status: 404,
    headers: { "content-type": "application/json" },
  });
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
    const input: unknown = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const secret = (input as { secret?: unknown }).secret;
    return typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/u.test(secret)
      ? secret
      : null;
  } catch {
    return null;
  }
}

function relayRequest(relayUrl: string, path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, `${relayUrl.replace(/\/+$/u, "")}/`), init);
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
  if (
    bytes.length >= 6 &&
    String.fromCharCode(...bytes.subarray(0, 6)) in { GIF87a: true, GIF89a: true }
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

export function createShareWebHandler({
  relayUrl,
  publicHosts,
  fetchRelay = (request) => fetch(request),
  nowMs = () => Date.now(),
  newSessionToken = () => randomBytes(32).toString("base64url"),
  maxSessions = DEFAULT_MAX_SESSIONS,
  viewerAssetsDir,
}: CreateShareWebHandlerOptions): (request: Request) => Promise<Response> {
  const sessions = new ShareWebSessionStore(maxSessions);
  const exchangeRateLimiter = new ShareWebExchangeRateLimiter();

  async function readSession(request: Request): Promise<{
    discriminator: string;
    token: string;
    session: ShareWebSession;
  } | null> {
    const discriminator =
      request.headers.get(LINK_SESSION_HEADER) ??
      new URL(request.url).searchParams.get("session") ??
      "";
    if (!SESSION_DISCRIMINATOR.test(discriminator)) return null;
    const token = parseCookies(request.headers.get("cookie")).get(cookieName(discriminator));
    if (!token) return null;
    const session = sessions.get(discriminator, token, nowMs());
    return session ? { discriminator, token, session } : null;
  }

  async function serveViewer(pathname: string): Promise<Response> {
    if (!viewerAssetsDir) return refused();
    const relative = pathname.startsWith("/s/assets/")
      ? pathname.slice("/s/".length)
      : "index.html";
    if (relative.includes("..") || relative.includes("\\")) return refused();
    try {
      const bytes = await readFile(join(viewerAssetsDir, relative));
      return response(bodyBuffer(bytes), {
        headers: { "content-type": contentTypeForAsset(relative) },
      });
    } catch {
      return refused();
    }
  }

  return async (request: Request): Promise<Response> => {
    if (!publicHosts.has(request.headers.get("host") ?? "")) return refused();
    const { pathname, search } = new URL(request.url);

    if (request.method === "GET" && (pathname === "/s" || pathname.startsWith("/s/"))) {
      return serveViewer(pathname);
    }

    if (pathname === "/api/exchange" && request.method === "POST") {
      const clientIp = request.headers.get("x-dohc-share-web-client-ip") ?? "unknown";
      if (!exchangeRateLimiter.allow(clientIp, nowMs())) return refused();
      const secret = await exchangeInput(request);
      if (!secret) return refused();
      try {
        const relayResponse = await fetchRelay(
          relayRequest(relayUrl, "/sync/link-exchange", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ secret }),
          }),
        );
        if (relayResponse.status !== 200) return refused();
        const exchanged = (await relayResponse.json()) as Record<string, unknown>;
        const grantId = exchanged.grantId;
        const capabilityToken = exchanged.capabilityToken;
        const expiresAtMs = exchanged.capabilityExpiresAtMs;
        if (
          typeof grantId !== "string" ||
          grantId.length === 0 ||
          typeof capabilityToken !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(capabilityToken) ||
          typeof expiresAtMs !== "number" ||
          !Number.isSafeInteger(expiresAtMs) ||
          expiresAtMs <= nowMs()
        ) {
          return refused();
        }
        const discriminator = linkDiscriminator(grantId);
        const token = newSessionToken();
        if (!/^[A-Za-z0-9_-]{16,}$/u.test(token)) return refused();
        sessions.set(
          token,
          {
            discriminator,
            capabilityToken,
            expiresAtMs,
            createdAtMs: nowMs(),
          },
          nowMs(),
        );
        const maxAge = Math.max(1, Math.ceil((expiresAtMs - nowMs()) / 1_000));
        return jsonResponse(
          { ok: true, session: discriminator },
          {
            headers: {
              "set-cookie":
                `${cookieName(discriminator)}=${token}; Path=/; Max-Age=${maxAge}; ` +
                "Secure; HttpOnly; SameSite=Strict",
            },
          },
        );
      } catch {
        return refused();
      }
    }

    if (pathname.startsWith("/api/view/")) {
      const authenticated = await readSession(request);
      if (!authenticated) return refused();
      let relayPath: string | null = null;
      if (request.method === "GET" && pathname === "/api/view/meta") {
        relayPath = "/sync/link/share";
      } else if (request.method === "GET" && pathname === "/api/view/log") {
        relayPath = `/sync/link/log${search}`;
      } else if (request.method === "GET" && pathname.startsWith("/api/view/blob/")) {
        const sha = pathname.slice("/api/view/blob/".length);
        if (SHA256_HEX.test(sha)) relayPath = `/sync/link/blobs/${sha}`;
      }
      if (!relayPath) return refused();

      try {
        const relayResponse = await fetchRelay(
          relayRequest(relayUrl, relayPath, {
            headers: {
              authorization: `LinkCapability ${authenticated.session.capabilityToken}`,
            },
          }),
        );
        if (relayResponse.status !== 200) {
          if (relayResponse.status === 404) {
            sessions.delete(authenticated.discriminator, authenticated.token);
          }
          return refused();
        }
        const bytes = new Uint8Array(await relayResponse.arrayBuffer());
        if (pathname.startsWith("/api/view/blob/")) {
          const raster = rasterContentType(bytes);
          return response(bodyBuffer(bytes), {
            headers: raster
              ? { "content-type": raster }
              : {
                  "content-type": "application/octet-stream",
                  "content-disposition": "attachment",
                },
          });
        }
        return response(bodyBuffer(bytes), {
          headers: { "content-type": "application/json" },
        });
      } catch {
        return refused();
      }
    }

    return refused();
  };
}

export const shareWebRefusalBody = REFUSAL_BODY;
