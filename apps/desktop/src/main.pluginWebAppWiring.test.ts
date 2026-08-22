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
    expect(start).toContain("if (displaced) destroyPluginWebAppViews([displaced]);");
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
    // The teardown runs in a section on the lock a reopen queues on, and its
    // view stop must be the variant that does NOT take that lock again.
    // MUTATION (stopPluginWebApp here): the section waits on itself and the
    // web app can never be opened again in this app run.
    expect(start).toContain("withTeardownLock: (teardown) =>");
    expect(start).toContain("withPluginWebAppStartLock(");
    expect(start).toContain("stopPluginWebAppUnderStartLock(");
    expect(start).not.toContain("stopPluginWebApp(");
  });

  it("leaves a normal tab close paired", () => {
    // Both halves of the close: this path and the host release it delegates
    // to. An unpair added to either one would unpair every tab close.
    const closePath =
      functionSource("async function stopPluginWebAppUnderStartLock(") +
      functionSource("async function stopPluginHostIfUnclaimed(");
    // MUTATION (unpair on every close): an enabled plugin's server would then
    // be torn down and respawned on every tab close, and the guest's session
    // cookie — which already landed, and which the next open reuses — would
    // be worthless. Only the recovery path unpairs.
    // The method, not one spelling of its first argument: the same unpair
    // written as host.stopWebApp(input.pluginId, …) must fail this too.
    expect(closePath).not.toContain(".stopWebApp(");
    expect(closePath).not.toContain("recoverConsumedWebAppCredential");
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

  // Every identity-keyed path in these handlers carries the request's own
  // instance. MUTATION (any one of them dropping it): that path would act on
  // whichever instance sorts first under the keyless identity, so one
  // preview's resize, stop, or failure would land on another preview.
  it("keys every web app path by the instance the request named", () => {
    const start = squeeze(handler("startPluginWebApp"));
    expect(start).toContain(
      "stopView:()=>stopPluginWebAppUnderStartLock(workspace.workspaceId,input.pluginId,input.webAppId,input.instanceKey,)",
    );
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
      "pluginWebAppViews.get({workspaceId:workspace.workspaceId,pluginId:input.pluginId,webAppId:input.webAppId,instanceKey:input.instanceKey,})",
    );
    expect(stop).toContain(
      "awaitstopPluginWebApp(workspace.workspaceId,input.pluginId,input.webAppId,input.instanceKey,)",
    );
  });

  it("shares the host claim accounting between panels and web apps", () => {
    // One helper, both close paths: neither can grow a claim rule the other
    // does not have.
    const call = "await stopPluginHostIfUnclaimed(workspaceId, pluginId);";
    expect(functionSource("async function stopPluginWebAppUnderStartLock(")).toContain(
      call,
    );
    expect(functionSource("async function stopPluginPanel(")).toContain(call);

    const unclaimed = functionSource("async function stopPluginHostIfUnclaimed(");
    expect(unclaimed).toContain("hasAnotherPanel");
    // MUTATION (shared claim): without this, closing the last panel stops a
    // host whose web app tab is still open on the same plugin — and closing
    // the last tab stops a host a panel still needs.
    expect(unclaimed).toContain(
      "!pluginWebAppViews.hasForPlugin(workspaceId, pluginId) &&",
    );
    expect(unclaimed).toContain(
      "panelStartedHosts.delete(pluginLifecycleKey(workspaceId, pluginId))",
    );
  });

  it("destroys guest views on every teardown path a view could outlive", () => {
    // functionSource, not a hand-built slice: an end marker that stops
    // matching returns -1, and slice(start, -1) silently widens the section
    // to the rest of main.ts — where the call being looked for exists.
    const reload = functionSource("async function prepareForRendererReload(");
    expect(reload).toContain(
      "destroyPluginWebAppViews(pluginWebAppViews.removeForSender(senderId));",
    );

    const stopWorkspace = functionSource("async function stopPluginWorkspace(");
    expect(stopWorkspace).toContain(
      "destroyPluginWebAppViews(pluginWebAppViews.removeForWorkspace(workspaceId));",
    );

    const stopAll = functionSource("async function stopAllPluginWorkspaces(");
    expect(stopAll).toContain("destroyPluginWebAppViews(pluginWebAppViews.removeAll());");

    const pipeline = functionSource("function createPluginPipeline");
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

  // The predicate itself, pinned once by name so every gate that reuses it
  // is pinned by construction: presence in pipeline.list() alone is not
  // ownership — a collision's never-installed, losing side can sit under
  // the exact same id as the row that actually owns a panel, a web app, or
  // a partition (#779-offers round 17 finding 1).
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

  it("clears the guest partition's storage after a successful uninstall, only once no installed claimant survives", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.confirmationToken),",
    );
    const idStillOwnedAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
      uninstallCallAt,
    );
    const guardAt = uninstall.indexOf(
      "if (result.ok && !idStillOwned) {",
      idStillOwnedAt,
    );
    const clearAt = uninstall.indexOf("clearPluginWebAppPartition({", guardAt);

    // MUTATION (session credential): without the clear, a reinstalled plugin
    // inherits the previous installation's authenticated session cookies.
    // What the clear targets is pinned in pluginWebAppGuest.test.ts.
    expect(uninstallCallAt).toBeGreaterThan(-1);
    // MUTATION (drop idStillOwned, or use presence alone): input.pluginId
    // can still be OWNED by a completely different, still-installed plugin
    // a duplicate-id collision produced — the losing side removed, the
    // winning side left running under the identical id. Without this
    // check, an unconditional clear would reach into that surviving
    // plugin's own live session (#779-offers round 16 finding 3, round 17
    // finding 1).
    expect(idStillOwnedAt).toBeGreaterThan(uninstallCallAt);
    expect(guardAt).toBeGreaterThan(idStillOwnedAt);
    expect(clearAt).toBeGreaterThan(guardAt);
  });

  it("gates the registration forget the same way it gates the partition clear", () => {
    const uninstall = handler("uninstallPlugin");
    const idStillOwnedAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
    );
    const forgetAt = uninstall.indexOf("forgetUninstalledPlugin({", idStillOwnedAt);
    const forgetCall = uninstall.slice(forgetAt, uninstall.indexOf("});", forgetAt));

    // MUTATION (uninstalled: result.ok, dropping !idStillOwned): the same
    // collision that must not clear a survivor's partition must not forget
    // its registration either — both are keyed by id alone.
    expect(idStillOwnedAt).toBeGreaterThan(-1);
    expect(forgetAt).toBeGreaterThan(idStillOwnedAt);
    expect(squeeze(forgetCall)).toContain("uninstalled:result.ok&&!idStillOwned,");
  });

  // #779-offers round 17 finding 2: revoking a panel or stopping a web app
  // by id alone, before the pipeline even resolves which row
  // confirmationToken names, reaches into a survivor's live authority the
  // same way an unguarded post-remove clear would.
  it("defers the panel and web app teardown when this id names more than one row at the start", () => {
    const uninstall = handler("uninstallPlugin");
    const collisionAt = uninstall.indexOf(
      "pipeline.list().filter((entry) => entry.id === input.pluginId).length > 1",
    );
    const firstGuardAt = uninstall.indexOf("if (!collisionAtStart) {", collisionAt);
    const firstRevokeAt = uninstall.indexOf(
      "revokePluginPanels(input.workspaceId, input.pluginId);",
      firstGuardAt,
    );
    const firstStopAt = uninstall.indexOf(
      "stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId);",
      firstRevokeAt,
    );
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.confirmationToken),",
      firstStopAt,
    );
    const settledGuardAt = uninstall.indexOf(
      "if (collisionAtStart && claimantStoppedBySettledResult) {",
      uninstallCallAt,
    );
    const secondRevokeAt = uninstall.indexOf(
      "revokePluginPanels(input.workspaceId, input.pluginId);",
      settledGuardAt,
    );
    const secondStopAt = uninstall.indexOf(
      "stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId);",
      secondRevokeAt,
    );

    // MUTATION (drop collisionAtStart, revoke unconditionally up front): an
    // ambiguous id would have its teardown fire before uninstall even
    // resolves which row is actually leaving, reaching into whichever row
    // happens to share the id right now.
    expect(collisionAt).toBeGreaterThan(-1);
    expect(firstGuardAt).toBeGreaterThan(collisionAt);
    expect(firstRevokeAt).toBeGreaterThan(firstGuardAt);
    expect(firstStopAt).toBeGreaterThan(firstRevokeAt);
    expect(uninstallCallAt).toBeGreaterThan(firstStopAt);
    // MUTATION (drop the settled re-run, or gate it on result.ok alone):
    // an ambiguous id whose confirmed row turned out to BE the installed
    // claimant must still have its authority revoked, once that is known
    // for certain rather than guessed up front.
    expect(settledGuardAt).toBeGreaterThan(uninstallCallAt);
    expect(secondRevokeAt).toBeGreaterThan(settledGuardAt);
    expect(secondStopAt).toBeGreaterThan(secondRevokeAt);
  });

  // #779-offers round 18 finding 1: a FAILED uninstall can still have
  // stopped the installed claimant's process before the failure that
  // followed — the preflight-stale-after-stop and delete-failed paths both
  // mark the row disabled or disabled-pending-repair only AFTER
  // pluginHost.stop() already ran, so its main-process surfaces are just as
  // dead as a successful removal's would be. An earlier failure (caught
  // before the pipeline ever touches the process) never reaches that
  // status, and the claimant is still genuinely running.
  it("revokes a collision's authority on a failed uninstall too, only once the settled status proves the process was actually stopped", () => {
    const uninstall = handler("uninstallPlugin");
    const settledGuardAt = uninstall.indexOf(
      "if (collisionAtStart && claimantStoppedBySettledResult) {",
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
});
