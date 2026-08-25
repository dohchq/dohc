import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBlock(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe("workspace-activity main-process wiring", () => {
  it("sends workspace activity through the scoped broadcast, keyed by each window's active workspace", () => {
    const notify = sourceBlock("function notifyRenderer(", "\n}\n");
    // The broadcaster itself owns the channel; this pin covers the wiring
    // that only main can get wrong: which windows and whose active workspace.
    expect(notify).toContain("broadcastWorkspaceActivity({");
    expect(notify).toContain("windows: BrowserWindow.getAllWindows(),");
    expect(notify).toContain("activeWorkspaceIdBySender.get(webContentsId)");
  });

  it("forwards the daemon's capture payload scope into the renderer notification", () => {
    // The bridge parses workspaceId+paths out of capture.momentRecorded and
    // hands them to notifyRenderer as the scope — reverting to a scope-free
    // wrapper here would re-broadcast every capture to every window.
    expect(mainSource).toContain(
      "bridgeCaptureEventsToRenderer(rustEngineDaemon, notifyRenderer);",
    );
  });

  it("broadcasts scope-free only for genuinely cross-workspace events", () => {
    // Every scope-free send is one of: logout (all engines detached), a
    // registry change no window has active yet (join/open-share success and
    // rollback), or a daemon relaunch that may have lost any workspace's
    // capture event. A new bare notifyRenderer() call must either name its
    // workspace or justify itself here.
    const bareCalls = mainSource.split("notifyRenderer()").length - 1;
    expect(bareCalls).toBe(6);
  });

  it("event-gates the bookmark projection worker and keeps it as a slow crash backstop", () => {
    const worker = sourceBlock("const bookmarkProjectionRuns = new Set<string>();", "\n  bookmarkProjectionTimer.unref();");
    // Gated: an unflagged workspace costs nothing per tick.
    const gateAt = worker.indexOf(
      "if (!pendingChatBookmarkProjectionWorkspaceIds.has(workspaceId)) continue;",
    );
    const clearAt = worker.indexOf(
      "pendingChatBookmarkProjectionWorkspaceIds.delete(workspaceId);",
      gateAt,
    );
    const runAt = worker.indexOf(
      "void materializePendingChatBookmarks(workspace, capture)",
      clearAt,
    );
    expect(gateAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(gateAt);
    expect(runAt).toBeGreaterThan(clearAt);
    // A failed pass re-flags so the pending rows survive to the next tick.
    expect(worker).toContain("queueChatBookmarkProjection(workspaceId);");
    // The backstop cadence: slow, never the 3s hot loop this replaced.
    expect(worker).toContain("}, 30_000);");
  });

  it("flags bookmark work from every reply path this process can observe", () => {
    // Agent dispatch replies.
    const dispatch = sourceBlock("onMessagePosted: (workspaceId, threadId) => {", "\n  },");
    expect(dispatch).toContain("queueChatBookmarkProjection(workspaceId);");
    // CLI/MCP chat writes.
    const cli = sourceBlock("onWrite: (workspace, target) => {", "\n    },");
    expect(cli).toContain("queueChatBookmarkProjection(workspace.workspaceId);");
    // Rows a previous session left pending: once per workspace open.
    const open = sourceBlock("async function openWorkspaceActivityWith(", "\n}\n");
    expect(open).toContain("queueChatBookmarkProjection(workspace.workspaceId);");
    // A failed post-pull projection retries through the worker.
    const pull = sourceBlock(
      "async function projectPendingChatBookmarksAfterPull(",
      "\n}\n",
    );
    expect(pull).toContain("queueChatBookmarkProjection(workspaceId);");
  });
});
