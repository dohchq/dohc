import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import { createRegistryStore } from "./registryStore";
import { workspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";
import { createWorkspaceSyncStop } from "./stopWorkspaceSync";
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

async function fixture(synced = true) {
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
  const service = createWorkspaceActivity(vi.fn(), {
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
  steps.length = 0;
  let current = true;
  const closeRelay = vi.fn(async () => { steps.push("relay-close"); });
  const pauseRemote = vi.fn((id: string, pause: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPause) => { steps.push("pause"); store.pauseRemote(id, pause); });
  const cleanupFailed = vi.fn();
  const person = vi.fn(async () => ({ kind: "person" as const, personId: "local-person" }));
  const stop = createWorkspaceSyncStop({
    person, cleanupFailed, nowMs: () => 42,
    pauseStatus: pause => workspaceSyncPauseStatus(pause, "local-person"),
    withOwnerHostPaused: async work => { steps.push("host-pause"); try { return await work(); } finally { steps.push("host-resume"); } },
    prepare: () => service.prepareSyncPause(workspace, state), resume: () => service.enableCloud(workspace, state), pauseRemote,
    closeActivity: () => service.close(workspace, state, { notify: false, preserveAgentRun: true }), closeRelay,
    openActivity: () => service.open(workspace, state), status: () => service.getStatus(workspace, state),
    notify: () => { steps.push("notify"); },
  });
  const operation = () => ({
    get workspace() { return { ...store.find(workspace.workspaceId)!, attachmentId: workspace.attachmentId }; },
    assertCurrent() { if (!current) throw new Error("workspace changed"); },
  });
  return { workspace, store, registryPath, steps, settle, engineStart, engineStop, watcherStop, closeRelay,
    pauseRemote, resumeAdmission, service, state, stop, operation, cleanupFailed, person, runStates, captureRuns, capturedWrites,
    write: () => observation.facts([{ path: "note.md", kind: "changed" }]), retire: () => { current = false; } };
}

describe("stop one workspace's sync", () => {
  it("keeps a dispatched run active and claiming writes across the capture restart", async () => {
    const h = await fixture();
    const run = { agentId: "dohc-mcp", onBehalfOf: "local-person", agentRunId: "run", depth: 2, dispatch: "run" as const };
    await h.service.claimAgentRun(h.workspace, h.state, run);
    try {
      await h.stop(h.operation());
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(true);
      expect(h.runStates.map(event => event.active)).toEqual([true]);
      expect(h.service.dispatchedAgentRun(h.state)).toBe(true);
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
      expect(h.service.dispatchedAgentRun(h.state)).toBe(false);
      expect(h.service.agentRun(h.state)).toBeNull();
    } finally {
      await h.service.close(h.workspace, h.state);
    }
  });

  it("does not revive a run that ends while sync is stopping", async () => {
    const h = await fixture();
    const run = { agentId: "dohc-mcp", onBehalfOf: "local-person", agentRunId: "run", depth: 2, dispatch: "run" as const };
    await h.service.claimAgentRun(h.workspace, h.state, run);
    h.closeRelay.mockImplementationOnce(async () => {
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(true);
      expect(h.service.dispatchedAgentRun(h.state)).toBe(true);
      await h.service.clearAgentRun(h.state, run.agentRunId, h.workspace.rootPath);
    });
    try {
      await h.stop(h.operation());
      expect(h.cleanupFailed).not.toHaveBeenCalled();
      expect(h.service.agentRunState(h.workspace, h.state).active).toBe(false);
      expect(h.service.dispatchedAgentRun(h.state)).toBe(false);
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

  it("keeps a paused workspace pinned to its owner on resume", async () => {
    const h = await fixture();
    await h.stop(h.operation());
    expect(() => assertSyncEnrollmentCredentials(h.store.find("workspace")!, { ...credentials, userId: "other" })).toThrow("account that synced");
    await h.service.close(h.workspace, h.state);
  });
});
