import {EditorState} from "@tiptap/pm/state";
import {EditorView} from "@tiptap/pm/view";
import {Schema} from "@tiptap/pm/model";
import {baseKeymap} from "@tiptap/pm/commands";
import {keymap} from "@tiptap/pm/keymap";
import {ySyncPlugin, ySyncPluginKey, yUndoPlugin, undo, redo} from "y-prosemirror";
import type * as Y from "yjs";
import {getDohcProseMirrorSchema} from "./import-export.js";

/** An editor on the existing body fragment. Admission remains the session owner's responsibility. */
export function mountLiveBodyEditor(element: HTMLElement, input: {body: Y.XmlFragment; canEdit(): boolean;
  edit(change: () => void): boolean; label: string}) {
  const projection = getDohcProseMirrorSchema();
  // Empty editor content must default to a paragraph, not the projection's recursive callout.
  const schema = new Schema({...projection.spec, nodes: projection.spec.nodes.addToStart("paragraph", projection.spec.nodes.get("paragraph")!)});
  const view = new EditorView(element, {
    state: EditorState.create({schema, plugins: [ySyncPlugin(input.body), yUndoPlugin(),
      keymap({"Mod-z": state => input.canEdit() && undo(state), "Mod-Shift-z": state => input.canEdit() && redo(state),
        "Mod-y": state => input.canEdit() && redo(state)}), keymap(baseKeymap)]}),
    attributes: {role: "textbox", "aria-label": input.label, "aria-multiline": "true", class: "markdown"},
    editable: input.canEdit,
    dispatchTransaction(this: EditorView, transaction) {
      const apply = () => this.updateState(this.state.apply(transaction));
      const fromDocument = transaction.getMeta(ySyncPluginKey)?.isChangeOrigin === true;
      if (transaction.docChanged && !fromDocument) input.edit(apply);
      else apply();
    },
    nodeViews: {image(node) {
      const dom = document.createElement("span");
      dom.textContent = node.attrs.alt ? `[Image: ${String(node.attrs.alt)}]` : "[Image]";
      return {dom};
    }},
    handlePaste(_view, event) {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text && input.canEdit()) view.dispatch(view.state.tr.insertText(text));
      return true;
    },
    handleDOMEvents: {drop(_view, event) {event.preventDefault(); return true;},
      click(_view, event) {if (event.target instanceof Element && event.target.closest("a")) {event.preventDefault(); return true;} return false;}},
  });
  return {refresh() {view.setProps({editable: input.canEdit});}, destroy() {view.destroy();}};
}
