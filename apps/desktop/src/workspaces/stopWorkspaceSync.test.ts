import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import { createRegistryStore } from "./registryStore";
import { createWorkspaceSyncStop } from "./stopWorkspaceSync";
import { createWorkspaceActivity, WorkspaceActivityState, type ActivityWorkspace } from "./workspaceActivity";
import { idleObservation } from "./workspaceActivity.testSupport";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { assertSyncEnrollmentCredentials } from "./chatRelayIdentity";

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
  const service = createWorkspaceActivity(vi.fn(), {
    observationFor: () => ({ ...idleObservation(workspace, {} as never), stop: watcherStop }),
    cloudStateFor: () => ({ enabled: !!store.find(workspace.workspaceId)?.remote, connected: !!store.find(workspace.workspaceId)?.remote }),
    engineFor: () => store.find(workspace.workspaceId)?.remote ? ({
      start: engineStart, stop: engineStop, queueSync: vi.fn(), snapshot: () => ({}),
    } as never) : null,
    captureFor: () => ({ shareView: false, capture: {
      start: () => {}, stop: async () => { steps.push("capture-stop"); },
      settleAndCloseLiveSessionsForSyncPause: settle,
      settleAndCloseAllLiveSessions: settle,
    } as never }),
  });
  const state = new WorkspaceActivityState();
  await service.open(workspace, state);
  steps.length = 0;
  let current = true;
  const closeRelay = vi.fn(async () => { steps.push("relay-close"); });
  const pauseRemote = vi.fn((id: string, pause: import("@dohc/workspace-contracts/workspace-sync").WorkspaceSyncPause) => { steps.push("pause"); store.pauseRemote(id, pause); });
  const cleanupFailed = vi.fn();
  const person = vi.fn(async () => ({ kind: "human" as const, humanId: "local-person", displayName: "Sam" }));
  const stop = createWorkspaceSyncStop({
    person, cleanupFailed, nowMs: () => 42,
    withOwnerHostPaused: async work => { steps.push("host-pause"); try { return await work(); } finally { steps.push("host-resume"); } },
    prepare: () => service.prepareSyncPause(workspace, state), resume: () => service.enableCloud(workspace, state), pauseRemote,
    closeActivity: () => service.close(workspace, state, { notify: false }), closeRelay,
    openActivity: () => service.open(workspace, state), status: () => service.getStatus(workspace, state),
    notify: () => { steps.push("notify"); },
  });
  const operation = () => ({
    get workspace() { return { ...store.find(workspace.workspaceId)!, attachmentId: workspace.attachmentId }; },
    assertCurrent() { if (!current) throw new Error("workspace changed"); },
  });
  return { workspace, store, registryPath, steps, settle, engineStart, engineStop, watcherStop, closeRelay,
    pauseRemote, resumeAdmission, service, state, stop, operation, cleanupFailed, person, retire: () => { current = false; } };
}

describe("stop one workspace's sync", () => {
  it("leaves a never-synced workspace open without requiring an account", async () => {
    const h = await fixture(false);
    const operation = h.operation();
    await expect(h.stop(operation)).resolves.toMatchObject({ workspaceSynced: false });
    expect(h.steps).toEqual([]);
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.service.close(h.workspace, h.state);
  });

  it("settles before saving a durable pause and reopens local capture", async () => {
    const h = await fixture();
    const result = await h.stop(h.operation());
    expect(result).toMatchObject({ workspaceId: "workspace", workspaceSynced: false,
      syncPause: { atMs: 42, author: { kind: "human", humanId: "local-person", displayName: "Sam" } },
      status: { state: "synced", pendingChangeCount: 0 } });
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("engine-stop"));
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("pause"));
    expect(h.steps.indexOf("pause")).toBeLessThan(h.steps.indexOf("relay-close"));
    expect(h.service.isOpen(h.state)).toBe(true);
    const persisted = createRegistryStore(h.registryPath).find("workspace");
    expect(persisted).toMatchObject({ pausedRemote: remote, syncPause: result.syncPause });
    expect(persisted?.remote).toBeUndefined();
    await h.service.close(h.workspace, h.state);
  });

  it("refuses a received share before touching sessions or sync", async () => {
    const h = await fixture();
    const operation = { ...h.operation(), workspace: { ...h.operation().workspace,
      shareView: { shareId: "received", granterEmail: null, genericChatWritable: false,
        grantedSelector: { paths: ["note.md"], versionId: null, access: "edit" as const } } } };
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
