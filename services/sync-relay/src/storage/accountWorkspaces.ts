import { endCopyReasonInTransaction } from "./automationWorkspaces";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

// "Show on phone" is on for every workspace until its owner turns it off, so
// only the workspaces an owner hid have a row. The row names the owner, so a
// workspace that changes owner shows on the new owner's phone.
export function initializeAccountWorkspaceSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_phone_hidden_workspaces (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 256),
      PRIMARY KEY (workspace_id, owner_user_id)
    ) STRICT;
  `);
}

/** One workspace as its owner's account lists it. */
export interface AccountWorkspace {
  workspaceId: string;
  /** The name its owner's computer last sent, or null before one did. */
  name: string | null;
  /** It has a sync identity, so the server can make a copy of it. */
  canOpen: boolean;
  showOnPhone: boolean;
}

/** The workspaces this account owns, by workspace ID. */
export function listAccountWorkspaces(storage: StorageContext, ownerUserId: string): AccountWorkspace[] {
  return storage.readTx(() => storage.db.prepare(
    `SELECT w.workspace_id, w.display_name, w.replication_epoch IS NOT NULL AS can_open,
       NOT EXISTS (SELECT 1 FROM sync_relay_phone_hidden_workspaces h
         WHERE h.workspace_id = w.workspace_id AND h.owner_user_id = w.owner_user_id) AS show_on_phone
     FROM sync_relay_workspaces w WHERE w.owner_user_id = ? ORDER BY w.workspace_id`,
  ).all(ownerUserId).map((row) => ({
    workspaceId: String(row.workspace_id), name: row.display_name === null ? null : String(row.display_name), canOpen: Boolean(row.can_open), showOnPhone: Boolean(row.show_on_phone),
  })));
}

/**
 * Ends the account's reason for every copy whose workspace its owner hid from
 * the phone, or whose workspace the account it was made for no longer owns.
 * Other copies keep the reason and leave on their usual schedule.
 */
export function endAccountReasonsOfHiddenOrDisownedCopies(storage: StorageContext): void {
  storage.tx(() => {
    storage.db.prepare(
      `DELETE FROM sync_relay_automation_workspace_reasons WHERE reason = 'account' AND workspace_id IN (
         SELECT a.workspace_id FROM sync_relay_automation_workspaces a
         JOIN sync_relay_workspaces w ON w.workspace_id = a.workspace_id
         WHERE w.owner_user_id IS NOT a.owner_user_id OR EXISTS (SELECT 1 FROM sync_relay_phone_hidden_workspaces h
           WHERE h.workspace_id = a.workspace_id AND h.owner_user_id = a.owner_user_id))`,
    ).run();
  });
}

export function showsOnPhone(storage: StorageContext, ownerUserId: string, workspaceId: string): boolean {
  return storage.db.prepare(
    "SELECT 1 FROM sync_relay_phone_hidden_workspaces WHERE workspace_id = ? AND owner_user_id = ?",
  ).get(workspaceId, ownerUserId) === undefined;
}

/**
 * Sets "Show on phone" for a workspace this account owns. Turning it off
 * ends the account's reason for the server's copy, which then goes once its
 * open visits end, unless automations still keep it. Returns false, and
 * changes nothing, when the account does not own the workspace.
 */
export function setShowOnPhone(
  storage: StorageContext,
  input: { ownerUserId: string; workspaceId: string; showOnPhone: boolean },
): boolean {
  return storage.tx(() => {
    const owned = storage.db.prepare("SELECT 1 FROM sync_relay_workspaces WHERE workspace_id = ? AND owner_user_id = ?")
      .get(input.workspaceId, input.ownerUserId) !== undefined;
    if (!owned) return false;
    if (input.showOnPhone) {
      storage.db.prepare("DELETE FROM sync_relay_phone_hidden_workspaces WHERE workspace_id = ? AND owner_user_id = ?")
        .run(input.workspaceId, input.ownerUserId);
    } else {
      storage.db.prepare("INSERT OR IGNORE INTO sync_relay_phone_hidden_workspaces (workspace_id, owner_user_id) VALUES (?, ?)")
        .run(input.workspaceId, input.ownerUserId);
      endCopyReasonInTransaction(storage, input.workspaceId, "account");
    }
    return true;
  });
}
