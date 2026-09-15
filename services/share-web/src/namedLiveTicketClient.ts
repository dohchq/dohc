import {readBoundedJson} from "@dohc/service-http";
import {parseLiveTicketToken} from "@dohc/live-session-contract/live-ticket";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {namedAccountCookie} from "./namedAccountCookie";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {isSessionDiscriminator} from "./sessionDiscriminator";

export function createNamedLiveTicketClient(options: {
  relayUrl: string; publicOrigin: string; exchangeKey: string; limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) throw new TypeError("Invalid named live ticket transport.");
  const refusal = () => Response.json({ok: false, error: "not found"}, {status: 404});
  let pending = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/live/named-ticket" || url.search || request.method !== "POST" || request.signal.aborted ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || pending >= limits.maxPendingRequests) return refusal();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refusal();
    pending++;
    const controller = new AbortController(), abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(abort, limits.timeoutMs); timer.unref();
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(refusal()), {once: true}));
    const work = (async () => {
      let response: Response | undefined;
      try {
        const input = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "discriminator,objectId") return refusal();
        const value = input as Record<string, unknown>;
        if (typeof value.discriminator !== "string" || !isSessionDiscriminator(value.discriminator)) return refusal();
        const body = JSON.stringify({discriminator: value.discriminator, objectId: parseLiveUpdateIdentifier(value.objectId, "object ID")});
        if (Buffer.byteLength(body) > limits.maxRequestBytes) return refusal();
        response = await options.fetchRelay(new Request(new URL("/sync/live/named-tickets", options.relayUrl), {
          method: "POST", redirect: "manual", signal: controller.signal, body,
          headers: {"content-type": "application/json", cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey},
        }));
        controller.signal.throwIfAborted();
        if (response.status !== 200 || response.redirected || response.headers.has("location") ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refusal();
        const parsed = await readBoundedJson(response, limits.maxResponseBytes, controller.signal);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join() !== "expiresAtMs,token") return refusal();
        const result = parsed as Record<string, unknown>;
        parseLiveTicketToken(result.token);
        const token = result.token as string;
        if (typeof result.expiresAtMs !== "number" || !Number.isSafeInteger(result.expiresAtMs) || result.expiresAtMs <= Date.now()) return refusal();
        return Response.json({token, expiresAtMs: result.expiresAtMs}, {headers: {"cache-control": "private, no-store"}});
      } catch {return refusal();}
      finally {
        await response?.body?.cancel().catch(() => {});
        pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      }
    })();
    return Promise.race([work, cancelled]);
  };
}
