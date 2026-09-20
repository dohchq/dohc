import {createHmac, timingSafeEqual} from "node:crypto";
import type {SyncRelayStorage} from "./storage";
import type {ServiceHostEnrollment} from "./storage/serviceHostEnrollment";

export interface ServiceHostCredentialKey {key: Uint8Array; namespace: string}
export function deriveServiceHostBearer(enrollment: ServiceHostEnrollment, config: ServiceHostCredentialKey): string {
  if (config.key.byteLength < 32 || !config.namespace) throw new Error("Service host credential key is unavailable.");
  const input = JSON.stringify(["dohc-service-replication-v1", config.namespace, enrollment.workspaceId, enrollment.objectId,
    enrollment.ownerUserId, enrollment.replicationEpoch, enrollment.streamIdentity, enrollment.credentialNonce]);
  return `dohc-service-v1.${createHmac("sha256", config.key).update(input).digest("base64url")}`;
}

export function serviceHostReplicationRoute(input: {workspaceId: string; method: string; pathname: string}): boolean {
  let parts: string[];
  try {parts = input.pathname.split("/").slice(1).map(decodeURIComponent);} catch {return false;}
  if (parts[0] !== "sync" || parts[1] !== input.workspaceId) return false;
  const suffix = parts.slice(2);
  if (suffix.length === 1) return (suffix[0] === "bootstrap" && input.method === "GET") ||
    (suffix[0] === "log" && (input.method === "GET" || input.method === "POST"));
  if (suffix.length === 2 && suffix[0] === "blobs") return suffix[1] === "have" ? input.method === "POST" :
    /^[0-9a-f]{64}$/.test(suffix[1]!) && (input.method === "GET" || input.method === "PUT");
  return suffix.length === 3 && suffix[0] === "log" && !!suffix[1] && !/[\u0000-\u001f\u007f]/.test(suffix[1]) &&
    /^\d+$/.test(suffix[2]!) && Number.isSafeInteger(Number(suffix[2])) && input.method === "GET";
}

/** A service token grants ordinary replication only, never account or share administration. */
export function authorizeServiceHostReplication(storage: SyncRelayStorage, input: ServiceHostCredentialKey & {
  workspaceId: string; bearer: string; method: string; pathname: string;
}): string | null {
  if (!/^dohc-service-v1\.[A-Za-z0-9_-]{43}$/.test(input.bearer) || !serviceHostReplicationRoute(input)) return null;
  const supplied = Buffer.from(input.bearer);
  for (const enrollment of storage.listCurrentServiceHostEnrollments(input.workspaceId)) {
    const expected = Buffer.from(deriveServiceHostBearer(enrollment, input));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return enrollment.ownerUserId;
  }
  return null;
}
