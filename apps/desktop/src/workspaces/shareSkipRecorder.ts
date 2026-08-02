import type { ShareViewRefusal } from "@dohc/workspace-contracts/relay";
import { mergeShareSkippedOps, type ShareSkippedOps } from "./registryStore";

/**
 * Writes a share's refused ops into its durable record, one PAGE at a time.
 *
 * A pull hands each page's refusals here before it commits that page's
 * cursor, so the evidence survives a later page failing. What this
 * deliberately does NOT do is tell the renderer: every broadcast starts file
 * scans, history reads and relay listings, and their tokens keep stale
 * results from landing without cancelling the work — so a relay refusing on
 * every page of a long backlog would fan one pull into an unbounded number of
 * concurrent scans.
 *
 * It cannot notify: it is handed a reader and a writer and nothing else. The
 * pull sites notify once, when the pull settles, success or failure.
 */
export function createShareSkipRecorder<
  T extends { skippedOps?: ShareSkippedOps },
>(target: {
  /** The record as it stands now, or undefined when it is gone. */
  current: () => T | undefined;
  persist: (next: T) => void;
  now?: () => number;
}): (refusals: readonly ShareViewRefusal[]) => Promise<void> {
  const now = target.now ?? (() => Date.now());
  return async (refusals) => {
    if (refusals.length === 0) return;
    // Read per call, not once: an earlier page of this same pull has already
    // written, and a share can be revoked mid-pull.
    const current = target.current();
    if (!current) return;
    target.persist({
      ...current,
      skippedOps: mergeShareSkippedOps(
        current.skippedOps,
        refusals.map((refusal) => ({ ...refusal, atMs: now() })),
      ),
    });
  };
}
