import { randomBytes } from "node:crypto";
import { AUTOMATION_SERVER_INSTALL_ID } from "@dohc/workspace-contracts/relay";
import type { StorageContext } from "./context";
import { getWorkspaceIdentity } from "./workspaces";
import type { SqliteDb } from "./types";

// The workspaces this server keeps a replica of to run their automations.
// Each row holds the workspace's sync identity and owner when the replica
// was made, the nonce its replication credential derives from, and the
// replica's incarnation, which rises when a changed identity forces a new
// replica. `started_at_ms` is when that incarnation began: its schedules
// start after it. A workspace no condition needs any more is `unwanted`
// from then; one that stayed unwanted long enough has `left`, and its
// credential stops working.
export function initializeAutomationWorkspaceSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_automation_workspaces (
      workspace_id TEXT NOT NULL PRIMARY KEY
        REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 256),
      replication_epoch TEXT NOT NULL,
      stream_identity TEXT NOT NULL,
      credential_nonce TEXT NOT NULL CHECK (length(credential_nonce) = 64),
      incarnation INTEGER NOT NULL CHECK (incarnation BETWEEN 1 AND 9007199254740991),
      started_at_ms INTEGER NOT NULL CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
      unwanted_since_ms INTEGER CHECK (unwanted_since_ms IS NULL OR unwanted_since_ms BETWEEN 0 AND 9007199254740991),
      left_at_ms INTEGER CHECK (left_at_ms IS NULL OR left_at_ms BETWEEN 0 AND 9007199254740991)
    ) STRICT;
  `);
}

export interface AutomationWorkspace {
  workspaceId: string;
  ownerUserId: string;
  replicationEpoch: string;
  streamIdentity: string;
  credentialNonce: string;
  incarnation: number;
  startedAtMs: number;
  unwantedSinceMs: number | null;
  leftAtMs: number | null;
}

// A replica leaves this long after no condition needs it, so a handover
// that moves back and forth does not reopen it each time.
export const AUTOMATION_WORKSPACE_LEAVE_AFTER_MS = 24 * 60 * 60 * 1000;
// A replica that left stays on disk this long, for Undo and run history.
export const AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS = 30 * 24 * 60 * 60 * 1000;

function rowOf(row: Record<string, unknown>): AutomationWorkspace {
  return {
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
    replicationEpoch: String(row.replication_epoch),
    streamIdentity: String(row.stream_identity),
    credentialNonce: String(row.credential_nonce),
    incarnation: Number(row.incarnation),
    startedAtMs: Number(row.started_at_ms),
    unwantedSinceMs: row.unwanted_since_ms === null ? null : Number(row.unwanted_since_ms),
    leftAtMs: row.left_at_ms === null ? null : Number(row.left_at_ms),
  };
}

function read(storage: StorageContext, workspaceId: string): AutomationWorkspace | null {
  const row = storage.db.prepare("SELECT * FROM sync_relay_automation_workspaces WHERE workspace_id = ?").get(workspaceId);
  return row ? rowOf(row) : null;
}

function ownerOf(storage: StorageContext, workspaceId: string): string | null {
  const row = storage.db.prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?").get(workspaceId);
  return row ? String(row.owner_user_id) : null;
}

/**
 * The server needs a replica of this workspace now. Returns its row, joined
 * or rejoined, or null while the workspace has no sync identity to join.
 * When the owner or the identity changed since the replica was made, as
 * after a restore, the replica is obsolete: the row moves to the next
 * incarnation with a new credential, and in the same transaction the
 * presses the server accepted end, since the new replica has no claim for
 * them and would run them again, and the new incarnation starts now.
 */
export function joinAutomationWorkspace(storage: StorageContext, input: { workspaceId: string; nowMs: number }): AutomationWorkspace | null {
  return storage.tx(() => {
    const { workspaceId, nowMs } = input;
    const ownerUserId = ownerOf(storage, workspaceId);
    const identity = getWorkspaceIdentity(storage, workspaceId);
    if (ownerUserId === null || identity === null) return null;
    const current = read(storage, workspaceId);
    const same = current !== null && current.ownerUserId === ownerUserId &&
      current.replicationEpoch === identity.replicationEpoch && current.streamIdentity === identity.streamIdentity;
    if (same) {
      // Only a change counts as a relay write, which wakes the replicas again.
      if (current.unwantedSinceMs === null && current.leftAtMs === null) return current;
      storage.db.prepare(
        "UPDATE sync_relay_automation_workspaces SET unwanted_since_ms = NULL, left_at_ms = NULL WHERE workspace_id = ?",
      ).run(workspaceId);
      return read(storage, workspaceId);
    }
    if (current !== null) {
      storage.db.prepare(
        `UPDATE sync_relay_automation_presses SET state = 'settled', accepted_by = NULL, outcome = 'ended', error = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND state = 'accepted' AND accepted_by = ?`,
      ).run(REPLICA_REPLACED, nowMs, workspaceId, AUTOMATION_SERVER_INSTALL_ID);
    }
    storage.db.prepare(
      `INSERT INTO sync_relay_automation_workspaces
         (workspace_id, owner_user_id, replication_epoch, stream_identity, credential_nonce, incarnation, started_at_ms, unwanted_since_ms, left_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(workspace_id) DO UPDATE SET
         owner_user_id = excluded.owner_user_id, replication_epoch = excluded.replication_epoch,
         stream_identity = excluded.stream_identity, credential_nonce = excluded.credential_nonce,
         incarnation = excluded.incarnation, started_at_ms = excluded.started_at_ms,
         unwanted_since_ms = NULL, left_at_ms = NULL`,
    ).run(
      workspaceId, ownerUserId, identity.replicationEpoch, identity.streamIdentity,
      randomBytes(32).toString("hex"), (current?.incarnation ?? 0) + 1, nowMs,
    );
    return read(storage, workspaceId);
  });
}

const REPLICA_REPLACED = "This server rebuilt its copy of the workspace before this press ran. Press it again.";

/**
 * No condition needs the replica now. Returns the row once it has been
 * unwanted for AUTOMATION_WORKSPACE_LEAVE_AFTER_MS, marked as left, or
 * null while it waits.
 */
export function unwantAutomationWorkspace(storage: StorageContext, input: { workspaceId: string; nowMs: number }): AutomationWorkspace | null {
  return storage.tx(() => {
    const current = read(storage, input.workspaceId);
    if (current === null || current.leftAtMs !== null) return null;
    if (current.unwantedSinceMs === null) {
      storage.db.prepare("UPDATE sync_relay_automation_workspaces SET unwanted_since_ms = ? WHERE workspace_id = ?")
        .run(input.nowMs, input.workspaceId);
      return null;
    }
    if (input.nowMs - current.unwantedSinceMs < AUTOMATION_WORKSPACE_LEAVE_AFTER_MS) return null;
    storage.db.prepare("UPDATE sync_relay_automation_workspaces SET left_at_ms = ? WHERE workspace_id = ?")
      .run(input.nowMs, input.workspaceId);
    return read(storage, input.workspaceId);
  });
}

/** Every replica row, joined or left. */
export function listAutomationWorkspaces(storage: StorageContext): AutomationWorkspace[] {
  return storage.readTx(() => storage.db.prepare("SELECT * FROM sync_relay_automation_workspaces ORDER BY workspace_id").all().map(rowOf));
}

/** Every replica row goes: the server no longer runs automations, so it keeps no copies. */
export function forgetAutomationWorkspaces(storage: StorageContext): void {
  storage.tx(() => {
    storage.db.prepare("DELETE FROM sync_relay_automation_workspaces").run();
  });
}

/** A left replica kept past AUTOMATION_WORKSPACE_KEEP_AFTER_LEAVING_MS goes, with its row. */
export function forgetAutomationWorkspace(storage: StorageContext, input: { workspaceId: string; incarnation: number }): void {
  storage.tx(() => {
    storage.db.prepare(
      "DELETE FROM sync_relay_automation_workspaces WHERE workspace_id = ? AND incarnation = ? AND left_at_ms IS NOT NULL",
    ).run(input.workspaceId, input.incarnation);
  });
}

/**
 * The row whose credential may replicate now: joined, not left, and still
 * the workspace's owner and identity. Null otherwise. One statement, so the
 * replication route can ask again inside its write transaction.
 */
export function currentAutomationWorkspace(storage: StorageContext, workspaceId: string): AutomationWorkspace | null {
  storage.captureStanding();
  const row = storage.db.prepare(
    `SELECT a.* FROM sync_relay_automation_workspaces a JOIN sync_relay_workspaces w USING (workspace_id)
     WHERE a.workspace_id = ? AND a.left_at_ms IS NULL AND a.owner_user_id = w.owner_user_id
       AND a.replication_epoch = w.replication_epoch AND a.stream_identity = w.stream_identity`,
  ).get(workspaceId);
  return row ? rowOf(row) : null;
}

/** The workspace's latest relay sequence, 0 before any: a replica behind it pulls. */
export function automationWorkspaceLogHead(storage: StorageContext, workspaceId: string): number {
  return storage.readTx(() => Number(storage.db.prepare(
    "SELECT COALESCE(MAX(relay_seq), 0) AS head FROM sync_relay_log WHERE workspace_id = ?",
  ).get(workspaceId)?.head ?? 0));
}

/** The workspaces whose automation host record names the server, running or handing over. */
export function serverHostedWorkspaces(storage: StorageContext): string[] {
  return storage.readTx(() => storage.db.prepare(
    `SELECT workspace_id FROM sync_relay_automation_hosts WHERE install_id = ? OR handover_from = ? ORDER BY workspace_id`,
  ).all(AUTOMATION_SERVER_INSTALL_ID, AUTOMATION_SERVER_INSTALL_ID).map((row) => String(row.workspace_id)));
}
