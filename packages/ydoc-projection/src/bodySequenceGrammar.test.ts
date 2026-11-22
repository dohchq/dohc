import { describe, expect, it } from "vitest";
import { Fragment, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { getDohcProseMirrorSchema, parseRichdocMarkdown } from "./import-export.js";
import {
  flattenBody,
  readBodyLeaves,
  type SequenceFrame,
  type SequenceInline,
  type SequenceLeaf,
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
const inlineAtoms = Object.values(schema.nodes).filter(
  (type) => type.isInline && type.isLeaf && !type.isText,
);

describe("reading any sequence", () => {
  const names = [...Object.keys(schema.nodes), "nonsense", ""];
  const marks = [...Object.keys(schema.marks), "nonsense"];
  const anyAttrs = (next: Next) =>
    pick(next, [
      {},
      { level: 2 },
      { level: "x", checked: true, colspan: 2, start: 5 },
      { nonsense: 1 },
      { calloutType: "warning", title: "T", fold: "+" },
    ]);
  const anyMarks = (next: Next) => {
    const on: Record<string, unknown> = {};
    while (next() < 0.4)
      on[pick(next, marks)] = pick(next, [true, {}, { href: "https://example.com" }, null, 3]);
    return on;
  };
  const anyLeaf = (next: Next): SequenceLeaf => {
    const path: SequenceFrame[] = [];
    while (next() < 0.6 && path.length < 70)
      path.push({
        type: next() < 0.8 ? pick(next, containers).name : pick(next, names),
        id: pick(next, ["a", "b", "c"]),
        attrs: anyAttrs(next),
      });
    const inline: SequenceInline[] = [];
    while (next() < 0.7)
      inline.push(
        next() < 0.7
          ? { text: pick(next, ["x", "word ", "\n", "", "😀"]), marks: anyMarks(next) }
          : { atom: pick(next, names), attrs: anyAttrs(next), marks: anyMarks(next) },
      );
    return {
      type: next() < 0.8 ? pick(next, leafBlocks).name : pick(next, names),
      attrs: anyAttrs(next),
      path,
      inline,
    };
  };

  it("gives a valid document that holds every letter once, in order", () => {
    for (let seed = 1; seed <= SEEDS * 10; seed++) {
      const next = random(seed);
      const leaves = Array.from({ length: Math.floor(next() * 12) }, () => anyLeaf(next));
      const doc = readBodyLeaves(schema, leaves);
      try {
        doc.check();
      } catch (error) {
        throw new Error(`seed ${String(seed)}: ${String(error)}\n${JSON.stringify(leaves)}`);
      }
      expect(lettersIn(doc), `seed ${String(seed)}`).toBe(lettersOf(leaves));
    }
  });

  it("reads no leaves as one empty paragraph", () => {
    expect(readBodyLeaves(schema, []).toJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("keeps the text that follows a block that holds no text", () => {
    const doc = readBodyLeaves(schema, [
      { type: "horizontalRule", attrs: {}, path: [], inline: [{ text: "after", marks: {} }] },
    ]);
    expect(doc.toJSON()).toEqual({
      type: "doc",
      content: [
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
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
});

describe("writing a document and reading it back", () => {
  const roundTrip = (doc: ProseMirrorNode) =>
    readBodyLeaves(
      schema,
      flattenBody(doc, (_node, index) => String(index)),
    );

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
    const atoms = allowedIn(holder).filter((type) => inlineAtoms.includes(type));
    while (next() < 0.7) {
      const marked =
        holder.spec.marks === "" || next() < 0.6
          ? []
          : [pick(next, [schema.marks.bold!, schema.marks.italic!, schema.marks.strike!]).create()];
      if (atoms.length > 0 && next() < 0.2)
        nodes.push(pick(next, atoms).create(null, null, marked));
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
    const merged = readBodyLeaves(
      schema,
      flattenBody(doc, () => "same"),
    );
    expect(merged.childCount).toBe(1);
    expect(merged.firstChild!.childCount).toBe(2);
  });
});
