import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Wiring order only. Every decision these handlers delegate to is pinned by
// behavior elsewhere: guest hardening in pluginWebAppGuest.test.ts, the
// async-guard registry in pluginWebAppViews.test.ts, the plugin round-trip in
// PluginHost.test.ts, and the whole surface end to end in t3-plugin.spec.ts.

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

  it("creates the hardened guest only after readiness, and never hands the URL to the renderer", () => {
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
    const parseAt = start.indexOf("parsePluginWebAppUrl(started.url)", startWebAppAt);
    const viewAt = start.indexOf("new WebContentsView({", parseAt);
    const sessionHardenAt = start.indexOf("hardenGuestSession(", viewAt);
    const contentsHardenAt = start.indexOf("hardenGuestWebContents(", viewAt);
    const attachAt = start.indexOf("win.contentView.addChildView(view);", viewAt);
    const loadAt = start.indexOf("view.webContents.loadURL(started.url)", attachAt);

    // MUTATION (stale renderer): dropping either recheck lets a start that
    // finished after a workspace switch or a plugin respawn attach a live
    // guest for the wrong context.
    expect(startWebAppAt).toBeGreaterThan(-1);
    expect(spawnRecheckAt).toBeGreaterThan(startWebAppAt);
    expect(currentRecheckAt).toBeGreaterThan(startWebAppAt);
    expect(parseAt).toBeGreaterThan(startWebAppAt);
    expect(viewAt).toBeGreaterThan(parseAt);
    expect(sessionHardenAt).toBeGreaterThan(viewAt);
    expect(contentsHardenAt).toBeGreaterThan(viewAt);
    expect(attachAt).toBeGreaterThan(contentsHardenAt);
    expect(loadAt).toBeGreaterThan(attachAt);
    expect(start).toContain("guestWebPreferences(partition)");
    expect(start).toContain("view.setVisible(false);");
    // The renderer result carries the credential-free origin, never the URL.
    expect(start).toContain("origin: parsed.origin,");
    expect(start).not.toContain("url: started.url");
    expect(start).toContain("if (displaced) destroyPluginWebAppViews([displaced]);");
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
    const clearAt = uninstall.indexOf(".clearStorageData()", guardAt);

    // MUTATION (session credential): without the clear, a reinstalled plugin
    // inherits the previous installation's authenticated session cookies.
    expect(stopViewsAt).toBeGreaterThan(-1);
    expect(uninstallCallAt).toBeGreaterThan(stopViewsAt);
    expect(guardAt).toBeGreaterThan(uninstallCallAt);
    expect(clearAt).toBeGreaterThan(guardAt);
    expect(uninstall).toContain("hardenedGuestPartitions.delete(partition);");
  });
});
