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

function handler(channel: string): string {
  return sourceBlock(`ipcMain.handle(CHANNELS.${channel}`, "\n  });");
}

function functionSource(signature: string): string {
  return sourceBlock(signature, "\n}\n");
}

const squeeze = (source: string): string => source.replace(/\s+/g, "");

describe("plugin web app main-process wiring", () => {
  it("loads and remembers a declared web app only while its renderer stays current", () => {
    const open = handler("openPluginWebApp");
    const firstCurrentAt = open.indexOf("requireCurrentRenderer(isCurrent);");
    const loadAt = open.indexOf("await loadPluginWebAppRegistration({");
    const postLoadCurrentAt = open.indexOf(
      "requireCurrentRenderer(isCurrent);",
      loadAt,
    );
    const pipelineAt = open.indexOf(
      "const { pipeline } = await activePluginPipelineFor(event, input.workspaceId);",
      postLoadCurrentAt,
    );
    const postPipelineCurrentAt = open.indexOf(
      "requireCurrentRenderer(isCurrent);",
      pipelineAt,
    );
    const rememberAt = open.indexOf("rememberPluginRegistration(", pipelineAt);
    const declaredAt = open.indexOf("requireDeclaredWebApp(", rememberAt);

    expect(firstCurrentAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(firstCurrentAt);
    expect(postLoadCurrentAt).toBeGreaterThan(loadAt);
    expect(pipelineAt).toBeGreaterThan(postLoadCurrentAt);
    expect(postPipelineCurrentAt).toBeGreaterThan(pipelineAt);
    expect(rememberAt).toBeGreaterThan(postPipelineCurrentAt);
    expect(declaredAt).toBeGreaterThan(rememberAt);
    expect(open).not.toContain("ensurePluginStarted(");
    expect(open).not.toContain("acquirePluginSurfaceLease(");
  });

  it("hands exact identity, policy, and captured host effects to the surface owner", () => {
    const start = handler("startPluginWebApp");
    const declaredAt = start.indexOf("const webApp = requireDeclaredWebApp(");
    const ownerAt = start.indexOf("pluginSurfaces.startWebApp(", declaredAt);
    const pipelineAt = start.indexOf("const pipeline = await ensurePluginPipeline(workspace);", ownerAt);
    const currentAt = start.indexOf("requireCurrentRenderer(isCurrent);", pipelineAt);
    const writableAt = start.indexOf("assertWritableWorkspace(workspace);", currentAt);
    const leaseAt = start.indexOf(
      "return createPluginWebAppHostLease(",
      writableAt,
    );

    expect(declaredAt).toBeGreaterThan(-1);
    expect(ownerAt).toBeGreaterThan(declaredAt);
    expect(squeeze(start)).toContain(
      "...identity,senderId:sender.id,generation,workspaceRoot:workspace.rootPath,container:createPluginWebAppContainer(sender),",
    );
    expect(start).toContain("assertInstanceBudget: (liveAndReservedOtherInstances) =>");
    expect(start).toContain("assertAllowed: () => {");
    expect(pipelineAt).toBeGreaterThan(ownerAt);
    expect(currentAt).toBeGreaterThan(pipelineAt);
    expect(writableAt).toBeGreaterThan(currentAt);
    expect(leaseAt).toBeGreaterThan(writableAt);
    expect(squeeze(start.slice(leaseAt, leaseAt + 180))).toContain(
      "returncreatePluginWebAppHostLease(pipeline,input.pluginId,input.webAppId,input.instanceKey,);",
    );
    expect(start).toContain("title: started.title ?? webApp.title,");
    expect(start).toContain("origin: started.origin,");
  });

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

  it("passes exact owner identity and sender zoom to the bounds guard", () => {
    const bounds = handler("setPluginWebAppBounds");
    const ownerAt = bounds.indexOf("pluginSurfaces.applyWebAppBounds({");
    const generationAt = bounds.indexOf(
      "generation: rendererGeneration(event.sender.id),",
      ownerAt,
    );
    const zoomAt = bounds.indexOf("zoomFactor: event.sender.getZoomFactor(),", generationAt);

    expect(ownerAt).toBeGreaterThan(-1);
    expect(generationAt).toBeGreaterThan(ownerAt);
    expect(zoomAt).toBeGreaterThan(generationAt);
    expect(squeeze(bounds)).toContain(
      "workspaceId:input.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,",
    );
  });

  it("carries the request instance through open, start, bounds, and exact stop", () => {
    expect(squeeze(handler("openPluginWebApp"))).toContain(
      "requireDeclaredWebApp(input.pluginId,plugin.manifest.webApps,input.webAppId,input.instanceKey,)",
    );
    expect(squeeze(handler("startPluginWebApp"))).toContain(
      "constidentity={workspaceId:workspace.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,}",
    );
    expect(squeeze(handler("setPluginWebAppBounds"))).toContain(
      "webAppId:input.webAppId,instanceKey:input.instanceKey,",
    );
    expect(squeeze(handler("stopPluginWebApp"))).toContain(
      "kind:\"web-app\",workspaceId:workspace.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,owner:{senderId:event.sender.id,generation:rendererGeneration(event.sender.id),},",
    );
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

  it("protects only an installed claimant from a different directory", () => {
    const predicateAt = mainSource.indexOf("const pluginIdHasOtherInstalledClaimant = (");
    const predicateEnd = mainSource.indexOf("\n\n", predicateAt);
    const predicate = mainSource.slice(predicateAt, predicateEnd);
    expect(predicateAt).toBeGreaterThan(-1);
    expect(squeeze(predicate)).toContain(
      "entry.id===pluginId&&entry.directoryName!==directoryName&&entry.approvedHash!==null",
    );
  });

  it("passes partition clearing to the owner only after the last claimant is removed", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallAt = uninstall.indexOf("pipeline.uninstall(");
    const claimantAt = uninstall.indexOf(
      "pluginIdHasOtherInstalledClaimant(",
      uninstallAt,
    );
    const removedAt = uninstall.indexOf(
      "const removedLastClaimant = result.ok && !pluginIdHasOtherInstalledClaimant(",
      uninstallAt,
    );
    const guardAt = uninstall.indexOf("if (removedLastClaimant)", removedAt);
    const stopAt = uninstall.indexOf("pluginSurfaces.stop({", guardAt);
    const clearAt = uninstall.indexOf(
      "clearPartition: { workspaceRoot: workspace.rootPath }",
      stopAt,
    );
    expect(uninstallAt).toBeGreaterThan(-1);
    expect(removedAt).toBeGreaterThan(uninstallAt);
    expect(claimantAt).toBeGreaterThan(removedAt);
    expect(guardAt).toBeGreaterThan(removedAt);
    expect(stopAt).toBeGreaterThan(guardAt);
    expect(clearAt).toBeGreaterThan(stopAt);
  });

  it("gates registration forgetting on the same last-claimant decision", () => {
    const uninstall = handler("uninstallPlugin");
    const removedAt = uninstall.indexOf(
      "const removedLastClaimant = result.ok && !pluginIdHasOtherInstalledClaimant(",
    );
    const forgetAt = uninstall.indexOf("forgetUninstalledPlugin({", removedAt);
    const forget = uninstall.slice(forgetAt, uninstall.indexOf("});", forgetAt));
    expect(removedAt).toBeGreaterThan(-1);
    expect(forgetAt).toBeGreaterThan(removedAt);
    expect(squeeze(forget)).toContain("uninstalled:removedLastClaimant,");
  });

  it("keeps successful last-claimant partition cleanup idempotent", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallAt = uninstall.indexOf("pipeline.uninstall(");
    const guardAt = uninstall.indexOf("if (removedLastClaimant)", uninstallAt);
    const partitionStopAt = uninstall.indexOf("pluginSurfaces.stop({", guardAt);
    expect(uninstallAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(uninstallAt);
    expect(partitionStopAt).toBeGreaterThan(guardAt);
    expect(uninstall.slice(uninstallAt, guardAt)).not.toContain(
      "pluginSurfaces.stop({",
    );
    expect(uninstall.indexOf("pluginSurfaces.stop({", partitionStopAt + 1)).toBe(-1);
  });

  it("does not infer teardown from a failed result's status", () => {
    const uninstall = handler("uninstallPlugin");
    const removedAt = uninstall.indexOf(
      "const removedLastClaimant = result.ok && !pluginIdHasOtherInstalledClaimant(",
    );
    const guardAt = uninstall.indexOf("if (removedLastClaimant)", removedAt);
    expect(removedAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(removedAt);
    expect(uninstall).not.toContain("claimantStoppedBySettledResult");
    expect(uninstall).not.toContain("result.plugin.status");
  });

  it("never tears down a surviving installed collision claimant", () => {
    const uninstall = handler("uninstallPlugin");
    const claimantAt = uninstall.indexOf(
      "const removedLastClaimant = result.ok && !pluginIdHasOtherInstalledClaimant(",
    );
    const directoryAt = uninstall.indexOf("input.directoryName,", claimantAt);
    const guardAt = uninstall.indexOf("if (removedLastClaimant)", claimantAt);
    expect(claimantAt).toBeGreaterThan(-1);
    expect(directoryAt).toBeGreaterThan(claimantAt);
    expect(guardAt).toBeGreaterThan(directoryAt);
  });
});
