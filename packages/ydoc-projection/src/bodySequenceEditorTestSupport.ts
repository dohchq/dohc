// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  dropPoint,
  ReplaceAroundStep,
  ReplaceStep,
  StepMap,
  Transform,
} from "@tiptap/pm/transform";
import { Fragment, Mark, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
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
  toggleHeaderCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from "@tiptap/pm/tables";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import { isBodySequenceChange } from "./bodySequenceEditor.js";
import {
  blockHolding,
  blockStartingAt,
  boundaryAt,
  createBodyReader,
  positionOf,
} from "./bodySequenceReading.js";
import {
  giveBoundaries,
  howToWrite,
  linesAWriteLeavesWanting,
  linesBroughtIntoBeing,
  linesWithNoBoundary,
  type BodyWriting,
  type LineWithNoBoundary,
} from "./bodySequenceWriting.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  boundary,
  declared,
  element,
  exchange,
  noteOf,
  person,
  schema,
  stopEveryone,
  tokensOf,
  type Person,
} from "./bodySequenceTestSupport.js";
import { BLOCK_ELEMENT, BODY_CONTAINERS_FIELD, BODY_SEQUENCE_FIELD } from "./bodySequenceStore.js";

export type Part =
  | string
  | readonly [string, Record<string, unknown>]
  | { letters: string; marks: Record<string, unknown> };
export type StoredLine = { boundary: Record<string, unknown> | null; parts: readonly Part[] };

export const HARD_BREAK: Part = ["hardBreak", {}];
export const WIKILINK: Part = ["wikilink", { target: "Page", label: null }];
export const CODE = { type: "codeBlock", language: null };
export const RULE = { type: "horizontalRule" };
export const PARAGRAPH = { type: "paragraph" };
export const MATH = { type: "mathBlock", tex: "x" };
const RAW = { type: "rawBlock", source: "<hr>" };
export const IN_ITEM = { path: ["L", "I"] };
export const stored = (
  boundaryAttrs: Record<string, unknown> | null,
  ...parts: Part[]
): StoredLine => ({
  boundary: boundaryAttrs,
  parts,
});

export function noteOfLines(lines: readonly StoredLine[]): Uint8Array {
  return noteOf(({ sequence, containers }) => {
    for (const [id, type] of [
      ["L", "bulletList"],
      ["I", "listItem"],
      ["Q", "blockquote"],
      ["Q2", "blockquote"],
      ["TB", "table"],
      ["R1", "tableRow"],
      ["R2", "tableRow"],
      ["A1", "tableHeader"],
      ["A2", "tableHeader"],
      ["B1", "tableCell"],
      ["B2", "tableCell"],
    ] as const)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        containers.set(key, value);
    for (const line of lines) {
      if (line.boundary) sequence.insertEmbed(sequence.length, boundary(line.boundary), {});
      for (const part of line.parts)
        if (typeof part === "string") sequence.insert(sequence.length, part, {});
        else if ("letters" in part) sequence.insert(sequence.length, part.letters, part.marks);
        else sequence.insertEmbed(sequence.length, element(part[0], part[1]), {});
    }
  });
}

/** The notes the every-step oracle, the two-step pass and the differential each go through. */
export const ORACLE_NOTES: [string, StoredLine[]][] = [
  ["two paragraphs", [stored({}, "ab"), stored({}, "cd")]],
  ["code, then an item and text", [stored(CODE, "ab", WIKILINK, "cd")]],
  ["code, then an item, a letter and an item", [stored(CODE, "ab", WIKILINK, "x", HARD_BREAK)]],
  [
    "code, then code with an item, a letter and an item",
    [stored(CODE, "cc"), stored(CODE, "kk", WIKILINK, "x", HARD_BREAK)],
  ],
  [
    "a heading, an empty line and a paragraph",
    [stored({ type: "heading", level: 2 }, "ab"), stored({}), stored({}, "cd")],
  ],
  ["text before the first boundary, then a paragraph", [stored(null, "hh"), stored({}, "ab")]],
  ["code, an inline item, text", [stored(CODE, "ab", HARD_BREAK, "cd")]],
  ["code, an item, text, an item, text", [stored(CODE, "ab", HARD_BREAK, "cd", WIKILINK, "ef")]],
  ["empty code, an item, text", [stored(CODE, HARD_BREAK, "cd")]],
  [
    "a paragraph, code with an item and text, a paragraph",
    [stored({}, "ab"), stored(CODE, "cd", WIKILINK, "ef"), stored({}, "gh")],
  ],
  ["a rule with text", [stored(RULE, "abc")]],
  ["a math block with text", [stored(MATH, "abc")]],
  ["a raw block with an item and text", [stored(RAW, WIKILINK, "ab")]],
  [
    "a paragraph, a rule with text, a paragraph",
    [stored({}, "ab"), stored(RULE, "cd"), stored({}, "ef")],
  ],
  ["two rules, the second with text", [stored(RULE), stored(RULE, "abc")]],
  ["code, then a rule with text", [stored(CODE, "ab"), stored(RULE, "cd")]],
  [
    "a list item whose first block is a heading",
    [stored({}, "ab"), stored({ type: "heading", level: 2, ...IN_ITEM }, "cd"), stored({}, "ef")],
  ],
  [
    "a list item whose first block is code with an item and text",
    [stored({ ...CODE, ...IN_ITEM }, "ab", HARD_BREAK, "cd"), stored({}, "ef")],
  ],
  [
    "a list item whose first block is a rule with text",
    [stored({}, "ab"), stored({ ...RULE, ...IN_ITEM }, "cd")],
  ],
  [
    "a list item with a paragraph and a rule with text",
    [stored(IN_ITEM, "ab"), stored({ ...RULE, ...IN_ITEM }, "cd"), stored({}, "ef")],
  ],
  [
    "a list item with two paragraphs, then a paragraph",
    [stored(IN_ITEM, "ab"), stored(IN_ITEM, "cd"), stored({}, "ef")],
  ],
  [
    "a quote with a rule and text, then a paragraph",
    [stored({ ...RULE, path: ["Q"] }, "ab"), stored({}, "cd")],
  ],
  [
    "a quote with code, an item and text",
    [stored({}, "ab"), stored({ ...CODE, path: ["Q"] }, "cd", HARD_BREAK, "ef")],
  ],
  [
    "code, then a quoted list item whose first block is an empty heading",
    [
      stored(CODE, "ab"),
      stored({ type: "heading", level: 2, path: ["Q", "L", "I"] }),
      stored({}, "cd"),
    ],
  ],
  [
    "code whose letters carry stored formatting, then a paragraph",
    [stored(CODE, "a", { letters: "bc", marks: { bold: {} } }), stored({}, "de")],
  ],
  [
    "a quote that ends with a rule and text, then a quote of its own",
    [stored({ ...RULE, path: ["Q"] }, "ab"), stored({ path: ["Q2"] }, "cd")],
  ],
];

export const ADDED_BLOCK_NOTES = [...ORACLE_NOTES];

const SWEPT_ABOVE: [string, StoredLine | null][] = [
  ["nothing", null],
  ["text before the first boundary", stored(null, "hh")],
  ["a paragraph", stored({}, "One")],
  ["a rule", stored(RULE)],
  ["a rule with text", stored(RULE, "zz")],
  ["code", stored(CODE, "cc")],
];
const SWEPT_BLOCKS: [string, Record<string, unknown>, Part[]][] = [
  ["a rule with text", RULE, ["abc"]],
  ["a math block with text", MATH, ["abc"]],
  ["code, an item and text", CODE, ["kk", HARD_BREAK, "abc"]],
];
for (const [aboveName, above] of SWEPT_ABOVE)
  for (const [blockName, block, parts] of SWEPT_BLOCKS)
    for (const inItem of [false, true])
      ORACLE_NOTES.push([
        `${aboveName}, then ${blockName}${inItem ? " in a list item" : ""}`,
        [...(above ? [above] : []), stored(inItem ? { ...block, ...IN_ITEM } : block, ...parts)],
      ]);
ORACLE_NOTES.push(
  [
    "headings of three levels",
    [
      stored({ type: "heading", level: 1 }, "One"),
      stored({ type: "heading", level: 2 }, "Two"),
      stored({ type: "heading", level: 3 }, "Three"),
    ],
  ],
  [
    "a list item whose first block is a heading of level 1, then a heading of level 3",
    [
      stored({ type: "heading", level: 1, ...IN_ITEM }, "Title"),
      stored({ type: "heading", level: 3 }, "ab"),
    ],
  ],
  [
    "code in a language with an item and text, then a math block with text",
    [stored({ type: "codeBlock", language: "ts" }, "ab", WIKILINK, "cd"), stored(MATH, "spilled")],
  ],
  [
    "a table with a header row",
    [
      stored({ path: ["TB", "R1", "A1"] }, "ab"),
      stored({ path: ["TB", "R1", "A2"] }, "cd"),
      stored({ path: ["TB", "R2", "B1"] }, "ef"),
      stored({ path: ["TB", "R2", "B2"] }, "gh"),
    ],
  ],
  [
    "a paragraph, a table of one row with an empty cell, a paragraph",
    [
      stored({}, "ab"),
      stored({ path: ["TB", "R2", "B1"] }, "cd"),
      stored({ path: ["TB", "R2", "B2"] }),
      stored({}, "ef"),
    ],
  ],
);

const mergedWith =
  (axis: "horiz" | "vert"): Command =>
  (state, dispatch) => {
    const $cell = cellAround(state.selection.$from);
    const $next = $cell && nextCell($cell, axis, 1);
    if (!$cell || !$next) return false;
    const cells = state.apply(state.tr.setSelection(new CellSelection($cell, $next)));
    return mergeCells(cells, dispatch);
  };

const movedOn =
  (what: "row" | "column"): Command =>
  (state, dispatch) => {
    const $cell = cellAround(state.selection.$from);
    if (!$cell) return false;
    const from = what === "row" ? $cell.index(-1) : $cell.index();
    const count = what === "row" ? $cell.node(-1).childCount : $cell.parent.childCount;
    if (from + 1 >= count) return false;
    return (what === "row" ? moveTableRow : moveTableColumn)({ from, to: from + 1 })(
      state,
      dispatch,
    );
  };

const rowMadeHigh: Command = (state, dispatch) => {
  const $cell = cellAround(state.selection.$from);
  if (!$cell) return false;
  dispatch?.(state.tr.setNodeAttribute($cell.before(), "height", 40));
  return true;
};

/** The table commands the oracle offers from each cell where they apply. */
export const TABLE_COMMANDS: [string, Command][] = [
  ["a row added under", addRowAfter],
  ["a row added above", addRowBefore],
  ["a column added after", addColumnAfter],
  ["a column added before", addColumnBefore],
  ["its row deleted", deleteRow],
  ["its column deleted", deleteColumn],
  ["the header row toggled", toggleHeaderRow],
  ["the header column toggled", toggleHeaderColumn],
  ["it made a header or a cell", toggleHeaderCell],
  ["it centered", setCellAttr("align", "center")],
  ["it made 120 wide", setCellAttr("colwidth", [120])],
  ["its row made 40 high", rowMadeHigh],
  ["it merged with the cell after", mergedWith("horiz")],
  ["it merged with the cell under", mergedWith("vert")],
  ["it split", splitCell],
  ["its row moved down", movedOn("row")],
  ["its column moved right", movedOn("column")],
];

/** What the every-step oracle counts over all its notes. `ORACLE_PARTS` holds each file's share. */
export const ORACLE_COUNTS = {
  outcomes: {
    applied: 41364,
    "refused, as no trial settles": 628,
    "refused, as a container would hold no line": 38,
    "not offered": 1112,
    "range error": 0,
  },
  undone: 40345,
  given: 24322,
  typedInBySomeoneElse: 40009,
  retypedBySomeoneElse: 27814,
  excepted: {
    "a mark on an inline item": 560,
    "formatting stored under a code block's letters": 33,
  },
  unsettled: {
    "a text drag of N-N to N": 230,
    "two paragraphs pasted over N-N": 51,
    "two paragraphs pasted over N-N, the first whole": 51,
    "an empty paragraph and a heading pasted over N-N": 51,
    "Enter over N-N": 138,
    "a divider over N-N": 3,
    "a code block put over N-N": 3,
    "a heading and a paragraph put over N-N": 3,
    "a delete and a split over N-N": 98,
  } as Record<string, number>,
  drags: {
    "text, applied": 7843,
    "block, applied": 756,
    "text, refused, as no trial settles": 230,
  } as Record<string, number>,
};

export type Agreement = {
  compared: number;
  trials: number;
  inTheWindow: number;
  onTheWholeNote: number;
};
export const AGREEMENT_COUNTS: Agreement = {
  compared: 54151,
  trials: 54118,
  inTheWindow: 54069,
  onTheWholeNote: 49,
};
export const AGREEMENT_IN_THE_DIFFERENTIAL: { sample: Agreement; full: Agreement } = {
  sample: { compared: 2237, trials: 2231, inTheWindow: 2231, onTheWholeNote: 0 },
  full: { compared: 12121, trials: 12106, inTheWindow: 12106, onTheWholeNote: 0 },
};

type OracleCounts = typeof ORACLE_COUNTS;
type OracleShares = Omit<OracleCounts, "excepted" | "unsettled" | "drags"> &
  Record<"excepted" | "unsettled" | "drags", Record<string, number>>;
type OracleShare = { counts: OracleShares; agreed: Agreement };
/**
 * The every-step oracle runs in two files so that neither runs long. Each file tries the notes
 * from `from` up to `to` and pins its share of the counts: `sample` for the steps tried by
 * default, `full` for every step. The full shares add up to `ORACLE_COUNTS`, and their
 * `agreed` with the differential's full share to `AGREEMENT_COUNTS`.
 */
export const ORACLE_PARTS: readonly {
  from: number;
  to: number;
  sample: OracleShare;
  full: OracleShare;
}[] = [
  {
    from: 0,
    to: 40,
    sample: {
      counts: {
        outcomes: {
          applied: 2609,
          "refused, as no trial settles": 27,
          "refused, as a container would hold no line": 0,
          "not offered": 111,
          "range error": 0,
        },
        undone: 2541,
        given: 1536,
        typedInBySomeoneElse: 2470,
        retypedBySomeoneElse: 1763,
        excepted: {
          "a mark on an inline item": 31,
          "formatting stored under a code block's letters": 8,
        },
        unsettled: {
          "a text drag of N-N to N": 13,
          "two paragraphs pasted over N-N": 2,
          "two paragraphs pasted over N-N, the first whole": 2,
          "an empty paragraph and a heading pasted over N-N": 2,
          "Enter over N-N": 4,
          "a delete and a split over N-N": 4,
        },
        drags: {
          "text, applied": 437,
          "block, applied": 52,
          "text, refused, as no trial settles": 13,
        },
      },
      agreed: {
        compared: 2636,
        trials: 2636,
        inTheWindow: 2635,
        onTheWholeNote: 1,
      },
    },
    full: {
      counts: {
        outcomes: {
          applied: 20062,
          "refused, as no trial settles": 248,
          "refused, as a container would hold no line": 0,
          "not offered": 593,
          "range error": 0,
        },
        undone: 19535,
        given: 12255,
        typedInBySomeoneElse: 18948,
        retypedBySomeoneElse: 13603,
        excepted: {
          "a mark on an inline item": 292,
          "formatting stored under a code block's letters": 33,
        },
        unsettled: {
          "a text drag of N-N to N": 82,
          "two paragraphs pasted over N-N": 21,
          "two paragraphs pasted over N-N, the first whole": 21,
          "an empty paragraph and a heading pasted over N-N": 21,
          "Enter over N-N": 55,
          "a divider over N-N": 3,
          "a code block put over N-N": 3,
          "a heading and a paragraph put over N-N": 3,
          "a delete and a split over N-N": 39,
        },
        drags: {
          "text, applied": 3485,
          "block, applied": 367,
          "text, refused, as no trial settles": 82,
        },
      },
      agreed: {
        compared: 20310,
        trials: 20310,
        inTheWindow: 20306,
        onTheWholeNote: 4,
      },
    },
  },
  {
    from: 40,
    to: 67,
    sample: {
      counts: {
        outcomes: {
          applied: 2754,
          "refused, as no trial settles": 48,
          "refused, as a container would hold no line": 4,
          "not offered": 85,
          "range error": 0,
        },
        undone: 2701,
        given: 1540,
        typedInBySomeoneElse: 2764,
        retypedBySomeoneElse: 1889,
        excepted: {
          "a mark on an inline item": 30,
        },
        unsettled: {
          "Enter over N-N": 14,
          "a delete and a split over N-N": 10,
          "a text drag of N-N to N": 18,
          "two paragraphs pasted over N-N": 2,
          "two paragraphs pasted over N-N, the first whole": 2,
          "an empty paragraph and a heading pasted over N-N": 2,
        },
        drags: {
          "text, applied": 545,
          "block, applied": 50,
          "text, refused, as no trial settles": 18,
        },
      },
      agreed: {
        compared: 2806,
        trials: 2800,
        inTheWindow: 2794,
        onTheWholeNote: 6,
      },
    },
    full: {
      counts: {
        outcomes: {
          applied: 21302,
          "refused, as no trial settles": 380,
          "refused, as a container would hold no line": 38,
          "not offered": 519,
          "range error": 0,
        },
        undone: 20810,
        given: 12067,
        typedInBySomeoneElse: 21061,
        retypedBySomeoneElse: 14211,
        excepted: {
          "a mark on an inline item": 268,
        },
        unsettled: {
          "a text drag of N-N to N": 148,
          "Enter over N-N": 83,
          "a delete and a split over N-N": 59,
          "two paragraphs pasted over N-N": 30,
          "two paragraphs pasted over N-N, the first whole": 30,
          "an empty paragraph and a heading pasted over N-N": 30,
        },
        drags: {
          "text, applied": 4358,
          "text, refused, as no trial settles": 148,
          "block, applied": 389,
        },
      },
      agreed: {
        compared: 21720,
        trials: 21702,
        inTheWindow: 21657,
        onTheWholeNote: 45,
      },
    },
  },
];

export const ORACLE_KINDS: [string, Record<string, unknown> | undefined][] = [
  ["paragraph", undefined],
  ["heading", { level: 1 }],
  ["heading", { level: 3 }],
  ["codeBlock", undefined],
];

type MarkDifference = {
  onItem: boolean;
  wasUnderCode: boolean;
  computedHasMarks: boolean;
  readHasMarks: boolean;
};

function markDifferences(
  before: ProseMirrorNode,
  applied: Transaction,
  read: ProseMirrorNode,
): MarkDifference[] | null {
  const computed = applied.doc;
  if (withoutMarks(computed) !== withoutMarks(read)) return null;
  const toBefore = applied.mapping.invert();
  const found: MarkDifference[] = [];
  read.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (let at = 0; at < node.nodeSize; at++) {
      const other = computed.nodeAt(pos + at)!;
      if (Mark.sameSet(node.marks, other.marks)) continue;
      found.push({
        onItem: !node.isText,
        wasUnderCode: before.resolve(toBefore.map(pos + at, 1)).parent.type.spec.code === true,
        computedHasMarks: other.marks.length > 0,
        readHasMarks: node.marks.length > 0,
      });
    }
    return false;
  });
  return found;
}

const ORACLE_EXCEPTIONS: {
  name: string;
  why: string;
  explains: (difference: MarkDifference) => boolean;
}[] = [
  {
    name: "formatting stored under a code block's letters",
    why: "A code block's letters keep the formatting items stored around them, which no reader shows while the block is code. ProseMirror's code block holds no marks, so its document has none on those letters once they leave the code block; the note reads the stored ones again.",
    explains: (difference) =>
      !difference.onItem && difference.wasUnderCode && !difference.computedHasMarks,
  },
  {
    name: "a mark on an inline item",
    why: "ProseMirror puts a mark on an inline item that stands in a marked range. The format gives marks to letters only, so the note reads the item with none.",
    explains: (difference) => difference.onItem && !difference.readHasMarks,
  },
];

export const REFERENCE = Symbol("the reference writer");
const SECOND_PERSONS_LETTER = "\u2603";
export const writingOf = (note: { sequence: Y.Text; containers: Y.Map<unknown> }): BodyWriting => ({
  sequence: note.sequence,
  reader: createBodyReader(schema, note.sequence, note.containers),
});

export const PADDING = Array.from({ length: 3 }, () => stored({}, "pad"));
type Longer = { baseline: Uint8Array; shift: number };

export function amongMoreLines(lines: readonly StoredLine[]): Longer {
  const above = lines[0]?.boundary ? PADDING : [];
  return { baseline: noteOfLines([...above, ...lines, ...PADDING]), shift: above.length * 5 };
}

type ContainerRun = { id: string; depth: number; first: Y.ID; above: string };

function containerRuns(doc: Y.Doc): ContainerRun[] {
  const runs: ContainerRun[] = [];
  let open: ContainerRun[] = [];
  for (let item = doc.getText(BODY_SEQUENCE_FIELD)._start; item !== null; item = item.right) {
    const type =
      item.deleted || !(item.content instanceof Y.ContentType) ? null : item.content.type;
    if (!(type instanceof Y.XmlElement) || type.nodeName !== BLOCK_ELEMENT) continue;
    const path = type.getAttribute("path") as unknown;
    let continues = true;
    open = (Array.isArray(path) ? (path as string[]) : []).map((id, depth, ids) => {
      continues &&= open[depth]?.id === id;
      if (continues) return open[depth]!;
      const run = { id, depth, first: item.id, above: ids.slice(0, depth).join() };
      runs.push(run);
      return run;
    });
  }
  return runs;
}

const FAMILY_OF: Record<string, string> = {
  bulletList: "list",
  orderedList: "list",
  taskList: "list",
  listItem: "item",
  taskItem: "item",
  blockquote: "box",
  callout: "box",
};

/**
 * The record rules a change broke, which hold after any merge: no record key goes, and every
 * container a path names has its type recorded, and each record its type is made with.
 */
export function recordRulesBroken(before: Y.Doc, after: Y.Doc): string[] {
  const broken: string[] = [];
  const records = after.getMap(BODY_CONTAINERS_FIELD);
  for (const key of before.getMap(BODY_CONTAINERS_FIELD).keys())
    if (!records.has(key)) broken.push(`the record ${key} went`);
  for (const { id } of containerRuns(after)) {
    const type = records.get(id);
    if (typeof type !== "string") broken.push(`the container ${id} has no type`);
    else
      for (const [key] of recordsOfContainer(schema, { id, type, attrs: {} }))
        if (!records.has(key)) broken.push(`the container ${id} has no record ${key}`);
  }
  return broken;
}

/**
 * The container rules one person's write broke, checked from the stored note alone, so they hold
 * whatever the writers decide: the record rules, no id comes to be shared by two containers that
 * did not share it before, and no container's id goes while the leaf that led it still leads a
 * container of its family under the same containers, unless another container shared that id or
 * that leaf led the container now there already, as when a lift takes away the one around it, or
 * a container it led shared its id and so took a fresh one. Merging two people's changes may leave one id on two containers, so these hold for a write, not
 * for a merge.
 */
export function containerRulesBroken(before: Y.Doc, after: Y.Doc): string[] {
  const broken = recordRulesBroken(before, after);
  const recordsBefore = before.getMap(BODY_CONTAINERS_FIELD);
  const records = after.getMap(BODY_CONTAINERS_FIELD);
  const runsBefore = containerRuns(before);
  const runs = containerRuns(after);
  const sharedIn = (all: ContainerRun[]) => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const { id } of all) (seen.has(id) ? shared : seen).add(id);
    return shared;
  };
  const sharedBefore = sharedIn(runsBefore);
  for (const id of sharedIn(runs))
    if (!sharedBefore.has(id)) broken.push(`two containers now share the id ${id}`);
  for (const was of runsBefore) {
    if (sharedBefore.has(was.id) || runs.some((run) => run.id === was.id)) continue;
    const now = runs.find(
      (run) =>
        Y.compareIDs(run.first, was.first) && run.depth === was.depth && run.above === was.above,
    );
    const family = (records: Y.Map<unknown>, id: string) => FAMILY_OF[String(records.get(id))];
    const movedUp = (id: string) =>
      runsBefore.some(
        (run) =>
          Y.compareIDs(run.first, was.first) &&
          (run.id === id ||
            (run.depth > was.depth && sharedBefore.has(run.id) && !recordsBefore.has(id))),
      );
    if (now && !movedUp(now.id) && family(records, now.id) === family(recordsBefore, was.id))
      broken.push(`the container ${was.id}, still led by its first leaf, is now ${now.id}`);
  }
  return broken;
}

/**
 * Asks how to write some transactions, from a trial on the blocks around them and from one on
 * the whole note, and throws when the two differ in the lines they give first or in which
 * transactions they write as one step. `longer` is the note with more lines around it, so the
 * window leaves blocks out. Counts what it compared in `agreement`.
 */
export function expectTheWindowToAgree(
  agreement: Agreement,
  longer: Longer,
  transactions: readonly Transaction[],
  label: string,
): void {
  const fresh = declared(97);
  Y.applyUpdate(fresh.doc, longer.baseline);
  const writing = writingOf(fresh);
  let doc = writing.reader.reading().doc;
  const moved = transactions.map((transaction) => {
    const transform = new Transform(doc);
    for (const step of transaction.steps) transform.step(step.map(StepMap.offset(longer.shift))!);
    doc = transform.doc;
    return transform;
  });
  const copies = new Map<Y.Doc, boolean>();
  const getText = Y.Doc.prototype.getText;
  const asked = vi.spyOn(Y.Doc.prototype, "getText").mockImplementation(function (
    this: Y.Doc,
    name?: string,
  ) {
    if (this !== fresh.doc && !copies.has(this))
      copies.set(this, this.share.has(BODY_SEQUENCE_FIELD));
    return getText.call(this, name);
  });
  const said = (how: ReturnType<typeof howToWrite>) =>
    JSON.stringify(how && [how.lines, how.transactions.map((each) => each.steps.length)]);
  let onTheWholeNote: string;
  let inTheWindow: string;
  let ranATrial: boolean;
  let copiedTheNote: boolean;
  try {
    onTheWholeNote = said(howToWrite(writing, moved, "note"));
    ranATrial = copies.size > 0;
    copies.clear();
    inTheWindow = said(howToWrite(writing, moved));
    copiedTheNote = [...copies.values()].some(Boolean);
  } finally {
    asked.mockRestore();
    fresh.doc.destroy();
  }
  agreement.compared += 1;
  if (ranATrial) agreement.trials += 1;
  if (ranATrial && copiedTheNote) agreement.onTheWholeNote += 1;
  else if (ranATrial) agreement.inTheWindow += 1;
  if (inTheWindow !== onTheWholeNote)
    throw new Error(
      `${label}, with three paragraphs more on each side: a trial on the blocks around the edit gives ${inTheWindow}, one on the whole note ${onTheWholeNote}`,
    );
}

/**
 * Writes one applied transaction again to a copy of the note it started from, as `howToWrite`
 * says for that note and with the boundaries the editor gave first. Throws when the write brings
 * a line into being with no boundary, does not settle, or leaves a line wanting a boundary that
 * it would not have deleted.
 */
export function expectNoLineLeftWanting(
  held: Uint8Array,
  sent: readonly Uint8Array[],
  wrote: Transaction,
  label: string,
): void {
  const asGiven = (isGiven = sent.length === 2) => {
    const settled = declared(95);
    Y.applyUpdate(settled.doc, held);
    if (isGiven) Y.applyUpdate(settled.doc, sent[0]!);
    return settled;
  };
  let written: readonly Transform[] = [wrote];
  if (wrote.steps.length > 1) {
    const unwritten = asGiven(false);
    written = howToWrite(writingOf(unwritten), written, "note")?.transactions ?? written;
    unwritten.doc.destroy();
  }
  const settled = asGiven();
  const writing = writingOf(settled);
  const had = linesWithNoBoundary(writing);
  const again = linesAWriteLeavesWanting(writing, written);
  const made = linesBroughtIntoBeing(had, linesWithNoBoundary(writingOf(settled)));
  settled.doc.destroy();
  if (made.length > 0)
    throw new Error(
      `${label}: the recorded change brought the lines of blocks ${made.map((line) => String(line.block)).join()} into being and wrote them no boundary`,
    );
  if (!again.isSettled)
    throw new Error(
      `${label}: the recorded change does not read as the editor's document after each step when written again, or leaves a boundary it made in front of what a line with none held`,
    );
  if (again.wanting.length === 0) return;
  const given = asGiven();
  const more = writingOf(given);
  given.doc.transact(() => giveBoundaries(more, again.wanting));
  const gave = again.wanting.map((block) => more.reader.reading().lines[block]!.item!);
  linesAWriteLeavesWanting(more, written);
  const kept = again.wanting.filter((_, at) => !gave[at]!.deleted);
  given.doc.destroy();
  if (kept.length > 0)
    throw new Error(
      `${label}: the recorded change left the lines of blocks ${kept.join()} wanting a boundary that it would not have deleted, and gave them none first`,
    );
}

/** Whether `BODY_SEQUENCE_EDITOR_FULL=1` asks for every step and edit, not the sample. */
export const FULL = process.env.BODY_SEQUENCE_EDITOR_FULL === "1";

/**
 * The kind of a step or an edit, from the label that names it: what stands in braces stays, a
 * heading's level for one, and every other number, a place in the note, reads as N.
 */
export const kindOf = (label: string) => label.replaceAll(/\d+(?![^{]*\})/g, "N");

/**
 * Tries the steps or edits of one note as they are offered, by kind: every one in a full run,
 * else every eighth of its kind, starting at a place that differs from note to note, the same
 * places each time. `finish` then tries the first one of each kind that the eighths left out, so
 * every kind a note offers is tried in it.
 */
export function sampleOf(note: number) {
  const seen = new Map<string, number>();
  const firstLeftOut = new Map<string, (() => void) | null>();
  return {
    offer(kind: string, run: () => void): void {
      const nth = seen.get(kind) ?? 0;
      seen.set(kind, nth + 1);
      if (FULL || (nth + note) % 8 === 0) {
        firstLeftOut.set(kind, null);
        run();
      } else if (!firstLeftOut.has(kind)) firstLeftOut.set(kind, run);
    },
    finish(): void {
      for (const run of firstLeftOut.values()) run?.();
    },
  };
}

const takesContainersApart = (transaction: Transaction) =>
  transaction.steps.some((step, at) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    let opens = false;
    step.slice.content.descendants((node) => {
      opens ||= node.isBlock && !node.isTextblock && !node.isLeaf;
    });
    const $from = transaction.docs[at]!.resolve(step.from);
    const $to = transaction.docs[at]!.resolve(step.to);
    const depthOf = ($pos: typeof $from) => $pos.depth - ($pos.parent.isTextblock ? 1 : 0);
    return opens || $from.sharedDepth(step.to) < Math.max(depthOf($from), depthOf($to));
  });

const holdsAContainerWithNoLine = (doc: ProseMirrorNode) => {
  let found = false;
  doc.descendants((node) => {
    found ||= node.isBlock && !node.isTextblock && !node.isLeaf && node.childCount === 0;
    return !found;
  });
  return found;
};

type Outcome =
  | "applied"
  | "refused, as no trial settles"
  | "refused, as a container would hold no line"
  | "not offered"
  | "range error";

/**
 * Registers the every-step oracle for one of `ORACLE_PARTS`: in each of its notes, each step
 * the generators make that `sampleOf` picks is dispatched, and the note must read as the
 * document ProseMirror computed, undo must read as before, and a second person's letter and
 * kind must stay.
 */
export function everyStepOracle(part: number): void {
  const { from, to } = ORACLE_PARTS[part]!;
  const { counts, agreed } = ORACLE_PARTS[part]![FULL ? "full" : "sample"];
  const notes = ORACLE_NOTES.slice(from, to);
  const agreement: Agreement = { compared: 0, trials: 0, inTheWindow: 0, onTheWholeNote: 0 };
  const oracle = {
    notes: 0,
    outcomes: {
      applied: 0,
      "refused, as no trial settles": 0,
      "refused, as a container would hold no line": 0,
      "not offered": 0,
      "range error": 0,
    },
    unsettled: new Map<string, number>(),
    drags: new Map<string, number>(),
    excepted: new Map<string, number>(),
    undone: 0,
    given: 0,
    typedInBySomeoneElse: 0,
    retypedBySomeoneElse: 0,
  };

  describe("the note reads as the document ProseMirror computed", () => {
    const steps = FULL
      ? "every step"
      : "every eighth step of each kind, and one of each kind at least (BODY_SEQUENCE_EDITOR_FULL=1 tries every step)";
    it.each(notes)(`for ${steps} tried in %s`, (_name, lines) => {
      const baseline = noteOfLines(lines);
      const longer = amongMoreLines(lines);
      const start = readBodySequence(schema, person(baseline, 10).doc);
      stopEveryone();
      const size = start.content.size;
      const inText: number[] = [];
      for (let pos = 0; pos <= size; pos++)
        if (start.resolve(pos).parent.isTextblock) inText.push(pos);

      const sample = sampleOf(ORACLE_NOTES.findIndex(([, each]) => each === lines));
      const check = (label: string, act: (a: Person) => void) =>
        sample.offer(kindOf(label), () => tryIt(label, act));
      const tryIt = (label: string, act: (a: Person) => void) => {
        const a = person(baseline, 10);
        const before = a.view.state.doc;
        let applied: Transaction | null = null;
        let filtered: Transaction | null = null;
        const dispatch = a.view.dispatch.bind(a.view);
        a.view.dispatch = (transaction) => {
          if (transaction.docChanged && !isBodySequenceChange(transaction)) {
            if (a.view.state.applyTransaction(transaction).transactions.length > 0)
              applied = transaction;
            else filtered = transaction;
          }
          dispatch(transaction);
        };
        let outcome: Outcome = "not offered";
        try {
          act(a);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          outcome = "range error";
        }
        const wrote = applied as Transaction | null;
        const refused = filtered as Transaction | null;
        let unsettled = false;
        if (wrote && a.sent.length === 0 && a.view.state.doc.eq(before) && !wrote.doc.eq(before)) {
          const fresh = declared(94);
          Y.applyUpdate(fresh.doc, baseline);
          unsettled = howToWrite(writingOf(fresh), [wrote], "note") === null;
          const left = linesAWriteLeavesWanting(writingOf(fresh), [wrote]);
          fresh.doc.destroy();
          if (
            unsettled &&
            !holdsAContainerWithNoLine(wrote.doc) &&
            left.moved.length === 0 &&
            (left.isSettled || left.wanting.length === 0)
          )
            throw new Error(
              `${label} in ${before.toString()} was refused, and neither because a boundary it makes would stand in front of what a line with none held nor because it deletes the boundary a moved item's added paragraph would be given`,
            );
        }
        if (wrote && unsettled) {
          if (label.startsWith("Enter") && !takesContainersApart(wrote))
            throw new Error(
              `${label} in ${before.toString()} was refused. Enter is written in every shape that takes no container apart: at a caret, and over a selection in one block or across blocks.`,
            );
          a.expectMirror();
          expectTheWindowToAgree(agreement, longer, [wrote], `${label} in ${before.toString()}`);
          if (holdsAContainerWithNoLine(wrote.doc))
            outcome = "refused, as a container would hold no line";
          else {
            outcome = "refused, as no trial settles";
            const kind = kindOf(label);
            oracle.unsettled.set(kind, (oracle.unsettled.get(kind) ?? 0) + 1);
          }
        } else if (wrote) {
          outcome = "applied";
          a.expectMirror();
          const was = declared(93);
          Y.applyUpdate(was.doc, baseline);
          const broken = containerRulesBroken(was.doc, a.doc);
          was.doc.destroy();
          if (broken.length > 0)
            throw new Error(`${label} in ${before.toString()}: ${broken.join("; ")}`);
          const read = readBodySequence(schema, a.doc);
          if (!read.eq(wrote.doc)) {
            const differences = markDifferences(before, wrote, read);
            const names = new Set<string>();
            const unexplained =
              differences === null ||
              differences.some((difference) => {
                const exception = ORACLE_EXCEPTIONS.find((each) => each.explains(difference));
                if (exception) names.add(exception.name);
                return !exception;
              });
            if (unexplained)
              throw new Error(
                `${label} in ${before.toString()}\n  ProseMirror computed ${wrote.doc.toString()}\n  the note reads as     ${read.toString()}`,
              );
            for (const name of names)
              oracle.excepted.set(name, (oracle.excepted.get(name) ?? 0) + 1);
          }
          expect(a.sent.length, label).toBeLessThanOrEqual(2);
          if (a.sent.length === 2) oracle.given += 1;
          expectTheWindowToAgree(agreement, longer, [wrote], `${label} in ${before.toString()}`);
          expectNoLineLeftWanting(baseline, a.sent, wrote, `${label} in ${before.toString()}`);
          if (a.undo()) {
            a.expectMirror();
            const undone = readBodySequence(schema, a.doc);
            if (!undone.eq(before))
              throw new Error(
                `${label} in ${before.toString()}\n  after its undo the note reads as ${undone.toString()}`,
              );
            oracle.undone += 1;
          }
        } else if (refused)
          throw new Error(`${label} in ${before.toString()} was refused for no listed reason`);
        oracle.outcomes[outcome] += 1;
        const drag = /^a (text|block) drag/.exec(label)?.[1];
        if (drag)
          oracle.drags.set(
            `${drag}, ${outcome}`,
            (oracle.drags.get(`${drag}, ${outcome}`) ?? 0) + 1,
          );
        stopEveryone();
        if (outcome === "applied") withASecondPerson(label, act);
      };

      const blockOf = (who: Person, line: LineWithNoBoundary) => {
        const reading = writingOf(who).reader.reading();
        const tokens = tokensOf(who.sequence);
        const idOf = (id: Y.ID) => `${String(id.client)}:${String(id.clock)}`;
        const indexOf = (ids: readonly Y.ID[]) =>
          tokens.findIndex((token) => ids.some((id) => idOf(id) === token.id));
        if (line.bare !== "item") {
          const first = indexOf(line.items);
          const at = first < 0 ? -1 : positionOf(reading, first);
          return { reading, block: at < 0 ? -1 : blockHolding(reading, at), at };
        }
        const under = line.owner ? indexOf([line.owner]) : -1;
        const below = under < 0 ? -1 : blockStartingAt(reading, positionOf(reading, under));
        const isItsParagraph =
          below > 0 &&
          reading.blocks[below - 1]!.node.type.name === "paragraph" &&
          reading.paths[below - 1]!.join() === reading.paths[below]!.join();
        const block = isItsParagraph ? below - 1 : -1;
        return { reading, block, at: block < 0 ? -1 : reading.starts[block]! + 1 };
      };

      const withASecondPerson = (label: string, act: (a: Person) => void) => {
        const noted = declared(96);
        Y.applyUpdate(noted.doc, baseline);
        const lines = linesWithNoBoundary(writingOf(noted));
        noted.doc.destroy();
        for (const line of lines) {
          const a = person(baseline, 10);
          const b = person(baseline, 20);
          const was = a.view.state.doc;
          try {
            act(a);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
          }
          const did = a.view.state.doc;
          const idOf = (id: Y.ID) => `${String(id.client)}:${String(id.clock)}`;
          const recorded = a.sent.length > 0 ? boundariesMadeIn(a.sent.at(-1)!) : [];
          const headed = line.bare === "item" ? line.owner : line.items[0];
          const givenIt =
            a.sent.length < 2 || !headed
              ? []
              : Y.decodeUpdate(a.sent[0]!).structs.flatMap((struct) =>
                  struct instanceof Y.Item &&
                  struct.rightOrigin &&
                  Y.compareIDs(struct.rightOrigin, headed)
                    ? [idOf(struct.id)]
                    : [],
                );
          exchange(a, b);
          const there = blockOf(b, line);
          const own =
            there.block < 0 || boundaryAt(there.reading, there.block) < 0
              ? null
              : there.reading.lines[there.block]!.item!.id;
          const standing = new Set(tokensOf(b.sequence).map((token) => token.id));
          const hasItsOwn = givenIt.some((id) => standing.has(id));
          if (own !== null && recorded.includes(idOf(own)) && !hasItsOwn)
            throw new Error(
              `${label} in ${was.toString()}, which gave ${did.toString()}: what block ${String(line.block)} held, which had no boundary and was given none that still stands, is under a boundary the recorded change wrote`,
            );
          if (there.block >= 0 && (own === null || givenIt.includes(idOf(own)))) {
            const keptItsKind = there.reading.blocks[there.block]!.node.sameMarkup(line.node);
            b.view.dispatch(b.view.state.tr.insertText(SECOND_PERSONS_LETTER, there.at));
            b.view.dispatch(
              b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, there.at)),
            );
            const retyped = line.bare !== "item" && b.retype("heading", { level: 3 });
            exchange(b, a);
            if (a.undo()) {
              exchange(a, b);
              oracle.typedInBySomeoneElse += 1;
              if (retyped && keptItsKind) oracle.retypedBySomeoneElse += 1;
              for (const each of [a, b]) {
                each.expectMirror();
                const now = blockOf(each, line);
                const block = now.block < 0 ? null : now.reading.blocks[now.block]!.node;
                const holdsTheLetter = block?.textContent.includes(SECOND_PERSONS_LETTER) === true;
                const isTheKind =
                  !retyped ||
                  !keptItsKind ||
                  (block?.type.name === "heading" && block.attrs.level === 3);
                if (!holdsTheLetter || !isTheKind)
                  throw new Error(
                    `${label} in ${was.toString()}, which gave ${did.toString()}: someone else typed at the start of block ${String(line.block)}${retyped ? " and made it a heading" : ""}, and after the undo the note reads ${each.view.state.doc.toString()}`,
                  );
              }
            }
          }
          stopEveryone();
        }
      };
      const select = (a: Person, from: number, to = from) =>
        a.view.dispatch(
          a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, from, to)),
        );

      for (let from = 0; from < size; from++)
        for (let to = from + 1; to <= size; to++)
          check(`delete(${String(from)}, ${String(to)})`, (a) =>
            a.view.dispatch(a.view.state.tr.delete(from, to)),
          );
      const places = textPlaces(start);
      const ranges: [number, number][] = places.map((place) => [place.pos, place.pos]);
      if (places.length > 1) {
        const last = places.at(-1)!;
        ranges.push([places[0]!.pos, last.pos + last.size]);
        ranges.push([places[0]!.pos, places[1]!.pos + places[1]!.size]);
      }
      for (const [from, to] of ranges)
        for (const [kind, attrs] of ORACLE_KINDS)
          check(`${kind}${JSON.stringify(attrs ?? {})} over ${String(from)}-${String(to)}`, (a) => {
            select(a, from, to);
            a.retype(kind, attrs);
          });
      const rule = () => schema.nodes.horizontalRule!.create();
      for (const pos of inText) {
        check(`Enter at ${String(pos)}`, (a) => {
          select(a, pos);
          a.press("Enter");
        });
        check(`a letter at ${String(pos)}`, (a) =>
          a.view.dispatch(a.view.state.tr.insertText("x", pos)),
        );
        check(`Backspace at ${String(pos)}`, (a) => {
          select(a, pos);
          a.press("Backspace");
        });
        check(`a divider at ${String(pos)}`, (a) =>
          a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, pos, pos, rule())),
        );
        for (const to of inText) {
          if (to <= pos) continue;
          const over = `over ${String(pos)}-${String(to)}`;
          check(`bold ${over}`, (a) => {
            select(a, pos, to);
            a.toggle("bold");
          });
          check(`Enter ${over}`, (a) => {
            select(a, pos, to);
            a.press("Enter");
          });
          check(`a divider ${over}`, (a) =>
            a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, pos, to, rule())),
          );
          check(`two paragraphs pasted ${over}`, (a) =>
            a.view.dispatch(a.view.state.tr.replaceRange(pos, to, twoParagraphs())),
          );
          check(`two paragraphs pasted ${over}, the first whole`, (a) =>
            a.view.dispatch(a.view.state.tr.replaceRange(pos, to, twoParagraphs(0))),
          );
          check(`a letter typed ${over}`, (a) =>
            a.view.dispatch(a.view.state.tr.insertText("Z", pos, to)),
          );
          check(`Backspace ${over}`, (a) => {
            select(a, pos, to);
            a.press("Backspace");
          });
          check(`a code block put ${over}`, (a) =>
            a.view.dispatch(
              tiptapInsertContentAt(
                a.view.state.tr,
                pos,
                to,
                schema.nodes.codeBlock!.create(null, schema.text("X")),
              ),
            ),
          );
          check(`an empty paragraph and a heading pasted ${over}`, (a) =>
            a.view.dispatch(
              a.view.state.tr.replaceRange(
                pos,
                to,
                new Slice(
                  Fragment.from([
                    schema.nodes.paragraph!.create(),
                    schema.nodes.heading!.create({ level: 2 }),
                  ]),
                  1,
                  1,
                ),
              ),
            ),
          );
          check(`a heading and a paragraph put ${over}`, (a) =>
            a.view.dispatch(
              tiptapInsertContentAt(a.view.state.tr, pos, to, [
                schema.nodes.heading!.create({ level: 2 }, schema.text("X")),
                schema.nodes.paragraph!.create(null, schema.text("Y")),
              ]),
            ),
          );
          check(`a delete and a split ${over}`, (a) =>
            a.view.dispatch(a.view.state.tr.delete(pos, to).split(pos)),
          );
          const acrossBlocks = !start.resolve(pos).sameParent(start.resolve(to));
          const outside = inText.filter((at) => at < pos || at > to);
          const targets = acrossBlocks ? outside : [outside[0], outside.at(-1)];
          for (const at of new Set(targets))
            if (at !== undefined)
              check(`a text drag of ${String(pos)}-${String(to)} to ${String(at)}`, (a) => {
                select(a, pos, to);
                a.view.dispatch(dropOfSelection(a.view.state, at));
              });
        }
      }
      const blocks: number[] = [];
      start.descendants((node, pos) => {
        if (node.isBlock && (node.isTextblock || node.isLeaf)) blocks.push(pos);
      });
      for (const pos of blocks)
        for (const at of [...blocks, size])
          if (at !== pos)
            check(`a block drag of ${String(pos)} to ${String(at)}`, (a) => {
              a.view.dispatch(
                a.view.state.tr.setSelection(NodeSelection.create(a.view.state.doc, pos)),
              );
              a.view.dispatch(dropOfSelection(a.view.state, at));
            });
      start.descendants((node, pos) => {
        const attribute = anotherAttribute(node);
        if (attribute)
          check(`another attribute of the ${node.type.name} at ${String(pos)}`, (a) =>
            a.view.dispatch(
              a.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attribute }),
            ),
          );
      });
      start.descendants((node, pos) => {
        if (!node.type.spec.tableRole?.includes("cell")) return true;
        const state = EditorState.create({
          doc: start,
          selection: TextSelection.create(start, pos + 2),
        });
        for (const [name, command] of TABLE_COMMANDS)
          if (command(state))
            check(`${name}, from the cell at ${String(pos)}`, (a) => {
              select(a, pos + 2);
              command(a.view.state, a.view.dispatch);
            });
        return false;
      });
      sample.finish();
      oracle.notes += 1;
    });

    afterAll(() => {
      console.log(
        `the oracle run, notes ${String(from)} to ${String(to - 1)}: ${String(oracle.notes)} notes; ${Object.entries(
          oracle.outcomes,
        )
          .map(([outcome, count]) => `${outcome} ${String(count)}`)
          .join(
            ", ",
          )}; undone and read as before ${String(oracle.undone)}; a line given its boundary first ${String(oracle.given)}; someone else typed at the start of a line that had no boundary, and it was undone ${String(oracle.typedInBySomeoneElse)}, of which they also made the line a heading ${String(oracle.retypedBySomeoneElse)}; exceptions: ${
          [...oracle.excepted].map(([name, count]) => `${name} (${String(count)})`).join("; ") ||
          "none"
        }; refused: ${
          [...oracle.unsettled].map(([kind, count]) => `${kind} (${String(count)})`).join("; ") ||
          "none"
        }; drags: ${[...oracle.drags].map(([kind, count]) => `${kind} (${String(count)})`).join("; ")}; a trial on the blocks around each step against one on the whole note, in the note with three paragraphs more on each side: compared ${String(agreement.compared)}, of which a trial ran ${String(agreement.trials)}: settled on the blocks around the edit ${String(agreement.inTheWindow)}, went on to the whole note ${String(agreement.onTheWholeNote)}`,
      );
      expect(oracle.notes).toBe(notes.length);
      expect(oracle.outcomes).toEqual(counts.outcomes);
      expect(oracle.undone).toBe(counts.undone);
      expect(oracle.given).toBe(counts.given);
      expect(oracle.typedInBySomeoneElse).toBe(counts.typedInBySomeoneElse);
      expect(oracle.retypedBySomeoneElse).toBe(counts.retypedBySomeoneElse);
      expect(Object.fromEntries(oracle.excepted)).toEqual(counts.excepted);
      expect(Object.fromEntries(oracle.unsettled)).toEqual(counts.unsettled);
      expect(Object.fromEntries(oracle.drags)).toEqual(counts.drags);
      expect(agreement).toEqual(agreed);
    });
  });
}

export const boundariesMadeIn = (update: Uint8Array) =>
  Y.decodeUpdate(update).structs.flatMap((struct) =>
    struct instanceof Y.Item &&
    struct.content instanceof Y.ContentType &&
    struct.content.type instanceof Y.XmlElement &&
    struct.content.type.nodeName === BLOCK_ELEMENT
      ? [`${String(struct.id.client)}:${String(struct.id.clock)}`]
      : [],
  );

export function tiptapInsertContentAt(
  tr: Transaction,
  from: number,
  to: number,
  node: ProseMirrorNode | readonly ProseMirrorNode[],
): Transaction {
  const $from = tr.doc.resolve(from);
  const parent = $from.parent;
  const isEmpty = parent.isTextblock && !parent.type.spec.code && parent.childCount === 0;
  if (from === to && isEmpty) return tr.replaceWith(from - 1, to + 1, node);
  const atItsStart = parent.isTextblock && $from.parentOffset === 0 && parent.content.size > 0;
  return tr.replaceWith(atItsStart ? from - 1 : from, to, node);
}

export function dropOfSelection(state: EditorState, at: number): Transaction {
  const slice = state.selection.content();
  const point = dropPoint(state.doc, at, slice) ?? at;
  const tr = state.tr.deleteSelection();
  const pos = tr.mapping.map(point);
  const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1;
  return isNode
    ? tr.replaceRangeWith(pos, pos, slice.content.firstChild!)
    : tr.replaceRange(pos, pos, slice);
}

export function twoParagraphs(openStart = 1): Slice {
  const paragraphs = ["X", "Y"].map((text) =>
    schema.nodes.paragraph!.create(null, schema.text(text)),
  );
  return new Slice(Fragment.from(paragraphs), openStart, 1);
}

export function anotherAttribute(node: ProseMirrorNode): Record<string, unknown> | null {
  if (node.type.name === "heading") return { level: (Number(node.attrs.level) % 3) + 1 };
  if (node.type.name === "codeBlock") return { language: "js" };
  if (node.type.name === "mathBlock") return { tex: `${String(node.attrs.tex)}+y` };
  return null;
}

export function withoutMarks(doc: ProseMirrorNode): string {
  const plain = (node: ProseMirrorNode): string => {
    if (node.isText) return JSON.stringify(node.text);
    const inside: string[] = [];
    node.forEach((child) => {
      const last = inside.at(-1);
      if (child.isText && last?.startsWith('"'))
        inside[inside.length - 1] = JSON.stringify(JSON.parse(last) + child.text!);
      else inside.push(plain(child));
    });
    return `${node.type.name}${JSON.stringify(node.attrs)}(${inside.join(",")})`;
  };
  return plain(doc);
}

export function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function textPlaces(doc: ProseMirrorNode): { pos: number; size: number }[] {
  const places: { pos: number; size: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) places.push({ pos: pos + 1, size: node.content.size });
    return node.isBlock && !node.isTextblock;
  });
  return places;
}

const seedsAsked = process.env.BODY_SEQUENCE_EDITOR_SEEDS;
/** How many runs the random tests make: 40, or the whole number `BODY_SEQUENCE_EDITOR_SEEDS` asks for. */
export const SEEDS = seedsAsked === undefined ? 40 : Number(seedsAsked);
if (!Number.isSafeInteger(SEEDS) || SEEDS < 1)
  throw new Error(
    `BODY_SEQUENCE_EDITOR_SEEDS must be a whole number of runs, 1 or more. It is ${JSON.stringify(seedsAsked)}.`,
  );
