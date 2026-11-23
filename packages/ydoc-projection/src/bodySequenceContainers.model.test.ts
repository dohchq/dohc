import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  leavesOfSequence,
  type SequenceAttrs,
} from "./bodySequenceGrammar.js";
import {
  bodyHistory,
  deleteRange,
  indentItem,
  insertInline,
  joinLine,
  liftBlocks,
  outdentItem,
  readBody,
  setContainerAttributes,
  setContainerKind,
  setInlineAttributes,
  setLineKind,
  setMarks,
  splitLine,
  typeLetters,
  wrapBlocks,
  writeBody,
  type BodyWrites,
} from "./bodySequenceWriter.js";
import { piecesOfSequence, readBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

const schema = getDohcProseMirrorSchema();
const SEQUENCE = BODY_SEQUENCE_FIELD;
const CONTAINERS = BODY_CONTAINERS_FIELD;
const REMOTE = Symbol("remote");
const LOCAL = Symbol("local");
const OUTSIDE_HISTORY = Symbol("outside the history");
const NEVER_ELAPSES = Number.MAX_SAFE_INTEGER;
const OBJECT = String.fromCharCode(0xfffc);
const HIGH_HALF = /[\uD800-\uDBFF]/;
const LOW_HALF = /[\uDC00-\uDFFF]/;

const PARAGRAPH: SequenceAttrs = { type: "paragraph" };
const LEAF_KINDS: Record<string, SequenceAttrs> = {
  paragraph: {},
  heading: { level: 1 },
  codeBlock: { language: null },
  horizontalRule: {},
  mathBlock: { tex: "" },
  rawBlock: { source: "" },
};
const HOLDS_LETTERS = ["paragraph", "heading", "codeBlock"];
const HOLDS_INLINE = ["paragraph", "heading"];
const BOX = { calloutType: "note", title: "", fold: "" };
const LIST = { loose: null, start: 1, type: null };
const ITEM = { checked: false };
const RECORDS: Record<string, SequenceAttrs> = {
  blockquote: BOX,
  callout: BOX,
  bulletList: LIST,
  orderedList: LIST,
  taskList: LIST,
  listItem: ITEM,
  taskItem: ITEM,
};
const DEFAULTS: SequenceAttrs = { ...BOX, ...LIST, ...ITEM };
const LISTS = ["bulletList", "orderedList", "taskList"];
const ITEMS = ["listItem", "taskItem"];
const ITEM_OF: Record<string, string | undefined> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
};
const HOLDS_BLOCKS = ["blockquote", "callout", "listItem", "taskItem", "tableCell", "tableHeader"];
const INLINE: Record<string, SequenceAttrs> = {
  image: { src: "", alt: "", title: null },
  mathInline: { tex: "" },
};
const MARKS = new Set(["link", "highlight", "bold", "code", "italic", "strike", "underline"]);

const FAULT = {
  defaultMapUndo: "Yjs's default undo of map changes",
  noDeleteFilter: "no delete filter",
  recordsOnlyFilter: "a delete filter that keeps container records and not a boundary's attributes",
  inlineAttributesKept: "a delete filter that also keeps an inline item's attributes",
  typeRecordOnly: "a container made with its type record and no defaults",
  defaultFirst: "a missing record's default written first, outside the history",
  noLooseRecord: "a list made without its `loose` record",
  oldBoundaryAbove: "a split at offset 0 that leaves the old boundary with the empty line",
  splitAlwaysParagraph: "a split whose new line is always a paragraph",
  oneRecordForTwins: "a setting written to an id that is on two containers",
  noKindDefaults: "a line's kind written without the attributes that hold their default",
  splitInsideLetter: "a split between the two units of a surrogate pair",
  alwaysLowerBoundary: "a join that always deletes the lower line's boundary",
  twinsJoined: "a join that lets two containers with one id stand together",
  wrongSetting: "a start number written one higher than asked",
  deleteAndRecreate: "a record deleted and written again in one transaction",
  copyKnownAttributes: "a fresh id's copy that takes only the records its kind has",
  typingInheritsMarks: "typing that takes the marks around it and not the marks it is given",
  spillLeftBare: "a change of kind that gives the paragraph after the block no boundary",
  addedParagraphBare: "typing in a list item's added first paragraph without giving it a boundary",
} as const;
type Fault = (typeof FAULT)[keyof typeof FAULT];
const LENIENT: (Fault | undefined)[] = [FAULT.typeRecordOnly, FAULT.defaultFirst];

type Id = string;
const idOf = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;
const json = (value: unknown) =>
  JSON.stringify(value, (_key, held: unknown) => (typeof held === "bigint" ? Number(held) : held));
const isPlain = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const marksOf = (marks: Iterable<[string, unknown]>) =>
  json([...marks].filter(([, value]) => isPlain(value)).sort(([a], [b]) => (a < b ? -1 : 1)));
const cutsALetter = (units: string, offset: number) =>
  HIGH_HALF.test(units.charAt(offset - 1)) && LOW_HALF.test(units.charAt(offset));

type Held = { item: Id; value: string };
type Atom = { name: string; attrs: Map<string, Held> };
type Letter = { kind: "char"; id: Id; line: Id | null; unit: string; marks: string; atom?: Atom };
type Token = Letter | { kind: "boundary"; id: Id; attrs: Map<string, Held> };
type Shot = { tokens: Token[]; records: Map<string, Held>; formats: string };
type Row = { boundary: Id | null; attrs: Map<string, Held>; chars: Id[]; units: string };
type Frame = { id: string; type: string; key: number };
type Line = {
  row: number;
  from: number;
  chars: Id[];
  units: string;
  boundary: Id | null;
  bare: "" | "start" | "item" | "spill";
  type: string;
  path: Frame[];
};
type Look = { shot: Shot; rows: Row[]; lines: Line[]; frames: Frame[][] };

const heldBy = new WeakMap<Y.Item, { length: number; held: Held }>();

function heldIn(map: Map<string, Y.Item>): Map<string, Held> {
  const all = new Map<string, Held>();
  for (const [key, item] of map) {
    if (item.deleted) continue;
    let known = heldBy.get(item);
    if (known?.length !== item.length) {
      const held = {
        item: idOf(item.id.client, item.id.clock + item.length - 1),
        value: json(item.content.getContent()[item.length - 1]),
      };
      known = { length: item.length, held };
      heldBy.set(item, known);
    }
    all.set(key, known.held);
  }
  return all;
}

function shoot(doc: Y.Doc): Shot {
  const tokens: Token[] = [];
  const formats = new Map<string, unknown>();
  let marks = "[]";
  let formatting = "";
  let line: Id | null = null;
  for (let item = doc.getText(SEQUENCE)._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    const id = idOf(item.id.client, item.id.clock);
    if (content instanceof Y.ContentFormat) {
      formatting += `${id} `;
      if (MARKS.has(content.key)) marks = marksOf(formats.set(content.key, content.value));
    } else if (content instanceof Y.ContentString)
      for (let at = 0; at < content.str.length; at++)
        tokens.push({
          kind: "char",
          id: idOf(item.id.client, item.id.clock + at),
          line,
          unit: content.str[at]!,
          marks,
        });
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const attrs = heldIn(content.type._map);
      const name = content.type.nodeName;
      if (name !== BLOCK_ELEMENT)
        tokens.push({ kind: "char", id, line, unit: OBJECT, marks: "", atom: { name, attrs } });
      else tokens.push({ kind: "boundary", id: (line = id), attrs });
    }
  }
  return { tokens, records: heldIn(doc.getMap(CONTAINERS)._map), formats: formatting };
}

function rowsOf(shot: Shot): Row[] {
  const rows: Row[] = [];
  const unbounded = (): Row => ({ boundary: null, attrs: new Map(), chars: [], units: "" });
  for (const token of shot.tokens)
    if (token.kind === "boundary")
      rows.push({ boundary: token.id, attrs: token.attrs, chars: [], units: "" });
    else {
      if (rows.length === 0) rows.push(unbounded());
      rows.at(-1)!.chars.push(token.id);
      rows.at(-1)!.units += token.unit;
    }
  return rows.length > 0 ? rows : [unbounded()];
}

function lookAt(doc: Y.Doc): Look {
  const shot = shoot(doc);
  const rows = rowsOf(shot);
  const leaves = leavesOfSequence(
    schema,
    piecesOfSequence(doc.getText(SEQUENCE), MARKS),
    doc.getMap(CONTAINERS),
  );
  const unread = rows.length - leaves.length;
  const lines: Line[] = [];
  const frames: Frame[][] = [];
  let keys = 0;
  let above: Frame[] = [];
  rows.forEach((row, at) => {
    const leaf = leaves[at - unread];
    const type = leaf && Object.hasOwn(LEAF_KINDS, leaf.type) ? leaf.type : "paragraph";
    const fitted = (leaf?.path ?? []).map((frame) => ({ id: frame.id, type: frame.type }));
    while (fitted.length > 0 && !HOLDS_BLOCKS.includes(fitted.at(-1)!.type)) fitted.pop();
    let shared = true;
    const path = fitted.map((frame, depth): Frame => {
      shared &&= above[depth]?.id === frame.id;
      return { ...frame, key: shared ? above[depth]!.key : keys++ };
    });
    path.forEach((frame, depth) => {
      const itsFirstIsThis = depth === path.length - 1 && type === "paragraph";
      if (frame.key === above[depth]?.key || !ITEMS.includes(frame.type) || itsFirstIsThis) return;
      lines.push({
        row: at,
        from: 0,
        chars: [],
        units: "",
        boundary: null,
        bare: "item",
        type: "paragraph",
        path: path.slice(0, depth + 1),
      });
    });
    const item = row.units.indexOf(OBJECT);
    const all = row.chars.length;
    const held = HOLDS_INLINE.includes(type)
      ? all
      : type !== "codeBlock"
        ? 0
        : item < 0
          ? all
          : item;
    lines.push({
      row: at,
      from: 0,
      chars: row.chars.slice(0, held),
      units: row.units.slice(0, held),
      boundary: row.boundary,
      bare: row.boundary === null ? "start" : "",
      type,
      path,
    });
    if (held < all)
      lines.push({
        row: at,
        from: held,
        chars: row.chars.slice(held),
        units: row.units.slice(held),
        boundary: null,
        bare: "spill",
        type: "paragraph",
        path,
      });
    frames.push(path);
    above = path;
  });
  return { shot, rows, lines, frames };
}

const idsOf = (path: Frame[]) => path.map((frame) => frame.id);
const pathOf = (row: Row) => JSON.parse(row.attrs.get("path")?.value ?? "[]") as string[];
const freshIds = (before: Shot, after: Shot) =>
  [...after.records.keys()].filter((key) => !key.includes(".") && !before.records.has(key));
const reads = (shot: Shot, key: string, lenient: boolean) => {
  const attribute = key.split(".")[1];
  const unset = lenient && attribute !== undefined ? json(DEFAULTS[attribute]) : undefined;
  return shot.records.get(key)?.value ?? unset;
};

function recordsWanted(id: string, type: string, attrs: SequenceAttrs): Map<string, unknown> {
  const wanted = new Map<string, unknown>([[id, type]]);
  for (const [key, unset] of Object.entries(RECORDS[type] ?? {}))
    wanted.set(`${id}.${key}`, key in attrs ? attrs[key] : unset);
  return wanted;
}

function twinsIn(look: Look) {
  const keys = new Map<string, Set<number>>();
  for (const frame of look.frames.flat())
    keys.set(frame.id, (keys.get(frame.id) ?? new Set<number>()).add(frame.key));
  return [...keys.values()].reduce((twins, each) => twins + each.size - 1, 0);
}

function noneJoined(before: Look, after: Look) {
  const was = new Map(
    before.rows.map((row, at) => [
      row.boundary,
      new Map(before.frames[at]!.map((frame) => [frame.id, frame.key])),
    ]),
  );
  const now = new Map<number, Set<number>>();
  after.rows.forEach((row, at) => {
    for (const frame of after.frames[at]!) {
      const earlier = was.get(row.boundary)?.get(frame.id);
      if (earlier === undefined) continue;
      now.set(frame.key, (now.get(frame.key) ?? new Set<number>()).add(earlier));
      if (now.get(frame.key)!.size > 1)
        throw new Error("[writer] a change made two containers that share an id read as one");
    }
  });
}

function blocksRead(doc: Y.Doc) {
  const blocks: [string, string][] = [];
  readBodySequence(schema, doc).descendants((node) => {
    if (!node.isTextblock && !(node.isBlock && node.isLeaf)) return true;
    let units = "";
    node.forEach((child) => {
      units += child.isText ? (child.text ?? "") : OBJECT;
    });
    blocks.push([node.type.name, units]);
    return false;
  });
  return json(blocks);
}

function writerAgrees(doc: Y.Doc, look: Look) {
  const read = readBody(schema, doc).map((line) => [line.bare, line.text, line.ids, line.type]);
  const held = look.lines.map((line) => [line.bare, line.units, idsOf(line.path), line.type]);
  if (json(read) !== json(held))
    throw new Error("[writer] the writer reads other lines than the note holds");
}

type Change = { from?: Held; to?: Held };
type Step = {
  insertedChars: Id[];
  deletedChars: Id[];
  insertedBoundaries: Id[];
  deletedBoundaries: Id[];
  slots: Map<string, Change>;
  rounds: Map<string, [number, number]>;
  gone: Map<Id, Map<string, Held>>;
  settings: Set<string>;
  marks: boolean;
  formats: boolean;
  known: Set<Id>;
};

const step = (): Step => ({
  insertedChars: [],
  deletedChars: [],
  insertedBoundaries: [],
  deletedBoundaries: [],
  slots: new Map(),
  rounds: new Map(),
  gone: new Map(),
  settings: new Set(),
  marks: false,
  formats: false,
  known: new Set(),
});

const partsOf = (slot: string) => slot.split(" ") as [string, string, string | undefined];
const attrsOf = (token: Token) => (token.kind === "boundary" ? token.attrs : token.atom?.attrs);

function effectsOf(before: Shot, after: Shot, round: number): Step {
  const effects = step();
  const changed = (
    from: Map<string, Held>,
    to: Map<string, Held>,
    name: (key: string) => string,
  ) => {
    for (const key of new Set([...from.keys(), ...to.keys()])) {
      if (from.get(key)?.item === to.get(key)?.item) continue;
      effects.slots.set(name(key), { from: from.get(key), to: to.get(key) });
      effects.rounds.set(name(key), [round, round]);
    }
  };
  const was = new Map(before.tokens.map((token) => [token.id, token]));
  const now = new Map(after.tokens.map((token) => [token.id, token]));
  for (const token of before.tokens) {
    const next = now.get(token.id);
    const attrs = attrsOf(token);
    const kind = token.kind === "boundary" ? "line" : "atom";
    if (token.kind === "char") effects.known.add(token.id);
    if (!next) {
      (token.kind === "char" ? effects.deletedChars : effects.deletedBoundaries).push(token.id);
      if (attrs) effects.gone.set(token.id, attrs);
    } else if (attrs) changed(attrs, attrsOf(next)!, (key) => `${kind} ${token.id} ${key}`);
  }
  for (const token of after.tokens)
    if (!was.has(token.id))
      (token.kind === "char" ? effects.insertedChars : effects.insertedBoundaries).push(token.id);
  changed(before.records, after.records, (key) => `record ${key}`);
  effects.formats = before.formats !== after.formats;
  return effects;
}

function join(top: Step, more: Step) {
  top.insertedChars.push(...more.insertedChars);
  top.deletedChars.push(...more.deletedChars);
  top.insertedBoundaries.push(...more.insertedBoundaries);
  top.deletedBoundaries.push(...more.deletedBoundaries);
  for (const [slot, change] of more.slots) {
    const known = top.slots.get(slot);
    top.slots.set(slot, known ? { from: known.from, to: change.to } : change);
    top.rounds.set(slot, [
      top.rounds.get(slot)?.[0] ?? more.rounds.get(slot)![0],
      more.rounds.get(slot)![1],
    ]);
  }
  for (const [id, attrs] of more.gone) top.gone.set(id, attrs);
  for (const key of more.settings) top.settings.add(key);
  top.marks ||= more.marks;
  top.formats ||= more.formats;
  top.known = new Set([...top.known].filter((id) => more.known.has(id)));
}

function marksMoved(before: Shot, after: Shot, saw: (id: Id) => boolean) {
  const was = new Map(
    before.tokens.flatMap((token) => (token.kind === "char" ? [[token.id, token.marks]] : [])),
  );
  return after.tokens.some(
    (token) =>
      token.kind === "char" && saw(token.id) && (was.get(token.id) ?? token.marks) !== token.marks,
  );
}

const tally = () => ({
  runs: 0,
  changes: 0,
  undos: 0,
  redos: 0,
  passedOverWhatItAddedIsGone: 0,
  passedOverItsLinesAreGone: 0,
  changedNothing: 0,
  freshIdsForATwin: 0,
  roundsWithOneIdOnTwo: 0,
  keptApart: 0,
  settingsChecked: 0,
  marksMovedByUndoOfFormatting: 0,
  textBeforeFirstBoundary: 0,
  boundariesForUnboundedText: 0,
  boundariesForAddedParagraphs: 0,
  boundariesForParagraphsAfter: 0,
  refusedInsideALetter: 0,
  inlineItems: 0,
  attributesFirstSet: 0,
  markChanges: 0,
  linesDeleted: 0,
  unnamedRecords: 0,
  records: 0,
});
type Tally = ReturnType<typeof tally>;

class Oracle {
  readonly rootOf = new Map<Id, Id>();
  readonly unitOf = new Map<Id, string>();
  readonly typed = new Set<Id>();
  readonly everDeletedChars = new Set<Id>();
  readonly insertedChars = new Set<Id>();
  readonly deletedChars = new Set<Id>();
  readonly insertedBoundaries = new Set<Id>();
  readonly deletedBoundaries = new Set<Id>();
  readonly snapshots: Id[][] = [];
  readonly writes = new Map<string, { who: number; round: number }[]>();
  readonly asMade = new Map<string, string>();
  readonly count = tally();
  round = 0;
  root(id: Id): Id {
    for (let at = id; ;) {
      const next = this.rootOf.get(at);
      if (next === undefined) return at;
      at = next;
    }
  }
  wrote(slot: string, who: number) {
    const writes = this.writes.get(slot) ?? [];
    writes.push({ who, round: this.round });
    this.writes.set(slot, writes);
  }
  others(slot: string, who: number, from: number, to = Infinity) {
    return (this.writes.get(slot) ?? []).some(
      (write) => write.who !== who && write.round >= from && write.round <= to,
    );
  }
  sees(tokens: Token[]) {
    for (const token of tokens) {
      if (token.kind !== "char") continue;
      const known = this.unitOf.get(this.root(token.id));
      if (known === undefined) this.unitOf.set(token.id, token.unit);
      else if (known !== token.unit)
        throw new Error(`[2 letters] a letter changed from ${json(known)} to ${json(token.unit)}`);
    }
  }
}

function kindsHold(shot: Shot) {
  for (const token of shot.tokens) {
    if (token.kind !== "boundary") continue;
    const type = String(JSON.parse(token.attrs.get("type")?.value ?? "null"));
    for (const key of ["type", "path", ...Object.keys(LEAF_KINDS[type] ?? {})])
      if (!token.attrs.has(key)) throw new Error(`[7 kind] a ${type} boundary holds no ${key}`);
  }
}

function expectMade(after: Shot, id: string, type: string, attrs: SequenceAttrs, lenient: boolean) {
  for (const [key, value] of recordsWanted(id, type, attrs))
    if (reads(after, key, lenient) !== json(value))
      throw new Error(
        `[4 settings] asked for a ${type} with ${key.slice(id.length) || "type"} ${json(value)} and the note holds ${String(reads(after, key, lenient))}`,
      );
}

function copies(before: Shot, after: Shot, id: string, changed: string[], lenient: boolean) {
  const was = new Map<Id | null | undefined, string[]>();
  for (const row of rowsOf(before))
    for (const held of [row.boundary, ...row.chars]) was.set(held, pathOf(row));
  const replaced = rowsOf(after).flatMap((row) => {
    const path = pathOf(row);
    const earlier = was.get(row.boundary) ?? was.get(row.chars[0]) ?? [];
    return path.includes(id) ? earlier.filter((old) => !path.includes(old)) : [];
  });
  return replaced.some((old) =>
    [...before.records].every(([key, held]) => {
      if (key !== old && !key.startsWith(`${old}.`)) return true;
      const suffix = key.slice(old.length);
      return changed.includes(suffix) || reads(after, id + suffix, lenient) === held.value;
    }),
  );
}

function expectCopies(before: Shot, after: Shot, changed: string[], lenient: boolean) {
  for (const id of freshIds(before, after))
    if (!copies(before, after, id, changed, lenient))
      throw new Error(
        `[4 settings] the fresh id ${id} does not hold a copy of every record of the id it replaces`,
      );
}

type Want = { b: string; chars: string[]; path: string[]; frames: Frame[]; kind?: SequenceAttrs };

const wantOf = (look: Look): Want[] =>
  look.rows.map((row, at) => ({
    b: row.boundary ?? "-",
    chars: [...row.chars],
    path: pathOf(row),
    frames: look.frames[at]!,
  }));

function rowsAre(what: string, want: Want[], before: Look, after: Look) {
  const known = new Set(before.shot.tokens.map((token) => token.id));
  const ids = new Set([
    ...before.rows.flatMap(pathOf),
    ...[...before.shot.records.keys()].map((key) => key.split(".")[0]!),
  ]);
  const got = after.rows.map((row) => ({
    b: row.boundary === null ? "-" : known.has(row.boundary) ? row.boundary : "+",
    chars: row.chars.map((id) => (known.has(id) ? id : "+")),
    path: pathOf(row).map((id) => (ids.has(id) ? id : "+")),
  }));
  const wanted = want.map(({ b, chars, path }) => ({ b, chars, path }));
  const both = process.env.BODY_CONTAINERS_DEBUG ? `\nWANT ${json(wanted)}\nGOT  ${json(got)}` : "";
  if (json(got) !== json(wanted))
    throw new Error(
      `[writer] after ${what}, the note's lines are not the ones section 4 gives${both}`,
    );
  want.forEach((row, at) => {
    for (const [key, value] of Object.entries(row.kind ?? {}))
      if (after.rows[at]!.attrs.get(key)?.value !== json(value))
        throw new Error(
          `[7 kind] after ${what}, a boundary holds ${key} ${String(after.rows[at]!.attrs.get(key)?.value)} where it should hold ${json(value)}`,
        );
  });
}

function rowsKept(what: string, before: Look, after: Look) {
  const known = new Set(before.shot.tokens.map((token) => token.id));
  const got: { b: Id | null; chars: Id[] }[] = [];
  after.rows.forEach((row, at) => {
    const given = row.boundary !== null && !known.has(row.boundary);
    const above = got.at(-1);
    const wasBare = before.lines.some(
      (line) => (line.bare === "spill" || line.bare === "start") && line.chars[0] === row.chars[0],
    );
    if (given && !wasBare) throw new Error(`[writer] ${what} made a line that was not there`);
    if (given && above && at > 0) above.chars.push(...row.chars);
    else got.push({ b: given ? null : row.boundary, chars: [...row.chars] });
  });
  const was = before.rows.map((row) => ({ b: row.boundary, chars: row.chars }));
  if (json(got) !== json(was)) throw new Error(`[writer] ${what} changed what a line holds`);
}

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Claim = { value: string | undefined; round: number };

function person(baseline: Uint8Array, who: number, oracle: Oracle, gc: boolean, fault?: Fault) {
  const doc = new Y.Doc({ gc });
  docs.push(doc);
  doc.clientID = 10 * (who + 1);
  const sequence = doc.getText(SEQUENCE);
  const records = doc.getMap<unknown>(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  records.delete = () => {
    throw new Error("[5 records] a writer deleted a record");
  };
  const lenient = LENIENT.includes(fault);
  const own = { trackedOrigins: new Set([LOCAL]), captureTimeout: NEVER_ELAPSES };
  const overwriting = { ...own, ignoreRemoteMapChanges: true };
  const keepRecords = (item: Y.Item) => item.parent !== records;
  const keepAttributes = (item: Y.Item) =>
    keepRecords(item) && !(item.parentSub !== null && item.parent instanceof Y.XmlElement);
  const keepBoundaries = (item: Y.Item) =>
    keepRecords(item) &&
    (keepAttributes(item) || (item.parent as Y.XmlElement).nodeName !== BLOCK_ELEMENT);
  const filtered = (deleteFilter: (item: Y.Item) => boolean, overwrites = true) =>
    new Y.UndoManager([sequence, records], {
      ...own,
      ignoreRemoteMapChanges: overwrites,
      deleteFilter,
    });
  const history =
    fault === FAULT.defaultMapUndo
      ? filtered(keepBoundaries, false)
      : fault === FAULT.noDeleteFilter
        ? new Y.UndoManager([sequence, records], overwriting)
        : fault === FAULT.recordsOnlyFilter
          ? filtered(keepRecords)
          : fault === FAULT.inlineAttributesKept
            ? filtered(keepAttributes)
            : bodyHistory(doc, LOCAL, NEVER_ELAPSES);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const undoMirror: Step[] = [];
  let redoMirror: Step[] = [];
  const claims = new Map<string, Claim>();
  let made = 0;
  const asked = new Set<string>();
  const freshId = () => {
    const id = `${"wxyz"[who]!}${(made++).toString(36)}`;
    asked.add(id);
    return id;
  };

  const seen = (before: Look): [Step, Look] => {
    const after = lookAt(doc);
    const effects = effectsOf(before.shot, after.shot, oracle.round);
    for (const key of before.shot.records.keys())
      if (!after.shot.records.has(key))
        throw new Error(`[5 records] the record ${key} was deleted`);
    oracle.sees(after.shot.tokens);
    for (const id of effects.deletedChars) oracle.everDeletedChars.add(oracle.root(id));
    for (const id of effects.insertedChars) oracle.insertedChars.add(id);
    for (const id of effects.deletedChars) oracle.deletedChars.add(id);
    for (const id of effects.insertedBoundaries) oracle.insertedBoundaries.add(id);
    for (const id of effects.deletedBoundaries) oracle.deletedBoundaries.add(id);
    for (const slot of effects.slots.keys()) oracle.wrote(slot, who);
    oracle.snapshots.push(after.shot.tokens.map((token) => token.id));
    if (after.shot.tokens[0]?.kind === "char") oracle.count.textBeforeFirstBoundary++;
    return [effects, after];
  };

  const local = (before: Look, act: () => void, mayMark: boolean, settings: string[]) => {
    const depth = history.undoStack.length;
    doc.transact(act, LOCAL);
    const [effects, after] = seen(before);
    effects.marks = mayMark;
    if (!mayMark && marksMoved(before.shot, after.shot, () => true))
      throw new Error("[2 letters] a change that is not about marks changed a letter's marks");
    noneJoined(before, after);
    if (twinsIn(after) > twinsIn(before))
      throw new Error("[writer] a change left one id on two containers");
    writerAgrees(doc, after);
    for (const id of effects.insertedChars) oracle.typed.add(id);
    for (const [slot, change] of effects.slots)
      claims.set(slot, { value: change.to?.value, round: oracle.round });
    for (const key of settings) effects.settings.add(key);
    const top = undoMirror.at(-1);
    if (history.undoStack.length > depth) undoMirror.push(effects);
    else if (top && history.undoStack.length === depth) join(top, effects);
    if (history.redoStack.length === 0) redoMirror = [];
    oracle.count.changes++;
    return [effects, after] as const;
  };

  const withoutFreshIds = (plan: BodyWrites) => {
    const twin = new Map<string, string>();
    for (const [boundary, attrs] of plan.attributes) {
      const was = boundary.getAttribute("path") as unknown as string[];
      (attrs.path as string[]).forEach((id, depth) => twin.set(id, was[depth]!));
    }
    for (const [key, value] of [...plan.records]) {
      const [id, attribute] = key.split(".") as [string, string | undefined];
      const shared = twin.get(id);
      if (shared === undefined || shared === id) continue;
      plan.records.delete(key);
      const sharedKey = attribute === undefined ? shared : `${shared}.${attribute}`;
      if (json(records.get(sharedKey)) !== json(value)) plan.records.set(sharedKey, value);
    }
    plan.attributes.clear();
  };

  const write = (before: Look, plan: BodyWrites | null, mayMark = false) => {
    const unused = [...asked].filter((id) => !plan?.records.has(id));
    asked.clear();
    if (!plan) return null;
    if (unused.length > 0 && fault === undefined)
      throw new Error("[writer] a change asked for a fresh id and did not use it");
    const settings: string[] = [];
    for (const [key, value] of plan.records)
      if (!records.has(key.split(".")[0]!)) oracle.asMade.set(key, json(value));
      else {
        oracle.asMade.delete(key);
        settings.push(key);
      }
    for (const [key, value] of fault === undefined ? [] : [...plan.records]) {
      const [id, attribute] = key.split(".") as [string, string | undefined];
      const isDefault = attribute !== undefined && json(value) === json(DEFAULTS[attribute]);
      const itsKind = RECORDS[String(plan.records.get(id))] ?? {};
      if (lenient) {
        if (isDefault && !records.has(key)) plan.records.delete(key);
      } else if (fault === FAULT.noLooseRecord) {
        if (attribute === "loose" && !records.has(key)) plan.records.delete(key);
      } else if (fault === FAULT.copyKnownAttributes) {
        if (!records.has(id) && attribute !== undefined && !Object.hasOwn(itsKind, attribute))
          plan.records.delete(key);
      } else if (fault === FAULT.wrongSetting && attribute === "start")
        plan.records.set(key, Number(value) + 1);
    }
    const missing = [...plan.records.keys()].filter(
      (key) => key.includes(".") && !records.has(key),
    );
    if (fault === FAULT.defaultFirst && missing.length > 0) {
      const earlier = lookAt(doc);
      doc.transact(() => {
        for (const key of missing) records.set(key, DEFAULTS[key.split(".")[1]!]);
      }, OUTSIDE_HISTORY);
      seen(earlier);
    }
    const typed = fault === FAULT.typingInheritsMarks ? plan.typed : undefined;
    if (typed) delete plan.typed;
    const shift = plan.added.filter((boundary) => boundary.index <= (typed?.index ?? 0)).length;
    return local(
      before,
      () => {
        if (fault === FAULT.deleteAndRecreate)
          for (const key of plan.records.keys()) if (records.has(key)) records.delete(key);
        writeBody(doc, plan);
        if (typed) sequence.insert(typed.index + shift, typed.letters);
      },
      mayMark,
      settings,
    );
  };

  const refusal = (before: Look, plan: BodyWrites | null, allowed: boolean, what: string) => {
    if (plan && !allowed)
      throw new Error(`[writer] ${what} was written where section 4 refuses it`);
    if (!plan && allowed) throw new Error(`[writer] ${what} was refused where section 4 allows it`);
    if (!plan) write(before, null);
    return plan === null;
  };

  const keepApart = (want: Want[], upper: number) => {
    const one = want[upper]?.frames ?? [];
    const other = want[upper + 1]?.frames ?? [];
    let depth = 0;
    while (one[depth] !== undefined && one[depth]!.key === other[depth]?.key) depth++;
    if (one[depth] === undefined || one[depth]!.id !== other[depth]?.id) return;
    for (const row of want) if (row.frames[depth]?.key === other[depth]!.key) row.path[depth] = "+";
    oracle.count.keptApart++;
  };

  const rowAfter = (before: Look, after: Look, line: Line) =>
    line.chars.length > 0
      ? after.rows.findIndex((row) => row.chars.includes(line.chars[0]!))
      : Math.max(
          0,
          after.rows.findIndex((row) => row.boundary === before.rows[line.row]!.boundary),
        );

  const shown = () =>
    leavesOfSequence(schema, piecesOfSequence(sequence, MARKS), records).map((leaf) =>
      leaf.path.map((frame) => json([frame.type, frame.attrs])),
    );

  const setting = (
    at: number,
    depth: number,
    type: string | undefined,
    attrs: SequenceAttrs,
    plan: BodyWrites | null,
  ) => {
    const before = lookAt(doc);
    const line = before.lines[at];
    const container = line?.path[depth];
    if (!line || !container) return false;
    const shownBefore = shown();
    const wanted = new Map(Object.entries(attrs).map(([name, value]) => [`.${name}`, json(value)]));
    if (type !== undefined) wanted.set("", json(type));
    if (plan && fault === FAULT.oneRecordForTwins) withoutFreshIds(plan);
    const done = write(before, plan);
    if (!done) {
      for (const [suffix, value] of wanted)
        if (before.shot.records.get(container.id + suffix)?.value !== value)
          throw new Error(
            `[4 settings] asked for ${suffix || "type"} ${value} and the writer wrote nothing`,
          );
      return false;
    }
    const after = done[1];
    rowsKept("a setting", before, after);
    const its = after.frames[rowAfter(before, after, line)]![depth]!;
    for (const [suffix, value] of wanted) {
      const holds = after.shot.records.get(its.id + suffix)?.value;
      if (holds !== value)
        throw new Error(
          `[4 settings] asked for ${suffix || "type"} ${value} and the note holds ${String(holds)}`,
        );
      claims.set(`record ${its.id}${suffix}`, { value, round: oracle.round });
    }
    const itemType = type === undefined ? undefined : ITEM_OF[type];
    for (const path of after.frames) {
      const item = path[depth]?.key === its.key ? path[depth + 1] : undefined;
      if (item && itemType && after.shot.records.get(item.id)?.value !== json(itemType))
        throw new Error(`[4 settings] an item of a list made a ${type!} is stored as another kind`);
    }
    expectCopies(before.shot, after.shot, [...wanted.keys()], lenient);
    if (freshIds(before.shot, after.shot).length > 0) oracle.count.freshIdsForATwin++;
    const unread = before.rows.length - shownBefore.length;
    shown().forEach((path, index) =>
      path.forEach((frame, level) => {
        const itsOwn = before.frames[index + unread]?.[depth]?.key === container.key;
        const onIt = level === depth || (type !== undefined && level === depth + 1);
        if (frame !== shownBefore[index]![level] && !(itsOwn && onIt))
          throw new Error("[writer] a setting changed on a container it was not made on");
      }),
    );
    return true;
  };

  const alive = (id: Id) => {
    let [client, clock] = id.split(":").map(Number) as [number, number];
    for (;;) {
      const struct = Y.getItem(doc.store, Y.createID(client, clock));
      if (!(struct instanceof Y.Item)) return false;
      if (struct.redone === null) return !struct.deleted;
      clock = struct.redone.clock + clock - struct.id.clock;
      client = struct.redone.client;
    }
  };

  const madeItsContainer = (entry: Step, key: string) => {
    const made = entry.slots.get(`record ${key.split(".")[0]!}`);
    return made !== undefined && made.from === undefined;
  };

  const nothingLeftToUndo = (entry: Step) => {
    const added = new Set([...entry.insertedChars, ...entry.insertedBoundaries]);
    const left = ([slot, change]: [string, Change]) => {
      const [kind, name] = partsOf(slot);
      if (kind === "record" || !alive(name)) return false;
      return change.from !== undefined || kind === "line" || alive(change.to!.item);
    };
    return (
      [...entry.settings].every((key) => madeItsContainer(entry, key)) &&
      [...entry.deletedChars, ...entry.deletedBoundaries].every((id) => added.has(id)) &&
      ![...added].some(alive) &&
      ![...entry.slots].some(left)
    );
  };

  const learnCopies = () => {
    for (const structs of doc.store.clients.values())
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.redone === null) continue;
        for (let at = 0; at < struct.length; at++)
          oracle.rootOf.set(
            idOf(struct.redone.client, struct.redone.clock + at),
            oracle.root(idOf(struct.id.client, struct.id.clock + at)),
          );
      }
  };

  const sourceOf = (copy: Id): Id | null => {
    for (const structs of doc.store.clients.values())
      for (const struct of structs)
        if (
          struct instanceof Y.Item &&
          struct.redone !== null &&
          idOf(struct.redone.client, struct.redone.clock) === copy
        )
          return idOf(struct.id.client, struct.id.clock);
    return null;
  };

  const noVisibleCharBetween = (left: Id, right: Id) => {
    let inside = false;
    for (let item = sequence._start; item !== null; item = item.right) {
      const ids = Array.from({ length: item.length }, (_, at) =>
        idOf(item.id.client, item.id.clock + at),
      );
      const edge = ids.includes(left) || ids.includes(right);
      if (edge && inside) return true;
      if (edge) inside = true;
      else if (inside && !item.deleted && item.content instanceof Y.ContentString) return false;
    }
    return false;
  };

  const back = (which: "undo" | "redo") => {
    const from = which === "undo" ? undoMirror : redoMirror;
    const to = which === "undo" ? redoMirror : undoMirror;
    const stack = () => (which === "undo" ? history.undoStack : history.redoStack);
    const other = () => (which === "undo" ? history.redoStack : history.undoStack);
    const depth = stack().length;
    const otherDepth = other().length;
    if (from.length !== depth) throw new Error("the model lost count of the history");
    let nothingLeft = 0;
    while (nothingLeft < depth && nothingLeftToUndo(from[depth - 1 - nothingLeft]!)) nothingLeft++;
    const before = lookAt(doc);
    const did = (which === "undo" ? history.undo() : history.redo()) !== null;
    const popped = from.splice(stack().length, depth - stack().length);
    const [effects, after] = seen(before);
    learnCopies();
    oracle.sees(after.shot.tokens);
    const changedFormatting = effects.formats;
    effects.marks = popped.some((entry) => entry.marks);
    effects.formats = popped.some((entry) => entry.formats);
    const sawAll = (id: Id) => popped.every((entry) => entry.known.has(id));
    if (!effects.marks && marksMoved(before.shot, after.shot, sawAll)) {
      if (!effects.formats)
        throw new Error(`[2 letters] ${which} changed a letter's marks and its step wrote none`);
      oracle.count.marksMovedByUndoOfFormatting++;
    }
    const passedOver = popped.length - (did ? 1 : 0);
    if (passedOver > nothingLeft)
      throw new Error(`[3 undo] ${which} passed over a step that still had something to ${which}`);
    for (const entry of popped.slice(did ? 1 : 0))
      oracle.count[
        entry.insertedChars.length + entry.insertedBoundaries.length > 0
          ? "passedOverWhatItAddedIsGone"
          : "passedOverItsLinesAreGone"
      ]++;
    oracle.count[which === "undo" ? "undos" : "redos"]++;
    const done = did ? popped[0]! : step();
    const changed = [
      effects.insertedChars,
      effects.deletedChars,
      effects.insertedBoundaries,
      effects.deletedBoundaries,
      [...effects.slots],
    ];
    if (did && !changedFormatting && changed.every((none) => none.length === 0))
      oracle.count.changedNothing++;

    const roots = (ids: Id[]) => ids.map((id) => oracle.root(id));
    const within = (ids: Id[], allowed: Id[]) => {
      const set = new Set(roots(allowed));
      return roots(ids).every((id) => set.has(id));
    };
    const once = (ids: Id[], deleted: Id[]) => {
      const left = new Map<Id, number>();
      for (const id of roots(deleted)) left.set(id, (left.get(id) ?? 0) + 1);
      return roots(ids).every((id) => {
        left.set(id, (left.get(id) ?? 0) - 1);
        return left.get(id)! >= 0;
      });
    };
    if (!within(effects.deletedChars, done.insertedChars))
      throw new Error(`[3 undo] ${which} deleted letters that its step did not type`);
    if (!once(effects.insertedChars, done.deletedChars))
      throw new Error(`[3 undo] ${which} added letters that its step did not delete`);
    if (!within(effects.deletedBoundaries, done.insertedBoundaries))
      throw new Error(`[3 undo] ${which} deleted a boundary that its step did not add`);
    if (!once(effects.insertedBoundaries, done.deletedBoundaries))
      throw new Error(`[3 undo] ${which} added a boundary that its step did not delete`);

    const rooted = (slot: string) => {
      const [kind, name, key] = partsOf(slot);
      return kind === "record" ? slot : `${kind} ${oracle.root(name)} ${key!}`;
    };
    const byRoot = new Map([...done.slots.keys()].map((slot) => [rooted(slot), slot]));
    for (const [slot, change] of effects.slots) {
      const mine = done.slots.has(slot) ? slot : byRoot.get(rooted(slot));
      if (mine === undefined)
        throw new Error(`[3 undo] ${which} changed ${slot}, which its step did not change`);
      const earlier = done.slots.get(mine)!.from?.value;
      const [first, last] = done.rounds.get(mine)!;
      if (change.to?.value !== earlier && !oracle.others(mine, who, first, last))
        throw new Error(
          `[4 settings] ${which} left ${slot} as ${String(change.to?.value)}, and it was ${String(earlier)} before the step`,
        );
      claims.set(slot, { value: change.to?.value, round: oracle.round });
    }

    for (const key of done.settings) {
      const change = done.slots.get(`record ${key}`);
      const [first, last] = done.rounds.get(`record ${key}`) ?? [0, Infinity];
      if (!change || oracle.others(`record ${key}`, who, first, last)) continue;
      if (madeItsContainer(done, key)) {
        if (effects.slots.has(`record ${key}`))
          throw new Error(`[4 settings] ${which} changed ${key}, which its own step made`);
        continue;
      }
      const earlier = change.from?.value ?? json(DEFAULTS[key.split(".")[1] ?? ""]);
      if (reads(after.shot, key, true) !== earlier)
        throw new Error(
          `[4 settings] ${which} left ${key} reading ${String(reads(after.shot, key, true))}, and it read ${String(earlier)} before the step`,
        );
    }

    const tokens = new Map(after.shot.tokens.map((token) => [token.id, token]));
    for (const copy of [...effects.insertedBoundaries, ...effects.insertedChars]) {
      const restored = tokens.get(copy);
      const now = restored && attrsOf(restored);
      if (!restored || !now) continue;
      const kind = restored.kind === "boundary" ? "line" : "atom";
      const source = sourceOf(copy);
      if (source === null || (kind === "line" && !noVisibleCharBetween(source, copy)))
        throw new Error(`[3 undo] ${which} put a boundary back away from where it was`);
      const lastSeen = new Map(
        [...(done.gone.get(source) ?? [])].map(([key, held]) => [key, held.value]),
      );
      const unsure = new Set<string>();
      for (const [slot, change] of done.slots) {
        const [slotKind, name, key] = partsOf(slot);
        if (slotKind !== kind || name !== source) continue;
        if (oracle.others(slot, who, done.rounds.get(slot)![0])) unsure.add(key!);
        else if (change.from) lastSeen.set(key!, change.from.value);
        else lastSeen.delete(key!);
      }
      const what = kind === "line" ? "a boundary" : "an inline item";
      for (const key of new Set([...lastSeen.keys(), ...now.keys()]))
        if (!unsure.has(key) && lastSeen.get(key) !== now.get(key)?.value)
          throw new Error(
            `[3 undo] ${which} put ${what} back with ${key} ${String(now.get(key)?.value)}, and the person last saw ${String(lastSeen.get(key))}`,
          );
    }

    for (const key of done.settings)
      if (effects.slots.has(`record ${key}`)) effects.settings.add(key);
    if (other().length > otherDepth) to.push(effects);
    kindsHold(after.shot);
    return did;
  };

  const expectDefaults = (before: Look, after: Look) => {
    for (const id of freshIds(before.shot, after.shot))
      expectMade(
        after.shot,
        id,
        String(JSON.parse(after.shot.records.get(id)!.value)),
        {},
        lenient,
      );
  };

  const paragraph = (chars: string[], line: Line): Want => ({
    b: "+",
    chars,
    path: idsOf(line.path),
    frames: line.path,
    kind: PARAGRAPH,
  });

  const given = (line: Line) =>
    oracle.count[
      line.bare === "item"
        ? "boundariesForAddedParagraphs"
        : line.bare === "spill"
          ? "boundariesForParagraphsAfter"
          : "boundariesForUnboundedText"
    ]++;

  const into = (
    what: string,
    at: number,
    offset: number,
    holders: string[],
    plan: BodyWrites | null,
    units: number,
  ) => {
    const before = lookAt(doc);
    const line = before.lines[at];
    const fits =
      line !== undefined &&
      (line.bare !== "" || holders.includes(line.type)) &&
      offset <= line.chars.length &&
      !cutsALetter(line.units, offset);
    if (refusal(before, plan, fits, what) || !line || !plan) return null;
    const want = wantOf(before);
    const row = want[line.row]!;
    const typed = Array.from({ length: units }, () => "+");
    const readAbove =
      line.bare === "spill" && offset === 0 && holders.includes(before.lines[at - 1]!.type);
    if (line.bare === "item") want.splice(line.row, 0, paragraph(typed, line));
    else if (readAbove)
      want.splice(line.row + 1, 0, paragraph([...typed, ...row.chars.splice(line.from)], line));
    else row.chars.splice(line.from + offset, 0, ...typed);
    if (line.bare === "item" || readAbove) given(line);
    if (line.bare === "item" && fault === FAULT.addedParagraphBare) plan.added = [];
    const [effects, after] = write(before, plan)!;
    rowsAre(what, want, before, after);
    const tokens = new Map(after.shot.tokens.map((token) => [token.id, token]));
    return effects.insertedChars.map((id) => tokens.get(id) as Letter);
  };

  return {
    who,
    doc,
    records,
    sent,
    claims,
    look: () => lookAt(doc),
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update, REMOTE);
    },
    type(at: number, offset: number, letters: string, marks: SequenceAttrs = {}) {
      const plan = typeLetters(schema, doc, at, offset, letters, marks);
      const landed = into("typing", at, offset, HOLDS_LETTERS, plan, letters.length);
      if (!landed) return false;
      if (landed.map((token) => token.unit).join("") !== letters)
        throw new Error("[2 letters] the note does not hold the letters that were typed");
      const wrong = landed.find((token) => token.marks !== marksOf(Object.entries(marks)));
      if (wrong)
        throw new Error(
          `[2 letters] letters typed with the marks ${json(marks)} hold the marks ${wrong.marks}`,
        );
      return true;
    },
    place(at: number, offset: number, name: string, attrs: SequenceAttrs) {
      const plan = insertInline(schema, doc, at, offset, name, attrs);
      const landed = into("an inline item", at, offset, HOLDS_INLINE, plan, 1);
      if (!landed) return false;
      const holds = [...(landed[0]?.atom?.attrs ?? [])].map(([key, held]) => [key, held.value]);
      const wanted = Object.entries(attrs).map(([key, value]) => [key, json(value)]);
      if (landed[0]?.atom?.name !== name || json(holds.sort()) !== json(wanted.sort()))
        throw new Error("[4 settings] an inline item does not hold what it was made with");
      oracle.count.inlineItems++;
      return true;
    },
    inline(at: number, offset: number, attrs: SequenceAttrs) {
      const before = lookAt(doc);
      const id = before.lines[at]?.chars[offset];
      const token = before.shot.tokens.find((each) => each.id === id);
      const atom = token?.kind === "char" ? token.atom : undefined;
      const wanted = Object.entries(attrs).map(([key, value]) => [key, json(value)] as const);
      const differs = wanted.some(([key, value]) => atom?.attrs.get(key)?.value !== value);
      const plan = setInlineAttributes(schema, doc, at, offset, attrs);
      const what = "a change to an inline item";
      if (refusal(before, plan, atom !== undefined && differs, what) || !atom) return false;
      const after = write(before, plan)![1];
      rowsAre(what, wantOf(before), before, after);
      const now = after.shot.tokens.find((each) => each.id === id);
      for (const [key, value] of wanted) {
        if ((now && attrsOf(now))?.get(key)?.value !== value)
          throw new Error(
            `[4 settings] asked for ${key} ${value} on an inline item, and it holds another`,
          );
        claims.set(`atom ${id!} ${key}`, { value, round: oracle.round });
        if (!atom.attrs.has(key)) oracle.count.attributesFirstSet++;
      }
      return true;
    },
    mark(at: number, offset: number, length: number, marks: SequenceAttrs) {
      const before = lookAt(doc);
      const line = before.lines[at];
      const fits =
        line !== undefined &&
        length > 0 &&
        offset + length <= line.chars.length &&
        !cutsALetter(line.units, offset) &&
        !cutsALetter(line.units, offset + length);
      const plan = setMarks(schema, doc, at, offset, length, marks);
      if (refusal(before, plan, fits, "a change of marks") || !line) return false;
      const after = write(before, plan, true)![1];
      rowsAre("a change of marks", wantOf(before), before, after);
      const marked = new Set(line.chars.slice(offset, offset + length));
      const was = new Map(before.shot.tokens.map((token) => [token.id, token]));
      for (const token of after.shot.tokens) {
        const earlier = was.get(token.id);
        if (token.kind !== "char" || earlier?.kind !== "char" || token.atom) continue;
        const wanted = new Map(JSON.parse(earlier.marks) as [string, unknown][]);
        if (marked.has(token.id))
          for (const [name, value] of Object.entries(marks))
            if (isPlain(value)) wanted.set(name, value);
            else wanted.delete(name);
        if (marksOf(wanted) !== token.marks)
          throw new Error(
            `[2 letters] a letter holds the marks ${token.marks} after ${json(marks)} was asked for, where it should hold ${marksOf(wanted)}`,
          );
      }
      oracle.count.markChanges++;
      return true;
    },
    erase(at: number, offset: number, toAt: number, toOffset: number) {
      const before = lookAt(doc);
      const { lines, rows } = before;
      const first = lines[at];
      const last = lines[toAt];
      const plan = deleteRange(schema, doc, at, offset, toAt, toOffset, freshId);
      const fits =
        first !== undefined &&
        last !== undefined &&
        offset <= first.chars.length &&
        toOffset <= last.chars.length &&
        !cutsALetter(first.units, offset) &&
        !cutsALetter(last.units, toOffset);
      const upTo = last?.bare === "item";
      const r1 = first?.row ?? 0;
      const p1 = (first?.from ?? 0) + offset;
      const r2 = (last?.row ?? 0) - (upTo ? 1 : 0);
      const p2 = upTo ? (rows[r2]?.chars.length ?? 0) : (last?.from ?? 0) + toOffset;
      const some = fits && (r1 < r2 || (r1 === r2 && (p1 < p2 || first.bare === "item")));
      if (refusal(before, plan, some, "a delete") || !first || !last) return false;
      const want = wantOf(before);
      const retyped =
        first.bare === "item" && rows[r1]!.attrs.get("type")?.value !== json("paragraph");
      const block = lines.find(
        (line) => line.row === r2 && line.from === 0 && line.bare !== "item",
      )!;
      const held = block.chars.length;
      const keepsAfter = held < rows[r2]!.chars.length && p2 <= held && (r2 > r1 || retyped);
      const tail = want[r2]!.chars.slice(p2);
      const after = keepsAfter ? [paragraph(tail.splice(held - p2), block)] : [];
      if (keepsAfter) oracle.count.boundariesForParagraphsAfter++;
      const left = [...want[r1]!.chars.slice(0, p1), ...tail];
      if (first.bare === "item")
        Object.assign(want[r1]!, paragraph(left, first), { b: want[r1]!.b });
      want[r1]!.chars = left;
      want.splice(r1 + 1, r2 - r1, ...after);
      if (want[0]!.b === "-" && left.length === 0 && r1 === 0 && want.length > 1) {
        Object.assign(want[0]!, { b: "+", kind: PARAGRAPH });
        oracle.count.boundariesForUnboundedText++;
      }
      keepApart(want, r1);
      const done = write(before, plan, true)![1];
      rowsAre("a delete", want, before, done);
      expectCopies(before.shot, done.shot, [], lenient);
      if (r2 > r1) oracle.count.linesDeleted++;
      return true;
    },
    split(at: number, offset: number, kind?: SequenceAttrs) {
      const before = lookAt(doc);
      const { lines } = before;
      const line = lines[at];
      const inside = line !== undefined && cutsALetter(line.units, offset);
      const fits = line !== undefined && offset <= line.chars.length && !inside;
      let plan = splitLine(schema, doc, at, offset, freshId, kind);
      if (!plan && inside) oracle.count.refusedInsideALetter++;
      if (!plan && inside && fault === FAULT.splitInsideLetter) {
        plan = splitLine(schema, doc, at, offset + 1, freshId, kind);
        if (plan) plan.added[0]!.index--;
      } else if (refusal(before, plan, fits, "a split")) return false;
      if (!line || !plan) return false;
      const want = wantOf(before);
      const row = want[line.row]!;
      const stored = before.rows[line.row]!.attrs;
      const type = String(
        kind ? (kind.type ?? "paragraph") : line.bare === "" ? line.type : "paragraph",
      );
      const copied = (key: string) => (line.bare === "" ? stored.get(key)?.value : undefined);
      const newKind: SequenceAttrs = { type };
      for (const [key, unset] of Object.entries(LEAF_KINDS[type]!))
        newKind[key] = kind
          ? key in kind
            ? kind[key]
            : unset
          : (JSON.parse(copied(key) ?? json(unset)) as unknown);
      const depth = line.path.length - 1;
      const item = line.path[depth];
      const isFirst =
        item !== undefined &&
        ITEMS.includes(item.type) &&
        lines[at - 1]?.path[depth]?.key !== item.key;
      const ids = idsOf(line.path);
      const newPath = isFirst ? [...ids.slice(0, depth), "+"] : ids;
      const fresh = (chars: string[]): Want => ({
        b: "+",
        chars,
        path: [...newPath],
        frames: line.path,
        kind: newKind,
      });
      const pos = line.from + offset;
      const end = line.from + line.chars.length;
      const some = line.chars.length > 0 || line.bare !== "";
      const above = offset === 0 && line.bare !== "item" && some;
      const after = line.bare === "" && end < row.chars.length && offset === line.chars.length;
      let moved = line.row + 1;
      if (line.bare !== "" && offset === 0) given(line);
      if (line.bare === "start" && offset === 0)
        want.splice(0, 1, fresh([]), paragraph(row.chars, line));
      else if (line.bare === "item") {
        want.splice(line.row, 0, paragraph([], line), fresh([]));
        moved = line.row + 2;
      } else if (line.bare === "spill" && offset === 0)
        want.splice(line.row + 1, 0, fresh([]), paragraph(row.chars.splice(pos), line));
      else if (above) want.splice(line.row, 0, fresh([]));
      else if (after) {
        want.splice(line.row + 1, 0, fresh([]), paragraph(row.chars.splice(pos), line));
        want[line.row + 2]!.path = [...newPath];
        oracle.count.boundariesForParagraphsAfter++;
        moved = line.row + 3;
      } else want.splice(line.row + 1, 0, fresh(row.chars.splice(pos)));
      if (isFirst && !above)
        for (let later = moved; want[later]?.frames[depth]?.key === item.key; later++)
          want[later]!.path[depth] = "+";
      if (above && fault === FAULT.oldBoundaryAbove) plan.added[0]!.index++;
      if (fault === FAULT.splitAlwaysParagraph && plan.added.length === 1)
        plan.added[0]!.attrs = { type: "paragraph", path: plan.added[0]!.attrs.path };
      const done = write(before, plan)![1];
      rowsAre("a split", want, before, done);
      expectDefaults(before, done);
      return true;
    },
    join(at: number) {
      const before = lookAt(doc);
      const lower = before.lines[at];
      const upper = before.lines[at - 1];
      const plan = joinLine(schema, doc, at, freshId);
      const fits = upper !== undefined && lower !== undefined && lower.bare === "";
      if (refusal(before, plan, fits, "a join") || !plan || !upper || !lower) return false;
      const want = wantOf(before);
      const row = want[lower.row]!;
      const held = lower.chars.length;
      const retyped = before.rows[lower.row]!.attrs.get("type")?.value !== json("paragraph");
      const after = (): Want[] => {
        if (held === row.chars.length) return [];
        oracle.count.boundariesForParagraphsAfter++;
        return [paragraph(row.chars.splice(held), lower)];
      };
      if (upper.bare === "item") {
        const below = retyped ? after() : [];
        Object.assign(row, paragraph(row.chars, upper), { b: row.b });
        want.splice(lower.row + 1, 0, ...below);
      } else if (upper.bare === "" && upper.chars.length === 0) {
        want.splice(upper.row, 1);
        keepApart(want, upper.row - 1);
      } else {
        const below = after();
        want[upper.row]!.chars.push(...row.chars);
        want.splice(lower.row, 1, ...below);
        keepApart(want, upper.row);
      }
      if (plan.erased.length > 0 && fault === FAULT.alwaysLowerBoundary)
        plan.erased[0]!.index = readBody(schema, doc)[at]!.start - 1;
      if (plan.erased.length > 0 && fault === FAULT.twinsJoined) {
        plan.records.clear();
        plan.attributes.clear();
      }
      const done = write(before, plan)![1];
      rowsAre("a join", want, before, done);
      expectCopies(before.shot, done.shot, [], lenient);
      return true;
    },
    kind(at: number, asked: SequenceAttrs) {
      const before = lookAt(doc);
      const line = before.lines[at];
      if (!line) return false;
      const stored = line.bare === "" ? before.rows[line.row]!.attrs : new Map<string, Held>();
      const held = line.bare === "" ? line.type : "paragraph";
      const type = typeof asked.type === "string" ? asked.type : held;
      const unset = LEAF_KINDS[type]!;
      const wanted: SequenceAttrs = { type };
      for (const key of Object.keys(unset)) {
        const kept = type === held ? stored.get(key)?.value : undefined;
        wanted[key] = key in asked ? asked[key] : (JSON.parse(kept ?? json(unset[key])) as unknown);
      }
      const holds = (key: string) =>
        line.bare === "" ? stored.get(key)?.value : json(PARAGRAPH[key]);
      const same = Object.entries(wanted).every(([key, value]) => holds(key) === json(value));
      const plan = setLineKind(schema, doc, at, asked);
      if (refusal(before, plan, line.bare !== "item" && !same, "a change of kind") || !plan)
        return false;
      const want = wantOf(before);
      const row = want[line.row]!;
      const end = line.from + line.chars.length;
      if (line.bare === "start") Object.assign(row, { b: "+", kind: wanted });
      else if (line.bare === "spill")
        want.splice(line.row + 1, 0, {
          ...paragraph(row.chars.splice(line.from), line),
          kind: wanted,
        });
      else {
        row.kind = wanted;
        if (type !== held && end < row.chars.length) {
          want.splice(line.row + 1, 0, paragraph(row.chars.splice(end), line));
          oracle.count.boundariesForParagraphsAfter++;
          if (fault === FAULT.spillLeftBare) plan.added = [];
        }
      }
      if (line.bare !== "") given(line);
      if (fault === FAULT.noKindDefaults)
        for (const attrs of [...plan.attributes.values(), ...plan.added.map((each) => each.attrs)])
          for (const key of Object.keys(unset))
            if (!stored.has(key) && json(attrs[key]) === json(unset[key])) delete attrs[key];
      rowsAre("a change of kind", want, before, write(before, plan)![1]);
      return true;
    },
    wrap(at: number, depth: number, count: number, type: string, attrs: SequenceAttrs) {
      const before = lookAt(doc);
      const line = before.lines[at];
      const plan = wrapBlocks(schema, doc, at, depth, count, type, attrs, freshId);
      const alone = line?.bare === "item" && depth === line.path.length;
      const inAList = LISTS.includes(line?.path[depth - 1]?.type ?? "");
      const shallow = before.frames.every((path) => path.length < 60);
      if (!plan && line && depth <= line.path.length && !inAList && shallow && !alone)
        throw new Error("[writer] a wrap was refused where blocks can be wrapped");
      const done = write(before, plan);
      if (!done || !line) return false;
      rowsKept("a wrap", before, done[1]);
      const made = done[1].frames[rowAfter(before, done[1], line)]?.[depth]?.id;
      const fresh = freshIds(before.shot, done[1].shot);
      if (made === undefined || !fresh.includes(made))
        throw new Error("[4 settings] a wrap made no container where it was asked for one");
      for (const id of fresh)
        if (id === made) expectMade(done[1].shot, id, type, attrs, lenient);
        else if (ITEM_OF[type]) expectMade(done[1].shot, id, ITEM_OF[type], {}, lenient);
        else throw new Error("[4 settings] a wrap made a container it was not asked for");
      return true;
    },
    lift(at: number, depth: number, count: number) {
      const before = lookAt(doc);
      const done = write(before, liftBlocks(schema, doc, at, depth, count, freshId));
      if (!done) return false;
      rowsKept("a lift", before, done[1]);
      expectCopies(before.shot, done[1].shot, [], lenient);
      return true;
    },
    indent(at: number, depth: number) {
      const before = lookAt(doc);
      const done = write(before, indentItem(schema, doc, at, depth, freshId));
      if (!done) return false;
      rowsKept("an indent", before, done[1]);
      for (const id of freshIds(before.shot, done[1].shot)) {
        const type = String(JSON.parse(done[1].shot.records.get(id)!.value));
        if (copies(before.shot, done[1].shot, id, [], lenient)) continue;
        if (!LISTS.includes(type))
          throw new Error("[4 settings] an indent made a container that is not a list");
        expectMade(done[1].shot, id, type, {}, lenient);
      }
      return true;
    },
    outdent(at: number, depth: number) {
      const before = lookAt(doc);
      const done = write(before, outdentItem(schema, doc, at, depth, freshId));
      if (!done) return false;
      rowsKept("an outdent", before, done[1]);
      expectCopies(before.shot, done[1].shot, [], lenient);
      return true;
    },
    containerKind: (at: number, depth: number, type: string) =>
      setting(at, depth, type, {}, setContainerKind(schema, doc, at, depth, type, freshId)),
    containerAttrs: (at: number, depth: number, attrs: SequenceAttrs) =>
      setting(
        at,
        depth,
        undefined,
        attrs,
        setContainerAttributes(schema, doc, at, depth, attrs, freshId),
      ),
    newStep: () => history.stopCapturing(),
    undo: () => back("undo"),
    redo: () => back("redo"),
    canUndo: () => history.undoStack.length > 0,
    canRedo: () => history.redoStack.length > 0,
  };
}
type Person = ReturnType<typeof person>;

type Piece =
  | string
  | { text: string; marks: SequenceAttrs }
  | { inline: string; attrs: SequenceAttrs };
type Written = [text: string | Piece[], kind: SequenceAttrs, path: string[]];
type Made = { id: string; type: string; attrs: SequenceAttrs };

function note(
  frames: Made[],
  lines: Written[],
  more: Record<string, unknown> = {},
  unbounded = "",
): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const sequence = doc.getText(SEQUENCE);
  const records = doc.getMap(CONTAINERS);
  const element = (name: string, attrs: SequenceAttrs) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs))
      made.setAttribute(key, value as unknown as string);
    sequence.insertEmbed(sequence.length, made, {});
  };
  for (const { id, type, attrs } of frames)
    for (const [key, value] of recordsWanted(id, type, attrs)) records.set(key, value);
  for (const [key, value] of Object.entries(more)) records.set(key, value);
  sequence.insert(0, unbounded, {});
  for (const [text, kind, path] of lines) {
    element(BLOCK_ELEMENT, { ...kind, path });
    for (const piece of typeof text === "string" ? [text] : text)
      if (typeof piece === "string") sequence.insert(sequence.length, piece, {});
      else if ("text" in piece) sequence.insert(sequence.length, piece.text, { ...piece.marks });
      else element(piece.inline, piece.attrs);
  }
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

const IMAGE = { inline: "image", attrs: { src: "a.png", alt: "" } };
const MATH = { inline: "mathInline", attrs: { tex: "x" } };
const BOLD = { bold: {} };
const TIP = { calloutType: "tip", title: "Read me", fold: "+" };

const plainNote = () =>
  note(
    [],
    ["abcd", "efgh", "ijkl"].map((text): Written => [text, PARAGRAPH, []]),
  );

const nestedNote = (unbounded = "") =>
  note(
    [
      { id: "Q", type: "blockquote", attrs: {} },
      { id: "T", type: "taskList", attrs: {} },
      { id: "T1", type: "taskItem", attrs: {} },
      { id: "N", type: "orderedList", attrs: { start: 3n } },
      { id: "N1", type: "listItem", attrs: {} },
      { id: "T2", type: "taskItem", attrs: { checked: true } },
      { id: "C", type: "callout", attrs: TIP },
    ],
    [
      [["a\u{1F600}", { text: "b", marks: BOLD }], PARAGRAPH, []],
      ["cd", { type: "heading", level: 2 }, ["Q"]],
      [["e", IMAGE, "f"], PARAGRAPH, ["Q"]],
      ["gh", PARAGRAPH, ["T", "T1"]],
      ["ij", { type: "heading", level: 3 }, ["T", "T1", "N", "N1"]],
      ["kl", PARAGRAPH, ["T", "T2"]],
      ["mn", PARAGRAPH, ["C"]],
      [["o\u{1F9E9}", MATH, "p"], { type: "codeBlock", language: null }, ["C"]],
      ["qr", PARAGRAPH, ["C"]],
      [[{ text: "st", marks: BOLD }, "u"], PARAGRAPH, []],
    ],
    { "Q.start": 7, "T.title": "kept", "T1.fold": "-", "N.calloutType": "tip", "C.checked": true },
    unbounded,
  );
const twinNote = () =>
  note(
    [
      { id: "C", type: "callout", attrs: TIP },
      { id: "L", type: "bulletList", attrs: {} },
      { id: "I", type: "listItem", attrs: {} },
    ],
    [
      ["ab", PARAGRAPH, ["C"]],
      ["x", PARAGRAPH, []],
      ["cd", PARAGRAPH, ["C"]],
      ["ef", PARAGRAPH, ["L", "I"]],
      ["", PARAGRAPH, []],
      ["gh", PARAGRAPH, ["L", "I"]],
      ["yz", PARAGRAPH, []],
    ],
    { "C.checked": true, "I.title": "kept" },
  );
const STARTS = [plainNote, nestedNote, () => nestedNote("u\u{1F389}v"), twinNote];

function team(count: number, baseline: Uint8Array, gc = true, fault?: Fault) {
  const oracle = new Oracle();
  const base = new Y.Doc();
  Y.applyUpdate(base, baseline);
  const { tokens } = shoot(base);
  oracle.sees(tokens);
  for (const token of tokens)
    if (token.kind === "char") {
      oracle.typed.add(token.id);
      oracle.insertedChars.add(token.id);
    } else oracle.insertedBoundaries.add(token.id);
  base.destroy();
  const people = Array.from({ length: count }, (_, who) =>
    person(baseline, who, oracle, gc, fault),
  );
  return { oracle, people };
}

type Arrive = "one by one" | "merged" | "after a reconnect";

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function deliver(people: Person[], arrive: Arrive, next: () => number) {
  if (arrive === "after a reconnect") {
    for (const each of people) each.sent.length = 0;
    for (let pass = 0; pass < 3; pass++)
      for (const from of people)
        for (const to of people)
          if (from !== to) to.receive(Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
    return;
  }
  if (arrive === "merged")
    for (const each of people)
      if (each.sent.length > 0) each.sent.push(Y.mergeUpdates(each.sent.splice(0)));
  for (;;) {
    const waiting = people.filter((each) => each.sent.length > 0);
    if (waiting.length === 0) return;
    const from = waiting[Math.floor(next() * waiting.length)]!;
    const update = from.sent.shift()!;
    for (const to of people) if (to !== from) to.receive(update);
  }
}

const sorted = (held: Map<string, Held>) => [...held].sort(([a], [b]) => (a < b ? -1 : 1));

function view(doc: Y.Doc): string {
  const shot = shoot(doc);
  const read = readBodySequence(schema, doc);
  try {
    read.check();
  } catch (error) {
    throw new Error(`[1 same note] the note is not a valid document: ${String(error)}`, {
      cause: error,
    });
  }
  return json({
    tokens: shot.tokens.map((token) =>
      token.kind === "boundary"
        ? [token.id, sorted(token.attrs)]
        : [token.id, token.line, token.unit, token.marks, sorted(token.atom?.attrs ?? new Map())],
    ),
    records: sorted(shot.records),
    note: read.toJSON(),
  });
}

function agreed(people: Person[]): Look {
  const first = view(people[0]!.doc);
  for (const each of people) {
    if (view(each.doc) !== first) throw new Error("[1 same note] two people read different notes");
    const reopened = new Y.Doc();
    reopened.getText(SEQUENCE);
    reopened.getMap(CONTAINERS);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(each.doc));
    const again = view(reopened);
    reopened.destroy();
    if (again !== first)
      throw new Error("[1 same note] a note reopened from its full state reads differently");
  }
  return people[0]!.look();
}

function lettersHold(oracle: Oracle, final: Token[]) {
  oracle.sees(final);
  const letters = new Set(final.filter((token) => token.kind === "char").map((token) => token.id));
  for (const id of oracle.insertedChars)
    if (!oracle.deletedChars.has(id) && !letters.has(id))
      throw new Error("[2 letters] a letter no change deleted is gone");
  for (const id of letters)
    if (oracle.deletedChars.has(id) || !oracle.insertedChars.has(id))
      throw new Error("[2 letters] a letter stands that no change left standing");
  const times = new Map<Id, number>();
  for (const id of letters) times.set(oracle.root(id), (times.get(oracle.root(id)) ?? 0) + 1);
  for (const id of oracle.typed)
    if (!oracle.everDeletedChars.has(oracle.root(id)) && times.get(id) !== 1)
      throw new Error(
        `[2 letters] a letter nobody deleted stands ${String(times.get(id) ?? 0)} times in the note`,
      );
  const boundaries = new Set(
    final.filter((token) => token.kind === "boundary").map((token) => token.id),
  );
  for (const id of boundaries)
    if (!oracle.insertedBoundaries.has(id) || oracle.deletedBoundaries.has(id))
      throw new Error("[2 letters] a boundary stands that no change left standing");
  for (const id of oracle.insertedBoundaries)
    if (!oracle.deletedBoundaries.has(id) && !boundaries.has(id))
      throw new Error("[2 letters] a boundary nobody deleted is gone");
  const place = new Map(final.map((token, index) => [token.id, index]));
  for (const snapshot of oracle.snapshots) {
    let last = -1;
    for (const id of snapshot) {
      const at = place.get(id);
      if (at === undefined) continue;
      if (at < last) throw new Error("[2 letters] two things changed order");
      last = at;
    }
  }
}

function settingsHold(people: Person[], oracle: Oracle, lenient: boolean) {
  const doc = people[0]!.doc;
  const shot = shoot(doc);
  const records = doc.getMap(CONTAINERS);
  for (const [key, value] of oracle.asMade)
    if (reads(shot, key, lenient) !== value)
      throw new Error(
        `[4 settings] ${key} was made as ${value} and reads ${String(reads(shot, key, lenient))}, and no one changed it`,
      );
  const elements = new Map(shot.tokens.map((token) => [token.id, attrsOf(token)]));
  const frames = leavesOfSequence(
    schema,
    piecesOfSequence(doc.getText(SEQUENCE), MARKS),
    records,
  ).flatMap((leaf) =>
    leaf.path.map((frame, depth) => ({ frame, under: leaf.path[depth - 1]?.type })),
  );
  for (const each of people)
    for (const [slot, claim] of each.claims) {
      const [kind, name, key] = partsOf(slot);
      const element = kind === "record" ? undefined : elements.get(name);
      const gone = kind !== "record" && !element;
      if (gone || oracle.others(slot, each.who, claim.round)) {
        each.claims.delete(slot);
        continue;
      }
      const held = kind === "record" ? shot.records.get(name) : element!.get(key!);
      oracle.count.settingsChecked++;
      if (held?.value !== claim.value)
        throw new Error(
          `[4 settings] ${slot} reads ${String(held?.value)}; person ${String(each.who)} left it as ${String(claim.value)} and no one else changed it since`,
        );
      if (kind !== "record" || claim.value === undefined) continue;
      const [id, attribute] = name.split(".");
      for (const { frame, under } of frames) {
        if (frame.id !== id) continue;
        const shows =
          attribute === undefined
            ? LISTS.includes(under ?? "") || json(frame.type) === claim.value
            : !(attribute in (schema.nodes[frame.type]!.spec.attrs ?? {})) ||
              json(frame.attrs[attribute]) === claim.value;
        if (!shows)
          throw new Error(`[4 settings] the note does not show ${name} as ${claim.value}`);
      }
    }
}

function recordsKept(doc: Y.Doc) {
  doc.getMap(CONTAINERS)._map.forEach((item, key) => {
    if (item.deleted) throw new Error(`[5 records] the record ${key} is deleted`);
  });
}

function unnamedRecords(doc: Y.Doc) {
  const shot = shoot(doc);
  const named = new Set(rowsOf(shot).flatMap(pathOf));
  const unnamed = [...shot.records].filter(([key]) => !named.has(key.split(".")[0]!));
  const alone = new Y.Doc();
  alone.transact(() => {
    for (const [key, held] of unnamed) alone.getMap(CONTAINERS).set(key, JSON.parse(held.value));
  });
  const unnamedBytes = Y.encodeStateAsUpdate(alone).length;
  alone.destroy();
  return { records: shot.records.size, unnamed: unnamed.length, unnamedBytes };
}

function readsAsWritten(doc: Y.Doc, look: Look, faithful: boolean, lenient: boolean) {
  if (blocksRead(doc) !== json(look.lines.map((line) => [line.type, line.units])))
    throw new Error("[1 same note] the model's lines are not the blocks the reader gives");
  writerAgrees(doc, look);
  look.rows.forEach((row, at) => {
    const path = look.frames[at]!;
    if (faithful && row.boundary !== null && json(pathOf(row)) !== json(idsOf(path)))
      throw new Error("[writer] a path does not read as it was written");
    for (const { id, type } of lenient ? [] : path)
      for (const key of recordsWanted(id, type, {}).keys())
        if (!look.shot.records.has(key))
          throw new Error(`[4 settings] the ${type} ${id} has no record ${key.slice(id.length)}`);
  });
}

function settled(people: Person[], oracle: Oracle, fault?: Fault) {
  const final = agreed(people);
  lettersHold(oracle, final.shot.tokens);
  settingsHold(people, oracle, LENIENT.includes(fault));
  for (const each of people) recordsKept(each.doc);
  kindsHold(final.shot);
  readsAsWritten(people[0]!.doc, final, fault === undefined, LENIENT.includes(fault));
  if (twinsIn(final) > 0) oracle.count.roundsWithOneIdOnTwo++;
  oracle.round++;
}

const CALLOUT_KINDS = ["note", "tip", "warning"];
const TITLES = ["", "Read me", "Danger"];
const FOLDS = ["", "+", "-"];
const LINK = { link: { href: "https://example.com" } };
const MARK_SETS: SequenceAttrs[] = [
  {},
  {},
  {},
  BOLD,
  { italic: {} },
  { ...BOLD, italic: {} },
  LINK,
];
const MARK_CHANGES: SequenceAttrs[] = [
  BOLD,
  { bold: null },
  { italic: {} },
  { italic: null },
  LINK,
  { link: null },
];
const SPLIT_KINDS: (SequenceAttrs | undefined)[] = [
  undefined,
  undefined,
  undefined,
  PARAGRAPH,
  { type: "heading", level: 2 },
  { type: "codeBlock" },
];

type Weights = {
  wraps: number;
  kindsOfTheFirstLine: number;
  kindsOfBlocksWithMore: number;
  inlines: number;
  undos: number;
};
const EVEN: Weights = {
  wraps: 1,
  kindsOfTheFirstLine: 0,
  kindsOfBlocksWithMore: 0,
  inlines: 1,
  undos: 0.16,
};
const WITH_MORE: Weights = { ...EVEN, kindsOfBlocksWithMore: 30 };
const ONE_LINE: Weights = { ...EVEN, kindsOfTheFirstLine: 600, undos: 0.4 };
const INLINES: Weights = { ...EVEN, inlines: 12, undos: 0.3 };

function change(
  each: Person,
  next: () => number,
  letter: () => string,
  log: string[],
  { wraps, kindsOfTheFirstLine, kindsOfBlocksWithMore, inlines }: Weights,
) {
  const pick = (below: number) => Math.floor(next() * below);
  const tried = (what: unknown[], run: () => boolean) => {
    log.push(`${String(each.who)}:${what.join(" ")}`);
    if (run()) return true;
    log.pop();
    return false;
  };
  const { lines, shot } = each.look();
  const bare = lines.flatMap((held, index) =>
    held.bare === "" ? [] : held.bare === "spill" ? [index - 1, index] : [index],
  );
  const at = bare.length > 0 && pick(4) === 0 ? bare[pick(bare.length)]! : pick(lines.length);
  const line = lines[at]!;
  const length = line.chars.length;
  const depth = pick(line.path.length + 1);
  const spot = (...types: string[]) => {
    const found: { at: number; depth: number; id: string; type: string }[] = [];
    const seen = new Set<number>();
    lines.forEach((held, index) =>
      held.path.forEach((frame, level) => {
        if (seen.has(frame.key) || !types.includes(frame.type)) return;
        seen.add(frame.key);
        found.push({ at: index, depth: level, id: frame.id, type: frame.type });
      }),
    );
    return found[pick(found.length)];
  };
  const typing = () => {
    const offset = pick(length + 1);
    const marks = MARK_SETS[pick(MARK_SETS.length)]!;
    return tried(["type", at, offset, json(marks)], () => each.type(at, offset, letter(), marks));
  };
  const options: [number, () => boolean][] = [
    [14, typing],
    [
      4,
      () => {
        const offset = pick(length + 1);
        const { inline, attrs } = [IMAGE, MATH][pick(2)]!;
        return tried(["place", at, offset, inline], () => each.place(at, offset, inline, attrs));
      },
    ],
    [
      5 * inlines,
      () => {
        const items = lines.flatMap((held, index) =>
          held.chars.flatMap((id, offset) =>
            held.units[offset] === OBJECT ? [{ index, offset, id }] : [],
          ),
        );
        const item = items[pick(items.length)];
        const token = shot.tokens.find((one) => one.id === item?.id);
        if (!item || token?.kind !== "char") return false;
        const attrs =
          token.atom?.name === "image"
            ? [{ title: "A cat" }, { title: "A dog" }, { alt: "seen" }][pick(3)]!
            : { tex: `y^${String(pick(3))}` };
        return tried(["inline", item.index, item.offset, json(attrs)], () =>
          each.inline(item.index, item.offset, attrs),
        );
      },
    ],
    [
      5,
      () => {
        const offset = pick(length + 1);
        const count = Math.min(1 + pick(3), length - offset);
        const marks = MARK_CHANGES[pick(MARK_CHANGES.length)]!;
        return tried(["mark", at, offset, count, json(marks)], () =>
          each.mark(at, offset, count, marks),
        );
      },
    ],
    [
      4,
      () => {
        const offset = pick(length + 1);
        const end = offset + Math.min(1 + pick(2), length - offset);
        return tried(["erase", at, offset, at, end], () => each.erase(at, offset, at, end));
      },
    ],
    [3, () => tried(["erase", at, 0, at, length], () => each.erase(at, 0, at, length))],
    [
      4,
      () => {
        const offset = pick(length + 1);
        const toAt = Math.min(lines.length - 1, at + 1 + pick(2));
        const toOffset = pick(lines[toAt]!.chars.length + 1);
        return tried(["erase", at, offset, toAt, toOffset], () =>
          each.erase(at, offset, toAt, toOffset),
        );
      },
    ],
    [
      11,
      () => {
        const pair = line.units.search(HIGH_HALF);
        const insideALetter = pair < 0 ? 0 : pair + 1;
        const offset = [0, length, pick(length + 1), insideALetter][pick(4)]!;
        const kind = SPLIT_KINDS[pick(SPLIT_KINDS.length)];
        return tried(["split", at, offset, json(kind)], () => each.split(at, offset, kind));
      },
    ],
    [8, () => tried(["join", at], () => each.join(at))],
    [
      11 * wraps,
      () => {
        const count = 1 + pick(3);
        const start = 1 + pick(5);
        const [type, attrs] = (
          [
            ["blockquote", {}],
            [
              "callout",
              { calloutType: CALLOUT_KINDS[pick(3)], title: TITLES[pick(3)], fold: FOLDS[pick(3)] },
            ],
            ["bulletList", {}],
            ["orderedList", { start: start % 2 === 0 ? BigInt(start) : start }],
            ["taskList", {}],
          ] as [string, SequenceAttrs][]
        )[pick(5)]!;
        return tried(["wrap", at, depth, count, type, json(attrs)], () =>
          each.wrap(at, depth, count, type, attrs),
        );
      },
    ],
    [
      8 * wraps,
      () => {
        const from = 1 + pick(line.path.length);
        const count = 1 + pick(2);
        return tried(["lift", at, from, count], () => each.lift(at, from, count));
      },
    ],
    [
      6,
      () => {
        const item = spot(...ITEMS);
        return (
          item !== undefined &&
          tried(["indent", item.at, item.depth], () => each.indent(item.at, item.depth))
        );
      },
    ],
    [
      6,
      () => {
        const item = spot(...ITEMS);
        return (
          item !== undefined &&
          tried(["outdent", item.at, item.depth], () => each.outdent(item.at, item.depth))
        );
      },
    ],
    [
      6,
      () => {
        const list = spot(...LISTS);
        if (!list) return false;
        const type = LISTS.filter((kind) => kind !== list.type)[pick(2)]!;
        return tried(["list", list.at, list.depth, type], () =>
          each.containerKind(list.at, list.depth, type),
        );
      },
    ],
    [
      3,
      () => {
        const box = spot("blockquote", "callout");
        if (!box) return false;
        const type = box.type === "callout" ? "blockquote" : "callout";
        return tried(["box", box.at, box.depth, type], () =>
          each.containerKind(box.at, box.depth, type),
        );
      },
    ],
    [
      7,
      () => {
        const item = spot("taskItem");
        if (!item) return false;
        const checked = each.records.get(`${item.id}.checked`) !== true;
        return tried(["tick", item.at, item.depth, checked], () =>
          each.containerAttrs(item.at, item.depth, { checked }),
        );
      },
    ],
    [
      6,
      () => {
        const callout = spot("callout");
        if (!callout) return false;
        const attrs = [
          { title: TITLES[pick(3)] },
          { calloutType: CALLOUT_KINDS[pick(3)] },
          { fold: FOLDS[pick(3)] },
        ][pick(3)]!;
        return tried(["callout", callout.at, callout.depth, json(attrs)], () =>
          each.containerAttrs(callout.at, callout.depth, attrs),
        );
      },
    ],
    [
      3,
      () => {
        const list = spot("orderedList");
        if (!list) return false;
        const start = 1 + pick(9);
        const asked = start % 3 === 0 ? BigInt(start) : start;
        return tried(["start", list.at, list.depth, start], () =>
          each.containerAttrs(list.at, list.depth, { start: asked }),
        );
      },
    ],
    [
      6 + kindsOfTheFirstLine + kindsOfBlocksWithMore,
      () => {
        const level = 1 + pick(3);
        const kind = [
          PARAGRAPH,
          { type: "heading" },
          { type: "heading", level },
          { level },
          { type: "codeBlock" },
          { type: "codeBlock", language: "ts" },
        ][pick(6)]!;
        const roll = next() * (6 + kindsOfTheFirstLine + kindsOfBlocksWithMore);
        const withMore = lines.findIndex((_, index) => lines[index + 1]?.bare === "spill");
        const loaded = roll < 6 + kindsOfTheFirstLine || withMore < 0 ? 0 : withMore;
        const which = roll < 6 ? at : loaded;
        return tried(["kind", which, json(kind)], () => each.kind(which, kind));
      },
    ],
  ];
  let roll = next() * options.reduce((sum, [weight]) => sum + weight, 0);
  const chosen = options.find(([weight]) => (roll -= weight) < 0) ?? options[0]!;
  if (!chosen[1]() && !typing()) tried(["type", at, 0], () => each.type(at, 0, letter()));
}

function act(
  each: Person,
  next: () => number,
  letter: () => string,
  log: string[],
  weights = EVEN,
) {
  if (next() < 0.4) {
    log.push(`${String(each.who)}:step`);
    each.newStep();
  }
  const roll = next();
  if (roll < weights.undos && each.canUndo()) {
    log.push(`${String(each.who)}:undo`);
    each.undo();
  } else if (roll < weights.undos + 0.07 && each.canRedo()) {
    log.push(`${String(each.who)}:redo`);
    each.redo();
  } else change(each, next, letter, log, weights);
}

const FACES = ["\u{1F600}", "\u{1F389}", "\u{1F9E9}"];
const lettersFrom = () => {
  let typed = 0;
  return () => (typed++ % 5 === 4 ? FACES[typed % 3]! : String.fromCharCode(0x391 + (typed % 600)));
};

type Run = {
  seed: number;
  count: number;
  arrive: Arrive;
  rounds: number;
  busiest: number;
  gc: boolean;
  fault?: Fault;
  weights?: Weights;
  start?: number;
};

function randomRun(run: Run): Tally {
  const { seed, count, arrive, rounds, busiest, gc, fault, weights } = run;
  const next = random(seed);
  const baseline = STARTS[run.start ?? seed % STARTS.length]!();
  const { oracle, people } = team(count, baseline, gc, fault);
  const log: string[] = [];
  const letter = lettersFrom();
  try {
    for (let round = 0; round < rounds; round++) {
      for (const each of people)
        for (let changes = 1 + Math.floor(next() * busiest); changes > 0; changes--)
          act(each, next, letter, log, weights);
      log.push("|");
      deliver(people, arrive, next);
      settled(people, oracle, fault);
    }
  } catch (error) {
    throw new Error(
      `seed ${String(seed)}, gc ${String(gc)}: ${log.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { records, unnamed } = unnamedRecords(people[0]!.doc);
  for (const doc of docs.splice(0)) doc.destroy();
  return { ...oracle.count, runs: 1, records, unnamedRecords: unnamed };
}

function add(total: Tally, more: Tally) {
  for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += more[key];
}

it("states the kinds, records and marks the editor's schema has", () => {
  const unset = (types: string[]) =>
    Object.fromEntries(
      types.flatMap((type) =>
        Object.entries(schema.nodes[type]!.spec.attrs ?? {}).map(([key, spec]) => [
          key,
          (spec as { default?: unknown }).default ?? null,
        ]),
      ),
    );
  for (const [type, attrs] of Object.entries({ ...LEAF_KINDS, ...INLINE }))
    expect(unset([type]), type).toEqual(attrs);
  expect(unset(["blockquote", "callout"])).toEqual(BOX);
  expect(unset(LISTS)).toEqual(LIST);
  expect(unset(ITEMS)).toEqual(ITEM);
  expect(new Set(Object.keys(schema.marks))).toEqual(MARKS);
  for (const type of Object.keys(LEAF_KINDS)) {
    const node = schema.nodes[type]!;
    expect(node.isTextblock, type).toBe(HOLDS_LETTERS.includes(type));
    expect(node.contentMatch.matchType(schema.nodes.image!) !== null, type).toBe(
      HOLDS_INLINE.includes(type),
    );
  }
});

const SEEDS = Number(process.env.BODY_CONTAINERS_SEEDS ?? 20);
const WEIGHTS = process.env.BODY_CONTAINERS_ONE_LINE ? ONE_LINE : EVEN;
const FIRST = Number(process.env.BODY_CONTAINERS_FIRST ?? 1);
const ROUNDS = Number(process.env.BODY_CONTAINERS_ROUNDS ?? 0);
const BUSIEST = Number(process.env.BODY_CONTAINERS_BUSIEST ?? 0);
const SETUPS = (
  [
    [2, "one by one", 6, 3],
    [2, "merged", 6, 3],
    [2, "after a reconnect", 6, 3],
    [3, "one by one", 4, 3],
    [3, "merged", 4, 6],
    [3, "after a reconnect", 4, 3],
    [4, "one by one", 3, 3],
    [4, "merged", 3, 3],
    [4, "after a reconnect", 3, 6],
  ] as [number, Arrive, number, number][]
).map(
  ([count, arrive, rounds, busiest]) =>
    [count, arrive, ROUNDS || rounds, BUSIEST || busiest] as const,
);

it.each(SETUPS)(
  "random changes to lines and containers by %i people, arriving %s, %i rounds of up to %i changes each",
  (count, arrive, rounds, busiest) => {
    const total = tally();
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++)
      for (const gc of [true, false])
        add(total, randomRun({ seed, count, arrive, rounds, busiest, gc, weights: WEIGHTS }));
    console.log(
      `${String(count)} people, ${arrive}, ${String(rounds)} rounds of up to ${String(busiest)}: ${json(total)}`,
    );
    expect(total.runs).toBe(2 * SEEDS);
  },
  600_000,
);

const BREAKAGE_SCALE = Number(process.env.BODY_CONTAINERS_BREAKAGE_SEEDS ?? 1);
const NESTED = STARTS.indexOf(nestedNote);
const TWINS = STARTS.indexOf(twinNote);
type Breakage = [Fault, string, { seeds: number; weights?: Weights; start?: number }];
const BREAKAGES: Breakage[] = [
  [FAULT.defaultMapUndo, "[3 undo]", { seeds: 12 }],
  [FAULT.noDeleteFilter, "[5 records] the record", { seeds: 3 }],
  [FAULT.recordsOnlyFilter, "[7 kind] a", { seeds: 15, weights: ONE_LINE }],
  [FAULT.inlineAttributesKept, "[3 undo] undo passed over", { seeds: 5, weights: INLINES }],
  [FAULT.typeRecordOnly, "[3 undo] or [4 settings]", { seeds: 10 }],
  [FAULT.defaultFirst, "[4 settings]", { seeds: 5 }],
  [FAULT.noLooseRecord, "[4 settings] asked for a", { seeds: 2 }],
  [FAULT.oldBoundaryAbove, "[writer] after a split", { seeds: 2 }],
  [FAULT.splitAlwaysParagraph, "[7 kind] after a split", { seeds: 3 }],
  [
    FAULT.oneRecordForTwins,
    "[writer] a setting changed on a container it was not made on",
    { seeds: 5 },
  ],
  [FAULT.noKindDefaults, "[7 kind] after a", { seeds: 3 }],
  [FAULT.splitInsideLetter, "[2 letters] a letter changed", { seeds: 8 }],
  [FAULT.alwaysLowerBoundary, "[writer] after a join", { seeds: 12 }],
  [
    FAULT.twinsJoined,
    "[writer] a change made two containers that share an id read as one",
    { seeds: 6, start: TWINS },
  ],
  [FAULT.wrongSetting, "[4 settings] asked for", { seeds: 2 }],
  [FAULT.deleteAndRecreate, "[5 records] a writer deleted a record", { seeds: 2 }],
  [FAULT.copyKnownAttributes, "[4 settings] the fresh id", { seeds: 3 }],
  [FAULT.typingInheritsMarks, "[2 letters] letters typed with the marks", { seeds: 2 }],
  [
    FAULT.spillLeftBare,
    "[writer] after a change of kind",
    { seeds: 3, weights: WITH_MORE, start: NESTED },
  ],
  [FAULT.addedParagraphBare, "[writer] after typing", { seeds: 2 }],
];

it.each(BREAKAGES)(
  "fails when broken on purpose with %s, at check %s",
  (fault, check, { seeds: few, weights, start }) => {
    const fired = new Map<string, number>();
    let asExpected = 0;
    const seeds = Math.ceil(few * BREAKAGE_SCALE);
    for (let seed = 1; seed <= seeds; seed++)
      for (const [count, arrive, rounds, busiest] of SETUPS) {
        try {
          const gc = seed % 2 === 0;
          randomRun({ seed, count, arrive, rounds, busiest, gc, fault, weights, start });
        } catch (error) {
          const said = /\n(\[[^\]]+\]) ?(.*)/.exec(String(error)) ?? [];
          const message = `${String(said[1])} ${String(said[2])}`;
          if (check.split(" or ").some((one) => message.startsWith(one))) asExpected++;
          const which = process.env.BODY_CONTAINERS_BREAKAGE_DETAIL
            ? `${String(said[1])} ${String(said[2]).replace(/\d+:\d+|\b[wxyz][0-9a-z]+\b/g, "_")}`
            : String(said[1]);
          fired.set(which, (fired.get(which) ?? 0) + 1);
        }
        for (const doc of docs.splice(0)) doc.destroy();
      }
    console.log(
      `${fault}, ${String(seeds * SETUPS.length)} runs:\n${[...fired].map(([which, runs]) => `  ${String(runs)} ${which}`).join("\n")}`,
    );
    expect(asExpected).toBeGreaterThan(0);
  },
  600_000,
);

const LONG_RUN = Number(process.env.BODY_CONTAINERS_LONG_RUN ?? 1000);

it("counts the records no path names while one person wraps, lifts and undoes", () => {
  const next = random(11);
  const { oracle, people } = team(1, plainNote());
  const only = people[0]!;
  const log: string[] = [];
  const letter = lettersFrom();
  const growth: string[] = [];
  for (let changes = 1; changes <= LONG_RUN; changes++) {
    act(only, next, letter, log, { ...EVEN, wraps: 4 });
    if (changes % (LONG_RUN / 4) !== 0) continue;
    settled(people, oracle);
    const { frames } = only.look();
    const kept = open(Y.encodeStateAsUpdate(only.doc), 99);
    growth.push(
      json({
        changes,
        lines: frames.length,
        deepest: Math.max(...frames.map((path) => path.length)),
        ...unnamedRecords(only.doc),
        bytesWithOwnHistory: Y.encodeStateAsUpdate(only.doc).length,
        bytesForSomeoneElse: Y.encodeStateAsUpdate(kept).length,
      }),
    );
  }
  console.log(`one person, ${json(oracle.count)}\n${growth.join("\n")}`);
  expect(unnamedRecords(only.doc).records).toBeLessThan(10 * LONG_RUN);
}, 600_000);

const open = (baseline: Uint8Array, clientID: number) => {
  const doc = new Y.Doc();
  docs.push(doc);
  doc.clientID = clientID;
  doc.getText(SEQUENCE);
  doc.getMap(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  return doc;
};
const exchange = (left: Y.Doc, right: Y.Doc) => {
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left, Y.encodeStateVector(right)), REMOTE);
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)), REMOTE);
};
const written = (doc: Y.Doc, plan: BodyWrites | null) => {
  if (plan) doc.transact(() => writeBody(doc, plan), LOCAL);
  return plan !== null;
};
const pathsOf = (doc: Y.Doc) => lookAt(doc).frames.map(idsOf);
const storedOf = (attrs: Map<string, Held>) =>
  Object.fromEntries([...attrs].map(([key, held]) => [key, JSON.parse(held.value) as unknown]));
const storedLines = (doc: Y.Doc) =>
  lookAt(doc).rows.map((row) =>
    row.boundary === null ? null : { ...storedOf(row.attrs), text: row.units },
  );
const rowsRead = (doc: Y.Doc) =>
  lookAt(doc).rows.map((row) => {
    const kind = `${String(storedOf(row.attrs).type)} ${pathOf(row).join("/")}`;
    return `${row.boundary === null ? "" : kind}:${row.units}`;
  });
const linesRead = (doc: Y.Doc) =>
  lookAt(doc).lines.map((line) => `${line.bare || "line"} ${line.type}:${line.units}`);
type Block = {
  type: string;
  attrs?: SequenceAttrs;
  content?: { type: string; text?: string; marks?: { type: string }[] }[];
};
const blocksOf = (doc: Y.Doc) =>
  (readBodySequence(schema, doc).toJSON() as { content: Block[] }).content;
const titlesOf = (doc: Y.Doc) =>
  blocksOf(doc).map((block) => (block.type === "callout" ? block.attrs?.title : block.type));
const textsOf = (doc: Y.Doc) =>
  blocksOf(doc).map((block) => `${block.type}:${block.content?.[0]?.text ?? ""}`);
const recordsOf = (doc: Y.Doc, id: string) =>
  Object.fromEntries(
    [...doc.getMap(CONTAINERS)].flatMap(([key, value]) =>
      key.startsWith(`${id}.`) ? [[key.slice(id.length + 1), value]] : [],
    ),
  );
const FACE = "\u{1F600}";

it("refuses a split, a delete, typing and marks between the two units of a surrogate pair", () => {
  const doc = open(note([], [[`a${FACE}b`, PARAGRAPH, []]]), 10);
  const text = () => lookAt(doc).rows.map((row) => row.units);
  expect(splitLine(schema, doc, 0, 2, String)).toBeNull();
  expect(deleteRange(schema, doc, 0, 1, 0, 2, String)).toBeNull();
  expect(deleteRange(schema, doc, 0, 2, 0, 3, String)).toBeNull();
  expect(deleteRange(schema, doc, 0, 2, 0, 4, String)).toBeNull();
  expect(typeLetters(schema, doc, 0, 2, "x", {})).toBeNull();
  expect(typeLetters(schema, doc, 0, 1, FACE[0]!, {})).toBeNull();
  expect(setMarks(schema, doc, 0, 0, 2, BOLD)).toBeNull();
  expect(text()).toEqual([`a${FACE}b`]);
  expect(written(doc, typeLetters(schema, doc, 0, 3, FACE, {}))).toBe(true);
  expect(written(doc, setMarks(schema, doc, 0, 1, 2, BOLD))).toBe(true);
  expect(written(doc, splitLine(schema, doc, 0, 3, String))).toBe(true);
  expect(written(doc, deleteRange(schema, doc, 0, 1, 0, 3, String))).toBe(true);
  expect(text()).toEqual(["a", `${FACE}b`]);
  expect(textsOf(doc)).toEqual(["paragraph:a", `paragraph:${FACE}b`]);
});

it("undoes a title given to an image that had none, and leaves the typing before it", () => {
  const doc = open(note([], [[["a", IMAGE], PARAGRAPH, []]]), 10);
  const history = bodyHistory(doc, LOCAL, NEVER_ELAPSES);
  const image = () => {
    const token = shoot(doc).tokens.find((each) => each.kind === "char" && each.atom);
    return storedOf(attrsOf(token!)!);
  };
  written(doc, typeLetters(schema, doc, 0, 0, "X", {}));
  history.stopCapturing();
  expect(written(doc, setInlineAttributes(schema, doc, 0, 2, { title: "A cat" }))).toBe(true);
  expect(setInlineAttributes(schema, doc, 0, 2, { title: "A cat" })).toBeNull();
  expect(image()).toEqual({ src: "a.png", alt: "", title: "A cat" });
  history.undo();
  expect(image()).toEqual({ src: "a.png", alt: "" });
  expect(rowsRead(doc)).toEqual([`paragraph :Xa${OBJECT}`]);
  history.undo();
  expect(rowsRead(doc)).toEqual([`paragraph :a${OBJECT}`]);
  history.redo();
  history.redo();
  expect(image()).toEqual({ src: "a.png", alt: "", title: "A cat" });
  expect(rowsRead(doc)).toEqual([`paragraph :Xa${OBJECT}`]);
});

it("types letters with the marks it is given, whatever the letters around them hold", () => {
  const doc = open(note([], [[[{ text: "abc", marks: BOLD }, "def"], PARAGRAPH, []]]), 10);
  const runs = () =>
    blocksOf(doc)[0]!.content!.map(
      (run) => `${run.text!}${(run.marks ?? []).map((mark) => `/${mark.type}`).join("")}`,
    );
  expect(written(doc, typeLetters(schema, doc, 0, 1, "X", {}))).toBe(true);
  expect(runs()).toEqual(["a/bold", "X", "bc/bold", "def"]);
  expect(written(doc, typeLetters(schema, doc, 0, 6, "Y", BOLD))).toBe(true);
  expect(runs()).toEqual(["a/bold", "X", "bc/bold", "de", "Y/bold", "f"]);
  expect(written(doc, typeLetters(schema, doc, 0, 3, "Z", { italic: {} }))).toBe(true);
  expect(runs()).toEqual(["a/bold", "X", "b/bold", "Z/italic", "c/bold", "de", "Y/bold", "f"]);
  expect(written(doc, setMarks(schema, doc, 0, 0, 3, { bold: null, italic: {} }))).toBe(true);
  expect(runs()).toEqual(["aXbZ/italic", "c/bold", "de", "Y/bold", "f"]);
});

const unboundedNote = () => note([], [["d", PARAGRAPH, []]], {}, "abc");

it.each([
  [
    "a split at offset 0 gives it a boundary and the empty line above it another",
    (doc: Y.Doc) => splitLine(schema, doc, 0, 0, String),
    ["paragraph:", "paragraph:abc", "paragraph:d"],
  ],
  [
    "a change of kind gives it a boundary of that kind",
    (doc: Y.Doc) => setLineKind(schema, doc, 0, { type: "heading", level: 2 }),
    ["heading:abc", "paragraph:d"],
  ],
  [
    "a wrap gives it a boundary with the quote in its path",
    (doc: Y.Doc) => wrapBlocks(schema, doc, 0, 0, 1, "blockquote", {}, () => "q"),
    ["blockquote:", "paragraph:d"],
  ],
  [
    "a delete of all it holds gives it a boundary, so the empty line stays",
    (doc: Y.Doc) => deleteRange(schema, doc, 0, 0, 0, 3, String),
    ["paragraph:", "paragraph:d"],
  ],
] as [string, (doc: Y.Doc) => BodyWrites | null, string[]][])(
  "text before the first boundary: %s",
  (_, plan, read) => {
    const doc = open(unboundedNote(), 10);
    const history = bodyHistory(doc, LOCAL);
    expect(storedLines(doc)[0]).toBeNull();
    expect(written(doc, plan(doc))).toBe(true);
    expect(textsOf(doc)).toEqual(read);
    const lines = storedLines(doc);
    expect(lines.every((line) => line !== null && "type" in line && "path" in line)).toBe(true);
    expect(lines).toHaveLength(read.length);
    history.undo();
    expect(storedLines(doc)).toEqual([null, { type: "paragraph", path: [], text: "d" }]);
    expect(lookAt(doc).rows[0]!.units).toBe("abc");
  },
);

it.each([
  [10, 20, ["heading:", "codeBlock:abc", "paragraph:d"], ["heading:Xabc", "paragraph:d"]],
  [
    20,
    10,
    ["codeBlock:", "heading:abc", "paragraph:d"],
    ["paragraph:X", "heading:abc", "paragraph:d"],
  ],
])(
  "text before the first boundary, when %i gives it a boundary while %i gives it one too, or types at its start",
  (one, other, bothBounded, typed) => {
    const heading = (doc: Y.Doc) => setLineKind(schema, doc, 0, { type: "heading", level: 2 });
    const first = open(unboundedNote(), one);
    const second = open(unboundedNote(), other);
    written(first, heading(first));
    written(second, setLineKind(schema, second, 0, { type: "codeBlock" }));
    exchange(first, second);
    expect(textsOf(first)).toEqual(bothBounded);
    expect(view(first)).toBe(view(second));
    const third = open(unboundedNote(), one);
    const fourth = open(unboundedNote(), other);
    written(third, heading(third));
    written(fourth, typeLetters(schema, fourth, 0, 0, "X", {}));
    exchange(third, fourth);
    expect(textsOf(third)).toEqual(typed);
    expect(view(third)).toBe(view(fourth));
  },
);

it("splits a note that holds nothing into two empty lines, each with a boundary", () => {
  const doc = open(note([], []), 10);
  expect(readBody(schema, doc)).toHaveLength(1);
  expect(written(doc, splitLine(schema, doc, 0, 0, String))).toBe(true);
  expect(storedLines(doc)).toEqual([
    { type: "paragraph", path: [], text: "" },
    { type: "paragraph", path: [], text: "" },
  ]);
  expect(textsOf(doc)).toEqual(["paragraph:", "paragraph:"]);
});

const itemNote = () =>
  note(
    [
      { id: "L", type: "bulletList", attrs: {} },
      { id: "I", type: "listItem", attrs: {} },
    ],
    [
      ["head", { type: "heading", level: 2 }, ["L", "I"]],
      ["tail", PARAGRAPH, ["L", "I"]],
    ],
  );

it("gives a list item's added first paragraph a boundary when a change needs one", () => {
  const fresh = () => open(itemNote(), 10);
  const first = fresh();
  expect(linesRead(first)).toEqual(["item paragraph:", "line heading:head", "line paragraph:tail"]);
  expect(readBody(schema, first).map((line) => line.bare)).toEqual(["item", "", ""]);

  expect(written(first, typeLetters(schema, first, 0, 0, "X", {}))).toBe(true);
  expect(rowsRead(first)).toEqual(["paragraph L/I:X", "heading L/I:head", "paragraph L/I:tail"]);
  expect(linesRead(first)).toEqual([
    "line paragraph:X",
    "line heading:head",
    "line paragraph:tail",
  ]);

  const split = fresh();
  expect(
    written(
      split,
      splitLine(schema, split, 0, 0, () => "new"),
    ),
  ).toBe(true);
  expect(rowsRead(split)).toEqual([
    "paragraph L/I:",
    "paragraph L/new:",
    "heading L/new:head",
    "paragraph L/new:tail",
  ]);

  const joined = fresh();
  expect(joinLine(schema, joined, 0, String)).toBeNull();
  expect(written(joined, joinLine(schema, joined, 1, String))).toBe(true);
  expect(rowsRead(joined)).toEqual(["paragraph L/I:head", "paragraph L/I:tail"]);
  expect(linesRead(joined)).toEqual(["line paragraph:head", "line paragraph:tail"]);

  const deleted = fresh();
  expect(written(deleted, deleteRange(schema, deleted, 0, 0, 1, 4, String))).toBe(true);
  expect(rowsRead(deleted)).toEqual(["paragraph L/I:", "paragraph L/I:tail"]);

  const kept = fresh();
  expect(setLineKind(schema, kept, 0, { type: "heading" })).toBeNull();
  expect(wrapBlocks(schema, kept, 0, 2, 1, "blockquote", {}, () => "alone")).toBeNull();
  expect(
    written(
      kept,
      wrapBlocks(schema, kept, 0, 0, 1, "blockquote", {}, () => "q"),
    ),
  ).toBe(true);
  expect(rowsRead(kept)).toEqual(["heading q/L/I:head", "paragraph q/L/I:tail"]);
});

const codeNote = () =>
  note(
    [],
    [
      ["top", PARAGRAPH, []],
      [["co", MATH, "de"], { type: "codeBlock", language: "ts" }, []],
      ["z", PARAGRAPH, []],
    ],
  );

it("gives the paragraph after a code block a boundary when a change needs one", () => {
  const fresh = () => open(codeNote(), 10);
  const rest = `${OBJECT}de`;
  const others = (doc: Y.Doc) => rowsRead(doc).slice(1, -1);
  const first = fresh();
  expect(linesRead(first)).toEqual([
    "line paragraph:top",
    "line codeBlock:co",
    `spill paragraph:${rest}`,
    "line paragraph:z",
  ]);

  expect(written(first, typeLetters(schema, first, 2, 0, "X", {}))).toBe(true);
  expect(others(first)).toEqual(["codeBlock :co", `paragraph :X${rest}`]);
  const inCode = fresh();
  expect(written(inCode, typeLetters(schema, inCode, 1, 2, "X", {}))).toBe(true);
  expect(linesRead(inCode).slice(1, 3)).toEqual(["line codeBlock:coX", `spill paragraph:${rest}`]);
  expect(insertInline(schema, inCode, 1, 1, "image", IMAGE.attrs)).toBeNull();

  const atEnd = fresh();
  expect(written(atEnd, splitLine(schema, atEnd, 1, 2, String, PARAGRAPH))).toBe(true);
  expect(others(atEnd)).toEqual(["codeBlock :co", "paragraph :", `paragraph :${rest}`]);
  const atStart = fresh();
  expect(written(atStart, splitLine(schema, atStart, 2, 0, String))).toBe(true);
  expect(others(atStart)).toEqual(["codeBlock :co", "paragraph :", `paragraph :${rest}`]);
  const inside = fresh();
  expect(written(inside, splitLine(schema, inside, 2, 2, String))).toBe(true);
  expect(others(inside)).toEqual([`codeBlock :co${OBJECT}d`, "paragraph :e"]);

  const joined = fresh();
  expect(joinLine(schema, joined, 2, String)).toBeNull();
  expect(written(joined, joinLine(schema, joined, 1, String))).toBe(true);
  expect(rowsRead(joined)).toEqual(["paragraph :topco", `paragraph :${rest}`, "paragraph :z"]);
  const below = fresh();
  expect(written(below, joinLine(schema, below, 3, String))).toBe(true);
  expect(linesRead(below).slice(1)).toEqual(["line codeBlock:co", `spill paragraph:${rest}z`]);

  const block = fresh();
  expect(written(block, setLineKind(schema, block, 1, PARAGRAPH))).toBe(true);
  expect(others(block)).toEqual(["paragraph :co", `paragraph :${rest}`]);
  const language = fresh();
  expect(written(language, setLineKind(schema, language, 1, { language: null }))).toBe(true);
  expect(others(language)).toEqual([`codeBlock :co${rest}`]);
  const own = fresh();
  expect(written(own, setLineKind(schema, own, 2, { type: "heading" }))).toBe(true);
  expect(others(own)).toEqual(["codeBlock :co", `heading :${rest}`]);
  expect(storedLines(own)[2]).toMatchObject({ type: "heading", level: 1, path: [] });

  const deleted = fresh();
  expect(written(deleted, deleteRange(schema, deleted, 0, 1, 1, 1, String))).toBe(true);
  expect(rowsRead(deleted)).toEqual(["paragraph :to", `paragraph :${rest}`, "paragraph :z"]);
});

it("deletes from an added first paragraph into the paragraph after the item's first line", () => {
  const baseline = note(
    [
      { id: "L", type: "bulletList", attrs: {} },
      { id: "I", type: "listItem", attrs: {} },
      { id: "C", type: "callout", attrs: TIP },
    ],
    [
      [["co", MATH, "de"], { type: "codeBlock", language: null }, ["L", "I", "C"]],
      ["z", PARAGRAPH, []],
    ],
  );
  const doc = open(baseline, 10);
  expect(linesRead(doc).slice(0, 3)).toEqual([
    "item paragraph:",
    "line codeBlock:co",
    `spill paragraph:${OBJECT}de`,
  ]);
  expect(written(doc, deleteRange(schema, doc, 0, 0, 2, 2, String))).toBe(true);
  expect(rowsRead(doc)).toEqual(["paragraph L/I:e", "paragraph :z"]);
  const kept = open(baseline, 20);
  expect(written(kept, deleteRange(schema, kept, 0, 0, 1, 1, String))).toBe(true);
  expect(rowsRead(kept)).toEqual([
    "paragraph L/I:o",
    `paragraph L/I/C:${OBJECT}de`,
    "paragraph :z",
  ]);
  const upTo = open(codeNote(), 30);
  expect(written(upTo, deleteRange(schema, upTo, 0, 1, 2, 0, String))).toBe(true);
  expect(rowsRead(upTo)).toEqual(["paragraph :t", `paragraph :${OBJECT}de`, "paragraph :z"]);
});

it("stores every attribute a line's kind has, with the default for one not asked for", () => {
  const doc = open(plainNote(), 10);
  const first = () => storedLines(doc)[0];
  expect(written(doc, setLineKind(schema, doc, 0, { type: "heading" }))).toBe(true);
  expect(first()).toEqual({ type: "heading", level: 1, path: [], text: "abcd" });
  expect(setLineKind(schema, doc, 0, { type: "heading" })).toBeNull();
  expect(written(doc, setLineKind(schema, doc, 0, { level: 3 }))).toBe(true);
  expect(first()).toMatchObject({ type: "heading", level: 3 });
  expect(written(doc, setLineKind(schema, doc, 0, { type: "codeBlock" }))).toBe(true);
  expect(first()).toMatchObject({ type: "codeBlock", language: null, level: 3 });
  expect(written(doc, setLineKind(schema, doc, 0, { type: "heading" }))).toBe(true);
  expect(first()).toMatchObject({ type: "heading", level: 1 });
});

it("gives a split's new line the kind asked for, or the line's own when none is", () => {
  const baseline = note(
    [],
    [
      ["head", { type: "heading", level: 3 }, []],
      ["code", { type: "codeBlock", language: "ts" }, []],
    ],
  );
  const split = (at: number, offset: number, kind?: SequenceAttrs) => {
    const doc = open(baseline, 10);
    written(doc, splitLine(schema, doc, at, offset, String, kind));
    return storedLines(doc).slice(at, at + 2);
  };
  expect(split(0, 4, PARAGRAPH)).toEqual([
    { type: "heading", level: 3, path: [], text: "head" },
    { type: "paragraph", path: [], text: "" },
  ]);
  expect(split(0, 2)).toEqual([
    { type: "heading", level: 3, path: [], text: "he" },
    { type: "heading", level: 3, path: [], text: "ad" },
  ]);
  expect(split(1, 2)).toEqual([
    { type: "codeBlock", language: "ts", path: [], text: "co" },
    { type: "codeBlock", language: "ts", path: [], text: "de" },
  ]);
  expect(split(1, 0, { type: "heading" })).toEqual([
    { type: "heading", level: 1, path: [], text: "" },
    { type: "codeBlock", language: "ts", path: [], text: "code" },
  ]);
});

it("compares a BigInt with the number it reads as, in a record, an attribute and an array", () => {
  const baseline = note(
    [
      { id: "N", type: "orderedList", attrs: { start: 2n } },
      { id: "N1", type: "listItem", attrs: {} },
    ],
    [["a", { type: "heading", level: 2n }, ["N", "N1"]]],
    { "N.colwidth": [1n, 2] },
  );
  const doc = open(baseline, 10);
  const start = (value: unknown) =>
    setContainerAttributes(schema, doc, 0, 0, { start: value }, String);
  expect(start(2)).toBeNull();
  expect(start(2n)).toBeNull();
  expect(setContainerAttributes(schema, doc, 0, 0, { colwidth: [1, 2n] }, String)).toBeNull();
  expect(setLineKind(schema, doc, 1, { type: "heading", level: 2 })).toBeNull();
  expect(written(doc, start(3))).toBe(true);
  expect(doc.getMap(CONTAINERS).get("N.start")).toBe(3);
  expect(written(doc, start(4n))).toBe(true);
  expect(blocksOf(doc)[0]).toMatchObject({ type: "orderedList", attrs: { start: 4 } });
});

const calloutNote = (more: Record<string, unknown> = {}) =>
  note(
    [{ id: "C", type: "callout", attrs: TIP }],
    ["a", "b", "c"].map((text): Written => [text, PARAGRAPH, ["C"]]),
    more,
  );

it("copies every record under a split container's id to the fresh id, whatever it names", () => {
  const more = { "C.checked": true, "C.start": 7n };
  const copy = { checked: true, start: 7n, ...TIP };
  const lifter = open(calloutNote(more), 10);
  expect(
    written(
      lifter,
      liftBlocks(schema, lifter, 1, 1, 1, () => "later"),
    ),
  ).toBe(true);
  expect(pathsOf(lifter)).toEqual([["C"], [], ["later"]]);
  expect(lifter.getMap(CONTAINERS).get("later")).toBe("callout");
  expect(recordsOf(lifter, "later")).toEqual(copy);

  const adder = open(calloutNote(more), 20);
  const other = open(calloutNote(more), 30);
  written(adder, splitLine(schema, adder, 2, 1, String));
  written(other, liftBlocks(schema, other, 2, 1, 1, String));
  exchange(adder, other);
  expect(pathsOf(adder)).toEqual([["C"], ["C"], [], ["C"]]);
  const titled = setContainerAttributes(schema, adder, 3, 0, { title: "Danger" }, () => "own");
  expect(written(adder, titled)).toBe(true);
  expect(pathsOf(adder)).toEqual([["C"], ["C"], [], ["own"]]);
  expect(recordsOf(adder, "own")).toEqual({ ...copy, title: "Danger" });
});

it.each([
  [
    "the line between them is joined into the first",
    "x",
    (doc: Y.Doc) => joinLine(schema, doc, 1, () => "own"),
    "ax",
  ],
  [
    "the empty line between them is joined away",
    "",
    (doc: Y.Doc) => joinLine(schema, doc, 2, () => "own"),
    "a",
  ],
  [
    "the line between them is deleted",
    "x",
    (doc: Y.Doc) => deleteRange(schema, doc, 0, 1, 1, 1, () => "own"),
    "a",
  ],
] as [string, string, (doc: Y.Doc) => BodyWrites | null, string][])(
  "keeps two callouts that share an id apart when %s",
  (_, between, plan, left) => {
    const baseline = note(
      [{ id: "C", type: "callout", attrs: TIP }],
      [
        ["a", PARAGRAPH, ["C"]],
        [between, PARAGRAPH, []],
        ["b", PARAGRAPH, ["C"]],
      ],
      { "C.checked": true },
    );
    const doc = open(baseline, 10);
    const history = bodyHistory(doc, LOCAL);
    expect(titlesOf(doc)).toEqual(["Read me", "paragraph", "Read me"]);
    expect(written(doc, plan(doc))).toBe(true);
    expect(rowsRead(doc)).toEqual([`paragraph C:${left}`, "paragraph own:b"]);
    expect(titlesOf(doc)).toEqual(["Read me", "Read me"]);
    expect(recordsOf(doc, "own")).toEqual({ checked: true, ...TIP });
    history.undo();
    expect(pathsOf(doc)).toEqual([["C"], [], ["C"]]);
    expect(titlesOf(doc)).toEqual(["Read me", "paragraph", "Read me"]);
  },
);

it("splits a line of a list item in each of the places section 4 names", () => {
  const baseline = (first: string) =>
    note(
      [
        { id: "L", type: "bulletList", attrs: {} },
        { id: "I", type: "listItem", attrs: {} },
      ],
      [first, "later", "last"].map((text): Written => [text, PARAGRAPH, ["L", "I"]]),
    );
  const split = (at: number, offset: number, first = "first") => {
    const doc = open(baseline(first), 10);
    let asked = 0;
    written(
      doc,
      splitLine(schema, doc, at, offset, () => `new${String(asked++)}`),
    );
    const lines = rowsRead(doc).map((line) => line.replace("paragraph ", ""));
    return { lines, asked, records: doc.getMap(CONTAINERS).has("new0.checked") };
  };
  expect(split(0, 2)).toEqual({
    lines: ["L/I:fi", "L/new0:rst", "L/new0:later", "L/new0:last"],
    asked: 1,
    records: true,
  });
  expect(split(0, 0)).toEqual({
    lines: ["L/new0:", "L/I:first", "L/I:later", "L/I:last"],
    asked: 1,
    records: true,
  });
  expect(split(1, 0)).toEqual({
    lines: ["L/I:first", "L/I:", "L/I:later", "L/I:last"],
    asked: 0,
    records: false,
  });
  expect(split(1, 3)).toEqual({
    lines: ["L/I:first", "L/I:lat", "L/I:er", "L/I:last"],
    asked: 0,
    records: false,
  });
  expect(split(0, 0, "")).toEqual({
    lines: ["L/I:", "L/new0:", "L/new0:later", "L/new0:last"],
    asked: 1,
    records: true,
  });
});

it.each([
  ["before the line's own", false, ["false paragraph:", "true paragraph:,heading:abc"]],
  ["after it, which section 4 forbids", true, ["true paragraph:,heading:", "false paragraph:abc"]],
])(
  "a tick and a heading given to a to-do while someone adds a line above it, with the new boundary %s",
  (_, wrong, read) => {
    const baseline = note(
      [
        { id: "T", type: "taskList", attrs: {} },
        { id: "T1", type: "taskItem", attrs: {} },
      ],
      [["abc", PARAGRAPH, ["T", "T1"]]],
    );
    const splitter = open(baseline, 10);
    const ticker = open(baseline, 20);
    const split = splitLine(schema, splitter, 0, 0, () => "fresh")!;
    if (wrong) split.added[0]!.index++;
    written(splitter, split);
    ticker.transact(() => {
      writeBody(ticker, setContainerAttributes(schema, ticker, 0, 1, { checked: true }, String)!);
      writeBody(ticker, setLineKind(schema, ticker, 0, { type: "heading", level: 2 })!);
    }, LOCAL);
    exchange(splitter, ticker);
    const list = (
      readBodySequence(schema, ticker).toJSON() as {
        content: { content: { attrs: { checked: boolean }; content: Block[] }[] }[];
      }
    ).content[0]!;
    expect(
      list.content.map(
        (item) =>
          `${String(item.attrs.checked)} ${item.content.map((block) => `${block.type}:${block.content?.[0]?.text ?? ""}`).join(",")}`,
      ),
    ).toEqual(read);
    expect(view(splitter)).toBe(view(ticker));
  },
);

it("gives what a callout holds after a lifted line a fresh id and the same settings", () => {
  const { oracle, people } = team(1, calloutNote());
  const only = people[0]!;
  only.lift(1, 1, 1);
  expect(pathsOf(only.doc)).toEqual([["C"], [], ["w0"]]);
  expect(titlesOf(only.doc)).toEqual(["Read me", "paragraph", "Read me"]);
  expect(only.records.get("w0.fold")).toBe("+");
  only.undo();
  expect(pathsOf(only.doc)).toEqual([["C"], ["C"], ["C"]]);
  settled(people, oracle);
});

it("gives a callout its own id before changing its title when its id is on two callouts", () => {
  const { oracle, people } = team(2, calloutNote());
  const [lifter, adder] = people as [Person, Person];
  lifter.lift(2, 1, 1);
  adder.split(2, 1);
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  expect(pathsOf(lifter.doc)).toEqual([["C"], ["C"], [], ["C"]]);
  lifter.newStep();
  lifter.containerAttrs(3, 0, { title: "Danger" });
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  expect(pathsOf(adder.doc)).toEqual([["C"], ["C"], [], ["w0"]]);
  expect(titlesOf(adder.doc)).toEqual(["Read me", "paragraph", "Danger"]);
  expect(adder.records.get("w0.calloutType")).toBe("tip");
  lifter.undo();
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  expect(titlesOf(adder.doc)).toEqual(["Read me", "paragraph", "Read me"]);
  expect(adder.records.get("w0.title")).toBe("Danger");
});

it("redo puts back what the undo replaced, which is someone else's start number", () => {
  const baseline = note(
    [
      { id: "N", type: "orderedList", attrs: {} },
      { id: "N1", type: "listItem", attrs: {} },
    ],
    [["a", PARAGRAPH, ["N", "N1"]]],
  );
  const { oracle, people } = team(2, baseline);
  const [first, second] = people as [Person, Person];
  const start = () => first.records.get("N.start");
  first.containerAttrs(0, 0, { start: 5 });
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  second.containerAttrs(0, 0, { start: 9 });
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  first.undo();
  expect(start()).toBe(1);
  first.redo();
  expect(start()).toBe(9);
  deliver(people, "one by one", random(1));
  settled(people, oracle);
});

it.each([
  ["keeps its level when the history keeps a boundary's attributes", undefined],
  [
    "loses its level, and an undo then removes other typing, when the history keeps only records",
    FAULT.recordsOnlyFilter,
  ],
] as [string, Fault | undefined][])("a heading two people's undos bring back %s", (_, fault) => {
  const { oracle, people } = team(2, plainNote(), true, fault);
  const [first, second] = people as [Person, Person];
  const send = () => deliver(people, "one by one", random(1));
  const heading = () => storedLines(second.doc)[0];
  first.kind(0, { type: "heading", level: 2 });
  send();
  second.kind(0, { type: "codeBlock" });
  send();
  first.undo();
  send();
  if (!fault) {
    second.undo();
    send();
    expect(heading()).toMatchObject({ type: "heading", level: 2, text: "abcd" });
    settled(people, oracle);
    return;
  }
  expect(() => second.undo()).toThrow("[7 kind] a heading boundary holds no level");
  send();
  expect(heading()).toEqual({ type: "heading", path: [], text: "abcd" });
  second.newStep();
  second.type(0, 0, "X");
  second.newStep();
  second.kind(0, { level: 3 });
  send();
  first.kind(0, { level: 4 });
  send();
  expect(() => second.undo()).toThrow("[3 undo] undo passed over a step");
  expect(heading()).toEqual({ type: "heading", level: 4, path: [], text: "abcd" });
});

it.each([
  ["as the step last set it", false, 5],
  ["as someone else set it since", true, 9],
])(
  "undo of a step that made a list and then set its start number leaves the number %s",
  (_, changedSince, start) => {
    const { oracle, people } = team(2, plainNote());
    const [first, second] = people as [Person, Person];
    first.wrap(0, 0, 1, "orderedList", { start: 3 });
    first.containerAttrs(0, 0, { start: 5 });
    deliver(people, "one by one", random(1));
    settled(people, oracle);
    if (changedSince) second.containerAttrs(0, 0, { start: 9 });
    second.split(0, 4);
    deliver(people, "one by one", random(1));
    settled(people, oracle);
    first.undo();
    deliver(people, "one by one", random(1));
    settled(people, oracle);
    expect(pathsOf(second.doc)).toEqual([[], ["w0", "x0"], [], []]);
    expect(second.records.get("w0.start")).toBe(start);
  },
);

it("shows a title set while someone lifts a line out of the callout's middle on its first part only", () => {
  const { oracle, people } = team(2, calloutNote());
  const [namer, lifter] = people as [Person, Person];
  namer.containerAttrs(0, 0, { title: "Danger" });
  lifter.lift(1, 1, 1);
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  expect(titlesOf(namer.doc)).toEqual(["Danger", "paragraph", "Read me"]);
  lifter.undo();
  deliver(people, "one by one", random(1));
  settled(people, oracle);
  expect(titlesOf(namer.doc)).toEqual(["Danger"]);
});

it("splits a line inside bold text without writing any formatting", () => {
  const doc = open(plainNote(), 10);
  const sequence = doc.getText(SEQUENCE);
  const formatting = () => {
    let items = 0;
    for (let item = sequence._start; item !== null; item = item.right)
      if (item.content instanceof Y.ContentFormat) items++;
    return items;
  };
  written(doc, setMarks(schema, doc, 0, 0, 4, BOLD));
  const before = formatting();
  written(doc, splitLine(schema, doc, 0, 2, String));
  expect(formatting()).toBe(before);
  const bold = { type: "text", marks: [{ type: "bold" }] };
  expect(readBodySequence(schema, doc).toJSON()).toMatchObject({
    content: [
      { content: [{ ...bold, text: "ab" }] },
      { content: [{ ...bold, text: "cd" }] },
      {},
      {},
    ],
  });
});
