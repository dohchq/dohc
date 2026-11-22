import { describe, expect, it } from "vitest";
import { Fragment, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { getDohcProseMirrorSchema, parseRichdocMarkdown } from "./import-export.js";
import {
  flattenBody,
  leavesOfSequence,
  readBodyLeaves,
  writtenLeaves,
  type SequenceFrame,
  type SequenceInline,
  type SequenceLeaf,
  type SequencePiece,
} from "./bodySequenceGrammar.js";

const schema = getDohcProseMirrorSchema();
const SEEDS = Number(process.env.BODY_SEQUENCE_SEEDS ?? 300);

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
type Next = () => number;
const pick = <T>(next: Next, from: readonly T[]): T => from[Math.floor(next() * from.length)]!;

const lettersOf = (leaves: readonly SequenceLeaf[]) =>
  leaves
    .flatMap((leaf) => leaf.inline.map((piece) => ("text" in piece ? piece.text : "")))
    .join("");
function lettersIn(doc: ProseMirrorNode) {
  let letters = "";
  doc.descendants((node) => {
    if (node.isText) letters += node.text ?? "";
  });
  return letters;
}

const blocks = Object.values(schema.nodes).filter(
  (type) => type.isBlock && type !== schema.topNodeType,
);
const containers = blocks.filter((type) => !type.isTextblock && !type.isLeaf);
const leafBlocks = blocks.filter((type) => type.isTextblock || type.isLeaf);
const inlineItems = Object.values(schema.nodes).filter(
  (type) => type.isInline && type.isLeaf && !type.isText,
);
const itemsOf = (leaves: readonly SequenceLeaf[]) =>
  leaves
    .flatMap((leaf) => leaf.inline)
    .flatMap((piece) =>
      "atom" in piece && inlineItems.some((type) => type.name === piece.atom) ? [piece.atom] : [],
    );
function itemsIn(doc: ProseMirrorNode) {
  const items: string[] = [];
  doc.descendants((node) => {
    if (inlineItems.includes(node.type)) items.push(node.type.name);
  });
  return items;
}

const names = [...Object.keys(schema.nodes), "nonsense", ""];
const marks = [...Object.keys(schema.marks), "nonsense"];
const anyValue = (next: Next): unknown =>
  pick(next, [
    0,
    2,
    70,
    -1,
    1.5,
    2n,
    "x",
    "",
    true,
    null,
    [],
    [1, "a"],
    {},
    { nested: { deep: [1] } },
    new Uint8Array([1, 2]),
  ]);
const anyAttrs = (next: Next) => {
  const attrs: Record<string, unknown> = {};
  const keys = ["level", "checked", "start", "colspan", "colwidth", "fold", "src", "tex", "x"];
  while (next() < 0.6) attrs[pick(next, keys)] = anyValue(next);
  return attrs;
};
const anyMarks = (next: Next) => {
  const on: Record<string, unknown> = {};
  while (next() < 0.4)
    on[pick(next, marks)] = pick(next, [true, false, {}, { href: 3 }, { href: "h" }, null, 3]);
  return on;
};
const anyInlinePiece = (next: Next): SequenceInline =>
  next() < 0.7
    ? { text: pick(next, ["x", "word ", "\n", "", "😀"]), marks: anyMarks(next) }
    : { atom: pick(next, names), attrs: anyAttrs(next) };

describe("reading any sequence", () => {
  const anyLeaf = (next: Next): SequenceLeaf => {
    const path: SequenceFrame[] = [];
    while (next() < 0.6 && path.length < 70)
      path.push({
        type: next() < 0.8 ? pick(next, containers).name : pick(next, names),
        id: pick(next, ["a", "b", "c"]),
        attrs: anyAttrs(next),
      });
    const inline: SequenceInline[] = [];
    while (next() < 0.7) inline.push(anyInlinePiece(next));
    return {
      type: next() < 0.8 ? pick(next, leafBlocks).name : pick(next, names),
      attrs: anyAttrs(next),
      path,
      inline,
    };
  };
  const reads = (seed: number, leaves: SequenceLeaf[], shown: unknown) => {
    const doc = readBodyLeaves(schema, leaves);
    try {
      doc.check();
    } catch (error) {
      throw new Error(`seed ${String(seed)}: ${String(error)} ${JSON.stringify(shown)}`);
    }
    expect(lettersIn(doc), `seed ${String(seed)}`).toBe(lettersOf(leaves));
    expect(itemsIn(doc), `seed ${String(seed)}`).toEqual(itemsOf(leaves));
  };

  it("gives a valid document that holds every letter and inline item once, in order", () => {
    for (let seed = 1; seed <= SEEDS * 10; seed++) {
      const next = random(seed);
      const leaves = Array.from({ length: Math.floor(next() * 12) }, () => anyLeaf(next));
      reads(seed, leaves, null);
    }
  });

  it("gives a valid document for boundaries and container records with any values", () => {
    const ids = ["a", "b", "c", "", "bad id", 3, null, ["a"]];
    const boundaryKeys = ["type", "path", "level", "language", "tex", "x"];
    const leafNames = [...leafBlocks.map((type) => type.name), "nonsense"];
    for (let seed = 1; seed <= SEEDS * 10; seed++) {
      const next = random(seed);
      const records = new Map<string, unknown>();
      for (const id of ["a", "b", "c"]) {
        if (next() < 0.8)
          records.set(id, next() < 0.8 ? pick(next, containers).name : anyValue(next));
        for (const key of ["checked", "start", "title", "fold", "colspan", "type"])
          if (next() < 0.3) records.set(`${id}.${key}`, anyValue(next));
      }
      const pieces: SequencePiece[] = [];
      while (next() < 0.9) {
        if (next() < 0.5) {
          pieces.push(anyInlinePiece(next));
          continue;
        }
        const boundary: Record<string, unknown> = {};
        while (next() < 0.8) {
          const key = pick(next, boundaryKeys);
          boundary[key] =
            key === "path" && next() < 0.8
              ? Array.from({ length: Math.floor(next() * 5) }, () => pick(next, ids))
              : key === "type" && next() < 0.8
                ? pick(next, leafNames)
                : anyValue(next);
        }
        pieces.push({ boundary });
      }
      reads(seed, leavesOfSequence(schema, pieces, records), pieces);
    }
  });

  it("reads no leaves as one empty paragraph", () => {
    expect(readBodyLeaves(schema, []).toJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("keeps what follows a block that holds no text as a paragraph after it", () => {
    const doc = readBodyLeaves(schema, [
      {
        type: "horizontalRule",
        attrs: {},
        path: [],
        inline: [
          { text: "after", marks: {} },
          { atom: "hardBreak", attrs: {} },
        ],
      },
    ]);
    expect(doc.toJSON()).toEqual({
      type: "doc",
      content: [
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }, { type: "hardBreak" }] },
      ],
    });
  });

  it("moves an inline item a code block cannot hold, and what follows it, to a paragraph", () => {
    const doc = readBodyLeaves(schema, [
      {
        type: "codeBlock",
        attrs: {},
        path: [],
        inline: [
          { text: "See ", marks: { bold: {} } },
          { atom: "wikilink", attrs: { target: "Design" } },
          { text: "!", marks: {} },
        ],
      },
    ]);
    doc.check();
    expect(doc.child(0).type.name).toBe("codeBlock");
    expect(doc.child(0).textContent).toBe("See ");
    expect(doc.child(0).firstChild!.marks).toHaveLength(0);
    expect(doc.child(1).type.name).toBe("paragraph");
    expect(doc.child(1).firstChild!.type.name).toBe("wikilink");
    expect(doc.child(1).lastChild!.text).toBe("!");
  });

  it("starts a list item with a paragraph when its first block is not one", () => {
    const item: SequenceFrame[] = [
      { type: "bulletList", id: "l", attrs: {} },
      { type: "listItem", id: "i", attrs: {} },
    ];
    const doc = readBodyLeaves(schema, [
      { type: "heading", attrs: { level: 2 }, path: item, inline: [{ text: "h", marks: {} }] },
    ]);
    doc.check();
    expect(doc.firstChild!.firstChild!.firstChild!.type.name).toBe("paragraph");
    expect(doc.firstChild!.firstChild!.child(1).type.name).toBe("heading");
  });

  it("puts a leaf whose path cannot hold it where the path last made sense", () => {
    const doc = readBodyLeaves(schema, [
      {
        type: "paragraph",
        attrs: {},
        path: [
          { type: "blockquote", id: "q", attrs: {} },
          { type: "table", id: "t", attrs: {} },
        ],
        inline: [{ text: "kept", marks: {} }],
      },
    ]);
    expect(doc.toJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }],
        },
      ],
    });
  });

  it("reads an attribute value its node cannot hold as the default, and a whole bigint as a number", () => {
    const heading = (level: unknown) =>
      readBodyLeaves(schema, [{ type: "heading", attrs: { level }, path: [], inline: [] }])
        .firstChild!.attrs.level as unknown;
    expect(heading(3)).toBe(3);
    expect(heading(3n)).toBe(3);
    expect(heading("x")).toBe(1);
    expect(heading(9)).toBe(1);
    expect(heading({ nested: true })).toBe(1);
  });

  it("turns a mark on only for an object, and reads code alone when code is on", () => {
    const marksOn = (given: Record<string, unknown>) =>
      readBodyLeaves(schema, [
        { type: "paragraph", attrs: {}, path: [], inline: [{ text: "x", marks: given }] },
      ]).firstChild!.firstChild!.marks.map((mark) => mark.type.name);
    expect(marksOn({ bold: {} })).toEqual(["bold"]);
    expect(marksOn({ bold: true, italic: false, strike: null, underline: 1 })).toEqual([]);
    expect(marksOn({ bold: {}, code: {}, italic: {} })).toEqual(["code"]);
    expect(marksOn({ "bold--abcdefgh": {} })).toEqual([]);
  });

  it("ends a path at an id used twice, an id with no record, or one past 64 deep", () => {
    const records = new Map<string, unknown>([
      ["q", "blockquote"],
      ["l", "bulletList"],
      ["i", "listItem"],
    ]);
    const depthOf = (path: unknown) => {
      const [leaf] = leavesOfSequence(schema, [{ boundary: { path } }], records);
      return leaf!.path.map((frame) => frame.id);
    };
    expect(depthOf(["q", "l", "i"])).toEqual(["q", "l", "i"]);
    expect(depthOf(["q", "q", "l"])).toEqual(["q"]);
    expect(depthOf(["q", "missing", "l"])).toEqual(["q"]);
    expect(depthOf("q")).toEqual([]);
    const deep = new Map<string, unknown>();
    const ids = Array.from({ length: 70 }, (_, at) => `q${String(at)}`);
    for (const id of ids) deep.set(id, "blockquote");
    const [leaf] = leavesOfSequence(schema, [{ boundary: { path: ids } }], deep);
    expect(leaf!.path).toHaveLength(64);
  });
});

describe("writing a document and reading it back", () => {
  const roundTrip = (doc: ProseMirrorNode, idFor = (index: number) => `c${String(index)}`) => {
    const leaves = flattenBody(doc, (_node, index) => idFor(index));
    const written = writtenLeaves(leaves);
    const pieces: SequencePiece[] = leaves.flatMap((leaf, at) => [
      { boundary: written.boundaries[at]! },
      ...leaf.inline,
    ]);
    return readBodyLeaves(schema, leavesOfSequence(schema, pieces, written.containers));
  };

  const allowedIn = (parent: NodeType) => {
    const allowed = new Set<NodeType>();
    const seen = new Set([parent.contentMatch]);
    for (const match of seen)
      for (let edge = 0; edge < match.edgeCount; edge++) {
        allowed.add(match.edge(edge).type);
        seen.add(match.edge(edge).next);
      }
    return [...allowed];
  };

  function anyInline(next: Next, holder: NodeType): Fragment {
    const nodes: ProseMirrorNode[] = [];
    const items = allowedIn(holder).filter((type) => inlineItems.includes(type));
    while (next() < 0.7) {
      const marked =
        holder.spec.marks === "" || next() < 0.6
          ? []
          : [pick(next, [schema.marks.bold!, schema.marks.italic!, schema.marks.strike!]).create()];
      if (items.length > 0 && next() < 0.2) nodes.push(pick(next, items).create());
      else nodes.push(schema.text(pick(next, ["a", "bc ", "def"]), marked));
    }
    return Fragment.fromArray(nodes);
  }

  function anyNode(next: Next, type: NodeType, depth: number): ProseMirrorNode {
    if (type.isTextblock)
      return type.create(type.name === "heading" ? { level: 2 } : null, anyInline(next, type));
    if (type.isLeaf) return type.create();
    const children: ProseMirrorNode[] = [];
    let match = type.contentMatch;
    for (let count = 0; count < 4; count++) {
      const choices = Array.from({ length: match.edgeCount }, (_, edge) => match.edge(edge)).filter(
        (edge) => depth < 4 || edge.type.isTextblock || edge.type.isLeaf || !edge.type.isBlock,
      );
      if (choices.length === 0 || (match.validEnd && count > 0 && next() < 0.4)) break;
      const edge = pick(next, choices);
      children.push(anyNode(next, edge.type, depth + 1));
      match = edge.next;
    }
    const content = Fragment.fromArray(children);
    const rest = match.fillBefore(Fragment.empty, true);
    return type.create(null, rest ? content.append(rest) : content);
  }

  it("gives the same document for any valid document", () => {
    let nested = 0;
    for (let seed = 1; seed <= SEEDS * 4; seed++) {
      const doc = anyNode(random(seed), schema.topNodeType, 0);
      doc.check();
      let emptyRow = false;
      doc.descendants((node) => {
        if (node.type.name === "tableRow" && node.childCount === 0) emptyRow = true;
        if (containers.includes(node.type)) nested++;
      });
      if (emptyRow) continue;
      const back = roundTrip(doc);
      if (!back.eq(doc))
        throw new Error(
          `seed ${String(seed)}\n${JSON.stringify(doc.toJSON())}\n${JSON.stringify(back.toJSON())}`,
        );
    }
    expect(nested).toBeGreaterThan(SEEDS);
  });

  it("gives the same document for notes with lists, to-dos, tables, callouts and code", () => {
    const markdown = [
      "# Title",
      "",
      "A paragraph with **bold**, *italic*, `code`, a [link](https://example.com) and a [[Page]].",
      "",
      "- one",
      "- two",
      "  - nested",
      "",
      "  second paragraph of two",
      "",
      "1. first",
      "2. second",
      "",
      "- [ ] open",
      "- [x] done",
      "",
      "> quoted",
      ">",
      "> - in a quote",
      "",
      "> [!warning] Careful",
      "> Inside a callout.",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "last",
    ].join("\n");
    const doc = schema.nodeFromJSON(parseRichdocMarkdown(markdown));
    doc.check();
    const types = new Set<string>();
    doc.descendants((node) => {
      types.add(node.type.name);
    });
    for (const type of ["bulletList", "taskItem", "table", "callout", "codeBlock", "blockquote"])
      expect([...types]).toContain(type);
    expect(roundTrip(doc).toJSON()).toEqual(doc.toJSON());
  });

  it("keeps two neighbouring quotes two, and makes them one when they share a name", () => {
    const quote = (text: string) =>
      schema.nodes.blockquote!.create(
        null,
        schema.nodes.paragraph!.create(null, schema.text(text)),
      );
    const doc = schema.topNodeType.create(null, [quote("a"), quote("b")]);
    expect(roundTrip(doc).eq(doc)).toBe(true);
    const merged = roundTrip(doc, () => "same");
    expect(merged.childCount).toBe(1);
    expect(merged.firstChild!.childCount).toBe(2);
  });
});
