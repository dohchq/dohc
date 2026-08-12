import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bindEngineYDoc,
  mergeYDocUpdatesForTransport,
  type EngineYDocBatchScheduler,
  type EngineYDocTransport,
} from "./engineYDocProvider";

// A mock transport standing in for the main-process engine session: it holds a
// "main" Y.Doc, seeds the renderer from it, records every shipped local update,
// and can push a remote delta back. This exercises the renderer half of the
// bridge (seed / ship-local / receive-remote / no-echo) with no Electron.
function mockTransport(
  seedMarkdownLines: string[] = ["Start."],
  applyGate: Promise<void> = Promise.resolve(),
): {
  transport: EngineYDocTransport;
  shipped: Uint8Array[];
  shippedSequences: number[];
  staged: () => number;
  pushRemote: (update: Uint8Array) => void;
  closed: () => boolean;
  events: string[];
  mainDoc: Y.Doc;
} {
  const mainDoc = new Y.Doc();
  mainDoc.transact(() => {
    const frag = mainDoc.getXmlFragment("body");
    for (const line of seedMarkdownLines) {
      const p = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      t.insert(0, line);
      p.insert(0, [t]);
      frag.insert(frag.length, [p]);
    }
  });
  const shipped: Uint8Array[] = [];
  const shippedSequences: number[] = [];
  const events: string[] = [];
  let staged = 0;
  let remoteListener: ((u: Uint8Array) => void) | null = null;
  let closed = false;
  const transport: EngineYDocTransport = {
    async open() {
      return { available: true, initialUpdate: Y.encodeStateAsUpdate(mainDoc) };
    },
    stageLocalUpdate() {
      staged += 1;
      return staged;
    },
    async applyLocalUpdate(update, sequence) {
      shipped.push(update);
      shippedSequences.push(sequence);
      events.push(`apply:${sequence}`);
      // Reflect the shipped edit into the "main" doc, like recordUpdate +
      // apply would, so a subsequent remote diff is computed against it.
      Y.applyUpdate(mainDoc, update);
      await applyGate;
    },
    onRemoteUpdate(listener) {
      remoteListener = listener;
      return () => {
        remoteListener = null;
      };
    },
    async close() {
      closed = true;
      events.push("close");
    },
  };
  return {
    transport,
    shipped,
    shippedSequences,
    staged: () => staged,
    pushRemote: (update) => remoteListener?.(update),
    closed: () => closed,
    events,
    mainDoc,
  };
}

function manualBatchScheduler(): {
  scheduler: EngineYDocBatchScheduler;
  delays: number[];
  pendingCount: () => number;
  runNext: () => Promise<void>;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const order: number[] = [];
  const delays: number[] = [];
  return {
    scheduler: {
      schedule(callback, delayMs) {
        const handle = nextHandle;
        nextHandle += 1;
        callbacks.set(handle, callback);
        order.push(handle);
        delays.push(delayMs);
        return handle;
      },
      cancel(handle) {
        callbacks.delete(handle as number);
      },
    },
    delays,
    pendingCount: () => callbacks.size,
    async runNext() {
      const handle = order.shift();
      if (handle === undefined) throw new Error("No scheduled batch to run");
      const callback = callbacks.get(handle);
      if (!callback) throw new Error("The scheduled batch was cancelled");
      callbacks.delete(handle);
      callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function typeIntoBody(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment("body");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);
  });
}

function bodyText(doc: Y.Doc): string {
  return doc.getXmlFragment("body").toString();
}

function pointerDragUpdates(frameCount: number): {
  seed: Uint8Array;
  updates: Uint8Array[];
} {
  const doc = new Y.Doc();
  // Keep byte evidence stable across runs. Yjs otherwise assigns a random
  // client id whose variable-width encoding changes the measurement.
  doc.clientID = 1;
  const element = new Y.Map<number>();
  doc.getMap<Y.Map<number>>("elements").set("dragged", element);
  const seed = Y.encodeStateAsUpdate(doc);
  const updates: Uint8Array[] = [];
  doc.on("update", (update) => updates.push(update));
  for (let frame = 1; frame <= frameCount; frame += 1) {
    doc.transact(() => {
      element.set("x", frame);
      element.set("y", frame * 2);
    });
  }
  doc.destroy();
  return { seed, updates };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

describe("engine Y.Doc provider — renderer bridge", () => {
  it("measures two- and three-frame batching for a drawing-rate pointer drag", () => {
    // Excalidraw throttles drag mutation to one call per animation frame. At
    // 60 Hz, 120 updates model a two-second drag. Two updates span about 32 ms;
    // three span about 48 ms. Excalidraw sends durable scene changes from each
    // onChange, so we do not take the extra frame. The two-frame window halves
    // transport calls and matches Excalidraw's 33 ms cursor-sync cadence.
    // Source: https://github.com/excalidraw/excalidraw/tree/817d8c553c3389650f8b4503984a6d4a5d2f0c11
    const { seed, updates } = pointerDragUpdates(120);
    const mergedTwoFrames = chunks(updates, 2).map((batch) =>
      Y.mergeUpdates(batch),
    );
    const mergedThreeFrames = chunks(updates, 3).map((batch) =>
      Y.mergeUpdates(batch),
    );
    const rawBytes = updates.reduce((sum, update) => sum + update.byteLength, 0);
    const mergedTwoFrameBytes = mergedTwoFrames.reduce(
      (sum, update) => sum + update.byteLength,
      0,
    );
    const mergedThreeFrameBytes = mergedThreeFrames.reduce(
      (sum, update) => sum + update.byteLength,
      0,
    );

    const rawReceiver = new Y.Doc();
    const twoFrameReceiver = new Y.Doc();
    const threeFrameReceiver = new Y.Doc();
    Y.applyUpdate(rawReceiver, seed);
    Y.applyUpdate(twoFrameReceiver, seed);
    Y.applyUpdate(threeFrameReceiver, seed);
    updates.forEach((update) => Y.applyUpdate(rawReceiver, update));
    mergedTwoFrames.forEach((update) =>
      Y.applyUpdate(twoFrameReceiver, update),
    );
    mergedThreeFrames.forEach((update) =>
      Y.applyUpdate(threeFrameReceiver, update),
    );

    expect({
      rawCalls: updates.length,
      rawBytes,
      twoFrameCalls: mergedTwoFrames.length,
      twoFrameBytes: mergedTwoFrameBytes,
      threeFrameCalls: mergedThreeFrames.length,
      threeFrameBytes: mergedThreeFrameBytes,
    }).toEqual({
      rawCalls: 120,
      rawBytes: 2_890,
      twoFrameCalls: 60,
      twoFrameBytes: 2_298,
      threeFrameCalls: 40,
      threeFrameBytes: 2_099,
    });
    expect(Array.from(Y.encodeStateVector(twoFrameReceiver))).toEqual(
      Array.from(Y.encodeStateVector(rawReceiver)),
    );
    expect(Array.from(Y.encodeStateAsUpdate(twoFrameReceiver))).toEqual(
      Array.from(Y.encodeStateAsUpdate(rawReceiver)),
    );
    expect(Array.from(Y.encodeStateAsUpdate(threeFrameReceiver))).toEqual(
      Array.from(Y.encodeStateAsUpdate(rawReceiver)),
    );
    rawReceiver.destroy();
    twoFrameReceiver.destroy();
    threeFrameReceiver.destroy();
  });

  it("splits a merged batch before it exceeds the existing transport byte contract", () => {
    const { seed, updates } = pointerDragUpdates(6);
    const maxBytes = Y.mergeUpdates(updates.slice(0, 2)).byteLength;
    const batches = mergeYDocUpdatesForTransport(
      updates.map((update, index) => ({ update, sequence: index + 1 })),
      maxBytes,
    );

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.update.byteLength <= maxBytes)).toBe(
      true,
    );
    expect(batches.at(-1)?.sequence).toBe(6);

    const rawReceiver = new Y.Doc();
    const batchedReceiver = new Y.Doc();
    Y.applyUpdate(rawReceiver, seed);
    Y.applyUpdate(batchedReceiver, seed);
    updates.forEach((update) => Y.applyUpdate(rawReceiver, update));
    batches.forEach(({ update }) => Y.applyUpdate(batchedReceiver, update));
    expect(Array.from(Y.encodeStateAsUpdate(batchedReceiver))).toEqual(
      Array.from(Y.encodeStateAsUpdate(rawReceiver)),
    );
    rawReceiver.destroy();
    batchedReceiver.destroy();
  });

  it("seeds the mirror doc from the engine's initial state before binding", async () => {
    const mock = mockTransport(["Seeded from engine."]);
    const batches = manualBatchScheduler();
    const binding = await bindEngineYDoc(mock.transport, batches.scheduler);
    expect(binding.available).toBe(true);
    expect(binding.doc).not.toBeNull();
    expect(bodyText(binding.doc!)).toContain("Seeded from engine.");
    await binding.destroy();
  });

  it("ships a local editor edit to main, and does NOT ship engine-sourced updates back (no echo)", async () => {
    const mock = mockTransport();
    const batches = manualBatchScheduler();
    const binding = await bindEngineYDoc(mock.transport, batches.scheduler);
    const doc = binding.doc!;

    // The seed apply happened under the engine origin: nothing shipped yet.
    expect(mock.shipped.length).toBe(0);

    // A real editor edit is staged immediately, then waits for its batch.
    typeIntoBody(doc, "Local edit.");
    expect(mock.staged()).toBe(1);
    expect(mock.shipped.length).toBe(0);

    // A remote delta main forwards is applied to the mirror but is NOT shipped
    // back (that would echo-storm).
    const before = Y.encodeStateVector(mock.mainDoc);
    typeIntoBody(mock.mainDoc, "Remote peer edit.");
    const remoteDelta = Y.encodeStateAsUpdate(mock.mainDoc, before);
    mock.pushRemote(remoteDelta);

    expect(bodyText(doc)).toContain("Remote peer edit.");
    expect(mock.staged()).toBe(1); // the remote apply was not staged or echoed
    expect(mock.shipped.length).toBe(0);

    await batches.runNext();
    expect(mock.shipped.length).toBe(1);
    expect(mock.shippedSequences).toEqual([1]);
    expect(bodyText(mock.mainDoc)).toContain("Local edit.");

    await binding.destroy();
  });

  it("coalesces consecutive local transactions and sends the newest staged sequence", async () => {
    const mock = mockTransport();
    const batches = manualBatchScheduler();
    const binding = await bindEngineYDoc(mock.transport, batches.scheduler);
    const doc = binding.doc!;

    typeIntoBody(doc, "Frame one.");
    typeIntoBody(doc, "Frame two.");
    typeIntoBody(doc, "Frame three.");

    expect(mock.staged()).toBe(3);
    expect(mock.shipped).toHaveLength(0);
    expect(batches.delays).toEqual([32]);
    expect(batches.pendingCount()).toBe(1);

    await batches.runNext();

    expect(mock.shipped).toHaveLength(1);
    expect(mock.shippedSequences).toEqual([3]);
    expect(bodyText(mock.mainDoc)).toContain("Frame one.");
    expect(bodyText(mock.mainDoc)).toContain("Frame two.");
    expect(bodyText(mock.mainDoc)).toContain("Frame three.");
    await binding.destroy();
  });

  it("falls back (doc:null) when the transport reports the doc is not engine-backed", async () => {
    const transport: EngineYDocTransport = {
      async open() {
        return { available: false };
      },
      stageLocalUpdate() {
        return null;
      },
      applyLocalUpdate() {},
      onRemoteUpdate() {
        return () => undefined;
      },
      async close() {},
    };
    const binding = await bindEngineYDoc(transport);
    expect(binding.available).toBe(false);
    expect(binding.doc).toBeNull();
    await binding.destroy();
  });

  it("destroy closes the engine session and stops shipping edits (idempotent)", async () => {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const mock = mockTransport(["Start."], applyGate);
    const batches = manualBatchScheduler();
    const binding = await bindEngineYDoc(mock.transport, batches.scheduler);
    const doc = binding.doc!;

    typeIntoBody(doc, "Pending at teardown.");
    const destroying = binding.destroy();
    await Promise.resolve();
    expect(mock.events).toEqual(["apply:1"]);
    expect(mock.closed()).toBe(false);
    expect(batches.pendingCount()).toBe(0);

    releaseApply();
    await destroying;
    expect(mock.closed()).toBe(true);
    expect(mock.events).toEqual(["apply:1", "close"]);

    // A post-destroy edit (e.g. a late transaction) must not ship.
    const shippedBefore = mock.shipped.length;
    typeIntoBody(doc, "After destroy.");
    expect(mock.shipped.length).toBe(shippedBefore);

    // Idempotent.
    await binding.destroy();
    expect(mock.events).toEqual(["apply:1", "close"]);
  });
});
