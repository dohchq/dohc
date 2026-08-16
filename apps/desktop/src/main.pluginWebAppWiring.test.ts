import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Wiring order only, and only for order this file's handlers own. Every
// decision they delegate is pinned by behavior elsewhere: the guest's
// preferences, origin lock, session hardening, credential handling, and the
// uninstall partition clear in pluginWebAppGuest.test.ts; the async-guard
// registry in pluginWebAppViews.test.ts; the plugin round-trip in
// PluginHost.test.ts; the whole surface end to end in t3-plugin.spec.ts.

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handler(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle(CHANNELS.${channel}`);
  expect(start).toBeGreaterThan(-1);
  return mainSource.slice(start, mainSource.indexOf("\n  });", start));
}

describe("plugin web app main-process wiring", () => {
  it("validates the web app registration before starting its host", () => {
    const open = handler("openPluginWebApp");
    const loadAt = open.indexOf("loadPluginWebAppRegistration({");
    const rememberAt = open.indexOf("rememberPluginRegistration(");
    const lockAt = open.indexOf("await withPluginWebAppStartLock(");
    const startAt = open.indexOf("return ensurePluginStarted(workspace, plugin)");

    expect(loadAt).toBeGreaterThan(-1);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(lockAt).toBeGreaterThan(rememberAt);
    expect(startAt).toBeGreaterThan(lockAt);
    expect(open).toContain("withPluginHostLifecycleLock(");
    expect(open).toContain("assertPluginPanelRequestCurrent(isCurrent);");
  });

  it("builds the guest only after readiness and both post-start rechecks", () => {
    const start = handler("startPluginWebApp");
    const startWebAppAt = start.indexOf(
      "await host.startWebApp(input.pluginId, input.webAppId)",
    );
    const spawnRecheckAt = start.indexOf(
      "host.getSpawnId(input.pluginId) !== spawnId",
      startWebAppAt,
    );
    const currentRecheckAt = start.indexOf(
      "assertPluginPanelRequestCurrent(isCurrent);",
      startWebAppAt,
    );
    const guestAt = start.indexOf("createPluginWebAppGuest({", currentRecheckAt);

    // MUTATION (stale renderer): dropping either recheck lets a start that
    // finished after a workspace switch or a plugin respawn attach a live
    // guest for the wrong context.
    expect(startWebAppAt).toBeGreaterThan(-1);
    expect(spawnRecheckAt).toBeGreaterThan(startWebAppAt);
    expect(currentRecheckAt).toBeGreaterThan(startWebAppAt);
    expect(guestAt).toBeGreaterThan(currentRecheckAt);
    // The renderer result carries the guest's origin. That the origin is
    // credential-free is pinned in pluginWebAppGuest.test.ts, where it is
    // derived; the start URL reaches this handler only to be passed on.
    expect(start).toContain("origin: guest.origin,");
    expect(start).toContain("if (displaced) destroyPluginWebAppViews([displaced]);");
  });

  it("recovers a consumed credential by unpairing the plugin itself", () => {
    const start = handler("startPluginWebApp");
    // What the recovery does with these, and in what order, is pinned by
    // behavior in pluginWebAppRecovery.test.ts; that the start hands it the
    // PLUGIN's unpair — not just the view stop — is this handler's own claim.
    expect(start).toContain("recoverConsumedWebAppCredential({");
    expect(start).toContain(
      "unpair: () => host.stopWebApp(input.pluginId, input.webAppId),",
    );
    expect(start).toContain("notifyFailed: () =>");
    expect(start).toContain("onLoadFailure: () => {");
    expect(start).toContain("recoverConsumedCredential();");
  });

  it("leaves a normal tab close paired", () => {
    const stopWebApp = mainSource.slice(
      mainSource.indexOf("async function stopPluginWebApp("),
      mainSource.indexOf("\n}\n", mainSource.indexOf("async function stopPluginWebApp(")),
    );
    // MUTATION (unpair on every close): an enabled plugin's server would then
    // be torn down and respawned on every tab close, and the guest's session
    // cookie — which already landed, and which the next open reuses — would
    // be worthless. Only the recovery path unpairs.
    expect(stopWebApp).not.toContain("stopWebApp(pluginId");
    expect(stopWebApp).not.toContain("recoverConsumedWebAppCredential");
  });

  it("applies bounds only through the registry's sender-and-generation guard", () => {
    const bounds = handler("setPluginWebAppBounds");
    const authorizeAt = bounds.indexOf("pluginWebAppViews.authorizeBounds({");
    const dropAt = bounds.indexOf("if (!record) return;", authorizeAt);
    const applyAt = bounds.indexOf("record.view.view.setBounds(input.bounds);", dropAt);

    expect(authorizeAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(authorizeAt);
    expect(applyAt).toBeGreaterThan(dropAt);
    expect(bounds).toContain("generation: rendererGeneration(event.sender.id),");
  });

  it("shares the host claim accounting between panels and web apps", () => {
    const stopWebApp = mainSource.slice(
      mainSource.indexOf("async function stopPluginWebApp("),
      mainSource.indexOf("\n}\n", mainSource.indexOf("async function stopPluginWebApp(")),
    );
    expect(stopWebApp).toContain("hasAnotherPanel");
    expect(stopWebApp).toContain("!pluginWebAppViews.hasForPlugin(workspaceId, pluginId)");
    expect(stopWebApp).toContain(
      "panelStartedHosts.delete(pluginLifecycleKey(workspaceId, pluginId))",
    );

    const stopPanel = mainSource.slice(
      mainSource.indexOf("async function stopPluginPanel("),
      mainSource.indexOf("\n}\n\nasync function stopPluginWebApp"),
    );
    // MUTATION (shared claim): without this, closing the last panel stops a
    // host whose web app tab is still open on the same plugin.
    expect(stopPanel).toContain(
      "!pluginWebAppViews.hasForPlugin(workspaceId, pluginId) &&",
    );
  });

  it("destroys guest views on every teardown path a view could outlive", () => {
    const reload = mainSource.slice(
      mainSource.indexOf("async function prepareForRendererReload("),
      mainSource.indexOf("\n}\n", mainSource.indexOf("async function prepareForRendererReload(")),
    );
    expect(reload).toContain(
      "destroyPluginWebAppViews(pluginWebAppViews.removeForSender(senderId));",
    );

    const stopWorkspace = mainSource.slice(
      mainSource.indexOf("async function stopPluginWorkspace("),
      mainSource.indexOf("\n}\n", mainSource.indexOf("async function stopPluginWorkspace(")),
    );
    expect(stopWorkspace).toContain(
      "destroyPluginWebAppViews(pluginWebAppViews.removeForWorkspace(workspaceId));",
    );

    const stopAll = mainSource.slice(
      mainSource.indexOf("async function stopAllPluginWorkspaces("),
      mainSource.indexOf("\n}\n", mainSource.indexOf("async function stopAllPluginWorkspaces(")),
    );
    expect(stopAll).toContain("destroyPluginWebAppViews(pluginWebAppViews.removeAll());");

    const pipeline = mainSource.slice(
      mainSource.indexOf("function createPluginPipeline"),
      mainSource.indexOf("\n}\n\nasync function ensurePluginPipeline"),
    );
    expect(pipeline).toContain(
      "stopPluginWebAppsForPlugin(workspace.workspaceId, pluginId);",
    );

    const disableAt = mainSource.indexOf("pluginAction(CHANNELS.disablePlugin,");
    const disableStopAt = mainSource.indexOf(
      "stopPluginWebAppsForPlugin(workspaceId, pluginId);",
      disableAt,
    );
    const disableCallAt = mainSource.indexOf(
      "return pipeline.disable(pluginId);",
      disableAt,
    );
    expect(disableStopAt).toBeGreaterThan(disableAt);
    expect(disableCallAt).toBeGreaterThan(disableStopAt);
  });

  it("clears the guest partition's storage after a successful uninstall", () => {
    const uninstall = handler("uninstallPlugin");
    const stopViewsAt = uninstall.indexOf(
      "stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId);",
    );
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.confirmationToken),",
    );
    const guardAt = uninstall.indexOf("if (result.ok) {", uninstallCallAt);
    const clearAt = uninstall.indexOf("clearPluginWebAppPartition({", guardAt);

    // MUTATION (session credential): without the clear, a reinstalled plugin
    // inherits the previous installation's authenticated session cookies.
    // What the clear targets is pinned in pluginWebAppGuest.test.ts.
    expect(stopViewsAt).toBeGreaterThan(-1);
    expect(uninstallCallAt).toBeGreaterThan(stopViewsAt);
    expect(guardAt).toBeGreaterThan(uninstallCallAt);
    expect(clearAt).toBeGreaterThan(guardAt);
  });
});
