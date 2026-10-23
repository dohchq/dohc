// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Collaboration } from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { CollaborationHistoryInput, createCollaborationHistoryHandle } from "./sharedCollaborationHistory";

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

it("answers the menu's Undo and Redo, which arrive as beforeinput, from the document's history", () => {
  const doc = new Y.Doc();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
      Collaboration.configure({ document: doc, field: "body" }),
      CollaborationHistoryInput,
    ],
  });
  const input = (inputType: string) => {
    const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    return event;
  };
  try {
    editor.commands.insertContent("Hello");
    expect(editor.getText()).toBe("Hello");

    const undo = input("historyUndo");
    expect(undo.defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("");
    expect(doc.getXmlFragment("body").toString()).not.toContain("Hello");

    expect(input("historyRedo").defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("Hello");

    // Typing stays with the browser and ProseMirror.
    expect(input("insertText").defaultPrevented).toBe(false);
  } finally {
    editor.destroy();
    doc.destroy();
  }
});

it("leaves the keyboard's Undo and Redo to the editor's keys, which raise no beforeinput", () => {
  const doc = new Y.Doc();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
      Collaboration.configure({ document: doc, field: "body" }),
      CollaborationHistoryInput,
    ],
  });
  const beforeinput = vi.fn();
  editor.view.dom.addEventListener("beforeinput", beforeinput);
  // jsdom is not a Mac, so Mod is Control.
  const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, ...init });
    editor.view.dom.dispatchEvent(event);
    return event;
  };
  try {
    editor.commands.insertContent("Hello");
    expect(key({ key: "z", keyCode: 90 }).defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("");
    expect(key({ key: "Z", keyCode: 90, shiftKey: true }).defaultPrevented).toBe(true);
    expect(editor.getText()).toBe("Hello");
    expect(beforeinput).not.toHaveBeenCalled();
  } finally {
    editor.destroy();
    doc.destroy();
  }
});
