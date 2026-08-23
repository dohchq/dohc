import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing main.ts region ${startMarker} .. ${endMarker}`);
  }
  return mainSource.slice(start, end);
}

describe("main-process engine store rebuild wiring", () => {
  it("serializes rebuild requests and passive move completion with one workspace lock", () => {
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
    expect(open).toContain("withKeyedStartLock(");
    expect(open).toContain("engineStoreRebuildLocks,");
    expect(open).toContain("completePendingEngineStoreMove(workspace.rootPath)");
    expect(open.indexOf("completePendingEngineStoreMove")).toBeLessThan(
      open.indexOf("for (;;)"),
    );
    expect(open.indexOf("completePendingEngineStoreMove")).toBeLessThan(
      open.indexOf("activity.open(workspace)"),
    );

    expect(rebuild).toContain("withKeyedStartLock(");
    expect(rebuild).toContain("engineStoreRebuildLocks,");
    expect(rebuild).toContain("rebuildEngineStoreRequest(workspace.rootPath,");
    expect(rebuild).toContain(
      "openWorkspaceActivity(workspace, undefined, true)",
    );
  });
});
