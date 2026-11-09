import { ChatMessageWaiters } from "./chatMessageWaiters";
import { signalChatWrite, subscribeChatWrites } from "../workspaces/chatWriteSignals";
import { ChatLinksInput, ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { ChatFileMentionsInput, ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import type { LinksEdgesInput, LinksEdgesResult, LinksInInput, LinksInResult, LinksResolveInput, LinksResolveResult } from "@dohc/workspace-contracts/links";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import { creationPartialMessage } from "@dohc/cli/creation";
import { atomicReplaceFileSync } from "../atomicReplaceFile";
import { cliUsageInvocation, type CliUsageInvocation } from "../usage/cliUsage";
import { nameSlug } from "@dohc/workspace-contracts/names";
import { SHARED_AUTOMATION_HISTORY_REASON } from "@dohc/workspace-contracts/automation-controls";
import type { WorkspacePolicyPath } from "@dohc/security-contract/effective-policy";
import { readThreadDispatchState } from "../agents/threadDispatchState";
import {
  CLI_PROTOCOL_VERSION,
  CHAT_WATCH_TIMEOUT_MS,
  MAX_CLI_REQUEST_BYTES,
  type CliFileWrite,
  cliRequestSchema,
  cliTransportResponseSchema,
  parseCliResult,
  type CliActor,
  type CliAuthor,
  type CliGroup,
  type CliCollectionQueryCursor,
  type CliGrepContextMessage,
  type CliGrepMatch,
  type CliReportedAgent,
  type CliRequest,
  type CliResultByVerb,
  type CliShowMessage,
  type CliShowThreadResult,
  type CliStreamPosition,
  type VersionResolution,
} from "@dohc/cli/protocol";
import { versionNameRefusal } from "../ipc/errorWords";
import { formatMessageHandle, renderThreadMarkdown } from "@dohc/cli/thread-markdown";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
import { PRESS_WAITING } from "@dohc/automation-executor/press-waiting";
import type {
  CollectionAutomationRun,
  CollectionAutomationRunDetail,
  PressWaitReason,
} from "@dohc/automation-executor/collection-automations";
import type { NamedPress, NamedPressResult } from "../ipc/automationButtonsIpc";
import {
  createLocalChangeAuthor,
  isSharedWithMePath,
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
  CollectionSummary,
} from "@dohc/workspace-contracts/collection";
import { UNNAMED_AGENT_ID, type ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type {
  ChannelThreadSummary,
  ChatAgentReader,
  ChatChannel,
  ChatChannelSummary,
  ChatChannelType,
  ChatMessage,
  ChatStreamItem,
  ChatThread,
  LinkedChatStore,
  VersionedTextMoment,
  VersionedTextMomentSummary,
} from "@dohc/workspace-contracts/engine";
import {
  DaemonRefusalError,
  type AutomationPressActor,
  decodeCollectionValue,
  encodeCollectionValue,
  MAX_GRANULAR_CHAT_QUERY_CHARS,
  type ChatUnreadFileThread,
  type GranularChatMessageSearchResponse,
  type GranularChatMessageSearchResult,
  type KeptCopySaveResult,
  type RetainedCopiesDeleteResult,
  type RetainedCopiesListResult,
} from "@dohc/workspace-engine-client";
import type { AwaitableAgentDispatchStore } from "../agents/awaitableAgentDispatchStore";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { DatasetSchemaChangeError } from "../workspaces/datasetSchemaChanges";
import { isInside } from "../security/pathContainment";
import { deepestRoot, pathUnderRoot } from "../workspaces/workspaceRootIdentity";
import type { ChatWrites, PersonWriter } from "../workspaces/chatWrites";
import { normalizeChatMessageBody } from "@dohc/workspace-contracts/chat-message-body";
import type { AutomationRunRetry } from "../automations/automationNotices";
import type { LocalDatasetAgent } from "../workspaces/localDatasetHost";
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

const MAX_REQUEST_BYTES = MAX_CLI_REQUEST_BYTES;
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
// `packages/automation-executor/src/collectionRecordEdits.ts` exactly, so main's
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
    recordId?: string;
    fields?: Record<string, unknown>;
    author: ChangeAuthor;
  }): Promise<{ path: string; recordId: string; kept?: Record<string, unknown> } | import("@dohc/cli/creation").CreationPartial>;
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
    allowLossySourceSha256?: string;
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

type CliVersionPage<Verb extends "versionList" | "versionCompare" | "versionConflicts"> = Omit<Extract<CliResultByVerb[Verb], { ok: true }>, "ok">;

// The versions menu's reads, for the owning workspace. Compare and conflict
// pages leave out secret-backed files and paths the workspace's rules don't
// track, as History does.
export interface CliVersionsPort {
  list(): Promise<CliVersionPage<"versionList">>;
  compare(versionId: string, afterPath?: string): Promise<Omit<CliVersionPage<"versionCompare">, "version"> | HistoryPolicyRefusal>;
  conflicts(afterConflictId?: string): Promise<CliVersionPage<"versionConflicts"> | HistoryPolicyRefusal>;
  // The versions menu's changes. Each first has the windows showing the
  // workspace save their open edits, and throws their reason when one can't.
  create(name: string): Promise<{ id: string; name: string }>;
  switch(versionId: string): Promise<{ changedFileCount: number }>;
  merge(versionId: string): Promise<{ mergedFileCount: number; unchangedFileCount: number; conflictCount: number }>;
  resolve(conflictId: string, resolution: VersionResolution): Promise<void>;
}

// Files dohc moved aside while it saved, because another program changed
// them meanwhile, and the step that moves one to a visible copy beside its
// file. The desktop's Notices row offers the same step.
export interface CliKeptCopiesPort {
  list(): Promise<{ keptCopies: Array<{ id: number; path: string; keptAtMs: number }>; more: boolean; outsideWriteCopies?: [string, string, string][] }>;
  save(id: number): Promise<KeptCopySaveResult>;
}

// Live documents whose edits the server refused, which dohc keeps on this
// computer or on the server, and the steps the desktop's Notices row offers
// for them: Save recovery copy, Try again, and a Stop run again for a Stop
// that kept them. Paths are workspace-relative.
export interface CliKeptEditsPort {
  list(): Promise<Extract<CliResultByVerb["liveKeptEdits"], { ok: true }>["keptEdits"]>;
  /** With an incident, saves exactly the kept edits it names. */
  saveRecoveryCopy(path: string, incident?: string): Promise<Omit<Extract<CliResultByVerb["saveRecoveryCopy"], { ok: true }>, "ok" | "folder">>;
  retry(path: string, incident: string): Promise<void>;
  stopAgain(path: string, incident: string): Promise<Pick<Extract<CliResultByVerb["stopAgain"], { ok: true }>, "keptEdits">>;
}

// Old file copies kept on a drive that cannot tell dohc whether a program
// still has one open, and the step that deletes listed ones. The desktop's
// Notices row offers the same step after the same warning.
export interface CliRetainedCopiesPort {
  list(): Promise<RetainedCopiesListResult>;
  delete(copies: readonly { id: number; revision: number }[]): Promise<RetainedCopiesDeleteResult>;
}

// The Automations panel's run history and Try again, for the automation
// verbs. Main answers with the same executor calls the panel's IPC makes,
// so a run is listed, read, and tried again under the same rules.
export interface CliAutomationsPort {
  list?(collectionPath: string): Promise<import("@dohc/workspace-contracts/automation-controls").AutomationDefinitionList>;
  switch?(collectionPath: string, input: import("@dohc/workspace-contracts/automation-controls").AutomationSwitchInput): Promise<import("@dohc/workspace-contracts/automation-controls").AutomationSwitchResult>;
  /** The engine id of an automation in the Collection at a path, or null when no Collection is there. */
  automationIdAt(collectionPath: string, id: string): Promise<string | null>;
  /** One page of runs, newest first, after `before`, and the `before` of the next page or null. */
  runs(automationId: string, before?: string): Promise<{ runs: CollectionAutomationRun[]; next: string | null }>;
  run(automationId: string, claimId: string): Promise<CollectionAutomationRunDetail | null>;
  /** The same reads of the workspace's self-hosted server's runs. Null when this computer cannot ask it as the owner. */
  serverRuns(automationId: string, before?: string): Promise<{ runs: CollectionAutomationRun[]; next: string | null } | null>;
  serverRun(automationId: string, claimId: string): Promise<CollectionAutomationRun | null>;
  retry(input: { automationId: string; claimId: string; startOver: boolean }): Promise<AutomationRunRetry>;
}

// Button presses for the press verb, through the same press path a window's
// press takes. `waiting` is why the run the press started waits, if it does.
export interface CliButtonsPort {
  inspect(input: Pick<NamedPress, "collectionPath" | "table">, by: AutomationPressActor): Promise<import("@dohc/automation-executor/collection-automations").CollectionAutomationButton[]>;
  press(
    input: Omit<NamedPress, "workspaceId">,
    by: AutomationPressActor,
  ): Promise<{ result: NamedPressResult; waiting: PressWaitReason | null }>;
}

// dohc can't read the workspace's History rules, so every History answer is
// this one, naming the files and nothing about any change.
export type HistoryPolicyRefusal = { status: "policy-unreadable"; unreadable: WorkspacePolicyPath[] };
export type HistoryReadRefusal = { status: "untracked" } | HistoryPolicyRefusal;

function historyPolicyUnreadable(refusal: HistoryPolicyRefusal, hidden = "History is hidden") {
  return {
    ok: false as const,
    status: "policy-unreadable" as const,
    unreadable: refusal.unreadable,
    reason: `${hidden} because dohc can't read ${refusal.unreadable.join(" and ")}`,
  };
}

// An agent you run, as this computer's settings and the workspace's registry
// entry describe it: its name and handle, the accounts its person posts as,
// and whether a post with no account is theirs.
export interface CliConnectedAgent {
  agentId: string;
  name: string;
  handle: string;
  requesters: string[];
  unattributedCounts: boolean;
}

// A run dohc dispatched: its agent, and its engine id (null for a self-test).
export interface CliRunCaller { agentId: string; runId: string | null }

export interface CliWorkspaceContext extends CliRegistryWorkspace {
  signal?: AbortSignal;
  // The agent you run that the request named, checked against this
  // computer's settings. Absent for every other caller.
  connected?: CliConnectedAgent;
  // The run dohc dispatched that this request proved it is, with the run's
  // secret. The socket sets it per request; without it, the request is no run's.
  run?: CliRunCaller;
  stopSync?(author?: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPauseAuthor): Promise<CliResultByVerb["stopSync"]>;
  shareCopy?(input: import("@dohc/workspace-contracts/share-copy").ShareCopyInput): Promise<import("@dohc/workspace-contracts/share-copy").ShareCopyResult>;
  shareLinkAgents?: {
    list(input: import("@dohc/workspace-contracts/share-link-agents").ShareLinkAgentsInput): Promise<import("@dohc/workspace-contracts/share-link-agents").ListRelayShareLinkAgentsResult>;
    disconnect(input: import("@dohc/workspace-contracts/share-link-agents").ShareLinkAgentDisconnectInput): Promise<import("@dohc/workspace-contracts/share-link-agents").DisconnectRelayShareLinkAgentResult>;
  };
  access?: {
    refresh(): Promise<import("@dohc/workspace-contracts/access").AccessRefreshResult>;
    object(input: import("zod").infer<typeof import("@dohc/workspace-contracts/access").ObjectAccessInput>): Promise<import("@dohc/workspace-contracts/access").AccessAnswer>;
    sharing(input: import("zod").infer<typeof import("@dohc/workspace-contracts/access").SharingAccessInput>): Promise<import("@dohc/workspace-contracts/access").AccessAnswer>;
  };
  // `agent` is the agent this socket's write is, or null for the person.
  dataset?(request: import("@dohc/cli/dataset").DatasetRequest, agent: LocalDatasetAgent | null): Promise<import("@dohc/cli/dataset").DatasetResult>;
  ownerAppResponses?(request:import("@dohc/cli/app-responses").OwnerAppResponsesRequest):Promise<import("@dohc/cli/app-responses").OwnerAppResponsesResult>;
  appPublication?(request: OwnerAppPublicationRequest, agent?: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null): Promise<OwnerAppPublicationResult>;
  store: LinkedChatStore;
  dispatchStore: AwaitableAgentDispatchStore;
  readOnly: boolean;
  // New group, as the window's: the group and its folder.
  createGroup?(input: { name: string; purpose?: string; type?: ChatChannelType }): Promise<ChatChannel>;
  fileObjectIdForPath(path: string): Promise<string | null>;
  filePathForObjectId(objectId: string): Promise<string | null>;
  listMoments(input: { limit: number; objectId?: string }): Promise<VersionedTextMomentSummary[] | HistoryPolicyRefusal>;
  // A refusal says why History hides a change, never its path or contents:
  // its rules no longer track a file it touched, or dohc can't read them.
  readMoment(momentId: string): Promise<VersionedTextMoment | HistoryReadRefusal | null>;
  daemonReads: {
    queryChatMessagesGranular(input: {
      query: string;
      limit: number;
    }): Promise<CliGranularChatMessageSearchResponse>;
    listUnreadFileThreads(input: {
      pageLimit: number;
      afterThreadId?: string;
    }): Promise<CliUnreadFileThread[]>;
    // Collection updates wait for an unfinished pull, as the engine answers.
    collectionsWaiting(): Promise<boolean>;
  };
  // Absent when the workspace has no engine-backed collection access.
  collections?: CliCollectionsPort;
  documents?: CliDocumentsPort;
  writeFiles?(files: CliFileWrite[], origin: LiveDocumentEditOrigin, requestId: string): Promise<CliResultByVerb["fileWrite"]>;
  historyOperation?(input: { operationId: string; cursor?: string }): Promise<CliResultByVerb["historyOperation"]>;
  historyUndo?(input: { operationId: string }, origin: LiveDocumentEditOrigin): Promise<CliResultByVerb["historyUndo"]>;
  duplicateFile?(path: string, origin: LiveDocumentEditOrigin, requestId: string): Promise<CliResultByVerb["fileDuplicate"]>;
  movePath?(input: { fromPath: string; toPath: string; overwrite?: boolean }, origin: LiveDocumentEditOrigin, requestId: string): Promise<CliResultByVerb["fileMove"]>;
  deletePath?(path: string, origin: LiveDocumentEditOrigin, requestId: string): Promise<CliResultByVerb["fileDelete"]>;
  // Absent in a shared view, which keeps no copies or versions of its own.
  versions?: CliVersionsPort;
  keptCopies?: CliKeptCopiesPort;
  retainedCopies?: CliRetainedCopiesPort;
  keptEdits?: CliKeptEditsPort;
  automations?: CliAutomationsPort;
  buttons?: CliButtonsPort;
}

export interface CliRunMessageLink {
  workspaceId: string;
  runId: string;
  messageId: string;
}

export interface CliServerOptions {
  recordSuccess?(invocation: CliUsageInvocation): unknown;
  // The server account this computer is connected to. Its verbs need no
  // workspace.
  serverAccount?: Pick<import("../workspaces/serverAccountDeletion").ServerAccountDeletion, "preview" | "delete">;
  stateDir: string;
  listWorkspaces(): readonly CliRegistryWorkspace[];
  openWorkspace(workspace: CliRegistryWorkspace): Promise<CliWorkspaceContext>;
  chatLinks?(workspace:CliRegistryWorkspace,input:ChatLinksInput):Promise<ChatLinksPage>;
  chatFileMentions?(workspace: CliRegistryWorkspace, input: ChatFileMentionsInput): Promise<ChatFileMentionsPage>;
  links?: {
    edges(workspace: CliRegistryWorkspace, input: LinksEdgesInput): Promise<LinksEdgesResult>;
    incoming(workspace: CliRegistryWorkspace, input: LinksInInput): Promise<LinksInResult>;
    resolve(workspace: CliRegistryWorkspace, input: LinksResolveInput): Promise<LinksResolveResult>;
  };
  // Messages, reactions, and decisions go through the same module renderer
  // chat uses, so a CLI or MCP write gets the same checks and effects.
  chatWrites: ChatWrites;
  localUserDisplayName(): string;
  // The person this computer's agents work for: the account, or this
  // installation's id when signed out.
  localPersonId(): string;
  // The chain depth of the agent run in progress in the workspace, or 0. Every
  // write during a run an automation started is the agent's at this depth, so
  // an automation that woke the agent and the agent cannot start each other
  // forever.
  agentRunDepth(workspaceId: string): number;
  // The agent of a run dohc dispatched while it holds the workspace's run
  // slot, or null.
  dispatchedAgent(workspaceId: string): string | null;
  // The engine's id for that run when dohc dispatched it as agent work, or
  // null. The engine reads the run's agent from it, so a read from the run
  // moves only that agent's place, whatever the command line says. An agent
  // you run reads as itself; any other read is that of connected agents.
  dispatchedRunId(workspaceId: string): string | null;
  // The run an agent's writes name while a run dohc dispatched, or one
  // started from Settings, holds the workspace's run slot, or null. It is
  // read with the depth, so a write names the run it was made in.
  agentWriteRunId(workspaceId: string): string | null;
  // The secret dohc gave that run's process, or null. Only a request that
  // carries it is the run's; any other caller in the workspace is not.
  dispatchedRunSecret(workspaceId: string): string | null;
  agentRunWorkspace(runId: string): string | undefined;
  // The agent you run with this id in this computer's settings, as it reads
  // and writes in the workspace, or null when no agent you run has the id.
  connectedAgent(workspaceId: string, agentId: string): Promise<CliConnectedAgent | null>;
  // An agent you run started a chat wait. The returned function runs once
  // when the wait ends, aborts or times out.
  agentWaiting?(agentId: string): (hold?: boolean) => void;
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
  const roots = (
    await Promise.all(
      workspaces.map(async (workspace) => {
        const root = await realpath(resolve(workspace.rootPath)).catch(() => null);
        return root === null ? [] : [{ entry: workspace, path: root }];
      }),
    )
  ).flat();
  // The deepest root among the cwd's folders, matched on disk when Linux
  // keeps another spelling of a folder that ignores capitals.
  return (await deepestRoot(absoluteCwd, roots))?.entry ?? null;
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

function groupForCli(channel: Pick<ChatChannelSummary, "id" | "kind" | "name" | "slug" | "purpose">): CliGroup {
  return {
    id: cliChannelId(channel.id),
    name: channel.kind === "agent" ? channel.slug : channel.name,
    slug: channel.slug,
    kind: cliGroupKind(channel.kind),
    ...(channel.purpose ? { purpose: channel.purpose } : {}),
  };
}

async function listCliChannelThreads(context: CliWorkspaceContext, channel: ChatChannelSummary) {
  // Any group can hold both lanes: an agent DM keeps its old posts beside its conversation.
  const pages = await Promise.all((["posts", "chat"] as const).map(lane => context.store.listChannelThreads({
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
  decision: ChatStreamItem["decision"],
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
    ...agentRequestsFor(message),
    ...reportedFor(message),
  };
}

// What an agent's client reported about itself, so an agent reading the
// chat sees what a person sees beside the name.
function reportedFor(message: ChatMessage) {
  return message.authorReported ? { authorReported: { ...message.authorReported } } : {};
}

// The agents still asked to answer a message, as the engine reports them.
function agentRequestsFor(message: ChatMessage) {
  return message.agentRequests?.length
    ? { agentRequests: message.agentRequests.map((request) => ({ ...request })) }
    : {};
}

// A history row carries only facts the path admission checked. The moment's
// free-form summary is not sent: a rename's reads "Renamed <before> to <after>",
// and its before path may be one current policy no longer admits.
function rawMomentSummary(
  moment: Pick<
    VersionedTextMomentSummary,
    "id" | "recordedAtMs" | "operation" | "path" | "versionId" | "metadata" | "authors"
  >,
  includeFiles: boolean,
) {
  return {
    id: moment.id,
    ...(HistoryOperationId.safeParse(moment.metadata.correlationId).success ? { operationId: moment.metadata.correlationId } : {}),
    recordedAtMs: moment.recordedAtMs,
    source: "workspace-engine" as const,
    operation: moment.operation,
    path: moment.path,
    versionId: moment.versionId,
    ...(moment.authors ? { authors: moment.authors } : {}),
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

// A failure whose reason never names a host path. Node's own messages name
// absolute paths, so a system error becomes `failed` and its code; dohc's own
// refusals, which name paths as the caller spelled them, pass through.
function pathFreeFailure(error: unknown, failed: string) {
  const system = error instanceof Error && "syscall" in error && "code" in error;
  const reason = system ? `${failed} (${String(error.code)}). Check the path, then try again.`
    : error instanceof Error && !/(?:[A-Za-z]:[\\/]|\\\\|(?<![\p{L}\p{N}_./\\-])\/)/u.test(error.message) ? error.message : failed;
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
// A Collection as the CLI names it: by its path. Its object id stays in dohc.
function cliCollection({ objectId: _objectId, ...collection }: CollectionSummary) {
  return collection;
}

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

// Who a write through this socket is. A request from the run dohc started that
// holds the run slot is that run's agent, whatever actor the caller named. So
// is every write while a run an automation started holds the slot, as disk
// edits during the run are: an agent that names itself a person would
// otherwise write at depth 0 and start the chain over.
function writeActor(
  actor: CliActor,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): CliActor {
  return context.run !== undefined || options.agentRunDepth(context.workspaceId) > 0 ? "agent" : actor;
}

// The agent an edit through this socket is recorded as. An agent you run is
// its id, even while a run holds the workspace. A run dohc dispatched is its
// agent, by id, so the run's file edits and replies are one actor. Any other
// agent is the unnamed agent: a name it gives itself is only a claim, and
// History names an agent id by your Settings when it shows the edit.
function editingAgentId(context: CliWorkspaceContext): string {
  return context.connected?.agentId ?? context.run?.agentId ?? UNNAMED_AGENT_ID;
}

// The name an edit by the unnamed agent carries, a label History shows and
// nothing reads as an id. An agent you run and a run's agent go by their
// Settings names.
function connectedAgentName(
  context: CliWorkspaceContext,
  agentName: string | undefined,
): { agentName?: string } {
  return agentName !== undefined && context.connected === undefined && context.run === undefined ? { agentName } : {};
}

// The run an agent's write names. An agent you run is never part of a run,
// even while one holds the workspace; its write still keeps the run's depth.
function agentWriteRun(context: CliWorkspaceContext, options: CliServerOptions): { agentRunId?: string } {
  const agentRunId = context.connected ? null : options.agentWriteRunId(context.workspaceId);
  return agentRunId === null ? {} : { agentRunId };
}

// Who a chat write through this socket is. An agent you run writes as itself.
// Any other agent's message during a run dohc dispatched is that run's
// agent's. What an agent reported about itself rides beside its name; a
// person's write carries none.
function cliChatWriter(
  actor: CliActor,
  context: CliWorkspaceContext,
  agentName?: string,
  reported?: CliReportedAgent,
): PersonWriter {
  const agentId = actor === "agent" ? context.connected?.agentId ?? context.run?.agentId ?? null : null;
  return {
    via: "cli",
    actor,
    ...(agentId ? { agentId } : agentName ? { agentName } : {}),
    ...(actor === "agent" && reported ? { reported } : {}),
  };
}

// Provenance for a CLI/MCP collection write, derived main-side only. Agent
// traffic is the agent you run, the run's agent, or the unnamed agent outside
// a run, acting on behalf of the local owner, at the depth of the agent run in
// progress and naming that run unless it is an agent you run; a human write is
// attributed as this device's local author under the workspace display name.
function collectionWriteAuthor(
  actor: CliActor,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): ChangeAuthor {
  if (writeActor(actor, context, options) === "agent") {
    return {
      kind: "agent",
      agentId: editingAgentId(context),
      onBehalfOf: options.localPersonId(),
      depth: options.agentRunDepth(context.workspaceId),
      ...agentWriteRun(context, options),
    };
  }
  return createLocalChangeAuthor(options.localUserDisplayName());
}

// The agent a dataset invocation through this socket is, as writeActor
// decides, at the depth of the run in progress, or 0 outside a chain. An
// agent you run also gives its id; a run's id stays out. Null for the person.
function datasetAgent(
  actor: CliActor,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): LocalDatasetAgent | null {
  if (writeActor(actor, context, options) !== "agent") return null;
  const depth = options.agentRunDepth(context.workspaceId);
  return context.connected ? { depth, agentId: context.connected.agentId } : { depth };
}

// A person edits documents and records in the app. Through this socket, an
// edit or a creation is an agent's, refused in the same words for both.
const EDIT_AS_AGENT_REFUSAL = "a document edit through the CLI socket is recorded as an agent's; send actor \"agent\"";
const CREATE_AS_AGENT_REFUSAL = "a document created through the CLI socket is recorded as an agent's; send actor \"agent\"";

// Provenance for a document edit, derived here. A person types in the
// editor, so every edit through this socket is an agent's on behalf of the
// local owner, recorded as the agent you run, the run's agent, or the unnamed
// agent with the name it gave, at the depth of the agent run in progress and
// naming that run unless it is an agent you run. Any process holding the
// socket token could otherwise claim the person's typing.
function documentEditOrigin(
  context: CliWorkspaceContext,
  options: CliServerOptions,
  agentName: string | undefined,
): LiveDocumentEditOrigin {
  return {
    actorOriginId: editingAgentId(context),
    ...connectedAgentName(context, agentName),
    attribution: {
      actorKind: "agent",
      onBehalfOf: options.localPersonId(),
      depth: options.agentRunDepth(context.workspaceId),
      ...agentWriteRun(context, options),
    },
  };
}

function keptCopiesUnavailable() {
  return {
    ok: false as const,
    reason: "kept copies are not available in this workspace",
  };
}

function retainedCopiesUnavailable() {
  return {
    ok: false as const,
    reason: "Old file copies are kept only in the owning workspace. Open it to continue.",
  };
}

function keptEditsUnavailable() {
  return {
    ok: false as const,
    reason: "Kept edits are kept only in the original workspace. Open it to continue.",
  };
}

const SHARED_VIEW_AUTOMATIONS = SHARED_AUTOMATION_HISTORY_REASON;
const SERVER_RUNS_UNREADABLE = "Your server has no runs in this workspace that this computer can read.";

// Try again as the panel answers it, in words for an agent: a run that
// would start over needs startOver, as the panel's confirmation asks.
function automationRetryResult(result: AutomationRunRetry): CliResultByVerb["automationRetry"] {
  switch (result.status) {
    case "queued":
      return { ok: true, status: "queued" };
    case "switched-off":
      return { ok: false, status: result.status, target: result.target,
        reason: "This automation is switched off. Open its controls to turn it on, then try again." };
    case "definition-changed":
      return {
        ok: false,
        status: result.status,
        repeatsMessages: result.repeatsMessages,
        reason: [
          "This automation changed since the run failed.",
          "Running it again starts from the first step and can repeat changes it already made.",
          ...(result.repeatsMessages ? ["Posts, direct messages, and notices it already sent may be sent again."] : []),
          "To do that, try again with --start-over, or startOver: true.",
        ].join(" "),
      };
    case "refused":
      return { ok: false, reason: result.reason, ...(result.notice ? { notice: result.notice } : {}) };
  }
}

function automationRunFields(run: Omit<CollectionAutomationRun, "writes">) {
  return {
    run: run.claimId,
    state: run.state,
    error: run.error,
    createdAtMs: run.createdAtMs,
    updatedAtMs: run.updatedAtMs,
    trigger: run.trigger,
    definitionChanged: run.definitionChanged,
    neverStarted: run.neverStarted,
    chainStopped: run.chainStopped,
    undone: run.undone,
    ...(run.unsentChangesLost ? { unsentChangesLost: true as const } : {}),
  };
}

// Who presses for the person: the agent a collection write through this
// socket would be, at its run's depth, or the person. A press counts in the
// chain as that agent's own record write does, and stops at the cap.
function pressActor(actor: CliActor, context: CliWorkspaceContext, options: CliServerOptions): AutomationPressActor {
  const author = collectionWriteAuthor(actor, context, options);
  return author.kind === "agent" ? { kind: "agent", originId: author.agentId, depth: author.depth } : { kind: "human" };
}

function automationPressResult(pressed: { result: NamedPressResult; waiting: PressWaitReason | null }): CliResultByVerb["automationPress"] {
  const { result, waiting } = pressed;
  if ("confirm" in result) {
    const names = result.confirm.map((action) => `"${action.label}" (--confirm ${action.name})`).join(", ");
    return {
      ok: false,
      reason: `This press runs actions dohc cannot undo: ${names}. Confirm each by name to run them.`,
      confirm: result.confirm,
    };
  }
  if (result.busy) return { ok: false, reason: result.reason };
  if ("relayed" in result) return { ok: true, relayed: true };
  return {
    ok: true,
    run: result.claimId,
    outcome: result.settled?.outcome ?? null,
    error: result.settled?.error ?? null,
    waiting: waiting === null ? null : PRESS_WAITING[waiting],
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

// Where a run's reply goes when the agent names no message: under the
// message the asking one replied to, so a question asked in a thread of a
// conversation is answered in that thread. A post's comments stay top-level.
async function askingThreadParent(
  context: CliWorkspaceContext,
  threadId: string,
  messages: readonly ChatMessage[],
  runId: string | null | undefined,
  onError: CliServerOptions["onError"],
): Promise<ChatMessage | undefined> {
  if (!runId) return undefined;
  try {
    const run = await context.dispatchStore.getRunRecord(runId);
    if (!run || run.workspaceId !== context.workspaceId || run.threadId !== threadId) return undefined;
    const parentId = messages.find((message) => message.id === run.triggerMessageId)?.parentMessageId;
    const parent = parentId ? messages.find((message) => message.id === parentId) : undefined;
    if (!parent) return undefined;
    const { thread } = await context.store.getThread({ workspaceId: context.workspaceId, threadId });
    return thread.lane === "chat" ? parent : undefined;
  } catch (error) {
    // The reply still posts, in the conversation itself.
    onError?.(new Error(`Could not find the thread for an agent reply, so it posts to the conversation. runId=${runId}`, { cause: error }));
    return undefined;
  }
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

async function buildThreadContent(
  context: CliWorkspaceContext,
  loaded: LoadedThread,
  allMessages: readonly ChatMessage[],
  rootMessage?: ChatMessage,
): Promise<Omit<CliShowThreadResult, "dispatch">> {
  const decisions = await context.store.listThreadDecisions(
    context.workspaceId,
    loaded.thread.id,
  );
  const decisionByMessage = new Map(
    decisions.map((decision) => [decision.messageId, decision]),
  );
  const counts = await threadCounts(context, loaded, allMessages);
  const selected = rootMessage
    ? branchFromMessage(allMessages, rootMessage)
    : [...allMessages];
  const messages = selected.map((message) => cliShowMessage(message, decisionByMessage.get(message.id)));
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

function cliShowMessage(message: ChatMessage, decision: ChatStreamItem["decision"]): CliShowMessage {
  return {
    id: cliMessageId(message.id),
    author: authorForCli(message),
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId
      ? { parentMessageId: cliMessageId(message.parentMessageId) }
      : {}),
    ...(decision ? {
      decisionState: decision.state,
      ...(decision.options ? { decisionOptions: [...decision.options] } : {}),
      ...(decision.chosenOption ? { decisionChosenOption: decision.chosenOption } : {}),
    } : {}),
    attachments: message.attachments.map((attachment) => ({
      ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
      ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
    })),
    ...agentRequestsFor(message),
    ...reportedFor(message),
  };
}

// One page of a group's stream, read the same way by `dohc chat show <group>`
// and dohc_read_chat. `ids` picks CLI handles or engine ids for what it names.
async function readGroupStream(
  context: CliWorkspaceContext,
  channel: ChatChannelSummary,
  page: { before?: CliStreamPosition; limit?: number },
  ids: "cli" | "engine",
) {
  const before = page.before && {
    ...page.before,
    id: page.before.lane === "posts"
      ? engineIdForHandle(page.before.id, "th_", "thread-")
      : engineIdForHandle(page.before.id, "msg_", "message-"),
  };
  const stream = await context.store.listGroupStream({
    workspaceId: context.workspaceId,
    channelId: channel.id,
    ...(before ? { before } : {}),
    ...(page.limit ? { limit: page.limit } : {}),
  });
  const threadId = (id: string) => ids === "cli" ? cliThreadId(id) : id;
  const messageId = (id: string) => ids === "cli" ? cliMessageId(id) : id;
  const position = (value: ChatStreamItem["position"]): CliStreamPosition => ({
    ...value,
    id: value.lane === "posts" ? threadId(value.id) : messageId(value.id),
  });
  return {
    items: stream.items.map((item) => ({
      position: position(item.position),
      threadId: threadId(item.message.threadId),
      message: item.message,
      decision: item.decision,
      ...(item.post ? {
        post: {
          replyCount: item.post.replyCount,
          repliers: item.post.repliers.map((replier) => ({
            author: { kind: replier.author.kind, displayName: replier.author.displayName },
            lastReplyAtMs: replier.lastReplyAtMs,
          })),
          ...(item.post.lastReplyAtMs === undefined ? {} : { lastReplyAtMs: item.post.lastReplyAtMs }),
          ...(item.post.latestAgentReply ? {
            latestAgentReply: {
              id: messageId(item.post.latestAgentReply.id),
              author: {
                kind: item.post.latestAgentReply.author.kind,
                displayName: item.post.latestAgentReply.author.displayName,
              },
              createdAtMs: item.post.latestAgentReply.createdAtMs,
              bodyExcerpt: item.post.latestAgentReply.bodyExcerpt,
            },
          } : {}),
          openDecisionCount: item.post.openDecisionCount,
        },
      } : {}),
    })),
    nextBefore: stream.nextBefore && position(stream.nextBefore),
    readPosition: stream.readPosition && position(stream.readPosition),
  };
}

function engineIdForHandle(id: string, handlePrefix: string, enginePrefix: string): string {
  return id.startsWith(handlePrefix) ? `${enginePrefix}${id.slice(handlePrefix.length)}` : id;
}

// A group named exactly, by name, #slug or id. A prefix names a thread or
// message instead.
function exactChannel(
  input: string,
  channels: readonly { engine: ChatChannelSummary; cli: CliGroup }[],
): { engine: ChatChannelSummary; cli: CliGroup } | undefined {
  const normalized = withoutChannelMarker(input);
  const matches = channels.filter(({ engine, cli }) =>
    [cli.slug, cli.name, cli.id, engine.name, engine.id].includes(normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

async function buildShowResult(
  context: CliWorkspaceContext,
  loaded: LoadedThread,
  allMessages: readonly ChatMessage[],
  rootMessage?: ChatMessage,
): Promise<CliShowThreadResult> {
  return {
    ...await buildThreadContent(context, loaded, allMessages, rootMessage),
    dispatch: await readThreadDispatchState(context.dispatchStore, context.workspaceId, loaded.thread.id),
  };
}

// Which agent reads: an agent you run as itself, then the agent of `runId`,
// a run dohc dispatched, then the unnamed agents.
function chatAgentReader(context: CliWorkspaceContext, runId: string | null): ChatAgentReader {
  const { connected } = context;
  if (connected) {
    return {
      kind: "connected",
      agentId: connected.agentId,
      handle: connected.handle,
      requesters: connected.requesters,
      unattributedCounts: connected.unattributedCounts,
    };
  }
  return runId === null ? { kind: "unnamed" } : { kind: "run", runId };
}

async function markShownThreadRead(
  context: CliWorkspaceContext,
  actor: CliActor,
  reader: ChatAgentReader,
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
      reader,
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
    const placed = await pathUnderRoot(root, await realpath(absolute));
    if (placed === null) {
      throw new CliCommandError(`${noun} is outside this workspace: ${path}`);
    }
    canonical = placed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const realParent = await pathUnderRoot(root, await realpath(dirname(absolute)).catch(() => {
      throw new CliCommandError(`${noun} is not a tracked workspace file: ${path}`);
    }));
    if (realParent === null) {
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
  signalChatWrite(context.workspaceId);
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
    verb === "chatLinks" ||
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
      return "group" in request.args ? { channelId: request.args.group } : { threadId: request.args.threadId };
    case "show":
      return { threadId: request.args.target };
    case "threads":
      return { channelId: request.args.group };
    case "chatLinks":
      return "group" in request.args ? { channelId: request.args.group } : undefined;
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
      atomicReplaceFileSync(path, (temporaryPath) => writeFileSync(temporaryPath, `${JSON.stringify(stored)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }));
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
  chatWaiters.get(options)?.close();
  chatWaiters.delete(options);
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
  reported?: CliReportedAgent;
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
  let body: string;
  try {
    body = normalizeChatMessageBody(input.body);
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
      writer: cliChatWriter("agent", context, input.agent, input.reported),
      threadId: thread.id,
      body,
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
  completion: { replayed: boolean },
): Promise<unknown> {
  const memory = workspaceRequests(options, context.workspaceId);
  // A digest, so a remembered edit does not keep its text in memory.
  const inputKey = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const remembered = memory.requests.get(requestId);
  if (remembered) {
    completion.replayed = true;
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

function refusePathColon(path: string): void {
  const segments = isAbsolute(path) ? path.replace(/^[A-Za-z]:[\\/]/, "") : path;
  if (segments.includes(":")) throw new CliCommandError(`path rejected (colon): ${path}`);
}

function validateRequestPathSpellings(request: CliRequest): void {
  const fields = ["fromPath", "toPath", "path", "recordPath", "collectionPath", "datasetPath", "descriptorPath", "migrationPath", "sourcePath", "savePath", "appRoot", "outDir", "schemaPath", "operationsPath"];
  const check = (value: object) => {
    for (const [key, path] of Object.entries(value)) {
      if (fields.includes(key) && typeof path === "string") refusePathColon(path);
      if (key === "attachments" && Array.isArray(path)) path.forEach(refusePathColon);
    }
  };
  check(request.args);
  if (request.verb === "dataset" || request.verb === "appPublication") {
    check(request.args.request);
    if (request.verb === "dataset" && request.args.request.action === "create") check(request.args.request.definition);
  }
  if (request.verb === "collectionQuery" && request.args.cursor) check(request.args.cursor);
}

type CliPathMode = "read" | "write" | "materialize";

// Validate the caller spelling before rebasing, then validate workspace authority.
async function callerPaths(context: CliWorkspaceContext, cwd: string) {
  const root = await realpath(context.rootPath);
  // The cwd under the workspace's own spelling, so every rebased path is too.
  const folder = await pathUnderRoot(root, await realpath(cwd));
  if (folder === null) throw new CliCommandError("not inside a dohc workspace");
  const known = new Map<string, string>();
  const workspacePath = (path: string) => isInside(root, resolve(root, path));
  const callerPath = (path: string) => workspacePath(path) ? relative(folder, resolve(root, path)).split(sep).join("/") || "." : path;
  const escapePattern = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const validate = (path: string, mode: CliPathMode) => mode === "write"
    ? validateUserWritePath(path)
    : mode === "materialize"
      ? validateUserMaterializePath(path, { platform: process.platform })
      : validateUserReadPath(path, { platform: process.platform });
  return {
    shared: isSharedWithMePath(relative(root, folder).split(sep).join("/")),
    rebase(path: string, mode: CliPathMode): string {
      const supplied = validate(path, mode);
      if (!supplied.ok) throw new CliCommandError(cliPathRejected(supplied.reason, path).reason);
      const rebased = relative(root, resolve(folder, supplied.normalized)).split(sep).join("/");
      const checked = validate(rebased, mode);
      if (!checked.ok) throw new CliCommandError(cliPathRejected(checked.reason, path).reason);
      known.set(checked.normalized, supplied.normalized);
      known.set(resolve(root, checked.normalized), supplied.normalized);
      return checked.normalized;
    },
    recoveryPath(path: string, mode: CliPathMode): string {
      if (isAbsolute(path)) return path;
      const absolute = resolve(root, this.rebase(path, mode));
      known.set(absolute, path);
      return absolute;
    },
    exportPath(path: string): string {
      if (!isAbsolute(path)) throw new CliCommandError(`savePath must be absolute: ${path}`);
      return path;
    },
    result(value: unknown, changeSnapshots = false): unknown {
      const paths = new Set(["fromPath", "toPath", "path", "recordPath", "collectionPath", "datasetPath", "savedPath", "appRoot", "pathHint", "linkedPathHint", "schemaPath", "operationsPath", "copyPath", "packagePath", "folder"]);
      const lists = new Set(["paths", "sourcePaths", "datasetPaths", "created", "written", "deleted", "withoutHistory"]);
      const data = new Set(["values", "fields", "kept", "input", "result", "definitions", "value", "previous", "next", "sortValues", "validation", "reasons", "default", "before", "after", "key", "recordId", "planned", "current", "undo"]);
      if (changeSnapshots) { data.delete("before"); data.delete("after"); }
      const collect = (entry: unknown, key = ""): void => {
        if (typeof entry === "string" && (paths.has(key) || lists.has(key)) && workspacePath(entry)) {
          known.set(entry, callerPath(entry));
          known.set(resolve(root, entry), callerPath(entry));
        }
        else if (Array.isArray(entry)) entry.forEach(item => collect(item, key));
        else if (entry !== null && typeof entry === "object") {
          for (const [name, item] of Object.entries(entry)) if (!data.has(name)) collect(item, name);
        }
      };
      collect(value);
      const text = (line: string) => {
        const names = [...known.keys()].filter(path => root !== folder || !isAbsolute(path)).sort((a, b) => b.length - a.length).map(path => escapePattern(path));
        const prefix = relative(root, folder).split(sep).join("/") + "/";
        // A port can mention another source file beside the requested descriptor.
        const anchors = root === folder ? [] : [prefix, root + sep, root.split(sep).join("/") + "/"];
        const pathsInText = anchors.map(path => escapePattern(path) + '[^\\s"\'<>()]+');
        const pattern = [...names, ...pathsInText].join("|");
        if (!pattern) return line;
        return line.replace(new RegExp(`(?<![\\p{L}\\p{N}_./\\\\-])(?:${pattern})(?![\\p{L}\\p{N}_.\\\\-])`, "gu"), path => known.get(path) ?? callerPath(path));
      };
      const map = (entry: unknown, key = ""): unknown => {
        if (typeof entry === "string") {
          if (paths.has(key) || lists.has(key)) return callerPath(entry);
          if (["reason", "message", "warning", "instruction", "sourceError", "error", "body"].includes(key)) return text(entry);
          return entry;
        }
        if (Array.isArray(entry)) return entry.map(item => map(item, key));
        if (entry !== null && typeof entry === "object") return Object.fromEntries(
          Object.entries(entry).map(([name, item]) => [name, data.has(name) ? item : map(item, name)]),
        );
        return entry;
      };
      return map(value);
    },
  };
}

async function dispatch(
  request: CliRequest,
  context: CliWorkspaceContext,
  options: CliServerOptions,
  completion: { replayed: boolean },
): Promise<unknown> {
  if (request.verb === "accessObject") {
    const ref = request.args.ref;
    if (ref.kind !== "path") return dispatchWorkspace(request, context, options, completion);
    const paths = await callerPaths(context, request.args.cwd);
    const rebased = { ...request, args: { ...request.args, ref: { ...ref, path: paths.rebase(ref.path, "read") } } };
    return dispatchWorkspace(rebased, context, options, completion);
  }
  const pathVerbs = new Set(["moment", "moments", "fileChats", "fileChatStart", "documentRead", "documentEdit", "documentCreate", "collectionQuery", "collectionRecord", "collectionSetFields", "collectionCreateRecord", "automationList", "automationSwitch", "automationRuns", "automationRun", "automationRetry", "automationButtons", "automationPress", "dataset", "keptCopies", "saveKeptCopy", "liveKeptEdits", "saveRecoveryCopy", "retryKeptEdits", "stopAgain", "fileWrite", "fileMove", "fileDelete", "fileDuplicate", "appPublication"]);
  if (!pathVerbs.has(request.verb)) {
    validateRequestPathSpellings(request);
    return dispatchWorkspace(request, context, options, completion);
  }
  let paths: Awaited<ReturnType<typeof callerPaths>>;
  try { paths = await callerPaths(context, request.args.cwd); } catch (error) {
    if (request.verb === "fileMove" || request.verb === "fileDelete" || request.verb === "fileDuplicate") {
      return pathFreeFailure(error, `dohc could not ${request.verb === "fileMove" ? "move" : request.verb === "fileDuplicate" ? "duplicate" : "delete"} the file.`);
    }
    throw error;
  }
  // A received share's folder resolves to its owner's workspace; the owner's kept edits stay the owner's.
  if (paths.shared && (request.verb === "liveKeptEdits" || request.verb === "saveRecoveryCopy" || request.verb === "retryKeptEdits" || request.verb === "stopAgain")) return keptEditsUnavailable();
  let rebased: CliRequest;
  try {
    validateRequestPathSpellings(request);
    switch (request.verb) {
      case "fileMove":
        rebased = { ...request, args: { ...request.args, fromPath: paths.rebase(request.args.fromPath, "materialize"), toPath: paths.rebase(request.args.toPath, "materialize") } };
        break;
      case "fileDuplicate": {
        const path = paths.rebase(request.args.path, "materialize");
        if (classifyEngineFilePathForRead(path, process.platform).kind === "secret") throw new CliCommandError("History cannot record secret files. Choose another file.");
        rebased = { ...request, args: { ...request.args, path } };
        break;
      }
      case "fileDelete":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "materialize") } };
        break;
      case "fileWrite":
        rebased = { ...request, args: { ...request.args, files: request.args.files.map(file => ({
          ...file, path: paths.rebase(file.path, "materialize"),
        })) } };
        break;
      case "appPublication": {
        const input = request.args.request;
        rebased = { ...request, args: { ...request.args, request: "appRoot" in input
          ? { ...input, appRoot: paths.rebase(input.appRoot, "read"), ...(input.action === "createLink" && input.paths ? {paths:input.paths.map(path=>paths.rebase(path,"read"))} : {}) } : input } };
        break;
      }
      case "fileChats":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "read") } };
        break;
      case "fileChatStart":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "read") } };
        break;
      case "documentRead":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "read") } };
        break;
      case "documentEdit":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "write") } };
        break;
      case "saveRecoveryCopy":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "write") } };
        break;
      case "retryKeptEdits":
      case "stopAgain":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "write") } };
        break;
      case "documentCreate":
        rebased = { ...request, args: { ...request.args, path: paths.rebase(request.args.path, "materialize") } };
        break;
      case "collectionSetFields":
        rebased = { ...request, args: { ...request.args, recordPath: paths.rebase(request.args.recordPath, "write") } };
        break;
      case "collectionQuery":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read"),
          ...(request.args.cursor ? { cursor: { ...request.args.cursor, recordPath: paths.rebase(request.args.cursor.recordPath, "read") } } : {}) } };
        break;
      case "collectionRecord":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "collectionCreateRecord":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "automationRuns":
      case "automationList":
      case "automationSwitch":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } } as typeof request;
        break;
      case "automationRun":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "automationRetry":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "automationButtons":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "automationPress":
        rebased = { ...request, args: { ...request.args, collectionPath: paths.rebase(request.args.collectionPath, "read") } };
        break;
      case "dataset": {
        const input = request.args.request;
        const translated = { ...input };
        if ("datasetPath" in translated) translated.datasetPath = paths.rebase(translated.datasetPath, "read");
        if ("descriptorPath" in translated) translated.descriptorPath = paths.rebase(translated.descriptorPath, "read");
        if ("migrationPath" in translated) translated.migrationPath = paths.rebase(translated.migrationPath, "read");
        if ("sourcePath" in translated && translated.sourcePath !== undefined) translated.sourcePath = paths.recoveryPath(translated.sourcePath, "read");
        if ("savePath" in translated && translated.savePath !== undefined) translated.savePath = paths.exportPath(translated.savePath);
        if ("appRoot" in translated) translated.appRoot = paths.rebase(translated.appRoot, "materialize");
        if (translated.action === "create") translated.definition = { ...translated.definition,
          schemaPath: paths.rebase(translated.definition.schemaPath, "read"),
          operationsPath: paths.rebase(translated.definition.operationsPath, "read") };
        rebased = { ...request, args: { ...request.args, request: translated } };
        break;
      }
      default: rebased = request;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "path rejected";
    if (request.verb === "moments" || request.verb === "appPublication") throw new CliCommandError(reason);
    if (request.verb === "fileWrite") return { ok: false, written: [], reason };
    return request.verb === "dataset" ? { kind: "refused", code: "path_rejected", message: reason } : { ok: false, reason };
  }
  try {
    return paths.result(parseCliResult(request.verb, await dispatchWorkspace(rebased, context, options, completion)), request.verb === "moment");
  } catch (error) {
    const workspacePaths = error instanceof DatasetSchemaChangeError
      ? error.workspacePaths
      : [];
    const mapped = paths.result({ error: error instanceof Error ? error.message : "request failed", paths: workspacePaths });
    if (mapped !== null && typeof mapped === "object" && "error" in mapped && typeof mapped.error === "string") throw new CliCommandError(mapped.error);
    throw error;
  }
}

async function dispatchWorkspace(
  request: CliRequest,
  context: CliWorkspaceContext,
  options: CliServerOptions,
  completion: { replayed: boolean },
): Promise<unknown> {
  if (request.verb === "reply" && request.args.choose !== undefined && request.args.resolve === undefined) {
    throw new CliCommandError("--choose needs --resolve <message>");
  }
  switch (request.verb) {
    case "stopSync":
      if (context.readOnly || !context.stopSync) throw new CliCommandError("Open the owning workspace to stop its sync.");
      return context.stopSync(writeActor(request.args.actor, context, options) === "agent"
        ? { kind: "agent", agentId: editingAgentId(context), ...connectedAgentName(context, request.args.agent), onBehalfOf: options.localPersonId(), depth: options.agentRunDepth(context.workspaceId) }
        : undefined);
    case "shareCopy":
      if (context.readOnly || !context.shareCopy) throw new CliCommandError("Share copy details require the owning workspace.");
      return context.shareCopy({ shareId: request.args.shareId, grantId: request.args.grantId });
    case "shareAgents":
      if (context.readOnly || !context.shareLinkAgents) throw new CliCommandError("Open the owning workspace to list a link's agents.");
      return context.shareLinkAgents.list({ shareId: request.args.shareId, grantId: request.args.grantId,
        ...(request.args.cursor === undefined ? {} : { cursor: request.args.cursor }) });
    case "shareDisconnect":
      if (context.readOnly || !context.shareLinkAgents) throw new CliCommandError("Open the owning workspace to disconnect a link's agent.");
      return context.shareLinkAgents.disconnect({ shareId: request.args.shareId, grantId: request.args.grantId, connectionId: request.args.connectionId });
    case "accessRefresh":
      if (!context.access) throw new CliCommandError("Access observations are unavailable.");
      return context.access.refresh();
    case "accessObject":
      if (!context.access) throw new CliCommandError("Access observations are unavailable.");
      return context.access.object(request.args);
    case "accessSharing":
      if (!context.access) throw new CliCommandError("Access observations are unavailable.");
      return context.access.sharing(request.args);
    case "appPublication": {
      if (request.args.request.workspaceId !== context.workspaceId || context.readOnly || !context.appPublication) throw new CliCommandError("App publication requires the owning workspace.");
      if (options.agentRunDepth(context.workspaceId) > 0) throw new CliCommandError("Automations cannot use app publication.");
      const agent = writeActor(request.args.actor, context, options) === "agent"
        ? {kind:"agent" as const,label:"agentLabel" in request.args.request ? request.args.request.agentLabel ?? null : null,labelSource:"agent-declared" as const} : null;
      return context.appPublication(request.args.request, agent);
    }
    case "dataset": {
      if (request.args.request.action === "export" && !request.args.request.savePath) throw new CliCommandError("Collection export requires an explicit savePath.");
      if (request.args.request.workspaceId !== context.workspaceId || context.readOnly || !context.dataset) throw new CliCommandError("Collections require the owning workspace.");
      if (request.args.request.action === "approve" || request.args.request.action === "approveMigration") {
        const invocationAgent = datasetAgent(request.args.actor, context, options);
        return context.dataset(request.args.request, invocationAgent
          ? {...invocationAgent,approvalAgent:{kind:"agent",label:request.args.request.agentLabel ?? null,labelSource:"agent-declared"}} : null);
      }
      return context.dataset(request.args.request, datasetAgent(request.args.actor, context, options));
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
      // An empty list would say this workspace has no History.
      if (!Array.isArray(moments)) return historyPolicyUnreadable(moments);
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
      if (moment && "status" in moment) {
        return moment.status === "untracked"
          ? {
              ok: false as const,
              status: "untracked" as const,
              reason: `change ${request.args.id} is hidden because History no longer tracks its file`,
            }
          : historyPolicyUnreadable(moment);
      }
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
      if ("group" in request.args) {
        const { group, before, limit } = request.args;
        try {
          const channels = (await context.store.listChannels({ workspaceId: context.workspaceId }))
            .map((engine) => ({ engine, cli: groupForCli(engine) }));
          const channel = resolveChannel(group, channels).engine;
          const page = await readGroupStream(context, channel, { ...(before ? { before } : {}), ...(limit ? { limit } : {}) }, "engine");
          return {
            ok: true as const,
            stream: {
              group: { id: channel.id, name: groupForCli(channel).name, kind: cliGroupKind(channel.kind) },
              ...page,
              items: page.items.map(({ message, decision, ...item }) => ({ ...item, message: rawChatMessage(message, decision) })),
            },
          };
        } catch (error) {
          return mcpFailure(error, `failed to read group: ${group}`);
        }
      }
      const { threadId } = request.args;
      try {
        const messages = await context.store.listMessages({
          workspaceId: context.workspaceId,
          threadId,
        });
        const threads = await context.store.listThreads({
          workspaceId: context.workspaceId,
        });
        const thread = threads.find(
          (candidate) => candidate.id === threadId,
        );
        if (!thread) {
          return {
            ok: false as const,
            reason: `chat thread not found: ${threadId}`,
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
          dispatch: await readThreadDispatchState(context.dispatchStore, context.workspaceId, thread.id),
          messages: messages.map((message) => rawChatMessage(message, decisionByMessage.get(message.id))),
          projection: {
            path: projection.path,
            readOnly: projection.readOnly,
            text: projection.text,
          },
        };
      } catch (error) {
        return mcpFailure(error, `failed to read chat: ${threadId}`);
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
        const wireIds = await Promise.all(fullChannels.map(channel =>
          context.store.getChannelWireId({ workspaceId: context.workspaceId, channelId: channel.id }).catch(() => null)));
        const withThreads = [];
        for (const [index, channel] of fullChannels.entries()) {
          const threads = await listCliChannelThreads(context, channel);
          withThreads.push({
            id: channel.id,
            channelWireId: wireIds[index] ?? null,
            name: channel.name,
            slug: channel.slug,
            kind: cliGroupKind(channel.kind),
            threadCount: threads.length,
            ...(channel.purpose ? { purpose: channel.purpose } : {}),
            threads: threads.map((entry) => ({
              id: entry.thread.id,
              title: entry.thread.title,
              messageCount: entry.messageCount,
              lane: entry.thread.lane,
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
        const versionError = collectionVersionError(result.collection.reasons, `${validated.normalized}/collection.yaml`);
        if (versionError) return { ok: false as const, reason: versionError };
        return {
          ok: true as const,
          collection: cliCollection(result.collection),
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
        const versionError = collectionVersionError(result.collection.reasons, `${validated.normalized}/collection.yaml`);
        if (versionError) return { ok: false as const, reason: versionError };
        return {
          ok: true as const,
          collection: cliCollection(result.collection),
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
            automationRun: entry.automationRun,
            linkAuthor: entry.linkAuthor,
          })),
        };
      } catch (error) {
        // Unsupported schemas have no record bindings, so getRecord can fail
        // before returning the collection diagnostic.
        try {
          const result = await collections.query({ collectionPath: validated.normalized, limit: 1 });
          const versionError = collectionVersionError(result.collection.reasons, `${validated.normalized}/collection.yaml`);
          if (versionError) return { ok: false as const, reason: versionError };
        } catch {
          // Preserve the original read failure if the schema is unavailable too.
        }
        return mcpFailure(
          error,
          `failed to read record: ${request.args.recordId}`,
        );
      }
    }

    case "collectionSetFields": {
      const collections = context.collections;
      if (!collections) return collectionsUnavailable();
      if (request.args.actor !== "agent") return { ok: false as const, reason: EDIT_AS_AGENT_REFUSAL };
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
      if (request.args.actor !== "agent") return { ok: false as const, reason: CREATE_AS_AGENT_REFUSAL };
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
          recordId: request.args.recordId,
          fields: request.args.fields,
          author: collectionWriteAuthor(request.args.actor, context, options),
        });
        if ("kind" in outcome) return { ok: false as const, reason: creationPartialMessage(outcome), partial: outcome };
        return {
          ok: true as const,
          recordId: outcome.recordId,
          recordPath: outcome.path,
          ...(outcome.kept ? { kept: outcome.kept } : {}),
        };
      } catch (error) {
        return mcpFailure(
          error,
          `failed to create a record in: ${request.args.collectionPath}`,
        );
      }
    }

    case "automationList":
    case "automationSwitch": {
      const automations = context.automations;
      if (!automations?.list || !automations.switch) return { ok: false, reason: "Automation controls are unavailable in this workspace." };
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.collectionPath);
      try {
        if (request.verb === "automationList") return { ok: true, definitions: await automations.list(validated.normalized) };
        const { automation, enabled, expectedContentHash, reformat, submitId } = request.args;
        const result = await automations.switch(validated.normalized, { automation, enabled, expectedContentHash, reformat, submitId });
        if (result.status === "written") await notifyWrite(options, context);
        return { ok: true, result };
      } catch (error) { return mcpFailure(error, "dohc could not read or switch this automation."); }
    }

    case "automationRuns":
    case "automationRun":
    case "automationRetry": {
      if (context.readOnly) return { ok: false as const, reason: SHARED_VIEW_AUTOMATIONS };
      const automations = context.automations;
      if (!automations) return { ok: false as const, reason: "automations are not available in this workspace" };
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.collectionPath);
      if (isSharedWithMePath(validated.normalized)) {
        return { ok: false as const, reason: SHARED_AUTOMATION_HISTORY_REASON };
      }
      try {
        const automationId = await automations.automationIdAt(validated.normalized, request.args.automation);
        if (automationId === null) return { ok: false as const, reason: `"${validated.normalized}" is not a Collection in this workspace.` };
        if (request.verb === "automationRuns") {
          const page = request.args.server ? await automations.serverRuns(automationId, request.args.page) : await automations.runs(automationId, request.args.page);
          if (page === null) return { ok: false as const, reason: SERVER_RUNS_UNREADABLE };
          const listed: CliResultByVerb["automationRuns"] = {
            ok: true,
            runs: page.runs.map(({ writes, ...run }) => ({ ...automationRunFields(run), changes: writes.length })),
            next: page.next,
          };
          return listed;
        }
        if (request.verb === "automationRun" && request.args.server) {
          const run = await automations.serverRun(automationId, request.args.run);
          if (run === null) return { ok: false as const, reason: `Your server has no run ${request.args.run} of this automation that this computer can read.` };
          const { writes, ...fields } = run;
          const read: CliResultByVerb["automationRun"] = { ok: true, run: { ...automationRunFields(fields), server: true, changes: writes } };
          return read;
        }
        if (request.verb === "automationRun") {
          const run = await automations.run(automationId, request.args.run);
          if (run === null) {
            return {
              ok: false as const,
              reason: `This computer has no run ${request.args.run} of this automation. Each computer keeps the runs of the automations it ran.`,
            };
          }
          const read: CliResultByVerb["automationRun"] = {
            ok: true,
            run: {
              ...automationRunFields(run),
              ...(run.findMs === undefined ? {} : { findMs: run.findMs }),
              ...(run.planMs === undefined ? {} : { planMs: run.planMs }),
              ...(run.writeMs === undefined ? {} : { writeMs: run.writeMs }),
              ...(run.writeCount === undefined ? {} : { writeCount: run.writeCount }),
              steps: run.steps.map((step) => ({ step: step.step, changes: step.writes })),
              failedStep: run.failedStep,
              startsOver: run.startsOver,
            },
          };
          return read;
        }
        return automationRetryResult(await automations.retry({
          automationId,
          claimId: request.args.run,
          startOver: request.args.startOver,
        }));
      } catch (error) {
        return mcpFailure(error, `failed to reach the runs of ${request.args.automation} in ${validated.normalized}`);
      }
    }

    case "fileWrite": {
      if (request.args.actor !== "agent") return { ok: false, written: [], reason: `A file write through the CLI socket is recorded as an agent's; send actor "agent".` };
      if (!context.writeFiles) return { ok: false, written: [], reason: "dohc could not start the engine for this workspace. Restart dohc to try again." };
      try {
        const result = await context.writeFiles(request.args.files, documentEditOrigin(context, options, request.args.agent), request.args.requestId);
        if (result.written?.length) await notifyWrite(options, context);
        return result;
      } catch (error) { return pathFreeFailure(error, "dohc could not write the files."); }
    }

    case "historyOperation":
    case "historyUndo": {
      // Every refused Undo carries a refusal, and main can name none of these.
      const refused = ({ reason }: { reason: string }) =>
        ({ ok: false as const, reason, ...(request.verb === "historyUndo" ? { refusal: { code: "unexplained" as const } } : {}) });
      if (request.verb === "historyUndo" && request.args.actor !== "agent") return refused({ reason: `An Undo through the CLI socket is recorded as an agent's; send actor "agent".` });
      const paths = await callerPaths(context, request.args.cwd);
      if (paths.shared) return refused({ reason: "History operations require the owning workspace. Open it to continue." });
      if (!context.historyOperation || !context.historyUndo) return refused({ reason: "The workspace engine is not running." });
      try {
        if (request.verb === "historyOperation") return await context.historyOperation(request.args);
        const result = await context.historyUndo(request.args, documentEditOrigin(context, options, request.args.agent));
        if (result.ok) await notifyWrite(options, context);
        return result;
      } catch (error) { return refused(pathFreeFailure(error, `dohc could not ${request.verb === "historyUndo" ? "undo" : "read"} this operation.`)); }
    }

    case "fileDuplicate": {
      if (context.readOnly) return {ok: false, reason: "Duplicate requires the owning workspace. Open it to continue."};
      if (request.args.actor !== "agent") return {ok: false, reason: 'Duplicate through the CLI socket requires actor "agent".'};
      if (!context.duplicateFile) return {ok: false, reason: "Restart dohc before duplicating this file."};
      return await onceForRequestId(context, options, request.args.requestId, ["fileDuplicate", request.args.path, request.args.agent ?? null], async () => {
        const result = await context.duplicateFile!(request.args.path, documentEditOrigin(context, options, request.args.agent), request.args.requestId)
          .catch(error => pathFreeFailure(error, "dohc could not duplicate the file."));
        if (result.ok) await notifyWrite(options, context);
        return { done: result.ok, result };
      }, completion);
    }
    case "fileMove":
    case "fileDelete": {
      const change = request.verb === "fileMove" ? "move" : "delete";
      if (request.args.actor !== "agent") return { ok: false, reason: `A file ${change} through the CLI socket is recorded as an agent's; send actor "agent".` };
      if (!context.movePath || !context.deletePath) return { ok: false, reason: "dohc could not start the engine for this workspace. Restart dohc to try again." };
      try {
        const origin = documentEditOrigin(context, options, request.args.agent);
        if (request.verb === "fileMove") {
          const result = await context.movePath({ fromPath: request.args.fromPath, toPath: request.args.toPath,
            ...(request.args.overwrite !== undefined ? { overwrite: request.args.overwrite } : {}) }, origin, request.args.requestId);
          if (result.ok || result.deleted?.length || result.withoutHistory?.length) await notifyWrite(options, context);
          return result;
        }
        const result = await context.deletePath(request.args.path, origin, request.args.requestId);
        if (result.ok || result.deleted?.length || result.withoutHistory?.length) await notifyWrite(options, context);
        return result;
      } catch (error) {
        return pathFreeFailure(error, `dohc could not ${change} the file.`);
      }
    }

    // Shared views inspect and press Buttons through the owner's host.
    case "automationButtons": {
      if (!context.buttons) return { ok: false as const, reason: "buttons are not available in this workspace" };
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.collectionPath);
      try {
        const buttons = await context.buttons.inspect({ collectionPath: validated.normalized, ...(request.args.table === undefined ? {} : { table: request.args.table }) }, pressActor(request.args.actor, context, options));
        return { ok: true as const, buttons };
      } catch (error) { return mcpFailure(error, "failed to inspect buttons"); }
    }
    case "automationPress": {
      const buttons = context.buttons;
      if (!buttons) return { ok: false as const, reason: "buttons are not available in this workspace" };
      const validated = validateUserReadPath(request.args.collectionPath, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.collectionPath);
      if (isSharedWithMePath(validated.normalized)) {
        return { ok: false as const, reason: `"${validated.normalized}" is not a Collection in this workspace.` };
      }
      const { field, record, table, confirm, requestId } = request.args;
      const collectionPath = validated.normalized;
      const pressWith = async (pressKey: string) => {
        try {
          return automationPressResult(await buttons.press({
            collectionPath, field, recordId: record, ...(table === undefined ? {} : { table }), confirm, pressKey,
          }, pressActor(request.args.actor, context, options)));
        } catch (error) {
          return mcpFailure(error, `failed to press ${field}`);
        }
      };
      if (requestId === undefined) return await pressWith(randomUUID());
      // Only a press is remembered, so a press refused for its questions can be sent again with confirm.
      return await onceForRequestId(context, options, requestId, [collectionPath, field, record, table ?? null, confirm], async () => {
        // The request id is the press's key, so a resend after a restart names the same press.
        const result = await pressWith(requestId);
        return { done: result.ok, result };
      }, completion);
    }

    case "documentRead": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const path = request.args.path;
      const validated = validateUserReadPath(path, { platform: process.platform });
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      try {
        return { ok: true as const, ...(await documents.read(validated.normalized)) };
      } catch (error) {
        return mcpFailure(error, `failed to read document: ${request.args.path}`);
      }
    }

    case "versionList":
    case "versionCompare":
    case "versionConflicts":
    case "versionCreate":
    case "versionSwitch":
    case "versionMerge":
    case "versionResolve": {
      const versions = context.versions;
      if (!versions || (await callerPaths(context, request.args.cwd)).shared) {
        return { ok: false as const, reason: "Versions belong to the owning workspace. Open it to continue." };
      }
      // A version as version list names it: by its name, then by its ID.
      const named = async (name: string) => {
        const { versions: all, activeVersionId } = await versions.list();
        const version = all.find(candidate => candidate.name === name) ?? all.find(candidate => candidate.id === name);
        return { version, activeVersionId };
      };
      const unknown = (name: string) => ({ ok: false as const, reason: `No version is called ${name}. Run dohc version list to see them.` });
      try {
        switch (request.verb) {
          case "versionList":
            return { ok: true as const, ...(await versions.list()) };
          case "versionConflicts": {
            const page = await versions.conflicts(request.args.afterConflictId);
            return "status" in page ? historyPolicyUnreadable(page, "Conflicts are hidden") : { ok: true as const, ...page };
          }
          case "versionCompare": {
            const { version } = await named(request.args.version);
            if (!version) return unknown(request.args.version);
            if (version.kind === "main") return { ok: false as const, reason: "Versions compare with Main. Name another version." };
            const page = await versions.compare(version.id, request.args.afterPath);
            if ("status" in page) return historyPolicyUnreadable(page, "Version files are hidden");
            return { ok: true as const, version: { id: version.id, name: version.name }, ...page };
          }
          case "versionCreate": {
            const name = request.args.name;
            try {
              return { ok: true as const, version: await versions.create(name) };
            } catch (error) {
              // The menu's name field says the same.
              const refusal = versionNameRefusal(error);
              if (refusal === "taken") return { ok: false as const, reason: `Another version is called ${name}. Choose another name.` };
              if (refusal === "invalid") return { ok: false as const, reason: "dohc can't use that name. Choose another name." };
              return pathFreeFailure(error, `dohc could not create the version ${name}.`);
            }
          }
          case "versionSwitch": {
            const { version, activeVersionId } = await named(request.args.version);
            if (!version) return unknown(request.args.version);
            const changed = version.id === activeVersionId ? { changedFileCount: 0 } : await versions.switch(version.id);
            return { ok: true as const, version: { id: version.id, name: version.name }, changedFileCount: changed.changedFileCount };
          }
          case "versionMerge": {
            const { version } = await named(request.args.version);
            if (!version) return unknown(request.args.version);
            if (version.kind === "main") return { ok: false as const, reason: "Versions merge into Main. Name another version." };
            if (!version.canMergeIntoMain) return { ok: false as const, reason: "Only versions made from Main can merge into Main." };
            const merged = await versions.merge(version.id);
            const page = await versions.conflicts();
            if ("status" in page) return historyPolicyUnreadable(page, "The merge ran, and its conflicts are hidden");
            return { ok: true as const, version: { id: version.id, name: version.name }, ...merged, ...page };
          }
          case "versionResolve": {
            const { conflictId, resolution } = request.args;
            // Only a conflict version conflicts shows can be resolved, so a
            // hidden file's conflict reads as no conflict at all.
            let conflict: CliVersionPage<"versionConflicts">["conflicts"][number] | undefined;
            let after: string | undefined;
            do {
              const page = await versions.conflicts(after);
              if ("status" in page) return historyPolicyUnreadable(page, "Conflicts are hidden");
              conflict = page.conflicts.find(candidate => candidate.conflictId === conflictId);
              after = page.nextAfterConflictId ?? undefined;
            } while (!conflict && after !== undefined);
            if (!conflict) return { ok: false as const, reason: `No open conflict has the ID ${conflictId}. Run dohc version conflicts to see them.` };
            if (resolution.keep === "combined" && conflict.contentKind === "binary") {
              return { ok: false as const, reason: "This conflict is between binary files, so it takes no combined text. Keep current or incoming." };
            }
            await versions.resolve(conflictId, resolution);
            const remaining = await versions.conflicts();
            return "status" in remaining ? historyPolicyUnreadable(remaining, "Conflicts are hidden") : { ok: true as const, ...remaining };
          }
        }
      } catch (error) {
        return pathFreeFailure(error, request.verb === "versionList" || request.verb === "versionCompare" || request.verb === "versionConflicts"
          ? "dohc could not read the workspace's versions." : "dohc could not change the workspace's versions.");
      }
    }

    case "keptCopies": {
      const keptCopies = context.keptCopies;
      if (!keptCopies) return keptCopiesUnavailable();
      try {
        return { ok: true as const, ...(await keptCopies.list()) };
      } catch (error) {
        return mcpFailure(error, "failed to list kept copies");
      }
    }

    case "collectionsWaiting":
      try {
        return { ok: true as const, waiting: await context.daemonReads.collectionsWaiting() };
      } catch (error) {
        return mcpFailure(error, "failed to read whether Collection updates wait");
      }

    case "saveKeptCopy": {
      const keptCopies = context.keptCopies;
      if (!keptCopies) return keptCopiesUnavailable();
      try {
        const saved = await keptCopies.save(request.args.id);
        if (saved.status === "saved") await notifyWrite(options, context);
        return { ok: true as const, ...saved };
      } catch (error) {
        return mcpFailure(error, `failed to save kept copy ${request.args.id}`);
      }
    }

    case "retainedCopies": {
      const retainedCopies = context.retainedCopies;
      if (!retainedCopies) return retainedCopiesUnavailable();
      try {
        return { ok: true as const, ...(await retainedCopies.list()) };
      } catch (error) {
        return mcpFailure(error, "failed to list old file copies");
      }
    }

    case "deleteRetainedCopies": {
      const retainedCopies = context.retainedCopies;
      if (!retainedCopies || context.readOnly) return retainedCopiesUnavailable();
      try {
        return { ok: true as const, ...(await retainedCopies.delete(request.args.copies)) };
      } catch (error) {
        return mcpFailure(error, "failed to delete old file copies");
      }
    }

    case "liveKeptEdits": {
      const keptEdits = context.keptEdits;
      if (!keptEdits || context.readOnly) return keptEditsUnavailable();
      try {
        return { ok: true as const, keptEdits: await keptEdits.list() };
      } catch (error) {
        return mcpFailure(error, "failed to list kept edits");
      }
    }

    case "saveRecoveryCopy": {
      const keptEdits = context.keptEdits;
      if (!keptEdits || context.readOnly) return keptEditsUnavailable();
      try {
        const saved = await keptEdits.saveRecoveryCopy(request.args.path, request.args.incident);
        await notifyWrite(options, context);
        return { ok: true as const, copyPath: saved.copyPath, packagePath: saved.packagePath, folder: posix.dirname(saved.packagePath), storedOn: saved.storedOn, keptEdits: saved.keptEdits };
      } catch (error) {
        return pathFreeFailure(error, `dohc could not save a recovery copy of ${request.args.path}.`);
      }
    }

    case "retryKeptEdits": {
      const keptEdits = context.keptEdits;
      if (!keptEdits || context.readOnly) return keptEditsUnavailable();
      try {
        await keptEdits.retry(request.args.path, request.args.incident);
        return { ok: true as const, path: request.args.path };
      } catch (error) {
        return mcpFailure(error, `failed to try again for ${request.args.path}`);
      }
    }

    case "stopAgain": {
      const keptEdits = context.keptEdits;
      if (!keptEdits || context.readOnly) return keptEditsUnavailable();
      try {
        const stopped = await keptEdits.stopAgain(request.args.path, request.args.incident);
        await notifyWrite(options, context);
        return { ok: true as const, path: request.args.path, keptEdits: stopped.keptEdits };
      } catch (error) {
        return mcpFailure(error, `failed to stop live editing again for ${request.args.path}`);
      }
    }

    case "documentEdit": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const { actor, agent, find, replacement } = request.args;
      if (actor !== "agent") return { ok: false as const, reason: EDIT_AS_AGENT_REFUSAL };
      const resolvedPath = request.args.path;
      const validated = validateUserWritePath(resolvedPath);
      if (!validated.ok) return cliPathRejected(validated.reason, request.args.path);
      const path = validated.normalized;
      const edit = async (): Promise<{ done: boolean; result: unknown }> => {
        try {
          const outcome = await documents.edit({
            ...(request.args.allowLossySourceSha256 ? { allowLossySourceSha256: request.args.allowLossySourceSha256 } : {}),
            path,
            edit: { find, replacement },
            origin: documentEditOrigin(context, options, request.args.agent),
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
       return await onceForRequestId(context, options, requestId, [path, find ?? null, replacement, agent ?? null, request.args.allowLossySourceSha256 ?? null], edit, completion);
    }

    case "documentCreate": {
      const documents = context.documents;
      if (!documents) return documentsUnavailable();
      const { actor, markdown } = request.args;
      if (actor !== "agent") return { ok: false as const, reason: CREATE_AS_AGENT_REFUSAL };
      // A new file, so the stricter materialization rules apply.
      const path = request.args.path;
      const validated = validateUserMaterializePath(path, { platform: process.platform });
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
            origin: documentEditOrigin(context, options, request.args.agent),
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
        ...(request.args.reported ? { reported: request.args.reported } : {}),
      };
      const requestId = request.args.requestId;
      if (requestId === undefined) return (await startFileChat(context, input, options)).result;
      return await onceForRequestId(
        context,
        options,
        requestId,
        [input.path, input.title, input.body, input.runId ?? null, input.agent ?? null, input.reported ?? null],
        async () => {
          const started = await startFileChat(context, input, options);
          return { done: started.created, result: started.result };
        },
        completion,
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
      return { groups: await Promise.all(channels.map(async ({ cli, engine }) => ({
        ...cli,
        channelWireId: await context.store.getChannelWireId({ workspaceId: context.workspaceId, channelId: engine.id }).catch(() => null),
      }))) };

    case "groupCreate": {
      if (!context.createGroup) throw new CliCommandError("Groups cannot be created in this workspace.");
      const channel = await context.createGroup({
        name: request.args.name,
        ...(request.args.purpose !== undefined ? { purpose: request.args.purpose } : {}),
        ...(request.args.type ? { type: request.args.type } : {}),
      });
      await notifyWrite(options, context);
      return { group: groupForCli(channel) };
    }

    case "threads": {
      const channel = resolveChannel(request.args.group, channels);
      const summaries = await listCliChannelThreads(context, channel.engine);
      const agentUnread = request.args.actor === "agent"
        ? new Set(
            (await context.store.listAgentUnreadThreads(
              context.workspaceId,
              chatAgentReader(context, context.run?.runId ?? null),
            )).map(
              (thread) => thread.id,
            ),
          )
        : null;
      return {
        group: channel.cli,
        threads: summaries.map((summary) => ({
          id: cliThreadId(summary.thread.id),
          lane: summary.thread.lane,
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
      // An agent you run, and the agent of a run dohc dispatched, each read
      // their own unread work: their chat, and each message elsewhere that
      // asked them. Connected agents share plain @agent mentions and replies
      // in threads they posted in. Agent chats belong to their agents.
      const reader = chatAgentReader(context, context.run?.runId ?? null);
      const readerAgentId = reader.kind === "connected"
        ? reader.agentId
        : reader.kind === "run" ? context.run?.agentId ?? null : null;
      const mentionRows = await context.store.listAgentUnreadRequests(context.workspaceId, reader);
      const unread = reader.kind === "unnamed"
        ? [...new Set(mentionRows.map(row => row.threadId))].map(id => ({ id }))
        : await context.store.listAgentUnreadThreads(context.workspaceId, reader);
      const agentChannelIds = new Set(
        channels
          .filter(({ engine }) => engine.kind === "agent" && (readerAgentId === null || engine.agentId === readerAgentId))
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

      const messageCache = new Map<string, ChatMessage[]>();
      const mentions: CliResultByVerb["inbox"]["mentions"] = [];
      for (const mention of mentionRows) {
        const thread = loadedById.get(mention.threadId);
        if (!thread) continue;
        // Requests in an agent chat are already in the threads above.
        if (thread.thread.channelId && agentChannelIds.has(thread.thread.channelId)) continue;
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
      const group = exactChannel(request.args.target, channels);
      if (group) {
        const page = await readGroupStream(context, group.engine, request.args, "cli");
        return {
          stream: {
            group: group.cli,
            ...page,
            items: page.items.map(({ message, decision, ...item }) => ({
              ...item,
              message: cliShowMessage(message, decision),
            })),
          },
        };
      }
      if (request.args.before || request.args.limit) {
        throw new CliCommandError("--before and --limit page a group's stream; name a group");
      }
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
          chatAgentReader(context, context.run?.runId ?? null),
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
      // An agent DM is one conversation; the engine puts the message there.
      if (channel.engine.kind === "agent" && request.args.title) {
        throw new CliCommandError("An agent DM is one conversation, so its messages have no title. Drop --title.");
      }
      const actor = writeActor(request.args.actor, context, options);
      const started = await options.chatWrites.startThread(context, {
        writer: cliChatWriter(actor, context, request.args.agent, request.args.reported),
        channelId: channel.engine.id,
        // A chat-only group shows only its chat lane.
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
      const actor = writeActor(request.args.actor, context, options);
      const parent = request.args.to
        ? resolveMessageInThread(request.args.to, messages)
        : actor === "agent"
          // An agent you run answers no run.
          ? await askingThreadParent(context, threadId, messages, context.connected ? null : request.args.runId ?? context.run?.runId ?? null, options.onError)
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
      const reply = {
        writer: cliChatWriter(actor, context, request.args.agent, request.args.reported),
        threadId,
        ...(parent ? { parentMessageId: parent.id } : {}),
        body: request.args.body,
        needsDecision: request.args.needsDecision,
        ...(request.args.options ? { options: request.args.options } : {}),
        resolveAttachments: () =>
          resolveAttachments(context, request.args.cwd, request.args.attachments),
      };
      const sent = decisionMessage
        ? await options.chatWrites.answer(context, {
            ...reply,
            resolves: {
              messageId: decisionMessage.id,
              ...(request.args.choose ? { chosenOption: request.args.choose } : {}),
            },
          })
        : { message: await options.chatWrites.sendMessage(context, reply) };
      const { message } = sent;
      const linkWarning = await linkRunMessage(context, {
        actor,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        messageId: message.id,
      }, options);
      const resolvedByReply = "decision" in sent && sent.decision.resolvedByMessageId === message.id;
      let resolutionFailure: string | null = null;
      if ("failure" in sent) {
        resolutionFailure = oneLine(
          sent.failure instanceof Error ? sent.failure.message : "decision update failed",
        );
        options.onError?.(sent.failure);
      }
      if (actor === "agent") {
        try {
          await context.store.markThreadReadByAgent({
            workspaceId: context.workspaceId,
            reader: chatAgentReader(context, context.run?.runId ?? null),
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
        writer: cliChatWriter(writeActor(request.args.actor, context, options), context),
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
        const result = await buildThreadContent(context, thread, messages);
        const channelDir = join(outputRoot, nameSlug(thread.group.slug) || "chat");
        await mkdir(channelDir, { recursive: true });
        const publicThreadId = cliThreadId(thread.thread.id);
        const path = join(channelDir, `${safePathSegment(publicThreadId)}.md`);
        const provenance = `<!-- exported from dohc chat thread ${publicThreadId} at ${exportedAt} -->`;
        await writeFile(path, `${provenance}\n${renderThreadMarkdown(result)}`, "utf8");
        files.push({ threadId: publicThreadId, path });
      }
      return { files };
    }
  }
}

async function dispatchMentionAndLinkReads(
  request: Extract<CliRequest, { verb: "chatLinks" | "chatFileMentions" | "linksIn" | "linksResolve" | "linksEdges" }>,
  options: CliServerOptions,
  runSecret: string | undefined,
): Promise<unknown> {
  const workspace = await resolveCliWorkspace(request.args.cwd, options.listWorkspaces());
  if (!workspace) throw new CliCommandError("not inside a dohc workspace");
  if (request.verb === "chatLinks") {
    if (!options.chatLinks) throw new CliCommandError("Chat links are unavailable.");
    let channelWireId: string | null;
    if ("group" in request.args) {
      const context = await workspaceContextForRequest(request, options, runSecret);
      const loaded = await loadChannels(context);
      if (loaded.provisioned) await notifyWrite(options, context);
      const channel = resolveChannel(request.args.group, loaded.channels);
      channelWireId = await context.store.getChannelWireId({
        workspaceId: context.workspaceId, channelId: channel.engine.id,
      }).catch(() => null);
    } else {
      channelWireId = request.args.channelWireId;
    }
    return channelWireId === null ? null : options.chatLinks(workspace, { channelWireId, cursor: request.args.cursor });
  }
  if (request.verb === "chatFileMentions") {
    if (!options.chatFileMentions) throw new CliCommandError("Chat mentions are unavailable.");
    return options.chatFileMentions(workspace, { subject: request.args.subject, cursor: request.args.cursor });
  }
  if (!options.links) throw new CliCommandError("Workspace links are unavailable.");
  if (request.verb === "linksEdges") return options.links.edges(workspace, { cursor: request.args.cursor });
  return request.verb === "linksIn"
    ? options.links.incoming(workspace, { subject: request.args.subject, cursor: request.args.cursor })
    : options.links.resolve(workspace, { source: request.args.source, literals: request.args.literals });
}

async function dispatchAccount(
  request: Extract<CliRequest, { verb: "accountDeletePreview" | "accountDelete" }>,
  options: CliServerOptions,
): Promise<unknown> {
  if (!options.serverAccount) throw new CliCommandError("Server accounts are unavailable.");
  if (request.verb === "accountDeletePreview") return options.serverAccount.preview();
  const { server, previewToken, password } = request.args;
  return options.serverAccount.delete({ server, previewToken, password });
}

async function workspaceContextForRequest(
  request: CliRequest,
  options: CliServerOptions,
  runSecret: string | undefined,
): Promise<CliWorkspaceContext> {
  const workspace = await resolveCliWorkspace(request.args.cwd, options.listWorkspaces());
  if (!workspace) throw new CliCommandError("not inside a dohc workspace");
  // An agent you run is named once, here. A person is never one, and a run
  // never names one.
  const { agentId } = request.args;
  let connected: CliConnectedAgent | null = null;
  if (agentId !== undefined) {
    if (request.args.actor !== "agent") throw new CliCommandError("Only an agent works as an agent you run. Send actor \"agent\" with its id.");
    if ("runId" in request.args && request.args.runId) throw new CliCommandError("An agent you run is not a run. Send its id without a run id.");
    connected = await options.connectedAgent(workspace.workspaceId, agentId);
    if (!connected) throw new CliCommandError("No agent you run has this id in Settings › Agents.");
    if (!connected.handle) throw new CliCommandError("Give this agent a name with a letter or digit in Settings › Agents, so @ can reach it.");
  }
  // An agent you run is never part of a run, even one whose secret it holds.
  const run = connected ? undefined : provenRun(workspace.workspaceId, runSecret, options);
  if ("runId" in request.args && request.args.runId) {
    const runWorkspaceId = options.agentRunWorkspace(request.args.runId);
    // A run id is only a claim unless the request proves it is that run.
    if (runWorkspaceId === undefined || !provenRun(runWorkspaceId, runSecret, options)) delete request.args.runId;
    else if (runWorkspaceId !== workspace.workspaceId) throw new CliCommandError("Agent runs cannot write in another workspace.");
    else request.args.actor = "agent";
  }
  const collectionWriteRequest =
    request.verb === "collectionSetFields" ||
    request.verb === "collectionCreateRecord";
  const fileRequest = request.verb === "fileWrite" || request.verb === "fileMove" || request.verb === "fileDelete" || request.verb === "fileDuplicate";
  const documentWriteRequest =
    request.verb === "documentEdit" || request.verb === "documentCreate" || fileRequest;
  const writeRequest =
    collectionWriteRequest ||
    documentWriteRequest ||
    request.verb === "fileChatStart" ||
    request.verb === "groupCreate" ||
    request.verb === "post" ||
    request.verb === "reply" ||
    request.verb === "react" ||
    request.verb === "export" ||
    (request.verb === "show" && !request.args.peek);
  if (workspace.readOnly && writeRequest) {
    throw new CliCommandError(
      fileRequest
        ? "This workspace is read-only. Write in the owning workspace."
        : collectionWriteRequest
        ? "collection writes are not available in a read-only shared view"
        : documentWriteRequest
          ? "document changes are not available in a read-only shared view"
          : "chats are not available in a read-only shared view",
    );
  }
  const opened = await options.openWorkspace(workspace);
  const context = connected ? { ...opened, connected } : opened;
  if (isChatReadVerb(request.verb)) {
    await notifyRead(options, context, chatReadTarget(request));
  }
  return run === undefined ? context : { ...context, run };
}

// The run dohc dispatched in the workspace, when the request carries that
// run's secret.
function provenRun(
  workspaceId: string,
  runSecret: string | undefined,
  options: CliServerOptions,
): CliRunCaller | undefined {
  const secret = options.dispatchedRunSecret(workspaceId);
  const agentId = options.dispatchedAgent(workspaceId);
  if (runSecret === undefined || secret === null || agentId === null || !tokenMatches(secret, runSecret)) return undefined;
  return { agentId, runId: options.dispatchedRunId(workspaceId) };
}

const chatWaiters = new WeakMap<CliServerOptions, ChatMessageWaiters>();
// A wait walks its reader's requests this many at a time, and returns at
// most WATCH_BATCH of them.
const WATCH_PAGE = 200;
const WATCH_BATCH = 100;
// The most message bytes one answer carries, so it fits an MCP client's tool
// result. A first message past it still comes alone.
export const WATCH_BATCH_MAX_BYTES = 96 * 1024;
const MAX_WATCH_SEEN = 50_000;
// `reader` is the id of the agent you run, `run:<id>` for a run dohc started,
// or null for unnamed agents. Each seen request is its time and message id.
const watchCursorSchema = z.object({
  v: z.literal(2),
  workspaceId: z.string(),
  group: z.string().nullable(),
  thread: z.string().nullable(),
  reader: z.string().nullable(),
  seen: z.array(z.tuple([z.number().int().nonnegative(), z.string().min(1).max(500)])).max(MAX_WATCH_SEEN),
}).strict();
type WatchSeen = [createdAtMs: number, messageId: string];

function compareWatchSeen([leftAt, leftId]: WatchSeen, [rightAt, rightId]: WatchSeen): number {
  return leftAt - rightAt || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

async function watchMessages(
  request: Extract<CliRequest, { verb: "watch" }>,
  options: CliServerOptions,
  runSecret: string | undefined,
  connectionSignal?: AbortSignal,
): Promise<CliResultByVerb["watch"]> {
  if (request.args.actor !== "agent") throw new CliCommandError("Chat watch is for agents. Use chat inbox for your unread threads.");
  connectionSignal?.throwIfAborted();
  // A run dohc started waits as its run's reader: for the requests its agent
  // was woken for, which include replies in threads it posted in. Any other
  // agent waits as itself or as the unnamed agent.
  const context = await workspaceContextForRequest(request, options, runSecret);
  const runId = context.run?.runId ?? null;
  const reader = chatAgentReader(context, runId);
  const scope = {
    v: 2 as const,
    workspaceId: context.workspaceId,
    group: request.args.group ?? null,
    thread: request.args.thread ?? null,
    reader: context.connected?.agentId ?? (runId === null ? null : `run:${runId}`),
  };
  let seen: WatchSeen[] = [];
  if (request.args.cursor !== undefined) {
    try {
      const cursor = watchCursorSchema.parse(JSON.parse(Buffer.from(request.args.cursor, "base64url").toString("utf8")));
      if (cursor.workspaceId !== scope.workspaceId || cursor.group !== scope.group || cursor.thread !== scope.thread || cursor.reader !== scope.reader) throw new Error("scope");
      seen = cursor.seen;
    } catch { throw new CliCommandError("This chat cursor is invalid for this agent, workspace or filter. Watch again without a cursor."); }
  }
  const encode = (entries: WatchSeen[]) => {
    const cursor = Buffer.from(JSON.stringify({ ...scope, seen: entries })).toString("base64url");
    if (entries.length > MAX_WATCH_SEEN || cursor.length > 1_048_576) throw new CliCommandError("The chat cursor is full. Mark processed threads read, then watch without a cursor.");
    return cursor;
  };
  // The Group and thread filters resolve once, before the wait.
  let channelId: string | undefined;
  let threadId: string | undefined;
  if (request.args.group !== undefined || request.args.thread !== undefined) {
    const { channels, provisioned } = await loadChannels(context);
    if (provisioned) await notifyWrite(options, context);
    if (request.args.group !== undefined) {
      const group = exactChannel(request.args.group, channels);
      if (!group) throw new CliCommandError("Group not found. Use chat groups to choose a Group.");
      channelId = group.engine.id;
    }
    if (request.args.thread !== undefined) threadId = resolveThread(request.args.thread, await loadThreads(context, channels)).thread.id;
  }
  const empty = { messages: [], cursor: request.args.cursor ?? encode([]) };
  const seenIds = new Set(seen.map(([, messageId]) => messageId));
  let waiters = chatWaiters.get(options);
  if (!waiters) chatWaiters.set(options, waiters = new ChatMessageWaiters());
  const signals = [connectionSignal, context.signal].filter((value): value is AbortSignal => value !== undefined);
  // An agent you run reads as listening until the wait ends, aborts or times out.
  const endWait = context.connected ? options.agentWaiting?.(context.connected.agentId) : undefined;
  const engineIds = new WeakMap<object, string[]>();
  const waited = waiters.wait<CliResultByVerb["watch"]>({
    signal: signals.length ? AbortSignal.any(signals) : undefined,
    timeoutMs: request.args.timeoutMs ?? CHAT_WATCH_TIMEOUT_MS,
    empty,
    subscribe: listener => subscribeChatWrites(context.workspaceId, listener),
    refresh: () => { void notifyRead(options, context, threadId ? { threadId } : undefined); },
    // Walk the reader's requests from the start, skipping the seen ones,
    // until the batch is full or the walk reaches the end. A late arrival
    // with an older time is still met.
    query: async () => {
      const messages: CliResultByVerb["watch"]["messages"] = [];
      const returned: WatchSeen[] = [];
      const met = new Set<string>();
      let bytes = 0;
      let stoppedAt: WatchSeen | null = null;
      let after: { createdAtMs: number; messageId: string } | undefined;
      walk: for (;;) {
        const page = await context.store.listAgentRequestsPage({
          workspaceId: context.workspaceId,
          reader,
          ...(channelId === undefined ? {} : { channelId }),
          ...(threadId === undefined ? {} : { threadId }),
          ...(after === undefined ? {} : { after }),
          limit: WATCH_PAGE,
        });
        for (const unread of page.requests) {
          if (seenIds.has(unread.messageId)) {
            met.add(unread.messageId);
            continue;
          }
          const message = {
            threadId: cliThreadId(unread.threadId),
            messageId: cliMessageId(unread.messageId),
            group: unread.channel ? groupForCli(unread.channel) : FILES_GROUP,
            author: { kind: unread.author.kind, displayName: unread.author.displayName },
            createdAtMs: unread.createdAtMs,
            text: unread.body,
          };
          const size = Buffer.byteLength(JSON.stringify(message));
          if (messages.length === WATCH_BATCH || (messages.length > 0 && bytes + size > WATCH_BATCH_MAX_BYTES)) {
            stoppedAt = [unread.createdAtMs, unread.messageId];
            break walk;
          }
          messages.push(message);
          returned.push([unread.createdAtMs, unread.messageId]);
          bytes += size;
        }
        const last = page.requests.at(-1);
        if (!page.more || !last) break;
        after = { createdAtMs: last.createdAtMs, messageId: last.messageId };
      }
      // A seen request the walk met is still unread. One past where it
      // stopped was not reached. Any other is read now, so it drops.
      const kept = seen.filter((entry) => met.has(entry[1]) || (stoppedAt !== null && compareWatchSeen(entry, stoppedAt) >= 0));
      const found = { messages, cursor: encode([...kept, ...returned]) };
      engineIds.set(found, returned.map(([, messageId]) => messageId));
      return found;
    },
  });
  if (runId !== null) {
    // The run answers what it was given, so no run after it starts for those
    // requests. Only the batch this watch returns counts: a query still in
    // flight when the wait timed out or was cancelled delivered nothing.
    const result = await waited;
    const delivered = engineIds.get(result);
    if (delivered !== undefined && delivered.length > 0) {
      await context.dispatchStore.coverDeliveredRequests({ workspaceId: context.workspaceId, runId, messageIds: delivered });
    }
    return result;
  }
  if (!endWait) return waited;
  // A refused or aborted wait clears at once; an answered one holds briefly.
  return waited.then((result) => {
    endWait();
    return result;
  }, (error: unknown) => {
    endWait(false);
    throw error;
  });
}

export async function handleCliRequestLine(
  line: string,
  token: string,
  options: CliServerOptions,
  signal?: AbortSignal,
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
    // The caller's door labels counting only; authority never receives it. The
    // run secret only proves the request is a run's; no verb receives it.
    const { door: _door, runSecret, ...request } = parsed.data;
    const completion = { replayed: false };
    const unvalidated = request.verb === "watch"
      ? await watchMessages(request, options, runSecret, signal)
      : request.verb === "accountDeletePreview" || request.verb === "accountDelete"
      ? await dispatchAccount(request, options)
      : request.verb === "chatLinks" || request.verb === "chatFileMentions" || request.verb === "linksEdges" || request.verb === "linksIn" || request.verb === "linksResolve"
        ? await dispatchMentionAndLinkReads(request, options, runSecret)
        : await dispatch(request, await workspaceContextForRequest(request, options, runSecret), options, completion);
    const result = parseCliResult(parsed.data.verb, unvalidated);
    const response = cliTransportResponseSchema.parse({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result,
    });
    const invocation = completion.replayed ? null : cliUsageInvocation(parsed.data, result);
    if (invocation) {
      try { options.recordSuccess?.(invocation); } catch { /* Measurement cannot fail the command. */ }
    }
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
  const chunks: string[] = [];
  let receivedBytes = 0;
  let handled = false;
  const cancellation = new AbortController();
  const deadline = setTimeout(() => socket.destroy(), CLI_REQUEST_DEADLINE_MS);

  const failOversized = () => {
    handled = true;
    const response = cliTransportResponseSchema.parse({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: false,
      error: "dohc: CLI request exceeds 14 MiB. Split the files into smaller batches.",
    });
    socket.end(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;
    receivedBytes += Buffer.byteLength(chunk, "utf8");
    if (receivedBytes > MAX_REQUEST_BYTES) {
      failOversized();
      return;
    }
    const newline = chunk.indexOf("\n");
    chunks.push(newline === -1 ? chunk : chunk.slice(0, newline));
    if (newline === -1) return;
    handled = true;
    clearTimeout(deadline);
    const line = chunks.join("");
    chunks.length = 0;
    // Keep reading so a disconnected waiter delivers its FIN immediately.
    const task = handleCliRequestLine(line, token, options, cancellation.signal)
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
  socket.on("end", () => cancellation.abort());
  socket.on("close", () => {
    cancellation.abort();
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
      chatWaiters.get(options)?.close();
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
