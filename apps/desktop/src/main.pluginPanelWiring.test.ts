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

  it("starts panel previews from the exact active host declaration", () => {
    const start = functionSource("async function startPluginPanelPreview(");
    const snapshotAt = start.indexOf(
      "pluginSnapshotRoot(input.workspace, input.pluginId)",
    );
    const previewAt = start.indexOf(
      "startStaticDirectoryPreview(dirname(entryPath)",
      snapshotAt,
    );
    expect(previewAt).toBeGreaterThan(snapshotAt);
    expect(start).toContain(
      "const entryPath = join(snapshotRoot, input.panel.entry);",
    );

    const registration = sourceBlock(
      "registerPluginIpcHandlers<",
      "\n  });",
    );
    expect(registration).toContain(
      "createPanelHostLease: createPluginPanelSurfaceHostLease,",
    );
    expect(registration).toContain(
      "startPanelPreview: startPluginPanelPreview,",
    );
  });

  it("sends panel invalidation only to the exact renderer generation", () => {
    const notify = functionSource("function notifyPluginPanelInvalidated(");
    const destroyedAt = notify.indexOf("sender.isDestroyed()");
    const generationAt = notify.indexOf(
      "rendererGeneration(sender.id) !== generation",
      destroyedAt,
    );
    const parseAt = notify.indexOf(
      "PluginPanelInvalidatedEvent.parse(event)",
      generationAt,
    );
    const sendAt = notify.indexOf("sender.send(", generationAt);
    expect(destroyedAt).toBeGreaterThan(-1);
    expect(generationAt).toBeGreaterThan(destroyedAt);
    expect(sendAt).toBeGreaterThan(generationAt);
    expect(parseAt).toBeGreaterThan(sendAt);

    const surfaces = sourceBlock(
      "const pluginSurfaces = new PluginSurfaces<WebContentsView>({",
      "\n});",
    );
    expect(surfaces).toContain(
      "notifyPanelInvalidated: ({ senderId, generation, ...event }) => {",
    );
    expect(surfaces).toContain("webContents.fromId(senderId)");
    expect(surfaces).toContain(
      "notifyPluginPanelInvalidated(sender, generation, event)",
    );
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

  it("awaits surface cleanup when a watched plugin identity departs", () => {
    const createPipeline = functionSource("function createPluginPipeline(");
    const pipelineAt = createPipeline.indexOf("pipeline = new PluginPipeline({");
    const hookAt = createPipeline.indexOf(
      "onRuntimeStopped: (pluginId) =>",
      pipelineAt,
    );
    const stopAt = createPipeline.indexOf("pluginSurfaces.stop({", hookAt);
    expect(hookAt).toBeGreaterThan(pipelineAt);
    expect(stopAt).toBeGreaterThan(hookAt);
    expect(squeeze(createPipeline.slice(stopAt, stopAt + 180))).toContain(
      'kind:"plugin",workspaceId:workspace.workspaceId,pluginId,',
    );
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

    const panelAdapter = functionSource(
      "function createPluginPanelSurfaceHostLease(",
    );
    const startPanelAt = panelAdapter.indexOf("startPanel: async (panelId) => {");
    const panelStartAt = panelAdapter.indexOf(
      "const spawnId = await lease.start();",
      startPanelAt,
    );
    const snapshotAt = panelAdapter.indexOf(
      "host.readyPanelsForSpawn(pluginId, spawnId)",
      panelStartAt,
    );
    const declarationAt = panelAdapter.indexOf(
      "ready?.panels.find((candidate) => candidate.id === panelId)",
      snapshotAt,
    );
    expect(startPanelAt).toBeGreaterThan(-1);
    expect(panelStartAt).toBeGreaterThan(startPanelAt);
    expect(snapshotAt).toBeGreaterThan(panelStartAt);
    expect(declarationAt).toBeGreaterThan(snapshotAt);
    expect(panelAdapter).toContain(
      "return { spawnId, hostRecord: ready.record, panel };",
    );
  });

  it("revokes surfaces synchronously when the exact host spawn ends", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const spawnEndAt = pipeline.indexOf("onSpawnEnd: (pluginId, spawnId) => {");
    const changedAt = pipeline.indexOf(
      "surfaceHostLifecycle?.spawnEnded(pluginId);",
      spawnEndAt,
    );
    const cleanupAt = pipeline.indexOf("pluginDrivers.endSpawn(pluginId, spawnId);", changedAt);
    const returnAt = pipeline.indexOf(
      "return childProcessBroker.disposeSpawn(pluginId, spawnId);",
      cleanupAt,
    );
    expect(pipeline).toContain("utilityProcess.fork(");
    expect(spawnEndAt).toBeGreaterThan(-1);
    expect(changedAt).toBeGreaterThan(spawnEndAt);
    expect(cleanupAt).toBeGreaterThan(changedAt);
    expect(returnAt).toBeGreaterThan(cleanupAt);
    expect(pipeline.slice(spawnEndAt, returnAt)).not.toContain("await ");
  });

  it("routes host statuses through the surface lifecycle", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const statusAt = pipeline.indexOf("onStatusChange: (pluginId, status) => {");
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle?.statusChanged(pluginId, status);",
      statusAt,
    );
    expect(statusAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(statusAt);
  });

  it("routes host recovery outcomes through the surface lifecycle", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const recoveryAt = pipeline.indexOf(
      "onRecoveryDisposition: (pluginId, disposition) => {",
    );
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle?.recoveryDisposition(pluginId, disposition);",
      recoveryAt,
    );
    expect(recoveryAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(recoveryAt);
  });

  it("composes host status with the pipeline and plugin surfaces once", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle = new PluginSurfaceHostLifecycle({",
    );
    const hostAt = pipeline.indexOf("host: pluginHost,", lifecycleAt);
    const surfacesAt = pipeline.indexOf("surfaces: pluginSurfaces,", hostAt);
    const statusAt = pipeline.indexOf(
      "pipeline?.noteRuntimeStatus(pluginId, status)",
      surfacesAt,
    );
    expect(lifecycleAt).toBeGreaterThan(-1);
    expect(hostAt).toBeGreaterThan(lifecycleAt);
    expect(surfacesAt).toBeGreaterThan(hostAt);
    expect(statusAt).toBeGreaterThan(surfacesAt);
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
    const invoke = functionSource("async function routePluginPanelSdk(");
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
