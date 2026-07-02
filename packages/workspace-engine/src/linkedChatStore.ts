import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";
import type { WorkspaceId, WorkspaceObjectId } from "./versionedTextStore";

export const LINKED_CHAT_STORE_RELATIVE_PATH = ".dohc/engine/linked-chat-store.json";
export const LINKED_CHAT_PROJECTION_KIND = "thread";

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

interface PersistedWorkspaceChatState {
  threads: Record<ChatThreadId, ChatThread>;
  threadOrder: ChatThreadId[];
  messages: Record<ChatMessageId, ChatMessage>;
  threadMessages: Record<ChatThreadId, ChatMessageId[]>;
}

interface PersistedLinkedChatState {
  schemaVersion: 1;
  workspaces: Record<WorkspaceId, PersistedWorkspaceChatState>;
}

function initialState(): PersistedLinkedChatState {
  return { schemaVersion: 1, workspaces: {} };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storePath(rootDir: string): string {
  return join(rootDir, LINKED_CHAT_STORE_RELATIVE_PATH);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeState(raw: unknown): PersistedLinkedChatState {
  if (raw === null) return initialState();
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (raw as { workspaces?: unknown }).workspaces !== "object" ||
    (raw as { workspaces?: unknown }).workspaces === null
  ) {
    throw new LinkedChatStoreError("state-corrupt", "Linked chat store is corrupt.");
  }
  const state = raw as PersistedLinkedChatState;
  for (const workspace of Object.values(state.workspaces)) {
    if (
      typeof workspace !== "object" ||
      workspace === null ||
      !Array.isArray(workspace.threadOrder) ||
      typeof workspace.threads !== "object" ||
      workspace.threads === null ||
      typeof workspace.messages !== "object" ||
      workspace.messages === null ||
      typeof workspace.threadMessages !== "object" ||
      workspace.threadMessages === null
    ) {
      throw new LinkedChatStoreError("state-corrupt", "Linked chat store is corrupt.");
    }
  }
  return state;
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
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

function ensureWorkspace(
  state: PersistedLinkedChatState,
  workspaceId: WorkspaceId,
): PersistedWorkspaceChatState {
  const existing = state.workspaces[workspaceId];
  if (existing) return existing;
  const workspace: PersistedWorkspaceChatState = {
    threads: {},
    threadOrder: [],
    messages: {},
    threadMessages: {},
  };
  state.workspaces[workspaceId] = workspace;
  return workspace;
}

function threadExistsInAnotherWorkspace(
  state: PersistedLinkedChatState,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): boolean {
  return Object.entries(state.workspaces).some(
    ([candidateWorkspaceId, workspace]) =>
      candidateWorkspaceId !== workspaceId && workspace.threads[threadId] !== undefined,
  );
}

function requireWorkspaceThread(
  state: PersistedLinkedChatState,
  workspaceId: WorkspaceId,
  threadId: ChatThreadId,
): { workspace: PersistedWorkspaceChatState; thread: ChatThread } {
  const workspace = state.workspaces[workspaceId];
  const thread = workspace?.threads[threadId];
  if (!workspace || !thread) {
    if (threadExistsInAnotherWorkspace(state, workspaceId, threadId)) {
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
  return { workspace, thread };
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
  let cachedState: PersistedLinkedChatState | null = null;

  async function loadState(): Promise<PersistedLinkedChatState> {
    if (cachedState) return cachedState;
    cachedState = normalizeState(await readJson<unknown>(storePath(rootDir)));
    return cachedState;
  }

  async function saveState(state: PersistedLinkedChatState): Promise<void> {
    cachedState = state;
    await writeFileAtomic(storePath(rootDir), `${JSON.stringify(state, null, 2)}\n`);
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task);
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

  return {
    createThread(input) {
      return serialize(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const title = normalizeThreadTitle(input.title);
        const state = await loadState();
        const workspace = ensureWorkspace(state, workspaceId);
        const id = createId("thread");
        const recordedAtMs = nowMs();
        const thread: ChatThread = {
          id,
          workspaceId,
          title,
          createdAtMs: recordedAtMs,
          updatedAtMs: recordedAtMs,
          ...(input.linkedFile
            ? {
                linkedFile: {
                  objectId: normalizeObjectId(input.linkedFile.objectId),
                  ...(input.linkedFile.pathHint
                    ? { pathHint: normalizePathHint(input.linkedFile.pathHint) }
                    : {}),
                  linkedAtMs: recordedAtMs,
                },
              }
            : {}),
        };
        workspace.threads[id] = thread;
        workspace.threadOrder.push(id);
        workspace.threadMessages[id] = [];
        await saveState(state);
        return cloneJson(thread);
      });
    },

    listThreads(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const workspace = state.workspaces[workspaceId];
        if (!workspace) return [];
        return workspace.threadOrder
          .map((threadId) => workspace.threads[threadId])
          .filter((thread): thread is ChatThread => thread !== undefined)
          .map(cloneJson);
      });
    },

    listThreadsForFile(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const objectId = normalizeObjectId(input.objectId);
        const state = await loadState();
        const workspace = state.workspaces[workspaceId];
        if (!workspace) return [];
        return workspace.threadOrder
          .map((threadId) => workspace.threads[threadId])
          .filter(
            (thread): thread is ChatThread =>
              thread !== undefined && thread.linkedFile?.objectId === objectId,
          )
          .map(cloneJson);
      });
    },

    sendMessage(input) {
      return serialize(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const { workspace, thread } = requireWorkspaceThread(
          state,
          workspaceId,
          input.threadId,
        );
        const message: ChatMessage = {
          id: createId("message"),
          workspaceId,
          threadId: thread.id,
          author: normalizeActor(input.author),
          body: normalizeBody(input.body),
          createdAtMs: nowMs(),
        };
        workspace.messages[message.id] = message;
        workspace.threadMessages[thread.id] ??= [];
        workspace.threadMessages[thread.id].push(message.id);
        thread.updatedAtMs = message.createdAtMs;
        await saveState(state);
        return cloneJson(message);
      });
    },

    listMessages(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const { workspace, thread } = requireWorkspaceThread(
          state,
          workspaceId,
          input.threadId,
        );
        return (workspace.threadMessages[thread.id] ?? [])
          .map((messageId) => workspace.messages[messageId])
          .filter((message): message is ChatMessage => message !== undefined)
          .map(cloneJson);
      });
    },

    getThreadProjection(input) {
      return afterWrites(async () => {
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const { workspace, thread } = requireWorkspaceThread(
          state,
          workspaceId,
          input.threadId,
        );
        const access = input.linkedFileAccess ?? { kind: "unknown" as const };
        const linkedFileAccess =
          access.kind === "allowed"
            ? { kind: "allowed" as const, path: normalizePathHint(access.path) }
            : access;
        const messages = (workspace.threadMessages[thread.id] ?? [])
          .map((messageId) => workspace.messages[messageId])
          .filter((message): message is ChatMessage => message !== undefined);
        return {
          path: linkedChatProjectionPath({ workspaceId, threadId: thread.id }),
          readOnly: true,
          threadId: thread.id,
          text: formatProjection({ thread, messages, linkedFileAccess }),
        };
      });
    },
  };
}
