import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { getDohcProseMirrorSchema } from "./import-export";
import type { PMDocLike, PMNodeLike } from "./inlineAtomPlugin";
import {
  buildReplaceActiveTransaction,
  buildReplaceAllTransaction,
  CLOSED_FIND_REPLACE_STATE,
  computeMatches,
  findReplaceReducer,
  nextMatchIndex,
  prevMatchIndex,
  type FindReplaceState,
} from "./findReplace";

// Same hand-built-doc convention as wikilinkPlugin.test.ts / inlineAtomPlugin.test.ts:
// a fake PMDocLike whose `descendants` walks explicit (text, pos) entries so
// offset math is exercised without a real ProseMirror instance.
function fakeDoc(entries: Array<{ text: string; pos: number }>): PMDocLike {
  return {
    descendants(cb) {
      for (const e of entries) {
        const node: PMNodeLike = { isText: true, text: e.text, marks: [], type: { name: "text" } };
        cb(node, e.pos, null);
      }
    },
  };
}

describe("computeMatches", () => {
  it("finds multiple matches in plain text", () => {
    const doc = fakeDoc([{ text: "the cat sat on the mat", pos: 1 }]);
    expect(computeMatches(doc, "at", true)).toEqual([
      { from: 6, to: 8 }, // c-AT
      { from: 10, to: 12 }, // s-AT
      { from: 21, to: 23 }, // m-AT
    ]);
  });

  it("is case-insensitive by default and case-sensitive when asked", () => {
    const doc = fakeDoc([{ text: "Cat cat CAT", pos: 1 }]);
    expect(computeMatches(doc, "cat", false)).toHaveLength(3);
    expect(computeMatches(doc, "cat", true)).toEqual([{ from: 5, to: 8 }]);
  });

  it("spans adjacent text nodes within the same textblock (**bo**ld)", () => {
    // "bo" (pos 1-3) directly followed by "ld" (pos 3-5) — as ProseMirror
    // lays out a bold "bo" + plain "ld" inside one paragraph.
    const doc = fakeDoc([
      { text: "bo", pos: 1 },
      { text: "ld", pos: 3 },
    ]);
    expect(computeMatches(doc, "old", false)).toEqual([{ from: 2, to: 5 }]);
    expect(computeMatches(doc, "bold", false)).toEqual([{ from: 1, to: 5 }]);
  });

  it("does not merge across a block boundary or a non-text gap", () => {
    // "end" at pos 1-4, then a gap (closing/opening block tags, or an
    // inline atom) before "start" resumes at pos 10 — not contiguous.
    const doc = fakeDoc([
      { text: "end", pos: 1 },
      { text: "start", pos: 10 },
    ]);
    expect(computeMatches(doc, "endstart", false)).toEqual([]);
    expect(computeMatches(doc, "end", false)).toEqual([{ from: 1, to: 4 }]);
    expect(computeMatches(doc, "start", false)).toEqual([{ from: 10, to: 15 }]);
  });

  it("searches code blocks too — no exclusion by node type", () => {
    const doc = fakeDoc([{ text: "const at = 1", pos: 1 }]);
    expect(computeMatches(doc, "at", false)).toEqual([{ from: 7, to: 9 }]);
  });

  it("returns no matches for an empty query or an absent query string", () => {
    const doc = fakeDoc([{ text: "hello world", pos: 1 }]);
    expect(computeMatches(doc, "", false)).toEqual([]);
    expect(computeMatches(doc, "xyz", false)).toEqual([]);
  });
});

describe("nextMatchIndex / prevMatchIndex — wrapping navigation", () => {
  it("wraps forward past the last match", () => {
    expect(nextMatchIndex(3, 0)).toBe(1);
    expect(nextMatchIndex(3, 1)).toBe(2);
    expect(nextMatchIndex(3, 2)).toBe(0);
  });

  it("wraps backward past the first match", () => {
    expect(prevMatchIndex(3, 2)).toBe(1);
    expect(prevMatchIndex(3, 1)).toBe(0);
    expect(prevMatchIndex(3, 0)).toBe(2);
  });

  it("starts at the first/last match when nothing is active yet", () => {
    expect(nextMatchIndex(3, -1)).toBe(0);
    expect(prevMatchIndex(3, -1)).toBe(2);
  });

  it("is always -1 with no matches", () => {
    expect(nextMatchIndex(0, -1)).toBe(-1);
    expect(prevMatchIndex(0, -1)).toBe(-1);
  });
});

describe("findReplaceReducer", () => {
  const doc = fakeDoc([{ text: "the cat sat on the mat", pos: 1 }]);

  it("open computes matches and activates the first one", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      doc,
    );
    expect(state.open).toBe(true);
    expect(state.replaceOpen).toBe(false);
    expect(state.matches).toHaveLength(3);
    expect(state.activeIndex).toBe(0);
  });

  it("open with replace:true expands the replace row; a second open keeps it expanded", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: true, query: "cat" },
      doc,
    );
    expect(opened.replaceOpen).toBe(true);
    const reopened = findReplaceReducer(opened, { type: "open", replace: false }, doc);
    expect(reopened.replaceOpen).toBe(true); // Mod-f after Mod-h doesn't collapse it
    expect(reopened.query).toBe("cat"); // and doesn't clobber the typed query
  });

  it("setQuery recomputes matches and resets to the first match", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      doc,
    );
    const navigated = findReplaceReducer(opened, { type: "next" }, doc);
    expect(navigated.activeIndex).toBe(1);
    const requeried = findReplaceReducer(navigated, { type: "setQuery", query: "cat" }, doc);
    expect(requeried.matches).toHaveLength(1);
    expect(requeried.activeIndex).toBe(0);
  });

  it("no matches state: activeIndex is -1 and the counter has nothing to show", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "zzz" },
      doc,
    );
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
  });

  it("close resets to the closed state, dropping query/replacement/matches", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: true, query: "cat" },
      doc,
    );
    expect(findReplaceReducer(opened, { type: "close" }, doc)).toEqual(CLOSED_FIND_REPLACE_STATE);
  });

  it("sync keeps the same match active by position when the doc changes elsewhere", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      doc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, doc);
    expect(onSecond.activeIndex).toBe(1);
    const secondMatchFrom = onSecond.matches[1]!.from;

    // An edit AFTER the active match (appending text at the end) doesn't
    // shift any earlier position, so the same match should stay active.
    const appendedDoc = fakeDoc([{ text: "the cat sat on the mat, extra", pos: 1 }]);
    const synced = findReplaceReducer(onSecond, { type: "sync" }, appendedDoc);
    expect(synced.activeIndex).toBe(1);
    expect(synced.matches[synced.activeIndex]?.from).toBe(secondMatchFrom);
  });

  it("sync falls back to the first match when the active one disappears", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      doc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, doc);
    expect(onSecond.activeIndex).toBe(1);

    // The "sat" occurrence (the active match) is gone; only "cat" and "mat" remain.
    const editedDoc = fakeDoc([{ text: "the cat ran on the mat", pos: 1 }]);
    const synced = findReplaceReducer(onSecond, { type: "sync" }, editedDoc);
    expect(synced.matches).toHaveLength(2);
    expect(synced.activeIndex).toBe(0);
  });
});

describe("buildReplaceActiveTransaction / buildReplaceAllTransaction", () => {
  const schema = getDohcProseMirrorSchema();

  function stateFor(text: string): EditorState {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text(text))]);
    return EditorState.create({ schema, doc });
  }

  it("replace-active preserves the surrounding text", () => {
    const text = "the cat sat on the mat";
    const state = stateFor(text);
    const matches = computeMatches(state.doc as unknown as PMDocLike, "cat", true);
    expect(matches).toHaveLength(1);

    const find: Pick<FindReplaceState, "matches" | "activeIndex" | "replacement"> = {
      matches,
      activeIndex: 0,
      replacement: "dog",
    };
    const tr = buildReplaceActiveTransaction(state, find);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe("the dog sat on the mat");
  });

  it("replace-active is a no-op (null transaction) with no active match", () => {
    const state = stateFor("no match here");
    const tr = buildReplaceActiveTransaction(state, { matches: [], activeIndex: -1, replacement: "x" });
    expect(tr).toBeNull();
  });

  it("replace-all replaces every match and reports the count", () => {
    const text = "the cat sat on the mat";
    const state = stateFor(text);
    const matches = computeMatches(state.doc as unknown as PMDocLike, "the", true);
    expect(matches).toHaveLength(2);

    const { tr, count } = buildReplaceAllTransaction(state, { matches, replacement: "a" });
    expect(count).toBe(2);
    const next = state.apply(tr);
    expect(next.doc.textContent).toBe("a cat sat on a mat");
  });

  it("replace-all count is 0 and the transaction is a no-op with no matches", () => {
    const state = stateFor("nothing to see");
    const { tr, count } = buildReplaceAllTransaction(state, { matches: [], replacement: "x" });
    expect(count).toBe(0);
    expect(tr.doc.textContent).toBe(state.doc.textContent);
  });
});
