// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { Command } from "@tiptap/pm/state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  cellAround,
  CellSelection,
  deleteColumn,
  deleteRow,
  mergeCells,
  moveTableColumn,
  moveTableRow,
  nextCell,
  setCellAttr,
  splitCell,
  tableEditing,
  toggleHeaderCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from "@tiptap/pm/tables";
import { type BodySequenceUnwritten } from "./bodySequenceEditor.js";
import {
  editorOn,
  exchange,
  page,
  person,
  stopEveryone,
  type Person,
} from "./bodySequenceTestSupport.js";
import { containerRulesBroken } from "./bodySequenceEditorTestSupport.js";
import { inUnevenTable, isUnevenTable, unevenTableGuard } from "./bodySequenceTables.js";
import {
  CONTAINER_ACTS,
  noteIn,
  playTogether,
  run,
  STARTING_FRAMES,
  STARTING_ROWS,
  type Act,
  type Frame,
  type Row,
} from "./bodySequenceEditorPlaySupport.js";

afterEach(stopEveryone);

const TABLE_FRAMES: Frame[] = [
  ["TB", "table"],
  ["R1", "tableRow"],
  ["R2", "tableRow"],
  ["R3", "tableRow"],
  ["A1", "tableHeader"],
  ["A2", "tableHeader"],
  ["B1", "tableCell"],
  ["B2", "tableCell"],
  ["W", "tableCell", { colspan: 2 }],
];
const TABLE_ROWS: Row[] = [
  [["TB", "R1", "A1"], "name"],
  [["TB", "R1", "A2"], "size"],
  [["TB", "R2", "B1"], "apple"],
  [["TB", "R2", "B2"], "big"],
  [["TB", "R3", "W"], "wide"],
];
const LINES = ["before", "name", "size", "apple", "big", "wide", "after"];
const baseline = noteIn(TABLE_FRAMES, [[[], "before"], ...TABLE_ROWS, [[], "after"]]);
const uneven = noteIn(TABLE_FRAMES, [
  [["TB", "R1", "A1"], "name"],
  [["TB", "R1", "A2"], "size"],
  [["TB", "R2", "B1"], "apple"],
]);
const even = noteIn(TABLE_FRAMES, [[[], "before"], ...TABLE_ROWS.slice(0, 4), [[], "after"]]);
const inAnItem = noteIn(
  [["O", "orderedList"], ["N", "listItem"], ["P", "listItem"], ...TABLE_FRAMES],
  [
    [null, "before"],
    [[], "middle"],
    [["O", "N"], ""],
    ...TABLE_ROWS.slice(2).map(([path, text]): Row => [["O", "P", ...path!], text]),
  ],
);

const caretIn = (a: Person, text: string) => a.select([a.lines().indexOf(text), 0]);

const cellsFrom = ($from: ResolvedPos, axis: "horiz" | "vert"): CellSelection | null => {
  const $cell = cellAround($from);
  const $next = $cell && nextCell($cell, axis, 1);
  return $cell && $next ? new CellSelection($cell, $next) : null;
};

const selectedCells =
  (axis: "horiz" | "vert", then: Command): Act =>
  (a) => {
    const cells = cellsFrom(a.view.state.selection.$from, axis);
    if (!cells) return false;
    return then(a.view.state.apply(a.view.state.tr.setSelection(cells)), a.view.dispatch);
  };

const rowHeight =
  (height: number): Act =>
  (a) => {
    const { $from } = a.view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--)
      if ($from.node(depth).type.name === "tableRow") {
        a.view.dispatch(a.view.state.tr.setNodeAttribute($from.before(depth), "height", height));
        return true;
      }
    return false;
  };

const moved =
  (what: "row" | "column", pick: (count: number, at: number) => number): Act =>
  (a) => {
    const { $from } = a.view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name !== "table") continue;
      const table = $from.node(depth);
      const row = $from.index(depth);
      const count = what === "row" ? table.childCount : table.child(row).childCount;
      const from = what === "row" ? row : $from.index(depth + 1);
      const to = pick(count, from);
      if (to === from) return false;
      const move = what === "row" ? moveTableRow : moveTableColumn;
      return move({ from, to })(a.view.state, a.view.dispatch);
    }
    return false;
  };

type Written = [
  name: string,
  at: string,
  act: Act,
  records: Record<string, unknown>,
  lines?: string[],
  note?: typeof baseline,
];

const WRITTEN: Written[] = [
  [
    "a row added under",
    "apple",
    run(addRowAfter),
    {},
    [...LINES.slice(0, 5), "", "", ...LINES.slice(5)],
  ],
  ["a row added above", "name", run(addRowBefore), {}, [LINES[0]!, "", "", ...LINES.slice(1)]],
  ["a column added after", "big", run(addColumnAfter), {}],
  ["a column added before", "name", run(addColumnBefore), {}],
  ["a column deleted", "apple", run(deleteColumn), { A1: "tableHeader", B1: "tableCell" }],
  [
    "a row deleted",
    "apple",
    run(deleteRow),
    { B1: "tableCell" },
    ["before", "name", "size", "wide", "after"],
  ],
  ["a cell's alignment", "apple", run(setCellAttr("align", "center")), { "B1.align": "center" }],
  ["a cell's width", "apple", run(setCellAttr("colwidth", [120])), { "B1.colwidth": [120] }],
  ["a row's height", "apple", rowHeight(40), { "R2.height": 40 }],
  ["a cell made a header", "apple", run(toggleHeaderCell), { B1: "tableHeader" }],
  ["a header row", "apple", run(toggleHeaderRow), { B1: "tableHeader", B2: "tableHeader" }],
  ["the header row turned off", "name", run(toggleHeaderRow), { A1: "tableCell", A2: "tableCell" }],
  ["the header column turned off", "apple", run(toggleHeaderColumn), { A1: "tableCell" }],
  [
    "a wide cell split",
    "wide",
    run(splitCell),
    { "W.colspan": 1 },
    [...LINES.slice(0, 6), "", "after"],
  ],
  ["two cells merged", "apple", selectedCells("horiz", mergeCells), { "B1.colspan": 2 }],
  [
    "a row moved down",
    "apple",
    moved("row", () => 2),
    {},
    ["before", "name", "size", "wide", "apple", "big", "after"],
  ],
  [
    "a column moved",
    "name",
    moved("column", () => 1),
    {},
    ["before", "size", "name", "big", "apple", "after"],
    even,
  ],
  [
    "a column added before a table that opens a list's second item, in a note whose first line has no boundary",
    "apple",
    run(addColumnBefore),
    {},
    ["before", "middle", "", "", "", "apple", "big", "", "wide"],
    inAnItem,
  ],
];

describe("table changes the editor writes", () => {
  it.each(WRITTEN)(
    "writes %s, as the editor shows it, and undo takes it back",
    (_name, at, act, records, lines, note = baseline) => {
      const told: BodySequenceUnwritten[] = [];
      const a = editorOn(page(note, 10), "bare", [], [], { unwritten: (why) => told.push(why) });
      const b = person(note, 20);
      const was = a.view.state.doc;
      caretIn(a, at);
      expect(act(a, () => 0)).toBe(true);
      expect(told).toEqual([]);
      expect(a.view.state.doc.eq(was)).toBe(false);
      expect(a.sent.length).toBeGreaterThan(0);
      a.expectMirror();
      if (lines) expect(a.lines()).toEqual(lines);
      for (const [key, value] of Object.entries(records))
        expect(a.containers.get(key), key).toEqual(value);
      expect(containerRulesBroken(page(note, 30).doc, a.doc)).toEqual([]);
      exchange(a, b);
      expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
      while (a.undo());
      a.expectMirror();
      expect(a.view.state.doc.eq(was)).toBe(true);
    },
  );

  it("keeps showing the note when someone else's changes leave a selected row of cells shorter than the table", () => {
    const a = person(baseline, 10);
    const b = person(baseline, 20);
    const cellAt = (text: string) => (caretIn(a, text), cellAround(a.view.state.selection.$from)!);
    a.view.dispatch(
      a.view.state.tr.setSelection(new CellSelection(cellAt("size"), cellAt("name"))),
    );
    caretIn(b, "apple");
    const apple = b.view.state.selection.from;
    caretIn(b, "size");
    b.view.dispatch(b.view.state.tr.delete(b.view.state.selection.from + 4, apple));
    caretIn(b, "name");
    expect(addColumnBefore(b.view.state, b.view.dispatch)).toBe(true);
    for (const update of b.sent) a.receive(update);
    expect(a.view.state.doc.eq(b.view.state.doc)).toBe(true);
    a.expectMirror();
  });

  it("turns a selected row into a caret in that row when someone else's column leaves the row short", () => {
    const a = person(even, 10, "bare", [tableEditing(), unevenTableGuard()]);
    const b = person(even, 20);
    caretIn(a, "apple");
    expect(addRowAfter(a.view.state, a.view.dispatch)).toBe(true);
    caretIn(b, "name");
    expect(addColumnAfter(b.view.state, b.view.dispatch)).toBe(true);
    a.select([a.lines().indexOf("big") + 1, 0]);
    a.view.dispatch(
      a.view.state.tr.setSelection(
        CellSelection.rowSelection(cellAround(a.view.state.selection.$from)!),
      ),
    );
    for (const update of b.sent) a.receive(update);
    const { selection } = a.view.state;
    expect(isUnevenTable(a.view.state.doc.child(1))).toBe(true);
    expect(selection).not.toBeInstanceOf(CellSelection);
    expect(cellAround(selection.$head)!.index(-1)).toBe(2);
    a.expectMirror();
  });

  it("writes a letter typed in an uneven table and refuses the repair the table plugin adds to it", () => {
    const a = person(uneven, 10, "bare", [tableEditing()]);
    a.select([2, 5]);
    a.type("s");
    expect(a.sent).toHaveLength(1);
    expect(a.lines()).toEqual(["name", "size", "apples"]);
    expect(a.view.state.doc.child(0).child(1).childCount).toBe(1);
    a.expectMirror();
  });
});

const ROWS = 1_000;
const DEEP = 61;

describe("a table change the room would refuse", () => {
  const refusedWhole = (a: Person, told: BodySequenceUnwritten[], lines: string[]) => {
    expect(told).toEqual(["unwritable"]);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(lines);
    a.expectMirror();
  };

  it("refuses a row added above the short row of an uneven table, which would hold no line", () => {
    const told: BodySequenceUnwritten[] = [];
    const a = editorOn(page(uneven, 10), "bare", [], [], { unwritten: (why) => told.push(why) });
    const lines = a.lines();
    caretIn(a, "apple");
    expect(addRowBefore(a.view.state, a.view.dispatch)).toBe(true);
    refusedWhole(a, told, lines);
  });

  it("refuses a column added to 1,000 rows 61 quotes deep, each of whose new boundaries holds the path", () => {
    const quotes = Array.from({ length: DEEP }, (_, at) => String(at).padEnd(32, "q"));
    const rows = Array.from({ length: ROWS }, (_, at) => `r${String(at)}`);
    const note = noteIn(
      [
        ...quotes.map((id): Frame => [id, "blockquote"]),
        ["TB", "table"],
        ...rows.flatMap((id): Frame[] => [
          [id, "tableRow"],
          [`${id}c`, "tableCell"],
        ]),
      ],
      rows.map((id): Row => [[...quotes, "TB", id, `${id}c`], "x"]),
    );
    const told: BodySequenceUnwritten[] = [];
    const a = editorOn(page(note, 10), "bare", [], [], { unwritten: (why) => told.push(why) });
    const lines = a.lines();
    a.select([0, 0]);
    expect(addColumnAfter(a.view.state, a.view.dispatch)).toBe(true);
    refusedWhole(a, told, lines);
  });

  it("refuses moving a row whose cells hold more letters than one change can carry", () => {
    const long = "x".repeat(2_200_000);
    const told: BodySequenceUnwritten[] = [];
    const a = editorOn(
      page(noteIn(TABLE_FRAMES, [[["TB", "R1", "A1"], long], ...TABLE_ROWS.slice(1)]), 10),
      "bare",
      [],
      [],
      { unwritten: (why) => told.push(why) },
    );
    const lines = a.lines();
    a.select([0, 0]);
    expect(moveTableRow({ from: 0, to: 1 })(a.view.state, a.view.dispatch)).toBe(true);
    refusedWhole(a, told, lines);
  });
});

const evenOnly =
  (act: Act): Act =>
  (a, next) => {
    const { $from, $head } = a.view.state.selection;
    return !inUnevenTable($from) && !inUnevenTable($head) && act(a, next);
  };

const withoutRowSpans =
  (act: Act): Act =>
  (a, next) => {
    let spans = false;
    a.view.state.doc.descendants((node) => !(spans ||= node.attrs.rowspan > 1));
    return !spans && act(a, next);
  };

const inOneCell =
  (act: Act): Act =>
  (a, next) => {
    const { $from, $to } = a.view.state.selection;
    return cellAround($from)?.pos === cellAround($to)?.pos && act(a, next);
  };

const TABLE_ACTS = [
  ["a row added under", evenOnly(run(addRowAfter))],
  ["a row added above", evenOnly(run(addRowBefore))],
  ["a column added after", run(addColumnAfter)],
  ["a column added before", run(addColumnBefore)],
  ["a row deleted", run(deleteRow)],
  ["a column deleted", run(deleteColumn)],
  ["the header row", evenOnly(run(toggleHeaderRow))],
  ["the header column", evenOnly(run(toggleHeaderColumn))],
  ["a header cell", run(toggleHeaderCell)],
  [
    "an alignment",
    (a, next) =>
      run(setCellAttr("align", ["left", "center", "right", null][Math.floor(next() * 4)]))(a, next),
  ],
  ["a width", (a, next) => run(setCellAttr("colwidth", [40 + Math.floor(next() * 200)]))(a, next)],
  ["a height", (a, next) => rowHeight(10 + Math.floor(next() * 90))(a, next)],
  ["cells merged across", evenOnly(selectedCells("horiz", mergeCells))],
  ["cells merged down", evenOnly(selectedCells("vert", mergeCells))],
  ["a cell split", inOneCell(run(splitCell))],
  [
    "a row moved",
    evenOnly(
      withoutRowSpans((a, next) => moved("row", (count) => Math.floor(next() * count))(a, next)),
    ),
  ],
  [
    "a column moved",
    evenOnly((a, next) => moved("column", (count) => Math.floor(next() * count))(a, next)),
  ],
] satisfies [string, Act][];

playTogether(
  "table changes",
  [...STARTING_FRAMES, ...TABLE_FRAMES],
  [...STARTING_ROWS.slice(0, 8), ...TABLE_ROWS, ...STARTING_ROWS.slice(8)],
  [...CONTAINER_ACTS, ...TABLE_ACTS, ...TABLE_ACTS],
);
