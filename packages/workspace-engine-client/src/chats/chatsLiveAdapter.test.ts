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

function captureClient(requests: Request[]): MinimalDaemonClient {
  return {
    close: () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      throw SENTINEL;
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

  it("maps retryable and terminal daemon refusals without losing wire metadata", async () => {
    const refusalClient = (retry: "afterBackoff" | "no"): MinimalDaemonClient => ({
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
    });

    await expect(
      new ChatsLiveAdapter(refusalClient("afterBackoff"), WORKSPACE).request(
        CHATS_METHOD.channelsList,
        {},
      ),
    ).rejects.toMatchObject({
      name: "DaemonRefusalError",
      retry: "afterBackoff",
      disposition: "retryable",
      wireCode: "OVERLOADED",
    } satisfies Partial<DaemonRefusalError>);
    await expect(
      new ChatsLiveAdapter(refusalClient("no"), WORKSPACE).request(
        CHATS_METHOD.channelsList,
        {},
      ),
    ).rejects.toMatchObject({
      name: "DaemonRefusalError",
      retry: "no",
      disposition: "terminal",
    } satisfies Partial<DaemonRefusalError>);
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
    );

    await expect(
      adapter.request(CHATS_METHOD.channelGetWireId, { channelId: "channel" }),
    ).resolves.toEqual({ wireId: "channel" });
  });
});
