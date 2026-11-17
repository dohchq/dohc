import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatChannelRecord,
  ChannelThreadRecord,
  PresenceScopeInput,
} from "../../ipc/bridgeContract";
import { ChatsView as ProductionChatsView, type ChatPresenceCollaboration } from "./ChatsView";
import { ReactionStoreProvider } from "./reactionStore";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";
import type { PresencePeer, PresenceSnapshot, PresenceTransport } from "../collab/presenceChannel";

type TestChatsViewProps = Parameters<typeof ProductionChatsView>[0];

function ChatsView(props: TestChatsViewProps) {
  return (
    <ReactionStoreProvider workspaceId={props.workspaceId}>
      <ProductionChatsView {...props} />
    </ReactionStoreProvider>
  );
}

const NOW = 1_700_000_000_000;

const channelRecord: ChatChannelRecord = {
  id: "channel-1",
  name: "general",
  slug: "general",
  kind: "channel",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  threadCount: 1,
  unreadCount: 0,
};

const threadRecord: ChannelThreadRecord = {
  id: "thread-1",
  title: "Ship on Friday?",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  channelId: "channel-1",
  messageCount: 1,
  lastReadSequence: 1,
  unreadCount: 0,
};

const agentChannelRecord: ChatChannelRecord = {
  id: "channel-agent",
  name: "My agent",
  slug: "my-agent",
  kind: "agent",
  agentId: "default",
  createdAtMs: NOW,
  updatedAtMs: NOW,
  threadCount: 1,
  unreadCount: 0,
  wireId: "channel-wire-agent",
};

const agentThreadRecord: ChannelThreadRecord = {
  ...threadRecord,
  id: "thread-agent",
  title: "Audit the projections",
  channelId: agentChannelRecord.id,
};

const bridgeMock = {
  readChatDispatchPaused: vi.fn(),
  onChatDispatchPaused: vi.fn(),
  listChatChannels: vi.fn(),
  listChannelThreads: vi.fn(),
  listChatMessages: vi.fn(),
  listChatThreadDecisions: vi.fn(),
  listChatThreadAttachments: vi.fn(),
  chatRunRecordsForThread: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  sendChatMessage: vi.fn(),
  // Shared-channel surface: ChatsView loads share state on mount, so
  // the presence tests must stub it even though they exercise a solo view.
  listChatChannelShares: vi.fn(),
  onCloudSessionChanged: vi.fn(),
  shareChatChannel: vi.fn(),
  joinSharedChannel: vi.fn(),
  leaveSharedChannel: vi.fn(),
  revokeRelayShare: vi.fn(),
  createChatChannel: vi.fn(),
  startChannelThread: vi.fn(),
  setChatReaction: vi.fn(),
  directConversations: vi.fn(),
  onDirectChanged: vi.fn(() => () => {}),
  onWorkspaceActivity: vi.fn(),
};

Element.prototype.scrollIntoView = vi.fn();

function pushableTransport() {
  let snapshot: PresenceSnapshot = { version: 0, peers: [] };
  const waiters = new Set<(s: PresenceSnapshot) => void>();
  const publishes: unknown[] = [];
  const topics: string[] = [];
  function set(peers: PresencePeer[]) {
    snapshot = { version: snapshot.version + 1, peers };
    for (const w of [...waiters]) w(snapshot);
    waiters.clear();
  }
  const transport: PresenceTransport = {
    async publish({ topic, state }) {
      topics.push(topic);
      publishes.push(state);
      return snapshot;
    },
    async leave() {},
    poll({ since, signal }) {
      if (snapshot.version !== since) return Promise.resolve(snapshot);
      return new Promise((resolve) => {
        const w = (s: PresenceSnapshot) => resolve(s);
        waiters.add(w);
        signal.addEventListener("abort", () => resolve(snapshot), { once: true });
      });
    },
  };
  return { transport, set, publishes, topics };
}

// The agent summary and task thread are deliberately different topics. This
// transport keeps their snapshots separate so the UI test proves each hint is
// driven by the right surface instead of leaking one topic's state into both.
function topicAwareTransport() {
  const snapshots = new Map<string, PresenceSnapshot>();
  const waiters = new Map<string, Set<(snapshot: PresenceSnapshot) => void>>();
  const topics: string[] = [];
  const snapshotFor = (topic: string) => snapshots.get(topic) ?? { version: 0, peers: [] };
  function set(topic: string, peers: PresencePeer[]) {
    const current = snapshotFor(topic);
    const snapshot = { version: current.version + 1, peers };
    snapshots.set(topic, snapshot);
    for (const resolve of [...(waiters.get(topic) ?? [])]) resolve(snapshot);
    waiters.delete(topic);
  }
  const transport: PresenceTransport = {
    async publish({ topic }) {
      topics.push(topic);
      return snapshotFor(topic);
    },
    async leave() {},
    poll({ topic, since, signal }) {
      const current = snapshotFor(topic);
      if (current.version !== since) return Promise.resolve(current);
      return new Promise((resolve) => {
        const topicWaiters = waiters.get(topic) ?? new Set();
        const finish = (snapshot: PresenceSnapshot) => {
          topicWaiters.delete(finish);
          resolve(snapshot);
        };
        topicWaiters.add(finish);
        waiters.set(topic, topicWaiters);
        signal.addEventListener("abort", () => finish(snapshotFor(topic)), { once: true });
      });
    },
  };
  return { transport, set, topics };
}

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listChatChannels.mockResolvedValue({ channels: [channelRecord], fileThreads: [] });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [threadRecord] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [] });
  bridgeMock.listChatThreadAttachments.mockResolvedValue({ attachments: [] });
  bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: {} });
  bridgeMock.onWorkspaceActivity.mockReturnValue(() => undefined);
  bridgeMock.readChatDispatchPaused.mockResolvedValue({ paused: false });
  bridgeMock.onChatDispatchPaused.mockReturnValue(() => undefined);
  bridgeMock.onCloudSessionChanged.mockReturnValue(() => undefined);
  bridgeMock.markChatThreadRead.mockResolvedValue({ lastReadSequence: 1, revision: 1 });
  bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "you" });
  // Solo/dormant default: no grants, nothing received, nothing joined — the
  // share load resolves so the overview reaches its ready state.
  bridgeMock.listChatChannelShares.mockResolvedValue({
    joined: [],
    sessionKey: "session-a",
    relay: { state: "answered" as const, granted: [], received: [], removed: [] },
  });
  // Signed out of direct messages.
  bridgeMock.directConversations.mockResolvedValue({ available: false });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// A collaboration whose factory returns the same recording transport for every
// scope — the presence tests here exercise a solo/owner (workspace) surface, so
// one transport is enough to observe topics/publishes.
function collabWith(transport: PresenceTransport): ChatPresenceCollaboration {
  return { transportForScope: () => transport, clientId: "me", displayName: "Me" };
}

function renderView(
  collaboration: ChatPresenceCollaboration | null,
  userSettings?: DesktopUserSettings,
) {
  render(
    <ChatsView
      workspaceId="workspace-a"
      onOpenFileChat={vi.fn()}
      onError={vi.fn()}
      collaboration={collaboration}
      userSettings={userSettings}
    />,
  );
}

async function openThread(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("chats-channel"));
  await user.click(await screen.findByTestId("chats-thread"));
  await screen.findByTestId("chats-thread-view");
}

describe("ChatsView presence (MU-C1)", () => {
  it("is dormant for solo: no transport => no presence UI", async () => {
    // With collaboration null, ChatsView receives no transport at all, so the
    // real dormancy signal is the absence of presence UI (usePresence's own
    // tests lock that a null transport never constructs a channel/publishes).
    const user = userEvent.setup();
    renderView(null); // collaboration off
    await openThread(user);
    // Give any async effects a chance; nothing presence-shaped may render.
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(screen.queryByLabelText(/is here|people here/)).toBeNull();
  });

  it("shows presence faces + typing when a peer is present", async () => {
    const t = pushableTransport();
    const user = userEvent.setup();
    renderView(collabWith(t.transport));
    await openThread(user);
    await waitFor(() => expect(t.publishes.length).toBeGreaterThan(0));
    act(() => {
      t.set([
        {
          faceToken: "me",
          sessionToken: "me",
          isSelf: true,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me" },
          updatedAtMs: 0,
        },
        {
          faceToken: "bob",
          sessionToken: "cb",
          isSelf: false,
          displayName: "Bob",
          paletteSlot: 0,
          state: { displayName: "Bob", typing: true },
          updatedAtMs: 0,
        },
      ]);
    });
    expect(await screen.findByLabelText("Bob is here")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("presence-typing").textContent).toContain("Bob is typing"),
    );
  });

  it("scopes thread presence to the thread id, so sibling threads never share typing", async () => {
    const t = pushableTransport();
    const user = userEvent.setup();
    renderView(collabWith(t.transport));
    // Channel view publishes into the channel topic — the bare channel wireId
    // (here it falls back to channel.id, "channel-1", since this fixture has no
    // recorded wire mapping), which is exactly the topic the relay's share gate
    // admits so owner + participant meet.
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(t.topics).toContain("channel-1"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() => expect(t.topics).toContain("chat:thread:thread-1"));
    expect(t.topics.at(-1)).toBe("chat:thread:thread-1");
  });

  it("publishes typing while composing and clears it on send", async () => {
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: {
        presentation: { group: "fixture", hue: null, self: false },
        id: "message-9",
        threadId: "thread-1",
        authorKind: "human",
        authorDisplayName: "You",
        body: "hi",
        createdAtMs: NOW,
      },
    });
    const t = pushableTransport();
    const user = userEvent.setup();
    renderView(collabWith(t.transport));
    await openThread(user);
    await waitFor(() => expect(t.publishes.length).toBeGreaterThan(0));

    await user.type(screen.getByTestId("chats-composer"), "hi");
    await waitFor(() =>
      expect(t.publishes.some((state) => (state as { typing?: boolean }).typing === true)).toBe(
        true,
      ),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalled());
    await waitFor(() => expect((t.publishes.at(-1) as { typing?: boolean }).typing).toBe(false));
  });

  it("shows validated agent working/idle hints on the agent's chat", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [agentChannelRecord],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [agentThreadRecord] });
    const t = topicAwareTransport();
    renderView(collabWith(t.transport), settingsWithAgent({ name: "Me" }));

    await screen.findByTestId("chats-my-agent");
    await waitFor(() => expect(t.topics).toContain("chat:agent"));
    expect(screen.queryByTestId("chats-my-agent-presence")).toBeNull();

    act(() => {
      t.set("chat:agent", [
        {
          faceToken: "me",
          sessionToken: "me",
          isSelf: true,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me" },
          updatedAtMs: 0,
        },
        {
          faceToken: "me",
          sessionToken: "agent:workspace-a",
          isSelf: false,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me", agent: true, activity: "busy" },
          updatedAtMs: 0,
        },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chats-my-agent-presence")).toBeNull();

    // The workspace's runner working for another agent says nothing here.
    act(() => {
      t.set("chat:agent", [
        {
          faceToken: "me",
          sessionToken: "me",
          isSelf: true,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me" },
          updatedAtMs: 0,
        },
        {
          faceToken: "me",
          sessionToken: "agent:workspace-a",
          isSelf: false,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Scout", agent: true, activity: "working" },
          updatedAtMs: 0,
        },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chats-my-agent-presence")).toBeNull();

    act(() => {
      t.set("chat:agent", [
        {
          faceToken: "me",
          sessionToken: "me",
          isSelf: true,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me" },
          updatedAtMs: 0,
        },
        {
          faceToken: "me",
          sessionToken: "agent:workspace-a",
          isSelf: false,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me", agent: true, activity: "working" },
          updatedAtMs: 0,
        },
      ]);
    });
    expect(await screen.findByLabelText("Agent is working")).toBeTruthy();
    expect(screen.getByTestId("chats-my-agent-presence").textContent).toBe(
      "Running node agent.mjs",
    );

    act(() => {
      t.set("chat:agent", [
        {
          faceToken: "me",
          sessionToken: "me",
          isSelf: true,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me" },
          updatedAtMs: 0,
        },
        {
          faceToken: "me",
          sessionToken: "agent:workspace-a",
          isSelf: false,
          displayName: "Me",
          paletteSlot: 0,
          state: { displayName: "Me", agent: true, activity: "idle" },
          updatedAtMs: 0,
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("chats-my-agent-presence").getAttribute("aria-label")).toBe(
        "Agent is idle",
      ),
    );
    expect(screen.getByTestId("chats-my-agent-presence").textContent).toBe("");
  });
});

// A collaboration that records every scope its factory is asked for, and tags
// each publish with the scope it went out on — so a test can assert which relay
// presence scope (workspace vs share) a conversation lands in, and prove the
// memoized transport is only rebuilt on a real scope switch.
// onLeave (optional) fires synchronously when the presence transport's
// leave() is invoked — used to pin ordering against another async call.
function recordingCollab(onLeave?: (topic: string) => void) {
  const calls: PresenceScopeInput[] = [];
  const publishes: { scope: PresenceScopeInput; topic: string }[] = [];
  const leaves: { scope: PresenceScopeInput; topic: string }[] = [];
  const collaboration: ChatPresenceCollaboration = {
    transportForScope: (scope) => {
      calls.push(scope);
      return {
        async publish({ topic }) {
          publishes.push({ scope, topic });
          return { version: 0, peers: [] };
        },
        async leave({ topic }) {
          leaves.push({ scope, topic });
          onLeave?.(topic);
        },
        poll: ({ signal }) =>
          new Promise<PresenceSnapshot>((resolve) => {
            if (signal.aborted) return resolve({ version: 0, peers: [] });
            signal.addEventListener("abort", () => resolve({ version: 0, peers: [] }), {
              once: true,
            });
          }),
      };
    },
    clientId: "me",
    displayName: "Me",
  };
  return { collaboration, calls, publishes, leaves };
}

function scopeKey(scope: PresenceScopeInput): string {
  return scope.kind === "share" ? `share:${scope.shareId}` : `ws:${scope.workspaceId}`;
}

describe("ChatsView presence scope selection (participant vs owner)", () => {
  const ownedChannel: ChatChannelRecord = {
    id: "channel-owned",
    name: "owned",
    slug: "owned",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    // A plain/owned channel: its local id and cross-machine wire id agree here.
    wireId: "wire-owned",
  };
  const joinedChannel: ChatChannelRecord = {
    id: "channel-joined",
    name: "joined",
    slug: "joined",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    // Shared TO this account: the participant's local id ("channel-joined")
    // differs from the owner's, but the wire id is shared across machines.
    wireId: "wire-joined",
  };

  async function openChannelById(
    user: ReturnType<typeof userEvent.setup>,
    channelId: string,
  ): Promise<void> {
    const buttons = await screen.findAllByTestId("chats-channel");
    const target = buttons.find((b) => b.getAttribute("data-channel-id") === channelId);
    if (!target) throw new Error(`no channel button for ${channelId}`);
    await user.click(target);
    await screen.findByTestId("chats-channel-view");
  }

  it("uses SHARE scope + wire-id topic for a joined channel and WORKSPACE scope for a plain one, rebuilding the transport only on the switch", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [ownedChannel, joinedChannel],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [
        {
          channelWireId: "wire-joined",
          joined: {
            shareId: "share-1",
            channelWireId: "wire-joined",
            access: "read-write",
            granterEmail: null,
            ended: false,
          },
        },
      ],
      sessionKey: "session-a",
      relay: { state: "answered" as const, granted: [], received: [], removed: [] },
    });
    const rec = recordingCollab();
    const user = userEvent.setup();
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );

    await openChannelById(user, "channel-joined");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-joined")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-joined")?.scope).toEqual({
      kind: "share",
      workspaceId: "workspace-a",
      shareId: "share-1",
    });

    await user.click(screen.getByTestId("chats-channel-back"));
    await openChannelById(user, "channel-owned");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-owned")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-owned")?.scope).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });

    // The memoized transport is rebuilt only when the scope actually changes:
    // no two consecutive factory calls share a scope identity (no per-render
    // churn), and both the share and workspace scopes were exercised.
    const keys = rec.calls.map(scopeKey);
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]).not.toBe(keys[i - 1]);
    }
    expect(keys).toContain("share:share-1");
    expect(keys).toContain("ws:workspace-a");
  });

  it("opening a thread inside a joined channel keeps SHARE scope on the thread topic", async () => {
    const joinedThread: ChannelThreadRecord = {
      id: "thread-j",
      title: "Ship it?",
      createdAtMs: NOW,
      updatedAtMs: NOW,
      channelId: "channel-joined",
      messageCount: 1,
      lastReadSequence: 1,
      unreadCount: 0,
    };
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [joinedChannel],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [joinedThread] });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [
        {
          channelWireId: "wire-joined",
          joined: {
            shareId: "share-1",
            channelWireId: "wire-joined",
            access: "read-write",
            granterEmail: null,
            ended: false,
          },
        },
      ],
      sessionKey: "session-a",
      relay: { state: "answered" as const, granted: [], received: [], removed: [] },
    });
    const rec = recordingCollab();
    const user = userEvent.setup();
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );
    await openChannelById(user, "channel-joined");
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() =>
      expect(rec.publishes.some((p) => p.topic === "chat:thread:thread-j")).toBe(true),
    );
    expect(rec.publishes.find((p) => p.topic === "chat:thread:thread-j")?.scope).toEqual({
      kind: "share",
      workspaceId: "workspace-a",
      shareId: "share-1",
    });
  });
});

// FIX 3 — presence must not act before its SCOPE is resolved for the current
// workspace. Scope for a joined channel derives from channelShares (loaded
// async); until that load lands, and after a workspace switch, presence stays
// dormant so it never publishes under a guessed or previous-workspace scope.
describe("ChatsView presence scope gating (loaded share state)", () => {
  const ownedChannel: ChatChannelRecord = {
    id: "channel-owned",
    name: "owned",
    slug: "owned",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    wireId: "wire-owned",
  };
  const joinedChannel: ChatChannelRecord = {
    id: "channel-joined",
    name: "joined",
    slug: "joined",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    wireId: "wire-joined",
  };

  async function openChannelById(
    user: ReturnType<typeof userEvent.setup>,
    channelId: string,
  ): Promise<void> {
    const buttons = await screen.findAllByTestId("chats-channel");
    const target = buttons.find((b) => b.getAttribute("data-channel-id") === channelId);
    if (!target) throw new Error(`no channel button for ${channelId}`);
    await user.click(target);
    await screen.findByTestId("chats-channel-view");
  }

  it("stays dormant while the overview/share load is in flight, then uses SHARE scope once it lands", async () => {
    let releaseOverview: (value: {
      channels: ChatChannelRecord[];
      fileThreads: [];
    }) => void = () => {};
    bridgeMock.listChatChannels.mockReturnValue(
      new Promise((resolve) => {
        releaseOverview = resolve;
      }),
    );
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    bridgeMock.listChatChannelShares.mockResolvedValue({
      joined: [
        {
          channelWireId: "wire-joined",
          joined: {
            shareId: "share-1",
            channelWireId: "wire-joined",
            access: "read-write",
            granterEmail: null,
            ended: false,
          },
        },
      ],
      sessionKey: "session-a",
      relay: { state: "answered" as const, granted: [], received: [], removed: [] },
    });
    const rec = recordingCollab();
    const user = userEvent.setup();
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(rec.publishes.length).toBe(0);
    await act(async () => {
      releaseOverview({ channels: [joinedChannel], fileThreads: [] });
    });
    await openChannelById(user, "channel-joined");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-joined")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-joined")?.scope).toEqual({
      kind: "share",
      workspaceId: "workspace-a",
      shareId: "share-1",
    });
  });

  it("a workspace switch never publishes the old channel under the new workspace's scope", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [ownedChannel], fileThreads: [] });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    const rec = recordingCollab();
    const user = userEvent.setup();
    const view = render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );
    await openChannelById(user, "channel-owned");
    await waitFor(() =>
      expect(
        rec.publishes.some(
          (p) => p.topic === "wire-owned" && scopeKey(p.scope) === "ws:workspace-a",
        ),
      ).toBe(true),
    );
    // Switch workspaces. The stale-nav render still points at workspace-a's
    // channel while workspaceId is already workspace-b — the gate keeps presence
    // dormant, so wire-owned is never published under a workspace-b scope.
    view.rerender(
      <ChatsView
        workspaceId="workspace-b"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(
      rec.publishes.some((p) => p.topic === "wire-owned" && scopeKey(p.scope) === "ws:workspace-b"),
    ).toBe(false);
  });
});

// Presence waits for the share scope to resolve (sharesWorkspaceId), because a
// joined channel's scope is derived from the share metadata. Preserving cached
// metadata on a failed background refresh is right — but only when something
// was cached. A background refresh supersedes an initial request still in
// flight, so if it also declined to commit its own failed lookup, nothing
// would ever resolve the scope and presence would stay dormant for good.
describe("ChatsView presence when the first share lookup never answers", () => {
  const ownedChannel: ChatChannelRecord = {
    id: "channel-owned",
    name: "owned",
    slug: "owned",
    kind: "channel",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    threadCount: 0,
    unreadCount: 0,
    wireId: "wire-owned",
  };

  it("resolves the scope from a failed background lookup rather than hanging", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [ownedChannel],
      fileThreads: [],
    });
    let initial = true;
    bridgeMock.listChatChannelShares.mockImplementation(() => {
      if (initial) {
        initial = false;
        return new Promise(() => {});
      }
      return Promise.reject(new Error("signed out"));
    });
    const rec = recordingCollab();
    const user = userEvent.setup();
    const props = (readRevision: number) => ({
      workspaceId: "workspace-a",
      onOpenFileChat: vi.fn(),
      onError: vi.fn(),
      collaboration: rec.collaboration,
      readRevision,
    });
    const view = render(<ChatsView {...props(0)} />);
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1));

    view.rerender(<ChatsView {...props(1)} />);
    await waitFor(() => expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2));

    // Unknown share metadata fails closed, but the scope is resolved, so
    // presence runs instead of waiting on a request that will never answer.
    const buttons = await screen.findAllByTestId("chats-channel");
    await user.click(buttons[0]);
    await screen.findByTestId("chats-channel-view");
    await waitFor(() =>
      expect(
        rec.publishes.some(
          (p) => p.topic === "wire-owned" && scopeKey(p.scope) === "ws:workspace-a",
        ),
      ).toBe(true),
    );
  });
});
