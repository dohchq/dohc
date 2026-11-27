import {
  Fragment,
  Mark,
  type MarkType,
  type Attrs,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from "@tiptap/pm/model";

import { CONTAINER_ID, MAX_SEQUENCE_DEPTH } from "./bodySequenceStore.js";

export type SequenceAttrs = Record<string, unknown>;
export type SequenceFrame = { type: string; id: string; attrs: SequenceAttrs };
export type SequenceInline =
  | { text: string; marks: SequenceAttrs }
  | { atom: string; attrs: SequenceAttrs };
export type SequenceBoundary = { boundary: SequenceAttrs };
export type SequenceLeaf<Inline extends SequenceInline = SequenceInline> = {
  type: string;
  attrs: SequenceAttrs;
  path: SequenceFrame[];
  inline: Inline[];
};
export type SequencePiece = SequenceBoundary | SequenceInline;

/**
 * The note's container records: `<id>` holds a container's node type and `<id>.<attribute>` one of
 * its attributes.
 */
export type ContainerRecords = { get(key: string): unknown };

const record = (value: unknown): SequenceAttrs | null =>
  typeof value === "object" &&
  value !== null &&
  Object.prototype.toString.call(value) === "[object Object]"
    ? (value as SequenceAttrs)
    : null;

const own = (holder: object, key: string): unknown => {
  const held = Object.getOwnPropertyDescriptor(holder, key);
  return held && "value" in held ? (held.value as unknown) : undefined;
};

const filled = (value: unknown): unknown[] | null => {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = [];
  for (let at = 0; at < value.length; at++) {
    const held = Object.getOwnPropertyDescriptor(value, at);
    if (!held || !("value" in held)) return null;
    items.push(held.value);
  }
  return items;
};

const whole = (value: unknown): unknown =>
  typeof value === "bigint" &&
  value >= BigInt(Number.MIN_SAFE_INTEGER) &&
  value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : Object.is(value, -0)
      ? 0
      : value;

const MAX_SPAN = 1000;
const MAX_LIST_START = 999_999_999;
const MAX_ROW_HEIGHT = 1_000_000;

const text = (value: unknown) => typeof value === "string";
const textOrNone = (value: unknown) => value === null || typeof value === "string";
const oneLine = (value: unknown) => typeof value === "string" && !/[\n\r\u2028\u2029]/.test(value);
const yesOrNo = (value: unknown) => typeof value === "boolean";
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const integerIn = (least: number, most: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= least && value <= most;
const span = integerIn(1, MAX_SPAN);
const widths = (value: unknown) => {
  const held = filled(value);
  return (
    value === null ||
    (held !== null &&
      held.length <= MAX_SPAN &&
      held.every((width) => finite(width) && (width as number) >= 0))
  );
};
const side = (value: unknown) =>
  value === null || value === "left" || value === "right" || value === "center";
const plain = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const VALUE_RULES: Record<string, (value: unknown) => boolean> = {
  "wikilink.target": text,
  "inlineAtom.atomId": text,
  "inlineAtom.params": text,
  "inlineAtom.source": text,
  "callout.calloutType": oneLine,
  "callout.title": oneLine,
  "mathInline.tex": text,
  "mathBlock.tex": text,
  "image.src": text,
  "image.alt": text,
  "escapedPunctuation.value": text,
  "rawBlock.source": text,
  "rawInline.source": text,
  "bulletList.loose": yesOrNo,
  "orderedList.loose": yesOrNo,
  "taskList.loose": yesOrNo,
  "taskItem.checked": yesOrNo,
  "wikilink.label": textOrNone,
  "image.title": textOrNone,
  "codeBlock.language": (value) => value === null || oneLine(value),
  "orderedList.type": textOrNone,
  "callout.fold": (value) => value === "" || value === "+" || value === "-",
  "heading.level": integerIn(1, 6),
  "orderedList.start": integerIn(0, MAX_LIST_START),
  "tableCell.colspan": span,
  "tableCell.rowspan": span,
  "tableHeader.colspan": span,
  "tableHeader.rowspan": span,
  "tableCell.colwidth": widths,
  "tableHeader.colwidth": widths,
  "tableCell.align": side,
  "tableHeader.align": side,
  "tableRow.height": (value) => value === null || integerIn(1, MAX_ROW_HEIGHT)(value),
  "link.href": textOrNone,
  "link.target": textOrNone,
  "link.rel": textOrNone,
  "link.class": textOrNone,
  "link.title": textOrNone,
};

/** The attributes a node or mark of `type` reads with from stored ones, each by its rule (2.3). */
export function attrsFor(type: NodeType | MarkType, raw: unknown): SequenceAttrs {
  const given = record(raw) ?? {};
  const attrs: SequenceAttrs = {};
  for (const key of Object.keys(type.spec.attrs ?? {})) {
    const held = whole(own(given, key));
    const rule = VALUE_RULES[`${type.name}.${key}`] ?? plain;
    const value = rule === widths ? (filled(held)?.map(whole) ?? held) : held;
    if (value !== undefined && rule(value)) attrs[key] = value;
  }
  return attrs;
}

const sameValue = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, at) => value === right[at])
    : left === right;

const attrSpecs = new WeakMap<NodeType | MarkType, [string, unknown][]>();

export function keepsAttrs(type: NodeType | MarkType, attrs: Attrs): boolean {
  let specs = attrSpecs.get(type);
  if (!specs) {
    specs = Object.entries(type.spec.attrs ?? {}).map(([key, spec]) => [
      key,
      (spec as { default?: unknown }).default,
    ]);
    attrSpecs.set(type, specs);
  }
  if (specs.length === 0) return true;
  const kept = attrsFor(type, attrs);
  return specs.every(([key, fallback]) =>
    sameValue(key in kept ? kept[key] : fallback, attrs[key]),
  );
}

/**
 * Whether a reader gives back `node`'s attributes and marks as `flattenBody` writes them, in a
 * node that allows them. A mark on anything but a letter is not written, an attribute whose value
 * breaks its rule (2.3) reads as its default, and of two marks where one excludes the other only
 * one is read: a letter of inline code reads with `code` alone.
 */
export function keepsMarkup(node: ProseMirrorNode): boolean {
  if (!node.isText) return node.marks.length === 0 && keepsAttrs(node.type, node.attrs);
  return node.marks.every(
    (mark) =>
      keepsAttrs(mark.type, mark.attrs) &&
      node.marks.every((other) => other === mark || !mark.type.excludes(other.type)),
  );
}

type Shape = {
  children: Map<NodeType, Set<NodeType>>;
  leafBlock(type: NodeType | undefined): type is NodeType;
  container(type: NodeType | undefined): type is NodeType;
  inlineItem(type: NodeType | undefined): type is NodeType;
  paragraph: NodeType;
};

const shapes = new WeakMap<Schema, Shape>();

function shapeOf(schema: Schema): Shape {
  const known = shapes.get(schema);
  if (known) return known;
  const children = new Map<NodeType, Set<NodeType>>();
  for (const type of Object.values(schema.nodes)) {
    const allowed = new Set<NodeType>();
    const seen = new Set([type.contentMatch]);
    for (const match of seen)
      for (let edge = 0; edge < match.edgeCount; edge++) {
        allowed.add(match.edge(edge).type);
        seen.add(match.edge(edge).next);
      }
    children.set(type, allowed);
  }
  const block = (type: NodeType | undefined): type is NodeType =>
    type !== undefined && type.isBlock && type !== schema.topNodeType;
  const shape: Shape = {
    children,
    leafBlock: (type): type is NodeType => block(type) && (type.isTextblock || type.isLeaf),
    container: (type): type is NodeType => block(type) && !type.isTextblock && !type.isLeaf,
    inlineItem: (type): type is NodeType =>
      type !== undefined && type.isInline && type.isLeaf && !type.isText,
    paragraph: schema.nodes.paragraph!,
  };
  shapes.set(schema, shape);
  return shape;
}

/** For each node type that holds nodes, the node types it may hold, both sorted by name. */
export function allowedChildren(schema: Schema): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const [type, allowed] of shapeOf(schema).children)
    if (allowed.size > 0) table[type.name] = [...allowed].map((child) => child.name).sort();
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}

function pathOf(
  schema: Schema,
  value: unknown,
  containers: ContainerRecords,
  held: Map<string, SequenceAttrs>,
): SequenceFrame[] {
  const shape = shapeOf(schema);
  const path: SequenceFrame[] = [];
  const ids = filled(value);
  if (ids === null) return path;
  const seen = new Set<string>();
  let parent = schema.topNodeType;
  for (const id of ids.slice(0, MAX_SEQUENCE_DEPTH)) {
    if (typeof id !== "string" || !CONTAINER_ID.test(id) || seen.has(id)) break;
    const recorded = containers.get(id);
    if (typeof recorded !== "string") break;
    const allowed = shape.children.get(parent)!;
    const type = allowed.size === 1 ? [...allowed][0] : schema.nodes[recorded];
    if (!shape.container(type) || !allowed.has(type)) break;
    seen.add(id);
    let attrs = held.get(`${type.name} ${id}`);
    if (!attrs) {
      attrs = {};
      for (const key of Object.keys(type.spec.attrs ?? {})) {
        const stored = containers.get(`${id}.${key}`);
        if (stored !== undefined) attrs[key] = stored;
      }
      held.set(`${type.name} ${id}`, attrs);
    }
    path.push({ type: type.name, id, attrs });
    parent = type;
  }
  return path;
}

function startsLeaf(piece: SequencePiece): piece is SequenceBoundary {
  return "boundary" in piece;
}

/**
 * The leaves a sequence holds. What stands before the first boundary is a paragraph with no path,
 * if any of it is a letter or an inline item the schema knows.
 */
export function leavesOfSequence<Inline extends SequenceInline = SequenceInline>(
  schema: Schema,
  pieces: Iterable<SequenceBoundary | Inline>,
  containers: ContainerRecords,
): SequenceLeaf<Inline>[] {
  const shape = shapeOf(schema);
  const leaves: SequenceLeaf<Inline>[] = [];
  const held = new Map<string, SequenceAttrs>();
  for (const piece of pieces) {
    if (startsLeaf(piece))
      leaves.push({
        type:
          typeof own(piece.boundary, "type") === "string"
            ? String(piece.boundary.type)
            : "paragraph",
        attrs: piece.boundary,
        path: pathOf(schema, own(piece.boundary, "path"), containers, held),
        inline: [],
      });
    else if (leaves.length > 0) leaves.at(-1)!.inline.push(piece);
    else if ("text" in piece ? piece.text !== "" : shape.inlineItem(schema.nodes[piece.atom]))
      leaves.push({ type: "paragraph", attrs: {}, path: [], inline: [piece] });
  }
  return leaves;
}

const KINDS_A_CONTAINER_CAN_BECOME = [
  ["blockquote", "callout"],
  ["bulletList", "orderedList", "taskList"],
  ["listItem", "taskItem"],
  ["tableCell", "tableHeader"],
];

/**
 * The records a writer gives a new container: its type, and every attribute of every kind it can
 * become where it stands, so that each later change to one is an overwrite. They are set in
 * `records`, a new map unless one is given.
 */
export function recordsOfContainer(
  schema: Schema,
  frame: SequenceFrame,
  records = new Map<string, unknown>(),
): Map<string, unknown> {
  records.set(frame.id, frame.type);
  for (const [key, value] of startingRecords(schema, frame.type))
    records.set(`${frame.id}.${key}`, value);
  for (const [key, value] of Object.entries(frame.attrs)) records.set(`${frame.id}.${key}`, value);
  return records;
}

const startingRecordsOf = new WeakMap<Schema, Map<string, Map<string, unknown>>>();

/**
 * The attributes a writer gives a new container of `type` a record for, each with its default:
 * every attribute of every kind it can become where it stands.
 */
export function startingRecords(schema: Schema, type: string): ReadonlyMap<string, unknown> {
  let known = startingRecordsOf.get(schema);
  if (!known) startingRecordsOf.set(schema, (known = new Map()));
  let records = known.get(type);
  if (records) return records;
  records = new Map();
  const kinds = KINDS_A_CONTAINER_CAN_BECOME.find((family) => family.includes(type)) ?? [type];
  for (const kind of kinds)
    for (const [key, spec] of Object.entries(schema.nodes[kind]?.spec.attrs ?? {}))
      if (!records.has(key)) records.set(key, (spec as { default?: unknown }).default ?? null);
  known.set(type, records);
  return records;
}

/** What a writer stores for some leaves: each boundary's attributes, and the container records. */
export function writtenLeaves(
  schema: Schema,
  leaves: readonly Omit<SequenceLeaf, "inline">[],
): {
  boundaries: SequenceAttrs[];
  containers: Map<string, unknown>;
} {
  const containers = new Map<string, unknown>();
  const boundaries = leaves.map((leaf) => {
    if (leaf.path.length > MAX_SEQUENCE_DEPTH)
      throw new RangeError(
        `A line sits in ${String(leaf.path.length)} containers; a note holds at most ${String(MAX_SEQUENCE_DEPTH)}.`,
      );
    for (const frame of leaf.path)
      if (!containers.has(frame.id)) recordsOfContainer(schema, frame, containers);
    return { ...leaf.attrs, type: leaf.type, path: leaf.path.map((frame) => frame.id) };
  });
  return { boundaries, containers };
}

function marksFor(schema: Schema, holder: NodeType, raw: SequenceAttrs): readonly Mark[] {
  let marks: readonly Mark[] = Mark.none;
  for (const [name, type] of Object.entries(schema.marks)) {
    const value = record(own(raw, name));
    if (value) marks = type.create(attrsFor(type, value)).addToSet(marks);
  }
  return holder.allowedMarks(marks);
}

/** One block that holds no blocks, and the pieces it shows, in the order it shows them. */
export type LeafBlock<Inline extends SequenceInline = SequenceInline> = {
  node: ProseMirrorNode;
  shown: Inline[];
};

/** What one leaf reads as: its own block, and a paragraph after it for what the block cannot hold. */
export type ReadLeaf<Inline extends SequenceInline = SequenceInline> = {
  leaf: SequenceLeaf<Inline>;
  own: LeafBlock<Inline>;
  after: LeafBlock<Inline> | null;
};

/**
 * A document, and the blocks in it that hold no blocks, in document order. For the block at one
 * index: `starts` has where it starts in the document, `paths` the ids of the containers it sits
 * in, outermost first, and `leaves` the index of the leaf it was read from. A paragraph the reader
 * added in front of a container's content has the index of that container's first leaf, and the
 * one paragraph of a note with no leaf has 0.
 */
export type PlacedLeaves<Inline extends SequenceInline = SequenceInline> = {
  doc: ProseMirrorNode;
  blocks: LeafBlock<Inline>[];
  starts: number[];
  leaves: number[];
  paths: (readonly string[])[];
};

function inlineNode(
  schema: Schema,
  shape: Shape,
  piece: SequenceInline,
  holder: NodeType,
): ProseMirrorNode | "refused" | null {
  if ("text" in piece) {
    if (piece.text === "") return null;
    return holder.isTextblock
      ? schema.text(piece.text, marksFor(schema, holder, piece.marks))
      : "refused";
  }
  const type = schema.nodes[piece.atom];
  if (!shape.inlineItem(type)) return null;
  return shape.children.get(holder)!.has(type)
    ? type.create(attrsFor(type, piece.attrs))
    : "refused";
}

/**
 * The blocks one leaf reads as. `as` is the leaf's type where it stands, when that is not the
 * type it names.
 */
export function readLeaf<Inline extends SequenceInline>(
  schema: Schema,
  leaf: SequenceLeaf<Inline>,
  as?: NodeType,
): ReadLeaf<Inline> {
  const shape = shapeOf(schema);
  const named = schema.nodes[leaf.type];
  const type = as ?? (shape.leafBlock(named) ? named : shape.paragraph);
  const own: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  const shown: Inline[] = [];
  const shownAfter: Inline[] = [];
  let spilled = false;
  for (const piece of leaf.inline) {
    const held = spilled ? "refused" : inlineNode(schema, shape, piece, type);
    if (held === "refused") {
      spilled = true;
      const moved = inlineNode(schema, shape, piece, shape.paragraph);
      if (moved && moved !== "refused") {
        after.push(moved);
        shownAfter.push(piece);
      }
    } else if (held) {
      own.push(held);
      shown.push(piece);
    }
  }
  return {
    leaf,
    own: {
      node: type.create(attrsFor(type, leaf.attrs), type.isTextblock ? own : undefined),
      shown,
    },
    after:
      after.length > 0
        ? { node: shape.paragraph.create(null, Fragment.fromArray(after)), shown: shownAfter }
        : null,
  };
}

export type Fitted = { frame: SequenceFrame; type: NodeType };
type Open = Fitted & {
  children: ProseMirrorNode[];
  contentStart: number;
  firstBlock: number;
  firstLeaf: number;
};

const NO_FRAMES: readonly Fitted[] = [];
const NO_PATH: readonly string[] = [];

/**
 * Where the reader puts a leaf: the containers that hold it, outermost first, and the type it
 * reads as there.
 */
export function fitLeaf(
  schema: Schema,
  leaf: Pick<SequenceLeaf, "type" | "path">,
): { path: readonly Fitted[]; type: NodeType } {
  const shape = shapeOf(schema);
  const named = schema.nodes[leaf.type];
  let type = shape.leafBlock(named) ? named : shape.paragraph;
  let path = NO_FRAMES;
  let parent = schema.topNodeType;
  if (leaf.path.length > 0) {
    const fitted: Fitted[] = [];
    for (const frame of leaf.path.slice(0, MAX_SEQUENCE_DEPTH)) {
      const container = schema.nodes[frame.type];
      if (!shape.container(container) || !shape.children.get(parent)!.has(container)) break;
      fitted.push({ frame, type: container });
      parent = container;
    }
    while (fitted.length > 0 && !shape.children.get(parent)!.has(type)) {
      fitted.pop();
      parent = fitted.at(-1)?.type ?? schema.topNodeType;
    }
    path = fitted;
  }
  if (!shape.children.get(parent)!.has(type)) type = shape.paragraph;
  return { path, type };
}

/**
 * The document that leaves stand for, each already read, and where each of their blocks is in it.
 * Every sequence reads as a valid document, and every letter and every inline item the schema
 * knows is in that document once.
 */
export function placeLeaves<Inline extends SequenceInline>(
  schema: Schema,
  read: readonly ReadLeaf<Inline>[],
): PlacedLeaves<Inline> {
  const shape = shapeOf(schema);
  const top: ProseMirrorNode[] = [];
  const stack: Open[] = [];
  const blocks: LeafBlock<Inline>[] = [];
  const starts: number[] = [];
  const leaves: number[] = [];
  const paths: (readonly string[])[] = [];
  let pos = 0;
  let ids = NO_PATH;
  const into = () => stack.at(-1)?.children ?? top;
  const idsOfStack = () => (stack.length === 0 ? NO_PATH : stack.map((open) => open.frame.id));
  const put = (block: LeafBlock<Inline>, leaf: number) => {
    blocks.push(block);
    starts.push(pos);
    leaves.push(leaf);
    paths.push(ids);
    into().push(block.node);
    pos += block.node.nodeSize;
  };
  const fitted = new WeakMap<SequenceAttrs, { type: NodeType; attrs: SequenceAttrs }>();
  const frameAttrs = (type: NodeType, stored: SequenceAttrs) => {
    const known = fitted.get(stored);
    if (known?.type === type) return known.attrs;
    const attrs = attrsFor(type, stored);
    fitted.set(stored, { type, attrs });
    return attrs;
  };
  const closeTo = (depth: number) => {
    if (stack.length <= depth) return;
    while (stack.length > depth) {
      const open = stack.pop()!;
      const content = Fragment.fromArray(open.children);
      const missing = open.type.contentMatch.fillBefore(content, true);
      if (missing && missing.size > 0) {
        const path = [...idsOfStack(), open.frame.id];
        const added: LeafBlock<Inline>[] = [];
        const addedStarts: number[] = [];
        missing.descendants((node, offset) => {
          if (!node.isTextblock && !node.isLeaf) return true;
          added.push({ node, shown: [] });
          addedStarts.push(open.contentStart + offset);
          return false;
        });
        for (let block = open.firstBlock; block < starts.length; block++)
          starts[block]! += missing.size;
        blocks.splice(open.firstBlock, 0, ...added);
        starts.splice(open.firstBlock, 0, ...addedStarts);
        leaves.splice(open.firstBlock, 0, ...added.map(() => open.firstLeaf));
        paths.splice(open.firstBlock, 0, ...added.map(() => path));
        pos += missing.size;
      }
      into().push(
        open.type.create(
          frameAttrs(open.type, open.frame.attrs),
          missing ? missing.append(content) : content,
        ),
      );
      pos += 1;
    }
    ids = idsOfStack();
  };

  read.forEach((given, index) => {
    const leaf = given.leaf;
    const { path, type: leafType } = fitLeaf(schema, leaf);

    let shared = 0;
    while (
      shared < stack.length &&
      shared < path.length &&
      stack[shared]!.type === path[shared]!.type &&
      stack[shared]!.frame.id === path[shared]!.frame.id
    )
      shared++;
    closeTo(shared);
    if (path.length > shared) {
      for (const fitted of path.slice(shared)) {
        pos += 1;
        stack.push({
          ...fitted,
          children: [],
          contentStart: pos,
          firstBlock: blocks.length,
          firstLeaf: index,
        });
      }
      ids = idsOfStack();
    }

    const fits = given.own.node.type === leafType ? given : readLeaf(schema, leaf, leafType);
    put(fits.own, index);
    if (fits.after) put(fits.after, index);
  });
  closeTo(0);
  if (top.length === 0) put({ node: shape.paragraph.create(), shown: [] }, 0);
  return {
    doc: schema.topNodeType.create(null, Fragment.fromArray(top)),
    blocks,
    starts,
    leaves,
    paths,
  };
}

/**
 * The document a sequence of leaves stands for. Every sequence reads as a valid document, and
 * every letter and every inline item the schema knows is in that document once.
 */
export function readBodyLeaves(schema: Schema, leaves: readonly SequenceLeaf[]): ProseMirrorNode {
  return placeLeaves(
    schema,
    leaves.map((leaf) => readLeaf(schema, leaf)),
  ).doc;
}

/**
 * The leaves a document is written as. `idFor` names each container node, and no two containers
 * in a note may share a name. Marks on inline items are not written.
 */
export function flattenBody(
  doc: ProseMirrorNode,
  idFor: (container: ProseMirrorNode, index: number) => string,
): SequenceLeaf[] {
  const leaves: SequenceLeaf[] = [];
  let containers = 0;
  const visit = (node: ProseMirrorNode, path: SequenceFrame[]) => {
    node.forEach((child) => {
      if (child.isTextblock || child.isLeaf) {
        const inline: SequenceInline[] = [];
        child.forEach((piece) => {
          if (piece.isText)
            inline.push({
              text: piece.text ?? "",
              marks: Object.fromEntries(
                piece.marks.map((mark) => [mark.type.name, { ...mark.attrs }]),
              ),
            });
          else inline.push({ atom: piece.type.name, attrs: { ...piece.attrs } });
        });
        leaves.push({ type: child.type.name, attrs: { ...child.attrs }, path, inline });
        return;
      }
      const frame = {
        type: child.type.name,
        id: idFor(child, containers++),
        attrs: { ...child.attrs },
      };
      visit(child, [...path, frame]);
    });
  };
  visit(doc, []);
  return leaves;
}
