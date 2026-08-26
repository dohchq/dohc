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
  it("treats relay teardown as non-fatal after local activity closes", () => {
    const close = sourceBetween(
      "async function closeDispatchRunActivity(",
      "async function acquireDispatchRunActivity(",
    );

    expect(close).toContain("closeWorkspaceActivityAndRelay({");
    expect(close).toMatch(
      /closeActivity: async \(\) => \{\s*await activity\.close\(current\.workspaceId, \{\s*expectedRootPath: current\.rootPath,\s*preserveStatus: true,\s*notify: options\.notifyRenderer,/,
    );
    expect(close).toContain(
      "closeRelay: () => closeRelayTransportWorkspace(relayWorkspaceId)",
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
