import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const rebuildSource = readFileSync(
  new URL("./workspaces/engineStoreRebuild.ts", import.meta.url),
  "utf8",
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
      /closeActivity: \(\) =>\s*activity\.close\(workspaceId, \{\s*preserveStatus: true,\s*notify: options\.notifyRenderer,/,
    );
    expect(close).toContain(
      "closeRelay: () => closeRelayTransportWorkspace(relayWorkspaceId)",
    );
    expect(close).toContain("onRelayCloseError: (error) =>");
    expect(close).toContain("console.error(");
  });

  it("routes ordinary opens and dispatch scans through the same recovery gate as rebuilds", () => {
    const dispatch = sourceBetween(
      "async function syncWorkspaceForDispatch(",
      "async function ensureWorkspaceActivityOpen(",
    );
    const open = sourceBetween(
      "async function ensureWorkspaceActivityOpen(",
      "async function closeDispatchRunActivity(",
    );
    const rebuild = sourceBetween(
      "ipcMain.handle(CHANNELS.rebuildEngineStore,",
      "ipcMain.handle(CHANNELS.startAgentRun,",
    );

    expect(mainSource).toContain(
      "const engineStoreRebuildLocks = new Map<string, Promise<void>>();",
    );
    expect(dispatch).toContain("withEngineStoreRecovered(");
    expect(dispatch).toContain("return coalesceDispatchScopedSync(");
    expect(dispatch.indexOf("coalesceDispatchScopedSync(")).toBeLessThan(
      dispatch.indexOf("withEngineStoreRecovered("),
    );
    expect(dispatch).toContain("engineStoreRebuildLocks,");
    expect(dispatch).toMatch(
      /withEngineStoreRecovered\(\s*engineStoreRebuildLocks,\s*workspace,\s*false,/,
    );
    expect(dispatch).toContain("captureForFlaggedWorkspace(");
    expect(dispatch).toContain("await engine.start()");
    expect(dispatch.indexOf("withEngineStoreRecovered(")).toBeLessThan(
      dispatch.indexOf("activity.listOpenWorkspaceIds()"),
    );
    expect(dispatch.indexOf("withEngineStoreRecovered(")).toBeLessThan(
      dispatch.indexOf("captureForFlaggedWorkspace("),
    );
    expect(dispatch.indexOf("withEngineStoreRecovered(")).toBeLessThan(
      dispatch.indexOf("await engine.start()"),
    );

    expect(open).toContain("return withEngineStoreRecovered(");
    expect(open).toContain("engineStoreRebuildLocks,");
    expect(open).toContain(
      "options.engineStoreMoveAlreadySerialized ?? false,",
    );
    expect(open.indexOf("withEngineStoreRecovered(")).toBeLessThan(
      open.indexOf("activity.open(workspace)"),
    );
    expect(open).not.toContain("pending engine store move:");

    expect(rebuild).toContain("withKeyedStartLock(");
    expect(rebuild).toContain("engineStoreRebuildLocks,");
    expect(rebuild).toContain("rebuildEngineStoreRequest(workspace.rootPath,");
    expect(rebuild).toContain("engineStoreMoveAlreadySerialized: true");
    expect(rebuild).toContain("notifyRenderer: false");
    expect(rebuild).toMatch(
      /catch \(error\) \{\s*notifyRenderer\(\);\s*throw error;/,
    );
    expect(rebuild).toMatch(
      /hasActiveAgentRun: \(\) =>\s*activity\.hasAgentRun\(workspace\.workspaceId\)/,
    );

    const gateStart = rebuildSource.indexOf(
      "export async function withEngineStoreRecovered<T>(",
    );
    const gateEnd = rebuildSource.indexOf(
      "async function throwAfterReservationCleanup(",
      gateStart,
    );
    const gate = rebuildSource.slice(gateStart, gateEnd);
    expect(gate).toContain("await completePendingMove(workspace.rootPath)");
    expect(gate.indexOf("await completePendingMove")).toBeLessThan(
      gate.lastIndexOf("return body()"),
    );
    expect(gate).not.toContain("catch");
  });

  it("keeps the gate raised from the store move through reopen recovery", () => {
    const dispatch = sourceBetween(
      "async function syncWorkspaceForDispatch(",
      "async function ensureWorkspaceActivityOpen(",
    );
    const open = sourceBetween(
      "async function ensureWorkspaceActivityOpen(",
      "async function closeDispatchRunActivity(",
    );
    const rebuild = sourceBetween(
      "ipcMain.handle(CHANNELS.rebuildEngineStore,",
      "ipcMain.handle(CHANNELS.startAgentRun,",
    );
    const recoveryStart = rebuildSource.indexOf(
      "export async function completePendingEngineStoreMove(",
    );
    const recoveryEnd = rebuildSource.indexOf(
      "export async function withEngineStoreRecovered<T>(",
      recoveryStart,
    );
    const recovery = rebuildSource.slice(recoveryStart, recoveryEnd);

    expect(mainSource).not.toContain("withRebuildBoundGate");
    expect(dispatch).toContain("completePendingEngineStoreMove(rootPath, {");
    expect(dispatch).toContain("rebuildGate: {");
    expect(open).toContain("completePendingEngineStoreMove(rootPath, {");
    expect(open).toContain("rebuildGate: {");
    expect(recovery.indexOf("MOVE_IN_PROGRESS")).toBeLessThan(
      recovery.indexOf("deps.rebuildGate?.begin()"),
    );
    expect(recovery.indexOf("deps.rebuildGate?.begin()")).toBeLessThan(
      recovery.indexOf("await readMoveManifest(inProgressMarker)"),
    );
    expect(recovery.indexOf("await completeManifestMove(")).toBeLessThan(
      recovery.indexOf("deps.rebuildGate?.end()"),
    );
    expect(rebuild).toMatch(
      /moveStoreAside: \(rootPath\) => \{\s*requireEngineSessions\(\)\.beginRebuild\(workspace\.workspaceId\);\s*return moveEngineStoreAside\(rootPath\);\s*\},/,
    );
    // The move raises the gate without lowering it. Reopen's mandatory
    // recovery callback lowers it before activity.open binds the fresh store.
    // A handler-wide bracket would make the probe or reopen refuse itself.
    expect((rebuild.match(/beginRebuild\(/g) ?? []).length).toBe(1);
    expect(rebuild).not.toContain("endRebuild(");
  });

  it("claims every agent run while the workspace rebuild lock is still held", () => {
    const open = sourceBetween(
      "async function ensureWorkspaceActivityOpen(",
      "async function closeDispatchRunActivity(",
    );
    const helper = sourceBetween(
      "async function startAgentRunWithWorkspaceActivity(",
      "interface RunningPluginPanel",
    );
    const tryInVersion = sourceBetween(
      "const tryInVersionSessions = createTryInVersionSessions({",
      "async function workspaceAgentDefaults(",
    );
    const sessionManager = sourceBetween(
      "async function agentSessionManager(",
      "// Linked Chats",
    );
    const ipc = sourceBetween(
      "ipcMain.handle(CHANNELS.startAgentRun,",
      "ipcMain.handle(CHANNELS.endAgentRun,",
    );

    expect(open).toContain("whileEngineStoreLockHeld");
    expect(open).toContain("await options.whileEngineStoreLockHeld?.()");
    expect(open.indexOf("await opening")).toBeLessThan(
      open.indexOf("await options.whileEngineStoreLockHeld?.()"),
    );
    expect(open.indexOf("await existing")).toBeLessThan(
      open.indexOf("await options.whileEngineStoreLockHeld?.()"),
    );
    expect(helper).toContain("await openWorkspaceActivity(workspace, {");
    expect(helper).toContain("whileEngineStoreLockHeld: async () => {");
    expect(helper).toContain("await agentIntegration.startAgentRun(");
    expect(tryInVersion).toMatch(
      /startAgentRunWithWorkspaceActivity\(\s*requireWorkspace\(workspaceId\),\s*\)/,
    );
    expect(tryInVersion).not.toContain(
      "agentIntegration.startAgentRun(workspaceId)",
    );
    expect(sessionManager).toMatch(
      /startAgentRunWithWorkspaceActivity\(requireWorkspace\(workspaceId\)\)/,
    );
    expect(ipc).toContain("startAgentRunWithWorkspaceActivity(workspace)");
    expect(ipc).not.toContain("agentIntegration.startAgentRun(");
  });
});
