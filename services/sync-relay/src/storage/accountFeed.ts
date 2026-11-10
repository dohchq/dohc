import type { StorageContext } from "./context";
import { objectLastKnownPath, threadCreateRows } from "./objectIndex";

// What an account's change feed reads: the workspace's relay log and its
// accepted live-update journal, never a copy.

/** Where a workspace's log and journal stand now, the log floor its last restore set, and its owner. */
export interface AccountFeedStanding {
  ownerUserId: string;
  floor: number;
  log: number;
  journal: number;
}

export function accountFeedStanding(storage: StorageContext, workspaceId: string): AccountFeedStanding | null {
  return storage.readTx(() => {
    const row = storage.db.prepare(
      `SELECT w.owner_user_id, COALESCE(w.epoch_log_floor, 0) AS floor,
         COALESCE((SELECT MAX(relay_seq) FROM sync_relay_log WHERE workspace_id = w.workspace_id), 0) AS log,
         COALESCE((SELECT MAX(journal_cursor) FROM sync_relay_live_update_journal WHERE workspace_id = w.workspace_id), 0) AS journal
       FROM sync_relay_workspaces w WHERE w.workspace_id = ?`,
    ).get(workspaceId);
    return row ? { ownerUserId: String(row.owner_user_id), floor: Number(row.floor), log: Number(row.log), journal: Number(row.journal) } : null;
  });
}

/**
 * One log row after the feed's cursor. A moment names its object, the path
 * it put the object at (null for a delete), and the object's path before it.
 * A chat op names its thread when it has one.
 */
export interface AccountFeedLogRow {
  relaySeq: number;
  chat: boolean;
  threadId: string | null;
  moment: { objectId: string; path: string | null; previousPath: string | null } | null;
}

/** The workspace's log rows in (after, through], at most `limit`, in log order. */
export function accountFeedLogRows(
  storage: StorageContext,
  input: { workspaceId: string; after: number; through: number; limit: number },
): AccountFeedLogRow[] {
  return storage.readTx(() => storage.db.prepare(
    `SELECT l.relay_seq, l.op_kind GLOB 'chat.*' AS chat,
       CASE WHEN l.op_kind GLOB 'chat.*' AND json_valid(l.payload_json) THEN json_extract(l.payload_json, '$.threadId') END AS thread_id,
       m.object_id, m.path,
       (SELECT p.path FROM sync_relay_object_moments p WHERE p.workspace_id = m.workspace_id AND p.object_id = m.object_id
          AND p.relay_seq < m.relay_seq AND p.path IS NOT NULL ORDER BY p.relay_seq DESC LIMIT 1) AS previous_path
     FROM sync_relay_log l INDEXED BY idx_sync_relay_log_page
     LEFT JOIN sync_relay_object_moments m ON m.workspace_id = l.workspace_id AND m.relay_seq = l.relay_seq
       AND m.object_id = CASE WHEN json_valid(l.payload_json) THEN json_extract(l.payload_json, '$.objectId') END
     WHERE l.workspace_id = ? AND l.relay_seq > ? AND l.relay_seq <= ?
     ORDER BY l.relay_seq LIMIT ?`,
  ).all(input.workspaceId, input.after, input.through, input.limit).map((row) => ({
    relaySeq: Number(row.relay_seq),
    chat: Boolean(row.chat),
    threadId: typeof row.thread_id === "string" && row.thread_id.length > 0 ? row.thread_id : null,
    moment: typeof row.object_id === "string"
      ? { objectId: row.object_id, path: typeof row.path === "string" ? row.path : null, previousPath: typeof row.previous_path === "string" ? row.previous_path : null }
      : null,
  })));
}

/** The pages the journal accepted edits for in (after, through], with the path each edit was accepted at. */
export function accountFeedJournalPages(
  storage: StorageContext,
  input: { workspaceId: string; after: number; through: number },
): Array<{ objectId: string; path: string }> {
  return storage.readTx(() => storage.db.prepare(
    `SELECT DISTINCT object_id, current_path FROM sync_relay_live_update_journal
     WHERE workspace_id = ? AND journal_cursor > ? AND journal_cursor <= ?`,
  ).all(input.workspaceId, input.after, input.through).map((row) => ({ objectId: String(row.object_id), path: String(row.current_path) })));
}

/**
 * What tells whether a thread is on a secret file: where the log last put
 * the object its first create names, or null when the log never placed it,
 * and the path and hint that create names. Both are empty for a thread on no
 * file, or one the log has no create for.
 */
export function accountFeedThreadPaths(storage: StorageContext, workspaceId: string, threadId: string): { lastKnownPath: string | null; named: string[] } {
  return storage.readTx(() => {
    let create: Record<string, unknown> | undefined;
    for (const row of threadCreateRows(storage, workspaceId, threadId)) {
      let payload: unknown;
      try { payload = JSON.parse(String(row.payload_json)); } catch { continue; }
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>).threadId === threadId) {
        create = payload as Record<string, unknown>;
        break;
      }
    }
    const text = (value: unknown) => typeof value === "string" && value.length > 0 ? [value] : [];
    const objectId = text(create?.linkedObjectId)[0];
    return {
      lastKnownPath: (objectId === undefined ? undefined : objectLastKnownPath(storage, workspaceId, objectId)) ?? null,
      named: [...text(create?.linkedPath), ...text(create?.linkedPathHint)],
    };
  });
}
