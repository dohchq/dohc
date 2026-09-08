import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { openSyncRelayStorage, type OpenSyncRelayStorageOptions } from "./storage.js";
import type { StorageContext } from "./storage/context.js";
import { prepareLiveDeliveryWorkspace, registerLiveDeliveryBaseline } from "./storage/liveDeliveryReservations.js";

export const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const scope = { workspaceId: "workspace-1", shareId: "share-1", grantId: "edit-1", userId: "reader-1" };
export const host = { mode: "device", hostId: "host-1", hostEpoch: parseHostEpoch(1), instanceId: "instance-1", connectionId: "connection-1" } as const;
const bytes = new Uint8Array([0, 0]);
export const binding = { workspaceId: scope.workspaceId, mainVersionId: "main", objectId: "object-1",
  lineageClaimId: createHash("sha256").update(bytes).digest("hex"), currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 7 };
export const report = { connection: host, binding };
export const audience = "https://share.example.test";
export const key = new Uint8Array(32).fill(13);
export const table = "sync_relay_live_session_tickets";
export const marker = "live-session-tickets-v1";
export async function fixture(options?: OpenSyncRelayStorageOptions) {
  const root = await mkdtemp(join(tmpdir(), "dohc-named-ticket-"));
  const path = join(root, "relay.sqlite");
  let time = 1000;
  const config = options ?? { liveTickets: { retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1, now: () => time } };
  const storage = openSyncRelayStorage(path, config);
  const raw = new DatabaseSync(path);
  try {
  raw.exec("PRAGMA foreign_keys=ON");
  // Synthetic authority rows test private ticket transactions, not Yjs registration.
  raw.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, ?)").run(scope.workspaceId, "owner-1", 0);
  raw.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
    VALUES (?, ?, 1, 'moment-1', 'main', 'docs/a.md', ?, 'text', 1, 1)`).run(scope.workspaceId, binding.objectId, "b".repeat(64));
  const context = storage as StorageContext;
  context.tx(() => {
    prepareLiveDeliveryWorkspace(context, scope.workspaceId, host.hostId);
    context.db.prepare(`INSERT INTO sync_relay_live_documents VALUES (?, 'main', ?, ?, NULL, 'docs/a.md', 1, ?, 1, ?, ?, 'current', 'open', 7, 0, NULL)`)
      .run(scope.workspaceId, binding.objectId, binding.lineageClaimId, "b".repeat(64), binding.lineageClaimId, bytes);
    registerLiveDeliveryBaseline(context, binding, host.hostId);
  });
  raw.prepare("INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms) VALUES (?, ?, 'owner-1', ?, 0)")
    .run(scope.shareId, scope.workspaceId, JSON.stringify({ paths: ["docs"], versionId: null }));
  raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES (?, ?, 'user', ?, NULL, 'edit', 4, 'active', 0, NULL, NULL)`).run(scope.grantId, scope.shareId, scope.userId);
  storage.provisionLiveHostControl({ ...host, updatedAtMs: 1, guard: () => undefined });
  storage.registerLiveHost({ ...host, updatedAtMs: 2, guard: () => undefined });
  } catch (error) {
    raw.close(); storage.close(); await rm(root, { recursive: true, force: true }); throw error;
  }
  return { storage, raw, path, config, setTime: (value: number) => { time = value; },
    async close() { raw.close(); storage.close(); await rm(root, { recursive: true, force: true }); } };
}
