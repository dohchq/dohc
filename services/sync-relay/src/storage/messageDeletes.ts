import { isWorkspaceGroup } from "@dohc/security-contract/chat-wire-ids";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { stableJsonStringify } from "../canonicalJson";
import {
  MESSAGE_DELETE_OP_KIND,
  MESSAGE_DELETE_ORIGIN,
  MESSAGE_TOMBSTONE_OP_KIND,
  personalAgentOrigin,
} from "../relayLogInputs";
import { workspaceFileReach } from "../workspaceReach";
import type { StorageContext } from "./context";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import { removeChatMessageNotices } from "./notices";
import {
  findChannelCreateKind,
  findThreadCreateChannelWireId,
  findThreadFirstMessageId,
} from "./objectIndex";
import { commentFileOf, type CommentFile, type PersonalCredential } from "./personalAgentChat";
import { personalReachIn, readPersonalAuthority } from "./personalAgents";
import { rowToLogRow } from "./rows";
import type { SqliteDb, SyncRelayLogRow } from "./types";
import { workspaceRoleOf } from "./workspaceMembers";

// Deleted chat messages (docs/engineering/plans/workspace-members.md, "Moderation").
//
// The relay is the only writer. A delete rewrites every append row of the
// message, at every origin, into a `chat.message.tombstone` at the same
// coordinate, keeps a row here for each, and appends one `chat.message.delete`
// that every copy pulls. Rows here are never removed while the workspace
// exists, so their count only grows.
//
// The two digests serve only retries of the deleted append. No pull, page,
// link read or agent route selects them: a digest would let a later reader
// confirm a guessed message.

const MARKER = "deleted-messages-v1";
const TABLE = "sync_relay_deleted_messages";
const SCHEMA = {
  [TABLE]: `CREATE TABLE ${TABLE} (
  relay_seq INTEGER PRIMARY KEY REFERENCES sync_relay_log(relay_seq) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  deleted_at_ms INTEGER NOT NULL CHECK (deleted_at_ms >= 0),
  deleted_by TEXT NOT NULL,
  append_sha256 TEXT NOT NULL CHECK (length(append_sha256) = 64),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64)
) STRICT`,
  idx_sync_relay_deleted_messages_message: `CREATE INDEX idx_sync_relay_deleted_messages_message
  ON ${TABLE}(workspace_id, thread_id, message_id, relay_seq)`,
} as const;

const normalize = (sql: string) => sql.trim().replace(/\s+/gu, " ");

export function initializeDeletedMessageSchema(db: SqliteDb): void {
  const assert = () => {
    for (const [name, sql] of Object.entries(SCHEMA)) {
      const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
      if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql))
        throw new Error("deleted message schema is missing or damaged");
    }
  };
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER))
    return assert();
  for (const name of Object.keys(SCHEMA)) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name))
      throw new Error("unmarked deleted message schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assert();
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

/** How many coordinates the workspace has deleted. Rows are only added, so a change means a new delete. */
export function deletedMessageCount(storage: StorageContext, workspaceId: string): number {
  return Number(
    storage.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE workspace_id = ?`).get(workspaceId)
      ?.n ?? 0,
  );
}

/** Whether the message was deleted. */
export function messageDeleted(
  storage: StorageContext,
  workspaceId: string,
  threadId: string,
  messageId: string,
): boolean {
  return !!storage.db
    .prepare(
      `SELECT 1 FROM ${TABLE} WHERE workspace_id = ? AND thread_id = ? AND message_id = ? LIMIT 1`,
    )
    .get(workspaceId, threadId, messageId);
}

export const deletedMessageKey = (message: { threadId: string; messageId: string }) =>
  JSON.stringify([message.threadId, message.messageId]);

/** When each of these messages was deleted, by `deletedMessageKey`. A message still there has no entry. */
export function deletedMessageTimes(
  storage: StorageContext,
  workspaceId: string,
  messages: readonly { threadId: string; messageId: string }[],
): Map<string, number> {
  const read = storage.db.prepare(
    `SELECT deleted_at_ms FROM ${TABLE} WHERE workspace_id = ? AND thread_id = ? AND message_id = ?
     ORDER BY relay_seq LIMIT 1`,
  );
  const times = new Map<string, number>();
  for (const message of messages) {
    const key = deletedMessageKey(message);
    if (times.has(key)) continue;
    const row = read.get(workspaceId, message.threadId, message.messageId);
    if (row) times.set(key, Number(row.deleted_at_ms));
  }
  return times;
}

/** The thread's earliest deleted coordinate, or null when none of its messages was deleted. */
export function firstDeletedInThread(
  storage: StorageContext,
  workspaceId: string,
  threadId: string,
): { relaySeq: number; messageId: string } | null {
  const row = storage.db
    .prepare(
      `SELECT relay_seq, message_id FROM ${TABLE} WHERE workspace_id = ? AND thread_id = ?
     ORDER BY relay_seq LIMIT 1`,
    )
    .get(workspaceId, threadId);
  return row ? { relaySeq: Number(row.relay_seq), messageId: String(row.message_id) } : null;
}

/**
 * Whether the relay deleted the thread's first message, by the rule
 * `findThreadFirstMessageId` reads. A thread's title often repeats that
 * message's first line, so a reader other than the owner's computers then
 * reads the thread with no title.
 */
export function threadFirstMessageDeleted(
  storage: StorageContext,
  workspaceId: string,
  threadId: string,
): boolean {
  const deleted = firstDeletedInThread(storage, workspaceId, threadId);
  return (
    deleted !== null &&
    findThreadFirstMessageId(storage, workspaceId, threadId) === deleted.messageId
  );
}

/** The digests of a deleted coordinate's append, for a retry of it, or null. */
export function deletedAppendDigests(
  storage: StorageContext,
  relaySeq: number,
): { appendSha256: string; bodySha256: string } | null {
  const row = storage.db
    .prepare(`SELECT append_sha256, body_sha256 FROM ${TABLE} WHERE relay_seq = ?`)
    .get(relaySeq);
  return row
    ? { appendSha256: String(row.append_sha256), bodySha256: String(row.body_sha256) }
    : null;
}

// The fields a deleted message keeps: who wrote it, when, where, and what it
// answered. The body, mentions, work report, reported agent, chain depth and
// every link or agent connection field go.
const TOMBSTONE_FIELDS = [
  "messageId",
  "threadId",
  "parentMessageId",
  "authorKind",
  "authorDisplayName",
  "authorOwnerDisplayName",
  "authorUserId",
  "createdAtMs",
] as const;

function tombstonePayloadJson(appendPayloadJson: string, deletedAtMs: number): string {
  const payload = JSON.parse(appendPayloadJson) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of TOMBSTONE_FIELDS) if (payload[key] !== undefined) kept[key] = payload[key];
  return stableJsonStringify({ ...kept, deletedAtMs });
}

function bodySha256(appendPayloadJson: string): string {
  const body = (JSON.parse(appendPayloadJson) as { body?: unknown }).body;
  return sha256Hex(typeof body === "string" ? body : "");
}

/**
 * Turns the append at `relaySeq` into its tombstone and keeps its digests.
 * The coordinate, the recorded time and the admitted author snapshot stay.
 */
function tombstoneRow(
  storage: StorageContext,
  row: SyncRelayLogRow,
  deleted: { deletedAtMs: number; deletedBy: string },
): void {
  const payloadJson = tombstonePayloadJson(row.payloadJson, deleted.deletedAtMs);
  recordDeletedCopy(storage, {
    relaySeq: row.relaySeq,
    workspaceId: row.workspaceId,
    appendPayloadJson: row.payloadJson,
    ...deleted,
  });
  storage.db
    .prepare("UPDATE sync_relay_log SET op_kind = ?, payload_json = ? WHERE relay_seq = ?")
    .run(MESSAGE_TOMBSTONE_OP_KIND, payloadJson, row.relaySeq);
  // The usage triggers count a row's payload when it is inserted and deleted.
  storage.db
    .prepare(
      "UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + ? WHERE workspace_id = ?",
    )
    .run(Buffer.byteLength(payloadJson) - Buffer.byteLength(row.payloadJson), row.workspaceId);
}

function recordDeletedCopy(
  storage: StorageContext,
  input: {
    relaySeq: number;
    workspaceId: string;
    appendPayloadJson: string;
    deletedAtMs: number;
    deletedBy: string;
  },
): void {
  const { messageId, threadId } = JSON.parse(input.appendPayloadJson) as Record<string, unknown>;
  storage.db
    .prepare(
      `INSERT INTO ${TABLE} (relay_seq, workspace_id, message_id, thread_id, deleted_at_ms,
       deleted_by, append_sha256, body_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.relaySeq,
      input.workspaceId,
      String(messageId),
      String(threadId),
      input.deletedAtMs,
      input.deletedBy,
      sha256Hex(input.appendPayloadJson),
      bodySha256(input.appendPayloadJson),
    );
}

/**
 * The backstop for an append of a deleted message at a new coordinate. No
 * known path sends one. The append is stored as a tombstone at once, with its
 * own row here; the caller records the row after it inserts the op.
 */
export function tombstoneForDeletedAppend(
  storage: StorageContext,
  workspaceId: string,
  appendPayloadJson: string,
): { payloadJson: string; record(relaySeq: number): void } | null {
  let threadId: unknown, messageId: unknown;
  try {
    ({ threadId, messageId } = JSON.parse(appendPayloadJson) as Record<string, unknown>);
  } catch {
    return null;
  }
  if (typeof threadId !== "string" || typeof messageId !== "string") return null;
  const first = storage.db
    .prepare(
      `SELECT deleted_at_ms, deleted_by FROM ${TABLE}
     WHERE workspace_id = ? AND thread_id = ? AND message_id = ? ORDER BY relay_seq LIMIT 1`,
    )
    .get(workspaceId, threadId, messageId);
  if (!first) return null;
  const deleted = { deletedAtMs: Number(first.deleted_at_ms), deletedBy: String(first.deleted_by) };
  return {
    payloadJson: tombstonePayloadJson(appendPayloadJson, deleted.deletedAtMs),
    record: (relaySeq) =>
      recordDeletedCopy(storage, { relaySeq, workspaceId, appendPayloadJson, ...deleted }),
  };
}

/** Who asks to delete: an account, or a personal agent by the credential its request read. */
export type MessageDeleteActor =
  | { kind: "account"; userId: string }
  | { kind: "personal-agent"; credential: PersonalCredential };

export type DeleteWorkspaceMessageResult =
  | {
      ok: true;
      /** The message was already deleted; nothing changed. */
      repeated: boolean;
      /** The tombstone at the message's first coordinate, as the relay serves it. */
      tombstone: { relaySeq: number; payload: Record<string, unknown> };
    }
  | { ok: false; reason: "not-found" };

type MessagePlace = { kind: "group" } | { kind: "comment"; file: CommentFile };

// A Group or a file's Comment thread. General, direct messages, agent chats
// and threads on no file are not places a delete reaches.
function placeOf(storage: StorageContext, workspaceId: string, threadId: string) {
  const channelWireId = findThreadCreateChannelWireId(storage, workspaceId, threadId);
  if (typeof channelWireId === "string")
    return isWorkspaceGroup(
      channelWireId,
      findChannelCreateKind(storage, workspaceId, channelWireId),
    )
      ? ({ kind: "group" } satisfies MessagePlace)
      : null;
  const file = commentFileOf(storage, workspaceId, threadId);
  return file ? ({ kind: "comment", file } satisfies MessagePlace) : null;
}

// What a member reads through the workspace share: every Group, and the
// Comments of each current file its file reach shows. On the restack onto
// per-target access, this reads the member's reach for this Group or file.
function memberReads(storage: StorageContext, workspaceId: string, place: MessagePlace): boolean {
  if (place.kind === "group") return true;
  const path = storage.objectCurrentPath(workspaceId, place.file.objectId);
  return (
    typeof path === "string" &&
    visibleSharePath(workspaceFileReach({ kind: "workspace", access: "view" }), path) === path
  );
}

// The actor's key for `deleted_by`, or null when
// the relay does not admit the actor to delete this message.
function admittedActor(
  storage: StorageContext,
  workspaceId: string,
  actor: MessageDeleteActor,
  first: SyncRelayLogRow,
  place: MessagePlace,
  nowMs: number,
): string | null {
  if (actor.kind === "personal-agent") {
    const { check, fenceEpoch, connectionId } = actor.credential;
    const connection = readPersonalAuthority(storage, check, fenceEpoch, nowMs);
    if (!connection || connection.connectionId !== connectionId) return null;
    // On the restack onto per-target access, this also reads the agent's reach for this place.
    if (!personalReachIn(storage, connection, workspaceId)) return null;
    // An agent deletes only its own messages, whatever its person's role.
    return first.originId === personalAgentOrigin(connection.agentId)
      ? `personal-agent:${connection.agentId}`
      : null;
  }
  const role = workspaceRoleOf(storage, workspaceId, actor.userId);
  if (!role) return null;
  const key = `account:${actor.userId}`;
  if (role.role === "owner") return key;
  if (!memberReads(storage, workspaceId, place)) return null;
  if (role.role === "admin") return key;
  // Own means the relay admitted the row for this account, never a payload field.
  return first.admittedAuthorSnapshot?.some(
    (author) => author.kind === "human" && author.humanId === actor.userId,
  )
    ? key
    : null;
}

function messageRows(
  storage: StorageContext,
  sql: string,
  ...params: (string | number)[]
): SyncRelayLogRow[] {
  return storage.db
    .prepare(sql)
    .all(...params)
    .map(rowToLogRow);
}

/**
 * Deletes one message in a Group or a file's Comments. Every caller, the
 * owner included, deletes here; copies learn of it by pull. The role, reach
 * and authorship are read inside the transaction that deletes. Every refusal
 * reads as not-found, so a delete never confirms that a hidden message
 * exists or was deleted.
 */
export function deleteWorkspaceMessage(
  storage: StorageContext,
  input: {
    workspaceId: string;
    threadId: string;
    messageId: string;
    actor: MessageDeleteActor;
    nowMs: number;
  },
): DeleteWorkspaceMessageResult {
  const { workspaceId, threadId, messageId } = input;
  const nowMs = Math.trunc(input.nowMs);
  return storage.tx((): DeleteWorkspaceMessageResult => {
    const tombstones = messageRows(
      storage,
      `SELECT l.* FROM ${TABLE} d JOIN sync_relay_log l ON l.relay_seq = d.relay_seq
       WHERE d.workspace_id = ? AND d.thread_id = ? AND d.message_id = ? ORDER BY d.relay_seq`,
      workspaceId,
      threadId,
      messageId,
    );
    const rows =
      tombstones.length > 0
        ? tombstones
        : messageRows(
            storage,
            `SELECT * FROM sync_relay_log INDEXED BY idx_push_message_identity
             WHERE workspace_id = ? AND json_extract(payload_json, '$.threadId') = ?
               AND json_extract(payload_json, '$.messageId') = ?
               AND op_kind = 'chat.message.append' AND json_valid(payload_json)
             ORDER BY relay_seq`,
            workspaceId,
            threadId,
            messageId,
          );
    const first = rows[0];
    if (!first) return { ok: false, reason: "not-found" };
    const place = placeOf(storage, workspaceId, threadId);
    const actorKey = place && admittedActor(storage, workspaceId, input.actor, first, place, nowMs);
    if (!actorKey) return { ok: false, reason: "not-found" };
    if (tombstones.length > 0)
      return {
        ok: true,
        repeated: true,
        tombstone: { relaySeq: first.relaySeq, payload: JSON.parse(first.payloadJson) },
      };

    const deleted = { deletedAtMs: nowMs, deletedBy: actorKey };
    for (const row of rows) {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      tombstoneRow(storage, row, deleted);
      // A Notice keeps a copy of the body. Its key comes from the stored
      // payload, as `noticeChatMessage` wrote it, never from the snapshot.
      if (payload.authorKind === "human" && typeof payload.authorUserId === "string")
        removeChatMessageNotices(storage, {
          senderUserId: payload.authorUserId,
          relaySeq: row.relaySeq,
          nowMs,
        });
    }
    appendLogBatchInTransaction(storage, {
      workspaceId,
      originId: MESSAGE_DELETE_ORIGIN,
      ops: [
        {
          originSeq: maxOriginSeq(storage, workspaceId, MESSAGE_DELETE_ORIGIN) + 1,
          opKind: MESSAGE_DELETE_OP_KIND,
          payloadJson: stableJsonStringify({ messageId, threadId, deletedAtMs: nowMs }),
          recordedAtMs: nowMs,
        },
      ],
    });
    return {
      ok: true,
      repeated: false,
      tombstone: {
        relaySeq: first.relaySeq,
        payload: JSON.parse(tombstonePayloadJson(first.payloadJson, nowMs)),
      },
    };
  });
}
