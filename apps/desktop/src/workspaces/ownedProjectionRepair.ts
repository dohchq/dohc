import { posix } from "node:path";
import { unjournalablePathMessages, type UnjournalablePath } from "./shareViewRecords";
import type {
  ShareViewFiles,
  ShareViewFilesTarget,
  ShareViewProjectionStatus,
  ShareViewReconcileOutcome,
} from "./shareViewFiles";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { workspacePathKey } from "./workspacePathKey";

type ProjectionOwner = Pick<ShareViewFiles, "projectionStatus" | "reconcile">;
type RepairOutcome = Extract<ShareViewReconcileOutcome, { kind: "repair" }>;

// A held file waits on a person, not on repair: a local file in its way, or
// another shared spelling that owns its file on this disk (#2416). Its disk
// file is not the share's copy, so reads skip it instead of failing the view.
function isHold(entry: UnjournalablePath): boolean {
  return entry.reason === "local-collision" || entry.reason === "spelling-collision";
}

export function createOwnedProjectionRepairer(files: ProjectionOwner) {
  /** Resolves with the share-relative paths held back from the folder. */
  return async function ensureOwnedProjectionTargetCurrent(input: {
    rootPath: string;
    target: ShareViewFilesTarget;
    // A file the caller hands to the OS, refused while it is held: its
    // share-relative path as resolved on disk, and the workspace path asked for.
    path?: { resolved: string; requested: string };
  }): Promise<ReadonlySet<string>> {
    const status = await files.projectionStatus(input.target);
    if (status.state === "unavailable") {
      throw new Error(
        "dohc cannot verify these shared files because the share record is damaged. Remove the share. Add it again.",
      );
    }

    const after = await withExclusiveWorkspaceOperation(
      input.rootPath,
      async (markWorkspaceChanged, lease) => {
        let changedNothing = false;
        try {
          const outcome = await files.reconcile(lease, input.target, "repair");
          assertOwnedProjectionRepair(outcome);
          const held = new Map(outcome.unjournalablePaths.map(entry => [entry.path, entry]));
          const repairedStatus = await files.projectionStatus(input.target);
          changedNothing = repairChangedNothing(outcome, repairedStatus, held);
          return { status: repairedStatus, held };
        } finally {
          // A write queued behind this repair is refused unless the repair
          // proves it left the workspace as it found it.
          if (!changedNothing) markWorkspaceChanged();
        }
      },
      { markOnSuccess: false },
    );
    if (!onlyHeld(after.status, after.held)) {
      throw new Error(
        "This shared file is still being restored to its folder. Try again after the shared view finishes repairing.",
      );
    }
    const requested = input.path && heldRequest(after.held, input.path);
    if (requested) throw new Error(unjournalablePathMessages([requested]).join(" "));
    return new Set(after.held.keys());
  };
}

// Resolving follows the disk's spelling, so on a disk that ignores case a held
// spelling resolves to the spelling that owns its file. A local file blocks
// every spelling of its name; a held spelling is refused only as asked for, so
// the spelling that owns the file stays openable.
function heldRequest(
  held: ReadonlyMap<string, UnjournalablePath>,
  path: { resolved: string; requested: string },
): UnjournalablePath | undefined {
  // The view's own root is never a held file.
  if (path.resolved === "") return undefined;
  const depth = path.resolved.split("/").length;
  const asked = posix.normalize(path.requested.replaceAll("\\", "/"))
    .split("/").filter(Boolean).slice(-depth).join("/");
  const key = workspacePathKey(path.resolved);
  return [...held.values()].find(entry => entry.reason === "local-collision"
    ? workspacePathKey(entry.path) === key
    : entry.path === asked);
}

// The projection is current apart from its held files: no path waits for
// repair, no pull is unfinished, and every recorded collision is held.
function onlyHeld(
  status: ShareViewProjectionStatus,
  held: ReadonlyMap<string, UnjournalablePath>,
): boolean {
  if (status.state === "current") return true;
  return (
    status.state === "pending" &&
    status.pendingPathCount === 0 &&
    !status.pullInFlight &&
    status.collisionPathCount === held.size &&
    status.collisionPaths.every(path => held.has(path))
  );
}

// Only a projection current apart from held files and an outcome with every
// named field at its no-change value proves nothing changed. A hold changes
// nothing. A missing field, a field this function does not name, or any
// other status counts as a change.
function repairChangedNothing(
  outcome: RepairOutcome,
  status: ShareViewProjectionStatus,
  held: ReadonlyMap<string, UnjournalablePath>,
): boolean {
  if (!onlyHeld(status, held)) return false;
  const {
    kind,
    repairedPaths,
    unjournalablePaths,
    failedPaths,
    ...unnamed
  } = outcome;
  // A field added to the repair outcome fails to compile here until it is named above.
  const unnamedFields: Record<string, never> = unnamed;
  return (
    Object.keys(unnamedFields).length === 0 &&
    kind === "repair" &&
    repairedPaths === 0 &&
    Array.isArray(unjournalablePaths) &&
    unjournalablePaths.every(isHold) &&
    Array.isArray(failedPaths) &&
    failedPaths.length === 0
  );
}

function assertOwnedProjectionRepair(
  outcome: ShareViewReconcileOutcome,
): asserts outcome is RepairOutcome {
  if (outcome.kind !== "repair") {
    throw new Error("Shared file repair returned an invalid result.");
  }
  const unrepairable = outcome.unjournalablePaths.filter(entry => !isHold(entry));
  if (unrepairable.length > 0) {
    throw new Error(unjournalablePathMessages(unrepairable).join(" "));
  }
}
