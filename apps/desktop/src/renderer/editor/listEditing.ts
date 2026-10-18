import { commands, Extension, getNodeType } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { canJoin } from "@tiptap/pm/transform";
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
        const range = selection.$from.blockRange(selection.$to);
        for (let depth = selection.$from.depth; depth > 0; depth--) {
          const list = selection.$from.node(depth);
          if (!listTypes.has(list.type.name)) continue;
          const parent = selection.$from.node(depth - 1);
          if (!range || range.depth - depth > 1
            || !["listItem", "taskItem"].includes(parent.type.name)) break;
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
            // Each join maps the selection; find the boundary again afterward.
            for (const direction of [-1, 1]) {
              const $from = tr.selection.$from;
              const boundary = direction < 0 ? $from.before(depth) : $from.after(depth);
              const $boundary = tr.doc.resolve(boundary);
              const before = $boundary.nodeBefore;
              const after = $boundary.nodeAfter;
              const normalize = (type: string | null | undefined) => !type || type === "1" ? null : type;
              if (before?.type === listType && after?.type === listType
                && normalize(before.attrs.type) === normalize(after.attrs.type)
                && canJoin(tr.doc, boundary)) tr.join(boundary);
            }
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
  ((text, context, plainText, view) => {
    if (plainText || !text.includes("\n") || context.parentOffset !== 0
      || context.parent.type.name !== "paragraph" || !/^\s*(?:[-+*]|\d+[.)])\s/.test(text)) return null;
    const doc = parseRichdocMarkdown(text);
    if (!doc.content?.length || !doc.content.every(node => listTypes.has(node.type ?? ""))) return null;
    return new Slice(view.state.schema.nodeFromJSON(doc).content, 0, 0);
  }) as ClipboardParser;
