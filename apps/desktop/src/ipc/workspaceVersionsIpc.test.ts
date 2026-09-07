import { describe, expect, it, vi } from "vitest";
import type { VersionedTextConflictRecord } from "@dohc/workspace-contracts/engine";
import { deferred } from "../testing/deferred";
import { CHANNELS } from "./channels";
import { registerWorkspaceVersionsIpcHandlers } from "./workspaceVersionsIpc";

type Event = { trusted: boolean };
type Dependencies = Parameters<typeof registerWorkspaceVersionsIpcHandlers<Event>>[0];
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

const captureRequests = [
  [CHANNELS.listWorkspaceVersions, { workspaceId }],
  [CHANNELS.createWorkspaceVersion, { workspaceId, name: "Draft" }],
  [CHANNELS.switchWorkspaceVersion, { workspaceId, versionId }],
  [CHANNELS.compareWorkspaceVersions, { workspaceId, versionId }],
  [CHANNELS.mergeWorkspaceVersion, { workspaceId, versionId }],
  [CHANNELS.listWorkspaceVersionConflicts, { workspaceId }],
  [CHANNELS.resolveWorkspaceVersionConflict, { workspaceId, conflictId: "conflict", resolution: { kind: "keep-current" } }],
  [CHANNELS.tryInWorkspaceVersion, { workspaceId, task: "Try this" }],
] as const;
const allRequests = [
  ...captureRequests,
  [CHANNELS.getTryInVersionState, { workspaceId }],
  [CHANNELS.dismissTryInVersionReview, { workspaceId }],
] as const;

function harness() {
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const steps: string[] = [];
  const operations = {
    listVersions: vi.fn<Operations["listVersions"]>().mockResolvedValue(snapshot),
    createVersion: vi.fn<Operations["createVersion"]>(async () => { steps.push("create"); return snapshot; }),
    switchVersion: vi.fn<Operations["switchVersion"]>(async () => { steps.push("switch"); return { activeVersionId: versionId, changedFileCount: 2 }; }),
    compareVersions: vi.fn<Operations["compareVersions"]>().mockResolvedValue({ files: [], nextAfterPath: null }),
    mergeVersionIntoMain: vi.fn<Operations["mergeVersionIntoMain"]>(async () => { steps.push("merge"); return { mergedFileCount: 2, unchangedFileCount: 1, conflictCount: 1 }; }),
    listOpenConflictsPage: vi.fn<Operations["listOpenConflictsPage"]>(async () => { steps.push("conflicts"); return conflictPage; }),
    resolveConflict: vi.fn<Operations["resolveConflict"]>(async () => { steps.push("resolve"); return { conflict, remaining: conflictPage }; }),
  };
  const requireEngineCapture = vi.fn<Dependencies["requireEngineCapture"]>(async () => {
    steps.push("capture");
    return { capture: operations };
  });
  const requireWorkspace = vi.fn<Dependencies["requireWorkspace"]>(() => { steps.push("workspace"); });
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
  registerWorkspaceVersionsIpcHandlers<Event>({
    registerHandler: (channel, handler) => {
      expect(handlers.has(channel)).toBe(false);
      handlers.set(channel, handler);
    },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    requireEngineCapture, requireWorkspace, notifyRenderer,
    activity: { queueCloudSync }, tryInVersionSessions: sessions, desktopMarks,
  });
  const invoke = async (channel: string, payload: unknown, trusted = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler({ trusted }, payload);
  };
  return { handlers, steps, operations, requireEngineCapture, requireWorkspace, notifyRenderer, queueCloudSync, sessions, desktopMarks, invoke };
}

describe("registered workspace version handlers", () => {
  it("registers the ten existing channels in order", () => {
    expect([...harness().handlers.keys()]).toEqual(allRequests.map(([channel]) => channel));
  });

  it.each(allRequests)("refuses an untrusted sender before parsing or accessing %s", async (channel) => {
    const h = harness();
    await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    expect(h.steps).toEqual([]);
  });

  it.each(allRequests)("rejects malformed payloads before accessing %s", async (channel) => {
    const h = harness();
    await expect(h.invoke(channel, {})).rejects.toThrow();
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
    await expect(h.invoke(CHANNELS.listWorkspaceVersions, { workspaceId })).resolves.toEqual({
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
    const result = h.invoke(CHANNELS.createWorkspaceVersion, { workspaceId, name: "New draft" });
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
    await expect(h.invoke(CHANNELS.createWorkspaceVersion, { workspaceId, name: "Draft" })).rejects.toBe(refusal);
    expect(h.notifyRenderer).not.toHaveBeenCalled();
    expect(h.queueCloudSync).not.toHaveBeenCalled();
  });

  it("switches through the capture owner and returns its changed-file count", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.switchWorkspaceVersion, { workspaceId, versionId })).resolves.toEqual({ activeVersionId: versionId, changedFileCount: 2 });
    expect(h.operations.switchVersion).toHaveBeenCalledExactlyOnceWith(versionId);
    expect(h.steps).toEqual(["capture", "switch", "notify"]);
  });

  it("preserves comparison continuations and protected/binary metadata", async () => {
    const h = harness();
    const page = { files: [{ path: ".env", status: "modified" as const, protected: true }, { path: "photo.png", status: "added" as const, binary: true }], nextAfterPath: "photo.png" };
    h.operations.compareVersions.mockResolvedValue(page);
    await expect(h.invoke(CHANNELS.compareWorkspaceVersions, { workspaceId, versionId })).resolves.toEqual(page);
    expect(h.operations.compareVersions).toHaveBeenLastCalledWith(versionId, {});
    await h.invoke(CHANNELS.compareWorkspaceVersions, { workspaceId, versionId, afterPath: "photo.png" });
    expect(h.operations.compareVersions).toHaveBeenLastCalledWith(versionId, { afterPath: "photo.png" });
    expect(h.notifyRenderer).not.toHaveBeenCalled();
  });

  it("reads one conflict page after a conflicted merge and preserves mixed sides", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.mergeWorkspaceVersion, { workspaceId, versionId })).resolves.toMatchObject({
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
    await expect(h.invoke(CHANNELS.mergeWorkspaceVersion, { workspaceId, versionId })).resolves.toEqual({ mergedFileCount: 1, unchangedFileCount: 2, conflictCount: 0, conflicts: [], nextAfterConflictId: null });
    expect(h.operations.listOpenConflictsPage).not.toHaveBeenCalled();
  });

  it("passes the conflict cursor without draining subsequent pages", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.listWorkspaceVersionConflicts, { workspaceId, afterConflictId: "previous" })).resolves.toMatchObject({ conflicts: [{ conflictId: "conflict" }], nextAfterConflictId: "next-conflict" });
    expect(h.operations.listOpenConflictsPage).toHaveBeenCalledExactlyOnceWith("previous");
  });

  it.each([
    [{ kind: "keep-current" }, { kind: "keep-current" }],
    [{ kind: "keep-incoming" }, { kind: "apply-incoming" }],
    [{ kind: "keep-combined", text: "combined" }, { kind: "apply-merged", text: "combined" }],
  ] as const)("resolves %j and queues cloud sync before notifying", async (resolution, expected) => {
    const h = harness();
    await expect(h.invoke(CHANNELS.resolveWorkspaceVersionConflict, { workspaceId, conflictId: "conflict", resolution })).resolves.toMatchObject({ nextAfterConflictId: "next-conflict" });
    expect(h.operations.resolveConflict).toHaveBeenCalledExactlyOnceWith("conflict", expected);
    expect(h.queueCloudSync).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(h.steps).toEqual(["capture", "resolve", "sync", "notify"]);
  });

  it("does not announce a refused conflict resolution", async () => {
    const h = harness();
    const refusal = new Error("conflict is no longer current");
    h.operations.resolveConflict.mockRejectedValue(refusal);
    await expect(h.invoke(CHANNELS.resolveWorkspaceVersionConflict, { workspaceId, conflictId: "conflict", resolution: { kind: "keep-current" } })).rejects.toBe(refusal);
    expect(h.notifyRenderer).not.toHaveBeenCalled();
    expect(h.queueCloudSync).not.toHaveBeenCalled();
  });

  it("keeps result parsing after the completed mutation and notification", async () => {
    const h = harness();
    h.operations.switchVersion.mockResolvedValue({ activeVersionId: versionId, changedFileCount: -1 });
    await expect(h.invoke(CHANNELS.switchWorkspaceVersion, { workspaceId, versionId })).rejects.toThrow();
    expect(h.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId });
  });
});

describe("registered try-in-version handlers", () => {
  it.each([undefined, "agent-driver"])("passes the task and driver %s through the existing manager", async (driverId) => {
    const h = harness();
    await expect(h.invoke(CHANNELS.tryInWorkspaceVersion, { workspaceId, task: "Try this", ...(driverId ? { driverId } : {}) })).resolves.toEqual(tryResult);
    expect(h.sessions.start).toHaveBeenCalledExactlyOnceWith(workspaceId, "Try this", driverId);
    expect(h.steps).toEqual(["capture", "mark", "start", "measure"]);
    expect(h.desktopMarks.mark).toHaveBeenCalledWith("try-in-version-start");
    expect(h.desktopMarks.measureSince).toHaveBeenCalledWith("try-in-version-gesture", "try-in-version-start");
  });

  it("does not record completed gesture latency when the manager refuses", async () => {
    const h = harness();
    h.sessions.start.mockRejectedValue(new Error("run already active"));
    await expect(h.invoke(CHANNELS.tryInWorkspaceVersion, { workspaceId, task: "Try this" })).rejects.toThrow("run already active");
    expect(h.desktopMarks.measureSince).not.toHaveBeenCalled();
  });

  it.each([CHANNELS.getTryInVersionState, CHANNELS.dismissTryInVersionReview])("requires an existing workspace before %s", async (channel) => {
    const h = harness();
    h.requireWorkspace.mockImplementation(() => { throw new Error("workspace missing"); });
    await expect(h.invoke(channel, { workspaceId })).rejects.toThrow("workspace missing");
    expect(h.sessions.snapshot).not.toHaveBeenCalled();
    expect(h.sessions.dismiss).not.toHaveBeenCalled();
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
  });

  it("reads and dismisses review state without acquiring engine capture", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.getTryInVersionState, { workspaceId })).resolves.toEqual({ state: null });
    h.sessions.snapshot.mockReturnValue({ ...tryResult, status: "review", task: "Try this", startedAtMs: 1, endedAtMs: 2, runOutcome: "complete", changedFileCount: null, mergeAvailable: true });
    await expect(h.invoke(CHANNELS.getTryInVersionState, { workspaceId })).resolves.toMatchObject({ state: { status: "review", changedFileCount: null } });
    await expect(h.invoke(CHANNELS.dismissTryInVersionReview, { workspaceId })).resolves.toBeUndefined();
    expect(h.sessions.dismiss).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(h.requireWorkspace).toHaveBeenCalledTimes(3);
    expect(h.requireEngineCapture).not.toHaveBeenCalled();
  });
});
