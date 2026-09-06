import { parseHostEpoch, type HostEpoch } from "./hostControl.js";
import {
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "./liveObjectBinding.js";

export const LIVE_UPDATE_IDENTIFIER_MAX_BYTES = 512;
export const LIVE_UPDATE_SHA256_HEX_LENGTH = 64;
export const LIVE_UPDATE_YJS_CLIENT_ID_MAX = 9_007_199_254_740_991;
export const LIVE_UPDATE_YJS_START_CLOCK_MAX = 4_294_967_294;
export const LIVE_UPDATE_YJS_END_CLOCK_MAX = 4_294_967_295;

export const LIVE_UPDATE_REFUSAL_VALUES = [
  "invalid-update",
  "authority-refused",
  "stale-session",
  "stale-binding",
  "restore-fenced",
  "provenance-refused",
  "baseline-missing",
  "delivery-conflict",
  "capacity-refused",
] as const;

export const LIVE_UPDATE_RETRY_VALUES = [
  "admission-unavailable",
  "host-unavailable",
  "application-pending",
] as const;

export interface LiveDocumentKey {
  readonly workspaceId: string;
  readonly mainVersionId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
}

export type ServerDerivedLiveUpdateAuthority =
  | {
      readonly principalKind: "owner";
      readonly principalId: string;
      readonly grantId: null;
      readonly grantGeneration: null;
    }
  | {
      readonly principalKind: "named" | "link";
      readonly principalId: string;
      readonly grantId: string;
      readonly grantGeneration: number;
    };

export interface LiveUpdateSubmissionMetadata {
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly binding: LiveObjectBinding;
}

export interface LiveUpdateSubmission {
  readonly metadata: LiveUpdateSubmissionMetadata;
  readonly updateBytes: Uint8Array;
}

export interface LiveUpdateReceipt {
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly journalCursor: number;
  readonly acceptingHostEpoch: HostEpoch;
}

export interface RelayAcceptedLiveUpdate {
  readonly receipt: LiveUpdateReceipt;
  readonly binding: LiveObjectBinding;
  readonly authority: ServerDerivedLiveUpdateAuthority;
  readonly receivedAtMs: number;
}

export interface LiveUpdateStructRange {
  readonly clientId: number;
  readonly startClock: number;
  readonly endClock: number;
}

export interface AdmittedLiveUpdateMetadata {
  readonly accepted: RelayAcceptedLiveUpdate;
  readonly firstSeen: readonly LiveUpdateStructRange[];
}

export interface AdmittedLiveUpdate {
  readonly metadata: AdmittedLiveUpdateMetadata;
  readonly updateBytes: Uint8Array;
}

export type LiveUpdateHostApplicationAck = LiveUpdateReceipt & {
  readonly localYDocSequence: number;
  readonly applicationReplayed: boolean;
};

export type LiveUpdateRefusal = (typeof LIVE_UPDATE_REFUSAL_VALUES)[number];
export type LiveUpdateRetry = (typeof LIVE_UPDATE_RETRY_VALUES)[number];

export type LiveUpdateAcceptResult =
  | {
      readonly kind: "accepted";
      readonly receipt: LiveUpdateReceipt;
      readonly replayed: boolean;
    }
  | { readonly kind: "refused"; readonly reason: LiveUpdateRefusal }
  | { readonly kind: "retry"; readonly reason: LiveUpdateRetry };

const DOCUMENT_KEY_FIELDS = [
  "workspaceId",
  "mainVersionId",
  "objectId",
  "lineageClaimId",
] as const;
const AUTHORITY_FIELDS = [
  "principalKind",
  "principalId",
  "grantId",
  "grantGeneration",
] as const;
const SUBMISSION_METADATA_FIELDS = [
  "deliveryId",
  "updateDigest",
  "binding",
] as const;
const RECEIPT_FIELDS = [
  "deliveryId",
  "updateDigest",
  "journalCursor",
  "acceptingHostEpoch",
] as const;
const ACCEPTED_FIELDS = [
  "receipt",
  "binding",
  "authority",
  "receivedAtMs",
] as const;
const STRUCT_RANGE_FIELDS = ["clientId", "startClock", "endClock"] as const;
const ADMITTED_METADATA_FIELDS = ["accepted", "firstSeen"] as const;
const APPLICATION_ACK_FIELDS = [
  ...RECEIPT_FIELDS,
  "localYDocSequence",
  "applicationReplayed",
] as const;

function exactRecord(
  value: unknown,
  name: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  ) {
    throw new TypeError(`${name} must contain exactly its defined fields.`);
  }
  return record;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function nonEmptyUpdateBytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new TypeError(`${name} must be a non-empty Uint8Array.`);
  }
  return value;
}

export function parseLiveUpdateIdentifier(
  value: unknown,
  name = "live-update identifier",
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new TypeError(`${name} must contain well-formed UTF-16.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must not contain ASCII control characters.`);
  }
  if (new TextEncoder().encode(value).byteLength > LIVE_UPDATE_IDENTIFIER_MAX_BYTES) {
    throw new TypeError(`${name} must be at most 512 UTF-8 bytes.`);
  }
  return value;
}

export function parseLiveUpdateDigest(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== LIVE_UPDATE_SHA256_HEX_LENGTH ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new TypeError("update digest must be 64 lowercase hexadecimal characters.");
  }
  return value;
}

export function parseLiveDocumentKey(value: unknown): LiveDocumentKey {
  const record = exactRecord(value, "LiveDocumentKey", DOCUMENT_KEY_FIELDS);
  return {
    workspaceId: parseLiveUpdateIdentifier(record.workspaceId, "workspaceId"),
    mainVersionId: parseLiveUpdateIdentifier(record.mainVersionId, "mainVersionId"),
    objectId: parseLiveUpdateIdentifier(record.objectId, "objectId"),
    lineageClaimId: parseLiveUpdateIdentifier(record.lineageClaimId, "lineageClaimId"),
  };
}

export function parseServerDerivedLiveUpdateAuthority(
  value: unknown,
): ServerDerivedLiveUpdateAuthority {
  const record = exactRecord(
    value,
    "ServerDerivedLiveUpdateAuthority",
    AUTHORITY_FIELDS,
  );
  const principalKind = record.principalKind;
  const principalId = parseLiveUpdateIdentifier(record.principalId, "principalId");
  if (principalKind === "owner") {
    if (record.grantId !== null || record.grantGeneration !== null) {
      throw new TypeError("owner authority must not contain a grant.");
    }
    return {
      principalKind: "owner",
      principalId,
      grantId: null,
      grantGeneration: null,
    };
  }
  if (principalKind !== "named" && principalKind !== "link") {
    throw new TypeError("principalKind must be owner, named, or link.");
  }
  return {
    principalKind,
    principalId,
    grantId: parseLiveUpdateIdentifier(record.grantId, "grantId"),
    grantGeneration: positiveSafeInteger(record.grantGeneration, "grantGeneration"),
  };
}

export function parseLiveUpdateSubmissionMetadata(
  value: unknown,
): LiveUpdateSubmissionMetadata {
  const record = exactRecord(
    value,
    "LiveUpdateSubmissionMetadata",
    SUBMISSION_METADATA_FIELDS,
  );
  return {
    deliveryId: parseLiveUpdateIdentifier(record.deliveryId, "deliveryId"),
    updateDigest: parseLiveUpdateDigest(record.updateDigest),
    binding: parseLiveObjectBinding(record.binding),
  };
}

export function parseLiveUpdateSubmission(
  metadata: unknown,
  updateBytes: unknown,
): LiveUpdateSubmission {
  return {
    metadata: parseLiveUpdateSubmissionMetadata(metadata),
    updateBytes: nonEmptyUpdateBytes(updateBytes, "updateBytes"),
  };
}

function parseReceiptFields(record: Record<string, unknown>): LiveUpdateReceipt {
  let acceptingHostEpoch: HostEpoch;
  try {
    acceptingHostEpoch = parseHostEpoch(record.acceptingHostEpoch);
  } catch {
    throw new TypeError("acceptingHostEpoch must be a positive safe integer.");
  }
  return {
    deliveryId: parseLiveUpdateIdentifier(record.deliveryId, "deliveryId"),
    updateDigest: parseLiveUpdateDigest(record.updateDigest),
    journalCursor: positiveSafeInteger(record.journalCursor, "journalCursor"),
    acceptingHostEpoch,
  };
}

export function parseLiveUpdateReceipt(value: unknown): LiveUpdateReceipt {
  return parseReceiptFields(exactRecord(value, "LiveUpdateReceipt", RECEIPT_FIELDS));
}

export function parseRelayAcceptedLiveUpdate(
  value: unknown,
): RelayAcceptedLiveUpdate {
  const record = exactRecord(value, "RelayAcceptedLiveUpdate", ACCEPTED_FIELDS);
  return {
    receipt: parseLiveUpdateReceipt(record.receipt),
    binding: parseLiveObjectBinding(record.binding),
    authority: parseServerDerivedLiveUpdateAuthority(record.authority),
    receivedAtMs: nonNegativeSafeInteger(record.receivedAtMs, "receivedAtMs"),
  };
}

export function parseLiveUpdateStructRange(value: unknown): LiveUpdateStructRange {
  const record = exactRecord(value, "LiveUpdateStructRange", STRUCT_RANGE_FIELDS);
  const clientId = boundedInteger(
    record.clientId,
    "clientId",
    0,
    LIVE_UPDATE_YJS_CLIENT_ID_MAX,
  );
  const startClock = boundedInteger(
    record.startClock,
    "startClock",
    0,
    LIVE_UPDATE_YJS_START_CLOCK_MAX,
  );
  const endClock = boundedInteger(
    record.endClock,
    "endClock",
    1,
    LIVE_UPDATE_YJS_END_CLOCK_MAX,
  );
  if (startClock >= endClock) {
    throw new TypeError("startClock must be smaller than endClock.");
  }
  return { clientId, startClock, endClock };
}

export function parseLiveUpdateStructRanges(
  value: unknown,
): readonly LiveUpdateStructRange[] {
  if (!Array.isArray(value)) {
    throw new TypeError("firstSeen must be an array.");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("firstSeen must be dense.");
    }
  }
  const sorted = Array.from(value, parseLiveUpdateStructRange).sort(
    (left, right) =>
      left.clientId - right.clientId || left.startClock - right.startClock,
  );
  const merged: LiveUpdateStructRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.clientId === range.clientId &&
      range.startClock <= previous.endClock
    ) {
      merged[merged.length - 1] = {
        clientId: previous.clientId,
        startClock: previous.startClock,
        endClock: Math.max(previous.endClock, range.endClock),
      };
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function parseAdmittedLiveUpdateMetadata(
  value: unknown,
): AdmittedLiveUpdateMetadata {
  const record = exactRecord(
    value,
    "AdmittedLiveUpdateMetadata",
    ADMITTED_METADATA_FIELDS,
  );
  return {
    accepted: parseRelayAcceptedLiveUpdate(record.accepted),
    firstSeen: parseLiveUpdateStructRanges(record.firstSeen),
  };
}

export function parseAdmittedLiveUpdate(
  metadata: unknown,
  updateBytes: unknown,
): AdmittedLiveUpdate {
  return {
    metadata: parseAdmittedLiveUpdateMetadata(metadata),
    updateBytes: nonEmptyUpdateBytes(updateBytes, "updateBytes"),
  };
}

export function parseLiveUpdateHostApplicationAck(
  value: unknown,
): LiveUpdateHostApplicationAck {
  const record = exactRecord(
    value,
    "LiveUpdateHostApplicationAck",
    APPLICATION_ACK_FIELDS,
  );
  const applicationReplayed = record.applicationReplayed;
  if (typeof applicationReplayed !== "boolean") {
    throw new TypeError("applicationReplayed must be a boolean.");
  }
  return {
    ...parseReceiptFields(record),
    localYDocSequence: positiveSafeInteger(
      record.localYDocSequence,
      "localYDocSequence",
    ),
    applicationReplayed,
  };
}

export function parseLiveUpdateRefusal(value: unknown): LiveUpdateRefusal {
  if (!(LIVE_UPDATE_REFUSAL_VALUES as readonly unknown[]).includes(value)) {
    throw new TypeError("reason is not a live-update refusal.");
  }
  return value as LiveUpdateRefusal;
}

export function parseLiveUpdateRetry(value: unknown): LiveUpdateRetry {
  if (!(LIVE_UPDATE_RETRY_VALUES as readonly unknown[]).includes(value)) {
    throw new TypeError("reason is not a live-update retry.");
  }
  return value as LiveUpdateRetry;
}

export function parseLiveUpdateAcceptResult(value: unknown): LiveUpdateAcceptResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("LiveUpdateAcceptResult must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "accepted") {
    const record = exactRecord(
      value,
      "LiveUpdateAcceptResult",
      ["kind", "receipt", "replayed"],
    );
    const replayed = record.replayed;
    if (typeof replayed !== "boolean") {
      throw new TypeError("replayed must be a boolean.");
    }
    return {
      kind: "accepted",
      receipt: parseLiveUpdateReceipt(record.receipt),
      replayed,
    };
  }
  if (candidate.kind === "refused") {
    const record = exactRecord(value, "LiveUpdateAcceptResult", ["kind", "reason"]);
    return { kind: "refused", reason: parseLiveUpdateRefusal(record.reason) };
  }
  if (candidate.kind === "retry") {
    const record = exactRecord(value, "LiveUpdateAcceptResult", ["kind", "reason"]);
    return { kind: "retry", reason: parseLiveUpdateRetry(record.reason) };
  }
  throw new TypeError("kind is not a live-update result kind.");
}
