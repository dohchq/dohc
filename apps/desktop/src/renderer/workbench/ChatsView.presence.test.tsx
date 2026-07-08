// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannelRecord, ChannelThreadRecord } from "../../ipc/bridgeContract";
import { ChatsView, type ChatPresenceCollaboration } from "./ChatsView";
import type {
  PresencePeer,
  PresenceScope,
  PresenceSnapshot,
  PresenceTransport,
} from "../collab/presenceChannel";

// MU-C1 — presence in the Chats surface: gated by collaboration, calm, and
// dormant for solo.

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

const bridgeMock = {
  listChatChannels: vi.fn(),
  listChannelThreads: vi.fn(),
  listChatMessages: vi.fn(),
  markChatThreadRead: vi.fn(),
  listChatReactions: vi.fn(),
  sendChatMessage: vi.fn(),
  // MU-C4 shared-channel surface: ChatsView loads share state on mount, so
  // the presence tests must stub it even though they exercise a solo view.
  listChatChannelShares: vi.fn(),
  shareChatChannel: vi.fn(),
  joinSharedChannel: vi.fn(),
  leaveSharedChannel: vi.fn(),
  revokeRelayShare: vi.fn(),
  createChatChannel: vi.fn(),
  startChannelThread: vi.fn(),
  setChatReaction: vi.fn(),
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

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listChatChannels.mockResolvedValue({ channels: [channelRecord], fileThreads: [] });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [threadRecord] });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.markChatThreadRead.mockResolvedValue({ lastReadSequence: 1, revision: 1 });
  bridgeMock.listChatReactions.mockResolvedValue({ reactions: [], viewerAuthorId: "you" });
  // Solo/dormant default: no grants, nothing received, nothing joined — the
  // share load resolves so the overview reaches its ready state.
  bridgeMock.listChatChannelShares.mockResolvedValue({ granted: [], received: [], joined: [] });
  vi.stubGlobal("dohcDesktop", bridgeMock);
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
});

// A collaboration that records EVERY scope its factory is asked for, and tags
// each publish with the scope it went out on — so a test can assert which relay
// presence scope (workspace vs share) a conversation lands in, and prove the
// memoized transport is only rebuilt on a real scope switch.
function recordingCollab() {
  const calls: PresenceScope[] = [];
  const publishes: { scope: PresenceScope; topic: string }[] = [];
  const collaboration: ChatPresenceCollaboration = {
    transportForScope: (scope) => {
      calls.push(scope);
      return {
        async publish({ topic }) {
          publishes.push({ scope, topic });
          return { version: 0, peers: [] };
        },
        async leave() {},
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
  return { collaboration, calls, publishes };
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
      granted: [],
      received: [],
      joined: [
        {
          shareId: "share-1",
          channelWireId: "wire-joined",
          access: "read-write",
          granterEmail: null,
          ended: false,
        },
      ],
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
});
