import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseHostControlIdentifier, parseHostEpoch, type HostEpoch } from "@dohc/live-session-contract/host-control";

export interface DeviceHostCredential {
  readonly version: 1;
  readonly hostId: string;
  readonly instanceId: string;
  readonly hostEpoch: HostEpoch;
  readonly secret: string;
}

export class DeviceHostCredentialRefused extends Error {
  constructor() { super("Device host credential refused."); }
}

export function parseDeviceHostCredential(value: unknown): DeviceHostCredential {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    const { version, hostId: suppliedHost, instanceId: suppliedInstance, hostEpoch: suppliedEpoch, secret } = record;
    if (Object.keys(record).sort().join(",") !== "hostEpoch,hostId,instanceId,secret,version" || version !== 1) throw new Error();
    const hostId = parseHostControlIdentifier(suppliedHost, "host ID");
    const instanceId = parseHostControlIdentifier(suppliedInstance, "instance ID");
    const hostEpoch = parseHostEpoch(suppliedEpoch);
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
      Buffer.from(secret, "base64url").toString("base64url") !== secret) throw new Error();
    return Object.freeze({ version: 1, hostId, instanceId, hostEpoch, secret });
  } catch { throw new DeviceHostCredentialRefused(); }
}

export function createDeviceHostCredential(hostId: string, hostEpoch: HostEpoch): DeviceHostCredential {
  return parseDeviceHostCredential({ version: 1, hostId, hostEpoch, instanceId: randomUUID(), secret: randomBytes(32).toString("base64url") });
}

export function deviceHostCredentialDigest(credential: DeviceHostCredential): string {
  const { version, hostId, instanceId, hostEpoch, secret } = parseDeviceHostCredential(credential);
  return createHash("sha256").update(JSON.stringify(["dohc-device-host-v1", version, hostId, instanceId, hostEpoch, secret])).digest("hex");
}

export function verifyDeviceHostCredentialDigest(credential: DeviceHostCredential, digest: unknown): void {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
    !timingSafeEqual(Buffer.from(deviceHostCredentialDigest(credential), "hex"), Buffer.from(digest, "hex"))) {
    throw new DeviceHostCredentialRefused();
  }
}
