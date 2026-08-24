import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPluginPanelFileWatchEmitter } from "./plugins/pluginPanelSdkEvent";

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

const stopPluginPanelSource = () =>
  functionSource("async function stopPluginPanel(");

describe("plugin panel main-process wiring", () => {
  it("forwards watcher batches to the matching plugin pipeline and workspace events", () => {
    const watcherBatch = sourceBlock(
      "onWatcherBatch: (workspace, events) => {",
      "\n  },",
    );

    expect(watcherBatch).toContain(
      "pluginPipelines.get(workspace.workspaceId)?.handleWatcherEvents(events);",
    );
    expect(watcherBatch).toMatch(
      /pluginWorkspaceEventsByWorkspace\s*\.get\(workspace\.workspaceId\)\s*\?\.handleWatcherEvents\(events\);/,
    );
  });

  it("drops file-watch events after the exact panel stops running", () => {
    let panelRunning = true;
    const send = vi.fn();
    const emitEvent = createPluginPanelFileWatchEmitter({
      workspaceId: "ws-plugins",
      pluginId: "sites",
      panelId: "main",
      isPanelRunning: () => panelRunning,
      send,
    });
    const data = { path: "docs/index.md", operation: "update" as const };

    emitEvent("subscription-1", "change", data);
    panelRunning = false;
    emitEvent("subscription-1", "change", data);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      workspaceId: "ws-plugins",
      pluginId: "sites",
      panelId: "main",
      subscriptionId: "subscription-1",
      event: "change",
      data,
    });
  });

  it("validates panel SDK events and sends them only to the active workspace", () => {
    const notify = functionSource("function notifyPluginPanelSdkEvent(");
    const parseAt = notify.indexOf("PluginPanelSdkEvent.safeParse(event)");
    const filterAt = notify.indexOf("activeWorkspaceIdBySender.get(");
    const sendAt = notify.indexOf(
      "win.webContents.send(CHANNELS.pluginPanelSdkEvent, payload.data)",
    );

    expect(parseAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(parseAt);
    expect(sendAt).toBeGreaterThan(filterAt);
    expect(notify).toContain("if (!payload.success)");
    expect(notify).toContain("console.error(");
  });

  it("validates and remembers a contained panel without starting its host", () => {
    const open = handler("openPluginPanel");
    const loadAt = open.indexOf(
      "loadPluginPanelRegistrationForCurrentRenderer(",
    );
    const currentAt = open.indexOf("isCurrent,", loadAt);
    const rememberAt = open.indexOf("rememberPluginRegistration(");

    expect(loadAt).toBeGreaterThan(-1);
    expect(currentAt).toBeGreaterThan(loadAt);
    expect(currentAt).toBeLessThan(rememberAt);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(open).toContain("assertPluginPanelRequestCurrent(isCurrent);");
    expect(open).not.toContain("ensurePluginStarted(");
    expect(open).not.toContain("acquirePluginSurfaceLease(");
    expect(open).toContain(
      "pluginRegistration: pluginPipelines.get(workspace.workspaceId),",
    );
  });

  it("rejects an open whose renderer generation changes while the pipeline starts", () => {
    const open = handler("openPluginPanel");
    const pipelineAt = open.indexOf(
      "const { pipeline } = await activePluginPipelineFor(event, input.workspaceId);",
    );
    const currentAt = open.indexOf(
      "assertPluginPanelRequestCurrent(isCurrent);",
      pipelineAt,
    );
    const rememberAt = open.indexOf("rememberPluginRegistration(", pipelineAt);

    expect(pipelineAt).toBeGreaterThan(-1);
    expect(currentAt).toBeGreaterThan(pipelineAt);
    expect(rememberAt).toBeGreaterThan(currentAt);
  });

  it("serves the manifest panel and grants only main-derived SDK context", () => {
    const start = handler("startPluginPanel");
    const serveAt = start.indexOf("startStaticDirectoryPreview(dirname(entryPath)");
    const allowAt = start.indexOf("allowLoopbackFrameOrigin(handle.url)");
    const rememberAt = start.indexOf("runningPluginPanels.set(key");
    const grantAt = start.indexOf("registerPluginPanelGrant({");

    expect(serveAt).toBeGreaterThan(-1);
    expect(allowAt).toBeGreaterThan(serveAt);
    expect(rememberAt).toBeGreaterThan(allowAt);
    expect(grantAt).toBeGreaterThan(rememberAt);

    const grantFn = functionSource("function registerPluginPanelGrant(");
    const registerAt = grantFn.indexOf("pluginPanelSdkAuthorities.register(input)");
    const disposeAt = grantFn.indexOf(".disposeOwner({", registerAt);
    expect(registerAt).toBeGreaterThan(-1);
    expect(disposeAt).toBeGreaterThan(registerAt);
    expect(grantFn).toContain("grant.signal.addEventListener(");
    expect(start).toContain("withPluginPanelStartLock(key");
    expect(start).toContain("hostLease.start((authority)");
    expect(start).toContain("await stopRunningPluginPanelPreview(previous);");

    const stop = stopPluginPanelSource();
    expect(stop).toContain("withPluginPanelStartLock(key");
    expect(stop).toContain("await stopRunningPluginPanelPreview(panel);");
    expect(stop).toContain("await panel.hostLease.release();");
  });

  it("discards a panel when its host changes while the preview starts", () => {
    const start = handler("startPluginPanel");
    const spawnAt = start.indexOf("const spawnId = host.getSpawnId(input.pluginId);");
    const previewAt = start.indexOf("handle = await startStaticDirectoryPreview(", spawnAt);
    const recheckAt = start.indexOf(
      "host.getSpawnId(input.pluginId) !== spawnId",
      previewAt,
    );
    const installAt = start.indexOf("runningPluginPanels.set(key, next);", recheckAt);
    const grantAt = start.indexOf("registerPluginPanelGrant({", installAt);
    const catchAt = start.indexOf("} catch (error) {", grantAt);
    const pendingPreviewAt = start.indexOf("} else if (handle) {", catchAt);
    const pendingPreviewStopAt = start.indexOf(
      "await stopRunningPluginPanelPreview({",
      pendingPreviewAt,
    );
    const releaseAt = start.indexOf("await hostLease.release();", pendingPreviewStopAt);

    // A disable, rebuild, or close can replace the spawn during the preview
    // await. The exact-spawn check throws before either durable surface
    // effect; the shared catch then stops the pending preview and releases
    // this start's lease.
    expect(spawnAt).toBeGreaterThan(-1);
    expect(previewAt).toBeGreaterThan(spawnAt);
    expect(recheckAt).toBeGreaterThan(previewAt);
    expect(installAt).toBeGreaterThan(recheckAt);
    expect(grantAt).toBeGreaterThan(installAt);
    expect(catchAt).toBeGreaterThan(grantAt);
    expect(pendingPreviewAt).toBeGreaterThan(catchAt);
    expect(pendingPreviewStopAt).toBeGreaterThan(pendingPreviewAt);
    expect(releaseAt).toBeGreaterThan(pendingPreviewStopAt);
  });

  it("starts a panel only where its manifest places it, and serves a view with no tab (B1)", () => {
    const start = handler("startPluginPanel");
    const panelAt = start.indexOf("plugin.manifest.panels?.find(");
    const placementAt = start.indexOf("panel.placement !== input.placement");
    const lockAt = start.indexOf("withPluginPanelStartLock(key");

    // MUTATION (stale tab): without this check a tab restored from before an
    // update mounts a panel the plugin has since moved to the view rail, and
    // the two mounts stop each other over one panel key.
    expect(panelAt).toBeGreaterThan(-1);
    expect(placementAt).toBeGreaterThan(panelAt);
    expect(placementAt).toBeLessThan(lockAt);

    // A rail view opens no tab, so nothing fills the registration map for it.
    // registeredPlugin must still resolve from the pipeline's own discovery,
    // or a view-only plugin's panel can never start. The precedence itself
    // (pipeline first, remembered registration as fallback) is pinned
    // behaviorally in pluginPanelRegistration.test.ts; this only pins that
    // both sources are still wired in. Behavior is pinned end to end by
    // e2e/plugin-panel.spec.ts.
    const lookup = functionSource("function registeredPlugin(");
    expect(lookup).toContain("resolveRegisteredPlugin(");
    expect(lookup).toContain("pluginPipelines.get(workspaceId)");
    expect(lookup).toContain("pluginRegistrations.get(workspaceId)");
  });

  it("authorizes panel SDK calls before routing them through the plugin host", () => {
    const invoke = handler("invokePluginPanelSdk");
    const authorizeAt = invoke.indexOf("pluginPanelSdkAuthorities.authorize({");
    const routeAt = invoke.indexOf("invokeWorkspacePluginSdk({");
    const router = functionSource("function invokeWorkspacePluginSdk");
    const requestLiveAt = invoke.indexOf(
      "const panelRunning = isPluginPanelRequestLive({",
    );
    const requestLiveEnd = invoke.indexOf("\n    });", requestLiveAt);
    const requestLive = invoke.slice(requestLiveAt, requestLiveEnd);
    const emitterAt = invoke.indexOf("createPluginPanelFileWatchEmitter({");
    const emitterEnd = invoke.indexOf(
      "send: notifyPluginPanelSdkEvent,",
      emitterAt,
    );
    const emitter = invoke.slice(emitterAt, emitterEnd);

    expect(authorizeAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(authorizeAt);
    expect(invoke).toContain("const liveSpawnId = host?.getSpawnId(input.pluginId);");
    expect(invoke).toContain("liveSpawnId,");
    expect(requestLiveAt).toBeGreaterThan(-1);
    expect(requestLiveEnd).toBeGreaterThan(requestLiveAt);
    expect(requestLive).toContain("liveSpawnId,");
    expect(emitterAt).toBeGreaterThan(-1);
    expect(emitterEnd).toBeGreaterThan(emitterAt);
    // The pure tests pin each predicate's rules. These checks stop the invoke
    // and push paths from silently swapping those rules.
    expect(emitter).toContain("isPluginPanelPushLive({");
    expect(emitter).not.toContain("isPluginPanelRequestLive({");
    expect(emitter).not.toContain("spawnId");
    expect(invoke).toContain(
      "workspaceEvents.subscribe({ owner, emitEvent }, watchParams)",
    );
    expect(invoke).toContain(
      "workspaceEvents.unsubscribe({ owner }, watchParams)",
    );
    expect(router).toContain("return invokePluginSdkHost(");
  });

  it("routes plugin commands through the declared-command guard", () => {
    const invoke = handler("invokePluginCommand");
    const currentAt = invoke.indexOf("activeWorkspaceIdBySender.get(");
    const pipelineAt = invoke.indexOf("const pipeline = await ensurePluginPipeline(workspace);");
    const lookupAt = invoke.indexOf("registeredPlugin(");
    const routeAt = invoke.indexOf("invokeRegisteredPluginCommand({");
    const ownerAt = invoke.indexOf("pipeline.hostOwnership.runCommand(", routeAt);
    const startAt = invoke.indexOf("command.start(() =>", ownerAt);

    expect(currentAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(currentAt);
    expect(lookupAt).toBeGreaterThan(pipelineAt);
    expect(routeAt).toBeGreaterThan(lookupAt);
    expect(ownerAt).toBeGreaterThan(routeAt);
    expect(startAt).toBeGreaterThan(ownerAt);
    expect(invoke).toContain("assertWritableWorkspace(workspace);");
    expect(invoke).not.toContain("activeCommandClaims");
  });

  it("wires the production authored-text writer with this invocation's own signal and pipeline (CERT779L D1)", () => {
    const router = functionSource("function invokeWorkspacePluginSdk");
    const writerAt = router.indexOf(
      "writeAuthoredText: createPluginAuthoredTextWriter({",
    );
    const signalAt = router.indexOf("signal: input.signal,", writerAt);
    const captureAt = router.indexOf(
      "await requirePluginEngineCapture(input.workspaceId);",
      writerAt,
    );
    const writableAt = router.indexOf(
      "assertWritableWorkspace(workspaceForWrite);",
      writerAt,
    );
    const pipelineAt = router.indexOf(
      "pipeline: () => pluginPipelines.get(input.workspaceId),",
      writerAt,
    );

    // What the writer does with these — the aborted precheck, the signal
    // handed to the capture's write, and the door-write notification into the
    // owning plugin's pipeline — is pinned by behavior in
    // pluginAuthoredWrite.test.ts. This asserts only that main.ts hands the
    // factory this invocation's real signal, capture, and pipeline.
    expect(writerAt).toBeGreaterThan(-1);
    expect(signalAt).toBeGreaterThan(writerAt);
    expect(captureAt).toBeGreaterThan(writerAt);
    expect(writableAt).toBeGreaterThan(captureAt);
    expect(pipelineAt).toBeGreaterThan(writerAt);
  });

  it("releases a removed identity's registration from the status-event path (#779 round 14 A5)", () => {
    // What forgetRemovedPlugin does is pinned by behavior in
    // pluginPanelRegistration.test.ts. This asserts only that main.ts's
    // status-event handler calls it before the schema guard that protects
    // the renderer send, so a departed identity (a rename, not an
    // uninstall) still releases its registration.
    const notifyStart = mainSource.indexOf("function notifyPluginStatusChanged(");
    const notifyEnd = mainSource.indexOf("\n}\n", notifyStart);
    expect(notifyEnd).toBeGreaterThan(-1);
    const notify = mainSource.slice(notifyStart, notifyEnd);
    const forgetAt = notify.indexOf("forgetRemovedPlugin({");
    const guardAt = notify.indexOf("PluginStatusChangedEvent.safeParse(");

    expect(forgetAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(forgetAt);
    expect(notify).toContain("registrations: pluginRegistrations,");
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
    expect(workspaceOpen).toContain(
      "await stopPluginWorkspace(activeWorkspaceId).catch((error: unknown) => {",
    );
    expect(workspaceOpen).toContain("await stopPluginWorkspace(previousWorkspaceId);");
    expect(willQuit).toContain("pluginPanelSdkAuthorities.revokeAll();");
    expect(willQuit).toContain("const pluginStop = stopAllPluginWorkspaces();");
  });

  it("passes the derived plugin-host environment to the production utility process", () => {
    const pipeline = functionSource("function createPluginPipeline(");
    const spawnAt = pipeline.indexOf("spawnTransport: (callbacks) => {");
    const spawnEnd = pipeline.indexOf("\n    },", spawnAt);
    const spawnTransport = pipeline.slice(spawnAt, spawnEnd);
    const environmentBinding = /const\s+(\w+)\s*=\s*pluginHostEnvFor\(/.exec(
      spawnTransport,
    )?.[1];
    const forkAt = spawnTransport.indexOf("utilityProcess.fork(");
    const forkEnd = spawnTransport.indexOf("\n      );", forkAt);
    const fork = spawnTransport.slice(forkAt, forkEnd);

    expect(spawnAt).toBeGreaterThan(-1);
    expect(spawnEnd).toBeGreaterThan(spawnAt);
    expect(environmentBinding).toBeDefined();
    expect(forkAt).toBeGreaterThan(-1);
    expect(forkEnd).toBeGreaterThan(forkAt);
    expect(fork).toContain(`env: ${environmentBinding},`);
  });

  it("derives panel writability from the current workspace on every invocation", () => {
    const invoke = handler("invokePluginPanelSdk");

    expect(invoke).not.toContain("writable: authority.writable");
    expect(invoke).toContain("isWritable: () => !sharedViewOf(authority.workspaceId)");
  });

  it("skips plugin-pipeline warmup when a later openWorkspace switched away first (#779 round 4 finding 1)", () => {
    const open = handler("openWorkspace");
    const statusAt = open.indexOf("const status = SyncStatusResult.parse(");
    const awaitAt = open.indexOf("await openWorkspaceActivity(workspace),", statusAt);
    const recheckAt = open.indexOf(
      "const stillActive = activeWorkspaceIdBySender.get(senderId) === workspace.workspaceId;",
      awaitAt,
    );
    const warmupAt = open.indexOf("await ensurePluginPipeline(workspace)", recheckAt);

    // MUTATION (open race): without a recheck after the await, a sender that
    // switched workspaces while this call's openWorkspaceActivity was still
    // pending would warm the plugin pipeline for the workspace it just left
    // instead of the one it is actually on now.
    expect(statusAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(statusAt);
    expect(recheckAt).toBeGreaterThan(awaitAt);
    expect(warmupAt).toBeGreaterThan(recheckAt);
    expect(open).toContain("stillActive && !sharedViewOf(workspace.workspaceId)");
  });

  it("gives each running panel record its own host lease", () => {
    const stop = stopPluginPanelSource();
    const removeAt = stop.indexOf("runningPluginPanels.delete(key);");
    const previewAt = stop.indexOf("await stopRunningPluginPanelPreview(panel);");
    const releaseAt = stop.indexOf("await panel.hostLease.release();");

    expect(stop).toContain("withPluginPanelStartLock(key");
    expect(removeAt).toBeGreaterThan(-1);
    expect(previewAt).toBeGreaterThan(removeAt);
    expect(releaseAt).toBeGreaterThan(previewAt);
    expect(stop).not.toContain(".host.stop(");

    const start = handler("startPluginPanel");
    const acquireAt = start.indexOf("acquirePluginSurfaceLease(");
    const ownerAt = start.indexOf("pipeline.hostOwnership", acquireAt);
    const startAt = start.indexOf("hostLease.start((authority)");
    const installAt = start.indexOf("runningPluginPanels.set(key, next)");
    const displacedReleaseAt = start.indexOf("await previous.hostLease.release();");

    expect(acquireAt).toBeGreaterThan(-1);
    expect(ownerAt).toBeGreaterThan(acquireAt);
    expect(startAt).toBeGreaterThan(acquireAt);
    expect(installAt).toBeGreaterThan(startAt);
    expect(displacedReleaseAt).toBeGreaterThan(installAt);
  });

  it("releases a panel start's lease when no record survives", () => {
    const start = handler("startPluginPanel");
    const catchAt = start.indexOf("} catch (error) {");
    const exactRecordAt = start.indexOf(
      "runningPluginPanels.get(key) === installed",
      catchAt,
    );
    const releaseAt = start.indexOf("await hostLease.release();", exactRecordAt);
    const throwAt = start.indexOf("throw error;", releaseAt);

    expect(catchAt).toBeGreaterThan(-1);
    expect(exactRecordAt).toBeGreaterThan(catchAt);
    expect(releaseAt).toBeGreaterThan(exactRecordAt);
    expect(throwAt).toBeGreaterThan(releaseAt);
  });

  it("runs plugin commands through the owner and the command's start authority", () => {
    const invoke = handler("invokePluginCommand");
    const runAt = invoke.indexOf("pipeline.hostOwnership.runCommand(");
    const startAt = invoke.indexOf("command.start(() =>", runAt);
    const ensureAt = invoke.indexOf(
      "pipeline.ensureStarted(input.pluginId, command)",
      startAt,
    );

    expect(runAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(runAt);
    expect(ensureAt).toBeGreaterThan(startAt);
    expect(invoke).not.toContain("activeCommandClaims");
    expect(invoke).not.toContain("finally {");
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
    expect(createPipeline).not.toContain("raiseCommandClaimsBarrier:");
    expect(createPipeline).not.toContain("awaitCommandClaimsDrained:");
  });

  it("passes the pipeline's exact host to the activation-tested start seam", () => {
    const start = handler("startPluginPanel");
    const ensureAt = start.indexOf("ensurePluginStarted(");
    const hostAt = start.indexOf("pipeline.host,", ensureAt);
    const leaseStartAt = start.indexOf("hostLease.start((authority)", hostAt);

    expect(ensureAt).toBeGreaterThan(-1);
    expect(hostAt).toBeGreaterThan(ensureAt);
    expect(leaseStartAt).toBeGreaterThan(hostAt);
  });

  it("refuses to create a plugin pipeline after the last workspace window closes", () => {
    const ensurePipeline = functionSource("async function ensurePluginPipeline(");
    const gateAt = ensurePipeline.indexOf("createOnlyWhile: () =>");
    const checkAt = ensurePipeline.indexOf(
      "isWorkspaceOpenInAnyWindow(workspace.workspaceId)",
      gateAt,
    );

    expect(gateAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(gateAt);
  });

  it("disposes panel records only after disable succeeds", () => {
    const disable = sourceBlock(
      "pluginAction(CHANNELS.disablePlugin,",
      "\n  });",
    );
    const disableCallAt = disable.indexOf(
      "const result = await pipeline.disable(pluginId);",
    );
    const failureReturnAt = disable.indexOf(
      "if (!result.ok) return result;",
      disableCallAt,
    );
    const disableCleanupAt = disable.indexOf(
      "stopPluginPanelsForPlugin(workspaceId, pluginId)",
      failureReturnAt,
    );

    expect(disableCallAt).toBeGreaterThan(-1);
    expect(failureReturnAt).toBeGreaterThan(disableCallAt);
    expect(disableCleanupAt).toBeGreaterThan(failureReturnAt);
  });

  it("disposes a plugin's panel records only once no installed claimant survives uninstall", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.directoryName, input.confirmationToken),",
    );
    const stillInstalledClaimantAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
      uninstallCallAt,
    );
    const uninstallCleanupAt = uninstall.indexOf(
      "stopPluginPanelsForPlugin(input.workspaceId, input.pluginId)",
      stillInstalledClaimantAt,
    );

    // A collision loser's uninstall must never tear down panel records a
    // still-installed winner sharing this id genuinely owns — revoking has
    // to wait for both the pipeline's own result AND proof no installed
    // claimant of this id survives. The gate's own predicate is pinned by
    // name in main.pluginWebAppWiring.test.ts, and its partition-clear
    // sibling is pinned end to end there too.
    expect(uninstallCallAt).toBeGreaterThan(-1);
    expect(stillInstalledClaimantAt).toBeGreaterThan(uninstallCallAt);
    expect(uninstallCleanupAt).toBeGreaterThan(stillInstalledClaimantAt);
  });

  it("revokes a plugin's panel authorities before rebuild replaces its process", () => {
    // Rebuild replaces the runtime instead of stopping it for good, but the
    // old grant is still against a runtime that is gone by the time this
    // fires — it must not straddle into the replacement (#779 round 18
    // finding 3).
    const rebuildAt = mainSource.indexOf(
      "pluginAction(CHANNELS.rebuildPlugin,",
    );
    // Bounded to this one handler's own body: an unbounded forward search
    // for any of these calls can match a same-named call belonging to a
    // different handler further down the file instead of catching a
    // mutation that removed it from here (#779 round 22 finding 8).
    const rebuildEnd = mainSource.indexOf(
      "\n\n  ipcMain.handle(CHANNELS.pluginUninstallPreflight",
      rebuildAt,
    );
    expect(rebuildEnd).toBeGreaterThan(rebuildAt);
    const rebuildBody = mainSource.slice(rebuildAt, rebuildEnd);
    const rebuildRevokeAt = rebuildBody.indexOf(
      "revokePluginPanels(workspaceId, pluginId);",
    );
    const rebuildReregisterAt = rebuildBody.indexOf(
      "void reregisterPluginPanels(workspaceId, pluginId).catch(",
      rebuildRevokeAt,
    );
    const rebuildStopWebAppsAt = rebuildBody.indexOf(
      "void stopPluginWebAppsForPlugin(workspaceId, pluginId).catch(",
      rebuildReregisterAt,
    );
    // MUTATION (grant straddles the replacement): rebuild without this
    // wire-up leaves a panel's grant against the old runtime live through
    // the swap — an in-flight brokered call never aborts, and a stale grant
    // sits unrevoked until the panel's own next call happens to supersede
    // it. Revoking here does not block re-granting: authorize() always
    // reads the pipeline's current spawn id (round-5 authority-registry
    // split), pinned behaviorally in pluginPanelSdkAuthority.test.ts.
    expect(rebuildAt).toBeGreaterThan(-1);
    // Relative to rebuildBody, not mainSource, from here down.
    expect(rebuildRevokeAt).toBeGreaterThan(-1);
    // MUTATION (mounted panel never re-grants): a still-mounted panel
    // never calls startPluginPanel again on its own, so a revoke with no
    // fresh registration after it leaves every later SDK call from that
    // panel failing forever, not just through the runtime swap itself
    // (#779 round 21 finding 6).
    expect(rebuildReregisterAt).toBeGreaterThan(rebuildRevokeAt);
    expect(rebuildStopWebAppsAt).toBeGreaterThan(rebuildReregisterAt);

    const reregisterFn = functionSource(
      "async function reregisterPluginPanels(",
    );
    const reregisterFilterAt = reregisterFn.indexOf(
      "([, panel]) => panel.workspaceId === workspaceId && panel.pluginId === pluginId,",
    );
    const reregisterLockAt = reregisterFn.indexOf(
      "withPluginPanelStartLock(key, async () => {",
      reregisterFilterAt,
    );
    const reregisterRecheckAt = reregisterFn.indexOf(
      "const current = runningPluginPanels.get(key);",
      reregisterLockAt,
    );
    const reregisterIdentityAt = reregisterFn.indexOf(
      "if (current !== panel) return;",
      reregisterRecheckAt,
    );
    const registerCallAt = reregisterFn.indexOf(
      "registerPluginPanelGrant({",
      reregisterIdentityAt,
    );
    const registerFieldsAt = reregisterFn.indexOf(
      "senderId: current.senderId,",
      registerCallAt,
    );
    // MUTATION (wrong panel re-granted, or none at all): a filter on
    // anything but this exact plugin's own mounted panels either grants
    // a panel that was never revoked, or never restores the one that was.
    expect(reregisterFilterAt).toBeGreaterThan(-1);
    // MUTATION (rebuild resurrects a closing panel): registering outside
    // this exact panel's own start lock lets a re-grant land between a
    // concurrent close's read and its own locked delete from
    // runningPluginPanels — the same lock stopPluginPanel holds while it
    // deletes that entry. Without it, or without the re-read after
    // acquiring it, this can hand a fresh grant to a panel a close already
    // meant to end (#779 round 23 finding 4).
    expect(reregisterLockAt).toBeGreaterThan(reregisterFilterAt);
    expect(reregisterRecheckAt).toBeGreaterThan(reregisterLockAt);
    // MUTATION (fresh grant clobbered by a stale re-register): a panel that
    // closed-and-reopened (or otherwise got a fresh record and its own
    // fresh grant) while this call waited for the lock must not have that
    // fresh grant revoked by a re-register still using the identity
    // captured before the lock — register() always revokes whatever grant
    // already exists for the same subject, fresh or not. Registering from
    // `current`, not the outer `panel`, is what makes this land on
    // whatever is actually there now (#779 round 25 finding 1).
    expect(reregisterIdentityAt).toBeGreaterThan(reregisterRecheckAt);
    expect(registerCallAt).toBeGreaterThan(reregisterIdentityAt);
    expect(registerFieldsAt).toBeGreaterThan(registerCallAt);
  });

  it("never tears down a workspace's plugins while another window still has it open (#779 round 19 finding 2)", () => {
    const open = handler("openWorkspace");
    const switchAt = open.indexOf(
      "if (\n      previousWorkspaceId &&\n      previousWorkspaceId !== workspace.workspaceId &&\n      !isWorkspaceOpenInAnyWindow(previousWorkspaceId)\n    ) {",
    );
    const switchStopAt = open.indexOf(
      "await stopPluginWorkspace(previousWorkspaceId);",
      switchAt,
    );
    const destroyedAt = open.indexOf('event.sender.once("destroyed"');
    const destroyedTryAt = open.indexOf("try {", destroyedAt);
    const destroyedSurfacesAt = open.indexOf(
      "await stopPluginSurfacesForSender(senderId);",
      destroyedTryAt,
    );
    const destroyedCatchAt = open.indexOf("} catch (error) {", destroyedSurfacesAt);
    const destroyedFinallyAt = open.indexOf("} finally {", destroyedCatchAt);
    const destroyedGateAt = open.indexOf(
      "if (activeWorkspaceId && !isWorkspaceOpenInAnyWindow(activeWorkspaceId)) {",
      destroyedFinallyAt,
    );
    const destroyedStopAt = open.indexOf(
      "await stopPluginWorkspace(activeWorkspaceId).catch((error: unknown) => {",
      destroyedGateAt,
    );
    // MUTATION (cross-window teardown): either gate missing lets one
    // window's switch or close stop a workspace a second window still has
    // open — that second window's own in-flight command then runs against
    // a host the first window just tore down.
    expect(switchAt).toBeGreaterThan(-1);
    expect(switchStopAt).toBeGreaterThan(switchAt);
    expect(destroyedAt).toBeGreaterThan(-1);
    // MUTATION (guest records outlive their window): a destroyed window
    // whose workspace survives must still lose its own panels and web
    // apps — revoking its SDK grants alone leaves those records alive
    // indefinitely and keeps their host leases live.
    expect(destroyedTryAt).toBeGreaterThan(destroyedAt);
    expect(destroyedSurfacesAt).toBeGreaterThan(destroyedTryAt);
    // MUTATION (unhandled rejection): a stop that rejects with no catch
    // here surfaces as an unhandled promise rejection instead of a logged
    // warning (#779 round 22 finding 9).
    expect(destroyedCatchAt).toBeGreaterThan(destroyedSurfacesAt);
    // MUTATION (a rejecting stop skips the last-window teardown): the
    // workspace-teardown decision runs in this finally, not only after a
    // successful stop above — a stop that throws must not also skip
    // deciding whether this was the workspace's last open window, or the
    // whole workspace leaks instead of just this sender's own claims
    // (#779 round 23 finding 3).
    expect(destroyedFinallyAt).toBeGreaterThan(destroyedCatchAt);
    expect(destroyedGateAt).toBeGreaterThan(destroyedFinallyAt);
    expect(destroyedStopAt).toBeGreaterThan(destroyedGateAt);
  });

  it("stops a departing window's own panels, not a survivor's sharing the same workspace (#779 round 20 finding 1)", () => {
    const panelsForSender = functionSource(
      "async function stopPluginPanelsForSender(",
    );
    const filterAt = panelsForSender.indexOf(
      "if (panel.senderId !== senderId) continue;",
    );
    const stopCallAt = panelsForSender.indexOf(
      "stopPluginPanel(",
      filterAt,
    );
    const exactOwnerAt = panelsForSender.indexOf(
      "{ senderId: panel.senderId, generation: panel.generation },",
      stopCallAt,
    );
    // MUTATION (wrong window's panels stopped, or none at all): a filter
    // on any field but senderId either tears down a surviving window's
    // own panels on the same shared workspace, or never reaches this
    // sender's own — either way a guest record outlives the window that
    // opened it.
    expect(filterAt).toBeGreaterThan(-1);
    expect(stopCallAt).toBeGreaterThan(filterAt);
    expect(exactOwnerAt).toBeGreaterThan(stopCallAt);

    const surfacesForSender = functionSource(
      "async function stopPluginSurfacesForSender(",
    );
    const webAppsAt = surfacesForSender.indexOf(
      "const removedWebApps = pluginWebAppViews.removeForSender(senderId);",
    );
    const disposeAt = surfacesForSender.indexOf(
      "await disposePluginWebAppViews(removedWebApps);",
      webAppsAt,
    );
    const panelsAt = surfacesForSender.indexOf(
      "await stopPluginPanelsForSender(senderId);",
      disposeAt,
    );
    expect(disposeAt).toBeGreaterThan(webAppsAt);
    expect(webAppsAt).toBeGreaterThan(-1);
    expect(panelsAt).toBeGreaterThan(disposeAt);
  });

  it("excludes the reloading sender's own now-stale entry from the any-window check, so a reload of the last window still tears down its workspace (#779 round 20 finding 2)", () => {
    const reload = functionSource("async function prepareForRendererReload(");
    const GATE = "isWorkspaceOpenInAnyWindow(activeWorkspaceId, senderId)";

    // The site-preview stop needs the identical exclusion the plugin-
    // workspace stop already has, for the identical reason: this sender's
    // own entry is not cleared yet here either, so without it a reload of
    // window A would count window A itself as "another window" showing the
    // workspace — stopping window B's still-live site preview of that same
    // workspace out from under it. Its gate+stop pair comes first in
    // source order (it starts the Promise.all array).
    const siteGateAt = reload.indexOf(GATE);
    const siteStopAt = reload.indexOf(
      "stopSitePreviewsForWorkspace(activeWorkspaceId)",
      siteGateAt,
    );
    // MUTATION (reload of one window kills another window's site preview):
    // an unconditional stopSitePreviewsForWorkspace call here — no gate at
    // all — stops every window's preview of the workspace, not just this
    // sender's own stale claim to it.
    expect(siteGateAt).toBeGreaterThan(-1);
    expect(siteStopAt).toBeGreaterThan(siteGateAt);

    const surfacesAt = reload.indexOf(
      "stopPluginSurfacesForSender(senderId)",
      siteStopAt,
    );
    const pluginGateAt = reload.indexOf(GATE, surfacesAt);
    const pluginStopAt = reload.indexOf(
      "stopPluginWorkspace(activeWorkspaceId)",
      pluginGateAt,
    );
    // MUTATION (last window's reload never tears down its workspace): this
    // sender's own activeWorkspaceIdBySender entry is not cleared before
    // this check runs — omitting the exclusion makes it always read as
    // "another window has this," so a solo window's own reload can never
    // reach full teardown, leaving a stale pipeline for the replacement
    // renderer to inherit instead of a fresh one.
    expect(surfacesAt).toBeGreaterThan(siteStopAt);
    expect(pluginGateAt).toBeGreaterThan(surfacesAt);
    expect(pluginStopAt).toBeGreaterThan(pluginGateAt);

    const isOpen = functionSource("function isWorkspaceOpenInAnyWindow(");
    const excludeAt = isOpen.indexOf("if (senderId === excludeSenderId) continue;");
    // MUTATION (exclusion parameter ignored): a signature that accepts
    // excludeSenderId but never uses it leaves the caller's own workaround
    // above silently defeated.
    expect(excludeAt).toBeGreaterThan(-1);
  });

  it("cleans the switching window's own surfaces on the workspace it is leaving, before it stops counting as open there (#779 round 21 finding 4)", () => {
    const open = handler("openWorkspace");
    const previousAt = open.indexOf(
      "const previousWorkspaceId = activeWorkspaceIdBySender.get(senderId);",
    );
    const tokenClaimAt = open.indexOf(
      "workspaceSwitchTokenBySender.set(senderId, switchToken);",
      previousAt,
    );
    const switchSurfacesAt = open.indexOf(
      "if (previousWorkspaceId && previousWorkspaceId !== workspace.workspaceId) {",
      tokenClaimAt,
    );
    const generationBumpAt = open.indexOf(
      "advanceRendererGeneration(senderId);",
      switchSurfacesAt,
    );
    const switchSurfacesCallAt = open.indexOf(
      "await stopPluginSurfacesForSender(senderId);",
      generationBumpAt,
    );
    const tokenGuardAt = open.indexOf(
      "if (workspaceSwitchTokenBySender.get(senderId) === switchToken) {",
      switchSurfacesCallAt,
    );
    const setAt = open.indexOf(
      "activeWorkspaceIdBySender.set(senderId, workspace.workspaceId);",
      tokenGuardAt,
    );
    // MUTATION (switch leaves guest records behind): calling this after
    // the set above — or not at all — either refuses to see this sender
    // as having just left the previous workspace, or never cleans its own
    // panels and web apps there at all. Either way a survivor sharing
    // that workspace inherits claims this window never released.
    expect(previousAt).toBeGreaterThan(-1);
    // MUTATION (rapid switch overwrite): claimed after reading
    // previousWorkspaceId but before the await below — a second rapid
    // switch from this sender then bumps past it, so if this call resumes
    // after that one already finished, the guard below stops it from
    // overwriting the newer assignment with its own now-stale one (#779
    // round 23 finding 2).
    expect(tokenClaimAt).toBeGreaterThan(previousAt);
    expect(switchSurfacesAt).toBeGreaterThan(tokenClaimAt);
    // MUTATION (in-flight start slips past the sweep): startPluginPanel
    // and startPluginWebApp both re-check the sender's own generation
    // right before they register — bumping it after the sweep instead of
    // before leaves a start already in flight free to register into the
    // sweep's own blind spot once it finishes (#779 round 22 finding 3).
    expect(generationBumpAt).toBeGreaterThan(switchSurfacesAt);
    expect(switchSurfacesCallAt).toBeGreaterThan(generationBumpAt);
    // MUTATION (rapid switch overwrite, continued): the assignment itself
    // must be gated on the same token, not just claimed earlier — an
    // unguarded set() here is exactly what a resumed, now-stale call would
    // use to clobber a newer switch's own already-current assignment.
    expect(tokenGuardAt).toBeGreaterThan(switchSurfacesCallAt);
    expect(setAt).toBeGreaterThan(tokenGuardAt);
  });
});
