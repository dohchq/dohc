import { DIRECT_PAGE_MAX, DIRECT_PREVIEW_MAX_CHARS, MAX_DIRECT_PEOPLE, type DirectMemberPick } from "@dohc/security-contract/direct-messages";
import { accountIsFenced } from "./accountDeletion";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";
import { workspaceRoleOf } from "./workspaceMembers";

// Direct messages (docs/engineering/plans/workspace-members.md, "Chats").
//
// A conversation belongs to a set of accounts on this relay, and to no
// workspace. `people_key` is that set at creation, as a sorted JSON array,
// so one set of people has one conversation. A person reaches a
// conversation only through their `direct_people` row; a workspace
// membership matters only when someone picks a person from its member list.
//
// A block stops the blocked person's new messages reaching the blocker. In a
// two-person conversation the relay refuses them. In a larger one it stores
// them with a `direct_hidden` row for the blocker, and every read, preview,
// count, and wake leaves them out for good. Unblocking shows nothing that was
// hidden.

const MARKER = "direct-messages-v1";
const CONVERSATIONS = "sync_relay_direct_conversations";
const PEOPLE = "sync_relay_direct_people";
const MESSAGES = "sync_relay_direct_messages";
const HIDDEN = "sync_relay_direct_hidden";
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

const SCHEMA = {
  [CONVERSATIONS]: `CREATE TABLE ${CONVERSATIONS} (
  conversation_id TEXT PRIMARY KEY CHECK (length(conversation_id) BETWEEN 1 AND 128),
  people_key TEXT NOT NULL UNIQUE CHECK (json_valid(people_key) AND json_type(people_key) = 'array'),
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
  [HIDDEN]: `CREATE TABLE ${HIDDEN} (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id, seq),
  FOREIGN KEY (conversation_id, seq) REFERENCES ${MESSAGES}(conversation_id, seq) ON DELETE CASCADE
) STRICT, WITHOUT ROWID`,
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
    if (typeof row?.sql !== "string" || normalize(row.sql) !== normalize(sql)) throw new Error("direct message schema is missing or damaged");
  }
}

export function initializeDirectMessageSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assertSchema(db);
    return;
  }
  for (const name of Object.keys(SCHEMA)) {
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name)) throw new Error("unmarked direct message schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(MARKER, Date.now());
}

export interface DirectPersonRow { personId: string; name: string | null; blocked: boolean }
export interface DirectMessageRow { seq: number; messageId: string; authorId: string; authorName: string | null; body: string; createdAtMs: number }
export interface DirectConversationRow { conversationId: string; people: DirectPersonRow[]; last: DirectMessageRow | null; unread: number; blocked: boolean }

export type DirectSendOutcome =
  | { ok: true; conversationId: string; seq: number; wake: string[] }
  | { ok: false; reason: "not_found" | "blocked" | "alone" | "message_id_taken" | "rate_limited" | "limit_reached" };

const peopleKey = (userIds: readonly string[]) => JSON.stringify([...new Set(userIds)].sort());

function nameOf(storage: StorageContext, userId: string): string | null {
  const row = storage.db.prepare("SELECT display_name FROM sync_relay_account_names WHERE user_id = ?").get(userId);
  return row ? String(row.display_name) : null;
}

function isPerson(storage: StorageContext, conversationId: string, userId: string): boolean {
  return !!storage.db.prepare(`SELECT 1 FROM ${PEOPLE} WHERE conversation_id = ? AND user_id = ?`).get(conversationId, userId);
}

function peopleOf(storage: StorageContext, conversationId: string): string[] {
  const row = storage.db.prepare(`SELECT people_key FROM ${CONVERSATIONS} WHERE conversation_id = ?`).get(conversationId);
  return row ? (JSON.parse(String(row.people_key)) as string[]) : [];
}

function blocks(storage: StorageContext, blocker: string, blocked: string): boolean {
  return !!storage.db.prepare(`SELECT 1 FROM ${BLOCKS} WHERE blocker_user_id = ? AND blocked_user_id = ?`).get(blocker, blocked);
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
 * The accounts behind people picked from member lists, with the caller. Null
 * unless the caller is in every named workspace now and every pick is its
 * owner or a current member there, so a refusal never says which pick failed.
 */
export function resolveDirectPicks(storage: StorageContext, callerUserId: string, picks: readonly DirectMemberPick[]): string[] | null {
  return storage.readTx(() => {
    if (accountIsFenced(storage, callerUserId)) return null;
    const userIds = new Set([callerUserId]);
    for (const pick of picks) {
      if (!workspaceRoleOf(storage, pick.workspaceId, callerUserId)) return null;
      const userId = pick.memberId === "owner"
        ? storage.db.prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?").get(pick.workspaceId)?.owner_user_id
        : storage.db.prepare(`SELECT user_id FROM sync_relay_workspace_members WHERE workspace_id = ? AND member_id = ? AND state = 'active'`)
          .get(pick.workspaceId, pick.memberId)?.user_id;
      if (typeof userId !== "string") return null;
      const role = workspaceRoleOf(storage, pick.workspaceId, userId);
      if (!role || role.memberId !== pick.memberId) return null;
      userIds.add(userId);
    }
    if (userIds.size < 2 || userIds.size > MAX_DIRECT_PEOPLE) return null;
    return [...userIds].sort();
  });
}

/** The conversation this exact set of people already has, if the caller is still in it. */
export function findDirectConversation(storage: StorageContext, callerUserId: string, userIds: readonly string[]): string | null {
  const row = storage.db.prepare(`SELECT conversation_id FROM ${CONVERSATIONS} WHERE people_key = ?`).get(peopleKey(userIds));
  const conversationId = row ? String(row.conversation_id) : null;
  return conversationId && isPerson(storage, conversationId, callerUserId) ? conversationId : null;
}

export function directPeople(storage: StorageContext, viewerUserId: string, userIds: readonly string[]): DirectPersonRow[] {
  return userIds.filter((userId) => userId !== viewerUserId)
    .map((userId) => ({ personId: userId, name: nameOf(storage, userId), blocked: blocks(storage, viewerUserId, userId) }));
}

/**
 * Stores one message. With `userIds` it finds or creates that set's
 * conversation; a new one is refused when anyone in it blocks the caller.
 * A retried `messageId` with the same author and body answers its first seq.
 */
export function sendDirectMessage(storage: StorageContext, input: {
  callerUserId: string;
  target: { conversationId: string } | { userIds: readonly string[] };
  messageId: string;
  body: string;
  nowMs: number;
  newId: () => string;
}): DirectSendOutcome {
  return storage.tx((): DirectSendOutcome => {
    const caller = input.callerUserId;
    if (accountIsFenced(storage, caller)) return { ok: false, reason: "not_found" };
    let conversationId: string | null = null;
    let create: { key: string; userIds: string[] } | null = null;
    if ("conversationId" in input.target) {
      if (!isPerson(storage, input.target.conversationId, caller)) return { ok: false, reason: "not_found" };
      conversationId = input.target.conversationId;
    } else {
      const userIds = [...new Set(input.target.userIds)].sort();
      if (!userIds.includes(caller) || userIds.length < 2 || userIds.length > MAX_DIRECT_PEOPLE) return { ok: false, reason: "not_found" };
      const key = peopleKey(userIds);
      const existing = storage.db.prepare(`SELECT conversation_id FROM ${CONVERSATIONS} WHERE people_key = ?`).get(key);
      if (existing) {
        conversationId = String(existing.conversation_id);
        if (!isPerson(storage, conversationId, caller)) return { ok: false, reason: "not_found" };
      } else {
        if (userIds.some((userId) => userId !== caller && (blocks(storage, userId, caller) || accountIsFenced(storage, userId)))) {
          return { ok: false, reason: "blocked" };
        }
        create = { key, userIds };
      }
    }
    if (conversationId) {
      const retried = storage.db.prepare(`SELECT seq, author_user_id, body FROM ${MESSAGES} WHERE conversation_id = ? AND message_id = ?`)
        .get(conversationId, input.messageId);
      if (retried) {
        return retried.author_user_id === caller && retried.body === input.body
          ? { ok: true, conversationId, seq: Number(retried.seq), wake: [] }
          : { ok: false, reason: "message_id_taken" };
      }
    }
    // Every limit is checked before anything is written, so a refusal leaves no empty conversation.
    const sentSince = (windowMs: number, firstOnly: boolean) => Number(storage.db.prepare(
      `SELECT count(*) AS n FROM ${MESSAGES} WHERE author_user_id = ? AND created_at_ms > ?${firstOnly ? " AND seq = 1" : ""}`,
    ).get(caller, input.nowMs - windowMs)!.n);
    if (sentSince(DIRECT_SEND_RATE_WINDOW_MS, false) >= DIRECT_SEND_RATE_LIMIT) return { ok: false, reason: "rate_limited" };
    if (create && sentSince(DIRECT_NEW_CONVERSATION_WINDOW_MS, true) >= DIRECT_NEW_CONVERSATION_LIMIT) return { ok: false, reason: "rate_limited" };
    const bytes = Buffer.byteLength(input.body);
    const stored = Number(storage.db.prepare(`SELECT stored_bytes FROM ${USAGE} WHERE user_id = ?`).get(caller)?.stored_bytes ?? 0);
    if (stored + bytes > DIRECT_STORED_BYTES_LIMIT) return { ok: false, reason: "limit_reached" };

    if (create) {
      conversationId = input.newId();
      storage.db.prepare(`INSERT INTO ${CONVERSATIONS} (conversation_id, people_key, created_at_ms) VALUES (?, ?, ?)`).run(conversationId, create.key, input.nowMs);
      const person = storage.db.prepare(`INSERT INTO ${PEOPLE} (conversation_id, user_id) VALUES (?, ?)`);
      for (const userId of create.userIds) person.run(conversationId, userId);
    }
    const id = conversationId!;
    const others = storage.db.prepare(`SELECT user_id FROM ${PEOPLE} WHERE conversation_id = ? AND user_id <> ?`)
      .all(id, caller).map((row) => String(row.user_id));
    if (others.length === 0) return { ok: false, reason: "alone" };
    const blockers = others.filter((userId) => blocks(storage, userId, caller));
    // Two people: a block refuses. The original set decides, so a deleted account's place still counts.
    if (blockers.length > 0 && peopleOf(storage, id).length === 2) return { ok: false, reason: "blocked" };
    const seq = Number(storage.db.prepare(`UPDATE ${CONVERSATIONS} SET last_seq = last_seq + 1 WHERE conversation_id = ? RETURNING last_seq`)
      .get(id)!.last_seq);
    storage.db.prepare(`INSERT INTO ${MESSAGES} (conversation_id, seq, message_id, author_user_id, body, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, seq, input.messageId, caller, input.body, input.nowMs);
    storage.db.prepare(`INSERT INTO ${USAGE} (user_id, stored_bytes) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET stored_bytes = stored_bytes + excluded.stored_bytes`)
      .run(caller, bytes);
    const hide = storage.db.prepare(`INSERT INTO ${HIDDEN} (conversation_id, seq, user_id) VALUES (?, ?, ?)`);
    for (const userId of blockers) hide.run(id, seq, userId);
    storage.db.prepare(`UPDATE ${PEOPLE} SET read_seq = ? WHERE conversation_id = ? AND user_id = ?`).run(seq, id, caller);
    const wake = [caller, ...others.filter((userId) => !blockers.includes(userId))];
    bump(storage, wake);
    return { ok: true, conversationId: id, seq, wake };
  });
}

const VISIBLE = (viewer: string) => `NOT EXISTS (SELECT 1 FROM ${HIDDEN} h WHERE h.conversation_id = m.conversation_id AND h.seq = m.seq AND h.user_id = ${viewer})`;

function messageRow(storage: StorageContext, row: Record<string, unknown>, preview: boolean): DirectMessageRow {
  const body = String(row.body);
  const authorId = String(row.author_user_id);
  return {
    seq: Number(row.seq), messageId: String(row.message_id), authorId, authorName: nameOf(storage, authorId),
    body: preview ? [...body].slice(0, DIRECT_PREVIEW_MAX_CHARS).join("") : body, createdAtMs: Number(row.created_at_ms),
  };
}

/** The viewer's conversations, newest message first. */
export function listDirectConversations(storage: StorageContext, viewerUserId: string): { revision: number; conversations: DirectConversationRow[] } {
  return storage.readTx(() => {
    if (accountIsFenced(storage, viewerUserId)) return { revision: 0, conversations: [] };
    const rows = storage.db.prepare(
      `SELECT c.conversation_id, c.people_key, p.read_seq,
         (SELECT max(m.seq) FROM ${MESSAGES} m WHERE m.conversation_id = c.conversation_id AND ${VISIBLE("p.user_id")}) AS last_seq,
         (SELECT count(*) FROM ${MESSAGES} m WHERE m.conversation_id = c.conversation_id AND m.seq > p.read_seq
            AND m.author_user_id <> p.user_id AND ${VISIBLE("p.user_id")}) AS unread
       FROM ${PEOPLE} p JOIN ${CONVERSATIONS} c ON c.conversation_id = p.conversation_id
       WHERE p.user_id = ? ORDER BY c.last_seq DESC`,
    ).all(viewerUserId);
    const conversations = rows.map((row): DirectConversationRow & { at: number } => {
      const conversationId = String(row.conversation_id);
      const people = directPeople(storage, viewerUserId, JSON.parse(String(row.people_key)) as string[]);
      const lastRow = row.last_seq === null ? undefined
        : storage.db.prepare(`SELECT * FROM ${MESSAGES} WHERE conversation_id = ? AND seq = ?`).get(conversationId, Number(row.last_seq));
      const last = lastRow ? messageRow(storage, lastRow, true) : null;
      return {
        conversationId, people, last, unread: Number(row.unread),
        blocked: people.length === 1 && people[0]!.blocked,
        at: last?.createdAtMs ?? 0,
      };
    });
    conversations.sort((a, b) => b.at - a.at || a.conversationId.localeCompare(b.conversationId));
    return { revision: directRevision(storage, viewerUserId), conversations: conversations.map(({ at: _at, ...rest }) => rest) };
  });
}

/** One page of messages, oldest first. `before` pages back through history; `after` reads what is new. */
export function readDirectMessages(storage: StorageContext, viewerUserId: string, conversationId: string, page: {
  after?: number; before?: number; limit: number;
}): { messages: DirectMessageRow[]; more: boolean } | null {
  return storage.readTx(() => {
    if (accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId)) return null;
    const limit = Math.max(1, Math.min(DIRECT_PAGE_MAX, page.limit));
    const viewer = "?";
    if (page.after !== undefined) {
      const rows = storage.db.prepare(`SELECT * FROM ${MESSAGES} m WHERE m.conversation_id = ? AND m.seq > ? AND ${VISIBLE(viewer)}
        ORDER BY m.seq LIMIT ?`).all(conversationId, page.after, viewerUserId, limit + 1);
      return { messages: rows.slice(0, limit).map((row) => messageRow(storage, row, false)), more: rows.length > limit };
    }
    const rows = storage.db.prepare(`SELECT * FROM ${MESSAGES} m WHERE m.conversation_id = ? AND m.seq < ? AND ${VISIBLE(viewer)}
      ORDER BY m.seq DESC LIMIT ?`).all(conversationId, page.before ?? Number.MAX_SAFE_INTEGER, viewerUserId, limit + 1);
    return { messages: rows.slice(0, limit).reverse().map((row) => messageRow(storage, row, false)), more: rows.length > limit };
  });
}

/** Moves the viewer's read mark forward, never back. False when the viewer is not in the conversation. */
export function markDirectRead(storage: StorageContext, viewerUserId: string, conversationId: string, seq: number): boolean {
  return storage.tx(() => {
    if (accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId)) return false;
    const changed = storage.db.prepare(`UPDATE ${PEOPLE} SET read_seq = min(?, (SELECT last_seq FROM ${CONVERSATIONS} WHERE conversation_id = ?))
      WHERE conversation_id = ? AND user_id = ? AND read_seq < ?`).run(seq, conversationId, conversationId, viewerUserId, seq);
    if (Number(changed.changes) > 0) bump(storage, [viewerUserId]);
    return true;
  });
}

/** Blocks or unblocks a person the viewer shares this conversation with. False when either is not in it. */
export function setDirectBlock(storage: StorageContext, input: { viewerUserId: string; conversationId: string; personId: string; blocked: boolean; nowMs: number }): boolean {
  return storage.tx(() => {
    const { viewerUserId, conversationId, personId } = input;
    if (personId === viewerUserId || accountIsFenced(storage, viewerUserId) || !isPerson(storage, conversationId, viewerUserId)
      || !peopleOf(storage, conversationId).includes(personId)) return false;
    if (input.blocked) {
      storage.db.prepare(`INSERT INTO ${BLOCKS} (blocker_user_id, blocked_user_id, created_at_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(viewerUserId, personId, input.nowMs);
    } else {
      storage.db.prepare(`DELETE FROM ${BLOCKS} WHERE blocker_user_id = ? AND blocked_user_id = ?`).run(viewerUserId, personId);
    }
    bump(storage, [viewerUserId]);
    return true;
  });
}

/** Account deletion: drops conversations nobody holds any more. Their messages go with them. */
export function dropUnheldDirectConversations(storage: StorageContext): void {
  storage.db.prepare(`DELETE FROM ${CONVERSATIONS} WHERE NOT EXISTS (SELECT 1 FROM ${PEOPLE} p WHERE p.conversation_id = ${CONVERSATIONS}.conversation_id)`).run();
}
