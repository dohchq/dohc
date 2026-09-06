import { parseHostEpoch, type HostEpoch } from "./hostControl.js";
import {
  LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT,
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "./liveObjectBinding.js";
import {
  parseLiveUpdateIdentifier,
  parseServerDerivedLiveUpdateAuthority,
  type ServerDerivedLiveUpdateAuthority,
} from "./liveUpdateAdmission.js";

export const LIVE_TICKET_ENTROPY_BYTES = 32;
export const LIVE_TICKET_TOKEN_PATTERN = "^[0-9a-f]{64}$";
export const LIVE_TICKET_LIFETIME_MS = 30_000;

export interface LiveTicketClaims {
  readonly ticketId: string;
  readonly audience: string;
  readonly authority: Exclude<
    ServerDerivedLiveUpdateAuthority,
    { principalKind: "owner" }
  >;
  readonly binding: LiveObjectBinding;
  readonly hostEpoch: HostEpoch;
  readonly mintedAtMs: number;
  readonly expiresAtMs: number;
}

export type RedeemedLiveTicket = LiveTicketClaims & {
  readonly redeemedAtMs: number;
};

const CLAIM_FIELDS = [
  "ticketId", "audience", "authority", "binding", "hostEpoch",
  "mintedAtMs", "expiresAtMs",
] as const;
const AUTHORITY_FIELDS = [
  "principalKind", "principalId", "grantId", "grantGeneration",
] as const;
const BINDING_FIELDS = [
  "workspaceId", "mainVersionId", "objectId", "lineageClaimId",
  "currentPath", "selectorPaths", "restoreFenceGeneration",
] as const;

function snapshot(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
      throw new TypeError();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor)) throw new TypeError();
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    throw new TypeError("Live-ticket fields must be exact own data properties.");
  }
}

function snapshotSelectors(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT) {
      throw new TypeError();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw new TypeError();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new TypeError();
      result.push(descriptor.value);
    }
    return result;
  } catch {
    throw new TypeError("Live-ticket selectors must be a dense array of own data properties.");
  }
}

export function parseLiveTicketAudience(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 2_048 || /[\ud800-\udfff]/u.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    new TextEncoder().encode(value).byteLength > 2_048
  ) throw new TypeError("Live-ticket audience must be a canonical HTTP or HTTPS origin.");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError("Live-ticket audience must be a canonical HTTP or HTTPS origin."); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value) {
    throw new TypeError("Live-ticket audience must be a canonical HTTP or HTTPS origin.");
  }
  return value;
}

function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Live-ticket times must be non-negative safe integers.");
  }
  return value;
}

function claims(record: Record<string, unknown>): LiveTicketClaims {
  const rawAuthority = snapshot(record.authority, AUTHORITY_FIELDS);
  const rawBinding = snapshot(record.binding, BINDING_FIELDS);
  rawBinding.selectorPaths = snapshotSelectors(rawBinding.selectorPaths);
  const authority = parseServerDerivedLiveUpdateAuthority(rawAuthority);
  if (authority.principalKind === "owner") throw new TypeError("Owner authority cannot use a live ticket.");
  const mintedAtMs = time(record.mintedAtMs);
  const expiresAtMs = time(record.expiresAtMs);
  if (mintedAtMs > Number.MAX_SAFE_INTEGER - LIVE_TICKET_LIFETIME_MS || expiresAtMs !== mintedAtMs + LIVE_TICKET_LIFETIME_MS) {
    throw new TypeError("Live-ticket expiry must be exactly 30000 ms after issue.");
  }
  return {
    ticketId: parseLiveUpdateIdentifier(record.ticketId, "ticketId"),
    audience: parseLiveTicketAudience(record.audience),
    authority,
    binding: parseLiveObjectBinding(rawBinding),
    hostEpoch: parseHostEpoch(record.hostEpoch),
    mintedAtMs,
    expiresAtMs,
  };
}

export function parseLiveTicketClaims(value: unknown): LiveTicketClaims {
  return claims(snapshot(value, CLAIM_FIELDS));
}

export function parseRedeemedLiveTicket(value: unknown): RedeemedLiveTicket {
  const record = snapshot(value, [...CLAIM_FIELDS, "redeemedAtMs"]);
  const parsed = claims(record);
  const redeemedAtMs = time(record.redeemedAtMs);
  if (redeemedAtMs < parsed.mintedAtMs || redeemedAtMs >= parsed.expiresAtMs) {
    throw new TypeError("Live-ticket redemption must occur within its issue and expiry interval.");
  }
  return { ...parsed, redeemedAtMs };
}

export function parseLiveTicketToken(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("Live-ticket token must be 64 lowercase hexadecimal characters.");
  }
  const bytes = new Uint8Array(LIVE_TICKET_ENTROPY_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
