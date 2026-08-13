import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createCollaborationHistoryHandle } from "./sharedCollaborationHistory";

it("keeps each view's listeners scoped to its shared history handle", () => {
  const doc = new Y.Doc();
  const body = doc.getXmlFragment("body");
  const trackedOrigin = {};
  const deleteFilter = () => true;
  const first = createCollaborationHistoryHandle(doc, {
    trackedOrigin,
    deleteFilter,
  });
  const second = createCollaborationHistoryHandle(doc, {
    trackedOrigin,
    deleteFilter,
  });
  const firstListener = vi.fn();
  const secondListener = vi.fn();
  const originalTrackedOrigins = new Set(first.trackedOrigins);
  const appendBlock = (name: string) => {
    first.stopCapturing();
    doc.transact(() => {
      body.insert(body.length, [new Y.XmlElement(name)]);
    }, trackedOrigin);
  };

  first.on("stack-item-added", firstListener);
  second.on("stack-item-added", secondListener);
  appendBlock("first");
  expect(firstListener).toHaveBeenCalledTimes(1);
  expect(secondListener).toHaveBeenCalledTimes(1);

  first.off("stack-item-added", firstListener);
  appendBlock("second");
  expect(firstListener).toHaveBeenCalledTimes(1);
  expect(secondListener).toHaveBeenCalledTimes(2);

  first.on("stack-item-added", firstListener);
  Reflect.set(first, "restore", vi.fn());
  expect(Reflect.get(first, "restore")).toBeUndefined();
  first.destroy();
  appendBlock("third");
  expect(firstListener).toHaveBeenCalledTimes(1);
  expect(secondListener).toHaveBeenCalledTimes(3);
  expect(first.trackedOrigins).toEqual(originalTrackedOrigins);
  expect(Reflect.get(first, "restore")).toBeUndefined();

  second.destroy();
  appendBlock("fourth");
  expect(firstListener).toHaveBeenCalledTimes(1);
  expect(secondListener).toHaveBeenCalledTimes(3);
  expect(second.trackedOrigins).toEqual(originalTrackedOrigins);
  expect(Reflect.get(second, "restore")).toBeUndefined();

  doc.destroy();
});
