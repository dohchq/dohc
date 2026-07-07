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
      onPeers: namesA,
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
});
