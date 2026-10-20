import {createHmac, timingSafeEqual} from "node:crypto";
import type {SyncRelayStorage} from "./storage";
import type {ServiceHostWorkspace} from "./storage/serviceHostEnrollment";

export interface ServiceHostCredentialKey {key: Uint8Array; namespace: string}
/**
 * The credential the service host replicates a workspace with. It belongs to
 * the workspace, so documents can join and leave without replacing it.
 */
export function deriveServiceHostBearer(workspace: ServiceHostWorkspace, config: ServiceHostCredentialKey): string {
  if (config.key.byteLength < 32 || !config.namespace) throw new Error("Service host credential key is unavailable.");
  const input = JSON.stringify(["dohc-service-replication-v2", config.namespace, workspace.workspaceId,
    workspace.ownerUserId, workspace.replicationEpoch, workspace.streamIdentity]);
  return `dohc-service-v1.${createHmac("sha256", config.key).update(input).digest("base64url")}`;
}

type RouteInput = {workspaceId: string; method: string; pathname: string};
// The decoded route under `/sync/:workspaceId/`, or null for another workspace.
function workspaceRoute(input: RouteInput): string[] | null {
  let parts: string[];
  try {parts = input.pathname.split("/").slice(1).map(decodeURIComponent);} catch {return null;}
  return parts[0] === "sync" && parts[1] === input.workspaceId ? parts.slice(2) : null;
}
function replicationShape(suffix: readonly string[], method: string): boolean {
  if (suffix.length === 1) return (suffix[0] === "bootstrap" && method === "GET") ||
    (suffix[0] === "log" && (method === "GET" || method === "POST"));
  if (suffix.length === 2 && suffix[0] === "blobs") return suffix[1] === "have" ? method === "POST" :
    /^[0-9a-f]{64}$/.test(suffix[1]!) && (method === "GET" || method === "PUT");
  return suffix.length === 3 && suffix[0] === "log" && !!suffix[1] && !/[\u0000-\u001f\u007f]/.test(suffix[1]) &&
    /^\d+$/.test(suffix[2]!) && Number.isSafeInteger(Number(suffix[2])) && method === "GET";
}

export function serviceHostReplicationRoute(input: RouteInput): boolean {
  const suffix = workspaceRoute(input);
  return suffix !== null && replicationShape(suffix, input.method);
}

/**
 * The same replication routes, under `/sync/:workspaceId/hosted/`: the service
 * host's scoped feed. Only the service host asks for a document's first live
 * base, so that route is here and never among the shapes other credentials share.
 */
export function serviceHostFeedRoute(input: RouteInput): boolean {
  const suffix = workspaceRoute(input);
  if (suffix?.[0] !== "hosted" || input.pathname.split("/")[3] !== "hosted") return false;
  return (suffix.length === 2 && suffix[1] === "first-open" && input.method === "POST") || replicationShape(suffix.slice(1), input.method);
}

/**
 * A service token grants the scoped feed only: never the workspace's ordinary
 * replication, account or share administration. It stays valid while the
 * current identity has an undrained enrollment, including one retired by Stop.
 */
export function authorizeServiceHostReplication(storage: SyncRelayStorage, input: ServiceHostCredentialKey & {
  workspaceId: string; bearer: string; method: string; pathname: string;
}): string | null {
  if (!/^dohc-service-v1\.[A-Za-z0-9_-]{43}$/.test(input.bearer) || !serviceHostFeedRoute(input)) return null;
  const workspace = storage.currentServiceHostWorkspace(input.workspaceId, true);
  if (!workspace) return null;
  const supplied = Buffer.from(input.bearer), expected = Buffer.from(deriveServiceHostBearer(workspace, input));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? workspace.ownerUserId : null;
}
