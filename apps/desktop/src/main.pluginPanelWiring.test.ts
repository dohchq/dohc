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

describe("plugin panel main-process wiring", () => {
  it("forwards watcher batches to the matching pipeline and workspace events", () => {
    const batch = sourceBlock("onWatcherBatch: (workspace, events) => {", "\n  },");
    expect(batch).toContain(
      "pluginPipelines.get(workspace.workspaceId)?.handleWatcherEvents(events);",
    );
    expect(batch).toMatch(
      /pluginWorkspaceEventsByWorkspace\s*\.get\(workspace\.workspaceId\)\s*\?\.handleWatcherEvents\(events\);/,
    );
  });

  it("validates panel SDK events and sends them only to the active workspace", () => {
    const notify = functionSource("function notifyPluginPanelSdkEvent(");
    const parseAt = notify.indexOf("PluginPanelSdkEvent.safeParse(event)");
    const filterAt = notify.indexOf("activeWorkspaceIdBySender.get(", parseAt);
    const sendAt = notify.indexOf(
      "win.webContents.send(CHANNELS.pluginPanelSdkEvent, payload.data)",
      filterAt,
    );
    expect(parseAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(parseAt);
    expect(sendAt).toBeGreaterThan(filterAt);
  });

  it("loads and remembers a contained panel only while its renderer stays current", () => {
    const open = handler("openPluginPanel");
    const firstCurrentAt = open.indexOf("requireCurrentRenderer(isCurrent);");
    const loadAt = open.indexOf("await loadPluginPanelRegistration({");
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
    expect(firstCurrentAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(firstCurrentAt);
    expect(postLoadCurrentAt).toBeGreaterThan(loadAt);
    expect(pipelineAt).toBeGreaterThan(postLoadCurrentAt);
    expect(postPipelineCurrentAt).toBeGreaterThan(pipelineAt);
    expect(rememberAt).toBeGreaterThan(postPipelineCurrentAt);
    expect(open).not.toContain("ensurePluginStarted(");
    expect(open).not.toContain("acquirePluginSurfaceLease(");
    expect(open).toContain(
      "pluginRegistration: pluginPipelines.get(workspace.workspaceId),",
    );
  });

  it("keeps manifest placement and snapshot serving outside the surface owner", () => {
    const start = handler("startPluginPanel");
    const panelAt = start.indexOf("plugin.manifest.panels?.find(");
    const placementAt = start.indexOf("panel.placement !== input.placement", panelAt);
    const ownerAt = start.indexOf("pluginSurfaces.startPanel(", placementAt);
    const snapshotAt = start.indexOf("pluginSnapshotRoot(workspace, input.pluginId)", ownerAt);
    const previewAt = start.indexOf("startStaticDirectoryPreview(dirname(entryPath)", snapshotAt);
    expect(panelAt).toBeGreaterThan(-1);
    expect(placementAt).toBeGreaterThan(panelAt);
    expect(ownerAt).toBeGreaterThan(placementAt);
    expect(snapshotAt).toBeGreaterThan(ownerAt);
    expect(previewAt).toBeGreaterThan(snapshotAt);
    expect(start).toContain("assertAllowed: () => {");
    expect(start).toContain("acquireHostLease: async () => {");
    expect(start).toContain("return createPluginSurfaceHostLease(pipeline, input.pluginId);");
    expect(start).toContain("title: panel.title,");

    const lookup = functionSource("function registeredPlugin(");
    expect(lookup).toContain("resolveRegisteredPlugin(");
    expect(lookup).toContain("pluginPipelines.get(workspaceId)");
    expect(lookup).toContain("pluginRegistrations.get(workspaceId)");
  });

  it("authorizes panel SDK calls through the surface owner before routing", () => {
    const invoke = handler("invokePluginPanelSdk");
    const authorizeAt = invoke.indexOf("pluginSurfaces.authorizePanelSdk({");
    const routeAt = invoke.indexOf("invokeWorkspacePluginSdk({", authorizeAt);
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(authorizeAt);
    expect(invoke).toContain(
      "currentGeneration: () => rendererGeneration(sender.id),",
    );
    expect(invoke).toContain(
      "activeWorkspaceId: () => activeWorkspaceIdBySender.get(sender.id),",
    );
    expect(invoke).toContain("liveSpawnId: () =>");
    expect(invoke).toContain("isPanelRunning: isPushLive,");
    expect(invoke).toContain(
      "workspaceEvents.subscribe({ owner, emitEvent }, watchParams)",
    );
    expect(invoke).toContain(
      "workspaceEvents.unsubscribe({ owner }, watchParams)",
    );
  });

  it("routes plugin commands through the declared-command guard and owner", () => {
    const invoke = handler("invokePluginCommand");
    const currentAt = invoke.indexOf("activeWorkspaceIdBySender.get(");
    const pipelineAt = invoke.indexOf("const pipeline = await ensurePluginPipeline(workspace);");
    const lookupAt = invoke.indexOf("registeredPlugin(", pipelineAt);
    const routeAt = invoke.indexOf("invokeRegisteredPluginCommand({", lookupAt);
    const ownerAt = invoke.indexOf("pipeline.hostOwnership.runCommand(", routeAt);
    const startAt = invoke.indexOf("command.start(() =>", ownerAt);
    expect(currentAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(currentAt);
    expect(lookupAt).toBeGreaterThan(pipelineAt);
    expect(routeAt).toBeGreaterThan(lookupAt);
    expect(ownerAt).toBeGreaterThan(routeAt);
    expect(startAt).toBeGreaterThan(ownerAt);
    expect(invoke).toContain("assertWritableWorkspace(workspace);");
  });

  it("wires authored text to this invocation's signal, capture, and pipeline", () => {
    const router = functionSource("function invokeWorkspacePluginSdk");
    const writerAt = router.indexOf("writeAuthoredText: createPluginAuthoredTextWriter({");
    expect(writerAt).toBeGreaterThan(-1);
    expect(router.indexOf("signal: input.signal,", writerAt)).toBeGreaterThan(writerAt);
    expect(
      router.indexOf("await requirePluginEngineCapture(input.workspaceId);", writerAt),
    ).toBeGreaterThan(writerAt);
    expect(
      router.indexOf("pipeline: () => pluginPipelines.get(input.workspaceId),", writerAt),
    ).toBeGreaterThan(writerAt);
  });

  it("releases a removed identity's registration before status notification", () => {
    const notify = functionSource("function notifyPluginStatusChanged(");
    const forgetAt = notify.indexOf("forgetRemovedPlugin({");
    const guardAt = notify.indexOf("PluginStatusChangedEvent.safeParse(");
    expect(forgetAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(forgetAt);
  });

  it("constructs one owner for the pipeline and its exact host", () => {
    const createPipeline = functionSource("function createPluginPipeline(");
    const ownerAt = createPipeline.indexOf(
      "const hostOwnership = new PluginHostOwnership(pluginHost",
    );
    const pipelineAt = createPipeline.indexOf("pipeline = new PluginPipeline({");
    const wireAt = createPipeline.indexOf("hostOwnership,", pipelineAt);
    expect(ownerAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(ownerAt);
    expect(wireAt).toBeGreaterThan(pipelineAt);
  });

  it("uses the exact pipeline host and ownership lease for surface admission", () => {
    const adapter = functionSource("function createPluginSurfaceHostLease(");
    const captureAt = adapter.indexOf("const host = pipeline.host;");
    const acquireAt = adapter.indexOf(
      "acquirePluginSurfaceLease(pipeline.hostOwnership, pluginId)",
      captureAt,
    );
    const ensureAt = adapter.indexOf("ensurePluginStarted(", acquireAt);
    const hostAt = adapter.indexOf("host,", ensureAt);
    const startAt = adapter.indexOf("lease.start((authority)", hostAt);
    const pipelineStartAt = adapter.indexOf(
      "pipeline.ensureStarted(pluginId, authority)",
      startAt,
    );
    expect(captureAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeGreaterThan(captureAt);
    expect(ensureAt).toBeGreaterThan(acquireAt);
    expect(hostAt).toBeGreaterThan(ensureAt);
    expect(startAt).toBeGreaterThan(hostAt);
    expect(pipelineStartAt).toBeGreaterThan(startAt);
    expect(adapter).toContain("currentSpawnId: () => host.getSpawnId(pluginId)");
    expect(adapter).toContain("release: () => lease.release()");
  });

  it("revokes surfaces synchronously when the exact host spawn ends", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const spawnEndAt = pipeline.indexOf("onSpawnEnd: (pluginId, spawnId) => {");
    const markAt = pipeline.indexOf("pluginIdsWithEndedSpawn.add(pluginId);", spawnEndAt);
    const changedAt = pipeline.indexOf("pluginSurfaces.hostChanged({", markAt);
    const cleanupAt = pipeline.indexOf("pluginDrivers.endSpawn(pluginId, spawnId);", changedAt);
    const returnAt = pipeline.indexOf(
      "return childProcessBroker.disposeSpawn(pluginId, spawnId);",
      cleanupAt,
    );
    expect(pipeline).toContain("utilityProcess.fork(");
    expect(spawnEndAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(spawnEndAt);
    expect(changedAt).toBeGreaterThan(markAt);
    expect(pipeline.slice(changedAt, changedAt + 180)).toContain('kind: "terminal"');
    expect(cleanupAt).toBeGreaterThan(changedAt);
    expect(returnAt).toBeGreaterThan(cleanupAt);
    expect(pipeline.slice(spawnEndAt, returnAt)).not.toContain("await ");
  });

  it("does not treat an initial ready status as a replacement", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const statusAt = pipeline.indexOf("onStatusChange: (pluginId, status) => {");
    const markerAt = pipeline.indexOf("pluginIdsWithEndedSpawn.delete(pluginId)", statusAt);
    const readyAt = pipeline.indexOf("pluginSurfaces.hostReady({", markerAt);
    expect(statusAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(statusAt);
    expect(readyAt).toBeGreaterThan(markerAt);
    expect(pipeline.match(/pluginIdsWithEndedSpawn\.add\(pluginId\)/g)).toHaveLength(1);
  });

  it("regrants only a current ready successor without consuming a stale marker", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const statusAt = pipeline.indexOf("onStatusChange: (pluginId, status) => {");
    const noteAt = pipeline.indexOf("pipeline?.noteRuntimeStatus(pluginId, status);", statusAt);
    const readyAt = pipeline.indexOf('if (status !== "ready") return;', noteAt);
    const spawnAt = pipeline.indexOf("const spawnId = pluginHost.getSpawnId(pluginId);", readyAt);
    const currentAt = pipeline.indexOf(
      'pluginHost.getStatus(pluginId) !== "ready"',
      spawnAt,
    );
    const deleteAt = pipeline.indexOf("pluginIdsWithEndedSpawn.delete(pluginId)", currentAt);
    const regrantAt = pipeline.indexOf("pluginSurfaces.hostReady({", deleteAt);
    expect(noteAt).toBeGreaterThan(statusAt);
    expect(readyAt).toBeGreaterThan(noteAt);
    expect(spawnAt).toBeGreaterThan(readyAt);
    expect(currentAt).toBeGreaterThan(spawnAt);
    expect(deleteAt).toBeGreaterThan(currentAt);
    expect(regrantAt).toBeGreaterThan(deleteAt);
    expect(squeeze(pipeline.slice(regrantAt, regrantAt + 180))).toContain(
      "workspaceId:workspace.workspaceId,pluginId,spawnId,",
    );
  });

  it("passes the derived plugin-host environment to the utility process", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const spawnAt = pipeline.indexOf("spawnTransport: (callbacks) => {");
    const spawnEnd = pipeline.indexOf("\n    },", spawnAt);
    const spawn = pipeline.slice(spawnAt, spawnEnd);
    const binding = /const\s+(\w+)\s*=\s*pluginHostEnvFor\(/.exec(spawn)?.[1];
    expect(binding).toBeDefined();
    expect(spawn).toContain(`env: ${binding},`);
  });

  it("derives panel writability from the current workspace on every invocation", () => {
    const invoke = handler("invokePluginPanelSdk");
    expect(invoke).toContain("isWritable: () => !sharedViewOf(authority.workspaceId)");
    expect(invoke).not.toContain("writable: authority.writable");
  });

  it("refuses pipeline creation after the last workspace window closes", () => {
    const ensure = functionSource("async function ensurePluginPipeline(");
    const gateAt = ensure.indexOf("createOnlyWhile: () =>");
    const checkAt = ensure.indexOf(
      "isWorkspaceOpenInAnyWindow(workspace.workspaceId)",
      gateAt,
    );
    expect(gateAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(gateAt);
  });

  it("revokes SDK grants before disable and returns owner cleanup from the stopped boundary", () => {
    const disable = sourceBlock(
      "pluginAction(CHANNELS.disablePlugin,",
      "\n  });",
    );
    const disableCallAt = disable.indexOf(
      "const result = await pipeline.disable(pluginId, {",
    );
    const revokeHookAt = disable.indexOf(
      "onWillStopRuntime: () =>",
      disableCallAt,
    );
    const revokeAt = disable.indexOf(
      "pluginSurfaces.revokePluginSdkGrants({ workspaceId, pluginId })",
      revokeHookAt,
    );
    const stoppedHookAt = disable.indexOf(
      "onRuntimeStopped: (stoppedPluginId) =>",
      revokeAt,
    );
    const disableCleanupAt = disable.indexOf(
      "pluginSurfaces.stop({",
      stoppedHookAt,
    );
    const cleanupKindAt = disable.indexOf('kind: "plugin",', disableCleanupAt);
    const cleanupWorkspaceAt = disable.indexOf("workspaceId,", cleanupKindAt);
    const cleanupPluginAt = disable.indexOf(
      "pluginId: stoppedPluginId,",
      cleanupWorkspaceAt,
    );
    const cleanupEndAt = disable.indexOf("}),", cleanupPluginAt);
    const resultReturnAt = disable.indexOf("return result;", cleanupEndAt);

    expect(disableCallAt).toBeGreaterThan(-1);
    expect(revokeHookAt).toBeGreaterThan(disableCallAt);
    expect(revokeAt).toBeGreaterThan(revokeHookAt);
    expect(stoppedHookAt).toBeGreaterThan(revokeAt);
    expect(disableCleanupAt).toBeGreaterThan(stoppedHookAt);
    expect(cleanupKindAt).toBeGreaterThan(disableCleanupAt);
    expect(cleanupWorkspaceAt).toBeGreaterThan(cleanupKindAt);
    expect(cleanupPluginAt).toBeGreaterThan(cleanupWorkspaceAt);
    expect(cleanupEndAt).toBeGreaterThan(cleanupPluginAt);
    expect(resultReturnAt).toBeGreaterThan(cleanupEndAt);
    expect(disable).not.toContain("void pluginSurfaces.stop");
  });

  it("routes every uninstall runtime revocation through the owner before successful physical teardown", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf("await pipeline.uninstall(");
    const revokeHookAt = uninstall.indexOf(
      "onWillStopRuntime: (pluginId) =>",
      uninstallCallAt,
    );
    const revokeAt = uninstall.indexOf(
      "pluginSurfaces.revokePluginSdkGrants({",
      revokeHookAt,
    );
    const revokeWorkspaceAt = uninstall.indexOf(
      "workspaceId: input.workspaceId,",
      revokeAt,
    );
    const revokePluginAt = uninstall.indexOf("pluginId,", revokeWorkspaceAt);
    const revokeEndAt = uninstall.indexOf("}),", revokePluginAt);
    const stoppedHookAt = uninstall.indexOf(
      "onRuntimeStopped: (pluginId) =>",
      revokeEndAt,
    );
    const stoppedCleanupAt = uninstall.indexOf(
      "pluginSurfaces.stop({",
      stoppedHookAt,
    );
    const stoppedPluginAt = uninstall.indexOf("pluginId,", stoppedCleanupAt);
    const stoppedEndAt = uninstall.indexOf("}),", stoppedPluginAt);
    const removedAt = uninstall.indexOf(
      "const removedLastClaimant =",
      stoppedEndAt,
    );
    const uninstallCleanupAt = uninstall.indexOf(
      "pluginSurfaces.stop({",
      removedAt,
    );
    expect(uninstallCallAt).toBeGreaterThan(-1);
    expect(revokeHookAt).toBeGreaterThan(uninstallCallAt);
    expect(revokeAt).toBeGreaterThan(revokeHookAt);
    expect(revokeWorkspaceAt).toBeGreaterThan(revokeAt);
    expect(revokePluginAt).toBeGreaterThan(revokeWorkspaceAt);
    expect(revokeEndAt).toBeGreaterThan(revokePluginAt);
    expect(stoppedHookAt).toBeGreaterThan(revokeEndAt);
    expect(stoppedCleanupAt).toBeGreaterThan(stoppedHookAt);
    expect(stoppedPluginAt).toBeGreaterThan(stoppedCleanupAt);
    expect(stoppedEndAt).toBeGreaterThan(stoppedPluginAt);
    expect(removedAt).toBeGreaterThan(stoppedEndAt);
    expect(uninstallCleanupAt).toBeGreaterThan(removedAt);
    expect(uninstall).not.toContain("void pluginSurfaces.stop");
  });

  it("lets the normal host lifecycle own rebuild stop and successor readiness", () => {
    const rebuild = sourceBlock(
      "pluginAction(CHANNELS.rebuildPlugin,",
      "\n\n  ipcMain.handle(CHANNELS.pluginUninstallPreflight",
    );
    expect(squeeze(rebuild)).toContain(
      "pluginAction(CHANNELS.rebuildPlugin,(pipeline,pluginId)=>pipeline.rebuild(pluginId));",
    );
    expect(rebuild).not.toContain("onOldRuntimeStopped");
    expect(rebuild).not.toContain("pluginSurfaces.");
  });

  it("does not warm a pipeline after a later workspace switch wins", () => {
    const open = handler("openWorkspace");
    const awaitAt = open.indexOf("await openWorkspaceActivity(workspace)");
    const recheckAt = open.indexOf(
      "const stillActive = activeWorkspaceIdBySender.get(senderId) === workspace.workspaceId;",
      awaitAt,
    );
    const warmAt = open.indexOf("await ensurePluginPipeline(workspace)", recheckAt);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(awaitAt);
    expect(warmAt).toBeGreaterThan(recheckAt);
    expect(open).toContain("stillActive && !sharedViewOf(workspace.workspaceId)");
  });

  it("keeps last-window policy around destroyed and switched senders", () => {
    const open = handler("openWorkspace");
    const switchedGateAt = open.indexOf(
      "!isWorkspaceOpenInAnyWindow(previousWorkspaceId)",
    );
    const switchedStopAt = open.indexOf(
      "await stopPluginWorkspace(previousWorkspaceId);",
      switchedGateAt,
    );
    const destroyedAt = open.indexOf('event.sender.once("destroyed"');
    const surfaceAt = open.indexOf(
      'const pluginSurfaceStop = pluginSurfaces.stop({ kind: "sender", senderId });',
      destroyedAt,
    );
    const deleteAt = open.indexOf("activeWorkspaceIdBySender.delete(senderId);", surfaceAt);
    const awaitAt = open.indexOf("await pluginSurfaceStop;", deleteAt);
    const finallyAt = open.indexOf("} finally {", awaitAt);
    const lastWindowAt = open.indexOf(
      "if (activeWorkspaceId && !isWorkspaceOpenInAnyWindow(activeWorkspaceId)) {",
      finallyAt,
    );
    expect(switchedGateAt).toBeGreaterThan(-1);
    expect(switchedStopAt).toBeGreaterThan(switchedGateAt);
    expect(surfaceAt).toBeGreaterThan(destroyedAt);
    expect(deleteAt).toBeGreaterThan(surfaceAt);
    expect(awaitAt).toBeGreaterThan(deleteAt);
    expect(finallyAt).toBeGreaterThan(awaitAt);
    expect(lastWindowAt).toBeGreaterThan(finallyAt);
  });

  it("bumps generation before stopping a switching or reloading sender", () => {
    const open = handler("openWorkspace");
    const switchAt = open.indexOf(
      "if (previousWorkspaceId && previousWorkspaceId !== workspace.workspaceId) {",
    );
    const bumpAt = open.indexOf("advanceRendererGeneration(senderId);", switchAt);
    const stopAt = open.indexOf(
      'await pluginSurfaces.stop({ kind: "sender", senderId });',
      bumpAt,
    );
    const setAt = open.indexOf(
      "activeWorkspaceIdBySender.set(senderId, workspace.workspaceId);",
      stopAt,
    );
    expect(switchAt).toBeGreaterThan(-1);
    expect(bumpAt).toBeGreaterThan(switchAt);
    expect(stopAt).toBeGreaterThan(bumpAt);
    expect(setAt).toBeGreaterThan(stopAt);

    const reload = functionSource("async function prepareForRendererReload(");
    const reloadBumpAt = reload.indexOf("advanceRendererGeneration(senderId);");
    const reloadStopAt = reload.indexOf(
      'pluginSurfaces.stop({ kind: "sender", senderId })',
      reloadBumpAt,
    );
    const exclusionAt = reload.indexOf(
      "isWorkspaceOpenInAnyWindow(activeWorkspaceId, senderId)",
      reloadStopAt,
    );
    expect(reloadBumpAt).toBeGreaterThan(-1);
    expect(reloadStopAt).toBeGreaterThan(reloadBumpAt);
    expect(exclusionAt).toBeGreaterThan(reloadStopAt);
  });

});
