import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  bindEngineYDoc,
  EngineYDocDeliveryRefusedError,
  type EngineYDocTransport,
} from "./engineYDocProvider";

// A mock transport standing in for the main-process engine session: it holds a
// "main" Y.Doc, seeds the renderer from it, records every shipped local update,
// and can push a remote delta back. This exercises the renderer half of the
// bridge (seed / ship-local / receive-remote / no-echo) with no Electron.
function mockTransport(seedMarkdownLines: string[] = ["Start."]): {
  transport: EngineYDocTransport;
  shipped: Uint8Array[];
  shippedGenerations: number[];
  pushRemote: (update: Uint8Array, lineageGeneration?: number) => void;
  replaceLineage: (input: {
    update: Uint8Array;
    recoveredPaths: string[];
    lineageGeneration: number;
  }) => Promise<void>;
  releaseReplacement: () => void;
  bufferDuringReplacement: (update: Uint8Array) => void;
  acknowledgedGenerations: number[];
  closed: () => boolean;
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
  const shippedGenerations: number[] = [];
  let remoteListener:
    | ((update: Uint8Array, lineageGeneration: number) => void)
    | null = null;
  let replacementListener:
    | ((input: {
        update: Uint8Array;
        recoveredPaths: string[];
        lineageGeneration: number;
      }) => void | Promise<void>)
    | null = null;
  let releaseReplacement!: () => void;
  const replacementReleased = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  const acknowledgedGenerations: number[] = [];
  const bufferedReplacementUpdates: Uint8Array[] = [];
  let closed = false;
  const transport: EngineYDocTransport = {
    async open() {
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(mainDoc),
        lineageGeneration: 1,
      };
    },
    async applyLocalUpdate(update, lineageGeneration) {
      shipped.push(update);
      shippedGenerations.push(lineageGeneration);
      // Reflect the shipped edit into the "main" doc, like recordUpdate +
      // apply would, so a subsequent remote diff is computed against it.
      Y.applyUpdate(mainDoc, update);
    },
    onRemoteUpdate(listener) {
      remoteListener = listener;
      return () => {
        remoteListener = null;
      };
    },
    onLineageReplacement(listener) {
      replacementListener = listener;
      return () => {
        replacementListener = null;
      };
    },
    async acknowledgeLineageReplacement(lineageGeneration) {
      acknowledgedGenerations.push(lineageGeneration);
      await replacementReleased;
      return bufferedReplacementUpdates.splice(0);
    },
    async close() {
      closed = true;
    },
  };
  return {
    transport,
    shipped,
    shippedGenerations,
    pushRemote: (update, lineageGeneration = 1) =>
      remoteListener?.(update, lineageGeneration),
    replaceLineage: async (input) => {
      await replacementListener?.(input);
    },
    releaseReplacement,
    bufferDuringReplacement: (update) => bufferedReplacementUpdates.push(update),
    acknowledgedGenerations,
    closed: () => closed,
    mainDoc,
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

describe("engine Y.Doc provider — renderer bridge", () => {
  it("does not lose a lineage replacement announced while open is in flight", async () => {
    const initial = new Y.Doc();
    typeIntoBody(initial, "Losing root.");
    const winner = new Y.Doc();
    typeIntoBody(winner, "Winning root.");
    let replacementListener:
      | ((input: {
          update: Uint8Array;
          recoveredPaths: string[];
          lineageGeneration: number;
        }) => void | Promise<void>)
      | null = null;
    const acknowledged: number[] = [];
    const transport: EngineYDocTransport = {
      async open() {
        void replacementListener?.({
          update: Y.encodeStateAsUpdate(winner),
          recoveredPaths: [],
          lineageGeneration: 2,
        });
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(initial),
          lineageGeneration: 1,
        };
      },
      async applyLocalUpdate() {},
      onRemoteUpdate() {
        return () => undefined;
      },
      onLineageReplacement(listener) {
        replacementListener = listener;
        return () => {
          replacementListener = null;
        };
      },
      async acknowledgeLineageReplacement(lineageGeneration) {
        acknowledged.push(lineageGeneration);
        return [];
      },
      async close() {},
    };

    const binding = await bindEngineYDoc(transport);
    await vi.waitFor(() => expect(acknowledged).toEqual([2]));

    expect(bodyText(binding.doc!)).toContain("Winning root.");
    expect(bodyText(binding.doc!)).not.toContain("Losing root.");
    await binding.destroy();
  });

  it("seeds the mirror doc from the engine's initial state before binding", async () => {
    const mock = mockTransport(["Seeded from engine."]);
    const binding = await bindEngineYDoc(mock.transport);
    expect(binding.available).toBe(true);
    expect(binding.doc).not.toBeNull();
    expect(bodyText(binding.doc!)).toContain("Seeded from engine.");
    await binding.destroy();
  });

  it("ships a local editor edit to main, and does NOT ship engine-sourced updates back (no echo)", async () => {
    const mock = mockTransport();
    const binding = await bindEngineYDoc(mock.transport);
    const doc = binding.doc!;

    // The seed apply happened under the engine origin: nothing shipped yet.
    expect(mock.shipped.length).toBe(0);

    // A real editor edit ships to main.
    typeIntoBody(doc, "Local edit.");
    expect(mock.shipped.length).toBe(1);

    // A remote delta main forwards is applied to the mirror but is NOT shipped
    // back (that would echo-storm).
    const before = Y.encodeStateVector(mock.mainDoc);
    typeIntoBody(mock.mainDoc, "Remote peer edit.");
    const remoteDelta = Y.encodeStateAsUpdate(mock.mainDoc, before);
    mock.pushRemote(remoteDelta);

    expect(bodyText(doc)).toContain("Remote peer edit.");
    expect(mock.shipped.length).toBe(1); // still just the one local edit

    await binding.destroy();
  });

  it("falls back (doc:null) when the transport reports the doc is not engine-backed", async () => {
    const transport: EngineYDocTransport = {
      async open() {
        return { available: false };
      },
      async applyLocalUpdate() {},
      onRemoteUpdate() {
        return () => undefined;
      },
      onLineageReplacement() {
        return () => undefined;
      },
      async acknowledgeLineageReplacement() {
        return [];
      },
      async close() {},
    };
    const binding = await bindEngineYDoc(transport);
    expect(binding.available).toBe(false);
    expect(binding.doc).toBeNull();
    await binding.destroy();
  });

  it("destroy closes the engine session and stops shipping edits (idempotent)", async () => {
    const mock = mockTransport();
    const binding = await bindEngineYDoc(mock.transport);
    const doc = binding.doc!;

    await binding.destroy();
    expect(mock.closed()).toBe(true);

    // A post-destroy edit (e.g. a late transaction) must not ship.
    const shippedBefore = mock.shipped.length;
    typeIntoBody(doc, "After destroy.");
    expect(mock.shipped.length).toBe(shippedBefore);

    // Idempotent.
    await binding.destroy();
  });

  it("waits for an in-flight local update before closing", async () => {
    const mock = mockTransport();
    let releaseUpdate!: () => void;
    const pendingUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    mock.transport.applyLocalUpdate = async (update) => {
      await pendingUpdate;
      Y.applyUpdate(mock.mainDoc, update);
    };
    const binding = await bindEngineYDoc(mock.transport);
    typeIntoBody(binding.doc!, "Final edit.");

    const destroying = binding.destroy();
    await Promise.resolve();
    expect(mock.closed()).toBe(false);

    releaseUpdate();
    await destroying;
    expect(mock.closed()).toBe(true);
    expect(bodyText(mock.mainDoc)).toContain("Final edit.");
  });

  it("repairs a rejected incremental update with the final full mirror state", async () => {
    const mock = mockTransport();
    let attempts = 0;
    mock.transport.applyLocalUpdate = async (update) => {
      attempts += 1;
      if (attempts === 1) throw new Error("delivery failed");
      Y.applyUpdate(mock.mainDoc, update);
    };
    const binding = await bindEngineYDoc(mock.transport);
    typeIntoBody(binding.doc!, "Recovered edit.");

    await binding.destroy();

    expect(attempts).toBe(2);
    expect(bodyText(mock.mainDoc)).toContain("Recovered edit.");
    expect(mock.closed()).toBe(true);
  });

  it("repairs a rejected update while the document remains open", async () => {
    const mock = mockTransport();
    let attempts = 0;
    let rejectFirst!: (error: Error) => void;
    const firstDelivery = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    mock.transport.applyLocalUpdate = async (update) => {
      attempts += 1;
      if (attempts === 1) return firstDelivery;
      Y.applyUpdate(mock.mainDoc, update);
    };
    const binding = await bindEngineYDoc(mock.transport);

    typeIntoBody(binding.doc!, "Edit A.");
    typeIntoBody(binding.doc!, "Edit B.");
    expect(attempts).toBe(2);

    rejectFirst(new Error("delivery failed"));
    for (let turn = 0; turn < 10 && attempts < 3; turn += 1) {
      await Promise.resolve();
    }

    expect(attempts).toBe(3);
    expect(bodyText(mock.mainDoc)).toContain("Edit A.");
    expect(bodyText(mock.mainDoc)).toContain("Edit B.");

    await binding.destroy();
    expect(attempts).toBe(3);
  });

  it("immediately repairs the full current state when an edit arrives during a failed repair", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockTransport();
      let attempts = 0;
      let rejectRepair!: (error: Error) => void;
      const heldRepair = new Promise<void>((_resolve, reject) => {
        rejectRepair = reject;
      });
      mock.transport.applyLocalUpdate = async (update) => {
        attempts += 1;
        if (attempts === 1) throw new Error("incremental delivery failed");
        if (attempts === 2) return heldRepair;
        Y.applyUpdate(mock.mainDoc, update);
      };
      const binding = await bindEngineYDoc(mock.transport);

      typeIntoBody(binding.doc!, "Edit A.");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);

      typeIntoBody(binding.doc!, "Edit B.");
      expect(attempts).toBe(3);
      expect(bodyText(mock.mainDoc)).not.toContain("Edit A.");
      expect(bodyText(mock.mainDoc)).not.toContain("Edit B.");

      rejectRepair(new Error("full-state repair failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(attempts).toBe(4);
      expect(bodyText(mock.mainDoc)).toContain("Edit A.");
      expect(bodyText(mock.mainDoc)).toContain("Edit B.");

      await binding.destroy();
      expect(attempts).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries outstanding delivery debt when another edit arrives", async () => {
    const mock = mockTransport();
    let attempts = 0;
    mock.transport.applyLocalUpdate = async (update) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("delivery failed");
      Y.applyUpdate(mock.mainDoc, update);
    };
    const binding = await bindEngineYDoc(mock.transport);

    typeIntoBody(binding.doc!, "Edit A.");
    for (let turn = 0; turn < 10 && attempts < 2; turn += 1) {
      await Promise.resolve();
    }
    expect(attempts).toBe(2);

    typeIntoBody(binding.doc!, "Edit B.");
    for (let turn = 0; turn < 10 && attempts < 4; turn += 1) {
      await Promise.resolve();
    }

    expect(attempts).toBe(4);
    expect(bodyText(mock.mainDoc)).toContain("Edit A.");
    expect(bodyText(mock.mainDoc)).toContain("Edit B.");

    await binding.destroy();
    expect(attempts).toBe(4);
  });

  it("retries failed live repair after backoff without another edit", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockTransport();
      let attempts = 0;
      mock.transport.applyLocalUpdate = async (update) => {
        attempts += 1;
        if (attempts <= 2) throw new Error("delivery unavailable");
        Y.applyUpdate(mock.mainDoc, update);
      };
      const binding = await bindEngineYDoc(mock.transport);

      typeIntoBody(binding.doc!, "Recovered after backoff.");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);
      expect(bodyText(mock.mainDoc)).not.toContain("Recovered after backoff.");

      await vi.advanceTimersByTimeAsync(249);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(attempts).toBe(3);
      expect(bodyText(mock.mainDoc)).toContain("Recovered after backoff.");

      await binding.destroy();
      await vi.runAllTimersAsync();
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled live repair before final teardown recovery", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockTransport();
      let attempts = 0;
      mock.transport.applyLocalUpdate = async (update) => {
        attempts += 1;
        if (attempts <= 2) throw new Error("delivery unavailable");
        Y.applyUpdate(mock.mainDoc, update);
      };
      const binding = await bindEngineYDoc(mock.transport);

      typeIntoBody(binding.doc!, "Recovered on close.");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);

      await binding.destroy();
      expect(attempts).toBe(3);
      expect(bodyText(mock.mainDoc)).toContain("Recovered on close.");

      await vi.runAllTimersAsync();
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures the final mirror before close when delivery stays unavailable", async () => {
    const mock = mockTransport();
    const order: string[] = [];
    mock.transport.applyLocalUpdate = async () => {
      throw new Error("delivery stayed unavailable");
    };
    mock.transport.close = async () => {
      order.push("close");
    };
    const binding = await bindEngineYDoc(mock.transport, {
      onDeliveryFailure(snapshot) {
        const recovered = new Y.Doc();
        Y.applyUpdate(recovered, snapshot);
        expect(bodyText(recovered)).toContain("Set aside edit.");
        recovered.destroy();
        order.push("recovery");
      },
    });
    typeIntoBody(binding.doc!, "Set aside edit.");

    await binding.destroy();

    expect(order).toEqual(["recovery", "close"]);
  });

  it("captures a terminal refusal once without retrying the retired lineage", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockTransport();
      let attempts = 0;
      const recovered: string[] = [];
      mock.transport.applyLocalUpdate = async () => {
        attempts += 1;
        throw new EngineYDocDeliveryRefusedError("lineage-transition");
      };
      const binding = await bindEngineYDoc(mock.transport, {
        onDeliveryFailure(snapshot) {
          const restored = new Y.Doc();
          Y.applyUpdate(restored, snapshot);
          recovered.push(bodyText(restored));
          restored.destroy();
        },
      });

      typeIntoBody(binding.doc!, "Retired edit.");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(attempts).toBe(1);
      expect(recovered.at(-1)).toContain("Retired edit.");
      await binding.destroy();
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying when a full-state repair receives a terminal refusal", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockTransport();
      let attempts = 0;
      const recovered: string[] = [];
      mock.transport.applyLocalUpdate = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient delivery failure");
        throw new EngineYDocDeliveryRefusedError("session-unavailable");
      };
      const binding = await bindEngineYDoc(mock.transport, {
        onDeliveryFailure(snapshot) {
          const restored = new Y.Doc();
          Y.applyUpdate(restored, snapshot);
          recovered.push(bodyText(restored));
          restored.destroy();
        },
      });

      typeIntoBody(binding.doc!, "Repair was refused.");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(attempts).toBe(2);
      expect(recovered.at(-1)).toContain("Repair was refused.");
      await binding.destroy();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an old delivery and preserves its mirror before acknowledging a replacement", async () => {
    const mock = mockTransport(["Losing root."]);
    let rejectDelivery!: (error: Error) => void;
    const heldDelivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    mock.transport.applyLocalUpdate = async (update, generation) => {
      mock.shipped.push(update);
      mock.shippedGenerations.push(generation);
      await heldDelivery;
    };
    const preserved: string[] = [];
    const binding = await bindEngineYDoc(mock.transport, {
      onDocumentReplacing(retired) {
        preserved.push(bodyText(retired));
      },
    });
    typeIntoBody(binding.doc!, "Unacknowledged edit.");

    const winner = new Y.Doc();
    typeIntoBody(winner, "Winning root.");
    const replacing = mock.replaceLineage({
      update: Y.encodeStateAsUpdate(winner),
      recoveredPaths: [],
      lineageGeneration: 2,
    });
    await Promise.resolve();
    expect(mock.acknowledgedGenerations).toEqual([]);

    rejectDelivery(new Error("old delivery failed"));
    for (let turn = 0; turn < 10 && preserved.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toContain("Unacknowledged edit.");
    for (
      let turn = 0;
      turn < 10 && mock.acknowledgedGenerations.length === 0;
      turn += 1
    ) {
      await Promise.resolve();
    }
    expect(mock.acknowledgedGenerations).toEqual([2]);

    mock.releaseReplacement();
    await replacing;
    expect(bodyText(binding.doc!)).toContain("Winning root.");
    await binding.destroy();
  });

  it("replaces an independent lineage instead of merging it and rejects stale updates", async () => {
    const mock = mockTransport(["Losing root."]);
    const binding = await bindEngineYDoc(mock.transport);
    const losingDoc = binding.doc!;
    const replacements: Y.Doc[] = [];
    binding.onDocumentReplaced((doc) => replacements.push(doc));

    const winner = new Y.Doc();
    typeIntoBody(winner, "Winning root.");
    const replacing = mock.replaceLineage({
      update: Y.encodeStateAsUpdate(winner),
      recoveredPaths: ["notes/live (recovered).md"],
      lineageGeneration: 2,
    });

    // Main has announced the winner but has not accepted its generation yet.
    // The losing editor must be inert throughout that handoff: a transaction
    // already queued against it cannot be silently shipped under generation 1.
    const shippedBeforeHandoff = mock.shipped.length;
    typeIntoBody(losingDoc, "Late losing edit.");
    expect(mock.shipped).toHaveLength(shippedBeforeHandoff);
    expect(binding.doc).toBe(losingDoc);
    expect(mock.acknowledgedGenerations).toEqual([2]);

    const winnerBeforeRemote = Y.encodeStateVector(winner);
    typeIntoBody(winner, "Remote during handoff.");
    mock.bufferDuringReplacement(
      Y.encodeStateAsUpdate(winner, winnerBeforeRemote),
    );
    mock.releaseReplacement();
    await replacing;

    expect(binding.doc).not.toBe(losingDoc);
    expect(bodyText(binding.doc!)).toContain("Winning root.");
    expect(bodyText(binding.doc!)).toContain("Remote during handoff.");
    expect(bodyText(binding.doc!)).not.toContain("Losing root.");
    expect(replacements).toEqual([binding.doc]);

    const staleRemote = new Y.Doc();
    typeIntoBody(staleRemote, "Stale remote.");
    mock.pushRemote(Y.encodeStateAsUpdate(staleRemote), 1);
    expect(bodyText(binding.doc!)).not.toContain("Stale remote.");

    const shippedBefore = mock.shipped.length;
    typeIntoBody(losingDoc, "Queued stale local.");
    expect(mock.shipped).toHaveLength(shippedBefore);

    typeIntoBody(binding.doc!, "Fresh local.");
    expect(mock.shippedGenerations.at(-1)).toBe(2);
    await binding.destroy();
  });

  it("serializes consecutive lineage replacements", async () => {
    const mock = mockTransport(["Losing root."]);
    const binding = await bindEngineYDoc(mock.transport);
    const firstWinner = new Y.Doc();
    typeIntoBody(firstWinner, "First winner.");
    const finalWinner = new Y.Doc();
    typeIntoBody(finalWinner, "Final winner.");

    const first = mock.replaceLineage({
      update: Y.encodeStateAsUpdate(firstWinner),
      recoveredPaths: [],
      lineageGeneration: 2,
    });
    const second = mock.replaceLineage({
      update: Y.encodeStateAsUpdate(finalWinner),
      recoveredPaths: [],
      lineageGeneration: 3,
    });
    expect(mock.acknowledgedGenerations).toEqual([2]);

    mock.releaseReplacement();
    await Promise.all([first, second]);

    expect(mock.acknowledgedGenerations).toEqual([2, 3]);
    expect(bodyText(binding.doc!)).toContain("Final winner.");
    expect(bodyText(binding.doc!)).not.toContain("First winner.");
    await binding.destroy();
  });
});
