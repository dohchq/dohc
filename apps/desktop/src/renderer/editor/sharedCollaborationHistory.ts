import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import * as Y from "yjs";

// Edit > Undo and Redo in the application menu reach the editor as
// beforeinput events, not keys. Collaboration binds only the keys, so
// without this Chromium would undo its own record of DOM edits instead of
// the document's history.
export const CollaborationHistoryInput = Extension.create({
  name: "dohcCollaborationHistoryInput",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("dohc-collaboration-history-input"),
        props: {
          handleDOMEvents: {
            beforeinput: (_view, event) => {
              if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
              event.preventDefault();
              if (event.inputType === "historyUndo") editor.commands.undo();
              else editor.commands.redo();
              return true;
            },
          },
        },
      }),
    ];
  },
});

type UndoEventName = Parameters<Y.UndoManager["on"]>[0];
type UndoEventHandler = Parameters<Y.UndoManager["on"]>[1];
type UndoManagerOptions = NonNullable<
  ConstructorParameters<typeof Y.UndoManager>[1]
>;

const managers = new WeakMap<Y.Doc, Y.UndoManager>();

function getManager(
  doc: Y.Doc,
  trackedOrigin: unknown,
  deleteFilter: UndoManagerOptions["deleteFilter"],
): Y.UndoManager {
  const existing = managers.get(doc);
  if (existing) return existing;

  const manager = new Y.UndoManager(doc.getXmlFragment("body"), {
    trackedOrigins: new Set([trackedOrigin]),
    deleteFilter,
    captureTransaction: (transaction) =>
      transaction.meta.get("addToHistory") !== false,
  });
  managers.set(doc, manager);
  return manager;
}

export function createCollaborationHistoryHandle(
  doc: Y.Doc,
  options: {
    trackedOrigin: unknown;
    deleteFilter: UndoManagerOptions["deleteFilter"];
  },
): Y.UndoManager {
  const manager = getManager(doc, options.trackedOrigin, options.deleteFilter);
  const subscriptions: Array<{
    event: UndoEventName;
    handler: UndoEventHandler;
  }> = [];

  // y-tiptap installs selection listeners per editor and destroys the
  // supplied UndoManager when that editor unmounts. Each proxy owns only its
  // view's listeners; the Y.Doc owns the real, shared history manager.
  return new Proxy(manager, {
    get(target, property) {
      if (property === "on") {
        return (event: UndoEventName, handler: UndoEventHandler) => {
          Reflect.apply(target.on, target, [event, handler]);
          subscriptions.push({ event, handler });
        };
      }
      if (property === "off") {
        return (event: UndoEventName, handler: UndoEventHandler) => {
          Reflect.apply(target.off, target, [event, handler]);
          const index = subscriptions.findIndex(
            (subscription) =>
              subscription.event === event && subscription.handler === handler,
          );
          if (index >= 0) subscriptions.splice(index, 1);
        };
      }
      if (property === "destroy") {
        return () => {
          for (const { event, handler } of subscriptions.splice(0)) {
            Reflect.apply(target.off, target, [event, handler]);
          }
        };
      }
      // Tiptap's Collaboration wrapper writes a restore hook because it
      // expects the underlying plugin to destroy the manager. This handle
      // never destroys it, so restoring would register its transaction
      // observer twice when an editor rebuilds.
      if (property === "restore") return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "restore") return true;
      return Reflect.set(target, property, value, target);
    },
  });
}
