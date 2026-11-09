import { describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Command, type Plugin } from "@tiptap/pm/state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, tableEditing } from "@tiptap/pm/tables";
import { Decoration, type DecorationSet } from "@tiptap/pm/view";
import { makeTableControlsPlugin } from "./tableControls";
import { doc, paragraph, randomEdit, schema, seededRandom } from "./testDocs";

function table(rows: number, cols: number, label = ""): PMNode {
  return schema.node(
    "table",
    null,
    Array.from({ length: rows }, (_, row) =>
      schema.node(
        "tableRow",
        null,
        Array.from({ length: cols }, (_, col) =>
          schema.node(row === 0 ? "tableHeader" : "tableCell", null, [paragraph(`${label}${row}${col}`)]),
        ),
      ),
    ),
  );
}

// Each control's range and key, or the node class for a table's own decoration.
function shown(state: EditorState, plugin: Plugin) {
  return (plugin.getState(state) as DecorationSet)
    .find()
    .map(({ from, to, spec }) => ({ from, to, key: String(spec.key ?? "table") }))
    .sort((a, b) => a.from - b.from || a.to - b.to || a.key.localeCompare(b.key));
}

function expected(document: PMNode) {
  const plugin = makeTableControlsPlugin();
  return shown(EditorState.create({ doc: document, plugins: [plugin] }), plugin);
}

function cellPositions(document: PMNode): number[] {
  const positions: number[] = [];
  document.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") positions.push(pos);
  });
  return positions;
}

describe("makeTableControlsPlugin — edits", () => {
  it("matches a full rebuild after every edit", () => {
    const random = seededRandom(2260);
    const plugin = makeTableControlsPlugin();
    let state = EditorState.create({
      doc: doc(paragraph("lead"), table(2, 2, "a"), paragraph("between"), table(3, 2, "b"), paragraph("after")),
      // As in the editor, a table an edit leaves uneven is fixed after it.
      plugins: [plugin, tableEditing()],
    });
    const commands: Command[] = [addRowAfter, addColumnAfter, deleteRow, deleteColumn];
    for (let step = 0; step < 400; step += 1) {
      const cells = cellPositions(state.doc);
      if (cells.length && random() < 0.2) {
        const cell = cells[Math.floor(random() * cells.length)]!;
        const inCell = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(cell + 1))));
        const command = commands[Math.floor(random() * commands.length)]!;
        command(inCell, (tr) => {
          state = inCell.apply(tr);
        });
      } else {
        state = state.apply(randomEdit(state, random, ["a", " ", "\n", "|"]));
      }
      expect(shown(state, plugin), `step ${step}`).toEqual(expected(state.doc));
    }
  });

  it("makes only the edited table's controls again when typing in a note with 1,000 tables", () => {
    const plugin = makeTableControlsPlugin();
    let state = EditorState.create({
      doc: doc(...Array.from({ length: 1000 }, () => table(2, 2))),
      plugins: [plugin],
    });
    const cell = cellPositions(state.doc)[2000]!;
    const widget = vi.spyOn(Decoration, "widget");
    const node = vi.spyOn(Decoration, "node");
    try {
      state = state.apply(state.tr.insertText("x", cell + 2));
      // One table: two column grips, the menu, two append buttons, and a
      // grip and a resize handle for each of its two rows.
      expect(widget).toHaveBeenCalledTimes(9);
      expect(node).toHaveBeenCalledTimes(1);
    } finally {
      widget.mockRestore();
      node.mockRestore();
    }
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });
});
