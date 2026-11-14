import { readBoundedJson } from "@dohc/service-http";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import {
  NAMED_LIVE_STOPPED,
  NAMED_LIVE_STOPPED_STATUS,
  isNamedLiveStopped,
} from "@dohc/security-contract/link-refusal";
import { namedAccountCookie } from "./namedAccountCookie";
import {
  parseNamedLiveBrowserClientLimits,
  type NamedLiveBrowserClientLimits,
} from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";
import { isSessionDiscriminator } from "./sessionDiscriminator";

export function createNamedLiveTicketClient(options: {
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
    throw new TypeError("Invalid named live ticket transport.");
  const refusal = () => Response.json({ ok: false, error: "not found" }, { status: 404 });
  const calls = createNamedRelayCalls({
    maxPending: limits.maxPendingRequests,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: true,
    refuse: refusal,
    fetchRelay: (input) => options.fetchRelay(input),
  });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/live/named-ticket" ||
      url.search ||
      request.method !== "POST" ||
      request.signal.aborted ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      calls.full
    )
      return refusal();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refusal();
    return calls.run(request, async (signal, relay) => {
      const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join() !== "discriminator,objectId"
      )
        return refusal();
      const value = input as Record<string, unknown>;
      if (typeof value.discriminator !== "string" || !isSessionDiscriminator(value.discriminator))
        return refusal();
      const body = JSON.stringify({
        discriminator: value.discriminator,
        objectId: parseLiveUpdateIdentifier(value.objectId, "object ID"),
      });
      if (Buffer.byteLength(body) > limits.maxRequestBytes) return refusal();
      const response = await relay(
        new Request(new URL("/sync/live/named-tickets", options.relayUrl), {
          method: "POST",
          redirect: "manual",
          signal,
          body,
          headers: {
            "content-type": "application/json",
            cookie,
            origin: options.publicOrigin,
            "x-dohc-relay-exchange-key": options.exchangeKey,
          },
        }),
      );
      if (
        ![200, NAMED_LIVE_STOPPED_STATUS].includes(response.status) ||
        response.redirected ||
        response.headers.has("location") ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      )
        return refusal();
      // Only the exact answer that live editing stopped on the server passes, rebuilt here.
      if (response.status !== 200)
        return isNamedLiveStopped(
          await readBoundedJson(response, limits.maxResponseBytes, signal).catch(() => null),
          response.status,
        )
          ? Response.json(NAMED_LIVE_STOPPED, {
              status: NAMED_LIVE_STOPPED_STATUS,
              headers: { "cache-control": "private, no-store" },
            })
          : refusal();
      const parsed = await readBoundedJson(response, limits.maxResponseBytes, signal);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join() !== "expiresAtMs,token"
      )
        return refusal();
      const result = parsed as Record<string, unknown>;
      parseLiveTicketToken(result.token);
      const token = result.token as string;
      if (
        typeof result.expiresAtMs !== "number" ||
        !Number.isSafeInteger(result.expiresAtMs) ||
        result.expiresAtMs <= Date.now()
      )
        return refusal();
      return Response.json(
        { token, expiresAtMs: result.expiresAtMs },
        { headers: { "cache-control": "private, no-store" } },
      );
    });
  };
}
