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
    expect(close).toContain(
      "closeActivity: () => activity.close(workspaceId, { preserveStatus: true })",
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
    expect(open).toContain("engineStoreMoveAlreadySerialized,");
    expect(open.indexOf("withEngineStoreRecovered(")).toBeLessThan(
      open.indexOf("activity.open(workspace)"),
    );
    expect(open).not.toContain("pending engine store move:");

    expect(rebuild).toContain("withKeyedStartLock(");
    expect(rebuild).toContain("engineStoreRebuildLocks,");
    expect(rebuild).toContain("rebuildEngineStoreRequest(workspace.rootPath,");
    expect(rebuild).toContain(
      "openWorkspaceActivity(workspace, undefined, true)",
    );
    expect(rebuild).toMatch(
      /hasActiveAgentRun: \(\) =>\s*activity\.hasAgentRun\(workspace\.workspaceId\)/,
    );

    const gateStart = rebuildSource.indexOf(
      "export async function withEngineStoreRecovered<T>(",
    );
    const gateEnd = rebuildSource.indexOf(
      "export async function moveEngineStoreAside(",
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
    const helper = sourceBetween(
      "async function withRebuildBoundGate<T>(",
      "async function syncWorkspaceForDispatch(",
    );
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

    expect(helper).toMatch(
      /beginRebuild\(workspaceId\);\s*try \{\s*return await body\(\);\s*\} finally \{\s*sessions\.endRebuild\(workspaceId\);/,
    );
    expect(dispatch).toMatch(
      /\},\s*\(rootPath\) =>\s*withRebuildBoundGate\(workspace\.workspaceId, \(\) =>\s*completePendingEngineStoreMove\(rootPath\),\s*\),\s*\);/,
    );
    expect(open).toMatch(
      /\},\s*\(rootPath\) =>\s*withRebuildBoundGate\(workspace\.workspaceId, \(\) =>\s*completePendingEngineStoreMove\(rootPath\),\s*\),\s*\);/,
    );
    expect(rebuild).toMatch(
      /moveStoreAside: \(rootPath\) => \{\s*requireEngineSessions\(\)\.beginRebuild\(workspace\.workspaceId\);\s*return moveEngineStoreAside\(rootPath\);\s*\},/,
    );
    // The move raises the gate without lowering it. Reopen's mandatory
    // recovery callback lowers it before activity.open binds the fresh store.
    // A handler-wide bracket would make the probe or reopen refuse itself.
    expect((rebuild.match(/beginRebuild\(/g) ?? []).length).toBe(1);
    expect(rebuild).not.toContain("endRebuild(");
    expect(rebuild).not.toContain("withRebuildBoundGate(");
  });
});
