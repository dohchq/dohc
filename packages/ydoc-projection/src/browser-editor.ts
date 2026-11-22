import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { baseKeymap } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import { ySyncPlugin, ySyncPluginKey, yUndoPlugin, undo, redo } from "y-prosemirror";
import type * as Y from "yjs";
import { getDohcProseMirrorSchema } from "./import-export.js";
import { PUT_BACK_ORIGIN } from "./movedText.js";

/** An editor on the existing body fragment. Admission remains the session owner's responsibility. */
export function mountLiveBodyEditor(
  element: HTMLElement,
  input: {
    body: Y.XmlFragment;
    canEdit(): boolean;
    edit(change: () => void): boolean;
    label: string;
  },
) {
  const schema = getDohcProseMirrorSchema();
  const view = new EditorView(element, {
    state: EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(input.body),
        yUndoPlugin({ trackedOrigins: [PUT_BACK_ORIGIN] }),
        keymap({
          "Mod-z": (state) => input.canEdit() && undo(state),
          "Mod-Shift-z": (state) => input.canEdit() && redo(state),
          "Mod-y": (state) => input.canEdit() && redo(state),
        }),
        keymap(baseKeymap),
      ],
    }),
    attributes: {
      role: "textbox",
      "aria-label": input.label,
      "aria-multiline": "true",
      class: "markdown",
    },
    editable: input.canEdit,
    dispatchTransaction(this: EditorView, transaction) {
      const apply = () => this.updateState(this.state.apply(transaction));
      const fromDocument = transaction.getMeta(ySyncPluginKey)?.isChangeOrigin === true;
      if (transaction.docChanged && !fromDocument) input.edit(apply);
      else apply();
    },
    nodeViews: {
      image(node) {
        const dom = document.createElement("span");
        dom.textContent = node.attrs.alt ? `[Image: ${String(node.attrs.alt)}]` : "[Image]";
        return { dom };
      },
      // The schema draws a to-do box as a bare checkbox, which only the browser toggles. This one
      // sends the tick as an edit and then shows the document's value, so a tick that isn't
      // saved doesn't stay on screen.
      taskItem(node, view, getPos) {
        const dom = document.createElement("li"),
          label = document.createElement("label"),
          box = document.createElement("input"),
          contentDOM = document.createElement("div");
        const show = () => {
          dom.dataset.checked = String(node.attrs.checked === true);
          box.checked = node.attrs.checked === true;
          box.setAttribute("aria-label", node.textContent || "To-do");
        };
        dom.dataset.type = "taskItem";
        label.contentEditable = "false";
        box.type = "checkbox";
        box.addEventListener("mousedown", (event) => event.preventDefault());
        box.addEventListener("change", () => {
          const position = getPos();
          if (input.canEdit() && position !== undefined)
            view.dispatch(
              view.state.tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                checked: box.checked,
              }),
            );
          show();
        });
        const marker = document.createElement("span");
        // A browser joining text into the item can delete the box with it. The editor redraws
        // nothing outside the item's text, so the view puts its box back itself.
        const restore = () => {
          if (box.parentNode !== label || marker.parentNode !== label)
            label.replaceChildren(box, marker);
          if (dom.firstChild !== label) dom.insertBefore(label, dom.firstChild);
        };
        restore();
        dom.append(contentDOM);
        show();
        return {
          dom,
          contentDOM,
          update(next) {
            if (next.type !== node.type) return false;
            node = next;
            restore();
            show();
            return true;
          },
          // The box and its marker are this view's own; only the item's text is the document's.
          ignoreMutation(mutation) {
            if (mutation.type === "selection" || contentDOM.contains(mutation.target)) return false;
            restore();
            return true;
          },
        };
      },
    },
    handlePaste(_view, event) {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text && input.canEdit()) view.dispatch(view.state.tr.insertText(text));
      return true;
    },
    handleDOMEvents: {
      drop(_view, event) {
        event.preventDefault();
        return true;
      },
      click(_view, event) {
        if (event.target instanceof Element && event.target.closest("a")) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });
  let refocus = false;
  return {
    refresh() {
      const editable = input.canEdit();
      if (!editable && view.hasFocus()) refocus = true;
      view.setProps({ editable: input.canEdit });
      if (!editable || !refocus) return;
      refocus = false;
      const active = element.ownerDocument.activeElement;
      if (active === null || active === element.ownerDocument.body) view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
