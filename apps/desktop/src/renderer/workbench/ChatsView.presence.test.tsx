// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannelRecord, ChannelThreadRecord, DmRecord } from "../../ipc/bridgeContract";
import {
  ChatsView as ProductionChatsView,
  type ChatPresenceCollaboration,
} from "./ChatsView";
import type {
  PresencePeer,
  PresenceScope,
  PresenceSnapshot,
  PresenceTransport,
} from "../collab/presenceChannel";

// MU-C1 — presence in the Chats surface: gated by collaboration, calm, and
// dormant for solo.

type TestChatsViewProps = Omit<
  Parameters<typeof ProductionChatsView>[0],
  "workspaces"
> & {
  workspaces?: Parameters<typeof ProductionChatsView>[0]["workspaces"];
};

function ChatsView(props: TestChatsViewProps) {
  return (
    <ProductionChatsView
      workspaces={[{ workspaceId: props.workspaceId, label: "Work" }]}
      {...props}
    />
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
  listChatChannels: vi.fn(),
  listChannelThreads: vi.fn(),
  listChatMessages: vi.fn(),
  listChatThreadDecisions: vi.fn(),
  resolveChatDecision: vi.fn(),
  listChatThreadAttachments: vi.fn(),
  chatRunRecordsForThread: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  sendChatMessage: vi.fn(),
  // MU-C4 shared-channel surface: ChatsView loads share state on mount, so
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
  // DM presence (MU-C3 x MU-C1): the DM surface loads through syncDms.
  syncDms: vi.fn(),
  acceptDm: vi.fn(),
  declineDm: vi.fn(),
  requestDmAgain: vi.fn(),
  leaveDm: vi.fn(),
  writeClipboardText: vi.fn(),
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
  const snapshotFor = (topic: string) =>
    snapshots.get(topic) ?? { version: 0, peers: [] };
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
        signal.addEventListener(
          "abort",
          () => finish(snapshotFor(topic)),
          { once: true },
        );
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
  bridgeMock.writeClipboardText.mockResolvedValue(undefined);
  bridgeMock.onWorkspaceActivity.mockReturnValue(() => undefined);
  bridgeMock.onCloudSessionChanged.mockReturnValue(() => undefined);
  bridgeMock.markChatThreadRead.mockResolvedValue({ lastReadSequence: 1, revision: 1 });
  bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "you" });
  // Solo/dormant default: no grants, nothing received, nothing joined — the
  // share load resolves so the overview reaches its ready state.
  bridgeMock.listChatChannelShares.mockResolvedValue({
    joined: [],
    sessionKey: "session-a",
    relay: { state: "answered" as const, granted: [], received: [] },
  });
  // Solo default: no DMs, DM surface unavailable.
  bridgeMock.syncDms.mockResolvedValue({
    available: false,
    dms: [],
    pending: [],
    declined: [],
  });
  vi.stubGlobal("dohcDesktop", {
    ...bridgeMock,
    syncDms: async (payload: { workspaceId: string; openChannelId?: string }) => ({
      pending: [],
      declined: [],
      ...(await bridgeMock.syncDms(payload)),
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// A collaboration whose factory returns the SAME recording transport for every
// scope — the presence tests here exercise a solo/owner (workspace) surface, so
// one transport is enough to observe topics/publishes.
function collabWith(transport: PresenceTransport): ChatPresenceCollaboration {
  return { transportForScope: () => transport, clientId: "me", displayName: "Me" };
}

function renderView(collaboration: ChatPresenceCollaboration | null) {
  render(
    <ChatsView
      workspaceId="workspace-a"
      workspaces={[{ workspaceId: "workspace-a", label: "Work" }]}
      onOpenFileChat={vi.fn()}
      onError={vi.fn()}
      collaboration={collaboration}
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
    // real dormancy signal is the ABSENCE of presence UI (usePresence's own
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
    // A published presence op should have fired for the open thread.
    await waitFor(() => expect(t.publishes.length).toBeGreaterThan(0));
    act(() => {
      t.set([
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        { userId: "bob", clientId: "cb", state: { displayName: "Bob", typing: true }, updatedAtMs: 0 },
      ]);
    });
    expect(await screen.findByLabelText("Bob is here")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("presence-typing").textContent).toContain("Bob is typing"),
    );
  });

  it("scopes thread presence to the THREAD id, so sibling threads never share typing", async () => {
    const t = pushableTransport();
    const user = userEvent.setup();
    renderView(collabWith(t.transport));
    // Channel view publishes into the channel topic — the bare channel wireId
    // (here it falls back to channel.id, "channel-1", since this fixture has no
    // recorded wire mapping), which is exactly the topic the relay's share gate
    // admits so owner + participant meet.
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(t.topics).toContain("channel-1"));
    // …and opening a thread re-scopes presence to the thread's own topic.
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() => expect(t.topics).toContain("chat:thread:thread-1"));
    expect(t.topics.at(-1)).toBe("chat:thread:thread-1");
  });

  it("publishes typing while composing and clears it on send", async () => {
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: {
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

    // Typing into the composer publishes typing: true…
    await user.type(screen.getByTestId("chats-composer"), "hi");
    await waitFor(() =>
      expect(
        t.publishes.some((state) => (state as { typing?: boolean }).typing === true),
      ).toBe(true),
    );
    // …and sending clears it.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalled());
    await waitFor(() =>
      expect((t.publishes.at(-1) as { typing?: boolean }).typing).toBe(false),
    );
  });

  it("shows validated agent working/idle hints on My agent and its thread header", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [agentChannelRecord],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [agentThreadRecord] });
    const t = topicAwareTransport();
    const user = userEvent.setup();
    renderView(collabWith(t.transport));

    // The overview row listens on the stable workspace agent-summary topic,
    // but is completely quiet until the reserved agent client appears.
    await screen.findByTestId("chats-my-agent");
    await waitFor(() => expect(t.topics).toContain("chat:agent"));
    expect(screen.queryByTestId("chats-my-agent-presence")).toBeNull();

    act(() => {
      t.set("chat:agent", [
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        {
          userId: "me",
          clientId: "agent:workspace-a",
          state: { displayName: "Me's agent", agent: true, activity: "busy" },
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
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        {
          userId: "me",
          clientId: "agent:workspace-a",
          state: { displayName: "Me's agent", agent: true, activity: "working" },
          updatedAtMs: 0,
        },
      ]);
    });
    expect(await screen.findByLabelText("Agent is working")).toBeTruthy();
    expect(screen.getByTestId("chats-my-agent-presence").textContent).toBe("working");

    act(() => {
      t.set("chat:agent", [
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        {
          userId: "me",
          clientId: "agent:workspace-a",
          state: { displayName: "Me's agent", agent: true, activity: "idle" },
          updatedAtMs: 0,
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("chats-my-agent-presence").textContent).toBe("idle"),
    );

    await user.click(screen.getByTestId("chats-my-agent"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() => expect(t.topics).toContain("chat:thread:thread-agent"));
    // Summary is still idle, but task presence has not arrived: the task
    // header must not borrow status from the overview topic.
    expect(screen.queryByTestId("chats-thread-agent-presence")).toBeNull();

    act(() => {
      t.set("chat:thread:thread-agent", [
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        {
          userId: "me",
          clientId: "agent:workspace-a",
          state: { displayName: "Me's agent", agent: true, activity: "working" },
          updatedAtMs: 0,
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("chats-thread-agent-presence").textContent).toBe("working"),
    );

    // A lookalike payload without the reserved client id is not agent status.
    act(() => {
      t.set("chat:thread:thread-agent", [
        { userId: "me", clientId: "me", state: { displayName: "Me" }, updatedAtMs: 0 },
        {
          userId: "me",
          clientId: "agent:another-workspace",
          state: { displayName: "Other agent", agent: true, activity: "working" },
          updatedAtMs: 0,
        },
      ]);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("chats-thread-agent-presence")).toBeNull(),
    );
  });
});

// A collaboration that records EVERY scope its factory is asked for, and tags
// each publish with the scope it went out on — so a test can assert which relay
// presence scope (workspace vs share) a conversation lands in, and prove the
// memoized transport is only rebuilt on a real scope switch.
// onLeave (optional) fires synchronously when the presence transport's
// leave() is invoked — used to pin ordering against another async call (e.g.
// #742 P2-E: presence must leave before the leaveDm IPC ends the row).
function recordingCollab(onLeave?: (topic: string) => void) {
  const calls: PresenceScope[] = [];
  const publishes: { scope: PresenceScope; topic: string }[] = [];
  const leaves: { scope: PresenceScope; topic: string }[] = [];
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

function scopeKey(scope: PresenceScope): string {
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
    relay: { state: "answered" as const, granted: [], received: [] },
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

    // PARTICIPANT: the joined channel lands in the GRANTER's scope via a SHARE
    // scope keyed by the grant's shareId, on the channel's cross-machine wireId.
    await openChannelById(user, "channel-joined");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-joined")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-joined")?.scope).toEqual({
      kind: "share",
      shareId: "share-1",
    });

    // OWNER/PLAIN: switching to a channel this account owns flips to the plain
    // WORKSPACE scope, on that channel's own wireId topic.
    await user.click(screen.getByTestId("chats-channel-back"));
    await openChannelById(user, "channel-owned");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-owned")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-owned")?.scope).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });

    // The memoized transport is rebuilt ONLY when the scope actually changes:
    // no two consecutive factory calls share a scope identity (no per-render
    // churn), and both the share and workspace scopes were exercised.
    const keys = rec.calls.map(scopeKey);
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]).not.toBe(keys[i - 1]);
    }
    expect(keys).toContain("share:share-1");
    expect(keys).toContain("ws:workspace-a");
  });

  it("opening a thread inside a JOINED channel keeps SHARE scope on the thread topic", async () => {
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
    relay: { state: "answered" as const, granted: [], received: [] },
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
    // Into the thread: presence re-scopes to the thread's own topic but STAYS
    // in the granter's SHARE scope (a thread of a shared channel is shared too).
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    await waitFor(() =>
      expect(rec.publishes.some((p) => p.topic === "chat:thread:thread-j")).toBe(true),
    );
    expect(rec.publishes.find((p) => p.topic === "chat:thread:thread-j")?.scope).toEqual({
      kind: "share",
      shareId: "share-1",
    });
  });
});

// A DM is a kind:"dm" chat channel backed by a chat-channel grant, so its
// presence folds into the SAME scope/topic derivation: the TOPIC is the DM
// channel's cross-machine wireId; the SCOPE is the grant's share scope for the
// PARTICIPANT (shared to) and the plain workspace scope for the OWNER — the
// exact owner/participant convergence a joined channel uses.
describe("ChatsView presence scope selection (DM)", () => {
  const participantDm: DmRecord = {
    channelId: "dm-local",
    channelWireId: "wire-dm",
    name: "granter@x.com",
    peerLabel: "granter@x.com",
    role: "participant",
    shareId: "dm-share-1",
    threadId: "dm-thread-1",
    unreadCount: 0,
    connected: true,
  };
  const ownerDm: DmRecord = {
    ...participantDm,
    channelId: "dm-owned",
    channelWireId: "wire-dm-owned",
    role: "owner",
    shareId: null,
  };

  async function openDmByChannelId(
    user: ReturnType<typeof userEvent.setup>,
    channelId: string,
  ): Promise<void> {
    const items = await screen.findAllByTestId("chats-dm-item");
    const target = items.find((b) => b.getAttribute("data-channel-id") === channelId);
    if (!target) throw new Error(`no DM item for ${channelId}`);
    await user.click(target);
    await screen.findByTestId("chats-dm-view");
  }

  it("uses SHARE scope + the DM wireId topic for a PARTICIPANT DM", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [participantDm] });
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
    await openDmByChannelId(user, "dm-local");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-dm")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-dm")?.scope).toEqual({
      kind: "share",
      shareId: "dm-share-1",
    });
  });

  it("uses WORKSPACE scope + the DM wireId topic for an OWNER DM", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [ownerDm] });
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
    await openDmByChannelId(user, "dm-owned");
    await waitFor(() =>
      expect(rec.publishes.some((p) => p.topic === "wire-dm-owned")).toBe(true),
    );
    expect(rec.publishes.find((p) => p.topic === "wire-dm-owned")?.scope).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });
  });

  it("switching DM -> channel changes scope and topic (transport rebuilt)", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [channelRecord], fileThreads: [] });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [participantDm] });
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
    // DM first: SHARE scope on the DM wireId.
    await openDmByChannelId(user, "dm-local");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-dm")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-dm")?.scope).toEqual({
      kind: "share",
      shareId: "dm-share-1",
    });
    // Back out and open the plain channel: WORKSPACE scope on the channel topic
    // (the fixture has no wire mapping, so it falls back to channel.id).
    await user.click(screen.getByTestId("chats-dm-back"));
    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-view");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "channel-1")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "channel-1")?.scope).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });
    // The memoized transport rebuilt on the real scope switch: consecutive
    // factory calls never repeat a scope identity, and both scopes were used.
    const keys = rec.calls.map(scopeKey);
    for (let i = 1; i < keys.length; i += 1) expect(keys[i]).not.toBe(keys[i - 1]);
    expect(keys).toContain("share:dm-share-1");
    expect(keys).toContain("ws:workspace-a");
  });

  // #742 P2-E (round 3): leaveDm ends the DM's share, and an ended scope
  // rejects further presence calls (the same ended-grant gate messages use)
  // — so leaveDm must not fire until the presence leave has genuinely
  // SETTLED at the transport, not merely been dispatched. A transport whose
  // leave() resolves synchronously (or a hook-level spy) cannot tell a
  // fire-and-forget void-launch from a real await — both would show
  // "presence-leave" before "leave-dm" in the order array. This transport's
  // leave() hangs until the test releases it, and only records itself AFTER
  // that await — so a void-launch upstream would let leaveDm fire while the
  // release is still pending, which the assertion below catches directly.
  it("awaits the transport leave settling before ending the row", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [participantDm] });
    const order: string[] = [];
    const leaves: { scope: PresenceScope; topic: string }[] = [];
    let releaseLeave!: () => void;
    const leaveGate = new Promise<void>((resolve) => {
      releaseLeave = resolve;
    });
    const collaboration: ChatPresenceCollaboration = {
      transportForScope: (scope) => ({
        async publish() {
          return { version: 0, peers: [] };
        },
        async leave({ topic }) {
          await leaveGate;
          leaves.push({ scope, topic });
          order.push("presence-leave-settled");
        },
        poll: ({ signal }) =>
          new Promise<PresenceSnapshot>((resolve) => {
            if (signal.aborted) return resolve({ version: 0, peers: [] });
            signal.addEventListener("abort", () => resolve({ version: 0, peers: [] }), {
              once: true,
            });
          }),
      }),
      clientId: "me",
      displayName: "Me",
    };
    bridgeMock.leaveDm.mockImplementation(async () => {
      order.push("leave-dm");
    });
    const user = userEvent.setup();
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={collaboration}
      />,
    );
    await openDmByChannelId(user, "dm-local");
    await user.click(await screen.findByTestId("chats-dm-leave"));
    await user.click(await screen.findByTestId("chats-leave-dm-confirm"));

    // The transport leave is still gated: give any (incorrect) fire-and-forget
    // path several ticks to reach leaveDm, then prove it has NOT.
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(bridgeMock.leaveDm).not.toHaveBeenCalled();
    expect(leaves).toEqual([]);

    releaseLeave();
    await waitFor(() => expect(bridgeMock.leaveDm).toHaveBeenCalled());
    expect(leaves).toEqual([{ scope: { kind: "share", shareId: "dm-share-1" }, topic: "wire-dm" }]);
    expect(order).toEqual(["presence-leave-settled", "leave-dm"]);
  });

  // #742 P2 (round 3): leave() already stopped the channel before leaveDm was
  // even called. If leaveDm rejects, the row never ended and this DM stays
  // open — presence must re-arm, or this client reads as gone to peers until
  // it navigates away and back.
  it("re-arms presence with a fresh publish if leaveDm rejects", async () => {
    bridgeMock.listChatChannels.mockResolvedValue({ channels: [], fileThreads: [] });
    bridgeMock.syncDms.mockResolvedValue({ available: true, dms: [participantDm] });
    const rec = recordingCollab();
    bridgeMock.leaveDm.mockRejectedValue(new Error("relay unreachable"));
    const user = userEvent.setup();
    render(
      <ChatsView
        workspaceId="workspace-a"
        onOpenFileChat={vi.fn()}
        onError={vi.fn()}
        collaboration={rec.collaboration}
      />,
    );
    await openDmByChannelId(user, "dm-local");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-dm")).toBe(true));
    const publishesBeforeLeave = rec.publishes.length;

    await user.click(await screen.findByTestId("chats-dm-leave"));
    await user.click(await screen.findByTestId("chats-leave-dm-confirm"));
    await waitFor(() => expect(bridgeMock.leaveDm).toHaveBeenCalled());

    // Still on the DM (leaveDm failed, goBack never ran) — and a fresh
    // channel has published again for the SAME topic/scope.
    expect(await screen.findByTestId("chats-dm-view")).toBeTruthy();
    await waitFor(() =>
      expect(rec.publishes.length).toBeGreaterThan(publishesBeforeLeave),
    );
    expect(rec.publishes.at(-1)).toEqual({
      scope: { kind: "share", shareId: "dm-share-1" },
      topic: "wire-dm",
    });
  });
});

// FIX 3 — presence must not act before its SCOPE is resolved for the CURRENT
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
    let releaseOverview: (value: { channels: ChatChannelRecord[]; fileThreads: [] }) => void = () => {};
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
    relay: { state: "answered" as const, granted: [], received: [] },
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
    // While the share state is unresolved, presence must publish nothing.
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(rec.publishes.length).toBe(0);
    // Land the load; the joined channel now carries resolved share state, so
    // opening it lands presence in the granter's SHARE scope (never workspace).
    await act(async () => {
      releaseOverview({ channels: [joinedChannel], fileThreads: [] });
    });
    await openChannelById(user, "channel-joined");
    await waitFor(() => expect(rec.publishes.some((p) => p.topic === "wire-joined")).toBe(true));
    expect(rec.publishes.find((p) => p.topic === "wire-joined")?.scope).toEqual({
      kind: "share",
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
    // dormant, so wire-owned is NEVER published under a workspace-b scope.
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
      rec.publishes.some(
        (p) => p.topic === "wire-owned" && scopeKey(p.scope) === "ws:workspace-b",
      ),
    ).toBe(false);
  });
});

// Presence waits for the share scope to RESOLVE (sharesWorkspaceId), because a
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
    // The initial lookup never answers; the background one fails.
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
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(1),
    );

    // A read lands. Its background refresh supersedes the stalled initial one.
    view.rerender(<ChatsView {...props(1)} />);
    await waitFor(() =>
      expect(bridgeMock.listChatChannelShares).toHaveBeenCalledTimes(2),
    );

    // Unknown share metadata fails closed, but the scope is RESOLVED, so
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
