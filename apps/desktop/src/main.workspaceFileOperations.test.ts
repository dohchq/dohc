import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

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

  it("keeps each move and delete capture lifecycle inside one exclusive workspace operation", () => {
    for (const channel of ["moveWorkspacePath", "deleteWorkspacePath"]) {
      const handler = handlerSource(channel);
      const exclusiveAt = handler.indexOf("withExclusiveWorkspaceOperation(");
      const callbackAt = handler.indexOf(
        "async (markWorkspaceChanged, lease)",
        exclusiveAt,
      );
      const captureAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("capture.beginFileRename(")
          : handler.indexOf("settleAndCloseLiveSessionsForPath(");
      const diskMutationAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("? await movePath(")
          : handler.indexOf("? await deletePath(");
      const sharedMutationAt = handler.indexOf("await shareViewFiles.change(");
      const successAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("finishRename?.(true)")
          : handler.indexOf("finishDebts?.(true)");
      const changedAt = handler.indexOf(
        "markWorkspaceChanged()",
        Math.max(diskMutationAt, sharedMutationAt),
      );
      const failureAt =
        channel === "moveWorkspacePath"
          ? handler.indexOf("finishRename?.(false)")
          : handler.indexOf("finishDebts?.(false)");
      expect(exclusiveAt).toBeGreaterThan(-1);
      expect(callbackAt).toBeGreaterThan(exclusiveAt);
      expect(captureAt).toBeGreaterThan(callbackAt);
      expect(diskMutationAt).toBeGreaterThan(captureAt);
      expect(sharedMutationAt).toBeGreaterThan(captureAt);
      expect(changedAt).toBeGreaterThan(diskMutationAt);
      expect(changedAt).toBeGreaterThan(sharedMutationAt);
      expect(changedAt).toBeLessThan(successAt);
      expect(failureAt).toBeGreaterThan(successAt);
    }
  });

  it("refuses a rename that would change a live document's kind", () => {
    const handler = handlerSource("moveWorkspacePath");
    expect(handler).toContain("liveDocumentKindForPath(input.fromPath)");
    expect(handler).toContain("liveDocumentKindForPath(input.toPath)");
    const guardAt = handler.indexOf("fromKind !== null && fromKind !== toKind");
    const renameAt = handler.indexOf("capture.beginFileRename(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(renameAt);
    expect(handler).toContain("cannot change a live document's kind");
  });

  it("admits file and folder creation through stale-sensitive workspace scheduling", () => {
    for (const [channel, mutations] of [
      ["createWorkspaceFile", ["? await createFile(", "await shareViewFiles.change("]],
      ["createWorkspaceFolder", ["const path = await createFolder("]],
    ] as const) {
      const handler = handlerSource(channel);
      const scheduledAt = handler.indexOf("withStaleSensitiveWorkspaceOperation(");
      expect(scheduledAt).toBeGreaterThan(-1);
      for (const mutation of mutations) {
        expect(handler.indexOf(mutation), `${channel}: ${mutation}`).toBeGreaterThan(
          scheduledAt,
        );
      }
    }
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
