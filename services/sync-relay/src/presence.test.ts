import { afterEach, describe, expect, it, vi } from "vitest";
import { PresenceCapacityError, PresenceHub, presenceScopeKey } from "./presence";

describe("PresenceHub", () => {
  it("publishes and returns a snapshot the publisher can see itself in", () => {
    const hub = new PresenceHub();
    const snap = hub.publish("ws:w:general", "alice", "tab1", { state: "viewing" }, 1000);
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0]).toMatchObject({ userId: "alice", clientId: "tab1" });
    expect(snap.version).toBeGreaterThan(0);
  });

  it("fans two clients into one scope; each sees the other", () => {
    const hub = new PresenceHub();
    hub.publish("ws:w:general", "alice", "tab1", { state: "viewing" }, 1000);
    const snap = hub.publish("ws:w:general", "bob", "tab1", { state: "typing" }, 1001);
    const ids = snap.peers.map((p) => p.userId).sort();
    expect(ids).toEqual(["alice", "bob"]);
  });

  it("isolates distinct scopes — no cross-scope leakage", () => {
    const hub = new PresenceHub();
    hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const other = hub.snapshot("ws:w:secret", 1001);
    expect(other.peers).toHaveLength(0);
  });

  it("clears a presence on explicit leave (disconnect)", () => {
    const hub = new PresenceHub();
    hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const snap = hub.leave("ws:w:general", "alice", "tab1", 1001);
    expect(snap.peers).toHaveLength(0);
    expect(hub.stats().entries).toBe(0);
  });

  it("expires an entry after the TTL without a heartbeat (self-expiring typing)", () => {
    const hub = new PresenceHub({ entryTtlMs: 5000 });
    hub.publish("ws:w:general", "alice", "tab1", { state: "typing" }, 1000);
    // Just under TTL: still present.
    expect(hub.snapshot("ws:w:general", 5999).peers).toHaveLength(1);
    // At/after TTL: dropped.
    expect(hub.snapshot("ws:w:general", 6000).peers).toHaveLength(0);
  });

  it("keeps an entry alive across heartbeats", () => {
    const hub = new PresenceHub({ entryTtlMs: 5000 });
    hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    hub.publish("ws:w:general", "alice", "tab1", {}, 4000); // heartbeat
    expect(hub.snapshot("ws:w:general", 8000).peers).toHaveLength(1); // 8000-4000<5000
  });

  it("returns immediately from wait when the scope already advanced", async () => {
    const hub = new PresenceHub();
    const first = hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    // A poller last saw version 0; the scope is now ahead, so wait resolves now.
    const snap = await hub.wait("ws:w:general", 0, { holdMs: 10_000, nowMs: 1001 });
    expect(snap.version).toBe(first.version);
    expect(snap.peers).toHaveLength(1);
  });

  it("parks wait until a peer publishes, then wakes with the new snapshot", async () => {
    const hub = new PresenceHub();
    const seed = hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const waiting = hub.wait("ws:w:general", seed.version, { holdMs: 10_000, nowMs: 1001 });
    // Bob joins; the parked poller wakes.
    hub.publish("ws:w:general", "bob", "tab1", {}, 1002);
    const snap = await waiting;
    expect(snap.peers.map((p) => p.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("wakes a parked poller when a peer leaves (departure is observable)", async () => {
    const hub = new PresenceHub();
    hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const seed = hub.publish("ws:w:general", "bob", "tab1", {}, 1001);
    const waiting = hub.wait("ws:w:general", seed.version, { holdMs: 10_000, nowMs: 1002 });
    hub.leave("ws:w:general", "bob", "tab1", 1003);
    const snap = await waiting;
    expect(snap.peers.map((p) => p.userId)).toEqual(["alice"]);
  });

  it("a RETRIED leave still wakes parked pollers when it only prunes an expired peer", async () => {
    // Regression: leave() used to gate bump() on deleting the caller's OWN
    // entry, discarding prune()'s result. A duplicate/late leave (entry already
    // gone) that expired a DIFFERENT stale peer in the same call left the
    // version unbumped — parked pollers slept through an observable departure.
    const hub = new PresenceHub({ entryTtlMs: 5_000 });
    hub.publish("ws:w:general", "alice", "tab1", {}, 1_000);
    hub.publish("ws:w:general", "bob", "tab1", {}, 1_001);
    // Alice leaves; her retry below will find her entry already gone.
    const seed = hub.leave("ws:w:general", "alice", "tab1", 1_002);
    const waiting = hub.wait("ws:w:general", seed.version, { holdMs: 60_000, nowMs: 1_003 });
    // The retried leave arrives after Bob's TTL lapsed: it deletes nothing of
    // Alice's but prunes Bob — and that must wake the parked poller.
    hub.leave("ws:w:general", "alice", "tab1", 7_000);
    const snap = await waiting;
    expect(snap.peers).toHaveLength(0);
    expect(hub.stats().waiters).toBe(0);
    hub.dispose();
  });

  it("resolves a parked poll at holdMs with the current snapshot (heartbeat re-poll)", async () => {
    const hub = new PresenceHub();
    const seed = hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const snap = await hub.wait("ws:w:general", seed.version, { holdMs: 1, nowMs: 1001 });
    expect(snap.version).toBe(seed.version);
  });

  it("resolves a parked poll immediately on abort", async () => {
    const hub = new PresenceHub();
    const seed = hub.publish("ws:w:general", "alice", "tab1", {}, 1000);
    const controller = new AbortController();
    const waiting = hub.wait("ws:w:general", seed.version, {
      holdMs: 10_000,
      nowMs: 1001,
      signal: controller.signal,
    });
    controller.abort();
    const snap = await waiting;
    expect(snap.version).toBe(seed.version);
    expect(hub.stats().waiters).toBe(0);
  });

  it("refuses NEW distinct entries past the per-scope cap but allows updates", () => {
    const hub = new PresenceHub({ maxEntriesPerScope: 2 });
    hub.publish("ws:w:general", "a", "t", {}, 1000);
    hub.publish("ws:w:general", "b", "t", {}, 1000);
    expect(() => hub.publish("ws:w:general", "c", "t", {}, 1000)).toThrow(
      PresenceCapacityError,
    );
    // Updating an existing entry is still fine at capacity.
    expect(() => hub.publish("ws:w:general", "a", "t", { x: 1 }, 1001)).not.toThrow();
  });

  it("garbage-collects empty scopes so memory does not accumulate", () => {
    const hub = new PresenceHub();
    hub.publish("ws:w:doc-1", "a", "t", {}, 1000);
    hub.leave("ws:w:doc-1", "a", "t", 1001);
    expect(hub.stats().scopes).toBe(0);
  });

  it("builds scope keys that cannot collide across workspaces (NUL separators)", () => {
    // Distinct (workspace, topic) pairs always produce distinct keys as long
    // as components carry no NUL — which server.ts's parse boundary enforces.
    expect(presenceScopeKey("a", "b")).not.toBe(presenceScopeKey("b", "a"));
    expect(presenceScopeKey("w", "t1")).not.toBe(presenceScopeKey("w", "t2"));
  });

  it("keeps the server-derived userId; a client cannot pass one in", () => {
    // The hub only records the userId the caller (the relay, from the actor)
    // supplies. State is opaque — even if a client stuffed a fake userId into
    // state, attribution is the hub's userId argument, not anything in state.
    const hub = new PresenceHub();
    const snap = hub.publish(
      "ws:w:general",
      "bob",
      "tab1",
      { userId: "alice-spoof", displayName: "Alice" },
      1000,
    );
    expect(snap.peers[0]?.userId).toBe("bob");
  });
});

// The OOM fix: expiry is TIME-DRIVEN, not lazy. A client that publishes into
// many unique topics and then vanishes must be reclaimed by the sweep timer
// even though nothing ever touches those scopes again.
describe("PresenceHub time-driven expiry (sweeper)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes expired entries and GCs their scopes WITHOUT the scopes being touched", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const hub = new PresenceHub({
      entryTtlMs: 5_000,
      sweepIntervalMs: 1_000,
      nowMs: () => now,
    });
    // Spray unique topics, then never touch them again (no leave, no poll).
    for (let i = 0; i < 20; i += 1) {
      hub.publish(presenceScopeKey("w", `topic-${i}`), "ghost", "tab", {}, now);
    }
    expect(hub.stats()).toMatchObject({ scopes: 20, entries: 20 });
    // Time passes beyond the TTL; only the sweep timer runs.
    now = 10_000;
    vi.advanceTimersByTime(1_000);
    expect(hub.stats()).toEqual({ scopes: 0, entries: 0, waiters: 0 });
    hub.dispose();
  });

  it("keeps live entries and reclaims only the expired ones", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const hub = new PresenceHub({ entryTtlMs: 5_000, sweepIntervalMs: 1_000, nowMs: () => now });
    hub.publish(presenceScopeKey("w", "dead"), "a", "t", {}, 1_000);
    now = 4_000;
    hub.publish(presenceScopeKey("w", "live"), "a", "t", {}, 4_000);
    now = 7_000; // "dead" is 6s old (expired); "live" is 3s old.
    vi.advanceTimersByTime(1_000);
    expect(hub.stats()).toMatchObject({ scopes: 1, entries: 1 });
    expect(hub.snapshot(presenceScopeKey("w", "live"), now).peers).toHaveLength(1);
    hub.dispose();
  });

  it("wakes a parked waiter when the sweep expires the last peer", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const hub = new PresenceHub({ entryTtlMs: 5_000, sweepIntervalMs: 1_000, nowMs: () => now });
    const key = presenceScopeKey("w", "general");
    const seed = hub.publish(key, "alice", "tab", {}, now);
    const waiting = hub.wait(key, seed.version, { holdMs: 60_000, nowMs: now });
    now = 10_000;
    vi.advanceTimersByTime(1_000);
    const snap = await waiting;
    expect(snap.peers).toHaveLength(0); // the TTL departure was observable
    expect(hub.stats().waiters).toBe(0);
    hub.dispose();
  });
});

describe("PresenceHub caps (memory is bounded)", () => {
  const key = (ws: string, topic: string) => presenceScopeKey(ws, topic);

  it("caps the GLOBAL scope count", () => {
    const hub = new PresenceHub({ maxScopes: 2 });
    hub.publish(key("w1", "a"), "u", "c", {}, 1_000);
    hub.publish(key("w2", "a"), "u", "c", {}, 1_000);
    expect(() => hub.publish(key("w3", "a"), "u", "c", {}, 1_000)).toThrow(
      PresenceCapacityError,
    );
    // Existing scopes still accept publishes at the cap.
    expect(() => hub.publish(key("w1", "a"), "u", "c2", {}, 1_000)).not.toThrow();
    hub.dispose();
  });

  it("caps scopes PER WORKSPACE without starving other workspaces", () => {
    const hub = new PresenceHub({ maxScopesPerGroup: 2 });
    hub.publish(key("w1", "a"), "u", "c", {}, 1_000);
    hub.publish(key("w1", "b"), "u", "c", {}, 1_000);
    expect(() => hub.publish(key("w1", "c"), "u", "c", {}, 1_000)).toThrow(
      PresenceCapacityError,
    );
    // A different workspace is unaffected by w1 hitting its cap.
    expect(() => hub.publish(key("w2", "a"), "u", "c", {}, 1_000)).not.toThrow();
    hub.dispose();
  });

  it("caps TOTAL entries across all scopes", () => {
    const hub = new PresenceHub({ maxTotalEntries: 2 });
    hub.publish(key("w1", "a"), "u1", "c", {}, 1_000);
    hub.publish(key("w2", "a"), "u2", "c", {}, 1_000);
    expect(() => hub.publish(key("w3", "a"), "u3", "c", {}, 1_000)).toThrow(
      PresenceCapacityError,
    );
    // Updating an existing entry is still allowed at the cap.
    expect(() => hub.publish(key("w1", "a"), "u1", "c", { x: 1 }, 1_001)).not.toThrow();
    // Freeing an entry frees the budget.
    hub.leave(key("w2", "a"), "u2", "c", 1_002);
    expect(() => hub.publish(key("w3", "a"), "u3", "c", {}, 1_003)).not.toThrow();
    hub.dispose();
  });

  it("caps entries PER WORKSPACE without starving other workspaces", () => {
    const hub = new PresenceHub({ maxEntriesPerGroup: 2 });
    hub.publish(key("w1", "a"), "u", "c1", {}, 1_000);
    hub.publish(key("w1", "b"), "u", "c2", {}, 1_000);
    expect(() => hub.publish(key("w1", "c"), "u", "c3", {}, 1_000)).toThrow(
      PresenceCapacityError,
    );
    expect(() => hub.publish(key("w2", "a"), "u", "c1", {}, 1_000)).not.toThrow();
    hub.dispose();
  });

  it("a refused publish allocates nothing (no scope/entry leak)", () => {
    const hub = new PresenceHub({ maxTotalEntries: 1 });
    hub.publish(key("w1", "a"), "u", "c", {}, 1_000);
    expect(() => hub.publish(key("w2", "a"), "u", "c", {}, 1_000)).toThrow(
      PresenceCapacityError,
    );
    expect(hub.stats()).toMatchObject({ scopes: 1, entries: 1 });
    hub.dispose();
  });
});

// The DoS fix: parked long-poll waiters are capped globally, per scope, and
// per actor, and every wake/abort path releases the slot.
describe("PresenceHub parked-waiter caps", () => {
  it("caps TOTAL parked waiters and frees the slot on wake", async () => {
    const hub = new PresenceHub({ maxTotalWaiters: 1 });
    const key = presenceScopeKey("w", "general");
    const seed = hub.publish(key, "a", "c", {}, 1_000);
    const first = hub.wait(key, seed.version, { holdMs: 60_000, nowMs: 1_001 });
    expect(hub.stats().waiters).toBe(1);
    expect(() =>
      hub.wait(key, seed.version, { holdMs: 60_000, nowMs: 1_002 }),
    ).toThrow(PresenceCapacityError);
    // A publish wakes the parked waiter and releases its slot.
    hub.publish(key, "b", "c", {}, 1_003);
    await first;
    expect(hub.stats().waiters).toBe(0);
    const snap = hub.snapshot(key, 1_004);
    expect(() =>
      hub.wait(key, snap.version, { holdMs: 1, nowMs: 1_005 }),
    ).not.toThrow();
    hub.dispose();
  });

  it("caps waiters PER SCOPE independently of other scopes", async () => {
    const hub = new PresenceHub({ maxWaitersPerScope: 1 });
    const keyA = presenceScopeKey("w", "a");
    const keyB = presenceScopeKey("w", "b");
    const seedA = hub.publish(keyA, "u", "c", {}, 1_000);
    const seedB = hub.publish(keyB, "u", "c", {}, 1_000);
    const parked = hub.wait(keyA, seedA.version, { holdMs: 60_000, nowMs: 1_001 });
    expect(() =>
      hub.wait(keyA, seedA.version, { holdMs: 60_000, nowMs: 1_002 }),
    ).toThrow(PresenceCapacityError);
    // Another scope still has budget.
    const parkedB = hub.wait(keyB, seedB.version, { holdMs: 60_000, nowMs: 1_003 });
    hub.publish(keyA, "x", "c", {}, 1_004);
    hub.publish(keyB, "x", "c", {}, 1_005);
    await Promise.all([parked, parkedB]);
    hub.dispose();
  });

  it("caps waiters PER ACTOR so one user cannot exhaust the budget", async () => {
    const hub = new PresenceHub({ maxWaitersPerActor: 1 });
    const key = presenceScopeKey("w", "general");
    const seed = hub.publish(key, "a", "c", {}, 1_000);
    const parked = hub.wait(key, seed.version, {
      holdMs: 60_000,
      nowMs: 1_001,
      actorId: "mallory",
    });
    expect(() =>
      hub.wait(key, seed.version, { holdMs: 60_000, nowMs: 1_002, actorId: "mallory" }),
    ).toThrow(PresenceCapacityError);
    // A different actor still parks fine.
    const other = hub.wait(key, seed.version, {
      holdMs: 60_000,
      nowMs: 1_003,
      actorId: "alice",
    });
    hub.publish(key, "b", "c", {}, 1_004);
    await Promise.all([parked, other]);
    expect(hub.stats().waiters).toBe(0);
    hub.dispose();
  });

  it("an ABORTED waiter (client disconnect) releases its slot immediately", async () => {
    const hub = new PresenceHub({ maxTotalWaiters: 1 });
    const key = presenceScopeKey("w", "general");
    const seed = hub.publish(key, "a", "c", {}, 1_000);
    const controller = new AbortController();
    const parked = hub.wait(key, seed.version, {
      holdMs: 60_000,
      nowMs: 1_001,
      signal: controller.signal,
      actorId: "a",
    });
    controller.abort();
    await parked;
    expect(hub.stats().waiters).toBe(0);
    // The freed slot is immediately reusable.
    const again = hub.wait(key, seed.version, {
      holdMs: 1,
      nowMs: 1_002,
      actorId: "a",
    });
    await again;
    hub.dispose();
  });
});
