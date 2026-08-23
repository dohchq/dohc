import { unjournalablePathMessages } from "./shareViewRecords";
import type {
  ShareViewFiles,
  ShareViewFilesTarget,
  ShareViewReconcileOutcome,
} from "./shareViewFiles";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";

type ProjectionOwner = Pick<ShareViewFiles, "projectionStatus" | "reconcile">;

export function createOwnedProjectionRepairer(files: ProjectionOwner) {
  return async function ensureOwnedProjectionTargetCurrent(input: {
    rootPath: string;
    target: ShareViewFilesTarget;
  }): Promise<void> {
    const status = await files.projectionStatus(input.target);
    if (status.state === "unavailable") {
      throw new Error(
        "dohc cannot verify these shared files because the share record is damaged. Remove the share. Add it again.",
      );
    }

    const repaired = await withExclusiveWorkspaceOperation(
      input.rootPath,
      (_markWorkspaceChanged, lease) =>
        files.reconcile(lease, input.target, "repair"),
    );
    assertOwnedProjectionRepair(repaired);
    if ((await files.projectionStatus(input.target)).state !== "current") {
      throw new Error(
        "This shared file is still being restored to its folder. Try again after the shared view finishes repairing.",
      );
    }
  };
}

function assertOwnedProjectionRepair(
  outcome: ShareViewReconcileOutcome,
): asserts outcome is Extract<ShareViewReconcileOutcome, { kind: "repair" }> {
  if (outcome.kind !== "repair") {
    throw new Error("Shared file repair returned an invalid result.");
  }
  if (outcome.collisionRecordQuarantined) {
    throw new Error(
      "dohc found a damaged shared file recovery record. Refresh shared files. Retry this action.",
    );
  }
  if (outcome.unjournalablePaths.length > 0) {
    throw new Error(
      unjournalablePathMessages(outcome.unjournalablePaths).join(" "),
    );
  }
}
