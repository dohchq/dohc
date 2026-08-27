import { describe, expect, it } from "vitest";
import {
  declareSceneRoots,
  foldScene,
  insertElementRevision,
  putSceneAsset,
  revisionKey,
  setAppStateProperty,
  stableJson,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";
import { ExcalidrawSceneBinding } from "./excalidrawSceneAdapter";

function rectangle(version: number, nonce: number, x: number) {
  return {
    id: "shape",
    type: "rectangle",
    version,
    versionNonce: nonce,
    isDeleted: false,
    index: "a0",
    x,
  };
}

function image(version: number, nonce: number) {
  return {
    id: "image-element",
    type: "image",
    version,
    versionNonce: nonce,
    isDeleted: false,
    index: "a1",
    fileId: "image",
    x: 0,
  };
}

const bindings = new WeakMap<Y.Doc, ExcalidrawSceneBinding>();

function bindingFor(doc: Y.Doc): ExcalidrawSceneBinding {
  let binding = bindings.get(doc);
  if (!binding) {
    binding = new ExcalidrawSceneBinding(doc);
    bindings.set(doc, binding);
  }
  return binding;
}

function apply(doc: Y.Doc, elements: readonly unknown[]) {
  return bindingFor(doc).apply({
    elements,
    appState: {
      gridSize: 20,
      scrollX: 400,
    },
    files: {},
  });
}

function captureTransaction(doc: Y.Doc, mutate: () => void): Y.Transaction {
  let captured: Y.Transaction | undefined;
  const capture = (transaction: Y.Transaction) => {
    captured = transaction;
  };
  doc.on("afterTransaction", capture);
  try {
    mutate();
  } finally {
    doc.off("afterTransaction", capture);
  }
  if (!captured) throw new Error("The generated mutation did not transact.");
  return captured;
}

function generatedRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function generatedRectangle(
  id: string,
  version: number,
  versionNonce: number,
  x: number,
): Record<string, unknown> {
  return {
    ...rectangle(version, versionNonce, x),
    id,
    index: "a0",
  };
}

describe("Excalidraw scene adapter", () => {
  it("writes only changed full element revisions and durable app state", () => {
    const doc = new Y.Doc();
    expect(apply(doc, [rectangle(1, 20, 10)]).changed).toBe(true);
    expect(apply(doc, [rectangle(1, 20, 10)]).changed).toBe(false);

    const scene = foldScene(doc);
    expect(scene.elements).toEqual([rectangle(1, 20, 10)]);
    expect(scene.appState).toEqual({ gridSize: 20 });
    expect(declareSceneRoots(doc).revisions.size).toBe(1);
  });

  it("clones only the dragged element in a 1,500-element scene", () => {
    const doc = new Y.Doc();
    const cloneCounts = new Map<string, number>();
    const elements = Array.from({ length: 1_500 }, (_, index) => {
      const element = {
        ...rectangle(index === 1_499 ? 2 : 1, index + 1, index),
        id: `shape-${index}`,
        index: "a0",
      };
      insertElementRevision(doc, {
        ...element,
        ...(index === 1_499 ? { version: 1 } : {}),
      });
      Object.defineProperty(element, "toJSON", {
        enumerable: false,
        value: () => {
          cloneCounts.set(element.id, (cloneCounts.get(element.id) ?? 0) + 1);
          return { ...element };
        },
      });
      return element;
    });

    expect(apply(doc, elements)).toEqual({
      changed: true,
      assetsRefused: false,
    });
    expect(
      [...cloneCounts.values()].reduce((total, count) => total + count, 0),
    ).toBe(1);
    expect(cloneCounts.get("shape-1499")).toBe(1);
  });

  it("isolates Excalidraw mutations and replaces only changed render elements", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, generatedRectangle("shape-a", 1, 10, 10));
    insertElementRevision(doc, generatedRectangle("shape-b", 1, 20, 20));
    setAppStateProperty(doc, "gridSize", 20);
    const binding = new ExcalidrawSceneBinding(doc);
    const first = binding.remote();
    const firstById = new Map(first.elements.map((element) => [element.id, element]));

    firstById.get("shape-a")!.x = 999;
    first.appState.gridSize = 10;
    expect(stableJson(binding.current())).toBe(stableJson(foldScene(doc)));

    const transaction = captureTransaction(doc, () => {
      insertElementRevision(doc, generatedRectangle("shape-b", 2, 30, 30));
    });
    const second = binding.remote(transaction);
    const secondById = new Map(
      second.elements.map((element) => [element.id, element]),
    );

    expect(secondById.get("shape-a")).toBe(firstById.get("shape-a"));
    expect(secondById.get("shape-b")).not.toBe(firstById.get("shape-b"));
    expect(secondById.get("shape-b")?.x).toBe(30);
    expect(stableJson(binding.current())).toBe(stableJson(foldScene(doc)));
  });

  it("matches a from-scratch fold through generated local, remote, and echo sequences", () => {
    const sequenceCount = 32;
    const stepsPerSequence = 64;
    let comparisons = 0;

    for (let seed = 1; seed <= sequenceCount; seed += 1) {
      const random = generatedRandom(seed);
      const doc = new Y.Doc();
      const binding = new ExcalidrawSceneBinding(doc);
      let nextId = 0;
      let canvasElements: Record<string, unknown>[] = [];

      for (let step = 0; step < stepsPerSequence; step += 1) {
        const targetIndex =
          canvasElements.length === 0
            ? -1
            : Math.floor(random() * canvasElements.length);
        const target = canvasElements[targetIndex];
        const operation = step % 6;

        if (operation === 0 || !target) {
          canvasElements.push(
            generatedRectangle(
              `shape-${seed}-${nextId}`,
              1,
              Math.floor(random() * 1_000_000),
              Math.floor(random() * 500),
            ),
          );
          nextId += 1;
          binding.apply({
            elements: canvasElements,
            appState: { gridSize: 20 },
            files: {},
          });
        } else if (operation === 1) {
          canvasElements[targetIndex] = {
            ...target,
            version: Number(target.version) + 1,
            versionNonce: Math.floor(random() * 1_000_000),
            x: Number(target.x) + 1 + Math.floor(random() * 20),
          };
          binding.apply({
            elements: canvasElements,
            appState: { gridSize: 20 },
            files: {},
          });
        } else if (operation === 2) {
          canvasElements[targetIndex] = {
            ...target,
            version: Number(target.version) + 1,
            versionNonce: Math.floor(random() * 1_000_000),
            strokeColor: random() < 0.5 ? "#1b1b1f" : "#e03131",
          };
          binding.apply({
            elements: canvasElements,
            appState: { gridSize: 20 },
            files: {},
          });
        } else if (operation === 3) {
          canvasElements[targetIndex] = {
            ...target,
            version: Number(target.version) + 1,
            versionNonce: Math.floor(random() * 1_000_000),
            isDeleted: true,
          };
          binding.apply({
            elements: canvasElements,
            appState: { gridSize: 20 },
            files: {},
          });
        } else if (operation === 4) {
          const remote = new Y.Doc();
          Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
          const localState = Y.encodeStateVector(doc);
          const currentVersion = Number(target.version);
          const currentNonce = Number(target.versionNonce);
          const tiedRevision = currentNonce > 0 && random() < 0.5;
          insertElementRevision(remote, {
            ...target,
            version: tiedRevision ? currentVersion : currentVersion + 1,
            versionNonce: tiedRevision
              ? currentNonce - 1
              : Math.floor(random() * 1_000_000),
            isDeleted: target.isDeleted === true ? false : target.isDeleted,
            x: Number(target.x) + 100,
          });
          setAppStateProperty(remote, "gridSize", random() < 0.5 ? 10 : 20);
          const update = Y.encodeStateAsUpdate(remote, localState);
          const transaction = captureTransaction(doc, () => {
            Y.applyUpdate(doc, update, "generated-remote");
          });
          canvasElements = binding
            .remote(transaction)
            .elements.map((element) => ({ ...element }));
        } else {
          const scene = binding.current();
          const before = Y.encodeStateVector(doc);
          expect(
            binding.apply({
              elements: scene.elements,
              appState: scene.appState,
              files: {},
            }).changed,
          ).toBe(false);
          expect(Y.encodeStateVector(doc)).toEqual(before);
        }

        expect(
          stableJson(binding.current()),
          `seed ${seed}, step ${step}`,
        ).toBe(stableJson(foldScene(doc)));
        canvasElements = binding
          .current()
          .elements.map((element) => ({ ...element }));
        comparisons += 1;
      }
    }

    expect(comparisons).toBe(sequenceCount * stepsPerSequence);
  });

  it("does not emit a second update for an identical tombstone", () => {
    const doc = new Y.Doc();
    const tombstone = {
      ...rectangle(2, 3, 10),
      isDeleted: true,
    };
    expect(apply(doc, [tombstone]).changed).toBe(true);
    const before = Y.encodeStateVector(doc);

    expect(apply(doc, [tombstone]).changed).toBe(false);
    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
  });

  it("does not echo an exact remote revision back into the document", () => {
    const doc = new Y.Doc();
    const remote = rectangle(2, 7, 30);
    insertElementRevision(doc, remote);
    const binding = new ExcalidrawSceneBinding(doc);
    binding.remote();
    const before = Y.encodeStateVector(doc);

    const result = binding.apply({
      elements: [remote],
      appState: {},
      files: {},
    });

    expect(result.changed).toBe(false);
    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
  });

  it("discards a delayed callback for a revision a newer remote render replaced", () => {
    const doc = new Y.Doc();
    const first = rectangle(1, 9, 10);
    insertElementRevision(doc, first);
    const binding = new ExcalidrawSceneBinding(doc);
    binding.remote();
    // A second remote render replaces the echo identities before Excalidraw
    // delivers the first render's callback.
    insertElementRevision(doc, rectangle(2, 7, 20));
    binding.refresh();
    binding.remote();

    const result = binding.apply({
      elements: [first],
      appState: {},
      files: {},
    });

    expect(result.changed).toBe(false);
    // The superseded revision was NOT re-added beside the winner.
    expect([...declareSceneRoots(doc).revisions.keys()]).toEqual([
      revisionKey("shape", 2, 7),
    ]);

    // A real local edit is strictly newer than the winner and still lands.
    const edited = binding.apply({
      elements: [rectangle(3, 5, 40)],
      appState: {},
      files: {},
    });
    expect(edited.changed).toBe(true);
    expect(foldScene(doc).elements[0]?.x).toBe(40);
  });

  it("discards a delayed callback's superseded app state", () => {
    const doc = new Y.Doc();
    const binding = new ExcalidrawSceneBinding(doc);
    // First remote render carries gridSize 10; a second render moves it to 20
    // before Excalidraw delivers the first render's callback.
    binding.apply({
      elements: [],
      appState: { gridSize: 10 },
      files: {},
    });
    binding.remote();
    binding.apply({
      elements: [],
      appState: { gridSize: 20 },
      files: {},
    });
    binding.remote();

    const stale = binding.apply({
      elements: [],
      appState: { gridSize: 10 },
      files: {},
    });
    expect(stale.changed).toBe(false);
    expect(foldScene(doc).appState.gridSize).toBe(20);

    // A real local change to a NEW value still lands.
    const edited = binding.apply({
      elements: [],
      appState: { gridSize: 30 },
      files: {},
    });
    expect(edited.changed).toBe(true);
    expect(foldScene(doc).appState.gridSize).toBe(30);
  });

  it("lets a local reversion land after the remote render's own echo", () => {
    const doc = new Y.Doc();
    const binding = new ExcalidrawSceneBinding(doc);
    // A remote render sets gridSize 10; its own immediate callback confirms
    // the value and must CONSUME the echo on that equality path.
    binding.apply({
      elements: [],
      appState: { gridSize: 10 },
      files: {},
    });
    binding.remote();
    const confirming = binding.apply({
      elements: [],
      appState: { gridSize: 10 },
      files: {},
    });
    expect(confirming.changed).toBe(false);

    // Another collaborator moves it to 20, then the local user intentionally
    // reverts to 10. The reversion is a real local edit, not a replay.
    binding.apply({
      elements: [],
      appState: { gridSize: 20 },
      files: {},
    });
    binding.remote();
    const reverted = binding.apply({
      elements: [],
      appState: { gridSize: 10 },
      files: {},
    });
    expect(reverted.changed).toBe(true);
    expect(foldScene(doc).appState.gridSize).toBe(10);
  });

  it("keeps a typed-out text element away from the document until it has text", () => {
    const doc = new Y.Doc();
    const binding = new ExcalidrawSceneBinding(doc);
    const emptyText = {
      id: "note",
      type: "text",
      version: 1,
      versionNonce: 4,
      isDeleted: false,
      index: "a2",
      text: "",
    };
    const empty = binding.apply({
      elements: [emptyText],
      appState: {},
      files: {},
    });
    expect(empty.changed).toBe(false);
    const typed = binding.apply({
      elements: [{ ...emptyText, version: 2, versionNonce: 3, text: "hello" }],
      appState: {},
      files: {},
    });
    expect(typed.changed).toBe(true);
    expect(foldScene(doc).elements[0]?.text).toBe("hello");
  });

  it("consumes a normalized callback for the same remote revision tuple", () => {
    const doc = new Y.Doc();
    const sparseRemote = {
      id: "legacy-shape",
      type: "rectangle",
      version: 1,
      versionNonce: 7,
      isDeleted: false,
    };
    insertElementRevision(doc, sparseRemote);
    const binding = new ExcalidrawSceneBinding(doc);
    binding.remote();
    const before = Y.encodeStateVector(doc);

    // Excalidraw v0.18's restoreElementWithProperties supplies these defaults
    // before its updateScene callback. The revision identity does not change.
    const normalizedByExcalidraw = {
      ...sparseRemote,
      index: null,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      strokeColor: "#1b1b1f",
    };
    expect(() =>
      binding.apply({
        elements: [normalizedByExcalidraw],
        appState: {},
        files: {},
      }),
    ).not.toThrow();

    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
    expect(foldScene(doc).elements).toEqual([sparseRemote]);

    // Excalidraw can report the normalized scene again after the one-shot
    // remote marker is consumed. Its immutable revision is still an echo.
    expect(() =>
      binding.apply({
        elements: [normalizedByExcalidraw],
        appState: {},
        files: {},
      }),
    ).not.toThrow();
    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);

    const localEdit = {
      ...normalizedByExcalidraw,
      version: 2,
      versionNonce: 8,
      x: 20,
    };
    expect(
      binding.apply({
        elements: [localEdit],
        appState: {},
        files: {},
      }),
    ).toEqual({ changed: true, assetsRefused: false });
    expect(foldScene(doc).elements).toEqual([localEdit]);
  });

  it("keeps restore-unsafe remote revisions away from the canvas", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, rectangle(1, 1, 10));
    const revisions = declareSceneRoots(doc).revisions;
    for (const invalid of [
      {
        id: "bad-line",
        type: "line",
        version: 1,
        versionNonce: 2,
        isDeleted: false,
      },
      {
        id: "bad-text",
        type: "text",
        version: 1,
        versionNonce: 3,
        isDeleted: false,
        font: null,
      },
      {
        id: "bad-link",
        type: "rectangle",
        version: 1,
        versionNonce: 4,
        isDeleted: false,
        link: {},
      },
    ]) {
      revisions.set(
        revisionKey(invalid.id, invalid.version, invalid.versionNonce),
        stableJson(invalid),
      );
    }

    expect(new ExcalidrawSceneBinding(doc).current().elements).toEqual([
      rectangle(1, 1, 10),
    ]);
  });

  it("converges after two mirrors edit offline", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    apply(left, [rectangle(1, 90, 10)]);
    apply(right, [rectangle(1, 10, 20)]);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    expect(stableJson(foldScene(left))).toBe(stableJson(foldScene(right)));
    expect(foldScene(left).elements[0]?.x).toBe(20);
  });

  it("rejects an unbacked image but keeps other changes working", () => {
    const doc = new Y.Doc();
    const secret = "BASE64_BYTES_MUST_NOT_ENTER_YDOC";
    const result = bindingFor(doc).apply({
      elements: [rectangle(1, 1, 1), image(1, 2)],
      appState: {},
      files: {
        image: { dataURL: `data:image/png;base64,${secret}` },
      },
    });

    expect(result).toEqual({ changed: true, assetsRefused: true });
    const update = Y.encodeStateAsUpdate(doc);
    expect(new TextDecoder().decode(update)).not.toContain(secret);
    expect(foldScene(doc).elements).toEqual([rectangle(1, 1, 1)]);

    expect(apply(doc, [rectangle(2, 3, 20)])).toEqual({
      changed: true,
      assetsRefused: false,
    });
    expect(foldScene(doc).elements).toEqual([rectangle(2, 3, 20)]);
  });

  it("accepts an image whose byte-free asset record already exists", () => {
    const doc = new Y.Doc();
    putSceneAsset(doc, {
      id: "image",
      mimeType: "image/png",
      created: 1,
      ref: "assets/image.png",
      sha256: "a".repeat(64),
    });
    const secret = "HYDRATED_BYTES_STAY_LOCAL";
    const result = bindingFor(doc).apply({
      elements: [image(1, 2)],
      appState: {},
      files: {
        image: { dataURL: `data:image/png;base64,${secret}` },
      },
      hydratedFileIds: new Set(["image"]),
    });

    expect(result).toEqual({ changed: true, assetsRefused: false });
    expect(foldScene(doc).elements).toEqual([image(1, 2)]);
    expect(new TextDecoder().decode(Y.encodeStateAsUpdate(doc))).not.toContain(
      secret,
    );
  });
});
