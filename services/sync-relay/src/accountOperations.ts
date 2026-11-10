import { serverOperationArgsSchemas, type CliResultByVerb, type ServerOperation } from "@dohc/cli/protocol";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { ChatsLiveAdapter, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  failure, listFileChats, listGroups, listGroupsWithThreads, listGroupThreads, OperationError, readChat, readThreadDispatchState,
  showChat, type ChatReadStore, type ChatsHost,
} from "@dohc/workspace-operations/chats";
import { readDocument, type DocumentsHost } from "@dohc/workspace-operations/documents";
import { documentMarkdown, settledDocumentMarkdown } from "@dohc/ydoc-projection";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import * as Y from "yjs";
import { replicaChatStore } from "./automationChatWrites";
import type { AutomationReplica } from "./automationReplicas";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";

// The reads an account makes through this server's copy of a workspace it
// owns. The caller authenticates the account and decides what it can reach;
// this runs the read on the copy and keeps the engine's own failures, and
// every secret file, out of the answer.

export type AccountOperationResult = CliResultByVerb[ServerOperation];

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
const secret = (path: string | undefined) => path !== undefined && classifyEngineFilePathForRead(path, PLATFORM).kind === "secret";

/** Whether `name` is an operation this server answers. `changes` is not one: it names 2b's change feed. */
export function isAccountOperation(name: string): name is ServerOperation {
  return Object.hasOwn(serverOperationArgsSchemas, name);
}

/**
 * Runs one read on the server's copy of `workspaceId` and answers its
 * result. An unknown operation, a workspace the owner cannot open, and a
 * copy whose owner changed reject with not-found; a full server rejects
 * with server_busy; arguments outside the operation's schema, and the
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
): Promise<AccountOperationResult> {
  const request = parseOperation(input.operation, input.args);
  return await server.copies.withServerCopy(input.owner, input.workspaceId, input.visitor, async (replica) => {
    await input.authorize();
    await replica.sync(input.visitor.signal);
    await input.authorize();
    const result = await answer(server.storage, replica, input.workspaceId, request);
    await input.authorize();
    return result;
  });
}

function parseOperation(operation: string, args: unknown): ParsedOperation {
  if (!isAccountOperation(operation)) throw notFound();
  const parsed = serverOperationArgsSchemas[operation].safeParse(args);
  if (!parsed.success) throw badRequest(`the arguments do not fit ${operation}`);
  return { operation, args: parsed.data } as ParsedOperation;
}

async function answer(storage: SyncRelayStorage, replica: AutomationReplica, workspaceId: string, request: ParsedOperation): Promise<AccountOperationResult> {
  const chats = serverChats(replica, workspaceId);
  try {
    switch (request.operation) {
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
    if (request.operation === "documentRead") return failure(error, `failed to read document: ${request.args.path}`, "operation-only");
    if (error instanceof OperationError) throw badRequest(error.message);
    throw error;
  }
}

// files.resolve answers at most this many targets at once.
const RESOLVE_BATCH = 128;

/**
 * The chat operations' host over the copy. It never writes, so a read never
 * creates General. A thread on a file the copy's active version doesn't hold,
 * or holds as a secret file, reads as missing, and so does an attachment to
 * one.
 */
function serverChats(replica: AutomationReplica, workspaceId: string): ChatsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const known = new Map<string, string | null>();
  // Where each object is now, asked once per object in this read; null when nowhere, or a secret file.
  const paths = async (objectIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
    const wanted = [...new Set(objectIds)].filter((objectId) => !known.has(objectId));
    for (let start = 0; start < wanted.length; start += RESOLVE_BATCH) {
      const batch = wanted.slice(start, start + RESOLVE_BATCH);
      const { results } = await files.resolveFiles({ workspaceId, targets: batch.map((objectId) => ({ objectId })), signal: replica.signal });
      batch.forEach((objectId, index) => {
        const found = results[index];
        known.set(objectId, found?.status === "found" && !secret(found.path) ? found.path : null);
      });
    }
    return known;
  };
  return {
    workspaceId,
    store: withoutSecretFiles(replicaChatStore(replica), paths),
    fileObjectId: async (path) => {
      if (secret(path)) return null;
      const [found] = (await files.resolveFiles({ workspaceId, targets: [{ path }], signal: replica.signal })).results;
      return found?.status === "found" ? found.objectId : null;
    },
    filePath: async (objectId) => (await paths([objectId])).get(objectId) ?? null,
    dispatch: (threadId) => readThreadDispatchState(new ChatsLiveAdapter(replica.client, replica.workspace, { workspaceId }), workspaceId, threadId),
    writable: false,
    provisioned: () => undefined,
    errorDetail: "operation-only",
  };
}

/** The store without the threads and attachments `paths` can't place outside a secret file. */
function withoutSecretFiles(store: ChatReadStore, paths: (objectIds: readonly string[]) => Promise<ReadonlyMap<string, string | null>>): ChatReadStore {
  const threads = async <Thread extends Pick<ChatThread, "linkedFile">>(rows: Thread[]): Promise<Thread[]> => {
    const placed = await paths(rows.flatMap((thread) => thread.linkedFile ? [thread.linkedFile.objectId] : []));
    return rows.filter((thread) => !thread.linkedFile || (placed.get(thread.linkedFile.objectId) ?? null) !== null);
  };
  const messages = async (rows: ChatMessage[]): Promise<ChatMessage[]> => {
    const placed = await paths(rows.flatMap((row) => row.attachments.flatMap((attachment) => attachment.objectId ? [attachment.objectId] : [])));
    // An opaque attachment from a shared channel has no object, only its hint.
    return rows.map((row) => ({ ...row, attachments: row.attachments.filter((attachment) => !secret(attachment.pathHint) &&
      (attachment.objectId === undefined || (placed.get(attachment.objectId) ?? null) !== null)) }));
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
 * A lossy note reads as its file, as on the desktop. Nothing here writes to
 * the copy or sends anything.
 */
function serverDocuments(storage: SyncRelayStorage, replica: AutomationReplica, workspaceId: string): DocumentsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  return {
    async read(path) {
      const missing = new OperationError(`No document at ${path}.`);
      if (secret(path)) throw missing;
      if (liveDocumentKindForPath(path) !== "richdoc") throw new OperationError(`${path} is not a Markdown document.`);
      const version = await files.getActiveVersion({ workspaceId });
      const file = version === null ? null : await files.readTextFile({ workspaceId, versionId: version.id, path });
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
