import { serverOperationArgsSchemas, type CliResultByVerb, type ServerOperation } from "@dohc/cli/protocol";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
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
import { badRequest, notFound, RelayError } from "./errors";
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

/**
 * Runs one read on the server's copy of `workspaceId` and answers its
 * result. An unknown operation, a workspace the owner cannot open, and a
 * copy whose owner changed reject with not-found; a full server rejects
 * with server_busy; arguments outside the operation's schema, and the
 * operation's own refusals, reject with bad_request.
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
    return await answer(server.storage, replica, input.workspaceId, request);
  });
}

function parseOperation(operation: string, args: unknown): ParsedOperation {
  if (!Object.hasOwn(serverOperationArgsSchemas, operation)) throw notFound();
  const name = operation as ServerOperation;
  const parsed = serverOperationArgsSchemas[name].safeParse(args);
  if (!parsed.success) throw badRequest(`the arguments do not fit ${name}`);
  return { operation: name, args: parsed.data } as ParsedOperation;
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

/** The chat operations' host over the copy. It never writes, so a read never creates General. */
function serverChats(replica: AutomationReplica, workspaceId: string): ChatsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const resolved = async (target: { path: string } | { objectId: string }) =>
    (await files.resolveFiles({ workspaceId, targets: [target], signal: replica.signal })).results[0];
  return {
    workspaceId,
    store: withoutSecretFiles(replicaChatStore(replica)),
    fileObjectId: async (path) => {
      if (secret(path)) return null;
      const found = await resolved({ path });
      return found?.status === "found" ? found.objectId : null;
    },
    filePath: async (objectId) => {
      const found = await resolved({ objectId });
      return found?.status === "found" && !secret(found.path) ? found.path : null;
    },
    dispatch: (threadId) => readThreadDispatchState(new ChatsLiveAdapter(replica.client, replica.workspace, { workspaceId }), workspaceId, threadId),
    writable: false,
    provisioned: () => undefined,
    errorDetail: "operation-only",
  };
}

/**
 * The store as if no attachment, and no file's thread, that names a secret
 * file existed. Other thread listings name a file only by its object, which
 * filePath resolves.
 */
function withoutSecretFiles(store: ChatReadStore): ChatReadStore {
  const message = (row: ChatMessage): ChatMessage =>
    ({ ...row, attachments: row.attachments.filter((attachment) => !secret(attachment.pathHint)) });
  return {
    ...store,
    listThreadsForFile: async (input) => (await store.listThreadsForFile(input)).filter((thread) => !secret(thread.linkedFile?.pathHint)),
    listMessages: async (input) => (await store.listMessages(input)).map(message),
    listGroupStream: async (input) => {
      const page = await store.listGroupStream(input);
      return { ...page, items: page.items.map((item) => ({ ...item, message: message(item.message) })) };
    },
  };
}

/**
 * Pages as the copy holds them. A page the relay hosts live reads as its
 * accepted state, the journal's checkpoint and the updates after it, so an
 * edit the relay accepted reads before it settles into the file. Any other
 * page reads as its settled file. A lossy note reads as its file, as on the
 * desktop. Nothing here writes to the copy or sends anything.
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
      const text = file?.contentKind === "text" && typeof file.text === "string" ? file.text : null;
      if (text !== null && isLossyMarkdown(text)) return { path, markdown: text };
      const accepted = acceptedState(storage, workspaceId, path);
      if (accepted !== null) return { path, markdown: documentMarkdown(accepted) };
      if (text === null) throw missing;
      return { path, markdown: settledDocumentMarkdown(text) };
    },
  };
}

function acceptedState(storage: SyncRelayStorage, workspaceId: string, path: string): Uint8Array | null {
  const document = storage.currentLiveDocument(workspaceId, path);
  if (document === null) return null;
  const read = storage.readLiveUpdateJournalCut({ document });
  if (read.kind !== "cut" || read.cut.currentPath !== path) return null;
  return Y.mergeUpdates([read.cut.checkpoint.bytes, ...read.cut.suffix.map((row) => row.bytes)]);
}
