import { describe, expect, it } from "vitest";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
} from "./engineYDocSaveSeq";

// AUDIT-SILENTSAVE round 4 (D1). Several settles are routinely in flight at
// once: a settle announces itself at its journal barrier and only THEN queues
// on the provider's settleChain (`announces a settle at the JOURNAL BARRIER…`
// asserts exactly that on both providers). The debounced autosave path does
// not go through the capture layer's serialization either.
//
// The renderer clears to "Saved" when a reported seq covers its newest local
// edit. If the completing settle reports the wrong start, the editor claims
// Saved over a file that is missing the user's last keystrokes — the precise
// lie this change exists to prevent.

describe("engine Y.Doc save-seq bookkeeping", () => {
  it("pairs each completing settle with ITS OWN start, not the newest one", () => {
    const state = createEngineYDocSaveSeqState();

    // Edit 1 lands, settle A crosses its barrier carrying it.
    noteLocalEdit(state, 1);
    expect(noteSettleStart(state)).toBe(1);

    // A is slow (a ~140 KiB document — this PR's own subject). Edit 2 lands
    // and settle B crosses its barrier behind A.
    noteLocalEdit(state, 2);
    expect(noteSettleStart(state)).toBe(2);

    // A completes FIRST. It only ever carried edit 1, so it must report 1.
    // A single scalar would have been overwritten by B's start and report 2,
    // and the renderer (2 >= 2) would clear to "Saved" while edit 2 lived
    // only in the CRDT and B had not run.
    expect(noteSettleOutcome(state)).toBe(1);

    // B completes and legitimately vouches for edit 2.
    expect(noteSettleOutcome(state)).toBe(2);
  });

  it("keeps pairing correctly across three overlapping settles", () => {
    const state = createEngineYDocSaveSeqState();
    const starts: number[] = [];
    for (const seq of [1, 2, 3]) {
      noteLocalEdit(state, seq);
      starts.push(noteSettleStart(state));
    }
    expect(starts).toEqual([1, 2, 3]);
    expect([
      noteSettleOutcome(state),
      noteSettleOutcome(state),
      noteSettleOutcome(state),
    ]).toEqual([1, 2, 3]);
  });

  it("reports a failure against its own start too, so a retry is judged honestly", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 5);
    noteSettleStart(state);
    noteLocalEdit(state, 6);
    noteSettleStart(state);
    // The first settle FAILS. It failed to carry edit 5, not edit 6.
    expect(noteSettleOutcome(state)).toBe(5);
    expect(noteSettleOutcome(state)).toBe(6);
  });

  it("claims nothing when an outcome arrives with no settle in flight", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 9);
    // Should not happen; if it does, 0 claims nothing and the renderer keeps
    // showing unsaved work. Answering dirtySeq here would invent a save.
    expect(noteSettleOutcome(state)).toBe(0);
  });

  it("does not let an edit typed DURING a settle be claimed by it", () => {
    const state = createEngineYDocSaveSeqState();
    noteLocalEdit(state, 1);
    noteSettleStart(state);
    // The user keeps typing while the settle runs; no new settle has begun.
    noteLocalEdit(state, 2);
    noteLocalEdit(state, 3);
    expect(noteSettleOutcome(state)).toBe(1);
  });
});
