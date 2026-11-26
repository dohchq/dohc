import type { WorkspaceVersionRecord, workspaceVersionOperations } from "./bridgeContract";
import type { protectedCopyOperations } from "./writeOperations";
import {
  heldChangeAuthorsForIpc,
  versionConflictForIpc,
  type EngineMomentAuthorNames,
} from "./engineHistoryIpc";
import type { WriteAuthor } from "@dohc/workspace-engine-client";
import type { OperationHandlers } from "./operationTable";
import type {
  WorkspaceEngineCapture,
  WorkspaceVersionMergeResult,
} from "../workspaces/workspaceEngineCapture";

// Each engine page can carry up to about 8 MiB, so the Versions page's count
// stops here and shows "N+" past it.
const CONFLICT_COUNT_PAGES_MAX = 5;

type VersionOperations = Pick<
  WorkspaceEngineCapture,
  | "listVersions"
  | "createVersion"
  | "switchVersion"
  | "compareVersions"
  | "compareVersionsChangedCount"
  | "mergeVersionIntoMain"
  | "updateVersionFromMain"
  | "setVersionArchived"
  | "listOpenConflictsPage"
  | "countOpenMergeConflicts"
  | "resolveConflict"
  | "listKeptCopies"
  | "saveKeptCopy"
  | "restoreProtectedCopy"
  | "discardProtectedCopy"
  | "heldNoteChange"
  | "listRetainedCopies"
  | "deleteRetainedCopies"
  | "notVersioned"
>;

// A version as the versions menu and the CLI show it.
export function workspaceVersionForIpc(version: {
  id: string;
  name: string;
  kind: "main" | "named";
  createdAtMs: number;
  archivedAtMs?: number;
  forkPoint?: { versionId: string };
}): WorkspaceVersionRecord {
  return {
    id: version.id,
    name: version.name,
    kind: version.kind,
    createdAtMs: version.createdAtMs,
    canMergeIntoMain: version.kind === "named" && version.forkPoint?.versionId === "main",
    ...(version.forkPoint ? { madeFromVersionId: version.forkPoint.versionId } : {}),
    ...(version.archivedAtMs !== undefined ? { archivedAtMs: version.archivedAtMs } : {}),
  };
}

export function workspaceVersionHandlers<Event = unknown>(dependencies: {
  localPerson(): Promise<WriteAuthor>;
  authorNames(workspaceId: string, event: Event): EngineMomentAuthorNames;
  onRefusalsChanged?(): void;
  requireEngineCapture(
    workspaceId: string,
    feature: "Versions",
  ): Promise<{ capture: VersionOperations }>;
  // Every file on the workspace's disk, by workspace-relative path.
  listDiskFiles(workspaceId: string): Promise<string[]>;
  notifyRenderer(target: { workspaceId: string }): void;
  activity: { queueCloudSync(workspaceId: string): void };
}): OperationHandlers<typeof workspaceVersionOperations, Event> {
  const { requireEngineCapture, notifyRenderer, activity } = dependencies;

  async function requireVersionOperations(workspaceId: string) {
    const { capture } = await requireEngineCapture(workspaceId, "Versions");
    return capture;
  }

  async function mergeResultForIpc(
    capture: VersionOperations,
    workspaceId: string,
    pair: { sourceVersionId: string; targetVersionId: string },
    result: WorkspaceVersionMergeResult,
  ) {
    notifyRenderer({ workspaceId });
    // The merge reports a count; the rows are open conflicts in the engine,
    // read back one page at a time like every other conflict reader.
    const page =
      result.conflictCount > 0
        ? await capture.listOpenConflictsPage(undefined, pair)
        : { conflicts: [], nextAfterConflictId: null };
    return {
      mergedFileCount: result.mergedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      conflictCount: result.conflictCount,
      replacedProtectedPaths: result.replacedProtectedPaths,
      skippedProtectedPaths: result.skippedProtectedPaths,
      conflicts: page.conflicts.map(versionConflictForIpc),
      nextAfterConflictId: page.nextAfterConflictId,
    };
  }

  return {
    async heldNoteChange(input, { event }) {
      const { workspaceId, ...params } = input;
      const request =
        params.action === "review"
          ? params
          : { ...params, author: await dependencies.localPerson() };
      const capture = await requireVersionOperations(workspaceId);
      const result = await capture.heldNoteChange(request);
      if (input.action !== "review") {
        notifyRenderer({ workspaceId: input.workspaceId });
        dependencies.onRefusalsChanged?.();
        activity.queueCloudSync(input.workspaceId);
      }
      return {
        ...result,
        authors: heldChangeAuthorsForIpc(
          result.authors,
          dependencies.authorNames(workspaceId, event),
        ),
      };
    },
    async listWorkspaceVersions(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const snapshot = await capture.listVersions({ includeArchived: true });
      return {
        versions: snapshot.versions.map(workspaceVersionForIpc),
        activeVersionId: snapshot.activeVersionId,
      };
    },

    async listNotVersionedFiles(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return {
        paths: await capture.notVersioned(() => dependencies.listDiskFiles(input.workspaceId)),
      };
    },

    async createWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const snapshot = await capture.createVersion(input.name);
      notifyRenderer({ workspaceId: input.workspaceId });
      return {
        versions: snapshot.versions.map(workspaceVersionForIpc),
        activeVersionId: snapshot.activeVersionId,
      };
    },

    async switchWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const result = await capture.switchVersion(input.versionId);
      notifyRenderer({ workspaceId: input.workspaceId });
      return result;
    },

    async compareWorkspaceVersions(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.compareVersions(input.versionId, {
        ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
      });
    },

    async countWorkspaceVersionChanges(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return { count: await capture.compareVersionsChangedCount(input.versionId) };
    },

    async mergeWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const result = await capture.mergeVersionIntoMain(input.versionId);
      return await mergeResultForIpc(
        capture,
        input.workspaceId,
        { sourceVersionId: input.versionId, targetVersionId: "main" },
        result,
      );
    },

    async updateWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const result = await capture.updateVersionFromMain(input.versionId);
      return await mergeResultForIpc(
        capture,
        input.workspaceId,
        { sourceVersionId: "main", targetVersionId: input.versionId },
        result,
      );
    },

    async archiveWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      await capture.setVersionArchived(input.versionId, input.archived);
      notifyRenderer({ workspaceId: input.workspaceId });
    },

    async listKeptCopies(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.listKeptCopies();
    },

    async saveKeptCopy(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const saved = await capture.saveKeptCopy(input.id);
      if (saved.status === "saved") notifyRenderer({ workspaceId: input.workspaceId });
      return saved;
    },

    async discardProtectedCopy(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.discardProtectedCopy(input.id);
    },

    async listRetainedCopies(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.listRetainedCopies();
    },

    async deleteRetainedCopies(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.deleteRetainedCopies(input.copies);
    },

    async listWorkspaceVersionConflicts(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const page = await capture.listOpenConflictsPage(input.afterConflictId);
      return {
        conflicts: page.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: page.nextAfterConflictId,
      };
    },

    async countWorkspaceVersionConflicts(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.countOpenMergeConflicts(CONFLICT_COUNT_PAGES_MAX);
    },

    async resolveWorkspaceVersionConflict(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const resolution =
        input.resolution.kind === "keep-current"
          ? ({ kind: "keep-current" } as const)
          : input.resolution.kind === "keep-incoming"
            ? ({ kind: "apply-incoming" } as const)
            : ({ kind: "apply-merged", text: input.resolution.text } as const);
      const outcome = await capture.resolveConflict(input.conflictId, resolution);
      // Push the resolution promptly: "keep mine" changes nothing on disk, so
      // without this nudge the other machine's mirrored conflict would stay
      // open until an unrelated edit happened to trigger a sync.
      activity.queueCloudSync(input.workspaceId);
      notifyRenderer({ workspaceId: input.workspaceId });
      dependencies.onRefusalsChanged?.();
      return {
        conflicts: outcome.remaining.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: outcome.remaining.nextAfterConflictId,
      };
    },
  };
}

// The window's handler for the protected-copy writes.
export function protectedCopyHandlers<Event>(dependencies: {
  requireEngineCapture(
    workspaceId: string,
    feature: "Versions",
  ): Promise<{ capture: Pick<VersionOperations, "restoreProtectedCopy"> }>;
  notifyRenderer(target: { workspaceId: string }): void;
  activity: { queueCloudSync(workspaceId: string): void };
}): OperationHandlers<typeof protectedCopyOperations, Event> {
  return {
    async restoreProtectedCopy(input) {
      const { capture } = await dependencies.requireEngineCapture(input.workspaceId, "Versions");
      const restored = await capture.restoreProtectedCopy(input.id);
      dependencies.activity.queueCloudSync(input.workspaceId);
      dependencies.notifyRenderer({ workspaceId: input.workspaceId });
      return restored;
    },
  };
}
