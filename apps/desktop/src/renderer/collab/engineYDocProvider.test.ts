import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bindEngineYDoc,
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
  }) => void;
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
      }) => void)
    | null = null;
  let closed = false;
  const transport: EngineYDocTransport = {
    async open() {
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(mainDoc),
        lineageGeneration: 1,
      };
    },
    applyLocalUpdate(update, lineageGeneration) {
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
    replaceLineage: (input) => replacementListener?.(input),
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
      applyLocalUpdate() {},
      onRemoteUpdate() {
        return () => undefined;
      },
      onLineageReplacement() {
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

  it("replaces an independent lineage instead of merging it and rejects stale updates", async () => {
    const mock = mockTransport(["Losing root."]);
    const binding = await bindEngineYDoc(mock.transport);
    const losingDoc = binding.doc!;
    const replacements: Y.Doc[] = [];
    binding.onDocumentReplaced((doc) => replacements.push(doc));

    const winner = new Y.Doc();
    typeIntoBody(winner, "Winning root.");
    mock.replaceLineage({
      update: Y.encodeStateAsUpdate(winner),
      recoveredPaths: ["notes/live (recovered).md"],
      lineageGeneration: 2,
    });

    expect(binding.doc).not.toBe(losingDoc);
    expect(bodyText(binding.doc!)).toContain("Winning root.");
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
});
