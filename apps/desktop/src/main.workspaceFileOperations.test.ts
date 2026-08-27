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

    const authorityStopAt = willQuitBody.indexOf(
      "const workspaceAuthorityStop",
    );
    const authorityStopEnd = willQuitBody.indexOf(
      "const workspaceShutdown",
      authorityStopAt,
    );
    expect(authorityStopAt).toBeGreaterThan(engineYDocStopAt);
    expect(authorityStopEnd).toBeGreaterThan(authorityStopAt);
    const authorityStop = willQuitBody.slice(
      authorityStopAt,
      authorityStopEnd,
    );
    const closeAuthorityAt = authorityStop.indexOf(
      "workspaceAuthorities.close()",
    );
    expect(closeAuthorityAt).toBeGreaterThan(-1);
    expect(authorityStop).toContain("Promise.allSettled(");
    for (const producerStop of [
      "engineYDocStop",
      "agentSessionStop",
      "chatDispatchStop",
      "cliServerStop",
      "searchStop",
      "agentIntegrationStop",
      "pluginStop",
    ]) {
      const producerStopAt = authorityStop.indexOf(producerStop);
      expect(producerStopAt).toBeGreaterThan(-1);
      expect(producerStopAt).toBeLessThan(closeAuthorityAt);
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
    expect(handler).toContain("exactRendererWorkspaceReferences.capture(");
    expect(
      handler.lastIndexOf("exactRendererWorkspaceReferences.withReference("),
    ).toBeGreaterThan(dialogAt);
    expect(handler.indexOf("withRendererWorkspaceOperation(")).toBeGreaterThan(-1);
  });

  it("holds modal picks and menu results to one exact renderer workspace", () => {
    for (const channel of [
      "pickImageFiles",
      "showExplorerMenu",
      "showWorkbenchMenu",
    ]) {
      const handler = handlerSource(channel);
      const captureAt = handler.indexOf("exactRendererWorkspaceReferences.capture(");
      const modalAt =
        channel === "pickImageFiles"
          ? handler.indexOf("await dialog.showOpenDialog(")
          : channel === "showExplorerMenu"
            ? handler.indexOf("await new Promise<ExplorerMenuCommand | null>")
            : handler.indexOf("await new Promise<WorkbenchMenuCommand | null>");
      const reacquireAt = handler.lastIndexOf(
        "exactRendererWorkspaceReferences.withReference(",
      );
      expect(captureAt, channel).toBeGreaterThan(-1);
      expect(modalAt, channel).toBeGreaterThan(captureAt);
      expect(reacquireAt, channel).toBeGreaterThan(modalAt);
    }
  });

  it("reacquires the exact renderer workspace after export dialogs", () => {
    for (const channel of ["exportWorkspaceZip", "exportDocumentFile"]) {
      const handler = handlerSource(channel);
      const captureAt = handler.indexOf(
        "exactRendererWorkspaceReferences.capture(",
      );
      const dialogAt = handler.indexOf("await dialog.showSaveDialog(");
      const cancelAt = handler.indexOf("if (target === null)");
      const reacquireAt = handler.lastIndexOf(
        "exactRendererWorkspaceReferences.withReference(",
      );
      const assertionAt = handler.indexOf(
        "operation.assertCurrent();",
        reacquireAt,
      );
      const writeAt = handler.indexOf("await writeFile(");
      const resultAt = handler.lastIndexOf(
        channel === "exportWorkspaceZip"
          ? "ExportWorkspaceZipResult.parse("
          : "ExportDocumentFileResult.parse(",
      );

      expect(captureAt, channel).toBeGreaterThan(-1);
      expect(dialogAt, channel).toBeGreaterThan(captureAt);
      expect(reacquireAt, channel).toBeGreaterThan(dialogAt);
      expect(cancelAt, channel).toBeGreaterThan(reacquireAt);
      expect(assertionAt, channel).toBeGreaterThan(cancelAt);
      expect(writeAt, channel).toBeGreaterThan(reacquireAt);
      expect(writeAt, channel).toBeGreaterThan(assertionAt);
      expect(writeAt, channel).toBeGreaterThan(cancelAt);
      expect(resultAt, channel).toBeGreaterThan(writeAt);

      if (channel === "exportDocumentFile") {
        const renderAt = handler.indexOf("await renderHtmlToPdf(");
        const postRenderAssertionAt = handler.indexOf(
          "operation.assertCurrent();",
          renderAt,
        );
        expect(renderAt).toBeGreaterThan(assertionAt);
        expect(postRenderAssertionAt).toBeGreaterThan(renderAt);
        expect(writeAt).toBeGreaterThan(postRenderAssertionAt);
      }
    }
  });

  it("holds graph, heading, backlink, and settings I/O under renderer authority", () => {
    const helpers = new Map([
      ["readWorkspaceGraph", "operation.state.workspaceGraph.readGraph("],
      ["getBacklinks", "operation.state.workspaceGraph.readBacklinks("],
      ["listWorkspaceHeadings", "readOwnedWorkspaceTextFor("],
      ["getWorkspaceSettings", "readWorkspaceSettingsFile("],
      ["setWorkspaceSettings", "saveWorkspaceSettingsFile("],
      ["resetWorkspaceSettings", "resetWorkspaceSettingsFile("],
    ]);
    for (const [channel, helper] of helpers) {
      const handler = handlerSource(channel);
      const operationAt = handler.indexOf("withRendererWorkspaceOperation(");
      expect(operationAt, channel).toBeGreaterThan(-1);
      expect(handler.indexOf(helper), channel).toBeGreaterThan(operationAt);
      expect(handler, channel).toContain("operation.workspace");
      expect(handler, channel).not.toContain("requireWorkspace(input.workspaceId)");
    }
  });
});
