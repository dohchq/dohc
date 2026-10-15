import {readBoundedJson} from "@dohc/service-http";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {namedAccountCookie} from "./namedAccountCookie";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {createNamedRelayCalls} from "./namedRelayCalls";
import {parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";

export function createNamedRecipientDocumentsClient(options: {relayUrl: string; publicOrigin: string; exchangeKey: string;
  limits: NamedLiveBrowserClientLimits; browserLimits: NamedLiveBrowserLimits; fetchRelay(request: Request): Promise<Response>}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), browserLimits = parseNamedLiveBrowserLimits(options.browserLimits);
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) throw new TypeError("Invalid named navigation configuration.");
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: {"cache-control": "private, no-store"}});
  const calls = createNamedRelayCalls({maxPending: limits.maxPendingRequests, timeoutMs: limits.timeoutMs, unrefDeadline: false,
    refuse, fetchRelay: input => options.fetchRelay(input)});
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/live/named-documents" || url.search || request.method !== "POST" || request.signal.aborted ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin || request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || calls.full) return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refuse();
    return calls.run(request, async (signal, relay) => {
      const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "grantId") return refuse();
      const grantId = parseLiveUpdateIdentifier((input as Record<string, unknown>).grantId);
      const response = await relay(new Request(new URL("/sync/live/named-documents", options.relayUrl), {
        method: "POST", redirect: "manual", signal, body: JSON.stringify({grantId}),
        headers: {"content-type": "application/json", cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey},
      }));
      if (response.status === 404 && !response.redirected && !response.headers.has("location")) {
        const error = await readBoundedJson(response, limits.maxResponseBytes, signal);
        if (error && typeof error === "object" && "code" in error && error.code === "share_access_removed") {
          return Response.json({ok: false, code: "share_access_removed", error: "The owner removed your access."},
            {status: 404, headers: {"cache-control": "private, no-store"}});
        }
        return refuse();
      }
      if (response.status !== 200 || response.redirected || response.headers.has("location") ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return refuse();
      const result = await readBoundedJson(response, limits.maxResponseBytes, signal);
      if (!result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).sort().join() !== "access,files,grantId,shareId,sharerName,subjectName,userId,workspaceId") return refuse();
      const data = result as Record<string, unknown>;
      for (const key of ["grantId", "shareId", "userId", "workspaceId"]) parseLiveUpdateIdentifier(data[key]);
      if (data.grantId !== grantId || data.workspaceId !== `named:${grantId}` || !Array.isArray(data.files)) return refuse();
      const body = JSON.stringify({...data, limits: browserLimits});
      if (Buffer.byteLength(body) > browserLimits.maxHttpResponseBytes) return refuse();
      return new Response(body, {headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
    });
  };
}
