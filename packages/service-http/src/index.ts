// The Node side of a fetch-style service: one node:http adapter, one response
// pipe, one token bucket, one parked-waiter registry, and process lifecycle.
// sync-relay, share-web, and workspace-api import from here instead of carrying copies.
export {
  ClientClosedRequest,
  RefusedRequest,
  serveFetchHandler,
  type ServeFetchHandlerOptions,
  waitsOnQuery,
} from "./serveFetchHandler";
export { carryRequestMark, createRequestLog, type RequestLog } from "./requestLog";
export { DRAIN_TIMEOUT_HEADER, DRAIN_TIMEOUT_MS, pipeResponseBody } from "./pipeResponseBody";
export { TokenBucketLimiter } from "./tokenBucketLimiter";
export { WaiterRegistry, type WaiterCaps } from "./waiterRegistry";
export { readBoundedBytes, readBoundedJson } from "./readBoundedJson";
export { canonicalIpAddress } from "./canonicalIpAddress";
export { clientAddress, senderAddressKey } from "./clientAddress";
export { closeServer, fatal, installShutdown, parseGracePeriodMs } from "./process";
export { withConnectRetry, type ConnectRetryOptions } from "./connectRetry";
export { createDeviceControlRequestParser, refuseDeviceControl } from "./deviceControlRequest";
export { BoundedSendQueue } from "./boundedSendQueue";
export { DeviceCreditSender } from "./deviceCreditSender";
export { DeviceControlWriter, DeviceCreditWindow } from "./deviceControlWriter";
export {
  isAllowedPublicHostname,
  isPublicInternetAddress,
  parseSafeOutboundHttpsUrl,
  parseSafeOutboundJson,
  readSafeOutboundHttps,
  resolveSafeAddresses,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  sendSafeOutboundHttps,
  type SafeAddressLookup,
  type SafeAddressRecord,
  type SafeOutboundDestination,
  type SafeOutboundErrorCode,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
  type SafeOutboundUrlOptions,
} from "./safeOutboundHttps";

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
export {
  DECLARED_HTTPS_USER_AGENT,
  DeclaredHttpsError,
  loopbackDeclaredHttpsTransport,
  safeDeclaredHttpsTransport,
  sendDeclaredHttps,
  type DeclaredHttpsErrorCode,
  type DeclaredHttpsRequest,
  type DeclaredHttpsTransport,
} from "./declaredHttps";
