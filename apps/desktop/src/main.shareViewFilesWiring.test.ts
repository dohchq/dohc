import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBlock(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function handlerSource(channel: string): string {
  return sourceBlock(`ipcMain.handle(CHANNELS.${channel}`, "\n  });");
}

describe("ShareViewFiles main-process wiring", () => {
  it("composes the share mount commands with process-owned adapters", () => {
    const composition = sourceBlock(
      "const shareMountCommands = createShareMountCommands({",
      "\n\nshareViewFiles = createShareViewFiles({",
    );
    expect(composition).toContain("storedShareMounts(findWorkspace(workspaceId)");
    expect(composition).toContain("setWorkspaceShareMounts(workspaceId, mounts)");
    expect(composition).toContain("loadAndCacheCurrentCredentials()");
    expect(composition).toContain("fetchShareViewInfo({ relay, shareId })");
    expect(composition).toContain("withExclusiveWorkspaceOperation(");
    expect(composition).toContain("closeRelayTransportWorkspace(workspaceId)");
    expect(composition).toContain("shareViewFilesMountProjection");

    const filesComposition = sourceBlock(
      "shareViewFiles = createShareViewFiles({",
      "\n});\nconst ensureOwnedProjectionTargetCurrent",
    );
    expect(filesComposition).toContain(
      "createMount: shareMountCommands.filesLifecycle.createMount",
    );
    expect(filesComposition).toContain(
      "removeMount: shareMountCommands.filesLifecycle.removeMount",
    );
  });

  it("limits received-share ripgrep passes to canonical share files", () => {
    const handler = handlerSource("searchWorkspace");
    const preparedAt = handler.indexOf(
      ").prepareSearch();",
    );
    const mountStartAt = handler.indexOf("await searchRegistry.startSearch(");
    const fallbackStartAt = handler.indexOf(
      "await searchRegistry.startSearch(",
      mountStartAt + 1,
    );
    const mountPredicateAt = handler.indexOf(
      "allowPath: ownedSearchView.allowPath,",
      mountStartAt,
    );
    const ownedPredicateAt = handler.indexOf(
      "allowPath: ownedSearchView.allowPath,",
      fallbackStartAt,
    );

    expect(preparedAt).toBeGreaterThan(-1);
    expect(mountStartAt).toBeGreaterThan(preparedAt);
    expect(fallbackStartAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeLessThan(fallbackStartAt);
    expect(ownedPredicateAt).toBeGreaterThan(fallbackStartAt);
  });
});
