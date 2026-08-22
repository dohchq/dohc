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
// The claim accounting both close paths share (panel close and web app tab
// close). Its callers are pinned here and in main.pluginWebAppWiring.test.ts.
const stopPluginHostIfUnclaimedSource = () =>
  functionSource("async function stopPluginHostIfUnclaimed(");

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
    expect(invoke).toContain("activeCommandClaims.claim(claimKey);");
    expect(invoke).toContain("finally {");
    expect(invoke).toContain("activeCommandClaims.release(claimKey);");
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
    expect(workspaceOpen).toContain(
      "await stopPluginWorkspace(activeWorkspaceId).catch((error: unknown) => {",
    );
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

  it("defers to a plugin's own drain barrier instead of stopping its host out of band (round-14 finding 1)", () => {
    const unclaimed = stopPluginHostIfUnclaimedSource();
    const activeClaimAt = unclaimed.indexOf("!activeCommandClaims.has(key)");
    const isDrainingAt = unclaimed.indexOf(
      "!activeCommandClaims.isDraining(key)",
      activeClaimAt,
    );
    const consumeAt = unclaimed.indexOf(
      "(panelStartedHosts.delete(key) || activeCommandClaims.consumeStartedHost(key))",
      isDrainingAt,
    );
    // MUTATION (out-of-band stop): without this check, a command that
    // finishes mid-rebuild consumes the on-demand marker and stops the
    // host directly here — outside the pipeline's own rebuild — while
    // the rebuild still believes that runtime is retained.
    expect(activeClaimAt).toBeGreaterThan(-1);
    expect(isDrainingAt).toBeGreaterThan(activeClaimAt);
    expect(consumeAt).toBeGreaterThan(isDrainingAt);
  });

  it("refuses a new command claim while a plugin is draining, and wires both barrier hooks to the same claims object", () => {
    // raiseDrainBarrier()/drain()/isDraining()'s own semantics are pinned
    // in pluginCommandHostClaims.test.ts. rebuild(), stopOldRuntime, and
    // dispose()'s own use of the returned lower handles are pinned
    // behaviorally in PluginPipeline.test.ts. This only pins that main.ts
    // wires both hooks to the same claims object.
    const invoke = handler("invokePluginCommand");
    const claimKeyAt = invoke.indexOf(
      "const claimKey = pluginLifecycleKey(workspace.workspaceId, input.pluginId);",
    );
    const isDrainingAt = invoke.indexOf(
      "activeCommandClaims.isDraining(claimKey)",
      claimKeyAt,
    );
    const refusalAt = invoke.indexOf('"plugin-rebuilding"', isDrainingAt);
    const refusalMessageAt = invoke.indexOf(
      'dohc is still working on plugin "${input.pluginId}". Try the command again in a moment.',
      refusalAt,
    );
    const claimAt = invoke.indexOf("activeCommandClaims.claim(claimKey);", refusalAt);
    // MUTATION (unbounded wait): dropping this refusal lets a new command
    // join a plugin whose rebuild or workspace close is already draining
    // it, so drain()'s own wait would never end.
    expect(claimKeyAt).toBeGreaterThan(-1);
    expect(isDrainingAt).toBeGreaterThan(claimKeyAt);
    expect(refusalAt).toBeGreaterThan(isDrainingAt);
    // MUTATION (passive voice hides the actor): dohc-interface requires a
    // named actor for a failing action, not a passive "isn't available"
    // that never says who is busy (#779 round 22 finding 6).
    expect(refusalMessageAt).toBeGreaterThan(refusalAt);
    expect(claimAt).toBeGreaterThan(refusalMessageAt);

    const createPipeline = functionSource(
      "function createPluginPipeline(",
    );
    const optionsAt = createPipeline.indexOf("pipeline = new PluginPipeline({");
    const raiseAt = createPipeline.indexOf(
      "raiseCommandClaimsBarrier: (pluginId) =>",
      optionsAt,
    );
    const raiseCallAt = createPipeline.indexOf(
      "activeCommandClaims.raiseDrainBarrier(",
      raiseAt,
    );
    const lowerCallAt = createPipeline.indexOf("lower();", raiseCallAt);
    const stopGateAt = createPipeline.indexOf(
      "if (activeCommandClaims.consumeRuntimeStop(key)) {",
      lowerCallAt,
    );
    const consumeAt = createPipeline.indexOf(
      "activeCommandClaims.consumeStartedHost(key);",
      stopGateAt,
    );
    // MUTATION (stale marker survives a rebuild): a marker not settled at
    // this same lower survives a successful in-queue rebuild that replaced
    // the runtime — a later, unrelated release then finds it and stops the
    // replacement it never claimed (#779 round 19 finding 3).
    expect(lowerCallAt).toBeGreaterThan(raiseCallAt);
    // MUTATION (no-op reconcile eats a live marker): consuming unconditionally
    // here, not only when consumeRuntimeStop reports this exact barrier's own
    // action actually stopped or replaced the runtime, eats a command's own
    // cold-start marker for a no-op reconcile or a precondition-failed action
    // that never touched the runtime — nothing is then left to stop the host
    // it started until workspace close (#779 round 26 note A).
    expect(stopGateAt).toBeGreaterThan(lowerCallAt);
    expect(consumeAt).toBeGreaterThan(stopGateAt);

    const boundaryAt = createPipeline.indexOf(
      "onOldRuntimeStopBoundary: (pluginId) => {",
      optionsAt,
    );
    const boundaryMarkAt = createPipeline.indexOf(
      "activeCommandClaims.markRuntimeStopped(",
      boundaryAt,
    );
    // MUTATION (nothing ever flags the stop): without this wire-up,
    // consumeRuntimeStop above can never report true for any action, so the
    // gate it guards permanently withholds the started-host marker instead
    // of only withholding it from no-op reconciles (#779 round 26 note A).
    expect(boundaryAt).toBeGreaterThan(optionsAt);
    expect(boundaryMarkAt).toBeGreaterThan(boundaryAt);

    const drainedAt = createPipeline.indexOf(
      "awaitCommandClaimsDrained: (pluginId) =>",
      raiseCallAt,
    );
    const deadlineWrapAt = createPipeline.indexOf(
      "awaitCommandClaimsDrainedWithDeadline(",
      drainedAt,
    );
    const drainCallAt = createPipeline.indexOf(
      "activeCommandClaims.drain(",
      deadlineWrapAt,
    );
    const resetAt = createPipeline.indexOf(
      "resetCommandClaims: (pluginId) =>",
      drainCallAt,
    );
    const resetCallAt = createPipeline.indexOf(
      "activeCommandClaims.reset(",
      resetAt,
    );
    // MUTATION (no raise/no wait): missing either wire-up makes the
    // corresponding PluginPipeline hook a no-op (each is optional exactly
    // so a caller without one keeps working) — silently letting a command
    // claim a plugin its own rebuild believes it has exclusive control of.
    expect(optionsAt).toBeGreaterThan(-1);
    expect(raiseAt).toBeGreaterThan(optionsAt);
    expect(raiseCallAt).toBeGreaterThan(raiseAt);
    expect(drainedAt).toBeGreaterThan(raiseCallAt);
    // MUTATION (unbounded teardown): a raw drain() with no deadline wrap
    // lets a hung command's handler block disable/uninstall/rebuild and
    // workspace disposal forever (round-15 finding 3).
    expect(deadlineWrapAt).toBeGreaterThan(drainedAt);
    expect(drainCallAt).toBeGreaterThan(deadlineWrapAt);
    // MUTATION (stale marker survives disposal): a missing reset wire-up
    // leaves a disposed workspace's started-host marker in place, so the
    // next command against a later session reusing the same lifecycle
    // key stops the wrong host (round-15 finding 2).
    expect(resetAt).toBeGreaterThan(drainCallAt);
    expect(resetCallAt).toBeGreaterThan(resetAt);

    // A command's own isDraining check above only runs once, before it
    // claims and before its lifecycle-lock wait — a stopping action can
    // still raise its own barrier and enqueue in that gap. ensurePluginStarted
    // calls the command's own recheck immediately before the pipeline's own
    // enqueue call, with no `await` between the two, so nothing can
    // interleave between them (round-17 finding 2, round-18 finding 1).
    const ensureStartedFn = functionSource("async function ensurePluginStarted(");
    const recheckParamAt = ensureStartedFn.indexOf("recheckCommandClaims?: CommandClaimsRecheck;");
    // The recheck and the enqueue call both live inside this one callback,
    // not the outer async function — declared with a plain `() => {`, not
    // `async () => {`. That declaration is what actually makes an `await`
    // between the two impossible: TypeScript refuses to compile one inside
    // a non-async arrow. A mutation that turns this callback async is the
    // one way "no await between them" could stop being true (#779 round 22
    // finding 7 — the position checks below only proved ordering, not the
    // absence of a gap; this line proves there is structurally no room for
    // one).
    const ensureStartedCallbackAt = ensureStartedFn.indexOf(
      "ensureStarted: () => {",
      recheckParamAt,
    );
    const recheckCallAt = ensureStartedFn.indexOf(
      "options.recheckCommandClaims?.();",
      ensureStartedCallbackAt,
    );
    const pipelineEnsureStartedAt = ensureStartedFn.indexOf(
      "return pipeline.ensureStarted(plugin.manifest.name)",
      recheckCallAt,
    );
    // MUTATION (TOCTOU stall): a recheck that runs anywhere but immediately
    // before this exact call leaves a window where a racing action's own
    // enqueue still lands ahead of this one on the same per-plugin queue —
    // this call's own claim is then the exact thing that action's later
    // stopOldRuntime wait stalls on.
    expect(recheckParamAt).toBeGreaterThan(-1);
    expect(ensureStartedCallbackAt).toBeGreaterThan(recheckParamAt);
    expect(recheckCallAt).toBeGreaterThan(ensureStartedCallbackAt);
    expect(pipelineEnsureStartedAt).toBeGreaterThan(recheckCallAt);
    // MUTATION (async callback reopens the gap): nothing between the two
    // calls but whitespace — an inserted `await` (which the callback's own
    // sync signature above already forbids, so this also catches making
    // the callback async first) or any other statement would push this
    // slice past a bare closing brace.
    const betweenRecheckAndEnsure = ensureStartedFn
      .slice(recheckCallAt + "options.recheckCommandClaims?.();".length, pipelineEnsureStartedAt)
      .trim();
    expect(betweenRecheckAndEnsure).toBe("");
    // MUTATION (raw pipeline error code reaches the panel/web-app catch):
    // narrows PluginPipeline's own open-ended error code down to the one
    // literal the catch above recognizes before it ever reaches
    // startPluginForPanel (#779 round 27).
    const narrowedAt = ensureStartedFn.indexOf(
      ".then(toPluginPanelHostStartResult);",
      pipelineEnsureStartedAt,
    );
    expect(narrowedAt).toBeGreaterThan(pipelineEnsureStartedAt);

    const wireAt = invoke.indexOf(
      "recheckCommandClaims: () =>",
      claimAt,
    );
    const wireCheckAt = invoke.indexOf(
      "activeCommandClaims.isDraining(claimKey)",
      wireAt,
    );
    const wireThrowAt = invoke.indexOf(
      "throw new PluginClaimsDrainingError(",
      wireCheckAt,
    );
    // MUTATION (no recheck): a command path that never supplies this hook
    // leaves ensurePluginStarted's own recheck permanently a no-op — the
    // exact TOCTOU this round closes never gets checked at all.
    expect(wireAt).toBeGreaterThan(-1);
    expect(wireCheckAt).toBeGreaterThan(wireAt);
    expect(wireThrowAt).toBeGreaterThan(wireCheckAt);

    // A stale command's own recheck above can pass once disposal's drain
    // deadline resets the barrier (round-18 finding 2) — the pipeline
    // creation it then reaches must independently refuse a workspace no
    // window has open any more, so ensurePluginPipeline shares one gate
    // with every other caller instead of trusting each one's own point
    // check.
    const ensurePipelineFn = functionSource("async function ensurePluginPipeline(");
    const createOnlyWhileAt = ensurePipelineFn.indexOf("createOnlyWhile: () =>");
    const createOnlyWhileCallAt = ensurePipelineFn.indexOf(
      "isWorkspaceOpenInAnyWindow(workspace.workspaceId)",
      createOnlyWhileAt,
    );
    // MUTATION (zombie pipeline): no createOnlyWhile wire-up leaves
    // ensureWorkspacePipeline's own gate a no-op — a stale caller that
    // waited out a workspace's disposal creates a fresh pipeline for it
    // anyway, even though no window has that workspace open any more.
    expect(createOnlyWhileAt).toBeGreaterThan(-1);
    expect(createOnlyWhileCallAt).toBeGreaterThan(createOnlyWhileAt);
  });

  it("revokes a plugin's panel authorities before disable takes its process (#779 round 12 A4)", () => {
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

    // MUTATION (ordering): revoking after the pipeline call leaves an
    // already-queued panel write holding a live authority for the whole time
    // the pipeline spends stopping the process and deleting the source, which
    // is exactly the window the write completes in. What revocation does to
    // an in-flight write is pinned by behavior in PluginHost.test.ts. disable
    // takes no confirmation to validate first, so revoking ahead of its own
    // call is safe — unlike uninstall, whose own ordering is pinned in
    // main.pluginWebAppWiring.test.ts.
    expect(disableAt).toBeGreaterThan(-1);
    expect(disableRevokeAt).toBeGreaterThan(-1);
    expect(disableCallAt).toBeGreaterThan(disableRevokeAt);
  });

  it("revokes a plugin's panel authorities only once no installed claimant survives its own uninstall", () => {
    const uninstall = handler("uninstallPlugin");
    const uninstallCallAt = uninstall.indexOf(
      "await pipeline.uninstall(input.pluginId, input.directoryName, input.confirmationToken),",
    );
    const stillInstalledClaimantAt = uninstall.indexOf(
      "pluginIdHasInstalledClaimant(pipeline, input.pluginId)",
      uninstallCallAt,
    );
    const uninstallRevokeAt = uninstall.indexOf(
      "revokePluginPanels(input.workspaceId, input.pluginId);",
      stillInstalledClaimantAt,
    );

    // MUTATION (revoke before the result, or unconditionally): a collision
    // loser's own uninstall must never tear down panel authorities a
    // still-installed winner sharing this id genuinely owns — revoking has
    // to wait for both the pipeline's own result AND proof no installed
    // claimant of this id survives. The gate's own predicate is pinned by
    // name in main.pluginWebAppWiring.test.ts, and its partition-clear
    // sibling is pinned end to end there too.
    expect(uninstallCallAt).toBeGreaterThan(-1);
    expect(stillInstalledClaimantAt).toBeGreaterThan(uninstallCallAt);
    expect(uninstallRevokeAt).toBeGreaterThan(stillInstalledClaimantAt);
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
      "stopPluginWebAppsForPlugin(workspaceId, pluginId);",
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
    // indefinitely and starves stopPluginHostIfUnclaimed (#779 round 20
    // finding 1).
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
      "stopPluginPanel(panel.workspaceId, panel.pluginId, panel.panelId)",
      filterAt,
    );
    // MUTATION (wrong window's panels stopped, or none at all): a filter
    // on any field but senderId either tears down a surviving window's
    // own panels on the same shared workspace, or never reaches this
    // sender's own — either way a guest record outlives the window that
    // opened it.
    expect(filterAt).toBeGreaterThan(-1);
    expect(stopCallAt).toBeGreaterThan(filterAt);

    const surfacesForSender = functionSource(
      "async function stopPluginSurfacesForSender(",
    );
    const webAppsAt = surfacesForSender.indexOf(
      "const removedWebApps = pluginWebAppViews.removeForSender(senderId);",
    );
    const destroyAt = surfacesForSender.indexOf(
      "destroyPluginWebAppViews(removedWebApps);",
      webAppsAt,
    );
    const unclaimedAt = surfacesForSender.indexOf(
      "stopPluginHostIfUnclaimed(workspaceId, pluginId)",
      destroyAt,
    );
    const panelsAt = surfacesForSender.indexOf(
      "await stopPluginPanelsForSender(senderId);",
      unclaimedAt,
    );
    // MUTATION (host claim leak): destroying a sender's own web app view
    // without also checking whether anything else still claims that host
    // leaves a cold-started process running forever once the window that
    // started it is gone (#779 round 21 finding 2).
    expect(destroyAt).toBeGreaterThan(webAppsAt);
    expect(unclaimedAt).toBeGreaterThan(destroyAt);
    // MUTATION (one surface type left behind): a caller reaching only one
    // of these still starves stopPluginHostIfUnclaimed of the other kind
    // of claim this sender's own window left behind.
    expect(webAppsAt).toBeGreaterThan(-1);
    expect(panelsAt).toBeGreaterThan(webAppsAt);
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
