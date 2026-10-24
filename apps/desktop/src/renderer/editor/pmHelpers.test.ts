import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { documentChange } from "./pmHelpers";
import { doc, paragraph, schema } from "./testDocs";

// Each paragraph("p0".."p999") is 4 or 5 positions wide; positions below come
// from the built doc rather than by hand.
function longState() {
  return EditorState.create({
    doc: doc(...Array.from({ length: 1_000 }, (_, index) => paragraph(`p${index}`))),
  });
}

function positionOfChild(state: EditorState, index: number): number {
  let pos = 0;
  for (let child = 0; child < index; child += 1) pos += state.doc.child(child).nodeSize;
  return pos;
}

describe("documentChange", () => {
  it("names only the block that typing changed", () => {
    const state = longState();
    const pos = positionOfChild(state, 500);
    const tr = state.tr.insertText("x", pos + 2);

    expect(documentChange(tr.before, tr.doc).textblocks).toEqual([
      { node: tr.doc.child(500), pos },
    ]);
  });

  it("names both halves of a split block", () => {
    const state = longState();
    const pos = positionOfChild(state, 10);
    const tr = state.tr.split(pos + 2);

    expect(documentChange(tr.before, tr.doc).textblocks.map(({ node }) => node.textContent)).toEqual([
      "p",
      "10",
    ]);
  });

  it("names every block of a paste", () => {
    const state = longState();
    const pos = positionOfChild(state, 10);
    const pasted = ["a", "b", "c"].map((text) => paragraph(text));
    const tr = state.tr.replaceWith(pos, positionOfChild(state, 12), pasted);

    const change = documentChange(tr.before, tr.doc);
    expect(change.textblocks.map(({ node }) => node.textContent)).toEqual(["a", "b", "c"]);
    expect(change.textblocks[0]!.pos).toBe(pos);
  });

  it("names a block whose marks changed and nothing else", () => {
    const state = longState();
    const pos = positionOfChild(state, 3);
    const tr = state.tr.addMark(pos + 1, pos + 3, schema.marks.code.create());

    expect(documentChange(tr.before, tr.doc).textblocks).toEqual([{ node: tr.doc.child(3), pos }]);
  });

  // The diff compares the blocks that now meet by content, so it can name
  // them too. Rescanning a neighbour is harmless; reading the note is not.
  it("names at most the neighbours when whole blocks were removed", () => {
    const state = longState();
    const from = positionOfChild(state, 20);
    const tr = state.tr.delete(from, positionOfChild(state, 22));

    const named = documentChange(tr.before, tr.doc).textblocks.map(({ node }) => node.textContent);
    expect(named.length).toBeLessThanOrEqual(2);
    expect(named).not.toContain("p20");
    expect(named).not.toContain("p21");
  });

  it("names nothing for an unchanged document", () => {
    const state = longState();
    expect(documentChange(state.doc, state.doc).textblocks).toEqual([]);
  });

  it("maps positions around a change made by replacing the whole document", () => {
    const state = longState();
    const pos = positionOfChild(state, 500);
    const typed = state.tr.insertText("xy", pos + 2).doc;
    const tr = state.tr.replaceWith(0, state.doc.content.size, typed.content);

    const change = documentChange(tr.before, tr.doc);
    expect(change.textblocks).toEqual([{ node: tr.doc.child(500), pos }]);
    expect(change.mapping.map(positionOfChild(state, 10))).toBe(positionOfChild(state, 10));
    expect(change.mapping.map(positionOfChild(state, 900))).toBe(positionOfChild(state, 900) + 2);
  });

  it("maps nothing for a replacement with equal content", () => {
    const state = longState();
    const tr = state.tr.replaceWith(0, state.doc.content.size, schema.nodeFromJSON(state.doc.toJSON()).content);

    const change = documentChange(tr.before, tr.doc);
    expect(change.textblocks).toEqual([]);
    expect(change.mapping.map(1234)).toBe(1234);
  });

  it("keeps both ends after the start when a repeated character is typed", () => {
    const state = EditorState.create({ doc: doc(paragraph("ab")) });
    const tr = state.tr.insertText("b", 3);

    const change = documentChange(tr.before, tr.doc);
    expect(change.textblocks.map(({ node }) => node.textContent)).toEqual(["abb"]);
    expect(change.mapping.map(1)).toBe(1);
    expect(change.mapping.map(4)).toBe(5);
  });
});
