// @vitest-environment jsdom
import { expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Collaboration } from "@tiptap/extension-collaboration";
import * as Y from "yjs";
import { RedoKeys } from "./redoKeys";

for (const { history, extensions } of [
  {
    history: "the shared document's",
    extensions: (doc: Y.Doc) => [
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
      Collaboration.configure({ document: doc, field: "body" }),
    ],
  },
  {
    history: "the local editor's",
    extensions: () => [StarterKit.configure({ trailingNode: false })],
  },
])
  it(`takes Redo with nothing left to redo in ${history} history without undoing or reaching the browser`, () => {
    const doc = new Y.Doc();
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [...extensions(doc), RedoKeys],
    });
    const key = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        ...init,
      });
      editor.view.dom.dispatchEvent(event);
      return event;
    };
    try {
      editor.commands.insertContent("Hello");
      key({ key: "z", keyCode: 90 });
      expect(editor.getText()).toBe("");
      expect(key({ key: "z", keyCode: 90, shiftKey: true }).defaultPrevented).toBe(true);
      expect(editor.getText()).toBe("Hello");

      // Caps Lock reports a lowercase key under Shift.
      for (const redo of [
        { key: "z", keyCode: 90, shiftKey: true },
        { key: "Z", keyCode: 90, shiftKey: true },
        { key: "y", keyCode: 89 },
        { key: "я", code: "KeyQ", keyCode: 81, shiftKey: true },
      ]) {
        expect(key(redo).defaultPrevented).toBe(true);
        expect(editor.getText()).toBe("Hello");
      }
    } finally {
      editor.destroy();
      doc.destroy();
    }
  });
