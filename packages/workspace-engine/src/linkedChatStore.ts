import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  ChannelThreadSummary,
  ChatAgentReadState,
  ChatActor,
  ChatAttachment,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatDecisionRecord,
  ChatDecisionState,
  ChatMessage,
  ChatMessageId,
  ChatReaction,
  ChatReactionAuthor,
  ChatReactionState,
  ChatMentionRecord,
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
import { parseMentionHandles } from "./chatMentions";
import {
  THREAD_SNIPPET_TITLE_MAX_CHARS,
  UNTITLED_THREAD_FALLBACK_TITLE,
  threadDisplayTitle,
  threadSnippetTitle,
} from "./chatThreadTitle";
import {
  ackReplicationPeer,
  appliedApplyResult,
  ensureOriginId,
  journalLocalReplicationOp,
  journalReplicationOp,
  nextOriginSeq,
  readReplicationAckedSeq,
  skippedApplyResult,
  type ChatAttachmentAddPayload,
  type ChatChannelCreatePayload,
  type ChatDecisionSetPayload,
  type ChatMessageAppendPayload,
  type ChatReactionSetPayload,
  type ChatThreadCreatePayload,
} from "./syncReplication";

export const LINKED_CHAT_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;
export const LINKED_CHAT_PROJECTION_KIND = "thread";

export type {
  ChannelThreadSummary,
  ChatAgentReadState,
  ChatActor,
  ChatAttachment,
  ChatChannel,
  ChatChannelId,
  ChatChannelKind,
  ChatChannelSummary,
  ChatDecisionRecord,
  ChatDecisionState,
  ChatMessage,
  ChatMessageId,
  ChatReaction,
  ChatReactionAuthor,
  ChatReactionState,
  ChatMentionRecord,
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
export const AGENT_CHANNEL_WIRE_ID = "channel_wire_agent_v1";
export const AGENT_CHANNEL_NAME = "My agent";
const OPENING_MESSAGE_BODY_SNIPPET_MAX_CHARS = 500;
// Display-title derivation lives in chatThreadTitle.ts (a leaf shared with
// the search index rebuild); re-exported here so store consumers keep one
// import surface.
export { THREAD_SNIPPET_TITLE_MAX_CHARS, UNTITLED_THREAD_FALLBACK_TITLE, threadSnippetTitle };

function openingMessageBodySnippet(body: string): string {
  if (body.length <= OPENING_MESSAGE_BODY_SNIPPET_MAX_CHARS) return body;
  return `${body.slice(0, OPENING_MESSAGE_BODY_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

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

function isNormalizedPathHint(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  const result = validateUserWritePath(path);
  return result.ok && result.normalized === path;
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
  if (kind !== "channel" && kind !== "dm" && kind !== "agent") {
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

// WS-MU-C0: the caller-supplied OPAQUE relay user id for a message. Absent for
// solo/legacy sends (returns undefined, so the op stays byte-identical to the
// pre-MU-C0 shape). When present it is trimmed and length-capped like the
// reaction author id; it is NEVER derived from the display name (identity and
// display are separate fields).
function normalizeAuthorUserId(authorUserId: string | undefined): string | undefined {
  if (authorUserId === undefined) return undefined;
  // Type-guard like the sibling boundary validators (normalizeActor,
  // normalizeReactionEmoji): a non-string from a loosely-typed IPC/tool payload
  // must surface the typed "invalid-sender" error, not a raw TypeError from
  // .trim(), so callers that switch on `.code` stay well-behaved.
  if (typeof authorUserId !== "string") {
    throw new LinkedChatStoreError("invalid-sender", "Chat author user id is invalid.");
  }
  const normalized = authorUserId.trim();
  if (!normalized || normalized.length > 200) {
    throw new LinkedChatStoreError("invalid-sender", "Chat author user id is invalid.");
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

function normalizeParentMessageId(parentMessageId: string | undefined): string | undefined {
  if (parentMessageId === undefined) return undefined;
  if (typeof parentMessageId !== "string" || parentMessageId.length === 0) {
    throw new LinkedChatStoreError("invalid-message-body", "Parent message id is invalid.");
  }
  return parentMessageId;
}

function normalizeMessageOrigin(origin: "cli" | undefined): "cli" | undefined {
  if (origin === undefined) return undefined;
  if (origin !== "cli") {
    throw new LinkedChatStoreError("invalid-message-body", "Message origin is invalid.");
  }
  return origin;
}

function normalizeAttachments(
  attachments: Array<{ objectId: WorkspaceObjectId; pathHint?: string }> | undefined,
): Array<{ objectId: WorkspaceObjectId; pathHint?: string }> {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) {
    throw new LinkedChatStoreError("invalid-path", "Message attachments are invalid.");
  }
  const normalized: Array<{ objectId: WorkspaceObjectId; pathHint?: string }> = [];
  const seenObjectIds = new Set<WorkspaceObjectId>();
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      throw new LinkedChatStoreError("invalid-path", "Message attachment is invalid.");
    }
    if (
      typeof attachment.objectId !== "string" ||
      (attachment.pathHint !== undefined && typeof attachment.pathHint !== "string")
    ) {
      throw new LinkedChatStoreError("invalid-path", "Message attachment is invalid.");
    }
    const objectId = normalizeObjectId(attachment.objectId);
    if (seenObjectIds.has(objectId)) continue;
    seenObjectIds.add(objectId);
    const pathHint =
      attachment.pathHint === undefined ? undefined : normalizePathHint(attachment.pathHint);
    normalized.push({ objectId, ...(pathHint !== undefined ? { pathHint } : {}) });
  }
  return normalized;
}

function normalizeMentionHandle(handle: string): string {
  if (typeof handle !== "string") {
    throw new LinkedChatStoreError("invalid-message-body", "Mention handle is invalid.");
  }
  const normalized = handle.toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(normalized)) {
    throw new LinkedChatStoreError("invalid-message-body", "Mention handle is invalid.");
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
          ORDER BY m.created_at_ms, m.message_id LIMIT 1) AS first_body,
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
  if (kind !== "channel" && kind !== "dm" && kind !== "agent") throw corruptStore();
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
  // author_user_id (WS-MU-C0) is the OPAQUE relay identity, kept SEPARATE from
  // the display-only author. NULL/absent for solo/legacy messages.
  const authorUserId = optionalString(row.author_user_id);
  const parentMessageId = optionalString(row.parent_message_id);
  const origin = optionalString(row.origin);
  if (parentMessageId !== undefined && parentMessageId.length === 0) throw corruptStore();
  if (origin !== undefined && origin !== "cli") throw corruptStore();
  return {
    id: stringValue(row.message_id),
    workspaceId: stringValue(row.workspace_id),
    threadId: stringValue(row.thread_id),
    author: {
      kind: actorKindValue(row.author_kind),
      displayName: stringValue(row.author_display_name),
    },
    ...(authorUserId !== undefined ? { authorUserId } : {}),
    ...(parentMessageId !== undefined ? { parentMessageId } : {}),
    ...(origin !== undefined ? { origin } : {}),
    body: stringValue(row.body),
    createdAtMs: numberValue(row.created_at_ms),
    attachments: [],
  };
}

// Fail closed on a corrupt/hand-edited author_kind: an unknown kind must
// never render as a valid-looking non-agent message.
function actorKindValue(value: unknown): ChatActor["kind"] {
  const kind = stringValue(value);
  if (kind !== "human" && kind !== "agent") throw corruptStore();
  return kind;
}

// --- Reactions (WS-MU-C2) --------------------------------------------------

// The emoji allowlist bound: a reaction emoji is a short grapheme, never a
// message body. Emojis normalize to NFC so the same glyph is one cell.
const REACTION_EMOJI_MAX_CHARS = 32;

// Defense in depth for REPLICATED ops: the desktop bridge (bridgeContract.ts)
// already rejects non-emoji at the IPC trust boundary, but a reaction op can
// arrive from another peer that never passed through that check. Validate the
// codepoints here too so a hostile/buggy peer cannot land arbitrary short
// strings (URLs, text) as reaction pills. This mirrors EMOJI_GRAPHEME_PATTERN:
// one emoji grapheme cluster — a pictographic (optional variation selector /
// skin-tone / keycap) or a regional-indicator pair, plus ZWJ sequences. Unicode
// property escapes with the `u` flag are ES2018 and supported by every runtime
// this engine ships on.
const REACTION_EMOJI_ATOM =
  "(?:\\p{Regional_Indicator}\\p{Regional_Indicator}|\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F\\u20E3]*)";
const REACTION_EMOJI_PATTERN = new RegExp(
  `^${REACTION_EMOJI_ATOM}(?:\\u200D${REACTION_EMOJI_ATOM})*$`,
  "u",
);

// True iff `value` is a bounded, single emoji grapheme cluster. Used both by the
// LOCAL setReaction normalizer and by the REPLICATED-op apply path — the latter
// validates verbatim (no re-normalization) so the total-order cell key stays
// byte-identical across peers.
function isReactionEmoji(value: string): boolean {
  return (
    value.length > 0 && value.length <= REACTION_EMOJI_MAX_CHARS && REACTION_EMOJI_PATTERN.test(value)
  );
}

function normalizeReactionEmoji(emoji: string): string {
  if (typeof emoji !== "string") {
    throw new LinkedChatStoreError("invalid-message-body", "Reaction emoji must be a string.");
  }
  const normalized = emoji.normalize("NFC").trim();
  if (normalized.length === 0 || normalized.length > REACTION_EMOJI_MAX_CHARS) {
    throw new LinkedChatStoreError(
      "invalid-message-body",
      "Reaction emoji must be a short non-empty grapheme.",
    );
  }
  if (!isReactionEmoji(normalized)) {
    throw new LinkedChatStoreError(
      "invalid-message-body",
      "Reaction emoji must be a single emoji grapheme.",
    );
  }
  return normalized;
}

function reactionStateValue(value: unknown): ChatReactionState {
  const state = stringValue(value);
  if (state !== "added" && state !== "removed") throw corruptStore();
  return state;
}

// Stable cross-machine reaction id: a deterministic function of the CELL
// coordinates. Same (message, emoji, author) => same id on every machine, so
// an add and its later remove address ONE register. NUL separators keep the
// join unambiguous (no emoji/id can contain a NUL).
function reactionIdFor(messageId: string, emoji: string, authorId: string): string {
  const digest = createHash("sha256")
    .update(`${messageId}\u0000${emoji}\u0000${authorId}`, "utf8")
    .digest();
  return `reaction_${base32LowercaseNoPadding(digest.subarray(0, 16))}`;
}

function reactionFromRow(row: Record<string, unknown>): ChatReaction {
  return {
    reactionId: stringValue(row.reaction_id),
    threadId: stringValue(row.thread_id),
    messageId: stringValue(row.message_id),
    emoji: stringValue(row.emoji),
    author: {
      authorId: stringValue(row.author_id),
      kind: actorKindValue(row.author_kind),
      displayName: stringValue(row.author_display_name),
    },
    state: reactionStateValue(row.state),
    atMs: numberValue(row.at_ms),
  };
}

function attachmentIdFor(messageId: ChatMessageId, objectId: WorkspaceObjectId): string {
  return createHash("sha256").update(`${messageId}file${objectId}`, "utf8").digest("hex");
}

function attachmentFromRow(row: Record<string, unknown>): ChatAttachment {
  if (stringValue(row.target_kind) !== "file") throw corruptStore();
  const objectId = optionalString(row.object_id);
  const pathHint = optionalString(row.path_hint);
  return {
    attachmentId: stringValue(row.attachment_id),
    threadId: stringValue(row.thread_id),
    messageId: stringValue(row.message_id),
    targetKind: "file",
    ...(objectId !== undefined ? { objectId } : {}),
    ...(pathHint !== undefined ? { pathHint } : {}),
    createdAtMs: numberValue(row.created_at_ms),
  };
}

function decisionStateValue(value: unknown): ChatDecisionState {
  const state = stringValue(value);
  if (state !== "open" && state !== "resolved") throw corruptStore();
  return state;
}

function decisionFromRow(row: Record<string, unknown>): ChatDecisionRecord {
  const resolvedByMessageId = optionalString(row.resolved_by_message_id);
  return {
    workspaceId: stringValue(row.workspace_id),
    threadId: stringValue(row.thread_id),
    messageId: stringValue(row.message_id),
    state: decisionStateValue(row.state),
    ...(resolvedByMessageId !== undefined ? { resolvedByMessageId } : {}),
    atMs: numberValue(row.at_ms),
  };
}

interface DecisionOpOrigin {
  originId: string;
  originSeq: number;
}

function upsertDecisionLww(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: ChatDecisionSetPayload,
  origin: DecisionOpOrigin,
): void {
  db.prepare(
    `INSERT INTO chat_decisions (
       workspace_id, thread_id, message_id, state, resolved_by_message_id,
       at_ms, origin_id, origin_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, message_id) DO UPDATE SET
       thread_id = excluded.thread_id,
       state = excluded.state,
       resolved_by_message_id = excluded.resolved_by_message_id,
       at_ms = excluded.at_ms,
       origin_id = excluded.origin_id,
       origin_seq = excluded.origin_seq
     WHERE excluded.at_ms > chat_decisions.at_ms
        OR (excluded.at_ms = chat_decisions.at_ms
            AND (CASE excluded.state WHEN 'resolved' THEN 1 ELSE 0 END) >
                (CASE chat_decisions.state WHEN 'resolved' THEN 1 ELSE 0 END))
        OR (excluded.at_ms = chat_decisions.at_ms
            AND excluded.state = chat_decisions.state
            AND (excluded.origin_id > chat_decisions.origin_id
              OR (excluded.origin_id = chat_decisions.origin_id
                  AND excluded.origin_seq > chat_decisions.origin_seq)))`,
  ).run(
    workspaceId,
    payload.threadId,
    payload.messageId,
    payload.state,
    payload.resolvedByMessageId ?? null,
    payload.atMs,
    origin.originId,
    origin.originSeq,
  );
}

function insertAttachment(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: ChatAttachmentAddPayload,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO chat_attachments (
       workspace_id, attachment_id, thread_id, message_id, target_kind,
       object_id, path_hint, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workspaceId,
    payload.attachmentId,
    payload.threadId,
    payload.messageId,
    payload.targetKind,
    payload.objectId ?? null,
    payload.pathHint ?? null,
    payload.createdAtMs,
  );
}

function indexMessageMentions(input: {
  db: SqliteDb;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  authorKind: ChatActor["kind"];
  body: string;
  createdAtMs: number;
}): void {
  const insert = input.db.prepare(
    `INSERT OR IGNORE INTO chat_mentions (
       workspace_id, thread_id, message_id, handle, author_kind, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const handle of parseMentionHandles(input.body)) {
    insert.run(
      input.workspaceId,
      input.threadId,
      input.messageId,
      handle,
      input.authorKind,
      input.createdAtMs,
    );
  }
}

function journalDecisionSet(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: ChatDecisionSetPayload,
): void {
  const originId = ensureOriginId(db, workspaceId);
  const originSeq = nextOriginSeq(db, workspaceId, originId);
  upsertDecisionLww(db, workspaceId, payload, { originId, originSeq });
  journalReplicationOp(db, {
    workspaceId,
    originId,
    originSeq,
    opKind: "chat.decision.set",
    payload,
    recordedAtMs: payload.atMs,
  });
}

function addLocalAttachments(input: {
  db: SqliteDb;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  attachments: Array<{ objectId: WorkspaceObjectId; pathHint?: string }>;
  createdAtMs: number;
}): ChatAttachment[] {
  return input.attachments.map((attachment) => {
    const payload: ChatAttachmentAddPayload = {
      attachmentId: attachmentIdFor(input.messageId, attachment.objectId),
      threadId: input.threadId,
      messageId: input.messageId,
      targetKind: "file",
      objectId: attachment.objectId,
      ...(attachment.pathHint !== undefined ? { pathHint: attachment.pathHint } : {}),
      createdAtMs: input.createdAtMs,
    };
    insertAttachment(input.db, input.workspaceId, payload);
    journalLocalReplicationOp(input.db, {
      workspaceId: input.workspaceId,
      opKind: "chat.attachment.add",
      payload,
      recordedAtMs: input.createdAtMs,
    });
    return {
      attachmentId: payload.attachmentId,
      threadId: payload.threadId,
      messageId: payload.messageId,
      targetKind: payload.targetKind,
      objectId: attachment.objectId,
      ...(payload.pathHint !== undefined ? { pathHint: payload.pathHint } : {}),
      createdAtMs: payload.createdAtMs,
    };
  });
}

// ⚠️ CLOCK SKEW — ACCEPTED ALPHA LIMITATION (determinism > the rare skew-pin).
// A replicated reaction op's at_ms is stored VERBATIM — NEVER re-clamped against
// the receiver's local clock. An earlier build clamped an implausible-future
// at_ms back toward (receiverNow + allowance) to stop a runaway-forward remote
// clock pinning a cell. That clamp REGRESSED convergence: two peers clamp
// against their OWN clocks, so the SAME op converges to DIFFERENT at_ms on
// different peers, and a later op sitting between the two clamps wins on one
// peer and loses on another → permanent divergence. Determinism of the total
// order (at_ms, stateRank, origin_id, origin_seq) has to be byte-identical on
// every peer, so the receiver-local clamp is GONE.
//
// The re-opened liveness issue: a device with a badly-forward wall clock can
// stamp a cell with an at_ms no correctly-clocked peer will ever exceed,
// pinning that cell (a later, lower-at_ms remove is rejected everywhere). This
// is an accepted alpha limitation. A proper fix is a hybrid logical clock (HLC)
// or a relay-stamped monotonic time on shared channels; both are deferred (see
// MU chat design + MU-C0). Note the LOCAL set path keeps a per-cell monotonic
// at_ms bump — that is local authorship, deterministic per origin, and does not
// vary by receiver, so it is safe.

// The origin coordinates that make the LWW register a TOTAL order. Read from
// the replication envelope on the apply path; minted locally (this device's
// origin + the seq the op will journal at) on the local set path.
interface ReactionOpOrigin {
  originId: string;
  originSeq: number;
}

// The whole CRDT apply, as ONE conflict-target upsert. The cell is an LWW
// register: the incoming op wins iff it is strictly greater by the TOTAL order
// (at_ms, then stateRank['removed'=1 > 'added'=0] — remove-wins on a tie, then
// origin_id, then origin_seq). Because (origin_id, origin_seq) uniquely
// identifies every op in the system, the tuple is a STRICT total order with no
// residual ties, so two ops with equal (at_ms, state) but different origins
// resolve to the SAME winner on every peer regardless of arrival order (no
// arrival-order-dependent divergence). 'removed' > 'added' is a plain lexical
// compare that encodes remove=1 > add=0. Equal tuple is not strictly greater,
// so a re-apply is a no-op (idempotent). Winner = `max` over a total order, so
// applying the same ops in ANY order converges (commutative). Shared verbatim
// by the local set path and the replicated apply path so their semantics can
// never drift.
function upsertReactionLww(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: ChatReactionSetPayload,
  origin: ReactionOpOrigin,
): void {
  db.prepare(
    `INSERT INTO chat_reactions (
       workspace_id, reaction_id, thread_id, message_id, emoji,
       author_id, author_kind, author_display_name, state, at_ms,
       origin_id, origin_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, message_id, emoji, author_id) DO UPDATE SET
       reaction_id = excluded.reaction_id,
       thread_id = excluded.thread_id,
       author_kind = excluded.author_kind,
       author_display_name = excluded.author_display_name,
       state = excluded.state,
       at_ms = excluded.at_ms,
       origin_id = excluded.origin_id,
       origin_seq = excluded.origin_seq
     WHERE excluded.at_ms > chat_reactions.at_ms
        OR (excluded.at_ms = chat_reactions.at_ms
            AND (excluded.state > chat_reactions.state
              OR (excluded.state = chat_reactions.state
                  AND (excluded.origin_id > chat_reactions.origin_id
                    OR (excluded.origin_id = chat_reactions.origin_id
                        AND excluded.origin_seq > chat_reactions.origin_seq)))))`,
  ).run(
    workspaceId,
    payload.reactionId,
    payload.threadId,
    payload.messageId,
    payload.emoji,
    payload.authorId,
    payload.authorKind,
    payload.authorDisplayName,
    payload.state,
    payload.atMs,
    origin.originId,
    origin.originSeq,
  );
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

function attachmentsForThread(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): ChatAttachment[] {
  return db
    .prepare(
      `SELECT a.* FROM chat_attachments a
       JOIN chat_messages m
         ON m.workspace_id = a.workspace_id
        AND m.thread_id = a.thread_id
        AND m.message_id = a.message_id
       WHERE a.workspace_id = ? AND a.thread_id = ?
       ORDER BY a.created_at_ms, a.attachment_id`,
    )
    .all(workspaceId, threadId)
    .map(attachmentFromRow);
}

function agentReadStateForThread(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): ChatAgentReadState {
  const row = db
    .prepare(
      `SELECT last_read_created_at_ms, last_read_message_id, revision, updated_at_ms
       FROM chat_agent_read_state WHERE workspace_id = ? AND thread_id = ?`,
    )
    .get(workspaceId, threadId);
  if (!row) {
    return {
      workspaceId,
      threadId,
      lastReadCreatedAtMs: 0,
      lastReadMessageId: "",
      revision: 0,
      updatedAtMs: 0,
    };
  }
  const revision = numberValue(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw corruptStore();
  return {
    workspaceId,
    threadId,
    lastReadCreatedAtMs: numberValue(row.last_read_created_at_ms),
    lastReadMessageId: stringValue(row.last_read_message_id),
    revision,
    updatedAtMs: numberValue(row.updated_at_ms),
  };
}

function messageCoordinateCompare(
  left: { createdAtMs: number; messageId: string },
  right: { createdAtMs: number; messageId: string },
): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
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

  function serialize<T>(task: (db: SqliteDb) => T): Promise<T> {
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

  function withTransaction<T>(task: (db: SqliteDb) => T): T {
    const txDb = db();
    try {
      txDb.exec("BEGIN IMMEDIATE");
      // Every linked-chat transaction is synchronous. Committing in the same
      // turn is important because node:sqlite waits synchronously on a busy
      // second connection: yielding here can leave our write lock held while
      // that connection blocks the event loop that would release it.
      const result = task(txDb);
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
    const messages = db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE workspace_id = ? AND thread_id = ?
         ORDER BY created_at_ms, message_id`,
      )
      .all(workspaceId, threadId)
      .map(messageFromRow);
    const attachmentsByMessage = new Map<ChatMessageId, ChatAttachment[]>();
    for (const attachment of attachmentsForThread(db, workspaceId, threadId)) {
      const existing = attachmentsByMessage.get(attachment.messageId) ?? [];
      existing.push(attachment);
      attachmentsByMessage.set(attachment.messageId, existing);
    }
    return messages.map((message) => ({
      ...message,
      attachments: attachmentsByMessage.get(message.id) ?? [],
    }));
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
      return serialize((db) => {
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
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const name = normalizeChannelName(input.name);
        const kind = normalizeChannelKind(input.kind);
        if (kind === "agent") {
          throw new LinkedChatStoreError(
            "invalid-channel-kind",
            "Agent channels are provisioned automatically.",
          );
        }
        const slug = channelSlugForName(name);
        if (!slug) {
          throw new LinkedChatStoreError(
            "invalid-channel-name",
            "Channel name must contain at least one letter or number.",
          );
        }
        if (slug === channelSlugForName(AGENT_CHANNEL_NAME)) {
          throw new LinkedChatStoreError(
            "channel-exists",
            "The My agent channel name is reserved.",
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
      return serialize((db) => {
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

    ensureAgentChannel(input) {
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const mappedChannelId = channelIdForWireId(db, workspaceId, AGENT_CHANNEL_WIRE_ID);
        if (mappedChannelId !== undefined) {
          const mapped = requireWorkspaceChannel(db, workspaceId, mappedChannelId);
          if (
            mapped.kind !== "agent" ||
            mapped.name !== AGENT_CHANNEL_NAME ||
            mapped.slug !== channelSlugForName(AGENT_CHANNEL_NAME)
          ) {
            throw corruptStore();
          }
          return cloneJson(mapped);
        }
        const slug = channelSlugForName(AGENT_CHANNEL_NAME);
        const existing = db
          .prepare("SELECT * FROM chat_channels WHERE workspace_id = ? AND slug = ?")
          .get(workspaceId, slug);
        if (existing) {
          const channel = channelFromRow(existing);
          if (channel.kind !== "agent" || channel.name !== AGENT_CHANNEL_NAME) {
            throw new LinkedChatStoreError(
              "channel-exists",
              "The reserved My agent channel name is already in use.",
            );
          }
          recordChannelWireId(db, workspaceId, AGENT_CHANNEL_WIRE_ID, channel.id);
          return cloneJson(channel);
        }
        const recordedAtMs = nowMs();
        const channel: ChatChannel = {
          id: createId("channel"),
          workspaceId,
          name: AGENT_CHANNEL_NAME,
          slug,
          kind: "agent",
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
        };
        db.prepare(
          `INSERT INTO chat_channels (
            workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          channel.id,
          channel.name,
          channel.slug,
          channel.kind,
          recordedAtMs,
          recordedAtMs,
        );
        recordChannelWireId(db, workspaceId, AGENT_CHANNEL_WIRE_ID, channel.id);
        journalLocalReplicationOp(db, {
          workspaceId,
          opKind: "chat.channel.create",
          payload: {
            channelId: channel.id,
            name: channel.name,
            slug: channel.slug,
            kind: channel.kind,
            createdAtMs: recordedAtMs,
            wireId: AGENT_CHANNEL_WIRE_ID,
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

    // MU-C4: the cross-machine wire identity a shared-channel grant keys on.
    getChannelWireId(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const channel = requireWorkspaceChannel(db, workspaceId, input.channelId);
          return wireIdForChannelId(db, workspaceId, channel.id) ?? null;
        });
      });
    },

    // MU-C4: point lookup for the read-only write gate — resolve a thread to
    // its channel WITHOUT scanning every thread in the workspace. Null when
    // the thread is missing, cross-workspace, or not channel-bound (a
    // file-linked thread).
    findThreadChannelId(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const row = db
            .prepare(
              "SELECT channel_id FROM chat_threads WHERE workspace_id = ? AND thread_id = ?",
            )
            .get(workspaceId, input.threadId) as { channel_id?: unknown } | undefined;
          return row ? optionalString(row.channel_id) ?? null : null;
        });
      });
    },

    // Thread + first message in ONE transaction (the fast composer path): a
    // failed send can never strand an empty thread.
    startChannelThread(input) {
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const channel = requireWorkspaceChannel(db, workspaceId, input.channelId);
        const title = normalizeOptionalThreadTitle(input.title);
        const author = normalizeActor(input.author);
        const authorUserId = normalizeAuthorUserId(input.authorUserId);
        const origin = normalizeMessageOrigin(input.origin);
        const body = normalizeBody(input.body);
        const attachments = normalizeAttachments(input.attachments);
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
          ...(authorUserId !== undefined ? { authorUserId } : {}),
          ...(origin !== undefined ? { origin } : {}),
          body,
          createdAtMs: recordedAtMs,
          attachments: [],
        };
        db.prepare(
          `INSERT INTO chat_messages (
            workspace_id, thread_id, message_order, message_id, author_kind,
            author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms
          ) VALUES (?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(
          workspaceId,
          threadId,
          message.id,
          author.kind,
          author.displayName,
          authorUserId ?? null,
          origin ?? null,
          body,
          recordedAtMs,
        );
        indexMessageMentions({
          db,
          workspaceId,
          threadId,
          messageId: message.id,
          authorKind: author.kind,
          body,
          createdAtMs: recordedAtMs,
        });
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
            // WS-MU-C0: carry the verified identity ONLY when signed in (see
            // sendMessage). Solo omits it — byte-identical to the pre-MU-C0 shape.
            ...(authorUserId !== undefined ? { authorUserId } : {}),
            ...(origin !== undefined ? { origin } : {}),
            body,
            createdAtMs: recordedAtMs,
          } satisfies ChatMessageAppendPayload,
          recordedAtMs,
        });
        if (input.needsDecision === true) {
          journalDecisionSet(db, workspaceId, {
            threadId,
            messageId: message.id,
            state: "open",
            atMs: recordedAtMs,
          });
        }
        message.attachments = addLocalAttachments({
          db,
          workspaceId,
          threadId,
          messageId: message.id,
          attachments,
          createdAtMs: recordedAtMs,
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
          const rows = db
            .prepare(
              `SELECT ${THREAD_SELECT_COLUMNS},
                    opening.message_id AS opening_message_id,
                    opening.author_kind AS opening_author_kind,
                    opening.author_display_name AS opening_author_display_name,
                    opening.created_at_ms AS opening_created_at_ms,
                    (SELECT COUNT(*) FROM chat_messages m
                     WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id)
                      AS message_count,
                    COALESCE((SELECT rs.last_read_sequence FROM chat_thread_read_state rs
                              WHERE rs.workspace_id = t.workspace_id AND rs.thread_id = t.thread_id), 0)
                      AS last_read_sequence,
                    (SELECT COUNT(*) FROM chat_decisions d
                     JOIN chat_messages dm
                       ON dm.workspace_id = d.workspace_id
                      AND dm.thread_id = d.thread_id
                      AND dm.message_id = d.message_id
                     WHERE d.workspace_id = t.workspace_id
                       AND d.thread_id = t.thread_id
                       AND d.state = 'open') AS open_decision_count
               FROM chat_threads t
               LEFT JOIN chat_messages opening
                 ON opening.workspace_id = t.workspace_id
                AND opening.thread_id = t.thread_id
                AND opening.message_id = (
                  SELECT first.message_id FROM chat_messages first
                  WHERE first.workspace_id = t.workspace_id
                    AND first.thread_id = t.thread_id
                  ORDER BY first.created_at_ms, first.message_id LIMIT 1
                )
               WHERE t.workspace_id = ? AND t.channel_id = ?
               ORDER BY t.updated_at_ms DESC, t.thread_id DESC`,
            )
            .all(workspaceId, channel.id);
          const reactionsByMessageId = new Map<ChatMessageId, ChatReaction[]>();
          const reactionRows = db
            .prepare(
              `SELECT r.*
               FROM chat_threads t
               JOIN chat_messages opening
                 ON opening.workspace_id = t.workspace_id
                AND opening.thread_id = t.thread_id
                AND opening.message_id = (
                  SELECT first.message_id FROM chat_messages first
                  WHERE first.workspace_id = t.workspace_id
                    AND first.thread_id = t.thread_id
                  ORDER BY first.created_at_ms, first.message_id LIMIT 1
                )
               JOIN chat_reactions r
                 ON r.workspace_id = opening.workspace_id
                AND r.thread_id = opening.thread_id
                AND r.message_id = opening.message_id
               WHERE t.workspace_id = ? AND t.channel_id = ? AND r.state = 'added'
               ORDER BY r.at_ms, r.reaction_id`,
            )
            .all(workspaceId, channel.id);
          for (const reactionRow of reactionRows) {
            const reaction = reactionFromRow(reactionRow);
            const reactions = reactionsByMessageId.get(reaction.messageId) ?? [];
            reactions.push(reaction);
            reactionsByMessageId.set(reaction.messageId, reactions);
          }
          return rows
            .map((row): ChannelThreadSummary => {
              const messageCount = numberValue(row.message_count);
              const openingMessageId = optionalString(row.opening_message_id);
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
                openDecisionCount: numberValue(row.open_decision_count),
                ...(openingMessageId !== undefined
                  ? {
                      openingMessage: {
                        id: openingMessageId,
                        author: {
                          kind: actorKindValue(row.opening_author_kind),
                          displayName: stringValue(row.opening_author_display_name),
                        },
                        createdAtMs: numberValue(row.opening_created_at_ms),
                        bodySnippet: openingMessageBodySnippet(stringValue(row.first_body)),
                        reactions: reactionsByMessageId.get(openingMessageId) ?? [],
                      },
                    }
                  : {}),
              };
            })
            .map(cloneJson);
        });
      });
    },

    markThreadRead(input) {
      return serialize((db) => {
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
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        const authorUserId = normalizeAuthorUserId(input.authorUserId);
        const parentMessageId = normalizeParentMessageId(input.parentMessageId);
        const origin = normalizeMessageOrigin(input.origin);
        const attachments = normalizeAttachments(input.attachments);
        const message: ChatMessage = {
          id: createId("message"),
          workspaceId,
          threadId: thread.id,
          author: normalizeActor(input.author),
          ...(authorUserId !== undefined ? { authorUserId } : {}),
          ...(parentMessageId !== undefined ? { parentMessageId } : {}),
          ...(origin !== undefined ? { origin } : {}),
          body: normalizeBody(input.body),
          createdAtMs: nowMs(),
          attachments: [],
        };
        const count = messageCountForThread(db, workspaceId, thread.id);
        db.prepare(
          `INSERT INTO chat_messages (
            workspace_id, thread_id, message_order, message_id, author_kind,
            author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workspaceId,
          thread.id,
          count,
          message.id,
          message.author.kind,
          message.author.displayName,
          authorUserId ?? null,
          parentMessageId ?? null,
          origin ?? null,
          message.body,
          message.createdAtMs,
        );
        indexMessageMentions({
          db,
          workspaceId,
          threadId: thread.id,
          messageId: message.id,
          authorKind: message.author.kind,
          body: message.body,
          createdAtMs: message.createdAtMs,
        });
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
            // WS-MU-C0: carry the verified identity ONLY when the caller supplied
            // one (signed-in send). Omitting it keeps solo ops byte-identical to
            // the pre-MU-C0 shape and leaves the relay's optional check inert.
            ...(authorUserId !== undefined ? { authorUserId } : {}),
            ...(parentMessageId !== undefined ? { parentMessageId } : {}),
            ...(origin !== undefined ? { origin } : {}),
            body: message.body,
            createdAtMs: message.createdAtMs,
          } satisfies ChatMessageAppendPayload,
          recordedAtMs: message.createdAtMs,
        });
        if (input.needsDecision === true) {
          journalDecisionSet(db, workspaceId, {
            threadId: thread.id,
            messageId: message.id,
            state: "open",
            atMs: message.createdAtMs,
          });
        }
        message.attachments = addLocalAttachments({
          db,
          workspaceId,
          threadId: thread.id,
          messageId: message.id,
          attachments,
          createdAtMs: message.createdAtMs,
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

    resolveChatDecision(input) {
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        const resolvedByMessageId = normalizeParentMessageId(input.resolvedByMessageId);
        if (resolvedByMessageId === undefined) throw corruptStore();
        const currentRow = db
          .prepare(
            `SELECT * FROM chat_decisions
             WHERE workspace_id = ? AND thread_id = ? AND message_id = ?`,
          )
          .get(workspaceId, thread.id, input.messageId);
        if (!currentRow) {
          throw new LinkedChatStoreError(
            "decision-not-found",
            `Decision ${input.messageId} was not found in thread ${thread.id}.`,
          );
        }
        const current = decisionFromRow(currentRow);
        if (current.state === "resolved") return cloneJson(current);
        const atMs = Math.max(nowMs(), current.atMs + 1);
        journalDecisionSet(db, workspaceId, {
          threadId: thread.id,
          messageId: current.messageId,
          state: "resolved",
          resolvedByMessageId,
          atMs,
        });
        const resolved = db
          .prepare("SELECT * FROM chat_decisions WHERE workspace_id = ? AND message_id = ?")
          .get(workspaceId, current.messageId);
        if (!resolved) throw corruptStore();
        return cloneJson(decisionFromRow(resolved));
      });
    },

    listThreadDecisions(workspaceIdInput, threadId) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(workspaceIdInput);
        return withDb((db) => {
          const thread = requireWorkspaceThread(db, workspaceId, threadId);
          return db
            .prepare(
              `SELECT d.* FROM chat_decisions d
               JOIN chat_messages m
                 ON m.workspace_id = d.workspace_id
                AND m.thread_id = d.thread_id
                AND m.message_id = d.message_id
               WHERE d.workspace_id = ? AND d.thread_id = ?
               ORDER BY d.at_ms, d.message_id`,
            )
            .all(workspaceId, thread.id)
            .map(decisionFromRow)
            .map(cloneJson);
        });
      });
    },

    listThreadAttachments(workspaceIdInput, threadId) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(workspaceIdInput);
        return withDb((db) => {
          const thread = requireWorkspaceThread(db, workspaceId, threadId);
          return attachmentsForThread(db, workspaceId, thread.id).map(cloneJson);
        });
      });
    },

    markThreadReadByAgent(input) {
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
        if (
          typeof input.upTo.createdAtMs !== "number" ||
          !Number.isFinite(input.upTo.createdAtMs) ||
          typeof input.upTo.messageId !== "string" ||
          input.upTo.messageId.length === 0
        ) {
          throw new LinkedChatStoreError("invalid-read-cursor", "Agent read cursor is invalid.");
        }
        const current = agentReadStateForThread(db, workspaceId, thread.id);
        if (expectedRevision !== undefined && expectedRevision !== current.revision) {
          throw new LinkedChatStoreError(
            "read-state-revision-mismatch",
            `Read-state revision ${expectedRevision} is stale (current ${current.revision}).`,
          );
        }
        const latestRow = db
          .prepare(
            `SELECT created_at_ms, message_id FROM chat_messages
             WHERE workspace_id = ? AND thread_id = ?
             ORDER BY created_at_ms DESC, message_id DESC LIMIT 1`,
          )
          .get(workspaceId, thread.id);
        if (!latestRow) return cloneJson(current);
        const latest = {
          createdAtMs: numberValue(latestRow.created_at_ms),
          messageId: stringValue(latestRow.message_id),
        };
        const target = messageCoordinateCompare(input.upTo, latest) > 0 ? latest : input.upTo;
        if (
          messageCoordinateCompare(target, {
            createdAtMs: current.lastReadCreatedAtMs,
            messageId: current.lastReadMessageId,
          }) <= 0
        ) {
          return cloneJson(current);
        }
        const next: ChatAgentReadState = {
          workspaceId,
          threadId: thread.id,
          lastReadCreatedAtMs: target.createdAtMs,
          lastReadMessageId: target.messageId,
          revision: current.revision + 1,
          updatedAtMs: nowMs(),
        };
        db.prepare(
          `INSERT INTO chat_agent_read_state (
             workspace_id, thread_id, last_read_created_at_ms,
             last_read_message_id, revision, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, thread_id) DO UPDATE SET
             last_read_created_at_ms = excluded.last_read_created_at_ms,
             last_read_message_id = excluded.last_read_message_id,
             revision = excluded.revision,
             updated_at_ms = excluded.updated_at_ms`,
        ).run(
          workspaceId,
          thread.id,
          next.lastReadCreatedAtMs,
          next.lastReadMessageId,
          next.revision,
          next.updatedAtMs,
        );
        return cloneJson(next);
      });
    },

    listAgentUnreadThreads(workspaceIdInput) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(workspaceIdInput);
        return withDb((db) =>
          db
            .prepare(
              `SELECT ${THREAD_SELECT_COLUMNS}, latest.created_at_ms AS latest_created_at_ms,
                      latest.message_id AS latest_message_id
               FROM chat_threads t
               JOIN chat_messages latest
                 ON latest.workspace_id = t.workspace_id
                AND latest.thread_id = t.thread_id
                AND NOT EXISTS (
                  SELECT 1 FROM chat_messages newer
                  WHERE newer.workspace_id = latest.workspace_id
                    AND newer.thread_id = latest.thread_id
                    AND (newer.created_at_ms > latest.created_at_ms
                      OR (newer.created_at_ms = latest.created_at_ms
                          AND newer.message_id > latest.message_id))
                )
               LEFT JOIN chat_agent_read_state ars
                 ON ars.workspace_id = t.workspace_id AND ars.thread_id = t.thread_id
               WHERE t.workspace_id = ?
                 AND latest.author_kind = 'human'
                 AND (ars.thread_id IS NULL
                   OR latest.created_at_ms > ars.last_read_created_at_ms
                   OR (latest.created_at_ms = ars.last_read_created_at_ms
                       AND latest.message_id > ars.last_read_message_id))
               ORDER BY latest.created_at_ms DESC, latest.message_id DESC`,
            )
            .all(workspaceId)
            .map(threadFromRow)
            .map(cloneJson),
        );
      });
    },

    listMentionsForHandle(workspaceIdInput, handleInput, options = {}) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(workspaceIdInput);
        const handle = normalizeMentionHandle(handleInput);
        return withDb((db) => {
          const unreadClause = options.unreadByAgentOnly
            ? `AND (ars.thread_id IS NULL
                 OR cm.created_at_ms > ars.last_read_created_at_ms
                 OR (cm.created_at_ms = ars.last_read_created_at_ms
                     AND cm.message_id > ars.last_read_message_id))`
            : "";
          const rows = db
            .prepare(
              `SELECT cm.* FROM chat_mentions cm
               JOIN chat_messages m
                 ON m.workspace_id = cm.workspace_id
                AND m.thread_id = cm.thread_id
                AND m.message_id = cm.message_id
               JOIN chat_threads t
                 ON t.workspace_id = cm.workspace_id AND t.thread_id = cm.thread_id
               LEFT JOIN chat_agent_read_state ars
                 ON ars.workspace_id = cm.workspace_id AND ars.thread_id = cm.thread_id
               WHERE cm.workspace_id = ? AND cm.handle = ? ${unreadClause}
               ORDER BY cm.created_at_ms, cm.message_id`,
            )
            .all(workspaceId, handle);
          for (const thread of new Set(rows.map((row) => stringValue(row.thread_id)))) {
            requireWorkspaceThread(db, workspaceId, thread);
          }
          return rows
            .map((row): ChatMentionRecord => ({
              threadId: stringValue(row.thread_id),
              messageId: stringValue(row.message_id),
              handle: stringValue(row.handle),
              authorKind: actorKindValue(row.author_kind),
              createdAtMs: numberValue(row.created_at_ms),
            }))
            .map(cloneJson);
        });
      });
    },

    setReaction(input) {
      return serialize((db) => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        // requireWorkspaceThread fails closed on a foreign-workspace thread;
        // the message must live in THIS thread so a reaction can never target a
        // message the caller cannot see.
        const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
        const messageExists = db
          .prepare(
            "SELECT 1 FROM chat_messages WHERE workspace_id = ? AND thread_id = ? AND message_id = ?",
          )
          .get(workspaceId, thread.id, input.messageId);
        if (!messageExists) {
          throw new LinkedChatStoreError(
            "message-not-found",
            `Message ${input.messageId} was not found in thread ${thread.id}.`,
          );
        }
        const emoji = normalizeReactionEmoji(input.emoji);
        const authorId = stringValue(input.author.authorId).trim();
        if (!authorId || authorId.length > 200) {
          throw new LinkedChatStoreError("invalid-sender", "Reaction author id is invalid.");
        }
        const authorKind = actorKindValue(input.author.kind);
        const authorDisplayName = normalizeDisplayName(input.author.displayName);
        const state = reactionStateValue(input.state);
        // Local writes are strictly monotonic PER CELL. A fast toggle
        // (remove → re-add) can reuse the same wall-clock ms; under the
        // remove-wins tie in the total order, stateRank outranks origin_seq, so
        // the causally-later re-add would otherwise LOSE to the just-written
        // remove. Bumping past the stored cell's at_ms keeps the user's latest
        // local intent winning (and lets a deliberate local re-add override a
        // newer remote remove, which is what the click means).
        const priorRow = db
          .prepare(
            `SELECT at_ms FROM chat_reactions
             WHERE workspace_id = ? AND message_id = ? AND emoji = ? AND author_id = ?`,
          )
          .get(workspaceId, input.messageId, emoji, authorId);
        const priorAtMs = priorRow ? numberValue(priorRow.at_ms) : Number.NEGATIVE_INFINITY;
        const atMs = Math.max(nowMs(), priorAtMs + 1);
        const payload: ChatReactionSetPayload = {
          reactionId: reactionIdFor(input.messageId, emoji, authorId),
          messageId: input.messageId,
          threadId: thread.id,
          emoji,
          authorId,
          authorKind,
          authorDisplayName,
          state,
          atMs,
        };
        // Mint this device's origin + the seq the op will journal at BEFORE the
        // upsert, so the register stores the same (origin_id, origin_seq) the
        // op replicates with — the total-order tie-break has to match on both
        // paths. nextOriginSeq is stable here: nothing new is journaled until
        // the journalReplicationOp call below reuses this exact seq, and the
        // whole method runs under `serialize` so no concurrent write intrudes.
        const originId = ensureOriginId(db, workspaceId);
        const originSeq = nextOriginSeq(db, workspaceId, originId);
        // The LWW upsert IS the mutation — shared verbatim with the replicated
        // apply path so a local set and an imported op converge identically.
        // Both paths store at_ms verbatim; the only local adjustment is the
        // per-cell monotonic bump above (deterministic per origin, not
        // receiver-dependent — see the clock-skew note near upsertReactionLww).
        upsertReactionLww(db, workspaceId, payload, { originId, originSeq });
        // Blob-free, rides the SAME push/pull/apply pipeline as the other chat
        // ops (no new transport). Journaled even for a SOLO workspace so the
        // reaction replicates the moment the workspace starts syncing. Uses the
        // origin/seq captured above (not journalLocalReplicationOp) so the
        // journaled envelope's coordinates equal the register's.
        journalReplicationOp(db, {
          workspaceId,
          originId,
          originSeq,
          opKind: "chat.reaction.set",
          payload,
          recordedAtMs: payload.atMs,
        });
        // Return the RESOLVED cell (the winning register): for a local set that
        // is always this call's op, but reading it back keeps the contract
        // honest under a future clock skew.
        const row = db
          .prepare(
            `SELECT * FROM chat_reactions
             WHERE workspace_id = ? AND message_id = ? AND emoji = ? AND author_id = ?`,
          )
          .get(workspaceId, input.messageId, emoji, authorId);
        if (!row) throw corruptStore();
        return cloneJson(reactionFromRow(row));
      });
    },

    listReactions(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return withDb((db) => {
          const thread = requireWorkspaceThread(db, workspaceId, input.threadId);
          // Active membership only — tombstones ('removed') stay in the table
          // for LWW convergence but never surface. Oldest cell first so pills
          // render in a stable order. The INNER JOIN on chat_messages is the
          // visibility gate: a reaction is head-check-free at APPLY (it may land
          // before its message across origins) BUT must never leak to the UI for
          // a message that is absent — an orphan (no matching message row, or a
          // message the viewer can't see) is filtered out here. Orphans stay in
          // the table for eventual convergence; only PRESENT messages surface.
          return db
            .prepare(
              `SELECT r.* FROM chat_reactions r
               JOIN chat_messages m
                 ON m.workspace_id = r.workspace_id
                AND m.thread_id = r.thread_id
                AND m.message_id = r.message_id
               WHERE r.workspace_id = ? AND r.thread_id = ? AND r.state = 'added'
               ORDER BY r.at_ms, r.reaction_id`,
            )
            .all(workspaceId, thread.id)
            .map(reactionFromRow)
            .map(cloneJson);
        });
      });
    },

    applyReplicationOp(input): Promise<SyncApplyResult> {
      return serialize((db) => {
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
          if (
            typeof payload.channelId !== "string" ||
            payload.channelId.length === 0 ||
            typeof payload.name !== "string" ||
            payload.name.length === 0 ||
            typeof payload.slug !== "string" ||
            payload.slug.length === 0 ||
            (payload.kind !== "channel" && payload.kind !== "dm" && payload.kind !== "agent") ||
            typeof payload.createdAtMs !== "number" ||
            !Number.isFinite(payload.createdAtMs) ||
            (payload.wireId !== undefined &&
              (typeof payload.wireId !== "string" || payload.wireId.length === 0))
          ) {
            throw corruptStore();
          }
          const carriesAgentWire = payload.wireId === AGENT_CHANNEL_WIRE_ID;
          const canonicalAgentSlug = channelSlugForName(AGENT_CHANNEL_NAME);
          if (
            (payload.kind === "agent") !== carriesAgentWire ||
            (payload.slug === canonicalAgentSlug) !== carriesAgentWire ||
            (payload.name === AGENT_CHANNEL_NAME) !== carriesAgentWire ||
            (carriesAgentWire &&
              (payload.name !== AGENT_CHANNEL_NAME || payload.slug !== canonicalAgentSlug))
          ) {
            throw corruptStore();
          }
          // Wire id is the cross-machine channel identity; slug is only a
          // lookup alias. Same wire id = same channel (idempotent no-op);
          // same slug + different wire id = distinct channel whose LOCAL slug
          // gets a numbered variant. Pre-wire-id payloads fall back to slug
          // identity (the 0P-A initial wire truth).
          if (typeof payload.wireId === "string" && payload.wireId.length > 0) {
            const mappedChannelId = channelIdForWireId(db, workspaceId, payload.wireId);
            if (mappedChannelId !== undefined && carriesAgentWire) {
              const mapped = requireWorkspaceChannel(db, workspaceId, mappedChannelId);
              if (
                mapped.kind !== "agent" ||
                mapped.name !== AGENT_CHANNEL_NAME ||
                mapped.slug !== canonicalAgentSlug
              ) {
                throw corruptStore();
              }
            }
            if (mappedChannelId === undefined) {
              const existingAgent = carriesAgentWire
                ? db
                    .prepare("SELECT * FROM chat_channels WHERE workspace_id = ? AND slug = ?")
                    .get(workspaceId, canonicalAgentSlug)
                : undefined;
              if (existingAgent) {
                const channel = channelFromRow(existingAgent);
                if (channel.kind !== "agent" || channel.name !== AGENT_CHANNEL_NAME) {
                  throw corruptStore();
                }
                recordChannelWireId(db, workspaceId, payload.wireId, channel.id);
              } else {
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
              const agentPlaceholder = payload.channelWireId === AGENT_CHANNEL_WIRE_ID;
              if (
                payload.channelSlug !== undefined &&
                (payload.channelSlug === channelSlugForName(AGENT_CHANNEL_NAME)) !==
                  agentPlaceholder
              ) {
                throw corruptStore();
              }
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
                if (agentPlaceholder) {
                  const mapped = requireWorkspaceChannel(db, workspaceId, mappedChannelId);
                  if (
                    mapped.kind !== "agent" ||
                    mapped.name !== AGENT_CHANNEL_NAME ||
                    mapped.slug !== channelSlugForName(AGENT_CHANNEL_NAME)
                  ) {
                    throw corruptStore();
                  }
                }
                channelId = mappedChannelId;
              } else if (existingChannel) {
                channelId = stringValue(existingChannel.channel_id);
              } else {
                const placeholderSlug =
                  typeof payload.channelSlug === "string" && payload.channelSlug.length > 0
                    ? payload.channelSlug
                    : (payload.channelWireId as string);
                const canonicalAgentSlug = channelSlugForName(AGENT_CHANNEL_NAME);
                const agentSlugRow = agentPlaceholder
                  ? db
                      .prepare(
                        "SELECT * FROM chat_channels WHERE workspace_id = ? AND slug = ?",
                      )
                      .get(workspaceId, canonicalAgentSlug)
                  : undefined;
                if (agentSlugRow) {
                  const agentChannel = channelFromRow(agentSlugRow);
                  if (agentChannel.kind !== "agent" || agentChannel.name !== AGENT_CHANNEL_NAME) {
                    throw corruptStore();
                  }
                  channelId = agentChannel.id;
                } else {
                  channelId = createId("channel");
                  db.prepare(
                    `INSERT INTO chat_channels (
                      workspace_id, channel_id, name, slug, kind, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  ).run(
                    workspaceId,
                    channelId,
                    agentPlaceholder ? AGENT_CHANNEL_NAME : placeholderSlug,
                    agentPlaceholder
                      ? canonicalAgentSlug
                      : nextFreeChannelSlug(db, workspaceId, placeholderSlug),
                    agentPlaceholder ? "agent" : "channel",
                    input.recordedAtMs,
                    input.recordedAtMs,
                  );
                }
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
          if (
            typeof payload.messageId !== "string" ||
            payload.messageId.length === 0 ||
            typeof payload.threadId !== "string" ||
            payload.threadId.length === 0 ||
            (payload.authorKind !== "human" && payload.authorKind !== "agent") ||
            typeof payload.authorDisplayName !== "string" ||
            payload.authorDisplayName.length === 0 ||
            (payload.authorUserId !== undefined &&
              (typeof payload.authorUserId !== "string" || payload.authorUserId.length === 0)) ||
            (payload.parentMessageId !== undefined &&
              (typeof payload.parentMessageId !== "string" ||
                payload.parentMessageId.length === 0)) ||
            (payload.origin !== undefined && payload.origin !== "cli") ||
            typeof payload.body !== "string" ||
            payload.body.length === 0 ||
            typeof payload.createdAtMs !== "number" ||
            !Number.isFinite(payload.createdAtMs)
          ) {
            throw corruptStore();
          }
          requireWorkspaceThread(db, workspaceId, payload.threadId);
          if (
            !db
              .prepare("SELECT 1 FROM chat_messages WHERE workspace_id = ? AND message_id = ?")
              .get(workspaceId, payload.messageId)
          ) {
            const messageOrder = nextMessageOrder(db, workspaceId, payload.threadId);
            // WS-MU-C0: `authorUserId` is the sender's OPAQUE relay identity. On
            // a REPLICATED op it is authoritative ONLY because the relay verified
            // `authorUserId === actor.userId` before admitting it to the log — the
            // engine has no origin→user map and cannot check it here (see the
            // chat.reaction.set note below). Absent on solo/legacy ops (persisted
            // as NULL). Never derived from the display name.
            const authorUserId = optionalString(payload.authorUserId) ?? null;
            const parentMessageId = optionalString(payload.parentMessageId) ?? null;
            const origin = payload.origin ?? null;
            db.prepare(
              `INSERT INTO chat_messages (
                workspace_id, thread_id, message_order, message_id, author_kind,
                author_display_name, author_user_id, parent_message_id, origin, body, created_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              workspaceId,
              payload.threadId,
              messageOrder,
              payload.messageId,
              payload.authorKind,
              payload.authorDisplayName,
              authorUserId,
              parentMessageId,
              origin,
              payload.body,
              payload.createdAtMs,
            );
            indexMessageMentions({
              db,
              workspaceId,
              threadId: payload.threadId,
              messageId: payload.messageId,
              authorKind: payload.authorKind,
              body: payload.body,
              createdAtMs: payload.createdAtMs,
            });
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
            const firstMessage = db
              .prepare(
                `SELECT message_id FROM chat_messages
                 WHERE workspace_id = ? AND thread_id = ?
                 ORDER BY created_at_ms, message_id LIMIT 1`,
              )
              .get(workspaceId, payload.threadId);
            if (
              stringValue(storedTitle?.title ?? "") === "" &&
              stringValue(firstMessage?.message_id) === payload.messageId
            ) {
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
        } else if (input.opKind === "chat.decision.set") {
          const payload = input.payload;
          if (
            typeof payload.threadId !== "string" ||
            payload.threadId.length === 0 ||
            typeof payload.messageId !== "string" ||
            payload.messageId.length === 0 ||
            (payload.state !== "open" && payload.state !== "resolved") ||
            typeof payload.atMs !== "number" ||
            !Number.isFinite(payload.atMs) ||
            (payload.resolvedByMessageId !== undefined &&
              (typeof payload.resolvedByMessageId !== "string" ||
                payload.resolvedByMessageId.length === 0)) ||
            (payload.state === "resolved") !== (payload.resolvedByMessageId !== undefined)
          ) {
            throw corruptStore();
          }
          upsertDecisionLww(
            db,
            workspaceId,
            {
              threadId: payload.threadId,
              messageId: payload.messageId,
              state: payload.state,
              ...(payload.resolvedByMessageId !== undefined
                ? { resolvedByMessageId: payload.resolvedByMessageId }
                : {}),
              atMs: payload.atMs,
            },
            { originId: input.originId, originSeq: input.originSeq },
          );
        } else if (input.opKind === "chat.attachment.add") {
          const payload = input.payload;
          if (
            typeof payload.attachmentId !== "string" ||
            payload.attachmentId.length === 0 ||
            typeof payload.threadId !== "string" ||
            payload.threadId.length === 0 ||
            typeof payload.messageId !== "string" ||
            payload.messageId.length === 0 ||
            payload.targetKind !== "file" ||
            (payload.objectId !== undefined &&
              (typeof payload.objectId !== "string" ||
                payload.objectId.length === 0 ||
                payload.objectId.length > 200 ||
                payload.attachmentId !== attachmentIdFor(payload.messageId, payload.objectId))) ||
            (payload.pathHint !== undefined && !isNormalizedPathHint(payload.pathHint)) ||
            typeof payload.createdAtMs !== "number" ||
            !Number.isFinite(payload.createdAtMs)
          ) {
            throw corruptStore();
          }
          insertAttachment(db, workspaceId, {
            attachmentId: payload.attachmentId,
            threadId: payload.threadId,
            messageId: payload.messageId,
            targetKind: "file",
            ...(payload.objectId !== undefined ? { objectId: payload.objectId } : {}),
            ...(payload.pathHint !== undefined ? { pathHint: payload.pathHint } : {}),
            createdAtMs: payload.createdAtMs,
          });
        } else if (input.opKind === "chat.reaction.set") {
          const payload = input.payload;
          // A COMMUTATIVE, head-check-free apply — like ydoc.update, not
          // message.append. There is NO thread/message existence gate: a
          // cross-origin reaction can arrive before the message it targets, and
          // the LWW register converges regardless of arrival order (the missing
          // message just means the pill has nothing to render on yet;
          // listReactions JOINs chat_messages so an orphaned reaction never
          // surfaces to the UI). The per-origin acked_seq dedup above is the
          // re-apply backstop; the LWW WHERE clause makes a stale replay a no-op
          // even if it slips through.
          //
          // AUTHORSHIP TRUST BOUNDARY (WS-MU-C0 — now VERIFIED at the relay).
          // `payload.authorId` is part of the CRDT cell key and is trusted
          // verbatim HERE because the engine has no origin→user map and cannot
          // verify it itself. That verification now lives at its correct home:
          // the relay's log-append path rejects any chat op whose claimed author
          // (`chat.reaction.set.authorId` / `chat.message.append.authorUserId`)
          // does not equal the authenticated pushing `actor.userId`, atomically
          // failing the whole batch with 403 `authorship_mismatch` (see
          // services/sync-relay/src/server.ts `assertChatAuthorship`). So a
          // replicated authored op is authoritative ONLY because the relay
          // verified it before admitting it to the log — a relay collaborator can
          // no longer forge a reaction as a VICTIM. A locally-applied op uses the
          // local identity (the LOCAL setReaction path derives authorId from the
          // signed-in user, never the renderer). The no-relay/solo path is a
          // single trusted user and is unaffected.
          if (
            typeof payload.reactionId !== "string" ||
            !payload.reactionId ||
            typeof payload.messageId !== "string" ||
            !payload.messageId ||
            typeof payload.threadId !== "string" ||
            !payload.threadId ||
            typeof payload.emoji !== "string" ||
            !payload.emoji ||
            typeof payload.authorId !== "string" ||
            !payload.authorId ||
            typeof payload.atMs !== "number" ||
            !Number.isFinite(payload.atMs)
          ) {
            throw corruptStore();
          }
          // Defense in depth for a REPLICATED write: the emoji is the CRDT cell
          // key and renders as a pill, but this op may come from a peer that
          // never passed the desktop IPC schema. Reject anything that isn't a
          // single emoji grapheme so a hostile/buggy peer can't land arbitrary
          // short strings (URLs, text) as reaction pills. Validated verbatim (no
          // NFC re-normalization): the origin already normalized, and mutating
          // here would desync the byte-identical total-order key across peers.
          if (!isReactionEmoji(payload.emoji)) {
            throw corruptStore();
          }
          upsertReactionLww(
            db,
            workspaceId,
            {
              reactionId: payload.reactionId,
              messageId: payload.messageId,
              threadId: payload.threadId,
              emoji: payload.emoji,
              authorId: payload.authorId,
              authorKind: actorKindValue(payload.authorKind),
              authorDisplayName: stringValue(payload.authorDisplayName),
              // Store the op's ORIGINAL at_ms verbatim (no receiver-local
              // clamp) so the total order is byte-identical on every peer. See
              // the clock-skew note above upsertReactionLww's origin type.
              atMs: payload.atMs,
              state: reactionStateValue(payload.state),
            },
            // The envelope's origin coordinates are the total-order tie-break;
            // they are validated at the top of applyReplicationOp.
            { originId: input.originId, originSeq: input.originSeq },
          );
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
