import { commands, Extension, getNodeType } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";
import { parseRichdocMarkdown } from "@dohc/ydoc-projection";

const listTypes = new Set(["bulletList", "orderedList", "taskList"]);

// Tiptap can change the list wrapper only when its existing items fit the
// target. Task lists need a different item type, converted in the same edit.
export const ListConversions = Extension.create({
  name: "listConversions",
  addCommands() {
    return {
      toggleList: (listName, itemName, keepMarks, attributes) => props => {
        const { state, tr, dispatch } = props;
        const listType = getNodeType(listName, state.schema);
        const itemType = getNodeType(itemName, state.schema);
        const { selection } = state;
        for (let depth = selection.$from.depth; depth > 0; depth--) {
          const list = selection.$from.node(depth);
          if (!listTypes.has(list.type.name)) continue;
          const pos = selection.$from.before(depth);
          if (selection.to >= pos + list.nodeSize || list.type === listType
            || list.firstChild?.type === itemType) break;
          const items = Fragment.fromArray(Array.from({ length: list.childCount }, (_, i) => {
            const item = list.child(i);
            return itemType.create(null, item.content, item.marks);
          }));
          if (!listType.validContent(items)) return false;
          if (dispatch) {
            tr.replaceWith(pos, pos + list.nodeSize, listType.create(attributes, items));
            tr.setSelection(selection.getBookmark().resolve(tr.doc));
            if (keepMarks) tr.ensureMarks(state.storedMarks ?? selection.$from.marks());
          }
          return true;
        }
        return commands.toggleList(listName, itemName, keepMarks, attributes)(props);
      },
    };
  },
});

type ClipboardParser = NonNullable<EditorProps["clipboardTextParser"]>;

// ProseMirror accepts null to use its default parser, but its type omits null.
export const parseMarkdownListClipboard =
  ((text, _context, plainText, view) => {
    if (plainText || !/^\s*(?:[-+*]|\d+[.)])\s/.test(text)) return null;
    const doc = parseRichdocMarkdown(text);
    if (!doc.content?.some(node => listTypes.has(node.type ?? ""))) return null;
    return Slice.maxOpen(view.state.schema.nodeFromJSON(doc).content);
  }) as ClipboardParser;
