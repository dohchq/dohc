import { DatasetRecoveryPreparation } from "@dohc/cli/dataset";
import { bridge } from "./bridge";
import { CollectionRecoveryRestoreDialog } from "./CollectionRecoveryRestoreDialog";

export interface ConnectedCollectionRecoveryRestoreProps {
  workspaceId: string;
  onRestored(datasetId: string, tableId: string): void;
  onClose(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}

export function ConnectedCollectionRecoveryRestore(props: ConnectedCollectionRecoveryRestoreProps) {
  const { workspaceId } = props;
  async function discard(transferId: string) {
    const result = await bridge().dataset({ action: "discardRecovery", workspaceId, transferId });
    if (result.kind !== "recovery-discarded") throw Error("dohc could not cancel this recovery. Try again.");
  }
  return <CollectionRecoveryRestoreDialog key={workspaceId} onClose={props.onClose} onError={props.onError}
    onPrepare={async signal => {
      signal.throwIfAborted();
      const result = await bridge().dataset({ action: "prepareRecovery", workspaceId });
      if (result.kind !== "recovery-prepared") throw Error("dohc could not read this recovery file. Try again.");
      if (!result.recovery) return null;
      const recovery = DatasetRecoveryPreparation.parse(result.recovery);
      if (recovery.sourceCursor.workspaceId !== workspaceId || recovery.sourceCursor.datasetId !== recovery.revision.datasetId
        || recovery.sourceCursor.approvedRevisionHash !== recovery.revision.revisionSha256 || !recovery.revision.definition.tables.length) {
        await discard(recovery.transferId);
        throw Error("This recovery belongs to another workspace or Collection. Choose its original workspace.");
      }
      // Return late preparations so the dialog can discard them after unmount.
      return recovery;
    }}
    onRestore={async (recovery, signal) => {
      signal.throwIfAborted();
      if (recovery.sourceCursor.workspaceId !== workspaceId) throw Error("The workspace changed. Open recovery in its original workspace.");
      const result = await bridge().dataset({ action: "claimRecovery", workspaceId, datasetId: recovery.revision.datasetId,
        transferId: recovery.transferId, manifestSha256: recovery.manifestSha256, sourceCursor: recovery.sourceCursor, oldHostStopped: true });
      signal.throwIfAborted();
      if (result.kind !== "recovery-claimed" || result.transferId !== recovery.transferId || result.manifestSha256 !== recovery.manifestSha256
        || result.targetCursor.workspaceId !== workspaceId || result.targetCursor.datasetId !== recovery.revision.datasetId
        || result.targetCursor.approvedRevisionHash !== recovery.revision.revisionSha256) {
        throw Error("dohc could not confirm this restore. Retry recovery.");
      }
    }}
    onDiscard={discard}
    onRestored={recovery => props.onRestored(recovery.revision.datasetId, recovery.revision.definition.tables[0]!.tableId)} />;
}
