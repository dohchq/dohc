import { createHash } from "node:crypto";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_FROM_PREFIX,
  NOTICE_ID_MAX_CHARS,
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
import { badRequest, relayError } from "../errors";
import { authorizeShareGrantAction } from "../shareAuthorization";
import { fileSideOf, visibleSharePath, type ShareSelector } from "../shareFilter";
import type { StorageContext } from "./context";
import {
  NOTICE_REMOVED_RETENTION_MS,
  NOTICE_REMOVED_ROW_LIMIT,
  NOTICE_ROWS_PER_SENDER,
  NOTICE_SWEEP_BATCH,
} from "./limits";

export interface PostNoticeInput {
  // As the sender posted it. A notice for someone else is stored under
  // `noticeIdFrom(senderUserId, noticeId)`.
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
  origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms, removed_at_ms`;
const MARKED = "(read_at_ms IS NOT NULL OR dismissed_at_ms IS NOT NULL)";
const UNREAD = "read_at_ms IS NULL AND dismissed_at_ms IS NULL";

// The sender is percent-encoded, so it holds no colon and the id after the
// second colon is exactly what the sender posted.
export function noticeIdFrom(senderUserId: string, noticeId: string): string {
  return `${NOTICE_FROM_PREFIX}${encodeURIComponent(senderUserId)}:${noticeId}`;
}

/**
 * Adds a notice to its recipient's list. A notice for someone else needs a
 * "readers" kind, a sender who owns the workspace or holds a named grant, and
 * a target path both people can read; anything else is `notice_refused`,
 * whatever the reason. A notice id the list already holds, even as a
 * tombstone, changes nothing. When the list is full and only other senders'
 * unread rows could make room, the post gets `notice_list_full` and removes
 * nothing.
 */
export function postNotice(storage: StorageContext, input: PostNoticeInput): void {
  const self = input.recipientUserId === input.senderUserId;
  const noticeId = self ? input.noticeId : noticeIdFrom(input.senderUserId, input.noticeId);
  if ([...noticeId].length > NOTICE_ID_MAX_CHARS) throw badRequest("noticeId is too long for this sender");
  storage.tx(() => {
    const placement = self ? ownPlacement(storage, input) : sharedPlacement(storage, input);
    const existing = storage.db
      .prepare("SELECT 1 FROM sync_relay_notices WHERE recipient_user_id = ? AND notice_id = ?")
      .get(input.recipientUserId, noticeId);
    if (existing) return;

    sweepExpiredNotices(storage, input.recipientUserId, input.nowMs);
    makeRoom(storage, input.recipientUserId, self ? null : input.senderUserId, input.nowMs);
    storage.db.prepare(
      `INSERT INTO sync_relay_notices (
         recipient_user_id, notice_id, change_seq, workspace_id, recipient_share_id,
         kind, sender_kind, sender_user_id, sender_label, title, body, target_json,
         origin_install_id, created_at_ms, read_at_ms, dismissed_at_ms, expires_at_ms, removed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
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
    // A row placed through a share was checked against the grants of this
    // moment, which a stored digest may not describe, so the next pull
    // checks access again.
    if (placement.recipientShareId !== null) {
      storage.db.prepare("UPDATE sync_relay_notice_lists SET reach_token = NULL WHERE recipient_user_id = ?")
        .run(input.recipientUserId);
    }
  });
}

/**
 * The recipient's rows that changed after the cursor, oldest change first.
 * First, if anything that decides the recipient's access changed since the
 * last check, a row whose recipient lost access to its target moves to
 * another share that still admits it, or loses its target; either is a new
 * change. A row removed to make room arrives as a tombstone.
 *
 * A cursor below a deleted row's last change missed that change, and a
 * cursor past the head comes from another relay history. Each gets the
 * whole list with `replace` set, paged under a cursor that remembers the
 * head the pull began at. That pull starts over only if a row changed after
 * it began is deleted.
 */
export function readNoticeChanges(
  storage: StorageContext,
  input: ReadNoticeChangesInput,
): RelayNoticePage {
  settleLostReach(storage, input.recipientUserId, input.nowMs);
  return storage.readTx(() => {
    const list = storage.db.prepare(
      "SELECT change_seq, floor_seq FROM sync_relay_notice_lists WHERE recipient_user_id = ?",
    ).get(input.recipientUserId);
    const head = Number(list?.change_seq ?? 0);
    const floor = Number(list?.floor_seq ?? 0);
    const cursor = input.cursor;
    // Rows past retention that no post has swept yet count as deleted.
    const deleted = Math.max(floor, Number(storage.db.prepare(
      `SELECT COALESCE(MAX(change_seq), 0) AS seq FROM sync_relay_notices
       WHERE recipient_user_id = ? AND expires_at_ms <= ?`,
    ).get(input.recipientUserId, input.nowMs)?.seq ?? 0));
    let replace: boolean;
    if (cursor === null) {
      replace = true;
    } else if (cursor.snapshotHead !== null) {
      replace = cursor.snapshotHead > head || cursor.seq > head || deleted > cursor.snapshotHead;
    } else {
      replace = cursor.seq > head || cursor.seq < deleted;
    }
    const since = replace ? 0 : cursor!.seq;
    const snapshotHead = replace ? head : cursor!.snapshotHead;
    // A pull taking the whole list skips tombstones from before it began:
    // the computer already dropped every row.
    const rows = storage.db.prepare(
      `SELECT ${NOTICE_COLUMNS} FROM sync_relay_notices
       WHERE recipient_user_id = ? AND change_seq > ? AND expires_at_ms > ?
         AND (removed_at_ms IS NULL OR change_seq > ?)
       ORDER BY change_seq LIMIT ?`,
    ).all(input.recipientUserId, since, input.nowMs, snapshotHead ?? 0, input.limit + 1);
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

/** Sets read or dismissed once. A row already marked, removed, expired, or gone is left as it is. */
export function markNotices(storage: StorageContext, input: MarkNoticesInput): void {
  storage.tx(() => {
    const read = storage.db.prepare(
      `SELECT read_at_ms, dismissed_at_ms FROM sync_relay_notices
       WHERE recipient_user_id = ? AND notice_id = ? AND expires_at_ms > ? AND removed_at_ms IS NULL`,
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

// A post to yourself is placed where you said. A share must be one you
// hold a current grant on, or the next pull's access check would tell you
// how someone else's share relates to yours. The target is judged at pull.
function ownPlacement(storage: StorageContext, input: PostNoticeInput): Placement {
  const reach = input.reach;
  if (reach.workspaceId !== undefined) return { workspaceId: reach.workspaceId, recipientShareId: null };
  if (fileSidesOn(storage, input.senderUserId, reach.shareId) === null) throw relayError("notice_refused");
  return { workspaceId: null, recipientShareId: reach.shareId };
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
  const shareId = shareReach(storage, input.recipientUserId).admitting(workspaceId, path);
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

// What `userId` reads through shares during one check. Each share's grants
// and the list of shares received are read once, however many notices ask.
function shareReach(storage: StorageContext, userId: string) {
  const sides = new Map<string, ShareSelector[] | null>();
  let received: ReturnType<StorageContext["listSharesReceivedBy"]> | null = null;
  const sidesOn = (shareId: string): ShareSelector[] | null => {
    if (!sides.has(shareId)) sides.set(shareId, fileSidesOn(storage, userId, shareId));
    return sides.get(shareId)!;
  };
  return {
    sidesOn,
    // A share in `workspaceId` through which `userId` reads `path`, if any.
    admitting(workspaceId: string, path: string): string | null {
      received ??= storage.listSharesReceivedBy(userId);
      const shareIds = new Set(received
        .filter(({ share }) => share.workspaceId === workspaceId)
        .map(({ share }) => share.shareId));
      for (const shareId of shareIds) {
        if (admits(sidesOn(shareId), path)) return shareId;
      }
      return null;
    },
  };
}

export interface NoticeReachRead {
  method: string;
  args: unknown[];
  result: unknown;
}

// Every storage read that decides what `userId` reads through shares: the
// grants they hold, then each read the access check makes for each grant.
// The digest is built from the check's own reads, so it covers whatever the
// check reads.
export function noticeReachReads(storage: StorageContext, userId: string): NoticeReachRead[] {
  const reads: NoticeReachRead[] = [];
  const recording = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        reads.push({ method: String(property), args, result });
        return result;
      };
    },
  });
  for (const { grant } of recording.listSharesReceivedBy(userId)) {
    authorizeShareGrantAction({
      storage: recording,
      grantId: grant.grantId,
      action: "read",
      principal: { kind: "user", userId },
    });
  }
  return reads;
}

function reachToken(storage: StorageContext, userId: string): string {
  return createHash("sha256").update(JSON.stringify(noticeReachReads(storage, userId))).digest("hex");
}

// Rechecks rows read through a share, in one pass inside the write
// transaction, and only when the reads behind the recipient's access
// changed since the last check. Each row whose recipient no longer reads
// its target there moves to another share that admits its path, or loses
// its target.
function settleLostReach(storage: StorageContext, recipientUserId: string, nowMs: number): void {
  const stale = storage.readTx(() => {
    // Nothing to check without a live, unexpired row placed through a share.
    const throughShare = storage.db.prepare(
      `SELECT EXISTS (SELECT 1 FROM sync_relay_notices
         WHERE recipient_user_id = ? AND recipient_share_id IS NOT NULL AND target_json IS NOT NULL
           AND removed_at_ms IS NULL AND expires_at_ms > ?) AS present`,
    ).get(recipientUserId, nowMs);
    if (Number(throughShare?.present) !== 1) return false;
    const list = storage.db.prepare("SELECT reach_token FROM sync_relay_notice_lists WHERE recipient_user_id = ?")
      .get(recipientUserId);
    return list !== undefined && list.reach_token !== reachToken(storage, recipientUserId);
  });
  if (!stale) return;
  storage.tx(() => {
    const rows = storage.db.prepare(
      `SELECT notice_id, recipient_share_id, target_json FROM sync_relay_notices
       WHERE recipient_user_id = ? AND recipient_share_id IS NOT NULL AND target_json IS NOT NULL
         AND removed_at_ms IS NULL AND expires_at_ms > ?
       ORDER BY change_seq`,
    ).all(recipientUserId, nowMs);
    const reach = shareReach(storage, recipientUserId);
    const move = storage.db.prepare(
      `UPDATE sync_relay_notices
       SET recipient_share_id = COALESCE(?, recipient_share_id),
           target_json = CASE WHEN ? IS NULL THEN NULL ELSE target_json END,
           change_seq = ?
       WHERE recipient_user_id = ? AND notice_id = ?`,
    );
    for (const row of rows) {
      const shareId = String(row.recipient_share_id);
      const path = (JSON.parse(String(row.target_json)) as NoticeTarget).path;
      const current = reach.sidesOn(shareId);
      if (path === undefined ? current !== null : admits(current, path)) continue;
      const workspaceId = storage.getShare(shareId)?.workspaceId;
      const movedTo = path === undefined || workspaceId === undefined ? null : reach.admitting(workspaceId, path);
      move.run(movedTo, movedTo, nextChangeSeq(storage, recipientUserId), recipientUserId, String(row.notice_id));
    }
    storage.db.prepare("UPDATE sync_relay_notice_lists SET reach_token = ? WHERE recipient_user_id = ?")
      .run(reachToken(storage, recipientUserId), recipientUserId);
  });
}

// Makes room for one more row. A sender first gives up its own oldest rows
// past its share of another person's list. A full list then gives up read
// and dismissed rows from any sender, oldest first, and after those only
// unread rows the poster may remove: any for a post to yourself, its own for
// a post to someone else. Tombstones do not count against either limit.
function makeRoom(
  storage: StorageContext,
  recipientUserId: string,
  senderUserId: string | null,
  nowMs: number,
): void {
  const live = (sender: string | null) => Number(storage.db.prepare(
    `SELECT COUNT(*) AS count FROM sync_relay_notices
     WHERE recipient_user_id = ? AND removed_at_ms IS NULL ${sender === null ? "" : "AND sender_user_id = ?"}`,
  ).get(recipientUserId, ...(sender === null ? [] : [sender]))?.count ?? 0);
  let removed = 0;
  if (senderUserId !== null) {
    removed += removeRows(storage, recipientUserId, senderUserId, senderUserId,
      live(senderUserId) - NOTICE_ROWS_PER_SENDER + 1, nowMs);
  }
  const excess = live(null) - NOTICE_LIST_ROW_LIMIT + 1;
  const freed = removeRows(storage, recipientUserId, null, senderUserId, excess, nowMs);
  if (freed < excess) throw relayError("notice_list_full");
  if (removed + freed === 0) return;
  // Past its tombstone limit, a list deletes its oldest tombstones.
  raiseFloors(storage, storage.db.prepare(
    `DELETE FROM sync_relay_notices WHERE rowid IN (
       SELECT rowid FROM sync_relay_notices WHERE recipient_user_id = ? AND removed_at_ms IS NOT NULL
       ORDER BY change_seq DESC LIMIT -1 OFFSET ?)
     RETURNING recipient_user_id, change_seq`,
  ).all(recipientUserId, NOTICE_REMOVED_ROW_LIMIT));
}

// Turns up to `needed` rows into tombstones: read or dismissed rows from
// `markedSender` (anyone's when null), then unread rows from `unreadSender`
// (anyone's when null), oldest first. Each tombstone drops its body and
// target and takes a new change.
function removeRows(
  storage: StorageContext,
  recipientUserId: string,
  markedSender: string | null,
  unreadSender: string | null,
  needed: number,
  nowMs: number,
): number {
  if (needed <= 0) return 0;
  const pick = (sender: string | null, state: string, limit: number) => storage.db.prepare(
    `SELECT notice_id FROM sync_relay_notices
     WHERE recipient_user_id = ? AND removed_at_ms IS NULL AND ${state}
       ${sender === null ? "" : "AND sender_user_id = ?"}
     ORDER BY created_at_ms, notice_id LIMIT ?`,
  ).all(recipientUserId, ...(sender === null ? [] : [sender]), limit).map((row) => String(row.notice_id));
  const noticeIds = pick(markedSender, MARKED, needed);
  if (noticeIds.length < needed) noticeIds.push(...pick(unreadSender, UNREAD, needed - noticeIds.length));
  const tombstone = storage.db.prepare(
    `UPDATE sync_relay_notices
     SET removed_at_ms = ?, body = '', target_json = NULL, expires_at_ms = ?, change_seq = ?
     WHERE recipient_user_id = ? AND notice_id = ?`,
  );
  for (const noticeId of noticeIds) {
    tombstone.run(nowMs, nowMs + NOTICE_REMOVED_RETENTION_MS, nextChangeSeq(storage, recipientUserId),
      recipientUserId, noticeId);
  }
  return noticeIds.length;
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

// Each list's floor rises to the newest change among its deleted rows.
function raiseFloors(storage: StorageContext, deleted: readonly Record<string, unknown>[]): void {
  const floors = new Map<string, number>();
  for (const row of deleted) {
    const recipient = String(row.recipient_user_id);
    floors.set(recipient, Math.max(floors.get(recipient) ?? 0, Number(row.change_seq)));
  }
  const raise = storage.db.prepare(
    "UPDATE sync_relay_notice_lists SET floor_seq = max(floor_seq, ?) WHERE recipient_user_id = ?",
  );
  for (const [recipient, floor] of floors) raise.run(floor, recipient);
}

function nextChangeSeq(storage: StorageContext, recipientUserId: string): number {
  const row = storage.db.prepare(
    `INSERT INTO sync_relay_notice_lists (recipient_user_id, change_seq, floor_seq, reach_token)
     VALUES (?, 1, 0, NULL)
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
    removed: row.removed_at_ms !== null,
  };
}
