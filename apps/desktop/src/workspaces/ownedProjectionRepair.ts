import { unjournalablePathMessages } from "./shareViewRecords";
import type {
  ShareViewFiles,
  ShareViewFilesTarget,
  ShareViewProjectionStatus,
  ShareViewReconcileOutcome,
} from "./shareViewFiles";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";

type ProjectionOwner = Pick<ShareViewFiles, "projectionStatus" | "reconcile">;
type RepairOutcome = Extract<ShareViewReconcileOutcome, { kind: "repair" }>;

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
      async (markWorkspaceChanged, lease) => {
        let changedNothing = false;
        try {
          const outcome = await files.reconcile(lease, input.target, "repair");
          const after = await files.projectionStatus(input.target);
          changedNothing = repairChangedNothing(outcome, after);
          return { outcome, after };
        } finally {
          // A write queued behind this repair is refused unless the repair
          // proves it left the workspace as it found it.
          if (!changedNothing) markWorkspaceChanged();
        }
      },
      { markOnSuccess: false },
    );
    assertOwnedProjectionRepair(repaired.outcome);
    if (repaired.after.state !== "current") {
      throw new Error(
        "This shared file is still being restored to its folder. Try again after the shared view finishes repairing.",
      );
    }
  };
}

// Only a current projection and an outcome with every named field at its
// no-change value proves nothing changed. A missing field, a field this
// function does not name, or any other status counts as a change.
function repairChangedNothing(
  outcome: ShareViewReconcileOutcome,
  status: ShareViewProjectionStatus,
): boolean {
  if (outcome.kind !== "repair" || status.state !== "current") return false;
  const {
    kind: _kind,
    repairedPaths,
    unjournalablePaths,
    collisionRecordQuarantined,
    ...unnamed
  } = outcome;
  // A field added to the repair outcome fails to compile here until it is named above.
  const unnamedFields: Record<string, never> = unnamed;
  return (
    Object.keys(unnamedFields).length === 0 &&
    repairedPaths === 0 &&
    Array.isArray(unjournalablePaths) &&
    unjournalablePaths.length === 0 &&
    collisionRecordQuarantined === false
  );
}

function assertOwnedProjectionRepair(
  outcome: ShareViewReconcileOutcome,
): asserts outcome is RepairOutcome {
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
