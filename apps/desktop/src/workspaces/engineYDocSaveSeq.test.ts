import { describe, expect, it } from "vitest";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
} from "./engineYDocSaveSeq";

// AUDIT-SILENTSAVE. The renderer clears to "Saved" when a reported seq covers
// its newest local edit, so a settle that reports the wrong start makes the
// editor claim Saved over a file missing the user's last keystrokes.
//
// Two order-based designs were tried and both produced exactly that:
//   1. a scalar, overwritten by the newest start;
//   2. a FIFO, which assumed completion order matched start order.
// It does not. An ABORTING settle throws before it reaches `settleChain`, so
// it completes ahead of settles that queued earlier; and `settleChain` is per
// generation while this state is per session. Pairing is by TOKEN now, and
// these tests are written so any order-based implementation fails them.

describe("engine Y.Doc save-seq bookkeeping", () => {
  it("pairs OUT-OF-ORDER completions correctly (announce A,B,C; complete C,A,B)", () => {
    // THE case a FIFO cannot survive. C aborts pre-barrier and completes
    // first while A and B are still queued on settleChain.
    const state = createEngineYDocSaveSeqState();

    noteLocalEdit(state, 1);
    const a = 1;
    expect(noteSettleStart(state, a)).toBe(1);

    noteLocalEdit(state, 2);
    const b = 2;
    expect(noteSettleStart(state, b)).toBe(2);

    noteLocalEdit(state, 3);
    const c = 3;
    expect(noteSettleStart(state, c)).toBe(3);

    // A FIFO shifts 1 here, then 2, then 3 — so B's success would report 3,
    // which equals the renderer's newest edit, and clear the editor to
    // "Saved" for an edit whose journaling had actually failed.
    expect(noteSettleOutcome(state, c)).toBe(3);
    expect(noteSettleOutcome(state, a)).toBe(1);
    expect(noteSettleOutcome(state, b)).toBe(2);
  });

  it("survives a completion order that is the exact reverse of the starts", () => {
    const state = createEngineYDocSaveSeqState();
    const tokens = [10, 11, 12];
    tokens.forEach((token, index) => {
      noteLocalEdit(state, index + 1);
      noteSettleStart(state, token);
    });
    expect(
      [...tokens].reverse().map((token) => noteSettleOutcome(state, token)),
    ).toEqual([3, 2, 1]);
  });

  it("pairs each completing settle with ITS OWN start, not the newest one", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 1);
    noteSettleStart(state, 1);
    noteLocalEdit(state, 2);
    noteSettleStart(state, 2);
    // The first settle completes first and carried only edit 1.
    expect(noteSettleOutcome(state, 1)).toBe(1);
    expect(noteSettleOutcome(state, 2)).toBe(2);
  });

  it("reports a failure against its own start too, so a retry is judged honestly", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 5);
    noteSettleStart(state, 1);
    noteLocalEdit(state, 6);
    noteSettleStart(state, 2);
    expect(noteSettleOutcome(state, 1)).toBe(5);
    expect(noteSettleOutcome(state, 2)).toBe(6);
  });

  it("claims nothing for a token it never saw", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 9);
    // Answering dirtySeq here would invent a save out of nothing.
    expect(noteSettleOutcome(state, 42)).toBe(0);
  });

  it("claims nothing when the same token completes twice", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 4);
    noteSettleStart(state, 7);
    expect(noteSettleOutcome(state, 7)).toBe(4);
    expect(noteSettleOutcome(state, 7)).toBe(0);
  });

  it("does not let an edit typed DURING a settle be claimed by it", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 1);
    noteSettleStart(state, 1);
    noteLocalEdit(state, 2);
    noteLocalEdit(state, 3);
    expect(noteSettleOutcome(state, 1)).toBe(1);
  });
});
