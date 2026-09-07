import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type {
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatMessageRecord,
  DmRecord,
  FileChatThreadRecord,
} from "../../ipc/bridgeContract";
import { ChatsView as ProductionChatsView } from "./ChatsView";

type TestChatsViewProps = Omit<
  Parameters<typeof ProductionChatsView>[0],
  "workspaces"
> & {
  workspaces?: Parameters<typeof ProductionChatsView>[0]["workspaces"];
};

export function ChatsView(props: TestChatsViewProps) {
  return (
    <ProductionChatsView
      workspaces={[{ workspaceId: props.workspaceId, label: "Work" }]}
      {...props}
    />
  );
}

// Chats view (PR 13, WS-E): fast, natural chat — the channel composer sends
// on Enter with NO title prompt, unread badges derive from the store's read
// cursors, and the Files grouping cross-links to the file rail.

export const NOW = 1_700_000_000_000;

// Production shape: every channel main lists carries a wire identity — a
// locally created one gets its own id (see createChatChannel in main.ts). A
// fixture without one takes channelIsLocked's no-wire-id early-out and never
// exercises the joined lane at all, so it is opt-IN here, not the default.
export function channel(overrides: Partial<ChatChannelRecord> = {}): ChatChannelRecord {
  const id = overrides.id ?? "channel-1";
  return {
    id,
    name: "general",
    slug: "general",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    wireId: id,
    ...overrides,
  };
}

export function thread(overrides: Partial<ChannelThreadRecord> = {}): ChannelThreadRecord {
  return {
    id: "thread-1",
    title: "Should we ship on Friday?",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    channelId: "channel-1",
    messageCount: 1,
    lastReadSequence: 1,
    unreadCount: 0,
    ...overrides,
  };
}

export function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: "message-1",
    threadId: "thread-1",
    authorKind: "human",
    authorDisplayName: "You",
    body: "Should we ship on Friday?",
    createdAtMs: NOW,
    ...overrides,
  };
}

export function openingPreview(
  overrides: Partial<NonNullable<ChannelThreadRecord["openingMessage"]>> = {},
): NonNullable<ChannelThreadRecord["openingMessage"]> {
  return {
    id: "message-1",
    authorKind: "human",
    authorDisplayName: "You",
    bodySnippet: "Should we ship on Friday?",
    createdAtMs: NOW,
    reactions: [],
    ...overrides,
  };
}

export function personalFeedItem(body: string, id: string) {
  return {
    message: message({ id, body }),
    thread: thread(),
    channel: {
      id: "channel-1",
      name: "general",
      slug: "general",
      kind: "channel" as const,
    },
    reactions: [],
    matchedBy: ["channel" as const],
  };
}

export const fileThread: FileChatThreadRecord = {
  id: "thread-file-1",
  title: "Naming discussion",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  path: "notes/topic.md",
};

export function dm(overrides: Partial<DmRecord> = {}): DmRecord {
  return {
    channelId: "channel-dm-1",
    channelWireId: "wire-dm-1",
    name: "bob@example.com",
    peerLabel: "bob@example.com",
    role: "owner",
    shareId: null,
    threadId: "thread-dm-1",
    unreadCount: 0,
    connected: true,
    ...overrides,
  };
}

export const bridgeMock = {
  listChatChannels: vi.fn(),
  listChatChannelShares: vi.fn(),
  listJoinedSharedChannels: vi.fn(),
  shareChatChannel: vi.fn(),
  joinSharedChannel: vi.fn(),
  leaveSharedChannel: vi.fn(),
  revokeRelayShare: vi.fn(),
  createChatChannel: vi.fn(),
  listChannelThreads: vi.fn(),
  startChannelThread: vi.fn(),
  listChatMessages: vi.fn(),
  getChatThreadRevision: vi.fn(),
  listChatThreadDecisions: vi.fn(),
  resolveChatDecision: vi.fn(),
  listChatThreadAttachments: vi.fn(),
  chatRunRecordsForThread: vi.fn(),
  sendChatMessage: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  setChatReaction: vi.fn(),
  syncDms: vi.fn(),
  acceptDm: vi.fn(),
  declineDm: vi.fn(),
  requestDmAgain: vi.fn(),
  startDm: vi.fn(),
  leaveDm: vi.fn(),
  chatDispatchStateForThread: vi.fn(),
  stopAgentRun: vi.fn(),
  resumeThreadDispatch: vi.fn(),
  writeClipboardText: vi.fn(),
  listChatBookmarks: vi.fn(),
  saveChatBookmark: vi.fn(),
  archiveChatBookmark: vi.fn(),
  listChatFollows: vi.fn(),
  setChatFollow: vi.fn(),
  listPersonalChatFeed: vi.fn(),
  markPersonalChatFeedSeen: vi.fn(),
  onWorkspaceActivity: vi.fn(),
  onCloudSessionChanged: vi.fn(),
};

Element.prototype.scrollIntoView = vi.fn();

// The contract listing for a relay that ANSWERED. An unreachable relay
// resolves `{ joined, relay: { state: "unreachable" } }` instead — never an
// empty listing — and a missing session resolves `{ state: "signed-out" }`.
// The joined lane the way main answers it: one entry per channel the
// caller named, carrying the registry row for that channel or null. The fake
// below applies this to every joined-lane read, so a fixture states what the
// registry holds and the scoping is exercised rather than assumed. A fixture
// that answered its own rows regardless of the payload would certify a
// scoping no test ever drove.
function scopeJoinedLane(
  rows: readonly unknown[],
  channelWireIds: readonly string[],
  receivedWireIds: readonly string[] = [],
): Array<{ channelWireId: string; joined: unknown }> {
  const byWire = new Map(
    rows.map((row) => [(row as { channelWireId: string }).channelWireId, row]),
  );
  const named = new Set([...channelWireIds, ...receivedWireIds]);
  return [...named].map((channelWireId) => ({
    channelWireId,
    joined: byWire.get(channelWireId) ?? null,
  }));
}

export function shareListing(
  rows: {
    granted?: unknown[];
    received?: unknown[];
    joined?: unknown[];
    // Answer for exactly these wire ids, whatever the caller named. It models
    // main and the renderer disagreeing about the scope, which is the only
    // condition under which a shown channel goes unanswered — and therefore
    // the only way to observe channelIsLocked's fail-closed rule from outside.
    answerOnly?: string[];
    sessionKey?: string | null;
  } = {},
) {
  return {
    joined: rows.joined ?? [],
    ...(rows.answerOnly ? { answerOnly: rows.answerOnly } : {}),
    sessionKey: rows.sessionKey !== undefined ? rows.sessionKey : "session-a",
    relay: {
      state: "answered" as const,
      granted: rows.granted ?? [],
      received: rows.received ?? [],
    },
  };
}

export const workspaceActivityCallbacks = new Set<() => void>();

export function emitWorkspaceActivity() {
  for (const callback of [...workspaceActivityCallbacks]) callback();
}

const cloudSessionCallbacks = new Set<
  (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void
>();

// Most tests model a whole transition with one event; "changing" is the
// default because for a changed key both phases behave the same, and a
// same-key test must say "ready" explicitly to ask for the revalidation.
export function emitCloudSessionChanged(
  sessionKey: string | null,
  phase: "changing" | "ready" = "changing",
) {
  for (const callback of [...cloudSessionCallbacks]) callback({ sessionKey, phase });
}

beforeEach(() => {
  workspaceActivityCallbacks.clear();
  cloudSessionCallbacks.clear();
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.onWorkspaceActivity.mockImplementation((callback: () => void) => {
    workspaceActivityCallbacks.add(callback);
    return () => {
      workspaceActivityCallbacks.delete(callback);
    };
  });
  bridgeMock.onCloudSessionChanged.mockImplementation(
    (
      callback: (event: {
        sessionKey: string | null;
        phase: "changing" | "ready";
      }) => void,
    ) => {
      cloudSessionCallbacks.add(callback);
      return () => {
        cloudSessionCallbacks.delete(callback);
      };
    },
  );
  bridgeMock.listChatChannels.mockResolvedValue({
    channels: [channel()],
    fileThreads: [],
  });
  bridgeMock.listChatChannelShares.mockResolvedValue(shareListing());
  bridgeMock.listJoinedSharedChannels.mockResolvedValue({ joined: [] });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 0 });
  bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [] });
  bridgeMock.listChatThreadAttachments.mockResolvedValue({ attachments: [] });
  bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: {} });
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
  bridgeMock.listChatBookmarks.mockResolvedValue({ bookmarks: [] });
  bridgeMock.saveChatBookmark.mockResolvedValue({
    bookmark: {
      bookmarkId: "bookmark-1",
      targetKind: "thread",
      targetId: "thread-1",
      threadId: "thread-1",
      mode: "live",
      destinationPath: "Bookmarks/Chats/Friday--thread-1.md",
      state: "active",
      projectionState: "ready",
      generation: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
  });
  bridgeMock.archiveChatBookmark.mockResolvedValue({
    bookmark: {
      bookmarkId: "bookmark-1",
      targetKind: "thread",
      targetId: "thread-1",
      threadId: "thread-1",
      mode: "live",
      destinationPath: "Bookmarks/Chats/Friday--thread-1.md",
      state: "archived",
      projectionState: "ready",
      generation: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
  });
  bridgeMock.listChatFollows.mockResolvedValue({ follows: [] });
  bridgeMock.setChatFollow.mockImplementation(
    (input: {
      target:
        | { kind: "channel"; channelId: string }
        | { kind: "thread"; threadId: string }
        | { kind: "author"; threadId: string; messageId: string };
      state: "following" | "unfollowed";
    }) =>
      Promise.resolve({
        follow: {
          targetKind:
            input.target.kind === "channel"
              ? "channel"
              : input.target.kind === "thread"
                ? "thread"
                : "person",
          targetId:
            input.target.kind === "channel"
              ? "wire-1"
              : input.target.kind === "thread"
                ? input.target.threadId
                : "user-alice",
          state: input.state,
          updatedAtMs: NOW,
        },
      }),
  );
  bridgeMock.listPersonalChatFeed.mockResolvedValue({ items: [] });
  bridgeMock.markPersonalChatFeedSeen.mockResolvedValue({
    readState: {
      lastSeenCreatedAtMs: NOW,
      lastSeenMessageId: "message-1",
      updatedAtMs: NOW,
    },
  });
  bridgeMock.chatDispatchStateForThread.mockResolvedValue({
    liveRunId: null,
    pendingCount: 0,
    paused: false,
  });
  bridgeMock.stopAgentRun.mockResolvedValue(undefined);
  bridgeMock.resumeThreadDispatch.mockResolvedValue(undefined);
  bridgeMock.markChatThreadRead.mockResolvedValue({
    lastReadSequence: 1,
    revision: 1,
  });
  bridgeMock.listChatReactions.mockResolvedValue({
    reactions: [],
    viewerAuthorId: "you@example.com",
  });
  bridgeMock.setChatReaction.mockResolvedValue({
    reaction: {
      reactionId: "r1",
      messageId: "message-1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "you@example.com",
      authorKind: "human",
      authorDisplayName: "you@example.com",
      state: "added",
    },
    viewerAuthorId: "you@example.com",
  });
  // Solo default (collaboration off): the DM surface stays invisible.
  bridgeMock.syncDms.mockResolvedValue({
    available: false,
    dms: [],
    pending: [],
    declined: [],
  });
  bridgeMock.declineDm.mockResolvedValue(undefined);
  bridgeMock.requestDmAgain.mockResolvedValue(undefined);
  // main scopes the joined lane to what the caller named; so does this. The
  // underlying mocks still record every call, so payload assertions and
  // mockImplementation stay exactly as they were.
  vi.stubGlobal("dohcDesktop", {
    ...bridgeMock,
    syncDms: async (payload: { workspaceId: string; openChannelId?: string }) => ({
      pending: [],
      declined: [],
      ...(await bridgeMock.syncDms(payload)),
    }),
    listChatChannelShares: async (payload: {
      workspaceId: string;
      channelWireIds: string[];
    }) => {
      const listing = await bridgeMock.listChatChannelShares(payload);
      if (!listing || !Array.isArray(listing.joined)) return listing;
      const received =
        listing.relay?.state === "answered" ? listing.relay.received ?? [] : [];
      return {
        ...listing,
        joined: listing.answerOnly
          ? scopeJoinedLane(listing.joined, listing.answerOnly)
          : scopeJoinedLane(
              listing.joined,
              payload.channelWireIds,
              received.map((row: { channelWireId: string }) => row.channelWireId),
            ),
      };
    },
    listJoinedSharedChannels: async (payload: {
      workspaceId: string;
      channelWireIds: string[];
    }) => {
      const listing = await bridgeMock.listJoinedSharedChannels(payload);
      if (!listing || !Array.isArray(listing.joined)) return listing;
      return {
        ...listing,
        joined: scopeJoinedLane(listing.joined, payload.channelWireIds),
      };
    },
  });
});

afterEach(() => {
  cleanup();
  workspaceActivityCallbacks.clear();
  cloudSessionCallbacks.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type ExtraProps = Partial<Parameters<typeof ChatsView>[0]>;

export function renderView(onOpenFileChat = vi.fn(), onError = vi.fn(), extra: ExtraProps = {}) {
  render(
    <ChatsView
      workspaceId="workspace-a"
      workspaces={[
        { workspaceId: "workspace-a", label: "Work" },
        { workspaceId: "workspace-b", label: "Personal" },
      ]}
      onOpenFileChat={onOpenFileChat}
      onError={onError}
      {...extra}
    />,
  );
  return { onOpenFileChat, onError };
}

export const mentionRoster = [
  { id: "agent:default", kind: "agent" as const, handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user" as const, handle: "you", label: "You", description: "you" },
];
