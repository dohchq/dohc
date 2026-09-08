// The Node side of a fetch-style service: one node:http adapter, one response
// pipe, one token bucket, one parked-waiter registry, and process lifecycle.
// sync-relay and share-web import from here instead of carrying copies.
export { serveFetchHandler, type ServeFetchHandlerOptions } from "./serveFetchHandler";
export { pipeResponseBody } from "./pipeResponseBody";
export { TokenBucketLimiter } from "./tokenBucketLimiter";
export { WaiterRegistry, type WaiterCaps } from "./waiterRegistry";
export { readBoundedJson } from "./readBoundedJson";
export { closeServer, fatal, installShutdown, parseGracePeriodMs } from "./process";
export { createDeviceControlRequestParser, refuseDeviceControl } from "./deviceControlRequest";

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
