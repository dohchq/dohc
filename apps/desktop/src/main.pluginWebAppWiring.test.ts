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
    expect(open).toContain(
      "pluginRegistration: pluginPipelines.get(workspace.workspaceId),",
    );
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
    expect(unclaimed).toContain("!activeCommandClaims.has(key) &&");
    // A command's cold start (claim: false) never touches panelStartedHosts,
    // so a surface-less command-started host relies on this fallback the
    // same way a panel's own claim relies on panelStartedHosts.delete()
    // (round-9 finding 1) — pinned behaviorally in
    // pluginCommandHostClaims.test.ts and pluginPanelRegistration.test.ts.
    expect(unclaimed).toContain(
      "(panelStartedHosts.delete(key) || activeCommandClaims.consumeStartedHost(key))",
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
    const destroyAt = stop.indexOf("destroyPluginWebAppViews,", notifyAt);

    expect(removeAt).toBeGreaterThan(-1);
    expect(guestsAt).toBeGreaterThan(removeAt);
    expect(resolveSenderAt).toBeGreaterThan(guestsAt);
    expect(notifyAt).toBeGreaterThan(resolveSenderAt);
    expect(destroyAt).toBeGreaterThan(notifyAt);
    expect(squeeze(stop)).toContain(
      "notifyPluginWebAppFailed(sender,record.generation,{workspaceId:record.workspaceId,pluginId:record.pluginId,webAppId:record.webAppId,instanceKey:record.instanceKey,})",
    );
    // The isolation and always-destroy guarantees themselves are pinned
    // behaviorally in pluginWebAppViews.test.ts, against the shared
    // stopPluginWebAppGuests() this handler delegates to.
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

  it("clears the guest partition's storage after a successful uninstall", () => {
    const uninstall = handler("uninstallPlugin");
    const stopViewsAt = uninstall.indexOf(
      "stopPluginWebAppsForPlugin(input.workspaceId, input.pluginId);",
    );
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.confirmationToken),",
    );
    const guardAt = uninstall.indexOf("if (result.ok) {", uninstallCallAt);
    const clearAt = uninstall.indexOf("clearPluginWebAppPartition({", guardAt);

    // MUTATION (session credential): without the clear, a reinstalled plugin
    // inherits the previous installation's authenticated session cookies.
    // What the clear targets is pinned in pluginWebAppGuest.test.ts.
    expect(stopViewsAt).toBeGreaterThan(-1);
    expect(uninstallCallAt).toBeGreaterThan(stopViewsAt);
    expect(guardAt).toBeGreaterThan(uninstallCallAt);
    expect(clearAt).toBeGreaterThan(guardAt);
  });
});
