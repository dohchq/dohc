import { describe, expect, it } from "vitest";
import {
  declareSceneRoots,
  foldScene,
  insertElementRevision,
  putSceneAsset,
  stableJson,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";
import {
  applyCanvasSceneChange,
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
    remoteEchoes: new Map(),
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
    const echoes = new Map<string, string>();
    rememberRemoteScene(sceneForCanvas(doc).elements, echoes);
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
      remoteEchoes: new Map(),
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
      remoteEchoes: new Map(),
      hydratedFileIds: new Set(["image"]),
    });

    expect(result).toEqual({ changed: true, assetsRefused: false });
    expect(foldScene(doc).elements).toEqual([image(1, 2)]);
    expect(new TextDecoder().decode(Y.encodeStateAsUpdate(doc))).not.toContain(
      secret,
    );
  });
});
