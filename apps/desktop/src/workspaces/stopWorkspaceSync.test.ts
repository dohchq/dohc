import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonRefusalError, VersionedLiveAdapter, type Request, type Response } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions, type EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import { RelayConfiguredDaemonClientSource, RelayTransportRouteGuard } from "./engineRelayClient";
import type { CloudCredentials } from "./cloudCredentialStore";
import { createRegistryStore } from "./registryStore";
import { workspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";
import { createWorkspaceSyncStop, reopenWithoutSync } from "./stopWorkspaceSync";
import { createWorkspaceActivity, WorkspaceActivityState, type ActivityWorkspace } from "./workspaceActivity";
import { idleObservation } from "./workspaceActivity.testSupport";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { assertSyncEnrollmentCredentials } from "./chatRelayIdentity";
import type { AgentRunStateEvent } from "../ipc/bridgeContract";
import type { ActiveAgentRun } from "../agents/activeAgentRun";
import type { WorkspaceObservationCallbacks } from "./workspaceFileObservation";

const remote = { serverUrl: "https://server.test", ownerUserId: "owner" };
const credentials: CloudCredentials = { ...remote, userId: remote.ownerUserId, token: "token", email: "owner@test", relayUrl: "https://relay.test" };

// The engine's side of an unfinished pull: its token stays until an owner
// open that abandons it succeeds.
class PullDaemon implements EngineDaemonClient {
  openFails = false;
  constructor(public pullUnfinished: boolean) {}
  async sendRequest(request: Request): Promise<Response> {
    const params = request.params as Record<string, unknown>;
    switch (request.method) {
      case "workspace.open":
        if (this.openFails) {
          throw new DaemonRefusalError({ code: "WORKSPACE_UNAVAILABLE", message: "workspace-open-failed", retry: "no" }, new Error("open"));
        }
        if (params.abandonOrdinaryPull === true) this.pullUnfinished = false;
        return { id: request.id, result: { workspace: "handle" } };
      case "workspace.close":
        return { id: request.id, result: { closed: true } };
      case "sync.collectionsWaiting":
        return { id: request.id, result: { waiting: this.pullUnfinished } };
      default:
        throw new Error(`unexpected engine request: ${request.method}`);
    }
  }
  close(): void {}
}

async function fixture(synced = true, collectionsWaiting = false) {
  const rootPath = await createTestScratch("stop-workspace-sync-");
  const registryPath = join(rootPath, "registry.json");
  const store = createRegistryStore(registryPath);
  const workspace: ActivityWorkspace = {
    workspaceId: "workspace", rootPath, kind: "personal", mode: "local-first", attachmentId: Symbol("workspace"),
  };
  store.register({ ...workspace, ...(synced ? { remote } : {}) });
  const steps: string[] = [];
  const resumeAdmission = vi.fn();
  const settle = vi.fn<() => Promise<() => void>>(async () => { steps.push("settle"); return resumeAdmission; });
  const engineStop = vi.fn(async () => { steps.push("engine-stop"); });
  const engineStart = vi.fn(async () => { steps.push("engine-start"); });
  const watcherStop = vi.fn(async () => { steps.push("watcher-stop"); });
  const runStates: AgentRunStateEvent[] = [];
  const captureRuns: ReturnType<typeof vi.fn<(run: ActiveAgentRun | null) => Promise<void>>>[] = [];
  const capturedWrites: (ActiveAgentRun | null)[] = [];
  let observation!: WorkspaceObservationCallbacks;
  const daemon = new PullDaemon(collectionsWaiting);
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource({ currentClient: () => daemon }, new RelayTransportRouteGuard(),
      id => !store.find(id)?.remote),
    { transportRebindAttempts: 1 },
  );
  const reads: Promise<boolean>[] = [];
  const service = createWorkspaceActivity(vi.fn(), {
    collectionsWaitingFor: engineWorkspace => {
      const read = sessions.run(engineWorkspace, ({ client, workspace: handle }) =>
        new VersionedLiveAdapter(client, handle, { workspaceId: engineWorkspace.workspaceId }).collectionsWaiting());
      reads.push(read);
      return read;
    },
    onAgentRunState: event => runStates.push(event),
    observationFor: (_workspace, callbacks) => {
      observation = callbacks;
      return { ...idleObservation(workspace, callbacks), stop: watcherStop };
    },
    cloudStateFor: () => {
      const entry = store.find(workspace.workspaceId)!;
      return { enabled: !!entry.remote, connected: !!entry.remote,
        syncPause: entry.syncPause ? workspaceSyncPauseStatus(entry.syncPause, "local-person") : undefined };
    },
    engineFor: () => store.find(workspace.workspaceId)?.remote ? ({
      start: engineStart, stop: engineStop, queueSync: vi.fn(), snapshot: () => ({}),
    } as never) : null,
    captureFor: () => {
      let activeRun: ActiveAgentRun | null = null;
      const setActiveAgentRun = vi.fn(async (run: ActiveAgentRun | null) => { activeRun = run; });
      captureRuns.push(setActiveAgentRun);
      return { shareView: false, capture: {
        setActiveAgentRun,
        observeFileEvents: () => { capturedWrites.push(activeRun); },
        start: () => {}, stop: async () => { steps.push("capture-stop"); },
        settleAndCloseLiveSessionsForSyncPause: settle,
        settleAndCloseAllLiveSessions: settle,
      } as never };
    },
  });
  const state = new WorkspaceActivityState();
  await service.open(workspace, state);
  // The answer the open asked for in the background.
  await reads[0];
  steps.length = 0;
  let current = true;
  // As in the app, closing the relay closes the workspace's engine sessions.
  const closeRelay = vi.fn(async () => { steps.push("relay-close"); await sessions.closeWorkspace(workspace); });
  const pauseRemote = vi.fn((id: string, pause: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPause) => { steps.push("pause"); store.pauseRemote(id, pause); });
  const cleanupFailed = vi.fn();
  const person = vi.fn(async () => ({ kind: "person" as const, personId: "local-person" }));
  const openActivity = vi.fn(() => service.open(workspace, state));
  const reopen = {
    closeActivity: () => service.close(workspace, state, { notify: false, preserveAgentRun: true }), closeRelay,
    openActivity, collectionsWaiting: () => service.readCollectionsWaiting(workspace, state),
    notify: () => { steps.push("notify"); },
  };
  const stop = createWorkspaceSyncStop({
    ...reopen, person, cleanupFailed, nowMs: () => 42,
    pauseStatus: pause => workspaceSyncPauseStatus(pause, "local-person"),
    withOwnerHostPaused: async work => { steps.push("host-pause"); try { return await work(); } finally { steps.push("host-resume"); } },
    prepare: () => service.prepareSyncPause(workspace, state), resume: () => service.enableCloud(workspace, state), pauseRemote,
    status: () => service.getStatus(workspace, state),
    reopenFailed: () => service.recordSyncPauseReopenFailed(workspace, state),
  });
  const operation = () => ({
    get workspace() { return { ...store.find(workspace.workspaceId)!, attachmentId: workspace.attachmentId }; },
    assertCurrent() { if (!current) throw new Error("workspace changed"); },
  });
  return { workspace, store, registryPath, steps, settle, engineStart, engineStop, watcherStop, closeRelay,
    pauseRemote, resumeAdmission, service, state, stop, operation, cleanupFailed, person, runStates, captureRuns, capturedWrites,
    openActivity, reopen, daemon,
    write: () => observation.facts([{ path: "note.md", kind: "changed" }]), retire: () => { current = false; } };
}

describe("stop one workspace's sync", () => {
  it("keeps a dispatched run active and claiming writes across the capture restart", async () => {
    const h = await fixture();
    const run = { agentId: "default", onBehalfOf: "local-person", agentRunId: "run", depth: 2, dispatch: "run" as const };
    await h.service.claimAgentRun(h.workspace, h.state, run);
    try {
      await h.stop(h.operation());
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(true);
      expect(h.runStates.map(event => event.active)).toEqual([true]);
      expect(h.service.dispatchedAgent(h.state)).toBe("default");
      expect(h.service.agentRunDepth(h.state)).toBe(2);
      const collectionRun = h.service.agentRun(h.state);
      expect(collectionRun).toEqual(run);
      expect(collectionRun).not.toBe(run);
      expect(h.captureRuns[1]).toHaveBeenCalledExactlyOnceWith(run);
      h.write();
      expect(h.capturedWrites).toEqual([run]);
      expect(await h.service.claimAgentRun(h.workspace, h.state, { ...run, agentId: "other", agentRunId: "other" })).toBe(false);
      await h.service.clearAgentRun(h.state, run.agentRunId);
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(false);
      expect(h.service.dispatchedAgent(h.state)).toBeNull();
      expect(h.service.agentRun(h.state)).toBeNull();
    } finally {
      await h.service.close(h.workspace, h.state);
    }
  });

  it("does not revive a run that ends while sync is stopping", async () => {
    const h = await fixture();
    const run = { agentId: "default", onBehalfOf: "local-person", agentRunId: "run", depth: 2, dispatch: "run" as const };
    await h.service.claimAgentRun(h.workspace, h.state, run);
    h.closeRelay.mockImplementationOnce(async () => {
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(true);
      expect(h.service.dispatchedAgent(h.state)).toBe("default");
      await h.service.clearAgentRun(h.state, run.agentRunId, h.workspace.rootPath);
    });
    try {
      await h.stop(h.operation());
      expect(h.cleanupFailed).not.toHaveBeenCalled();
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(false);
      expect(h.service.dispatchedAgent(h.state)).toBeNull();
      expect(h.runStates.map(event => event.active)).toEqual([true, false]);
      expect(h.captureRuns[1]).not.toHaveBeenCalled();
      h.write();
      expect(h.capturedWrites).toEqual([null]);
    } finally {
      await h.service.close(h.workspace, h.state);
    }
  });

  it("leaves a never-synced workspace open without requiring an account", async () => {
    const h = await fixture(false);
    const operation = h.operation();
    await expect(h.stop(operation)).resolves.toMatchObject({ workspaceSynced: false });
    expect(h.steps).toEqual([]);
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.service.close(h.workspace, h.state);
  });

  it.each([false, true])("refuses an unfinished join before any stop work (remote %s)", async synced => {
    const h = await fixture(synced);
    const operation = { ...h.operation(), workspace: { ...h.operation().workspace, joinBootstrapPending: true as const } };
    await expect(h.stop(operation)).rejects.toThrow("This workspace is still joining. Wait for it to finish, then stop sync.");
    expect(h.steps).toEqual([]);
    expect(h.pauseRemote).not.toHaveBeenCalled();
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.service.close(h.workspace, h.state);
  });

  it("settles before saving a durable pause and reopens local capture", async () => {
    const h = await fixture();
    const result = await h.stop(h.operation());
    expect(result).toMatchObject({ workspaceId: "workspace", workspaceSynced: false,
      syncPause: { atMs: 42, author: { kind: "person", personId: "local-person", self: true } },
      status: { state: "synced", pendingChangeCount: 0 } });
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("engine-stop"));
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("pause"));
    expect(h.steps.indexOf("pause")).toBeLessThan(h.steps.indexOf("relay-close"));
    expect(h.service.isOpen(h.state)).toBe(true);
    const persisted = createRegistryStore(h.registryPath).find("workspace");
    expect(persisted).toMatchObject({ pausedRemote: remote, syncPause: { atMs: 42, author: { kind: "person", personId: "local-person" } } });
    expect(persisted?.syncPause?.author).not.toHaveProperty("displayName");
    expect(persisted?.syncPause?.author).not.toHaveProperty("self");
    expect(persisted?.remote).toBeUndefined();
    await h.service.close(h.workspace, h.state);
  });

  it.each([null, {
    shareId: "received", granterEmail: null, genericChatWritable: false,
    grantedSelector: { paths: ["note.md"], versionId: null, access: "edit" as const },
  }])("refuses a received share before touching sessions or sync (%j)", async shareView => {
    const h = await fixture();
    const operation = { ...h.operation(), workspace: { ...h.operation().workspace,
      shareView: shareView as import("./registryStore").RegistryEntry["shareView"] } };
    await expect(h.stop(operation)).rejects.toThrow("received share");
    expect(h.steps).toEqual([]);
    expect(h.pauseRemote).not.toHaveBeenCalled();
    expect(h.store.find("workspace")?.remote).toEqual(remote);
    await h.service.close(h.workspace, h.state);
  });

  it("records agent provenance once and leaves already-paused sessions alone", async () => {
    const h = await fixture();
    const author = { kind: "agent" as const, agentId: "claude-code", onBehalfOf: "local-person", depth: 2 };
    const first = await h.stop(h.operation(), author);
    h.steps.length = 0;
    const second = await h.stop(h.operation());
    expect(second.syncPause).toEqual(first.syncPause);
    expect(second.syncPause).toEqual({ atMs: 42, author });
    expect(h.pauseRemote).toHaveBeenCalledOnce();
    expect(h.steps).toEqual([]);
    await h.service.close(h.workspace, h.state);
  });

  it("waits for settlement and keeps the local capture alive on refusal", async () => {
    const h = await fixture();
    const entered = deferred(), held = deferred<() => void>();
    h.settle.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = h.stop(h.operation());
    await entered.promise;
    expect(h.pauseRemote).not.toHaveBeenCalled();
    expect(h.watcherStop).not.toHaveBeenCalled();
    held.reject(new Error("file locked"));
    await expect(pending).rejects.toThrow("file locked");
    expect(h.store.find("workspace")?.remote).toEqual(remote);
    expect(h.closeRelay).not.toHaveBeenCalled();
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.stop(h.operation());
    expect(h.store.find("workspace")?.pausedRemote).toEqual(remote);
    await h.service.close(h.workspace, h.state);
  });

  it("refuses an attachment change during settlement before recording the pause", async () => {
    const h = await fixture();
    const entered = deferred(), held = deferred<() => void>();
    h.settle.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = h.stop(h.operation());
    await entered.promise;
    h.retire();
    held.resolve(h.resumeAdmission);
    await expect(pending).rejects.toThrow();
    expect(h.pauseRemote).not.toHaveBeenCalled();
    expect(h.closeRelay).not.toHaveBeenCalled();
    await h.service.close(h.workspace, h.state);
  });

  it("restores sync when recording the pause fails", async () => {
    const h = await fixture();
    h.pauseRemote.mockImplementationOnce(() => { throw new Error("registry write failed"); });
    await expect(h.stop(h.operation())).rejects.toThrow("registry write failed");
    expect(h.store.find("workspace")?.remote).toEqual(remote);
    expect(h.engineStart).toHaveBeenCalledTimes(2);
    expect(h.resumeAdmission).toHaveBeenCalledOnce();
    expect(h.closeRelay).not.toHaveBeenCalled();
    await h.service.close(h.workspace, h.state);
  });

  it("reports a saved pause despite cleanup failure, without retiring sessions again", async () => {
    const h = await fixture();
    h.closeRelay.mockRejectedValueOnce(new Error("relay close failed"));
    await expect(h.stop(h.operation())).resolves.toMatchObject({ workspaceSynced: false });
    expect(h.cleanupFailed).toHaveBeenCalledWith("workspace", expect.objectContaining({ message: "relay close failed" }));
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.stop(h.operation());
    expect(h.closeRelay).toHaveBeenCalledOnce();
    await h.service.close(h.workspace, h.state);
  });

  it("reports success when the attachment retires after the pause is saved", async () => {
    const h = await fixture();
    h.closeRelay.mockImplementationOnce(async () => h.retire());
    await expect(h.stop(h.operation())).resolves.toMatchObject({ workspaceSynced: false, syncPause: { atMs: 42 } });
    await h.service.close(h.workspace, h.state);
  });

  it("ends a Collections wait by reopening without sync", async () => {
    const h = await fixture(true, true);
    expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBe("sync");
    await h.stop(h.operation());
    expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBeUndefined();
    await h.service.close(h.workspace, h.state);
  });

  it("keeps a Collections wait after a failed reopen, and Try again repeats the reopen", async () => {
    const h = await fixture(true, true);
    h.openActivity.mockRejectedValueOnce(new Error("open failed"));
    await expect(h.stop(h.operation())).resolves.toMatchObject({ workspaceSynced: false });
    expect(h.cleanupFailed).toHaveBeenCalledWith("workspace", expect.objectContaining({ message: "open failed" }));
    expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBe("reopen");
    // After a pause there is no sync to retry: the retry reopens.
    await expect(reopenWithoutSync(h.reopen, h.operation().workspace)).resolves.toEqual({ reopened: true });
    expect(h.service.isOpen(h.state)).toBe(true);
    expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBeUndefined();
    await h.service.close(h.workspace, h.state);
  });

  it("keeps the wait while the engine refuses the owner open, and a later Try again ends it", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = await fixture(true, true);
      h.daemon.openFails = true;
      // The activity still opens, but the open that abandons the pull did not.
      await expect(h.stop(h.operation())).resolves.toMatchObject({ workspaceSynced: false });
      expect(h.openActivity).toHaveBeenCalledOnce();
      expect(h.cleanupFailed).toHaveBeenCalledWith("workspace", expect.objectContaining({ message: "workspace-open-failed" }));
      expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBe("reopen");
      expect(h.daemon.pullUnfinished).toBe(true);
      // Try again repeats the reopen, and stays while the engine refuses it.
      const again = await reopenWithoutSync(h.reopen, h.operation().workspace);
      expect(again).toMatchObject({ reopened: false, failure: { error: expect.objectContaining({ message: "workspace-open-failed" }) } });
      expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBe("reopen");
      expect(h.daemon.pullUnfinished).toBe(true);
      h.daemon.openFails = false;
      await expect(reopenWithoutSync(h.reopen, h.operation().workspace)).resolves.toEqual({ reopened: true });
      expect(h.daemon.pullUnfinished).toBe(false);
      expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBeUndefined();
      await h.service.close(h.workspace, h.state);
    } finally {
      quiet.mockRestore();
    }
  });

  it("reports nothing waiting when a reopen fails with no Collections wait", async () => {
    const h = await fixture();
    h.openActivity.mockRejectedValueOnce(new Error("open failed"));
    await h.stop(h.operation());
    expect(h.service.getStatus(h.workspace, h.state).collectionsWaitingForSync).toBeUndefined();
    await h.service.open(h.workspace, h.state);
    await h.service.close(h.workspace, h.state);
  });

  it("keeps a paused workspace pinned to its owner on resume", async () => {
    const h = await fixture();
    await h.stop(h.operation());
    expect(() => assertSyncEnrollmentCredentials(h.store.find("workspace")!, { ...credentials, userId: "other" })).toThrow("account that synced");
    await h.service.close(h.workspace, h.state);
  });
});
