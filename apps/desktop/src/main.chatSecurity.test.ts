import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `ipcMain.handle(CHANNELS.${channel}`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(CHANNELS.", start + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("main-process chat authorization", () => {
  it("guards every renderer chat mutation with the workspace read-only boundary", () => {
    const guardedMutations = [
      "saveChatBookmark",
      "archiveChatBookmark",
      "createFileChat",
      "sendChatMessage",
      "resolveChatDecision",
      "setChatFollow",
      "createChatChannel",
      "startChannelThread",
      "markChatThreadRead",
      "setChatReaction",
      "startDm",
      "resumeThreadDispatch",
    ];

    for (const channel of guardedMutations) {
      expect(handlerSource(channel), channel).toContain(
        "assertWritableWorkspace(workspace);",
      );
    }

    // These read-shaped calls can write viewer/sync state. Their shared-view
    // behavior is deliberately a no-op rather than a rejected background call.
    expect(handlerSource("markPersonalChatFeedSeen")).toContain(
      "markPersonalFeedSeenReadOnlySafe",
    );
    expect(handlerSource("syncDms")).toContain(
      "if (relay && !sharedViewOf(workspace.workspaceId))",
    );
  });

  it("queues both joined-channel and workspace-cloud sync after a reaction write", () => {
    const handler = handlerSource("setChatReaction");
    const write = handler.indexOf(".setReaction({");
    const joinedChannelSync = handler.indexOf("syncWorkspaceSharedChannels", write);
    const workspaceSync = handler.indexOf("activity.queueCloudSync", write);

    expect(write).toBeGreaterThan(-1);
    expect(joinedChannelSync).toBeGreaterThan(write);
    expect(workspaceSync).toBeGreaterThan(write);
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
