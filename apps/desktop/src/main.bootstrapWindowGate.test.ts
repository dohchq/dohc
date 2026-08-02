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
  it("tracks bootstrap completion as a single flag", () => {
    expect(mainSource).toContain("let bootstrapComplete = false;");
    expect(mainSource.split("bootstrapComplete = true").length - 1).toBe(1);
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
      if (createAt < 0) return;
      expect(gateAt).toBeGreaterThanOrEqual(0);

      const returnAt = handler.indexOf("return;", gateAt);
      expect(returnAt).toBeGreaterThan(gateAt);
      expect(returnAt).toBeLessThan(createAt);
      // Whatever the guard does before returning, it cannot open a window.
      const guardBody = handler.slice(gateAt, returnAt);
      expect(guardBody).not.toContain("showOrCreateMainWindow");
      expect(guardBody).not.toContain("createMainWindow");
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

  it("drains queued paths into the window the bootstrap created", () => {
    const openGateAt = mainSource.indexOf("bootstrapComplete = true");
    const drainAt = mainSource.indexOf(
      "void flushPendingOpenPaths(window);",
      openGateAt,
    );
    expect(drainAt).toBeGreaterThan(openGateAt);
  });
});
