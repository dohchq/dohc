import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

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
    // MUTATION: the complete-listing cache must be invalidated before any
    // window can answer the activity event from its retained snapshot.
    expect(notify.indexOf("workspaceFileListings.invalidate(")).toBeLessThan(
      notify.indexOf("broadcastWorkspaceActivity({"),
    );
    expect(notify.indexOf("invalidateWorkspaceGraphIndexes(")).toBeLessThan(
      notify.indexOf("broadcastWorkspaceActivity({"),
    );
    expect(notify).toContain("workspaceActivityPayload(scope)");
    // The broadcaster itself owns the channel; this pin covers the wiring
    // that only main can get wrong: which windows and whose active workspace.
    expect(notify).toContain("broadcastWorkspaceActivity({");
    expect(notify).toContain("windows: BrowserWindow.getAllWindows(),");
    expect(notify).toContain(
      "rendererWorkspaceSessions.current(sender)?.workspaceId",
    );
  });

  it("caches the complete owned listing only when the renderer opts in", () => {
    const handler = sourceBlock(
      "ipcMain.handle(CHANNELS.listWorkspaceFiles",
      "\n  ipcMain.handle(CHANNELS.createWorkspaceFile",
    );
    expect(handler).toContain("withRendererWorkspaceOperation(");
    expect(handler).toContain("workspaceFileListings.list({");
    expect(handler).toContain("attachmentId: workspace.attachmentId,");
    expect(handler).toContain("allowCached: input.allowCached === true,");
    expect(handler).toContain("await listOwnedWorkspaceFilesFor(workspace)");
    expect(handler).not.toContain("requireWorkspace(input.workspaceId)");
  });

  it("keeps the cold graph index on the workspace attachment and reuses owned listings", () => {
    expect(mainSource).toContain("workspaceGraph: new WorkspaceGraphIndex(),");
    const source = sourceBlock(
      "function ownedWorkspaceGraphSource(",
      "\n}\n\nasync function collectShareTargetZipEntries",
    );
    expect(source).toContain("workspaceFileListings.list({");
    expect(source).toContain("allowCached: true,");
    expect(source).toContain("workspaceHasReceivedShareState(workspace)");
    expect(source).toContain("readOwnedWorkspaceTextFor(workspace, path)");
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
    // rollback), a daemon relaunch that may have lost any workspace's capture
    // event, or an all-workspace engine reconcile/stop. A new bare
    // notifyRenderer() call must either name its workspace or justify itself
    // here.
    const bareCalls = mainSource.split("notifyRenderer()").length - 1;
    expect(bareCalls).toBe(8);
  });

  it("event-gates the bookmark projection worker and keeps it as a slow crash backstop", () => {
    const worker = sourceBlock("const bookmarkProjectionTimer = setInterval(() => {", "\n  bookmarkProjectionTimer.unref();");
    // Gated: an unflagged workspace costs nothing per tick.
    const gateAt = worker.indexOf(
      "if (!state.bookmarkProjectionPending || state.bookmarkProjectionRunning) {",
    );
    const clearAt = worker.indexOf(
      "state.bookmarkProjectionPending = false;",
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
    expect(worker).toContain("state.bookmarkProjectionPending = true;");
    // The backstop cadence: slow, never the 3s hot loop this replaced.
    expect(worker).toContain("}, 30_000);");
  });

  it("flags bookmark work from every reply path this process can observe", () => {
    // Agent dispatch replies.
    const dispatch = sourceBlock("onMessagePosted: (workspace, threadId) => {", "\n  },");
    expect(dispatch).toContain("queueChatBookmarkProjection(workspace.workspaceId);");
    // CLI/MCP chat writes.
    const cli = sourceBlock("onWrite: (workspace, target) => {", "\n    },");
    expect(cli).toContain("queueChatBookmarkProjection(workspace.workspaceId);");
    // Rows a previous session left pending: once per workspace open.
    const open = sourceBlock(
      "async function openWorkspaceActivityForOperation(",
      "\n}\n",
    );
    expect(open).toContain(
      "queueChatBookmarkProjection(canonicalWorkspace.workspaceId);",
    );
    // A failed post-pull projection retries through the worker.
    const pull = sourceBlock(
      "async function projectPendingChatBookmarksAfterPull(",
      "\n}\n",
    );
    expect(pull).toContain("queueChatBookmarkProjection(workspaceId);");
  });
});
