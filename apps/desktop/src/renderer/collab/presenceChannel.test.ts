import { describe, expect, it, vi } from "vitest";
import {
  createPresenceChannel,
  createRelayPresenceTransport,
  resolvePeerDisplayName,
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
    // pollController.abort() happens synchronously inside stop(), before it
    // awaits any in-flight publish (#742 P2, round 5) — but leave() no
    // longer dispatches synchronously, so it is checked after a flush, not
    // synchronously. stop()'s own returned promise is NOT awaited here: it
    // additionally waits on loopDone, which (in this fake) only settles once
    // resolvePoll runs below — awaiting it here would deadlock the test.
    void channel.stop();
    expect(f.pollAborted()).toBe(true);
    await flush();
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
    expect(() => void channel.stop()).not.toThrow();
  });

  it("stop() during a poll-retry sleep terminates the loop instead of leaking it", async () => {
    // Relay outage: every poll fails, so the loop parks in its retry sleep.
    let polls = 0;
    const transport: PresenceTransport = {
      publish: async () => ({ version: 1, peers: [] }),
      leave: async () => undefined,
      poll: async () => {
        polls += 1;
        throw new Error("relay down");
      },
    };
    const channel = createPresenceChannel({
      transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: vi.fn(),
      // A retry window far longer than the test: only stop() can release it.
      retryMs: 60_000,
    });
    await flush(); // the failed poll has parked the loop in its retry sleep
    expect(polls).toBe(1);
    // stop() must resolve the sleeping promise so the loop observes `stopped`
    // and RETURNS — before the fix it dangled until the 60s timer was GC'd.
    const outcome = await Promise.race([
      channel.stop().then(() => "terminated"),
      new Promise<string>((resolve) => setTimeout(() => resolve("leaked"), 250)),
    ]);
    expect(outcome).toBe("terminated");
    expect(polls).toBe(1); // and it never polled again after stop
  });

  it("stop() tolerates a transport.leave that rejects (no unhandled rejection)", async () => {
    const transport: PresenceTransport = {
      publish: async () => ({ version: 1, peers: [] }),
      leave: async () => {
        throw new Error("leave failed");
      },
      poll: (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => resolve({ version: 0, peers: [] }),
            { once: true },
          );
        }),
    };
    const channel = createPresenceChannel({
      transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: vi.fn(),
    });
    await flush();
    await expect(channel.stop()).resolves.toBeUndefined();
    await flush(); // any unhandled rejection would fail the test run here
  });

  // #742 P2, round 5: awaiting transport.leave alone does not order it after
  // a publish already in flight when stop() is called — a late-arriving
  // publish (a heartbeat, or setState) can reach the transport AFTER leave
  // does, reviving presence the instant after it left (ghost until the
  // relay's TTL). This transport hangs its SECOND publish (the kickoff's
  // first publish settles immediately, matching real startup) until the test
  // releases it, and proves leave is withheld for the whole hang — not just
  // dispatched-then-reordered, which a transport-level spy on call order
  // alone could not distinguish from a real wait.
  it("waits out an in-flight publish before sending leave", async () => {
    let releasePublish!: (snapshot: PresenceSnapshot) => void;
    const publishGate = new Promise<PresenceSnapshot>((resolve) => {
      releasePublish = resolve;
    });
    const leaves: Array<{ topic: string; clientId: string }> = [];
    let publishCalls = 0;
    const transport: PresenceTransport = {
      publish: () => {
        publishCalls += 1;
        return publishCalls === 1
          ? Promise.resolve({ version: 1, peers: [] })
          : publishGate;
      },
      async leave(input) {
        leaves.push(input);
      },
      poll: (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => resolve({ version: 0, peers: [] }),
            { once: true },
          );
        }),
    };
    const channel = createPresenceChannel({
      transport,
      topic: "general",
      clientId: "c1",
      initialState: {},
      onPeers: vi.fn(),
    });
    await flush();
    // A second publish, in flight and hanging — e.g. a heartbeat or setState
    // firing right as stop() is about to run.
    channel.setState({ typing: true });
    expect(publishCalls).toBe(2);

    const stopped = channel.stop();
    await flush();
    expect(leaves).toEqual([]);

    releasePublish({ version: 2, peers: [] });
    await stopped;
    expect(leaves).toEqual([{ topic: "general", clientId: "c1" }]);
  });

  it("serializes overlapping publishes and coalesces to the newest state", async () => {
    const releases: Array<(snapshot: PresenceSnapshot) => void> = [];
    const published: unknown[] = [];
    const transport: PresenceTransport = {
      publish: (input) => {
        published.push(input.state);
        return new Promise((resolve) => releases.push(resolve));
      },
      leave: async () => undefined,
      poll: (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => resolve({ version: 0, peers: [] }),
            { once: true },
          );
        }),
    };
    const channel = createPresenceChannel({
      transport,
      topic: "general",
      clientId: "c1",
      initialState: { n: 0 },
      onPeers: vi.fn(),
    });
    // The initial publish is still in flight. Rapid updates must not start
    // concurrent requests — they coalesce into ONE queued publish that reads
    // the newest state when it runs.
    channel.setState({ n: 1 });
    channel.setState({ n: 2 });
    channel.setState({ n: 3 });
    expect(published).toEqual([{ n: 0 }]);
    releases[0]!({ version: 1, peers: [] });
    await flush();
    expect(published).toEqual([{ n: 0 }, { n: 3 }]);
    releases[1]!({ version: 2, peers: [] });
    await channel.stop();
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

  it("surfaces non-2xx publish/poll responses as rejections — which the channel swallows", async () => {
    const fakeFetch = (async () => new Response("relay says no", { status: 503 })) as unknown as typeof fetch;
    const transport = createRelayPresenceTransport({
      baseUrl: "http://relay.test",
      token: "tok",
      scope: { kind: "workspace", workspaceId: "w" },
      fetch: fakeFetch,
    });
    // The transport boundary: an HTTP error is a rejected promise, never a
    // silently-parsed snapshot.
    await expect(
      transport.publish({ topic: "t", clientId: "c", state: {} }),
    ).rejects.toThrow("presence publish failed: 503");
    await expect(
      transport.poll({ topic: "t", since: 0, signal: new AbortController().signal }),
    ).rejects.toThrow("presence poll failed: 503");

    // The channel contract: those rejections degrade to dark presence and
    // never throw into the UI (no repaint, no unhandled rejection — vitest
    // would fail this test on one).
    const peers = vi.fn();
    const channel = createPresenceChannel({
      transport,
      topic: "t",
      clientId: "c",
      initialState: {},
      onPeers: peers,
      retryMs: 1,
    });
    await flush();
    expect(peers).not.toHaveBeenCalled();
    await expect(channel.stop()).resolves.toBeUndefined();
  });
});

describe("resolvePeerDisplayName", () => {
  const peer = (state: unknown) => ({ userId: "u", clientId: "c", state, updatedAtMs: 0 });

  it("returns the trimmed name and caps hostile lengths", () => {
    // The name a peer publishes is untrusted payload: padding must not leak
    // into faces/typing text, and an unbounded string must not reach the UI.
    expect(resolvePeerDisplayName(peer({ displayName: "  Alice  " }))).toBe("Alice");
    expect(resolvePeerDisplayName(peer({ displayName: "x".repeat(500) }))).toBe("x".repeat(64));
  });

  it("falls back to Someone for missing/blank/non-string names", () => {
    expect(resolvePeerDisplayName(peer(null))).toBe("Someone");
    expect(resolvePeerDisplayName(peer({}))).toBe("Someone");
    expect(resolvePeerDisplayName(peer({ displayName: "   " }))).toBe("Someone");
    expect(resolvePeerDisplayName(peer({ displayName: 42 }))).toBe("Someone");
  });
});
