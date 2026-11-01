import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openSyncRelayStorage, type OpenSyncRelayStorageOptions, type SyncRelayStorage } from "./storage.js";
import type { SetServiceHostEnrollmentEnabledInput } from "./storage/serviceHostEnrollment.js";
import type { StorageContext } from "./storage/context.js";
import { prepareLiveDeliveryWorkspace, registerLiveDeliveryBaseline } from "./storage/liveDeliveryReservations.js";

export const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const scope = { kind: "named" as const, workspaceId: "workspace-1", shareId: "share-1", grantId: "edit-1", userId: "reader-1" };
export const host = { mode: "device", hostId: "host-1", hostEpoch: parseHostEpoch(1), instanceId: "instance-1", connectionId: "connection-1" } as const;
const bytes = new Uint8Array([0, 0]);
export const binding = { workspaceId: scope.workspaceId, mainVersionId: "main", objectId: "object-1",
  lineageClaimId: createHash("sha256").update(bytes).digest("hex"), currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 7 };
export const report = { connection: host, binding };
/** Stored metadata of a retained service activation of `binding`. Native activation is covered by the engine integration suite. */
export function retainServiceActivation(raw: InstanceType<typeof DatabaseSync>, namespace: string, completed = false): string {
  const activationId = `ordinary-activation-${"a".repeat(64)}`;
  const source = {version: 1, relayDatabaseNamespace: namespace, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: binding.objectId,
    lineageClaimId: binding.lineageClaimId, currentPath: binding.currentPath, replicationEpoch: "epoch", streamIdentity: "stream", committedCursor: 1,
    baseOriginId: "origin", baseOriginSeq: 0, baseRelaySeq: 1, sourceMomentId: "moment-1", sourceDigest: "b".repeat(64), sourceByteLength: 1,
    nativeHeadSequence: 0, fullStateDigest: binding.lineageClaimId, fullStateByteLength: 2};
  raw.prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
      source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,x'0000','owner-1',?,?,1)`)
    .run(namespace, activationId, scope.workspaceId, "main", binding.objectId, binding.lineageClaimId,
      JSON.stringify(source), JSON.stringify(binding), binding.lineageClaimId, scope.shareId, completed ? "{}" : null);
  return activationId;
}
/**
 * Stored records of the owner's restore of `binding` that ended its last Edit
 * grant at 30, after `retainServiceActivation`. The restore fenced generation
 * 8 and resumed, and the activation it continued retired at 40. Its native
 * evidence is covered by the restore suites. Returns the restore's row, for a
 * test to change.
 */
export function restoredWithoutEditGrant(storage: SyncRelayStorage, raw: InstanceType<typeof DatabaseSync>, namespace: string) {
  const activationId = `ordinary-activation-${"a".repeat(64)}`;
  if (!storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30}).ok) throw new Error("Missing Edit grant.");
  const document = {workspaceId: binding.workspaceId, mainVersionId: "main", objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
  const intent = {deliveryKind: "owner", operationId: "restore", ownerUserId: "owner-1", document, shareId: scope.shareId, grantId: scope.grantId,
    expectedGrantGeneration: 4, expectedDependentGrantIds: [], expectedFence: 7, restorePointCursor: 0, restorePointReceiptDigest: binding.lineageClaimId};
  const basis = {binding, ownerBinding: binding, baselineSequence: 1, namespace, ownerOrigin: JSON.stringify({adoptionId: activationId})};
  raw.prepare(`INSERT INTO sync_relay_live_restore_operations(operation_id,relay_database_namespace,previous_operation_id,workspace_id,main_version_id,object_id,
      lineage_claim_id,intent_json,basis_json,terminal_json,applied_json,native_receipt_json,phase,old_fence,new_fence,cutover_cursor,revoked_generation,
      invalidated_at_ms,fenced_at_ms,accounted_bytes) VALUES ('restore',?,NULL,?,'main',?,?,?,?,'{}','{}','{}','resumed',7,8,0,5,30,30,1)`)
    .run(namespace, binding.workspaceId, binding.objectId, binding.lineageClaimId, JSON.stringify(intent), JSON.stringify(basis));
  raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=8 WHERE workspace_id=? AND object_id=?").run(binding.workspaceId, binding.objectId);
  raw.prepare(`UPDATE sync_relay_service_activations SET retire_restore_generation=8,retired_at_ms=40,retired_boundary_json='{}',state_bytes=NULL
    WHERE activation_id=? AND retire_requested_at_ms=30`).run(activationId);
  return {activationId, update: (sql: string) => raw.prepare(`UPDATE sync_relay_live_restore_operations SET ${sql} WHERE operation_id='restore'`).run()};
}
/** The owner's next activation after `restoredWithoutEditGrant`, at the restored generation. */
export function retainSuccessorActivation(raw: InstanceType<typeof DatabaseSync>, completed: boolean): string {
  const activationId = `ordinary-activation-${"b".repeat(64)}`;
  raw.prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
      predecessor_activation_id,source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes)
    SELECT relay_database_namespace,?,workspace_id,main_version_id,object_id,lineage_claim_id,activation_id,source_json,?,state_digest,x'0000',owner_user_id,share_id,?,1
    FROM sync_relay_service_activations WHERE activation_id=?`)
    .run(activationId, JSON.stringify({...binding, restoreFenceGeneration: 8}), completed ? "{}" : null, `ordinary-activation-${"a".repeat(64)}`);
  return activationId;
}
/**
 * The owner's Stop as a running service host fences it once its engine
 * prepared the document's activation, for tests of what follows Stop. The
 * host's own preparation is tested in `serviceLiveHost.test.ts`.
 */
export function preparedStop(storage: SyncRelayStorage, input: SetServiceHostEnrollmentEnabledInput) {
  const objectId = input.objectId ?? storage.readServiceHostEnrollment(input.workspaceId, input.path)?.objectId;
  const candidate = objectId === undefined ? null : storage.retirableServiceActivation({workspaceId: input.workspaceId, objectId});
  return storage.setServiceHostEnrollmentEnabled({...input, ...(candidate ? {prepared: {...candidate, assertCurrent() {}}} : {})});
}
export const audience = "https://share.example.test";
export const key = new Uint8Array(32).fill(13);
export const table = "sync_relay_live_session_tickets";
export const marker = "live-session-tickets-v1";
const defaultScope = scope, defaultBinding = binding;
export async function fixture(options?: OpenSyncRelayStorageOptions, identity?: {userId: string; grantId: string; objectId: string; workspaceId?: string; shareId?: string}, population?: {people: number; documents: number}) {
  const scope = {...defaultScope, ...(identity ? {shareId: identity.shareId ?? defaultScope.shareId, userId: identity.userId, grantId: identity.grantId, workspaceId: identity.workspaceId ?? defaultScope.workspaceId} : {})};
  const binding = {...defaultBinding, ...(identity ? {objectId: identity.objectId, workspaceId: scope.workspaceId} : {})};
  const root = await mkdtemp(join(tmpdir(), "dohc-named-ticket-"));
  const path = join(root, "relay.sqlite");
  let time = 1000;
  const config = options ?? { liveTickets: { retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now: () => time } };
  const storage = openSyncRelayStorage(path, config);
  const raw = new DatabaseSync(path);
  try {
  raw.exec("PRAGMA foreign_keys=ON");
  // Synthetic authority rows test private ticket transactions, not Yjs registration.
  const context = storage as StorageContext;
  context.tx(() => {
    context.db.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)").run(scope.workspaceId, "owner-1", 0);
    prepareLiveDeliveryWorkspace(context, scope.workspaceId, host.hostId);
    for (let document = 1; document <= (population?.documents ?? 1); document++) {
      const current = population ? {...binding, objectId: "object-" + document, currentPath: `docs/${document}.md`} : binding;
      context.db.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
        VALUES (?, ?, ?, ?, 'main', ?, ?, 'text', 1, 1)`).run(scope.workspaceId, current.objectId, document, "moment-" + document, current.currentPath, "b".repeat(64));
      context.db.prepare(`INSERT INTO sync_relay_live_documents VALUES (?, 'main', ?, ?, NULL, ?, ?, ?, 1, ?, ?, 'current', 'open', 7, 0, NULL)`)
        .run(scope.workspaceId, current.objectId, current.lineageClaimId, current.currentPath, document, "b".repeat(64), current.lineageClaimId, bytes);
      registerLiveDeliveryBaseline(context, current, host.hostId);
    }
    context.db.prepare("INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms) VALUES (?, ?, 'owner-1', ?, 0)")
      .run(scope.shareId, scope.workspaceId, JSON.stringify({ paths: ["docs"], versionId: null }));
    for (let person = 1; person <= (population?.people ?? 1); person++) {
      context.db.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES (?, ?, 'user', ?, NULL, 'edit', 4, 'active', 0, NULL, NULL)`)
        .run(population ? "edit-" + person : scope.grantId, scope.shareId, population ? "reader-" + person : scope.userId);
    }
  });
  storage.provisionLiveHostControl({ ...host, updatedAtMs: 1, guard: () => undefined });
  storage.registerLiveHost({ ...host, updatedAtMs: 2, guard: () => undefined });
  } catch (error) {
    raw.close(); storage.close(); await rm(root, { recursive: true, force: true }); throw error;
  }
  return { storage, raw, path, config, setTime: (value: number) => { time = value; },
    async close() { raw.close(); storage.close(); await rm(root, { recursive: true, force: true }); } };
}
