import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { PresencePublishPayload } from "../../ipc/bridgeContract";
import { bindDocPresence } from "./docPresence";
import {
  bindExcalidrawPresence,
  excalidrawPresenceTopic,
} from "./excalidrawPresence";
import type {
  PresencePeer,
  PresenceSnapshot,
  PresenceTransport,
} from "./presenceChannel";

function sharedRelay() {
  const entries = new Map<string, PresencePeer>();
  let version = 0;
  const waiters = new Set<(snapshot: PresenceSnapshot) => void>();
  let publishes = 0;
  const snapshot = (): PresenceSnapshot => ({
    version,
    peers: [...entries.values()].map((peer) => ({ ...peer })),
  });
  const bump = (): void => {
    version += 1;
    const next = snapshot();
    for (const waiter of [...waiters]) waiter(next);
    waiters.clear();
  };
  const make = (): PresenceTransport => ({
    async publish({ clientId, state }) {
      publishes += 1;
      entries.set(clientId, {
        userId: `user-${clientId}`,
        clientId,
        state,
        updatedAtMs: 0,
      });
      bump();
      return snapshot();
    },
    async leave({ clientId }) {
      if (entries.delete(clientId)) bump();
    },
    poll({ since, signal }) {
      if (since !== version) return Promise.resolve(snapshot());
      return new Promise((resolve) => {
        const waiter = (next: PresenceSnapshot) => resolve(next);
        waiters.add(waiter);
        signal.addEventListener(
          "abort",
          () => {
            waiters.delete(waiter);
            resolve(snapshot());
          },
          { once: true },
        );
      });
    },
  });
  return { make, publishes: () => publishes };
}

function fakeApi() {
  const updateScene = vi.fn();
  return {
    api: { updateScene } as unknown as ExcalidrawImperativeAPI,
    updateScene,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

describe("Excalidraw presence", () => {
  it("keys presence by workspace, version, and durable object identity", () => {
    expect(
      excalidrawPresenceTopic({
        workspaceId: "workspace:a",
        versionId: "main",
        objectId: "object:1",
      }),
    ).toBe('scene:["workspace:a","main","object:1"]');
  });

  it("maps cursor and selection awareness to Excalidraw collaborators", async () => {
    const relay = sharedRelay();
    const aliceApi = fakeApi();
    const bobApi = fakeApi();
    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    const alice = bindExcalidrawPresence({
      doc: aliceDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "alice",
      displayName: "Alice",
      getApi: () => aliceApi.api,
    });
    const bob = bindExcalidrawPresence({
      doc: bobDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "bob",
      displayName: "Bob",
      getApi: () => bobApi.api,
    });

    bob.updatePointer({
      pointer: { x: 12, y: 34, tool: "pointer" },
      button: "down",
    });
    bob.updateSelection({ rectangle: true });
    await flush();

    const latest = aliceApi.updateScene.mock.calls.at(-1)?.[0] as {
      collaborators: Map<string, {
        pointer?: { x: number; y: number };
        button?: string;
        selectedElementIds?: Record<string, boolean>;
        username?: string;
      }>;
    };
    expect(latest.collaborators.size).toBe(1);
    expect([...latest.collaborators.values()][0]).toMatchObject({
      username: "Bob",
      pointer: { x: 12, y: 34 },
      button: "down",
      selectedElementIds: { rectangle: true },
    });

    alice.destroy();
    bob.destroy();
    aliceDoc.destroy();
    bobDoc.destroy();
  });

  it("sanitizes malformed remote display state and derives a local color", async () => {
    const relay = sharedRelay();
    const api = fakeApi();
    const localDoc = new Y.Doc();
    const remoteDoc = new Y.Doc();
    const local = bindExcalidrawPresence({
      doc: localDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "local",
      displayName: "Local",
      getApi: () => api.api,
    });
    const remote = bindDocPresence({
      doc: remoteDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "remote",
      user: { name: "Remote", color: "url(javascript:bad)" },
      onPeers: () => undefined,
    });
    const selectedElementIds = Object.create(null) as Record<string, boolean>;
    selectedElementIds.good = true;
    selectedElementIds.falseValue = false;
    // A long VALID id fits the real envelope and must survive; only an id
    // beyond the envelope-derived byte budget is dropped.
    selectedElementIds["long".padEnd(513, "x")] = true;
    selectedElementIds["x".repeat(8192)] = true;
    // Backslashes serialize as two bytes each: 2,000 of them fit a raw
    // UTF-8 count but exceed the byte budget once JSON-escaped.
    selectedElementIds["\\".repeat(2000)] = true;
    selectedElementIds.__proto__ = true;
    selectedElementIds["control\u0000id"] = true;
    selectedElementIds["surrogate\ud800id"] = true;
    remote.awareness.setLocalState({
      user: { name: `\u0000  ${"R".repeat(80)}  `, color: "url(javascript:bad)" },
      pointer: { x: 99_000_000, y: -99_000_000, tool: "pointer" },
      button: "sideways",
      selectedElementIds,
      color: "red",
    });
    await flush();

    const latest = api.updateScene.mock.calls.at(-1)?.[0] as {
      collaborators: Map<string, {
        pointer?: { x: number; y: number };
        button?: string;
        selectedElementIds?: Record<string, boolean>;
        username?: string;
        color?: { background: string; stroke: string };
      }>;
    };
    const collaborator = [...latest.collaborators.values()][0]!;
    expect(collaborator.username).toBe("R".repeat(64));
    expect(collaborator.pointer).toEqual({
      x: 10_000_000,
      y: -10_000_000,
      tool: "pointer",
    });
    expect(collaborator.button).toBeUndefined();
    expect(collaborator.selectedElementIds).toEqual({
      good: true,
      ["long".padEnd(513, "x")]: true,
    });
    expect(Object.getPrototypeOf(collaborator.selectedElementIds)).toBeNull();
    expect(Object.hasOwn(collaborator.selectedElementIds!, "__proto__")).toBe(
      false,
    );
    expect(collaborator.color?.stroke).toMatch(/^#[0-9a-f]{6}$/i);
    expect(collaborator.color?.stroke).not.toContain("url");

    local.destroy();
    remote.destroy();
    localDoc.destroy();
    remoteDoc.destroy();
  });

  it("keeps a maximum sanitized selection inside the 8 KiB presence envelope", async () => {
    const relay = sharedRelay();
    const api = fakeApi();
    const states: unknown[] = [];
    const senderDoc = new Y.Doc();
    const receiverDoc = new Y.Doc();
    const senderTransport = relay.make();
    const sender = bindExcalidrawPresence({
      doc: senderDoc,
      transport: {
        ...senderTransport,
        async publish(input) {
          states.push(input.state);
          return senderTransport.publish(input);
        },
      },
      topic: "scene-1",
      clientId: "local",
      displayName: "L".repeat(64),
      getApi: () => null,
    });
    const receiver = bindExcalidrawPresence({
      doc: receiverDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "receiver",
      displayName: "R",
      getApi: () => api.api,
    });
    const selection = Object.create(null) as Record<string, boolean>;
    for (let index = 99; index >= 0; index -= 1) {
      selection[`id-${String(index).padStart(20, "x")}`] = true;
    }
    sender.updateSelection(selection);
    await flush();

    // Each 23-byte id costs 31 with entry overhead, so exactly 99 of the
    // 100 fit the 3,072-byte id budget. This pins the budget constant: a
    // different headroom changes the kept count.
    const latest = api.updateScene.mock.calls.at(-1)?.[0] as {
      collaborators: Map<
        string,
        { selectedElementIds?: Record<string, boolean> }
      >;
    };
    const collaborator = [...latest.collaborators.values()][0]!;
    expect(Object.keys(collaborator.selectedElementIds!)).toHaveLength(99);

    const state = states.at(-1);
    expect(
      PresencePublishPayload.safeParse({
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        topic: "scene-1",
        clientId: "local",
        state,
      }).success,
    ).toBe(true);
    // The measurement the headroom comment cites: the full-budget selection
    // serializes to ~3,070 bytes of awareness JSON, base64 expands that by
    // 4/3 to ~4,093, and the user wrapper plus framing add only ~310 more —
    // the 4,096-byte headroom is conservative by an order of magnitude.
    const measured = JSON.stringify(states.at(-1)).length;
    expect(measured).toBeGreaterThan(4093);
    expect(measured).toBeLessThan(4093 + 512);

    sender.destroy();
    receiver.destroy();
    senderDoc.destroy();
    receiverDoc.destroy();
  });

  it("drops non-finite pointers and limits cursor publishes to 33ms", async () => {
    const relay = sharedRelay();
    const api = fakeApi();
    const doc = new Y.Doc();
    let now = 0;
    const timers: Array<() => void> = [];
    const binding = bindExcalidrawPresence({
      doc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "local",
      displayName: "Local",
      getApi: () => api.api,
      scheduler: {
        now: () => now,
        schedule: (callback) => {
          timers.push(callback);
          return 1;
        },
        cancel: () => {
          timers.length = 0;
        },
      },
    });
    await flush();
    const initialPublishes = relay.publishes();

    binding.updatePointer({
      pointer: { x: Number.NaN, y: 0, tool: "pointer" },
      button: "up",
    });
    binding.updatePointer({
      pointer: { x: 1, y: 1, tool: "pointer" },
      button: "up",
    });
    binding.updatePointer({
      pointer: { x: 2, y: 2, tool: "pointer" },
      button: "up",
    });
    await flush();
    expect(relay.publishes() - initialPublishes).toBe(1);

    now = 33;
    timers.shift()?.();
    await flush();
    expect(relay.publishes() - initialPublishes).toBe(2);

    binding.destroy();
    doc.destroy();
  });

  it("does not repaint after teardown", async () => {
    const relay = sharedRelay();
    const api = fakeApi();
    const localDoc = new Y.Doc();
    const remoteDoc = new Y.Doc();
    const local = bindExcalidrawPresence({
      doc: localDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "local",
      displayName: "Local",
      getApi: () => api.api,
    });
    const remote = bindExcalidrawPresence({
      doc: remoteDoc,
      transport: relay.make(),
      topic: "scene-1",
      clientId: "remote",
      displayName: "Remote",
      getApi: () => null,
    });
    await flush();
    local.destroy();
    const callsAfterDestroy = api.updateScene.mock.calls.length;

    remote.updatePointer({
      pointer: { x: 1, y: 2, tool: "pointer" },
      button: "up",
    });
    await flush();
    expect(api.updateScene).toHaveBeenCalledTimes(callsAfterDestroy);

    remote.destroy();
    localDoc.destroy();
    remoteDoc.destroy();
  });
});
