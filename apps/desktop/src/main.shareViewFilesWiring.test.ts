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

  it("holds the mount lock across preflight but leases the workspace only for local mount work", () => {
    const mount = handlerSource("mountShare");
    const mountLockAt = mount.indexOf("return withShareMountLock(");
    const infoAt = mount.indexOf("await fetchShareViewInfo(");
    const exclusiveAt = mount.indexOf("return withExclusiveWorkspaceOperation(");
    const createAt = mount.indexOf("await createMountDirectory(");
    const reconcileAt = mount.indexOf("await shareViewFiles.reconcile(");

    expect(mountLockAt).toBeGreaterThan(-1);
    expect(infoAt).toBeGreaterThan(mountLockAt);
    expect(exclusiveAt).toBeGreaterThan(infoAt);
    expect(createAt).toBeGreaterThan(exclusiveAt);
    expect(reconcileAt).toBeGreaterThan(createAt);

    const refresh = handlerSource("refreshShareMounts");
    const refreshLockAt = refresh.indexOf("return withShareMountLock(");
    const loopAt = refresh.indexOf("for (const mount of mounts)");
    const perMountLeaseAt = refresh.indexOf(
      "await withExclusiveWorkspaceOperation(",
      loopAt,
    );
    const refreshReconcileAt = refresh.indexOf(
      "shareViewFiles.reconcile(",
      perMountLeaseAt,
    );

    expect(refreshLockAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(refreshLockAt);
    expect(perMountLeaseAt).toBeGreaterThan(loopAt);
    expect(refreshReconcileAt).toBeGreaterThan(perMountLeaseAt);
    expect(refresh.slice(refreshLockAt, loopAt)).not.toContain(
      "withExclusiveWorkspaceOperation(",
    );

    const unmount = handlerSource("unmountShare");
    expect(unmount.indexOf("return withShareMountLock(")).toBeLessThan(
      unmount.indexOf("withExclusiveWorkspaceOperation("),
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

  it("routes plugin SDK reads through the shared-file owner", () => {
    const reads = functionSource("function ownedWorkspaceReads(");
    const invoke = functionSource("async function invokeWorkspacePluginSdk(");

    expect(reads).toContain("readOwnedWorkspaceText(workspace, path)");
    expect(reads).toContain("listOwnedWorkspaceFiles(workspace)");
    expect(reads).toContain("createOwnedWorkspaceSdkReadPort({");
    expect(reads).toContain("shareViewFiles.read(target, { kind: \"asset\", path })");
    expect(invoke).toContain("reads: ownedWorkspaceReads(workspace)");

    const database = handlerSource("readWorkspaceDatabase");
    expect(database).toContain(
      "ownedWorkspaceReads(workspace).readDatabase(input.relativePath)",
    );
    expect(database).not.toContain("readDatabaseSnapshot(");
  });
});
