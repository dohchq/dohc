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

  it.each(WINDOW_CREATING_HANDLERS)(
    "makes the %s handler return before it can create a window",
    (event) => {
      const handler = handlerSource(event);
      const gateAt = handler.indexOf("if (!bootstrapComplete)");
      const createAt = handler.indexOf("showOrCreateMainWindow");
      if (createAt < 0) return;
      expect(gateAt).toBeGreaterThanOrEqual(0);
      expect(gateAt).toBeLessThan(createAt);
    },
  );

  it("keeps a second instance's workspace paths for the deferred flush", () => {
    const handler = handlerSource("second-instance");
    const gateAt = handler.indexOf("if (!bootstrapComplete)");
    const queueAt = handler.indexOf(
      "pendingOpenPaths.push(...collectOpenWorkspaceArgs(argv))",
    );
    expect(queueAt).toBeGreaterThan(gateAt);
    expect(queueAt).toBeLessThan(handler.indexOf("showOrCreateMainWindow"));
  });

  it("opens the gate only after the daemon started and a window exists", () => {
    const whenReadyAt = mainSource.indexOf("app.whenReady().then(");
    const daemonGateAt = mainSource.indexOf(
      "if (!(await startRustEngineDaemon())) return;",
      whenReadyAt,
    );
    const createWindowAt = mainSource.indexOf("createMainWindow({", daemonGateAt);
    const openGateAt = mainSource.indexOf("bootstrapComplete = true", whenReadyAt);

    expect(whenReadyAt).toBeGreaterThanOrEqual(0);
    expect(daemonGateAt).toBeGreaterThan(whenReadyAt);
    expect(createWindowAt).toBeGreaterThan(daemonGateAt);
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
