import {
  Fragment,
  Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from "@tiptap/pm/model";

export const MAX_SEQUENCE_DEPTH = 64;
export const BODY_SEQUENCE_FIELD = "sequence";
export const BODY_CONTAINERS_FIELD = "containers";
export const BLOCK_ELEMENT = "block";
export const CONTAINER_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type SequenceAttrs = Record<string, unknown>;
export type SequenceFrame = { type: string; id: string; attrs: SequenceAttrs };
export type SequenceInline =
  | { text: string; marks: SequenceAttrs }
  | { atom: string; attrs: SequenceAttrs };
export type SequenceLeaf = {
  type: string;
  attrs: SequenceAttrs;
  path: SequenceFrame[];
  inline: SequenceInline[];
};
export type SequencePiece = { boundary: SequenceAttrs } | SequenceInline;

/**
 * The note's container records: `<id>` holds a container's node type and `<id>.<attribute>` one of
 * its attributes.
 */
export type ContainerRecords = { get(key: string): unknown };

const record = (value: unknown): SequenceAttrs | null => {
  if (typeof value !== "object" || value === null) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null ? (value as SequenceAttrs) : null;
};

const filled = (value: unknown): unknown[] | null =>
  Array.isArray(value) && Object.keys(value).length === value.length ? (value as unknown[]) : null;

const own = (holder: SequenceAttrs, key: string): unknown =>
  Object.hasOwn(holder, key) ? holder[key] : undefined;

const whole = (value: unknown): unknown =>
  typeof value === "bigint" &&
  value >= BigInt(Number.MIN_SAFE_INTEGER) &&
  value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
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
const widths = (value: unknown) =>
  value === null ||
  (filled(value) !== null &&
    (value as unknown[]).length <= MAX_SPAN &&
    (value as unknown[]).every((width) => finite(width) && (width as number) >= 0));
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

function attrsFor(type: NodeType | MarkType, raw: unknown): SequenceAttrs {
  const given = record(raw) ?? {};
  const attrs: SequenceAttrs = {};
  for (const key of Object.keys(type.spec.attrs ?? {})) {
    const held = whole(own(given, key));
    const value = filled(held)?.map(whole) ?? held;
    if (value !== undefined && (VALUE_RULES[`${type.name}.${key}`] ?? plain)(value))
      attrs[key] = value;
  }
  return attrs;
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

function pathOf(schema: Schema, value: unknown, containers: ContainerRecords): SequenceFrame[] {
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
    const attrs: SequenceAttrs = {};
    for (const key of Object.keys(type.spec.attrs ?? {})) {
      const held = containers.get(`${id}.${key}`);
      if (held !== undefined) attrs[key] = held;
    }
    path.push({ type: type.name, id, attrs });
    parent = type;
  }
  return path;
}

/**
 * The leaves a sequence holds. What stands before the first boundary is a paragraph with no path,
 * if any of it is a letter or an inline item the schema knows.
 */
export function leavesOfSequence(
  schema: Schema,
  pieces: Iterable<SequencePiece>,
  containers: ContainerRecords,
): SequenceLeaf[] {
  const shape = shapeOf(schema);
  const leaves: SequenceLeaf[] = [];
  for (const piece of pieces) {
    if ("boundary" in piece)
      leaves.push({
        type:
          typeof own(piece.boundary, "type") === "string"
            ? String(piece.boundary.type)
            : "paragraph",
        attrs: piece.boundary,
        path: pathOf(schema, own(piece.boundary, "path"), containers),
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
 * become where it stands, so that each later change to one is an overwrite.
 */
export function recordsOfContainer(schema: Schema, frame: SequenceFrame): Map<string, unknown> {
  const records = new Map<string, unknown>([[frame.id, frame.type]]);
  const kinds = KINDS_A_CONTAINER_CAN_BECOME.find((family) => family.includes(frame.type)) ?? [
    frame.type,
  ];
  for (const kind of kinds)
    for (const [key, spec] of Object.entries(schema.nodes[kind]?.spec.attrs ?? {}))
      if (!records.has(`${frame.id}.${key}`))
        records.set(`${frame.id}.${key}`, (spec as { default?: unknown }).default ?? null);
  for (const [key, value] of Object.entries(frame.attrs)) records.set(`${frame.id}.${key}`, value);
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
      if (!containers.has(frame.id))
        for (const [key, value] of recordsOfContainer(schema, frame)) containers.set(key, value);
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

type Open = { frame: SequenceFrame; type: NodeType; children: ProseMirrorNode[] };

function closed(open: Open): ProseMirrorNode {
  const content = Fragment.fromArray(open.children);
  const missing = open.type.contentMatch.fillBefore(content, true);
  return open.type.create(
    attrsFor(open.type, open.frame.attrs),
    missing ? missing.append(content) : content,
  );
}

/**
 * The document a sequence of leaves stands for. Every sequence reads as a valid document, and
 * every letter and every inline item the schema knows is in that document once.
 */
export function readBodyLeaves(schema: Schema, leaves: readonly SequenceLeaf[]): ProseMirrorNode {
  const shape = shapeOf(schema);
  const top: ProseMirrorNode[] = [];
  const stack: Open[] = [];
  const into = () => stack.at(-1)?.children ?? top;
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const node = closed(stack.pop()!);
      into().push(node);
    }
  };
  const inline = (piece: SequenceInline, holder: NodeType): ProseMirrorNode | "refused" | null => {
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
  };

  for (const leaf of leaves) {
    const given = schema.nodes[leaf.type];
    let leafType = shape.leafBlock(given) ? given : shape.paragraph;
    const path: { frame: SequenceFrame; type: NodeType }[] = [];
    let parent = schema.topNodeType;
    for (const frame of leaf.path.slice(0, MAX_SEQUENCE_DEPTH)) {
      const type = schema.nodes[frame.type];
      if (!shape.container(type) || !shape.children.get(parent)!.has(type)) break;
      path.push({ frame, type });
      parent = type;
    }
    while (!shape.children.get(parent)!.has(leafType)) {
      if (path.length === 0) leafType = shape.paragraph;
      else path.pop();
      parent = path.at(-1)?.type ?? schema.topNodeType;
    }

    let shared = 0;
    while (
      shared < stack.length &&
      shared < path.length &&
      stack[shared]!.type === path[shared]!.type &&
      stack[shared]!.frame.id === path[shared]!.frame.id
    )
      shared++;
    closeTo(shared);
    for (const { frame, type } of path.slice(shared)) stack.push({ frame, type, children: [] });

    const own: ProseMirrorNode[] = [];
    const after: ProseMirrorNode[] = [];
    let spilled = false;
    for (const piece of leaf.inline) {
      const held = spilled ? "refused" : inline(piece, leafType);
      if (held === "refused") {
        spilled = true;
        const moved = inline(piece, shape.paragraph);
        if (moved && moved !== "refused") after.push(moved);
      } else if (held) own.push(held);
    }
    into().push(
      leafType.create(attrsFor(leafType, leaf.attrs), leafType.isTextblock ? own : undefined),
    );
    if (after.length > 0) into().push(shape.paragraph.create(null, Fragment.fromArray(after)));
  }
  closeTo(0);
  if (top.length === 0) top.push(shape.paragraph.create());
  return schema.topNodeType.create(null, Fragment.fromArray(top));
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
