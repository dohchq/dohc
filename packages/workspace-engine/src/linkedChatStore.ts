import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  ChatActor,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
} from "@dohc/workspace-contracts/engine";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
} from "./engineDbSchema";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  type WorkspaceId,
  type WorkspaceObjectId,
} from "./versionedTextStore";

export const LINKED_CHAT_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;
export const LINKED_CHAT_PROJECTION_KIND = "thread";

export type {
  ChatActor,
  ChatMessage,
  ChatMessageId,
  ChatThread,
  ChatThreadId,
  LinkedChatFileRef,
  LinkedChatProjection,
  LinkedChatProjectionFileAccess,
  LinkedChatStore,
  LinkedChatStoreErrorCode,
  LinkedChatStoreOptions,
} from "@dohc/workspace-contracts/engine";

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
