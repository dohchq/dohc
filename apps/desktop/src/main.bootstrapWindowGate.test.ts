import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts is the Electron entry point: it cannot be imported under vitest, so
// this suite guards the bootstrap gate the way main.chatSecurity.test.ts guards
// chat authorization — by reading the source it protects.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

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

  it.each(WINDOW_CREATING_HANDLERS)(
    "gates the %s handler on the bootstrap flag, never on app.isReady()",
    (event) => {
      const handler = handlerSource(event);
      expect(handler).toContain("if (!bootstrapComplete)");
      expect(handler).not.toContain("app.isReady()");
    },
  );

  // A gate that only precedes the window call is not a gate: control has to
  // leave the handler, so the guarded branch must return.
  it.each(WINDOW_CREATING_HANDLERS)(
    "makes the %s handler return out of the closed gate, not fall through",
    (event) => {
      const handler = handlerSource(event);
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
    expect(openGateAt).toBeGreaterThan(createWindowAt);
  });

  // D1#9: appReady must measure Electron readiness, not daemon boot — it used
  // to be marked after the daemon await. daemonReady lands at the gate.
  it("marks app-ready before the daemon starts and daemon-ready at its gate", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const appReadyMarkAt = mainSource.indexOf(
      "launchMarks.appReady();",
      whenReadyAt,
    );
    const daemonStartAt = mainSource.indexOf(
      "engineDaemonStartup = startRustEngineDaemon();",
      whenReadyAt,
    );
    const daemonGateAt = mainSource.indexOf(
      "if (!(await engineDaemonStartup)) return;",
      whenReadyAt,
    );
    const daemonReadyMarkAt = mainSource.indexOf(
      "launchMarks.daemonReady();",
      whenReadyAt,
    );
    expect(appReadyMarkAt).toBeGreaterThan(whenReadyAt);
    expect(appReadyMarkAt).toBeLessThan(daemonStartAt);
    expect(daemonReadyMarkAt).toBeGreaterThan(daemonGateAt);
  });

  // The window loads while the daemon handshakes, so a fast renderer can call
  // engine-backed IPC before sessions exist. The boot-reachable entry awaits
  // the handshake instead of throwing the broken-invariant sessions error.
  it("gates workspace-activity opens on the daemon startup promise", () => {
    const openActivityAt = mainSource.indexOf(
      "async function openWorkspaceActivityWith(",
    );
    expect(openActivityAt).toBeGreaterThanOrEqual(0);
    const retainAt = mainSource.indexOf(
      "retainedWorkspaceActivities.add",
      openActivityAt,
    );
    expect(retainAt).toBeGreaterThan(openActivityAt);
    expect(mainSource.slice(openActivityAt, retainAt)).toContain(
      "await engineDaemonStartup;",
    );
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
      "const drainedWorkspace = await flushPendingOpenPaths();",
      whenReadyAt,
    );
    const mergeAt = mainSource.indexOf(
      "drainedWorkspace ?? initialActivatedWorkspace",
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
    const handler = mainSource.slice(catchAt, catchAt + 1200);
    expect(handler).toContain('"Rust engine failed to start"');
    expect(handler).toContain("await rustEngineDaemon?.stop();");
    // The window can already be up — it loads during the handshake. The
    // failure path destroys it so the quit is immediate instead of the quit
    // guard interrogating a renderer about a boot that already failed.
    const destroyAt = handler.indexOf(
      "for (const window of workspaceWindows.allLive()) window.destroy();",
    );
    const quitAt = handler.indexOf("app.quit();");
    expect(destroyAt).toBeGreaterThanOrEqual(0);
    expect(quitAt).toBeGreaterThan(destroyAt);
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
