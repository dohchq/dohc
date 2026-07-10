import {
  CLI_PROTOCOL_VERSION,
  cliRequestSchema,
  cliTransportResponseSchema,
  parseCliResult,
  type CliActor,
  type CliAuthor,
  type CliChannel,
  type CliGrepContextMessage,
  type CliGrepMatch,
  type CliRequest,
  type CliResultByVerb,
  type CliShowMessage,
} from "@dohc/cli/protocol";
import { renderShowMarkdown } from "@dohc/cli/render";
import { formatMessageHandle } from "@dohc/cli/thread-markdown";
import {
  AgentDispatchStoreError,
  LINKED_CHAT_STORE_RELATIVE_PATH,
  queryChatMessagesGranular,
  type AgentDispatchStore,
  type ChannelThreadSummary,
  type ChatChannelSummary,
  type ChatMessage,
  type ChatThread,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import {
  chmod,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";

export const CLI_SOCKET_FILE = "dohc-cli.sock";
export const CLI_TOKEN_FILE = "dohc-cli-token";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_FTS_CANDIDATES = 50_000;
const MAX_SOCKET_CONNECTIONS = 64;
const REQUEST_DEADLINE_MS = 15_000;
const REGEX_SCAN_TIMEOUT_MS = 5_000;
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

interface EngineSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface EngineSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): EngineSqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => EngineSqliteDb;
}

export interface CliRegistryWorkspace {
  workspaceId: string;
  rootPath: string;
  readOnly?: boolean;
}

export interface CliWorkspaceContext extends CliRegistryWorkspace {
  store: LinkedChatStore;
  dispatchStore: AgentDispatchStore;
  readOnly: boolean;
  fileObjectIdForPath(path: string): Promise<string | null>;
  assertWritable(target: { channelId: string } | { threadId: string }): Promise<void>;
}

export interface CliMainIdentity {
  displayName: string;
  authorUserId?: string;
  reactionAuthorId: string;
}

export interface CliServerOptions {
  stateDir: string;
  listWorkspaces(): readonly CliRegistryWorkspace[];
  openWorkspace(workspace: CliRegistryWorkspace): Promise<CliWorkspaceContext>;
  identity(): Promise<CliMainIdentity>;
  onWrite?(workspace: CliWorkspaceContext): void | Promise<void>;
  onError?(error: unknown): void;
  nowMs?: () => number;
  platform?: NodeJS.Platform;
  regexScanTimeoutMs?: number;
}

export interface CliServerHandle {
  socketPath: string;
  tokenPath: string;
  ready: Promise<void>;
  close(): Promise<void>;
}

interface LoadedThread {
  thread: ChatThread;
  channel: CliChannel;
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

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function resolveCliWorkspace(
  cwd: string,
  workspaces: readonly CliRegistryWorkspace[],
): CliRegistryWorkspace | null {
  const absoluteCwd = resolve(cwd);
  const candidates = workspaces
    .map((workspace) => ({ workspace, root: resolve(workspace.rootPath) }))
    .filter(({ root }) => isInside(root, absoluteCwd))
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

export function cliChannelId(id: string): string {
  return shortenedEngineId(id, "channel_", "ch_");
}

export function cliThreadId(id: string): string {
  return shortenedEngineId(id, "thread_", "th_");
}

export function cliMessageId(id: string): string {
  return formatMessageHandle(id);
}

function channelForCli(channel: ChatChannelSummary): CliChannel {
  return {
    id: cliChannelId(channel.id),
    name: channel.kind === "agent" ? "my-agent" : channel.name,
    slug: channel.slug,
    kind: channel.kind,
  };
}

const FILES_CHANNEL: CliChannel = {
  id: "files",
  name: "files",
  slug: "files",
  kind: "channel",
};

function authorForCli(message: ChatMessage): CliAuthor {
  return {
    kind: message.author.kind,
    displayName: message.author.displayName,
  };
}

function authorForActor(identity: CliMainIdentity, actor: CliActor): CliAuthor {
  return actor === "agent"
    ? { kind: "agent", displayName: identity.displayName }
    : { kind: "human", displayName: identity.displayName };
}

async function loadChannels(
  context: CliWorkspaceContext,
): Promise<{
  channels: Array<{ engine: ChatChannelSummary; cli: CliChannel }>;
  provisioned: boolean;
}> {
  const before = await context.store.listChannels({
    workspaceId: context.workspaceId,
  });
  if (!context.readOnly) {
    await context.store.ensureGeneralChannel({ workspaceId: context.workspaceId });
    await context.store.ensureAgentChannel({ workspaceId: context.workspaceId });
  }
  const channels = await context.store.listChannels({
    workspaceId: context.workspaceId,
  });
  return {
    channels: channels.map((engine) => ({ engine, cli: channelForCli(engine) })),
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
  channels: readonly { engine: ChatChannelSummary; cli: CliChannel }[],
): { engine: ChatChannelSummary; cli: CliChannel } {
  const normalized = withoutChannelMarker(input);
  const slugMatches = channels.filter(
    ({ cli }) => cli.slug === normalized || cli.name === normalized,
  );
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    ambiguous("channel", input, slugMatches.map(({ cli }) => cli.id));
  }
  return resolveIdPrefix(
    normalized,
    "channel",
    channels,
    ({ cli }) => cli.id,
    ({ engine }) => [engine.id],
  );
}

async function loadThreads(
  context: CliWorkspaceContext,
  channels: readonly { engine: ChatChannelSummary; cli: CliChannel }[],
): Promise<LoadedThread[]> {
  const summaries = await Promise.all(
    channels.map(async ({ engine, cli }) => ({
      cli,
      summaries: await context.store.listChannelThreads({
        workspaceId: context.workspaceId,
        channelId: engine.id,
      }),
    })),
  );
  const byId = new Map<string, LoadedThread>();
  for (const group of summaries) {
    for (const summary of group.summaries) {
      byId.set(summary.thread.id, {
        thread: summary.thread,
        channel: group.cli,
        summary,
      });
    }
  }
  const all = await context.store.listThreads({ workspaceId: context.workspaceId });
  for (const thread of all) {
    if (!byId.has(thread.id)) {
      byId.set(thread.id, { thread, channel: FILES_CHANNEL });
    }
  }
  return [...byId.values()];
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
      channel: loaded.channel,
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

function workspaceRelativePath(
  context: CliWorkspaceContext,
  cwd: string,
  path: string,
): string {
  const absolute = resolve(cwd, path);
  const root = resolve(context.rootPath);
  if (!isInside(root, absolute)) {
    throw new CliCommandError(`attachment is outside this workspace: ${path}`);
  }
  return relative(root, absolute).split(sep).join("/");
}

async function resolveAttachments(
  context: CliWorkspaceContext,
  cwd: string,
  paths: readonly string[],
): Promise<Array<{ objectId: string; pathHint: string }>> {
  return Promise.all(
    paths.map(async (path) => {
      const pathHint = workspaceRelativePath(context, cwd, path);
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

function queryFtsCandidates(
  context: CliWorkspaceContext,
  query: string,
): { threadIds: Set<string>; messageIds: Set<string> } | null {
  if ([...query.trim()].length < 3) return null;
  const { DatabaseSync } = nodeSqlite();
  let db: EngineSqliteDb | null = null;
  try {
    db = new DatabaseSync(
      join(context.rootPath, LINKED_CHAT_STORE_RELATIVE_PATH),
      { readOnly: true },
    );
    const rows = queryChatMessagesGranular(db, {
      workspaceId: context.workspaceId,
      query,
      limit: MAX_FTS_CANDIDATES,
    });
    // A saturated prefilter is not exhaustive. Fall back to the full body scan
    // below so the optimization can never change grep's results at scale.
    if (rows.length === MAX_FTS_CANDIDATES) return null;
    const threadIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const row of rows) {
      threadIds.add(row.threadId);
      if (row.messageId) messageIds.add(row.messageId);
    }
    return { threadIds, messageIds };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function humanUnreadFileThreadIds(context: CliWorkspaceContext): Set<string> {
  const { DatabaseSync } = nodeSqlite();
  let db: EngineSqliteDb | null = null;
  try {
    db = new DatabaseSync(
      join(context.rootPath, LINKED_CHAT_STORE_RELATIVE_PATH),
      { readOnly: true },
    );
    const rows = db.prepare(
      `SELECT t.thread_id,
              (SELECT COUNT(*) FROM chat_messages m
               WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.thread_id)
                AS message_count,
              COALESCE((SELECT rs.last_read_sequence FROM chat_thread_read_state rs
                        WHERE rs.workspace_id = t.workspace_id AND rs.thread_id = t.thread_id), 0)
                AS last_read_sequence
       FROM chat_threads t
       WHERE t.workspace_id = ?
         AND t.channel_id IS NULL
         AND t.linked_object_id IS NOT NULL`,
    ).all(context.workspaceId);
    const ids = new Set<string>();
    for (const row of rows) {
      const messageCount = row.message_count;
      const lastReadSequence = row.last_read_sequence;
      if (
        typeof row.thread_id !== "string" || row.thread_id.length === 0 ||
        typeof messageCount !== "number" ||
        !Number.isSafeInteger(messageCount) ||
        messageCount < 0 ||
        typeof lastReadSequence !== "number" ||
        !Number.isSafeInteger(lastReadSequence) ||
        lastReadSequence < 0
      ) {
        throw new CliCommandError("chat store contains invalid read state");
      }
      if (messageCount > Math.min(lastReadSequence, messageCount)) {
        ids.add(row.thread_id);
      }
    }
    return ids;
  } finally {
    db?.close();
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

function linkRunMessage(
  context: CliWorkspaceContext,
  input: { actor: CliActor; runId?: string; messageId: string },
  options: CliServerOptions,
): void {
  if (input.actor !== "agent" || !input.runId) return;
  try {
    const run = context.dispatchStore.getRunRecord(input.runId);
    if (!run || run.workspaceId !== context.workspaceId) return;
    context.dispatchStore.recordRunMessage({
      workspaceId: context.workspaceId,
      messageId: input.messageId,
      runId: input.runId,
    });
  } catch (error) {
    if (
      error instanceof AgentDispatchStoreError &&
      (error.code === "invalid-input" || error.code === "run-not-found")
    ) {
      return;
    }
    try {
      options.onError?.(error);
    } catch {}
  }
}

async function dispatch(
  request: CliRequest,
  context: CliWorkspaceContext,
  options: CliServerOptions,
): Promise<unknown> {
  const loadedChannels = await loadChannels(context);
  const channels = loadedChannels.channels;
  if (loadedChannels.provisioned) await notifyWrite(options, context);
  const nowMs = options.nowMs ?? Date.now;

  switch (request.verb) {
    case "channels":
      return { channels: channels.map(({ cli }) => cli) };

    case "threads": {
      const channel = resolveChannel(request.args.channel, channels);
      const summaries = await context.store.listChannelThreads({
        workspaceId: context.workspaceId,
        channelId: channel.engine.id,
      });
      const agentUnread = request.args.actor === "agent"
        ? new Set(
            (await context.store.listAgentUnreadThreads(context.workspaceId)).map(
              (thread) => thread.id,
            ),
          )
        : null;
      return {
        channel: channel.cli,
        threads: summaries.map((summary) => ({
          id: cliThreadId(summary.thread.id),
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
            summaries: await context.store.listChannelThreads({
              workspaceId: context.workspaceId,
              channelId: channel.engine.id,
            }),
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
              channel: channel.cli,
            })),
        );
        const unreadFileIds = humanUnreadFileThreadIds(context);
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
          channel: thread.channel,
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
              channel: thread.channel,
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
          channel: thread.channel,
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
      const channel = resolveChannel(request.args.channel, channels);
      if (channel.engine.kind === "dm") {
        throw new CliCommandError(
          "DMs are streams — use 'dohc chat reply <thread>'",
        );
      }
      await context.assertWritable({ channelId: channel.engine.id });
      const [identity, attachments] = await Promise.all([
        options.identity(),
        resolveAttachments(context, request.args.cwd, request.args.attachments),
      ]);
      const started = await context.store.startChannelThread({
        workspaceId: context.workspaceId,
        channelId: channel.engine.id,
        ...(request.args.title ? { title: request.args.title } : {}),
        author: authorForActor(identity, request.args.actor),
        ...(identity.authorUserId ? { authorUserId: identity.authorUserId } : {}),
        origin: "cli",
        body: request.args.body,
        needsDecision: request.args.needsDecision,
        attachments,
      });
      linkRunMessage(context, {
        actor: request.args.actor,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        messageId: started.message.id,
      }, options);
      await notifyWrite(options, context);
      return {
        channel: channel.cli,
        threadId: cliThreadId(started.thread.id),
        messageId: cliMessageId(started.message.id),
        title: started.thread.title,
      };
    }

    case "reply": {
      const threads = await loadThreads(context, channels);
      const thread = resolveThread(request.args.thread, threads);
      const messages = await context.store.listMessages({
        workspaceId: context.workspaceId,
        threadId: thread.thread.id,
      });
      const parent = request.args.to
        ? resolveMessageInThread(request.args.to, messages)
        : undefined;
      let decisionMessage: ChatMessage | undefined;
      if (request.args.resolve) {
        decisionMessage = resolveMessageInThread(request.args.resolve, messages);
        const decisions = await context.store.listThreadDecisions(
          context.workspaceId,
          thread.thread.id,
        );
        const decision = decisions.find(
          (candidate) => candidate.messageId === decisionMessage?.id,
        );
        if (!decision || decision.state !== "open") {
          throw new CliCommandError(
            `message is not an open decision: ${cliMessageId(decisionMessage.id)}`,
          );
        }
      }
      await context.assertWritable({ threadId: thread.thread.id });
      const [identity, attachments] = await Promise.all([
        options.identity(),
        resolveAttachments(context, request.args.cwd, request.args.attachments),
      ]);
      const message = await context.store.sendMessage({
        workspaceId: context.workspaceId,
        threadId: thread.thread.id,
        author: authorForActor(identity, request.args.actor),
        ...(identity.authorUserId ? { authorUserId: identity.authorUserId } : {}),
        ...(parent ? { parentMessageId: parent.id } : {}),
        origin: "cli",
        body: request.args.body,
        needsDecision: request.args.needsDecision,
        attachments,
      });
      linkRunMessage(context, {
        actor: request.args.actor,
        ...(request.args.runId ? { runId: request.args.runId } : {}),
        messageId: message.id,
      }, options);
      let resolvedByReply = false;
      let resolutionFailure: string | null = null;
      if (decisionMessage) {
        try {
          const resolution = await context.store.resolveChatDecision({
            workspaceId: context.workspaceId,
            threadId: thread.thread.id,
            messageId: decisionMessage.id,
            resolvedByMessageId: message.id,
          });
          resolvedByReply = resolution.resolvedByMessageId === message.id;
        } catch (error) {
          resolutionFailure = oneLine(
            error instanceof Error ? error.message : "decision update failed",
          );
          options.onError?.(error);
        }
      }
      if (request.args.actor === "agent") {
        try {
          await context.store.markThreadReadByAgent({
            workspaceId: context.workspaceId,
            threadId: thread.thread.id,
            upTo: { createdAtMs: message.createdAtMs, messageId: message.id },
          });
        } catch (error) {
          options.onError?.(error);
        }
      }
      await notifyWrite(options, context);
      if (decisionMessage && resolutionFailure) {
        throw new CliCommandError(
          `reply ${cliMessageId(message.id)} was posted, but decision ` +
          `${cliMessageId(decisionMessage.id)} could not be resolved: ${resolutionFailure}`,
        );
      }
      if (decisionMessage && !resolvedByReply) {
        throw new CliCommandError(
          `reply ${cliMessageId(message.id)} was posted, but decision ` +
          `${cliMessageId(decisionMessage.id)} was already resolved by another message`,
        );
      }
      return {
        threadId: cliThreadId(thread.thread.id),
        messageId: cliMessageId(message.id),
        ...(parent ? { parentMessageId: cliMessageId(parent.id) } : {}),
        ...(decisionMessage && resolvedByReply
          ? { resolvedMessageId: cliMessageId(decisionMessage.id) }
          : {}),
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
      await context.assertWritable({ threadId: target.thread.thread.id });
      const identity = await options.identity();
      const existing = await context.store.listReactions({
        workspaceId: context.workspaceId,
        threadId: target.thread.thread.id,
      });
      const active = existing.some(
        (reaction) =>
          reaction.messageId === target.rootMessage?.id &&
          reaction.emoji === request.args.emoji &&
          reaction.author.authorId === identity.reactionAuthorId,
      );
      const state = active ? "removed" : "added";
      await context.store.setReaction({
        workspaceId: context.workspaceId,
        threadId: target.thread.thread.id,
        messageId: target.rootMessage.id,
        emoji: request.args.emoji,
        author: {
          authorId: identity.reactionAuthorId,
          ...authorForActor(identity, request.args.actor),
        },
        state,
      });
      await notifyWrite(options, context);
      return {
        threadId: cliThreadId(target.thread.thread.id),
        messageId: cliMessageId(target.rootMessage.id),
        emoji: request.args.emoji,
        state,
      };
    }

    case "grep": {
      const threads = await loadThreads(context, channels);
      const scopedChannel = request.args.channel
        ? resolveChannel(request.args.channel, channels).cli
        : null;
      const scopedThread = request.args.thread
        ? resolveThread(request.args.thread, threads)
        : null;
      const selected = threads.filter((thread) =>
        (!scopedChannel || thread.channel.id === scopedChannel.id) &&
        (!scopedThread || thread.thread.id === scopedThread.thread.id),
      );
      // Substring grep asks FTS for candidate thread/message ids before any
      // bodies are loaded. A candidate thread is then loaded in full so
      // context lines remain exact; regex and FTS fallbacks retain the
      // deadline-bounded full scan.
      const fts = request.args.regex
        ? null
        : queryFtsCandidates(context, request.args.pattern);
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
            channel: thread.channel,
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
      } else if (request.args.scope.kind === "channel") {
        const channel = resolveChannel(request.args.scope.channel, channels);
        selected = threads.filter((thread) => thread.channel.id === channel.cli.id);
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
        const channelDir = join(outputRoot, safePathSegment(thread.channel.slug));
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
  const workspace = resolveCliWorkspace(request.args.cwd, options.listWorkspaces());
  if (!workspace) throw new CliCommandError("not inside a dohc workspace");
  if (workspace.readOnly) {
    throw new CliCommandError("chats are not available in a read-only shared view");
  }
  return options.openWorkspace(workspace);
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
  const deadline = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);

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
  if (platform === "win32") {
    throw new Error("dohc: CLI socket server is not yet supported on this platform");
  }

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const socketPath = join(options.stateDir, CLI_SOCKET_FILE);
  const tokenPath = join(options.stateDir, CLI_TOKEN_FILE);
  await Promise.all([
    rm(socketPath, { force: true }),
    rm(tokenPath, { force: true }),
  ]);
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(tokenPath, 0o600);

  const sockets = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  const server = createServer((socket) =>
    attachSocketHandler(socket, token, options, sockets, inFlight));
  server.maxConnections = MAX_SOCKET_CONNECTIONS;
  try {
    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
    await Promise.all([
      rm(socketPath, { force: true }),
      rm(tokenPath, { force: true }),
    ]);
    throw error;
  }
  server.unref();
  server.on("error", (error) => options.onError?.(error));
  const ready = Promise.resolve();

  let closed = false;
  return {
    socketPath,
    tokenPath,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      const serverClosed = closeServer(server);
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        serverClosed,
        ready,
        Promise.allSettled([...inFlight]),
      ]);
      await Promise.all([
        rm(socketPath, { force: true }),
        rm(tokenPath, { force: true }),
      ]);
    },
  };
}
