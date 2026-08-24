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

/**
 * Source with every run of whitespace removed, so an assertion can name a
 * whole call — arguments, order, and all — without pinning how it wraps.
 */
const squeeze = (source: string): string => source.replace(/\s+/g, "");

function functionSource(signature: string): string {
  const start = mainSource.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe("plugin web app main-process wiring", () => {
  it("validates and remembers a web app without starting its host", () => {
    const open = handler("openPluginWebApp");
    const loadAt = open.indexOf("loadPluginWebAppRegistration({");
    const rememberAt = open.indexOf("rememberPluginRegistration(");

    expect(loadAt).toBeGreaterThan(-1);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(open).toContain("assertPluginPanelRequestCurrent(isCurrent);");
    expect(open).not.toContain("ensurePluginStarted(");
    expect(open).not.toContain("acquirePluginSurfaceLease(");
    expect(open).toContain(
      "pluginRegistration: pluginPipelines.get(workspace.workspaceId),",
    );
  });

  it("rejects an open whose renderer generation changes while the pipeline starts", () => {
    const open = handler("openPluginWebApp");
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

  it("builds the guest only after readiness and both post-start rechecks", () => {
    const start = handler("startPluginWebApp");
    const startWebAppAt = start.indexOf("await host.startWebApp(");
    // MUTATION (pass null, or the manifest id, instead of the request's own
    // key): every instance would start under one identity, so two preview
    // tabs would share one origin. PluginHost.test.ts pins that the host
    // sends whatever key it is given; only this pins WHICH key main gives it.
    expect(squeeze(start)).toContain(
      "awaithost.startWebApp(input.pluginId,input.webAppId,input.instanceKey,)",
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
    expect(start).toContain("await disposePluginWebAppViews([displaced]);");
  });

  it("recovers a consumed credential by unpairing the plugin itself", () => {
    const start = handler("startPluginWebApp");
    // What the recovery does with these, and in what order, is pinned by
    // behavior in pluginWebAppRecovery.test.ts; that the start hands it the
    // PLUGIN's unpair — not just the view stop — is this handler's own claim.
    expect(start).toContain("recoverConsumedWebAppCredential({");
    // The unpair must BE the host call — not merely be followed by one — and
    // it must name the instance the failed start paired, or the recovery
    // would retire a sibling instance's session instead of this one's.
    expect(squeeze(start)).toContain(
      "unpair:()=>host.stopWebApp(input.pluginId,input.webAppId,input.instanceKey,)",
    );
    expect(start).toContain("notifyFailed: () =>");
    expect(start).toContain("onLoadFailure: () => {");
    expect(start).toContain("recoverConsumedCredential();");
    // The teardown runs in a section on the lock a reopen queues on.
    expect(start).toContain("withTeardownLock: (teardown) =>");
    expect(start).toContain("withPluginWebAppStartLock(");
    expect(start).toContain("pluginWebAppViews.get(identity) === installedRecord");
    expect(start).toContain("await disposePluginWebAppViews(records);");
  });

  it("leaves a normal tab close paired", () => {
    const closePath = functionSource(
      "async function stopPluginWebAppUnderStartLock(",
    );
    // MUTATION (unpair on every close): an enabled plugin's server would then
    // be torn down and respawned on every tab close, and the guest's session
    // cookie — which already landed, and which the next open reuses — would
    // be worthless. Only the recovery path unpairs.
    // The method, not one spelling of its first argument: the same unpair
    // written as host.stopWebApp(input.pluginId, …) must fail this too.
    expect(closePath).not.toContain(".stopWebApp(");
    expect(closePath).not.toContain("recoverConsumedWebAppCredential");
  });

  it("embedded guests follow the window zoom (#875)", () => {
    // The attach/load/level behavior is pinned in windowZoom.test.ts
    // (createGuestZoomApplier drives a fake guest through attach, loads,
    // level changes, and destruction). This file pins only what it owns:
    // the attach callback binds the REAL guest's WebContents to the applier
    // fed by knownZoomLevel.
    const start = handler("startPluginWebApp");
    const bindAt = start.indexOf("bindGuestZoom(view.webContents);");
    const registerAt = start.indexOf("pluginWebAppViews.register(next)", bindAt);
    expect(bindAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(bindAt);
    expect(squeeze(mainSource)).toContain(
      "constbindGuestZoom=createGuestZoomApplier(()=>knownZoomLevel);",
    );

    // On every zoom change: the window-wide apply reaches each live guest.
    const apply = functionSource("function applyZoomLevelToWindows(");
    expect(squeeze(apply)).toContain(
      "for(constrecordofpluginWebAppViews.all()){",
    );
    expect(squeeze(apply)).toContain("guest.setZoomLevel(zoomLevel);");

    // The launch read routes its first application through that same
    // window-wide apply (behavior pinned in windowZoom.test.ts) — a
    // host-only apply here would leave an early-attached guest at 100%.
    const track = functionSource("function trackWorkspaceWindow(");
    expect(squeeze(track)).toContain("resolvePersistedZoomApplication(");
    expect(squeeze(track)).toContain(
      "applyZoomLevelToWindows(application.applyEverywhere);",
    );
  });

  it("applies bounds only through the registry's sender-and-generation guard", () => {
    const bounds = handler("setPluginWebAppBounds");
    const authorizeAt = bounds.indexOf("pluginWebAppViews.authorizeBounds({");
    const dropAt = bounds.indexOf("if (!record) return;", authorizeAt);
    // The applied rect is the renderer's CSS-pixel report scaled by the
    // sender's zoom factor — raw CSS pixels would misplace the guest on a
    // zoomed host.
    const zoomAt = bounds.indexOf("event.sender.getZoomFactor()", dropAt);
    const applyAt = bounds.indexOf("record.view.view.setBounds({", zoomAt);

    expect(authorizeAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(authorizeAt);
    expect(zoomAt).toBeGreaterThan(dropAt);
    expect(applyAt).toBeGreaterThan(zoomAt);
    expect(bounds).toContain("generation: rendererGeneration(event.sender.id),");
  });

  // Every identity-keyed path in these handlers carries the request's own
  // instance. MUTATION (any one of them dropping it): that path would act on
  // whichever instance sorts first under the keyless identity, so one
  // preview's resize, stop, or failure would land on another preview.
  it("keys every web app path by the instance the request named", () => {
    const start = squeeze(handler("startPluginWebApp"));
    expect(start).toContain("constidentity={workspaceId:workspace.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,}");
    expect(start).toContain(
      "assertInstanceBudget(input.pluginId,input.webAppId,pluginWebAppViews.countOtherInstances(identity),)",
    );
    expect(squeeze(handler("openPluginWebApp"))).toContain(
      "requireDeclaredWebApp(input.pluginId,plugin.manifest.webApps,input.webAppId,input.instanceKey,)",
    );
    expect(squeeze(handler("setPluginWebAppBounds"))).toContain(
      "authorizeBounds({workspaceId:input.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,",
    );
    const stop = squeeze(handler("stopPluginWebApp"));
    expect(stop).toContain(
      "awaitstopPluginWebApp(workspace.workspaceId,input.pluginId,input.webAppId,input.instanceKey,{senderId:event.sender.id,generation:rendererGeneration(event.sender.id),},)",
    );
    const stopUnderLock = squeeze(
      functionSource("async function stopPluginWebAppUnderStartLock("),
    );
    expect(stopUnderLock).toContain(
      "pluginWebAppViews.get({workspaceId,pluginId,webAppId,instanceKey,})",
    );
  });

  it("releases a failed web app start's exact lease", () => {
    const start = handler("startPluginWebApp");
    const stopViewAt = start.indexOf("stopView: async () => {");
    const exactRecordAt = start.indexOf(
      "pluginWebAppViews.get(identity) === installedRecord",
      stopViewAt,
    );
    const recordReleaseAt = start.indexOf(
      "await disposePluginWebAppViews(records);",
      exactRecordAt,
    );
    const pendingReleaseAt = start.indexOf(
      "await hostLease.release();",
      recordReleaseAt,
    );

    expect(stopViewAt).toBeGreaterThan(-1);
    expect(exactRecordAt).toBeGreaterThan(stopViewAt);
    expect(recordReleaseAt).toBeGreaterThan(exactRecordAt);
    expect(pendingReleaseAt).toBeGreaterThan(recordReleaseAt);
    expect(squeeze(start)).toContain(
      "awaitdisposePluginWebAppViews(records);awaithostLease.release();",
    );
    expect(start).not.toContain("leaseOwnedByRecord");
  });

  it("stores and releases the lease owned by each web app record", () => {
    const start = handler("startPluginWebApp");
    const acquireAt = start.indexOf("acquirePluginSurfaceLease(");
    const ownerAt = start.indexOf("pipeline.hostOwnership", acquireAt);
    const startAt = start.indexOf("hostLease.start((authority)", acquireAt);
    const installAt = start.indexOf("pluginWebAppViews.register(next)", startAt);
    const displacementAt = start.indexOf(
      "await disposePluginWebAppViews([displaced]);",
      installAt,
    );

    expect(acquireAt).toBeGreaterThan(-1);
    expect(ownerAt).toBeGreaterThan(acquireAt);
    expect(startAt).toBeGreaterThan(acquireAt);
    expect(installAt).toBeGreaterThan(startAt);
    expect(displacementAt).toBeGreaterThan(installAt);

    const dispose = functionSource("async function disposePluginWebAppViews(");
    expect(dispose).toContain("destroyPluginWebAppViews(records);");
    expect(dispose).toContain("record.view.hostLease.release()");
  });

  it("destroys guest views on every teardown path a view could outlive", () => {
    // functionSource, not a hand-built slice: an end marker that stops
    // matching returns -1, and slice(start, -1) silently widens the section
    // to the rest of main.ts — where the call being looked for exists.
    const reload = functionSource("async function prepareForRendererReload(");
    expect(reload).toContain("stopPluginSurfacesForSender(senderId)");

    const surfacesForSender = functionSource(
      "async function stopPluginSurfacesForSender(",
    );
    expect(surfacesForSender).toContain(
      "const removedWebApps = pluginWebAppViews.removeForSender(senderId);",
    );
    expect(surfacesForSender).toContain(
      "await disposePluginWebAppViews(removedWebApps);",
    );
    const disposeAt = surfacesForSender.indexOf(
      "await disposePluginWebAppViews(removedWebApps);",
    );
    const panelsForSenderAt = surfacesForSender.indexOf(
      "await stopPluginPanelsForSender(senderId);",
      disposeAt,
    );
    expect(panelsForSenderAt).toBeGreaterThan(disposeAt);

    const stopWorkspace = functionSource("async function stopPluginWorkspace(");
    expect(stopWorkspace).toContain(
      "pluginWebAppViews.removeForWorkspace(workspaceId)",
    );
    expect(stopWorkspace).toContain("await disposePluginWebAppViews(");

    const stopAll = functionSource("async function stopAllPluginWorkspaces(");
    expect(stopAll).toContain("pluginWebAppViews.all().map((record) => record.workspaceId)");

    const pipeline = functionSource("function createPluginPipeline");
    expect(pipeline).toContain(
      "void stopPluginWebAppsForPlugin(workspace.workspaceId, pluginId).catch(",
    );

    const disableAt = mainSource.indexOf("pluginAction(CHANNELS.disablePlugin,");
    const disableStopAt = mainSource.indexOf(
      "stopPluginWebAppsForPlugin(workspaceId, pluginId)",
      disableAt,
    );
    const disableCallAt = mainSource.indexOf(
      "pipeline.disable(pluginId),",
      disableAt,
    );
    expect(disableCallAt).toBeGreaterThan(disableAt);
    expect(disableStopAt).toBeGreaterThan(disableAt);
    expect(disableStopAt).toBeGreaterThan(disableCallAt);
  });

  // The predicate itself, pinned once by name so every gate that reuses it
  // is pinned by construction: presence in pipeline.list() alone is not
  // ownership — a collision's never-installed, losing side can sit under
  // the exact same id as the row that actually owns a panel, a web app, or
  // a partition.
  it("requires an actual installed claimant, not merely a row present under the id", () => {
    const predicateAt = mainSource.indexOf("const pluginIdHasInstalledClaimant = (");
    const predicateEnd = mainSource.indexOf("\n\n", predicateAt);
    const predicate = mainSource.slice(predicateAt, predicateEnd);

    // MUTATION (drop the approvedHash check): a never-installed collision
    // loser reads as an "owner" too, and every gate built on this predicate
    // then wrongly treats it as one.
    expect(predicateAt).toBeGreaterThan(-1);
    expect(squeeze(predicate)).toContain(
      "entry.id===pluginId&&entry.approvedHash!==null",
    );
  });

  it("destroys a plugin's guest views after the old runtime stops", () => {
    const rebuildAt = mainSource.indexOf("pluginAction(CHANNELS.rebuildPlugin,");
    const rebuildEnd = mainSource.indexOf("\n\n  ipcMain.handle(", rebuildAt);
    const rebuild = mainSource.slice(rebuildAt, rebuildEnd);

    expect(rebuildAt).toBeGreaterThan(-1);
    expect(rebuild).toContain("pipeline.rebuild(pluginId, {");
    expect(rebuild).toContain("onOldRuntimeStopped: () =>");
    expect(rebuild).toContain(
      "stopPluginWebAppsForPlugin(workspaceId, pluginId)",
    );
    expect(rebuild).not.toContain(
      "stopPluginWebAppsForPlugin(workspaceId, pluginId);\n    return pipeline.rebuild",
    );
  });

  it("notifies each owner when plugin teardown destroys its guest view", () => {
    const stop = functionSource("function stopPluginWebAppsForPlugin(");
    const removeAt = stop.indexOf("pluginWebAppViews.removeForPlugin(");
    const guestsAt = stop.indexOf("stopPluginWebAppGuests(", removeAt);
    const resolveSenderAt = stop.indexOf(
      "webContents.fromId(record.senderId)",
      guestsAt,
    );
    const notifyAt = stop.indexOf("notifyPluginWebAppFailed(sender,", resolveSenderAt);
    const disposeAt = stop.indexOf("await disposePluginWebAppViews(records);", notifyAt);

    expect(removeAt).toBeGreaterThan(-1);
    expect(guestsAt).toBeGreaterThan(removeAt);
    expect(resolveSenderAt).toBeGreaterThan(guestsAt);
    expect(notifyAt).toBeGreaterThan(resolveSenderAt);
    expect(disposeAt).toBeGreaterThan(notifyAt);
    expect(squeeze(stop)).toContain(
      "notifyPluginWebAppFailed(sender,record.generation,{workspaceId:record.workspaceId,pluginId:record.pluginId,webAppId:record.webAppId,instanceKey:record.instanceKey,})",
    );
    // Notification isolation is pinned in pluginWebAppViews.test.ts. This
    // test pins disposal after notification in the production caller.
  });

  // round-13 finding 3 (CodeRabbit): WebContents ids recycle across a
  // crash-reload, so a sender resolved by a stale id could otherwise
  // deliver a dead guest's failure to whatever unrelated page now answers
  // to that id — every other send in this file gates on the record's
  // generation, and this one now does too.
  it("refuses to notify a sender whose generation has moved on", () => {
    const notify = functionSource("function notifyPluginWebAppFailed(");

    expect(notify).toContain(
      "sender.isDestroyed() || rendererGeneration(sender.id) !== generation",
    );

    // Both call sites pass a generation the record or the handler itself
    // already carries, not a freshly re-derived one — the whole point is
    // to compare against what the record was stamped with, not the
    // sender's current generation (which would make the check vacuous).
    const stop = functionSource("function stopPluginWebAppsForPlugin(");
    expect(squeeze(stop)).toContain(
      "notifyPluginWebAppFailed(sender,record.generation,",
    );
    const recover = mainSource.indexOf(
      "notifyFailed: () => notifyPluginWebAppFailed(sender, generation, identity)",
    );
    expect(recover).toBeGreaterThan(-1);
  });

  it("clears the guest partition's storage after a successful uninstall, only once no installed claimant survives", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.directoryName, input.confirmationToken),",
    );
    const stillInstalledClaimantAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
      uninstallCallAt,
    );
    const guardAt = uninstall.indexOf(
      "if (removedLastClaimant) {",
      stillInstalledClaimantAt,
    );
    const clearAt = uninstall.indexOf("clearPluginWebAppPartition({", guardAt);

    // MUTATION (session credential): without the clear, a reinstalled plugin
    // inherits the previous installation's authenticated session cookies.
    // What the clear targets is pinned in pluginWebAppGuest.test.ts.
    expect(uninstallCallAt).toBeGreaterThan(-1);
    // MUTATION (drop stillInstalledClaimant, or use presence alone):
    // input.pluginId can still be OWNED by a completely different,
    // still-installed plugin a duplicate-id collision produced — the
    // losing side removed, the winning side left running under the
    // identical id. Without this check, an unconditional clear would
    // reach into that surviving plugin's own live session.
    expect(stillInstalledClaimantAt).toBeGreaterThan(uninstallCallAt);
    expect(guardAt).toBeGreaterThan(stillInstalledClaimantAt);
    expect(clearAt).toBeGreaterThan(guardAt);
  });

  it("gates the registration forget the same way it gates the partition clear", () => {
    const uninstall = handler("uninstallPlugin");
    const stillInstalledClaimantAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
    );
    const forgetAt = uninstall.indexOf("forgetUninstalledPlugin({", stillInstalledClaimantAt);
    const forgetCall = uninstall.slice(forgetAt, uninstall.indexOf("});", forgetAt));

    // MUTATION (uninstalled: result.ok, dropping !stillInstalledClaimant):
    // the same collision that must not clear a survivor's partition must
    // not forget its registration either — both are keyed by id alone.
    expect(stillInstalledClaimantAt).toBeGreaterThan(-1);
    expect(forgetAt).toBeGreaterThan(stillInstalledClaimantAt);
    expect(squeeze(forgetCall)).toContain("uninstalled:removedLastClaimant,");
  });

  // #779-offers round 17 finding 2, tightened round 23 finding 2: revoking
  // a panel or stopping a web app before the pipeline even validates
  // confirmationToken reaches into whatever row is currently running under
  // this id — a stale dialog or an expired token fails before
  // pipeline.uninstall ever calls pluginHost.stop(), and teardown ahead of
  // that would destroy a still-running plugin's surfaces for an action
  // that never touched it. There is exactly one teardown site, entirely
  // after the settled result.
  it("defers all panel and web app teardown until after pipeline.uninstall settles", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.directoryName, input.confirmationToken),",
    );
    const settledGuardAt = uninstall.indexOf(
      "if (!stillInstalledClaimant && (result.ok || claimantStoppedBySettledResult)) {",
      uninstallCallAt,
    );
    const panelStopAt = uninstall.indexOf(
      "stopPluginPanelsForPlugin(input.workspaceId, input.pluginId)",
      settledGuardAt,
    );
    const stopAt = uninstall.indexOf(
      "stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId)",
      panelStopAt,
    );

    // MUTATION (revoke/stop before the settled guard, or before
    // uninstallCallAt at all): a stale dialog or expired token would then
    // have its surfaces torn down before pipeline.uninstall ever proves
    // this attempt actually reached pluginHost.stop().
    expect(uninstallCallAt).toBeGreaterThan(-1);
    expect(settledGuardAt).toBeGreaterThan(uninstallCallAt);
    expect(panelStopAt).toBeGreaterThan(settledGuardAt);
    expect(stopAt).toBeGreaterThan(panelStopAt);
    expect(uninstall.indexOf("stopPluginPanelsForPlugin(input.workspaceId, input.pluginId)"))
      .toBe(panelStopAt);
    expect(uninstall.indexOf("stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId)"))
      .toBe(stopAt);
  });

  // #779-offers round 18 finding 1, tightened round 23 finding 2: a FAILED
  // uninstall can still have stopped the installed claimant's process
  // before the failure that followed — the preflight-stale-after-stop and
  // delete-failed paths both mark the row disabled or disabled-pending-
  // repair only AFTER pluginHost.stop() already ran, so its main-process
  // surfaces are just as dead as a successful removal's would be. An
  // earlier failure (caught before the pipeline ever touches the process)
  // never reaches that status, and the claimant is still genuinely
  // running. A full SUCCESS proves it too, on its own (result.ok).
  it("revokes authority on a failed uninstall too, only once the settled status proves the process was actually stopped", () => {
    const uninstall = handler("uninstallPlugin");
    const settledGuardAt = uninstall.indexOf(
      "if (!stillInstalledClaimant && (result.ok || claimantStoppedBySettledResult)) {",
    );
    const predicateAt = uninstall.indexOf(
      "const claimantStoppedBySettledResult =",
    );
    const predicate = uninstall.slice(
      predicateAt,
      uninstall.indexOf(";", uninstall.indexOf("disabled-pending-repair", predicateAt)) + 1,
    );

    // MUTATION (gate on result.ok alone, dropping the status check): a
    // failure caught before the process was ever stopped would then ALSO
    // revoke a still-genuinely-running claimant's authority.
    expect(predicateAt).toBeGreaterThan(-1);
    expect(settledGuardAt).toBeGreaterThan(predicateAt);
    expect(squeeze(predicate)).toContain("result.plugin!==null");
    expect(squeeze(predicate)).toContain("result.plugin.approvedHash!==null");
    expect(squeeze(predicate)).toContain('result.plugin.status==="disabled"');
    expect(squeeze(predicate)).toContain(
      'result.plugin.status==="disabled-pending-repair"',
    );
  });

  // #779-offers round 24 finding 1: removing an id-losing collision loser
  // genuinely returns result.ok, with nothing of ITS own ever having run —
  // the loser has no panel or web app authority of its own to revoke.
  // result.ok alone is not proof this id's own claimant was stopped: a
  // still-installed WINNER can survive under the identical id, and
  // teardown by id alone would tear its live surfaces down for an action
  // that never touched it.
  it("never tears down a still-installed claimant's surfaces when the settled result names no stopped claimant", () => {
    const uninstall = handler("uninstallPlugin");
    const claimantAt = uninstall.indexOf(
      "const stillInstalledClaimant = pluginIdHasInstalledClaimant(pipeline, input.pluginId);",
    );
    const settledGuardAt = uninstall.indexOf(
      "if (!stillInstalledClaimant && (result.ok || claimantStoppedBySettledResult)) {",
      claimantAt,
    );

    // MUTATION (gate on result.ok/claimantStoppedBySettledResult alone,
    // dropping !stillInstalledClaimant): removing the loser would then
    // tear down the winner's still-live panel and web app views, even
    // though nothing of the loser's own was ever running to revoke.
    expect(claimantAt).toBeGreaterThan(-1);
    expect(settledGuardAt).toBeGreaterThan(claimantAt);
  });
});
