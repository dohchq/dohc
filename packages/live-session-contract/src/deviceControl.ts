import { parseHostControlIdentifier, parseHostEpoch, type HostEpoch } from "./hostControl.js";

export const DEVICE_CONTROL_PATH = "/api/device-control";
export const DEVICE_CONTROL_PROTOCOL = "dohc-device-control-v1";

export interface DeviceControlLimits {
  readonly maxConnections: number;
  readonly maxHeaderBytes: number;
  readonly maxCredentialBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxPendingBytes: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly handshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

export function parseDeviceControlLimits(value: unknown): DeviceControlLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid device control limits.");
  const record = value as Record<string, unknown>;
  const names = ["maxConnections", "maxHeaderBytes", "maxCredentialBytes", "maxPayloadBytes", "maxPendingBytes",
    "maxFragments", "maxBufferedChunks", "handshakeTimeoutMs", "heartbeatIntervalMs", "heartbeatTimeoutMs", "closeTimeoutMs"] as const;
  if (Object.keys(record).length !== names.length || names.some(name => !Number.isSafeInteger(record[name]) ||
    (record[name] as number) <= 0 || (record[name] as number) > 2_147_483_647)) throw new TypeError("Invalid device control limits.");
  const limits = Object.fromEntries(names.map(name => [name, record[name]])) as unknown as DeviceControlLimits;
  if (limits.maxCredentialBytes > limits.maxHeaderBytes || limits.maxPayloadBytes + 16 > limits.maxPendingBytes ||
    limits.heartbeatIntervalMs + limits.heartbeatTimeoutMs > 2_147_483_647) throw new TypeError("Invalid device control limits.");
  return Object.freeze(limits);
}

export interface DeviceControlRegistration {
  readonly type: "registered";
  readonly mode: "device";
  readonly hostId: string;
  readonly hostEpoch: HostEpoch;
  readonly instanceId: string;
  readonly connectionId: string;
}

export function parseDeviceControlRegistration(value: unknown): DeviceControlRegistration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid control registration.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "connectionId,hostEpoch,hostId,instanceId,mode,type" ||
    record.type !== "registered" || record.mode !== "device") throw new TypeError("Invalid control registration.");
  return Object.freeze({ type: "registered", mode: "device", hostId: parseHostControlIdentifier(record.hostId),
    hostEpoch: parseHostEpoch(record.hostEpoch), instanceId: parseHostControlIdentifier(record.instanceId),
    connectionId: parseHostControlIdentifier(record.connectionId) });
}
