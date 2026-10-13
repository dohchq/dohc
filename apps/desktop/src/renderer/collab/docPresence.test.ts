import { identityHues } from "../tokens";
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
  function snapshot(clientId?: string): PresenceSnapshot {
    return {
      version,
      peers: [...entries.values()].map((e) => ({
        ...e,
        isSelf: e.sessionToken === clientId,
      })),
    };
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
        entries.set(clientId, {
          faceToken: clientId,
          sessionToken: clientId,
          isSelf: false,
          displayName: clientId === "a" ? "Alice" : "Bob",
          paletteSlot: 0,
          state,
          updatedAtMs: 0,
        });
        bump();
        return snapshot(clientId);
      },
      async leave({ clientId }) {
        if (entries.delete(clientId)) bump();
      },
      poll({ clientId, since, signal }) {
        if (version !== since) return Promise.resolve(snapshot(clientId));
        return new Promise((resolve) => {
          const w = (s: PresenceSnapshot) =>
            resolve({
              ...s,
              peers: s.peers.map((peer) => ({
                ...peer,
                isSelf: peer.sessionToken === clientId,
              })),
            });
          waiters.add(w);
          signal.addEventListener("abort", () => resolve(snapshot(clientId)), {
            once: true,
          });
        });
      },
    };
  }
  return { make, entries };
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
    expect(a.awareness.getStates().get(docB.clientID)?.user.color).toBe(identityHues.light.rust);
    expect(namesA.mock.calls.at(-1)?.[0]).toEqual(["Bob"]);
    expect(namesB.mock.calls.at(-1)?.[0]).toEqual(["Alice"]);
    const probeDoc = new Y.Doc();
    const probe = new Awareness(probeDoc);
    const published = relay.entries.get("a")!.state as { update: string };
    applyAwarenessUpdate(probe, Buffer.from(published.update, "base64"), "test");
    expect(probe.getStates().get(docA.clientID)).not.toHaveProperty("user");
    probe.destroy();
    probeDoc.destroy();

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
    expect(names).toEqual([]);

    a.destroy();
  });

  it("rejects forged awareness updates: a peer cannot claim another slot or ours", async () => {
    // y-protocols applies whatever clientIDs an update embeds — it never
    // validates ownership. These are the client-side guards: (1) a yc slot is
    // bound to the first server-authenticated presence entry that claimed it,
    // (2) no remote peer may claim our clientID, (3) an update embedding any
    // id other than the claimed yc is rejected wholesale.
    const forgedUpdate = (targetYc: number, name: string): string => {
      const doc = new Y.Doc();
      doc.clientID = targetYc;
      const aw = new Awareness(doc);
      // Bump the clock well past the honest peer's so, unguarded, this forgery
      // would win the awareness merge.
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
      faceToken: "alice",
      sessionToken: "pa",
      isSelf: false,
      displayName: "Alice",
      paletteSlot: 0,
      state: {
        yc: aliceYc,
        update: Buffer.from(encodeAwarenessUpdate(aliceAw, [aliceYc])).toString("base64"),
      },
      updatedAtMs: 0,
    };

    // A controllable transport so each snapshot arrives after we know yc ids.
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
        faceToken: "mallory",
        sessionToken: "pm",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: { yc: aliceYc, update: forgedUpdate(aliceYc, "Impostor") },
        updatedAtMs: 0,
      },
    ]);
    const aliceState = binding.awareness.getStates().get(aliceYc) as {
      user?: { name?: string };
    };
    expect(aliceState?.user?.name).toBe("Alice");
    expect(onPeers.mock.calls.at(-1)?.[0]).not.toContain("Impostor");

    // (2) Mallory claims our clientID: dropped, local state untouched.
    await push([
      alicePeer,
      {
        faceToken: "mallory",
        sessionToken: "pm",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: { yc: localYc, update: forgedUpdate(localYc, "Impostor") },
        updatedAtMs: 0,
      },
    ]);
    const localState = binding.awareness.getLocalState() as {
      user?: { name?: string };
    };
    expect(localState?.user?.name).toBe("Me");

    // (3) Mallory claims her own (unowned) yc but smuggles Alice's id into the
    // update: rejected wholesale — Alice intact and Mallory never applied.
    const smuggleDoc = new Y.Doc();
    smuggleDoc.clientID = 424242;
    const smuggleAw = new Awareness(smuggleDoc);
    smuggleAw.setLocalState({ user: { name: "Mallory", color: "#000" } });
    applyAwarenessUpdate(smuggleAw, Buffer.from(forgedUpdate(aliceYc, "Clone"), "base64"), "test");
    const smuggled = Buffer.from(encodeAwarenessUpdate(smuggleAw, [424242, aliceYc])).toString(
      "base64",
    );
    await push([
      alicePeer,
      {
        faceToken: "mallory",
        sessionToken: "pm",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
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
    // A rogue peer publishes a real Yjs awareness update whose user.name is an
    // object — applyAwarenessUpdate accepts it, so the name filter is the only
    // thing keeping the `string[]` contract of onPeers.
    const rogueDoc = new Y.Doc();
    const rogueAwareness = new Awareness(rogueDoc);
    rogueAwareness.setLocalState({
      user: { name: { evil: true }, color: "#000" },
    });
    const rogueUpdate = Buffer.from(
      encodeAwarenessUpdate(rogueAwareness, [rogueAwareness.clientID]),
    ).toString("base64");

    const malformedPeers: PresencePeer[] = [
      // Non-numeric yc / non-string update: skipped entirely.
      {
        faceToken: "p1",
        sessionToken: "p1",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: { yc: "not-a-number", update: 42 },
        updatedAtMs: 0,
      },
      // Garbage update payload: applyAwarenessUpdate throws, caught locally.
      {
        faceToken: "p2",
        sessionToken: "p2",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: { yc: 7, update: "%%%not-base64%%%" },
        updatedAtMs: 0,
      },
      // Null state: skipped.
      {
        faceToken: "p3",
        sessionToken: "p3",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: null,
        updatedAtMs: 0,
      },
      // Valid update, but the advertised name is not a string.
      {
        faceToken: "p4",
        sessionToken: "p4",
        isSelf: false,
        displayName: null,
        paletteSlot: 0,
        state: { yc: rogueAwareness.clientID, update: rogueUpdate },
        updatedAtMs: 0,
      },
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

it("batches remote changes and skips unchanged snapshots while retaining presentation updates", async () => {
  let notify!: (snapshot: PresenceSnapshot) => void;
  let version = 0;
  const transport: PresenceTransport = {
    async publish() {
      return { version, peers: [] };
    },
    async leave() {},
    poll({ signal }) {
      return new Promise((resolve) => {
        notify = resolve;
        signal.addEventListener("abort", () => resolve({ version, peers: [] }), { once: true });
      });
    },
  };
  const doc = new Y.Doc();
  const onPeers = vi.fn();
  const binding = bindDocPresence({
    doc,
    transport,
    topic: "notes/a.md",
    clientId: "me",
    user: { name: "Me", color: "#fff" },
    onPeers,
  });
  await flush();
  const changes = vi.fn();
  binding.awareness.on("change", changes);
  const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  const awareness = docs.map((doc) => new Awareness(doc));
  const peers: PresencePeer[] = awareness.map((aw, i) => {
    aw.setLocalState({ pointer: { x: i, y: i, tool: "pointer" } });
    return {
      faceToken: "face-" + i,
      sessionToken: "session-" + i,
      isSelf: false,
      displayName: null,
      paletteSlot: i,
      updatedAtMs: 0,
      state: {
        yc: aw.clientID,
        update: Buffer.from(encodeAwarenessUpdate(aw, [aw.clientID])).toString("base64"),
      },
    };
  });
  const push = async (peers: PresencePeer[]) => {
    notify({ version: ++version, peers });
    await flush();
  };
  try {
    await push(peers);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]![0].added).toHaveLength(3);
    expect(onPeers.mock.calls.at(-1)?.[0]).toEqual(["Someone", "Someone", "Someone"]);
    for (const aw of awareness) {
      expect(binding.awareness.getStates().get(aw.clientID)?.user.name).toBe("Someone");
    }
    changes.mockClear();
    await push(peers);
    expect(changes).not.toHaveBeenCalled();
    await push(
      peers.map((peer) => ({
        ...peer,
        displayName: "Named editor",
        paletteSlot: 6,
      })),
    );
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]![0].updated).toHaveLength(3);
    changes.mockClear();
    await push([peers[0]!]);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.mock.calls[0]![0].removed).toHaveLength(2);
    expect(changes.mock.calls[0]![0].updated).toHaveLength(1);
  } finally {
    await binding.destroy();
    doc.destroy();
    awareness.forEach((aw) => aw.destroy());
    docs.forEach((doc) => doc.destroy());
  }
});

it("groups named sessions by face rather than equal display names", async () => {
  const onPeers = vi.fn();
  const doc = new Y.Doc();
  const peer = (faceToken: string, sessionToken: string): PresencePeer => ({
    faceToken,
    sessionToken,
    isSelf: false,
    displayName: "Same name",
    paletteSlot: 0,
    updatedAtMs: 0,
    state: {},
  });
  const binding = bindDocPresence({
    doc,
    topic: "notes/a.md",
    clientId: "me",
    user: { name: "Me", color: "#fff" },
    onPeers,
    transport: {
      async publish() {
        return {
          version: 1,
          peers: [peer("a", "a1"), peer("a", "a2"), peer("b", "b1")],
        };
      },
      async leave() {},
      poll({ signal }) {
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ version: 1, peers: [] }), {
            once: true,
          }),
        );
      },
    },
  });
  await flush();
  expect(onPeers.mock.calls.at(-1)?.[0]).toEqual(["Same name", "Same name"]);
  await binding.destroy();
  doc.destroy();
});
