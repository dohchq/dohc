import type { LiveGatewayHostRoute } from "./liveGateway";
import { openLiveSocket, type HostReceive } from "./linkLiveClient";
import {
  parseNamedLiveBrowserClientLimits,
  type NamedLiveBrowserClientLimits,
} from "./namedLiveBrowserClient";

// A personal agent's live documents. Each call carries the agent's access
// token and MCP address over the relay exchange key, as its other calls do
// (personalAgentClient.ts), and the origin the relay's tickets name. The relay
// derives the owner, the reach and the fence from them, so nothing here names
// one. A request's client carries that request's token, so each tool call
// opens its own session with the token the agent sent.

/** A personal agent's live access through one MCP request. */
export interface PersonalLiveClient {
  /** Asks the relay to host the document at `path`. It holds until the document is ready, still starting, or refused. */
  document(workspaceId: string, path: string, signal: AbortSignal): Promise<Response>;
  ticket(workspaceId: string, objectId: string, signal: AbortSignal): Promise<Response>;
  open(
    workspaceId: string,
    ticketToken: string,
    signal: AbortSignal,
    receive: HostReceive,
  ): Promise<LiveGatewayHostRoute | null>;
}

export const PERSONAL_LIVE_BUSY = "dohc is busy with other live documents. Try again shortly.";

export function createPersonalLiveClient(options: {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits);
  // Every agent's held opens and tickets share one cap, as a link's live requests do.
  let pending = 0;
  async function post(
    path: string,
    headers: Record<string, string>,
    body: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    if (pending >= limits.maxPendingRequests) throw new Error(PERSONAL_LIVE_BUSY);
    pending++;
    try {
      return await options.fetchRelay(
        new Request(new URL(path, options.relayUrl), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]),
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    } finally {
      pending--;
    }
  }
  return {
    agent(input: { accessToken: string; resource: string }): PersonalLiveClient {
      const headers = {
        authorization: `DohcAgent ${input.accessToken}`,
        "x-dohc-agent-resource": input.resource,
        "x-dohc-relay-exchange-key": options.exchangeKey,
        origin: options.publicOrigin,
      };
      return {
        document: (workspaceId, path, signal) =>
          post("/sync/live/personal-document", headers, { workspaceId, path }, signal),
        ticket: (workspaceId, objectId, signal) =>
          post("/sync/live/personal-tickets", headers, { workspaceId, objectId }, signal),
        open(workspaceId, ticketToken, signal, receive) {
          const url = new URL("/sync/live/personal", options.relayUrl);
          url.searchParams.set("workspaceId", workspaceId);
          return openLiveSocket(url, ticketToken, headers, limits.timeoutMs, signal, receive);
        },
      };
    },
  };
}
