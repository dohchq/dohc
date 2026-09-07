import { readBoundedJson } from "@dohc/service-http";
import { LIVE_UPDATE_IDENTIFIER_MAX_BYTES, parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedLiveBrowserResolver } from "./namedLiveBrowserAuth";
import { createNamedLiveBrowserSessions } from "./namedLiveBrowserSessions";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import type { SyncRelayStorage } from "./storage";

// Quotes and backslashes double in JSON; other permitted identifier bytes do not expand.
const largestIdentifier = "\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES);
const minimumRequestBytes = Buffer.byteLength(JSON.stringify({ grantId: largestIdentifier }));
const minimumResponseBytes = Buffer.byteLength(JSON.stringify({ userId: largestIdentifier, workspaceId: largestIdentifier, shareId: largestIdentifier, grantId: largestIdentifier }));

export interface NamedLiveBrowserHttpLimits {
  maxSessions: number;
  retentionMs: number;
  maxPendingRequests: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}

export function parseNamedLiveBrowserHttpLimits(value: unknown): NamedLiveBrowserHttpLimits {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "maxPendingRequests,maxRequestBytes,maxResponseBytes,maxSessions,retentionMs,timeoutMs") {
    throw new TypeError("Invalid named browser session limits.");
  }
  const limits = { ...value } as NamedLiveBrowserHttpLimits;
  if (Object.values(limits).some(number => !Number.isSafeInteger(number) || number <= 0) || limits.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(Date.now() + limits.retentionMs) ||
      limits.maxRequestBytes < minimumRequestBytes || limits.maxResponseBytes < minimumResponseBytes) {
    throw new TypeError("Invalid named browser session limits.");
  }
  return limits;
}

export function createNamedLiveBrowserHttp(options: {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserHttpLimits;
  now?: () => number;
}) {
  const limits = parseNamedLiveBrowserHttpLimits(options.limits);
  const publicOrigin = options.publicOrigin;
  if (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith("https://") || options.exchangeKey.length < 32) {
    throw new TypeError("Named browser sessions require an HTTPS origin and relay exchange key.");
  }
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey);
  const sessions = createNamedLiveBrowserSessions({ ...limits, storage: options.storage, resolveActor: options.resolveActor, now: options.now });
  const resolveBrowser = createNamedLiveBrowserResolver(options);
  const refusal = () => Response.json({ ok: false, error: "not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
  let pending = 0;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const create = url.pathname === "/sync/live/named-sessions";
    if ((!create && url.pathname !== "/sync/live/named-sessions/resolve") || url.search || request.method !== "POST" ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
        request.headers.get("origin") !== publicOrigin || !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash) ||
        request.signal.aborted || pending >= limits.maxPendingRequests) return refusal();
    pending++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, limits.timeoutMs);
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(refusal()), { once: true }));
    const work = (async () => {
      try {
        const input = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
        const field = create ? "grantId" : "discriminator";
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join(",") !== field) return refusal();
        const value = (input as Record<string, unknown>)[field];
        const authenticated = new Request(request.url, { headers: { cookie: request.headers.get("cookie") ?? "" }, signal: controller.signal });
        let result: unknown;
        if (create) {
          const grantId = parseLiveUpdateIdentifier(value, "grant ID");
          const grant = options.storage.getShareGrant(grantId);
          const share = grant && options.storage.getShare(grant.shareId);
          if (!share) return refusal();
          const context = await resolveBrowser(authenticated, { grantId, shareId: share.shareId, workspaceId: share.workspaceId });
          controller.signal.throwIfAborted();
          if (!context) return refusal();
          result = sessions.create(context);
        } else {
          if (typeof value !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(value)) return refusal();
          result = await sessions.resolve(authenticated, value);
          controller.signal.throwIfAborted();
        }
        if (result === null) return refusal();
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > limits.maxResponseBytes) return refusal();
        return new Response(body, { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
      } catch { return refusal(); }
      finally {
        // A cancelled authentication still occupies its slot until it settles.
        pending--;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    })();
    return Promise.race([work, cancelled]);
  };
}
