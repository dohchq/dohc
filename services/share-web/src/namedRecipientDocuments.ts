import {readBoundedJson} from "@dohc/service-http";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {namedAccountCookie} from "./namedAccountCookie";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";

export function createNamedRecipientDocumentsClient(options: {relayUrl: string; publicOrigin: string; exchangeKey: string;
  limits: NamedLiveBrowserClientLimits; browserLimits: NamedLiveBrowserLimits; fetchRelay(request: Request): Promise<Response>}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), browserLimits = parseNamedLiveBrowserLimits(options.browserLimits);
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) throw new TypeError("Invalid named navigation configuration.");
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: {"cache-control": "private, no-store"}});
  let pending = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/live/named-documents" || url.search || request.method !== "POST" || request.signal.aborted ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin || request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || pending >= limits.maxPendingRequests) return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refuse();
    pending++;
    const controller = new AbortController(), abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, {once: true});
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, limits.timeoutMs);
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(refuse()), {once: true}));
    const work = (async () => {
      let response: Response | undefined;
      try {
        const input = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "grantId") return refuse();
        const grantId = parseLiveUpdateIdentifier((input as Record<string, unknown>).grantId);
        response = await options.fetchRelay(new Request(new URL("/sync/live/named-documents", options.relayUrl), {
          method: "POST", redirect: "manual", signal: controller.signal, body: JSON.stringify({grantId}),
          headers: {"content-type": "application/json", cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey},
        }));
        controller.signal.throwIfAborted();
        if (response.status !== 200 || response.redirected || response.headers.has("location") ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refuse();
        const result = await readBoundedJson(response, limits.maxResponseBytes, controller.signal);
        if (!result || typeof result !== "object" || Array.isArray(result) ||
          Object.keys(result).sort().join() !== "files,grantId,shareId,userId,workspaceId") return refuse();
        const data = result as Record<string, unknown>;
        for (const key of ["grantId", "shareId", "userId", "workspaceId"]) parseLiveUpdateIdentifier(data[key]);
        if (data.grantId !== grantId || !Array.isArray(data.files)) return refuse();
        const body = JSON.stringify({...data, limits: browserLimits});
        if (Buffer.byteLength(body) > browserLimits.maxHttpResponseBytes) return refuse();
        return new Response(body, {headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
      } catch {return refuse();}
      finally {await response?.body?.cancel().catch(() => {}); pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);}
    })();
    return Promise.race([work, cancelled]);
  };
}
