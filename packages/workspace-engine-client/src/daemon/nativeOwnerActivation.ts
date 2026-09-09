import { createHash } from "node:crypto";

export interface NativeOwnerActivationSource {
  version: 1;
  relayDatabaseNamespace: string;
  workspaceId: string;
  mainVersionId: "main";
  objectId: string;
  lineageClaimId: string;
  currentPath: string;
  replicationEpoch: string;
  streamIdentity: string;
  committedCursor: number;
  baseOriginId: string;
  baseOriginSeq: number;
  baseRelaySeq: number;
  sourceMomentId: string;
  sourceDigest: string;
  sourceByteLength: number;
  nativeHeadSequence: number;
  fullStateDigest: string;
  fullStateByteLength: number;
}

export interface NativeOwnerActivation {
  activationId: string;
  sessionId: string;
  source: NativeOwnerActivationSource;
  baselineBytes: Buffer;
  fullState: Buffer;
}

const sourceKeys = ["version", "relayDatabaseNamespace", "workspaceId", "mainVersionId", "objectId",
  "lineageClaimId", "currentPath", "replicationEpoch", "streamIdentity", "committedCursor", "baseOriginId",
  "baseOriginSeq", "baseRelaySeq", "sourceMomentId", "sourceDigest", "sourceByteLength",
  "nativeHeadSequence", "fullStateDigest", "fullStateByteLength"].sort().join();
const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export function parseNativeOwnerActivationSource(value: unknown, path: string, maxBytes: number): NativeOwnerActivationSource {
  const invalid = (): never => { throw new TypeError("Invalid native owner activation source."); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== sourceKeys) return invalid();
  const source = value as NativeOwnerActivationSource;
  if (source.version !== 1 || source.mainVersionId !== "main" || source.currentPath !== path ||
      !isDigest(source.lineageClaimId) || !isDigest(source.sourceDigest) || !isDigest(source.fullStateDigest) ||
      !isInteger(source.committedCursor, 0) || !isInteger(source.baseOriginSeq, 0) ||
      !isInteger(source.baseRelaySeq, 0, source.committedCursor) || !isInteger(source.nativeHeadSequence, 0) ||
      !isInteger(source.sourceByteLength, 0, 2_097_152) || !isInteger(source.fullStateByteLength, 2, maxBytes)) return invalid();
  for (const value of [source.relayDatabaseNamespace, source.workspaceId, source.objectId, source.currentPath,
    source.replicationEpoch, source.streamIdentity, source.baseOriginId, source.sourceMomentId]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0")) return invalid();
  }
  return {...source};
}

export function parseNativeOwnerActivation(value: unknown, bytes: Buffer, path: string, maxBytes: number): NativeOwnerActivation {
  const invalid = (): never => { throw new TypeError("Invalid native owner activation."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "activationId,baselineByteLength,byteLength,digest,sessionId,source,status,streamId" ||
      row.status !== "captured" || typeof row.activationId !== "string" || !/^ordinary-activation-[a-f0-9]{64}$/.test(row.activationId) ||
      typeof row.sessionId !== "string" || row.sessionId.length < 1 || row.sessionId.length > 1024 ||
      !isInteger(row.streamId, 1) || row.byteLength !== bytes.length || bytes.length > maxBytes ||
      !isDigest(row.digest) || digest(bytes) !== row.digest || !isInteger(row.baselineByteLength, 2, bytes.length - 2)) return invalid();
  const source = parseNativeOwnerActivationSource(row.source, path, maxBytes);
  const baselineBytes = bytes.subarray(0, row.baselineByteLength), fullState = bytes.subarray(row.baselineByteLength);
  if (digest(baselineBytes) !== source.lineageClaimId || digest(fullState) !== source.fullStateDigest ||
      fullState.length !== source.fullStateByteLength) return invalid();
  return { activationId: row.activationId, sessionId: row.sessionId, source: { ...source }, baselineBytes, fullState };
}
