import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("workspace file operation wiring", () => {
  it("starts bounded engine shutdown before arming quit teardown (#564)", () => {
    const closeAllStart = mainSource.indexOf(
      "async function closeAllEngineYDocSessions",
    );
    expect(closeAllStart).toBeGreaterThan(-1);
    const closeAllBody = mainSource.slice(
      closeAllStart,
      mainSource.indexOf("\n}", closeAllStart),
    );
    expect(closeAllBody).toContain("await engineYDocSessionIpc.shutdown()");

    const willQuitStart = mainSource.indexOf('app.on("will-quit"');
    expect(willQuitStart).toBeGreaterThan(-1);
    const willQuitBody = mainSource.slice(
      willQuitStart,
      mainSource.indexOf("app.exit(0)", willQuitStart),
    );
    const beginShutdownAt = willQuitBody.indexOf(
      "rustEngineWorkspaceSessions?.beginShutdown()",
    );
    const engineYDocStopAt = willQuitBody.indexOf(
      "closeAllEngineYDocSessions()",
    );
    const firstStopAllAt = willQuitBody.indexOf(".stopAll()");

    expect(beginShutdownAt).toBeGreaterThan(-1);
    expect(beginShutdownAt).toBeLessThan(engineYDocStopAt);
    expect(beginShutdownAt).toBeLessThan(firstStopAllAt);
  });

  it("admits imports through stale-sensitive scheduling without holding the native dialog", () => {
    const handler = handlerSource("importWorkspaceFiles");
    const scheduleAt = handler.indexOf("withStaleSensitiveWorkspaceOperation(");
    expect(scheduleAt).toBeGreaterThan(-1);
    expect(
      handler.indexOf("withStaleSensitiveWorkspaceOperation(", scheduleAt + 1),
    ).toBe(-1);
    const importAt = handler.indexOf("await shareViewFiles.change(");
    expect(importAt).toBeGreaterThan(scheduleAt);
    const scheduleEndAt = handler.indexOf("const droppedPaths = input.droppedPaths;");
    const scheduled = handler.slice(scheduleAt, scheduleEndAt);
    expect(scheduled).toContain("copyIntoWorkspace(");
    expect(scheduled).toContain("importDroppedPaths(");
    expect(scheduled).toContain("shareViewFiles.change(");
    expect(scheduled).not.toContain("showOpenDialog");
    const dialogAt = handler.indexOf("await dialog.showOpenDialog(");
    expect(dialogAt).toBeGreaterThan(importAt);
    expect(handler.lastIndexOf("await importInto(")).toBeGreaterThan(dialogAt);
  });
});
