import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bindDocPresence } from "./docPresence";
import type { PresencePeer, PresenceSnapshot, PresenceTransport } from "./presenceChannel";

// A relay stand-in that fans publishes from all bound clients into one shared
// scope, so two doc-presence bindings genuinely see each other's Yjs awareness.
function sharedRelay() {
  const entries = new Map<string, PresencePeer>();
  let version = 0;
  const waiters = new Set<(s: PresenceSnapshot) => void>();
  function snapshot(): PresenceSnapshot {
    return { version, peers: [...entries.values()].map((e) => ({ ...e })) };
  }
  function bump() {
    version += 1;
    const snap = snapshot();
    for (const w of [...waiters]) w(snap);
    waiters.clear();
  }
  function make(): PresenceTransport {
    return {
      async publish({ clientId, state }) {
        entries.set(clientId, { userId: clientId, clientId, state, updatedAtMs: 0 });
        bump();
        return snapshot();
      },
      async leave({ clientId }) {
        if (entries.delete(clientId)) bump();
      },
      poll({ since, signal }) {
        if (version !== since) return Promise.resolve(snapshot());
        return new Promise((resolve) => {
          const w = (s: PresenceSnapshot) => resolve(s);
          waiters.add(w);
          signal.addEventListener("abort", () => resolve(snapshot()), { once: true });
        });
      },
    };
  }
  return { make };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("bindDocPresence", () => {
  it("binds a Yjs Awareness to the doc and shares peer names over the transport", async () => {
    const relay = sharedRelay();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const namesA = vi.fn();
    const namesB = vi.fn();

    const a = bindDocPresence({
      doc: docA,
      transport: relay.make(),
      topic: "notes/a.md",
      clientId: "a",
      user: { name: "Alice", color: "#f00" },
      onPeers: namesA,
    });
    const b = bindDocPresence({
      doc: docB,
      transport: relay.make(),
      topic: "notes/a.md",
      clientId: "b",
      user: { name: "Bob", color: "#00f" },
      onPeers: namesB,
    });

    await flush();

    // Alice sees Bob among the doc's editors, via the Yjs Awareness states.
    expect(a.awareness.getStates().size).toBeGreaterThanOrEqual(2);
    expect(namesA.mock.calls.at(-1)?.[0]).toContain("Bob");
    expect(namesB.mock.calls.at(-1)?.[0]).toContain("Alice");

    a.destroy();
    b.destroy();
  });

  it("prunes a departed editor's awareness state when they leave", async () => {
    const relay = sharedRelay();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const namesA = vi.fn();
    const namesB = vi.fn();

    const a = bindDocPresence({
      doc: docA,
      transport: relay.make(),
      topic: "notes/a.md",
      clientId: "a",
      user: { name: "Alice", color: "#f00" },
      onPeers: namesA,
    });
    const b = bindDocPresence({
      doc: docB,
      transport: relay.make(),
      topic: "notes/a.md",
      clientId: "b",
      user: { name: "Bob", color: "#00f" },
      onPeers: namesB,
    });
    await flush();
    expect(namesA.mock.calls.at(-1)?.[0]).toContain("Bob");

    b.destroy();
    await flush();
    // Bob's awareness state is pruned on Alice's side.
    const names = namesA.mock.calls.at(-1)?.[0] as string[];
    expect(names).not.toContain("Bob");

    a.destroy();
  });

  it("rejects forged awareness updates: a peer cannot claim another slot or ours", async () => {
    // y-protocols applies whatever clientIDs an update embeds — it never
    // validates ownership. These are the client-side guards: (1) a yc slot is
    // bound to the first server-authenticated presence entry that claimed it,
    // (2) no remote peer may claim OUR clientID, (3) an update embedding any
    // id other than the claimed yc is rejected wholesale.
    const forgedUpdate = (targetYc: number, name: string): string => {
      const doc = new Y.Doc();
      doc.clientID = targetYc;
      const aw = new Awareness(doc);
      // Bump the clock well past the honest peer's so, unguarded, this forgery
      // WOULD win the awareness merge.
      for (let i = 0; i < 5; i += 1) aw.setLocalState({ user: { name, color: "#000" } });
      const update = Buffer.from(encodeAwarenessUpdate(aw, [targetYc])).toString("base64");
      aw.destroy();
      doc.destroy();
      return update;
    };

    // Honest peer Alice, publishing her real awareness state.
    const aliceDoc = new Y.Doc();
    const aliceAw = new Awareness(aliceDoc);
    aliceAw.setLocalState({ user: { name: "Alice", color: "#f00" } });
    const aliceYc = aliceAw.clientID;
    const alicePeer: PresencePeer = {
      userId: "alice",
      clientId: "pa",
      state: {
        yc: aliceYc,
        update: Buffer.from(encodeAwarenessUpdate(aliceAw, [aliceYc])).toString("base64"),
      },
      updatedAtMs: 0,
    };

    // A controllable transport so each snapshot arrives AFTER we know yc ids.
    let notify: ((s: PresenceSnapshot) => void) | null = null;
    let version = 0;
    const push = async (peers: PresencePeer[]): Promise<void> => {
      for (let i = 0; i < 5 && !notify; i += 1) await Promise.resolve();
      version += 1;
      const fire = notify;
      notify = null;
      fire?.({ version, peers });
      await flush();
    };
    const onPeers = vi.fn();
    const doc = new Y.Doc();
    const binding = bindDocPresence({
      doc,
      transport: {
        async publish() {
          return { version, peers: [] };
        },
        async leave() {},
        poll: ({ signal }) =>
          new Promise((resolve) => {
            notify = resolve;
            signal.addEventListener("abort", () => resolve({ version, peers: [] }), {
              once: true,
            });
          }),
      },
      topic: "notes/a.md",
      clientId: "me",
      user: { name: "Me", color: "#fff" },
      onPeers,
    });
    await flush();
    const localYc = binding.awareness.clientID;

    // Alice joins honestly; her slot is now owned by (alice, pa).
    await push([alicePeer]);
    expect(onPeers.mock.calls.at(-1)?.[0]).toContain("Alice");

    // (1) Mallory claims ALICE's yc with a higher clock: dropped, Alice intact.
    await push([
      alicePeer,
      {
        userId: "mallory",
        clientId: "pm",
        state: { yc: aliceYc, update: forgedUpdate(aliceYc, "Impostor") },
        updatedAtMs: 0,
      },
    ]);
    const aliceState = binding.awareness.getStates().get(aliceYc) as {
      user?: { name?: string };
    };
    expect(aliceState?.user?.name).toBe("Alice");
    expect(onPeers.mock.calls.at(-1)?.[0]).not.toContain("Impostor");

    // (2) Mallory claims OUR clientID: dropped, local state untouched.
    await push([
      alicePeer,
      {
        userId: "mallory",
        clientId: "pm",
        state: { yc: localYc, update: forgedUpdate(localYc, "Impostor") },
        updatedAtMs: 0,
      },
    ]);
    const localState = binding.awareness.getLocalState() as { user?: { name?: string } };
    expect(localState?.user?.name).toBe("Me");

    // (3) Mallory claims her own (unowned) yc but smuggles Alice's id into the
    // update: rejected wholesale — Alice intact AND Mallory never applied.
    const smuggleDoc = new Y.Doc();
    smuggleDoc.clientID = 424242;
    const smuggleAw = new Awareness(smuggleDoc);
    smuggleAw.setLocalState({ user: { name: "Mallory", color: "#000" } });
    applyAwarenessUpdate(
      smuggleAw,
      Buffer.from(forgedUpdate(aliceYc, "Clone"), "base64"),
      "test",
    );
    const smuggled = Buffer.from(
      encodeAwarenessUpdate(smuggleAw, [424242, aliceYc]),
    ).toString("base64");
    await push([
      alicePeer,
      {
        userId: "mallory",
        clientId: "pm",
        state: { yc: 424242, update: smuggled },
        updatedAtMs: 0,
      },
    ]);
    const aliceAfter = binding.awareness.getStates().get(aliceYc) as {
      user?: { name?: string };
    };
    expect(aliceAfter?.user?.name).toBe("Alice");
    expect(binding.awareness.getStates().has(424242)).toBe(false);
    expect(onPeers.mock.calls.at(-1)?.[0]).not.toContain("Mallory");

    binding.destroy();
    smuggleAw.destroy();
    smuggleDoc.destroy();
    aliceAw.destroy();
    aliceDoc.destroy();
    doc.destroy();
  });

  it("tolerates malformed peer state: bad yc/update are skipped, non-string names never reach onPeers", async () => {
    // A rogue peer publishes a REAL Yjs awareness update whose user.name is an
    // object — applyAwarenessUpdate accepts it, so the name filter is the only
    // thing keeping the `string[]` contract of onPeers.
    const rogueDoc = new Y.Doc();
    const rogueAwareness = new Awareness(rogueDoc);
    rogueAwareness.setLocalState({ user: { name: { evil: true }, color: "#000" } });
    const rogueUpdate = Buffer.from(
      encodeAwarenessUpdate(rogueAwareness, [rogueAwareness.clientID]),
    ).toString("base64");

    const malformedPeers: PresencePeer[] = [
      // Non-numeric yc / non-string update: skipped entirely.
      { userId: "p1", clientId: "p1", state: { yc: "not-a-number", update: 42 }, updatedAtMs: 0 },
      // Garbage update payload: applyAwarenessUpdate throws, caught locally.
      { userId: "p2", clientId: "p2", state: { yc: 7, update: "%%%not-base64%%%" }, updatedAtMs: 0 },
      // Null state: skipped.
      { userId: "p3", clientId: "p3", state: null, updatedAtMs: 0 },
      // Valid update, but the advertised name is not a string.
      { userId: "p4", clientId: "p4", state: { yc: rogueAwareness.clientID, update: rogueUpdate }, updatedAtMs: 0 },
    ];

    const onPeers = vi.fn();
    const doc = new Y.Doc();
    const binding = bindDocPresence({
      doc,
      transport: {
        async publish() {
          return { version: 1, peers: malformedPeers };
        },
        async leave() {},
        poll: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ version: 1, peers: [] }), {
              once: true,
            });
          }),
      },
      topic: "notes/a.md",
      clientId: "me",
      user: { name: "Me", color: "#fff" },
      onPeers,
    });
    await flush();

    // Nothing threw, and every reported name is a real string (the rogue
    // object-name peer is represented in awareness but never in names).
    expect(onPeers).toHaveBeenCalled();
    for (const call of onPeers.mock.calls) {
      const names = call[0] as unknown[];
      expect(names.every((name) => typeof name === "string")).toBe(true);
      expect(names).not.toContainEqual({ evil: true });
    }

    binding.destroy();
    rogueAwareness.destroy();
    rogueDoc.destroy();
  });
});
