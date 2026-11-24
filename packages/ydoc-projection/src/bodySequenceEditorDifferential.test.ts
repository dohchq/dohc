// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type Transaction } from "@tiptap/pm/state";
import { isBodySequenceChange } from "./bodySequenceEditor.js";
import { boundaryAt, createBodyReader, isAddedParagraph } from "./bodySequenceReading.js";
import {
  deleteRange,
  GIVEN_BOUNDARY,
  insertInline,
  joinLine,
  setLineKind,
  setMarks,
  splitLine,
  typeLetters,
  writeBody,
  type BodyChange,
} from "./bodySequenceWriter.js";
import { howToWrite, linesBroughtIntoBeing, linesWithNoBoundary } from "./bodySequenceWriting.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  boundary,
  declared,
  person,
  schema,
  stopEveryone,
  tokensOf,
  type Person,
} from "./bodySequenceTestSupport.js";
import {
  type Part,
  type StoredLine,
  HARD_BREAK,
  WIKILINK,
  CODE,
  RULE,
  PARAGRAPH,
  MATH,
  IN_ITEM,
  stored,
  noteOfLines,
  PADDING,
  FULL,
  kindOf,
  sampleOf,
  ORACLE_NOTES,
  type Agreement,
  AGREEMENT_IN_THE_DIFFERENTIAL,
  REFERENCE,
  writingOf,
  amongMoreLines,
  expectTheWindowToAgree,
  boundariesMadeIn,
  tiptapInsertContentAt,
  twoParagraphs,
  anotherAttribute,
  random,
  SEEDS,
} from "./bodySequenceEditorTestSupport.js";

afterEach(stopEveryone);

const agreement: Agreement = { compared: 0, trials: 0, inTheWindow: 0, onTheWholeNote: 0 };

type Differential = {
  compared: number;
  onlyOne: number;
  neither: number;
  givenDifferently: Record<string, number>;
  readDifferently: Record<string, number>;
  bothDifferently: Record<string, number>;
  keptDifferently: Record<string, number>;
  recordedDifferently: Record<string, number>;
};
type Tally = Differential & { notes: number; examples: string[] };
const tally = (): Tally => ({
  notes: 0,
  compared: 0,
  onlyOne: 0,
  neither: 0,
  givenDifferently: {},
  readDifferently: {},
  bothDifferently: {},
  keptDifferently: {},
  recordedDifferently: {},
  examples: [],
});
const sayTally = (name: string, { notes, examples, ...counts }: Tally) =>
  `the editor against the reference writer, ${name}: ${String(notes)} notes; compared ${String(counts.compared)}; read the same and gave boundaries to other lines ${JSON.stringify(counts.givenDifferently)}; gave the same and read differently ${JSON.stringify(counts.readDifferently)}; made another edit, so read and gave differently ${JSON.stringify(counts.bothDifferently)}; of all compared, kept other boundaries of the note ${JSON.stringify(counts.keptDifferently)}; of all compared, recorded other new boundaries ${JSON.stringify(counts.recordedDifferently)}; only one of the two took the edit ${String(counts.onlyOne)}, neither ${String(counts.neither)}\n${examples.join("\n")}`;

const BUCKETS = [
  "givenDifferently",
  "readDifferently",
  "bothDifferently",
  "keptDifferently",
  "recordedDifferently",
] as const;
const WHY_THEY_DIFFER: { why: string; edits: readonly string[] }[] = [
  {
    why: "To a code block, ProseMirror turns hard breaks into newlines and drops what code cannot hold. The reference writer leaves all of it in a paragraph after the code.",
    edits: ["a change of kind to codeBlock"],
  },
  {
    why: "In a list item, the reference writer's split of the item's first block starts a new item and gives the lines that move there. A block the editor puts in stays in the item, and ProseMirror keeps the paragraph the item needs where the reference writer turns its boundary into the new block's. A paste over whole blocks of an item can only be said as those lines retyped and typed into, which keeps their boundaries and gives one to a line that has none, where ProseMirror puts new blocks in their place.",
    edits: [
      "a block put first in its container",
      "a block put right under another",
      "a divider",
      "a divider over a selection",
      "a divider over a selection, as a delete and a block put in",
      "a divider over a selection across blocks",
      "two paragraphs pasted over a selection, the first whole",
      "two paragraphs pasted over a selection across blocks, the first whole",
    ],
  },
  {
    why: "A quote or a list whose only block is deleted stays in the editor, with an empty paragraph, and goes with its line for the reference writer.",
    edits: ["a delete of a whole block"],
  },
  {
    why: "A delete that runs from one block into another that holds what the first cannot leaves two blocks in ProseMirror, also under a typed letter or Enter. The reference writer joins what fits, and gives the second block no boundary where the editor, which keeps it a paragraph, gives it one first.",
    edits: [
      "a delete across blocks",
      "a letter typed over a selection across blocks",
      "Enter over a selection across blocks",
    ],
  },
  {
    why: "Enter over a selection that ends in a line with no boundary of its own deletes into that line and splits it off again. The editor writes the two steps as one range: the line is given its boundary first and keeps it, and the change records no new one. The reference writer's delete joins the line away and gives it none, and its split records a new boundary.",
    edits: ["Enter over a selection across blocks"],
  },
  {
    why: "A selection that takes a divider and ends right after it, with a divider put over it, leaves the document that divider where it stood. The editor writes what changed and keeps its boundary; the reference writer deletes it and writes the new divider a boundary, or makes the first line the divider. The editor gives no boundary to a line the selection takes away whole, where the reference writer gives it one and makes it the divider.",
    edits: ["a divider over a selection across blocks"],
  },
  {
    why: "Backspace in an empty line under a block that holds no text takes the line away in ProseMirror, and the block above for the reference writer.",
    edits: ["a join"],
  },
  {
    why: "From a line's start, ProseMirror takes the selection's whole blocks away and splits the block it ends in. The reference writer cannot take a note's first line away: its delete keeps that line, gives it a boundary when it has none, and joins the last line to it.",
    edits: ["Enter over a selection across blocks, from the note's start"],
  },
];
const withNoReason = (counts: Differential) =>
  BUCKETS.flatMap((bucket) => Object.keys(counts[bucket])).filter(
    (edit) => !WHY_THEY_DIFFER.some((each) => each.edits.includes(edit)),
  );

const EVERY_EDIT: Differential = {
  compared: 8062,
  onlyOne: 1888,
  neither: 398,
  givenDifferently: {
    "Enter over a selection across blocks": 98,
    "Enter over a selection across blocks, from the note's start": 18,
    "a divider over a selection across blocks": 2,
  },
  readDifferently: {
    "Enter over a selection across blocks, from the note's start": 29,
    "a change of kind to codeBlock": 23,
    "a block put first in its container": 2,
    "a divider": 2,
    "a divider over a selection": 2,
    "a divider over a selection, as a delete and a block put in": 2,
    "two paragraphs pasted over a selection, the first whole": 3,
    "a block put right under another": 1,
    "a delete of a whole block": 1,
  },
  bothDifferently: {
    "Enter over a selection across blocks, from the note's start": 16,
    "a delete across blocks": 9,
    "a letter typed over a selection across blocks": 9,
    "Enter over a selection across blocks": 6,
    "two paragraphs pasted over a selection, the first whole": 1,
    "a block put right under another": 1,
  },
  keptDifferently: {
    "Enter over a selection across blocks, from the note's start": 61,
    "two paragraphs pasted over a selection across blocks, the first whole": 44,
    "a divider over a selection across blocks": 18,
    "a divider over a selection": 2,
    "a divider over a selection, as a delete and a block put in": 2,
    "a delete of a whole block": 1,
  },
  recordedDifferently: {
    "Enter over a selection across blocks, from the note's start": 45,
    "two paragraphs pasted over a selection across blocks, the first whole": 44,
    "Enter over a selection across blocks": 104,
    "a change of kind to codeBlock": 23,
    "a delete across blocks": 9,
    "a letter typed over a selection across blocks": 9,
    "a divider over a selection across blocks": 12,
    "a divider over a selection": 2,
    "a divider over a selection, as a delete and a block put in": 2,
    "a block put right under another": 2,
  },
};
const EVERY_EDIT_AT_RANDOM: Differential = {
  compared: 1412,
  onlyOne: 431,
  neither: 76,
  givenDifferently: { "Enter over a selection across blocks": 10 },
  readDifferently: {
    "a change of kind to codeBlock": 14,
    "Enter over a selection across blocks, from the note's start": 4,
    "a delete of a whole block": 1,
    "a block put first in its container": 1,
    "a divider": 1,
    "two paragraphs pasted over a selection, the first whole": 2,
    "a divider over a selection": 1,
    "a divider over a selection, as a delete and a block put in": 1,
  },
  bothDifferently: {
    "a letter typed over a selection across blocks": 2,
    "a delete across blocks": 1,
  },
  keptDifferently: {
    "two paragraphs pasted over a selection across blocks, the first whole": 5,
    "Enter over a selection across blocks, from the note's start": 4,
    "a divider over a selection across blocks": 1,
    "a delete of a whole block": 1,
    "a divider over a selection": 1,
    "a divider over a selection, as a delete and a block put in": 1,
  },
  recordedDifferently: {
    "two paragraphs pasted over a selection across blocks, the first whole": 5,
    "a letter typed over a selection across blocks": 2,
    "a delete across blocks": 1,
    "a change of kind to codeBlock": 14,
    "Enter over a selection across blocks, from the note's start": 2,
    "Enter over a selection across blocks": 10,
    "a divider over a selection": 1,
    "a divider over a selection, as a delete and a block put in": 1,
  },
};

const EVERY_EIGHTH_EDIT: Differential = {
  compared: 1570,
  onlyOne: 395,
  neither: 108,
  givenDifferently: {
    "Enter over a selection across blocks, from the note's start": 6,
    "Enter over a selection across blocks": 14,
    "a divider over a selection across blocks": 1,
  },
  readDifferently: {
    "Enter over a selection across blocks, from the note's start": 11,
    "a change of kind to codeBlock": 4,
    "a block put first in its container": 2,
    "a block put right under another": 1,
    "a delete of a whole block": 1,
  },
  bothDifferently: {
    "a delete across blocks": 1,
    "a letter typed over a selection across blocks": 1,
    "Enter over a selection across blocks": 1,
    "Enter over a selection across blocks, from the note's start": 2,
    "a block put right under another": 1,
  },
  keptDifferently: {
    "Enter over a selection across blocks, from the note's start": 17,
    "two paragraphs pasted over a selection across blocks, the first whole": 5,
    "a divider over a selection across blocks": 3,
    "a delete of a whole block": 1,
  },
  recordedDifferently: {
    "Enter over a selection across blocks, from the note's start": 10,
    "two paragraphs pasted over a selection across blocks, the first whole": 5,
    "a delete across blocks": 1,
    "a letter typed over a selection across blocks": 1,
    "Enter over a selection across blocks": 15,
    "a change of kind to codeBlock": 4,
    "a divider over a selection across blocks": 1,
    "a block put right under another": 2,
  },
};
const EVERY_EIGHTH_EDIT_AT_RANDOM: Differential = {
  compared: 250,
  onlyOne: 73,
  neither: 24,
  givenDifferently: { "Enter over a selection across blocks": 1 },
  readDifferently: {
    "Enter over a selection across blocks, from the note's start": 1,
    "a change of kind to codeBlock": 1,
    "a delete of a whole block": 1,
  },
  bothDifferently: {},
  keptDifferently: {
    "two paragraphs pasted over a selection across blocks, the first whole": 3,
    "Enter over a selection across blocks, from the note's start": 1,
    "a delete of a whole block": 1,
  },
  recordedDifferently: {
    "two paragraphs pasted over a selection across blocks, the first whole": 3,
    "Enter over a selection across blocks": 1,
    "Enter over a selection across blocks, from the note's start": 1,
    "a change of kind to codeBlock": 1,
  },
};
const DIFFERENTIAL_COUNTS = FULL ? EVERY_EDIT : EVERY_EIGHTH_EDIT;
const DIFFERENTIAL_COUNTS_AT_RANDOM = FULL ? EVERY_EDIT_AT_RANDOM : EVERY_EIGHTH_EDIT_AT_RANDOM;

function placesOf(
  sequence: Y.Text,
  boundaries: readonly string[],
  was: readonly { id: string }[],
): number[] {
  const before = new Map(was.map((token, index) => [token.id, index]));
  const now = tokensOf(sequence);
  return now.flatMap((token, at) => {
    if (!boundaries.includes(token.id)) return [];
    const next = now.slice(at + 1).find((later) => before.has(later.id));
    return [next ? before.get(next.id)! : was.length];
  });
}

function boundariesKept(sequence: Y.Text, was: readonly { id: string }[]): string[] {
  const before = new Map(was.map((token, index) => [token.id, index]));
  return tokensOf(sequence).flatMap((token) => {
    const place = before.get(token.id);
    if (token.kind !== "boundary" || place === undefined) return [];
    const attrs = new Map(JSON.parse(token.attrs) as [string, unknown][]);
    return [`${String(place)} ${String(attrs.get("type") ?? "paragraph")}`];
  });
}

function boundariesRecorded(
  sequence: Y.Text,
  was: readonly { id: string }[],
  given: readonly string[],
): string[] {
  const before = new Map(was.map((token, index) => [token.id, index]));
  const now = tokensOf(sequence);
  return now.flatMap((token, at) => {
    if (token.kind !== "boundary" || before.has(token.id) || given.includes(token.id)) return [];
    const next = now.slice(at + 1).find((later) => before.has(later.id));
    const attrs = new Map(JSON.parse(token.attrs) as [string, unknown][]);
    return [
      `${String(next ? before.get(next.id) : was.length)} ${String(attrs.get("type") ?? "paragraph")}`,
    ];
  });
}

type Make = (plan: (doc: Y.Doc) => BodyChange | null) => boolean;
type Said = (make: Make) => unknown;

function compareWithReference(lines: readonly StoredLine[], counted: Tally, note: number): void {
  const sample = sampleOf(note);
  const baseline = noteOfLines(lines);
  const longer = amongMoreLines(lines);
  const start = declared(92);
  Y.applyUpdate(start.doc, baseline);
  const reading = createBodyReader(schema, start.sequence, start.containers).reading();
  const was = tokensOf(start.sequence);
  let fresh = 0;
  const freshId = () => `fresh${String(fresh++)}`;
  const placeOf = (block: number) =>
    reading.lines[block]?.element
      ? reading.bases[block]! + (reading.blocks[block]!.shown[0]?.index ?? 0)
      : 0;
  const inOrder = (places: readonly number[]) =>
    [...new Set(places)].toSorted((one, other) => one - other);

  const asSaid = (say: Said) => {
    const reference = declared(93);
    Y.applyUpdate(reference.doc, baseline);
    const given: number[] = [];
    const givenIds: string[] = [];
    reference.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== GIVEN_BOUNDARY) return;
      givenIds.push(...boundariesMadeIn(update));
      given.push(...placesOf(reference.sequence, boundariesMadeIn(update), was));
    });
    let made = 0;
    let took = true;
    say((plan) => {
      if (!took) return false;
      made += 1;
      let change: BodyChange | null = null;
      try {
        change = plan(reference.doc);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      if (change) writeBody(reference.doc, change, REFERENCE);
      else took = false;
      return took;
    });
    const said = {
      took: took && made > 0,
      given,
      read: readBodySequence(schema, reference.doc),
      kept: boundariesKept(reference.sequence, was).join(),
      recorded: boundariesRecorded(reference.sequence, was, givenIds).join(),
    };
    reference.doc.destroy();
    return said;
  };

  const compare = (...asked: Parameters<typeof compareIt>) =>
    sample.offer(kindOf(`${asked[0]} ${asked[1]}`), () => compareIt(...asked));
  const compareIt = (
    edit: string,
    label: string,
    byReference: Said | readonly Said[],
    byEditor: (a: Person) => void,
    startsInLineAbove = -1,
  ) => {
    const taken = [byReference]
      .flat()
      .map(asSaid)
      .filter((said) => said.took);
    const a = person(baseline, 10);
    const applied: Transaction[] = [];
    const dispatch = a.view.dispatch.bind(a.view);
    a.view.dispatch = (transaction) => {
      const changes = transaction.docChanged && !isBodySequenceChange(transaction);
      if (changes && a.view.state.applyTransaction(transaction).transactions.length > 0)
        applied.push(transaction);
      dispatch(transaction);
    };
    try {
      byEditor(a);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    const wrote = a.sent.length > 0;
    if (wrote && applied.length === 1)
      expectTheWindowToAgree(
        agreement,
        longer,
        applied,
        `${edit} ${label} in ${reading.doc.toString()}`,
      );
    const readTheSame = taken.filter((said) => a.view.state.doc.eq(said.read));
    const references = readTheSame.length > 0 ? readTheSame : taken;
    if (references.length === 0 || !wrote) {
      if (references.length === 0 && !wrote) counted.neither += 1;
      else counted.onlyOne += 1;
    } else {
      counted.compared += 1;
      const where = `${edit} ${label} in ${reading.doc.toString()}`;
      const lineAbove = startsInLineAbove >= 0 ? placeOf(startsInLineAbove) : -1;
      const butTheLineAbove = (index: number) =>
        index !== lineAbove || boundaryAt(reading, startsInLineAbove) >= 0;
      const afterTheGive = declared(94);
      Y.applyUpdate(afterTheGive.doc, baseline);
      if (a.sent.length > 1) Y.applyUpdate(afterTheGive.doc, a.sent[0]!);
      const givenHere = a.sent.length > 1 ? boundariesMadeIn(a.sent[0]!) : [];
      const byTheEditor = inOrder(placesOf(afterTheGive.sequence, givenHere, was)).filter(
        butTheLineAbove,
      );
      afterTheGive.doc.destroy();
      const givenBy = (said: (typeof references)[number]) =>
        JSON.stringify(inOrder(said.given).filter(butTheLineAbove));
      const kept = boundariesKept(a.sequence, was).join();
      const recorded = boundariesRecorded(a.sequence, was, givenHere).join();
      a.expectMirror();
      const count = (counts: Record<string, number>, why: string) => {
        counts[edit] = (counts[edit] ?? 0) + 1;
        if (counts[edit] <= 2) counted.examples.push(`${why}: ${where}`);
      };
      const gaveTheSame = references.filter(
        (said) => givenBy(said) === JSON.stringify(byTheEditor),
      );
      const orAll = (some: typeof references, all: typeof references) =>
        some.length > 0 ? some : all;
      const givers = orAll(gaveTheSame, references);
      const keptTheSame = givers.filter((said) => said.kept === kept);
      const keepers = orAll(keptTheSame, givers);
      const readsTheSame = readTheSame.length > 0;
      const gave = `the editor gave ${JSON.stringify(byTheEditor)}, the reference ${givenBy(references[0]!)}`;
      const reads = `the editor reads ${a.view.state.doc.toString()}, the reference ${references[0]!.read.toString()}`;
      if (gaveTheSame.length === 0 && !readsTheSame)
        count(counted.bothDifferently, `${gave}; ${reads}`);
      else if (gaveTheSame.length === 0) count(counted.givenDifferently, gave);
      else if (!readsTheSame) count(counted.readDifferently, reads);
      if (keptTheSame.length === 0)
        count(
          counted.keptDifferently,
          `the editor kept ${kept}, the reference ${givers[0]!.kept}, of ${boundariesKept(start.sequence, was).join()}`,
        );
      if (!keepers.some((said) => said.recorded === recorded))
        count(
          counted.recordedDifferently,
          `the editor recorded [${recorded}], the reference [${keepers[0]!.recorded}]`,
        );
    }
    stopEveryone();
  };

  const offsetsIn = (size: number) => [...new Set([0, Math.floor(size / 2), size])];
  const rule = () => schema.nodes.horizontalRule!.create();
  reading.blocks.forEach((block, at) => {
    const from = reading.starts[at]! + 1;
    const own = block.node;
    const size = own.isTextblock ? own.content.size : 0;
    const kinds = [
      { type: "heading", level: 1 },
      { type: "heading", level: 2 },
      { type: "heading", level: 3 },
      { type: "codeBlock" },
      { type: "paragraph" },
    ];
    for (const kind of kinds)
      compare(
        `a change of kind to ${kind.type}`,
        `${"level" in kind ? `{level ${String(kind.level)}}` : ""} of block ${String(at)}`,
        (make) => make((doc) => setLineKind(schema, doc, at, kind)),
        (a) => {
          a.select([at, 0]);
          a.retype(kind.type, "level" in kind ? { level: kind.level } : undefined);
        },
      );
    const attribute = anotherAttribute(own);
    if (attribute)
      compare(
        "an attribute of the block's own kind",
        `of block ${String(at)}`,
        (make) =>
          make((doc) => setLineKind(schema, doc, at, { type: own.type.name, ...attribute })),
        (a) =>
          a.view.dispatch(
            a.view.state.tr.setNodeMarkup(reading.starts[at]!, undefined, {
              ...own.attrs,
              ...attribute,
            }),
          ),
      );
    const above = reading.blocks[at - 1]?.node;
    if (above?.isTextblock)
      compare(
        "a delete of a whole block",
        `of block ${String(at)}`,
        (make) =>
          make((doc) => deleteRange(schema, doc, at - 1, above.content.size, at, size, freshId)),
        (a) =>
          a.view.dispatch(
            a.view.state.tr.delete(reading.starts[at]!, reading.starts[at]! + own.nodeSize),
          ),
        at - 1,
      );
    const isUnderAbove =
      above !== undefined &&
      reading.starts[at - 1]! + above.nodeSize === reading.starts[at] &&
      !isAddedParagraph(reading, at - 1);
    compare(
      isUnderAbove ? "a block put right under another" : "a block put first in its container",
      `above block ${String(at)}`,
      (make) =>
        isUnderAbove
          ? make((doc) => splitLine(schema, doc, at - 1, above.content.size, freshId, RULE))
          : size > 0 && make((doc) => splitLine(schema, doc, at, 0, freshId, RULE)),
      (a) => a.view.dispatch(a.view.state.tr.insert(reading.starts[at]!, rule())),
    );
    if (!own.isTextblock) return;
    const isCode = own.type.spec.code === true;
    const underNewLine = (make: Make, line: number, offset: number) =>
      make((doc) => splitLine(schema, doc, line, offset, freshId, PARAGRAPH));
    const sizeOf = (index: number) => {
      const node = reading.blocks[index]!.node;
      return node.isTextblock ? node.content.size : 0;
    };
    const asParagraph = (make: Make, line: number, node: ProseMirrorNode) =>
      node.type.name === "paragraph" || make((doc) => setLineKind(schema, doc, line, PARAGRAPH));
    const letter = (make: Make, line: number, offset: number, text: string) =>
      make((doc) => typeLetters(schema, doc, line, offset, text, {}));
    const divide = (make: Make, offset: number, length: number) => {
      if (length === 0 && !isCode) return make((doc) => setLineKind(schema, doc, at, RULE));
      if (offset === 0 || offset === length)
        return make((doc) => splitLine(schema, doc, at, offset, freshId, RULE));
      return (
        make((doc) => splitLine(schema, doc, at, offset, freshId)) &&
        make((doc) => splitLine(schema, doc, at + 1, 0, freshId, RULE))
      );
    };
    for (let toAt = at + 1; toAt <= at + 2 && toAt < reading.blocks.length; toAt++) {
      const last = reading.blocks[toAt]!.node;
      if (!last.isTextblock) continue;
      for (const offset of offsetsIn(size))
        for (const toOffset of offsetsIn(last.content.size)) {
          const across = `from ${String(offset)} of block ${String(at)} to ${String(toOffset)} of block ${String(toAt)}`;
          const to = reading.starts[toAt]! + 1 + toOffset;
          const cutAcross = (make: Make) =>
            make((doc) => deleteRange(schema, doc, at, offset, toAt, toOffset, freshId));
          const cutUpToTheLast = (make: Make) =>
            (toAt - 1 === at && offset === size) ||
            make((doc) =>
              deleteRange(schema, doc, at, offset, toAt - 1, sizeOf(toAt - 1), freshId),
            );
          const cutTheLastsStart = (make: Make, line = at + 1) =>
            toOffset === 0 ||
            make((doc) => deleteRange(schema, doc, line, 0, line, toOffset, freshId));
          const cutTheWholeBlocks = (make: Make) =>
            offset === 0 &&
            at > 0 &&
            make((doc) =>
              deleteRange(schema, doc, at - 1, sizeOf(at - 1), toAt - 1, sizeOf(toAt - 1), freshId),
            );
          const divideTheFirst = (make: Make) =>
            make((doc) =>
              offset === 0 && size > 0
                ? setLineKind(schema, doc, at, RULE)
                : splitLine(schema, doc, at, offset, freshId, RULE),
            );
          compare(
            "a delete across blocks",
            across,
            [cutAcross, (make) => toOffset === 0 && toAt - 1 > at && cutUpToTheLast(make)],
            (a) => a.view.dispatch(a.view.state.tr.delete(from + offset, to)),
          );
          compare(
            "a letter typed over a selection across blocks",
            across,
            (make) => cutAcross(make) && letter(make, at, offset, "Z"),
            (a) => a.view.dispatch(a.view.state.tr.insertText("Z", from + offset, to)),
          );
          compare(
            "a divider over a selection across blocks",
            across,
            [
              (make) => cutUpToTheLast(make) && cutTheLastsStart(make) && divideTheFirst(make),
              (make) => cutAcross(make) && divideTheFirst(make),
            ],
            (a) =>
              a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, from + offset, to, rule())),
          );
          const asEnterSplits =
            toOffset === last.content.size || offset === 0 ? PARAGRAPH : undefined;
          compare(
            offset > 0
              ? "Enter over a selection across blocks"
              : at > 0
                ? "Enter over a selection across blocks, from a line's start"
                : "Enter over a selection across blocks, from the note's start",
            across,
            [
              (make) =>
                cutAcross(make) &&
                make((doc) => splitLine(schema, doc, at, offset, freshId, asEnterSplits)),
              (make) =>
                cutAcross(make) && make((doc) => splitLine(schema, doc, at + 1, 0, freshId)),
              (make) =>
                cutAcross(make) &&
                make((doc) => splitLine(schema, doc, at + 1, 0, freshId, PARAGRAPH)),
              (make) =>
                cutTheWholeBlocks(make) &&
                cutTheLastsStart(make, at) &&
                make((doc) => splitLine(schema, doc, at, 0, freshId)),
              (make) =>
                cutTheWholeBlocks(make) &&
                cutTheLastsStart(make, at) &&
                make((doc) => splitLine(schema, doc, at, 0, freshId, PARAGRAPH)),
              (make) =>
                toOffset === 0 &&
                toAt - 1 > at &&
                cutUpToTheLast(make) &&
                make((doc) => splitLine(schema, doc, at + 1, 0, freshId)),
              (make) =>
                toOffset === 0 &&
                toAt - 1 > at &&
                cutUpToTheLast(make) &&
                make((doc) => splitLine(schema, doc, at + 1, 0, freshId, PARAGRAPH)),
            ],
            (a) => {
              a.select([at, offset], [toAt, toOffset]);
              a.press("Enter");
            },
            offset === 0 ? at - 1 : -1,
          );
          compare(
            "two paragraphs pasted over a selection across blocks",
            across,
            (make) =>
              cutUpToTheLast(make) &&
              letter(make, at, offset, "X") &&
              cutTheLastsStart(make) &&
              asParagraph(make, at + 1, last) &&
              letter(make, at + 1, 0, "Y"),
            (a) =>
              a.view.dispatch(a.view.state.tr.replaceRange(from + offset, to, twoParagraphs())),
          );
          if (offset === 0)
            compare(
              "two paragraphs pasted over a selection across blocks, the first whole",
              across,
              [
                (make) =>
                  cutUpToTheLast(make) &&
                  asParagraph(make, at, own) &&
                  letter(make, at, 0, "X") &&
                  cutTheLastsStart(make) &&
                  asParagraph(make, at + 1, last) &&
                  letter(make, at + 1, 0, "Y"),
                (make) =>
                  cutAcross(make) &&
                  asParagraph(make, at, own) &&
                  letter(make, at, 0, "X") &&
                  underNewLine(make, at, 1) &&
                  letter(make, at + 1, 0, "Y"),
                (make) =>
                  cutUpToTheLast(make) &&
                  underNewLine(make, at, 0) &&
                  letter(make, at + 1, 0, "X") &&
                  cutTheLastsStart(make, at + 2) &&
                  asParagraph(make, at + 2, last) &&
                  letter(make, at + 2, 0, "Y"),
                (make) =>
                  cutAcross(make) &&
                  underNewLine(make, at, 0) &&
                  letter(make, at + 1, 0, "X") &&
                  underNewLine(make, at + 1, 1) &&
                  letter(make, at + 2, 0, "Y"),
                (make) =>
                  toAt > at + 1 &&
                  (size === 0 ||
                    make((doc) => deleteRange(schema, doc, at, 0, at, size, freshId))) &&
                  asParagraph(make, at, own) &&
                  letter(make, at, 0, "X") &&
                  make((doc) => deleteRange(schema, doc, at + 1, 0, toAt, toOffset, freshId)) &&
                  asParagraph(make, at + 1, reading.blocks[at + 1]!.node) &&
                  letter(make, at + 1, 0, "Y"),
              ],
              (a) => a.view.dispatch(a.view.state.tr.replaceRange(from, to, twoParagraphs(0))),
            );
        }
    }
    if (size > 0)
      compare(
        "a mark",
        `over block ${String(at)}`,
        (make) => make((doc) => setMarks(schema, doc, at, 0, size, { bold: {} })),
        (a) => {
          a.select([at, 0], [at, size]);
          a.toggle("bold");
        },
      );
    for (const offset of offsetsIn(size)) {
      const pos = from + offset;
      compare(
        "a letter",
        `at ${String(offset)} of block ${String(at)}`,
        (make) => make((doc) => typeLetters(schema, doc, at, offset, "x", {})),
        (a) => a.view.dispatch(a.view.state.tr.insertText("x", pos)),
      );
      compare(
        "an inline item",
        `at ${String(offset)} of block ${String(at)}`,
        (make) =>
          make((doc) =>
            insertInline(schema, doc, at, offset, "wikilink", { target: "Other", label: null }),
          ),
        (a) =>
          a.view.dispatch(
            a.view.state.tr.insert(pos, schema.nodes.wikilink!.create({ target: "Other" })),
          ),
      );
      compare(
        "a split",
        `at ${String(offset)} of block ${String(at)}`,
        (make) => make((doc) => splitLine(schema, doc, at, offset, freshId)),
        (a) => a.view.dispatch(a.view.state.tr.split(pos)),
      );
      compare(
        "a divider",
        `at ${String(offset)} of block ${String(at)}`,
        (make) => divide(make, offset, size),
        (a) => a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, pos, pos, rule())),
      );
      if (offset < size)
        compare(
          "a delete",
          `from ${String(offset)} to the end of block ${String(at)}`,
          (make) => make((doc) => deleteRange(schema, doc, at, offset, at, size, freshId)),
          (a) => a.view.dispatch(a.view.state.tr.delete(pos, from + size)),
        );
    }
    const selections = [
      [0, size],
      [0, Math.ceil(size / 2)],
      [Math.floor(size / 2), size],
    ].filter(([one, other], index, all) => {
      const sameAsEarlier = all.findIndex(([a, b]) => a === one && b === other) < index;
      return one! < other! && !sameAsEarlier;
    }) as [number, number][];
    for (const [one, other] of selections) {
      const over = `over ${String(one)} to ${String(other)} of block ${String(at)}`;
      const left = size - (other - one);
      const cut = (make: Make) =>
        make((doc) => deleteRange(schema, doc, at, one, at, other, freshId));
      compare(
        "a split over a selection, as a delete and a split",
        over,
        (make) => cut(make) && make((doc) => splitLine(schema, doc, at, one, freshId)),
        (a) => a.view.dispatch(a.view.state.tr.delete(from + one, from + other).split(from + one)),
      );
      const asEnterSplits = other === size || one === 0 ? PARAGRAPH : undefined;
      compare(
        "Enter over a selection",
        over,
        (make) =>
          cut(make) &&
          make((doc) =>
            isCode
              ? typeLetters(schema, doc, at, one, "\n", {})
              : splitLine(schema, doc, at, one, freshId, asEnterSplits),
          ),
        (a) => {
          a.select([at, one], [at, other]);
          a.press("Enter");
        },
      );
      compare(
        "a divider over a selection",
        over,
        (make) =>
          cut(make) &&
          (left === 0
            ? make((doc) => setLineKind(schema, doc, at, RULE))
            : divide(make, one, left)),
        (a) =>
          a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, from + one, from + other, rule())),
      );
      compare(
        "a divider over a selection, as a delete and a block put in",
        over,
        (make) => cut(make) && divide(make, one, left),
        (a) =>
          a.view.dispatch(
            tiptapInsertContentAt(
              a.view.state.tr.delete(from + one, from + other),
              from + one,
              from + one,
              rule(),
            ),
          ),
      );
      if (one === 0)
        compare(
          "two paragraphs pasted over a selection, the first whole",
          over,
          other === size
            ? [
                (make) =>
                  cut(make) &&
                  asParagraph(make, at, own) &&
                  letter(make, at, 0, "X") &&
                  underNewLine(make, at, 1) &&
                  letter(make, at + 1, 0, "Y"),
                (make) =>
                  cut(make) &&
                  underNewLine(make, at, 0) &&
                  letter(make, at + 1, 0, "X") &&
                  underNewLine(make, at + 1, 1) &&
                  letter(make, at + 2, 0, "Y"),
              ]
            : [
                (make) =>
                  cut(make) &&
                  asParagraph(make, at, own) &&
                  letter(make, at, 0, "Y") &&
                  underNewLine(make, at, 0) &&
                  letter(make, at, 0, "X"),
                (make) =>
                  underNewLine(make, at, other) &&
                  cut(make) &&
                  letter(make, at + 1, 0, "Y") &&
                  underNewLine(make, at, 0) &&
                  letter(make, at + 1, 0, "X"),
              ],
          (a) =>
            a.view.dispatch(a.view.state.tr.replaceRange(from, from + other, twoParagraphs(0))),
        );
      compare(
        "two paragraphs pasted over a selection",
        over,
        (make) =>
          cut(make) &&
          make((doc) => typeLetters(schema, doc, at, one, "X", {})) &&
          make((doc) => splitLine(schema, doc, at, one + 1, freshId, PARAGRAPH)) &&
          make((doc) => typeLetters(schema, doc, at + 1, 0, "Y", {})),
        (a) =>
          a.view.dispatch(a.view.state.tr.replaceRange(from + one, from + other, twoParagraphs())),
      );
    }
    if (at > 0)
      compare(
        "a join",
        `of block ${String(at)} into the one above`,
        (make) => make((doc) => joinLine(schema, doc, at, freshId)),
        (a) => {
          a.select([at, 0]);
          a.press("Backspace");
        },
      );
  });
  sample.finish();
  start.doc.destroy();
  counted.notes += 1;
}

function noteAtRandom(next: () => number): StoredLine[] {
  const pick = <Option>(options: readonly Option[]) =>
    options[Math.floor(next() * options.length)]!;
  const count = 2 + Math.floor(next() * 3);
  const itemFrom = pick([-9, 0, 1, 2]);
  const itemTo = itemFrom + 1 + Math.floor(next() * 2);
  return Array.from({ length: count }, (_, line) => {
    const kind = pick<Record<string, unknown>>([
      {},
      {},
      { type: "heading", level: 1 },
      { type: "heading", level: 2 },
      { type: "heading", level: 3 },
      CODE,
      RULE,
      MATH,
    ]);
    const parts = Array.from({ length: Math.floor(next() * 4) }, () =>
      pick<Part>(["ab", "c", HARD_BREAK, WIKILINK]),
    );
    if (line === 0 && next() < 0.3) return stored(null, ...parts);
    return stored(line >= itemFrom && line < itemTo ? { ...kind, ...IN_ITEM } : kind, ...parts);
  });
}

const inDeclaredOrder = { shuffle: false };
const sameEdit = "the editor and the reference writer, for the same edit of the same note";
describe(sameEdit, inDeclaredOrder, () => {
  const inOracleNotes = tally();
  const atRandom = tally();
  const edits = FULL
    ? "every edit"
    : "every eighth edit of each kind, and one of each kind at least (BODY_SEQUENCE_EDITOR_FULL=1 compares every edit)";
  it.each(ORACLE_NOTES)(`give boundaries to the same lines for ${edits} in %s`, (_name, lines) => {
    const note = ORACLE_NOTES.findIndex(([, each]) => each === lines);
    compareWithReference(lines, inOracleNotes, note);
  });

  it("compares as many edits as counted", () => {
    console.log(sayTally("in the oracle's notes", inOracleNotes));
    const { notes, examples: _examples, ...counts } = inOracleNotes;
    expect(withNoReason(counts)).toEqual([]);
    expect(notes).toBe(ORACLE_NOTES.length);
    expect(counts).toEqual(DIFFERENTIAL_COUNTS);
  });

  it("give boundaries to the same lines in notes made at random", () => {
    const next = random(1);
    for (let note = 1; note <= Math.ceil(SEEDS / 4); note++)
      compareWithReference(noteAtRandom(next), atRandom, note);
    console.log(sayTally("in notes made at random", atRandom));
    const { notes: _notes, examples: _examples, ...counts } = atRandom;
    expect(withNoReason(counts)).toEqual([]);
    expect(
      Object.keys(counts.givenDifferently).filter((edit) => !(edit in EVERY_EDIT.givenDifferently)),
    ).toEqual([]);
    if (SEEDS === 40) expect(counts).toEqual(DIFFERENTIAL_COUNTS_AT_RANDOM);
  });

  it("give the same lines from a trial on the blocks around each edit as from one on the whole note", () => {
    console.log(
      `a trial on the blocks around the edit against one on the whole note, for each edit above, in the note with three paragraphs more on each side: compared ${String(agreement.compared)}, of which a trial ran ${String(agreement.trials)}: settled on the blocks around the edit ${String(agreement.inTheWindow)}, went on to the whole note ${String(agreement.onTheWholeNote)}; both gave the same lines every time`,
    );
    expect(inOracleNotes.notes).toBe(ORACLE_NOTES.length);
    expect(atRandom.notes).toBe(Math.ceil(SEEDS / 4));
    if (SEEDS === 40)
      expect(agreement).toEqual(AGREEMENT_IN_THE_DIFFERENTIAL[FULL ? "full" : "sample"]);
  });

  it("refuse a dispatch the note cannot be written to read as, on the blocks around it and on the whole note, and write nothing, as the editor does when that dispatch is sent to it", () => {
    const a = person(noteOfLines([stored(CODE, "ab", WIKILINK, "cd"), stored({}, "ef")]), 10);
    const { doc, tr } = a.view.state;
    expect(doc.toString()).toBe('doc(codeBlock("ab"), paragraph(wikilink, "cd"), paragraph("ef"))');
    const quoted = tr.wrap(doc.resolve(doc.content.size - 1).blockRange()!, [
      { type: schema.nodes.blockquote! },
    ]);
    expect(quoted.doc.toString()).toBe(
      'doc(codeBlock("ab"), paragraph(wikilink, "cd"), blockquote(paragraph("ef")))',
    );
    const held = Y.encodeStateAsUpdate(a.doc);
    const asked = vi.spyOn(Y.Doc.prototype, "getMap");
    expect(howToWrite(writingOf(a), [quoted])).toBeNull();
    const copies = asked.mock.contexts.map((from) => from !== a.doc);
    asked.mockRestore();
    expect(copies).toEqual([false, true]);
    expect(howToWrite(writingOf(a), [quoted], "note")).toBeNull();
    a.view.dispatch(quoted);
    expect(a.view.state.doc).toBe(doc);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(held);
    expect(a.sent).toEqual([]);
  });

  it("say which lines with no boundary a change brought into being, by what they hold and not by where they stand", () => {
    const made = declared(98);
    Y.applyUpdate(made.doc, noteOfLines([stored({}, "ab"), stored({}, "c", WIKILINK, "d")]));
    const writing = writingOf(made);
    const before = linesWithNoBoundary(writing);
    expect(before).toEqual([]);
    made.sequence.delete(3, 1);
    writing.reader.reading().lines[0]!.element!.setAttribute("type", "codeBlock");
    expect(readBodySequence(schema, made.doc).toString()).toBe(
      'doc(codeBlock("abc"), paragraph(wikilink, "d"))',
    );
    const now = linesWithNoBoundary(writingOf(made));
    expect(linesBroughtIntoBeing(before, now).map((line) => line.bare)).toEqual(["spill"]);
    made.sequence.insertEmbed(4, boundary(RULE), {});
    expect(readBodySequence(schema, made.doc).toString()).toBe(
      'doc(codeBlock("abc"), horizontalRule, paragraph(wikilink, "d"))',
    );
    const later = linesWithNoBoundary(writingOf(made));
    expect(later.map((line) => [line.block, line.bare])).toEqual([[2, "spill"]]);
    expect(linesBroughtIntoBeing(now, later)).toEqual([]);
    made.doc.destroy();

    const item = declared(99);
    Y.applyUpdate(
      item.doc,
      noteOfLines([stored(IN_ITEM, "x"), stored({ type: "heading", level: 1, ...IN_ITEM }, "T")]),
    );
    const inItem = writingOf(item);
    const stored1 = linesWithNoBoundary(inItem);
    expect(stored1).toEqual([]);
    item.sequence.delete(0, 2);
    const added = linesWithNoBoundary(writingOf(item));
    expect(readBodySequence(schema, item.doc).toString()).toBe(
      'doc(bulletList(listItem(paragraph, heading("T"))))',
    );
    expect(linesBroughtIntoBeing(stored1, added).map((line) => line.bare)).toEqual(["item"]);
    item.sequence.insertEmbed(0, boundary({ ...CODE, ...IN_ITEM }), {});
    expect(readBodySequence(schema, item.doc).toString()).toBe(
      'doc(bulletList(listItem(paragraph, codeBlock, heading("T"))))',
    );
    expect(linesBroughtIntoBeing(added, linesWithNoBoundary(writingOf(item)))).toEqual([]);
    item.doc.destroy();
  });

  const expectTheBlocksAroundToDo = (
    baseline: Uint8Array,
    act: (a: Person) => void,
    name: string,
  ) => {
    const a = person(baseline, 10);
    const applied: Transaction[] = [];
    const dispatch = a.view.dispatch.bind(a.view);
    a.view.dispatch = (transaction) => {
      if (transaction.docChanged && !isBodySequenceChange(transaction)) applied.push(transaction);
      dispatch(transaction);
    };
    act(a);
    expect(applied).toHaveLength(1);
    const counted: Agreement = { compared: 0, trials: 0, inTheWindow: 0, onTheWholeNote: 0 };
    expectTheWindowToAgree(counted, { baseline, shift: 0 }, applied, name);
    expect(counted).toEqual({ compared: 1, trials: 1, inTheWindow: 1, onTheWholeNote: 0 });
    a.expectMirror();
  };

  it("give the lines from the blocks around the edit, and copy no whole note, when the last of those blocks is a code block that ends in a line feed", () => {
    const baseline = noteOfLines([
      ...PADDING,
      stored(CODE, "ab", WIKILINK, "cd"),
      stored({}, "ef"),
      stored(CODE, "gh\n"),
      ...PADDING,
    ]);
    expect(readBodySequence(schema, person(baseline, 30).doc).toString()).toContain(
      'codeBlock("ab"), paragraph(wikilink, "cd"), paragraph("ef"), codeBlock("gh\\n"), paragraph("pad")',
    );
    const joinIntoTheLineWithNoBoundary = (a: Person) => {
      a.select([5, 0]);
      a.press("Backspace");
    };
    expectTheBlocksAroundToDo(baseline, joinIntoTheLineWithNoBoundary, "a join above that block");
  });

  it.each([
    [
      "the paragraph under it joined into it",
      (a: Person) => {
        a.select([5, 0]);
        a.press("Backspace");
      },
    ],
    [
      "a selection from the code into it deleted",
      (a: Person) => {
        a.select([3, 1], [4, 1]);
        a.press("Backspace");
      },
    ],
    [
      "the two paragraphs under it joined",
      (a: Person) => {
        a.select([6, 0]);
        a.press("Backspace");
      },
    ],
  ] as const)(
    "give the same lines from the blocks around the edit as from the whole note, with %s, when formatting runs across those blocks and letters there were deleted",
    (name, act) => {
      const lines = [
        ...PADDING,
        stored(CODE, "ab", WIKILINK, "cd"),
        stored({}, "ef"),
        stored({}, "gh"),
        ...PADDING,
      ];
      const writer = person(noteOfLines(lines), 30);
      writer.sequence.format(0, writer.sequence.length, { bold: {} });
      for (const block of [3, 5, 6]) {
        writer.typeAt(block, 1, "xyz");
        const typed = writer.view.state.selection.from;
        writer.view.dispatch(writer.view.state.tr.delete(typed - 3, typed));
      }
      const baseline = Y.encodeStateAsUpdate(writer.doc);
      expect(writer.view.state.doc.toString()).toContain(
        'codeBlock("ab"), paragraph(wikilink, bold("cd")), paragraph(bold("ef"))',
      );
      expectTheBlocksAroundToDo(baseline, act, name);
    },
  );
});
