import {
  WorkspaceIdPayload,
  ListWorkspaceVersionsResult,
  CreateWorkspaceVersionPayload,
  SwitchWorkspaceVersionPayload,
  SwitchWorkspaceVersionResult,
  CompareWorkspaceVersionsPayload,
  CompareWorkspaceVersionsResult,
  MergeWorkspaceVersionPayload,
  MergeWorkspaceVersionResult,
  ListWorkspaceVersionConflictsPayload,
  ListWorkspaceVersionConflictsResult,
  ResolveWorkspaceVersionConflictPayload,
  ResolveWorkspaceVersionConflictResult,
  TryInVersionStateResult,
  TryInWorkspaceVersionPayload,
  TryInWorkspaceVersionResult,
  WorkspaceVersionRecord,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { versionConflictForIpc } from "./engineHistoryIpc";
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
>;

export function registerWorkspaceVersionsIpcHandlers<Event>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  requireEngineCapture(workspaceId: string, feature: "Versions"): Promise<{ capture: VersionOperations }>;
  requireWorkspace(workspaceId: string): unknown;
  notifyRenderer(target: { workspaceId: string }): void;
  activity: { queueCloudSync(workspaceId: string): void };
  tryInVersionSessions: Pick<ReturnType<typeof createTryInVersionSessions>, "start" | "snapshot" | "dismiss">;
  desktopMarks: { mark(name: string): void; measureSince(name: string, start: string): unknown };
}): void {
  const {
    registerHandler, assertTrustedSender, requireEngineCapture, requireWorkspace,
    notifyRenderer, activity, tryInVersionSessions, desktopMarks,
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

  registerHandler(CHANNELS.listWorkspaceVersions, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const snapshot = await capture.listVersions();
    return ListWorkspaceVersionsResult.parse({
      versions: snapshot.versions.map(workspaceVersionForIpc),
      activeVersionId: snapshot.activeVersionId,
    });
  });

  registerHandler(CHANNELS.createWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = CreateWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const snapshot = await capture.createVersion(input.name);
    notifyRenderer({ workspaceId: input.workspaceId });
    return ListWorkspaceVersionsResult.parse({
      versions: snapshot.versions.map(workspaceVersionForIpc),
      activeVersionId: snapshot.activeVersionId,
    });
  });

  registerHandler(CHANNELS.switchWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = SwitchWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const result = await capture.switchVersion(input.versionId);
    notifyRenderer({ workspaceId: input.workspaceId });
    return SwitchWorkspaceVersionResult.parse(result);
  });

  registerHandler(CHANNELS.compareWorkspaceVersions, async (event, payload) => {
    assertTrustedSender(event);
    const input = CompareWorkspaceVersionsPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const page = await capture.compareVersions(input.versionId, {
      ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
    });
    return CompareWorkspaceVersionsResult.parse(page);
  });

  registerHandler(CHANNELS.mergeWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = MergeWorkspaceVersionPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const result = await capture.mergeVersionIntoMain(input.versionId);
    notifyRenderer({ workspaceId: input.workspaceId });
    // The merge reports a count; the rows are open conflicts in the engine,
    // read back one page at a time like every other conflict reader.
    const page =
      result.conflictCount > 0
        ? await capture.listOpenConflictsPage()
        : { conflicts: [], nextAfterConflictId: null };
    return MergeWorkspaceVersionResult.parse({
      mergedFileCount: result.mergedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      conflictCount: result.conflictCount,
      conflicts: page.conflicts.map(versionConflictForIpc),
      nextAfterConflictId: page.nextAfterConflictId,
    });
  });

  registerHandler(CHANNELS.listWorkspaceVersionConflicts, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceVersionConflictsPayload.parse(payload);
    const capture = await requireVersionOperations(input.workspaceId);
    const page = await capture.listOpenConflictsPage(input.afterConflictId);
    return ListWorkspaceVersionConflictsResult.parse({
      conflicts: page.conflicts.map(versionConflictForIpc),
      nextAfterConflictId: page.nextAfterConflictId,
    });
  });

  registerHandler(
    CHANNELS.resolveWorkspaceVersionConflict,
    async (event, payload) => {
      assertTrustedSender(event);
      const input = ResolveWorkspaceVersionConflictPayload.parse(payload);
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
      return ResolveWorkspaceVersionConflictResult.parse({
        conflicts: outcome.remaining.conflicts.map(versionConflictForIpc),
        nextAfterConflictId: outcome.remaining.nextAfterConflictId,
      });
    },
  );

  // "Try it in a version". The gesture handler double-gates on the engine
  // capture (requireVersionOperations here, and the manager's own
  // operationsFor) so a workspace without one rejects before anything runs.
  registerHandler(CHANNELS.tryInWorkspaceVersion, async (event, payload) => {
    assertTrustedSender(event);
    const input = TryInWorkspaceVersionPayload.parse(payload);
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
    return TryInWorkspaceVersionResult.parse(result);
  });

  registerHandler(CHANNELS.getTryInVersionState, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    return TryInVersionStateResult.parse({
      state: tryInVersionSessions.snapshot(input.workspaceId),
    });
  });

  registerHandler(CHANNELS.dismissTryInVersionReview, async (event, payload) => {
    assertTrustedSender(event);
    const input = WorkspaceIdPayload.parse(payload);
    requireWorkspace(input.workspaceId);
    tryInVersionSessions.dismiss(input.workspaceId);
  });

}
