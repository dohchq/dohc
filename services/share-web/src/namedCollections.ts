import { APP_BACKEND_REQUEST_BYTES } from "@dohc/security-contract/app-backend";
import { readBoundedJson } from "@dohc/service-http";
import { namedAccountCookie } from "./namedAccountCookie";
import {
  parseNamedLiveBrowserClientLimits,
  type NamedLiveBrowserClientLimits,
} from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";

export const NAMED_COLLECTIONS_API = "/api/named/collections";
export const NAMED_COLLECTIONS_REQUEST_BYTES = APP_BACKEND_REQUEST_BYTES;
const RESPONSE_BYTES = 1024 * 1024;
const OPERATIONS = ["collections", "collection", "collectionRecords", "collectionEdit"];
const cacheHeaders = { "cache-control": "private, no-store" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A signed-in page's transactional Collections through one of its invitations: share-web forwards the account cookie to
 * the relay, which decides who the person is, which invitation is theirs, and what the owner lets them read and change.
 */
export function createNamedCollectionsClient(options: {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits),
    origin = new URL(options.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.publicOrigin ||
    options.exchangeKey.length < 32
  )
    throw new TypeError("Invalid named Collections configuration.");
  const refuse = () =>
    Response.json({ ok: false, error: "not found" }, { status: 404, headers: cacheHeaders });
  const unavailable = () => new Response(null, { status: 503, headers: cacheHeaders });
  const calls = createNamedRelayCalls({
    maxPending: limits.maxPendingRequests,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: false,
    refuse,
    unavailable,
    fetchRelay: options.fetchRelay,
  });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== NAMED_COLLECTIONS_API ||
      url.search ||
      request.method !== "POST" ||
      request.signal.aborted ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
    )
      return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie)
      return Response.json(
        { ok: false, error: "signed out", code: "signed_out" },
        { status: 401, headers: cacheHeaders },
      );
    if (calls.full)
      return Response.json(
        { ok: false, error: "too many requests", code: "share_access_rate_limited" },
        { status: 429, headers: cacheHeaders },
      );
    return calls.run(request, async (signal, relay) => {
      const input = await readBoundedJson(request, NAMED_COLLECTIONS_REQUEST_BYTES, signal);
      if (
        !record(input) ||
        Object.keys(input).sort().join() !== "args,grantId,operation" ||
        typeof input.grantId !== "string" ||
        !OPERATIONS.includes(String(input.operation)) ||
        !record(input.args)
      )
        return refuse();
      const response = await relay(
        new Request(new URL("/sync/live/named-collections", options.relayUrl), {
          method: "POST",
          redirect: "manual",
          signal,
          body: JSON.stringify(input),
          headers: {
            cookie,
            origin: options.publicOrigin,
            "x-dohc-relay-exchange-key": options.exchangeKey,
            "content-type": "application/json",
          },
        }),
      );
      if (response.redirected || response.headers.has("location")) return refuse();
      if (response.status >= 500 || response.status === 429) return unavailable();
      if (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json" ||
        ![200, 400, 404, 409].includes(response.status)
      )
        return refuse();
      const result = await readBoundedJson(response, RESPONSE_BYTES, signal);
      if (
        !record(result) ||
        (response.status === 200
          ? Object.keys(result).sort().join() !== "ok,result" ||
            result.ok !== true ||
            !record(result.result)
          : result.ok !== false || typeof result.code !== "string")
      )
        return refuse();
      if (response.status === 404) return refuse();
      return Response.json(response.status === 200 ? result : { ok: false, code: result.code }, {
        status: response.status,
        headers: cacheHeaders,
      });
    });
  };
}
