import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  compareUnicodeScalar,
  declareSceneRoots,
  exportPortableScene,
  foldScene,
  insertElementRevision,
  parseRevisionKey,
  putSceneAsset,
  revisionKey,
  setAppStateProperty,
  stableJson,
} from "./index";

const SHA256 = "a".repeat(64);

const element = (id: string, version: number, nonce: number, extra = {}) => ({
  id, type: "rectangle", version, versionNonce: nonce, isDeleted: false, index: "a0", ...extra,
});

function merge(target: Y.Doc, ...sources: Y.Doc[]) {
  for (const source of sources) Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

describe("element revisions", () => {
  it("converges in either update order and retains offline branches", () => {
    const base = new Y.Doc();
    insertElementRevision(base, element("shape", 1, 10));
    const update = Y.encodeStateAsUpdate(base);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update);
    insertElementRevision(left, element("shape", 2, 90, { x: 1 }));
    insertElementRevision(right, element("shape", 2, 20, { x: 2 }));
    const a = new Y.Doc(); const b = new Y.Doc();
    merge(a, left, right); merge(b, right, left);
    expect(stableJson(foldScene(a))).toBe(stableJson(foldScene(b)));
    expect(foldScene(a).elements[0]?.x).toBe(2);
    expect(declareSceneRoots(a).revisions.size).toBe(2);
  });

  it("handles tombstone resurrection and observed dominated cleanup", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, element("shape", 1, 8));
    insertElementRevision(doc, element("shape", 2, 7, { isDeleted: true }));
    expect(declareSceneRoots(doc).revisions.size).toBe(1);
    insertElementRevision(doc, element("shape", 3, 6));
    expect(foldScene(doc).elements[0]?.isDeleted).toBe(false);
  });

  it("orders duplicate, null, and missing indices by index then ID", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, element("b", 1, 1));
    insertElementRevision(doc, element("a", 1, 1));
    insertElementRevision(doc, element("null", 1, 1, { index: null }));
    const missing = element("missing", 1, 1); delete (missing as { index?: string }).index;
    insertElementRevision(doc, missing);
    expect(foldScene(doc).elements.map(({ id }) => id)).toEqual(["a", "b", "null", "missing"]);
  });

  it("uses unambiguous tuple keys and rejects nonce collisions", () => {
    expect(parseRevisionKey(revisionKey("a,1", 2, 3))).toEqual(["a,1", 2, 3]);
    expect(() => parseRevisionKey('["a",1,2,3]')).toThrow("three-item");
    const doc = new Y.Doc();
    insertElementRevision(doc, element("a", 1, 2, { x: 1 }));
    expect(() => insertElementRevision(doc, element("a", 1, 2, { x: 2 }))).toThrow("different content");
  });

  it("converges when offline writers collide on the same nonce", () => {
    const left = new Y.Doc(); const right = new Y.Doc();
    insertElementRevision(left, element("shape", 1, 7, { x: 1 }));
    insertElementRevision(right, element("shape", 1, 7, { x: 2 }));
    const a = new Y.Doc(); const b = new Y.Doc();
    merge(a, left, right); merge(b, right, left);
    expect(stableJson(foldScene(a))).toBe(stableJson(foldScene(b)));
    expect(declareSceneRoots(a).revisions.size).toBe(1);
  });

  it("ignores malformed and noncanonical remote records one at a time", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, element("valid", 1, 1, { x: 10 }));
    setAppStateProperty(doc, "gridSize", 20);
    putSceneAsset(doc, {
      id: "valid-asset",
      mimeType: "image/png",
      created: 1,
      ref: "assets/valid.png",
      sha256: "a".repeat(64),
    });
    const roots = declareSceneRoots(doc);
    roots.revisions.set("not-json", "not-json");
    roots.revisions.set(
      revisionKey("spaced", 1, 1),
      '{ "id":"spaced","index":"a0","isDeleted":false,"type":"rectangle","version":1,"versionNonce":1}',
    );
    roots.revisions.set(
      revisionKey("wrong-key", 1, 1),
      stableJson(element("other-id", 1, 1)),
    );
    roots.appState.set("scrollX", "{ bad");
    roots.appState.set("gridStep", " 5");
    roots.assets.set("broken", "null");
    roots.assets.set(
      "wrong-id",
      stableJson({
        id: "other-asset",
        mimeType: "image/png",
        created: 1,
        ref: "assets/other.png",
        sha256: "b".repeat(64),
      }),
    );

    expect(foldScene(doc)).toEqual({
      elements: [element("valid", 1, 1, { x: 10 })],
      appState: { gridSize: 20 },
      assets: {
        "valid-asset": {
          id: "valid-asset",
          mimeType: "image/png",
          created: 1,
          ref: "assets/valid.png",
          sha256: "a".repeat(64),
        },
      },
    });
    expect(JSON.parse(exportPortableScene(doc))).toMatchObject({
      elements: [{ id: "valid" }],
      appState: { gridSize: 20 },
      files: {},
    });
  });
});

describe("portable export", () => {
  it("omits tombstones, asset references, private app state, and file bytes", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, element("image", 1, 1, { type: "image", fileId: "used" }));
    insertElementRevision(doc, element("gone", 1, 1, { isDeleted: true, fileId: "unused" }));
    putSceneAsset(doc, { id: "used", mimeType: "image/png", created: 1, ref: "assets/used.png", sha256: SHA256 });
    putSceneAsset(doc, { id: "unused", mimeType: "image/png", created: 1, ref: "assets/unused.png", sha256: SHA256 });
    setAppStateProperty(doc, "gridSize", 20);
    setAppStateProperty(doc, "gridStep", 5);
    setAppStateProperty(doc, "gridModeEnabled", true);
    setAppStateProperty(doc, "viewBackgroundColor", "#ffffff");
    setAppStateProperty(doc, "scrollX", 42);
    const exported = JSON.parse(exportPortableScene(doc));
    expect(exported.source).toBe("https://excalidraw.com");
    expect(exported.elements.map(({ id }: { id: string }) => id)).toEqual(["image"]);
    expect(exported.files).toEqual({});
    expect(exported.appState).toEqual({
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#ffffff",
    });
  });

  it("rejects invalid revisions and asset references", () => {
    const doc = new Y.Doc();
    expect(() => insertElementRevision(doc, element("x", 1.5, 1))).toThrow("safe integer");
    expect(() => putSceneAsset(doc, { id: "x", mimeType: "image/png", created: 1, ref: "../x", sha256: SHA256 })).toThrow("workspace-relative");
    expect(() => putSceneAsset(doc, { id: "x", mimeType: "image/png", created: 1, ref: "x" })).toThrow("SHA-256");
    expect(() => putSceneAsset(doc, { id: "x", mimeType: "image/png", created: 1, ref: "x", sha256: "A".repeat(64) })).toThrow("lowercase");
    expect(() => putSceneAsset(doc, { id: "x", mimeType: "image/png", created: 1, ref: "x", sha256: SHA256, dataURL: "bytes" })).toThrow("file bytes");
  });

  it("writes stable canonical JSON", () => {
    expect(stableJson({ z: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"z":1}');
    expect(compareUnicodeScalar("\uE000", "😀")).toBeLessThan(0);
    expect(stableJson({ "😀": 2, "\uE000": 1 })).toBe(
      '{"":1,"😀":2}',
    );
    expect(() => stableJson({ text: "\ud800" })).toThrow("valid Unicode");
  });

  it("removes references to tombstoned elements", () => {
    const doc = new Y.Doc();
    insertElementRevision(
      doc,
      element("live", 1, 1, {
        boundElements: [{ id: "gone", type: "text" }],
        containerId: "gone",
        frameId: "gone",
        startBinding: { elementId: "gone" },
        endBinding: { elementId: "gone" },
      }),
    );
    insertElementRevision(doc, element("gone", 1, 1, { isDeleted: true }));
    const [exported] = JSON.parse(exportPortableScene(doc)).elements;
    expect(exported).toMatchObject({
      boundElements: [],
      containerId: null,
      frameId: null,
      startBinding: null,
      endBinding: null,
    });
  });

  it("retains tombstone winners in the collaborative fold but omits them from export", () => {
    const doc = new Y.Doc();
    insertElementRevision(doc, element("gone", 2, 1, { isDeleted: true }));

    expect(foldScene(doc).elements).toEqual([
      element("gone", 2, 1, { isDeleted: true }),
    ]);
    expect(JSON.parse(exportPortableScene(doc)).elements).toEqual([]);
  });
});

it("measures a five-second 60 Hz drag without setting a rejection limit", () => {
  const doc = new Y.Doc();
  for (let frame = 0; frame < 300; frame += 1) {
    insertElementRevision(doc, element("dragged", frame + 1, frame + 1, { x: frame }));
  }
  expect(foldScene(doc).elements[0]?.x).toBe(299);
  console.info(`drag-footprint revisions=300 updateBytes=${Y.encodeStateAsUpdate(doc).byteLength}`);
});
