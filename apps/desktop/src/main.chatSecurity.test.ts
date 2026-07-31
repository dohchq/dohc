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

describe("main-process chat authorization", () => {
  it("routes every main chat acquisition through the Rust-only factory", () => {
    const factoryStart = mainSource.indexOf("function linkedChatStoreFor(");
    const factoryEnd = mainSource.indexOf(
      "\nconst agentDispatchStoreHandles",
      factoryStart,
    );
    const factory = mainSource.slice(factoryStart, factoryEnd);

    expect(factory).toContain("createDesktopLinkedChatStore(workspace, {");
    expect(factory).toContain("sessions: rustEngineWorkspaceSessions");
    expect(factory).not.toContain("createLinkedChatStore(");
  });

  it("awaits linked-chat initialization before opening the dispatch adapter", () => {
    const handler = handlerSource("chatRunRecordsForThread");
    expect(handler).toContain("await linkedChatStore.ensureOpen()");
    expect(handler.indexOf("await linkedChatStore.ensureOpen()")).toBeLessThan(
      handler.indexOf("agentDispatchStoreHandleFor(workspace)"),
    );
  });

  it("guards every renderer chat mutation with the workspace read-only boundary", () => {
    const guardedMutations = [
      "saveChatBookmark",
      "archiveChatBookmark",
      "createFileChat",
      "sendChatMessage",
      "resolveChatDecision",
      "setChatFollow",
      "startChannelThread",
      "shareChatChannel",
      "startDm",
      "resumeThreadDispatch",
    ];

    for (const channel of guardedMutations) {
      expect(handlerSource(channel), channel).toContain(
        "assertWritableWorkspace(workspace);",
      );
    }

    expect(handlerSource("createChatChannel")).toContain("createChatChannelIpcHandler({");
    expect(handlerSource("createChatChannel")).toContain("assertWritableWorkspace,");
    expect(handlerSource("setChatReaction")).toContain("createSetChatReactionIpcHandler({");
    expect(handlerSource("setChatReaction")).toContain("assertWritableWorkspace,");
    expect(handlerSource("markChatThreadRead")).toContain(
      "createSharedChannelWritableChatIpcHandler({",
    );
    expect(handlerSource("markChatThreadRead")).toContain("assertWritableWorkspace,");
    expect(handlerSource("markChatThreadRead")).toContain(
      "await assertSharedChannelWritable({",
    );

    // These read-shaped calls can write viewer/sync state. Their shared-view
    // behavior is deliberately a no-op rather than a rejected background call.
    expect(handlerSource("markPersonalChatFeedSeen")).toContain(
      "markPersonalFeedSeenReadOnlySafe",
    );
    expect(handlerSource("syncDms")).toContain("createReadAwareChatIpcHandler({");
    expect(handlerSource("syncDms")).toContain("if (relay && !readOnly)");
  });

  it("registers the production reaction handler with both sync effects", () => {
    const handler = handlerSource("setChatReaction");
    expect(handler).toContain("syncJoinedChannels:");
    expect(handler).toContain("syncWorkspaceSharedChannels(workspaceId)");
    expect(handler).toContain("queueCloudSync:");
    expect(handler).toContain("activity.queueCloudSync(workspaceId)");
    expect(handler).toContain("const replicationAuthorId = relayAuthorUserId()");
    expect(handler).toContain("{ replicationAuthorId }");
  });

  it("derives generic channel-share eligibility in the main process", () => {
    const handler = handlerSource("shareChatChannel");
    expect(handler).toContain("requireShareableChatChannel({");
    expect(handler.indexOf("requireShareableChatChannel({")).toBeLessThan(
      handler.indexOf("relayShareJson<{ shareId: string }>("),
    );
  });

  it("projects pending chat bookmarks immediately after workspace and shared-channel pulls", () => {
    expect(mainSource).toContain(
      "afterSuccessfulPull: () =>\n      projectPendingChatBookmarksAfterPull(workspace.workspaceId)",
    );
    expect(mainSource).toContain(
      "if (result.changed) await projectPendingChatBookmarksAfterPull(workspaceId);",
    );
    expect(mainSource).toContain(
      "readOnly: Boolean(sharedViewOf(workspaceId))",
    );
  });
});
