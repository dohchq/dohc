import { utf8ByteLength } from "@dohc/live-session-contract/limits";
import type { MarkType, NodeType, Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  allowedChildren,
  flattenBody,
  keepsMarkup,
  leavesOfSequence,
  readBodyLeaves,
  recordsOfContainer,
  startingRecords,
  writtenLeaves,
  type SequenceAttrs,
  type SequenceLeaf,
} from "./bodySequenceGrammar.js";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  MAX_SEQUENCE_DEPTH,
} from "./bodySequenceStore.js";
import { astralLetters, keySorts, type NewNoteCounts } from "./liveValidationPolicy.js";

/**
 * A container as a writer holds it. Neighbouring lines in one container hold the same object, so
 * two objects with one id are one id on two containers.
 */
export type BodyContainer = {
  id: string;
  type: string;
  /** For a container the change makes: the attributes it starts with. */
  starts?: SequenceAttrs;
  /** For a container the change gives a fresh id: the id whose records it takes. */
  copies?: string;
  /** Record changes to write, by attribute name, with "" for the type. */
  changes: Map<string, unknown>;
};

/** One leaf block of a note's body, as a writer reads it. */
export type BodyLine = {
  /** Null for a line that is read with no boundary of its own. */
  boundary: Y.XmlElement | null;
  /**
   * Why the line has no boundary: it is the text before the first boundary ("start"), a list
   * item's added first paragraph ("item"), or the paragraph after a block that cannot hold its
   * content ("spill"). Empty for a line with a boundary.
   */
  bare: "" | "start" | "item" | "spill";
  /** Where the line's content starts in the sequence. For "item", where its boundary would go. */
  start: number;
  /** What the line holds, in UTF-16 units, with U+FFFC for each inline item. */
  text: string;
  /** The line's kind as it reads. */
  type: string;
  /** The boundary's attributes as stored. None for a line with no boundary. */
  attrs: SequenceAttrs;
  /** The containers the line is in, outermost first. */
  path: BodyContainer[];
  /** The ids of those containers as the line was read. */
  ids: string[];
  /** For "item" and "spill": the line whose boundary the line is read from. */
  owner?: BodyLine;
};

/** What one change writes once every line it edits has a boundary of its own. */
export type BodyWrites = {
  records: Map<string, unknown>;
  attributes: Map<Y.XmlElement, SequenceAttrs>;
  /** Ranges to delete. */
  erased: { index: number; length: number }[];
  /** Boundaries to insert, in the order they stand in the note. */
  added: { index: number; attrs: SequenceAttrs }[];
  /** Letters to insert, with their marks; no marks means plain. */
  typed?: { index: number; letters: string; marks: SequenceAttrs };
  /** An inline item to insert. */
  placed?: { index: number; name: string; attrs: SequenceAttrs };
  /** Marks to set on a range; null takes a mark off. */
  marked?: { index: number; length: number; marks: SequenceAttrs };
};

/**
 * One change to a note's body, for `writeBody` to write. A change edits only lines that have a
 * boundary of their own, so it comes in three parts, each planned on the note as the part before
 * left it. Every place in the sequence is the place when that part is written.
 */
export type BodyChange = {
  /**
   * A boundary for each line that is read with none of its own and that the change edits, or
   * whose reading the change can alter, with the kind and path the line reads with.
   */
  given: { index: number; attrs: SequenceAttrs }[];
  /** What the change writes once those boundaries stand. */
  writes: () => BodyWrites;
  /** A boundary for each line the written change would leave with none of its own. */
  made: () => { index: number; attrs: SequenceAttrs }[];
};

export type Planned = BodyLine & { fresh?: boolean };

const ITEM_OF_LIST: Record<string, string> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
};
export const isList = (type: string | undefined) =>
  type !== undefined && Object.hasOwn(ITEM_OF_LIST, type);
export const isItem = (type: string | undefined) => type === "listItem" || type === "taskItem";
export const isBox = (type: string | undefined) => type === "blockquote" || type === "callout";
const isLeafKind = (schema: Schema, type: unknown) => {
  const node = typeof type === "string" ? schema.nodes[type] : undefined;
  const isLeaf = node?.isBlock === true && (node.isTextblock || node.isLeaf);
  return isLeaf && node !== schema.topNodeType;
};

const whole = (value: unknown) =>
  typeof value === "bigint" &&
  value >= BigInt(Number.MIN_SAFE_INTEGER) &&
  value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;

function plain(value: unknown): unknown {
  const one = whole(value);
  if (Array.isArray(one)) return Array.from(one, plain);
  if (typeof one !== "object" || one === null) return one;
  const built = Object.getPrototypeOf(one) as unknown;
  if (built !== Object.prototype && built !== null) return one;
  return Object.fromEntries(Object.entries(one).map(([key, held]) => [key, plain(held)]));
}

export function same(left: unknown, right: unknown): boolean {
  const one = whole(left);
  const other = whole(right);
  if (one === other) return true;
  if (typeof one !== "object" || typeof other !== "object" || one === null || other === null)
    return false;
  if (Array.isArray(one) !== Array.isArray(other)) return false;
  if (Array.isArray(one) && one.length !== (other as unknown[]).length) return false;
  const keys = Object.keys(one);
  return (
    keys.length === Object.keys(other).length &&
    keys.every(
      (key) =>
        Object.hasOwn(other, key) &&
        same((one as SequenceAttrs)[key], (other as SequenceAttrs)[key]),
    )
  );
}

const INLINE_ITEM = "\uFFFC";
const HIGH_HALF = /[\uD800-\uDBFF]/;
const LOW_HALF = /[\uDC00-\uDFFF]/;
/** Matches letters that hold half of a surrogate pair. No writer puts such letters in. */
export const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const splitsALetter = (text: string, offset: number) =>
  HIGH_HALF.test(text.charAt(offset - 1)) && LOW_HALF.test(text.charAt(offset));

function attributesOf(element: Y.XmlElement): SequenceAttrs {
  const entries: [string, unknown][] = [];
  element._map.forEach((item, key) => {
    if (!item.deleted) entries.push([key, item.content.getContent()[item.length - 1]]);
  });
  return Object.fromEntries(entries);
}

function kindOf(schema: Schema, stored: SequenceAttrs, asked: SequenceAttrs): SequenceAttrs {
  const held = typeof stored.type === "string" ? stored.type : "paragraph";
  const type = typeof asked.type === "string" ? asked.type : held;
  const kind: SequenceAttrs = { type };
  for (const [key, spec] of Object.entries(schema.nodes[type]?.spec.attrs ?? {})) {
    const unset = (spec as { default?: unknown }).default ?? null;
    const kept = type === held && Object.hasOwn(stored, key);
    kind[key] = Object.hasOwn(asked, key) ? asked[key] : kept ? stored[key] : unset;
  }
  return kind;
}

const isInlineItem = (schema: Schema, name: string) => {
  const node = schema.nodes[name];
  return node !== undefined && node.isInline && node.isLeaf && !node.isText;
};

const tables = new WeakMap<Schema, Record<string, string[]>>();

function heldBy(schema: Schema, type: string): string[] {
  let table = tables.get(schema);
  if (!table) tables.set(schema, (table = allowedChildren(schema)));
  return table[type] ?? [];
}

const holdsIt = (schema: Schema, type: string, what: string) => heldBy(schema, type).includes(what);

const isContainer = (schema: Schema, type: string) => {
  const node = schema.nodes[type];
  return node?.isBlock === true && !node.isTextblock && !node.isLeaf && node !== schema.topNodeType;
};

function wayTo(schema: Schema, from: string, to: string): string[] {
  const ways = [[from]];
  const seen = new Set([from]);
  for (const way of ways)
    for (const child of heldBy(schema, way.at(-1)!)) {
      if (child === to) return [...way.slice(1), to];
      if (seen.has(child) || !isContainer(schema, child)) continue;
      seen.add(child);
      ways.push([...way, child]);
    }
  return [];
}

function readsAs(schema: Schema, kind: string, key: string, value: unknown): unknown {
  const held = { [key]: value };
  const read = (leaf: Partial<SequenceLeaf>) =>
    readBodyLeaves(schema, [{ type: "paragraph", attrs: {}, path: [], inline: [], ...leaf }]);
  const node = schema.nodes[kind];
  if (!node) {
    const letter = read({ inline: [{ text: "a", marks: { [kind]: held } }] }).firstChild!;
    return letter.firstChild!.marks[0]?.attrs[key];
  }
  if (node.isInline)
    return read({ inline: [{ atom: kind, attrs: held }] }).firstChild!.firstChild!.attrs[key];
  if (!isContainer(schema, kind)) return read({ type: kind, attrs: held }).firstChild!.attrs[key];
  const above = wayTo(schema, schema.topNodeType.name, kind);
  const below = wayTo(schema, kind, "paragraph");
  const path = [...above, ...below.slice(0, -1)].map((type, depth) => ({
    type,
    id: String(depth),
    attrs: depth === above.length - 1 ? held : {},
  }));
  let found = read({ path });
  for (let depth = 0; depth < above.length; depth++) found = found.lastChild!;
  return found.attrs[key];
}

function keepRules(schema: Schema, kinds: string[], attrs: SequenceAttrs): void {
  for (const kind of kinds) {
    const has = (schema.nodes[kind] ?? schema.marks[kind])?.spec.attrs ?? {};
    for (const [key, value] of Object.entries(attrs)) {
      if (!Object.hasOwn(has, key) || same(readsAs(schema, kind, key, value), value)) continue;
      const given = typeof value === "object" && value !== null ? typeof value : String(value);
      throw new RangeError(`${kind}.${key} cannot hold ${given}: it breaks the attribute's rule.`);
    }
  }
}

function keepMarkRules(schema: Schema, marks: SequenceAttrs): void {
  for (const [name, value] of Object.entries(marks))
    if (typeof value === "object" && value !== null)
      keepRules(schema, [name], value as SequenceAttrs);
}

const keepRecordRules = (schema: Schema, attrs: SequenceAttrs) =>
  keepRules(
    schema,
    Object.keys(schema.nodes).filter((type) => isContainer(schema, type)),
    attrs,
  );

/**
 * The lines of a note's body, in order, for a writer to change: one for each boundary, and one
 * for each block that is read with no boundary of its own. A body that holds nothing is one empty
 * line with no boundary.
 */
export function readBody(schema: Schema, doc: Y.Doc): BodyLine[] {
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  const lines: BodyLine[] = [];
  let above: BodyContainer[] = [];
  let row = { boundary: null as Y.XmlElement | null, start: 0, text: "", items: [] as string[] };
  let at = 0;

  const close = () => {
    if (row.boundary === null && row.text === "") return;
    const attrs = row.boundary ? attributesOf(row.boundary) : {};
    const leaf = leavesOfSequence(schema, [{ boundary: attrs }], records)[0]!;
    const node = schema.nodes[leaf.type];
    const isLeaf = node?.isBlock === true && (node.isTextblock || node.isLeaf);
    const type = isLeaf && node !== schema.topNodeType ? leaf.type : "paragraph";
    const frames = row.boundary ? leaf.path : [];
    while (frames.length > 0 && !holdsIt(schema, frames.at(-1)!.type, type)) frames.pop();
    let shared = true;
    const path = frames.map((frame, depth): BodyContainer => {
      shared &&= above[depth]?.id === frame.id;
      return shared ? above[depth]! : { id: frame.id, type: frame.type, changes: new Map() };
    });
    const ids = path.map((container) => container.id);
    const { boundary, start } = row;
    const stored: BodyLine = {
      boundary,
      bare: boundary ? "" : "start",
      start,
      text: row.text,
      type,
      attrs,
      path,
      ids,
    };
    path.forEach((container, depth) => {
      const itsFirstIsThis = depth === path.length - 1 && type === "paragraph";
      if (above[depth] === container || !isItem(container.type) || itsFirstIsThis) return;
      lines.push({
        boundary: null,
        bare: "item",
        start: start - 1,
        text: "",
        type: "paragraph",
        attrs: {},
        path: path.slice(0, depth + 1),
        ids: ids.slice(0, depth + 1),
        owner: stored,
      });
    });
    const held = heldBy(schema, type);
    const refused = row.items.findIndex((name) => name !== "" && !held.includes(name));
    const cut = refused < 0 ? row.text.length : refused;
    stored.text = row.text.slice(0, cut);
    lines.push(stored);
    if (cut < row.text.length)
      lines.push({
        boundary: null,
        bare: "spill",
        start: start + cut,
        text: row.text.slice(cut),
        type: "paragraph",
        attrs: {},
        path: [...path],
        ids: [...ids],
        owner: stored,
      });
    above = path;
  };

  for (let item = doc.getText(BODY_SEQUENCE_FIELD)._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const element = item.content instanceof Y.ContentType ? item.content.type : null;
    if (element instanceof Y.XmlElement && element.nodeName === BLOCK_ELEMENT) {
      close();
      row = { boundary: element, start: at + 1, text: "", items: [] };
    } else if (item.content instanceof Y.ContentString) {
      row.text += item.content.str;
      for (let unit = 0; unit < item.length; unit++) row.items.push("text");
    } else {
      const name = element instanceof Y.XmlElement ? element.nodeName : "";
      row.text += INLINE_ITEM.repeat(item.length);
      for (let unit = 0; unit < item.length; unit++)
        row.items.push(isInlineItem(schema, name) ? name : "");
    }
    at += item.length;
  }
  close();
  if (lines.length === 0)
    lines.push({
      boundary: null,
      bare: "start",
      start: 0,
      text: "",
      type: "paragraph",
      attrs: {},
      path: [],
      ids: [],
    });
  return lines;
}

const nothing = (): BodyWrites => ({
  records: new Map(),
  attributes: new Map(),
  erased: [],
  added: [],
});
const noId = () => "";

const idsOf = (path: BodyContainer[]) => path.map((container) => container.id);
const moved = (line: BodyLine) => !same(idsOf(line.path), line.ids);
const paragraphFor = (line: BodyLine) => ({
  index: line.start,
  attrs: { type: "paragraph", path: line.ids },
});
/** What a change touches, by line. A line is one leaf block of the note, with or without a boundary. */
export type TouchedLines<Line> = {
  /** Lines the change edits: it puts in or takes out a letter, an inline item, a mark or a kind. */
  edits?: readonly (Line | undefined)[];
  /** Lines the change deletes, ends, splits, moves or changes the kind of, when that can alter the paragraph read after one from its boundary. */
  after?: readonly (Line | undefined)[];
  /** Lines the change deletes, splits at their start, moves or changes the kind of, when that can alter the first paragraph a list item adds above one. */
  above?: readonly (Line | undefined)[];
};

/**
 * The lines read with no boundary of their own that get one before a change is written, as
 * section 4 of the format says: each such line the change edits, the paragraph after each line
 * in `after`, and each list item's added first paragraph above a line in `above`. The one rule
 * for every writer: `changeOf` here and the editor adapter both ask it.
 */
export function linesGiven<Line extends { bare: string; owner?: Line | undefined }>(
  lines: readonly Line[],
  touched: TouchedLines<Line>,
): Line[] {
  const edits = new Set(touched.edits);
  const after = new Set(touched.after);
  const above = new Set(touched.above);
  return lines.filter(
    (line) =>
      line.bare !== "" &&
      (edits.has(line) ||
        (line.bare === "spill" && after.has(line.owner)) ||
        (line.bare === "item" && above.has(line.owner))),
  );
}
const bareIn = (lines: BodyLine[]) =>
  lines.flatMap((line) =>
    line.bare === ""
      ? []
      : [
          {
            bare: line.bare,
            owner: line.owner?.boundary,
            depth: line.ids.length,
            text: line.text,
          },
        ],
  );

function asGiven(lines: BodyLine[], given: Set<number>): BodyLine[] {
  let shift = 0;
  lines.forEach((line, at) => {
    line.start += shift;
    if (!given.has(at)) return;
    shift++;
    Object.assign(line, {
      boundary: new Y.XmlElement(BLOCK_ELEMENT),
      bare: "",
      start: line.start + 1,
      attrs: { type: "paragraph", path: line.ids },
      owner: undefined,
    });
  });
  return lines;
}

function changeOf(
  schema: Schema,
  doc: Y.Doc,
  freshId: () => string,
  touches: (lines: BodyLine[]) => TouchedLines<BodyLine> | null,
  plan: (lines: Planned[], freshId: () => string) => BodyWrites | null,
): BodyChange | null {
  let tried = 0;
  const idToTry = () => `?${String(tried++)}`;
  let lines = readBody(schema, doc);
  const touched = touches(lines);
  if (!touched) return null;
  const given = new Set<number>();
  for (const line of linesGiven(lines, touched)) given.add(lines.indexOf(line));
  for (;;) {
    const all = [...asGiven(lines, given)];
    const tryout = plan(lines, idToTry);
    if (!tryout) return null;
    const known = given.size;
    const left = new Set(lines);
    const went = all.filter(moved);
    for (const line of linesGiven(all, { edits: went, after: went, above: went }))
      if (left.has(line)) given.add(all.indexOf(line));
    if (given.size > known) {
      lines = readBody(schema, doc);
      continue;
    }
    let written = tryout;
    let bare = bareIn(all);
    const planned = () => {
      const now = readBody(schema, doc);
      bare = bareIn(now);
      written = plan(now, freshId)!;
      return written;
    };
    if (given.size === 0 && tried > 0) planned();
    const had = (line: BodyLine) =>
      bare.some(
        (known) =>
          known.bare === line.bare &&
          known.owner === line.owner?.boundary &&
          known.depth === line.ids.length &&
          known.text === line.text,
      );
    return {
      given:
        given.size === 0
          ? []
          : readBody(schema, doc)
              .filter((_, at) => given.has(at))
              .map(paragraphFor),
      writes: () => (given.size === 0 ? written : planned()),
      made: () => {
        const elements = [...written.attributes.keys()];
        const structural =
          written.erased.length + written.added.length > 0 ||
          elements.some((element) => element.nodeName === BLOCK_ELEMENT);
        if (!structural) return [];
        return readBody(schema, doc)
          .filter((line) => line.bare !== "" && !had(line))
          .map(paragraphFor);
      },
    };
  }
}

export function writesOf(
  schema: Schema,
  doc: Y.Doc,
  read: Planned[],
  freshId: () => string,
): BodyWrites | null {
  const stored = doc.getMap(BODY_CONTAINERS_FIELD);
  const lines = read.filter((line) => line.bare === "");
  const placed = new Set<BodyContainer>();
  let asHeld: BodyContainer[] = [];
  let asWritten: BodyContainer[] = [];
  for (const line of lines) {
    let shared = true;
    const path = line.path.map((container, depth): BodyContainer => {
      shared &&= asHeld[depth] === container;
      if (shared) return asWritten[depth]!;
      if (!placed.has(container)) {
        placed.add(container);
        return container;
      }
      const laterHalf = { ...container, id: freshId(), changes: new Map<string, unknown>() };
      if (!container.starts) laterHalf.copies = container.copies ?? container.id;
      return laterHalf;
    });
    asHeld = line.path;
    asWritten = path;
    line.path = path;
  }

  let above: BodyContainer[] = [];
  for (const line of lines) {
    const depth = line.path.findIndex((container, at) => container !== above[at]);
    const here = line.path[depth];
    if (here && above[depth]?.id === here.id) {
      here.copies ??= here.id;
      here.id = freshId();
    }
    above = line.path;
  }

  for (const { path } of lines)
    path.forEach((container, depth) => {
      if (!path.slice(0, depth).some((outer) => outer.id === container.id)) return;
      if (!container.starts) container.copies ??= container.id;
      container.id = freshId();
    });

  const held = [...new Set(lines.flatMap((line) => line.path))];
  const holders = new Map<string, number>();
  for (const { id } of held) holders.set(id, (holders.get(id) ?? 0) + 1);
  for (const container of held) {
    const onTwo = holders.get(container.id)! > 1;
    if (onTwo && container.changes.size > 0 && !container.starts && !container.copies) {
      holders.set(container.id, holders.get(container.id)! - 1);
      container.copies = container.id;
      container.id = freshId();
    }
  }

  const writes = nothing();
  for (const container of held) {
    const { id, type, starts, copies, changes } = container;
    if (starts || copies)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: starts ?? {} }))
        writes.records.set(key, value);
    if (copies)
      stored.forEach((value, key) => {
        if (key === copies || key.startsWith(`${copies}.`))
          writes.records.set(id + key.slice(copies.length), value);
      });
    for (const [name, value] of changes)
      writes.records.set(name === "" ? id : `${id}.${name}`, value);
  }

  for (const line of lines) {
    const ids = idsOf(line.path);
    if (ids.length > MAX_SEQUENCE_DEPTH) return null;
    if (line.fresh === true)
      writes.added.push({ index: line.start, attrs: { ...line.attrs, path: ids } });
    else if (!same(ids, line.ids)) writes.attributes.set(line.boundary!, { path: ids });
  }
  return writes;
}

function blocksAround(lines: BodyLine[], at: number, depth: number) {
  const around = lines[at]!.path.slice(0, depth);
  const inside = (index: number) =>
    lines[index] !== undefined &&
    lines[index].path.length >= depth &&
    around.every((container, level) => lines[index]!.path[level] === container);
  let from = at;
  while (inside(from - 1)) from--;
  let to = at;
  while (inside(to + 1)) to++;
  const blocks: { from: number; to: number }[] = [];
  for (let index = from; index <= to; index++) {
    const last = blocks.at(-1);
    const holder = lines[index]!.path[depth];
    if (last && holder !== undefined && lines[last.to]!.path[depth] === holder) last.to = index;
    else blocks.push({ from: index, to: index });
  }
  const own = blocks.findIndex((block) => block.from <= at && at <= block.to);
  const addedOnly = (count: number) =>
    blocks
      .slice(own, own + count)
      .some((block) => block.from === block.to && lines[block.from]!.bare === "item");
  return { blocks, own, addedOnly };
}

function landing(
  schema: Schema,
  line: BodyLine | undefined,
  offset: number,
  what: string,
): number | null {
  if (!line || offset < 0 || offset > line.text.length || splitsALetter(line.text, offset))
    return null;
  return holdsIt(schema, line.type, what) ? line.start + offset : null;
}

/**
 * Type letters into a line, with the marks they are to carry; no marks means plain. Refused
 * between the two units of a surrogate pair, for letters that hold half of one, and in a block
 * that holds no letters. Like every change here, it first gives a boundary to each line read with
 * none that it edits or whose reading it can alter, and writes the boundary of any such line it
 * would make. Like every change here that takes values, it throws a `RangeError` naming the
 * attribute for a value that breaks the attribute's rule in section 2.3 of the format.
 */
export function typeLetters(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  letters: string,
  marks: SequenceAttrs,
): BodyChange | null {
  keepMarkRules(schema, marks);
  if (letters === "" || LONE_HALF.test(letters)) return null;
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => ({ edits: [lines[at]] }),
    (lines) => {
      const index = landing(schema, lines[at], offset, "text");
      return index === null ? null : { ...nothing(), typed: { index, letters, marks } };
    },
  );
}

/**
 * Replace `length` letters at an offset of a line with `letters`, which take `marks`, in one change.
 * Refused where it would cut a surrogate pair or reach past the line.
 */
export function replaceLetters(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  length: number,
  letters: string,
  marks: SequenceAttrs,
): BodyChange | null {
  keepMarkRules(schema, marks);
  if (length < 1 || LONE_HALF.test(letters)) return null;
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => ({ edits: [lines[at]] }),
    (lines) => {
      const line = lines[at];
      if (!line || offset < 0 || offset + length > line.text.length) return null;
      if (splitsALetter(line.text, offset) || splitsALetter(line.text, offset + length))
        return null;
      const index = line.start + offset;
      return {
        ...nothing(),
        erased: [{ index, length }],
        ...(letters ? { typed: { index, letters, marks } } : {}),
      };
    },
  );
}

/** Insert an inline item into a line. Refused where typing is, and in a block that cannot hold it. */
export function insertInline(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  name: string,
  attrs: SequenceAttrs,
): BodyChange | null {
  keepRules(schema, [name], attrs);
  if (!isInlineItem(schema, name)) return null;
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => ({ edits: [lines[at]] }),
    (lines) => {
      const index = landing(schema, lines[at], offset, name);
      return index === null ? null : { ...nothing(), placed: { index, name, attrs } };
    },
  );
}

function elementAt(sequence: Y.Text, index: number): Y.XmlElement | null {
  let passed = 0;
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    if (passed === index) {
      const element = item.content instanceof Y.ContentType ? item.content.type : null;
      return element instanceof Y.XmlElement && element.nodeName !== BLOCK_ELEMENT ? element : null;
    }
    passed += item.length;
    if (passed > index) return null;
  }
  return null;
}

const unitAt = (doc: Y.Doc, index: number) =>
  elementAt(doc.getText(BODY_SEQUENCE_FIELD), index)?.nodeName ?? "text";

/** Change attributes of the inline item that stands at an offset of a line. */
export function setInlineAttributes(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  attrs: SequenceAttrs,
): BodyChange | null {
  const line = readBody(schema, doc)[at];
  if (!line || offset < 0 || offset >= line.text.length) return null;
  const element = elementAt(doc.getText(BODY_SEQUENCE_FIELD), line.start + offset);
  if (!element) return null;
  keepRules(schema, [element.nodeName], attrs);
  const stored = attributesOf(element);
  const changed = Object.entries(attrs).filter(
    ([key, value]) => !Object.hasOwn(stored, key) || !same(stored[key], value),
  );
  if (changed.length === 0) return null;
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => ({ edits: [lines[at]] }),
    () => ({ ...nothing(), attributes: new Map([[element, Object.fromEntries(changed)]]) }),
  );
}

function marksDiffer(sequence: Y.Text, index: number, length: number, asked: SequenceAttrs) {
  const isOn = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const held = new Map<string, unknown>();
  let passed = 0;
  for (let item = sequence._start; item !== null && passed < index + length; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentFormat) held.set(item.content.key, item.content.value);
    if (!item.countable) continue;
    passed += item.length;
    if (!(item.content instanceof Y.ContentString) || passed <= index) continue;
    const differs = Object.entries(asked).some(([key, value]) =>
      isOn(value) ? !isOn(held.get(key)) || !same(held.get(key), value) : isOn(held.get(key)),
    );
    if (differs) return true;
  }
  return false;
}

/**
 * Set or take off marks on part of one line. Refused where it would cut a surrogate pair, and
 * where every letter in the range already holds the marks asked for.
 */
export function setMarks(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  length: number,
  marks: SequenceAttrs,
): BodyChange | null {
  keepMarkRules(schema, marks);
  const line = readBody(schema, doc)[at];
  if (!line || length <= 0 || offset < 0 || offset + length > line.text.length) return null;
  if (splitsALetter(line.text, offset) || splitsALetter(line.text, offset + length)) return null;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  if (!marksDiffer(sequence, line.start + offset, length, marks)) return null;
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => ({ edits: [lines[at]] }),
    (lines) => ({ ...nothing(), marked: { index: lines[at]!.start + offset, length, marks } }),
  );
}

/**
 * Delete from an offset of one line to an offset of the same or a later line: the letters and
 * inline items between, and the boundary of each line after the first, so what is left of the
 * last line joins the first. When the first line cannot hold what is left of the last, the last
 * line keeps its boundary and stays a line, as does a last line read with no boundary that the
 * delete only runs up to. When the delete runs into such a line, or takes the block it stands
 * after, and the first line cannot hold what is left of it, the line gets its boundary first: the
 * delete edits it and leaves it a line. A line the delete takes away gets no boundary first.
 * Refused where it
 * would cut a surrogate pair, and where all it would delete is the empty first paragraph a list
 * item needs.
 */
export function deleteRange(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  toAt: number,
  toOffset: number,
  freshId: () => string,
): BodyChange | null {
  let joins = true;
  return changeOf(
    schema,
    doc,
    freshId,
    (lines) => {
      const first = lines[at];
      const last = lines[toAt];
      const apart = at < toAt && last !== undefined;
      const afterFirst = last?.bare === "spill" && last.owner === first && toOffset === 0;
      const stays = apart && (last.bare === "item" || afterFirst);
      const isLeft = apart && last.boundary && toOffset >= 0 && toOffset < last.text.length;
      const held =
        !isLeft || !first || holdsIt(schema, first.type, unitAt(doc, last.start + toOffset));
      const staysWithNoBoundary =
        apart &&
        last.bare === "spill" &&
        !afterFirst &&
        toOffset < last.text.length &&
        first !== undefined &&
        !holdsIt(schema, first.type, unitAt(doc, last.start + toOffset));
      joins = !stays && held && !staysWithNoBoundary;
      return {
        edits: [first, ...(staysWithNoBoundary ? [last] : [])],
        after: apart && joins ? [last] : [],
      };
    },
    (lines, freshId) => {
      const first = lines[at];
      const last = lines[toAt];
      if (!first || !last || offset < 0 || toOffset < 0) return null;
      if (offset > first.text.length || toOffset > last.text.length) return null;
      if (splitsALetter(first.text, offset) || splitsALetter(last.text, toOffset)) return null;
      const from = first.start + offset;
      const to = last.start + toOffset;
      const end = last.boundary ? last.start - 1 : last.start;
      const ranges = joins
        ? [{ index: from, length: to - from }]
        : [
            { index: from, length: end - from },
            { index: last.start, length: toOffset },
          ];
      const erased = ranges.filter((range) => range.length > 0);
      if (erased.length === 0) return null;
      const taken = lines.slice(at + 1, joins ? toAt + 1 : toAt).filter((line) => line.boundary);
      const backAgain = taken.every((line) => isNeededFirst(lines, lines.indexOf(line)));
      const length = erased.reduce((sum, range) => sum + range.length, 0);
      const onlyBoundaries = taken.length > 0 && length === taken.length;
      if (onlyBoundaries && backAgain && (!joins || last.text === "")) return null;
      const isLeft = (line: BodyLine) => {
        const owner = lines.indexOf(line.owner!);
        const itsOwnerStays = owner > toAt || (owner === toAt && !joins);
        return line.bare === "item" ? itsOwnerStays : line.bare === "spill" && owner === at;
      };
      const goes = lines.slice(at + 1, joins ? toAt + 1 : toAt).filter((line) => !isLeft(line));
      for (const line of goes) lines.splice(lines.indexOf(line), 1);
      const writes = writesOf(schema, doc, lines, freshId);
      writes?.erased.push(...erased);
      return writes;
    },
  );
}

/**
 * Split a line at an offset, as section 4 of the format says. The new line gets `kind`, or the
 * line's own kind when none is given, and the line's path; a split of a list item's first block
 * starts a new item, and at offset 0 of a line that holds text the new boundary goes before the
 * line's own. Refused inside a surrogate pair, and for a kind that is not a leaf block's.
 */
export function splitLine(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  freshId: () => string,
  kind?: SequenceAttrs,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    (lines) => ({
      edits: [lines[at]],
      after: [lines[at]],
      above: offset === 0 ? [lines[at]] : [],
    }),
    (lines, freshId) => {
      const line = lines[at];
      if (!line || offset < 0 || offset > line.text.length) return null;
      if (splitsALetter(line.text, offset)) return null;
      const asRead = { ...line.attrs, type: line.type };
      const attrs = kind ? kindOf(schema, {}, kind) : kindOf(schema, asRead, {});
      if (!isLeafKind(schema, attrs.type)) return null;
      if (kind) keepRules(schema, [String(attrs.type)], kind);
      const above = offset === 0 && line.text !== "";
      const fresh: Planned = {
        boundary: null,
        bare: "",
        start: above ? line.start - 1 : line.start + offset,
        text: "",
        type: "",
        attrs,
        path: [...line.path],
        ids: [],
        fresh: true,
      };
      const depth = line.path.length - 1;
      const item = line.path[depth];
      if (item && isItem(item.type) && lines[at - 1]?.path[depth] !== item) {
        const next = { id: freshId(), type: item.type, starts: {}, changes: new Map() };
        fresh.path[depth] = next;
        for (let later = at + 1; !above && lines[later]?.path[depth] === item; later++)
          lines[later]!.path[depth] = next;
      }
      lines.splice(above ? at : at + 1, 0, fresh);
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

function isNeededFirst(lines: BodyLine[], at: number): boolean {
  const line = lines[at];
  const next = lines[at + 1];
  const depth = (line?.path.length ?? 0) - 1;
  const item = line?.path[depth];
  if (!line || !next || !item || !isItem(item.type) || line.type !== "paragraph") return false;
  if (lines[at - 1]?.path[depth] === item || next.path[depth] !== item) return false;
  return !(next.path.length === line.path.length && next.type === "paragraph");
}

function goneInJoin(lines: BodyLine[], at: number): BodyLine | undefined {
  const lower = lines[at];
  const upper = lines[at - 1];
  if (!lower || !upper || upper.bare !== "" || upper.text !== "") return lower;
  const depth = upper.path.length - 1;
  const item = upper.path[depth];
  const itsFirst = item !== undefined && isItem(item.type) && lines[at - 2]?.path[depth] !== item;
  const takesItsPlace = lower.path.length === upper.path.length && lower.type === "paragraph";
  return itsFirst && lower.path[depth] === item && !takesItsPlace ? lower : upper;
}

/**
 * Join a line to the one above: delete the lower line's boundary, or the upper line's when the
 * upper line is empty and is not the first paragraph its list item needs. Refused when nothing
 * would join: the upper line cannot hold what the lower line starts with, or the lower line is
 * the empty first paragraph its list item needs. Such a join would only take a boundary away and
 * put it back, and for a line read with no boundary of its own it would give one first. Two
 * containers that share an id and would then stand together are kept apart by a fresh id for the
 * later one.
 */
export function joinLine(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  freshId: () => string,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    (lines) => {
      const lower = lines[at];
      const upper = lines[at - 1];
      if (!lower || !upper) return null;
      const lowerGoes = goneInJoin(lines, at) === lower;
      const joins = lower.text === "" || holdsIt(schema, upper.type, unitAt(doc, lower.start));
      if (lowerGoes && !joins) return null;
      if (lowerGoes && lower.text === "" && isNeededFirst(lines, at)) return null;
      return {
        edits: [upper, lower],
        after: lowerGoes ? [lower] : [],
        above: lowerGoes ? [] : [upper],
      };
    },
    (lines, freshId) => {
      const gone = goneInJoin(lines, at)!;
      lines.splice(lines.indexOf(gone), 1);
      const writes = writesOf(schema, doc, lines, freshId);
      writes?.erased.push({ index: gone.start - 1, length: 1 });
      return writes;
    },
  );
}

/**
 * Change a line's kind on its boundary: its `type`, and every attribute that kind has, with the
 * default for one neither asked for nor stored. Refused for a list item's added first paragraph,
 * and for a kind that is not a leaf block's.
 */
export function setLineKind(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  asked: SequenceAttrs,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    noId,
    (lines) => {
      const line = lines[at];
      if (!line || line.bare === "item") return null;
      if (typeof asked.type === "string" && !isLeafKind(schema, asked.type)) return null;
      const retyped = typeof asked.type === "string" && asked.type !== line.type;
      return { edits: [line], after: retyped ? [line] : [], above: retyped ? [line] : [] };
    },
    (lines) => {
      const line = lines[at]!;
      const kind = kindOf(schema, line.attrs, asked);
      keepRules(schema, [String(kind.type)], asked);
      const changed = Object.entries(kind).filter(
        ([key, value]) => !Object.hasOwn(line.attrs, key) || !same(line.attrs[key], value),
      );
      if (changed.length === 0) return null;
      return { ...nothing(), attributes: new Map([[line.boundary!, Object.fromEntries(changed)]]) };
    },
  );
}

/**
 * Wrap `count` neighbouring blocks, starting with the one that holds line `at` at `depth`, in a
 * new quote, callout or list. In a list each block becomes one item. Refused where the container
 * around the blocks cannot hold the new one: directly in a list, a table or a table row.
 */
export function wrapBlocks(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  count: number,
  type: string,
  attrs: SequenceAttrs,
  freshId: () => string,
): BodyChange | null {
  if (!isBox(type) && !isList(type)) return null;
  keepRecordRules(schema, attrs);
  return changeOf(
    schema,
    doc,
    freshId,
    (lines) => {
      const line = lines[at];
      const around = line?.path[depth - 1]?.type ?? schema.topNodeType.name;
      if (!line || depth > line.path.length || !holdsIt(schema, around, type)) return null;
      return blocksAround(lines, at, depth).addedOnly(count) ? null : {};
    },
    (lines, freshId) => {
      const make = (made: string, starts: SequenceAttrs): BodyContainer => ({
        id: freshId(),
        type: made,
        starts,
        changes: new Map(),
      });
      const { blocks, own } = blocksAround(lines, at, depth);
      const wrap = make(type, attrs);
      for (const block of blocks.slice(own, own + count)) {
        const around = isList(type) ? [wrap, make(ITEM_OF_LIST[type]!, {})] : [wrap];
        for (let index = block.from; index <= block.to; index++)
          lines[index]!.path.splice(depth, 0, ...around);
      }
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

/**
 * Lift `count` neighbouring blocks, starting with the one that holds line `at` at `depth`, out of
 * the quote or callout around them, or out of their list when the blocks are its items. What the
 * container holds after them goes to a container with a fresh id and a copy of its records.
 * Refused for blocks directly in any other container: a list item, a table, a row or a cell.
 */
export function liftBlocks(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  count: number,
  freshId: () => string,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    (lines) => (lines[at] && blocksAround(lines, at, depth).addedOnly(count) ? null : {}),
    (lines, freshId) => {
      const line = lines[at];
      const around = line?.path[depth - 1];
      if (!line || !around || !(isBox(around.type) || isList(around.type))) return null;
      const levels = isList(around.type) ? 2 : 1;
      if (line.path.length < depth - 1 + levels) return null;
      const { blocks, own } = blocksAround(lines, at, depth);
      for (const block of blocks.slice(own, own + count))
        for (let index = block.from; index <= block.to; index++)
          lines[index]!.path.splice(depth - 1, levels);
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

/**
 * Indent the list item that holds line `at` at `depth`: it goes under the item above it, into
 * that item's last list, or into a new list of its own list's kind.
 */
export function indentItem(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  freshId: () => string,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    () => ({}),
    (lines, freshId) => {
      const list = lines[at]?.path[depth - 1];
      if (!list || !isList(list.type) || !lines[at]!.path[depth]) return null;
      const { blocks, own } = blocksAround(lines, at, depth);
      const above = lines[blocks[own - 1]?.to ?? -1]?.path;
      if (!above?.[depth]) return null;
      const nested = isList(above[depth + 1]?.type)
        ? above[depth + 1]!
        : { id: freshId(), type: list.type, starts: {}, changes: new Map() };
      for (let index = blocks[own]!.from; index <= blocks[own]!.to; index++)
        lines[index]!.path.splice(depth, 0, above[depth], nested);
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

/**
 * Outdent the list item that holds line `at` at `depth`: it becomes an item of the list its
 * parent item is in, and the items after it in its own list go under it.
 */
export function outdentItem(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  freshId: () => string,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    () => ({}),
    (lines, freshId) => {
      const path = lines[at]?.path ?? [];
      const item = path[depth];
      if (!item || !isList(path[depth - 1]?.type) || !isList(path[depth - 3]?.type)) return null;
      const { blocks, own } = blocksAround(lines, at, depth);
      for (let index = blocks[own]!.from; index <= blocks[own]!.to; index++)
        lines[index]!.path.splice(depth - 2, 2);
      for (const block of blocks.slice(own + 1))
        for (let index = block.from; index <= block.to; index++)
          lines[index]!.path[depth - 2] = item;
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

/**
 * Change the kind of the container that holds line `at` at `depth`, to a kind it can become: a
 * quote or a callout, one of the three lists, or a table cell or header cell. A list's items take
 * the new list's item kind.
 */
export function setContainerKind(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  type: string,
  freshId: () => string,
): BodyChange | null {
  return changeOf(
    schema,
    doc,
    freshId,
    () => ({}),
    (lines, freshId) => {
      const stored = doc.getMap(BODY_CONTAINERS_FIELD);
      const container = lines[at]?.path[depth];
      if (!container) return null;
      const isCell = (kind: string | undefined) => kind === "tableCell" || kind === "tableHeader";
      const itsFamily = isList(container.type)
        ? isList(type)
        : isBox(container.type)
          ? isBox(type)
          : isCell(container.type) && isCell(type);
      if (!itsFamily) return null;
      const changed = [container];
      if (stored.get(container.id) !== type) container.changes.set("", type);
      if (isList(type))
        for (const block of blocksAround(lines, at, depth + 1).blocks) {
          const item = lines[block.from]!.path[depth + 1];
          if (!item || stored.get(item.id) === ITEM_OF_LIST[type]) continue;
          item.changes.set("", ITEM_OF_LIST[type]);
          changed.push(item);
        }
      if (changed.every((each) => each.changes.size === 0)) return null;
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

/** Change attributes of the container that holds line `at` at `depth`. */
export function setContainerAttributes(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  attrs: SequenceAttrs,
  freshId: () => string,
): BodyChange | null {
  keepRecordRules(schema, attrs);
  return changeOf(
    schema,
    doc,
    freshId,
    () => ({}),
    (lines, freshId) => {
      const stored = doc.getMap(BODY_CONTAINERS_FIELD);
      const container = lines[at]?.path[depth];
      if (!container) return null;
      for (const [name, value] of Object.entries(attrs))
        if (!same(stored.get(`${container.id}.${name}`), value)) container.changes.set(name, value);
      if (container.changes.size === 0) return null;
      return writesOf(schema, doc, lines, freshId);
    },
  );
}

function formattingAt(sequence: Y.Text, index: number): Record<string, unknown> {
  const marks = new Map<string, unknown>();
  let passed = 0;
  for (let item = sequence._start; item !== null && passed < index; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentFormat) {
      if (item.content.value === null) marks.delete(item.content.key);
      else marks.set(item.content.key, item.content.value);
    } else if (item.countable) passed += item.length;
  }
  return Object.fromEntries(marks);
}

/** The origin `writeBody` gives the change that makes a line's boundary, unless told another. */
export const GIVEN_BOUNDARY = Symbol("a boundary for a line that had none");

/**
 * Write one change as the writer whose origin is `origin`. The boundaries the change gives to
 * lines that had none are written first, in a change of their own with the origin `given`; the
 * rest follows in one change. No history may follow `given`: undo then leaves those boundaries,
 * what someone else typed in such a line stays in it, and undoing the rest puts every boundary
 * back as it was. It throws inside an open transaction, where Yjs would write the two changes as
 * one. It stores plain data: a BigInt it is given is stored as the number it reads as.
 */
export function writeBody(
  doc: Y.Doc,
  change: BodyChange,
  origin: unknown,
  given: unknown = GIVEN_BOUNDARY,
): void {
  if (doc._transaction !== null)
    throw new Error(
      "writeBody cannot run inside an open transaction: its two changes would be written as one, and undo would take away the boundary it gives a line.",
    );
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  const set = (element: Y.XmlElement, attrs: SequenceAttrs) => {
    for (const [key, value] of Object.entries(attrs))
      element.setAttribute(key, plain(value) as string);
  };
  const embed = (index: number, name: string, attrs: SequenceAttrs) => {
    const element = new Y.XmlElement(name);
    set(element, attrs);
    sequence.insertEmbed(index, element, formattingAt(sequence, index));
  };
  const bound = (boundaries: BodyChange["given"]) => {
    for (const { index, attrs } of [...boundaries].reverse()) embed(index, BLOCK_ELEMENT, attrs);
  };
  if (change.given.length > 0) doc.transact(() => bound(change.given), given);
  doc.transact(() => {
    const writes = change.writes();
    for (const [key, value] of writes.records) records.set(key, plain(value));
    for (const [element, attrs] of writes.attributes) set(element, attrs);
    const { marked, typed, placed } = writes;
    if (marked) sequence.format(marked.index, marked.length, plain(marked.marks) as SequenceAttrs);
    const edits: { index: number; rank: number; make: () => void }[] = [];
    for (const { index, length } of writes.erased)
      edits.push({ index, rank: 0, make: () => sequence.delete(index, length) });
    if (typed)
      edits.push({
        index: typed.index,
        rank: 1,
        make: () =>
          sequence.insert(typed.index, typed.letters, plain(typed.marks) as SequenceAttrs),
      });
    if (placed)
      edits.push({
        index: placed.index,
        rank: 1,
        make: () => embed(placed.index, placed.name, placed.attrs),
      });
    writes.added.forEach(({ index, attrs }, order) =>
      edits.push({
        index,
        rank: 2 + writes.added.length - order,
        make: () => embed(index, BLOCK_ELEMENT, attrs),
      }),
    );
    edits.sort((one, other) => other.index - one.index || one.rank - other.rank);
    for (const edit of edits) edit.make();
    bound(change.made());
  }, origin);
}

type Read = { values: number; bytes: number };

function stored(read: Read, value: unknown): void {
  read.values++;
  if (typeof value === "string") read.bytes += utf8ByteLength(value);
  else if (Array.isArray(value)) for (const held of value) stored(read, held);
  else if (typeof value === "object" && value !== null)
    for (const [key, held] of Object.entries(value)) {
      read.bytes += utf8ByteLength(key);
      stored(read, held);
    }
}

const SEQUENCE_NAME_BYTES = utf8ByteLength(BODY_SEQUENCE_FIELD);
const CONTAINERS_NAME_BYTES = utf8ByteLength(BODY_CONTAINERS_FIELD);
const BOUNDARY_NAME_BYTES = utf8ByteLength(BLOCK_ELEMENT);

type Kind = { structs: number; keyBytes: number; nameBytes: number };

/**
 * What a note stores more once `writeNewBody` writes `body` into it with `idFor`, counted as the
 * save's check and the engine's Markdown writer count it, or null when the note would not read
 * as `body`:
 * - a line sits in more containers than a note holds;
 * - a container holds no line, or a node holds what its kind does not allow;
 * - a block or an inline item carries a mark;
 * - an attribute holds a value its rule does not keep (2.3), such as a row height over the
 *   limit or a callout type with a line break;
 * - a letter of inline code carries another mark, such as a link.
 *
 * The engine's Markdown writer spends a node on each path entry of each line, each container,
 * line, text run, mark of a run, inline item, attribute and column width, and on the one empty
 * line of a note with none. It counts the bytes of each path entry, kind and string it reads, and
 * a run's marks each time it reads them: when it reaches the run, when it starts the run, and when
 * it compares them with the run before of as many marks.
 */
export function newBodyWeight(
  schema: Schema,
  body: ProseMirrorNode,
  idFor: (container: ProseMirrorNode, index: number) => string,
): NewNoteCounts | null {
  if (body.childCount > 0 && !body.type.validContent(body.content)) return null;
  const kinds = new Map<NodeType | MarkType, Kind>();
  const kind = (type: NodeType | MarkType, made: () => Omit<Kind, "nameBytes">) => {
    let known = kinds.get(type);
    if (known === undefined)
      kinds.set(type, (known = { ...made(), nameBytes: utf8ByteLength(type.name) }));
    return known;
  };
  const keyBytes = (keys: Iterable<string>, prefix = "") => {
    let bytes = 0;
    for (const key of keys) bytes += utf8ByteLength(prefix + key);
    return bytes;
  };
  let structs = 0;
  let elements = 0;
  let engineNodes = 0;
  let engineBytes = 0;
  let containers = 0;
  let rootEntries = 0;
  let sorted = 0;
  let astral = 0;
  const read: Read = { values: 0, bytes: 0 };
  const marked: Read = { values: 0, bytes: 0 };
  const attributes = (attrs: ProseMirrorNode["attrs"]) => {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "type" || key === "path") continue;
      stored(read, value);
      sorted += keySorts(value);
      engineNodes++;
      if (typeof value === "string") engineBytes += utf8ByteLength(value);
      else if (Array.isArray(value)) engineNodes += value.length;
    }
  };
  const line = (child: ProseMirrorNode, depth: number, pathBytes: number): boolean => {
    if (!child.type.validContent(child.content)) return false;
    const leaf = kind(child.type, () => {
      const keys = new Set([...Object.keys(child.attrs), "type", "path"]);
      return { structs: 1 + keys.size, keyBytes: keyBytes(keys) };
    });
    structs += leaf.structs;
    elements++;
    read.bytes += BOUNDARY_NAME_BYTES + leaf.keyBytes + leaf.nameBytes + pathBytes;
    read.values += 2 + depth;
    engineNodes += 1 + depth;
    engineBytes += leaf.nameBytes + pathBytes;
    attributes(child.attrs);
    const unmarked = child.type.spec.marks === "";
    let before = -1;
    for (let piece = 0; piece < child.childCount; piece++) {
      const inline = child.child(piece);
      if (!keepsMarkup(inline)) return false;
      if (!inline.isText) {
        const atom = kind(inline.type, () => {
          const keys = Object.keys(inline.attrs);
          return { structs: 1 + keys.length, keyBytes: keyBytes(keys) };
        });
        structs += atom.structs;
        elements++;
        read.bytes += atom.nameBytes + atom.keyBytes;
        engineNodes++;
        engineBytes += atom.nameBytes;
        attributes(inline.attrs);
        before = -1;
        continue;
      }
      const letters = utf8ByteLength(inline.text ?? "");
      astral += astralLetters(inline.text ?? "");
      const marks = inline.marks;
      structs += 1 + 2 * marks.length;
      read.bytes += letters;
      engineBytes += letters;
      if (unmarked) {
        if (before === -1) engineNodes++;
        before = 0;
        continue;
      }
      let markBytes = 0;
      engineNodes++;
      for (const mark of marks) {
        marked.bytes += 2 * kind(mark.type, () => ({ structs: 0, keyBytes: 0 })).nameBytes;
        marked.values++;
        stored(marked, mark.attrs);
        sorted += keySorts(mark.attrs);
        engineNodes++;
        for (const value of Object.values(mark.attrs)) {
          engineNodes++;
          if (typeof value === "string") markBytes += utf8ByteLength(value);
        }
      }
      engineBytes += (before === marks.length ? 3 : 2) * markBytes;
      before = marks.length;
    }
    return true;
  };
  const holds = (node: ProseMirrorNode, depth: number, pathBytes: number): boolean => {
    for (let at = 0; at < node.childCount; at++) {
      const child = node.child(at);
      if (!keepsMarkup(child)) return false;
      if (child.isTextblock || child.isLeaf) {
        if (!line(child, depth, pathBytes)) return false;
        continue;
      }
      if (
        depth === MAX_SEQUENCE_DEPTH ||
        child.childCount === 0 ||
        !child.type.validContent(child.content)
      )
        return false;
      const starting = startingRecords(schema, child.type.name);
      const container = kind(child.type, () => ({
        structs: 1 + starting.size,
        keyBytes: (1 + starting.size) * CONTAINERS_NAME_BYTES + keyBytes(starting.keys(), "."),
      }));
      const idBytes = utf8ByteLength(idFor(child, containers++));
      structs += container.structs;
      rootEntries += container.structs;
      read.bytes += container.keyBytes + container.structs * idBytes + container.nameBytes;
      read.values++;
      for (const [key, fallback] of starting) {
        const value = Object.hasOwn(child.attrs, key) ? child.attrs[key] : fallback;
        stored(read, value);
        sorted += keySorts(value);
      }
      engineNodes++;
      engineBytes += container.nameBytes;
      for (const value of Object.values(child.attrs)) {
        engineNodes++;
        if (typeof value === "string") engineBytes += utf8ByteLength(value);
        else if (Array.isArray(value)) engineNodes += value.length;
      }
      if (!holds(child, depth + 1, pathBytes + idBytes)) return false;
    }
    return true;
  };
  if (!holds(body, 0, 0)) return null;
  if (elements === 0) engineNodes++;
  else read.bytes += SEQUENCE_NAME_BYTES;
  return {
    structs,
    elements,
    rootEntries,
    keySorts: sorted,
    astral,
    values: read.values,
    markValues: marked.values,
    bytes: read.bytes,
    markBytes: marked.bytes,
    engineNodes,
    engineBytes,
  };
}

/**
 * Write a whole document as the body of a new note, in one change. Every line gets a boundary
 * with its kind, every attribute of its kind and its path, and every container gets its type
 * record and a record for every attribute of every kind it can become. `idFor` names each
 * container, and no two may share a name. A document with no block writes no item: the note reads
 * as one empty line with no boundary, so the first change to it gives that line its boundary in a
 * change of its own first (section 4). No other line is read with no boundary of its own.
 *
 * It throws for a note whose body already holds an item or a record, and a `RangeError` for a
 * line that sits in more containers than a note holds. It writes what a note stores, so the note
 * reads as `body` only where `newBodyWeight` says so.
 */
export function writeNewBody(
  schema: Schema,
  doc: Y.Doc,
  body: ProseMirrorNode,
  idFor: (container: ProseMirrorNode, index: number) => string,
  origin?: unknown,
): void {
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  if (sequence._start !== null || records._map.size > 0)
    throw new Error("writeNewBody writes the body of a new note, and this note already holds one.");
  const leaves = flattenBody(body, idFor);
  const written = writtenLeaves(schema, leaves);
  const element = (name: string, attrs: SequenceAttrs) => {
    const made = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attrs))
      made.setAttribute(key, plain(value) as string);
    return made;
  };
  const pieces: { insert: string | Y.XmlElement; attributes: unknown }[] = [];
  for (const [at, leaf] of leaves.entries()) {
    pieces.push({ insert: element(BLOCK_ELEMENT, written.boundaries[at]!), attributes: {} });
    for (const piece of leaf.inline)
      pieces.push(
        "text" in piece
          ? { insert: piece.text, attributes: plain(piece.marks) }
          : { insert: element(piece.atom, piece.attrs), attributes: {} },
      );
  }
  doc.transact(() => {
    for (const [key, value] of written.containers) records.set(key, plain(value));
    sequence.applyDelta(pieces);
  }, origin);
}

/**
 * The undo history of one writer of a note's body. It follows `origin` only and puts an earlier
 * value back over someone else's later one. It never deletes a container record or an attribute of
 * a boundary that still stands. An inline item's attribute is not kept: it may have had no value
 * before the person set it. A boundary `writeBody` gives a line that had none is no part of a
 * step, so undo leaves it.
 */
export function bodyHistory(doc: Y.Doc, origin: unknown, captureTimeout?: number): Y.UndoManager {
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  return new Y.UndoManager([doc.getText(BODY_SEQUENCE_FIELD), records], {
    trackedOrigins: new Set([origin]),
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) =>
      item.parent !== records &&
      !(
        item.parent instanceof Y.XmlElement &&
        item.parent.nodeName === BLOCK_ELEMENT &&
        item.parentSub !== null
      ),
    ...(captureTimeout === undefined ? {} : { captureTimeout }),
  });
}
