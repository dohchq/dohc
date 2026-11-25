import { Extension } from "@tiptap/core";

// The history extensions' redo keys decline when nothing is left to redo, and
// ProseMirror's keymap then retries Ctrl+Shift+z without Shift as Undo. These
// run first and always take the key. Only the editor's own history binds the
// Cyrillic alias.
export const RedoKeys = Extension.create({
  name: "dohcRedoKeys",
  priority: 1001,
  addKeyboardShortcuts() {
    const redo = () => {
      this.editor.commands.redo();
      return true;
    };
    const ownHistory = () =>
      this.editor.extensionManager.extensions.some(({ name }) => name === "undoRedo");
    return { "Shift-Mod-z": redo, "Mod-y": redo, "Shift-Mod-я": () => ownHistory() && redo() };
  },
});
