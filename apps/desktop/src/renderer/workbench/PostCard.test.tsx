// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelThreadRecord } from "../../ipc/bridgeContract";
import { PostCard, type PostData } from "./PostCard";

afterEach(cleanup);

const thread: ChannelThreadRecord = {
  id: "thread-1", title: "Finished Book hotel", createdAtMs: 1, updatedAtMs: 2, channelId: "channel-1",
  messageCount: 1, lastReadSequence: 0, unreadCount: 1,
};

function card(data: PostData, onOpenPath?: (path: string) => void, onOpen = vi.fn()) {
  render(<PostCard
    thread={thread}
    data={data}
    reactionControls={{ reactions: [], viewerAuthorId: "ice", onToggle: vi.fn() }}
    onOpen={onOpen}
    {...(onOpenPath ? { onOpenPath } : {})}
  />);
  return onOpen;
}

const opening = {
  id: "message-1", authorKind: "automation" as const, authorDisplayName: "Stamp the finish date",
  authorOwnerDisplayName: "Ice", createdAtMs: 1, bodySnippet: "Finished Book hotel",
};

describe("PostCard for an automation's post", () => {
  it("draws the automation's mark and opens the automation that ran here without opening the post", () => {
    const onOpenPath = vi.fn();
    const onOpen = card({
      openingMessage: { ...opening, automation: { automationId: "collection:Trip/Tasks#stamp", collectionPath: "Trip/Tasks" } },
      reactions: [], viewerAuthorId: "ice",
    }, onOpenPath);
    expect(screen.getByTitle("Stamp the finish date").querySelector("svg.lucide-zap")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open automation" }));
    expect(onOpenPath).toHaveBeenCalledWith("Trip/Tasks/automations.yaml");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("names an automation from another computer without offering to open it", () => {
    card({ openingMessage: { ...opening, authorUserId: "ana", authorOwnerDisplayName: "Ana" }, reactions: [], viewerAuthorId: "ice" }, vi.fn());
    expect(screen.queryByRole("button", { name: "Open automation" })).toBeNull();
    fireEvent.focus(screen.getByTestId("chats-post-automation-badge"));
    expect(screen.getByRole("tooltip").textContent).toContain("Ran on Ana's computer");
  });
});
