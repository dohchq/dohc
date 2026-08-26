import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts is the Electron entry point: it cannot be imported under vitest, so
// this suite guards the bootstrap gate the way main.chatSecurity.test.ts guards
// chat authorization — by reading the source it protects.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function ipcHandlerSource(channel: string): string {
  const marker = `ipcMain.handle(CHANNELS.${channel},`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${channel} IPC handler`);
  const next = mainSource.indexOf("ipcMain.handle(", start + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

function handlerSource(event: string): string {
  const marker = `app.on("${event}",`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing app.on("${event}") handler`);
  const next = mainSource.indexOf("app.on(", start + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

// Every handler that can reach showOrCreateMainWindow before the whenReady
// continuation finishes. app.isReady() turns true too early to gate them.
const WINDOW_CREATING_HANDLERS = ["open-file", "second-instance", "activate"];

describe("bootstrap window gate", () => {
  it("tracks bootstrap completion as a single flag that only ever opens", () => {
    expect(mainSource).toContain("let bootstrapComplete = false;");
    expect(mainSource.split("bootstrapComplete = true").length - 1).toBe(1);
    // A second `= false` write re-closes the gate for the rest of the process:
    // on macOS, closing the last window would then kill every dock click.
    expect(mainSource.split("bootstrapComplete = false").length - 1).toBe(1);
  });

  // A gate that only precedes the window call is not a gate: control has to
  // leave the handler, so the guarded branch must return.
  it.each(WINDOW_CREATING_HANDLERS)(
    "gates the %s handler on the bootstrap flag and returns out of the closed gate",
    (event) => {
      const handler = handlerSource(event);
      expect(handler).not.toContain("app.isReady()");
      const gateAt = handler.indexOf("if (!bootstrapComplete)");
      const createAt = handler.indexOf("showOrCreateMainWindow");
      expect(gateAt).toBeGreaterThanOrEqual(0);
      // Every one of these handlers opens its window through this call. Skipping
      // the assertions when it is absent would excuse a handler that switched to
      // createMainWindow instead.
      expect(createAt).toBeGreaterThanOrEqual(0);

      const returnAt = handler.indexOf("return;", gateAt);
      expect(returnAt).toBeGreaterThan(gateAt);
      expect(returnAt).toBeLessThan(createAt);
      // Whatever the guard does before returning, it cannot open a window —
      // by either name, including the dynamic import of the window module.
      const guardBody = handler.slice(gateAt, returnAt);
      expect(guardBody).not.toContain("showOrCreateMainWindow");
      expect(guardBody).not.toContain("createMainWindow(");
      expect(guardBody).not.toContain("window/createMainWindow");
    },
  );

  it("keeps an opened file's path for the deferred flush", () => {
    const handler = handlerSource("open-file");
    const queueAt = handler.indexOf("pendingOpenPaths.push(path)");
    const gateAt = handler.indexOf("if (!bootstrapComplete)");
    expect(queueAt).toBeGreaterThanOrEqual(0);
    // Queued before the gate, so a closed gate returns having kept the path.
    expect(queueAt).toBeLessThan(gateAt);
  });

  it("keeps a second instance's workspace paths for the deferred flush", () => {
    const handler = handlerSource("second-instance");
    const gateAt = handler.indexOf("if (!bootstrapComplete)");
    const queueAt = handler.indexOf(
      "pendingOpenPaths.push(...collectOpenWorkspaceArgs(argv))",
    );
    expect(queueAt).toBeGreaterThan(gateAt);
    expect(queueAt).toBeLessThan(handler.indexOf("return;", gateAt));
    expect(queueAt).toBeLessThan(handler.indexOf("showOrCreateMainWindow"));
  });

  it("opens the gate only after both the daemon and the window", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const daemonStartAt = mainSource.indexOf(
      "engineDaemonStartup = startRustEngineDaemon();",
      whenReadyAt,
    );
    const ipcAt = mainSource.indexOf("registerIpcHandlers();", whenReadyAt);
    const createWindowAt = mainSource.indexOf("createMainWindow({", whenReadyAt);
    const daemonGateAt = mainSource.indexOf(
      "if (!(await engineDaemonStartup)) return;",
      whenReadyAt,
    );
    const openGateAt = mainSource.indexOf("bootstrapComplete = true", whenReadyAt);

    expect(whenReadyAt).toBeGreaterThanOrEqual(0);
    // The daemon starts first and handshakes concurrently with everything up
    // to the gate that awaits it.
    expect(daemonStartAt).toBeGreaterThan(whenReadyAt);
    // The renderer's first IPC call races the daemon handshake, so the
    // handlers must exist before the window starts loading.
    expect(ipcAt).toBeGreaterThan(daemonStartAt);
    expect(createWindowAt).toBeGreaterThan(ipcAt);
    // The window is created BEFORE the daemon resolves — that concurrency is
    // the point — and the gate opens only after both.
    expect(daemonGateAt).toBeGreaterThan(createWindowAt);
    expect(openGateAt).toBeGreaterThan(daemonGateAt);
  });

  // D1#9: appReady must measure Electron readiness, not daemon boot — it used
  // to be marked after the daemon await. daemonReady lands where the handshake
  // actually completes, inside startRustEngineDaemon: the bootstrap gate's
  // await also covers the cached-settings read, which would inflate the mark.
  it("marks app-ready before the daemon starts and daemon-ready at handshake completion", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const appReadyMarkAt = mainSource.indexOf(
      "launchMarks.appReady();",
      whenReadyAt,
    );
    const daemonStartAt = mainSource.indexOf(
      "engineDaemonStartup = startRustEngineDaemon();",
      whenReadyAt,
    );
    expect(appReadyMarkAt).toBeGreaterThan(whenReadyAt);
    expect(appReadyMarkAt).toBeLessThan(daemonStartAt);

    const startFnAt = mainSource.indexOf("async function startRustEngineDaemon(");
    const daemonReadyMarkAt = mainSource.indexOf(
      "launchMarks.daemonReady();",
      startFnAt,
    );
    const successReturnAt = mainSource.indexOf("return true;", startFnAt);
    const catchAt = mainSource.indexOf("\n  } catch (error) {", startFnAt);
    expect(startFnAt).toBeGreaterThanOrEqual(0);
    expect(daemonReadyMarkAt).toBeGreaterThan(startFnAt);
    // Before the success return — so inside the try, on the handshake path,
    // never on the failure path.
    expect(daemonReadyMarkAt).toBeLessThan(successReturnAt);
    expect(successReturnAt).toBeLessThan(catchAt);
  });

  // The window loads while the daemon handshakes, so a fast renderer can call
  // engine-backed IPC before sessions exist. The boot-reachable entry awaits
  // the handshake instead of throwing the broken-invariant sessions error.
  it("holds physical workspace authority while daemon startup settles", () => {
    const openActivityAt = mainSource.indexOf(
      "async function openWorkspaceActivityForOperation(",
    );
    expect(openActivityAt).toBeGreaterThanOrEqual(0);
    const retainAt = mainSource.indexOf(
      "operation.state.retainedActivity = true;",
      openActivityAt,
    );
    expect(retainAt).toBeGreaterThan(openActivityAt);
    expect(mainSource.slice(openActivityAt, retainAt)).toContain(
      "await engineDaemonStartup;",
    );
    const wrapperAt = mainSource.indexOf("function openWorkspaceActivityWith(");
    expect(wrapperAt).toBeGreaterThan(retainAt);
    expect(
      mainSource.slice(wrapperAt, mainSource.indexOf("\n}", wrapperAt)),
    ).toContain("withPhysicalWorkspaceOperation(");
  });

  it("prepares search activity inside its held exact operation", () => {
    const searchAt = mainSource.indexOf("registerWorkspaceSearchIpcHandlers<");
    expect(searchAt).toBeGreaterThanOrEqual(0);
    const wiring = mainSource.slice(searchAt, searchAt + 2200);
    const acquireAt = wiring.indexOf("withRendererWorkspaceOperation(");
    const activityAt = wiring.indexOf("await openWorkspaceActivityForOperation(");
    const recheckAt = wiring.indexOf("operation.assertCurrent();", activityAt);
    const forwardAt = wiring.indexOf("return work({", recheckAt);
    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(activityAt).toBeGreaterThan(acquireAt);
    expect(recheckAt).toBeGreaterThan(activityAt);
    expect(forwardAt).toBeGreaterThan(recheckAt);
  });

  // The shell's mount-time cloudStatus and the share view's on-open
  // auto-refresh both race the handshake; ungated, each surfaces the
  // broken-invariant sessions error as a user-visible failure.
  it("gates cloudStatus and refreshSharedView on the daemon startup promise", () => {
    const cloudStatus = ipcHandlerSource("cloudStatus");
    const gateAt = cloudStatus.indexOf("await engineDaemonStartup;");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(cloudStatus.indexOf("requireEngineSessions()"));

    const refresh = ipcHandlerSource("refreshSharedView");
    const acquireAt = refresh.indexOf("withRendererWorkspaceOperation(");
    const refreshGateAt = refresh.indexOf("await engineDaemonStartup;");
    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(refreshGateAt).toBeGreaterThan(acquireAt);
  });

  // A mount operation acquires physical authority before awaiting the daemon,
  // so retirement cannot replace its canonical root during startup.
  it("holds share mount authority across daemon startup", () => {
    const commandsAt = mainSource.indexOf("const shareMountCommands:");
    expect(commandsAt).toBeGreaterThanOrEqual(0);
    const wiring = mainSource.slice(
      commandsAt,
      mainSource.indexOf("shareViewFiles =", commandsAt),
    );
    const acquireAt = wiring.indexOf("withPhysicalWorkspaceOperation(");
    const gateAt = wiring.indexOf("await engineDaemonStartup;");
    const forwardAt = wiring.indexOf("operation.state.shareMountCommands.mount(");
    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(acquireAt);
    expect(forwardAt).toBeGreaterThan(gateAt);
  });

  // The engine-backed listing branches await the handshake; the plain disk
  // listing must NOT, or every workspace's first file list would serialize
  // behind the daemon and undo the concurrent boot.
  it("gates only the share-backed file listing branches on the daemon startup", () => {
    const listAt = mainSource.indexOf("async function listOwnedWorkspaceFilesFor(");
    expect(listAt).toBeGreaterThanOrEqual(0);
    const body = mainSource.slice(
      listAt,
      mainSource.indexOf("\nfunction ", listAt),
    );
    const standaloneAt = body.indexOf("shareViewFiles.list({");
    const diskAt = body.indexOf("await listFiles(workspace.rootPath);");
    const overlayAt = body.indexOf("overlayCanonicalShareMountFiles({");
    const firstGateAt = body.indexOf("await engineDaemonStartup;");
    const secondGateAt = body.indexOf("await engineDaemonStartup;", firstGateAt + 1);
    expect(firstGateAt).toBeGreaterThanOrEqual(0);
    expect(firstGateAt).toBeLessThan(standaloneAt);
    // The disk listing sits between the two gates: after the share-view
    // return, before the mount overlay's gate.
    expect(diskAt).toBeGreaterThan(standaloneAt);
    expect(secondGateAt).toBeGreaterThan(diskAt);
    expect(secondGateAt).toBeLessThan(overlayAt);
  });

  // Share-backed file reads answer from the engine share store, and a
  // restored share tab's first read races the handshake. Ungated, it errors
  // once and nothing retries it: a current share reports zero changed paths,
  // so no refresh-key bump ever re-reads the tab. Only the share branch calls
  // `read`, so local disk reads must stay ungated.
  it("gates share-backed file reads on the daemon startup promise", () => {
    const gateAt = mainSource.indexOf("const gatedShareViewFileReads");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    const wrapper = mainSource.slice(gateAt, mainSource.indexOf("\n};", gateAt));
    const wrapperGateAt = wrapper.indexOf("await engineDaemonStartup;");
    const forwardAt = wrapper.indexOf("shareViewFiles.read(");
    expect(wrapperGateAt).toBeGreaterThanOrEqual(0);
    expect(forwardAt).toBeGreaterThan(wrapperGateAt);
    // Both operation-scoped owned readers route their share branch through the gate.
    for (const reader of [
      "function readOwnedWorkspaceTextFor(",
      "function readOwnedWorkspaceAssetFor(",
    ]) {
      const readerAt = mainSource.indexOf(reader);
      expect(readerAt).toBeGreaterThanOrEqual(0);
      const body = mainSource.slice(readerAt, mainSource.indexOf("\n}", readerAt));
      expect(body).toContain("files: gatedShareViewFileReads");
    }
  });

  // The adapter behavior suite owns the startup/reload interleavings. This
  // source check pins only the Electron composition that supplies that port.
  it("routes engine Y.Doc opens through the startup-aware owner", () => {
    const ownerAt = mainSource.indexOf("const engineYDocSessionIpc =");
    expect(ownerAt).toBeGreaterThanOrEqual(0);
    const owner = mainSource.slice(ownerAt, mainSource.indexOf("\n});", ownerAt));
    expect(owner).toContain("const lease = requireWorkspaceAuthority(workspaceId);");
    expect(owner).toContain(
      "captureFor: (workspace) => activity.engineCaptureFor(workspace.workspaceId, workspace.rootPath)",
    );
    expect(owner).toContain("ensureCaptureFor: async (workspace) => {");
    expect(owner).toContain(
      "await openWorkspaceActivity(requireWorkspace(workspace.workspaceId));",
    );

    const handler = ipcHandlerSource("engineYDocOpen");
    expect(handler).toContain(
      "return engineYDocSessionIpc.open(event.sender, payload);",
    );
  });

  // The persisted zoom must be KNOWN before the first window exists:
  // trackWorkspaceWindow applies a known level synchronously at creation,
  // before any show(), while its async read lands only after ready-to-show's
  // show() — a wrong-scale first frame that firstPaint would then describe.
  it("resolves the persisted zoom before creating the first window", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const settingsAwaitAt = mainSource.indexOf(
      "await cachedSettingsRead",
      whenReadyAt,
    );
    const zoomSeedAt = mainSource.indexOf("knownZoomLevel ??=", whenReadyAt);
    const createWindowAt = mainSource.indexOf("createMainWindow({", whenReadyAt);
    expect(settingsAwaitAt).toBeGreaterThan(whenReadyAt);
    expect(zoomSeedAt).toBeGreaterThan(settingsAwaitAt);
    expect(zoomSeedAt).toBeLessThan(createWindowAt);
  });

  // Indentation is the cheap proof of nesting: four spaces is the continuation
  // body. A gate opened inside any `if` would sit deeper, and a launch that
  // missed that condition would never open the gate at all.
  it("opens the gate unconditionally, not inside a branch", () => {
    expect(mainSource).toContain("\n    bootstrapComplete = true;\n");
  });

  it("drains queued paths after the daemon and sends activation on the load promise", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const createWindowAt = mainSource.indexOf("createMainWindow({", whenReadyAt);
    const listenerAt = mainSource.indexOf('once("did-finish-load"', createWindowAt);
    const daemonGateAt = mainSource.indexOf(
      "if (!(await engineDaemonStartup)) return;",
      whenReadyAt,
    );
    const drainAt = mainSource.indexOf(
      "const pendingWorkspace = await flushPendingOpenPaths();",
      whenReadyAt,
    );
    const mergeAt = mainSource.indexOf(
      "pendingWorkspace ?? launchWorkspace",
      drainAt,
    );
    const chainAt = mainSource.indexOf("void windowLoaded.then(", mergeAt);
    const sendAt = mainSource.indexOf(
      "sendWorkspaceActivated(window, activatedWorkspace)",
      chainAt,
    );
    const residualDrainAt = mainSource.indexOf(
      "void flushPendingOpenPaths(window);",
      sendAt,
    );
    const openGateAt = mainSource.indexOf("bootstrapComplete = true", drainAt);

    // Creating the window starts the load. The load promise must be armed in
    // the same tick — an await in between lets did-finish-load fire first,
    // and `once` then never resolves it.
    expect(createWindowAt).toBeGreaterThan(whenReadyAt);
    expect(listenerAt).toBeGreaterThan(createWindowAt);
    expect(mainSource.slice(createWindowAt, listenerAt)).not.toContain("await");
    // Opening workspaces needs the daemon, so the drains follow its gate. The
    // activation send chains on the armed load promise: the renderer has
    // subscribed by load-finish, and being last this send wins over any
    // activation an open above sent into a still-loading window.
    expect(drainAt).toBeGreaterThan(daemonGateAt);
    expect(mergeAt).toBeGreaterThan(drainAt);
    expect(chainAt).toBeGreaterThan(mergeAt);
    expect(sendAt).toBeGreaterThan(chainAt);
    // A path can arrive while the drain above awaits: it is queued behind an
    // open gate, so the chain has to flush the remainder or it sits there.
    expect(residualDrainAt).toBeGreaterThan(sendAt);
    expect(openGateAt).toBeGreaterThan(drainAt);
  });

  // The load promise carries the activation send and the residual drain, so a
  // launch with no workspace to activate must still arm it.
  it("arms the window's load promise unconditionally", () => {
    expect(mainSource).toContain("\n    const windowLoaded = new Promise<void>(");
  });

  // Resolving the binary path can throw (a packaged build with no resources
  // path). Outside the try it rejects the whenReady callback instead, so the
  // user gets an unhandled rejection on the one path whose job is to explain
  // why the engine could not start.
  it("resolves the engine binary path inside the failure dialog's try", () => {
    const startAt = mainSource.indexOf("async function startRustEngineDaemon(");
    expect(startAt).toBeGreaterThanOrEqual(0);
    const tryAt = mainSource.indexOf("\n  try {", startAt);
    const resolveAt = mainSource.indexOf("defaultEngineBinaryPath({", startAt);
    const catchAt = mainSource.indexOf("\n  } catch (error) {", startAt);
    expect(tryAt).toBeGreaterThan(startAt);
    expect(resolveAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(resolveAt);
    // The daemon handle is now assigned inside the try, so a throw before that
    // assignment reaches a catch that must not dereference it.
    const handler = mainSource.slice(catchAt, catchAt + 1800);
    expect(handler).toContain('"Rust engine failed to start"');
    // Contained: a stop() rejection would otherwise reject engineDaemonStartup
    // itself, skip the destroy below, and rethrow from every gated await.
    expect(handler).toContain("await rustEngineDaemon?.stop().catch(");
    // The window can already be up — it loads during the handshake — and its
    // renderer can hold edits by the time the failure dialog is dismissed.
    // The teardown must go through app.quit() so before-quit and the quit
    // guard's ask run; a destroy() here skips beforeunload and discards
    // renderer-held work silently.
    expect(handler).toContain("app.quit();");
    expect(handler).not.toContain("window.destroy()");
  });

  it("quits with a visible error when the bootstrap continuation throws", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    // Bounded to search forward from the bootstrap chain itself: this exact
    // catch shape is not unique in the file — a detached cleanup promise
    // elsewhere attaches the same literal, and an unbounded search could
    // match that one instead of the bootstrap's own (#779 round 22 finding
    // 9 introduced the second occurrence).
    const catchAt = mainSource.indexOf(
      "}).catch((error: unknown) => {",
      whenReadyAt,
    );
    // A -1 start here would let indexOf search from position 0 instead,
    // so a mutation that removed or renamed the bootstrap chain itself
    // could still find some unrelated catch elsewhere and pass (#779
    // round 24 finding 1).
    expect(whenReadyAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(whenReadyAt);
    // A throw after the daemon started leaves the gate shut forever, so the
    // continuation must not fail silently.
    const handler = mainSource.slice(catchAt, catchAt + 800);
    expect(handler).toContain("dialog.showErrorBox(");
    expect(handler).toContain("app.quit();");
  });
});
