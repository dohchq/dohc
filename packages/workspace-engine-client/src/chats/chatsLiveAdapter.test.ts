import { ProtocolShapeError } from "../wireSchema";
import { describe, expect, it, vi } from "vitest";
import { EngineRequestError } from "../daemon/engineClient";
import type { JsonValue, Request, Response } from "../protocol";
import {
  DaemonRefusalError,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import {
  CHATS_METHOD,
  decodeChatsResult,
  type ChatsMethod,
  type ChatsMethodParamsMap,
} from "./chatsWireContract";
import {
  ChatsAdapterCapabilityError,
  ChatsLiveAdapter,
} from "./chatsLiveAdapter";
import { ChatsLoopbackEngine } from "../testing/chatsLoopbackEngine";

const WORKSPACE = "ws-handle";
const SENTINEL = new Error("captured");

type ChatRequestCase = {
  method: ChatsMethod;
  params: ChatsMethodParamsMap[ChatsMethod];
};

const CHAT_REQUEST_CASES: ChatRequestCase[] = [
  { method: CHATS_METHOD.channelCreate, params: { channelId: "c", name: "C", kind: "channel" } },
  { method: CHATS_METHOD.channelEnsureAgent, params: { channelId: "agent", agentId: "default", name: "Nova" } },
  { method: CHATS_METHOD.channelEnsureGeneral, params: { channelId: "general" } },
  { method: CHATS_METHOD.channelFindBySlug, params: { slug: "general" } },
  { method: CHATS_METHOD.channelsList, params: {} },
  { method: CHATS_METHOD.channelGetWireId, params: { channelId: "c" } },
  {
    method: CHATS_METHOD.threadStart,
    params: {
      channelId: "c",
      threadId: "t",
      messageId: "m",
      authorKind: "human",
      authorDisplayName: "Sam",
      body: "hello",
    },
  },
  {
    method: CHATS_METHOD.threadCreate,
    params: { threadId: "t", title: "T", linkedFile: { objectId: "o" } },
  },
  { method: CHATS_METHOD.threadsList, params: {} },
  { method: CHATS_METHOD.threadsListForFile, params: { objectId: "o" } },
  { method: CHATS_METHOD.threadsListForChannel, params: { channelId: "c" } },
  { method: CHATS_METHOD.threadFindChannelId, params: { threadId: "t" } },
  { method: CHATS_METHOD.threadRevision, params: { threadId: "t" } },
  { method: CHATS_METHOD.threadGetProjection, params: { threadId: "t" } },
  {
    method: CHATS_METHOD.messageSend,
    params: {
      threadId: "t",
      messageId: "m",
      authorKind: "agent",
      authorDisplayName: "Agent",
      body: "done",
    },
  },
  { method: CHATS_METHOD.messagesList, params: { threadId: "t" } },
  { method: CHATS_METHOD.readStateGet, params: { threadId: "t" } },
  {
    method: CHATS_METHOD.readStateMarkThreadRead,
    params: { threadId: "t", upToSequence: 1 },
  },
  {
    method: CHATS_METHOD.decisionResolve,
    params: { threadId: "t", messageId: "m", resolvedByMessageId: "m2" },
  },
  { method: CHATS_METHOD.decisionsListForThread, params: { threadId: "t" } },
  {
    method: CHATS_METHOD.reactionSet,
    params: {
      threadId: "t",
      messageId: "m",
      emoji: "👍",
      author: { authorId: "u", kind: "human", displayName: "Sam" },
      state: "added",
    },
  },
  { method: CHATS_METHOD.reactionsList, params: { threadId: "t" } },
  { method: CHATS_METHOD.attachmentsListForThread, params: { threadId: "t" } },
  { method: CHATS_METHOD.attachmentsListFileMentions, params: { subject: {objectId: "o"}, scope: "grant", sharedChannelRowsUncovered: 0 } },
  { method: CHATS_METHOD.mentionsListForHandle, params: { handle: "agent" } },
  { method: CHATS_METHOD.agentReadListUnreadRequests, params: { reader: { kind: "run", runId: "run_1" } } },
  { method: CHATS_METHOD.agentReadListUnreadRequests, params: { reader: { kind: "unnamed" } } },
  {
    method: CHATS_METHOD.agentReadListRequestsPage,
    params: {
      reader: { kind: "connected", agentId: "terminal", handle: "terminal", requesters: ["u"], unattributedCounts: false },
      threadId: "t",
      after: { createdAtMs: 1, messageId: "m" },
    },
  },
  { method: CHATS_METHOD.agentReadListUnreadThreads, params: { reader: { kind: "unnamed" } } },
  {
    method: CHATS_METHOD.agentReadMarkThreadRead,
    params: { reader: { kind: "unnamed" }, threadId: "t", upTo: { createdAtMs: 1, messageId: "m" } },
  },
  {
    method: CHATS_METHOD.followsSet,
    params: {
      ownerUserId: "u",
      targetKind: "thread",
      targetId: "t",
      state: "following",
    },
  },
  { method: CHATS_METHOD.followsList, params: { ownerUserId: "u" } },
  { method: CHATS_METHOD.followsEnsureDefaults, params: { ownerUserId: "u" } },
  {
    method: CHATS_METHOD.feedMarkSeen,
    params: { ownerUserId: "u", headCursor: "cursor" },
  },
  { method: CHATS_METHOD.feedListPersonal, params: { ownerUserId: "u" } },
  {
    method: CHATS_METHOD.bookmarkSave,
    params: {
      ownerUserId: "u",
      targetKind: "thread",
      targetId: "t",
      mode: "live",
      destinationPath: "bookmark.md",
    },
  },
  { method: CHATS_METHOD.bookmarksList, params: { ownerUserId: "u" } },
  { method: CHATS_METHOD.bookmarkFind, params: { ownerUserId: "u", bookmarkId: "b" } },
  { method: CHATS_METHOD.bookmarkListPending, params: { ownerUserId: "u" } },
  {
    method: CHATS_METHOD.bookmarkMarkReady,
    params: { ownerUserId: "u", bookmarkId: "b", generation: 1 },
  },
  { method: CHATS_METHOD.bookmarkArchive, params: { ownerUserId: "u", bookmarkId: "b" } },
  { method: CHATS_METHOD.bookmarkMarkPending, params: { ownerUserId: "u", bookmarkId: "b" } },
  {
    method: CHATS_METHOD.bookmarkMarkFailed,
    params: { ownerUserId: "u", bookmarkId: "b", generation: 1, failureReason: "failed" },
  },
  {
    method: CHATS_METHOD.bookmarkMarkStale,
    params: { ownerUserId: "u", bookmarkId: "b", generation: 1 },
  },
  {
    method: CHATS_METHOD.dispatchEnqueue,
    params: { triggerMessageId: "m", threadId: "t", agentId: "default" },
  },
  { method: CHATS_METHOD.dispatchClaimNextPending, params: { agentId: "default", runId: "r" } },
  { method: CHATS_METHOD.dispatchListPending, params: {} },
  { method: CHATS_METHOD.dispatchOpenRuns, params: {} },
  { method: CHATS_METHOD.dispatchListRunMessages, params: { runId: "r" } },
  { method: CHATS_METHOD.dispatchRunIdForMessage, params: { messageId: "m" } },
  { method: CHATS_METHOD.dispatchRunRecordsForThread, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchGetRunRecord, params: { runId: "r" } },
  { method: CHATS_METHOD.dispatchLatestRunForThread, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchIsThreadPaused, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchGetThreadPauseState, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchRecentCount, params: { threadId: "t", sinceMs: 0 } },
  {
    method: CHATS_METHOD.dispatchFailPendingForThread,
    params: { threadId: "t", agentId: "default", reason: "stop" },
  },
  {
    method: CHATS_METHOD.dispatchRecordRunMessage,
    params: { messageId: "m", runId: "r" },
  },
  {
    method: CHATS_METHOD.dispatchSetThreadPaused,
    params: { threadId: "t", paused: true },
  },
  { method: CHATS_METHOD.dispatchMarkFailureHandled, params: { runId: "r" } },
  {
    method: CHATS_METHOD.dispatchRequeueFailedTrigger,
    params: { triggerMessageId: "m", runId: "r" },
  },
  { method: CHATS_METHOD.dispatchListFailedRunRecoveries, params: {} },
  {
    method: CHATS_METHOD.dispatchComplete,
    params: { runId: "r", exitCode: 0 },
  },
  {
    method: CHATS_METHOD.dispatchFail,
    params: { runId: "r", reason: "failed" },
  },
];

const channel = {
  workspaceId: "workspace",
  channelId: "channel",
  name: "General",
  slug: "general",
  kind: "channel",
  type: "posts",
  purpose: "",
  createdAtMs: 1,
  updatedAtMs: 2,
};
const threadWire = {
  workspaceId: "workspace",
  threadId: "thread",
  title: "Thread",
  createdAtMs: 1,
  updatedAtMs: 2,
  lane: "posts",
  channelId: "channel",
  linkedObjectId: null,
};
const message = {
  id: "message",
  workspaceId: "workspace",
  threadId: "thread",
  author: { kind: "human", displayName: "Sam" },
  body: "hello",
  createdAtMs: 2,
  attachments: [],
};
const readState = {
  workspaceId: "workspace",
  threadId: "thread",
  lastReadSequence: 1,
  revision: 1,
  updatedAtMs: 2,
};
const follow = {
  workspaceId: "workspace",
  ownerUserId: "owner",
  targetKind: "thread",
  targetId: "thread",
  state: "following",
  updatedAtMs: 2,
};
const feedReadState = {
  workspaceId: "workspace",
  ownerUserId: "owner",
  lastSeenCreatedAtMs: 2,
  lastSeenMessageId: "message",
  updatedAtMs: 3,
};
const bookmark = {
  bookmarkId: "bookmark",
  workspaceId: "workspace",
  ownerUserId: "owner",
  targetKind: "thread",
  targetId: "thread",
  threadId: "thread",
  mode: "live",
  destinationPath: "bookmark.md",
  state: "active",
  generation: 1,
  projectedGeneration: 0,
  projectionState: "pending",
  createdAtMs: 1,
  updatedAtMs: 2,
};
const dispatch = {
  workspaceId: "workspace",
  triggerMessageId: "trigger",
  agentId: "default",
  threadId: "thread",
  state: "pending",
  attemptCount: 0,
  createdAtMs: 1,
  updatedAtMs: 2,
};
const run = {
  workspaceId: "workspace",
  runId: "run",
  threadId: "thread",
  triggerMessageId: "trigger",
  agentId: "default",
  command: "codex",
  startedAtMs: 3,
  failureHandled: false,
};

const NEW_DECODER_CASES: Array<{
  method: ChatsMethod;
  valid: JsonValue;
}> = [
  { method: CHATS_METHOD.channelCreate, valid: channel },
  { method: CHATS_METHOD.channelEnsureAgent, valid: channel },
  { method: CHATS_METHOD.channelEnsureGeneral, valid: channel },
  { method: CHATS_METHOD.channelFindBySlug, valid: null },
  {
    method: CHATS_METHOD.channelsList,
    valid: { channels: [{ ...channel, threadCount: 1, unreadCount: 0 }], nextCursor: null },
  },
  { method: CHATS_METHOD.threadsList, valid: { threads: [threadWire], nextCursor: null } },
  { method: CHATS_METHOD.threadRevision, valid: { revision: 1 } },
  {
    method: CHATS_METHOD.messagesList,
    valid: { messages: [message], nextAfterMessageOrder: null },
  },
  { method: CHATS_METHOD.readStateGet, valid: readState },
  { method: CHATS_METHOD.readStateMarkThreadRead, valid: readState },
  { method: CHATS_METHOD.followsSet, valid: follow },
  { method: CHATS_METHOD.followsList, valid: { follows: [follow], nextCursor: null } },
  { method: CHATS_METHOD.feedMarkSeen, valid: feedReadState },
  { method: CHATS_METHOD.bookmarkSave, valid: bookmark },
  { method: CHATS_METHOD.bookmarksList, valid: { bookmarks: [bookmark], nextCursor: null } },
  {
    method: CHATS_METHOD.bookmarkMarkReady,
    valid: { bookmark, applied: true },
  },
  { method: CHATS_METHOD.dispatchEnqueue, valid: { enqueued: true } },
  { method: CHATS_METHOD.dispatchComplete, valid: { completed: true } },
  { method: CHATS_METHOD.dispatchFail, valid: { failed: true } },
];

function renameField(
  value: { [key: string]: JsonValue | undefined },
  from: string,
  to: string,
): JsonValue {
  const renamed = { ...value };
  renamed[to] = renamed[from];
  delete renamed[from];
  return renamed;
}

const STRICT_NEGATIVE_CASES: Array<{
  method: ChatsMethod;
  wrongFieldName: JsonValue;
  wrongEnumSpelling: JsonValue;
}> = [
  {
    method: CHATS_METHOD.channelCreate,
    wrongFieldName: renameField(channel, "channelId", "channel_id"),
    wrongEnumSpelling: { ...channel, kind: "Channel" },
  },
  {
    method: CHATS_METHOD.messageSend,
    wrongFieldName: renameField(message, "createdAtMs", "created_at_ms"),
    wrongEnumSpelling: {
      ...message,
      author: { ...message.author, kind: "Human" },
    },
  },
  {
    method: CHATS_METHOD.decisionResolve,
    wrongFieldName: renameField(
      {
        threadId: "thread",
        messageId: "message",
        state: "resolved",
        resolvedByMessageId: "reply",
        atMs: 3,
      },
      "resolvedByMessageId",
      "resolved_by_message_id",
    ),
    wrongEnumSpelling: {
      threadId: "thread",
      messageId: "message",
      state: "Resolved",
      resolvedByMessageId: "reply",
      atMs: 3,
    },
  },
  {
    method: CHATS_METHOD.reactionSet,
    wrongFieldName: renameField(
      {
        reactionId: "reaction",
        threadId: "thread",
        messageId: "message",
        emoji: "👍",
        author: { authorId: "owner", kind: "human", displayName: "Sam" },
        state: "added",
        atMs: 3,
      },
      "reactionId",
      "reaction_id",
    ),
    wrongEnumSpelling: {
      reactionId: "reaction",
      threadId: "thread",
      messageId: "message",
      emoji: "👍",
      author: { authorId: "owner", kind: "human", displayName: "Sam" },
      state: "Added",
      atMs: 3,
    },
  },
  {
    method: CHATS_METHOD.followsSet,
    wrongFieldName: renameField(follow, "ownerUserId", "owner_user_id"),
    wrongEnumSpelling: { ...follow, state: "Following" },
  },
  {
    method: CHATS_METHOD.bookmarkSave,
    wrongFieldName: renameField(
      bookmark,
      "projectionState",
      "projection_state",
    ),
    wrongEnumSpelling: { ...bookmark, projectionState: "Pending" },
  },
  {
    method: CHATS_METHOD.dispatchListPending,
    wrongFieldName: {
      dispatches: [renameField(dispatch, "attemptCount", "attempt_count")],
      nextCursor: null,
    },
    wrongEnumSpelling: {
      dispatches: [{ ...dispatch, state: "Pending" }],
      nextCursor: null,
    },
  },
];

function captureClient(requests: Request[]): MinimalDaemonClient {
  return {
    close: () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      throw SENTINEL;
    },
  };
}

function mockDaemon(
  requests: Request[],
  respond: (request: Request, index: number) => JsonValue | Promise<JsonValue>,
): MinimalDaemonClient {
  return {
    close: () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      return {
        id: request.id,
        result: await respond(request, requests.length - 1),
      };
    },
  };
}

function loopbackAdapter(): {
  adapter: ChatsLiveAdapter;
  loopback: ChatsLoopbackEngine;
} {
  const loopback = new ChatsLoopbackEngine();
  let nextId = 0;
  const adapter = new ChatsLiveAdapter(
    {
      sendRequest: (request) => loopback.sendRequest(request),
      close: () => undefined,
    },
    WORKSPACE,
    {
      workspaceId: "workspace",
      createId: (kind) => `${kind}-${++nextId}`,
    },
  );
  return { adapter, loopback };
}

// The reader scenarios mirror the engine's tests in chats_agent_state.rs, so
// the loopback and the engine answer each one the same way.
const UNNAMED = { kind: "unnamed" as const };

function terminal(requesters: string[], unattributedCounts: boolean) {
  return { kind: "connected" as const, agentId: "terminal", handle: "terminal", requesters, unattributedCounts };
}

type PostOptions = { kind?: "human" | "agent"; agentId?: string; userId?: string | null; origin?: "cli" };

// A post whose id is its body. The first post in a thread starts it. A
// person's post is Ada's unless it names another account or none.
function readerFixture() {
  const { adapter, loopback } = loopbackAdapter();
  const started = new Set<string>();
  const post = async (channelId: string, threadId: string, messageId: string, options: PostOptions = {}) => {
    const kind = options.kind ?? "human";
    const userId = options.userId === undefined ? (kind === "human" ? "ada" : undefined) : options.userId ?? undefined;
    const input = {
      workspaceId: "workspace", threadId, messageId, authorActorKey: null, body: messageId,
      author: { kind, displayName: kind === "human" ? "Ada" : "Terminal" },
      ...(userId === undefined ? {} : { authorUserId: userId }),
      ...(options.agentId === undefined ? {} : { authorAgentId: options.agentId }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    };
    if (started.has(threadId)) return await adapter.sendMessage(input);
    started.add(threadId);
    return (await adapter.startChannelThread({ ...input, channelId })).message;
  };
  return { adapter, loopback, post };
}

async function agentChats(adapter: ChatsLiveAdapter) {
  const channel = await adapter.createChannel({ workspaceId: "workspace", name: "Channel" });
  const chat = await adapter.ensureAgentChannel({ workspaceId: "workspace", agentId: "terminal", name: "Terminal" });
  const research = await adapter.ensureAgentChannel({ workspaceId: "workspace", agentId: "research", name: "Research" });
  return { channel: channel.channelId, terminal: chat.channelId, research: research.channelId };
}

async function requestIds(adapter: ChatsLiveAdapter, reader: typeof UNNAMED | ReturnType<typeof terminal>) {
  return (await adapter.listAgentUnreadRequests("workspace", reader)).map(row => row.messageId);
}

describe("ChatsLiveAdapter", () => {
  it("keeps a posted-thread reply that also requests a dohc agent", async () => {
    const { adapter } = loopbackAdapter();
    const channel = await adapter.ensureGeneralChannel({ workspaceId: "workspace" });
    const started = await adapter.startChannelThread({
      authorActorKey: null, workspaceId: "workspace", channelId: channel.channelId,
      author: { kind: "agent", displayName: "Connected agent" }, body: "Joining the thread",
    });
    const reply = await adapter.sendMessage({
      authorActorKey: null, workspaceId: "workspace", threadId: started.thread.id,
      author: { kind: "human", displayName: "Sam" }, body: "@Research please also look",
      wakeAgentIds: ["research"],
    });
    expect((await adapter.listAgentUnreadRequests("workspace", UNNAMED)).map(row => row.messageId)).toEqual([reply.id]);
  });

  it("leaves agent chats to their agents when the reader gave no name", async () => {
    const { adapter } = loopbackAdapter();
    const channel = await adapter.ensureAgentChannel({ workspaceId: "workspace", agentId: "default", name: "Nova" });
    const started = await adapter.startChannelThread({
      authorActorKey: null, workspaceId: "workspace", channelId: channel.channelId,
      author: { kind: "human", displayName: "Sam" }, body: "Please look",
    });
    const send = (kind: "human" | "agent", body: string) => adapter.sendMessage({
      authorActorKey: null, workspaceId: "workspace", threadId: started.thread.id,
      author: { kind, displayName: kind }, body,
    });
    await send("agent", "Answered");
    const later = await send("human", "@agent one more question");
    expect(await adapter.listAgentUnreadRequests("workspace", UNNAMED)).toEqual([]);
    expect(await adapter.listAgentUnreadThreads("workspace", UNNAMED)).toEqual([]);
    const nova = { kind: "connected" as const, agentId: "default", handle: "nova", requesters: [], unattributedCounts: true };
    expect((await adapter.listAgentUnreadRequests("workspace", nova)).map(row => row.messageId))
      .toEqual([started.message.id, later.id]);
  });

  it("reads an agent you run's chat, mentions, and threads it posted in, for its person only", async () => {
    const { adapter, post } = readerFixture();
    const { channel, terminal: chat, research } = await agentChats(adapter);
    await post(chat, "dm", "dm-ask");
    await post(channel, "group", "ask @terminal");
    await post(channel, "posted", "opening");
    await post(channel, "posted", "terminal-post", { kind: "agent", agentId: "terminal" });
    await post(channel, "posted", "reply");
    await post(research, "other", "other-ask");
    await post(research, "other", "other @terminal");
    await post(chat, "dm", "terminal-reply", { kind: "agent", agentId: "terminal" });
    await post(chat, "dm", "from-cli", { origin: "cli" });
    await post(chat, "dm", "bob-ask", { userId: "bob" });
    await post(channel, "group", "plain");

    expect(await requestIds(adapter, terminal(["ada"], false)))
      .toEqual(["dm-ask", "ask @terminal", "reply", "other @terminal"]);
    expect(await requestIds(adapter, UNNAMED)).toEqual([]);
  });

  it("keeps each reader's own place in a thread", async () => {
    const { adapter, post } = readerFixture();
    const { channel } = await agentChats(adapter);
    await post(channel, "group", "own", { kind: "agent" });
    const ask = await post(channel, "group", "ask @terminal");
    const reader = terminal(["ada"], false);
    expect(await requestIds(adapter, reader)).toEqual(["ask @terminal"]);
    expect(await requestIds(adapter, UNNAMED)).toEqual(["ask @terminal"]);

    const upTo = (message: { id: string; createdAtMs: number }) =>
      ({ createdAtMs: message.createdAtMs, messageId: message.id });
    await adapter.markThreadReadByAgent({ workspaceId: "workspace", reader, threadId: "group", upTo: upTo(ask) });
    expect(await requestIds(adapter, reader)).toEqual([]);
    expect(await requestIds(adapter, UNNAMED)).toEqual(["ask @terminal"]);
    expect(await adapter.listAgentUnreadThreads("workspace", UNNAMED)).toHaveLength(1);
    expect(await adapter.listAgentUnreadThreads("workspace", reader)).toEqual([]);

    const again = await post(channel, "group", "again @terminal");
    await adapter.markThreadReadByAgent({
      workspaceId: "workspace", reader: UNNAMED, threadId: "group", upTo: upTo(again),
    });
    expect(await requestIds(adapter, reader)).toEqual(["again @terminal"]);
    const state = await adapter.markThreadReadByAgent({
      workspaceId: "workspace", reader, threadId: "group", upTo: upTo(again), expectedRevision: 1,
    });
    expect(state.revision).toBe(2);
  });

  it("asks an agent you run only with its person's posts", async () => {
    const { adapter, post } = readerFixture();
    const { terminal: chat } = await agentChats(adapter);
    await post(chat, "dm", "mine", { userId: "me" });
    await post(chat, "dm", "owners", { userId: "owner" });
    await post(chat, "dm", "no-account", { userId: null });

    expect(await requestIds(adapter, terminal(["me"], false))).toEqual(["mine"]);
    expect(await requestIds(adapter, terminal(["me"], true))).toEqual(["mine", "no-account"]);
    expect(await requestIds(adapter, terminal([], false))).toEqual([]);
    expect(await requestIds(adapter, terminal(["me", "owner", "me"], false))).toEqual(["mine", "owners"]);
  });

  it("checks a connected reader and binds a cursor to it", async () => {
    const { adapter, post } = readerFixture();
    const { terminal: chat } = await agentChats(adapter);
    await post(chat, "dm", "first");
    await post(chat, "dm", "second");
    // Sent as raw params, so a malformed reader reaches the engine's checks.
    const read = (reader: JsonValue, cursor?: string) => adapter.request(
      CHATS_METHOD.agentReadListUnreadRequests,
      { reader, pageLimit: 1, ...(cursor === undefined ? {} : { cursor }) } as never,
    );
    const first = await read(terminal(["ada"], false));
    expect(first.requests.map(row => row.messageId)).toEqual(["first"]);
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error("expected a second page");
    await expect(read(terminal(["bob"], false), cursor)).rejects.toThrow("invalid-cursor");
    await expect(read({ ...terminal([], true), agentId: "Terminal" })).rejects.toThrow("invalid-input");
    await expect(read({ ...terminal([], true), handle: "@" })).rejects.toThrow("invalid-message-body");
    const tooMany = Array.from({ length: 65 }, (_, index) => `account-${index}`);
    await expect(read(terminal(tooMany, false))).rejects.toThrow("invalid-input");
    await expect(read({ kind: "unnamed", agentId: "terminal" })).rejects.toThrow("invalid-parameters");
    await expect(read({ kind: "run", runId: "no-such-run" })).rejects.toThrow("run-not-found");
  });

  it("pages requests by Group, thread, and coordinate with what a wait shows", async () => {
    const { adapter, post } = readerFixture();
    const { channel, terminal: chat } = await agentChats(adapter);
    await post(chat, "dm", "dm-ask");
    const ask = await post(channel, "group", "ask @terminal");
    await post(channel, "group", "more @terminal");
    const reader = terminal(["ada"], false);
    const page = async (filter: { channelId?: string; threadId?: string; after?: { createdAtMs: number; messageId: string } }) =>
      (await adapter.listAgentRequestsPage({ workspaceId: "workspace", reader, ...filter })).requests.map(row => row.messageId);

    expect(await page({})).toEqual(["dm-ask", "ask @terminal", "more @terminal"]);
    expect(await page({ channelId: channel })).toEqual(["ask @terminal", "more @terminal"]);
    expect(await page({ threadId: "dm" })).toEqual(["dm-ask"]);
    expect(await page({ channelId: chat, threadId: "group" })).toEqual([]);
    expect(await page({ after: { createdAtMs: ask.createdAtMs, messageId: ask.id } })).toEqual(["more @terminal"]);
    expect(await adapter.listAgentRequestsPage({ workspaceId: "workspace", reader, limit: 1 })).toMatchObject({
      requests: [{
        threadId: "dm",
        messageId: "dm-ask",
        channel: { id: chat, kind: "agent", name: "Terminal", slug: "my-agent-terminal", purpose: "" },
        author: { kind: "human", displayName: "Ada" },
        body: "dm-ask",
      }],
      more: true,
    });
  });

  it("matches a post's account after trimming it, as the engine stores it", async () => {
    const { adapter, post } = readerFixture();
    const { terminal: chat } = await agentChats(adapter);
    await post(chat, "dm", "spaced", { userId: " ada " });
    expect(await requestIds(adapter, terminal(["ada"], false))).toEqual(["spaced"]);
  });

  it("cuts a requests page at the engine's 256 KiB and continues after it", async () => {
    const { adapter } = readerFixture();
    const { terminal: chat } = await agentChats(adapter);
    const body = "x".repeat(64 * 1024);
    const author = { kind: "human" as const, displayName: "Ada" };
    const started = await adapter.startChannelThread({
      workspaceId: "workspace", channelId: chat, threadId: "dm", messageId: "ask-1",
      authorActorKey: null, authorUserId: "ada", author, body,
    });
    for (const messageId of ["ask-2", "ask-3", "ask-4", "ask-5"]) {
      await adapter.sendMessage({
        workspaceId: "workspace", threadId: started.thread.id, messageId,
        authorActorKey: null, authorUserId: "ada", author, body,
      });
    }
    const reader = terminal(["ada"], false);
    const first = await adapter.listAgentRequestsPage({ workspaceId: "workspace", reader });
    expect(first.requests.map(row => row.messageId)).toEqual(["ask-1", "ask-2", "ask-3"]);
    expect(first.more).toBe(true);
    const last = first.requests[2];
    if (last === undefined) throw new Error("expected three requests");
    const rest = await adapter.listAgentRequestsPage({
      workspaceId: "workspace", reader, after: { createdAtMs: last.createdAtMs, messageId: last.messageId },
    });
    expect(rest.requests.map(row => row.messageId)).toEqual(["ask-4", "ask-5"]);
    expect(rest.more).toBe(false);
  });

  it("encodes every chats request case with the workspace handle and exact params", async () => {
    expect(CHAT_REQUEST_CASES).toHaveLength(64);
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    for (const entry of CHAT_REQUEST_CASES) {
      await expect(
        adapter.request(entry.method as never, entry.params as never),
      ).rejects.toBe(SENTINEL);
      expect(requests.at(-1)).toMatchObject({
        method: entry.method,
        workspace: WORKSPACE,
        params: entry.params,
      });
    }
  });

  it.each(NEW_DECODER_CASES)(
    "strictly decodes the daemon payload for $method",
    ({ method, valid }) => {
      expect(() => decodeChatsResult(method as never, valid)).not.toThrow();
      expect(() =>
        decodeChatsResult(method as never, { unexpected: true }),
      ).toThrow(ProtocolShapeError);
    },
  );

  it.each(STRICT_NEGATIVE_CASES)(
    "rejects wrong field names and enum spellings for $method",
    ({ method, wrongFieldName, wrongEnumSpelling }) => {
      expect(() =>
        decodeChatsResult(method as never, wrongFieldName),
      ).toThrow(ProtocolShapeError);
      expect(() =>
        decodeChatsResult(method as never, wrongEnumSpelling),
      ).toThrow(ProtocolShapeError);
    },
  );

  it("maps thread wire records into store threads, including the documented linked-file substitution", async () => {
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, () => ({
        threads: [
          {
            workspaceId: "workspace",
            threadId: "linked-thread",
            title: "Linked",
            createdAtMs: 11,
            updatedAtMs: 12,
            lane: "posts",
            channelId: null,
            linkedObjectId: "object-1",
          },
          {
            workspaceId: "workspace",
            threadId: "channel-thread",
            title: "Channel",
            createdAtMs: 21,
            updatedAtMs: 22,
            lane: "chat",
            channelId: "channel-1",
            linkedObjectId: null,
          },
        ],
        nextCursor: null,
      })),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    const threads = await adapter.listThreads({ workspaceId: "workspace" });
    expect(threads).toEqual([
      {
        id: "linked-thread",
        workspaceId: "workspace",
        title: "Linked",
        createdAtMs: 11,
        updatedAtMs: 12,
        lane: "posts",
        linkedFile: {
          objectId: "object-1",
          // thread_json has no linkedAtMs, so the adapter substitutes createdAtMs.
          linkedAtMs: 11,
        },
      },
      {
        id: "channel-thread",
        workspaceId: "workspace",
        title: "Channel",
        createdAtMs: 21,
        updatedAtMs: 22,
        lane: "chat",
        channelId: "channel-1",
      },
    ]);
    expect(requests).toEqual([
      {
        id: 1,
        method: CHATS_METHOD.threadsList,
        workspace: WORKSPACE,
        params: { pageLimit: 500 },
      },
    ]);
    expect(threads[0]?.linkedFile).not.toHaveProperty("pathHint");
  });

  it("attaches stable, per-operation idempotency keys to the two daemon-required methods", async () => {
    const requests: Request[] = [];
    let threadSequence = 0;
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, (request) =>
        request.method === CHATS_METHOD.threadCreate
          ? {
              id: (request.params as { threadId: string }).threadId,
              workspaceId: "workspace",
              title: "Thread",
              createdAtMs: 1,
              updatedAtMs: 1,
              linkedFile: { objectId: "object", linkedAtMs: 1 },
            }
          : bookmark,
      ),
      WORKSPACE,
      {
        workspaceId: "workspace",
        createId: (kind) =>
          kind === "thread"
            ? `thread-${++threadSequence}`
            : `${kind}-unused`,
      },
    );

    await adapter.createThread({
      workspaceId: "workspace",
      title: "One",
      linkedFile: { objectId: "object" },
    });
    await adapter.createThread({
      workspaceId: "workspace",
      title: "Two",
      linkedFile: { objectId: "object" },
    });
    await adapter.markBookmarkPending({
      workspaceId: "workspace",
      ownerUserId: "owner",
      bookmarkId: "bookmark-1",
    });
    await adapter.markBookmarkPending({
      workspaceId: "workspace",
      ownerUserId: "owner",
      bookmarkId: "bookmark-1",
    });

    const keys = requests.map((request) => request.idempotencyKey);
    expect(keys.slice(0, 2)).toEqual(["thread-1", "thread-2"]);
    expect(keys[2]).toMatch(/^bookmark-1:pending:[0-9a-f-]{36}$/);
    expect(keys[3]).toMatch(/^bookmark-1:pending:[0-9a-f-]{36}$/);
    expect(requests[0]?.idempotencyKey).toBe(
      (requests[0]?.params as { threadId: string }).threadId,
    );
    expect(requests[1]?.idempotencyKey).toBe(
      (requests[1]?.params as { threadId: string }).threadId,
    );
    expect(keys[2]?.startsWith(
      `${(requests[2]?.params as { bookmarkId: string }).bookmarkId}:pending:`,
    )).toBe(true);
    expect(keys[3]?.startsWith(
      `${(requests[3]?.params as { bookmarkId: string }).bookmarkId}:pending:`,
    )).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("assembles cursor pages, threads the cursor, and stops at null", async () => {
    const requests: Request[] = [];
    const first = { ...dispatch, triggerMessageId: "trigger-1" };
    const second = { ...dispatch, triggerMessageId: "trigger-2" };
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, (_request, index) =>
        index === 0
          ? { dispatches: [first], nextCursor: "page-2" }
          : { dispatches: [second], nextCursor: null },
      ),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(adapter.listPending("workspace")).resolves.toEqual([
      first,
      second,
    ]);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: CHATS_METHOD.dispatchListPending,
        params: { pageLimit: 500 },
      },
      {
        method: CHATS_METHOD.dispatchListPending,
        params: { pageLimit: 500, cursor: "page-2" },
      },
    ]);
    expect(requests).toHaveLength(2);
  });

  it("paginates every named aggregate list until its cursor is exhausted", async () => {
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, (request) => {
        const cursor = (request.params as { cursor?: string }).cursor;
        const nextCursor = cursor === undefined ? "page-2" : null;
        switch (request.method) {
          case CHATS_METHOD.channelsList:
            return {
              channels: [
                {
                  ...channel,
                  channelId: cursor === undefined ? "channel-1" : "channel-2",
                  threadCount: 0,
                  unreadCount: 0,
                },
              ],
              nextCursor,
            };
          case CHATS_METHOD.threadsList:
            return {
              threads: [
                {
                  ...threadWire,
                  threadId: cursor === undefined ? "thread-1" : "thread-2",
                },
              ],
              nextCursor,
            };
          case CHATS_METHOD.followsList:
            return {
              follows: [
                {
                  ...follow,
                  targetId: cursor === undefined ? "target-1" : "target-2",
                },
              ],
              nextCursor,
            };
          case CHATS_METHOD.bookmarksList:
            return {
              bookmarks: [
                {
                  ...bookmark,
                  bookmarkId:
                    cursor === undefined ? "bookmark-1" : "bookmark-2",
                },
              ],
              nextCursor,
            };
          default:
            throw new Error(`Unexpected method: ${request.method}`);
        }
      }),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.listChannels({ workspaceId: "workspace" }),
    ).resolves.toHaveLength(2);
    await expect(
      adapter.listThreads({ workspaceId: "workspace" }),
    ).resolves.toHaveLength(2);
    await expect(
      adapter.listFollows({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toHaveLength(2);
    await expect(
      adapter.listBookmarks({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toHaveLength(2);
    expect(
      requests.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: CHATS_METHOD.channelsList,
        params: { pageLimit: 500 },
      },
      {
        method: CHATS_METHOD.channelsList,
        params: { pageLimit: 500, cursor: "page-2" },
      },
      {
        method: CHATS_METHOD.threadsList,
        params: { pageLimit: 500 },
      },
      {
        method: CHATS_METHOD.threadsList,
        params: { pageLimit: 500, cursor: "page-2" },
      },
      {
        method: CHATS_METHOD.followsList,
        params: { ownerUserId: "owner", pageLimit: 500 },
      },
      {
        method: CHATS_METHOD.followsList,
        params: {
          ownerUserId: "owner",
          pageLimit: 500,
          cursor: "page-2",
        },
      },
      {
        method: CHATS_METHOD.bookmarksList,
        params: { ownerUserId: "owner", pageLimit: 500 },
      },
      {
        method: CHATS_METHOD.bookmarksList,
        params: {
          ownerUserId: "owner",
          pageLimit: 500,
          cursor: "page-2",
        },
      },
    ]);
  });

  it("reconstructs completeRun and failRun with an acknowledgement followed by getRunRecord", async () => {
    const requests: Request[] = [];
    const completedRun = { ...run, endedAtMs: 10, exitCode: 0 };
    const failedRun = {
      ...run,
      runId: "failed-run",
      endedAtMs: 12,
      exitCode: 1,
      failureReason: "failed",
    };
    const results: JsonValue[] = [
      { completed: true },
      completedRun,
      { failed: true },
      failedRun,
    ];
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, (_request, index) => results[index] ?? null),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.completeRun({ runId: "run", exitCode: 0 }),
    ).resolves.toEqual(completedRun);
    await expect(
      adapter.failRun({
        runId: "failed-run",
        exitCode: 1,
        reason: "failed",
      }),
    ).resolves.toEqual(failedRun);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: CHATS_METHOD.dispatchComplete,
        params: { runId: "run", exitCode: 0 },
      },
      {
        method: CHATS_METHOD.dispatchGetRunRecord,
        params: { runId: "run" },
      },
      {
        method: CHATS_METHOD.dispatchFail,
        params: { runId: "failed-run", exitCode: 1, reason: "failed" },
      },
      {
        method: CHATS_METHOD.dispatchGetRunRecord,
        params: { runId: "failed-run" },
      },
    ]);
  });

  it("passes claimNextPending logPath through verbatim with the generated run ID", async () => {
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, () => null),
      WORKSPACE,
      {
        workspaceId: "workspace",
        createId: (kind) =>
          kind === "run" ? "run-claim" : `${kind}-unused`,
      },
    );

    // The desktop wrapper substitutes RUN_ID_LOG_TOKEN before calling this
    // method (desktopAgentDispatchStore.ts:124-139). The call-site shard must
    // preserve that indirection.
    await expect(
      adapter.claimNextPending("workspace", {
        agentId: "default",
        command: "codex",
        logPath: "run-logs/{runId}.log",
      }),
    ).resolves.toBeNull();
    expect(requests[0]).toMatchObject({
      method: CHATS_METHOD.dispatchClaimNextPending,
      params: {
        runId: "run-claim",
        agentId: "default",
        command: "codex",
        logPath: "run-logs/{runId}.log",
      },
    });
  });

  it.each([
    ["no", "terminal"],
    ["immediate", "immediate"],
    ["afterBackoff", "afterBackoff"],
    ["afterReconnect", "afterReconnect"],
  ] as const)(
    "maps the %s daemon refusal without losing wire metadata",
    async (retry, disposition) => {
      const refusalClient: MinimalDaemonClient = {
        close: () => undefined,
        async sendRequest(request): Promise<Response> {
          throw new EngineRequestError(request.id, {
            code: "OVERLOADED",
            message: "busy",
            retry,
          });
        },
      };

      await expect(
        new ChatsLiveAdapter(
          refusalClient,
          WORKSPACE,
          { workspaceId: "workspace" },
        ).request(
          CHATS_METHOD.channelsList,
          {},
        ),
      ).rejects.toMatchObject({
        name: "DaemonRefusalError",
        retry,
        disposition,
        wireCode: "OVERLOADED",
      } satisfies Partial<DaemonRefusalError>);
    },
  );

  it("requires a workspace binding before the adapter can issue requests", () => {
    const requests: Request[] = [];
    expect(() => {
      // @ts-expect-error The logical workspace binding is intentionally required.
      new ChatsLiveAdapter(captureClient(requests), WORKSPACE);
    }).toThrow(ChatsAdapterCapabilityError);
    expect(requests).toEqual([]);
  });

  it("decodes loopback answers through the live adapter for an existing RPC path", async () => {
    const loopback = new ChatsLoopbackEngine();
    loopback.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    const adapter = new ChatsLiveAdapter(
      { sendRequest: (request) => loopback.sendRequest(request), close: () => undefined },
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.getChannelWireId({
        workspaceId: "workspace",
        channelId: "channel",
      }),
    ).resolves.toBe("channel");
  });

  it("moves a group named like an agent's chat to another slug when that chat is made", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "group", name: "My agent codex" });

    const chat = await adapter.ensureAgentChannel({ workspaceId: "workspace", agentId: "codex", name: "Codex" });

    expect(chat.slug).toBe("my-agent-codex");
    const group = (await adapter.listChannels({ workspaceId: "workspace" })).find((channel) => channel.channelId === "group");
    expect(group).toMatchObject({ name: "My agent codex", slug: expect.stringMatching(/^my-agent-codex-[0-9a-f]{64}$/) });
  });

  it("matches native reaction validation for keycaps and ZWJ atoms", async () => {
    const loopback = new ChatsLoopbackEngine();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "General" });
    const adapter = new ChatsLiveAdapter(
      { sendRequest: (request) => loopback.sendRequest(request), close: () => undefined },
      WORKSPACE,
      { workspaceId: "workspace" },
    );
    const started = await adapter.startChannelThread({
      authorActorKey: null,
      workspaceId: "workspace", channelId: "channel",
      author: { kind: "human", displayName: "Sam" }, body: "React here",
    });
    const reaction = {
      workspaceId: "workspace", threadId: started.thread.id, messageId: started.message.id,
      author: { authorId: "ice", kind: "human" as const, displayName: "Sam" },
      replicationAuthorId: "ice", state: "added" as const,
    };
    for (const emoji of ["😀‍😀", "1\u20E3", "1️⃣", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) {
      await expect(adapter.setReaction({ ...reaction, emoji })).resolves.toBeDefined();
    }
    for (const emoji of ["😀😀", "1", "1\uFE0F", "😀‍x", "🏴\u{E0067}\u{E0062}"]) {
      await expect(adapter.setReaction({ ...reaction, emoji })).rejects.toThrow("invalid-message-body");
    }
  });

  it("claims only the listed agent when another agent has an older request", async () => {
    const loopback = new ChatsLoopbackEngine();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "General" });
    const adapter = new ChatsLiveAdapter(
      { sendRequest: (request) => loopback.sendRequest(request), close: () => undefined },
      WORKSPACE,
      { workspaceId: "workspace" },
    );
    const author = { kind: "human" as const, displayName: "Sam" };
    const started = await adapter.startChannelThread({
      authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      messageId: "other-first", author, body: "First", wakeAgentIds: ["other"],
    });
    await adapter.sendMessage({
      authorActorKey: null, workspaceId: "workspace", threadId: started.thread.id,
      messageId: "listed", author, body: "Second", wakeAgentIds: ["default"],
    });
    expect((await adapter.listPending("workspace"))[0]?.agentId).toBe("other");

    const claim = await adapter.claimNextPending("workspace", {
      agentId: "default", command: "listed-command",
    });
    expect(claim?.dispatch).toMatchObject({ triggerMessageId: "listed", agentId: "default" });
    expect(claim?.run).toMatchObject({ agentId: "default", command: "listed-command" });
    if (!claim) throw new Error("Expected the listed agent's run.");
    await adapter.completeRun({ runId: claim.run.runId, exitCode: 0 });

    await expect(adapter.claimNextPending("workspace", { agentId: "default" })).resolves.toBeNull();
    expect(await adapter.listPending("workspace")).toEqual([
      expect.objectContaining({ triggerMessageId: "other-first", agentId: "other", attemptCount: 0 }),
    ]);
  });

  it("folds pending requests only from the same place: the stream, or one message's thread", async () => {
    const loopback = new ChatsLoopbackEngine();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "General" });
    const adapter = new ChatsLiveAdapter(
      { sendRequest: (request) => loopback.sendRequest(request), close: () => undefined },
      WORKSPACE,
      { workspaceId: "workspace" },
    );
    const author = { kind: "human" as const, displayName: "Sam" };
    const started = await adapter.startChannelThread({
      authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      messageId: "main-1", author, body: "First", wakeAgentIds: ["codex"],
    });
    for (const [messageId, parentMessageId] of [
      ["main-2", undefined], ["a-1", "main-1"], ["a-2", "main-1"], ["b-1", "main-2"],
    ] as const) {
      await adapter.sendMessage({
        authorActorKey: null, workspaceId: "workspace", threadId: started.thread.id,
        messageId, author, body: messageId, wakeAgentIds: ["codex"],
        ...(parentMessageId ? { parentMessageId } : {}),
      });
    }
    const claimed: string[] = [];
    for (let run = 0; run < 3; run += 1) {
      const claim = await adapter.claimNextPending("workspace", { agentId: "codex" });
      claimed.push(claim!.dispatch.triggerMessageId);
      await adapter.completeRun({ runId: claim!.run.runId, exitCode: 0 });
    }
    expect(claimed).toEqual(["main-1", "a-1", "b-1"]);
    const runOf = (trigger: string) => loopback.readDispatch(WORKSPACE, trigger, "codex")?.runId;
    expect(runOf("main-2")).toBe(runOf("main-1"));
    expect(runOf("a-2")).toBe(runOf("a-1"));
    expect(new Set(["main-1", "a-1", "b-1"].map(runOf)).size).toBe(3);
  });

  it("uses a fresh idempotency key for added, removed, then added reaction transitions", async () => {
    const loopback = new ChatsLoopbackEngine();
    const requests: Request[] = [];
    let nextId = 0;
    const adapter = new ChatsLiveAdapter(
      {
        async sendRequest(request) {
          requests.push(request);
          return loopback.sendRequest(request);
        },
        close: () => undefined,
      },
      WORKSPACE,
      {
        workspaceId: "workspace",
        createId: (kind) => `${kind}-${++nextId}`,
      },
    );
    loopback.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    const started = await adapter.startChannelThread({
      authorActorKey: null,
      workspaceId: "workspace",
      channelId: "channel",
      author: { kind: "human", displayName: "Sam" },
      body: "React here",
    });
    const reaction = {
      workspaceId: "workspace",
      threadId: started.thread.id,
      messageId: started.message.id,
      emoji: "👍",
      author: {
        authorId: "ice",
        kind: "human" as const,
        displayName: "Sam",
      },
      replicationAuthorId: "ice",
    };

    await adapter.setReaction({ ...reaction, state: "added" });
    await adapter.setReaction({ ...reaction, state: "removed" });
    await adapter.setReaction({ ...reaction, state: "added" });

    const transitions = requests.filter(
      (request) => request.method === CHATS_METHOD.reactionSet,
    );
    expect(transitions.map((request) => request.idempotencyKey)).toHaveLength(3);
    expect(new Set(transitions.map((request) => request.idempotencyKey)).size)
      .toBe(3);
    expect(transitions.map((request) => request.params)).toEqual([
      expect.objectContaining({ replicationAuthorId: "ice" }),
      expect.objectContaining({ replicationAuthorId: "ice" }),
      expect.objectContaining({ replicationAuthorId: "ice" }),
    ]);
    await expect(
      adapter.listReactions({
        workspaceId: "workspace",
        threadId: started.thread.id,
      }),
    ).resolves.toMatchObject([{ state: "added" }]);
  });

  it("marks only the personal-feed head that the caller actually displayed", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({
      workspace: WORKSPACE,
      channelId: "channel",
      name: "General",
    });
    const started = await adapter.startChannelThread({
      authorActorKey: null,
      workspaceId: "workspace",
      channelId: "channel",
      author: { kind: "human", displayName: "Sam" },
      body: "Displayed",
    });
    await adapter.setFollow({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: started.thread.id,
      state: "following",
    });
    const displayed = await adapter.listPersonalFeed({
      workspaceId: "workspace",
      ownerUserId: "owner",
    });
    expect(displayed.headCursor).toBeDefined();

    const arrivedLater = await adapter.sendMessage({
      authorActorKey: null,
      workspaceId: "workspace",
      threadId: started.thread.id,
      author: { kind: "human", displayName: "Sam" },
      body: "Arrived later",
    });
    const seen = await adapter.markPersonalFeedSeen({
      workspaceId: "workspace",
      ownerUserId: "owner",
      headCursor: displayed.headCursor!,
    });

    expect(seen.lastSeenMessageId).toBe(started.message.id);
    expect(seen.lastSeenMessageId).not.toBe(arrivedLater.id);

    await adapter.setFollow({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: started.thread.id,
      state: "unfollowed",
    });
    await expect(
      adapter.markPersonalFeedSeen({
        workspaceId: "workspace",
        ownerUserId: "owner",
        headCursor: displayed.headCursor!,
      }),
    ).rejects.toThrow("invalid-follow-target");
  });

  it("lists seeded default channel follows without resurrecting tombstones", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({
      workspace: WORKSPACE,
      channelId: "general",
      name: "General",
    });
    loopback.seedChannel({
      workspace: WORKSPACE,
      channelId: "private",
      name: "Private",
      kind: "dm",
    });

    await adapter.ensureDefaultChannelFollows({
      workspaceId: "workspace",
      ownerUserId: "owner",
    });
    await expect(
      adapter.listFollows({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toEqual([
      {
        workspaceId: WORKSPACE,
        ownerUserId: "owner",
        targetKind: "channel",
        targetId: "general",
        state: "following",
        updatedAtMs: 0,
      },
    ]);

    await adapter.setFollow({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "channel",
      targetId: "general",
      state: "unfollowed",
    });
    await adapter.ensureDefaultChannelFollows({
      workspaceId: "workspace",
      ownerUserId: "owner",
    });
    await expect(
      adapter.listFollows({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        targetKind: "channel",
        targetId: "general",
        state: "unfollowed",
      }),
    ]);
  });

  it("rejects a replicated follow whose verified owner does not match", async () => {
    const { adapter } = loopbackAdapter();
    const thread = await adapter.createThread({
      workspaceId: "workspace",
      title: "Thread",
      linkedFile: { objectId: "object" },
    });

    await expect(
      adapter.setFollow({
        workspaceId: "workspace",
        ownerUserId: "owner",
        replicationOwnerUserId: "someone-else",
        targetKind: "thread",
        targetId: thread.id,
        state: "following",
      }),
    ).rejects.toThrow("invalid-follow-target");
    await expect(
      adapter.listFollows({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toEqual([]);
  });

  it("requires bookmark projection object and path identities together", async () => {
    const { adapter } = loopbackAdapter();
    const thread = await adapter.createThread({
      workspaceId: "workspace",
      title: "Thread",
      linkedFile: { objectId: "object" },
    });
    const bookmark = await adapter.saveBookmark({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: thread.id,
      mode: "live",
      destinationPath: "bookmarks/thread.md",
    });

    await expect(
      adapter.markBookmarkReady({
        workspaceId: "workspace",
        ownerUserId: "owner",
        bookmarkId: bookmark.bookmarkId,
        generation: bookmark.generation,
        projectionObjectId: "projection-object",
      }),
    ).rejects.toThrow("invalid-bookmark-target");
    await expect(
      adapter.markBookmarkReady({
        workspaceId: "workspace",
        ownerUserId: "owner",
        bookmarkId: bookmark.bookmarkId,
        generation: bookmark.generation,
        projectionPath: bookmark.destinationPath,
      }),
    ).rejects.toThrow("invalid-bookmark-target");
    await expect(
      adapter.markBookmarkReady({
        workspaceId: "workspace",
        ownerUserId: "owner",
        bookmarkId: bookmark.bookmarkId,
        generation: bookmark.generation,
        projectionObjectId: "projection-object",
        projectionPath: bookmark.destinationPath,
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("rejects non-tracked bookmark destination paths before projection", async () => {
    const { adapter } = loopbackAdapter();
    const thread = await adapter.createThread({
      workspaceId: "workspace",
      title: "Thread",
      linkedFile: { objectId: "object" },
    });

    for (const destinationPath of [
      ".env",
      "secrets%252eenv",
      ".dohc/engine/engine.db",
      "DOHC~1/bookmark.md",
      "%252e%252e/outside.md",
    ]) {
      await expect(
        adapter.saveBookmark({
          workspaceId: "workspace",
          ownerUserId: "owner",
          targetKind: "thread",
          targetId: thread.id,
          mode: "live",
          destinationPath,
        }),
        destinationPath,
      ).rejects.toThrow("invalid-path");
    }

    await expect(
      adapter.saveBookmark({
        workspaceId: "workspace",
        ownerUserId: "owner",
        targetKind: "thread",
        targetId: thread.id,
        mode: "live",
        destinationPath: "bookmarks/./thread.md",
      }),
    ).resolves.toMatchObject({ destinationPath: "bookmarks/thread.md" });
  });

  it("upserts a bookmark by owner and target and queues a fresh generation", async () => {
    const { adapter } = loopbackAdapter();
    const thread = await adapter.createThread({
      workspaceId: "workspace",
      title: "Thread",
      linkedFile: { objectId: "object" },
    });
    const first = await adapter.saveBookmark({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: thread.id,
      mode: "live",
      destinationPath: "bookmarks/first.md",
    });
    await adapter.markBookmarkReady({
      workspaceId: "workspace",
      ownerUserId: "owner",
      bookmarkId: first.bookmarkId,
      generation: first.generation,
      projectionObjectId: "projection-object",
      projectionPath: first.destinationPath,
    });

    const updated = await adapter.saveBookmark({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: thread.id,
      mode: "snapshot",
      destinationPath: "bookmarks/updated.md",
    });

    expect(updated).toMatchObject({
      bookmarkId: first.bookmarkId,
      mode: "snapshot",
      destinationPath: "bookmarks/updated.md",
      generation: 2,
      projectedGeneration: 1,
      projectionState: "pending",
    });
    expect(updated.projectionObjectId).toBeUndefined();
    await expect(
      adapter.listBookmarks({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toHaveLength(1);

    const otherThread = await adapter.createThread({
      workspaceId: "workspace",
      title: "Other thread",
      linkedFile: { objectId: "other-object" },
    });
    const otherTarget = await adapter.saveBookmark({
      workspaceId: "workspace",
      ownerUserId: "owner",
      targetKind: "thread",
      targetId: otherThread.id,
      mode: "live",
      destinationPath: updated.destinationPath,
    });
    expect(otherTarget.bookmarkId).not.toBe(updated.bookmarkId);
    await expect(
      adapter.listBookmarks({
        workspaceId: "workspace",
        ownerUserId: "owner",
      }),
    ).resolves.toHaveLength(2);
  });
});

describe("loopback poll validation", () => {
  it.each([
    { name: "non-string", options: [7], sentence: "invalid parameters" },
    { name: "non-array", options: "a", sentence: "invalid parameters" },
    { name: "empty", options: ["  "], sentence: "Each choice is one line of at most 200 characters." },
    { name: "duplicate", options: [" a ", "a"], sentence: "Each choice appears once." },
    { name: "too many", options: Array.from({ length: 13 }, (_, index) => String(index)), sentence: "A poll has at most twelve choices." },
    { name: "too long", options: ["x".repeat(201)], sentence: "Each choice is one line of at most 200 characters." },
    { name: "UTF-16 too long", options: ["💥".repeat(101)], sentence: "Each choice is one line of at most 200 characters." },
    { name: "multiline", options: ["a\nb"], sentence: "Each choice is one line of at most 200 characters." },
  ])("rejects $name options before writing a message", async ({ options, sentence }) => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Team" });
    const started = await adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel", author: { kind: "human", displayName: "Sam" }, body: "Hello" });
    await expect(loopback.sendRequest({ id: 100, workspace: WORKSPACE, method: CHATS_METHOD.messageSend, params: {
      threadId: started.thread.id, messageId: "bad-poll", authorKind: "human", authorDisplayName: "Sam", body: "Choose", options,
    } })).rejects.toThrow(sentence);
    expect(await adapter.listMessages({ workspaceId: "workspace", threadId: started.thread.id })).toHaveLength(1);
  });
});

describe("loopback reported agent validation", () => {
  it.each([
    { name: "40 emoji, 80 UTF-16 units", model: "\u{1F600}".repeat(40) },
    { name: "a leading byte order mark", model: "﻿Claude Opus 5.5" },
  ])("refuses a model of $name, as the daemon does", async ({ model }) => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Team" });
    const started = await adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel", author: { kind: "human", displayName: "Sam" }, body: "Hello" });
    await expect(loopback.sendRequest({ id: 100, workspace: WORKSPACE, method: CHATS_METHOD.messageSend, params: {
      threadId: started.thread.id, messageId: "bad-report", authorKind: "agent", authorDisplayName: "Nova", body: "Done",
      authorReported: { model },
    } })).rejects.toThrow("invalid-input");
    expect(await adapter.listMessages({ workspaceId: "workspace", threadId: started.thread.id })).toHaveLength(1);
  });

  it("accepts a model of 32 emoji, 64 UTF-16 units", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Team" });
    const started = await adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel", author: { kind: "human", displayName: "Sam" }, body: "Hello" });
    const model = "\u{1F600}".repeat(32);
    await loopback.sendRequest({ id: 100, workspace: WORKSPACE, method: CHATS_METHOD.messageSend, params: {
      threadId: started.thread.id, messageId: "good-report", authorKind: "agent", authorDisplayName: "Nova", body: "Done",
      authorReported: { model },
    } });
    const messages = await adapter.listMessages({ workspaceId: "workspace", threadId: started.thread.id });
    expect(messages.find(message => message.id === "good-report")?.authorReported).toEqual({ model });
  });
});


it("decodes agent owner display metadata without changing its verified author", () => {
  const message = decodeChatsResult(CHATS_METHOD.messageSend, {
    id: "message", workspaceId: "workspace", threadId: "thread",
    author: { kind: "agent", displayName: "Nova" }, authorOwnerDisplayName: "Ada", authorUserId: "owner-id",
    body: "Done", createdAtMs: 1, attachments: [],
  });
  expect(message).toMatchObject({ author: { kind: "agent", displayName: "Nova" }, authorOwnerDisplayName: "Ada", authorUserId: "owner-id" });
});

describe("automation authors", () => {
  it("posts with the executor's ids, key, and automation, and reads the automation back", async () => {
    const requests: Request[] = [];
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Trip" });
    const recording = new ChatsLiveAdapter(
      { sendRequest: (request) => { requests.push(request); return loopback.sendRequest(request); }, close: () => undefined },
      WORKSPACE,
      { workspaceId: "workspace" },
    );
    const author = { kind: "automation" as const, displayName: "Stamp the finish date" };
    const started = await recording.startChannelThread({
      authorActorKey: null,
      workspaceId: "workspace", channelId: "channel", threadId: "thread-auto", messageId: "message-auto-1",
      idempotencyKey: "claim/step/post", automation: { automationId: "collection:object-tasks#stamp", chainDepth: 1 },
      author, authorOwnerDisplayName: "Ice", body: "Finished Book hotel",
    });
    expect(requests.at(-1)).toMatchObject({
      idempotencyKey: "claim/step/post",
      params: { threadId: "thread-auto", messageId: "message-auto-1", authorKind: "automation", authorOwnerDisplayName: "Ice",
        automation: { automationId: "collection:object-tasks#stamp", chainDepth: 1 } },
    });
    expect(started.message).toMatchObject({ id: "message-auto-1", author, authorOwnerDisplayName: "Ice",
      automation: { automationId: "collection:object-tasks#stamp" } });
    const reply = await recording.sendMessage({
      authorActorKey: null,
      workspaceId: "workspace", threadId: "thread-auto", messageId: "message-auto-2", idempotencyKey: "claim/step2/post",
      automation: { automationId: "collection:object-tasks#stamp", chainDepth: 2 }, author, body: "Again",
    });
    expect(requests.at(-1)).toMatchObject({ idempotencyKey: "claim/step2/post", params: { messageId: "message-auto-2" } });
    expect(reply.automation).toEqual({ automationId: "collection:object-tasks#stamp" });
    expect((await adapter.listMessages({ workspaceId: "workspace", threadId: "thread-auto" })).map((message) => message.automation?.automationId))
      .toEqual(["collection:object-tasks#stamp", "collection:object-tasks#stamp"]);
    // Without ids, the adapter still mints them.
    const minted = await adapter.sendMessage({ authorActorKey: null, workspaceId: "workspace", threadId: "thread-auto", author: { kind: "human", displayName: "Ice" }, body: "Thanks" });
    expect(minted.id).toMatch(/^message-/u);
    expect(minted.automation).toBeUndefined();
  });

  it("refuses an automation author without its automation, and an automation on anyone else", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Trip" });
    await expect(adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      author: { kind: "automation", displayName: "Stamp the finish date" }, body: "Done" })).rejects.toThrow("invalid-input");
    await expect(adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      automation: { automationId: "collection:object-tasks#stamp", chainDepth: 1 },
      author: { kind: "human", displayName: "Ice" }, body: "Done" })).rejects.toThrow("invalid-input");
    await expect(adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      automation: { automationId: "other:hello/triage", chainDepth: 1 },
      author: { kind: "automation", displayName: "Stamp the finish date" }, body: "Done" })).rejects.toThrow("invalid-input");
  });

  it("decodes automation message and mention authors, and refuses an automation reaction author", () => {
    const message = decodeChatsResult(CHATS_METHOD.messageSend, {
      id: "message", workspaceId: "workspace", threadId: "thread",
      author: { kind: "automation", displayName: "Stamp the finish date" }, authorOwnerDisplayName: "Ice", authorUserId: "ice",
      body: "Done", createdAtMs: 1, attachments: [], automation: { automationId: "collection:object-tasks#stamp" },
    });
    expect(message.author.kind).toBe("automation");
    expect(() => decodeChatsResult(CHATS_METHOD.reactionSet, {
      reactionId: "reaction", threadId: "thread", messageId: "message", emoji: "👍",
      author: { authorId: "ice", kind: "automation", displayName: "Stamp the finish date" }, state: "added", atMs: 1,
    })).toThrow(ProtocolShapeError);
  });
});

describe("loopback idempotency", () => {
  it("refuses a reused key whose message wakes other agents or names another author agent", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Team" });
    const human = { kind: "human" as const, displayName: "Sam" };
    const agent = { kind: "agent" as const, displayName: "Nova" };
    const start = { authorActorKey: null, workspaceId: "workspace", channelId: "channel", threadId: "thread", messageId: "first", idempotencyKey: "start", author: human, body: "Hello" };
    await adapter.startChannelThread({ ...start, wakeAgentIds: ["codex", "nova", "codex"] });
    await expect(adapter.startChannelThread({ ...start, wakeAgentIds: ["codex", "nova"] })).resolves.toMatchObject({ message: { id: "first" } });
    await expect(adapter.startChannelThread({ ...start, wakeAgentIds: ["nova"] })).rejects.toThrow("idempotency-key-reuse-mismatch");
    // The engine checks the ids before it looks up a retry, so one id can't stand for two.
    await expect(adapter.startChannelThread({ ...start, wakeAgentIds: ["codex,nova"] })).rejects.toThrow("invalid-input");
    // A message wakes at most 64 agents.
    const crowd = Array.from({ length: 65 }, (_, index) => `agent-${index}`);
    await expect(adapter.startChannelThread({ ...start, threadId: "crowd", messageId: "crowd", idempotencyKey: "crowd", wakeAgentIds: crowd }))
      .rejects.toThrow("invalid-input");
    const agentStart = { ...start, threadId: "agent-thread", messageId: "opened", idempotencyKey: "opened", author: agent, authorAgentId: "nova" };
    await adapter.startChannelThread(agentStart);
    await expect(adapter.startChannelThread({ ...agentStart, authorAgentId: "codex" })).rejects.toThrow("idempotency-key-reuse-mismatch");

    const send = { authorActorKey: null, workspaceId: "workspace", threadId: "thread", body: "Done" };
    await adapter.sendMessage({ ...send, messageId: "named", idempotencyKey: "named", author: human, wakeAgentIds: ["nova"] });
    await expect(adapter.sendMessage({ ...send, messageId: "named", idempotencyKey: "named", author: human, wakeAgentIds: ["codex"] }))
      .rejects.toThrow("idempotency-key-reuse-mismatch");
    await adapter.sendMessage({ ...send, messageId: "reply", idempotencyKey: "reply", author: agent, authorAgentId: "nova" });
    await expect(adapter.sendMessage({ ...send, messageId: "reply", idempotencyKey: "reply", author: agent, authorAgentId: "codex" }))
      .rejects.toThrow("idempotency-key-reuse-mismatch");
  });
});

describe("loopback channel previews", () => {
  it("keeps the opening message's stored key, origin and agent, and leaves out those it lacks", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Team" });
    const key = '{"kind":"agent","ownerKey":{"kind":"installation","installationId":"device"},"claimedName":"Codex"}';
    await adapter.startChannelThread({ authorActorKey: key, origin: "cli", workspaceId: "workspace", channelId: "channel",
      threadId: "run", author: { kind: "agent", displayName: "Codex" }, authorAgentId: "codex", body: "Done" });
    await adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      threadId: "plain", author: { kind: "human", displayName: "Sam" }, body: "Hello" });
    const threads = await adapter.listChannelThreads({ workspaceId: "workspace", channelId: "channel" });
    expect(threads.find((summary) => summary.thread.id === "run")?.openingMessage)
      .toMatchObject({ authorActorKey: key, origin: "cli", authorAgentId: "codex" });
    const plain = threads.find((summary) => summary.thread.id === "plain")?.openingMessage;
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty("authorActorKey");
    expect(plain).not.toHaveProperty("origin");
  });
});

describe("link authors", () => {
  it("cannot be written through either local write method", async () => {
    const { adapter, loopback } = loopbackAdapter();
    loopback.seedChannel({ workspace: WORKSPACE, channelId: "channel", name: "Trip" });
    const link = { kind: "link", displayName: "Guest", grantId: "grant-1", principalId: "principal-1" } as const;
    // @ts-expect-error Only the relay writes a link author.
    await expect(adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel", author: link, body: "Hi" }))
      .rejects.toThrow("invalid-sender");
    const { thread } = await adapter.startChannelThread({ authorActorKey: null, workspaceId: "workspace", channelId: "channel",
      author: { kind: "human", displayName: "Ice" }, body: "Hi" });
    // @ts-expect-error Only the relay writes a link author.
    await expect(adapter.sendMessage({ authorActorKey: null, workspaceId: "workspace", threadId: thread.id, author: link, body: "Hi" }))
      .rejects.toThrow("invalid-sender");
    expect((await adapter.listMessages({ workspaceId: "workspace", threadId: thread.id })).map((message) => message.author.kind)).toEqual(["human"]);
  });
});

describe("local chat actor key transport", () => {
  it("passes admission keys through the native write door and preserves the own-store column on reads", async () => {
    const key = '{"kind":"installation","installationId":"device"}';
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(mockDaemon(requests, (request) => {
      if (request.method === CHATS_METHOD.threadStart) return { thread: { id: "thread", workspaceId: "workspace", title: "Thread", createdAtMs: 1, updatedAtMs: 2 }, message: { ...message, authorActorKey: key } };
      if (request.method === CHATS_METHOD.messagesList) return { messages: [{ ...message, authorActorKey: key }, { ...message, id: "received" }], nextAfterMessageOrder: null };
      return { ...message, authorActorKey: key };
    }), WORKSPACE, { workspaceId: "workspace" });
    const started = await adapter.startChannelThread({ workspaceId: "workspace", channelId: "channel", author: { kind: "human", displayName: "Sam" }, authorActorKey: key, body: "Hi" });
    const sent = await adapter.sendMessage({ workspaceId: "workspace", threadId: "thread", author: { kind: "human", displayName: "Sam" }, authorActorKey: key, body: "Hi" });
    expect(requests[0]!.params).toHaveProperty("authorActorKey", key);
    expect(requests[1]!.params).toHaveProperty("authorActorKey", key);
    expect(started.message.authorActorKey).toBe(key);
    expect(sent.authorActorKey).toBe(key);
    const rows = await adapter.listMessages({ workspaceId: "workspace", threadId: "thread" });
    expect(rows[0]!.authorActorKey).toBe(key);
    expect(rows[1]!.authorActorKey).toBeUndefined();
  });
});

it("preserves the agent read position on unread threads", async () => {
  const requests: Request[] = [];
  const thread = { id: "thread", workspaceId: "workspace", title: "Thread", createdAtMs: 1, updatedAtMs: 3,
    lastRead: { createdAtMs: 2, messageId: "read-message" } };
  const adapter = new ChatsLiveAdapter(mockDaemon(requests, () => ({ threads: [thread], nextCursor: null })), WORKSPACE, { workspaceId: "workspace" });
  expect(await adapter.listAgentUnreadThreads("workspace", { kind: "run", runId: "run" })).toEqual([thread]);
  expect(requests[0]).toMatchObject({
    method: CHATS_METHOD.agentReadListUnreadThreads,
    params: { reader: { kind: "run", runId: "run" } },
  });
});

it("returns exactly one chat mention page even when an empty filtered page has a continuation",async()=>{
  const requests: Request[]=[];
  const page={versionId:"main",subject:null,entries:[],unchecked:[],complete:false,indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:2,nextCursor:"sealed-next"};
  const adapter=new ChatsLiveAdapter(mockDaemon(requests,()=>page),WORKSPACE,{workspaceId:"workspace"});
  await expect(adapter.fileMentionsPage({workspaceId:"workspace",scope:"grant",sharedChannelRowsUncovered:2,cursor:"sealed-before"})).resolves.toEqual(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({workspace:WORKSPACE,method:CHATS_METHOD.attachmentsListFileMentions,params:{scope:"grant",sharedChannelRowsUncovered:2,cursor:"sealed-before"}});
});

it("reads one conversation Links page without draining or accepting another workspace",async()=>{
  const page={versionId:"main",subject:{channelWireId:"wire"},entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:0,nextCursor:"next"};
  const sendRequest=vi.fn(async(request:Request):Promise<Response>=>({id:request.id,result:page}));
  const adapter=new ChatsLiveAdapter({sendRequest,close(){}},WORKSPACE,{workspaceId:"workspace"});
  expect(await adapter.linksPage({workspaceId:"workspace",channelWireId:"wire",scope:"scope",sharedChannelRowsUncovered:2,cursor:"previous"})).toEqual(page);
  expect(sendRequest).toHaveBeenCalledTimes(1);
  expect(sendRequest.mock.calls[0]?.[0]).toMatchObject({method:CHATS_METHOD.conversationLinks,params:{channelWireId:"wire",scope:"scope",sharedChannelRowsUncovered:2,cursor:"previous"}});
  await expect(adapter.linksPage({workspaceId:"other",channelWireId:"wire",scope:"scope",sharedChannelRowsUncovered:0})).rejects.toThrow();
  expect(sendRequest).toHaveBeenCalledTimes(1);
});
