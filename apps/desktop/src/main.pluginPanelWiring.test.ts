import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handler(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle(CHANNELS.${channel}`);
  expect(start).toBeGreaterThan(-1);
  return mainSource.slice(start, mainSource.indexOf("\n  });", start));
}

describe("plugin panel main-process wiring", () => {
  it("validates a contained plugin registration before starting its host", () => {
    const open = handler("openPluginPanel");
    const loadAt = open.indexOf(
      "loadPluginPanelRegistrationForCurrentRenderer(",
    );
    const currentAt = open.indexOf("isCurrent,", loadAt);
    const rememberAt = open.indexOf("rememberPluginRegistration(");
    const lockAt = open.indexOf("await withPluginPanelStartLock(");
    const startAt = open.indexOf(
      "return ensurePluginStarted(workspace, plugin)",
    );

    expect(loadAt).toBeGreaterThan(-1);
    expect(currentAt).toBeGreaterThan(loadAt);
    expect(currentAt).toBeLessThan(rememberAt);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(lockAt).toBeGreaterThan(rememberAt);
    expect(open).toContain("withPluginHostLifecycleLock(");
    expect(open).toContain("assertPluginPanelRequestCurrent(isCurrent);");
    expect(startAt).toBeGreaterThan(lockAt);
  });

  it("serves the manifest panel and grants only main-derived SDK context", () => {
    const start = handler("startPluginPanel");
    const serveAt = start.indexOf("startStaticDirectoryPreview(dirname(entryPath)");
    const allowAt = start.indexOf("allowLoopbackFrameOrigin(handle.url)");
    const rememberAt = start.indexOf("runningPluginPanels.set(key");
    const grantAt = start.indexOf("pluginPanelSdkAuthorities.register({");

    expect(serveAt).toBeGreaterThan(-1);
    expect(allowAt).toBeGreaterThan(serveAt);
    expect(rememberAt).toBeGreaterThan(allowAt);
    expect(grantAt).toBeGreaterThan(rememberAt);
    expect(start).toContain("startPluginPanelWithLock(");
    expect(start).toContain("withPluginHostLifecycleLock,");
    expect(start).toContain("() => ensurePluginStarted(workspace, plugin)");
    expect(start).toContain("await stopRunningPluginPanelPreview(previous);");

    const stopStart = mainSource.indexOf("async function stopPluginPanel(");
    const stopEnd = mainSource.indexOf(
      "\n}\n\nasync function stopPluginPanelsForWorkspace",
      stopStart,
    );
    expect(stopEnd).toBeGreaterThan(-1);
    const stop = mainSource.slice(stopStart, stopEnd);
    expect(stop).toContain("stopPluginPanelWithLock(");
    expect(stop).toContain("withPluginHostLifecycleLock,");
    expect(stop).toContain("await stopRunningPluginPanelPreview(panel);");
    expect(stop).toContain(
      "await pluginPipelines.get(workspaceId)?.host.stop(pluginId);",
    );
  });

  it("authorizes panel SDK calls before routing them through the plugin host", () => {
    const invoke = handler("invokePluginPanelSdk");
    const authorizeAt = invoke.indexOf("pluginPanelSdkAuthorities.authorize({");
    const routeAt = invoke.indexOf("invokeWorkspacePluginSdk({");
    const routerStart = mainSource.indexOf("function invokeWorkspacePluginSdk");
    const routerEnd = mainSource.indexOf(
      "\n}\n\nfunction registeredPlugin",
      routerStart,
    );
    expect(routerEnd).toBeGreaterThan(-1);
    const router = mainSource.slice(routerStart, routerEnd);

    expect(authorizeAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(authorizeAt);
    expect(invoke).toContain("const liveSpawnId = host?.getSpawnId(input.pluginId);");
    expect(invoke).toContain("liveSpawnId,");
    expect(router).toContain("return invokePluginSdkHost(");
    expect(router).toContain(
      "await capture.writeAuthoredTextFile(absolutePath, text, author, {",
    );
  });

  it("routes a plugin's own door-written source write into its pipeline (A5)", () => {
    const routerStart = mainSource.indexOf("function invokeWorkspacePluginSdk");
    const routerEnd = mainSource.indexOf(
      "\n}\n\nfunction registeredPlugin",
      routerStart,
    );
    expect(routerEnd).toBeGreaterThan(-1);
    const router = mainSource.slice(routerStart, routerEnd);
    const writeAt = router.indexOf(
      "await capture.writeAuthoredTextFile(absolutePath, text, author, {",
    );
    const ownerAt = router.indexOf(
      "?.pluginIdForPath(absolutePath);",
      writeAt,
    );
    const notifyAt = router.indexOf(
      "?.handleDoorWrittenSourceChange(ownerId);",
      ownerAt,
    );

    // A door-attributed write (files.write, stamped with MomentAuthor above)
    // must tell the owning plugin's pipeline directly — the plan doc's
    // auto-approve predicate is attribution through the door, not topology —
    // rather than only reaching the pipeline as an unattributed watcher
    // event, which never auto-approves.
    expect(writeAt).toBeGreaterThan(-1);
    expect(ownerAt).toBeGreaterThan(writeAt);
    expect(notifyAt).toBeGreaterThan(ownerAt);
  });

  it("uses utilityProcess and tears plugin hosts down with their owners", () => {
    const hostStart = mainSource.indexOf("function createPluginPipeline");
    const hostEnd = mainSource.indexOf(
      "\n}\n\nasync function ensurePluginPipeline",
      hostStart,
    );
    expect(hostEnd).toBeGreaterThan(-1);
    const host = mainSource.slice(hostStart, hostEnd);
    const workspaceOpen = handler("openWorkspace");
    const willQuitAt = mainSource.indexOf('app.on("will-quit"');
    const willQuit = mainSource.slice(
      willQuitAt,
      mainSource.indexOf("\n});", willQuitAt),
    );

    expect(host).toContain("utilityProcess.fork(");
    expect(host).toContain('join(import.meta.dirname, "plugin-host.js")');
    expect(host).toContain("onStatusChange:");
    expect(host).toContain("revokePluginPanelAuthoritiesForStatus(");
    expect(workspaceOpen).toContain("pluginPanelSdkAuthorities.revokeSender(senderId);");
    expect(workspaceOpen).toContain("void stopPluginWorkspace(activeWorkspaceId);");
    expect(workspaceOpen).toContain("await stopPluginWorkspace(previousWorkspaceId);");
    expect(willQuit).toContain("pluginPanelSdkAuthorities.revokeAll();");
    expect(willQuit).toContain("const pluginStop = stopAllPluginWorkspaces();");
  });

  it("derives panel writability from the current workspace on every invocation", () => {
    const invoke = handler("invokePluginPanelSdk");

    expect(invoke).not.toContain("writable: authority.writable");
    expect(invoke).toContain("isWritable: () => !sharedViewOf(authority.workspaceId)");
  });

  it("skips plugin-pipeline warmup when a later openWorkspace switched away first (#779 round 4 finding 1)", () => {
    const open = handler("openWorkspace");
    const awaitAt = open.indexOf(
      "const status = SyncStatusResult.parse(await openWorkspaceActivity(workspace));",
    );
    const recheckAt = open.indexOf(
      "const stillActive = activeWorkspaceIdBySender.get(senderId) === workspace.workspaceId;",
      awaitAt,
    );
    const warmupAt = open.indexOf("await ensurePluginPipeline(workspace)", recheckAt);

    // MUTATION (open race): without a recheck after the await, a sender that
    // switched workspaces while this call's openWorkspaceActivity was still
    // pending would warm the plugin pipeline for the workspace it just left
    // instead of the one it is actually on now.
    expect(awaitAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(awaitAt);
    expect(warmupAt).toBeGreaterThan(recheckAt);
    expect(open).toContain("stillActive && !sharedViewOf(workspace.workspaceId)");
  });

  it("stops a host on last-panel-close only when a panel is the reason it's running (#779 round 4 finding 3)", () => {
    // Claiming the host is startPluginForPanel's job and is pinned by
    // behavior in pluginPanelRegistration.test.ts. Source-text assertions
    // about it survived a mutation that claimed the host unconditionally
    // (CERT779J S1), so they are gone.
    const stopPanel = mainSource.slice(
      mainSource.indexOf("async function stopPluginPanel("),
      mainSource.indexOf("\n}\n\nasync function stopPluginPanelsForWorkspace"),
    );
    const hasAnotherAt = stopPanel.indexOf("hasAnotherPanel");
    const deleteAt = stopPanel.indexOf(
      "panelStartedHosts.delete(pluginLifecycleKey(workspaceId, pluginId))",
    );
    const stopHostAt = stopPanel.indexOf(
      "await pluginPipelines.get(workspaceId)?.host.stop(pluginId);",
    );
    // MUTATION (ownership): dropping the panelStartedHosts.delete() guard
    // (leaving only !hasAnotherPanel) stops every plugin's host on its last
    // panel close, including one the workspace itself enabled and expects
    // to keep running with no panel open at all.
    expect(hasAnotherAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(hasAnotherAt);
    expect(stopHostAt).toBeGreaterThan(deleteAt);

    const pluginActionStart = mainSource.indexOf("const pluginAction = (");
    const pluginActionEnd = mainSource.indexOf("\n  };\n\n  pluginAction(", pluginActionStart);
    expect(pluginActionEnd).toBeGreaterThan(-1);
    const pluginAction = mainSource.slice(pluginActionStart, pluginActionEnd);
    expect(pluginAction).toContain("if (result.ok) {");
    expect(pluginAction).toContain(
      "panelStartedHosts.delete(pluginLifecycleKey(input.workspaceId, input.pluginId));",
    );
  });
});
