import {
  CLI_PROTOCOL_VERSION,
  cliRequestSchema,
  cliTransportResponseSchema,
  parseCliResult,
  type CliActor,
  type CliAuthor,
  type CliGroup,
  type CliCollectionQueryCursor,
  type CliGrepContextMessage,
  type CliGrepMatch,
  type CliRequest,
  type CliResultByVerb,
  type CliShowMessage,
} from "@dohc/cli/protocol";
import { renderShowMarkdown } from "@dohc/cli/render";
import { formatMessageHandle } from "@dohc/cli/thread-markdown";
import {
  createLocalChangeAuthor,
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import type {
  CollectionGetRecordParams,
  CollectionGetRecordResult,
  CollectionQueryCursor,
  CollectionQueryParams,
  CollectionQueryResult,
  CollectionRecord,
} from "@dohc/workspace-contracts/collection";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type {
  ChannelThreadSummary,
  ChatChannelSummary,
  ChatMessage,
  ChatThread,
  LinkedChatStore,
  VersionedTextMoment,
  VersionedTextMomentSummary,
} from "@dohc/workspace-contracts/engine";
import {
  DaemonRefusalError,
  decodeCollectionValue,
  encodeCollectionValue,
  MAX_GRANULAR_CHAT_QUERY_CHARS,
  type ChatUnreadFileThread,
  type GranularChatMessageSearchResponse,
  type GranularChatMessageSearchResult,
} from "@dohc/workspace-engine-client";
import type { AwaitableAgentDispatchStore } from "../agents/awaitableAgentDispatchStore";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  chmod,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { isInside } from "../security/pathContainment";
import type { ChatWrites } from "../workspaces/chatWrites";
import {
  LiveDocumentEditAppliedError,
  type LiveDocumentEditOrigin,
  type LiveDocumentEditOutcome,
} from "../workspaces/engineYDocSessionIpc";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import type { DocumentEdit } from "@dohc/ydoc-projection";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";

export const CLI_SOCKET_FILE = "dohc-cli.sock";
const CLI_TOKEN_FILE = "dohc-cli-token";
export const CLI_ENDPOINT_FILE = "dohc-cli-endpoint";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_FTS_CANDIDATES = 50_000;
const LIST_MOMENTS_HARD_LIMIT = 500;
const MAX_SOCKET_CONNECTIONS = 64;
// A CLI request that has not answered by now loses its socket; work done for
// it, such as waiting for a created record, ends at the same bound.
export const CLI_REQUEST_DEADLINE_MS = 15_000;
const REGEX_SCAN_TIMEOUT_MS = 5_000;
const RUN_MESSAGE_LINK_ATTEMPTS = 3;
const RUN_MESSAGE_LINK_RETRY_MS = 25;
const RUN_MESSAGE_LINK_DEADLINE_MS = 1_000;
const RUN_MESSAGE_LINK_FOREGROUND_BUDGET_MS = 1_500;
const RUN_MESSAGE_LINK_RECOVERY_MAX_PENDING = 1_000;
const RUN_MESSAGE_LINK_RECOVERY_MAX_ATTEMPTS = 12;
const RUN_MESSAGE_LINK_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const RUN_MESSAGE_LINK_RECOVERY_FILE =
  "dohc-run-message-link-recovery.json";
const TOKEN_RE = /^[a-f0-9]{64}$/u;

const authEnvelopeSchema = z.object({ token: z.string() }).passthrough();
const versionEnvelopeSchema = z
  .object({ protocolVersion: z.number().int() })
  .passthrough();
const regexWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), matches: z.array(z.boolean()) }).strict(),
  z.object({ ok: z.literal(false) }).strict(),
]);

const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const expression = new RegExp(workerData.pattern, workerData.ignoreCase ? "iu" : "u");
  parentPort.postMessage({
    ok: true,
    matches: workerData.texts.map((text) => expression.test(text)),
  });
} catch {
  parentPort.postMessage({ ok: false });
}
`;

type CliGranularChatMessageSearchResult = Pick<
  GranularChatMessageSearchResult,
  "threadId" | "messageId" | "text"
>;
type CliGranularChatMessageSearchResponse = Pick<
  GranularChatMessageSearchResponse,
  "saturated"
> & {
  results: CliGranularChatMessageSearchResult[];
};
type CliUnreadFileThread = Pick<
  ChatUnreadFileThread,
  "threadId" | "messageCount" | "lastReadSequence"
>;

export interface CliRegistryWorkspace {
  workspaceId: string;
  rootPath: string;
  readOnly?: boolean;
}

// The desktop's one collection write seam. The shapes mirror
// `setCollectionRecordFields` / `createCollectionRecord` in
// `apps/desktop/src/workspaces/collectionRecordEdits.ts` exactly, so main's
// wiring is a closure over that module's workspace-scoped edit context. The
// author is derived here, main-side, from the workspace identity plus the
// behavior-bearing actor kind; the request never supplies one. Field values
// are plain JSON: they land in the record's frontmatter Y.Doc map. Both
// functions throw on refusal (invalid path, engine off, "id" field, a held
// doc session, a taken record name, adoption not done by the request
// deadline).
export interface CliCollectionWriteSeam {
  setFields(input: {
    recordPath: string;
    fields: Record<string, unknown>;
    author: ChangeAuthor;
  }): Promise<{ path: string }>;
  createRecord(input: {
    collectionPath: string;
    name: string;
    fields?: Record<string, unknown>;
    author: ChangeAuthor;
  }): Promise<{ path: string; recordId: string }>;
}

// Engine-backed collection access for the CLI verbs. Reads go to the engine
// adapter; the two writes go through the write seam.
export interface CliCollectionsPort {
  query(params: CollectionQueryParams): Promise<CollectionQueryResult>;
  getRecord(params: CollectionGetRecordParams): Promise<CollectionGetRecordResult>;
  writes: CliCollectionWriteSeam;
}

// Live Markdown documents for the document verbs. Main answers through the
// editor session that holds a document, so an edit reaches an open editor
// as the person's own typing would.
export interface CliDocumentsPort {
  read(path: string): Promise<{ path: string; markdown: string }>;
  edit(input: {
    path: string;
    edit: DocumentEdit;
    origin: LiveDocumentEditOrigin;
  }): Promise<LiveDocumentEditOutcome>;
  // Creates the file the way the explorer does, then writes `markdown`
  // into its live session. Refuses a path that already exists.
  create(input: {
    path: string;
    markdown: string;
    origin: LiveDocumentEditOrigin;
  }): Promise<{ path: string }>;
}

export interface CliWorkspaceContext extends CliRegistryWorkspace {
  dataset?(request: import("@dohc/cli/dataset").DatasetRequest): Promise<import("@dohc/cli/dataset").DatasetResult>;
  ownerAppResponses?(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest):Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>;
  appPublication?(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult>;
  store: LinkedChatStore;
  dispatchStore: AwaitableAgentDispatchStore;
  readOnly: boolean;
  fileObjectIdForPath(path: string): Promise<string | null>;
  filePathForObjectId(objectId: string): Promise<string | null>;
  listMoments(input: { limit: number; objectId?: string }): Promise<VersionedTextMomentSummary[]>;
  readMoment(momentId: string): Promise<VersionedTextMoment | null>;
  daemonReads: {
    queryChatMessagesGranular(input: {
      query: string;
      limit: number;
    }): Promise<CliGranularChatMessageSearchResponse>;
    listUnreadFileThreads(input: {
      pageLimit: number;
      afterThreadId?: string;
    }): Promise<CliUnreadFileThread[]>;
  };
  // Absent when the workspace has no engine-backed collection access.
  collections?: CliCollectionsPort;
  documents?: CliDocumentsPort;
}

export interface CliRunMessageLink {
  workspaceId: string;
  runId: string;
  messageId: string;
}

export interface CliServerOptions {
  stateDir: string;
  listWorkspaces(): readonly CliRegistryWorkspace[];
  openWorkspace(workspace: CliRegistryWorkspace): Promise<CliWorkspaceContext>;
  // Messages, reactions, and decisions go through the same module renderer
  // chat uses, so a CLI or MCP write gets the same checks and effects.
  chatWrites: ChatWrites;
  localUserDisplayName(): string;
  // The chain depth of the agent run in progress in the workspace, or 0. Every
  // write during a run an automation started is the agent's at this depth, so
  // an automation that woke the agent and the agent cannot start each other
  // forever.
  agentRunDepth(workspaceId: string): number;
  // Runs once a command has made its last durable change.
  onWrite?(workspace: CliWorkspaceContext): void | Promise<void>;
  // A chat read has no renderer poll behind it — with no window open, nothing
  // else ever runs a sync pass for it. Awaited (up to a bound — see
  // CHAT_READ_SYNC_BUDGET_MS) before the verb reads the store, the same
  // bounded rotating pass the renderer's reads trigger. `target` names the
  // read's own channel or thread, when the verb's args carry one, so that
  // channel is covered even past the pass's own row bound.
  onRead?(
    workspace: CliWorkspaceContext,
    target?: { channelId: string } | { threadId: string },
  ): void | Promise<void>;
  onError?(error: unknown): void;
  onDebug?(message: string): void;
  nowMs?: () => number;
  platform?: NodeJS.Platform;
  regexScanTimeoutMs?: number;
  chatReadSyncBudgetMs?: number;
  runMessageLinkRetryMs?: number;
  runMessageLinkDeadlineMs?: number;
  /** How many finished results and forgotten request ids each workspace keeps; tests lower them. */
  requestIdLimits?: { results: number; ids: number };
  runMessageLinkForegroundBudgetMs?: number;
  runMessageLinkRecoveryRetryMs?: number;
  runMessageLinkRecoveryMaxPending?: number;
  runMessageLinkRecoveryMaxAttempts?: number;
  runMessageLinkRecoveryMaxAgeMs?: number;
  onRunMessageLinkPending?(link: CliRunMessageLink): void;
  onRunMessageLinkSettled?(link: CliRunMessageLink): void;
  onRunMessageLinkAbandoned?(link: CliRunMessageLink): void;
}

export interface CliServerHandle {
  socketPath: string;
  tokenPath: string;
  close(): Promise<void>;
}

interface LoadedThread {
  thread: ChatThread;
  group: CliGroup;
  summary?: ChannelThreadSummary;
}

interface LoadedMessage {
  thread: LoadedThread;
  message: ChatMessage;
  messages: ChatMessage[];
}

class CliCommandError extends Error {
  constructor(message: string) {
    super(message.startsWith("dohc:") ? message : `dohc: ${message}`);
    this.name = "CliCommandError";
  }
}

export async function resolveCliWorkspace(
  cwd: string,
  workspaces: readonly CliRegistryWorkspace[],
): Promise<CliRegistryWorkspace | null> {
  const absoluteCwd = await realpath(resolve(cwd)).catch(() => null);
  if (absoluteCwd === null) return null;
  const candidates = (
    await Promise.all(
      workspaces.map(async (workspace) => {
        const root = await realpath(resolve(workspace.rootPath)).catch(() => null);
        return root === null ? null : { workspace, root };
      }),
    )
  )
    .filter((candidate): candidate is { workspace: CliRegistryWorkspace; root: string } =>
      candidate !== null && isInside(candidate.root, absoluteCwd)
    )
    .sort((left, right) => right.root.length - left.root.length);
  return candidates[0]?.workspace ?? null;
}

function tokenMatches(expected: string, supplied: string): boolean {
  if (!TOKEN_RE.test(supplied)) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function cliErrorLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unexpected CLI failure.";
  const message = oneLine(raw) || "Unexpected CLI failure.";
  return message.startsWith("dohc:") ? message : `dohc: ${message}`;
}

function shortenedEngineId(id: string, enginePrefix: string, cliPrefix: string): string {
  return id.startsWith(enginePrefix)
    ? `${cliPrefix}${id.slice(enginePrefix.length)}`
    : id;
}

function cliChannelId(id: string): string {
  return shortenedEngineId(id, "channel-", "ch_");
}

export function cliThreadId(id: string): string {
  return shortenedEngineId(id, "thread-", "th_");
}

export function cliMessageId(id: string): string {
  return formatMessageHandle(id);
}

// The engine's `channel` kind is a Group everywhere a reader sees it.
export function cliGroupKind(kind: ChatChannelSummary["kind"]): CliGroup["kind"] {
  return kind === "channel" ? "group" : kind;
}

// A thread linked to a file belongs to no engine channel; it lists here.
export const FILES_GROUP: CliGroup = {
  id: "files",
  name: "files",
  slug: "files",
  kind: "group",
};

function groupForCli(channel: ChatChannelSummary): CliGroup {
  return {
    id: cliChannelId(channel.id),
    name: channel.kind === "agent" ? "my-agent" : channel.name,
    slug: channel.slug,
    kind: cliGroupKind(channel.kind),
    ...(channel.purpose ? { purpose: channel.purpose } : {}),
  };
}

async function listCliChannelThreads(context: CliWorkspaceContext, channel: ChatChannelSummary) {
  const lanes = channel.type === "both" ? ["posts", "chat"] as const : [channel.type === "chat" ? "chat" : "posts"] as const;
  const pages = await Promise.all(lanes.map(lane => context.store.listChannelThreads({
    workspaceId: context.workspaceId, channelId: channel.id, lane,
  })));
  return pages.flat();
}

function authorForCli(message: ChatMessage): CliAuthor {
  return {
    kind: message.author.kind,
    displayName: message.author.displayName,
  };
}

function rawChatThread(thread: ChatThread) {
  return {
    id: thread.id,
    title: thread.title,
    createdAtMs: thread.createdAtMs,
    updatedAtMs: thread.updatedAtMs,
    ...(thread.linkedFile?.pathHint
      ? { linkedPathHint: thread.linkedFile.pathHint }
      : {}),
  };
}

function rawChatMessage(
  message: ChatMessage,
  decision: Awaited<ReturnType<LinkedChatStore["listThreadDecisions"]>>[number] | undefined,
) {
  return {
    id: message.id,
    threadId: message.threadId,
    authorKind: message.author.kind,
    authorDisplayName: message.author.displayName,
    ...(message.authorOwnerDisplayName ? { authorOwnerDisplayName: message.authorOwnerDisplayName } : {}),
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    attachments: message.attachments.map(({ objectId, pathHint }) => ({
      ...(objectId ? { objectId } : {}),
      ...(pathHint ? { pathHint } : {}),
    })),
    needsDecision: decision !== undefined,
    ...(decision ? {
      decisionState: decision.state,
      ...(decision.options ? { options: [...decision.options] } : {}),
      ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
      ...(decision.resolvedByMessageId ? { resolvedByMessageId: decision.resolvedByMessageId } : {}),
    } : {}),
  };
}

// A history row carries only facts the path admission checked. The moment's
// free-form summary is not sent: a rename's reads "Renamed <before> to <after>",
// and its before path may be one current policy no longer admits.
function rawMomentSummary(
  moment: Pick<
    VersionedTextMomentSummary,
    "id" | "recordedAtMs" | "operation" | "path" | "versionId" | "metadata" | "author"
  >,
  includeFiles: boolean,
) {
  return {
    id: moment.id,
    recordedAtMs: moment.recordedAtMs,
    source: "workspace-engine" as const,
    operation: moment.operation,
    path: moment.path,
    versionId: moment.versionId,
    ...(moment.author ? { author: moment.author } : {}),
    fileCount: 1 as const,
    ...(includeFiles
      ? { files: [{ path: moment.path, operation: moment.operation }] }
      : {}),
  };
}

function mcpFailure(error: unknown, fallback: string) {
  const reason = error instanceof Error ? error.message : fallback;
  return { ok: false as const, reason };
}

function collectionsUnavailable() {
  return {
    ok: false as const,
    reason: "collections are not available in this workspace",
  };
}

function cliPathRejected(reason: string, path: string) {
  return { ok: false as const, reason: `path rejected (${reason}): ${path}` };
}

// Collection values enter and leave the CLI socket in the engine wire's JSON
// encoding; the engine adapter speaks decoded CollectionValue on both sides.
function encodedCollectionRecord(record: CollectionRecord) {
  return {
    id: record.id,
    path: record.path,
    conflicted: record.conflicted,
    values: record.values.map((value) => ({
      field: value.field,
      value: encodeCollectionValue(value.value),
      validation: value.validation,
      resolvedRelations: value.resolvedRelations,
    })),
  };
}

function encodedCollectionCursor(cursor: CollectionQueryCursor) {
  return {
    sortValues: cursor.sortValues.map((entry) => ({
      present: entry.present,
      value: encodeCollectionValue(entry.value),
    })),
    recordPath: cursor.recordPath,
    recordId: cursor.recordId,
  };
}

function decodedCollectionCursor(
  cursor: CliCollectionQueryCursor,
): CollectionQueryCursor {
  return {
    sortValues: cursor.sortValues.map((entry) => ({
      present: entry.present,
      value: decodeCollectionValue(entry.value),
    })),
    recordPath: cursor.recordPath,
    recordId: cursor.recordId,
  };
}

// Who a write through this socket is. While a run an automation started holds
// the run slot, every write is that run's agent, whatever actor the caller
// named, as disk edits during the run are: an agent that names itself a
// person would otherwise write at depth 0 and start the chain over.
function writeActor(
  actor: CliActor,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): CliActor {
  return options.agentRunDepth(context.workspaceId) > 0 ? "agent" : actor;
}

// Provenance for a CLI/MCP collection write, derived main-side only. Agent
// traffic reaches this socket through the MCP server, whose declared identity
// is agent `dohc-mcp` acting on behalf of the local owner, at the depth of the
// agent run in progress; a human write is attributed as this device's local
// author under the workspace display name.
function collectionWriteAuthor(
  actor: CliActor,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): ChangeAuthor {
  if (writeActor(actor, context, options) === "agent") {
    return {
      kind: "agent",
      agentId: "dohc-mcp",
      onBehalfOf: "local",
      depth: options.agentRunDepth(context.workspaceId),
    };
  }
  return createLocalChangeAuthor(options.localUserDisplayName());
}

// Provenance for a document edit, derived here. A person types in the
// editor, so every edit through this socket is an agent's on behalf of the
// local owner, recorded under the name the agent gave itself or under none,
// at the depth of the agent run in progress. Any process holding the socket
// token could otherwise claim the person's typing.
function documentEditOrigin(
  agent: string | undefined,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): LiveDocumentEditOrigin {
  return {
    ...(agent === undefined ? {} : { actorOriginId: agent }),
    attribution: {
      actorKind: "agent",
      onBehalfOf: "local",
      depth: options.agentRunDepth(context.workspaceId),
    },
  };
}

function documentsUnavailable() {
  return {
    ok: false as const,
    reason: "documents are not available in this workspace",
  };
}

async function loadChannels(
  context: CliWorkspaceContext,
): Promise<{
  channels: Array<{ engine: ChatChannelSummary; cli: CliGroup }>;
  provisioned: boolean;
}> {
  const before = await context.store.listChannels({
    workspaceId: context.workspaceId,
  });
  if (!context.readOnly) {
    await context.store.ensureGeneralChannel({ workspaceId: context.workspaceId });
  }
  const channels = await context.store.listChannels({
    workspaceId: context.workspaceId,
  });
  return {
    channels: channels.map((engine) => ({ engine, cli: groupForCli(engine) })),
    provisioned: channels.length !== before.length,
  };
}

function withoutChannelMarker(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

function ambiguous(label: string, input: string, ids: readonly string[]): never {
  throw new CliCommandError(
    `ambiguous ${label} prefix '${input}': ${ids.join(", ")}`,
  );
}

function resolveIdPrefix<T>(
  input: string,
  label: string,
  values: readonly T[],
  idFor: (value: T) => string,
  aliasesFor: (value: T) => readonly string[] = () => [],
): T {
  const handlesFor = (value: T) => [idFor(value), ...aliasesFor(value)];
  const exact = values.filter((value) => handlesFor(value).includes(input));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) ambiguous(label, input, exact.map(idFor));
  const matches = values.filter((value) =>
    handlesFor(value).some((handle) => handle.startsWith(input)));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) ambiguous(label, input, matches.map(idFor));
  throw new CliCommandError(`no such ${label}: ${input}`);
}

function resolveChannel(
  input: string,
  channels: readonly { engine: ChatChannelSummary; cli: CliGroup }[],
): { engine: ChatChannelSummary; cli: CliGroup } {
  const normalized = withoutChannelMarker(input);
  const slugMatches = channels.filter(
    ({ engine, cli }) => cli.slug === normalized || cli.name === normalized || engine.name === normalized,
  );
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    ambiguous("group", input, slugMatches.map(({ cli }) => cli.id));
  }
  return resolveIdPrefix(
    normalized,
    "group",
    channels,
    ({ cli }) => cli.id,
    ({ engine }) => [engine.id],
  );
}

async function loadThreads(
  context: CliWorkspaceContext,
  channels: readonly { engine: ChatChannelSummary; cli: CliGroup }[],
): Promise<LoadedThread[]> {
  const summaries = await Promise.all(
    channels.map(async ({ engine, cli }) => ({
      cli,
      summaries: await listCliChannelThreads(context, engine),
    })),
  );
  const byId = new Map<string, LoadedThread>();
  for (const entry of summaries) {
    for (const summary of entry.summaries) {
      byId.set(summary.thread.id, {
        thread: summary.thread,
        group: entry.cli,
        summary,
      });
    }
  }
  const all = await context.store.listThreads({ workspaceId: context.workspaceId });
  for (const thread of all) {
    if (!byId.has(thread.id)) {
      byId.set(thread.id, { thread, group: FILES_GROUP });
    }
  }
  return [...byId.values()];
}

async function readReplyThread(
  context: CliWorkspaceContext,
  input: string,
  options: CliServerOptions,
): Promise<{ threadId: string; messages: ChatMessage[] }> {
  try {
    const messages = await context.store.listMessages({ workspaceId: context.workspaceId, threadId: input });
    return { threadId: input, messages };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "thread-not-found") throw error;
  }
  const loaded = await loadChannels(context);
  if (loaded.provisioned) await notifyWrite(options, context);
  const threadId = resolveThread(input, await loadThreads(context, loaded.channels)).thread.id;
  const messages = await context.store.listMessages({ workspaceId: context.workspaceId, threadId });
  return { threadId, messages };
}

async function loadMessagesByThread(
  context: CliWorkspaceContext,
  threads: readonly LoadedThread[],
): Promise<Map<string, ChatMessage[]>> {
  const entries = await Promise.all(
    threads.map(async (thread) => [
      thread.thread.id,
      await context.store.listMessages({
        workspaceId: context.workspaceId,
        threadId: thread.thread.id,
      }),
    ] as const),
  );
  return new Map(entries);
}

function resolveThread(input: string, threads: readonly LoadedThread[]): LoadedThread {
  return resolveIdPrefix(
    input,
    "thread",
    threads,
    ({ thread }) => cliThreadId(thread.id),
    ({ thread }) => [thread.id],
  );
}

function resolveMessageInThread(
  input: string,
  messages: readonly ChatMessage[],
): ChatMessage {
  return resolveIdPrefix(
    input,
    "message",
    messages,
    (message) => cliMessageId(message.id),
    (message) => [message.id],
  );
}

function resolveThreadOrMessage(
  input: string,
  threads: readonly LoadedThread[],
  messagesByThread: ReadonlyMap<string, ChatMessage[]>,
): { thread: LoadedThread; rootMessage?: ChatMessage } {
  const candidates: Array<{
    id: string;
    thread: LoadedThread;
    rootMessage?: ChatMessage;
  }> = [];
  for (const thread of threads) {
    candidates.push({ id: cliThreadId(thread.thread.id), thread });
    for (const message of messagesByThread.get(thread.thread.id) ?? []) {
      candidates.push({
        id: cliMessageId(message.id),
        thread,
        rootMessage: message,
      });
    }
  }
  const resolved = resolveIdPrefix(
    input,
    "thread or message",
    candidates,
    (item) => item.id,
    (item) => [item.rootMessage?.id ?? item.thread.thread.id],
  );
  return {
    thread: resolved.thread,
    ...(resolved.rootMessage ? { rootMessage: resolved.rootMessage } : {}),
  };
}

function branchFromMessage(
  messages: readonly ChatMessage[],
  rootMessage: ChatMessage,
): ChatMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  function isDescendant(message: ChatMessage): boolean {
    if (message.id === rootMessage.id) return true;
    let parentId = message.parentMessageId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      if (parentId === rootMessage.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentMessageId;
    }
    return false;
  }
  return messages.filter(isDescendant);
}

async function threadCounts(
  context: CliWorkspaceContext,
  loaded: LoadedThread,
  messages: readonly ChatMessage[],
): Promise<{ commentCount: number; openDecisionCount: number }> {
  if (loaded.summary) {
    return {
      commentCount: Math.max(0, loaded.summary.messageCount - 1),
      openDecisionCount: loaded.summary.openDecisionCount,
    };
  }
  const decisions = await context.store.listThreadDecisions(
    context.workspaceId,
    loaded.thread.id,
  );
  return {
    commentCount: Math.max(0, messages.length - 1),
    openDecisionCount: decisions.filter((decision) => decision.state === "open").length,
  };
}

async function buildShowResult(
  context: CliWorkspaceContext,
  loaded: LoadedThread,
  allMessages: readonly ChatMessage[],
  rootMessage?: ChatMessage,
): Promise<CliResultByVerb["show"]> {
  const decisions = await context.store.listThreadDecisions(
    context.workspaceId,
    loaded.thread.id,
  );
  const decisionByMessage = new Map(
    decisions.map((decision) => [decision.messageId, decision.state]),
  );
  const counts = await threadCounts(context, loaded, allMessages);
  const selected = rootMessage
    ? branchFromMessage(allMessages, rootMessage)
    : [...allMessages];
  const messages: CliShowMessage[] = selected.map((message) => ({
    id: cliMessageId(message.id),
    author: authorForCli(message),
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId
      ? { parentMessageId: cliMessageId(message.parentMessageId) }
      : {}),
    ...(decisionByMessage.has(message.id)
      ? { decisionState: decisionByMessage.get(message.id)! }
      : {}),
    attachments: message.attachments.map((attachment) => ({
      ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
      ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
    })),
  }));
  return {
    thread: {
      id: cliThreadId(loaded.thread.id),
      title: loaded.thread.title,
      group: loaded.group,
      ...counts,
    },
    messages,
  };
}

async function markShownThreadRead(
  context: CliWorkspaceContext,
  actor: CliActor,
  threadId: string,
  messages: readonly ChatMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  if (actor === "agent") {
    const latest = messages.reduce((current, candidate) =>
      candidate.createdAtMs > current.createdAtMs ||
      (candidate.createdAtMs === current.createdAtMs && candidate.id > current.id)
        ? candidate
        : current);
    await context.store.markThreadReadByAgent({
      workspaceId: context.workspaceId,
      threadId,
      upTo: { createdAtMs: latest.createdAtMs, messageId: latest.id },
    });
    return;
  }
  await context.store.markThreadRead({
    workspaceId: context.workspaceId,
    threadId,
    upToSequence: messages.length,
  });
}

async function workspaceRelativePath(
  context: CliWorkspaceContext,
  cwd: string,
  path: string,
  noun: string,
): Promise<string> {
  const absolute = resolve(cwd, path);
  const root = await realpath(resolve(context.rootPath));
  let canonical: string;
  try {
    canonical = await realpath(absolute);
    if (!isInside(root, canonical)) {
      throw new CliCommandError(`${noun} is outside this workspace: ${path}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const realParent = await realpath(dirname(absolute)).catch(() => {
      throw new CliCommandError(`${noun} is not a tracked workspace file: ${path}`);
    });
    if (!isInside(root, realParent)) {
      throw new CliCommandError(`${noun} is outside this workspace: ${path}`);
    }
    const suppliedName = basename(path);
    const unresolved = join(realParent, basename(absolute));
    if (basename(unresolved) !== suppliedName) {
      throw new CliCommandError(`${noun} is outside this workspace: ${path}`);
    }
    canonical = unresolved;
  }
  return relative(root, canonical).split(sep).join("/");
}

async function resolveAttachments(
  context: CliWorkspaceContext,
  cwd: string,
  paths: readonly string[],
): Promise<Array<{ objectId: string; pathHint: string }>> {
  return Promise.all(
    paths.map(async (path) => {
      const pathHint = await workspaceRelativePath(context, cwd, path, "attachment");
      const objectId = await context.fileObjectIdForPath(pathHint);
      if (!objectId) {
        throw new CliCommandError(
          `attachment is not a tracked workspace file: ${path}`,
        );
      }
      return { objectId, pathHint };
    }),
  );
}

function normalizeMatchedText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function grepContextMessage(message: ChatMessage): CliGrepContextMessage {
  return {
    messageId: cliMessageId(message.id),
    author: authorForCli(message),
    createdAtMs: message.createdAtMs,
    text: normalizeMatchedText(message.body),
  };
}

function sinceThreshold(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const duration = /^(\d+)d$/u.exec(value);
  if (duration) {
    const days = Number(duration[1]);
    if (Number.isSafeInteger(days) && days >= 0) {
      return nowMs - days * 24 * 60 * 60 * 1000;
    }
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new CliCommandError(`invalid --since value: ${value}`);
}

function messageMatchesFrom(message: ChatMessage, from: string | undefined): boolean {
  if (!from) return true;
  const normalized = from.toLocaleLowerCase();
  return message.author.kind === normalized ||
    message.author.displayName.toLocaleLowerCase().includes(normalized);
}

function substringTextMatcher(input: {
  pattern: string;
  ignoreCase: boolean;
}): (text: string) => boolean {
  const caseSensitive = !input.ignoreCase && /\p{Lu}/u.test(input.pattern);
  const needle = caseSensitive ? input.pattern : input.pattern.toLocaleLowerCase();
  return (text) => {
    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    return haystack.includes(needle);
  };
}

async function regexMatchesForTexts(
  input: { pattern: string; ignoreCase: boolean; texts: string[] },
  timeoutMs: number,
): Promise<boolean[]> {
  return new Promise<boolean[]>((resolveMatches, rejectMatches) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: input,
    });
    let settled = false;
    const finish = (task: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      task();
    };
    const deadline = setTimeout(() => {
      finish(() => rejectMatches(new CliCommandError("regular expression scan timed out")));
    }, timeoutMs);
    worker.once("message", (raw: unknown) => {
      const response = regexWorkerResponseSchema.safeParse(raw);
      if (!response.success ||
          (response.data.ok && response.data.matches.length !== input.texts.length)) {
        finish(() => rejectMatches(new CliCommandError("regular expression scan failed")));
        return;
      }
      if (!response.data.ok) {
        finish(() => rejectMatches(
          new CliCommandError(`invalid regular expression: ${input.pattern}`),
        ));
        return;
      }
      const matches = response.data.matches;
      finish(() => resolveMatches(matches));
    });
    worker.once("error", () => {
      finish(() => rejectMatches(new CliCommandError("regular expression scan failed")));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      const detail = code === 0 ? "ended without a response" : `exited with code ${code}`;
      finish(() => rejectMatches(
        new CliCommandError(`regular expression scan failed: ${detail}`),
      ));
    });
  });
}

async function queryFtsCandidates(
  context: CliWorkspaceContext,
  query: string,
  onDebug?: (message: string) => void,
): Promise<{ threadIds: Set<string>; messageIds: Set<string> } | null> {
  if ([...query.trim()].length < 3) return null;
  if ([...query.trim()].length > MAX_GRANULAR_CHAT_QUERY_CHARS) return null;
  let response: CliGranularChatMessageSearchResponse;
  try {
    response = await context.daemonReads.queryChatMessagesGranular({
      query,
      limit: MAX_FTS_CANDIDATES,
    });
    // A saturated prefilter is not exhaustive. Fall back to the full body scan
    // below so the optimization can never change grep's results at scale.
    if (response.saturated) return null;
    const threadIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const row of response.results) {
      threadIds.add(row.threadId);
      if (row.messageId) messageIds.add(row.messageId);
    }
    return { threadIds, messageIds };
  } catch (error) {
    const detail = oneLine(
      error instanceof Error ? error.message : "unknown daemon read failure",
    );
    onDebug?.(
      `grep daemon prefilter failed; falling back to full scan: ${detail}`,
    );
    return null;
  }
}

async function humanUnreadFileThreadIds(
  context: CliWorkspaceContext,
): Promise<Set<string>> {
  const threadIds = new Set<string>();
  let afterThreadId: string | undefined;
  for (;;) {
    const rows = await context.daemonReads.listUnreadFileThreads({
      pageLimit: 500,
      ...(afterThreadId ? { afterThreadId } : {}),
    });
    for (const row of rows) threadIds.add(row.threadId);
    if (rows.length < 500) return threadIds;
    const next = rows.at(-1)?.threadId;
    if (!next || next === afterThreadId) {
      throw new Error("Daemon unread-file pagination did not advance.");
    }
    afterThreadId = next;
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe || "chat";
}

async function notifyWrite(
  options: CliServerOptions,
  context: CliWorkspaceContext,
): Promise<void> {
  try {
    await options.onWrite?.(context);
  } catch (error) {
    options.onError?.(error);
  }
}

// The CLI client itself gives up after DEFAULT_RESPONSE_TIMEOUT_MS (30 s,
// packages/cli/src/index.ts) — an unbounded await of the sync pass (up to
// SHARED_CHANNEL_SYNC_PASS_ROWS rows, each up to its own relay timeout) can
// outlast that budget and kill the read entirely, which is worse than the
// stale read a bound leaves behind. A hook failure must never block a read for
// local data that already exists either — the same offline-degrades-silently
// contract the sync pass itself keeps.
const CHAT_READ_SYNC_BUDGET_MS = 10_000;

// A pass past the budget keeps running detached (see notifyRead below). A
// slow relay behind a stream of reads would otherwise start one detached pass
// per read — main.ts's own serializer only stops them running concurrently,
// not from queueing up unboundedly. One in-flight pass per (options,
// workspace) is tracked here so a read that finds one already running joins
// its race instead of starting another.
const chatReadSyncInFlight = new WeakMap<CliServerOptions, Map<string, Promise<void>>>();

function chatReadSyncInFlightFor(options: CliServerOptions): Map<string, Promise<void>> {
  const existing = chatReadSyncInFlight.get(options);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  chatReadSyncInFlight.set(options, created);
  return created;
}

async function notifyRead(
  options: CliServerOptions,
  context: CliWorkspaceContext,
  target?: { channelId: string } | { threadId: string },
): Promise<void> {
  const inFlight = chatReadSyncInFlightFor(options);
  let pending = inFlight.get(context.workspaceId);
  if (!pending) {
    // `target` names the pass this call starts. A read that instead joins an
    // already-running pass gets whatever priority that pass already
    // committed to — the same tradeoff a rotation-only pass always had.
    pending = Promise.resolve()
      .then(() => options.onRead?.(context, target))
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        if (inFlight.get(context.workspaceId) === pending) {
          inFlight.delete(context.workspaceId);
        }
      });
    inFlight.set(context.workspaceId, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolveBudget) => {
    timer = setTimeout(
      resolveBudget,
      options.chatReadSyncBudgetMs ?? CHAT_READ_SYNC_BUDGET_MS,
    );
  });
  // Past the budget, the read proceeds on whatever the store already has —
  // `pending` keeps running (tracked above, so a concurrent read joins it
  // instead of starting a second one) and the next read benefits from what it
  // finishes.
  await Promise.race([pending, budget]);
  clearTimeout(timer);
}

// Every verb that reads chat content before doing anything else. `moments` and
// `moment` read workspace-version history, not chat, so they sit outside it.
function isChatReadVerb(verb: CliRequest["verb"]): boolean {
  return (
    verb === "groups" ||
    verb === "threads" ||
    verb === "inbox" ||
    verb === "show" ||
    verb === "grep" ||
    verb === "export" ||
    verb === "fileChats" ||
    verb === "chat" ||
    verb === "groupsFull"
  );
}

// The chat/show/threads verbs name their target directly in their args — no
// resolution against the (not-yet-synced) local channel/thread list needed,
// the way the write side already resolves it. A wrong or unresolvable
// guess is harmless: syncSharedChannelsForChatTarget falls back to a plain
// pass, so this can only add coverage, never remove it.
function chatReadTarget(
  request: CliRequest,
): { channelId: string } | { threadId: string } | undefined {
  switch (request.verb) {
    case "chat":
      return { threadId: request.args.threadId };
    case "show":
      return { threadId: request.args.target };
    case "threads":
      return { channelId: request.args.group };
    default:
      return undefined;
  }
}

type RunMessageLinkInput = {
  actor: CliActor;
  runId?: string;
  messageId: string;
};

// A daemon refusal carries the engine's domain code as its message.
// Two of those codes can never succeed on a retry: a malformed message or run
// id ("invalid-input"), and a run that is not in this workspace
// ("run-not-found"). Retryability does not select them — a persist failure is
// terminal too, and giving up on it would drop a recoverable link.
const PERMANENT_RUN_MESSAGE_LINK_CODES = new Set([
  "invalid-input",
  "run-not-found",
]);

function isPermanentRunMessageLinkFailure(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError &&
    PERMANENT_RUN_MESSAGE_LINK_CODES.has(error.message)
  );
}

async function tryRunMessageLink(
  context: CliWorkspaceContext,
  input: RunMessageLinkInput,
  requestDeadlineMs: () => number,
): Promise<void> {
  if (input.actor !== "agent" || !input.runId) return;
  const run = await context.dispatchStore.getRunRecord(
    input.runId,
    { deadlineMs: requestDeadlineMs() },
  );
  if (!run || run.workspaceId !== context.workspaceId) return;
  await context.dispatchStore.recordRunMessage(
    {
      workspaceId: context.workspaceId,
      messageId: input.messageId,
      runId: input.runId,
    },
    { deadlineMs: requestDeadlineMs() },
  );
}

interface PendingRunMessageLink {
  context: CliWorkspaceContext;
  input: RunMessageLinkInput & { runId: string };
  link: CliRunMessageLink;
  attempt: number;
  createdAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface StoredRunMessageLink extends CliRunMessageLink {
  attempt: number;
  createdAtMs: number;
}

class RunMessageLinkRecoveryQueue {
  private readonly pending = new Map<string, PendingRunMessageLink>();
  private readonly deferred = new Map<string, StoredRunMessageLink>();
  private restored = false;
  private closed = false;

  constructor(private readonly options: CliServerOptions) {}

  async restore(): Promise<void> {
    if (this.restored || this.closed) return;
    this.restored = true;
    let stored: StoredRunMessageLink[];
    try {
      const parsed = JSON.parse(
        readFileSync(this.persistencePath(), "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      stored = parsed.filter(isStoredRunMessageLink);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      this.options.onError?.(
        new Error("Could not restore pending CLI provenance links.", {
          cause: error,
        }),
      );
      return;
    }
    const workspaces = new Map(
      this.options.listWorkspaces().map((workspace) => [
        workspace.workspaceId,
        workspace,
      ]),
    );
    const restored: Array<{
      context: CliWorkspaceContext;
      link: StoredRunMessageLink;
    }> = [];
    const contexts = new Map<string, CliWorkspaceContext>();
    for (const link of stored.slice(0, this.maxPending())) {
      const workspace = workspaces.get(link.workspaceId);
      if (!workspace) {
        this.options.onError?.(
          new Error(
            `Could not restore CLI provenance link for unavailable workspace ${link.workspaceId}.`,
          ),
        );
        this.deferred.set(this.key(link), link);
        continue;
      }
      try {
        let context = contexts.get(link.workspaceId);
        if (!context) {
          context = await this.options.openWorkspace(workspace);
          contexts.set(link.workspaceId, context);
        }
        restored.push({ context, link });
      } catch (error) {
        this.options.onError?.(
          new Error(
            `Could not restore CLI provenance link for workspace ${link.workspaceId}.`,
            { cause: error },
          ),
        );
        this.deferred.set(this.key(link), link);
        continue;
      }
    }
    for (const { context, link } of restored) {
      this.add(
        context,
        {
          actor: "agent",
          runId: link.runId,
          messageId: link.messageId,
        },
        link.attempt,
        link.createdAtMs,
        false,
      );
    }
    this.persist();
  }

  enqueue(
    context: CliWorkspaceContext,
    input: RunMessageLinkInput & { runId: string },
  ): boolean {
    if (this.closed) return false;
    const key = this.key({
      workspaceId: context.workspaceId,
      runId: input.runId,
      messageId: input.messageId,
    });
    if (
      !this.pending.has(key) &&
      !this.deferred.has(key) &&
      this.pending.size + this.deferred.size >= this.maxPending()
    ) {
      return false;
    }
    return this.add(context, input, 0, Date.now());
  }

  private add(
    context: CliWorkspaceContext,
    input: RunMessageLinkInput & { runId: string },
    attempt: number,
    createdAtMs: number,
    persist = true,
  ): boolean {
    const link = {
      workspaceId: context.workspaceId,
      runId: input.runId,
      messageId: input.messageId,
    };
    const key = this.key(link);
    if (this.pending.has(key)) return true;
    this.deferred.delete(key);
    const pending = {
      context,
      input,
      link,
      attempt,
      createdAtMs,
      timer: null,
    };
    this.pending.set(key, pending);
    if (persist && !this.persist()) {
      this.pending.delete(key);
      return false;
    }
    try {
      this.options.onRunMessageLinkPending?.(link);
    } catch {}
    this.schedule(key, pending);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  private schedule(key: string, pending: PendingRunMessageLink): void {
    if (this.closed || this.pending.get(key) !== pending) return;
    const baseDelay =
      this.options.runMessageLinkRecoveryRetryMs ??
      Math.max(250, this.options.runMessageLinkRetryMs ?? RUN_MESSAGE_LINK_RETRY_MS);
    const delay = Math.min(
      baseDelay * 2 ** Math.min(pending.attempt, 20),
      5_000,
    );
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.retry(key, pending);
    }, delay);
    pending.timer.unref?.();
  }

  private async retry(
    key: string,
    pending: PendingRunMessageLink,
  ): Promise<void> {
    if (this.closed || this.pending.get(key) !== pending) return;
    pending.attempt += 1;
    this.persist();
    try {
      await tryRunMessageLink(
        pending.context,
        pending.input,
        () =>
          this.options.runMessageLinkDeadlineMs ??
          RUN_MESSAGE_LINK_DEADLINE_MS,
      );
      if (this.closed || this.pending.get(key) !== pending) return;
      this.pending.delete(key);
      this.persist();
      this.notifySettled(pending.link);
    } catch (error) {
      if (this.closed || this.pending.get(key) !== pending) return;
      if (isPermanentRunMessageLinkFailure(error)) {
        this.pending.delete(key);
        this.persist();
        this.notifySettled(pending.link);
        return;
      }
      if (
        pending.attempt >=
          (this.options.runMessageLinkRecoveryMaxAttempts ??
            RUN_MESSAGE_LINK_RECOVERY_MAX_ATTEMPTS) ||
        Date.now() - pending.createdAtMs >=
          (this.options.runMessageLinkRecoveryMaxAgeMs ??
            RUN_MESSAGE_LINK_RECOVERY_MAX_AGE_MS)
      ) {
        this.pending.delete(key);
        this.persist();
        this.notifyAbandoned(pending.link);
        return;
      }
      this.schedule(key, pending);
    }
  }

  private maxPending(): number {
    return Math.max(
      1,
      this.options.runMessageLinkRecoveryMaxPending ??
        RUN_MESSAGE_LINK_RECOVERY_MAX_PENDING,
    );
  }

  private persistencePath(): string {
    return join(this.options.stateDir, RUN_MESSAGE_LINK_RECOVERY_FILE);
  }

  private key(link: CliRunMessageLink): string {
    return `${link.workspaceId}\u0000${link.runId}\u0000${link.messageId}`;
  }

  private persist(): boolean {
    const path = this.persistencePath();
    try {
      if (this.pending.size === 0 && this.deferred.size === 0) {
        rmSync(path, { force: true });
        return true;
      }
      mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
      const stored: StoredRunMessageLink[] = [
        ...this.deferred.values(),
        ...[...this.pending.values()].map(
          ({ link, attempt, createdAtMs }) => ({
            ...link,
            attempt,
            createdAtMs,
          }),
        ),
      ];
      const temporaryPath = `${path}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(stored)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, path);
      return true;
    } catch (error) {
      try {
        this.options.onError?.(
          new Error("Could not persist pending CLI provenance links.", {
            cause: error,
          }),
        );
      } catch {}
      return false;
    }
  }

  private notifySettled(link: CliRunMessageLink): void {
    try {
      this.options.onRunMessageLinkSettled?.(link);
    } catch {}
  }

  private notifyAbandoned(link: CliRunMessageLink): void {
    try {
      this.options.onRunMessageLinkAbandoned?.(link);
    } catch {}
  }
}

function isStoredRunMessageLink(value: unknown): value is StoredRunMessageLink {
  if (typeof value !== "object" || value === null) return false;
  const link = value as Partial<StoredRunMessageLink>;
  return (
    typeof link.workspaceId === "string" &&
    link.workspaceId.length > 0 &&
    typeof link.runId === "string" &&
    link.runId.length > 0 &&
    typeof link.messageId === "string" &&
    link.messageId.length > 0 &&
    typeof link.attempt === "number" &&
    Number.isSafeInteger(link.attempt) &&
    link.attempt >= 0 &&
    typeof link.createdAtMs === "number" &&
    Number.isSafeInteger(link.createdAtMs) &&
    link.createdAtMs >= 0
  );
}

const runMessageLinkRecoveryQueues = new WeakMap<
  CliServerOptions,
  RunMessageLinkRecoveryQueue
>();

function runMessageLinkRecoveryQueue(
  options: CliServerOptions,
): RunMessageLinkRecoveryQueue {
  const existing = runMessageLinkRecoveryQueues.get(options);
  if (existing) return existing;
  const created = new RunMessageLinkRecoveryQueue(options);
  runMessageLinkRecoveryQueues.set(options, created);
  return created;
}

export function disposeCliServerRuntime(options: CliServerOptions): void {
  runMessageLinkRecoveryQueues.get(options)?.close();
  runMessageLinkRecoveryQueues.delete(options);
}

export async function restoreCliServerRuntime(
  options: CliServerOptions,
): Promise<void> {
  await runMessageLinkRecoveryQueue(options).restore();
}

async function linkRunMessage(
  context: CliWorkspaceContext,
  input: RunMessageLinkInput,
  options: CliServerOptions,
): Promise<string | null> {
  if (input.actor !== "agent" || !input.runId) return null;
  const retryMs = options.runMessageLinkRetryMs ?? RUN_MESSAGE_LINK_RETRY_MS;
  const perRequestDeadlineMs =
    options.runMessageLinkDeadlineMs ?? RUN_MESSAGE_LINK_DEADLINE_MS;
  const foregroundDeadline =
    Date.now() +
    (options.runMessageLinkForegroundBudgetMs ??
      RUN_MESSAGE_LINK_FOREGROUND_BUDGET_MS);
  const requestDeadlineMs = (): number => {
    const remaining = foregroundDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error("CLI provenance foreground budget exhausted.");
    }
    return Math.max(1, Math.min(perRequestDeadlineMs, remaining));
  };
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= RUN_MESSAGE_LINK_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      await tryRunMessageLink(context, input, requestDeadlineMs);
      return null;
    } catch (error) {
      lastError = error;
      if (isPermanentRunMessageLinkFailure(error)) return null;
      const remaining = foregroundDeadline - Date.now();
      if (attempt < RUN_MESSAGE_LINK_ATTEMPTS && remaining > 0) {
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, Math.min(retryMs * attempt, remaining));
        });
        if (Date.now() >= foregroundDeadline) break;
        continue;
      }
      break;
    }
  }
  const queued = runMessageLinkRecoveryQueue(options).enqueue(context, {
    ...input,
    runId: input.runId,
  });
  const warning = queued
    ? `Message posted, but agent-run provenance could not be recorded after ${attempts} attempts; recovery will continue in the background.`
    : `Message posted, but agent-run provenance could not be recorded and the bounded recovery queue is full.`;
  try {
    options.onError?.(
      new Error(
        `${warning} runId=${input.runId} messageId=${input.messageId}`,
        { cause: lastError },
      ),
    );
  } catch {}
  return warning;
}

interface FileChatStart {
  path: string;
  title: string;
  body: string;
  runId?: string;
  agent?: string;
}

// A comment on a file takes the path a person's does: a chat linked to the
// file, then its first message, through the one chat write module. `created`
// says whether a chat now exists, so a retry knows whether it may start one.
async function startFileChat(
  context: CliWorkspaceContext,
  input: FileChatStart,
  options: CliServerOptions,
): Promise<{ created: boolean; result: unknown }> {
  let thread: ChatThread;
  try {
    thread = await options.chatWrites.createFileThread(context, {
      title: input.title,
      linkedFile: async () => {
        const objectId = await context.fileObjectIdForPath(input.path);
        if (!objectId) {
          throw new Error(
            `dohc does not track ${input.path} yet, so it cannot have chats. Only text files dohc tracks can. Try again once dohc lists the file.`,
          );
        }
        return { objectId, pathHint: input.path };
      },
    });
  } catch (error) {
    return { created: false, result: mcpFailure(error, `failed to start a chat on: ${input.path}`) };
  }
  let message: ChatMessage;
  try {
    message = await options.chatWrites.sendMessage(context, {
      writer: { via: "cli", actor: "agent", ...(input.agent ? { agentName: input.agent } : {}) },
      threadId: thread.id,
      body: input.body,
      resolveAttachments: async () => [],
    });
  } catch (error) {
    // The chat exists now. Name it, so the caller replies there instead
    // of starting a second one.
    await notifyWrite(options, context);
    const cause = error instanceof Error ? error.message : String(error);
    return {
      created: true,
      result: {
        ok: false as const,
        reason: `dohc started chat ${thread.id} on ${input.path}, but could not post its first message (${cause}). Reply in that chat to post it.`,
      },
    };
  }
  const linkWarning = await linkRunMessage(context, {
    actor: "agent",
    ...(input.runId ? { runId: input.runId } : {}),
    messageId: message.id,
  }, options);
  await notifyWrite(options, context);
  return {
    created: true,
    result: {
      ok: true as const,
      path: input.path,
      threadId: thread.id,
      messageId: message.id,
      ...(linkWarning ? { warning: linkWarning } : {}),
    },
  };
}

// The results of requests a caller sent with a request id, per workspace. A
// caller whose request passed the socket deadline sends it again with the same
// id and gets the first result instead of the work done twice. Kept in memory
// while dohc runs.
//
// A running request is never dropped; the socket's connection limit bounds how
// many run at once. A finished one is kept as a digest of its input and its
// small result. Past the limit the oldest finished result is dropped and only
// its id is kept, so a resend is refused instead of run again. Past that
// limit too, the oldest ids go, and only then could a very old id run again.
// The MCP tool descriptions that take a requestId state these numbers.
const REQUEST_ID_LIMITS = { results: 1_024, ids: 16_384 };

interface RememberedRequest {
  input: string;
  result: Promise<unknown>;
  finished: boolean;
}

interface WorkspaceRequests {
  requests: Map<string, RememberedRequest>;
  forgotten: Set<string>;
}

const requestMemory = new WeakMap<CliServerOptions, Map<string, WorkspaceRequests>>();

function workspaceRequests(options: CliServerOptions, workspaceId: string): WorkspaceRequests {
  let workspaces = requestMemory.get(options);
  if (!workspaces) {
    workspaces = new Map();
    requestMemory.set(options, workspaces);
  }
  let memory = workspaces.get(workspaceId);
  if (!memory) {
    memory = { requests: new Map(), forgotten: new Set() };
    workspaces.set(workspaceId, memory);
  }
  return memory;
}

function forgetOldestResults(memory: WorkspaceRequests, limits: { results: number; ids: number }): void {
  let finished = 0;
  for (const request of memory.requests.values()) if (request.finished) finished += 1;
  for (const [requestId, request] of memory.requests) {
    if (finished <= limits.results) break;
    if (!request.finished) continue;
    memory.requests.delete(requestId);
    memory.forgotten.add(requestId);
    finished -= 1;
  }
  for (const requestId of memory.forgotten) {
    if (memory.forgotten.size <= limits.ids) break;
    memory.forgotten.delete(requestId);
  }
}

async function onceForRequestId(
  context: CliWorkspaceContext,
  options: CliServerOptions,
  requestId: string,
  input: unknown,
  run: () => Promise<{ done: boolean; result: unknown }>,
): Promise<unknown> {
  const memory = workspaceRequests(options, context.workspaceId);
  // A digest, so a remembered edit does not keep its text in memory.
  const inputKey = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const remembered = memory.requests.get(requestId);
  if (remembered) {
    if (remembered.input !== inputKey) {
      return { ok: false as const, reason: `request id ${requestId} was already used for a different request` };
    }
    return await remembered.result;
  }
  if (memory.forgotten.has(requestId)) {
    return {
      ok: false as const,
      reason: `dohc no longer holds the result of request id ${requestId}, so it did not run it again. Read the document or the chat to see whether it happened, and send any new request with a new id.`,
    };
  }
  const started = run();
  const result = started.then((outcome) => outcome.result);
  // A retry may never come to await it.
  result.catch(() => undefined);
  const entry: RememberedRequest = { input: inputKey, result, finished: false };
  memory.requests.set(requestId, entry);
  const limits = options.requestIdLimits ?? REQUEST_ID_LIMITS;
  try {
    const outcome = await started;
    if (outcome.done) {
      // Finished results leave in the order they finished.
      entry.finished = true;
      if (memory.requests.get(requestId) === entry) {
        memory.requests.delete(requestId);
        memory.requests.set(requestId, entry);
      }
      forgetOldestResults(memory, limits);
    } else {
      memory.requests.delete(requestId);
    }
    return outcome.result;
  } catch (error) {
    memory.requests.delete(requestId);
    throw error;
  }
}

async function dispatch(
  request: CliRequest,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): Promise<unknown> {
  if (request.verb === "reply" && request.args.choose !== undefined && request.args.resolve === undefined) {
    throw new CliCommandError("--choose needs --resolve <message>");
  }
  switch (request.verb) {
    case "appPublication": {
      if (request.args.request.workspaceId !== context.workspaceId || context.readOnly || !context.appPublication) throw new CliCommandError("App publication requires the owning workspace.");
      return context.appPublication(request.args.request);
    }
    case "dataset": {
      if (request.args.request.action === "export" && !request.args.request.savePath) throw new CliCommandError("Collection export requires an explicit savePath.");
      if (request.args.request.workspaceId !== context.workspaceId || context.readOnly || !context.dataset) throw new CliCommandError("Collections require the owning workspace.");
      return context.dataset(request.args.request);
    }
    case "ownerAppResponses": {
      if(request.args.request.workspaceId!==context.workspaceId || context.readOnly || !context.ownerAppResponses)throw new CliCommandError("App responses require the owning workspace.");
      return context.ownerAppResponses(request.args.request);
    }
    case "moments": {
      const includeFiles = request.args.includeFiles ?? false;
      const sinceMs = request.args.sinceMs;
      const limit = Math.min(
        LIST_MOMENTS_HARD_LIMIT,
        Math.max(1, Math.floor(request.args.limit ?? 50)),
      );
      // A path narrows the list to that file's own history, across renames.
      let objectId: string | undefined;
      if (request.args.path !== undefined) {
        const path = await workspaceRelativePath(context, request.args.cwd, request.args.path, "file");
        objectId = (await context.fileObjectIdForPath(path)) ?? undefined;
        if (!objectId) throw new CliCommandError(`file is not a tracked workspace file: ${request.args.path}`);
      }
      const moments = await context.listMoments({
        limit: LIST_MOMENTS_HARD_LIMIT,
        ...(objectId ? { objectId } : {}),
      });
      const selectedMoments = sinceMs === undefined
        ? moments
        : moments.filter((moment) => moment.recordedAtMs > sinceMs);
      const merged = selectedMoments
        .map((moment) => rawMomentSummary(moment, includeFiles))
        .sort((left, right) =>
          right.recordedAtMs - left.recordedAtMs ||
          left.id.localeCompare(right.id),
        );
      const selected = merged.slice(0, limit);
      return {
        changes: selected,
        count: selected.length,
        totalAvailable: merged.length,
        hasMore: merged.length > selected.length,
        cursorMs: selected.reduce(
          (max, entry) => Math.max(max, entry.recordedAtMs),
          sinceMs ?? 0,
        ),
      };
    }

    case "moment": {
      const moment = await context.readMoment(request.args.id);
      if (!moment) {
        return {
          ok: false as const,
          reason: `change not found: ${request.args.id}`,
        };
      }
      return {
        ok: true as const,
        change: {
          ...rawMomentSummary(moment, true),
          before: moment.payload.before,
          after: moment.payload.after,
        },
      };
    }

    case "fileChats": {
      const validated = validateUserReadPath(request.args.path, { platform: process.platform });
      if (!validated.ok) {
        return {
          ok: false as const,
          reason: `path rejected (${validated.reason}): ${request.args.path}`,
        };
      }
      try {
        const fileObjectId = await context.fileObjectIdForPath(validated.normalized);
        const threads = fileObjectId
          ? await context.store.listThreadsForFile({
              workspaceId: context.workspaceId,
              objectId: fileObjectId,
            })
          : [];
        return {
          ok: true as const,
          path: validated.normalized,
          fileObjectId,
          threads: threads.map(rawChatThread),
        };
      } catch (error) {
        return mcpFailure(error, `failed to list chats for: ${request.args.path}`);
      }
    }

    case "chat": {
      try {
        const messages = await context.store.listMessages({
          workspaceId: context.workspaceId,
          threadId: request.args.threadId,
        });
        const threads = await context.store.listThreads({
          workspaceId: context.workspaceId,
        });
        const thread = threads.find(
          (candidate) => candidate.id === request.args.threadId,
        );
        if (!thread) {
          return {
            ok: false as const,
            reason: `chat thread not found: ${request.args.threadId}`,
          };
        }
        const currentPath = thread.linkedFile
          ? await context.filePathForObjectId(thread.linkedFile.objectId)
          : null;
        const projection = await context.store.getThreadProjection({
          workspaceId: context.workspaceId,
          threadId: thread.id,
          linkedFileAccess: currentPath
            ? { kind: "allowed", path: currentPath }
            : { kind: "unknown" },
        });
        const decisions = await context.store.listThreadDecisions(context.workspaceId, thread.id);
        const decisionByMessage = new Map(decisions.map((decision) => [decision.messageId, decision]));
        return {
          ok: true as const,
          thread: rawChatThread(thread),
          messages: messages.map((message) => rawChatMessage(message, decisionByMessage.get(message.id))),
          projection: {
            path: projection.path,
            readOnly: projection.readOnly,
            text: projection.text,
          },
        };
      } catch (error) {
        return mcpFailure(error, `failed to read chat: ${request.args.threadId}`);
      }
    }

    case "groupsFull": {
      try {
        const before = await context.store.listChannels({
          workspaceId: context.workspaceId,
        });
        if (!context.readOnly) {
          await context.store.ensureGeneralChannel({
            workspaceId: context.workspaceId,
          });
        }
        const fullChannels = await context.store.listChannels({
          workspaceId: context.workspaceId,
        });
        if (fullChannels.length !== before.length) {
          await notifyWrite(options, context);
        }
        const withThreads = [];
        for (const channel of fullChannels) {
          const threads = await listCliChannelThreads(context, channel);
          withThreads.push({
            id: channel.id,
            name: channel.name,
            slug: channel.slug,
            kind: cliGroupKind(channel.kind),
            threadCount: threads.length,
            ...(channel.purpose ? { purpose: channel.purpose } : {}),
            threads: threads.map((entry) => ({
              id: entry.thread.id,
              title: entry.thread.title,
              messageCount: entry.messageCount,
              ...(channel.type === "both" ? { lane: entry.thread.lane } : {}),
              updatedAtMs: entry.thread.updatedAtMs,
            })),
          });
        }
        return { ok: true as const, groups: withThreads };
      } catch (error) {
        return mcpFailure(error, "failed to list groups");
      }
    }

    case "collectionQuery": {
      const collections = context.collections;
      if (!collections) return collectionsUnavailable();
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) {
        return cliPathRejected(validated.reason, request.args.collectionPath);
      }
      try {
        const args = request.args;
        const result = await collections.query({
          collectionPath: validated.normalized,
          ...(args.filter !== undefined
            ? {
                filter: {
                  field: args.filter.field,
                  operator: args.filter.operator,
                  value: decodeCollectionValue(args.filter.value),
                },
              }
            : {}),
          ...(args.sort !== undefined ? { sort: args.sort } : {}),
          ...(args.groupBy !== undefined ? { groupBy: args.groupBy } : {}),
          ...(args.resolveRelations !== undefined
            ? { resolveRelations: args.resolveRelations }
            : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined
            ? { cursor: decodedCollectionCursor(args.cursor) }
            : {}),
        });
        return {
          ok: true as const,
          collection: result.collection,
          records: result.records.map(encodedCollectionRecord),
          groups:
            result.groups === null
              ? null
              : result.groups.map((group) => ({
                  value: encodeCollectionValue(group.value),
                  records: group.records.map(encodedCollectionRecord),
                })),
          nextCursor:
            result.nextCursor === null
              ? null
              : encodedCollectionCursor(result.nextCursor),
        };
      } catch (error) {
        return mcpFailure(
          error,
          `failed to query collection: ${request.args.collectionPath}`,
        );
      }
    }

    case "collectionRecord": {
      const collections = context.collections;
      if (!collections) return collectionsUnavailable();
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) {
        return cliPathRejected(validated.reason, request.args.collectionPath);
      }
      try {
        const result = await collections.getRecord({
          collectionPath: validated.normalized,
          recordId: request.args.recordId,
          historyLimit: request.args.historyLimit,
          ...(request.args.beforeHistoryId !== undefined
            ? { beforeHistoryId: request.args.beforeHistoryId }
            : {}),
        });
        return {
          ok: true as const,
          collection: result.collection,
          record: encodedCollectionRecord(result.record),
          history: result.history.map((entry) => ({
            historyId: entry.historyId,
            field: entry.field,
            previous: {
              present: entry.previous.present,
              value: encodeCollectionValue(entry.previous.value),
            },
            next: {
              present: entry.next.present,
              value: encodeCollectionValue(entry.next.value),
            },
            authorOriginId: entry.authorOriginId,
            actorKind: entry.actorKind,
            onBehalfOf: entry.onBehalfOf,
            depth: entry.depth,
            recordedAtMs: entry.recordedAtMs,
          })),
        };
      } catch (error) {
        return mcpFailure(
          error,
          `failed to read record: ${request.args.recordId}`,
        );
      }
    }

    case "collectionSetFields": {
      const collections = context.collections;
      if (!collections) return collectionsUnavailable();
      // A write-mode check: the seam opens the record's live session, so
      // the path must clear the same floor every other CLI write clears.
      const validated = validateUserWritePath(request.args.recordPath);
      if (!validated.ok) {
        return cliPathRejected(validated.reason, request.args.recordPath);
      }
      try {
        const outcome = await collections.writes.setFields({
          recordPath: validated.normalized,
          fields: request.args.fields,
          author: collectionWriteAuthor(request.args.actor, context, options),
        });
        return { ok: true as const, recordPath: outcome.path };
      } catch (error) {
        return mcpFailure(
          error,
          `failed to set fields on: ${request.args.recordPath}`,
        );
      }
    }

    case "collectionCreateRecord": {
      const collections = context.collections;
      if (!collections) return collectionsUnavailable();
      const collectionValidated = validateUserReadPath(
        request.args.collectionPath,
        { platform: process.platform },
      );
      if (!collectionValidated.ok) {
        return cliPathRejected(
          collectionValidated.reason,
          request.args.collectionPath,
        );
      }
      // The record materializes as a new file, so the joined spelling must
      // pass the stricter materialization rules before the seam sees it.
      const recordValidated = validateUserMaterializePath(
        `${collectionValidated.normalized}/${request.args.name}.md`,
        { platform: process.platform },
      );
      if (!recordValidated.ok) {
        return cliPathRejected(
          recordValidated.reason,
          `${request.args.collectionPath}/${request.args.name}.md`,
        );
      }
      try {
        const outcome = await collections.writes.createRecord({
          collectionPath: collectionValidated.normalized,
          name: request.args.name,
          fields: request.args.fields,
          author: collectionWriteAuthor(request.args.actor, context, options),
        });
        return {
          ok: true as const,
          recordId: outcome.recordId,
          recordPath: outcome.path,
        };
      } catch (error) {
        return mcpFailure(
          error,
          `failed to create a record in: ${request.args.collectionPath}`,
        );
      }
    }

    case "documentRead": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const validated = validateUserReadPath(request.args.path, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      try {
        return { ok: true as const, ...(await documents.read(validated.normalized)) };
      } catch (error) {
        return mcpFailure(error, `failed to read document: ${request.args.path}`);
      }
    }

    case "documentEdit": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const { actor, agent, find, replacement } = request.args;
      if (actor !== "agent") {
        return {
          ok: false as const,
          reason: "a document edit through the CLI socket is recorded as an agent's; send actor \"agent\"",
        };
      }
      const validated = validateUserWritePath(request.args.path);
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      const path = validated.normalized;
      const edit = async (): Promise<{ done: boolean; result: unknown }> => {
        try {
          const outcome = await documents.edit({
            path,
            edit: { find, replacement },
            origin: documentEditOrigin(agent, context, options),
          });
          return { done: true, result: { ok: true as const, ...outcome } };
        } catch (error) {
          return {
            // An edit that reached the document is remembered with its
            // failure, so a retry does not apply it again.
            done: error instanceof LiveDocumentEditAppliedError,
            result: mcpFailure(error, `failed to edit document: ${request.args.path}`),
          };
        }
      };
      const requestId = request.args.requestId;
      if (requestId === undefined) return (await edit()).result;
      return await onceForRequestId(context, options, requestId, [path, find ?? null, replacement, agent ?? null], edit);
    }

    case "documentCreate": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const { actor, agent, markdown } = request.args;
      if (actor !== "agent") {
        return {
          ok: false as const,
          reason: "a document created through the CLI socket is recorded as an agent's; send actor \"agent\"",
        };
      }
      // A new file, so the stricter materialization rules apply.
      const validated = validateUserMaterializePath(request.args.path, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      if (liveDocumentKindForPath(validated.normalized) !== "richdoc") {
        return { ok: false as const, reason: `a document path ends in .md or .markdown: ${request.args.path}` };
      }
      try {
        return {
          ok: true as const,
          ...(await documents.create({
            path: validated.normalized,
            markdown,
            origin: documentEditOrigin(agent, context, options),
          })),
        };
      } catch (error) {
        return mcpFailure(error, `failed to create document: ${request.args.path}`);
      }
    }

    // A comment on a file takes the path a person's does: a chat linked to
    // the file, then its first message, through the one chat write module.
    case "fileChatStart": {
      if (request.args.actor !== "agent") {
        return {
          ok: false as const,
          reason: "a comment through the CLI socket is recorded as an agent's; send actor \"agent\"",
        };
      }
      const validated = validateUserReadPath(request.args.path, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      const input = {
        path: validated.normalized,
        title: request.args.title,
        body: request.args.body,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        ...(request.args.agent ? { agent: request.args.agent } : {}),
      };
      const requestId = request.args.requestId;
      if (requestId === undefined) return (await startFileChat(context, input, options)).result;
      return await onceForRequestId(
        context,
        options,
        requestId,
        [input.path, input.title, input.body, input.runId ?? null, input.agent ?? null],
        async () => {
          const started = await startFileChat(context, input, options);
          return { done: started.created, result: started.result };
        },
      );
    }
  }

  const loadedChannels = request.verb === "reply"
    ? { channels: [], provisioned: false }
    : await loadChannels(context);
  const channels = loadedChannels.channels;
  if (loadedChannels.provisioned) await notifyWrite(options, context);
  const nowMs = options.nowMs ?? Date.now;

  switch (request.verb) {
    case "groups":
      return { groups: channels.map(({ cli }) => cli) };

    case "threads": {
      const channel = resolveChannel(request.args.group, channels);
      const summaries = await listCliChannelThreads(context, channel.engine);
      const agentUnread = request.args.actor === "agent"
        ? new Set(
            (await context.store.listAgentUnreadThreads(context.workspaceId)).map(
              (thread) => thread.id,
            ),
          )
        : null;
      return {
        group: channel.cli,
        threads: summaries.map((summary) => ({
          id: cliThreadId(summary.thread.id),
          ...(channel.engine.type === "both" ? { lane: summary.thread.lane } : {}),
          title: summary.thread.title,
          commentCount: Math.max(0, summary.messageCount - 1),
          openDecisionCount: summary.openDecisionCount,
          unread: agentUnread
            ? agentUnread.has(summary.thread.id)
            : summary.unreadCount > 0,
          updatedAtMs: summary.thread.updatedAtMs,
        })),
      };
    }

    case "inbox": {
      if (request.args.actor === "human") {
        const groups = await Promise.all(
          channels.map(async (channel) => ({
            channel,
            summaries: await listCliChannelThreads(context, channel.engine),
          })),
        );
        const channelThreads = groups.flatMap(({ channel, summaries }) =>
          summaries
            .filter((summary) => summary.unreadCount > 0)
            .map((summary) => ({
              id: cliThreadId(summary.thread.id),
              title: summary.thread.title,
              commentCount: Math.max(0, summary.messageCount - 1),
              openDecisionCount: summary.openDecisionCount,
              unread: true as const,
              updatedAtMs: summary.thread.updatedAtMs,
              group: channel.cli,
            })),
        );
        const unreadFileIds = await humanUnreadFileThreadIds(context);
        const fileThreads = (await loadThreads(context, channels)).filter((thread) =>
          thread.thread.linkedFile && unreadFileIds.has(thread.thread.id));
        const messagesByThread = await loadMessagesByThread(context, fileThreads);
        const unreadFileThreads = await Promise.all(fileThreads.map(async (thread) => ({
          id: cliThreadId(thread.thread.id),
          title: thread.thread.title,
          ...await threadCounts(
            context,
            thread,
            messagesByThread.get(thread.thread.id) ?? [],
          ),
          unread: true,
          updatedAtMs: thread.thread.updatedAtMs,
          group: thread.group,
        })));
        const threads = [...channelThreads, ...unreadFileThreads];
        threads.sort((left, right) =>
          right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id));
        return { threads, mentions: [] };
      }

      const loadedThreads = await loadThreads(context, channels);
      const loadedById = new Map(
        loadedThreads.map((thread) => [thread.thread.id, thread]),
      );
      const unread = await context.store.listAgentUnreadThreads(context.workspaceId);
      const agentChannelIds = new Set(
        channels
          .filter(({ engine }) => engine.kind === "agent")
          .map(({ engine }) => engine.id),
      );
      const inboxThreads = await Promise.all(
        unread
          .map((thread) => loadedById.get(thread.id))
          .filter((thread): thread is LoadedThread =>
            Boolean(thread?.thread.channelId && agentChannelIds.has(thread.thread.channelId)),
          )
          .map(async (thread) => {
            const messages = await context.store.listMessages({
              workspaceId: context.workspaceId,
              threadId: thread.thread.id,
            });
            const counts = await threadCounts(context, thread, messages);
            return {
              id: cliThreadId(thread.thread.id),
              title: thread.thread.title,
              ...counts,
              unread: true,
              updatedAtMs: thread.thread.updatedAtMs,
              group: thread.group,
            };
          }),
      );
      inboxThreads.sort((left, right) => right.updatedAtMs - left.updatedAtMs);

      const mentionRows = await context.store.listMentionsForHandle(
        context.workspaceId,
        "agent",
        { unreadByAgentOnly: true },
      );
      const messageCache = new Map<string, ChatMessage[]>();
      const mentions: CliResultByVerb["inbox"]["mentions"] = [];
      for (const mention of mentionRows) {
        const thread = loadedById.get(mention.threadId);
        if (!thread) continue;
        let messages = messageCache.get(thread.thread.id);
        if (!messages) {
          messages = await context.store.listMessages({
            workspaceId: context.workspaceId,
            threadId: thread.thread.id,
          });
          messageCache.set(thread.thread.id, messages);
        }
        const message = messages.find((candidate) => candidate.id === mention.messageId);
        if (!message) continue;
        mentions.push({
          threadId: cliThreadId(thread.thread.id),
          messageId: cliMessageId(message.id),
          group: thread.group,
          author: authorForCli(message),
          createdAtMs: message.createdAtMs,
          text: normalizeMatchedText(message.body),
        });
      }
      mentions.sort((left, right) => right.createdAtMs - left.createdAtMs);
      return { threads: inboxThreads, mentions };
    }

    case "show": {
      const threads = await loadThreads(context, channels);
      const messagesByThread = await loadMessagesByThread(context, threads);
      const target = resolveThreadOrMessage(
        request.args.target,
        threads,
        messagesByThread,
      );
      const messages = messagesByThread.get(target.thread.thread.id) ?? [];
      const result = await buildShowResult(
        context,
        target.thread,
        messages,
        target.rootMessage,
      );
      if (!request.args.peek) {
        if (context.readOnly) {
          throw new CliCommandError("show requires --peek in a read-only workspace");
        }
        await markShownThreadRead(
          context,
          request.args.actor,
          target.thread.thread.id,
          messages,
        );
        await notifyWrite(options, context);
      }
      return result;
    }

    case "post": {
      const channel = resolveChannel(request.args.group, channels);
      if (channel.engine.kind === "dm") {
        throw new CliCommandError(
          "DMs are streams — use 'dohc chat reply <thread>'",
        );
      }
      const actor = writeActor(request.args.actor, context, options);
      const started = await options.chatWrites.startThread(context, {
        writer: { via: "cli", actor },
        channelId: channel.engine.id,
        ...(channel.engine.type === "chat" ? { lane: "chat" as const } : {}),
        ...(request.args.title ? { title: request.args.title } : {}),
        body: request.args.body,
        needsDecision: request.args.needsDecision,
        ...(request.args.options ? { options: request.args.options } : {}),
        resolveAttachments: () =>
          resolveAttachments(context, request.args.cwd, request.args.attachments),
      });
      const linkWarning = await linkRunMessage(context, {
        actor,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        messageId: started.message.id,
      }, options);
      await notifyWrite(options, context);
      return {
        group: channel.cli,
        threadId: cliThreadId(started.thread.id),
        messageId: cliMessageId(started.message.id),
        title: started.thread.title,
        ...(linkWarning ? { warning: linkWarning } : {}),
      };
    }

    case "reply": {
      const { threadId, messages } = await readReplyThread(context, request.args.thread, options);
      const parent = request.args.to
        ? resolveMessageInThread(request.args.to, messages)
        : undefined;
      let decisionMessage: ChatMessage | undefined;
      if (request.args.resolve) {
        decisionMessage = resolveMessageInThread(request.args.resolve, messages);
        const decisions = await context.store.listThreadDecisions(
          context.workspaceId,
          threadId,
        );
        const decision = decisions.find(
          (candidate) => candidate.messageId === decisionMessage?.id,
        );
        if (!decision || decision.state !== "open") {
          throw new CliCommandError(
            `message is not an open decision: ${cliMessageId(decisionMessage.id)}`,
          );
        }
        const choices = decision.options ?? [];
        const chosen = request.args.choose?.trim();
        if (choices.length > 0 && (!chosen || !choices.includes(chosen))) {
          throw new CliCommandError("Pick one of the poll's choices.");
        }
        if (choices.length === 0 && chosen) {
          throw new CliCommandError("This question has no choices to pick from.");
        }
      }
      const actor = writeActor(request.args.actor, context, options);
      const message = await options.chatWrites.sendMessage(context, {
        writer: { via: "cli", actor },
        threadId,
        ...(parent ? { parentMessageId: parent.id } : {}),
        body: request.args.body,
        needsDecision: request.args.needsDecision,
        ...(request.args.options ? { options: request.args.options } : {}),
        resolveAttachments: () =>
          resolveAttachments(context, request.args.cwd, request.args.attachments),
      });
      const linkWarning = await linkRunMessage(context, {
        actor,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        messageId: message.id,
      }, options);
      let resolvedByReply = false;
      let resolutionFailure: string | null = null;
      if (decisionMessage) {
        try {
          const resolution = await options.chatWrites.resolveDecision(context, {
            threadId,
            messageId: decisionMessage.id,
            resolvedByMessageId: message.id,
            ...(request.args.choose ? { chosenOption: request.args.choose } : {}),
            reply: message,
          });
          resolvedByReply = resolution.resolvedByMessageId === message.id;
        } catch (error) {
          resolutionFailure = oneLine(
            error instanceof Error ? error.message : "decision update failed",
          );
          options.onError?.(error);
        }
      }
      if (actor === "agent") {
        try {
          await context.store.markThreadReadByAgent({
            workspaceId: context.workspaceId,
            threadId,
            upTo: { createdAtMs: message.createdAtMs, messageId: message.id },
          });
        } catch (error) {
          options.onError?.(error);
        }
      }
      await notifyWrite(options, context);
      const resolutionWarning = decisionMessage && !resolvedByReply
        ? `reply ${cliMessageId(message.id)} was posted, but decision ${cliMessageId(decisionMessage.id)} ` +
          (resolutionFailure
            ? `could not be resolved: ${resolutionFailure}`
            : "was already resolved by another message")
        : undefined;
      const warning = [linkWarning, resolutionWarning].filter(Boolean).join(" ");
      return {
        threadId: cliThreadId(threadId),
        messageId: cliMessageId(message.id),
        ...(parent ? { parentMessageId: cliMessageId(parent.id) } : {}),
        ...(decisionMessage && resolvedByReply
          ? { resolvedMessageId: cliMessageId(decisionMessage.id) }
          : {}),
        ...(warning ? { warning } : {}),
      };
    }

    case "react": {
      const threads = await loadThreads(context, channels);
      const messagesByThread = await loadMessagesByThread(context, threads);
      const target = resolveThreadOrMessage(
        request.args.message,
        threads,
        messagesByThread,
      );
      if (!target.rootMessage) {
        throw new CliCommandError(`no such message: ${request.args.message}`);
      }
      const reaction = await options.chatWrites.setReaction(context, {
        writer: { via: "cli", actor: writeActor(request.args.actor, context, options) },
        threadId: target.thread.thread.id,
        messageId: target.rootMessage.id,
        emoji: request.args.emoji,
        state: "toggle",
      });
      await notifyWrite(options, context);
      return {
        threadId: cliThreadId(target.thread.thread.id),
        messageId: cliMessageId(target.rootMessage.id),
        emoji: request.args.emoji,
        state: reaction.state,
      };
    }

    case "grep": {
      const threads = await loadThreads(context, channels);
      const scopedChannel = request.args.group
        ? resolveChannel(request.args.group, channels).cli
        : null;
      const scopedThread = request.args.thread
        ? resolveThread(request.args.thread, threads)
        : null;
      const selected = threads.filter((thread) =>
        (!scopedChannel || thread.group.id === scopedChannel.id) &&
        (!scopedThread || thread.thread.id === scopedThread.thread.id),
      );
      // Substring grep asks FTS for candidate thread/message ids before any
      // bodies are loaded. A candidate thread is then loaded in full so
      // context lines remain exact; regex and FTS fallbacks retain the
      // deadline-bounded full scan.
      const fts = request.args.regex
        ? null
        : await queryFtsCandidates(
            context,
            request.args.pattern,
            options.onDebug,
          );
      const scanThreads = !request.args.regex && fts
        ? selected.filter((thread) => fts.threadIds.has(thread.thread.id))
        : selected;
      const messagesByThread = await loadMessagesByThread(context, scanThreads);
      let matchesText: (text: string) => boolean;
      if (request.args.regex) {
        const searchableTexts = [...new Set(scanThreads.flatMap((thread) => [
          thread.thread.title,
          ...(messagesByThread.get(thread.thread.id) ?? []).map((message) => message.body),
        ]))];
        const regexMatches = await regexMatchesForTexts(
          {
            pattern: request.args.pattern,
            ignoreCase: request.args.ignoreCase,
            texts: searchableTexts,
          },
          options.regexScanTimeoutMs ?? REGEX_SCAN_TIMEOUT_MS,
        );
        const matchedByText = new Map(
          searchableTexts.map((text, index) => [text, regexMatches[index] ?? false]),
        );
        matchesText = (text) => matchedByText.get(text) ?? false;
      } else {
        matchesText = substringTextMatcher(request.args);
      }
      const threshold = sinceThreshold(request.args.since, nowMs());
      const matches: CliGrepMatch[] = [];
      for (const thread of scanThreads) {
        const messages = messagesByThread.get(thread.thread.id) ?? [];
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index]!;
          const bodyCandidate = !fts || fts.messageIds.has(message.id);
          const titleCandidate = index === 0 &&
            (!fts || fts.threadIds.has(thread.thread.id));
          const bodyInScope =
            (threshold === null || message.createdAtMs >= threshold) &&
            messageMatchesFrom(message, request.args.from);
          const bodyMatches = bodyInScope && bodyCandidate && matchesText(message.body);
          const titleMatches = titleCandidate && matchesText(thread.thread.title);
          if (!bodyMatches && !titleMatches) continue;
          const start = Math.max(0, index - request.args.context);
          const end = Math.min(messages.length, index + request.args.context + 1);
          matches.push({
            group: thread.group,
            threadId: cliThreadId(thread.thread.id),
            messageId: cliMessageId(message.id),
            author: authorForCli(message),
            createdAtMs: message.createdAtMs,
            text: normalizeMatchedText(bodyMatches ? message.body : thread.thread.title),
            contextBefore: messages.slice(start, index).map(grepContextMessage),
            contextAfter: messages.slice(index + 1, end).map(grepContextMessage),
          });
        }
      }
      matches.sort((left, right) =>
        right.createdAtMs - left.createdAtMs || left.messageId.localeCompare(right.messageId),
      );
      if (request.args.filesWithMatches) {
        return {
          threadIds: [...new Set(matches.map((match) => match.threadId))]
            .slice(0, request.args.limit),
        };
      }
      return { matches: matches.slice(0, request.args.limit) };
    }

    case "export": {
      const threads = await loadThreads(context, channels);
      let selected: LoadedThread[];
      if (request.args.scope.kind === "thread") {
        selected = [resolveThread(request.args.scope.thread, threads)];
      } else if (request.args.scope.kind === "group") {
        const channel = resolveChannel(request.args.scope.group, channels);
        selected = threads.filter((thread) => thread.group.id === channel.cli.id);
      } else {
        selected = threads;
      }
      if (context.readOnly) {
        throw new CliCommandError("cannot export from a read-only shared view");
      }
      const outputRoot = resolve(request.args.cwd, request.args.outDir);
      await mkdir(outputRoot, { recursive: true });
      const files: CliResultByVerb["export"]["files"] = [];
      const exportedAt = new Date(nowMs()).toISOString();
      for (const thread of selected) {
        const messages = await context.store.listMessages({
          workspaceId: context.workspaceId,
          threadId: thread.thread.id,
        });
        const result = await buildShowResult(context, thread, messages);
        const channelDir = join(outputRoot, safePathSegment(thread.group.slug));
        await mkdir(channelDir, { recursive: true });
        const publicThreadId = cliThreadId(thread.thread.id);
        const path = join(channelDir, `${safePathSegment(publicThreadId)}.md`);
        const provenance = `<!-- exported from dohc chat thread ${publicThreadId} at ${exportedAt} -->`;
        await writeFile(path, `${provenance}\n${renderShowMarkdown(result)}`, "utf8");
        files.push({ threadId: publicThreadId, path });
      }
      return { files };
    }
  }
}

async function workspaceContextForRequest(
  request: CliRequest,
  options: CliServerOptions,
): Promise<CliWorkspaceContext> {
  const workspace = await resolveCliWorkspace(request.args.cwd, options.listWorkspaces());
  if (!workspace) throw new CliCommandError("not inside a dohc workspace");
  const collectionWriteRequest =
    request.verb === "collectionSetFields" ||
    request.verb === "collectionCreateRecord";
  const documentWriteRequest =
    request.verb === "documentEdit" || request.verb === "documentCreate";
  const writeRequest =
    collectionWriteRequest ||
    documentWriteRequest ||
    request.verb === "fileChatStart" ||
    request.verb === "post" ||
    request.verb === "reply" ||
    request.verb === "react" ||
    request.verb === "export" ||
    (request.verb === "show" && !request.args.peek);
  if (workspace.readOnly && writeRequest) {
    throw new CliCommandError(
      collectionWriteRequest
        ? "collection writes are not available in a read-only shared view"
        : documentWriteRequest
          ? "document changes are not available in a read-only shared view"
          : "chats are not available in a read-only shared view",
    );
  }
  const context = await options.openWorkspace(workspace);
  if (isChatReadVerb(request.verb)) {
    await notifyRead(options, context, chatReadTarget(request));
  }
  return context;
}

export async function handleCliRequestLine(
  line: string,
  token: string,
  options: CliServerOptions,
): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    raw = null;
  }

  const auth = authEnvelopeSchema.safeParse(raw);
  if (!auth.success || !tokenMatches(token, auth.data.token)) {
    return `${JSON.stringify(
      cliTransportResponseSchema.parse({
        protocolVersion: CLI_PROTOCOL_VERSION,
        ok: false,
        error: "dohc: CLI authentication failed",
      }),
    )}\n`;
  }

  const version = versionEnvelopeSchema.safeParse(raw);
  if (!version.success || version.data.protocolVersion !== CLI_PROTOCOL_VERSION) {
    return `${JSON.stringify(
      cliTransportResponseSchema.parse({
        protocolVersion: CLI_PROTOCOL_VERSION,
        ok: false,
        error: "dohc: CLI/app version mismatch — restart the app",
      }),
    )}\n`;
  }

  const parsed = cliRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return `${JSON.stringify(
      cliTransportResponseSchema.parse({
        protocolVersion: CLI_PROTOCOL_VERSION,
        ok: false,
        error: "dohc: invalid CLI request",
      }),
    )}\n`;
  }

  try {
    const context = await workspaceContextForRequest(parsed.data, options);
    const unvalidated = await dispatch(parsed.data, context, options);
    const result = parseCliResult(parsed.data.verb, unvalidated);
    const response = cliTransportResponseSchema.parse({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result,
    });
    return `${JSON.stringify(response)}\n`;
  } catch (error) {
    const response = cliTransportResponseSchema.parse({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: cliErrorLine(error),
    });
    return `${JSON.stringify(response)}\n`;
  }
}

function attachSocketHandler(
  socket: Socket,
  token: string,
  options: CliServerOptions,
  sockets: Set<Socket>,
  inFlight: Set<Promise<void>>,
): void {
  sockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  let handled = false;
  const deadline = setTimeout(() => socket.destroy(), CLI_REQUEST_DEADLINE_MS);

  const failOversized = () => {
    handled = true;
    const response = cliTransportResponseSchema.parse({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: invalid CLI request",
    });
    socket.end(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
      failOversized();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    clearTimeout(deadline);
    const line = buffer.slice(0, newline);
    socket.pause();
    const task = handleCliRequestLine(line, token, options)
      .then((response) => {
        socket.end(response);
      })
      .catch((error) => {
        options.onError?.(error);
        socket.destroy();
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    clearTimeout(deadline);
    sockets.delete(socket);
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

export async function startCliServer(
  options: CliServerOptions,
): Promise<CliServerHandle> {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";

  // Windows ignores this mode; directory access depends on the inherited stateDir ACL.
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  // Windows chmod does not set a DACL; directory access still depends on its inherited ACL.
  await chmod(options.stateDir, 0o700);
  // main added the provenance-restore step; this branch made the endpoint
  // platform-aware. Both are needed, restore first as main had it.
  await restoreCliServerRuntime(options);
  const endpointPath = join(options.stateDir, CLI_ENDPOINT_FILE);
  const socketPath = isWindows
    ? `\\\\.\\pipe\\dohc-cli-${randomBytes(16).toString("hex")}`
    : join(options.stateDir, CLI_SOCKET_FILE);
  const tokenPath = join(options.stateDir, CLI_TOKEN_FILE);
  const endpointArtifactPath = isWindows ? endpointPath : socketPath;
  await Promise.all([
    rm(endpointArtifactPath, { force: true }),
    rm(tokenPath, { force: true }),
  ]);
  const token = randomBytes(32).toString("hex");
  // Windows ignores this mode; token secrecy depends on the inherited stateDir ACL.
  await writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  // Windows chmod does not set a DACL; token secrecy still depends on the inherited ACL.
  await chmod(tokenPath, 0o600);

  const sockets = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  const server = createServer((socket) =>
    attachSocketHandler(socket, token, options, sockets, inFlight));
  server.maxConnections = MAX_SOCKET_CONNECTIONS;
  try {
    await listen(server, socketPath);
    if (isWindows) {
      // Windows ignores this mode; pipe-name secrecy depends on the inherited stateDir ACL.
      await writeFile(endpointPath, `${socketPath}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      // Windows chmod does not set a DACL; pipe-name secrecy still depends on that ACL.
      await chmod(endpointPath, 0o600);
    } else {
      await chmod(socketPath, 0o600);
    }
  } catch (error) {
    if (server.listening) {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
    await Promise.all([
      rm(endpointArtifactPath, { force: true }),
      rm(tokenPath, { force: true }),
    ]);
    disposeCliServerRuntime(options);
    throw error;
  }
  server.unref();
  server.on("error", (error) => options.onError?.(error));

  let closed = false;
  return {
    socketPath,
    tokenPath,
    async close() {
      if (closed) return;
      closed = true;
      const serverClosed = closeServer(server);
      for (const socket of sockets) socket.destroy();
      await Promise.all([serverClosed, Promise.allSettled([...inFlight])]);
      await Promise.all([
        rm(endpointArtifactPath, { force: true }),
        rm(tokenPath, { force: true }),
      ]);
      disposeCliServerRuntime(options);
    },
  };
}
