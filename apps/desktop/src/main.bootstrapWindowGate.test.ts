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

  it("opens the gate only after the daemon, IPC, and a window", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const daemonGateAt = mainSource.indexOf(
      "if (!(await startRustEngineDaemon())) return;",
      whenReadyAt,
    );
    const ipcAt = mainSource.indexOf("registerIpcHandlers();", daemonGateAt);
    const createWindowAt = mainSource.indexOf("createMainWindow({", daemonGateAt);
    const openGateAt = mainSource.indexOf("bootstrapComplete = true", whenReadyAt);

    expect(whenReadyAt).toBeGreaterThanOrEqual(0);
    expect(daemonGateAt).toBeGreaterThan(whenReadyAt);
    expect(ipcAt).toBeGreaterThan(daemonGateAt);
    expect(createWindowAt).toBeGreaterThan(daemonGateAt);
    expect(openGateAt).toBeGreaterThan(ipcAt);
    expect(openGateAt).toBeGreaterThan(createWindowAt);
  });

  // Indentation is the cheap proof of nesting: four spaces is the continuation
  // body. A gate opened inside any `if` would sit deeper, and a launch that
  // missed that condition would never open the gate at all.
  it("opens the gate unconditionally, not inside a branch", () => {
    expect(mainSource).toContain("\n    bootstrapComplete = true;\n");
  });

  it("drains queued paths before the window's activation listener", () => {
    const createWindowAt = mainSource.indexOf("createMainWindow({");
    const drainAt = mainSource.indexOf(
      "const drainedWorkspace = await flushPendingOpenPaths();",
      createWindowAt,
    );
    const mergeAt = mainSource.indexOf(
      "drainedWorkspace ?? initialActivatedWorkspace",
      drainAt,
    );
    const listenerAt = mainSource.indexOf('once("did-finish-load"', mergeAt);
    const sendAt = mainSource.indexOf(
      "sendWorkspaceActivated(window, activatedWorkspace)",
      listenerAt,
    );
    const residualDrainAt = mainSource.indexOf(
      "void flushPendingOpenPaths(window);",
      sendAt,
    );
    const openGateAt = mainSource.indexOf("bootstrapComplete = true", drainAt);

    // The renderer subscribes when it loads, so the drained path has to reach
    // the did-finish-load listener. Sending it earlier drops it, and the launch
    // argument then overrides the path the user actually opened.
    expect(drainAt).toBeGreaterThan(createWindowAt);
    expect(mergeAt).toBeGreaterThan(drainAt);
    expect(listenerAt).toBeGreaterThan(mergeAt);
    expect(sendAt).toBeGreaterThan(listenerAt);
    // A path can arrive while the drain above awaits: it is queued behind an
    // open gate, so the listener has to flush the remainder or it sits there.
    expect(residualDrainAt).toBeGreaterThan(sendAt);
    expect(openGateAt).toBeGreaterThan(drainAt);
  });

  // The listener carries the residual drain, so a launch with no workspace to
  // activate must still register it.
  it("registers the activation listener unconditionally", () => {
    expect(mainSource).toContain('\n    window.webContents.once("did-finish-load"');
  });

  it("quits with a visible error when the bootstrap continuation throws", () => {
    const catchAt = mainSource.indexOf("}).catch((error: unknown) => {");
    expect(catchAt).toBeGreaterThan(mainSource.indexOf("app.whenReady().then("));
    // A throw after the daemon started leaves the gate shut forever, so the
    // continuation must not fail silently.
    const handler = mainSource.slice(catchAt, catchAt + 800);
    expect(handler).toContain("dialog.showErrorBox(");
    expect(handler).toContain("app.quit();");
  });
});
