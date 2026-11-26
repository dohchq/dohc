import { endCopyReasonInTransaction } from "./automationWorkspaces";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { workspaceRoleOf } from "./workspaceMembers";

// "Show on phone" is on for every workspace until a person turns it off, so
// only the workspaces someone hid have a row, one per person. The owner's row
// hides the workspace on the owner's phones and ends the server copy's account
// reason; a Member's or an Admin's hides it only on their own phones. A
// workspace that changes owner shows on the new owner's phone until they hide it.
export function initializeAccountWorkspaceSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_phone_hidden_workspaces (
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 256),
      PRIMARY KEY (workspace_id, owner_user_id)
    ) STRICT;
  `);
}

export type PhoneRole = "owner" | "admin" | "member";

/** One workspace as an account lists it: one it owns, or one it joined. */
export interface AccountWorkspace {
  workspaceId: string;
  /** The name its owner's computer last sent, or null before one did. A joined workspace has the name it was shared with. */
  name: string | null;
  /** It has a sync identity, so the server can make a copy of it. */
  canOpen: boolean;
  showOnPhone: boolean;
  role: PhoneRole;
}

const HIDDEN =
  "SELECT 1 FROM sync_relay_phone_hidden_workspaces WHERE workspace_id = ? AND owner_user_id = ?";

/** The workspaces this account owns, by workspace ID, then those it joined, by name. */
export function listAccountWorkspaces(storage: StorageContext, userId: string): AccountWorkspace[] {
  return storage.readTx(() => {
    const owned = storage.db
      .prepare(
        `SELECT w.workspace_id, w.display_name, w.replication_epoch IS NOT NULL AS can_open
     FROM sync_relay_workspaces w WHERE w.owner_user_id = ? ORDER BY w.workspace_id`,
      )
      .all(userId)
      .map((row) => ({
        workspaceId: String(row.workspace_id),
        name: row.display_name === null ? null : String(row.display_name),
        canOpen: Boolean(row.can_open),
        role: "owner" as PhoneRole,
      }));
    const joined = storage.db
      .prepare(
        `SELECT m.workspace_id, ms.workspace_name, w.replication_epoch IS NOT NULL AS can_open
     FROM sync_relay_workspace_members m
     JOIN sync_relay_workspace_memberships ms ON ms.workspace_id = m.workspace_id
     JOIN sync_relay_workspaces w ON w.workspace_id = m.workspace_id
     WHERE m.user_id = ? AND m.state = 'active' ORDER BY ms.workspace_name, m.workspace_id`,
      )
      .all(userId)
      .flatMap((row) => {
        const workspaceId = String(row.workspace_id);
        const role = workspaceRoleOf(storage, workspaceId, userId)?.role;
        return role === "admin" || role === "member"
          ? [
              {
                workspaceId,
                name: String(row.workspace_name),
                canOpen: Boolean(row.can_open),
                role,
              },
            ]
          : [];
      });
    return [...owned, ...joined].map((row) => ({
      ...row,
      showOnPhone: showsOnPhone(storage, userId, row.workspaceId),
    }));
  });
}

/**
 * Ends the account's reason for every copy whose workspace its owner hid from
 * the phone, or whose workspace the account it was made for no longer owns.
 * A Member hiding a workspace never ends it. Other copies keep the reason and
 * leave on their usual schedule.
 */
export function endAccountReasonsOfHiddenOrDisownedCopies(storage: StorageContext): void {
  storage.tx(() => {
    storage.db
      .prepare(
        `DELETE FROM sync_relay_automation_workspace_reasons WHERE reason = 'account' AND workspace_id IN (
         SELECT a.workspace_id FROM sync_relay_automation_workspaces a
         JOIN sync_relay_workspaces w ON w.workspace_id = a.workspace_id
         WHERE w.owner_user_id IS NOT a.owner_user_id OR EXISTS (SELECT 1 FROM sync_relay_phone_hidden_workspaces h
           WHERE h.workspace_id = a.workspace_id AND h.owner_user_id = a.owner_user_id))`,
      )
      .run();
  });
}

/** Whether this person left "Show on phone" on for the workspace. It says nothing about whether they reach it. */
export function showsOnPhone(
  storage: StorageContext,
  userId: string,
  workspaceId: string,
): boolean {
  return storage.db.prepare(HIDDEN).get(workspaceId, userId) === undefined;
}

/**
 * The person's role in a workspace that shows on their phone, or null. The
 * owner, an Admin and a Member each reach it only while their own "Show on
 * phone" is on; the owner hiding it never hides it from the others.
 */
export function phoneRole(
  storage: StorageContext,
  userId: string,
  workspaceId: string,
): PhoneRole | null {
  const role = workspaceRoleOf(storage, workspaceId, userId)?.role ?? null;
  return role !== null && showsOnPhone(storage, userId, workspaceId) ? role : null;
}

/**
 * Sets "Show on phone" for one person in a workspace they own or joined.
 * Only the owner turning it off ends the account's reason for the server's
 * copy, which then goes once its open visits end, unless automations still
 * keep it. Returns null, and changes nothing, when the person is not in the
 * workspace; otherwise their role.
 */
export function setShowOnPhone(
  storage: StorageContext,
  input: { userId: string; workspaceId: string; showOnPhone: boolean },
): PhoneRole | null {
  return storage.tx(() => {
    const role = workspaceRoleOf(storage, input.workspaceId, input.userId)?.role ?? null;
    if (role === null) return null;
    if (input.showOnPhone) {
      storage.db
        .prepare(
          "DELETE FROM sync_relay_phone_hidden_workspaces WHERE workspace_id = ? AND owner_user_id = ?",
        )
        .run(input.workspaceId, input.userId);
    } else {
      storage.db
        .prepare(
          "INSERT OR IGNORE INTO sync_relay_phone_hidden_workspaces (workspace_id, owner_user_id) VALUES (?, ?)",
        )
        .run(input.workspaceId, input.userId);
      if (role === "owner") endCopyReasonInTransaction(storage, input.workspaceId, "account");
    }
    return role;
  });
}
