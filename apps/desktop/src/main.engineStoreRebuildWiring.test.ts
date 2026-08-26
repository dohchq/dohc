import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing main.ts region ${startMarker} .. ${endMarker}`);
  }
  return mainSource.slice(start, end);
}

describe("main-process engine store rebuild wiring", () => {
  it("keeps physical relay teardown on one attachment coordinate", () => {
    const target = sourceBetween(
      "function workspaceSessionTargetForPhysicalWorkspace(",
      "function relayCloseTargetsForPhysicalWorkspace(",
    );
    const targets = sourceBetween(
      "function relayCloseTargetsForPhysicalWorkspace(",
      "const workspaceAuthorities = createWorkspaceAuthorityOwner({",
    );
    const owner = sourceBetween(
      "const workspaceAuthorities = createWorkspaceAuthorityOwner({",
      "function requireWorkspaceAuthority(",
    );
    const transportClose = sourceBetween(
      "async function closeRelayTransportWorkspace(",
      "async function closeAllRelayTransportWorkspaces(",
    );

    expect(target).toContain(
      "if (targetWorkspaceId !== workspace.workspaceId) return targetWorkspaceId;",
    );
    expect(target).toContain("workspaceId: workspace.workspaceId");
    expect(target).toContain("rootPath: workspace.rootPath");
    expect(target).toContain("attachmentId: workspace.attachmentId");
    expect(targets).toContain(
      "workspaceSessionTargetForPhysicalWorkspace(\n" +
        "      workspace.workspaceId,\n" +
        "      workspace,\n" +
        "    )",
    );
    expect(targets).toContain(
      "const mountStoreWorkspaceIds = new Set(\n" +
        "    storedShareMounts(workspace).map((mount) =>\n" +
        "      mountStoreWorkspaceIdFor(workspace.workspaceId, mount.shareId),",
    );
    expect(targets).toContain("...mountStoreWorkspaceIds");
    expect(targets).not.toContain("workspace.remote");
    expect(owner).toContain("attachmentId: binding.attachmentId");
    expect(owner).toContain(
      "relayCloseTargetsForPhysicalWorkspace(physicalWorkspace)",
    );
    expect(owner).toContain(
      "...relayCloseTargets.map((target) => closeRelayTransportWorkspace(target))",
    );
    expect(transportClose).toContain("workspace: string | EngineWorkspace");
    expect(transportClose).toContain(
      "await rustEngineRelayClient.closeWorkspace(workspace)",
    );
    expect(transportClose).toContain(
      "await rustEngineWorkspaceSessions?.closeWorkspace(workspace)",
    );
  });

  it("binds registered relay work to the workspace attachment", () => {
    const engine = sourceBetween(
      "function engineForWorkspace(",
      "const workspaceActivity = createWorkspaceActivity(",
    );
    const sharedChannel = sourceBetween(
      "function reserveAndPullSharedChannelForWorkspace(",
      "ipcMain.handle(CHANNELS.listChatChannelShares",
    );

    for (const source of [engine, sharedChannel]) {
      expect(source).toMatch(
        /relayClientForWorkspace\(\{[\s\S]*?workspaceId: workspace\.workspaceId,[\s\S]*?rootPath: workspace\.rootPath,[\s\S]*?attachmentId: workspace\.attachmentId,/,
      );
    }
    expect(engine).toContain(
      "Cloud sync requires a registered workspace attachment.",
    );
    expect(sharedChannel).toContain(
      'throw new Error("Shared channel pull targeted a different workspace.");',
    );
  });

  it("retires a standalone physical share by attachment and a mount child by id", () => {
    const shareFiles = sourceBetween(
      "function createShareViewFilesForOperation(",
      "function withShareViewFilesOperation<Result>(",
    );
    expect(shareFiles).toMatch(
      /workspaceSessionTargetForPhysicalWorkspace\(\s*target\.storeWorkspaceId,\s*operation\.workspace,\s*\)/,
    );
    expect(shareFiles).toContain(
      "closeRelayTransportWorkspace(retireTarget)",
    );
  });

  it("does not seed received-share session state under logical startup keys", () => {
    const startup = sourceBetween(
      "async function startRustEngineDaemon(",
      "// Single-instance lock gates the entire bootstrap",
    );
    expect(startup).not.toContain(
      "receivedShareEngine.workspaceForRegistered(workspace)",
    );
  });

  it("treats relay teardown as non-fatal after local activity closes", () => {
    const close = sourceBetween(
      "async function closeDispatchRunActivity(",
      "async function acquireDispatchRunActivity(",
    );

    expect(close).toContain("closeWorkspaceActivityAndRelay({");
    expect(close).toMatch(
      /closeActivity: async \(\) => \{\s*await activity\.close\(current\.workspaceId, \{\s*expectedRootPath: current\.rootPath,\s*preserveStatus: true,\s*notify: options\.notifyRenderer,/,
    );
    expect(close).toMatch(
      /workspaceSessionTargetForPhysicalWorkspace\(\s*current\.workspaceId,\s*current,?\s*\)/,
    );
    expect(close).toContain(
      "closeRelay: () => closeRelayTransportWorkspace(relayCloseTarget)",
    );
    expect(close).toContain("onRelayCloseError: (error) =>");
    expect(close).toContain("console.error(");
  });

  it("calls the lock-owning recovery boundary for each open path", () => {
    const recovery = sourceBetween(
      "function completePendingEngineStoreMoveForWorkspace(",
      "async function syncWorkspaceForDispatch(",
    );
    const dispatch = sourceBetween(
      "async function syncWorkspaceForDispatch(",
      "interface WorkspaceActivityOpenOptions",
    );
    const ordinaryOpen = sourceBetween(
      "async function ensureWorkspaceActivityOpen(",
      "async function ensureWorkspaceActivityOpenUnderEngineStoreLock(",
    );
    const lockedOpen = sourceBetween(
      "async function ensureWorkspaceActivityOpenUnderEngineStoreLock(",
      "async function closeDispatchRunActivity(",
    );
    const rebuild = sourceBetween(
      "ipcMain.handle(CHANNELS.rebuildEngineStore,",
      "ipcMain.handle(CHANNELS.startAgentRun,",
    );

    expect(recovery).toContain("completePendingEngineStoreMove(rootPath");
    expect(recovery).toContain("sessions.beginRebuild(workspace)");
    expect(recovery).toContain("sessions.endRebuild(workspace)");
    expect(dispatch).toContain("withEngineStoreRecoveredForAuthority(lease,");
    expect(dispatch).toMatch(
      /captureForFlaggedWorkspace\(\s*\{\s*\.\.\.workspace,[\s\S]*?shareView: false,/,
    );
    expect(dispatch).toMatch(
      /const relayCloseTarget = workspace\.remote[\s\S]*?workspaceSessionTargetForPhysicalWorkspace\(\s*workspace\.workspaceId,\s*workspace,\s*\)/,
    );
    expect(dispatch).toContain(
      "await closeRelayTransportWorkspace(relayCloseTarget).catch(",
    );
    expect(ordinaryOpen).toContain("withEngineStoreRecoveredForAuthority(lease,");
    expect(lockedOpen).toContain(
      "withEngineStoreRecoveredUnderEngineStoreLock(",
    );
    // Round 19: the reopen's recovery step must settle (resume-and-complete,
    // or an honest no-op) and release the request gate BEFORE the
    // activity-open body starts the daemon-owned capture — not after the
    // whole reopen resolves. The hook sits inside the completePendingMove
    // callback, after the recovery call and before the callback returns.
    expect(lockedOpen).toContain("options.afterReopenRecoverySettled?.()");
    expect(
      lockedOpen.indexOf("completePendingEngineStoreMoveForWorkspace("),
    ).toBeLessThan(lockedOpen.indexOf("options.afterReopenRecoverySettled?.()"));
    expect(rebuild).toContain("inWorkspaceEngineStoreLane(lease,");
    expect(rebuild).toContain("openWorkspaceActivityUnderEngineStoreLock(");
    expect(rebuild).toContain("begin: () => sessions.beginRebuild(");
    expect(rebuild).toContain("end: () => sessions.endRebuild(");
    expect(rebuild).toMatch(
      /afterReopenRecoverySettled: \(\) =>\s*sessions\.endRebuild\(workspace\),/,
    );
    expect(rebuild).toContain("moveStoreAside: moveEngineStoreAside");
    expect(rebuild).not.toContain("requireEngineSessions().beginRebuild(");
  });

  it("claims agent runs through the lock-owning open boundary", () => {
    const openBody = sourceBetween(
      "async function ensureWorkspaceActivityOpenBody(",
      "async function ensureWorkspaceActivityOpen(",
    );
    const helper = sourceBetween(
      "async function startAgentRunWithWorkspaceActivity(",
      "function createPluginSurfaceHostLease(",
    );
    const tryInVersion = sourceBetween(
      "function createTryInVersionSessionsFor(",
      "const tryInVersionSessions = {",
    );
    const sessionManager = sourceBetween(
      "async function agentSessionManager(",
      "function linkedChatStoreFor(",
    );
    const ipc = sourceBetween(
      "ipcMain.handle(CHANNELS.startAgentRun,",
      "ipcMain.handle(CHANNELS.endAgentRun,",
    );

    expect(openBody).toContain("await options.whileEngineStoreLockHeld?.()");
    expect(helper).toContain("openWorkspaceActivity(workspace");
    expect(helper).toContain("whileEngineStoreLockHeld:");
    expect(helper).toContain("agentIntegration.startAgentRun(");
    expect(tryInVersion).toContain("startAgentRunWithWorkspaceActivity(");
    expect(sessionManager).toContain("startAgentRunWithWorkspaceActivity(");
    expect(ipc).toContain("startAgentRunWithWorkspaceActivity(workspace)");
  });
});
