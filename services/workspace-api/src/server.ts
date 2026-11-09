import { toNodeHandler } from "better-auth/node";
import { createServer, type Server } from "node:http";
import { sanitizeAuthHeaders } from "./clientAddress";

export interface RequestTimeouts {
  /** How long a client has to send its request headers. */
  headersMs: number;
  /** How long a client has to send the whole request, body included. */
  requestMs: number;
  /** How often Node checks both limits. Its default is 30 s. */
  checkEveryMs: number;
}

// Every body this service reads is small: auth JSON, or one crash report.
export const REQUEST_TIMEOUTS: RequestTimeouts = { headersMs: 10_000, requestMs: 30_000, checkEveryMs: 1_000 };

/**
 * The node:http server in front of the router. The client address is derived
 * from the socket and this server's own trusted proxy list before Better Auth
 * sees a single header, so no caller can choose the address its rate limit is
 * counted against.
 */
export function createWorkspaceServer(
  handle: (request: Request) => Promise<Response>,
  trustedProxies: ReadonlySet<string>,
  timeouts: RequestTimeouts = REQUEST_TIMEOUTS,
): Server {
  const handler = toNodeHandler(handle);
  return createServer(
    { headersTimeout: timeouts.headersMs, requestTimeout: timeouts.requestMs, connectionsCheckingInterval: timeouts.checkEveryMs },
    (request, response) => {
      try {
        sanitizeAuthHeaders(request.headers, request.socket.remoteAddress, trustedProxies);
      } catch {
        // A connection with no address of its own cannot be rate limited; it has
        // usually already gone away by the time the request parses.
        response.writeHead(400).end();
        return;
      }
      // The adapter rejects a request it can't read before the router sees it.
      // The router answers every other failure itself.
      handler(request, response).catch(() => {
        if (response.headersSent || response.destroyed) response.destroy();
        else response.writeHead(400).end();
      });
    },
  );
}
