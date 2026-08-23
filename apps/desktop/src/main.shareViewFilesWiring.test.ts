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

function functionSource(signature: string): string {
  return sourceBlock(signature, "\n}\n");
}

function handlerSource(channel: string): string {
  return sourceBlock(`ipcMain.handle(CHANNELS.${channel}`, "\n  });");
}

describe("ShareViewFiles main-process wiring", () => {
  it("exports an exact mount root through its owner without an empty relative path", () => {
    const collect = functionSource("async function collectOwnedZipEntries(");

    expect(collect).toContain(
      '...(routed.path === "" ? {} : { relativePath: routed.path }),',
    );
    expect(collect).not.toContain("const mountRoot =");
  });

  it("falls back to registry and folder cleanup when registered unmount fails", () => {
    const handler = handlerSource("mountShare");
    const registeredAt = handler.indexOf("if (registered) {");
    const rollback = handler.slice(
      registeredAt,
      handler.indexOf("notifyRenderer();", registeredAt),
    );
    const unmountAt = rollback.indexOf(".unmount(lease,");
    const fallbackAt = rollback.indexOf("catch (unmountError)");
    const registryAt = rollback.indexOf("setWorkspaceShareMounts(", fallbackAt);
    const registryCatchAt = rollback.indexOf("catch (registryError)", registryAt);
    const folderAt = rollback.indexOf("removeMountFolder(", fallbackAt);

    expect(registeredAt).toBeGreaterThan(-1);
    expect(unmountAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(unmountAt);
    expect(registryAt).toBeGreaterThan(fallbackAt);
    expect(registryCatchAt).toBeGreaterThan(registryAt);
    expect(folderAt).toBeGreaterThan(registryCatchAt);
  });

  it("repairs available projections before disk-only reads even when status says current", () => {
    const one = functionSource("async function ensureOwnedProjectionCurrent(");
    const all = functionSource("async function ensureAllOwnedProjectionsCurrent(");

    expect(one).toContain('if (status.state === "unavailable") {');
    expect(one).not.toContain('status.state === "current"');
    expect(one).toContain(
      'shareViewFiles.reconcile(lease, routed.target, "repair")',
    );

    expect(all).not.toContain('status.state === "pending"');
    expect(all).toContain('status.state === "unavailable"');
    expect(all).toContain(
      "const repaired = await shareViewFiles.reconcile(",
    );
    expect(all).toContain("assertOwnedProjectionRepair(repaired);");
  });

  it("limits received-share ripgrep passes to canonical share files", () => {
    const allowance = functionSource("async function shareSearchAllowPath(");
    const handler = handlerSource("searchWorkspace");
    const repairedAt = handler.indexOf(
      "await ensureAllOwnedProjectionsCurrent(workspace);",
    );
    const standaloneAllowanceAt = handler.indexOf(
      "await shareSearchAllowPath([",
      repairedAt,
    );
    const mountStartAt = handler.indexOf("await searchRegistry.startSearch(");
    const fallbackStartAt = handler.indexOf(
      "await searchRegistry.startSearch(",
      mountStartAt + 1,
    );
    const mountPredicateAt = handler.indexOf(
      "allowPath: mountAllowPath,",
      mountStartAt,
    );
    const ownedPredicateAt = handler.indexOf(
      "allowPath: ownedAllowPath,",
      fallbackStartAt,
    );

    expect(allowance).toContain("await shareViewFiles.list(target)");
    expect(allowance).toContain("allowedPaths.add(searchPathKey(path))");
    expect(repairedAt).toBeGreaterThan(-1);
    expect(standaloneAllowanceAt).toBeGreaterThan(repairedAt);
    expect(handler).toContain(
      "prefix: `${SHARED_WITH_ME_FOLDER}/${mount.label}`",
    );
    expect(handler).toContain("allowCanonicalMountSearchPaths(");
    expect(mountStartAt).toBeGreaterThan(standaloneAllowanceAt);
    expect(fallbackStartAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeGreaterThan(mountStartAt);
    expect(mountPredicateAt).toBeLessThan(fallbackStartAt);
    expect(ownedPredicateAt).toBeGreaterThan(fallbackStartAt);
  });

  it("routes plugin SDK reads through the shared-file owner", () => {
    const reads = functionSource("function ownedWorkspaceSdkReads(");
    const invoke = functionSource("async function invokeWorkspacePluginSdk(");

    expect(reads).toContain("readOwnedWorkspaceText(workspace, path)");
    expect(reads).toContain("listOwnedWorkspaceFiles(workspace)");
    expect(reads).toContain("ensureAllOwnedProjectionsCurrent(workspace)");
    expect(reads).toContain("ensureOwnedProjectionCurrent(workspace, path)");
    expect(reads).toContain("readDatabaseSnapshot(workspace.rootPath, path)");
    expect(invoke).toContain("reads: ownedWorkspaceSdkReads(workspace)");
    expect(invoke).not.toContain("ensureAllOwnedProjectionsCurrent");
  });
});
