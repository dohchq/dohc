import { types } from "node:util";
import { parseHostEpoch, parseHostMode, parseHostControlIdentifier } from "@dohc/live-session-contract/host-control";
import { LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateIdentifier, parseLiveUpdateDigest } from "@dohc/live-session-contract/live-update-admission";
import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth.js";
import type { TicketHostReport } from "./storage.js";

export function ticketRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Invalid live-ticket input.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Invalid live-ticket input.");
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid live-ticket input.");
    result[field] = descriptor.value;
  }
  return result;
}

export function snapshotNamedTicketScope(value: unknown): NamedLiveBrowserContext {
  const scope = ticketRecord(value, ["workspaceId", "shareId", "grantId", "userId"]);
  return {
    workspaceId: parseLiveUpdateIdentifier(scope.workspaceId, "workspace ID"),
    shareId: parseLiveUpdateIdentifier(scope.shareId, "share ID"),
    grantId: parseLiveUpdateIdentifier(scope.grantId, "grant ID"),
    userId: parseLiveUpdateIdentifier(scope.userId, "user ID"),
  };
}

export function snapshotTicketHostReport(value: unknown): TicketHostReport {
  const report = ticketRecord(value, ["connection", "binding"]);
  const coordinate = ticketRecord(report.connection, ["mode", "hostId", "hostEpoch", "instanceId", "connectionId"]);
  const raw = ticketRecord(report.binding, ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"]);
  const selectors = raw.selectorPaths;
  if (!Array.isArray(selectors) || types.isProxy(selectors) || Object.getPrototypeOf(selectors) !== Array.prototype) {
    throw new TypeError("Invalid live-ticket selectors.");
  }
  const length = Object.getOwnPropertyDescriptor(selectors, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT || Reflect.ownKeys(selectors).length !== length + 1) {
    throw new TypeError("Invalid live-ticket selectors.");
  }
  const paths: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(selectors, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid live-ticket selectors.");
    paths.push(descriptor.value);
  }
  const binding = parseLiveObjectBinding({ ...raw, selectorPaths: paths });
  if (binding.mainVersionId !== "main" || binding.currentPath !== raw.currentPath ||
    JSON.stringify(binding.selectorPaths) !== JSON.stringify(paths)) throw new TypeError("Invalid live-ticket binding.");
  parseLiveUpdateDigest(binding.lineageClaimId);
  return { binding, connection: {
    mode: parseHostMode(coordinate.mode), hostId: parseHostControlIdentifier(coordinate.hostId, "host ID"),
    hostEpoch: parseHostEpoch(coordinate.hostEpoch), instanceId: parseHostControlIdentifier(coordinate.instanceId, "host instance ID"),
    connectionId: parseHostControlIdentifier(coordinate.connectionId, "connection ID"),
  } };
}

export function parseTicketHash(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").length !== 32 || Buffer.from(value, "base64url").toString("base64url") !== value) {
    throw new TypeError("Invalid live-ticket credential.");
  }
  return value;
}
