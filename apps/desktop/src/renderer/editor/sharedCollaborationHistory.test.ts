// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Collaboration } from "@tiptap/extension-collaboration";
import { defaultDeleteFilter, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import { markdownToYDoc, serializeRichdocBody, yDocToMarkdown } from "@dohc/ydoc-projection";
import { bindEngineYDoc, type EngineYDocTransport } from "../collab/engineYDocProvider";
import { desktopMarkdownExtensions } from "./extensions";
import { ListConversions } from "./listEditing";
import {
  CollaborationHistoryInput,
  createCollaborationHistoryHandle,
} from "./sharedCollaborationHistory";

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

async function desktop(baseline: Uint8Array) {
  const shipped: Uint8Array[] = [];
  let remote: ((update: Uint8Array, generation: number) => void) | null = null;
  const transport: EngineYDocTransport = {
    open: async () => ({ available: true, initialUpdate: baseline, lineageGeneration: 1 }),
    stageLocalUpdate: (() => {
      let sequence = 0;
      return () => ++sequence;
    })(),
    applyLocalUpdate(update) {
      shipped.push(update);
    },
    onRemoteUpdate(listener) {
      remote = listener;
      return () => (remote = null);
    },
    onLineageReplacement: () => () => {},
    acknowledgeLineageReplacement: async () => [],
    close: async () => {},
  };
  const binding = await bindEngineYDoc(transport);
  const doc = binding.doc!;
  const element = document.createElement("div");
  document.body.append(element);
  const protectedNodes = new Set(["paragraph"]);
  const editor = new Editor({
    element,
    extensions: [
      ...desktopMarkdownExtensions,
      StarterKit.configure({
        trailingNode: false,
        undoRedo: false,
        orderedList: false,
        listItem: false,
      }),
      ListConversions,
      MarkdownListItem,
      MarkdownOrderedList,
      MarkdownTaskList,
      DohcTaskItem,
      TableKit.configure({ table: false }),
      DohcMarkdownTable,
      Collaboration.configure({
        document: doc,
        field: "body",
        yUndoOptions: {
          undoManager: createCollaborationHistoryHandle(doc, {
            trackedOrigin: ySyncPluginKey,
            deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
          }),
        },
      }),
      CollaborationHistoryInput,
    ],
  });
  return {
    doc,
    editor,
    async take() {
      await binding.flushPendingLocalUpdates();
      return Y.mergeUpdates(shipped.splice(0));
    },
    receive: (update: Uint8Array) => remote!(update, 1),
    async stop() {
      editor.destroy();
      element.remove();
      await binding.destroy();
    },
  };
}

it("undo brings a deleted heading back at its old level for everyone, after its level changed in the same undo step", async () => {
  const note = "first\n\n## title\n\nlast\n";
  const seed = markdownToYDoc(note);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const a = await desktop(baseline);
  const b = await desktop(baseline);
  const reopened = new Y.Doc();
  const shown = (person: typeof a) => `${serializeRichdocBody(person.editor.getJSON())}\n`;
  try {
    const { view } = a.editor;
    let at = -1;
    view.state.doc.forEach((node, position) => {
      if (node.type.name === "heading") at = position;
    });
    view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { level: 3 }));
    view.dispatch(view.state.tr.delete(at, at + view.state.doc.nodeAt(at)!.nodeSize));
    b.receive(await a.take());
    expect(yDocToMarkdown(b.doc)).toBe("first\n\nlast\n");

    expect(a.editor.commands.undo()).toBe(true);
    b.receive(await a.take());
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(a.doc));
    expect({
      "first person's editor": shown(a),
      "second person's editor": shown(b),
      "first person's document": yDocToMarkdown(a.doc),
      "second person's document": yDocToMarkdown(b.doc),
      "first person's document, opened again": yDocToMarkdown(reopened),
    }).toEqual({
      "first person's editor": note,
      "second person's editor": note,
      "first person's document": note,
      "second person's document": note,
      "first person's document, opened again": note,
    });
  } finally {
    reopened.destroy();
    await a.stop();
    await b.stop();
  }
});
