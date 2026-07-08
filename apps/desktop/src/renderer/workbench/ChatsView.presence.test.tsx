// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannelRecord, ChannelThreadRecord } from "../../ipc/bridgeContract";
import { ChatsView, type ChatPresenceCollaboration } from "./ChatsView";
import type { PresencePeer, PresenceSnapshot, PresenceTransport } from "../collab/presenceChannel";

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
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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
    renderView({ transport: t.transport, clientId: "me", displayName: "Me" });
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
    renderView({ transport: t.transport, clientId: "me", displayName: "Me" });
    // Channel view publishes into the channel topic…
    await user.click(await screen.findByTestId("chats-channel"));
    await waitFor(() => expect(t.topics).toContain("chat:channel:channel-1"));
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
    renderView({ transport: t.transport, clientId: "me", displayName: "Me" });
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
