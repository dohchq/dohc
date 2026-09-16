// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView, type DecorationSource } from "@tiptap/pm/view";

const commonJsView = createRequire(import.meta.url)("@tiptap/pm/view") as typeof import("@tiptap/pm/view");

const schema = new Schema({ nodes: {
  doc: { content: "block+" },
  paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
  blockquote: { group: "block", content: "block+", toDOM: () => ["blockquote", 0] },
  text: { group: "inline" },
} });
const paragraph = () => schema.nodes.paragraph.create(null, schema.text("abcdef"));
const views: EditorView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.destroy(); });

function gutters(doc: ProseMirrorNode): Decoration[] {
  const decorations: Decoration[] = [];
  doc.forEach((node, pos, index) => decorations.push(
    Decoration.node(pos, pos + node.nodeSize, { class: "block" }, { id: `node-${index}` }),
    Decoration.widget(pos, () => document.createElement("span"), { id: `widget-${index}` }),
  ));
  return decorations;
}

function entries(source: DecorationSource) {
  const result: { from: number; to: number; id: string }[] = [];
  source.forEachSet((set) => {
    for (const decoration of set.find()) {
      result.push({ from: decoration.from, to: decoration.to, id: String(decoration.spec.id) });
    }
  });
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

describe("patched ProseMirror decoration projection", () => {
  it("applies the same skip and inline behavior to the CommonJS build", () => {
    const doc = schema.nodes.doc.create(null, [paragraph(), paragraph()]);
    const outer = commonJsView.Decoration.node(0, 8, { class: "block" });
    const set = commonJsView.DecorationSet.create(doc, [outer]);
    let reads = 0;
    Object.defineProperty(outer, "from", { get() { reads++; return 0; } });
    expect(entries(set.forChild(0, doc.child(0)))).toEqual([]);
    expect(reads).toBe(0);
    const added = set.add(doc, [commonJsView.Decoration.inline(3, 14, { class: "cross" }, { id: "cross" })]);
    expect(entries(added.forChild(0, doc.child(0)))).toEqual([{ from: 2, to: 6, id: "cross" }]);
    const tr = EditorState.create({ schema, doc }).tr.insertText("x", 2);
    const mapped = added.map(tr.mapping, tr.doc);
    expect(entries(mapped.forChild(0, tr.doc.child(0)))).toEqual([{ from: 3, to: 7, id: "cross" }]);
    const removed = mapped.remove(mapped.find().filter((decoration) => decoration.spec.id === "cross"));
    expect(entries(removed.forChild(0, tr.doc.child(0)))).toEqual([]);
  });

  it.each([10, 100, 200])("does not read %i blocks' node/widget ranges for each child", (count) => {
    const doc = schema.nodes.doc.create(null, Array.from({ length: count }, paragraph));
    const decorations = gutters(doc);
    const set = DecorationSet.create(doc, [...decorations]);
    let rangeReads = 0;
    for (const decoration of decorations) {
      const from = decoration.from;
      Object.defineProperty(decoration, "from", { get() { rangeReads++; return from; } });
    }
    doc.forEach((node, offset) => expect(set.forChild(offset, node)).toBe(DecorationSet.empty));
    expect(rangeReads).toBe(0);
    expect(set.find()).toHaveLength(count * 2);
  });

  it("preserves crossing and nested inline decorations through add, map, and remove", () => {
    const quote = schema.nodes.blockquote.create(null, [paragraph(), paragraph()]);
    const doc = schema.nodes.doc.create(null, [paragraph(), quote, paragraph()]);
    const outer = DecorationSet.create(doc, gutters(doc));
    const inline = [
      Decoration.inline(2, 4, { class: "local" }, { id: "local" }),
      Decoration.inline(3, 32, { class: "cross" }, { id: "cross" }),
      Decoration.inline(11, 13, { class: "nested" }, { id: "nested" }),
    ];
    const added = outer.add(doc, [...inline]);
    expect(entries(added.forChild(0, doc.child(0)))).toEqual([
      { from: 2, to: 6, id: "cross" }, { from: 1, to: 3, id: "local" },
    ]);
    const nested = added.forChild(8, quote).forChild(0, quote.child(0));
    expect(entries(nested)).toEqual([
      { from: 0, to: 6, id: "cross" }, { from: 1, to: 3, id: "nested" },
    ]);
    const tr = EditorState.create({ schema, doc }).tr.insertText("xx", 2);
    const mapped = added.map(tr.mapping, tr.doc);
    expect(entries(mapped.forChild(0, tr.doc.child(0)))).toEqual([
      { from: 4, to: 8, id: "cross" }, { from: 3, to: 5, id: "local" },
    ]);
    expect(entries(mapped.forChild(10, quote).forChild(0, quote.child(0)))).toEqual(entries(nested));
    const removed = mapped.remove(mapped.find().filter((decoration) => inline.some((original) => original.spec.id === decoration.spec.id)));
    expect(removed.find()).toHaveLength(6);
    tr.doc.forEach((node, pos) => expect(entries(removed.forChild(pos, node))).toEqual([]));
    const restored = removed.add(tr.doc, [Decoration.inline(2, 30, { class: "again" }, { id: "again" })]);
    expect(entries(restored.forChild(10, quote).forChild(8, quote.child(1)))).toEqual([
      { from: 0, to: 6, id: "again" },
    ]);
    const deletion = EditorState.create({ schema, doc: tr.doc }).tr.delete(1, tr.doc.content.size - 1);
    const cleared = restored.map(deletion.mapping, deletion.doc);
    expect(cleared.find().some((decoration) => decoration.spec.id === "again")).toBe(false);
    expect(entries(cleared.forChild(0, deletion.doc.child(0)))).toEqual([]);
  });

  it("combines node/widget and inline plugin sets in a nested editor view", () => {
    const quote = schema.nodes.blockquote.create(null, [paragraph(), paragraph()]);
    const doc = schema.nodes.doc.create(null, [paragraph(), quote, paragraph()]);
    const blockSet = DecorationSet.create(doc, gutters(doc));
    const inlineSet = DecorationSet.create(doc, [Decoration.inline(3, 32, { class: "cross" })]);
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema, doc, plugins: [
        new Plugin({ props: { decorations: () => blockSet } }),
        new Plugin({ props: { decorations: () => inlineSet } }),
      ] }),
    });
    views.push(view);
    expect(view.dom.querySelectorAll(".block")).toHaveLength(3);
    expect(view.dom.querySelectorAll("blockquote p .cross")).toHaveLength(2);
    expect(view.dom.textContent).toBe("abcdef".repeat(4));
  });
});
