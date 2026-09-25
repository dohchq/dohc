import { TextSelection, type EditorState, type Selection } from "@tiptap/pm/state";
import { turnIntoIdAt, type BlockMenuTurnIntoId } from "./blockControls";

// The selection toolbar shows only for a non-empty text selection.
export function hasFormattableSelection(selection: Selection): selection is TextSelection {
  return selection instanceof TextSelection && !selection.empty;
}

const FORMAT_MARKS = ["bold", "italic", "underline", "strike", "code", "highlight", "link"] as const;
type FormatMark = (typeof FORMAT_MARKS)[number];

export type SelectionFormat = { block: BlockMenuTurnIntoId } & Record<FormatMark, boolean>;

export const NO_SELECTION_FORMAT: SelectionFormat = Object.freeze({
  block: "paragraph",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  highlight: false,
  link: false,
});

/**
 * The block and marks under the selection, for the selection toolbar.
 *
 * The toolbar reads this on every transaction, typing and remote edits
 * included, whether or not it shows. So it returns a constant without a
 * selection, and with one it visits only the selected blocks, once for all
 * marks. `editor.isActive` walks the document from its start, once per mark.
 *
 * A mark is active as in TipTap's `isMarkActive`: it covers every selected
 * character that can carry it, where text under a mark that excludes it
 * (inline code) counts once the mark covers any text.
 */
export function selectionFormat(state: EditorState): SelectionFormat {
  const { selection, schema, doc } = state;
  if (!hasFormattableSelection(selection)) return NO_SELECTION_FORMAT;
  const { $from, from, to } = selection;
  const types = FORMAT_MARKS.map((name) => schema.marks[name]);
  const selected = types.map(() => 0);
  const matched = types.map(() => 0);
  const excluded = types.map(() => 0);

  let blockStart = $from.before(1);
  for (let index = $from.index(0); index < doc.childCount && blockStart < to; index += 1) {
    const block = doc.child(index);
    const contentStart = blockStart + 1;
    block.nodesBetween(
      Math.max(0, from - contentStart),
      Math.min(block.content.size, to - contentStart),
      (node, pos, parent) => {
        if (!node.isText && node.marks.length === 0) return;
        const range = Math.min(to, pos + node.nodeSize) - Math.max(from, pos);
        types.forEach((type, i) => {
          if (!type || !parent?.type.allowsMarkType(type)) return;
          selected[i] += range;
          if (node.marks.some((mark) => mark.type === type)) matched[i] += range;
          else if (node.marks.some((mark) => mark.type.excludes(type))) excluded[i] += range;
        });
      },
      contentStart,
    );
    blockStart += block.nodeSize;
  }

  const format: SelectionFormat = { ...NO_SELECTION_FORMAT, block: turnIntoIdAt($from) };
  FORMAT_MARKS.forEach((name, i) => {
    format[name] = matched[i]! > 0 && matched[i]! + excluded[i]! >= selected[i]!;
  });
  return format;
}
