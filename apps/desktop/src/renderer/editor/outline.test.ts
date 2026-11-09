import { EditorState } from "@tiptap/pm/state";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vitest";
import { extractOutline, resolveActiveHeadingIndex, updateOutline, type OutlineHeading } from "./outline";
import { codeBlock, doc, heading, paragraph, randomEdit, schema, seededRandom } from "./testDocs";

// Extraction over real ProseMirror documents (testDocs.ts). Positions are
// hand-computed from node sizes: a textblock's nodeSize is text length + 2,
// and the first top-level block starts at pos 0.

describe("extractOutline", () => {
  it("extracts headings with level, text, and pos in document order", () => {
    // "Title" (nodeSize 7) → paragraph "intro copy" at 7 (nodeSize 12) →
    // "Section A" at 19 (nodeSize 11) → "Subsection" at 30.
    const d = doc(
      heading(1, "Title"),
      paragraph("intro copy"),
      heading(2, "Section A"),
      heading(3, "Subsection"),
    );

    expect(extractOutline(d)).toEqual([
      { level: 1, text: "Title", pos: 0 },
      { level: 2, text: "Section A", pos: 19 },
      { level: 3, text: "Subsection", pos: 30 },
    ]);
  });

  it("supports all six heading levels", () => {
    const d = doc(...[1, 2, 3, 4, 5, 6].map((level) => heading(level, `H${level}`)));
    expect(extractOutline(d).map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("skips headings with no text (empty or whitespace-only)", () => {
    // Empty heading nodeSize 2 → whitespace heading at 2 (nodeSize 5) →
    // "Real heading" at 7.
    const d = doc(heading(1), heading(2, "   "), heading(1, "Real heading"));
    expect(extractOutline(d)).toEqual([{ level: 1, text: "Real heading", pos: 7 }]);
  });

  it("trims heading text", () => {
    expect(extractOutline(doc(heading(1, "  Padded  ")))).toEqual([
      { level: 1, text: "Padded", pos: 0 },
    ]);
  });

  it("finds a heading nested in a container block", () => {
    // blockquote at 0 opens; its heading starts at 1.
    const d = doc(schema.node("blockquote", null, [heading(2, "Quoted")]));
    expect(extractOutline(d)).toEqual([{ level: 2, text: "Quoted", pos: 1 }]);
  });

  it("ignores non-heading nodes entirely", () => {
    const d = doc(paragraph("not a heading"), codeBlock("# not markdown here"));
    expect(extractOutline(d)).toEqual([]);
  });

  it("falls back to the schema's default level when none is supplied", () => {
    const d = doc(schema.node("heading", null, [schema.text("No level")]));
    expect(extractOutline(d)).toEqual([{ level: 1, text: "No level", pos: 0 }]);
  });

  it("falls back to level 1 for a non-numeric level attr", () => {
    // ProseMirror's computeAttrs applies the default only for a *missing*
    // attribute; an explicit null survives into the real node's attrs.
    const d = doc(schema.node("heading", { level: null }, [schema.text("No level")]));
    expect(d.child(0).attrs.level).toBeNull();
    expect(extractOutline(d)).toEqual([{ level: 1, text: "No level", pos: 0 }]);
  });

  it("returns an empty array for a doc with no headings", () => {
    expect(extractOutline(doc(paragraph("just prose")))).toEqual([]);
  });
});

describe("resolveActiveHeadingIndex", () => {
  const headings = [0, 200, 500, 900].map((pos) => ({ pos }));

  it("returns -1 for an empty heading list", () => {
    expect(resolveActiveHeadingIndex([], 500)).toBe(-1);
  });

  it("returns 0 before the reading position reaches the first heading", () => {
    expect(resolveActiveHeadingIndex([{ pos: 100 }], 50)).toBe(0);
  });

  it("picks the last heading at or before the reading position", () => {
    expect(resolveActiveHeadingIndex(headings, 250)).toBe(1);
    expect(resolveActiveHeadingIndex(headings, 899)).toBe(2);
    expect(resolveActiveHeadingIndex(headings, 900)).toBe(3);
    expect(resolveActiveHeadingIndex(headings, 5000)).toBe(3);
  });

  it("searches a long outline without reading every heading", () => {
    let reads = 0;
    const long = new Proxy(
      Array.from({ length: 1_024 }, (_, index) => ({ pos: index * 20 })),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(resolveActiveHeadingIndex(long, 15_072)).toBe(753);
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe("updateOutline", () => {
  const quote = (...blocks: ProseMirrorNode[]) => schema.node("blockquote", null, blocks);

  it("matches a full read after every edit", () => {
    const random = seededRandom(2260);
    let state = EditorState.create({
      doc: doc(
        heading(1, "Title"),
        paragraph("intro copy"),
        quote(heading(2, "Quoted"), paragraph("inside")),
        heading(2, "Section"),
        paragraph("body"),
        heading(3, "Sub"),
      ),
    });
    let outline: readonly OutlineHeading[] = extractOutline(state.doc);
    for (let step = 0; step < 400; step += 1) {
      const next = state.apply(randomEdit(state, random, ["Head", " ", "x", "\n"]));
      outline = updateOutline(outline, state.doc, next.doc);
      state = next;
      expect(outline, `step ${step}`).toEqual(extractOutline(state.doc));
    }
  });

  it("finds a paragraph that became a heading and drops a heading that lost its text", () => {
    const before = doc(paragraph("Soon a heading"), heading(2, "Gone"), paragraph("after"));
    let state = EditorState.create({ doc: before });
    state = state.apply(state.tr.setBlockType(1, 1, schema.nodes.heading, { level: 3 }));
    let outline = updateOutline(extractOutline(before), before, state.doc);
    expect(outline).toEqual(extractOutline(state.doc));

    const withText = state.doc;
    state = state.apply(state.tr.delete(17, 21));
    outline = updateOutline(outline, withText, state.doc);
    expect(outline).toEqual([{ level: 3, text: "Soon a heading", pos: 0 }]);
  });

  it("reads only the edited heading when typing in a note with 2,000 headings", () => {
    const before = doc(...Array.from({ length: 2000 }, (_, index) => heading(2, `Section ${index}`)));
    const outline = extractOutline(before);
    const state = EditorState.create({ doc: before });
    const middle = outline[1000]!.pos + 2;
    const after = state.apply(state.tr.insertText("x", middle)).doc;

    const reads = vi.spyOn(ProseMirrorNode.prototype, "textContent", "get");
    try {
      const next = updateOutline(outline, before, after);
      expect(reads.mock.calls.length).toBeLessThan(5);
      expect(next[1000]!.text).toBe("Sxection 1000");
      expect(next).toEqual(extractOutline(after));
    } finally {
      reads.mockRestore();
    }
  });
});
