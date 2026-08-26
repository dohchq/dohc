import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

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
  it("forwards watcher batches to the matching workspace runtime", () => {
    const batch = sourceBlock("onWatcherBatch: (workspace, events) => {", "\n  },");
    expect(batch).toContain("withWorkspaceAttachment(workspace, () =>");
    expect(batch).toMatch(
      /pluginWorkspaceRuntimes\.current\(workspace\.workspaceId\)\s*\?\.handleWatcherEvents\(events\),/,
    );
  });

  it("validates panel SDK events and sends them only to the active workspace", () => {
    const notify = functionSource("function notifyPluginPanelSdkEvent(");
    const parseAt = notify.indexOf("PluginPanelSdkEvent.safeParse(event)");
    const filterAt = notify.indexOf(
      "rendererWorkspaceSessions.current(win.webContents)?.workspaceId",
      parseAt,
    );
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
      "rendererWorkspaceSessions.current(sender)?.generation !== generation",
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
      "function createPluginSurfaces(",
      "\n}\n",
    );
    const panelCallbackAt = surfaces.indexOf("notifyPanelInvalidated:");
    const attachmentAt = surfaces.indexOf(
      "attachmentId: binding.attachmentId,",
      panelCallbackAt,
    );
    const notifyAt = surfaces.indexOf(
      "notifyPluginPanelInvalidated(sender, generation, event)",
      attachmentAt,
    );
    expect(surfaces).toContain(
      "notifyPanelInvalidated: ({ senderId, generation, ...event }) => {",
    );
    expect(surfaces).toContain("webContents.fromId(senderId)");
    expect(panelCallbackAt).toBeGreaterThan(-1);
    expect(attachmentAt).toBeGreaterThan(panelCallbackAt);
    expect(notifyAt).toBeGreaterThan(attachmentAt);
  });


  it("wires authored text to this invocation's signal, capture, and pipeline", () => {
    const router = functionSource("function invokeWorkspacePluginSdk");
    const writerAt = router.indexOf("writeAuthoredText: createPluginAuthoredTextWriter({");
    expect(writerAt).toBeGreaterThan(-1);
    expect(router.indexOf("signal,", writerAt)).toBeGreaterThan(writerAt);
    expect(
      router.indexOf(
        "await requirePluginEngineCaptureForOperation(operation);",
        writerAt,
      ),
    ).toBeGreaterThan(writerAt);
    expect(
      router.indexOf(
        "operation.state.pluginRuntimes.current(input.workspaceId)?.pipeline",
        writerAt,
      ),
    ).toBeGreaterThan(writerAt);
  });

  it("routes runtime status through the validated main-process notifier", () => {
    const owner = sourceBlock(
      "function createDesktopWorkspaceAuthorityState(",
      "\n}\n",
    );
    const statusAt = owner.indexOf("onPipelineStatus: (workspaceId, event) => {");
    const attachmentAt = owner.indexOf(
      "attachmentId: binding.attachmentId",
      statusAt,
    );
    const notifyAt = owner.indexOf(
      "notifyPluginStatusChanged(workspaceId, event)",
      attachmentAt,
    );
    expect(statusAt).toBeGreaterThan(-1);
    expect(attachmentAt).toBeGreaterThan(statusAt);
    expect(notifyAt).toBeGreaterThan(attachmentAt);
  });

  it("constructs one owner for the pipeline and its exact host", () => {
    const createPipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
    expect(createPipeline).toContain(
      "const surfaces = authorityLease.state.pluginSurfaces;",
    );
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
    const createPipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
    const pipelineAt = createPipeline.indexOf("pipeline = new PluginPipeline({");
    const hookAt = createPipeline.indexOf(
      "onRuntimeStopped: (pluginId) =>",
      pipelineAt,
    );
    const stopAt = createPipeline.indexOf("surfaces.stop({", hookAt);
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
    const pipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
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
    const pipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
    const statusAt = pipeline.indexOf("onStatusChange: (pluginId, status) => {");
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle?.statusChanged(pluginId, status)",
      statusAt,
    );
    expect(statusAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(statusAt);
  });

  it("routes host recovery outcomes through the surface lifecycle", () => {
    const pipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
    const recoveryAt = pipeline.indexOf(
      "onRecoveryDisposition: (pluginId, disposition) => {",
    );
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle?.recoveryDisposition(pluginId, disposition)",
      recoveryAt,
    );
    expect(recoveryAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(recoveryAt);
  });

  it("composes host status with the pipeline and plugin surfaces once", () => {
    const pipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
    const capturedSurfacesAt = pipeline.indexOf(
      "const surfaces = authorityLease.state.pluginSurfaces;",
    );
    const lifecycleAt = pipeline.indexOf(
      "surfaceHostLifecycle = new PluginSurfaceHostLifecycle({",
    );
    const hostAt = pipeline.indexOf("host: pluginHost,", lifecycleAt);
    const surfacesAt = pipeline.indexOf("surfaces,", hostAt);
    const statusAt = pipeline.indexOf(
      "pipeline?.noteRuntimeStatus(pluginId, status)",
      surfacesAt,
    );
    expect(capturedSurfacesAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(capturedSurfacesAt);
    expect(hostAt).toBeGreaterThan(lifecycleAt);
    expect(surfacesAt).toBeGreaterThan(hostAt);
    expect(statusAt).toBeGreaterThan(surfacesAt);
  });

  it("passes the derived plugin-host environment to the utility process", () => {
    const pipeline = functionSource("function createPluginWorkspaceRuntimeParts(");
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
    const owner = sourceBlock(
      "function createDesktopWorkspaceAuthorityState(",
      "\n}\n",
    );
    expect(owner).toContain(
      "rendererWorkspaceSessions.isAttachmentOpen(binding.attachmentId)",
    );
  });

  it("does not warm a pipeline after a later workspace switch wins", () => {
    const open = handler("openWorkspace");
    const awaitAt = open.indexOf("await openWorkspaceActivityForOperation(");
    const recheckAt = open.indexOf("rendererSession.isCurrent()", awaitAt);
    const warmAt = open.indexOf(
      "void withPhysicalWorkspaceOperation(workspace.workspaceId, (warmup) =>",
      recheckAt,
    );
    const ensureAt = open.indexOf(
      "warmup.state.pluginRuntimes.ensure(warmup.workspace)",
      warmAt,
    );
    expect(awaitAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(awaitAt);
    expect(warmAt).toBeGreaterThan(recheckAt);
    expect(ensureAt).toBeGreaterThan(warmAt);
    expect(open.indexOf("if (!sharedViewOf(workspace.workspaceId))", recheckAt))
      .toBeGreaterThan(recheckAt);
  });

});
