// The Node side of a fetch-style service: one node:http adapter, one response
// pipe, one token bucket, one parked-waiter registry, and process lifecycle.
// sync-relay, share-web, and workspace-api import from here instead of carrying copies.
export { serveFetchHandler, type ServeFetchHandlerOptions } from "./serveFetchHandler";
export { DRAIN_TIMEOUT_HEADER, DRAIN_TIMEOUT_MS, pipeResponseBody } from "./pipeResponseBody";
export { TokenBucketLimiter } from "./tokenBucketLimiter";
export { WaiterRegistry, type WaiterCaps } from "./waiterRegistry";
export { readBoundedJson } from "./readBoundedJson";
export { canonicalIpAddress } from "./canonicalIpAddress";
export { closeServer, fatal, installShutdown, parseGracePeriodMs } from "./process";
export { createDeviceControlRequestParser, refuseDeviceControl } from "./deviceControlRequest";
export { BoundedSendQueue } from "./boundedSendQueue";
export { DeviceCreditSender } from "./deviceCreditSender";
export { DeviceControlWriter, DeviceCreditWindow } from "./deviceControlWriter";

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
