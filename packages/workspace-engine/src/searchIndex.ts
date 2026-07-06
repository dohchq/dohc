import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatActor,
  TextFileSnapshot,
  WorkspaceId,
  WorkspaceObjectId,
  VersionId,
} from "@dohc/workspace-contracts/engine";
import {
  parseFilesPolicy,
  parseVisibilityPolicy,
  resolveEffectivePolicy,
  type FilesPolicyRule,
  type VisibilityPolicyRule,
} from "./effectivePolicy";
import type { EngineSqliteDb } from "./engineDbSchema";

const POLICY_FILE_MAX_BYTES = 64 * 1024;
const THREAD_HEADER_MESSAGE_ID = "__thread__";
const MIN_TRIGRAM_QUERY_CHARS = 3;

export interface EngineSearchPolicySnapshot {
  filesPolicy: FilesPolicyRule[] | null;
  visibilityPolicy: VisibilityPolicyRule[] | null;
}

export interface IndexedSearchCandidateFile {
  surface: "file";
  path: string;
  objectId: string;
  text: string;
}

export interface IndexedSearchCandidateChat {
  surface: "chat";
  threadId: string;
}

export type IndexedSearchCandidate = IndexedSearchCandidateFile | IndexedSearchCandidateChat;

function tableHasRows(db: EngineSqliteDb, sql: string, ...params: unknown[]): boolean {
  return Boolean(db.prepare(sql).get(...params));
}

function readPolicyFile<T>(
  rootDir: string,
  fileName: string,
  parse: (text: string) => { ok: true; rules: T[] } | { ok: false },
): T[] | null {
  const path = join(rootDir, ".dohc", fileName);
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > POLICY_FILE_MAX_BYTES) {
      return null;
    }
    const parsed = parse(readFileSync(path, "utf8"));
    return parsed.ok ? parsed.rules : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export function readEngineSearchPolicySync(rootDir: string): EngineSearchPolicySnapshot {
  return {
    filesPolicy: readPolicyFile(rootDir, "files.toml", parseFilesPolicy),
    visibilityPolicy: readPolicyFile(rootDir, "visibility.toml", parseVisibilityPolicy),
  };
}

export function pathIsSearchIndexed(
  rootDir: string,
  path: string,
  policy = readEngineSearchPolicySync(rootDir),
): boolean {
  const resolved = resolveEffectivePolicy({
    path,
    filesPolicy: policy.filesPolicy,
    visibilityPolicy: policy.visibilityPolicy,
  });
  // Hidden means hidden from search too: visibility.toml can hide a file
  // that files.toml still marks searchable — the stricter answer wins.
  return resolved.tracked && resolved.searchable && resolved.visibility !== "hidden";
}

function deleteFileIndexRow(input: {
  db: EngineSqliteDb;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
}): void {
  input.db
    .prepare(
      `DELETE FROM engine_search_files_fts
       WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
    )
    .run(input.workspaceId, input.versionId, input.objectId);
}

export function upsertFileSearchIndex(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  snapshot: TextFileSnapshot;
}): void {
  deleteFileIndexRow({
    db: input.db,
    workspaceId: input.workspaceId,
    versionId: input.snapshot.versionId,
    objectId: input.snapshot.objectId,
  });
  if (!pathIsSearchIndexed(input.rootDir, input.snapshot.path)) return;
  input.db
    .prepare(
      `INSERT INTO engine_search_files_fts (workspace_id, version_id, object_id, path, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      input.snapshot.versionId,
      input.snapshot.objectId,
      input.snapshot.path,
      input.snapshot.text,
    );
}

export function deleteFileSearchIndex(input: {
  db: EngineSqliteDb;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
}): void {
  deleteFileIndexRow(input);
}

function chatIndexText(input: {
  title?: string;
  author?: ChatActor;
  body?: string;
}): string {
  const parts: string[] = [];
  if (input.title) parts.push(input.title);
  if (input.author) {
    parts.push(input.author.displayName);
    if (input.author.kind === "agent") parts.push(`${input.author.displayName} (agent)`);
  }
  if (input.body) parts.push(input.body);
  return parts.join("\n");
}

export function upsertThreadHeaderSearchIndex(input: {
  db: EngineSqliteDb;
  workspaceId: WorkspaceId;
  threadId: string;
  title: string;
}): void {
  input.db
    .prepare(
      `DELETE FROM engine_search_chat_messages_fts
       WHERE workspace_id = ? AND thread_id = ? AND message_id = ?`,
    )
    .run(input.workspaceId, input.threadId, THREAD_HEADER_MESSAGE_ID);
  input.db
    .prepare(
      `INSERT INTO engine_search_chat_messages_fts (workspace_id, thread_id, message_id, text)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.workspaceId, input.threadId, THREAD_HEADER_MESSAGE_ID, chatIndexText({ title: input.title }));
}

export function upsertChatMessageSearchIndex(input: {
  db: EngineSqliteDb;
  workspaceId: WorkspaceId;
  threadId: string;
  messageId: string;
  author: ChatActor;
  body: string;
}): void {
  input.db
    .prepare(
      `DELETE FROM engine_search_chat_messages_fts
       WHERE workspace_id = ? AND thread_id = ? AND message_id = ?`,
    )
    .run(input.workspaceId, input.threadId, input.messageId);
  input.db
    .prepare(
      `INSERT INTO engine_search_chat_messages_fts (workspace_id, thread_id, message_id, text)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      input.threadId,
      input.messageId,
      chatIndexText({ author: input.author, body: input.body }),
    );
}

export function ensureSearchIndexForVersion(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  nowMs: number;
}): void {
  if (
    tableHasRows(
      input.db,
      "SELECT 1 FROM engine_search_index_state WHERE workspace_id = ? AND version_id = ?",
      input.workspaceId,
      input.versionId,
    )
  ) {
    return;
  }

  const policy = readEngineSearchPolicySync(input.rootDir);
  input.db
    .prepare("DELETE FROM engine_search_files_fts WHERE workspace_id = ? AND version_id = ?")
    .run(input.workspaceId, input.versionId);
  const files = input.db
    .prepare(
      `SELECT candidate.*, b.text
       FROM (
         SELECT s.workspace_id, s.version_id, s.object_id, s.path, s.blob_sha256
         FROM snapshots s
         WHERE s.workspace_id = ? AND s.version_id = ?
         UNION ALL
         SELECT fb.workspace_id, fb.version_id, fb.object_id, fb.path, fb.blob_sha256
         FROM fork_base_snapshots fb
         WHERE fb.workspace_id = ? AND fb.version_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM snapshots s
             WHERE s.workspace_id = fb.workspace_id
               AND s.version_id = fb.version_id
               AND s.object_id = fb.object_id
           )
       ) candidate
       JOIN blobs b ON b.sha256 = candidate.blob_sha256
       ORDER BY candidate.path`,
    )
    .all(input.workspaceId, input.versionId, input.workspaceId, input.versionId);
  const insertFile = input.db.prepare(
    `INSERT INTO engine_search_files_fts (workspace_id, version_id, object_id, path, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of files) {
    const path = String(row.path);
    if (!pathIsSearchIndexed(input.rootDir, path, policy)) continue;
    insertFile.run(
      input.workspaceId,
      input.versionId,
      String(row.object_id),
      path,
      String(row.text),
    );
  }

  input.db
    .prepare("DELETE FROM engine_search_chat_messages_fts WHERE workspace_id = ?")
    .run(input.workspaceId);
  const insertChat = input.db.prepare(
    `INSERT INTO engine_search_chat_messages_fts (workspace_id, thread_id, message_id, text)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of input.db
    .prepare(
      `SELECT thread_id, title
       FROM chat_threads
       WHERE workspace_id = ?
       ORDER BY created_at_ms, thread_id`,
    )
    .all(input.workspaceId)) {
    insertChat.run(
      input.workspaceId,
      String(row.thread_id),
      THREAD_HEADER_MESSAGE_ID,
      chatIndexText({ title: String(row.title) }),
    );
  }
  for (const row of input.db
    .prepare(
      `SELECT thread_id, message_id, author_kind, author_display_name, body
       FROM chat_messages
       WHERE workspace_id = ?
       ORDER BY thread_id, message_order`,
    )
    .all(input.workspaceId)) {
    const kind = String(row.author_kind) === "agent" ? "agent" : "human";
    insertChat.run(
      input.workspaceId,
      String(row.thread_id),
      String(row.message_id),
      chatIndexText({
        author: { kind, displayName: String(row.author_display_name) },
        body: String(row.body),
      }),
    );
  }
  input.db
    .prepare(
      `INSERT INTO engine_search_index_state (workspace_id, version_id, indexed_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, version_id) DO UPDATE SET indexed_at_ms = excluded.indexed_at_ms`,
    )
    .run(input.workspaceId, input.versionId, input.nowMs);
}

function ftsQueryForSubstring(query: string): string | null {
  const normalized = query.trim();
  if ([...normalized].length < MIN_TRIGRAM_QUERY_CHARS) return null;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function rowText(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? "");
}

export function querySearchIndex(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  query: string;
  limit: number;
}): IndexedSearchCandidate[] | null {
  const match = ftsQueryForSubstring(input.query);
  if (!match) return null;
  const policy = readEngineSearchPolicySync(input.rootDir);
  const candidates: IndexedSearchCandidate[] = [];
  const seenFiles = new Set<string>();
  for (const row of input.db
    .prepare(
      `SELECT path, object_id, text
       FROM engine_search_files_fts
       WHERE engine_search_files_fts MATCH ?
         AND workspace_id = ?
         AND version_id = ?
       ORDER BY rowid
       LIMIT ?`,
    )
    .all(match, input.workspaceId, input.versionId, input.limit * 4)) {
    const path = rowText(row, "path");
    if (!pathIsSearchIndexed(input.rootDir, path, policy)) continue;
    const objectId = rowText(row, "object_id");
    const key = `${path}\0${objectId}`;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    candidates.push({
      surface: "file",
      path,
      objectId,
      text: rowText(row, "text"),
    });
    if (candidates.length >= input.limit) return candidates;
  }

  const seenThreads = new Set<string>();
  for (const row of input.db
    .prepare(
      `SELECT thread_id
       FROM engine_search_chat_messages_fts
       WHERE engine_search_chat_messages_fts MATCH ?
         AND workspace_id = ?
       ORDER BY rowid
       LIMIT ?`,
    )
    .all(match, input.workspaceId, input.limit * 8)) {
    const threadId = rowText(row, "thread_id");
    if (seenThreads.has(threadId)) continue;
    seenThreads.add(threadId);
    candidates.push({ surface: "chat", threadId });
    if (candidates.length >= input.limit) return candidates;
  }
  return candidates;
}
