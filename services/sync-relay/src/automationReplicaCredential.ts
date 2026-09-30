import {createHmac, timingSafeEqual} from "node:crypto";
import type {SyncRelayStorage} from "./storage";
import type {AutomationWorkspace} from "./storage/automationWorkspaces";
import {serviceHostReplicationRoute, type ServiceHostCredentialKey} from "./serviceHostCredential";

export const AUTOMATION_REPLICA_BEARER_PREFIX = "dohc-automation-v1.";

/**
 * The credential this server's automation replica of a workspace syncs with.
 * It is derived, never stored, under a label of its own, so it never verifies
 * as a service host credential. A new nonce or incarnation revokes it.
 */
export function deriveAutomationReplicaBearer(workspace: AutomationWorkspace, config: ServiceHostCredentialKey): string {
  if (config.key.byteLength < 32 || !config.namespace) throw new Error("Automation replica credential key is unavailable.");
  const input = JSON.stringify(["dohc-automation-replication-v1", config.namespace, workspace.workspaceId, workspace.ownerUserId,
    workspace.replicationEpoch, workspace.streamIdentity, workspace.incarnation, workspace.credentialNonce]);
  return `${AUTOMATION_REPLICA_BEARER_PREFIX}${createHmac("sha256", config.key).update(input).digest("base64url")}`;
}

/**
 * The workspace owner an automation replica credential acts for, or null.
 * It grants ordinary replication of its own workspace only, and only while
 * the server keeps that replica and the workspace's owner and identity are
 * the ones it was made for. A replica nothing needs any more, waiting to
 * leave, reads but writes nothing: a server handing over is still needed
 * until its release, so it keeps writing until then.
 */
export function authorizeAutomationReplication(storage: Pick<SyncRelayStorage, "currentAutomationWorkspace">, input: ServiceHostCredentialKey & {
  workspaceId: string; bearer: string; method: string; pathname: string;
}): string | null {
  if (!/^dohc-automation-v1\.[A-Za-z0-9_-]{43}$/.test(input.bearer) || !serviceHostReplicationRoute(input)) return null;
  const workspace = storage.currentAutomationWorkspace(input.workspaceId);
  if (workspace === null) return null;
  if (workspace.unwantedSinceMs !== null && input.method !== "GET") return null;
  const supplied = Buffer.from(input.bearer), expected = Buffer.from(deriveAutomationReplicaBearer(workspace, input));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? workspace.ownerUserId : null;
}
