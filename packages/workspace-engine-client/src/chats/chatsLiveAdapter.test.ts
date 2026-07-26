import { describe, expect, it } from "vitest";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import {
  DaemonRefusalError,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import {
  CHATS_METHOD,
  ChatsProtocolShapeError,
  decodeChatsResult,
  type ChatsMethod,
  type ChatsMethodParamsMap,
} from "./chatsWireContract";
import { ChatsLiveAdapter } from "./chatsLiveAdapter";
import { ChatsLoopbackEngine } from "./chatsLoopbackEngine";

const WORKSPACE = "ws-handle";
const SENTINEL = new Error("captured");

type ChatRequestCase = {
  method: ChatsMethod;
  params: ChatsMethodParamsMap[ChatsMethod];
};

const CHAT_REQUEST_CASES: ChatRequestCase[] = [
  { method: CHATS_METHOD.channelCreate, params: { channelId: "c", name: "C", kind: "channel" } },
  { method: CHATS_METHOD.channelEnsureAgent, params: { channelId: "agent" } },
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
      authorDisplayName: "Ice",
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
      author: { authorId: "u", kind: "human", displayName: "Ice" },
      state: "added",
    },
  },
  { method: CHATS_METHOD.reactionsList, params: { threadId: "t" } },
  { method: CHATS_METHOD.attachmentsListForThread, params: { threadId: "t" } },
  { method: CHATS_METHOD.attachmentsListFileMentions, params: { objectId: "o" } },
  { method: CHATS_METHOD.mentionsListForHandle, params: { handle: "agent" } },
  { method: CHATS_METHOD.agentReadListUnreadThreads, params: {} },
  {
    method: CHATS_METHOD.agentReadMarkThreadRead,
    params: { threadId: "t", upTo: { createdAtMs: 1, messageId: "m" } },
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
    params: { triggerMessageId: "m", threadId: "t" },
  },
  { method: CHATS_METHOD.dispatchRecordEligibleTriggers, params: {} },
  { method: CHATS_METHOD.dispatchClaimNextPending, params: { runId: "r" } },
  { method: CHATS_METHOD.dispatchListPending, params: {} },
  { method: CHATS_METHOD.dispatchOpenRuns, params: {} },
  { method: CHATS_METHOD.dispatchListRunMessages, params: { runId: "r" } },
  { method: CHATS_METHOD.dispatchRunIdForMessage, params: { messageId: "m" } },
  { method: CHATS_METHOD.dispatchRunRecordsForThread, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchGetRunRecord, params: { runId: "r" } },
  { method: CHATS_METHOD.dispatchIsThreadPaused, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchGetThreadPauseState, params: { threadId: "t" } },
  { method: CHATS_METHOD.dispatchRecentCount, params: { threadId: "t", sinceMs: 0 } },
  {
    method: CHATS_METHOD.dispatchFailPendingForThread,
    params: { threadId: "t", reason: "stop" },
  },
  {
    method: CHATS_METHOD.dispatchRecordRunMessage,
    params: { messageId: "m", runId: "r" },
  },
  {
    method: CHATS_METHOD.dispatchSetThreadPaused,
    params: { threadId: "t", paused: true },
  },
  { method: CHATS_METHOD.dispatchMarkFailureNotePosted, params: { runId: "r" } },
  {
    method: CHATS_METHOD.dispatchRequeueFailedTrigger,
    params: { triggerMessageId: "m", runId: "r" },
  },
  { method: CHATS_METHOD.dispatchListAppQuitRecoveries, params: {} },
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
  createdAtMs: 1,
  updatedAtMs: 2,
};
const threadWire = {
  workspaceId: "workspace",
  threadId: "thread",
  title: "Thread",
  createdAtMs: 1,
  updatedAtMs: 2,
  channelId: "channel",
  linkedObjectId: null,
};
const message = {
  id: "message",
  workspaceId: "workspace",
  threadId: "thread",
  author: { kind: "human", displayName: "Ice" },
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
  command: "codex",
  startedAtMs: 3,
  failureNotePosted: false,
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
    valid: { channels: [{ ...channel, threadCount: 1, unreadCount: 0 }], truncated: false },
  },
  { method: CHATS_METHOD.threadsList, valid: { threads: [threadWire], truncated: false } },
  {
    method: CHATS_METHOD.messagesList,
    valid: { messages: [message], nextAfterMessageOrder: null },
  },
  { method: CHATS_METHOD.readStateGet, valid: readState },
  { method: CHATS_METHOD.readStateMarkThreadRead, valid: readState },
  { method: CHATS_METHOD.followsSet, valid: follow },
  { method: CHATS_METHOD.followsList, valid: { follows: [follow], truncated: false } },
  { method: CHATS_METHOD.feedMarkSeen, valid: feedReadState },
  { method: CHATS_METHOD.bookmarkSave, valid: bookmark },
  { method: CHATS_METHOD.bookmarksList, valid: { bookmarks: [bookmark], truncated: false } },
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
        author: { authorId: "owner", kind: "human", displayName: "Ice" },
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
      author: { authorId: "owner", kind: "human", displayName: "Ice" },
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

describe("ChatsLiveAdapter", () => {
  it("encodes every one of the 60 chats methods with the workspace handle and exact params", async () => {
    expect(CHAT_REQUEST_CASES).toHaveLength(60);
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(captureClient(requests), WORKSPACE);

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
      ).toThrow(ChatsProtocolShapeError);
    },
  );

  it.each(STRICT_NEGATIVE_CASES)(
    "rejects wrong field names and enum spellings for $method",
    ({ method, wrongFieldName, wrongEnumSpelling }) => {
      expect(() =>
        decodeChatsResult(method as never, wrongFieldName),
      ).toThrow(ChatsProtocolShapeError);
      expect(() =>
        decodeChatsResult(method as never, wrongEnumSpelling),
      ).toThrow(ChatsProtocolShapeError);
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
            channelId: null,
            linkedObjectId: "object-1",
          },
          {
            workspaceId: "workspace",
            threadId: "channel-thread",
            title: "Channel",
            createdAtMs: 21,
            updatedAtMs: 22,
            channelId: "channel-1",
            linkedObjectId: null,
          },
        ],
        truncated: false,
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
        channelId: "channel-1",
      },
    ]);
    expect(requests).toEqual([
      {
        id: 1,
        method: CHATS_METHOD.threadsList,
        workspace: WORKSPACE,
        params: {},
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

  it("fails closed when a cursorless named list is truncated", async () => {
    const requests: Request[] = [];
    const adapter = new ChatsLiveAdapter(
      mockDaemon(requests, () => ({ threads: [], truncated: true })),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.listThreads({ workspaceId: "workspace" }),
    ).rejects.toThrow(
      "chats.threads.list was truncated by the daemon and has no continuation cursor.",
    );
    expect(requests).toHaveLength(1);
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
        command: "codex",
        logPath: "run-logs/{runId}.log",
      }),
    ).resolves.toBeNull();
    expect(requests[0]).toMatchObject({
      method: CHATS_METHOD.dispatchClaimNextPending,
      params: {
        runId: "run-claim",
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
        async sendRequest(): Promise<Response> {
          throw {
            wireError: {
              code: "OVERLOADED",
              message: "busy",
              retry,
            },
          };
        },
      };

      await expect(
        new ChatsLiveAdapter(refusalClient, WORKSPACE).request(
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
});
