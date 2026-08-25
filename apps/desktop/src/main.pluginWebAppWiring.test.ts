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

const squeeze = (source: string): string => source.replace(/\s+/g, "");

describe("plugin web app main-process wiring", () => {
  it("unpairs only the failed attempt's captured live spawn in the same turn", () => {
    const lease = functionSource("function createPluginWebAppHostLease(");
    const captureAt = lease.indexOf("const host = pipeline.host;");
    const startAt = lease.indexOf("startWebApp: () => host.startWebApp(", captureAt);
    const unpairAt = lease.indexOf("unpair: (expectedSpawnId) => {", startAt);
    const checkAt = lease.indexOf("host.getSpawnId(pluginId) !== expectedSpawnId", unpairAt);
    const callAt = lease.indexOf("return host.stopWebApp(", checkAt);
    const gap = lease.slice(checkAt, callAt);

    expect(captureAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(captureAt);
    expect(unpairAt).toBeGreaterThan(startAt);
    expect(checkAt).toBeGreaterThan(unpairAt);
    expect(callAt).toBeGreaterThan(checkAt);
    expect(gap).not.toContain("await ");
    expect(squeeze(lease.slice(callAt, callAt + 120))).toContain(
      "returnhost.stopWebApp(pluginId,webAppId,instanceKey);",
    );
  });

  it("attaches and detaches a guest through the exact captured window", () => {
    const container = functionSource("function createPluginWebAppContainer(");
    const attachAt = container.indexOf("attach: (view) => {");
    const resolveAt = container.indexOf("BrowserWindow.fromWebContents(sender)", attachAt);
    const captureAt = container.indexOf("attachedWindow = window;", resolveAt);
    const addAt = container.indexOf("window.contentView.addChildView(view);", captureAt);
    const detachAt = container.indexOf("detach: (view) => {", addAt);
    const exactAt = container.indexOf("const window = attachedWindow;", detachAt);
    const removeAt = container.indexOf("window.contentView.removeChildView(view);", exactAt);

    expect(resolveAt).toBeGreaterThan(attachAt);
    expect(captureAt).toBeGreaterThan(resolveAt);
    expect(addAt).toBeGreaterThan(captureAt);
    expect(detachAt).toBeGreaterThan(addAt);
    expect(exactAt).toBeGreaterThan(detachAt);
    expect(removeAt).toBeGreaterThan(exactAt);
    expect(container.slice(detachAt)).not.toContain("BrowserWindow.fromWebContents(sender)");
  });

  it("binds new guests and every zoom change through the surface owner", () => {
    expect(mainSource).toContain("bindWebAppZoom: bindGuestZoom,");
    expect(squeeze(mainSource)).toContain(
      "constbindGuestZoom=createGuestZoomApplier(()=>knownZoomLevel);",
    );

    const apply = functionSource("function applyZoomLevelToWindows(");
    expect(apply).toContain("pluginSurfaces.applyWebAppZoom(zoomLevel);");

    const track = functionSource("function trackWorkspaceWindow(");
    expect(track).toContain("resolvePersistedZoomApplication(");
    expect(track).toContain("applyZoomLevelToWindows(application.applyEverywhere);");
  });

  it("keeps surface teardown before pipeline disposal for one workspace and all workspaces", () => {
    const stopWorkspace = functionSource("async function stopPluginWorkspace(");
    const surfacesAt = stopWorkspace.indexOf(
      'await pluginSurfaces.stop({ kind: "workspace", workspaceId });',
    );
    const pipelineAt = stopWorkspace.indexOf(
      "await stopPluginPipelineForWorkspace(workspaceId);",
      surfacesAt,
    );
    expect(surfacesAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(surfacesAt);

    const stopAll = functionSource("async function stopAllPluginWorkspaces(");
    const closeAt = stopAll.indexOf("const surfaceStop = pluginSurfaces.close();");
    const drainAt = stopAll.indexOf(
      "await Promise.allSettled([sitePreviewStop, surfaceStop]);",
      closeAt,
    );
    const allPipelinesAt = stopAll.indexOf(
      "stopPluginPipelineForWorkspace(workspaceId)",
      drainAt,
    );
    expect(closeAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(closeAt);
    expect(allPipelinesAt).toBeGreaterThan(drainAt);
  });

  it("generation-gates owner failure notification before sending", () => {
    const notify = functionSource("function notifyPluginWebAppFailed(");
    expect(notify).toContain(
      "sender.isDestroyed() || rendererGeneration(sender.id) !== generation",
    );

    const ownerAt = mainSource.indexOf(
      "const pluginSurfaces = new PluginSurfaces<WebContentsView>({",
    );
    const resolveAt = mainSource.indexOf("webContents.fromId(senderId)", ownerAt);
    const sendAt = mainSource.indexOf(
      "notifyPluginWebAppFailed(sender, generation, event)",
      resolveAt,
    );
    expect(ownerAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(ownerAt);
    expect(sendAt).toBeGreaterThan(resolveAt);
  });
});
