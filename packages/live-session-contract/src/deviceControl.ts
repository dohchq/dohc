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

export interface DeviceLiveHostStart {
  readonly type: "liveHost.start";
  readonly version: 1;
  readonly relayNamespace: string;
  readonly host: Omit<DeviceControlRegistration, "type" | "mode">;
  readonly authToken: string;
  readonly receive: DeviceLiveHostReceive;
}

export function parseDeviceLiveHostStart(value: unknown): DeviceLiveHostStart {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid live host start.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "authToken,host,receive,relayNamespace,type,version" || row.type !== "liveHost.start" ||
    row.version !== 1 || typeof row.authToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.authToken) ||
    !row.host || typeof row.host !== "object" || Array.isArray(row.host) ||
    Object.keys(row.host).sort().join() !== "connectionId,hostEpoch,hostId,instanceId") throw new TypeError("Invalid live host start.");
  const { type: _type, mode: _mode, ...host } = parseDeviceControlRegistration({ ...row.host, type: "registered", mode: "device" });
  return Object.freeze({ type: "liveHost.start", version: 1, relayNamespace: parseHostControlIdentifier(row.relayNamespace),
    host: Object.freeze(host), authToken: row.authToken, receive: parseDeviceLiveHostReceive(row.receive) });
}

export interface DeviceLiveHostReceive { readonly maxPayloadBytes: number; readonly maxPendingBytes: number }
export function parseDeviceLiveHostReceive(value: unknown): DeviceLiveHostReceive {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "maxPayloadBytes,maxPendingBytes") {
    throw new TypeError("Invalid device receive window.");
  }
  const row = value as DeviceLiveHostReceive;
  if (![row.maxPayloadBytes, row.maxPendingBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647) ||
    row.maxPayloadBytes + 16 > row.maxPendingBytes) throw new TypeError("Invalid device receive window.");
  return Object.freeze({ maxPayloadBytes: row.maxPayloadBytes, maxPendingBytes: row.maxPendingBytes });
}
export function deviceLiveHostReceive(limits: DeviceLiveHostReceive, peer: DeviceLiveHostReceive = limits): DeviceLiveHostReceive {
  return parseDeviceLiveHostReceive({ maxPayloadBytes: Math.min(limits.maxPayloadBytes, peer.maxPayloadBytes),
    maxPendingBytes: Math.min(limits.maxPendingBytes, peer.maxPendingBytes) });
}
export function parseDeviceLiveHostTransport(value: unknown): { readonly type: "liveHost.transport"; readonly version: 1; readonly receive: DeviceLiveHostReceive } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "receive,type,version" ||
    (value as Record<string, unknown>).type !== "liveHost.transport" || (value as Record<string, unknown>).version !== 1) {
    throw new TypeError("Invalid live host transport.");
  }
  return Object.freeze({ type: "liveHost.transport", version: 1, receive: parseDeviceLiveHostReceive((value as Record<string, unknown>).receive) });
}

export function parseDeviceLiveHostCredit(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "receivedBytes,type,version" ||
    (value as Record<string, unknown>).type !== "liveHost.credit" || (value as Record<string, unknown>).version !== 1) throw new TypeError("Invalid device credit.");
  const total = (value as Record<string, unknown>).receivedBytes;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) throw new TypeError("Invalid device credit.");
  return total;
}
