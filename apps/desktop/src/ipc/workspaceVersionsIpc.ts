import type {
  WorkspaceVersionRecord,
  workspaceVersionOperations,
} from "./bridgeContract";
import { versionConflictForIpc } from "./engineHistoryIpc";
import type { OperationHandlers } from "./operationTable";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { createTryInVersionSessions } from "../agents/tryInVersion";

type VersionOperations = Pick<WorkspaceEngineCapture,
  | "listVersions"
  | "createVersion"
  | "switchVersion"
  | "compareVersions"
  | "mergeVersionIntoMain"
  | "listOpenConflictsPage"
  | "resolveConflict"
  | "listKeptCopies"
  | "saveKeptCopy"
>;

export function workspaceVersionHandlers(dependencies: {
  requireEngineCapture(workspaceId: string, feature: "Versions"): Promise<{ capture: VersionOperations }>;
  notifyRenderer(target: { workspaceId: string }): void;
  activity: { queueCloudSync(workspaceId: string): void };
  tryInVersionSessions: Pick<ReturnType<typeof createTryInVersionSessions>, "start" | "snapshot" | "dismiss">;
  desktopMarks: { mark(name: string): void; measureSince(name: string, start: string): unknown };
}): OperationHandlers<typeof workspaceVersionOperations> {
  const {
    requireEngineCapture, notifyRenderer, activity, tryInVersionSessions, desktopMarks,
  } = dependencies;

  async function requireVersionOperations(workspaceId: string) {
    const { capture } = await requireEngineCapture(
      workspaceId,
      "Versions",
    );
    return capture;
  }

  function workspaceVersionForIpc(version: {
    id: string;
    name: string;
    kind: "main" | "named";
    createdAtMs: number;
    forkPoint?: { versionId: string };
  }): WorkspaceVersionRecord {
    return {
      id: version.id,
      name: version.name,
      kind: version.kind,
      createdAtMs: version.createdAtMs,
      canMergeIntoMain:
        version.kind === "named" && version.forkPoint?.versionId === "main",
    };
  }

  return {
    async listWorkspaceVersions(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const snapshot = await capture.listVersions();
      return {
        versions: snapshot.versions.map(workspaceVersionForIpc),
        activeVersionId: snapshot.activeVersionId,
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

    async mergeWorkspaceVersion(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const result = await capture.mergeVersionIntoMain(input.versionId);
      notifyRenderer({ workspaceId: input.workspaceId });
      // The merge reports a count; the rows are open conflicts in the engine,
      // read back one page at a time like every other conflict reader.
      const page =
        result.conflictCount > 0
          ? await capture.listOpenConflictsPage()
          : { conflicts: [], nextAfterConflictId: null };
      return {
        mergedFileCount: result.mergedFileCount,
        unchangedFileCount: result.unchangedFileCount,
        conflictCount: result.conflictCount,
        conflicts: page.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: page.nextAfterConflictId,
      };
    },

    async listKeptCopies(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      return await capture.listKeptCopies();
    },

    async saveKeptCopy(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const path = await capture.saveKeptCopy(input.id);
      if (path !== null) notifyRenderer({ workspaceId: input.workspaceId });
      return { path };
    },

    async listWorkspaceVersionConflicts(input) {
      const capture = await requireVersionOperations(input.workspaceId);
      const page = await capture.listOpenConflictsPage(input.afterConflictId);
      return {
        conflicts: page.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: page.nextAfterConflictId,
      };
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
      return {
        conflicts: outcome.remaining.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: outcome.remaining.nextAfterConflictId,
      };
    },

    // "Try it in a version". The gesture handler double-gates on the engine
    // capture (requireVersionOperations here, and the manager's own
    // operationsFor) so a workspace without one rejects before anything runs.
    async tryInWorkspaceVersion(input) {
      await requireVersionOperations(input.workspaceId);
      desktopMarks.mark("try-in-version-start");
      const result = await tryInVersionSessions.start(
        input.workspaceId,
        input.task,
        input.driverId,
      );
      // Gesture latency evidence (create+switch+run-start, excluding any agent
      // process startup on the bare-run path), read via the test-gated marks.
      desktopMarks.measureSince("try-in-version-gesture", "try-in-version-start");
      return result;
    },

    getTryInVersionState(input) {
      return { state: tryInVersionSessions.snapshot(input.workspaceId) };
    },

    dismissTryInVersionReview(input) {
      tryInVersionSessions.dismiss(input.workspaceId);
    },
  };
}
