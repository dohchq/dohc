// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadRecord } from "../../ipc/bridgeContract";
import { LinkedChatsPanel } from "./LinkedChats";

// CodeRabbit major (WS-D gate): a chat opened from a search result is
// consumed ONCE. The Shell clears its searchChatThread state through
// onInitialThreadConsumed, so toggling History <-> Chats (which fully
// unmounts/remounts this panel and resets its consumed ref) must NOT trap
// the user back inside the stale thread.

const searchThread: ChatThreadRecord = {
  id: "thread-1",
  title: "Plan discussion",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
};

const bridgeMock = {
  listFileChats: vi.fn(),
  createFileChat: vi.fn(),
  listChatMessages: vi.fn(),
  sendChatMessage: vi.fn(),
  listChatReactions: vi.fn(),
  setChatReaction: vi.fn(),
};

// jsdom doesn't implement scrollIntoView; the thread view nudges the latest
// message into view after load.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  for (const mock of Object.values(bridgeMock)) mock.mockReset();
  bridgeMock.listFileChats.mockResolvedValue({
    fileObjectId: "object-1",
    threads: [searchThread],
  });
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [] });
  bridgeMock.listChatReactions.mockResolvedValue({
    reactions: [],
    viewerAuthorId: "you@example.com",
  });
  bridgeMock.setChatReaction.mockResolvedValue({
    reaction: {
      reactionId: "r1",
      messageId: "message-1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "you@example.com",
      authorKind: "human",
      authorDisplayName: "you@example.com",
      state: "added",
    },
    viewerAuthorId: "you@example.com",
  });
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Mirrors the Shell's Chats panel: searchChatThread state feeding
// initialThread, cleared by onInitialThreadConsumed, with the panel swapped
// out for the other panel tab's surface (full unmount) and back.
function RailHarness() {
  const [searchChatThread, setSearchChatThread] = useState<ChatThreadRecord | null>(
    searchThread,
  );
  const [view, setView] = useState<"chats" | "history">("chats");
  return (
    <div>
      <button type="button" onClick={() => setView("history")}>
        show-history
      </button>
      <button type="button" onClick={() => setView("chats")}>
        show-chats
      </button>
      <output data-testid="pending-initial-thread">
        {searchChatThread ? "set" : "cleared"}
      </output>
      {view === "chats" ? (
        <LinkedChatsPanel
          workspaceId="workspace-1"
          filePath="docs/plan.md"
          initialThread={searchChatThread}
          onInitialThreadConsumed={() => setSearchChatThread(null)}
          onError={() => undefined}
        />
      ) : (
        <p>history timeline</p>
      )}
    </div>
  );
}

describe("LinkedChatsPanel initialThread consumption", () => {
  it("clears the parent state on consumption so a History<->Chats remount shows the list, not the stale thread", async () => {
    const user = userEvent.setup();
    render(<RailHarness />);

    // The search-result thread opens once.
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listChatMessages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    // Consumption reported upward: the parent state is cleared.
    expect(screen.getByTestId("pending-initial-thread").textContent).toBe("cleared");

    // History <-> Chats fully unmounts and remounts the panel.
    await user.click(screen.getByText("show-history"));
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    await user.click(screen.getByText("show-chats"));

    // The remounted panel lands on the thread LIST — the stale search thread
    // must not re-open (no second listChatMessages call).
    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it("still opens the initial thread when no consumed-callback is wired (prop is optional)", async () => {
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={searchThread}
        onError={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
  });
});
