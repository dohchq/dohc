export interface EngineYDocSaveSeqState {
  /** Highest local-edit seq main has received from the renderer. */
  dirtySeq: number;
  /**
   * The seq each IN-FLIGHT settle started at, keyed by the capture's token.
   * A settle may only vouch for what had been journaled when it began.
   */
  inFlight: Map<number, number>;
}

export function createEngineYDocSaveSeqState(): EngineYDocSaveSeqState {
  return { dirtySeq: 0, inFlight: new Map() };
}

/**
 * An edit reached the settle — journaled onto the session's journal chain and
 * counted by the settle it arms. Not when the renderer shipped it: the session
 * queues updates, and counting at hand-over lets a settle armed by an earlier
 * update vouch for edits still waiting in that queue.
 *
 * Ordering is the session queue's FIFO guarantee. Assignment, not a maximum:
 * were the order ever to break, a seq that lags under-reports and the document
 * keeps showing "Saving…", which is the safe direction for this indicator.
 */
export function noteLocalEdit(state: EngineYDocSaveSeqState, seq: number): void {
  state.dirtySeq = seq;
}

/**
 * A settle announced itself. Everything journaled up to now is what it is
 * guaranteed to carry, so that is the seq it may later vouch for.
 */
export function noteSettleStart(state: EngineYDocSaveSeqState, token: number): number {
  state.inFlight.set(token, state.dirtySeq);
  return state.dirtySeq;
}

/**
 * A settle finished (succeeded or failed). Returns the seq that settle
 * started at, found by its own token.
 *
 * An unknown token should not happen; if it does, answer 0 rather than guess.
 * 0 claims nothing, so the renderer keeps showing unsaved work — the safe
 * direction for an indicator whose whole job is to not lie.
 */
export function noteSettleOutcome(state: EngineYDocSaveSeqState, token: number): number {
  const seq = state.inFlight.get(token);
  if (seq === undefined) return 0;
  state.inFlight.delete(token);
  return seq;
}
