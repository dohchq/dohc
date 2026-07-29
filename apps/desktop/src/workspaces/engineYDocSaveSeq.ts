// Per-session edit/settle bookkeeping behind the honest save indicator.
//
// Extracted from main.ts's IPC handlers because the interleaving that matters
// cannot be driven through the Electron bootstrap: a settle announces itself
// at its JOURNAL BARRIER and only then queues on the provider's settleChain,
// so several settles are routinely in flight at once (the debounced autosave
// path does not go through the capture layer's serialization either).
//
// A single scalar "seq this settle started at" is wrong for that shape: the
// newest start overwrites it, and the OLDEST settle then completes reporting
// the newest start's seq. The renderer trusts that number to decide whether a
// success covers the user's latest keystroke, so the scalar made the editor
// claim "Saved" over a file missing the very edits a later settle still had to
// write — defeating the mechanism this whole change exists to provide.

export interface EngineYDocSaveSeqState {
  /** Highest local-edit seq main has received from the renderer. */
  dirtySeq: number;
  /**
   * The seq each IN-FLIGHT settle started at, oldest first.
   *
   * Pairing is by ORDER, which holds because a provider announces every
   * settle before any of its abort paths (so starts and outcomes come in
   * matched pairs) and completes settles within one generation in start order
   * (each queues on `settleChain`).
   *
   * It is NOT guaranteed ACROSS generations: `settleChain` is per-generation
   * while this queue is per-session, so a daemon revive can leave the old
   * generation holding an in-flight settle while the new one completes its
   * own. That drifts pairing by one position — see the follow-up issue on
   * making the pairing explicit with a token instead of relying on order.
   * The renderer absorbs a one-position drift (it only clears to "Saved" when
   * the reported seq covers its newest local edit), so this is a latent
   * imprecision, not a live lie.
   */
  inFlight: number[];
}

export function createEngineYDocSaveSeqState(): EngineYDocSaveSeqState {
  return { dirtySeq: 0, inFlight: [] };
}

/** The renderer shipped an edit. Ordering is the IPC channel's guarantee. */
export function noteLocalEdit(state: EngineYDocSaveSeqState, seq: number): void {
  state.dirtySeq = seq;
}

/**
 * A settle crossed its journal barrier. Everything journaled up to here is
 * what it is guaranteed to carry, so that is the seq it may later vouch for.
 */
export function noteSettleStart(state: EngineYDocSaveSeqState): number {
  state.inFlight.push(state.dirtySeq);
  return state.dirtySeq;
}

/**
 * A settle finished (succeeded or failed). Returns the seq THAT settle
 * started at.
 *
 * An outcome with nothing in flight should not happen; if it does, answer 0
 * rather than guess. 0 claims nothing, so the renderer keeps showing unsaved
 * work — the safe direction for an indicator whose whole job is to not lie.
 */
export function noteSettleOutcome(state: EngineYDocSaveSeqState): number {
  return state.inFlight.shift() ?? 0;
}
