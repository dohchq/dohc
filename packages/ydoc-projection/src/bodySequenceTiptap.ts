import { Extension, type RawCommands } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import {
  bodySequencePlugin,
  redoBodySequence,
  undoBodySequence,
  type BodySequenceOptions,
} from "./bodySequenceEditor.js";
import { unevenTableGuard } from "./bodySequenceTables.js";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dohcBodySequence: {
      /** Undo this person's last change to the note. */
      undo: () => ReturnType;
      /** Redo the change this person last undid. */
      redo: () => ReturnType;
    };
  }
}

/**
 * Binds a Tiptap editor to a note's body sequence. Configure it with the options of
 * `bodySequencePlugin`, and use it in place of the Collaboration extension, with the starter
 * kit's `undoRedo` off. Like the Collaboration extension, it binds the undo and redo keys, and
 * its plugin comes before those of extensions of a lower priority, so their views find each
 * edit already written. It also keeps the editor off what `prosemirror-tables` can't do in a
 * table whose rows differ in length (`unevenTableGuard`).
 *
 * An undo or redo comes back from the sequence as its own transaction, so the `undo` and `redo`
 * commands tell Tiptap not to dispatch the command's own.
 */
export const BodySequence = Extension.create<Partial<BodySequenceOptions>>({
  name: "dohcBodySequence",
  priority: 1000,
  addProseMirrorPlugins() {
    const { sequence, containers } = this.options;
    if (!sequence || !containers)
      throw new Error("BodySequence needs the note's sequence and containers.");
    return [bodySequencePlugin({ ...this.options, sequence, containers }), unevenTableGuard()];
  },
  addCommands() {
    const fromHistory =
      (command: Command): RawCommands["undo"] =>
      () =>
      ({ state, dispatch, tr }) => {
        tr.setMeta("preventDispatch", true);
        return command(state, dispatch);
      };
    return { undo: fromHistory(undoBodySequence), redo: fromHistory(redoBodySequence) };
  },
});
