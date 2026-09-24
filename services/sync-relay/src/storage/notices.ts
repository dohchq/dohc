import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_FROM_PREFIX,
  NOTICE_KINDS,
  NOTICE_LIST_ROW_LIMIT,
  NOTICE_READ_RETENTION_MS,
  NOTICE_UNREAD_RETENTION_MS,
  type NoticeKind,
  type NoticeMark,
  type NoticeReach,
  type NoticeTarget,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import { validateUserWritePath } from "@dohc/workspace-core";
import { relayError } from "../errors";
import { authorizeShareGrantAction } from "../shareAuthorization";
import { fileSideOf, visibleSharePath, type ShareSelector } from "../shareFilter";
import type { StorageContext } from "./context";
import { NOTICE_ROWS_PER_SENDER, NOTICE_SWEEP_BATCH } from "./limits";

export interface PostNoticeInput {
  // As the sender posted it. A notice for someone else is stored under
  // `from:<senderUserId>:<noticeId>`.
  noticeId: string;
  recipientUserId: string;
  reach: NoticeReach;
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

// Where a pull stands: every change up to `seq` served. While a pull takes
// the whole list, `snapshotHead` is the list's head when it began.
export interface NoticeCursor {
  seq: number;
  snapshotHead: number | null;
}

export interface ReadNoticeChangesInput {
  recipientUserId: string;
  // Null asks for the whole list.
  cursor: NoticeCursor | null;
  limit: number;
  nowMs: number;
}

// "<seq>" or, while taking the whole list, "<seq>.<snapshotHead>". Anything
// else is not a cursor this relay issued.
export function parseNoticeCursor(value: string): NoticeCursor | null {
  const match = /^(0|[1-9][0-9]{0,15})(?:\.(0|[1-9][0-9]{0,15}))?$/u.exec(value);
  if (!match) return null;
  const seq = Number(match[1]);
  const snapshotHead = match[2] === undefined ? null : Number(match[2]);
  if (!Number.isSafeInteger(seq) || (snapshotHead !== null && !Number.isSafeInteger(snapshotHead))) return null;
  return { seq, snapshotHead };
}

function formatNoticeCursor(cursor: NoticeCursor): string {
  return cursor.snapshotHead === null ? String(cursor.seq) : `${cursor.seq}.${cursor.snapshotHead}`;
}

export interface MarkNoticesInput {
  recipientUserId: string;
  marks: readonly { noticeId: string; mark: NoticeMark }[];
  nowMs: number;
}

// Where a notice sits in its recipient's list: the workspace they may see,
// or the share they read it through.
type Placement = { workspaceId: string; recipientShareId: null } | { workspaceId: null; recipientShareId: string };

const NOTICE_COLUMNS = `notice_id, change_seq, workspace_id, recipient_share_id, kind,
  sender_kind, sender_user_id, sender_label, title, body, target_json,
  origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms`;
// Read and dismissed rows go before unread ones, then the oldest.
const EVICTION_ORDER = "(read_at_ms IS NULL AND dismissed_at_ms IS NULL), created_at_ms, notice_id";

export function noticeIdFrom(senderUserId: string, noticeId: string): string {
  return `${NOTICE_FROM_PREFIX}${senderUserId}:${noticeId}`;
}

/**
 * Adds a notice to its recipient's list. A notice for someone else needs a
 * "readers" kind, a sender who owns the workspace or holds a named grant, and
 * a target path both people can read; anything else is `notice_refused`,
 * whatever the reason. A notice id the list already holds changes nothing.
 * A sender who would have to remove someone else's rows to make room gets
 * `notice_rate_limited` and removes nothing.
 */
export function postNotice(storage: StorageContext, input: PostNoticeInput): void {
  const self = input.recipientUserId === input.senderUserId;
  const noticeId = self ? input.noticeId : noticeIdFrom(input.senderUserId, input.noticeId);
  storage.tx(() => {
    const placement = self ? ownPlacement(input.reach) : sharedPlacement(storage, input);
    const existing = storage.db
      .prepare("SELECT 1 FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id = ?")
      .get(input.recipientUserId, noticeId);
    if (existing) return;

    sweepExpiredNotices(storage, input.recipientUserId, input.nowMs);
    makeRoom(storage, input, self);
    storage.db.prepare(
      `INSERT INTO sync_relay_notices (
         recipient_user_id, notice_id, change_seq, workspace_id, recipient_share_id,
         kind, sender_kind, sender_user_id, sender_label, title, body, target_json,
         origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms, expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      input.recipientUserId,
      noticeId,
      nextChangeSeq(storage, input.recipientUserId),
      placement.workspaceId,
      placement.recipientShareId,
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
 * The recipient's rows that changed after the cursor, oldest change first.
 * First, a row whose recipient lost access to its target moves to another
 * share that still admits it, or loses its target; either is a new change.
 *
 * A cursor below a removed row's change missed that removal, and a cursor
 * past the head comes from another relay history: both get the whole list
 * with `replace` set, paged under a cursor that remembers the head the pull
 * began at. That pull starts over only if rows are removed after it began.
 */
export function readNoticeChanges(
  storage: StorageContext,
  input: ReadNoticeChangesInput,
): RelayNoticePage {
  if (storage.readTx(() => lostReach(storage, input.recipientUserId).length > 0)) {
    storage.tx(() => {
      for (const { noticeId, movedTo } of lostReach(storage, input.recipientUserId)) {
        storage.db.prepare(
          `UPDATE sync_relay_notices
           SET recipient_share_id = COALESCE(?, recipient_share_id),
               target_json = CASE WHEN ? IS NULL THEN NULL ELSE target_json END,
               change_seq = ?
           WHERE recipient_user_id = ? AND notice_id = ?`,
        ).run(movedTo, movedTo, nextChangeSeq(storage, input.recipientUserId), input.recipientUserId, noticeId);
      }
    });
  }
  return storage.readTx(() => {
    const list = storage.db.prepare(
      "SELECT change_seq, floor_seq, removed_seq FROM sync_relay_notice_lists WHERE recipient_user_id = ?",
    ).get(input.recipientUserId);
    const head = Number(list?.change_seq ?? 0);
    const cursor = input.cursor;
    let replace: boolean;
    if (cursor === null) {
      replace = true;
    } else if (cursor.snapshotHead !== null) {
      replace = cursor.snapshotHead > head || cursor.seq > head ||
        Number(list?.removed_seq ?? 0) > cursor.snapshotHead;
    } else {
      // Rows past retention that no post has swept yet count as removed.
      const expired = Number(storage.db.prepare(
        `SELECT COALESCE(MAX(change_seq), 0) AS seq FROM sync_relay_notices
         WHERE recipient_user_id = ? AND expires_at_ms <= ?`,
      ).get(input.recipientUserId, input.nowMs)?.seq ?? 0);
      replace = cursor.seq > head || cursor.seq < Math.max(Number(list?.floor_seq ?? 0), expired);
    }
    const since = replace ? 0 : cursor!.seq;
    const snapshotHead = replace ? head : cursor!.snapshotHead;
    const rows = storage.db.prepare(
      `SELECT ${NOTICE_COLUMNS} FROM sync_relay_notices
       WHERE recipient_user_id = ? AND change_seq > ? AND expires_at_ms > ?
       ORDER BY change_seq LIMIT ?`,
    ).all(input.recipientUserId, since, input.nowMs, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const notices = rows.slice(0, input.limit).map(rowToNotice);
    // Every change after the last row served is expired or replaced by a
    // later change, so a finished pull can move its cursor to the head.
    const nextCursor = hasMore
      ? formatNoticeCursor({ seq: notices.at(-1)!.changeSeq, snapshotHead })
      : formatNoticeCursor({ seq: head, snapshotHead: null });
    return { notices, nextCursor, hasMore, replace };
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

// A post to yourself is placed where you said. Access is judged at pull.
function ownPlacement(reach: NoticeReach): Placement {
  return reach.workspaceId !== undefined
    ? { workspaceId: reach.workspaceId, recipientShareId: null }
    : { workspaceId: null, recipientShareId: reach.shareId };
}

function sharedPlacement(storage: StorageContext, input: PostNoticeInput): Placement {
  const refused = () => relayError("notice_refused");
  const path = input.target.path;
  const validated = path === undefined ? null : validateUserWritePath(path);
  if (
    NOTICE_KINDS[input.kind].recipients !== "readers" ||
    path === undefined || !validated?.ok || validated.normalized !== path
  ) {
    throw refused();
  }
  let workspaceId: string;
  if (input.reach.workspaceId !== undefined) {
    workspaceId = input.reach.workspaceId;
    if (!storage.workspaceIsOwnedBy(workspaceId, input.senderUserId)) throw refused();
  } else {
    if (!admits(fileSidesOn(storage, input.senderUserId, input.reach.shareId, "named"), path)) throw refused();
    workspaceId = storage.getShare(input.reach.shareId)!.workspaceId;
  }
  if (storage.workspaceIsOwnedBy(workspaceId, input.recipientUserId)) {
    return { workspaceId, recipientShareId: null };
  }
  const shareId = shareAdmitting(storage, input.recipientUserId, workspaceId, path);
  if (shareId === null) throw refused();
  return { workspaceId: null, recipientShareId: shareId };
}

// The main-version file sides `userId` reads through `shareId` now, or null
// when no current grant on the share is theirs. "named" leaves out grants
// opened from a public link.
function fileSidesOn(
  storage: StorageContext,
  userId: string,
  shareId: string,
  grants: "named" | "any" = "any",
): ShareSelector[] | null {
  let held = false;
  const sides: ShareSelector[] = [];
  for (const grant of storage.listActiveShareGrantsForRecipient(shareId, userId)) {
    if (grants === "named" && grant.parentGrantId !== null) continue;
    const authorized = authorizeShareGrantAction({
      storage,
      grantId: grant.grantId,
      action: "read",
      principal: { kind: "user", userId },
    });
    if (!authorized.ok) continue;
    held = true;
    const files = fileSideOf(authorized.effectiveSelector);
    if (files?.versionId === null) sides.push(files);
  }
  return held ? sides : null;
}

function admits(sides: ShareSelector[] | null, path: string): boolean {
  return sides?.some((files) => visibleSharePath(files, path) === path) ?? false;
}

// A share in `workspaceId` through which `userId` reads `path`, if any.
function shareAdmitting(
  storage: StorageContext,
  userId: string,
  workspaceId: string,
  path: string,
): string | null {
  const shareIds = new Set(storage.listSharesReceivedBy(userId)
    .filter(({ share }) => share.workspaceId === workspaceId)
    .map(({ share }) => share.shareId));
  for (const shareId of shareIds) {
    if (admits(fileSidesOn(storage, userId, shareId), path)) return shareId;
  }
  return null;
}

// Rows read through a share whose recipient no longer reads the target
// there. Each moves to another share that admits its path, or loses its
// target (`movedTo` null). Grants are checked once per share.
function lostReach(
  storage: StorageContext,
  recipientUserId: string,
): { noticeId: string; movedTo: string | null }[] {
  const rows = storage.db.prepare(
    `SELECT notice_id, recipient_share_id, target_json FROM sync_relay_notices
     WHERE recipient_user_id = ? AND recipient_share_id IS NOT NULL AND target_json IS NOT NULL
     ORDER BY change_seq`,
  ).all(recipientUserId);
  const sides = new Map<string, ShareSelector[] | null>();
  const changes = [];
  for (const row of rows) {
    const shareId = String(row.recipient_share_id);
    const path = (JSON.parse(String(row.target_json)) as NoticeTarget).path;
    if (!sides.has(shareId)) sides.set(shareId, fileSidesOn(storage, recipientUserId, shareId));
    const current = sides.get(shareId)!;
    if (path === undefined ? current !== null : admits(current, path)) continue;
    const workspaceId = storage.getShare(shareId)?.workspaceId;
    const movedTo = path === undefined || workspaceId === undefined
      ? null
      : shareAdmitting(storage, recipientUserId, workspaceId, path);
    changes.push({ noticeId: String(row.notice_id), movedTo });
  }
  return changes;
}

// Makes room for one more row. Another sender first gives up its own oldest
// rows past its share of the list, and may take room only from itself.
function makeRoom(storage: StorageContext, input: PostNoticeInput, self: boolean): void {
  const count = (bySender: boolean) => Number(storage.db.prepare(
    `SELECT COUNT(*) AS count FROM sync_relay_notices
     WHERE recipient_user_id = ? ${bySender ? "AND sender_user_id = ?" : ""}`,
  ).get(input.recipientUserId, ...(bySender ? [input.senderUserId] : []))?.count ?? 0);
  if (!self) {
    removeOldest(storage, input.recipientUserId, input.senderUserId, count(true) - NOTICE_ROWS_PER_SENDER + 1);
  }
  const excess = count(false) - NOTICE_LIST_ROW_LIMIT + 1;
  if (excess <= 0) return;
  const removed = removeOldest(storage, input.recipientUserId, self ? null : input.senderUserId, excess);
  if (removed < excess) throw relayError("notice_rate_limited");
}

// Removes up to `limit` rows, read and oldest first, from one sender's rows
// when `senderUserId` is set.
function removeOldest(
  storage: StorageContext,
  recipientUserId: string,
  senderUserId: string | null,
  limit: number,
): number {
  if (limit <= 0) return 0;
  const bySender = senderUserId === null ? "" : "AND sender_user_id = ?";
  const removed = storage.db.prepare(
    `DELETE FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id IN (
       SELECT notice_id FROM sync_relay_notices WHERE recipient_user_id = ? ${bySender}
       ORDER BY ${EVICTION_ORDER} LIMIT ?)
     RETURNING recipient_user_id, change_seq`,
  ).all(recipientUserId, recipientUserId, ...(senderUserId === null ? [] : [senderUserId]), limit);
  raiseFloors(storage, removed);
  return removed.length;
}

// Retention runs with each post, as the relay's other expiring rows do: this
// recipient's expired rows go first so they never count against the list's
// limit, then a bounded batch from every list.
function sweepExpiredNotices(storage: StorageContext, recipientUserId: string, nowMs: number): void {
  raiseFloors(storage, storage.db.prepare(
    `DELETE FROM sync_relay_notices WHERE recipient_user_id = ? AND expires_at_ms <= ?
     RETURNING recipient_user_id, change_seq`,
  ).all(recipientUserId, nowMs));
  raiseFloors(storage, storage.db.prepare(
    `DELETE FROM sync_relay_notices WHERE rowid IN (
       SELECT rowid FROM sync_relay_notices WHERE expires_at_ms <= ?
       ORDER BY expires_at_ms LIMIT ?)
     RETURNING recipient_user_id, change_seq`,
  ).all(nowMs, NOTICE_SWEEP_BATCH));
}

// A removal is a change to its list: the list's floor rises to the newest
// change among its removed rows, and the removal takes the next change.
function raiseFloors(storage: StorageContext, removed: readonly Record<string, unknown>[]): void {
  const floors = new Map<string, number>();
  for (const row of removed) {
    const recipient = String(row.recipient_user_id);
    floors.set(recipient, Math.max(floors.get(recipient) ?? 0, Number(row.change_seq)));
  }
  const raise = storage.db.prepare(
    `UPDATE sync_relay_notice_lists
     SET floor_seq = max(floor_seq, ?), change_seq = change_seq + 1, removed_seq = change_seq + 1
     WHERE recipient_user_id = ?`,
  );
  for (const [recipient, floor] of floors) raise.run(floor, recipient);
}

function nextChangeSeq(storage: StorageContext, recipientUserId: string): number {
  const row = storage.db.prepare(
    `INSERT INTO sync_relay_notice_lists (recipient_user_id, change_seq, floor_seq, removed_seq) VALUES (?, 1, 0, 0)
     ON CONFLICT (recipient_user_id) DO UPDATE SET change_seq = change_seq + 1
     RETURNING change_seq`,
  ).get(recipientUserId);
  return Number(row!.change_seq);
}

function rowToNotice(row: Record<string, unknown>): RelayNotice {
  const nullable = (value: unknown) => (value === null ? null : String(value));
  return {
    noticeId: String(row.notice_id),
    changeSeq: Number(row.change_seq),
    workspaceId: nullable(row.workspace_id),
    recipientShareId: nullable(row.recipient_share_id),
    kind: String(row.kind) as NoticeKind,
    senderKind: String(row.sender_kind) as RelayNotice["senderKind"],
    senderUserId: String(row.sender_user_id),
    senderLabel: String(row.sender_label),
    title: String(row.title),
    body: String(row.body),
    target: row.target_json === null ? null : JSON.parse(String(row.target_json)) as NoticeTarget,
    originInstallId: String(row.origin_install_id),
    createdAtMs: Number(row.created_at_ms),
    readAtMs: row.read_at_ms === null ? null : Number(row.read_at_ms),
    dismissedAtMs: row.dismissed_at_ms === null ? null : Number(row.dismissed_at_ms),
  };
}
