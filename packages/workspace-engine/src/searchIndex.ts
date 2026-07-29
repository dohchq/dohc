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
  type PolicyParseResult,
  type VisibilityPolicyRule,
} from "@dohc/security-contract/effective-policy";
import type { EngineSqliteDb } from "./engineDbSchema";
import { threadDisplayTitle } from "./chatThreadTitle";

// Must match the desktop policy reader's cap (MAX_WORKSPACE_SETTINGS_FILE_BYTES,
// 256 KiB): now that oversize fails CLOSED, a file the desktop accepts and
// applies must not be treated as broken here, or search would silently pause
// on a policy both layers consider valid.
const POLICY_FILE_MAX_BYTES = 256 * 1024;
const THREAD_HEADER_MESSAGE_ID = "__thread__";
const MIN_TRIGRAM_QUERY_CHARS = 3;

export interface EngineSearchPolicyDiagnostic {
  file: string;
  reason: "unreadable" | "invalid";
  detail: string;
}

export interface EngineSearchPolicySnapshot {
  filesPolicy: FilesPolicyRule[] | null;
  visibilityPolicy: VisibilityPolicyRule[] | null;
  // Fail-closed marker. An ABSENT policy file means defaults (null rules, no
  // diagnostic); a policy file that EXISTS but cannot be read or parsed must
  // never widen search, so while a diagnostic is present nothing is indexed
  // or returned (same posture as the desktop's resolveEngineSearchPolicy).
  diagnostics: EngineSearchPolicyDiagnostic[];
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

export interface GranularChatMessageSearchResult {
  threadId: string;
  messageId: string | null;
  text: string;
}

function tableHasRows(db: EngineSqliteDb, sql: string, ...params: unknown[]): boolean {
  return Boolean(db.prepare(sql).get(...params));
}

type PolicyFileRead<T> = {
  rules: T[] | null;
  diagnostic: EngineSearchPolicyDiagnostic | null;
};

function readPolicyFile<T>(
  rootDir: string,
  fileName: string,
  parse: (text: string) => PolicyParseResult<T>,
): PolicyFileRead<T> {
  const broken = (
    reason: EngineSearchPolicyDiagnostic["reason"],
    detail: string,
  ): PolicyFileRead<T> => ({ rules: null, diagnostic: { file: fileName, reason, detail } });
  const path = join(rootDir, ".dohc", fileName);
  let text: string;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      return broken("unreadable", "policy file must be a regular file");
    }
    if (info.size > POLICY_FILE_MAX_BYTES) {
      return broken("unreadable", `policy file exceeds ${POLICY_FILE_MAX_BYTES} bytes`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    // ENOENT means the file is absent, which is a valid configuration (the
    // defaults apply). Anything else means a policy file may exist that we
    // failed to read (EACCES, EIO, ...), so filtering must fail closed.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rules: null, diagnostic: null };
    return broken("unreadable", code ?? String(error));
  }
  const parsed = parse(text);
  if (!parsed.ok) return broken("invalid", parsed.errors.join("; "));
  return { rules: parsed.rules, diagnostic: null };
}

export function readEngineSearchPolicySync(rootDir: string): EngineSearchPolicySnapshot {
  const files = readPolicyFile(rootDir, "files.toml", parseFilesPolicy);
  const visibility = readPolicyFile(rootDir, "visibility.toml", parseVisibilityPolicy);
  const diagnostics: EngineSearchPolicyDiagnostic[] = [];
  if (files.diagnostic) diagnostics.push(files.diagnostic);
  if (visibility.diagnostic) diagnostics.push(visibility.diagnostic);
  return { filesPolicy: files.rules, visibilityPolicy: visibility.rules, diagnostics };
}

export function pathIsSearchIndexed(
  rootDir: string,
  path: string,
  policy = readEngineSearchPolicySync(rootDir),
): boolean {
  // A broken policy file fails CLOSED: policy filtering is never silently
  // disabled, so nothing is searchable until the file is fixed or removed.
  if (policy.diagnostics.length > 0) return false;
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
  const policy = readEngineSearchPolicySync(input.rootDir);
  // Broken policy = freeze the file index: don't delete-then-skip (which would
  // drop this file from a healthy index). Leave FTS rows untouched — query-time
  // pathIsSearchIndexed fails file search closed while degraded — but INVALIDATE
  // index_state so a fix triggers a full rebuild that picks up everything
  // written during the degraded window (a new file would otherwise stay missing
  // because ensureSearchIndexForVersion skips already-stated versions).
  if (policy.diagnostics.length > 0) {
    input.db
      .prepare(
        "DELETE FROM engine_search_index_state WHERE workspace_id = ? AND version_id = ?",
      )
      .run(input.workspaceId, input.snapshot.versionId);
    return;
  }
  deleteFileIndexRow({
    db: input.db,
    workspaceId: input.workspaceId,
    versionId: input.snapshot.versionId,
    objectId: input.snapshot.objectId,
  });
  if (input.snapshot.contentKind === "binary") return;
  if (!pathIsSearchIndexed(input.rootDir, input.snapshot.path, policy)) return;
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

// The validated thread-search row: SQL columns -> the exact { threadId,
// title } pair the FTS header row is built from. ONE derivation shared by
// the rebuild below and (via threadDisplayTitle) the chat store's write-time
// indexing, so a rebuild reproduces byte-identical header rows — including
// snippet-derived titles for untitled threads. Ownership is validated with
// the chat store's fail-closed posture: both owners, neither owner, or a
// channel owner that no longer exists is corrupt state, never a search row.
export function validatedThreadSearchRow(
  row: Record<string, unknown>,
  corrupt: (cause?: unknown) => Error,
): { threadId: string; title: string } {
  const threadId = String(row.thread_id ?? "");
  const title = typeof row.title === "string" ? row.title : null;
  if (!threadId || title === null) throw corrupt();
  const linkedObjectId = row.linked_object_id ?? null;
  const channelId = row.channel_id ?? null;
  if (linkedObjectId !== null && channelId !== null) throw corrupt();
  if (linkedObjectId === null && channelId === null) throw corrupt();
  if (channelId !== null && Number(row.channel_owner_exists) !== 1) throw corrupt();
  const firstBody = typeof row.first_body === "string" ? row.first_body : undefined;
  return { threadId, title: threadDisplayTitle(title, firstBody) };
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

function rebuildFileSearchIndexForVersion(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  policy: EngineSearchPolicySnapshot;
}): void {
  const files = input.db
    .prepare(
      `SELECT candidate.*, b.text
       FROM (
         SELECT s.workspace_id, s.version_id, s.object_id, s.path, s.blob_sha256
         FROM snapshots s
         WHERE s.workspace_id = ? AND s.version_id = ?
           AND COALESCE(s.content_kind, 'text') = 'text'
         UNION ALL
         SELECT fb.workspace_id, fb.version_id, fb.object_id, fb.path, fb.blob_sha256
         FROM fork_base_snapshots fb
         WHERE fb.workspace_id = ? AND fb.version_id = ?
           AND COALESCE(fb.content_kind, 'text') = 'text'
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
    if (!pathIsSearchIndexed(input.rootDir, path, input.policy)) continue;
    insertFile.run(
      input.workspaceId,
      input.versionId,
      String(row.object_id),
      path,
      String(row.text),
    );
  }
}

export function ensureSearchIndexForVersion(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  nowMs: number;
  corrupt: (cause?: unknown) => Error;
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
  // A broken policy fails closed for FILE indexing only: file visibility is
  // exactly what the policy governs, so leave the file index empty. Chat
  // indexing (which file policy does NOT govern) still runs below, and no
  // index_state is recorded while degraded so fixing/removing the policy file
  // triggers a full rebuild. Query-time pathIsSearchIndexed also fails file
  // search closed regardless of what the index happens to hold.
  const policyOk = policy.diagnostics.length === 0;
  if (policyOk) {
    rebuildFileSearchIndexForVersion({
      db: input.db,
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      policy,
    });
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
      `SELECT t.thread_id, t.title, t.linked_object_id, t.channel_id,
              (SELECT m.body FROM chat_messages m
               WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id
               ORDER BY m.created_at_ms, m.message_id LIMIT 1) AS first_body,
              EXISTS(SELECT 1 FROM chat_channels c
               WHERE c.workspace_id = t.workspace_id AND c.channel_id = t.channel_id)
                AS channel_owner_exists
       FROM chat_threads t
       WHERE t.workspace_id = ?
       ORDER BY t.created_at_ms, t.thread_id`,
    )
    .all(input.workspaceId)) {
    const header = validatedThreadSearchRow(row, input.corrupt);
    insertChat.run(
      input.workspaceId,
      header.threadId,
      THREAD_HEADER_MESSAGE_ID,
      chatIndexText({ title: header.title }),
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
  // Only mark the version indexed when the file index is authoritative. While
  // the policy is degraded the file index was intentionally skipped, so
  // leaving index_state unset forces a rebuild once the policy is fixed.
  if (policyOk) {
    input.db
      .prepare(
        `INSERT INTO engine_search_index_state (workspace_id, version_id, indexed_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, version_id) DO UPDATE SET indexed_at_ms = excluded.indexed_at_ms`,
      )
      .run(input.workspaceId, input.versionId, input.nowMs);
  }
}

function ftsQueryForSubstring(query: string): string | null {
  const normalized = query.trim();
  if ([...normalized].length < MIN_TRIGRAM_QUERY_CHARS) return null;
  return `"${normalized.replaceAll('"', '""')}"`;
}

function rowText(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? "");
}

export function queryChatMessagesGranular(
  db: EngineSqliteDb,
  input: {
    workspaceId: WorkspaceId;
    query: string;
    limit: number;
  },
): GranularChatMessageSearchResult[] {
  const match = ftsQueryForSubstring(input.query);
  if (!match || !Number.isSafeInteger(input.limit) || input.limit <= 0) return [];
  return db
    .prepare(
      `SELECT thread_id, message_id, text
       FROM engine_search_chat_messages_fts
       WHERE engine_search_chat_messages_fts MATCH ?
         AND workspace_id = ?
       ORDER BY rowid
       LIMIT ?`,
    )
    .all(match, input.workspaceId, input.limit)
    .map((row) => {
      const messageId = rowText(row, "message_id");
      return {
        threadId: rowText(row, "thread_id"),
        messageId: messageId === THREAD_HEADER_MESSAGE_ID ? null : messageId,
        text: rowText(row, "text"),
      };
    });
}

export function querySearchIndex(input: {
  db: EngineSqliteDb;
  rootDir: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  query: string;
  limit: number;
}): IndexedSearchCandidate[] | null {
  const policy = readEngineSearchPolicySync(input.rootDir);
  const match = ftsQueryForSubstring(input.query);
  if (!match) {
    // A query too short for the trigram index normally returns null so the
    // caller does a linear scan — but under a broken policy that linear scan
    // fails OPEN (default visibility), so fail CLOSED with an empty result set
    // (non-null) to suppress the fallback. A healthy policy keeps the null.
    return policy.diagnostics.length > 0 ? [] : null;
  }
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
