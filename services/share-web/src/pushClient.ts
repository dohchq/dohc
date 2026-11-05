import { readBoundedJson } from "@dohc/service-http";
import {
  isPushStatus,
  PUSH_MAX_REQUEST_BYTES,
  PUSH_MAX_RESPONSE_BYTES,
  PUSH_PATHS,
} from "@dohc/workspace-contracts/push-subscriptions";
import { namedAccountCookie } from "./namedAccountCookie";
import { parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits } from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";

const cacheHeaders = {"cache-control": "private, no-store"};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The browser chat page's alerts on this device: `/api/push/status`,
 * `/api/push/subscribe`, and `/api/push/unsubscribe`. It forwards only the
 * account session cookie, so a link holder is signed out here.
 */
export function createPushClient(options: {
  relayUrl: string; publicOrigin: string; exchangeKey: string; limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) {
    throw new TypeError("Invalid push configuration.");
  }
  const maxRequestBytes = Math.min(limits.maxRequestBytes, PUSH_MAX_REQUEST_BYTES);
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: cacheHeaders});
  const unavailable = () => new Response(null, {status: 503, headers: cacheHeaders});
  const calls = createNamedRelayCalls({maxPending: limits.maxPendingRequests, timeoutMs: limits.timeoutMs,
    unrefDeadline: false, refuse, unavailable, fetchRelay: options.fetchRelay});
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname.slice("/api".length);
    // Every route is a POST, so a browser always sends its Origin.
    if (!(PUSH_PATHS as readonly string[]).includes(path) || request.method !== "POST" || url.search ||
        request.signal.aborted || request.headers.get("host") !== origin.host ||
        request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("origin") !== options.publicOrigin ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return Response.json({ok: false, error: "signed out", code: "signed_out"}, {status: 401, headers: cacheHeaders});
    if (calls.full) {
      return Response.json({ok: false, error: "too many alert requests", code: "share_access_rate_limited"}, {status: 429, headers: cacheHeaders});
    }
    return calls.run(request, async (signal, relay) => {
      const tooLarge = () => Response.json({ok: false, error: "request is too large", code: "payload_too_large"}, {status: 413, headers: cacheHeaders});
      let body: string;
      try {body = JSON.stringify(await readBoundedJson(request, maxRequestBytes, signal));}
      catch (error) {
        if (error instanceof RangeError && !signal.aborted) return tooLarge();
        throw error;
      }
      if (Buffer.byteLength(body) > maxRequestBytes) return tooLarge();
      const response = await relay(new Request(new URL(`/sync${path}`, options.relayUrl), {
        method: "POST", redirect: "manual", signal, body,
        headers: {cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey,
          "content-type": "application/json"},
      }));
      if (response.redirected || response.headers.has("location")) return refuse();
      if (response.status >= 500) return unavailable();
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
          ![200, 400, 401, 404, 409, 413, 429].includes(response.status)) return refuse();
      const result = await readBoundedJson(response, Math.min(limits.maxResponseBytes, PUSH_MAX_RESPONSE_BYTES), signal);
      if (response.status === 200 ? !isPushStatus(result) :
        !record(result) || result.ok !== false || typeof result.error !== "string" ||
          (result.code !== undefined && typeof result.code !== "string")) return refuse();
      return Response.json(result, {status: response.status, headers: cacheHeaders});
    });
  };
}
