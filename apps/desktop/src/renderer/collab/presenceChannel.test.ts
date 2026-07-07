import { describe, expect, it, vi } from "vitest";
import {
  createPresenceChannel,
  createRelayPresenceTransport,
  type PresenceSnapshot,
  type PresenceTransport,
} from "./presenceChannel";

// A controllable fake transport: publish/leave are recorded; poll returns a
// promise the test resolves/rejects on demand to drive the loop deterministically.
function fakeTransport() {
  const publishes: Array<{ topic: string; clientId: string; state: unknown }> = [];
  const leaves: Array<{ topic: string; clientId: string }> = [];
  let pendingPoll: {
    resolve: (s: PresenceSnapshot) => void;
    reject: (e: unknown) => void;
    signal: AbortSignal;
  } | null = null;
  const transport: PresenceTransport = {
    async publish(input) {
      publishes.push(input);
      return { version: publishes.length, peers: [{ userId: "me", clientId: input.clientId, state: input.state, updatedAtMs: 0 }] };
    },
    async leave(input) {
      leaves.push(input);
    },
    poll(input) {
      return new Promise((resolve, reject) => {
        pendingPoll = { resolve, reject, signal: input.signal };
      });
    },
  };
  return {
    transport,
    publishes,
    leaves,
    async resolvePoll(snapshot: PresenceSnapshot) {
      // Wait a tick for the loop to register the poll.
      for (let i = 0; i < 5 && !pendingPoll; i += 1) await Promise.resolve();
      pendingPoll?.resolve(snapshot);
      pendingPoll = null;
    },
    pollAborted(): boolean {
      return pendingPoll?.signal.aborted ?? false;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("createPresenceChannel", () => {
  it("publishes the initial state immediately on start", async () => {
    const f = fakeTransport();
    const peers = vi.fn();
    const channel = createPresenceChannel({
      transport: f.transport,
      topic: "general",
      clientId: "c1",
      initialState: { displayName: "Ice", typing: false },
      onPeers: peers,
    });
    await flush();
    expect(f.publishes[0]).toMatchObject({ topic: "general", clientId: "c1" });
    expect(peers).toHaveBeenCalled();
    channel.stop();
  });

  it("updates peers as the poll loop yields new snapshots", async () => {
    const f = fakeTransport();
    const peers = vi.fn();
    const channel = createPresenceChannel({
      transport: f.transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: peers,
    });
    await flush();
    await f.resolvePoll({
      version: 9,
      peers: [
        { userId: "me", clientId: "c1", state: {}, updatedAtMs: 0 },
        { userId: "bob", clientId: "cb", state: { displayName: "Bob" }, updatedAtMs: 0 },
      ],
    });
    await flush();
    const last = peers.mock.calls.at(-1)?.[0] as Array<{ userId: string }>;
    expect(last.map((p) => p.userId).sort()).toEqual(["bob", "me"]);
    channel.stop();
  });

  it("stops cleanly: aborts the poll, leaves, and never repaints after stop", async () => {
    const f = fakeTransport();
    const peers = vi.fn();
    const channel = createPresenceChannel({
      transport: f.transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: peers,
    });
    await flush();
    peers.mockClear();
    channel.stop();
    expect(f.pollAborted()).toBe(true);
    expect(f.leaves).toEqual([{ topic: "general", clientId: "c1" }]);
    // A poll that resolves AFTER stop must not repaint.
    await f.resolvePoll({ version: 99, peers: [{ userId: "x", clientId: "cx", state: {}, updatedAtMs: 0 }] });
    await flush();
    expect(peers).not.toHaveBeenCalled();
  });

  it("setState publishes the new state (e.g. typing on)", async () => {
    const f = fakeTransport();
    const channel = createPresenceChannel({
      transport: f.transport,
      topic: "general",
      clientId: "c1",
      initialState: { typing: false },
      onPeers: vi.fn(),
    });
    await flush();
    channel.setState({ typing: true });
    await flush();
    expect(f.publishes.at(-1)?.state).toMatchObject({ typing: true });
    channel.stop();
  });

  it("degrades gracefully: a failing poll never throws, and stop still works", async () => {
    const transport: PresenceTransport = {
      publish: async () => ({ version: 1, peers: [] }),
      leave: async () => undefined,
      poll: async () => {
        throw new Error("relay down");
      },
    };
    const channel = createPresenceChannel({
      transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: vi.fn(),
      retryMs: 1,
    });
    await flush();
    // No unhandled rejection; stopping is clean.
    expect(() => channel.stop()).not.toThrow();
  });
});

describe("createRelayPresenceTransport", () => {
  it("builds the workspace presence URL and sends the bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, version: 1, peers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = createRelayPresenceTransport({
      baseUrl: "http://relay.test",
      token: "tok",
      scope: { kind: "workspace", workspaceId: "w" },
      fetch: fakeFetch,
    });
    await transport.publish({ topic: "notes/a.md", clientId: "c", state: { x: 1 } });
    expect(calls[0]?.url).toContain("/sync/w/presence?topic=notes%2Fa.md");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("builds the share presence URL", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, version: 0, peers: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = createRelayPresenceTransport({
      baseUrl: "http://relay.test",
      token: "tok",
      scope: { kind: "share", shareId: "share-1" },
      fetch: fakeFetch,
    });
    await transport.poll({ topic: "notes/a.md", since: 3, signal: new AbortController().signal });
    expect(calls[0]).toContain("/sync/shares/share-1/presence?topic=notes%2Fa.md&since=3");
  });
});
