import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseHostControlIdentifier, parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { DeviceControlLimits } from "@dohc/live-session-contract/device-control";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveSettlementConfig } from "./liveSettlementConfig.js";
import {parseLiveRestoreConfig} from "./liveRestorePreparation.js";
import {DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";

export function configRecord(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) throw new TypeError("Invalid device delivery configuration.");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 1, maximum = 2_147_483_647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid device delivery limit.");
  return value;
}
function path(value: unknown, directory: boolean): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new TypeError("Device delivery paths must be canonical and absolute.");
  const actual = realpathSync(value);
  if ((process.platform === "win32" ? actual.toLowerCase() !== value.toLowerCase() : actual !== value) ||
    (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())) throw new TypeError("Invalid device delivery path.");
  return value;
}
function read(value: string): unknown {
  const file = path(value, false);
  if (statSync(file).size > 1024 * 1024) throw new TypeError("Device delivery configuration is too large.");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function readDeviceLiveHostConfig(file: string, limits: DeviceControlLimits) {
  const row = configRecord(read(file), ["version", "engineExecutable", "hostId", "hostEpoch", "instanceId", "workspaces", "ingress", "maxQueuedBytes", "shutdownGraceMs"], ["settlement", "restore"]);
  if (row.version !== 1 || !Array.isArray(row.workspaces) || row.workspaces.length < 1 || row.workspaces.length > 64) throw new TypeError("Invalid device delivery configuration.");
  const workspaces = row.workspaces.map(item => {
    const entry = configRecord(item, ["root", "workspaceId", "maxRegistrations"]);
    return Object.freeze({ root: path(entry.root, true), workspaceId: parseLiveUpdateIdentifier(entry.workspaceId), maxRegistrations: integer(entry.maxRegistrations) });
  });
  if (new Set(workspaces.map(item => item.workspaceId)).size !== workspaces.length ||
    new Set(workspaces.map(item => process.platform === "win32" ? item.root.toLowerCase() : item.root)).size !== workspaces.length) throw new TypeError("Duplicate device workspace.");
  const ingress = configRecord(row.ingress, ["aggregateBytes", "applicationWorkingReserveBytes", "maxUploads", "uploadDeadlineMs"]);
  const settlement = parseLiveSettlementConfig(row.settlement);
  const restoreRow = row.restore === undefined ? undefined : configRecord(row.restore, ["maxBytes", "maxEvents"]);
  const restore = restoreRow ? Object.freeze({maxBytes: integer(restoreRow.maxBytes, 5, DEFAULT_MAX_BLOB_BYTES), maxEvents: integer(restoreRow.maxEvents)}) : undefined;
  const applicationWorkingReserveBytes = integer(ingress.applicationWorkingReserveBytes, 0);
  if (applicationWorkingReserveBytes === 0) throw new TypeError("Live application requires a positive applicationWorkingReserveBytes limit.");
  return Object.freeze({ version: 1 as const, engineExecutable: path(row.engineExecutable, false),
    settlement, restore,
    shutdownGraceMs: integer(row.shutdownGraceMs),
    hostId: parseHostControlIdentifier(row.hostId), hostEpoch: parseHostEpoch(row.hostEpoch), instanceId: parseHostControlIdentifier(row.instanceId),
    workspaces: Object.freeze(workspaces), maxQueuedBytes: integer(row.maxQueuedBytes, Math.max(limits.maxPayloadBytes + 16, 65_536 + 16)),
    ingress: Object.freeze({ aggregateBytes: integer(ingress.aggregateBytes), applicationWorkingReserveBytes,
      maxUploads: integer(ingress.maxUploads), uploadDeadlineMs: integer(ingress.uploadDeadlineMs) }) });
}
export type DeviceLiveHostConfig = ReturnType<typeof readDeviceLiveHostConfig>;

export function readRelayDeviceDeliveryConfig(file: string, limits: DeviceControlLimits) {
  return parseRelayDeviceDeliveryConfig(read(file),limits);
}
export function parseRelayDeviceDeliveryConfig(value: unknown, limits: DeviceControlLimits) {
  const row = configRecord(value, ["version", "workspaceIds", "client", "maxQueuedBytes", "maxActiveDrains"], ["restore"]);
  if (row.version !== 1 || !Array.isArray(row.workspaceIds) || row.workspaceIds.length < 1 || row.workspaceIds.length > 64) throw new TypeError("Invalid relay delivery configuration.");
  const workspaceIds = row.workspaceIds.map(value => parseLiveUpdateIdentifier(value));
  if (new Set(workspaceIds).size !== workspaceIds.length) throw new TypeError("Duplicate relay workspace.");
  const client = configRecord(row.client, ["aggregateBytes", "maxUploads", "connectTimeoutMs", "requestDeadlineMs", "maxFrameBytes"]);
  const maxFrameBytes = integer(client.maxFrameBytes, 1024 * 1024);
  return Object.freeze({ version: 1 as const,workspaceIds: Object.freeze(workspaceIds), maxActiveDrains: integer(row.maxActiveDrains),
    restore: parseLiveRestoreConfig(row.restore),
    maxQueuedBytes: integer(row.maxQueuedBytes, Math.max(limits.maxPayloadBytes + 16, maxFrameBytes + 20 + 16)),
    client: Object.freeze({ aggregateBytes: integer(client.aggregateBytes, 20 * 1024 * 1024 + Math.floor((20 * 1024 * 1024 - 2) / 5) * 16 + 3 * 1024 * 1024),
      maxUploads: integer(client.maxUploads), connectTimeoutMs: integer(client.connectTimeoutMs), requestDeadlineMs: integer(client.requestDeadlineMs), maxFrameBytes }) });
}
export type RelayDeviceDeliveryConfig = ReturnType<typeof readRelayDeviceDeliveryConfig>;
