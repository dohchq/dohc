import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, Selection } from "@tiptap/pm/state";
import { CellSelection, goToNextCell, pointsAtCell, TableMap } from "@tiptap/pm/tables";

/**
 * Whether a table's rows differ in length or its cells overlap. In format 2 no editor repairs a
 * table, so one that two people change at once can stay uneven, and `prosemirror-tables`
 * commands then throw or act on the wrong cells.
 */
export function isUnevenTable(table: ProseMirrorNode): boolean {
  const { problems } = TableMap.get(table);
  return problems?.some((problem) => problem.type !== "colwidth mismatch") ?? false;
}

export function inUnevenTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1)
    if ($pos.node(depth).type.spec.tableRole === "table") return isUnevenTable($pos.node(depth));
  return false;
}

/**
 * Keeps a format 2 editor off what `prosemirror-tables` can't do in an uneven table. A cell
 * selection there, whether a person makes it or a change from elsewhere maps one into it,
 * becomes a caret in its head cell, or in its anchor cell when the head is a missing cell: one
 * reads as the table's first row, so the selection would cover the wrong cells. Tab in the
 * table's last cell adds no row.
 */
export function unevenTableGuard(): Plugin {
  return new Plugin({
    appendTransaction(_, __, state) {
      const { selection } = state;
      if (!(selection instanceof CellSelection) || !inUnevenTable(selection.$head)) return null;
      const $cell = pointsAtCell(selection.$headCell) ? selection.$headCell : selection.$anchorCell;
      return state.tr.setSelection(Selection.near(state.doc.resolve($cell.pos + 1)));
    },
    props: {
      handleKeyDown(view, event) {
        if (event.key !== "Tab" || event.shiftKey) return false;
        return inUnevenTable(view.state.selection.$head) && !goToNextCell(1)(view.state);
      },
    },
  });
}
