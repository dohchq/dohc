import {
  DIRECT_PAGE_MAX,
  DIRECT_PREVIEW_MAX_CHARS,
  type DirectMemberPick,
} from "@dohc/security-contract/direct-messages";
import { accountIsFenced } from "./accountDeletion";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { workspaceRoleOf } from "./workspaceMembers";

// Direct messages (docs/engineering/plans/workspace-members.md, "Chats").
//
// A conversation is between two accounts on this relay and belongs to no
// workspace. `people_key` is the pair, as a sorted JSON array, so two people
// have one conversation. A person reaches a conversation only through their
// `direct_people` row; a workspace membership matters only when someone picks
// a person from its member list.
//
// A block refuses the blocked person's sends to the blocker. Nothing is hidden.

const MARKER = "direct-messages-v1";
const CONVERSATIONS = "sync_relay_direct_conversations";
const PEOPLE = "sync_relay_direct_people";
const MESSAGES = "sync_relay_direct_messages";
const BLOCKS = "sync_relay_direct_blocks";
const REVISIONS = "sync_relay_direct_revisions";
const USAGE = "sync_relay_direct_usage";

// Direct messages belong to no workspace, so no workspace quota bounds them.
// These bound one account instead, inside the send's transaction.
export const DIRECT_SEND_RATE_LIMIT = 30;
export const DIRECT_SEND_RATE_WINDOW_MS = 60_000;
export const DIRECT_NEW_CONVERSATION_LIMIT = 50;
export const DIRECT_NEW_CONVERSATION_WINDOW_MS = 24 * 60 * 60_000;
export const DIRECT_STORED_BYTES_LIMIT = 64 * 1024 * 1024;
/** What one message costs beyond its words: its row and index entries. */
export const DIRECT_MESSAGE_ROW_BYTES = 256;

const SCHEMA = {
  [CONVERSATIONS]: `CREATE TABLE ${CONVERSATIONS} (
  conversation_id TEXT PRIMARY KEY CHECK (length(conversation_id) BETWEEN 1 AND 128),
  people_key TEXT NOT NULL UNIQUE CHECK (json_valid(people_key) AND json_type(people_key) = 'array' AND json_array_length(people_key) = 2),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0)
) STRICT`,
  [PEOPLE]: `CREATE TABLE ${PEOPLE} (
  conversation_id TEXT NOT NULL REFERENCES ${CONVERSATIONS}(conversation_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  read_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_seq >= 0),
  PRIMARY KEY (conversation_id, user_id)
) STRICT, WITHOUT ROWID`,
  idx_sync_relay_direct_people_account: `CREATE INDEX idx_sync_relay_direct_people_account ON ${PEOPLE}(user_id)`,
  [MESSAGES]: `CREATE TABLE ${MESSAGES} (
  conversation_id TEXT NOT NULL REFERENCES ${CONVERSATIONS}(conversation_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, message_id)
) STRICT`,
  idx_sync_relay_direct_messages_author: `CREATE INDEX idx_sync_relay_direct_messages_author ON ${MESSAGES}(author_user_id, created_at_ms)`,
  // The new-conversation count reads only first messages. Through the author
  // index it would visit every message the account sent that day.
  idx_sync_relay_direct_messages_started: `CREATE INDEX idx_sync_relay_direct_messages_started ON ${MESSAGES}(author_user_id, created_at_ms) WHERE seq = 1`,
  [BLOCKS]: `CREATE TABLE ${BLOCKS} (
  blocker_user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL CHECK (blocked_user_id <> blocker_user_id),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
) STRICT, WITHOUT ROWID`,
  [REVISIONS]: `CREATE TABLE ${REVISIONS} (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1)
) STRICT, WITHOUT ROWID`,
  [USAGE]: `CREATE TABLE ${USAGE} (
  user_id TEXT PRIMARY KEY,
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0)
) STRICT, WITHOUT ROWID`,
} as const;

const normalize = (sql: string) => sql.trim().replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb): void {
  for (const [name, sql] of Object.entries(SCHEMA)) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
    if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql))
      throw new Error("direct message schema is missing or damaged");
  }
}

export function initializeDirectMessageSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assertSchema(db);
    return;
  }
  for (const name of Object.keys(SCHEMA)) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name))
      throw new Error("unmarked direct message schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

export interface DirectPersonRow {
  personId: string;
  name: string | null;
  blocked: boolean;
}
export interface DirectMessageRow {
  seq: number;
  messageId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAtMs: number;
}
export interface DirectConversationRow {
  conversationId: string;
  person: DirectPersonRow;
  last: DirectMessageRow;
  unread: number;
}

export type DirectSendOutcome =
  | { ok: true; conversationId: string; seq: number; wake: string[] }
  | {
      ok: false;
      reason: "not_found" | "blocked" | "message_id_taken" | "rate_limited" | "limit_reached";
    };

const peopleKey = (a: string, b: string) => JSON.stringify([a, b].sort());

function nameOf(storage: StorageContext, userId: string): string | null {
  const row = storage.db
    .prepare("SELECT display_name FROM sync_relay_account_names WHERE user_id = ?")
    .get(userId);
  return row ? String(row.display_name) : null;
}

function isPerson(storage: StorageContext, conversationId: string, userId: string): boolean {
  return !!storage.db
    .prepare(`SELECT 1 FROM ${PEOPLE} WHERE conversation_id = ? AND user_id = ?`)
    .get(conversationId, userId);
}

/** The other person in the pair. The pair is fixed at creation, so a deleted account keeps its place. */
function otherOf(peopleKeyJson: unknown, viewerUserId: string): string {
  const pair = JSON.parse(String(peopleKeyJson)) as [string, string];
  return pair[0] === viewerUserId ? pair[1] : pair[0];
}

function conversationOther(
  storage: StorageContext,
  conversationId: string,
  viewerUserId: string,
): string | null {
  const row = storage.db
    .prepare(`SELECT people_key FROM ${CONVERSATIONS} WHERE conversation_id = ?`)
    .get(conversationId);
  return row ? otherOf(row.people_key, viewerUserId) : null;
}

function blocks(storage: StorageContext, blocker: string, blocked: string): boolean {
  return !!storage.db
    .prepare(`SELECT 1 FROM ${BLOCKS} WHERE blocker_user_id = ? AND blocked_user_id = ?`)
    .get(blocker, blocked);
}

function bump(storage: StorageContext, userIds: readonly string[]): void {
  const statement = storage.db.prepare(`INSERT INTO ${REVISIONS} (user_id, revision) VALUES (?, 1)
    ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1`);
  for (const userId of userIds) statement.run(userId);
}

export function directRevision(storage: StorageContext, userId: string): number {
  const row = storage.db.prepare(`SELECT revision FROM ${REVISIONS} WHERE user_id = ?`).get(userId);
  return row ? Number(row.revision) : 0;
}

/**
 * The account behind a person picked from a member list. Null unless the
 * caller is in that workspace now and the pick is its owner or a current
 * member there other than the caller.
 */
export function resolveDirectPick(
  storage: StorageContext,
  callerUserId: string,
  pick: DirectMemberPick,
): string | null {
  return storage.readTx(() => {
    if (
      accountIsFenced(storage, callerUserId) ||
      !workspaceRoleOf(storage, pick.workspaceId, callerUserId)
    )
      return null;
    const userId =
      pick.memberId === "owner"
        ? storage.db
            .prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?")
            .get(pick.workspaceId)?.owner_user_id
        : storage.db
            .prepare(
              `SELECT user_id FROM sync_relay_workspace_members WHERE workspace_id = ? AND member_id = ? AND state = 'active'`,
            )
            .get(pick.workspaceId, pick.memberId)?.user_id;
    if (typeof userId !== "string" || userId === callerUserId) return null;
    const role = workspaceRoleOf(storage, pick.workspaceId, userId);
    return role && role.memberId === pick.memberId ? userId : null;
  });
}

/** The conversation the caller already has with this person, if any. */
export function findDirectConversation(
  storage: StorageContext,
  callerUserId: string,
  otherUserId: string,
): string | null {
  const row = storage.db
    .prepare(`SELECT conversation_id FROM ${CONVERSATIONS} WHERE people_key = ?`)
    .get(peopleKey(callerUserId, otherUserId));
  const conversationId = row ? String(row.conversation_id) : null;
  return conversationId && isPerson(storage, conversationId, callerUserId) ? conversationId : null;
}

export function directPerson(
  storage: StorageContext,
  viewerUserId: string,
  userId: string,
): DirectPersonRow {
  return {
    personId: userId,
    name: nameOf(storage, userId),
    blocked: blocks(storage, viewerUserId, userId),
  };
}

/**
 * Stores one message. With `personId` it finds or creates the pair's
 * conversation. A send is refused when the other person blocks the caller,
 * or no longer holds the conversation. A retried `messageId` with the same
 * author and body answers its first seq.
 */
export function sendDirectMessage(
  storage: StorageContext,
  input: {
    callerUserId: string;
    target: { conversationId: string } | { personId: string };
    messageId: string;
    body: string;
    nowMs: number;
    newId: () => string;
  },
): DirectSendOutcome {
  return storage.tx((): DirectSendOutcome => {
    const caller = input.callerUserId;
    if (accountIsFenced(storage, caller)) return { ok: false, reason: "not_found" };
    let conversationId: string | null;
    let other: string;
    if ("conversationId" in input.target) {
      conversationId = input.target.conversationId;
      const found = isPerson(storage, conversationId, caller)
        ? conversationOther(storage, conversationId, caller)
        : null;
      if (found === null) return { ok: false, reason: "not_found" };
      other = found;
    } else {
      other = input.target.personId;
      if (other === caller) return { ok: false, reason: "not_found" };
      const existing = storage.db
        .prepare(`SELECT conversation_id FROM ${CONVERSATIONS} WHERE people_key = ?`)
        .get(peopleKey(caller, other));
      conversationId = existing ? String(existing.conversation_id) : null;
      if (conversationId !== null && !isPerson(storage, conversationId, caller))
        return { ok: false, reason: "not_found" };
    }
    if (conversationId !== null) {
      const retried = storage.db
        .prepare(
          `SELECT seq, author_user_id, body FROM ${MESSAGES} WHERE conversation_id = ? AND message_id = ?`,
        )
        .get(conversationId, input.messageId);
      if (retried) {
        return retried.author_user_id === caller && retried.body === input.body
          ? { ok: true, conversationId, seq: Number(retried.seq), wake: [] }
          : { ok: false, reason: "message_id_taken" };
      }
      // A deleted account leaves its conversations.
      if (!isPerson(storage, conversationId, other)) return { ok: false, reason: "not_found" };
    }
    // An account being deleted keeps its rows until the purge, but reads nothing new.
    if (accountIsFenced(storage, other)) return { ok: false, reason: "not_found" };
    if (blocks(storage, other, caller)) return { ok: false, reason: "blocked" };
    // Every limit is checked before anything is written, so a refusal leaves no empty conversation.
    const sentSince = (windowMs: number, firstOnly: boolean) =>
      Number(
        storage.db
          .prepare(
            `SELECT count(*) AS n FROM ${MESSAGES} WHERE author_user_id = ? AND created_at_ms > ?${firstOnly ? " AND seq = 1" : ""}`,
          )
          .get(caller, input.nowMs - windowMs)!.n,
      );
    if (sentSince(DIRECT_SEND_RATE_WINDOW_MS, false) >= DIRECT_SEND_RATE_LIMIT)
      return { ok: false, reason: "rate_limited" };
    if (
      conversationId === null &&
      sentSince(DIRECT_NEW_CONVERSATION_WINDOW_MS, true) >= DIRECT_NEW_CONVERSATION_LIMIT
    )
      return { ok: false, reason: "rate_limited" };
    const bytes = Buffer.byteLength(input.body) + DIRECT_MESSAGE_ROW_BYTES;
    const stored = Number(
      storage.db.prepare(`SELECT stored_bytes FROM ${USAGE} WHERE user_id = ?`).get(caller)
        ?.stored_bytes ?? 0,
    );
    if (stored + bytes > DIRECT_STORED_BYTES_LIMIT) return { ok: false, reason: "limit_reached" };

    if (conversationId === null) {
      conversationId = input.newId();
      storage.db
        .prepare(
          `INSERT INTO ${CONVERSATIONS} (conversation_id, people_key, created_at_ms) VALUES (?, ?, ?)`,
        )
        .run(conversationId, peopleKey(caller, other), input.nowMs);
      const person = storage.db.prepare(
        `INSERT INTO ${PEOPLE} (conversation_id, user_id) VALUES (?, ?)`,
      );
      person.run(conversationId, caller);
      person.run(conversationId, other);
    }
    const id = conversationId;
    const seq = Number(
      storage.db
        .prepare(
          `UPDATE ${CONVERSATIONS} SET last_seq = last_seq + 1 WHERE conversation_id = ? RETURNING last_seq`,
        )
        .get(id)!.last_seq,
    );
    storage.db
      .prepare(
        `INSERT INTO ${MESSAGES} (conversation_id, seq, message_id, author_user_id, body, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, seq, input.messageId, caller, input.body, input.nowMs);
    storage.db
      .prepare(
        `INSERT INTO ${USAGE} (user_id, stored_bytes) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET stored_bytes = stored_bytes + excluded.stored_bytes`,
      )
      .run(caller, bytes);
    // The sender's read mark stays: a message the other person sent just before may not have reached them.
    const wake = [caller, other];
    bump(storage, wake);
    return { ok: true, conversationId: id, seq, wake };
  });
}

function messageRow(
  storage: StorageContext,
  row: Record<string, unknown>,
  preview: boolean,
): DirectMessageRow {
  const body = String(row.body);
  const authorId = String(row.author_user_id);
  return {
    seq: Number(row.seq),
    messageId: String(row.message_id),
    authorId,
    authorName: nameOf(storage, authorId),
    body: preview ? [...body].slice(0, DIRECT_PREVIEW_MAX_CHARS).join("") : body,
    createdAtMs: Number(row.created_at_ms),
  };
}

/** The viewer's conversations, newest message first. */
export function listDirectConversations(
  storage: StorageContext,
  viewerUserId: string,
): { revision: number; conversations: DirectConversationRow[] } {
  return storage.readTx(() => {
    if (accountIsFenced(storage, viewerUserId)) return { revision: 0, conversations: [] };
    const rows = storage.db
      .prepare(
        `SELECT c.people_key, m.*,
         (SELECT count(*) FROM ${MESSAGES} u WHERE u.conversation_id = c.conversation_id AND u.seq > p.read_seq
            AND u.author_user_id <> p.user_id) AS unread
       FROM ${PEOPLE} p
       JOIN ${CONVERSATIONS} c ON c.conversation_id = p.conversation_id
       JOIN ${MESSAGES} m ON m.conversation_id = c.conversation_id AND m.seq = c.last_seq
       WHERE p.user_id = ? ORDER BY m.created_at_ms DESC, c.conversation_id`,
      )
      .all(viewerUserId);
    const conversations = rows.map((row): DirectConversationRow => ({
      conversationId: String(row.conversation_id),
      person: directPerson(storage, viewerUserId, otherOf(row.people_key, viewerUserId)),
      last: messageRow(storage, row, true),
      unread: Number(row.unread),
    }));
    return { revision: directRevision(storage, viewerUserId), conversations };
  });
}

/** One page of messages, oldest first. `before` pages back through history; `after` reads what is new. */
export function readDirectMessages(
  storage: StorageContext,
  viewerUserId: string,
  conversationId: string,
  page: {
    after?: number;
    before?: number;
    limit: number;
  },
): { messages: DirectMessageRow[]; more: boolean } | null {
  return storage.readTx(() => {
    if (accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId))
      return null;
    const limit = Math.max(1, Math.min(DIRECT_PAGE_MAX, page.limit));
    if (page.after !== undefined) {
      const rows = storage.db
        .prepare(
          `SELECT * FROM ${MESSAGES} WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(conversationId, page.after, limit + 1);
      return {
        messages: rows.slice(0, limit).map((row) => messageRow(storage, row, false)),
        more: rows.length > limit,
      };
    }
    const rows = storage.db
      .prepare(
        `SELECT * FROM ${MESSAGES} WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, page.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    return {
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((row) => messageRow(storage, row, false)),
      more: rows.length > limit,
    };
  });
}

/** Moves the viewer's read mark forward, never back. False when the viewer is not in the conversation. */
export function markDirectRead(
  storage: StorageContext,
  viewerUserId: string,
  conversationId: string,
  seq: number,
): boolean {
  return storage.tx(() => {
    if (accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId))
      return false;
    const changed = storage.db
      .prepare(`UPDATE ${PEOPLE} SET read_seq = min(?, (SELECT last_seq FROM ${CONVERSATIONS} WHERE conversation_id = ?))
      WHERE conversation_id = ? AND user_id = ? AND read_seq < ?`)
      .run(seq, conversationId, conversationId, viewerUserId, seq);
    if (Number(changed.changes) > 0) bump(storage, [viewerUserId]);
    return true;
  });
}

/** Blocks or unblocks the other person in this conversation. False when the viewer is not in it. */
export function setDirectBlock(
  storage: StorageContext,
  input: { viewerUserId: string; conversationId: string; blocked: boolean; nowMs: number },
): boolean {
  return storage.tx(() => {
    const { viewerUserId, conversationId } = input;
    if (accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId))
      return false;
    const other = conversationOther(storage, conversationId, viewerUserId)!;
    if (input.blocked) {
      storage.db
        .prepare(
          `INSERT INTO ${BLOCKS} (blocker_user_id, blocked_user_id, created_at_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(viewerUserId, other, input.nowMs);
    } else {
      storage.db
        .prepare(`DELETE FROM ${BLOCKS} WHERE blocker_user_id = ? AND blocked_user_id = ?`)
        .run(viewerUserId, other);
    }
    bump(storage, [viewerUserId]);
    return true;
  });
}

/** Account deletion: drops conversations nobody holds any more. Their messages go with them. */
export function dropUnheldDirectConversations(storage: StorageContext): void {
  storage.db
    .prepare(
      `DELETE FROM ${CONVERSATIONS} WHERE NOT EXISTS (SELECT 1 FROM ${PEOPLE} p WHERE p.conversation_id = ${CONVERSATIONS}.conversation_id)`,
    )
    .run();
}
