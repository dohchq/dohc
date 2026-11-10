import type {
  CliGroup,
  CliRequest,
  CliResultByVerb,
  CliShowThreadResult,
  CliStreamPosition,
} from "@dohc/cli/protocol";
import type {
  AgentRunRecord,
  ChannelThreadSummary,
  ChatAgentReader,
  ChatChannelSummary,
  ChatMessage,
  ChatStreamItem,
  ChatThread,
  LinkedChatStore,
  ThreadDispatchPauseState,
} from "@dohc/workspace-contracts/engine";
import { validateUserReadPath } from "@dohc/workspace-contracts/workspace-paths";
import {
  cliGroupKind,
  cliMessageId,
  cliShowMessage,
  cliThreadId,
  engineIdForHandle,
  FILES_GROUP,
  groupForCli,
  rawChatMessage,
  rawChatThread,
} from "./chatHandles";
import { failure, OperationError, pathRejected, type ErrorDetail } from "./results";

export { failure, OperationError, type ErrorDetail } from "./results";
export {
  authorForCli,
  cliGroupKind,
  cliMessageId,
  cliThreadId,
  FILES_GROUP,
  groupForCli,
} from "./chatHandles";

// The chat store reads these operations make, with the linked chat store's
// signatures. Each takes its workspace as the store does.
export type ChatReadStore = Pick<
  LinkedChatStore,
  | "ensureGeneralChannel"
  | "listChannels"
  | "getChannelWireId"
  | "listChannelThreads"
  | "listThreadsForFile"
  | "listThreads"
  | "listMessages"
  | "listThreadDecisions"
  | "getThreadProjection"
  | "listGroupStream"
  | "listAgentUnreadThreads"
>;

// A thread's pause state and its latest run, as `show` and `chat` report them.
export type DispatchFacts = CliShowThreadResult["dispatch"];

// The two dispatch store reads a thread's dispatch facts come from.
export interface ThreadDispatchReads {
  getThreadDispatchPauseState(workspaceId: string, threadId: string):
    Pick<ThreadDispatchPauseState, "paused"> | null | Promise<Pick<ThreadDispatchPauseState, "paused"> | null>;
  latestRunForThread(workspaceId: string, threadId: string): ThreadRun | null | Promise<ThreadRun | null>;
}
type ThreadRun = Pick<AgentRunRecord, "endedAtMs" | "exitCode" | "failureReason" | "failureHandled">;

export async function readThreadDispatchState(
  store: ThreadDispatchReads,
  workspaceId: string,
  threadId: string,
): Promise<DispatchFacts> {
  const [pause, run] = await Promise.all([
    store.getThreadDispatchPauseState(workspaceId, threadId),
    store.latestRunForThread(workspaceId, threadId),
  ]);
  const failureReason = run?.failureReason ?? (
    run?.endedAtMs !== undefined && run.exitCode === 0 && run.failureHandled
      ? "no-reply"
      : null
  );
  return {
    paused: pause?.paused ? "budget" : null,
    lastRun: run ? {
      state: run.endedAtMs === undefined ? "running" : failureReason || run.exitCode !== 0 ? "failed" : "completed",
      failureReason,
      exitCode: run.exitCode ?? null,
    } : null,
  };
}

// The channels a read created: General, the first time a writable
// workspace's chats are listed.
export interface ProvisionedChannel {
  workspaceId: string;
  added: ChatChannelSummary[];
}

export interface ChatsHost {
  workspaceId: string;
  store: ChatReadStore;
  fileObjectId(path: string): Promise<string | null>;
  filePath(objectId: string): Promise<string | null>;
  dispatch(threadId: string): Promise<DispatchFacts>;
  // General is created only when the workspace is writable.
  writable: boolean;
  // Awaited as soon as General is created, before any later read, so a read
  // that fails afterwards has still reported the change.
  provisioned(change: ProvisionedChannel): void | Promise<void>;
  // How much of an engine failure a failed result reports (results.ts).
  errorDetail: ErrorDetail;
}

export interface ChannelEntry {
  engine: ChatChannelSummary;
  cli: CliGroup;
}

export interface LoadedThread {
  thread: ChatThread;
  group: CliGroup;
  summary?: ChannelThreadSummary;
}

// An operation's arguments, less who is calling: the caller acts on that.
type Args<Verb extends CliRequest["verb"]> = Extract<CliRequest, { verb: Verb }>["args"] extends infer Each
  ? Each extends unknown ? Omit<Each, "cwd" | "actor" | "agentId"> : never
  : never;
type ShowStream = Extract<CliResultByVerb["show"], { stream: unknown }>;

// What marking a shown thread read needs, from the whole thread rather than
// the displayed branch: a person's place advances by the message count, an
// agent's to the latest message. `latest` is null for an empty thread.
export interface ShownThreadRead {
  threadId: string;
  messageCount: number;
  latest: { createdAtMs: number; messageId: string } | null;
}

export type ShowResult = ShowStream | { thread: CliShowThreadResult; read: ShownThreadRead };

async function provisionedChannels(host: ChatsHost): Promise<ChatChannelSummary[]> {
  // A read-only workspace's reads create nothing, so they report nothing.
  if (!host.writable) return await host.store.listChannels({ workspaceId: host.workspaceId });
  const before = await host.store.listChannels({ workspaceId: host.workspaceId });
  await host.store.ensureGeneralChannel({ workspaceId: host.workspaceId });
  const channels = await host.store.listChannels({ workspaceId: host.workspaceId });
  if (channels.length !== before.length) {
    const known = new Set(before.map((channel) => channel.id));
    await host.provisioned({
      workspaceId: host.workspaceId,
      added: channels.filter((channel) => !known.has(channel.id)),
    });
  }
  return channels;
}

export async function loadChannels(host: ChatsHost): Promise<ChannelEntry[]> {
  return (await provisionedChannels(host)).map((engine) => ({ engine, cli: groupForCli(engine) }));
}

export async function listChannelThreads(host: ChatsHost, channel: ChatChannelSummary) {
  // Any group can hold both lanes: an agent DM keeps its old posts beside its conversation.
  const pages = await Promise.all((["posts", "chat"] as const).map(lane => host.store.listChannelThreads({
    workspaceId: host.workspaceId, channelId: channel.id, lane,
  })));
  return pages.flat();
}

function withoutChannelMarker(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

function ambiguous(label: string, input: string, ids: readonly string[]): never {
  throw new OperationError(
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
  throw new OperationError(`no such ${label}: ${input}`);
}

export function resolveChannel(input: string, channels: readonly ChannelEntry[]): ChannelEntry {
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

// A group named exactly, by name, #slug or id. A prefix names a thread or
// message instead.
export function exactChannel(input: string, channels: readonly ChannelEntry[]): ChannelEntry | undefined {
  const normalized = withoutChannelMarker(input);
  const matches = channels.filter(({ engine, cli }) =>
    [cli.slug, cli.name, cli.id, engine.name, engine.id].includes(normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

// Every thread in the workspace. A thread no channel lists is linked to a
// file and goes to the files group.
export async function loadThreads(host: ChatsHost, channels: readonly ChannelEntry[]): Promise<LoadedThread[]> {
  const summaries = await Promise.all(
    channels.map(async ({ engine, cli }) => ({
      cli,
      summaries: await listChannelThreads(host, engine),
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
  const all = await host.store.listThreads({ workspaceId: host.workspaceId });
  for (const thread of all) {
    if (!byId.has(thread.id)) {
      byId.set(thread.id, { thread, group: FILES_GROUP });
    }
  }
  return [...byId.values()];
}

export async function loadMessagesByThread(
  host: ChatsHost,
  threads: readonly LoadedThread[],
): Promise<Map<string, ChatMessage[]>> {
  const entries = await Promise.all(
    threads.map(async (thread) => [
      thread.thread.id,
      await host.store.listMessages({
        workspaceId: host.workspaceId,
        threadId: thread.thread.id,
      }),
    ] as const),
  );
  return new Map(entries);
}

export function resolveThread(input: string, threads: readonly LoadedThread[]): LoadedThread {
  return resolveIdPrefix(
    input,
    "thread",
    threads,
    ({ thread }) => cliThreadId(thread.id),
    ({ thread }) => [thread.id],
  );
}

export function resolveMessageInThread(
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

export function resolveThreadOrMessage(
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

// Counts for the whole thread. A channel's summary already has them; a file's
// thread counts the messages it was given.
export async function threadCounts(
  host: ChatsHost,
  loaded: LoadedThread,
  messages: readonly ChatMessage[],
): Promise<{ commentCount: number; openDecisionCount: number }> {
  if (loaded.summary) {
    return {
      commentCount: Math.max(0, loaded.summary.messageCount - 1),
      openDecisionCount: loaded.summary.openDecisionCount,
    };
  }
  const decisions = await host.store.listThreadDecisions(
    host.workspaceId,
    loaded.thread.id,
  );
  return {
    commentCount: Math.max(0, messages.length - 1),
    openDecisionCount: decisions.filter((decision) => decision.state === "open").length,
  };
}

// The thread's counts come from all of its messages; the messages shown are
// the branch under `rootMessage` when one is named.
export async function buildThreadContent(
  host: ChatsHost,
  loaded: LoadedThread,
  allMessages: readonly ChatMessage[],
  rootMessage?: ChatMessage,
): Promise<Omit<CliShowThreadResult, "dispatch">> {
  const decisions = await host.store.listThreadDecisions(
    host.workspaceId,
    loaded.thread.id,
  );
  const decisionByMessage = new Map(
    decisions.map((decision) => [decision.messageId, decision]),
  );
  const counts = await threadCounts(host, loaded, allMessages);
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

// One page of a group's stream, read the same way by `dohc chat show <group>`
// and dohc_read_chat. `ids` picks CLI handles or engine ids for what it names.
async function readGroupStream(
  host: ChatsHost,
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
  const stream = await host.store.listGroupStream({
    workspaceId: host.workspaceId,
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
          ...(item.post.work ? {
            work: {
              status: item.post.work.status,
              ...(item.post.work.url === undefined ? {} : { url: item.post.work.url }),
              messageId: messageId(item.post.work.messageId),
              author: { kind: item.post.work.author.kind, displayName: item.post.work.author.displayName },
              reportedAtMs: item.post.work.reportedAtMs,
            },
          } : {}),
        },
      } : {}),
    })),
    nextBefore: stream.nextBefore && position(stream.nextBefore),
    readPosition: stream.readPosition && position(stream.readPosition),
  };
}

export async function listGroups(host: ChatsHost): Promise<CliResultByVerb["groups"]> {
  const channels = await loadChannels(host);
  return { groups: await Promise.all(channels.map(async ({ cli, engine }) => ({
    ...cli,
    channelWireId: await host.store.getChannelWireId({ workspaceId: host.workspaceId, channelId: engine.id }).catch(() => null),
  }))) };
}

// A person's unread comes from each thread's read cursor. An agent's comes
// from the threads the engine reports unread for `reader`.
export async function listGroupThreads(
  host: ChatsHost,
  input: { group: string; reader: ChatAgentReader | null },
): Promise<CliResultByVerb["threads"]> {
  const channel = resolveChannel(input.group, await loadChannels(host));
  const summaries = await listChannelThreads(host, channel.engine);
  const agentUnread = input.reader
    ? new Set(
        (await host.store.listAgentUnreadThreads(host.workspaceId, input.reader)).map(
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

export async function listGroupsWithThreads(host: ChatsHost): Promise<CliResultByVerb["groupsFull"]> {
  try {
    const channels = await provisionedChannels(host);
    const wireIds = await Promise.all(channels.map(channel =>
      host.store.getChannelWireId({ workspaceId: host.workspaceId, channelId: channel.id }).catch(() => null)));
    const withThreads = [];
    for (const [index, channel] of channels.entries()) {
      const threads = await listChannelThreads(host, channel);
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
    return failure(error, "failed to list groups", host.errorDetail);
  }
}

// `path` is workspace-relative. `platform` is the one whose path rules apply.
export async function listFileChats(
  host: ChatsHost,
  path: string,
  platform: string,
): Promise<CliResultByVerb["fileChats"]> {
  const validated = validateUserReadPath(path, { platform });
  if (!validated.ok) return pathRejected(validated.reason, path);
  try {
    const fileObjectId = await host.fileObjectId(validated.normalized);
    const threads = fileObjectId
      ? await host.store.listThreadsForFile({
          workspaceId: host.workspaceId,
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
    return failure(error, `failed to list chats for: ${path}`, host.errorDetail);
  }
}

// A thread or a group's stream under engine ids. It never creates General.
export async function readChat(host: ChatsHost, args: Args<"chat">): Promise<CliResultByVerb["chat"]> {
  if ("group" in args) {
    const { group, before, limit } = args;
    try {
      const channels = (await host.store.listChannels({ workspaceId: host.workspaceId }))
        .map((engine) => ({ engine, cli: groupForCli(engine) }));
      const channel = resolveChannel(group, channels).engine;
      const page = await readGroupStream(host, channel, { ...(before ? { before } : {}), ...(limit ? { limit } : {}) }, "engine");
      return {
        ok: true as const,
        stream: {
          group: { id: channel.id, name: groupForCli(channel).name, kind: cliGroupKind(channel.kind) },
          ...page,
          items: page.items.map(({ message, decision, ...item }) => ({ ...item, message: rawChatMessage(message, decision) })),
        },
      };
    } catch (error) {
      return failure(error, `failed to read group: ${group}`, host.errorDetail);
    }
  }
  const { threadId } = args;
  try {
    // The thread first, so a thread the store doesn't list reads as missing whatever its messages would answer.
    const threads = await host.store.listThreads({
      workspaceId: host.workspaceId,
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
    const messages = await host.store.listMessages({
      workspaceId: host.workspaceId,
      threadId,
    });
    const currentPath = thread.linkedFile
      ? await host.filePath(thread.linkedFile.objectId)
      : null;
    const projection = await host.store.getThreadProjection({
      workspaceId: host.workspaceId,
      threadId: thread.id,
      linkedFileAccess: currentPath
        ? { kind: "allowed", path: currentPath }
        : { kind: "unknown" },
    });
    const decisions = await host.store.listThreadDecisions(host.workspaceId, thread.id);
    const decisionByMessage = new Map(decisions.map((decision) => [decision.messageId, decision]));
    return {
      ok: true as const,
      thread: rawChatThread(thread),
      dispatch: await host.dispatch(thread.id),
      messages: messages.map((message) => rawChatMessage(message, decisionByMessage.get(message.id))),
      projection: {
        path: projection.path,
        readOnly: projection.readOnly,
        text: projection.text,
      },
    };
  } catch (error) {
    return failure(error, `failed to read chat: ${threadId}`, host.errorDetail);
  }
}

// A group's stream, or a thread with the branch under a named message. A
// stream marks nothing read; a thread returns what marking it read needs.
export async function showChat(host: ChatsHost, args: Args<"show">): Promise<ShowResult> {
  const channels = await loadChannels(host);
  const group = exactChannel(args.target, channels);
  if (group) {
    const page = await readGroupStream(host, group.engine, args, "cli");
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
  if (args.before || args.limit) {
    throw new OperationError("--before and --limit page a group's stream; name a group");
  }
  const threads = await loadThreads(host, channels);
  const messagesByThread = await loadMessagesByThread(host, threads);
  const target = resolveThreadOrMessage(args.target, threads, messagesByThread);
  const threadId = target.thread.thread.id;
  const messages = messagesByThread.get(threadId) ?? [];
  const thread = {
    ...await buildThreadContent(host, target.thread, messages, target.rootMessage),
    dispatch: await host.dispatch(threadId),
  };
  const latest = messages.length === 0
    ? null
    : messages.reduce((current, candidate) =>
        candidate.createdAtMs > current.createdAtMs ||
        (candidate.createdAtMs === current.createdAtMs && candidate.id > current.id)
          ? candidate
          : current);
  return {
    thread,
    read: {
      threadId,
      messageCount: messages.length,
      latest: latest && { createdAtMs: latest.createdAtMs, messageId: latest.id },
    },
  };
}
