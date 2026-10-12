import type { ShareViewRefusal } from "@dohc/workspace-contracts/relay";
import { mergeShareSkippedOps, type ShareSkippedOps } from "./registryStore";

/**
 * Writes a share's refused ops into its durable record, one PAGE at a time.
 *
 * A pull hands each page's refusals here before it commits that page's
 * cursor, so the evidence survives a later page failing. What this
 * deliberately does not do is tell the renderer: every broadcast starts file
 * scans, history reads and relay listings, and their tokens keep stale
 * results from landing without cancelling the work — so a relay refusing on
 * every page of a long backlog would fan one pull into an unbounded number of
 * concurrent scans.
 *
 * It cannot notify: it is handed a writer and nothing else. The pull sites
 * notify once, when the pull settles, success or failure.
 */
export function createShareSkipRecorder<
  T extends { skippedOps?: ShareSkippedOps },
>(target: {
  /**
   * Applies `change` to the record as it stands when written, so an
   * acknowledgement or removal made meanwhile is kept. Writes nothing when
   * the record is gone.
   */
  update: (change: (current: T) => T) => Promise<void>;
  now?: () => number;
}): (refusals: readonly ShareViewRefusal[]) => Promise<void> {
  const now = target.now ?? (() => Date.now());
  return async (refusals) => {
    if (refusals.length === 0) return;
    const skipped = refusals.map((refusal) => ({ ...refusal, atMs: now() }));
    await target.update((current) => ({
      ...current,
      skippedOps: mergeShareSkippedOps(current.skippedOps, skipped),
    }));
  };
}
