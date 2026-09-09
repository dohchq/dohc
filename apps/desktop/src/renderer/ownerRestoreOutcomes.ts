import type {OwnerRestoreReview} from "../ipc/ownerRestoreContract";

export function ownerRestoreOutcomes(review: OwnerRestoreReview) {
  const cuts = review.priorRestoreCuts.map(cut => [cut.selectedTerminal?.journalCursor ?? 0, cut.frozenTerminal?.journalCursor ?? 0] as const)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of cuts) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  const removed: OwnerRestoreReview["acceptedEvents"] = [], excluded: OwnerRestoreReview["acceptedEvents"] = [];
  let index = 0;
  for (const event of review.acceptedEvents) {
    const cursor = event.metadata.accepted.receipt.journalCursor;
    while (merged[index] && merged[index]![1] < cursor) index++;
    const cut = merged[index];
    (cut && cursor > cut[0] && cursor <= cut[1] ? excluded : removed).push(event);
  }
  const local: OwnerRestoreReview["nativeSources"] = [], earlierLocal: OwnerRestoreReview["nativeSources"] = [], kept: OwnerRestoreReview["nativeSources"] = [];
  for (const source of review.nativeSources) {
    if (source.acceptedRelation === "at-or-before-selected") kept.push(source);
    // Accepted sources already occur in the accepted-change list. Do not count them twice.
    else if (source.acceptedReceipt === null) {
      (source.occurrences.some(o => o.context === "current-fence") ? local : earlierLocal).push(source);
    }
  }
  return {removed, excluded, local, earlierLocal, kept};
}
