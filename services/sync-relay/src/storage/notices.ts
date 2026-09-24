import {
  NOTICE_KINDS,
  type NoticeKind,
  type NoticeMark,
  type NoticeTarget,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import { validateUserWritePath } from "@dohc/workspace-core";
import { relayError } from "../errors";
import { authorizeShareGrantAction } from "../shareAuthorization";
import { fileSideOf, visibleSharePath } from "../shareFilter";
import type { StorageContext } from "./context";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_READ_RETENTION_MS,
  NOTICE_SWEEP_BATCH,
  NOTICE_UNREAD_RETENTION_MS,
} from "./limits";

export interface PostNoticeInput {
  noticeId: string;
  recipientUserId: string;
  workspaceId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  target: NoticeTarget;
  originInstallId: string;
  // Derived from the authenticated caller, never from the request body.
  senderUserId: string;
  senderLabel: string;
  nowMs: number;
}

export interface ReadNoticeChangesInput {
  recipientUserId: string;
  since: number;
  limit: number;
  nowMs: number;
}

export interface MarkNoticesInput {
  recipientUserId: string;
  marks: readonly { noticeId: string; mark: NoticeMark }[];
  nowMs: number;
}

const NOTICE_COLUMNS = `notice_id, change_seq, workspace_id, recipient_share_id, kind,
  sender_kind, sender_user_id, sender_label, title, body, target_json,
  origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms`;

/**
 * Adds a notice to its recipient's list. A notice for someone else needs a
 * target path that both people can read in the notice's workspace; anything
 * else is `notice_refused`, whatever the reason, so a refusal maps nothing.
 * A notice id the list already holds changes nothing.
 */
export function postNotice(storage: StorageContext, input: PostNoticeInput): void {
  storage.tx(() => {
    const recipientShareId = input.recipientUserId === input.senderUserId
      ? null
      : sharedReach(storage, input);
    const existing = storage.db
      .prepare("SELECT 1 FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id = ?")
      .get(input.recipientUserId, input.noticeId);
    if (existing) return;

    sweepExpiredNotices(storage, input.recipientUserId, input.nowMs);
    const excess = Number(storage.db
      .prepare("SELECT COUNT(*) AS count FROM sync_relay_notices WHERE recipient_user_id = ?")
      .get(input.recipientUserId)?.count ?? 0) - NOTICE_LIST_ROW_LIMIT + 1;
    if (excess > 0) {
      storage.db.prepare(
        `DELETE FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id IN (
           SELECT notice_id FROM sync_relay_notices WHERE recipient_user_id = ?
           ORDER BY (read_at_ms IS NULL AND dismissed_at_ms IS NULL), created_at_ms, notice_id
           LIMIT ?)`,
      ).run(input.recipientUserId, input.recipientUserId, excess);
    }

    storage.db.prepare(
      `INSERT INTO sync_relay_notices (
         recipient_user_id, notice_id, change_seq, workspace_id, recipient_share_id,
         kind, sender_kind, sender_user_id, sender_label, title, body, target_json,
         origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms, expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      input.recipientUserId,
      input.noticeId,
      nextChangeSeq(storage, input.recipientUserId),
      input.workspaceId,
      recipientShareId,
      input.kind,
      NOTICE_KINDS[input.kind].senderKind,
      input.senderUserId,
      input.senderLabel,
      input.title,
      input.body,
      JSON.stringify(input.target),
      input.originInstallId,
      input.nowMs,
      input.nowMs + NOTICE_UNREAD_RETENTION_MS,
    );
  });
}

/**
 * The recipient's rows that changed after `since`, oldest change first. A
 * cursor past the list's newest change comes from another relay history, so
 * the page starts again from the beginning.
 */
export function readNoticeChanges(
  storage: StorageContext,
  input: ReadNoticeChangesInput,
): RelayNoticePage {
  return storage.readTx(() => {
    const head = Number(storage.db
      .prepare("SELECT change_seq FROM sync_relay_notice_lists WHERE recipient_user_id = ?")
      .get(input.recipientUserId)?.change_seq ?? 0);
    const since = input.since > head ? 0 : input.since;
    const rows = storage.db.prepare(
      `SELECT ${NOTICE_COLUMNS} FROM sync_relay_notices
       WHERE recipient_user_id = ? AND change_seq > ? AND expires_at_ms > ?
       ORDER BY change_seq LIMIT ?`,
    ).all(input.recipientUserId, since, input.nowMs, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const notices = rows.slice(0, input.limit).map(rowToNotice);
    // Every change after the last row served is expired or replaced by a
    // later change, so a finished pull can move its cursor to the head.
    return { notices, nextCursor: hasMore ? notices.at(-1)!.changeSeq : head, hasMore };
  });
}

/** Sets read or dismissed once. A row already marked, expired, or gone is left as it is. */
export function markNotices(storage: StorageContext, input: MarkNoticesInput): void {
  storage.tx(() => {
    const read = storage.db.prepare(
      `SELECT read_at_ms, dismissed_at_ms FROM sync_relay_notices
       WHERE recipient_user_id = ? AND notice_id = ? AND expires_at_ms > ?`,
    );
    for (const { noticeId, mark } of input.marks) {
      const row = read.get(input.recipientUserId, noticeId, input.nowMs);
      if (!row || row.dismissed_at_ms !== null || (mark === "read" && row.read_at_ms !== null)) continue;
      const [column, retentionMs] = mark === "read"
        ? ["read_at_ms", NOTICE_READ_RETENTION_MS]
        : ["dismissed_at_ms", NOTICE_DISMISSED_RETENTION_MS];
      storage.db.prepare(
        `UPDATE sync_relay_notices SET ${column} = ?, expires_at_ms = ?, change_seq = ?
         WHERE recipient_user_id = ? AND notice_id = ?`,
      ).run(
        input.nowMs,
        input.nowMs + retentionMs,
        nextChangeSeq(storage, input.recipientUserId),
        input.recipientUserId,
        noticeId,
      );
    }
  });
}

// The share the recipient reads the target through, or null when the
// recipient owns the workspace. Refuses unless both people can read it.
function sharedReach(storage: StorageContext, input: PostNoticeInput): string | null {
  const path = input.target.path;
  const validated = path === undefined ? null : validateUserWritePath(path);
  if (
    NOTICE_KINDS[input.kind].recipients !== "readers" ||
    !path || !validated?.ok || validated.normalized !== path
  ) {
    throw relayError("notice_refused");
  }
  const sender = readerOf(storage, input.senderUserId, input.workspaceId, path);
  const recipient = readerOf(storage, input.recipientUserId, input.workspaceId, path);
  if (!sender || !recipient) throw relayError("notice_refused");
  return recipient === "owner" ? null : recipient.shareId;
}

// How `userId` reads `path` in main: as the workspace owner, or through the
// first current grant whose file side admits it.
function readerOf(
  storage: StorageContext,
  userId: string,
  workspaceId: string,
  path: string,
): "owner" | { shareId: string } | null {
  if (storage.workspaceIsOwnedBy(workspaceId, userId)) return "owner";
  for (const { share, grant } of storage.listSharesReceivedBy(userId)) {
    if (share.workspaceId !== workspaceId) continue;
    const authorized = authorizeShareGrantAction({
      storage,
      grantId: grant.grantId,
      action: "read",
      principal: { kind: "user", userId },
    });
    if (!authorized.ok) continue;
    const files = fileSideOf(authorized.effectiveSelector);
    if (files?.versionId === null && visibleSharePath(files, path) === path) {
      return { shareId: share.shareId };
    }
  }
  return null;
}

// Retention runs with each post, as the relay's other expiring rows do: this
// recipient's expired rows go first so they never count against the list's
// limit, then a bounded batch from every list.
function sweepExpiredNotices(storage: StorageContext, recipientUserId: string, nowMs: number): void {
  storage.db
    .prepare("DELETE FROM sync_relay_notices WHERE recipient_user_id = ? AND expires_at_ms <= ?")
    .run(recipientUserId, nowMs);
  storage.db.prepare(
    `DELETE FROM sync_relay_notices WHERE rowid IN (
       SELECT rowid FROM sync_relay_notices WHERE expires_at_ms <= ?
       ORDER BY expires_at_ms LIMIT ?)`,
  ).run(nowMs, NOTICE_SWEEP_BATCH);
}

function nextChangeSeq(storage: StorageContext, recipientUserId: string): number {
  const row = storage.db.prepare(
    `INSERT INTO sync_relay_notice_lists (recipient_user_id, change_seq) VALUES (?, 1)
     ON CONFLICT (recipient_user_id) DO UPDATE SET change_seq = change_seq + 1
     RETURNING change_seq`,
  ).get(recipientUserId);
  return Number(row!.change_seq);
}

function rowToNotice(row: Record<string, unknown>): RelayNotice {
  return {
    noticeId: String(row.notice_id),
    changeSeq: Number(row.change_seq),
    workspaceId: String(row.workspace_id),
    recipientShareId: row.recipient_share_id === null ? null : String(row.recipient_share_id),
    kind: String(row.kind) as NoticeKind,
    senderKind: String(row.sender_kind) as RelayNotice["senderKind"],
    senderUserId: String(row.sender_user_id),
    senderLabel: String(row.sender_label),
    title: String(row.title),
    body: String(row.body),
    target: JSON.parse(String(row.target_json)) as NoticeTarget,
    originInstallId: String(row.origin_install_id),
    createdAtMs: Number(row.created_at_ms),
    readAtMs: row.read_at_ms === null ? null : Number(row.read_at_ms),
    dismissedAtMs: row.dismissed_at_ms === null ? null : Number(row.dismissed_at_ms),
  };
}
