import {readBoundedJson} from "@dohc/service-http";
import {parseWorkspaceJoinPreview, parseWorkspaceJoinResult, WORKSPACE_MEMBER_ROUTES} from "@dohc/security-contract/workspace-members";
import {isJoinToken, JOIN_API, JOIN_REFUSAL_STATUS, type JoinRefusal} from "../viewer/src/joinWire";
import {namedAccountCookie} from "./namedAccountCookie";
import {parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits} from "./namedLiveBrowserClient";
import {createNamedRelayCalls} from "./namedRelayCalls";

const ROUTES = {
  [JOIN_API.preview]: {relay: WORKSPACE_MEMBER_ROUTES.joinPreview, parse: parseWorkspaceJoinPreview},
  [JOIN_API.join]: {relay: WORKSPACE_MEMBER_ROUTES.join, parse: parseWorkspaceJoinResult},
} as const;

// The relay's refusal codes for an invite link, by what the page tells the person.
const RELAY_CODES: Record<string, JoinRefusal> = {
  invite_link_off: "link_off",
  member_removed: "removed",
  workspace_full: "full",
};

const headers = {"cache-control": "private, no-store"};
const refusal = (code: JoinRefusal) => Response.json({ok: false, code}, {status: JOIN_REFUSAL_STATUS[code], headers});
const contentType = (response: Response | Request) => response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

/**
 * Forwards a signed-in browser's invite-link preview and join to the relay.
 * The token stays in the request body; the relay derives the account from the
 * forwarded session cookie, never from anything the browser names.
 */
export function createWorkspaceJoinClient(options: {relayUrl: string; publicOrigin: string; exchangeKey: string;
  limits: NamedLiveBrowserClientLimits; fetchRelay(request: Request): Promise<Response>}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits);
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) {
    throw new TypeError("Invalid workspace join configuration.");
  }
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers});
  const calls = createNamedRelayCalls({maxPending: limits.maxPendingRequests, timeoutMs: limits.timeoutMs, unrefDeadline: false,
    refuse, unavailable: () => refusal("unavailable"), fetchRelay: input => options.fetchRelay(input)});
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = (ROUTES as Record<string, (typeof ROUTES)[keyof typeof ROUTES] | undefined>)[url.pathname];
    if (!route || url.search || request.method !== "POST" || request.signal.aborted ||
      request.headers.get("host") !== origin.host || request.headers.get("origin") !== options.publicOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site" || contentType(request) !== "application/json") return refuse();
    if (calls.full) return refusal("unavailable");
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refusal("signed_out");
    return calls.run(request, async (signal, relay) => {
      const input = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "token") return refuse();
      const token = (input as Record<string, unknown>).token;
      if (!isJoinToken(token)) return refuse();
      const response = await relay(new Request(new URL(route.relay, options.relayUrl), {
        method: "POST", redirect: "manual", signal, body: JSON.stringify({token}),
        headers: {"content-type": "application/json", cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey},
      }));
      if (response.redirected || response.headers.has("location")) return refusal("unavailable");
      if (response.status === 401) return refusal("signed_out");
      if (response.status !== 200) {
        const body = contentType(response) === "application/json"
          ? await readBoundedJson(response, limits.maxResponseBytes, signal).catch(() => null) : null;
        const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? RELAY_CODES[body.code] : undefined;
        if (code) return refusal(code);
        // A reset or unknown token reads as a missing link.
        if (response.status === 404) return refusal("link_off");
        return refusal("unavailable");
      }
      if (contentType(response) !== "application/json") return refusal("unavailable");
      const result = route.parse(await readBoundedJson(response, limits.maxResponseBytes, signal));
      if (!result) return refusal("unavailable");
      return Response.json(result, {headers});
    });
  };
}
