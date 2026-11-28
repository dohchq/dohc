import {
  serverOperationArgsSchemas,
  type CliResultByVerb,
  type ServerOperation,
} from "@dohc/cli/protocol";
import { agentIdForChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { isChatRunnerAgentId } from "@dohc/workspace-contracts/chat-wakes";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import type { ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { ChatsLiveAdapter, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import {
  failure,
  groupForCli,
  listFileChats,
  listGroups,
  listGroupsWithThreads,
  listGroupThreads,
  OperationError,
  readChat,
  readThreadDispatchState,
  resolveChannel,
  showChat,
  type ChatReadStore,
  type ChatsHost,
} from "@dohc/workspace-operations/chats";
import {
  listFiles,
  readDocument,
  readText,
  type DocumentsHost,
  type FileListResult,
  type FilesHost,
  type TextReadResult,
} from "@dohc/workspace-operations/documents";
import { documentMarkdownOf, settledDocumentMarkdown, yDocToMarkdown } from "@dohc/ydoc-projection";
import { readsBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
import { isLossyMarkdown } from "@dohc/ydoc-projection/lossy-markdown";
import * as Y from "yjs";
import { currentAccountFeedCursor } from "./accountFeed";
import { replicaChatStore } from "./automationChatWrites";
import type { AutomationReplica } from "./automationReplicas";
import { badRequest, notFound, RelayError } from "./errors";
import { untilAborted } from "./namedLiveFrameHost";
import { channelShown, memberChatAnswer, pathShown, type PhoneMember } from "./phoneMember";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import { commentFileOf } from "./storage/personalAgentChat";

// The reads an account makes through this server's copy of a workspace it
// owns or, on a phone, joined. The caller authenticates the account and
// decides what it can reach; this runs the read on the copy and keeps the
// engine's own failures, every secret file, and whatever a Member's reach
// hides out of the answer.

type MemberAccess = "read-write" | "read-only";
type ChatThreadResult = Extract<CliResultByVerb["chat"], { ok: true; thread: unknown }>;
export type AccountOperationResult =
  | CliResultByVerb[Exclude<ServerOperation, "listFiles" | "readText" | "groupsFull">]
  | (Extract<CliResultByVerb["documentRead"], { ok: true }> & { objectId: string })
  | (Extract<CliResultByVerb["fileChats"], { ok: true }> & { access?: MemberAccess })
  | (Omit<ChatThreadResult, "thread"> & {
      thread: ChatThreadResult["thread"] & { access?: MemberAccess };
    })
  | PhoneGroupsResult
  | FileListResult
  | TextReadResult
  | PageTooLargeResult
  | MissingResult;

/**
 * The phone's chat list: an agent's chat named as the account's computers name its agent, and marked archived when no
 * computer has it, as a desktop files one whose agent isn't in its Settings. Only the phone's route adds `archived`.
 */
type GroupsResult = CliResultByVerb["groupsFull"];
type PhoneGroupsResult =
  | GroupsResult
  | (Extract<GroupsResult, { ok: true }> & {
      groups: Array<Extract<GroupsResult, { ok: true }>["groups"][number] & { archived?: true }>;
    });

function phoneGroups(names: Map<string, string> | null, result: GroupsResult): PhoneGroupsResult {
  if (names === null || !result.ok) return result;
  return {
    ...result,
    groups: result.groups.map((group) => {
      const agentId =
        group.kind === "agent" && group.channelWireId
          ? agentIdForChannelWireId(group.channelWireId)
          : null;
      if (agentId === null || !isChatRunnerAgentId(agentId)) return group;
      const name = names.get(agentId);
      return name === undefined ? { ...group, archived: true as const } : { ...group, name };
    }),
  };
}

/** A page whose file is over the desktop's editor limit, refused before the server fetches its body. */
export type PageTooLargeResult = { ok: false; reason: string; refusal: "too-large" };

/**
 * A page, chat or thread the copy doesn't hold. A secret file's page, and a thread on one, answer exactly this, word for
 * word, so the code says nothing a missing one wouldn't. Only this route adds it: the CLI's and the desktop's results
 * stay as the operations word them.
 */
export type MissingResult = { ok: false; reason: string; refusal: "missing" };

class PageTooLarge extends OperationError {
  constructor() {
    super("This page is too large to open here.");
  }
}

class PageMissing extends OperationError {
  constructor(path: string) {
    super(`No document at ${path}.`);
  }
}

export interface AccountOperationInput {
  /** The account that owns the workspace, whose copy this reads. */
  owner: string;
  /** A Member's or an Admin's reach, which narrows every answer, or null for the owner. */
  member: PhoneMember | null;
  workspaceId: string;
  /** The operation's name and arguments as the caller received them. */
  operation: string;
  args: unknown;
  /** Whose visit to the copy this is. Its signal ends the visit's waits. */
  visitor: Extract<CopyVisitor, { reason: "account" }>;
  /** Checks the caller's credential and reach again. It runs once the copy is open and again once it has synced. */
  authorize(): Promise<void>;
}

type ParsedOperation = {
  [Operation in ServerOperation]: {
    operation: Operation;
    args: ReturnType<(typeof serverOperationArgsSchemas)[Operation]["parse"]>;
  };
}[ServerOperation];

export const ACCOUNT_READ_DEADLINE_MS = 12_000;

const CHAT_OPERATIONS: ReadonlySet<ServerOperation> = new Set([
  "groups",
  "threads",
  "groupsFull",
  "fileChats",
  "chat",
  "show",
]);

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
 * - Pass `member` for anyone but the owner, and only from the phone's Bearer route.
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
  const signal = input.visitor.signal;
  const authorize = () => untilAborted(input.authorize(), signal);
  const spent: string[] = [];
  const lap = (step: string, since: number) =>
    spent.push(`${step}=${Math.round(performance.now() - since)}ms`);
  const timed = async <T>(step: string, work: Promise<T>) => {
    const since = performance.now();
    try {
      return await work;
    } finally {
      lap(step, since);
    }
  };
  const started = performance.now();
  try {
    return await server.copies.withServerCopy(
      input.owner,
      input.workspaceId,
      input.visitor,
      async (replica) => {
        lap("open", started);
        await authorize();
        // The sync brings the copy at least this far.
        const cursor = currentAccountFeedCursor(server.storage, input.workspaceId, input.member);
        const stale =
          request.operation !== "documentRead" || !copyIsCurrent(server.storage, replica);
        await timed("sync", stale ? replica.sync(signal) : Promise.resolve());
        await authorize();
        const read = await timed(
          "read",
          untilAborted(
            answer(server.storage, replica, input.workspaceId, request, input.member),
            signal,
          ),
        );
        const memberResult =
          input.member !== null && CHAT_OPERATIONS.has(request.operation)
            ? memberChatAnswer(
                input.member,
                read,
                request.operation === "groupsFull"
                  ? server.storage.listChannelCreates(input.workspaceId)
                  : undefined,
              )
            : null;
        const result =
          memberResult !== null && input.member !== null
            ? attachMemberFileAccess(
                server.storage,
                input.workspaceId,
                input.member,
                request.operation,
                memberResult,
              )
            : request.operation === "groupsFull" && input.visitor.phone && input.member === null
              ? phoneGroups(
                  server.storage.declaredAgentNames({
                    accountId: input.owner,
                    workspaceId: input.workspaceId,
                  }),
                  read as GroupsResult,
                )
              : read;
        await authorize();
        if (!("ok" in result) || result.ok)
          server.copies.hold(input.visitor.userId, input.workspaceId);
        return { result, cursor };
      },
    );
  } finally {
    console.info(`[account-reads] ${request.operation} ${spent.join(" ")}`);
  }
}

function attachMemberFileAccess(
  storage: SyncRelayStorage,
  workspaceId: string,
  member: PhoneMember,
  operation: ServerOperation,
  result: AccountOperationResult,
): AccountOperationResult {
  if (!("ok" in result) || !result.ok) return result;
  const accessAt = (path: string): MemberAccess =>
    member.selector.reach.levelAt(path) === "view" ? "read-only" : "read-write";
  if (operation === "fileChats" && "fileObjectId" in result && result.fileObjectId !== null)
    return { ...result, access: accessAt(result.path) };
  if (operation === "chat" && "thread" in result) {
    const file = commentFileOf(storage, workspaceId, result.thread.id);
    if (file !== null && member.selector.reach.levelAt(file.filePath) !== null) {
      const active = typeof storage.objectCurrentPath(workspaceId, file.objectId) === "string";
      return {
        ...result,
        thread: { ...result.thread, access: active ? accessAt(file.filePath) : "read-only" },
      };
    }
  }
  return result;
}

export async function withAccountReadDeadline<T>(
  requestSignal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ACCOUNT_READ_DEADLINE_MS);
  try {
    // Cancelling an upload still arriving would close the connection before the answer.
    return await untilAborted(
      read(AbortSignal.any([requestSignal, deadline.signal])),
      deadline.signal,
    );
  } catch (error) {
    if (deadline.signal.aborted && !requestSignal.aborted)
      throw new RelayError(
        "server_busy",
        "Your server took too long to read this workspace. Try again.",
        503,
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function copyIsCurrent(storage: SyncRelayStorage, replica: AutomationReplica): boolean {
  return (
    !replica.signal.aborted &&
    !replica.busy() &&
    storage.currentAutomationWorkspace(replica.workspaceId)?.incarnation === replica.incarnation &&
    replica.pulledHead >= storage.automationWorkspaceLogHead(replica.workspaceId)
  );
}

function parseOperation(operation: string, args: unknown): ParsedOperation {
  if (!isAccountOperation(operation)) throw notFound();
  const parsed = serverOperationArgsSchemas[operation].safeParse(args);
  if (!parsed.success) throw badRequest(`the arguments do not fit ${operation}`);
  return { operation, args: parsed.data } as ParsedOperation;
}

async function answer(
  storage: SyncRelayStorage,
  replica: AutomationReplica,
  workspaceId: string,
  request: ParsedOperation,
  member: PhoneMember | null,
): Promise<AccountOperationResult> {
  const chats = serverChats(storage, replica, workspaceId, member);
  const files = () => serverFiles(replica, workspaceId, member);
  try {
    switch (request.operation) {
      case "listFiles":
        return await listFiles(files(), request.args, PLATFORM);
      case "readText":
        return await readText(files(), request.args.path, PLATFORM);
      case "groups":
        return await listGroups(chats);
      case "threads":
        return await listGroupThreads(chats, { group: request.args.group, reader: null });
      case "groupsFull":
        return await listGroupsWithThreads(chats);
      case "fileChats":
        return await listFileChats(chats, request.args.path, PLATFORM);
      case "chat": {
        const read = await readChat(chats, request.args);
        return read.ok || !(await chatMissing(chats, request.args))
          ? read
          : { ...read, refusal: "missing" };
      }
      case "show": {
        const shown = await showChat(chats, request.args);
        return "stream" in shown ? shown : shown.thread;
      }
      case "documentRead": {
        let objectId: string | undefined;
        const result = await readDocument(
          serverDocuments(storage, replica, workspaceId, member, (id) => {
            objectId = id;
          }),
          request.args.path,
          PLATFORM,
        );
        return result.ok && objectId !== undefined ? { ...result, objectId } : result;
      }
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    // A document read rejects, so its failure is worded here, by the rule the chat host's results follow.
    if (error instanceof PageTooLarge)
      return { ok: false, reason: error.message, refusal: "too-large" };
    if (error instanceof PageMissing)
      return { ok: false, reason: error.message, refusal: "missing" };
    if (request.operation === "documentRead")
      return failure(error, `failed to read document: ${request.args.path}`, "operation-only");
    if (error instanceof OperationError) throw badRequest(error.message);
    throw error;
  }
}

/**
 * Whether a chat read that failed found no such chat: a thread the store doesn't list, which takes in a thread on a
 * secret file, or a group no name or ID resolves to. An engine that fails on the way says nothing about the chat.
 */
async function chatMissing(host: ChatsHost, args: ParsedChatArgs): Promise<boolean> {
  try {
    if ("threadId" in args)
      return !(await host.store.listThreads({ workspaceId: host.workspaceId })).some(
        (thread) => thread.id === args.threadId,
      );
    const channels = (await host.store.listChannels({ workspaceId: host.workspaceId })).map(
      (engine) => ({ engine, cli: groupForCli(engine) }),
    );
    try {
      resolveChannel(args.group, channels);
      return false;
    } catch (error) {
      return error instanceof OperationError;
    }
  } catch {
    return false;
  }
}

type ParsedChatArgs = Extract<ParsedOperation, { operation: "chat" }>["args"];

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
 * and an attachment to one is left out. For a Member, so does a thread or an
 * attachment on a file their reach hides, and every chat but the Groups it
 * shows.
 */
export function serverChats(
  storage: SyncRelayStorage,
  replica: AutomationReplica,
  workspaceId: string,
  member: PhoneMember | null = null,
): ChatsHost {
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
      const { results } = await files.resolveFiles({
        workspaceId,
        targets: batch.map((objectId) => ({ objectId })),
        signal: replica.signal,
      });
      for (const [index, objectId] of batch.entries()) {
        const found = results[index];
        if (found?.status === "found") {
          known.set(
            objectId,
            pathShown(member, found.path)
              ? { kind: "placed", path: found.path }
              : { kind: "hidden" },
          );
          continue;
        }
        const last = storage.objectLastKnownPath(workspaceId, objectId);
        const hints =
          last === undefined
            ? (await chats.listThreadsForFile({ workspaceId, objectId })).map(
                (thread) => thread.linkedFile?.pathHint,
              )
            : [last];
        const shown =
          hints.every((hint) => pathShown(member, hint)) &&
          (member === null || member.selector.reach.objectVisible(objectId));
        known.set(objectId, shown ? { kind: "unavailable" } : { kind: "hidden" });
      }
    }
    return known;
  };
  return {
    workspaceId,
    store: withoutSecretFiles(chats, place, member),
    fileObjectId: async (path) => {
      if (!pathShown(member, path)) return null;
      const [found] = (
        await files.resolveFiles({ workspaceId, targets: [{ path }], signal: replica.signal })
      ).results;
      return found?.status === "found" ? found.objectId : null;
    },
    filePath: async (objectId) => {
      const placement = (await place([objectId])).get(objectId);
      return placement?.kind === "placed" ? placement.path : null;
    },
    dispatch: (threadId) =>
      readThreadDispatchState(
        new ChatsLiveAdapter(replica.client, replica.workspace, { workspaceId }),
        workspaceId,
        threadId,
      ),
    writable: false,
    provisioned: () => undefined,
    errorDetail: "operation-only",
  };
}

/**
 * The store without the threads and attachments that name a secret file, by their hint or by where `place` puts their
 * object, and for a Member without the chats their reach hides. A thread's own decisions, reactions, messages and
 * projection answer only for a thread it lists.
 */
function withoutSecretFiles(
  store: ChatReadStore,
  place: Place,
  member: PhoneMember | null,
): ChatReadStore {
  const hidden = (
    placed: ReadonlyMap<string, Placement>,
    objectId: string | undefined,
    hint: string | undefined,
  ) =>
    !pathShown(member, hint) || (objectId !== undefined && placed.get(objectId)?.kind === "hidden");
  let channels: Promise<Awaited<ReturnType<ChatReadStore["listChannels"]>>> | undefined;
  const shownRows = (workspaceId: string) =>
    (channels ??= store.listChannels({ workspaceId }).then(async (rows) => {
      const shown = [];
      for (const row of rows) {
        const wireId = await store.getChannelWireId({ workspaceId, channelId: row.id });
        if (channelShown(member, wireId, row.kind)) shown.push(row);
      }
      return shown;
    }));
  const shownChannels = async (workspaceId: string) =>
    new Set((await shownRows(workspaceId)).map((row) => row.id));
  const channelHidden = async (workspaceId: string, channelId: string | undefined) =>
    member !== null &&
    (channelId === undefined || !(await shownChannels(workspaceId)).has(channelId));
  // Threads this read already listed, placed as `place` placed them.
  const listed = new Set<string>();
  const threads = async <
    Thread extends Pick<ChatThread, "id" | "linkedFile" | "workspaceId" | "channelId">,
  >(
    rows: Thread[],
  ): Promise<Thread[]> => {
    const placed = await place(
      rows.flatMap((thread) => (thread.linkedFile ? [thread.linkedFile.objectId] : [])),
    );
    const kept: Thread[] = [];
    for (const thread of rows) {
      if (hidden(placed, thread.linkedFile?.objectId, thread.linkedFile?.pathHint)) continue;
      if (!thread.linkedFile && (await channelHidden(thread.workspaceId, thread.channelId)))
        continue;
      kept.push(thread);
    }
    for (const thread of kept) listed.add(thread.id);
    return kept;
  };
  const admit = async (workspaceId: string, threadId: string): Promise<void> => {
    if (
      listed.has(threadId) ||
      (await threads(await store.listThreads({ workspaceId }))).some(
        (thread) => thread.id === threadId,
      )
    )
      return;
    throw new OperationError(`chat thread not found: ${threadId}`);
  };
  const messages = async (rows: ChatMessage[]): Promise<ChatMessage[]> => {
    const placed = await place(
      rows.flatMap((row) =>
        row.attachments.flatMap((attachment) => (attachment.objectId ? [attachment.objectId] : [])),
      ),
    );
    return rows.map((row) => ({
      ...row,
      attachments: row.attachments.filter(
        (attachment) => !hidden(placed, attachment.objectId, attachment.pathHint),
      ),
    }));
  };
  return {
    ...store,
    listChannels: async (input) =>
      member === null ? await store.listChannels(input) : await shownRows(input.workspaceId),
    getThreadProjection: async (input) => {
      if (member !== null) await admit(input.workspaceId, input.threadId);
      return await store.getThreadProjection(input);
    },
    listThreads: async (input) => await threads(await store.listThreads(input)),
    listThreadsForFile: async (input) => await threads(await store.listThreadsForFile(input)),
    listChannelThreads: async (input) => {
      if (await channelHidden(input.workspaceId, input.channelId)) return [];
      const summaries = await store.listChannelThreads(input);
      const kept = new Set(await threads(summaries.map((summary) => summary.thread)));
      return summaries.filter((summary) => kept.has(summary.thread));
    },
    listAgentUnreadThreads: async (workspaceId, reader) =>
      await threads(await store.listAgentUnreadThreads(workspaceId, reader)),
    listMessages: async (input) => {
      if (member !== null) await admit(input.workspaceId, input.threadId);
      return await messages(await store.listMessages(input));
    },
    listThreadDecisions: async (workspaceId, threadId) => {
      await admit(workspaceId, threadId);
      return await store.listThreadDecisions(workspaceId, threadId);
    },
    listReactions: async (input) => {
      await admit(input.workspaceId, input.threadId);
      return await store.listReactions(input);
    },
    listGroupStream: async (input) => {
      if (await channelHidden(input.workspaceId, input.channelId))
        throw new OperationError(`chat channel not found: ${input.channelId}`);
      const page = await store.listGroupStream(input);
      const shown = await messages(page.items.map((item) => item.message));
      return {
        ...page,
        items: page.items.map((item, index) => ({ ...item, message: shown[index]! })),
      };
    },
  };
}

/** A hosted note's accepted state as Markdown. A format-2 note reads as the engine writes it. */
function acceptedMarkdown(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return readsBodySequence(doc) ? yDocToMarkdown(doc) : documentMarkdownOf(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Pages as the copy holds them. While the copy's active version is main, a
 * page the relay hosts live reads as its accepted state, the journal's
 * checkpoint and the updates after it, so an edit the relay accepted reads
 * before it settles into the file. Any other page reads as its settled file in the active version.
 * A lossy note reads as its file, as on the desktop. A page whose file is
 * over the desktop's editor limit is refused before its body is fetched.
 * Nothing here writes to the copy or sends anything.
 */
function serverDocuments(
  storage: SyncRelayStorage,
  replica: AutomationReplica,
  workspaceId: string,
  member: PhoneMember | null,
  onObjectId?: (objectId: string) => void,
): DocumentsHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  return {
    async read(path) {
      const missing = new PageMissing(path);
      if (!pathShown(member, path)) throw missing;
      if (liveDocumentKindForPath(path) !== "richdoc")
        throw new OperationError(`${path} is not a Markdown document.`);
      const version = await files.getActiveVersion({ workspaceId });
      const file =
        version === null
          ? null
          : await files.readTextFile({
              workspaceId,
              versionId: version.id,
              path,
              maxBytes: LIVE_MARKDOWN_MAX_BYTES,
            });
      if (
        file?.contentKind === "text" &&
        (file.text === null || file.byteLength > LIVE_MARKDOWN_MAX_BYTES)
      )
        throw new PageTooLarge();
      if (file?.contentKind !== "text" || typeof file.text !== "string") throw missing;
      onObjectId?.(file.objectId);
      if (isLossyMarkdown(file.text)) return { path, markdown: file.text };
      const live =
        version?.kind === "main"
          ? storage.readAcceptedLiveDocument(workspaceId, path)
          : { kind: "none" as const };
      if (live.kind === "cut" && live.cut.document.objectId === file.objectId) {
        return {
          path,
          markdown: acceptedMarkdown(
            Y.mergeUpdates([live.cut.checkpoint.bytes, ...live.cut.suffix.map((row) => row.bytes)]),
          ),
        };
      }
      return { path, markdown: settledDocumentMarkdown(file.text) };
    },
  };
}

/**
 * The files in the copy's active version. A hidden file, or for a Member one
 * their reach hides, is never listed, and reads as missing without asking the
 * engine. A text file over the desktop's editor limit is refused before its
 * body is fetched.
 */
function serverFiles(
  replica: AutomationReplica,
  workspaceId: string,
  member: PhoneMember | null,
): FilesHost {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  return {
    async list() {
      const version = await files.getActiveVersion({ workspaceId });
      if (version === null) return [];
      return (await files.listTextFileMetadata({ workspaceId, versionId: version.id }))
        .filter((file) => pathShown(member, file.path))
        .map(({ path, objectId, contentKind, byteLength }) => ({
          path,
          objectId,
          contentKind,
          byteLength,
        }));
    },
    async readText(path) {
      if (!pathShown(member, path)) return { kind: "missing" };
      const version = await files.getActiveVersion({ workspaceId });
      const file =
        version === null
          ? null
          : await files.readTextFile({
              workspaceId,
              versionId: version.id,
              path,
              maxBytes: LIVE_MARKDOWN_MAX_BYTES,
            });
      if (file === null) return { kind: "missing" };
      if (file.contentKind !== "text") return { kind: "binary" };
      if (file.text === null || file.byteLength > LIVE_MARKDOWN_MAX_BYTES)
        return { kind: "too-large", maxBytes: LIVE_MARKDOWN_MAX_BYTES };
      return { kind: "text", text: file.text };
    },
    errorDetail: "operation-only",
  };
}
