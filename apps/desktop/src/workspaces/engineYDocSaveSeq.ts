// Per-session edit/settle bookkeeping behind the honest save indicator.
//
// Extracted from main.ts's IPC handlers because the interleaving that matters
// cannot be driven through the Electron bootstrap.
//
// Pairing is by TOKEN, never by order. The provider mints one identity per
// settle and echoes it on whichever outcome that settle produces, so this
// module never reasons about which settle completes when. Arrival order does
// not hold, for two independent reasons:
//
//   - An ABORTING settle (failed journal, or a synchronous local-edit throw)
//     throws before it ever reaches `settleChain`, so it completes ahead of
//     settles that queued before it.
//   - `settleChain` is per GENERATION while this state is per SESSION, so a
//     daemon revive races the old generation's in-flight settle against the
//     new generation's.
//
// Both produce the same defect: a settle vouching for edits it never carried,
// which is the single thing this mechanism exists to prevent. An order-based
// queue was tried twice and was wrong twice.

export interface EngineYDocSaveSeqState {
  /** Highest local-edit seq main has received from the renderer. */
  dirtySeq: number;
  /**
   * The seq each IN-FLIGHT settle started at, keyed by the provider's token.
   * A settle may only vouch for what had been journaled when it began.
   */
  inFlight: Map<number, number>;
}

export function createEngineYDocSaveSeqState(): EngineYDocSaveSeqState {
  return { dirtySeq: 0, inFlight: new Map() };
}

/** The renderer shipped an edit. Ordering is the IPC channel's guarantee. */
export function noteLocalEdit(state: EngineYDocSaveSeqState, seq: number): void {
  state.dirtySeq = seq;
}

/**
 * A settle announced itself. Everything journaled up to now is what it is
 * guaranteed to carry, so that is the seq it may later vouch for.
 */
export function noteSettleStart(
  state: EngineYDocSaveSeqState,
  token: number,
): number {
  state.inFlight.set(token, state.dirtySeq);
  return state.dirtySeq;
}

/**
 * A settle finished (succeeded or failed). Returns the seq THAT settle
 * started at, found by its own token.
 *
 * An unknown token should not happen; if it does, answer 0 rather than guess.
 * 0 claims nothing, so the renderer keeps showing unsaved work — the safe
 * direction for an indicator whose whole job is to not lie.
 */
export function noteSettleOutcome(
  state: EngineYDocSaveSeqState,
  token: number,
): number {
  const seq = state.inFlight.get(token);
  if (seq === undefined) return 0;
  state.inFlight.delete(token);
  return seq;
}
