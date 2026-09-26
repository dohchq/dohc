import { describe, expect, it, vi } from "vitest";
import type { VersionedTextConflictRecord } from "@dohc/workspace-contracts/engine";
import { deferred } from "../testing/deferred";
import { workspaceVersionOperations as ops } from "./bridgeContract";
import { registerOperations } from "./operationTable";
import { workspaceVersionHandlers } from "./workspaceVersionsIpc";

type Event = { openWorkspaceId: string };
type Dependencies = Parameters<typeof workspaceVersionHandlers>[0];
type Operations = Awaited<ReturnType<Dependencies["requireEngineCapture"]>>["capture"];

const workspaceId = "workspace";
const versionId = "draft";
const snapshot: Awaited<ReturnType<Operations["listVersions"]>> = {
  activeVersionId: versionId,
  versions: [
    { id: "main", workspaceId, name: "Main", kind: "main", createdAtMs: 1 },
    { id: versionId, workspaceId, name: "Draft", kind: "named", createdAtMs: 2, forkPoint: { versionId: "main" } },
    { id: "nested", workspaceId, name: "Nested", kind: "named", createdAtMs: 3, forkPoint: { versionId } },
    { id: "unbased", workspaceId, name: "Unbased", kind: "named", createdAtMs: 4 },
  ],
};
const conflict: VersionedTextConflictRecord = {
  id: "conflict", workspaceId, path: "notes.md", targetVersionId: "main", sourceVersionId: versionId,
  createdAtMs: 1, updatedAtMs: 2, status: "open", chosenFrom: "current", metadata: { origin: "sync" },
  base: { exists: false, path: "notes.md" },
  current: { exists: true, path: "notes.md", text: "current" },
  incoming: { exists: true, path: "notes.md", contentKind: "binary", sha256: "b".repeat(64), byteLength: 4 },
};
const conflictPage = { conflicts: [conflict], nextAfterConflictId: "next-conflict" };
const tryResult = { versionId, versionName: "Draft", runId: "run" };
const keptCopy = { id: 7, path: "notes.md", keptAtMs: 5 };

const captureRequests = [
  [ops.listWorkspaceVersions.channel, { workspaceId }],
  [ops.createWorkspaceVersion.channel, { workspaceId, name: "Draft" }],
  [ops.switchWorkspaceVersion.channel, { workspaceId, versionId }],
  [ops.compareWorkspaceVersions.channel, { workspaceId, versionId }],
  [ops.mergeWorkspaceVersion.channel, { workspaceId, versionId }],
  [ops.listWorkspaceVersionConflicts.channel, { workspaceId }],
  [ops.resolveWorkspaceVersionConflict.channel, { workspaceId, conflictId: "conflict", resolution: { kind: "keep-current" } }],
  [ops.tryInWorkspaceVersion.channel, { workspaceId, task: "Try this" }],
  [ops.listKeptCopies.channel, { workspaceId }],
  [ops.saveKeptCopy.channel, { workspaceId, id: 7 }],
] as const;
const allRequests = [
  ...captureRequests,
  [ops.getTryInVersionState.channel, { workspaceId }],
  [ops.dismissTryInVersionReview.channel, { workspaceId }],
] as const;

function harness() {
  const handlers = new Map<string, (event: Event, payload: unknown) => Promise<unknown>>();
  const steps: string[] = [];
  const operations = {
    listVersions: vi.fn<Operations["listVersions"]>().mockResolvedValue(snapshot),
    createVersion: vi.fn<Operations["createVersion"]>(async () => { steps.push("create"); return snapshot; }),
    switchVersion: vi.fn<Operations["switchVersion"]>(async () => { steps.push("switch"); return { activeVersionId: versionId, changedFileCount: 2 }; }),
    compareVersions: vi.fn<Operations["compareVersions"]>().mockResolvedValue({ files: [], nextAfterPath: null }),
    mergeVersionIntoMain: vi.fn<Operations["mergeVersionIntoMain"]>(async () => { steps.push("merge"); return { mergedFileCount: 2, unchangedFileCount: 1, conflictCount: 1 }; }),
    listOpenConflictsPage: vi.fn<Operations["listOpenConflictsPage"]>(async () => { steps.push("conflicts"); return conflictPage; }),
    resolveConflict: vi.fn<Operations["resolveConflict"]>(async () => { steps.push("resolve"); return { conflict, remaining: conflictPage }; }),
    listKeptCopies: vi.fn<Operations["listKeptCopies"]>(async () => { steps.push("kept"); return { keptCopies: [keptCopy], more: false }; }),
    saveKeptCopy: vi.fn<Operations["saveKeptCopy"]>(async () => { steps.push("save kept"); return { status: "saved", path: "notes (kept copy).md" }; }),
  };
  const requireEngineCapture = vi.fn<Dependencies["requireEngineCapture"]>(async () => {
    steps.push("capture");
    return { capture: operations };
  });
  const notifyRenderer = vi.fn<Dependencies["notifyRenderer"]>(() => { steps.push("notify"); });
  const queueCloudSync = vi.fn(() => { steps.push("sync"); });
  const sessions = {
    start: vi.fn<Dependencies["tryInVersionSessions"]["start"]>(async () => { steps.push("start"); return tryResult; }),
    snapshot: vi.fn<Dependencies["tryInVersionSessions"]["snapshot"]>(() => null),
    dismiss: vi.fn<Dependencies["tryInVersionSessions"]["dismiss"]>(() => { steps.push("dismiss"); return true; }),
  };
  const desktopMarks = {
    mark: vi.fn(() => { steps.push("mark"); }),
    measureSince: vi.fn(() => { steps.push("measure"); }),
  };
  registerOperations<typeof ops, Event, unknown>(
    {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      assertTrustedSender: () => undefined,
      withActiveWorkspace: async (event, workspaceId, inactiveMessage, work) => {
        if (event.openWorkspaceId !== workspaceId) throw new Error(inactiveMessage);
        return await work(undefined);
      },
    },
    ops,
    workspaceVersionHandlers({
      requireEngineCapture, notifyRenderer,
      activity: { queueCloudSync }, tryInVersionSessions: sessions, desktopMarks,
    }),
  );
  const invoke = async (channel: string, payload: unknown, openWorkspaceId = workspaceId) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler({ openWorkspaceId }, payload);
  };
  return { steps, operations, requireEngineCapture, notifyRenderer, queueCloudSync, sessions, desktopMarks, invoke };
}

describe("registered workspace version handlers", () => {
  it.each(allRequests)("refuses %s from a window showing another workspace", async (channel, payload) => {
    const h = harness();
    await expect(h.invoke(channel, payload, "other-workspace")).rejects.toThrow(
      ops.listWorkspaceVersions.inactiveMessage,
    );
    expect(h.steps).toEqual([]);
  });

  it.each(captureRequests)("propagates the capture refusal without downstream work for %s", async (channel, payload) => {
    const h = harness();
    const refusal = new Error("Versions are unavailable for this workspace");
    h.requireEngineCapture.mockRejectedValue(refusal);
    await expect(h.invoke(channel, payload)).rejects.toBe(refusal);
    expect(h.requireEngineCapture).toHaveBeenCalledExactlyOnceWith(workspaceId, "Versions");
    expect(h.steps).toEqual([]);
    for (const operation of Object.values(h.operations)) expect(operation).not.toHaveBeenCalled();
    expect(h.sessions.start).not.toHaveBeenCalled();
  });

  it("maps merge eligibility from the named version's Main fork", async () => {
    const h = harness();
    await expect(h.invoke(ops.listWorkspaceVersions.channel, { workspaceId })).resolves.toEqual({
      activeVersionId: versionId,
      versions: snapshot.versions.map(({ id, name, kind, createdAtMs }) => ({
        id, name, kind, createdAtMs, canMergeIntoMain: id === versionId,
      })),
    });
    expect(h.notifyRenderer).not.toHaveBeenCalled();
  });

  it("waits for the capture gate and version creation before notifying", async () => {
    const h = harness();
    const gate = deferred<Awaited<ReturnType<Dependencies["requireEngineCapture"]>>>();
    const created = deferred<Awaited<ReturnType<Operations["createVersion"]>>>();
    const started = deferred();
    h.requireEngineCapture.mockReturnValue(gate.promise);
    h.operations.createVersion.mockImplementation(() => { started.resolve(); return created.promise; });
    const result = h.invoke(ops.createWorkspaceVersion.channel, { workspaceId, name: "New draft" });
    expect(h.operations.createVersion).not.toHaveBeenCalled();
    gate.resolve({ capture: h.operations });
    await started.promise;
    expect(h.operations.createVersion).toHaveBeenCalledExactlyOnceWith("New draft");
    expect(h.notifyRenderer).not.toHaveBeenCalled();
    created.resolve(snapshot);
    await expect(result).resolves.toMatchObject({ activeVersionId: versionId });
    expect(h.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId });
  });

  it("propagates a retired capture's mutation refusal without notifying", async () => {
    const h = harness();
    const refusal = new Error("Workspace engine is shutting down (create version).");
    h.operations.createVersion.mockRejectedValue(refusal);
    await expect(h.invoke(ops.createWorkspaceVersion.channel, { workspaceId, name: "Draft" })).rejects.toBe(refusal);
    expect(h.notifyRenderer).not.toHaveBeenCalled();
    expect(h.queueCloudSync).not.toHaveBeenCalled();
  });

  it("lists kept copies and saves one, repainting only when a copy was saved", async () => {
    const h = harness();
    await expect(h.invoke(ops.listKeptCopies.channel, { workspaceId })).resolves.toEqual({ keptCopies: [keptCopy], more: false });
    await expect(h.invoke(ops.saveKeptCopy.channel, { workspaceId, id: 7 })).resolves.toEqual({ status: "saved", path: "notes (kept copy).md" });
    expect(h.operations.saveKeptCopy).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.steps).toEqual(["capture", "kept", "capture", "save kept", "notify"]);
    h.operations.saveKeptCopy.mockResolvedValue({ status: "gone" });
    await expect(h.invoke(ops.saveKeptCopy.channel, { workspaceId, id: 7 })).resolves.toEqual({ status: "gone" });
    h.operations.saveKeptCopy.mockResolvedValue({ status: "no-valid-name" });
    await expect(h.invoke(ops.saveKeptCopy.channel, { workspaceId, id: 7 }))
      .resolves.toEqual({ status: "no-valid-name" });
    expect(h.notifyRenderer).toHaveBeenCalledOnce();
  });

  it("switches through the capture owner and returns its changed-file count", async () => {
    const h = harness();
    await expect(h.invoke(ops.switchWorkspaceVersion.channel, { workspaceId, versionId })).resolves.toEqual({ activeVersionId: versionId, changedFileCount: 2 });
    expect(h.operations.switchVersion).toHaveBeenCalledExactlyOnceWith(versionId);
    expect(h.steps).toEqual(["capture", "switch", "notify"]);
  });

  it("preserves comparison continuations and protected/binary metadata", async () => {
    const h = harness();
    const page = { files: [{ path: ".env", status: "modified" as const, protected: true }, { path: "photo.png", status: "added" as const, binary: true }], nextAfterPath: "photo.png" };
    h.operations.compareVersions.mockResolvedValue(page);
    await expect(h.invoke(ops.compareWorkspaceVersions.channel, { workspaceId, versionId })).resolves.toEqual(page);
    expect(h.operations.compareVersions).toHaveBeenLastCalledWith(versionId, {});
    await h.invoke(ops.compareWorkspaceVersions.channel, { workspaceId, versionId, afterPath: "photo.png" });
    expect(h.operations.compareVersions).toHaveBeenLastCalledWith(versionId, { afterPath: "photo.png" });
    expect(h.notifyRenderer).not.toHaveBeenCalled();
  });

  it("reads one conflict page after a conflicted merge and preserves mixed sides", async () => {
    const h = harness();
    await expect(h.invoke(ops.mergeWorkspaceVersion.channel, { workspaceId, versionId })).resolves.toMatchObject({
      mergedFileCount: 2, unchangedFileCount: 1, conflictCount: 1, nextAfterConflictId: "next-conflict",
      conflicts: [{ conflictId: "conflict", origin: "sync", contentKind: "binary", currentText: "current", incomingText: null, baseText: null, incomingBinary: { byteLength: 4, sha256: "b".repeat(64) } }],
    });
    expect(h.operations.mergeVersionIntoMain).toHaveBeenCalledExactlyOnceWith(versionId);
    expect(h.operations.listOpenConflictsPage).toHaveBeenCalledExactlyOnceWith();
    expect(h.steps).toEqual(["capture", "merge", "notify", "conflicts"]);
  });

  it("does not load unrelated conflicts after a clean merge", async () => {
    const h = harness();
    h.operations.mergeVersionIntoMain.mockResolvedValue({ mergedFileCount: 1, unchangedFileCount: 2, conflictCount: 0 });
    await expect(h.invoke(ops.mergeWorkspaceVersion.channel, { workspaceId, versionId })).resolves.toEqual({ mergedFileCount: 1, unchangedFileCount: 2, conflictCount: 0, conflicts: [], nextAfterConflictId: null });
    expect(h.operations.listOpenConflictsPage).not.toHaveBeenCalled();
  });

  it("passes the conflict cursor without draining subsequent pages", async () => {
    const h = harness();
    await expect(h.invoke(ops.listWorkspaceVersionConflicts.channel, { workspaceId, afterConflictId: "previous" })).resolves.toMatchObject({ conflicts: [{ conflictId: "conflict" }], nextAfterConflictId: "next-conflict" });
    expect(h.operations.listOpenConflictsPage).toHaveBeenCalledExactlyOnceWith("previous");
  });

  it.each([
    [{ kind: "keep-current" }, { kind: "keep-current" }],
    [{ kind: "keep-incoming" }, { kind: "apply-incoming" }],
    [{ kind: "keep-combined", text: "combined" }, { kind: "apply-merged", text: "combined" }],
  ] as const)("resolves %j and queues cloud sync before notifying", async (resolution, expected) => {
    const h = harness();
    await expect(h.invoke(ops.resolveWorkspaceVersionConflict.channel, { workspaceId, conflictId: "conflict", resolution })).resolves.toMatchObject({ nextAfterConflictId: "next-conflict" });
    expect(h.operations.resolveConflict).toHaveBeenCalledExactlyOnceWith("conflict", expected);
    expect(h.queueCloudSync).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(h.steps).toEqual(["capture", "resolve", "sync", "notify"]);
  });

  it("does not announce a refused conflict resolution", async () => {
    const h = harness();
    const refusal = new Error("conflict is no longer current");
    h.operations.resolveConflict.mockRejectedValue(refusal);
    await expect(h.invoke(ops.resolveWorkspaceVersionConflict.channel, { workspaceId, conflictId: "conflict", resolution: { kind: "keep-current" } })).rejects.toBe(refusal);
    expect(h.notifyRenderer).not.toHaveBeenCalled();
    expect(h.queueCloudSync).not.toHaveBeenCalled();
  });

  it("keeps result parsing after the completed mutation and notification", async () => {
    const h = harness();
    h.operations.switchVersion.mockResolvedValue({ activeVersionId: versionId, changedFileCount: -1 });
    await expect(h.invoke(ops.switchWorkspaceVersion.channel, { workspaceId, versionId })).rejects.toThrow();
    expect(h.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId });
  });
});

describe("registered try-in-version handlers", () => {
  it("passes the task through the existing manager", async () => {
    const h = harness();
    await expect(h.invoke(ops.tryInWorkspaceVersion.channel, { workspaceId, task: "Try this" })).resolves.toEqual(tryResult);
    expect(h.sessions.start).toHaveBeenCalledExactlyOnceWith(workspaceId, "Try this");
    expect(h.steps).toEqual(["capture", "mark", "start", "measure"]);
    expect(h.desktopMarks.mark).toHaveBeenCalledWith("try-in-version-start");
    expect(h.desktopMarks.measureSince).toHaveBeenCalledWith("try-in-version-gesture", "try-in-version-start");
  });

  it("does not record completed gesture latency when the manager refuses", async () => {
    const h = harness();
    h.sessions.start.mockRejectedValue(new Error("run already active"));
    await expect(h.invoke(ops.tryInWorkspaceVersion.channel, { workspaceId, task: "Try this" })).rejects.toThrow("run already active");
    expect(h.desktopMarks.measureSince).not.toHaveBeenCalled();
  });

  it("reads and dismisses review state without acquiring engine capture", async () => {
    const h = harness();
    await expect(h.invoke(ops.getTryInVersionState.channel, { workspaceId })).resolves.toEqual({ state: null });
    h.sessions.snapshot.mockReturnValue({ ...tryResult, status: "review", task: "Try this", startedAtMs: 1, endedAtMs: 2, runOutcome: "complete", changedFileCount: null, mergeAvailable: true });
    await expect(h.invoke(ops.getTryInVersionState.channel, { workspaceId })).resolves.toMatchObject({ state: { status: "review", changedFileCount: null } });
    await expect(h.invoke(ops.dismissTryInVersionReview.channel, { workspaceId })).resolves.toBeUndefined();
    expect(h.sessions.dismiss).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
  });
});
