import { describe, expect, it } from "vitest";
import * as Y from "yjs";

const exchange = (...docs: Y.Doc[]) => {
  for (const from of docs)
    for (const to of docs)
      if (to !== from) Y.applyUpdate(to, Y.encodeStateAsUpdate(from), "remote");
};

describe("Yjs undo", () => {
  it("passes over a key whose map someone else deleted after an undo brought it back", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.clientID = 1;
    b.clientID = 2;
    const blocks = a.getArray<Y.Map<string>>("blocks");
    const block = new Y.Map<string>();
    blocks.insert(0, [block]);
    block.set("path", "first");
    exchange(a, b);
    const history = new Y.UndoManager(blocks, { captureTimeout: 0, ignoreRemoteMapChanges: true });
    block.set("path", "second");
    blocks.delete(0);
    history.undo();
    const back = blocks.get(0);
    back.set("path", "third");
    history.undo();
    blocks.push([new Y.Map<string>()]);
    exchange(a, b);
    b.getArray("blocks").delete(0);
    exchange(a, b);
    while (history.undo());
    exchange(a, b);
    expect(history.undoStack).toHaveLength(0);
    expect(blocks.length).toBe(0);
    expect(a.getArray("blocks").toJSON()).toEqual(b.getArray("blocks").toJSON());
  });
});
