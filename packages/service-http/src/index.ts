// The Node side of a fetch-style service: one node:http adapter, one response
// pipe, one token bucket, one parked-waiter registry, and process lifecycle.
// sync-relay and share-web import from here instead of carrying copies.
import { createHash } from "node:crypto";

export { serveFetchHandler, type ServeFetchHandlerOptions } from "./serveFetchHandler";
export { pipeResponseBody } from "./pipeResponseBody";
export { TokenBucketLimiter } from "./tokenBucketLimiter";
export { WaiterRegistry, type WaiterCaps } from "./waiterRegistry";
export { closeServer, fatal, installShutdown, parseGracePeriodMs } from "./process";

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
