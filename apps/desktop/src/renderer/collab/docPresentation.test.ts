// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { bindDocPresence } from "./docPresence";
import { caretSelectionRender } from "./caretPresence";
import { identityHues } from "../tokens";
import { deferred } from "../../testing/deferred";
import type { PresenceSnapshot } from "./presenceChannel";

afterEach(() => { delete document.documentElement.dataset.theme; });
it("repaints admitted caret colours and selections on theme changes, then disconnects", async () => {
  const doc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  remote.setLocalState({ cursor: { anchor: 0, head: 0 } });
  const update = Buffer.from(encodeAwarenessUpdate(remote, [remote.clientID])).toString("base64");
  const snapshot: PresenceSnapshot = { version: 1, peers: [{ faceToken: "face", sessionToken: "session", isSelf: false, displayName: "Remote", paletteSlot: 4, state: { yc: remote.clientID, update }, updatedAtMs: 0 }] };
  const later = deferred<PresenceSnapshot>();
  let published = false;
  let closed = false;
  const binding = bindDocPresence({ doc, clientId: "local", topic: "document", user: { name: "You", color: "unused" }, onPeers() {},
    transport: {
      async publish() {
        if (published) return later.promise;
        published = true;
        return snapshot;
      },
      async leave() {},
      poll: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ version: 1, peers: [] }), { once: true })),
    },
  });
  const user = () => binding.awareness.getStates().get(remote.clientID)?.user;
  const change = vi.fn();
  binding.awareness.on("change", change);
  try {
    await expect.poll(() => user()?.color).toBe(identityHues.light.indigo);
    change.mockClear();
    document.documentElement.dataset.theme = "dark";
    await expect.poll(() => user()?.color).toBe(identityHues.dark.indigo);
    expect(caretSelectionRender(user()!).style).toBe("color: " + identityHues.dark.indigo);
    expect(change).toHaveBeenCalledWith({ added: [], updated: [remote.clientID], removed: [] }, "presence-remote");
    later.resolve(snapshot);
    await binding.destroy();
    closed = true;
    const calls = change.mock.calls.length;
    document.documentElement.dataset.theme = "light";
    await Promise.resolve();
    expect(change).toHaveBeenCalledTimes(calls);
  } finally {
    later.resolve(snapshot);
    if (!closed) await binding.destroy();
    remote.destroy(); doc.destroy(); remoteDoc.destroy();
  }
});
