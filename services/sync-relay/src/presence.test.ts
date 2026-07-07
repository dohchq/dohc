import { describe, expect, it } from "vitest";
import { PresenceCapacityError, PresenceHub } from "./presence";

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
