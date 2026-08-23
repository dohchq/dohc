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
});
