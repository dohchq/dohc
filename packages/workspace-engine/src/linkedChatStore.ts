import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  type WorkspaceId,
  type WorkspaceObjectId,
} from "./versionedTextStore";

export const LINKED_CHAT_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;
export const LINKED_CHAT_PROJECTION_KIND = "thread";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const ENGINE_SCHEMA_VERSION = 1;

export type ChatThreadId = string;
export type ChatMessageId = string;

export type LinkedChatStoreErrorCode =
  | "invalid-message-body"
  | "invalid-path"
  | "invalid-sender"
  | "invalid-thread-title"
  | "invalid-workspace"
  | "state-corrupt"
  | "thread-not-found"
  | "workspace-mismatch";

export class LinkedChatStoreError extends Error {
  readonly code: LinkedChatStoreErrorCode;

  constructor(code: LinkedChatStoreErrorCode, message: string) {
    super(message);
    this.name = "LinkedChatStoreError";
    this.code = code;
  }
}

export type ChatActor =
  | { kind: "human"; displayName: string }
  | { kind: "agent"; displayName: string };

export interface LinkedChatFileRef {
  objectId: WorkspaceObjectId;
  pathHint?: string;
  linkedAtMs: number;
}

export interface ChatThread {
  id: ChatThreadId;
  workspaceId: WorkspaceId;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  linkedFile?: LinkedChatFileRef;
}

export interface ChatMessage {
  id: ChatMessageId;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  author: ChatActor;
  body: string;
  createdAtMs: number;
}

export type LinkedChatProjectionFileAccess =
  | { kind: "allowed"; path: string }
  | { kind: "denied" }
  | { kind: "unknown" };

export interface LinkedChatProjection {
  path: string;
  readOnly: true;
  threadId: ChatThreadId;
  text: string;
}

export interface LinkedChatStore {
  createThread(input: {
    workspaceId: WorkspaceId;
    title: string;
    linkedFile?: { objectId: WorkspaceObjectId; pathHint?: string };
  }): Promise<ChatThread>;
  listThreads(input: { workspaceId: WorkspaceId }): Promise<ChatThread[]>;
  listThreadsForFile(input: {
    workspaceId: WorkspaceId;
    objectId: WorkspaceObjectId;
  }): Promise<ChatThread[]>;
  sendMessage(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    author: ChatActor;
    body: string;
  }): Promise<ChatMessage>;
  listMessages(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<ChatMessage[]>;
  getThreadProjection(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    linkedFileAccess?: LinkedChatProjectionFileAccess;
  }): Promise<LinkedChatProjection>;
}

export interface LinkedChatStoreOptions {
  nowMs?: () => number;
  createId?: (kind: "message" | "thread") => string;
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
    db = new DatabaseSync(path);
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    initializeOrValidateSchema(db);
    assertSqliteIntegrity(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (error instanceof LinkedChatStoreError) throw error;
    throw corruptStore(error);
  }
}

function initializeOrValidateSchema(db: SqliteDb): void {
  const schemaRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!schemaRow) {
    const userTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (userTables.length > 0) throw corruptStore();
    createSchema(db);
    return;
  }
  const version = db.prepare("SELECT version FROM schema_version WHERE id = 1").get();
  if (Number(version?.version) !== ENGINE_SCHEMA_VERSION) throw corruptStore();
  assertRequiredTables(db);
}

function assertSqliteIntegrity(db: SqliteDb): void {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || String(integrity[0]?.integrity_check) !== "ok") {
    throw corruptStore();
  }
}

function assertRequiredTables(db: SqliteDb): void {
  const required = new Set([
    "schema_version",
    "blobs",
    "versioned_workspaces",
    "versions",
    "file_objects",
    "path_aliases",
    "snapshots",
    "fork_base_snapshots",
    "moments",
    "conflicts",
    "chat_threads",
    "chat_messages",
  ]);
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name)),
  );
  for (const table of required) {
    if (!names.has(table)) throw corruptStore();
  }
}

function createSchema(db: SqliteDb): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE versioned_workspaces (workspace_id TEXT PRIMARY KEY, main_version_id TEXT NOT NULL);
      CREATE TABLE versions (
        workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        created_at_ms REAL NOT NULL, fork_version_id TEXT, fork_moment_id TEXT,
        PRIMARY KEY (workspace_id, version_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE TABLE file_objects (
        workspace_id TEXT NOT NULL, object_id TEXT NOT NULL, created_at_ms REAL NOT NULL,
        PRIMARY KEY (workspace_id, object_id), UNIQUE (object_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
      );
      CREATE TABLE path_aliases (
        workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, path TEXT NOT NULL, object_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, version_id, path),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE
      );
      CREATE TABLE snapshots (
        workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL,
        blob_sha256 TEXT NOT NULL, updated_at_ms REAL NOT NULL, latest_moment_id TEXT NOT NULL,
        metadata_origin TEXT NOT NULL, metadata_summary TEXT, metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, version_id, object_id),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE fork_base_snapshots (
        workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL,
        blob_sha256 TEXT NOT NULL, updated_at_ms REAL NOT NULL, latest_moment_id TEXT NOT NULL,
        metadata_origin TEXT NOT NULL, metadata_summary TEXT, metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, version_id, object_id),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE moments (
        workspace_id TEXT NOT NULL, moment_order INTEGER NOT NULL, moment_id TEXT NOT NULL,
        version_id TEXT NOT NULL, object_id TEXT NOT NULL, path TEXT NOT NULL, recorded_at_ms REAL NOT NULL,
        operation TEXT NOT NULL, payload_before_path TEXT, payload_before_blob_sha256 TEXT,
        payload_after_path TEXT NOT NULL, payload_after_blob_sha256 TEXT NOT NULL,
        metadata_origin TEXT NOT NULL, metadata_summary TEXT, metadata_correlation_id TEXT,
        before_present INTEGER NOT NULL, before_object_id TEXT, before_version_id TEXT, before_path TEXT,
        before_blob_sha256 TEXT, before_updated_at_ms REAL, before_latest_moment_id TEXT,
        before_metadata_origin TEXT, before_metadata_summary TEXT, before_metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, moment_id), UNIQUE (workspace_id, moment_order),
        FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id) ON DELETE CASCADE,
        FOREIGN KEY (payload_before_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (payload_after_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (before_blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE conflicts (
        workspace_id TEXT NOT NULL, conflict_id TEXT NOT NULL, path TEXT NOT NULL, target_version_id TEXT NOT NULL,
        source_version_id TEXT NOT NULL, created_at_ms REAL NOT NULL, updated_at_ms REAL NOT NULL,
        status TEXT NOT NULL, chosen_from TEXT NOT NULL, resolution TEXT, metadata_origin TEXT NOT NULL,
        metadata_summary TEXT, metadata_correlation_id TEXT, base_exists INTEGER NOT NULL, base_path TEXT NOT NULL,
        base_object_id TEXT, base_blob_sha256 TEXT, base_updated_at_ms REAL, base_latest_moment_id TEXT,
        base_metadata_origin TEXT, base_metadata_summary TEXT, base_metadata_correlation_id TEXT,
        current_exists INTEGER NOT NULL, current_path TEXT NOT NULL, current_object_id TEXT,
        current_blob_sha256 TEXT, current_updated_at_ms REAL, current_latest_moment_id TEXT,
        current_metadata_origin TEXT, current_metadata_summary TEXT, current_metadata_correlation_id TEXT,
        incoming_exists INTEGER NOT NULL, incoming_path TEXT NOT NULL, incoming_object_id TEXT,
        incoming_blob_sha256 TEXT, incoming_updated_at_ms REAL, incoming_latest_moment_id TEXT,
        incoming_metadata_origin TEXT, incoming_metadata_summary TEXT, incoming_metadata_correlation_id TEXT,
        PRIMARY KEY (workspace_id, conflict_id),
        FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
        FOREIGN KEY (base_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (current_blob_sha256) REFERENCES blobs(sha256),
        FOREIGN KEY (incoming_blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE TABLE chat_threads (
        workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at_ms REAL NOT NULL, updated_at_ms REAL NOT NULL, linked_object_id TEXT,
        linked_path_hint TEXT, linked_at_ms REAL, PRIMARY KEY (workspace_id, thread_id)
      );
      CREATE TABLE chat_messages (
        workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_order INTEGER NOT NULL,
        message_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_display_name TEXT NOT NULL,
        body TEXT NOT NULL, created_at_ms REAL NOT NULL, PRIMARY KEY (workspace_id, message_id),
        UNIQUE (workspace_id, thread_id, message_order),
        FOREIGN KEY (workspace_id, thread_id) REFERENCES chat_threads(workspace_id, thread_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_versions_workspace_name ON versions(workspace_id, name);
      CREATE INDEX idx_versions_fork ON versions(workspace_id, fork_version_id, fork_moment_id);
      CREATE INDEX idx_path_aliases_object ON path_aliases(workspace_id, version_id, object_id);
      CREATE INDEX idx_snapshots_path ON snapshots(workspace_id, version_id, path);
      CREATE INDEX idx_fork_base_snapshots_path ON fork_base_snapshots(workspace_id, version_id, path);
      CREATE INDEX idx_moments_version_object_order ON moments(workspace_id, version_id, object_id, moment_order);
      CREATE INDEX idx_moments_version_order ON moments(workspace_id, version_id, moment_order);
      CREATE INDEX idx_moments_object_before ON moments(workspace_id, object_id, before_latest_moment_id);
      CREATE INDEX idx_conflicts_workspace_status ON conflicts(workspace_id, status, created_at_ms, conflict_id);
      CREATE INDEX idx_chat_threads_workspace_created ON chat_threads(workspace_id, created_at_ms, thread_id);
      CREATE INDEX idx_chat_threads_linked_file ON chat_threads(workspace_id, linked_object_id, created_at_ms, thread_id);
      CREATE INDEX idx_chat_messages_thread_order ON chat_messages(workspace_id, thread_id, message_order);
      INSERT INTO schema_version (id, version) VALUES (1, ${ENGINE_SCHEMA_VERSION});
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
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

function defaultCreateId(kind: "message" | "thread"): string {
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

function threadFromRow(row: Record<string, unknown>): ChatThread {
  const linkedObjectId = optionalString(row.linked_object_id);
  return {
    id: stringValue(row.thread_id),
    workspaceId: stringValue(row.workspace_id),
    title: stringValue(row.title),
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
  };
}

function messageFromRow(row: Record<string, unknown>): ChatMessage {
  return {
    id: stringValue(row.message_id),
    workspaceId: stringValue(row.workspace_id),
    threadId: stringValue(row.thread_id),
    author: {
      kind: stringValue(row.author_kind) as ChatActor["kind"],
      displayName: stringValue(row.author_display_name),
    },
    body: stringValue(row.body),
    createdAtMs: numberValue(row.created_at_ms),
  };
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
    .prepare("SELECT * FROM chat_threads WHERE workspace_id = ? AND thread_id = ?")
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
    if (!dbHandle) {
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

  return {
    createThread(input) {
      return serialize(async (db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const title = normalizeThreadTitle(input.title);
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
        return cloneJson(thread);
      });
    },

    listThreads(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) =>
          db
            .prepare(
              `SELECT * FROM chat_threads
               WHERE workspace_id = ?
               ORDER BY created_at_ms, thread_id`,
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
              `SELECT * FROM chat_threads
               WHERE workspace_id = ? AND linked_object_id = ?
               ORDER BY created_at_ms, thread_id`,
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
        const count = db
          .prepare(
            "SELECT COUNT(*) AS count FROM chat_messages WHERE workspace_id = ? AND thread_id = ?",
          )
          .get(workspaceId, thread.id);
        db.prepare(
          `INSERT INTO chat_messages (
            workspace_id, thread_id, message_order, message_id, author_kind,
            author_display_name, body, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          thread.id,
          Number(count?.count ?? 0),
          message.id,
          message.author.kind,
          message.author.displayName,
          message.body,
          message.createdAtMs,
        );
        db.prepare(
          "UPDATE chat_threads SET updated_at_ms = ? WHERE workspace_id = ? AND thread_id = ?",
        ).run(message.createdAtMs, workspaceId, thread.id);
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
  };
}
