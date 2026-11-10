import { serverOperationArgsSchemas, type CliResultByVerb, type ServerOperation } from "@dohc/cli/protocol";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import type { ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { ChatsLiveAdapter, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  failure, listFileChats, listGroups, listGroupsWithThreads, listGroupThreads, OperationError, readChat, readThreadDispatchState,
  showChat, type ChatReadStore, type ChatsHost,
} from "@dohc/workspace-operations/chats";
import {
  listFiles, readDocument, readText, type DocumentsHost, type FileListResult, type FilesHost, type TextReadResult,
} from "@dohc/workspace-operations/documents";
import { documentMarkdown, settledDocumentMarkdown } from "@dohc/ydoc-projection";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import * as Y from "yjs";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import { replicaChatStore } from "./automationChatWrites";
import type { AutomationReplica } from "./automationReplicas";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";

// The reads an account makes through this server's copy of a workspace it
// owns. The caller authenticates the account and decides what it can reach;
// this runs the read on the copy and keeps the engine's own failures, and
// every secret file, out of the answer.

export type AccountOperationResult =
  | CliResultByVerb[Exclude<ServerOperation, "listFiles" | "readText">]
  | FileListResult
  | TextReadResult
  | PageTooLargeResult;

/** A page whose file is over the desktop's editor limit, refused before the server fetches its body. */
export type PageTooLargeResult = { ok: false; reason: string; refusal: "too-large" };

class PageTooLarge extends OperationError {
  constructor() { super("This page is too large to open here."); }
}

export interface AccountOperationInput {
  /** The account that owns the workspace, from the caller's credential. */
  owner: string;
  workspaceId: string;
  /** The operation's name and arguments as the caller received them. */
  operation: string;
  args: unknown;
  /** Whose visit to the copy this is. Its signal ends the visit's waits. */
  visitor: Extract<CopyVisitor, { reason: "account" }>;
  /** Checks the caller's credential and reach again. It runs once the copy is open and again once it has synced. */
  authorize(): Promise<void>;
}

type ParsedOperation = { [Operation in ServerOperation]: {
  operation: Operation;
  args: ReturnType<(typeof serverOperationArgsSchemas)[Operation]["parse"]>;
} }[ServerOperation];

// The server's own path rules: the copies live on its disk.
const PLATFORM = process.platform;

/** Whether `name` is an operation this server answers. `changes` is not one: it names the change feed. */
export function isAccountOperation(name: string): name is ServerOperation {
  return Object.hasOwn(serverOperationArgsSchemas, name);
}

/**
 * Runs one read on the server's copy of `workspaceId` and answers its
 * result, with the change feed's cursor for what the copy had synced. An
 * unknown operation, a workspace the owner cannot open, and a copy whose
 * owner changed reject with not-found; a full server rejects with
 * server_busy; arguments outside the operation's schema, and the
 * operation's own refusals, reject with bad_request.
 *
 * The caller's duties:
 * - Authenticate the caller and check that `owner` owns the workspace before reading the arguments.
 * - Pass `phone: true` only from the phone's Bearer route.
 * - With `phone: false`, enforce the caller's own reach and level in `authorize`.
 * - Make `authorize` throw notFound() for any loss of access.
 *
 * `authorize` runs once the copy opens, once it has synced, and once the
 * result is ready, before this returns it.
 */
export async function runAccountOperation(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: AccountOperationInput,
): Promise<{ result: AccountOperationResult; cursor: string }> {
  const request = parseOperation(input.operation, input.args);
  return await server.copies.withServerCopy(input.owner, input.workspaceId, input.visitor, async (replica) => {
    await input.authorize();
    // The sync brings the copy at least this far.
    const cursor = currentAccountFeedCursor(server.storage, input.workspaceId);
    await replica.sync(input.visitor.signal);
    await input.authorize();
    const result = await answer(server.storage, replica, input.workspaceId, request);
    await input.authorize();
    return { result, cursor };
  });
}

function parseOperation(operation: string, args: unknown): ParsedOperation {
  if (!isAccountOperation(operation)) throw notFound();
  const parsed = serverOperationArgsSchemas[operation].safeParse(args);
  if (!parsed.success) throw badRequest(`the arguments do not fit ${operation}`);
  return { operation, args: parsed.data } as ParsedOperation;
}

async function answer(storage: SyncRelayStorage, replica: AutomationReplica, workspaceId: string, request: ParsedOperation): Promise<AccountOperationResult> {
  const chats = serverChats(storage, replica, workspaceId);
  try {
    switch (request.operation) {
      case "listFiles": return await listFiles(serverFiles(replica, workspaceId), request.args, PLATFORM);
      case "readText": return await readText(serverFiles(replica, workspaceId), request.args.path, PLATFORM);
      case "groups": return await listGroups(chats);
      case "threads": return await listGroupThreads(chats, { group: request.args.group, reader: null });
      case "groupsFull": return await listGroupsWithThreads(chats);
      case "fileChats": return await listFileChats(chats, request.args.path, PLATFORM);
      case "chat": return await readChat(chats, request.args);
      case "show": {
        const shown = await showChat(chats, request.args);
        return "stream" in shown ? shown : shown.thread;
      }
      case "documentRead": return await readDocument(serverDocuments(storage, replica, workspaceId), request.args.path, PLATFORM);
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    // A document read rejects, so its failure is worded here, by the rule the chat host's results follow.
    if (error instanceof PageTooLarge) return { ok: false, reason: error.message, refusal: "too-large" };
    if (request.operation === "documentRead") return failure(error, `failed to read document: ${request.args.path}`, "operation-only");
    if (error instanceof OperationError) throw badRequest(error.message);
    throw error;
  }
}

// files.resolve answers at most this many targets at once.
const RESOLVE_BATCH = 128;

/**
 * Where an object's file is, for the chats that name it: at a path in the
 * copy's active version, unavailable (deleted, or never in the copy), or
 * hidden because it is, or last was, a secret file.
 */
type Placement = { kind: "placed"; path: string } | { kind: "unavailable" } | { kind: "hidden" };
type Place = (objectIds: readonly string[]) => Promise<ReadonlyMap<string, Placement>>;

/**
 * The chat operations' host over the copy. It never writes, so a read never
 * creates General. A thread on a deleted file stays readable, with its file
 * unavailable, as on the desktop. A thread on a secret file reads as missing,
 * and an attachment to one is left out.
 */
function serverChats(storage: SyncRelayStorage, replica: AutomationReplica, workspaceId: string): ChatsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const chats = replicaChatStore(replica);
  const known = new Map<string, Placement>();
  // Each object is placed once in this read. An object the copy doesn't hold
  // is judged by where the relay's log last put it, and an object the relay
  // never saw by the hints its file's threads carry.
  const place: Place = async (objectIds) => {
    const wanted = [...new Set(objectIds)].filter((objectId) => !known.has(objectId));
    for (let start = 0; start < wanted.length; start += RESOLVE_BATCH) {
      const batch = wanted.slice(start, start + RESOLVE_BATCH);
      const { results } = await files.resolveFiles({ workspaceId, targets: batch.map((objectId) => ({ objectId })), signal: replica.signal });
      for (const [index, objectId] of batch.entries()) {
        const found = results[index];
        if (found?.status === "found") {
          known.set(objectId, hiddenFile(found.path) ? { kind: "hidden" } : { kind: "placed", path: found.path });
          continue;
        }
        const last = storage.objectLastKnownPath(workspaceId, objectId);
        const hints = last === undefined
          ? (await chats.listThreadsForFile({ workspaceId, objectId })).map((thread) => thread.linkedFile?.pathHint)
          : [last];
        known.set(objectId, hints.some(hiddenFile) ? { kind: "hidden" } : { kind: "unavailable" });
      }
    }
    return known;
  };
  return {
    workspaceId,
    store: withoutSecretFiles(chats, place),
    fileObjectId: async (path) => {
      if (hiddenFile(path)) return null;
      const [found] = (await files.resolveFiles({ workspaceId, targets: [{ path }], signal: replica.signal })).results;
      return found?.status === "found" ? found.objectId : null;
    },
    filePath: async (objectId) => {
      const placement = (await place([objectId])).get(objectId);
      return placement?.kind === "placed" ? placement.path : null;
    },
    dispatch: (threadId) => readThreadDispatchState(new ChatsLiveAdapter(replica.client, replica.workspace, { workspaceId }), workspaceId, threadId),
    writable: false,
    provisioned: () => undefined,
    errorDetail: "operation-only",
  };
}

/** The store without the threads and attachments that name a secret file, by their hint or by where `place` puts their object. */
function withoutSecretFiles(store: ChatReadStore, place: Place): ChatReadStore {
  const hidden = (placed: ReadonlyMap<string, Placement>, objectId: string | undefined, hint: string | undefined) =>
    hiddenFile(hint) || (objectId !== undefined && placed.get(objectId)?.kind === "hidden");
  const threads = async <Thread extends Pick<ChatThread, "linkedFile">>(rows: Thread[]): Promise<Thread[]> => {
    const placed = await place(rows.flatMap((thread) => thread.linkedFile ? [thread.linkedFile.objectId] : []));
    return rows.filter((thread) => !hidden(placed, thread.linkedFile?.objectId, thread.linkedFile?.pathHint));
  };
  const messages = async (rows: ChatMessage[]): Promise<ChatMessage[]> => {
    const placed = await place(rows.flatMap((row) => row.attachments.flatMap((attachment) => attachment.objectId ? [attachment.objectId] : [])));
    return rows.map((row) => ({ ...row, attachments: row.attachments.filter((attachment) => !hidden(placed, attachment.objectId, attachment.pathHint)) }));
  };
  return {
    ...store,
    listThreads: async (input) => await threads(await store.listThreads(input)),
    listThreadsForFile: async (input) => await threads(await store.listThreadsForFile(input)),
    listChannelThreads: async (input) => {
      const summaries = await store.listChannelThreads(input);
      const kept = new Set(await threads(summaries.map((summary) => summary.thread)));
      return summaries.filter((summary) => kept.has(summary.thread));
    },
    listAgentUnreadThreads: async (workspaceId, reader) => await threads(await store.listAgentUnreadThreads(workspaceId, reader)),
    listMessages: async (input) => await messages(await store.listMessages(input)),
    listGroupStream: async (input) => {
      const page = await store.listGroupStream(input);
      const shown = await messages(page.items.map((item) => item.message));
      return { ...page, items: page.items.map((item, index) => ({ ...item, message: shown[index]! })) };
    },
  };
}

/**
 * Pages as the copy holds them. While the copy's active version is main, a
 * page the relay hosts live reads as its accepted state, the journal's
 * checkpoint and the updates after it, so an edit the relay accepted reads
 * before it settles into the file. While a restore keeps the relay from
 * cutting that state, the read answers restore-in-progress rather than an
 * older file. Any other page reads as its settled file in the active version.
 * A lossy note reads as its file, as on the desktop. A page whose file is
 * over the desktop's editor limit is refused before its body is fetched.
 * Nothing here writes to the copy or sends anything.
 */
function serverDocuments(storage: SyncRelayStorage, replica: AutomationReplica, workspaceId: string): DocumentsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  return {
    async read(path) {
      const missing = new OperationError(`No document at ${path}.`);
      if (hiddenFile(path)) throw missing;
      if (liveDocumentKindForPath(path) !== "richdoc") throw new OperationError(`${path} is not a Markdown document.`);
      const version = await files.getActiveVersion({ workspaceId });
      const file = version === null ? null
        : await files.readTextFile({ workspaceId, versionId: version.id, path, maxBytes: LIVE_MARKDOWN_MAX_BYTES });
      if (file?.contentKind === "text" && (file.text === null || file.byteLength > LIVE_MARKDOWN_MAX_BYTES)) throw new PageTooLarge();
      if (file?.contentKind !== "text" || typeof file.text !== "string") throw missing;
      if (isLossyMarkdown(file.text)) return { path, markdown: file.text };
      const live = version?.kind === "main" ? storage.readAcceptedLiveDocument(workspaceId, path) : { kind: "none" as const };
      if (live.kind === "restoring") throw relayError("restore-in-progress", "This page is being restored. Try again once it finishes.");
      if (live.kind === "cut" && live.cut.document.objectId === file.objectId) {
        return { path, markdown: documentMarkdown(Y.mergeUpdates([live.cut.checkpoint.bytes, ...live.cut.suffix.map((row) => row.bytes)])) };
      }
      return { path, markdown: settledDocumentMarkdown(file.text) };
    },
  };
}

/**
 * The files in the copy's active version. A hidden file is never listed, and
 * reads as missing without asking the engine. A text file over the desktop's
 * editor limit is refused before its body is fetched.
 */
function serverFiles(replica: AutomationReplica, workspaceId: string): FilesHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  return {
    async list() {
      const version = await files.getActiveVersion({ workspaceId });
      if (version === null) return [];
      return (await files.listTextFileMetadata({ workspaceId, versionId: version.id }))
        .filter((file) => !hiddenFile(file.path))
        .map(({ path, objectId, contentKind, byteLength }) => ({ path, objectId, contentKind, byteLength }));
    },
    async readText(path) {
      if (hiddenFile(path)) return { kind: "missing" };
      const version = await files.getActiveVersion({ workspaceId });
      const file = version === null ? null
        : await files.readTextFile({ workspaceId, versionId: version.id, path, maxBytes: LIVE_MARKDOWN_MAX_BYTES });
      if (file === null) return { kind: "missing" };
      if (file.contentKind !== "text") return { kind: "binary" };
      if (file.text === null || file.byteLength > LIVE_MARKDOWN_MAX_BYTES) return { kind: "too-large", maxBytes: LIVE_MARKDOWN_MAX_BYTES };
      return { kind: "text", text: file.text };
    },
    errorDetail: "operation-only",
  };
}
