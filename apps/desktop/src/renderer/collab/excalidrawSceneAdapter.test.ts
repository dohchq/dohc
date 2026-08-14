import { describe, expect, it } from "vitest";
import {
  declareSceneRoots,
  foldScene,
  insertElementRevision,
  putSceneAsset,
  revisionKey,
  stableJson,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";
import {
  applyCanvasSceneChange,
  createSceneRemoteEchoes,
  rememberRemoteScene,
  sceneForCanvas,
} from "./excalidrawSceneAdapter";

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

function apply(doc: Y.Doc, elements: readonly unknown[]) {
  return applyCanvasSceneChange({
    doc,
    elements,
    appState: {
      gridSize: 20,
      scrollX: 400,
    },
    files: {},
    remoteEchoes: createSceneRemoteEchoes(),
  });
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
    const echoes = createSceneRemoteEchoes();
    rememberRemoteScene(sceneForCanvas(doc), echoes);
    const before = Y.encodeStateVector(doc);

    const result = applyCanvasSceneChange({
      doc,
      elements: [remote],
      appState: {},
      files: {},
      remoteEchoes: echoes,
    });

    expect(result.changed).toBe(false);
    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
  });

  it("discards a delayed callback for a revision a newer remote render replaced", () => {
    const doc = new Y.Doc();
    const first = rectangle(1, 9, 10);
    insertElementRevision(doc, first);
    const echoes = createSceneRemoteEchoes();
    rememberRemoteScene(sceneForCanvas(doc), echoes);
    // A second remote render replaces the echo identities before Excalidraw
    // delivers the first render's callback.
    insertElementRevision(doc, rectangle(2, 7, 20));
    rememberRemoteScene(sceneForCanvas(doc), echoes);

    const result = applyCanvasSceneChange({
      doc,
      elements: [first],
      appState: {},
      files: {},
      remoteEchoes: echoes,
    });

    expect(result.changed).toBe(false);
    // The superseded revision was NOT re-added beside the winner.
    expect([...declareSceneRoots(doc).revisions.keys()]).toEqual([
      revisionKey("shape", 2, 7),
    ]);

    // A real local edit is strictly newer than the winner and still lands.
    const edited = applyCanvasSceneChange({
      doc,
      elements: [rectangle(3, 5, 40)],
      appState: {},
      files: {},
      remoteEchoes: echoes,
    });
    expect(edited.changed).toBe(true);
    expect(foldScene(doc).elements[0]?.x).toBe(40);
  });

  it("discards a delayed callback's superseded app state", () => {
    const doc = new Y.Doc();
    const echoes = createSceneRemoteEchoes();
    // First remote render carries gridSize 10; a second render moves it to 20
    // before Excalidraw delivers the first render's callback.
    applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 10 },
      files: {},
      remoteEchoes: createSceneRemoteEchoes(),
    });
    rememberRemoteScene(sceneForCanvas(doc), echoes);
    applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 20 },
      files: {},
      remoteEchoes: createSceneRemoteEchoes(),
    });
    rememberRemoteScene(sceneForCanvas(doc), echoes);

    const stale = applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 10 },
      files: {},
      remoteEchoes: echoes,
    });
    expect(stale.changed).toBe(false);
    expect(foldScene(doc).appState.gridSize).toBe(20);

    // A real local change to a NEW value still lands.
    const edited = applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 30 },
      files: {},
      remoteEchoes: echoes,
    });
    expect(edited.changed).toBe(true);
    expect(foldScene(doc).appState.gridSize).toBe(30);
  });

  it("lets a local reversion land after the remote render's own echo", () => {
    const doc = new Y.Doc();
    const echoes = createSceneRemoteEchoes();
    // A remote render sets gridSize 10; its own immediate callback confirms
    // the value and must CONSUME the echo on that equality path.
    applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 10 },
      files: {},
      remoteEchoes: createSceneRemoteEchoes(),
    });
    rememberRemoteScene(sceneForCanvas(doc), echoes);
    const confirming = applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 10 },
      files: {},
      remoteEchoes: echoes,
    });
    expect(confirming.changed).toBe(false);

    // Another collaborator moves it to 20, then the local user intentionally
    // reverts to 10. The reversion is a real local edit, not a replay.
    applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 20 },
      files: {},
      remoteEchoes: createSceneRemoteEchoes(),
    });
    rememberRemoteScene(sceneForCanvas(doc), echoes);
    const reverted = applyCanvasSceneChange({
      doc,
      elements: [],
      appState: { gridSize: 10 },
      files: {},
      remoteEchoes: echoes,
    });
    expect(reverted.changed).toBe(true);
    expect(foldScene(doc).appState.gridSize).toBe(10);
  });

  it("keeps a typed-out text element away from the document until it has text", () => {
    const doc = new Y.Doc();
    const echoes = createSceneRemoteEchoes();
    const emptyText = {
      id: "note",
      type: "text",
      version: 1,
      versionNonce: 4,
      isDeleted: false,
      index: "a2",
      text: "",
    };
    const empty = applyCanvasSceneChange({
      doc,
      elements: [emptyText],
      appState: {},
      files: {},
      remoteEchoes: echoes,
    });
    expect(empty.changed).toBe(false);
    const typed = applyCanvasSceneChange({
      doc,
      elements: [{ ...emptyText, version: 2, versionNonce: 3, text: "hello" }],
      appState: {},
      files: {},
      remoteEchoes: echoes,
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
    const echoes = createSceneRemoteEchoes();
    rememberRemoteScene(sceneForCanvas(doc), echoes);
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
      applyCanvasSceneChange({
        doc,
        elements: [normalizedByExcalidraw],
        appState: {},
        files: {},
        remoteEchoes: echoes,
      }),
    ).not.toThrow();

    expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
    expect(foldScene(doc).elements).toEqual([sparseRemote]);

    // Excalidraw can report the normalized scene again after the one-shot
    // remote marker is consumed. Its immutable revision is still an echo.
    expect(() =>
      applyCanvasSceneChange({
        doc,
        elements: [normalizedByExcalidraw],
        appState: {},
        files: {},
        remoteEchoes: echoes,
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
      applyCanvasSceneChange({
        doc,
        elements: [localEdit],
        appState: {},
        files: {},
        remoteEchoes: echoes,
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

    expect(sceneForCanvas(doc).elements).toEqual([rectangle(1, 1, 10)]);
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
    const result = applyCanvasSceneChange({
      doc,
      elements: [rectangle(1, 1, 1), image(1, 2)],
      appState: {},
      files: {
        image: { dataURL: `data:image/png;base64,${secret}` },
      },
      remoteEchoes: createSceneRemoteEchoes(),
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
    const result = applyCanvasSceneChange({
      doc,
      elements: [image(1, 2)],
      appState: {},
      files: {
        image: { dataURL: `data:image/png;base64,${secret}` },
      },
      remoteEchoes: createSceneRemoteEchoes(),
      hydratedFileIds: new Set(["image"]),
    });

    expect(result).toEqual({ changed: true, assetsRefused: false });
    expect(foldScene(doc).elements).toEqual([image(1, 2)]);
    expect(new TextDecoder().decode(Y.encodeStateAsUpdate(doc))).not.toContain(
      secret,
    );
  });
});
