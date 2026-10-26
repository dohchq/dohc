import { describe, expect, it } from "vitest";
import { extractOutline, resolveActiveHeadingIndex } from "./outline";
import { codeBlock, doc, heading, paragraph, schema } from "./testDocs";

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
