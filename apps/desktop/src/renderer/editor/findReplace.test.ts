import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { boldText, codeBlock, doc, hardBreak, paragraph, schema } from "./testDocs";
import {
  buildReplaceActiveTransaction,
  buildReplaceAllTransaction,
  CLOSED_FIND_REPLACE_STATE,
  computeMatches,
  findReplaceKey,
  findReplaceReducer,
  makeFindReplacePlugin,
  nextMatchIndex,
  prevMatchIndex,
  type FindReplaceState,
} from "./findReplace";

// Real ProseMirror documents built through the shared dohc schema
// (testDocs.ts). A single paragraph's text starts at pos 1, matching the
// hand-computed positions below.

describe("computeMatches", () => {
  it("finds multiple matches in plain text", () => {
    const d = doc(paragraph("the cat sat on the mat"));
    expect(computeMatches(d, "at", true)).toEqual([
      { from: 6, to: 8 }, // c-AT
      { from: 10, to: 12 }, // s-AT
      { from: 21, to: 23 }, // m-AT
    ]);
  });

  it("is case-insensitive by default and case-sensitive when asked", () => {
    const d = doc(paragraph("Cat cat CAT"));
    expect(computeMatches(d, "cat", false)).toHaveLength(3);
    expect(computeMatches(d, "cat", true)).toEqual([{ from: 5, to: 8 }]);
  });

  it("spans adjacent text nodes within the same textblock (**bo**ld)", () => {
    // A bold "bo" (pos 1-3) directly followed by a plain "ld" (pos 3-5)
    // inside one paragraph — two text nodes, positionally contiguous.
    const d = doc(paragraph(boldText("bo"), "ld"));
    expect(computeMatches(d, "old", false)).toEqual([{ from: 2, to: 5 }]);
    expect(computeMatches(d, "bold", false)).toEqual([{ from: 1, to: 5 }]);
  });

  it("does not merge across a block boundary or a non-text gap", () => {
    // "end" at 1..4 in the first paragraph (nodeSize 5); "start" resumes at
    // 6 in the second — not contiguous.
    const d = doc(paragraph("end"), paragraph("start"));
    expect(computeMatches(d, "endstart", false)).toEqual([]);
    expect(computeMatches(d, "end", false)).toEqual([{ from: 1, to: 4 }]);
    expect(computeMatches(d, "start", false)).toEqual([{ from: 6, to: 11 }]);

    // A non-text leaf (hardBreak) between two text nodes in the same
    // paragraph also breaks the run.
    const withBreak = doc(paragraph("end", hardBreak(), "start"));
    expect(computeMatches(withBreak, "endstart", false)).toEqual([]);
  });

  it("searches code blocks too — no exclusion by node type", () => {
    const d = doc(codeBlock("const at = 1"));
    expect(computeMatches(d, "at", false)).toEqual([{ from: 7, to: 9 }]);
  });

  it("returns no matches for an empty query or an absent query string", () => {
    const d = doc(paragraph("hello world"));
    expect(computeMatches(d, "", false)).toEqual([]);
    expect(computeMatches(d, "xyz", false)).toEqual([]);
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
  const catDoc = doc(paragraph("the cat sat on the mat"));

  it("open computes matches and activates the first one", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
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
      catDoc,
    );
    expect(opened.replaceOpen).toBe(true);
    const reopened = findReplaceReducer(opened, { type: "open", replace: false }, catDoc);
    expect(reopened.replaceOpen).toBe(true); // Mod-f after Mod-h doesn't collapse it
    expect(reopened.query).toBe("cat"); // and doesn't clobber the typed query
  });

  it("setQuery recomputes matches and resets to the first match", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const navigated = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(navigated.activeIndex).toBe(1);
    const requeried = findReplaceReducer(navigated, { type: "setQuery", query: "cat" }, catDoc);
    expect(requeried.matches).toHaveLength(1);
    expect(requeried.activeIndex).toBe(0);
  });

  it("no matches state: activeIndex is -1 and the counter has nothing to show", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "zzz" },
      catDoc,
    );
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
  });

  it("close resets to the closed state, dropping query/replacement/matches", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: true, query: "cat" },
      catDoc,
    );
    expect(findReplaceReducer(opened, { type: "close" }, catDoc)).toEqual(CLOSED_FIND_REPLACE_STATE);
  });

  it("sync keeps the same match active by position when the doc changes elsewhere", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(onSecond.activeIndex).toBe(1);
    const secondMatchFrom = onSecond.matches[1]!.from;

    // An edit after the active match (appending text at the end) doesn't
    // shift any earlier position, so the same match should stay active.
    const appendedDoc = doc(paragraph("the cat sat on the mat, extra"));
    const synced = findReplaceReducer(onSecond, { type: "sync" }, appendedDoc);
    expect(synced.activeIndex).toBe(1);
    expect(synced.matches[synced.activeIndex]?.from).toBe(secondMatchFrom);
  });

  it("sync advances forward when the active match disappears (e.g. after Replace)", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(onSecond.activeIndex).toBe(1);

    // The "sat" occurrence (the active match) is gone; only "cat" (before the
    // old position) and "mat" (after it) remain. Forward progression should
    // land on "mat" — the nearest match at/after where we were — not snap
    // back to "cat" at the top of the doc.
    const editedDoc = doc(paragraph("the cat ran on the mat"));
    const synced = findReplaceReducer(onSecond, { type: "sync" }, editedDoc);
    expect(synced.matches).toHaveLength(2);
    expect(synced.activeIndex).toBe(1);
    expect(synced.matches[synced.activeIndex]?.from).toBe(21);
  });
});

describe("buildReplaceActiveTransaction / buildReplaceAllTransaction", () => {
  function stateFor(text: string): EditorState {
    return EditorState.create({ schema, doc: doc(paragraph(text)) });
  }

  it("replace-active preserves the surrounding text", () => {
    const text = "the cat sat on the mat";
    const state = stateFor(text);
    const matches = computeMatches(state.doc, "cat", true);
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
    const matches = computeMatches(state.doc, "the", true);
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

// The reducer/transaction-builder suites above test the pure pieces in
// isolation; this exercises the real registered plugin end-to-end so the
// meta-action wiring, the docChanged→auto-sync branch in apply(), and
// buildFindDecorations can't silently regress.
describe("makeFindReplacePlugin (registered plugin, real EditorState)", () => {
  function openState(query: string) {
    const plugin = makeFindReplacePlugin();
    let state = EditorState.create({
      schema,
      doc: doc(paragraph("the cat sat on the mat")),
      plugins: [plugin],
    });
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: "open", replace: false, query }),
    );
    return { plugin, state };
  }

  it("open meta populates plugin state and renders a decoration per match", () => {
    const { plugin, state } = openState("the");
    const find = findReplaceKey.getState(state);
    expect(find?.open).toBe(true);
    expect(find?.matches).toHaveLength(2);

    const decos = plugin.props.decorations?.call(plugin, state);
    expect(decos).toBeInstanceOf(DecorationSet);
    expect((decos as DecorationSet).find()).toHaveLength(2);
  });

  it("a doc-changing transaction without find meta auto-syncs matches", () => {
    const { state } = openState("the");
    expect(findReplaceKey.getState(state)?.matches).toHaveLength(2);

    // Insert another "the " at the start of the paragraph text — no find
    // meta on this transaction, so only the plugin's docChanged branch can
    // pick it up.
    const next = state.apply(state.tr.insertText("the ", 1));
    expect(findReplaceKey.getState(next)?.matches).toHaveLength(3);
  });
});
