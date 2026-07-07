import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  ChannelThreadSummary,
  ChatActor,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
  ChatThreadReadState,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
  SyncApplyResult,
  SyncReplicationEnvelope,
} from "@dohc/workspace-contracts/engine";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  trackEngineDbHandleForTest,
} from "./engineDbSchema";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  type WorkspaceId,
  type WorkspaceObjectId,
} from "./versionedTextStore";
import {
  upsertChatMessageSearchIndex,
  upsertThreadHeaderSearchIndex,
} from "./searchIndex";
import {
  THREAD_SNIPPET_TITLE_MAX_CHARS,
  UNTITLED_THREAD_FALLBACK_TITLE,
  threadDisplayTitle,
  threadSnippetTitle,
} from "./chatThreadTitle";
import {
  ackReplicationPeer,
  appliedApplyResult,
  journalLocalReplicationOp,
  readReplicationAckedSeq,
  skippedApplyResult,
  type ChatChannelCreatePayload,
  type ChatMessageAppendPayload,
  type ChatThreadCreatePayload,
} from "./syncReplication";

export const LINKED_CHAT_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;
export const LINKED_CHAT_PROJECTION_KIND = "thread";

export type {
  ChannelThreadSummary,
  ChatActor,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
  ChatThreadReadState,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
  SyncApplyResult,
  SyncReplicationEnvelope,
} from "@dohc/workspace-contracts/engine";

export const GENERAL_CHANNEL_NAME = "general";
// Cross-machine identity for the AUTO-CREATED general channel: every store
// mints general independently, so a deterministic well-known wire id is what
// lets those rows converge as ONE channel. Every other channel's wire id is
// its creator's local channel id (globally unique uuid).
export const GENERAL_CHANNEL_WIRE_ID = "channel_wire_general_v1";
// Display-title derivation lives in chatThreadTitle.ts (a leaf shared with
// the search index rebuild); re-exported here so store consumers keep one
// import surface.
export { THREAD_SNIPPET_TITLE_MAX_CHARS, UNTITLED_THREAD_FALLBACK_TITLE, threadSnippetTitle };

export class LinkedChatStoreError extends Error {
  readonly code: LinkedChatStoreErrorCode;

  constructor(code: LinkedChatStoreErrorCode, message: string) {
    super(message);
    this.name = "LinkedChatStoreError";
    this.code = code;
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storePath(rootDir: string): string {
  return join(rootDir, LINKED_CHAT_STORE_RELATIVE_PATH);
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen?: boolean;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function corruptStore(cause?: unknown): LinkedChatStoreError {
  const error = new LinkedChatStoreError("state-corrupt", "Linked chat store is corrupt.");
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function openDatabase(rootDir: string): SqliteDb {
  const path = storePath(resolve(rootDir));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = nodeSqlite();
  let db: SqliteDb;
  try {
    db = trackEngineDbHandleForTest(new DatabaseSync(path));
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    // Schema bootstrap + integrity are shared with versionedTextStore (one
    // engine.db, one DDL owner — see engineDbSchema.ts). Whichever store
    // opens a brand-new workspace first creates the exact same schema.
    initializeOrValidateEngineSchema(db, corruptStore);
    assertEngineSqliteIntegrity(db, corruptStore);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (error instanceof LinkedChatStoreError) throw error;
    throw corruptStore(error);
  }
}

function normalizeWorkspaceId(workspaceId: string): WorkspaceId {
  const normalized = workspaceId.trim();
  if (!normalized) {
    throw new LinkedChatStoreError("invalid-workspace", "Workspace id is required.");
  }
  return normalized;
}

function normalizeObjectId(objectId: string): WorkspaceObjectId {
  const normalized = objectId.trim();
  if (!normalized || normalized.length > 200) {
    throw new LinkedChatStoreError("invalid-path", "Linked file object id is invalid.");
  }
  return normalized;
}

function normalizePathHint(path: string): string {
  const result = validateUserWritePath(path);
  if (!result.ok) {
    throw new LinkedChatStoreError(
      "invalid-path",
      `Invalid linked file path ${JSON.stringify(path)}: ${result.reason}`,
    );
  }
  return result.normalized;
}

function normalizeThreadTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || normalized.length > 200) {
    throw new LinkedChatStoreError("invalid-thread-title", "Thread title is required.");
  }
  return normalized;
}

// Optional-title variant for the fast channel composer: absent/blank means
// "untitled" (stored as ''), which displays as the first-message snippet.
function normalizeOptionalThreadTitle(title: string | undefined): string {
  if (title === undefined || title.trim() === "") return "";
  return normalizeThreadTitle(title);
}

function normalizeChannelName(name: string): string {
  const normalized = name.normalize("NFC").trim();
  // PROJECTION_FIELD_CONTROL_CHAR is the store's shared control-char class.
  if (!normalized || normalized.length > 80 || PROJECTION_FIELD_CONTROL_CHAR.test(normalized)) {
    throw new LinkedChatStoreError(
      "invalid-channel-name",
      "Channel name must be 1-80 characters without control characters.",
    );
  }
  return normalized;
}

// The slug is a LOOKUP ALIAS derived from the display name — lowercase,
// dash-separated, ascii-safe. Durable rows key on channelId, never the slug,
// so a future rename cannot fork channel state.
export function channelSlugForName(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeChannelKind(kind: ChatChannelKind | undefined): ChatChannelKind {
  if (kind === undefined) return "channel";
  if (kind !== "channel" && kind !== "dm") {
    throw new LinkedChatStoreError("invalid-channel-kind", "Channel kind is invalid.");
  }
  return kind;
}

function normalizeReadSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LinkedChatStoreError(
      "invalid-read-cursor",
      "Read cursor sequence must be a non-negative integer.",
    );
  }
  return value;
}

function normalizeExpectedRevision(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LinkedChatStoreError(
      "invalid-read-cursor",
      "Expected read-state revision must be a non-negative integer.",
    );
  }
  return value;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized || normalized.length > 200) {
    throw new LinkedChatStoreError("invalid-sender", "Chat sender display name is required.");
  }
  return normalized;
}

function normalizeActor(actor: ChatActor): ChatActor {
  if (actor.kind !== "human" && actor.kind !== "agent") {
    throw new LinkedChatStoreError("invalid-sender", "Chat sender kind is invalid.");
  }
  return { kind: actor.kind, displayName: normalizeDisplayName(actor.displayName) };
}

function normalizeBody(body: string): string {
  const normalized = body.replace(/\r\n?/g, "\n").trimEnd();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 64 * 1024) {
    throw new LinkedChatStoreError("invalid-message-body", "Message body is required.");
  }
  return normalized;
}

function defaultCreateId(kind: "channel" | "message" | "thread"): string {
  return `${kind}_${randomUUID()}`;
}

const BASE32_LOWERCASE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const PROJECTION_FIELD_CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;

function base32LowercaseNoPadding(bytes: Uint8Array): string {
  let output = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_LOWERCASE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_LOWERCASE_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function normalizeProjectionField(fieldName: string, value: string): string {
  const normalized = value.normalize("NFC");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    PROJECTION_FIELD_CONTROL_CHAR.test(normalized)
  ) {
    throw new LinkedChatStoreError(
      "invalid-path",
      `${fieldName} is invalid for a linked chat projection path.`,
    );
  }
  return normalized;
}

export function linkedChatProjectionPath(input: {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  projectionKind?: string;
}): string {
  const workspaceId = normalizeProjectionField("workspaceId", input.workspaceId);
  const threadId = normalizeProjectionField("threadId", input.threadId);
  const projectionKind = normalizeProjectionField(
    "projectionKind",
    input.projectionKind ?? LINKED_CHAT_PROJECTION_KIND,
  );
  const digest = createHash("sha256")
    .update(`v1\0${workspaceId}\0${threadId}\0${projectionKind}`, "utf8")
    .digest();
  return `.dohc/chats/v1-${base32LowercaseNoPadding(digest)}.md`;
}

// Thread rows are always read through these columns so the display-title
// derivation (untitled -> first-message snippet) and the ownership checks can
// never drift between the list, lookup, and projection paths.
const THREAD_SELECT_COLUMNS = `t.*,
         (SELECT m.body FROM chat_messages m
          WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id
          ORDER BY m.message_order LIMIT 1) AS first_body,
         EXISTS(SELECT 1 FROM chat_channels c
          WHERE c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id)
           AS channel_owner_exists`;
const THREAD_SELECT_SQL = `SELECT ${THREAD_SELECT_COLUMNS} FROM chat_threads t`;

function threadFromRow(row: Record<string, unknown>): ChatThread {
  const linkedObjectId = optionalString(row.linked_object_id);
  const channelId = optionalString(row.channel_id);
  // Exactly-one-owner fail-closed: a hand-edited row claiming BOTH a file
  // link and a channel — or NEITHER (creation enforces one owner, so an
  // ownerless row can only be tampering) — must never render as either. A
  // channel owner must also still EXIST: a thread pointing at a deleted or
  // planted channel id is unreachable-by-navigation state, not a chat.
  if (linkedObjectId && channelId) throw corruptStore();
  if (!linkedObjectId && !channelId) throw corruptStore();
  if (channelId && numberValue(row.channel_owner_exists) !== 1) throw corruptStore();
  const title = threadDisplayTitle(stringValue(row.title), optionalString(row.first_body));
  return {
    id: stringValue(row.thread_id),
    workspaceId: stringValue(row.workspace_id),
    title,
    createdAtMs: numberValue(row.created_at_ms),
    updatedAtMs: numberValue(row.updated_at_ms),
    ...(linkedObjectId
      ? {
          linkedFile: {
            objectId: linkedObjectId,
            ...(optionalString(row.linked_path_hint)
              ? { pathHint: optionalString(row.linked_path_hint) }
              : {}),
            linkedAtMs: numberValue(row.linked_at_ms),
          },
        }
      : {}),
    ...(channelId ? { channelId } : {}),
  };
}

function channelFromRow(row: Record<string, unknown>): ChatChannel {
  const kind = stringValue(row.kind);
  // Fail closed on a corrupt/hand-edited kind, like actorKindValue.
  if (kind !== "channel" && kind !== "dm") throw corruptStore();
  return {
    id: stringValue(row.channel_id),
    workspaceId: stringValue(row.workspace_id),
    name: stringValue(row.name),
    slug: stringValue(row.slug),
    kind,
    createdAtMs: numberValue(row.created_at_ms),
    updatedAtMs: numberValue(row.updated_at_ms),
  };
}

function messageFromRow(row: Record<string, unknown>): ChatMessage {
  return {
    id: stringValue(row.message_id),
    workspaceId: stringValue(row.workspace_id),
    threadId: stringValue(row.thread_id),
    author: {
      kind: actorKindValue(row.author_kind),
      displayName: stringValue(row.author_display_name),
    },
    body: stringValue(row.body),
    createdAtMs: numberValue(row.created_at_ms),
  };
}

// Fail closed on a corrupt/hand-edited author_kind: an unknown kind must
// never render as a valid-looking non-agent message.
function actorKindValue(value: unknown): ChatActor["kind"] {
  const kind = stringValue(value);
  if (kind !== "human" && kind !== "agent") throw corruptStore();
  return kind;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw corruptStore();
  return value;
}

function requireWorkspaceThread(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): ChatThread {
  const row = db
    .prepare(`${THREAD_SELECT_SQL} WHERE t.workspace_id = ? AND t.thread_id = ?`)
    .get(workspaceId, threadId);
  if (row) return threadFromRow(row);
  const other = db
    .prepare("SELECT workspace_id FROM chat_threads WHERE thread_id = ? AND workspace_id <> ?")
    .get(threadId, workspaceId);
  if (other) {
    throw new LinkedChatStoreError(
      "workspace-mismatch",
      `Thread ${threadId} does not belong to workspace ${workspaceId}.`,
    );
  }
  throw new LinkedChatStoreError(
    "thread-not-found",
    `Thread ${threadId} was not found in workspace ${workspaceId}.`,
  );
}

function requireWorkspaceChannel(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  channelId: ChatChannelId,
): ChatChannel {
  const row = db
    .prepare("SELECT * FROM chat_channels WHERE workspace_id = ? AND channel_id = ?")
    .get(workspaceId, channelId);
  if (row) return channelFromRow(row);
  const other = db
    .prepare("SELECT workspace_id FROM chat_channels WHERE channel_id = ? AND workspace_id <> ?")
    .get(channelId, workspaceId);
  if (other) {
    throw new LinkedChatStoreError(
      "workspace-mismatch",
      `Channel ${channelId} does not belong to workspace ${workspaceId}.`,
    );
  }
  throw new LinkedChatStoreError(
    "channel-not-found",
    `Channel ${channelId} was not found in workspace ${workspaceId}.`,
  );
}

// Remote-wire-id -> local-channel-id map (lazy additive, 0P-A gate fix). The
// wire id is the ONLY cross-machine channel identity; the slug stays a lookup
// alias. Locally created channels record their own mapping at creation so an
// importer's lookup covers both local and imported rows.
function recordChannelWireId(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  wireId: string,
  channelId: ChatChannelId,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO chat_channel_wire_ids (workspace_id, wire_id, channel_id) VALUES (?, ?, ?)",
  ).run(workspaceId, wireId, channelId);
}

function channelIdForWireId(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  wireId: string,
): ChatChannelId | undefined {
  const row = db
    .prepare(
      `SELECT m.channel_id
       FROM chat_channel_wire_ids m
       JOIN chat_channels c
         ON c.workspace_id = m.workspace_id
        AND c.channel_id = m.channel_id
       WHERE m.workspace_id = ? AND m.wire_id = ?`,
    )
    .get(workspaceId, wireId);
  return row ? stringValue(row.channel_id) : undefined;
}

function wireIdForChannelId(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  channelId: ChatChannelId,
): string | undefined {
  const row = db
    .prepare(
      `SELECT wire_id FROM chat_channel_wire_ids
       WHERE workspace_id = ? AND channel_id = ?
       ORDER BY wire_id LIMIT 1`,
    )
    .get(workspaceId, channelId);
  return row ? stringValue(row.wire_id) : undefined;
}

// Same slug + DIFFERENT wire id means two distinct channels: the importer
// keeps its local slug and gives the incoming channel a numbered variant,
// mirroring how name collisions are settled elsewhere in the engine.
function nextFreeChannelSlug(db: SqliteDb, workspaceId: WorkspaceId, slug: string): string {
  const taken = (candidate: string) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM chat_channels WHERE workspace_id = ? AND slug = ?")
        .get(workspaceId, candidate),
    );
  if (!taken(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

function messageCountForThread(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM chat_messages WHERE workspace_id = ? AND thread_id = ?",
    )
    .get(workspaceId, threadId);
  return Number(row?.count ?? 0);
}

// Fail closed on a tampered persisted read cursor: negative, non-integer, or
// beyond-safe-integer values must never feed unread math as if valid. An
// OVER-COUNT cursor (> the thread's real message count) is handled separately
// by advanceReadCursor, which clamps and repairs it in place.
function readSequenceValue(value: unknown): number {
  const sequence = numberValue(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw corruptStore();
  return sequence;
}

// Guard for the SQL unread rollups (listChannels): a negative or non-integer
// cursor row would silently INFLATE unread sums inside the aggregate, so the
// read fails closed instead. Over-count rows are fine here — the rollup's
// MAX(..., 0) already reads them as zero unread, and advanceReadCursor
// repairs them on the next mark-read.
function assertReadStateRowsSane(db: SqliteDb, workspaceId: WorkspaceId): void {
  const bad = db
    .prepare(
      `SELECT 1 FROM chat_thread_read_state
       WHERE workspace_id = ?
         AND (last_read_sequence < 0
              OR last_read_sequence <> CAST(last_read_sequence AS INTEGER)
              OR revision < 0
              OR revision <> CAST(revision AS INTEGER))
       LIMIT 1`,
    )
    .get(workspaceId);
  if (bad) throw corruptStore();
}

function readStateForThread(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): ChatThreadReadState {
  const row = db
    .prepare(
      `SELECT last_read_sequence, revision, updated_at_ms
       FROM chat_thread_read_state WHERE workspace_id = ? AND thread_id = ?`,
    )
    .get(workspaceId, threadId);
  if (!row) {
    return { workspaceId, threadId, lastReadSequence: 0, revision: 0, updatedAtMs: 0 };
  }
  return {
    workspaceId,
    threadId,
    lastReadSequence: readSequenceValue(row.last_read_sequence),
    revision: readSequenceValue(row.revision),
    updatedAtMs: numberValue(row.updated_at_ms),
  };
}

function persistReadState(db: SqliteDb, state: ChatThreadReadState): void {
  db.prepare(
    `INSERT INTO chat_thread_read_state (
      workspace_id, thread_id, last_read_sequence, revision, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, thread_id) DO UPDATE SET
      last_read_sequence = excluded.last_read_sequence,
      revision = excluded.revision,
      updated_at_ms = excluded.updated_at_ms`,
  ).run(
    state.workspaceId,
    state.threadId,
    state.lastReadSequence,
    state.revision,
    state.updatedAtMs,
  );
}

// The ONE cursor writer: monotonic (never moves backwards), clamped to the
// thread's real message count, server-owned revision bumped only on an
// APPLIED advance. Callers pass the transaction's db handle.
function advanceReadCursor(input: {
  db: SqliteDb;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  upToSequence: number;
  expectedRevision?: number;
  nowMs: number;
}): ChatThreadReadState {
  let current = readStateForThread(input.db, input.workspaceId, input.threadId);
  if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
    throw new LinkedChatStoreError(
      "read-state-revision-mismatch",
      `Read-state revision ${input.expectedRevision} is stale (current ${current.revision}).`,
    );
  }
  const messageCount = messageCountForThread(input.db, input.workspaceId, input.threadId);
  if (current.lastReadSequence > messageCount) {
    // A tampered/corrupt OVER-COUNT cursor would otherwise make every future
    // advance a no-op (nothing can ever exceed it), leaving unread counts
    // unrepairable. Clamp to the thread's real message count and PERSIST the
    // repair inside this store-owned transaction; the revision holds — a
    // repair is not an applied advance, so CAS callers stay coherent.
    current = { ...current, lastReadSequence: messageCount };
    persistReadState(input.db, current);
  }
  const target = Math.min(input.upToSequence, messageCount);
  if (target <= current.lastReadSequence) return current;
  const next: ChatThreadReadState = {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    lastReadSequence: target,
    revision: current.revision + 1,
    updatedAtMs: input.nowMs,
  };
  persistReadState(input.db, next);
  return next;
}

function formatProjection(input: {
  thread: ChatThread;
  messages: ChatMessage[];
  linkedFileAccess: LinkedChatProjectionFileAccess;
}): string {
  const lines = [`# ${input.thread.title}`, "", "Read-only chat projection.", ""];
  if (input.thread.linkedFile) {
    if (input.linkedFileAccess.kind === "allowed") {
      lines.push(`Linked file: ${input.linkedFileAccess.path}`);
    } else {
      lines.push("Linked file: unavailable");
    }
    lines.push("");
  }
  for (const message of input.messages) {
    const author =
      message.author.kind === "agent"
        ? `${message.author.displayName} (agent)`
        : message.author.displayName;
    lines.push(`## ${author}`);
    lines.push("");
    lines.push(message.body);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function createLinkedChatStore(
  rootDir: string,
  options: LinkedChatStoreOptions = {},
): LinkedChatStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const createId = options.createId ?? defaultCreateId;
  let writeChain: Promise<unknown> = Promise.resolve();
  let dbHandle: SqliteDb | null = null;

  function db(): SqliteDb {
    if (!dbHandle || dbHandle.isOpen === false) {
      // A handle can be closed out from under the store (the test-teardown
      // sweep releases Windows file locks between tests); reopen instead of
      // returning a dead handle.
      dbHandle = openDatabase(rootDir);
    }
    return dbHandle;
  }

  function serialize<T>(task: (db: SqliteDb) => Promise<T>): Promise<T> {
    const run = writeChain.then(() => withTransaction(task), () => withTransaction(task));
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function afterWrites<T>(task: () => Promise<T>): Promise<T> {
    await writeChain;
    return task();
  }

  async function withDb<T>(task: (db: SqliteDb) => T): Promise<T> {
    return task(db());
  }

  async function withTransaction<T>(task: (db: SqliteDb) => Promise<T>): Promise<T> {
    const txDb = db();
    try {
      txDb.exec("BEGIN IMMEDIATE");
      const result = await task(txDb);
      txDb.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        txDb.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  function listMessagesForThread(db: SqliteDb, workspaceId: WorkspaceId, threadId: ChatThreadId) {
    return db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE workspace_id = ? AND thread_id = ?
         ORDER BY message_order`,
      )
      .all(workspaceId, threadId)
      .map(messageFromRow);
  }

  function nextMessageOrder(db: SqliteDb, workspaceId: WorkspaceId, threadId: ChatThreadId): number {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(message_order), -1) + 1 AS next_order
         FROM chat_messages
         WHERE workspace_id = ? AND thread_id = ?`,
      )
      .get(workspaceId, threadId);
    return Number(row?.next_order ?? 0);
  }

  function importedReplicationLogExists(db: SqliteDb, input: SyncReplicationEnvelope): boolean {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM replication_log
           WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
        )
        .get(input.workspaceId, input.originId, input.originSeq),
    );
  }

  function journalImportedReplicationOp(db: SqliteDb, input: SyncReplicationEnvelope): void {
    db.prepare(
      `INSERT OR IGNORE INTO replication_log (
        workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workspaceId,
      input.originId,
      input.originSeq,
      input.opKind,
      JSON.stringify(input.payload),
      input.recordedAtMs,
    );
  }

  return {
    createThread(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const title = normalizeThreadTitle(input.title);
        // Exactly-one-owner at creation: this path creates FILE-LINKED
        // threads only (channel threads go through startChannelThread).
        // Without an owner a thread is unreachable by navigation — readable
        // and indexed but orphaned — so refusing here is what keeps the
        // read-side neither-owner check meaning "tampering", not "legacy".
        if (!input.linkedFile) {
          throw new LinkedChatStoreError(
            "invalid-thread-owner",
            "createThread requires a linked file; channel threads are created through startChannelThread.",
          );
        }
        const id = createId("thread");
        const recordedAtMs = nowMs();
        const linkedObjectId = input.linkedFile
          ? normalizeObjectId(input.linkedFile.objectId)
          : undefined;
        const linkedPathHint = input.linkedFile?.pathHint
          ? normalizePathHint(input.linkedFile.pathHint)
          : undefined;
        const thread: ChatThread = {
          id,
          workspaceId,
          title,
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
          ...(linkedObjectId
            ? {
                linkedFile: {
                  objectId: linkedObjectId,
                  ...(linkedPathHint ? { pathHint: linkedPathHint } : {}),
                  linkedAtMs: recordedAtMs,
                },
              }
            : {}),
        };
        db.prepare(
          `INSERT INTO chat_threads (
            workspace_id, thread_id, title, created_at_ms, updated_at_ms,
            linked_object_id, linked_path_hint, linked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          id,
          title,
          recordedAtMs,
          recordedAtMs,
          linkedObjectId ?? null,
          linkedPathHint ?? null,
          linkedObjectId ? recordedAtMs : null,
        );
        upsertThreadHeaderSearchIndex({
          db,
          workspaceId,
          threadId: id,
          title,
        });
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.thread.create",
          payload: {
            threadId: id,
            title,
            createdAtMs: recordedAtMs,
            ...(linkedObjectId ? { linkedObjectId } : {}),
            ...(linkedPathHint ? { linkedPathHint } : {}),
            ...(linkedObjectId ? { linkedAtMs: recordedAtMs } : {}),
          } satisfies ChatThreadCreatePayload,
          recordedAtMs,
        });
        return cloneJson(thread);
      });
    },

    createChannel(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const name = normalizeChannelName(input.name);
        const kind = normalizeChannelKind(input.kind);
        const slug = channelSlugForName(name);
        if (!slug) {
          throw new LinkedChatStoreError(
            "invalid-channel-name",
            "Channel name must contain at least one letter or number.",
          );
        }
        const existing = db
          .prepare("SELECT channel_id FROM chat_channels WHERE workspace_id = ? AND slug = ?")
          .get(workspaceId, slug);
        if (existing) {
          throw new LinkedChatStoreError(
            "channel-exists",
            `A channel named ${JSON.stringify(name)} already exists.`,
          );
        }
        const recordedAtMs = nowMs();
        const channel: ChatChannel = {
          id: createId("channel"),
          workspaceId,
          name,
          slug,
          kind,
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
        };
        db.prepare(
          `INSERT INTO chat_channels (
            workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(workspaceId, channel.id, name, slug, kind, recordedAtMs, recordedAtMs);
        // A locally created channel's wire identity is its own id.
        recordChannelWireId(db, workspaceId, channel.id, channel.id);
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.channel.create",
          payload: {
            channelId: channel.id,
            name,
            slug,
            kind,
            createdAtMs: recordedAtMs,
            wireId: channel.id,
          } satisfies ChatChannelCreatePayload,
          recordedAtMs,
        });
        return cloneJson(channel);
      });
    },

    // Idempotent inside the write chain: first chat use creates "general",
    // every later call returns the same row.
    ensureGeneralChannel(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const slug = channelSlugForName(GENERAL_CHANNEL_NAME);
        const existing = db
          .prepare("SELECT * FROM chat_channels WHERE workspace_id = ? AND slug = ?")
          .get(workspaceId, slug);
        if (existing) {
          // Backfill the well-known wire mapping for generals created before
          // wire ids shipped so imported generals still converge onto them.
          recordChannelWireId(
            db,
            workspaceId,
            GENERAL_CHANNEL_WIRE_ID,
            stringValue(existing.channel_id),
          );
          return cloneJson(channelFromRow(existing));
        }
        const recordedAtMs = nowMs();
        const channel: ChatChannel = {
          id: createId("channel"),
          workspaceId,
          name: GENERAL_CHANNEL_NAME,
          slug,
          kind: "channel",
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
        };
        db.prepare(
          `INSERT INTO chat_channels (
            workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(workspaceId, channel.id, channel.name, slug, channel.kind, recordedAtMs, recordedAtMs);
        // Every store auto-creates general independently; the deterministic
        // well-known wire id is what makes those rows ONE channel under sync.
        recordChannelWireId(db, workspaceId, GENERAL_CHANNEL_WIRE_ID, channel.id);
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.channel.create",
          payload: {
            channelId: channel.id,
            name: channel.name,
            slug,
            kind: channel.kind,
            createdAtMs: recordedAtMs,
            wireId: GENERAL_CHANNEL_WIRE_ID,
          } satisfies ChatChannelCreatePayload,
          recordedAtMs,
        });
        return cloneJson(channel);
      });
    },

    listChannels(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          assertReadStateRowsSane(db, workspaceId);
          return db
            .prepare(
              `SELECT c.*,
                      COALESCE(agg.thread_count, 0) AS thread_count,
                      COALESCE(agg.unread_count, 0) AS unread_count
               FROM chat_channels c
               LEFT JOIN (
                 SELECT t.workspace_id, t.channel_id,
                        COUNT(*) AS thread_count,
                        SUM(MAX(
                          (SELECT COUNT(*) FROM chat_messages m
                           WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id)
                          - COALESCE((SELECT rs.last_read_sequence FROM chat_thread_read_state rs
                                      WHERE rs.workspace_id = t.workspace_id AND rs.thread_id = t.thread_id), 0),
                          0)) AS unread_count
                 FROM chat_threads t
                 WHERE t.channel_id IS NOT NULL
                 GROUP BY t.workspace_id, t.channel_id
               ) agg ON agg.workspace_id = c.workspace_id AND agg.channel_id = c.channel_id
               WHERE c.workspace_id = ?
               ORDER BY c.created_at_ms, c.channel_id`,
            )
            .all(workspaceId)
            .map((row): ChatChannelSummary => ({
              ...channelFromRow(row),
              threadCount: numberValue(row.thread_count),
              unreadCount: numberValue(row.unread_count),
            }))
            .map(cloneJson);
        });
      });
    },

    findChannelBySlug(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const slug = channelSlugForName(input.slug);
        if (!slug) return null;
        return withDb((db) => {
          const row = db
            .prepare("SELECT * FROM chat_channels WHERE workspace_id = ? AND slug = ?")
            .get(workspaceId, slug);
          return row ? cloneJson(channelFromRow(row)) : null;
        });
      });
    },

    // Thread + first message in ONE transaction (the fast composer path): a
    // failed send can never strand an empty thread.
    startChannelThread(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const channel = requireWorkspaceChannel(db, workspaceId, input.channelId);
        const title = normalizeOptionalThreadTitle(input.title);
        const author = normalizeActor(input.author);
        const body = normalizeBody(input.body);
        const threadId = createId("thread");
        const recordedAtMs = nowMs();
        db.prepare(
          `INSERT INTO chat_threads (
            workspace_id, thread_id, title, created_at_ms, updated_at_ms,
            linked_object_id, linked_path_hint, linked_at_ms, channel_id
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        ).run(workspaceId, threadId, title, recordedAtMs, recordedAtMs, channel.id);
        const message: ChatMessage = {
          id: createId("message"),
          workspaceId,
          threadId,
          author,
          body,
          createdAtMs: recordedAtMs,
        };
        db.prepare(
          `INSERT INTO chat_messages (
            workspace_id, thread_id, message_order, message_id, author_kind,
            author_display_name, body, created_at_ms
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          threadId,
          message.id,
          author.kind,
          author.displayName,
          body,
          recordedAtMs,
        );
        if (author.kind === "human") {
          advanceReadCursor({
            db,
            workspaceId,
            threadId,
            upToSequence: 1,
            nowMs: recordedAtMs,
          });
        }
        const displayTitle = threadDisplayTitle(title, body);
        upsertThreadHeaderSearchIndex({
          db,
          workspaceId,
          threadId,
          title: displayTitle,
        });
        upsertChatMessageSearchIndex({
          db,
          workspaceId,
          threadId,
          messageId: message.id,
          author,
          body,
        });
        const channelWireId = wireIdForChannelId(db, workspaceId, channel.id);
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.thread.create",
          payload: {
            threadId,
            title,
            createdAtMs: recordedAtMs,
            channelSlug: channel.slug,
            ...(channelWireId !== undefined ? { channelWireId } : {}),
          } satisfies ChatThreadCreatePayload,
          recordedAtMs,
        });
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.message.append",
          payload: {
            messageId: message.id,
            threadId,
            authorKind: author.kind,
            authorDisplayName: author.displayName,
            body,
            createdAtMs: recordedAtMs,
          } satisfies ChatMessageAppendPayload,
          recordedAtMs,
        });
        const thread: ChatThread = {
          id: threadId,
          workspaceId,
          title: displayTitle,
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
          channelId: channel.id,
        };
        return cloneJson({ thread, message });
      });
    },

    listChannelThreads(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const channel = requireWorkspaceChannel(db, workspaceId, input.channelId);
          return db
            .prepare(
              `SELECT ${THREAD_SELECT_COLUMNS},
                    (SELECT COUNT(*) FROM chat_messages m
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id)
                      AS message_count,
                    COALESCE((SELECT rs.last_read_sequence FROM chat_thread_read_state rs
                              WHERE rs.workspace_id = t.workspace_id AND rs.thread_id = t.thread_id), 0)
                      AS last_read_sequence
               FROM chat_threads t
               WHERE t.workspace_id = ? AND t.channel_id = ?
               ORDER BY t.updated_at_ms DESC, t.thread_id DESC`,
            )
            .all(workspaceId, channel.id)
            .map((row): ChannelThreadSummary => {
              const messageCount = numberValue(row.message_count);
              // Fail closed on negative/non-integer cursors; clamp a (not yet
              // repaired) over-count cursor to the real message count so the
              // summary never claims more read than exists.
              const lastReadSequence = Math.min(
                readSequenceValue(row.last_read_sequence),
                messageCount,
              );
              return {
                thread: threadFromRow(row),
                messageCount,
                lastReadSequence,
                unreadCount: Math.max(0, messageCount - lastReadSequence),
              };
            })
            .map(cloneJson);
        });
      });
    },

    markThreadRead(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const upToSequence = normalizeReadSequence(input.upToSequence);
        const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        return cloneJson(
          advanceReadCursor({
            db,
            workspaceId,
            threadId: thread.id,
            upToSequence,
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
            nowMs: nowMs(),
          }),
        );
      });
    },

    listThreads(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) =>
          db
            .prepare(
              `${THREAD_SELECT_SQL}
               WHERE t.workspace_id = ?
               ORDER BY t.created_at_ms, t.thread_id`,
            )
            .all(workspaceId)
            .map(threadFromRow)
            .map(cloneJson),
        );
      });
    },

    listThreadsForFile(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const objectId = normalizeObjectId(input.objectId);
        return withDb((db) =>
          db
            .prepare(
              `${THREAD_SELECT_SQL}
               WHERE t.workspace_id = ? AND t.linked_object_id = ?
               ORDER BY t.created_at_ms, t.thread_id`,
            )
            .all(workspaceId, objectId)
            .map(threadFromRow)
            .map(cloneJson),
        );
      });
    },

    sendMessage(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        const message: ChatMessage = {
          id: createId("message"),
          workspaceId,
          threadId: thread.id,
          author: normalizeActor(input.author),
          body: normalizeBody(input.body),
          createdAtMs: nowMs(),
        };
        const count = messageCountForThread(db, workspaceId, thread.id);
        db.prepare(
          `INSERT INTO chat_messages (
            workspace_id, thread_id, message_order, message_id, author_kind,
            author_display_name, body, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          thread.id,
          count,
          message.id,
          message.author.kind,
          message.author.displayName,
          message.body,
          message.createdAtMs,
        );
        db.prepare(
          "UPDATE chat_threads SET updated_at_ms = ? WHERE workspace_id = ? AND thread_id = ?",
        ).run(message.createdAtMs, workspaceId, thread.id);
        // Single-user read-state rule: your own (human) message is never
        // unread; agent messages are exactly what unread exists to surface.
        if (message.author.kind === "human") {
          advanceReadCursor({
            db,
            workspaceId,
            threadId: thread.id,
            upToSequence: count + 1,
            nowMs: message.createdAtMs,
          });
        }
        upsertChatMessageSearchIndex({
          db,
          workspaceId,
          threadId: thread.id,
          messageId: message.id,
          author: message.author,
          body: message.body,
        });
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.message.append",
          payload: {
            messageId: message.id,
            threadId: thread.id,
            authorKind: message.author.kind,
            authorDisplayName: message.author.displayName,
            body: message.body,
            createdAtMs: message.createdAtMs,
          } satisfies ChatMessageAppendPayload,
          recordedAtMs: message.createdAtMs,
        });
        return cloneJson(message);
      });
    },

    listMessages(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
          return listMessagesForThread(db, workspaceId, thread.id).map(cloneJson);
        });
      });
    },

    applyReplicationOp(input): Promise<SyncApplyResult> {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (
          typeof input.originId !== "string" ||
          !input.originId ||
          !Number.isInteger(input.originSeq) ||
          input.originSeq < 0 ||
          typeof input.recordedAtMs !== "number" ||
          !Number.isFinite(input.recordedAtMs)
        ) {
          throw new LinkedChatStoreError("state-corrupt", "Replication envelope is invalid.");
        }
        const ackedSeq = readReplicationAckedSeq(db, workspaceId, input.originId);
        if (input.originSeq <= ackedSeq) return skippedApplyResult();
        if (importedReplicationLogExists(db, input)) {
          ackReplicationPeer(db, workspaceId, input.originId, input.originSeq);
          return skippedApplyResult();
        }
        if (input.originSeq !== ackedSeq + 1) {
          throw new LinkedChatStoreError(
            "state-corrupt",
            `Replication origin ${input.originId} has a gap before sequence ${input.originSeq}.`,
          );
        }
        if (input.opKind === "chat.channel.create") {
          const payload = input.payload;
          // Wire id is the cross-machine channel identity; slug is only a
          // lookup alias. Same wire id = same channel (idempotent no-op);
          // same slug + different wire id = distinct channel whose LOCAL slug
          // gets a numbered variant. Pre-wire-id payloads fall back to slug
          // identity (the 0P-A initial wire truth).
          if (typeof payload.wireId === "string" && payload.wireId.length > 0) {
            if (!channelIdForWireId(db, workspaceId, payload.wireId)) {
              const channelId = createId("channel");
              db.prepare(
                `INSERT INTO chat_channels (
                  workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                workspaceId,
                channelId,
                payload.name,
                nextFreeChannelSlug(db, workspaceId, payload.slug),
                payload.kind,
                payload.createdAtMs,
                payload.createdAtMs,
              );
              recordChannelWireId(db, workspaceId, payload.wireId, channelId);
            }
          } else if (
            !db
              .prepare("SELECT 1 FROM chat_channels WHERE workspace_id = ? AND slug = ?")
              .get(workspaceId, payload.slug)
          ) {
            db.prepare(
              `INSERT INTO chat_channels (
                workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              workspaceId,
              createId("channel"),
              payload.name,
              payload.slug,
              payload.kind,
              payload.createdAtMs,
              payload.createdAtMs,
            );
          }
        } else if (input.opKind === "chat.thread.create") {
          const payload = input.payload;
          if (
            !db
              .prepare("SELECT 1 FROM chat_threads WHERE workspace_id = ? AND thread_id = ?")
              .get(workspaceId, payload.threadId)
          ) {
            const hasLinkedOwner = typeof payload.linkedObjectId === "string";
            const hasChannelOwner =
              typeof payload.channelSlug === "string" || typeof payload.channelWireId === "string";
            if (hasLinkedOwner === hasChannelOwner) throw corruptStore();
            let channelId: string | null = null;
            if (hasChannelOwner) {
              // Prefer the wire-id map (true identity), fall back to the slug
              // alias, and only then create a placeholder channel — a thread
              // op can arrive before its channel op only across origins.
              const mappedChannelId =
                typeof payload.channelWireId === "string"
                  ? channelIdForWireId(db, workspaceId, payload.channelWireId)
                  : undefined;
              // The slug alias only resolves identity for pre-wire-id
              // payloads: a wire-id-carrying thread must never bind to a
              // same-slug channel with a DIFFERENT wire identity.
              const existingChannel =
                payload.channelWireId === undefined && typeof payload.channelSlug === "string"
                  ? db
                      .prepare(
                        "SELECT channel_id FROM chat_channels WHERE workspace_id = ? AND slug = ?",
                      )
                      .get(workspaceId, payload.channelSlug)
                  : undefined;
              if (mappedChannelId !== undefined) {
                channelId = mappedChannelId;
              } else if (existingChannel) {
                channelId = stringValue(existingChannel.channel_id);
              } else {
                const placeholderSlug =
                  typeof payload.channelSlug === "string" && payload.channelSlug.length > 0
                    ? payload.channelSlug
                    : (payload.channelWireId as string);
                channelId = createId("channel");
                db.prepare(
                  `INSERT INTO chat_channels (
                    workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
                  ) VALUES (?, ?, ?, ?, 'channel', ?, ?)`,
                ).run(
                  workspaceId,
                  channelId,
                  placeholderSlug,
                  nextFreeChannelSlug(db, workspaceId, placeholderSlug),
                  input.recordedAtMs,
                  input.recordedAtMs,
                );
                if (typeof payload.channelWireId === "string") {
                  recordChannelWireId(db, workspaceId, payload.channelWireId, channelId);
                }
              }
            }
            db.prepare(
              `INSERT INTO chat_threads (
                workspace_id, thread_id, title, created_at_ms, updated_at_ms,
                linked_object_id, linked_path_hint, linked_at_ms, channel_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              workspaceId,
              payload.threadId,
              payload.title,
              payload.createdAtMs,
              payload.createdAtMs,
              hasLinkedOwner ? payload.linkedObjectId : null,
              payload.linkedPathHint ?? null,
              hasLinkedOwner ? (payload.linkedAtMs ?? null) : null,
              channelId,
            );
            upsertThreadHeaderSearchIndex({
              db,
              workspaceId,
              threadId: payload.threadId,
              title: payload.title,
            });
          }
        } else if (input.opKind === "chat.message.append") {
          const payload = input.payload;
          requireWorkspaceThread(db, workspaceId, payload.threadId);
          if (
            !db
              .prepare("SELECT 1 FROM chat_messages WHERE workspace_id = ? AND message_id = ?")
              .get(workspaceId, payload.messageId)
          ) {
            const messageOrder = nextMessageOrder(db, workspaceId, payload.threadId);
            db.prepare(
              `INSERT INTO chat_messages (
                workspace_id, thread_id, message_order, message_id, author_kind,
                author_display_name, body, created_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              workspaceId,
              payload.threadId,
              messageOrder,
              payload.messageId,
              payload.authorKind,
              payload.authorDisplayName,
              payload.body,
              payload.createdAtMs,
            );
            db.prepare(
              "UPDATE chat_threads SET updated_at_ms = ? WHERE workspace_id = ? AND thread_id = ?",
            ).run(payload.createdAtMs, workspaceId, payload.threadId);
            // An untitled channel thread's searchable header is its snippet
            // title. Locally startChannelThread derives it with the first
            // message body in the same transaction; on import that body only
            // arrives with this op, one op after the thread row.
            const storedTitle = db
              .prepare("SELECT title FROM chat_threads WHERE workspace_id = ? AND thread_id = ?")
              .get(workspaceId, payload.threadId);
            if (messageOrder === 0 && stringValue(storedTitle?.title ?? "") === "") {
              upsertThreadHeaderSearchIndex({
                db,
                workspaceId,
                threadId: payload.threadId,
                title: threadDisplayTitle("", payload.body),
              });
            }
            upsertChatMessageSearchIndex({
              db,
              workspaceId,
              threadId: payload.threadId,
              messageId: payload.messageId,
              author: { kind: payload.authorKind, displayName: payload.authorDisplayName },
              body: payload.body,
            });
          }
        } else {
          throw new LinkedChatStoreError(
            "state-corrupt",
            `Chat store cannot apply replication op ${input.opKind}.`,
          );
        }
        journalImportedReplicationOp(db, input);
        ackReplicationPeer(db, workspaceId, input.originId, input.originSeq);
        return appliedApplyResult();
      });
    },

    getThreadProjection(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
          const access = input.linkedFileAccess ?? { kind: "unknown" as const };
          const linkedFileAccess =
            access.kind === "allowed"
              ? { kind: "allowed" as const, path: normalizePathHint(access.path) }
              : access;
          const messages = listMessagesForThread(db, workspaceId, thread.id);
          return {
            path: linkedChatProjectionPath({ workspaceId, threadId: thread.id }),
            readOnly: true,
            threadId: thread.id,
            text: formatProjection({ thread, messages, linkedFileAccess }),
          };
        });
      });
    },

    // Releases the SQLite handle (and its WAL locks) after in-flight writes
    // drain. The store stays usable: a later call lazily reopens, so close is
    // safe to call from workspace teardown/app quit without poisoning late
    // readers.
    async close() {
      await writeChain;
      if (dbHandle) {
        try {
          dbHandle.close();
        } catch {}
        dbHandle = null;
      }
    },
  };
}
