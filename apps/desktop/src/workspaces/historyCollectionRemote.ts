import type { OwnerDatasetData } from "./remoteDataset";
import type { TimelineReads } from "./historyTimeline";

type Operation = { state: object; workspace: { attachmentId: symbol }; signal: AbortSignal; assertCurrent(): void };
/** Background reads outlive the page lease, but never its workspace or credentials. */
export function createHistoryCollectionRemote(options: {
  expected: Pick<Operation, "state" | "workspace">;
  generation: number;
  currentGeneration(): number;
  withOperation(work: (operation: Operation) => Promise<Awaited<ReturnType<TimelineReads["remote"]>>>): Promise<Awaited<ReturnType<TimelineReads["remote"]>>>;
  dataFor(signal: AbortSignal, current: () => void): OwnerDatasetData;
}): TimelineReads["remote"] {
  const expectedState = options.expected.state, expectedAttachment = options.expected.workspace.attachmentId;
  return (datasetId, beforeRevision, deadline) => options.withOperation(async operation => {
    const signal = AbortSignal.any([operation.signal, deadline]);
    const current = () => {
      signal.throwIfAborted(); operation.assertCurrent();
      if (operation.state !== expectedState || operation.workspace.attachmentId !== expectedAttachment) throw new Error("This workspace changed. Refresh History.");
      if (options.generation !== options.currentGeneration()) throw new Error("Your server session changed. Reopen this workspace.");
    };
    current();
    const data = options.dataFor(signal, current);
    try {
      const page = await data.history({ datasetId, beforeRevision, limit: 51, metadataOnly: true, signal }); current();
      return page;
    } catch (error) {
      current();
      if (data.deletionStatus && (await data.deletionStatus({ datasetId })).deleted) {
        current(); return { datasetId, headRevision: 0, entries: [], nextBeforeRevision: null, deleted: true };
      }
      throw error;
    }
  });
}
