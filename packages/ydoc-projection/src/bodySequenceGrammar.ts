import {
  Fragment,
  Mark,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from "@tiptap/pm/model";

export const MAX_SEQUENCE_DEPTH = 64;

export type SequenceAttrs = Record<string, unknown>;
export type SequenceFrame = { type: string; id: string; attrs: SequenceAttrs };
export type SequenceInline =
  | { text: string; marks: SequenceAttrs }
  | { atom: string; attrs: SequenceAttrs; marks: SequenceAttrs };
export type SequenceLeaf = {
  type: string;
  attrs: SequenceAttrs;
  path: SequenceFrame[];
  inline: SequenceInline[];
};

export type SequencePiece = { boundary: SequenceAttrs } | SequenceInline;

const record = (value: unknown): SequenceAttrs | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SequenceAttrs)
    : null;

/** The leaf a boundary's attributes describe: its type, its own attributes and its path. */
export function leafOfBoundary(attributes: SequenceAttrs): Omit<SequenceLeaf, "inline"> {
  const depth = attributes.depth;
  const frames =
    typeof depth === "number" && Number.isInteger(depth) && depth > 0
      ? Math.min(depth, MAX_SEQUENCE_DEPTH)
      : 0;
  const path: SequenceFrame[] = [];
  for (let at = 0; at < frames; at++) {
    const frame = record(attributes[`c${String(at)}`]);
    if (!frame || typeof frame.t !== "string" || typeof frame.id !== "string") break;
    path.push({ type: frame.t, id: frame.id, attrs: record(attributes[`a.${frame.id}`]) ?? {} });
  }
  return {
    type: typeof attributes.type === "string" ? attributes.type : "paragraph",
    attrs: attributes,
    path,
  };
}

/** The attributes a writer gives the boundary of a leaf. */
export function boundaryOfLeaf(leaf: Omit<SequenceLeaf, "inline">): SequenceAttrs {
  const attributes: SequenceAttrs = { ...leaf.attrs, type: leaf.type };
  if (leaf.path.length > 0) attributes.depth = leaf.path.length;
  leaf.path.forEach((frame, at) => {
    attributes[`c${String(at)}`] = { t: frame.type, id: frame.id };
    attributes[`a.${frame.id}`] = frame.attrs;
  });
  return attributes;
}

/** The leaves a sequence holds. Text before the first boundary is a paragraph with no path. */
export function leavesOfSequence(pieces: Iterable<SequencePiece>): SequenceLeaf[] {
  const leaves: SequenceLeaf[] = [];
  for (const piece of pieces) {
    if ("boundary" in piece) leaves.push({ ...leafOfBoundary(piece.boundary), inline: [] });
    else if (leaves.length === 0)
      leaves.push({ type: "paragraph", attrs: {}, path: [], inline: [piece] });
    else leaves.at(-1)!.inline.push(piece);
  }
  return leaves;
}

type Shape = {
  children: Map<NodeType, Set<NodeType>>;
  leafBlock(type: NodeType | undefined): type is NodeType;
  container(type: NodeType | undefined): type is NodeType;
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
    paragraph: schema.nodes.paragraph!,
  };
  shapes.set(schema, shape);
  return shape;
}

function attrsFor(type: NodeType | Mark["type"], raw: unknown): SequenceAttrs {
  const given = typeof raw === "object" && raw !== null ? (raw as SequenceAttrs) : {};
  const attrs: SequenceAttrs = {};
  for (const key of Object.keys(type.spec.attrs ?? {}))
    if (given[key] !== undefined) attrs[key] = given[key];
  return attrs;
}

function marksFor(schema: Schema, parent: NodeType, raw: SequenceAttrs): readonly Mark[] {
  let marks: readonly Mark[] = Mark.none;
  for (const [name, type] of Object.entries(schema.marks)) {
    const value = raw[name];
    if (value === undefined || value === null || value === false) continue;
    marks = type.create(attrsFor(type, value)).addToSet(marks);
  }
  return parent.allowedMarks(marks);
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
 * every letter in it is in that document once.
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

    const inlineFor = (holder: NodeType) => {
      const allowed = shape.children.get(holder)!;
      const nodes: ProseMirrorNode[] = [];
      for (const piece of leaf.inline) {
        if ("text" in piece) {
          if (piece.text !== "")
            nodes.push(schema.text(piece.text, marksFor(schema, holder, piece.marks)));
          continue;
        }
        const type = schema.nodes[piece.atom];
        if (!type || !type.isInline || !type.isLeaf || type.isText || !allowed.has(type)) continue;
        nodes.push(
          type.create(attrsFor(type, piece.attrs), null, marksFor(schema, holder, piece.marks)),
        );
      }
      return Fragment.fromArray(nodes);
    };

    if (leafType.isTextblock) {
      into().push(leafType.create(attrsFor(leafType, leaf.attrs), inlineFor(leafType)));
      continue;
    }
    into().push(leafType.create(attrsFor(leafType, leaf.attrs)));
    const after = inlineFor(shape.paragraph);
    if (after.childCount > 0) into().push(shape.paragraph.create(null, after));
  }
  closeTo(0);
  if (top.length === 0) top.push(shape.paragraph.create());
  return schema.topNodeType.create(null, Fragment.fromArray(top));
}

const marksOf = (node: ProseMirrorNode): SequenceAttrs =>
  Object.fromEntries(node.marks.map((mark) => [mark.type.name, { ...mark.attrs }]));

/**
 * The leaves a document is written as. `idFor` names each container node; two neighbouring
 * containers of one type need different names to stay two.
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
          if (piece.isText) inline.push({ text: piece.text ?? "", marks: marksOf(piece) });
          else
            inline.push({
              atom: piece.type.name,
              attrs: { ...piece.attrs },
              marks: marksOf(piece),
            });
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
