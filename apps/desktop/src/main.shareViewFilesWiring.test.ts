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
  it("routes mount creation and rollback through ShareViewFiles", () => {
    const handler = handlerSource("mountShare");
    expect(handler).toContain("await shareViewFiles.mount(");
    expect(handler).toContain("error instanceof ShareViewMountRollbackError");
    expect(handler).toContain("cleanup did not finish");
    expect(handler).toContain("remove any leftover folder from shared-with-me");
    expect(handler).not.toContain("createMountDirectory(");
    expect(handler).not.toContain("removeMountFolder(");
    expect(handler).not.toContain("removeShareMountProjection(");

    expect(handlerSource("openShare")).not.toContain(
      "ShareViewMountRollbackError",
    );
  });

  it("does not let relay shutdown skip owner-gated mount cleanup", () => {
    const removeMount = sourceBlock(
      "  removeMount: async (owner, target) => {",
      "\n  },\n});",
    );
    const relayCloseAt = removeMount.indexOf(
      "await closeRelayTransportWorkspace(target.storeWorkspaceId)",
    );
    const ownerRemoveAt = removeMount.indexOf(
      "await shareViewFilesMountProjection(owner).remove()",
    );
    const registryWriteAt = removeMount.indexOf("setWorkspaceShareMounts(");

    expect(relayCloseAt).toBeGreaterThan(-1);
    expect(removeMount.slice(relayCloseAt, ownerRemoveAt)).toContain(
      ".catch((error) =>",
    );
    expect(ownerRemoveAt).toBeGreaterThan(relayCloseAt);
    expect(registryWriteAt).toBeGreaterThan(ownerRemoveAt);

    const unmount = handlerSource("unmountShare");
    const registryOnlyAt = unmount.indexOf(
      'if (removal.kind === "registry-only")',
    );
    const registryOnlyCloseAt = unmount.indexOf(
      "await closeRelayTransportWorkspace(",
      registryOnlyAt,
    );
    const registryOnlyWriteAt = unmount.indexOf(
      "setWorkspaceShareMounts(",
      registryOnlyCloseAt,
    );
    expect(registryOnlyAt).toBeGreaterThan(-1);
    expect(unmount.slice(registryOnlyCloseAt, registryOnlyWriteAt)).toContain(
      ").catch((error) =>",
    );
  });

  it("holds the mount lock across preflight but leases the workspace only for local mount work", () => {
    const mount = handlerSource("mountShare");
    const mountLockAt = mount.indexOf("return withShareMountLock(");
    const infoAt = mount.indexOf("await fetchShareViewInfo(");
    const exclusiveAt = mount.indexOf("return withExclusiveWorkspaceOperation(");
    const ownerMountAt = mount.indexOf("await shareViewFiles.mount(");

    expect(mountLockAt).toBeGreaterThan(-1);
    expect(infoAt).toBeGreaterThan(mountLockAt);
    expect(exclusiveAt).toBeGreaterThan(infoAt);
    expect(ownerMountAt).toBeGreaterThan(exclusiveAt);

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
});
