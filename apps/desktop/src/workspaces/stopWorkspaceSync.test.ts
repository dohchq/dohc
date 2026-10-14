import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  let account: CloudCredentials | null = credentials;
  const closeRelay = vi.fn(async () => { steps.push("relay-close"); });
  const pauseRemote = vi.fn((id: string) => { steps.push("pause"); store.pauseRemote(id); });
  const stop = createWorkspaceSyncStop({
    credentials: async () => account, currentCredentials: () => account,
    withOwnerHostPaused: async work => { steps.push("host-pause"); try { return await work(); } finally { steps.push("host-resume"); } },
    prepare: () => service.prepareSyncPause(workspace, state), resume: () => service.enableCloud(workspace, state), pauseRemote,
    closeActivity: () => service.close(workspace, state, { notify: false }), closeRelay,
    openActivity: () => service.open(workspace, state), status: () => service.getStatus(workspace, state),
    notify: () => { steps.push("notify"); },
  });
  const operation = () => ({
    workspace: { ...store.find(workspace.workspaceId)!, attachmentId: workspace.attachmentId },
    assertCurrent() { if (!current) throw new Error("workspace changed"); },
  });
  return { workspace, store, registryPath, steps, settle, engineStart, engineStop, watcherStop, closeRelay,
    pauseRemote, resumeAdmission, service, state, stop, operation, retire: () => { current = false; },
    account: (value: CloudCredentials | null) => { account = value; } };
}

describe("stop one workspace's sync", () => {
  it("leaves a never-synced workspace open without requiring an account", async () => {
    const h = await fixture(false);
    const operation = h.operation();
    h.account(null);
    await expect(h.stop(operation)).resolves.toMatchObject({ workspaceSynced: false, reversible: true });
    expect(h.steps).toEqual([]);
    expect(h.service.isOpen(h.state)).toBe(true);
    await h.service.close(h.workspace, h.state);
  });

  it("keeps files, documents, records, history, and protected-file keys; resumes the same binding after restart", async () => {
    const h = await fixture();
    await mkdir(join(h.workspace.rootPath, ".dohc", "engine"), { recursive: true });
    const files = new Map([
      ["note.md", "# Keep local work\n"], ["records.json", '{"records":[{"id":"r1","value":42}]}'],
      [".dohc/engine/engine.db", "durable history and records"], [".dohc/engine/secret.key", "protected key"],
    ]);
    for (const [path, text] of files) await writeFile(join(h.workspace.rootPath, path), text);
    const result = await h.stop(h.operation());
    expect(result).toMatchObject({ workspaceId: "workspace", workspaceSynced: false, reversible: true, irreversibleEffects: [], status: { state: "synced", pendingChangeCount: 0 } });
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("engine-stop"));
    expect(h.steps.indexOf("settle")).toBeLessThan(h.steps.indexOf("pause"));
    expect(h.steps.indexOf("pause")).toBeLessThan(h.steps.indexOf("relay-close"));
    expect(h.service.isOpen(h.state)).toBe(true);
    for (const [path, text] of files) expect(await readFile(join(h.workspace.rootPath, path), "utf8")).toBe(text);
    await writeFile(join(h.workspace.rootPath, "note.md"), "# Edited offline\n");
    const restarted = createRegistryStore(h.registryPath);
    expect(restarted.find("workspace")).toMatchObject({ pausedRemote: remote });
    expect(restarted.find("workspace")?.remote).toBeUndefined();
    assertSyncEnrollmentCredentials(restarted.find("workspace")!, credentials);
    h.store.setRemote("workspace", remote);
    await h.service.enableCloud(h.workspace, h.state);
    expect(h.store.find("workspace")?.pausedRemote).toBeUndefined();
    expect(h.engineStart).toHaveBeenCalledTimes(2);
    expect(await readFile(join(h.workspace.rootPath, "note.md"), "utf8")).toBe("# Edited offline\n");
    await h.service.close(h.workspace, h.state);
  });

  it.each(["other-owner", "other-server", "signed-out", "received-share"])("refuses %s before touching sessions or sync", async kind => {
    const h = await fixture();
    const operation = h.operation();
    if (kind === "other-owner") h.account({ ...credentials, userId: "someone-else" });
    if (kind === "other-server") h.account({ ...credentials, serverUrl: "https://other.test" });
    if (kind === "signed-out") h.account(null);
    if (kind === "received-share") operation.workspace.shareView = { shareId: "received", granterEmail: null,
      genericChatWritable: false, grantedSelector: { paths: ["note.md"], versionId: null, access: "edit" } };
    await expect(h.stop(operation)).rejects.toThrow();
    expect(h.steps).toEqual([]);
    expect(h.pauseRemote).not.toHaveBeenCalled();
    expect(h.store.find("workspace")?.remote).toEqual(remote);
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

  it.each(["workspace", "account"])("refuses a %s change during settlement before recording the pause", async kind => {
    const h = await fixture();
    const entered = deferred(), held = deferred<() => void>();
    h.settle.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = h.stop(h.operation());
    await entered.promise;
    if (kind === "workspace") h.retire(); else h.account({ ...credentials, userId: "other" });
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

  it("preserves the relay close failure and supports retry with local work open", async () => {
    const h = await fixture();
    h.closeRelay.mockRejectedValueOnce(new Error("relay close failed"));
    // The real activity reopen remains available; the saved pause supports retry.
    await expect(h.stop(h.operation())).rejects.toThrow("relay close failed");
    expect(h.service.isOpen(h.state)).toBe(true);
    expect(h.store.find("workspace")?.pausedRemote).toEqual(remote);
    await h.stop(h.operation());
    await h.service.close(h.workspace, h.state);
  });

  it("keeps a paused workspace pinned to its owner on resume", async () => {
    const h = await fixture();
    await h.stop(h.operation());
    expect(() => assertSyncEnrollmentCredentials(h.store.find("workspace")!, { ...credentials, userId: "other" })).toThrow("account that synced");
    await h.service.close(h.workspace, h.state);
  });
});
