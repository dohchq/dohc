import { createHash, createPublicKey } from "node:crypto";
import { readBoundedJson } from "@dohc/service-http";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  isPushAuthSecret,
  isPushEndpoint,
  isPushInstallationId,
  isPushKeyId,
  isPushP256Point,
  PUSH_MAX_REQUEST_BYTES,
  PUSH_PATHS,
  PUSH_STATUS_PATH,
  PUSH_SUBSCRIBE_PATH,
  type PushStatus,
} from "@dohc/workspace-contracts/push-subscriptions";
import { badRequest, errorResponse, relayError, RelayError } from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import type { SyncRelayStorage } from "./storage";

const cacheHeaders = {"cache-control": "private, no-store"};
const SUBSCRIBE_KEYS = "auth,endpoint,expiresAtMs,installationId,p256dh,vapidKeyId";

/** A P-256 public key as browsers take it: base64url of the uncompressed point, which must lie on the curve. */
export function isP256PublicKey(value: unknown): value is string {
  if (!isPushP256Point(value)) return false;
  const point = Buffer.from(value, "base64url");
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    createPublicKey({format: "jwk", key: {kty: "EC", crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url")}});
    return true;
  } catch {
    return false;
  }
}

/** This server's VAPID public key and its id. A rotated key gets a new id, which ends every binding to the old one. */
export function parsePushVapidPublicKey(value: string): {publicKey: string; keyId: string} {
  if (!isP256PublicKey(value)) throw new TypeError("The push VAPID public key must be a base64url P-256 point.");
  return {publicKey: value, keyId: createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex")};
}

/**
 * Status, subscribe, and unsubscribe for one browser installation, reached
 * only through share-web. Identity is the account session the cookie
 * validates to, never a field of the request. A link holder has no account
 * session, so every route refuses one.
 */
export function createPushRoutes(options: {
  storage: Pick<SyncRelayStorage, "readPushSubscription" | "bindPushSubscription" | "removePushSubscription">;
  resolveAccountSession: ResolveAccountSession;
  publicOrigin: string;
  exchangeKey: string;
  vapidPublicKey: string | undefined;
  limits: {maxPendingRequests: number; timeoutMs: number};
  nowMs: () => number;
}) {
  const {storage, limits} = options;
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey);
  const vapid = options.vapidPublicKey === undefined ? undefined : parsePushVapidPublicKey(options.vapidPublicKey);
  let pending = 0;
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: cacheHeaders});
  const cancelledResponse = (request: Request) => request.signal.aborted ? refuse() : new Response(null, {status: 503, headers: cacheHeaders});

  const statusFor = (installationId: string, session: AccountSession, nowMs: number): PushStatus => {
    if (!vapid) return {ok: true, available: false};
    const row = storage.readPushSubscription(installationId);
    const off = {ok: true, available: true, vapidPublicKey: vapid.publicKey, vapidKeyId: vapid.keyId} as const;
    // Only the sign-in that turned alerts on sees them on; nothing about
    // another account's or another sign-in's binding leaves.
    if (!row || row.userId !== session.userId || row.sessionId !== session.sessionId ||
        row.vapidKeyId !== vapid.keyId || row.expiresAtMs <= nowMs) {
      return {...off, enabled: false, generation: null, fingerprint: null};
    }
    return {...off, enabled: true, generation: row.generation,
      fingerprint: createHash("sha256").update(row.endpoint, "utf8").digest("hex")};
  };

  const work = async (request: Request, path: string, signal: AbortSignal): Promise<Response> => {
    if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw badRequest("invalid request");
    }
    let value: unknown;
    try {value = await readBoundedJson(request, PUSH_MAX_REQUEST_BYTES, signal);}
    catch (error) {
      if (signal.aborted) throw error;
      throw error instanceof RangeError ? relayError("payload_too_large") : badRequest("invalid request");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("invalid request");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join() !== (path === PUSH_SUBSCRIBE_PATH ? SUBSCRIBE_KEYS : "installationId")) {
      throw badRequest("invalid request");
    }
    // Authenticate before answering anything about the installation.
    const session = await options.resolveAccountSession(new Request(request.url, {
      headers: {cookie: request.headers.get("cookie") ?? ""}, signal,
    }));
    signal.throwIfAborted();
    const nowMs = options.nowMs();
    if (session.expiresAtMs <= nowMs) throw new UnauthorizedError();
    const installationId = input.installationId;
    if (!isPushInstallationId(installationId)) throw badRequest("installationId is invalid");
    if (path === PUSH_SUBSCRIBE_PATH) {
      const {vapidKeyId, endpoint, p256dh, auth, expiresAtMs} = input;
      if (!vapid) throw new RelayError("conflict", "alerts are not set up on this server");
      if (!isPushKeyId(vapidKeyId)) throw badRequest("vapidKeyId is invalid");
      if (vapidKeyId !== vapid.keyId) throw new RelayError("conflict", "the server's alert key changed");
      if (!isPushEndpoint(endpoint)) throw badRequest("endpoint is invalid");
      if (!isP256PublicKey(p256dh)) throw badRequest("p256dh is invalid");
      if (!isPushAuthSecret(auth)) throw badRequest("auth is invalid");
      if (expiresAtMs !== null && (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs)) {
        throw badRequest("expiresAtMs is invalid");
      }
      storage.bindPushSubscription({installationId, userId: session.userId, sessionId: session.sessionId,
        sessionExpiresAtMs: session.expiresAtMs, endpoint, p256dh, auth, vapidKeyId: vapid.keyId,
        browserExpiresAtMs: expiresAtMs, nowMs, accountName: session.displayName});
    } else if (path !== PUSH_STATUS_PATH) {
      storage.removePushSubscription({installationId, userId: session.userId});
    }
    return Response.json(statusFor(installationId, session, nowMs), {headers: cacheHeaders});
  };

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.slice("/sync".length);
    // Every route is a POST, so a browser always sends its Origin.
    if (!(PUSH_PATHS as readonly string[]).includes(path) || request.method !== "POST" ||
        request.signal.aborted || request.headers.get("origin") !== options.publicOrigin ||
        !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash)) return refuse();
    if (pending >= limits.maxPendingRequests) return errorResponse(relayError("share_access_rate_limited"));
    pending++;
    const controller = new AbortController(), abort = () => controller.abort();
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(cancelledResponse(request)), {once: true}));
    request.signal.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(abort, limits.timeoutMs);
    const completed = (async () => {
      try {return await work(request, path, controller.signal);}
      catch (error) {return controller.signal.aborted ? cancelledResponse(request) : errorResponse(error);}
      finally {pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);}
    })();
    return Promise.race([completed, cancelled]);
  };
}
