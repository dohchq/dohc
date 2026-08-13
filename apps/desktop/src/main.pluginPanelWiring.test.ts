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
    const loadAt = open.indexOf("loadPluginPanelRegistration({");
    const rememberAt = open.indexOf("rememberPluginRegistration(");
    const startAt = open.indexOf("await ensurePluginStarted(workspace, plugin);");

    expect(loadAt).toBeGreaterThan(-1);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(startAt).toBeGreaterThan(rememberAt);
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
    expect(start).toContain("spawnId");
    expect(start).toContain("previous.releaseOrigin();");

    const stopStart = mainSource.indexOf("async function stopPluginPanel(");
    const stopEnd = mainSource.indexOf(
      "\n}\n\nasync function stopPluginPanelsForWorkspace",
      stopStart,
    );
    expect(stopEnd).toBeGreaterThan(-1);
    const stop = mainSource.slice(stopStart, stopEnd);
    expect(stop).toContain("panel.releaseOrigin();");
  });

  it("authorizes panel SDK calls before routing them through the plugin host", () => {
    const invoke = handler("invokePluginPanelSdk");
    const authorizeAt = invoke.indexOf("pluginPanelSdkAuthorities.authorize({");
    const routeAt = invoke.indexOf("invokeWorkspacePluginSdk({");
    const routerStart = mainSource.indexOf("function invokeWorkspacePluginSdk");
    const routerEnd = mainSource.indexOf(
      "\n}\n\nfunction pluginHostFor",
      routerStart,
    );
    expect(routerEnd).toBeGreaterThan(-1);
    const router = mainSource.slice(routerStart, routerEnd);

    expect(authorizeAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(authorizeAt);
    expect(router).toContain("return invokePluginSdkHost(");
    expect(router).toContain(
      "await capture.writeAuthoredTextFile(absolutePath, text, author);",
    );
  });

  it("uses utilityProcess and tears plugin hosts down with their owners", () => {
    const hostStart = mainSource.indexOf("function pluginHostFor");
    const hostEnd = mainSource.indexOf(
      "\n}\n\nfunction registeredPlugin",
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
    expect(workspaceOpen).toContain("pluginPanelSdkAuthorities.revokeSender(senderId);");
    expect(workspaceOpen).toContain("void stopPluginWorkspace(activeWorkspaceId);");
    expect(workspaceOpen).toContain("await stopPluginWorkspace(previousWorkspaceId);");
    expect(willQuit).toContain("pluginPanelSdkAuthorities.revokeAll();");
    expect(willQuit).toContain("const pluginStop = stopAllPluginWorkspaces();");
  });
});
