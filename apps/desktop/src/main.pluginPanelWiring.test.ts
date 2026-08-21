import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPluginPanelFileWatchEmitter } from "./plugins/pluginPanelSdkEvent";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handler(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle(CHANNELS.${channel}`);
  expect(start).toBeGreaterThan(-1);
  return mainSource.slice(start, mainSource.indexOf("\n  });", start));
}

function functionSource(signature: string): string {
  const start = mainSource.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

const stopPluginPanelSource = () =>
  functionSource("async function stopPluginPanel(");
// The claim accounting both close paths share (panel close and web app tab
// close). Its callers are pinned here and in main.pluginWebAppWiring.test.ts.
const stopPluginHostIfUnclaimedSource = () =>
  functionSource("async function stopPluginHostIfUnclaimed(");

describe("plugin panel main-process wiring", () => {
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

  it("validates a contained plugin registration before starting its host", () => {
    const open = handler("openPluginPanel");
    const loadAt = open.indexOf(
      "loadPluginPanelRegistrationForCurrentRenderer(",
    );
    const currentAt = open.indexOf("isCurrent,", loadAt);
    const rememberAt = open.indexOf("rememberPluginRegistration(");
    const lockAt = open.indexOf("await withPluginPanelStartLock(");
    const startAt = open.indexOf(
      "return ensurePluginStarted(workspace, plugin)",
    );

    expect(loadAt).toBeGreaterThan(-1);
    expect(currentAt).toBeGreaterThan(loadAt);
    expect(currentAt).toBeLessThan(rememberAt);
    expect(rememberAt).toBeGreaterThan(loadAt);
    expect(lockAt).toBeGreaterThan(rememberAt);
    expect(open).toContain("withPluginHostLifecycleLock(");
    expect(open).toContain("assertPluginPanelRequestCurrent(isCurrent);");
    expect(startAt).toBeGreaterThan(lockAt);
    expect(open).toContain(
      "pluginRegistration: pluginPipelines.get(workspace.workspaceId),",
    );
  });

  it("serves the manifest panel and grants only main-derived SDK context", () => {
    const start = handler("startPluginPanel");
    const serveAt = start.indexOf("startStaticDirectoryPreview(dirname(entryPath)");
    const allowAt = start.indexOf("allowLoopbackFrameOrigin(handle.url)");
    const rememberAt = start.indexOf("runningPluginPanels.set(key");
    const grantAt = start.indexOf("pluginPanelSdkAuthorities.register({");
    const disposeAt = start.indexOf(".disposeOwner({", grantAt);

    expect(serveAt).toBeGreaterThan(-1);
    expect(allowAt).toBeGreaterThan(serveAt);
    expect(rememberAt).toBeGreaterThan(allowAt);
    expect(grantAt).toBeGreaterThan(rememberAt);
    expect(disposeAt).toBeGreaterThan(grantAt);
    expect(start).toContain("grant.signal.addEventListener(");
    expect(start).toContain("startPluginPanelWithLock(");
    expect(start).toContain("withPluginHostLifecycleLock,");
    expect(start).toContain("() => ensurePluginStarted(workspace, plugin)");
    expect(start).toContain("await stopRunningPluginPanelPreview(previous);");

    const stop = stopPluginPanelSource();
    expect(stop).toContain("stopPluginPanelWithLock(");
    expect(stop).toContain("withPluginHostLifecycleLock,");
    expect(stop).toContain("await stopRunningPluginPanelPreview(panel);");
    // The host itself is released through the shared claim accounting, whose
    // body this file pins below.
    expect(stop).toContain(
      "await stopPluginHostIfUnclaimed(workspaceId, pluginId);",
    );
  });

  it("starts a panel only where its manifest places it, and serves a view with no tab (B1)", () => {
    const start = handler("startPluginPanel");
    const panelAt = start.indexOf("plugin.manifest.panels?.find(");
    const placementAt = start.indexOf("panel.placement !== input.placement");
    const lockAt = start.indexOf("startPluginPanelWithLock(");

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
    const pipelineAt = invoke.indexOf("await ensurePluginPipeline(workspace);");
    const lookupAt = invoke.indexOf("registeredPlugin(");
    const routeAt = invoke.indexOf("invokeRegisteredPluginCommand({");
    const lockAt = invoke.indexOf("return withPluginHostLifecycleLock(", routeAt);
    const startAt = invoke.indexOf("ensurePluginStarted(", lockAt);

    expect(currentAt).toBeGreaterThan(-1);
    expect(pipelineAt).toBeGreaterThan(currentAt);
    expect(lookupAt).toBeGreaterThan(pipelineAt);
    expect(routeAt).toBeGreaterThan(lookupAt);
    expect(lockAt).toBeGreaterThan(routeAt);
    expect(startAt).toBeGreaterThan(lockAt);
    expect(invoke).toContain("assertWritableWorkspace(workspace);");
    expect(invoke).toContain(
      "pluginLifecycleKey(workspace.workspaceId, input.pluginId)",
    );
    expect(invoke).toContain("claim: false");
    expect(invoke).toContain("claimHostForCommand(claimKey);");
    expect(invoke).toContain("finally {");
    expect(invoke).toContain("releaseHostForCommand(claimKey);");
    expect(invoke).toContain(
      "() => stopPluginHostIfUnclaimed(workspace.workspaceId, input.pluginId)",
    );
    // A `finally` that itself throws replaces whatever the `try` returned
    // or threw — so this cleanup must be contained, or a host-stop
    // rejection would reach the renderer in place of a command result the
    // invocation already earned (round-8 finding 4). The isolation and
    // always-run guarantees of that shape are behavioral, not
    // grep-provable; pinned by finding-4's own containment test below,
    // this only pins that the containment is actually wired here.
    const finallyAt = invoke.indexOf("} finally {");
    const stopCallAt = invoke.indexOf(
      "() => stopPluginHostIfUnclaimed(workspace.workspaceId, input.pluginId)",
      finallyAt,
    );
    const catchAt = invoke.indexOf("} catch (error) {", stopCallAt);
    const warnAt = invoke.indexOf("console.warn(", catchAt);
    expect(finallyAt).toBeGreaterThan(-1);
    expect(stopCallAt).toBeGreaterThan(finallyAt);
    expect(catchAt).toBeGreaterThan(stopCallAt);
    expect(warnAt).toBeGreaterThan(catchAt);
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
    // What forgetRemovedPlugin does — clearing the registration and the
    // panel host claim only for a removed event — is pinned by behavior in
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
    expect(notify).toContain("panelStartedHosts,");
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
    expect(workspaceOpen).toContain("void stopPluginWorkspace(activeWorkspaceId);");
    expect(workspaceOpen).toContain("await stopPluginWorkspace(previousWorkspaceId);");
    expect(willQuit).toContain("pluginPanelSdkAuthorities.revokeAll();");
    expect(willQuit).toContain("const pluginStop = stopAllPluginWorkspaces();");
  });

  it("derives panel writability from the current workspace on every invocation", () => {
    const invoke = handler("invokePluginPanelSdk");

    expect(invoke).not.toContain("writable: authority.writable");
    expect(invoke).toContain("isWritable: () => !sharedViewOf(authority.workspaceId)");
  });

  it("skips plugin-pipeline warmup when a later openWorkspace switched away first (#779 round 4 finding 1)", () => {
    const open = handler("openWorkspace");
    const awaitAt = open.indexOf(
      "const status = SyncStatusResult.parse(await openWorkspaceActivity(workspace));",
    );
    const recheckAt = open.indexOf(
      "const stillActive = activeWorkspaceIdBySender.get(senderId) === workspace.workspaceId;",
      awaitAt,
    );
    const warmupAt = open.indexOf("await ensurePluginPipeline(workspace)", recheckAt);

    // MUTATION (open race): without a recheck after the await, a sender that
    // switched workspaces while this call's openWorkspaceActivity was still
    // pending would warm the plugin pipeline for the workspace it just left
    // instead of the one it is actually on now.
    expect(awaitAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(awaitAt);
    expect(warmupAt).toBeGreaterThan(recheckAt);
    expect(open).toContain("stillActive && !sharedViewOf(workspace.workspaceId)");
  });

  it("stops a host on last-panel-close only when a panel is the reason it's running (#779 round 4 finding 3)", () => {
    // Claiming the host is startPluginForPanel's job and is pinned by
    // behavior in pluginPanelRegistration.test.ts. Source-text assertions
    // about it survived a mutation that claimed the host unconditionally
    // (CERT779J S1), so they are gone.
    // The panel close reaches the host only through the shared claim
    // accounting, so the guard lives in that helper's body.
    expect(stopPluginPanelSource()).toContain(
      "await stopPluginHostIfUnclaimed(workspaceId, pluginId);",
    );
    const unclaimed = stopPluginHostIfUnclaimedSource();
    const hasAnotherAt = unclaimed.indexOf("hasAnotherPanel");
    const deleteAt = unclaimed.indexOf("panelStartedHosts.delete(key)");
    const stopHostAt = unclaimed.indexOf(
      "await pluginPipelines.get(workspaceId)?.host.stop(pluginId);",
    );
    // MUTATION (ownership): dropping the panelStartedHosts.delete() guard
    // (leaving only !hasAnotherPanel) stops every plugin's host on its last
    // panel close, including one the workspace itself enabled and expects
    // to keep running with no panel open at all.
    expect(hasAnotherAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(hasAnotherAt);
    expect(stopHostAt).toBeGreaterThan(deleteAt);

    const pluginActionStart = mainSource.indexOf("const pluginAction = (");
    const pluginActionEnd = mainSource.indexOf("\n  };\n\n  pluginAction(", pluginActionStart);
    expect(pluginActionEnd).toBeGreaterThan(-1);
    const pluginAction = mainSource.slice(pluginActionStart, pluginActionEnd);
    expect(pluginAction).toContain("if (result.ok) {");
    expect(pluginAction).toContain("panelStartedHosts.delete(key);");
    expect(pluginAction).toContain("activeCommandClaims.consumeStartedHost(key);");
  });

  it("stops a surface-less host a command cold-started once its own claim is the last to release (round-9 finding 1)", () => {
    // The refcount and the on-demand marker's actual claim/release/mark/
    // consume behavior are pinned in pluginCommandHostClaims.test.ts, and
    // the callback that reports a cold start under claim: false is pinned
    // behaviorally in pluginPanelRegistration.test.ts. This only pins that
    // main.ts wires those two pieces together correctly.
    const invoke = handler("invokePluginCommand");
    const ensureStartedAt = invoke.indexOf("ensureStarted: async () => {");
    const startAt = invoke.indexOf(
      "ensurePluginStarted(workspace, plugin, {",
      ensureStartedAt,
    );
    const claimFalseAt = invoke.indexOf("claim: false,", startAt);
    const onColdStartAt = invoke.indexOf("onColdStartWithoutClaim: () =>", claimFalseAt);
    const markAt = invoke.indexOf(
      "activeCommandClaims.markStartedHost(claimKey)",
      onColdStartAt,
    );
    expect(ensureStartedAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(ensureStartedAt);
    expect(claimFalseAt).toBeGreaterThan(startAt);
    expect(onColdStartAt).toBeGreaterThan(claimFalseAt);
    expect(markAt).toBeGreaterThan(onColdStartAt);

    const unclaimed = stopPluginHostIfUnclaimedSource();
    const activeClaimAt = unclaimed.indexOf("!activeCommandClaims.has(key)");
    const orAt = unclaimed.indexOf(
      "(panelStartedHosts.delete(key) || activeCommandClaims.consumeStartedHost(key))",
      activeClaimAt,
    );
    // MUTATION (leak): dropping the "|| activeCommandClaims.consumeStartedHost(key)"
    // half leaves panelStartedHosts.delete(key) as the sole trigger, which a
    // command's cold start (claim: false) never populates — the exact way a
    // surface-less command-started host used to never stop.
    expect(activeClaimAt).toBeGreaterThan(-1);
    expect(orAt).toBeGreaterThan(activeClaimAt);
  });

  it("refuses a new command claim while a rebuild is draining it, and wires the pipeline's drain wait (round-10 finding 2)", () => {
    // drain()/isDraining()'s own semantics — the synchronous marking, the
    // resolve-only-once-existing-claims-release behavior — are pinned in
    // pluginCommandHostClaims.test.ts. stopOldRuntime genuinely awaiting
    // the injected drain before pluginHost.stop() is pinned behaviorally
    // in PluginPipeline.test.ts. This only pins that main.ts wires the
    // refusal and the drain callback to the same claims object.
    const invoke = handler("invokePluginCommand");
    const claimKeyAt = invoke.indexOf(
      "const claimKey = pluginLifecycleKey(workspace.workspaceId, input.pluginId);",
    );
    const isDrainingAt = invoke.indexOf(
      "activeCommandClaims.isDraining(claimKey)",
      claimKeyAt,
    );
    const refusalAt = invoke.indexOf('"plugin-rebuilding"', isDrainingAt);
    const claimAt = invoke.indexOf("claimHostForCommand(claimKey);", refusalAt);
    // MUTATION (unbounded wait): dropping this refusal lets a new command
    // join a plugin whose rebuild is already draining it — the exact
    // "chasing future arrivals instead of the claims it began with" case
    // drain() is built to never do on its own.
    expect(claimKeyAt).toBeGreaterThan(-1);
    expect(isDrainingAt).toBeGreaterThan(claimKeyAt);
    expect(refusalAt).toBeGreaterThan(isDrainingAt);
    expect(claimAt).toBeGreaterThan(refusalAt);

    const createPipeline = functionSource(
      "function createPluginPipeline(",
    );
    const optionsAt = createPipeline.indexOf("pipeline = new PluginPipeline({");
    const drainedAt = createPipeline.indexOf(
      "awaitCommandClaimsDrained: (pluginId) =>",
      optionsAt,
    );
    const drainCallAt = createPipeline.indexOf(
      "activeCommandClaims.drain(",
      drainedAt,
    );
    // MUTATION (no wait): without this wire-up, stopOldRuntime's own
    // awaitCommandClaimsDrained call is a no-op (it's optional exactly so
    // every caller without one keeps working), and every claim this
    // handler makes stops meaning anything to a rebuild's stop.
    expect(optionsAt).toBeGreaterThan(-1);
    expect(drainedAt).toBeGreaterThan(optionsAt);
    expect(drainCallAt).toBeGreaterThan(drainedAt);
  });

  it("revokes a plugin's panel authorities before disable and uninstall take its process (#779 round 12 A4)", () => {
    const disableAt = mainSource.indexOf(
      "pluginAction(CHANNELS.disablePlugin,",
    );
    const disableRevokeAt = mainSource.indexOf(
      "revokePluginPanels(workspaceId, pluginId);",
      disableAt,
    );
    const disableCallAt = mainSource.indexOf(
      "return pipeline.disable(pluginId);",
      disableAt,
    );
    const uninstall = handler("uninstallPlugin");
    const uninstallRevokeAt = uninstall.indexOf(
      "revokePluginPanels(input.workspaceId, input.pluginId);",
    );
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.confirmationToken),",
    );

    // MUTATION (ordering): revoking after the pipeline call leaves an
    // already-queued panel write holding a live authority for the whole time
    // the pipeline spends stopping the process and deleting the source, which
    // is exactly the window the write completes in. What revocation does to
    // an in-flight write is pinned by behavior in PluginHost.test.ts.
    expect(disableAt).toBeGreaterThan(-1);
    expect(disableRevokeAt).toBeGreaterThan(-1);
    expect(disableCallAt).toBeGreaterThan(disableRevokeAt);
    expect(uninstallRevokeAt).toBeGreaterThan(-1);
    expect(uninstallCallAt).toBeGreaterThan(uninstallRevokeAt);
  });
});
