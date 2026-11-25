import { Extension } from "@tiptap/core";

// The history extensions' redo keys decline when nothing is left to redo, and
// ProseMirror's keymap then retries Ctrl+Shift+z without Shift as Undo. These
// run first and always take the key.
export const RedoKeys = Extension.create({
  name: "dohcRedoKeys",
  priority: 1001,
  addKeyboardShortcuts() {
    const redo = () => {
      this.editor.commands.redo();
      return true;
    };
    return { "Shift-Mod-z": redo, "Mod-y": redo };
  },
});
