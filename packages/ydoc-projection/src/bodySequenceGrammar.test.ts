import { describe, expect, it } from "vitest";
import { Fragment, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { getDohcProseMirrorSchema, parseRichdocMarkdown } from "./import-export.js";
import {
  allowedChildren,
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

const blocks = Object.values(schema.nodes).filter(
  (type) => type.isBlock && type !== schema.topNodeType,
);
const containers = blocks.filter((type) => !type.isTextblock && !type.isLeaf);
const leafBlocks = blocks.filter((type) => type.isTextblock || type.isLeaf);
const inlineItems = Object.values(schema.nodes).filter(
  (type) => type.isInline && type.isLeaf && !type.isText,
);
const isInlineItem = (name: string) => inlineItems.some((type) => type.name === name);

const contentOf = (pieces: readonly SequencePiece[]) =>
  pieces
    .map((piece) =>
      "text" in piece
        ? piece.text
        : "atom" in piece && isInlineItem(piece.atom)
          ? `<${piece.atom}>`
          : "",
    )
    .join("");
function contentIn(doc: ProseMirrorNode) {
  let content = "";
  doc.descendants((node) => {
    if (node.isText) content += node.text ?? "";
    else if (inlineItems.includes(node.type)) content += `<${node.type.name}>`;
  });
  return content;
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
    Infinity,
    [100n],
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
  const reads = (seed: number, leaves: SequenceLeaf[], given: readonly SequencePiece[]) => {
    const doc = readBodyLeaves(schema, leaves);
    try {
      doc.check();
    } catch (error) {
      throw new Error(`seed ${String(seed)}: ${String(error)}`);
    }
    expect(contentIn(doc), `seed ${String(seed)}`).toBe(contentOf(given));
  };

  it("gives a valid document that holds every letter and inline item once, in the order given", () => {
    for (let seed = 1; seed <= SEEDS * 10; seed++) {
      const next = random(seed);
      const leaves = Array.from({ length: Math.floor(next() * 12) }, () => anyLeaf(next));
      reads(
        seed,
        leaves,
        leaves.flatMap((leaf) => leaf.inline),
      );
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

  it("holds table and list numbers to whole numbers in range", () => {
    const records = new Map<string, unknown>([
      ["t", "table"],
      ["r", "tableRow"],
      ["c", "tableCell"],
      ["l", "orderedList"],
      ["i", "listItem"],
    ]);
    const read = (extra: [string, unknown][], path: string[]) => {
      const all = new Map([...records, ...extra]);
      const doc = readBodyLeaves(schema, leavesOfSequence(schema, [{ boundary: { path } }], all));
      doc.check();
      return doc;
    };
    const cell = (extra: [string, unknown][]) =>
      read(extra, ["t", "r", "c"]).firstChild!.firstChild!.firstChild!.attrs;
    expect(cell([["c.colspan", 3]]).colspan).toBe(3);
    for (const bad of [1e9, 0, -5, 1.5, Infinity, "2"])
      expect(cell([["c.colspan", bad]]).colspan, String(bad)).toBe(1);
    expect(cell([["c.colwidth", [100n, 20]]]).colwidth).toEqual([100, 20]);
    expect(cell([["c.colwidth", [Infinity]]]).colwidth).toBeNull();
    expect(cell([["c.colwidth", [-1]]]).colwidth).toBeNull();
    expect(cell([["c.colwidth", Array(1)]]).colwidth).toBeNull();
    const start = (value: unknown) =>
      read([["l.start", value]], ["l", "i"]).firstChild!.attrs.start as unknown;
    expect(start(7)).toBe(7);
    expect(start(0)).toBe(0);
    for (const bad of [1.5, -5, 1e20]) expect(start(bad), String(bad)).toBe(1);
    const height = (value: unknown) =>
      read([["r.height", value]], ["t", "r", "c"]).firstChild!.firstChild!.attrs.height as unknown;
    expect(height(40)).toBe(40);
    for (const bad of [1.5, 1e20, 0]) expect(height(bad), String(bad)).toBeNull();
  });

  it("reads an item as the kind its list holds, whatever its own record says", () => {
    const kinds = (list: string, recorded: string) => {
      const records = new Map<string, unknown>([
        ["l", list],
        ["i", recorded],
      ]);
      const [leaf] = leavesOfSequence(schema, [{ boundary: { path: ["l", "i"] } }], records);
      return leaf!.path.map((frame) => frame.type);
    };
    expect(kinds("bulletList", "taskItem")).toEqual(["bulletList", "listItem"]);
    expect(kinds("orderedList", "taskItem")).toEqual(["orderedList", "listItem"]);
    expect(kinds("taskList", "listItem")).toEqual(["taskList", "taskItem"]);
    expect(kinds("taskList", "blockquote")).toEqual(["taskList", "taskItem"]);
    expect(kinds("table", "listItem")).toEqual(["table", "tableRow"]);
    expect(kinds("blockquote", "listItem")).toEqual(["blockquote"]);
  });

  it("starts no paragraph for an empty string or an unknown element before the first boundary", () => {
    const read = (first: SequencePiece) =>
      (
        readBodyLeaves(
          schema,
          leavesOfSequence(
            schema,
            [first, { boundary: { type: "heading", level: 2 } }, { text: "Hi", marks: {} }],
            new Map(),
          ),
        ).toJSON() as { content: { type: string }[] }
      ).content.map((node) => node.type);
    expect(read({ text: "", marks: {} })).toEqual(["heading"]);
    expect(read({ atom: "nonsense", attrs: {} })).toEqual(["heading"]);
    expect(read({ atom: "hardBreak", attrs: {} })).toEqual(["paragraph", "heading"]);
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
    const written = writtenLeaves(schema, leaves);
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

  it("gives the same document for any valid document whose table rows all hold a cell", () => {
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

  it("gives a new container every record a kind it can become has, and every line a path", () => {
    const item = schema.nodes.listItem!.create(null, schema.nodes.paragraph!.create());
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph!.create(),
      schema.nodes.bulletList!.create(null, item),
    ]);
    const written = writtenLeaves(
      schema,
      flattenBody(doc, (_node, index) => ["L", "i"][index]!),
    );
    expect(written.boundaries.map((boundary) => boundary.path)).toEqual([[], ["L", "i"]]);
    expect(Object.fromEntries(written.containers)).toEqual({
      L: "bulletList",
      "L.loose": null,
      "L.start": 1,
      "L.type": null,
      i: "listItem",
      "i.checked": false,
    });
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

describe("the schema the format is written against", () => {
  const BLOCKS = [
    "blockquote",
    "bulletList",
    "callout",
    "codeBlock",
    "heading",
    "horizontalRule",
    "mathBlock",
    "orderedList",
    "paragraph",
    "rawBlock",
    "table",
    "taskList",
  ];
  const INLINE = [
    "escapedPunctuation",
    "hardBreak",
    "image",
    "inlineAtom",
    "mathInline",
    "rawInline",
    "text",
    "wikilink",
  ];

  it("allows the children the format's table lists", () => {
    expect(allowedChildren(schema)).toEqual({
      blockquote: BLOCKS,
      bulletList: ["listItem"],
      callout: BLOCKS,
      codeBlock: ["text"],
      doc: BLOCKS,
      heading: INLINE,
      listItem: BLOCKS,
      orderedList: ["listItem"],
      paragraph: INLINE,
      table: ["tableRow"],
      tableCell: BLOCKS,
      tableHeader: BLOCKS,
      tableRow: ["tableCell", "tableHeader"],
      taskItem: BLOCKS,
      taskList: ["taskItem"],
    });
  });

  it("has the attribute defaults the format's table lists", () => {
    const defaults: Record<string, unknown> = {};
    for (const type of [...Object.values(schema.nodes), ...Object.values(schema.marks)])
      for (const [key, spec] of Object.entries(type.spec.attrs ?? {}))
        defaults[`${type.name}.${key}`] = (spec as { default?: unknown }).default ?? null;
    expect(defaults).toEqual({
      "wikilink.target": "",
      "wikilink.label": null,
      "inlineAtom.atomId": "",
      "inlineAtom.params": "",
      "inlineAtom.source": "",
      "mathInline.tex": "",
      "rawInline.source": "",
      "callout.calloutType": "note",
      "callout.title": "",
      "callout.fold": "",
      "mathBlock.tex": "",
      "rawBlock.source": "",
      "image.src": "",
      "image.alt": "",
      "image.title": null,
      "escapedPunctuation.value": "",
      "codeBlock.language": null,
      "heading.level": 1,
      "bulletList.loose": null,
      "orderedList.start": 1,
      "orderedList.type": null,
      "orderedList.loose": null,
      "taskList.loose": null,
      "taskItem.checked": false,
      "tableCell.colspan": 1,
      "tableCell.rowspan": 1,
      "tableCell.colwidth": null,
      "tableCell.align": null,
      "tableHeader.colspan": 1,
      "tableHeader.rowspan": 1,
      "tableHeader.colwidth": null,
      "tableHeader.align": null,
      "tableRow.height": null,
      "link.href": null,
      "link.target": "_blank",
      "link.rel": "noopener noreferrer nofollow",
      "link.class": null,
      "link.title": null,
    });
  });

  it("has code as the one mark that excludes the others", () => {
    expect(
      Object.entries(schema.marks)
        .filter(([, type]) => type.spec.excludes !== undefined)
        .map(([name, type]) => [name, type.spec.excludes]),
    ).toEqual([["code", "_"]]);
  });

  it("needs a first paragraph only in a list item or a to-do", () => {
    const needing: string[] = [];
    for (const type of Object.values(schema.nodes)) {
      if (!type.isBlock || type.isTextblock || type.isLeaf) continue;
      for (const child of BLOCKS.map((name) => schema.nodes[name]!)) {
        if (type.contentMatch.matchType(child) !== null) continue;
        const front = type.contentMatch.fillBefore(Fragment.from(child.createAndFill()), false);
        if (front && front.childCount > 0)
          needing.push(`${type.name} before ${child.name}: ${front.firstChild!.type.name}`);
      }
    }
    expect(new Set(needing.map((line) => line.split(" ")[0]))).toEqual(
      new Set(["listItem", "taskItem"]),
    );
    expect(new Set(needing.map((line) => line.split(": ")[1]))).toEqual(new Set(["paragraph"]));
  });
});
