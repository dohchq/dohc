// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  markChatThreadRead: vi.fn(),
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
  bridgeMock.markChatThreadRead.mockResolvedValue(undefined);
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

  it("opens a compatibility-form file mention through its resolved attachment path", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        {
          id: "message-file",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "Read @[ docs/plan.md #scope].",
          createdAtMs: 1_700_000_000_000,
          attachments: [
            {
              attachmentId: "attachment-file",
              threadId: searchThread.id,
              messageId: "message-file",
              targetKind: "file",
              objectId: "file-plan",
              pathHint: "docs/plan.md",
              headingAnchor: "scope",
              createdAtMs: 1_700_000_000_000,
            },
          ],
        },
      ],
    });

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/current.md"
        initialThread={searchThread}
        onOpenPath={onOpenPath}
        onError={() => undefined}
      />,
    );

    await user.click(await screen.findByTestId("linked-chat-message-body-file-mention"));
    expect(onOpenPath).toHaveBeenCalledWith("docs/plan.md", "scope");
  });

  it("lands on a focused message and honors a repeated open of the same thread", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        {
          id: "message-1",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "First update",
          createdAtMs: 1_700_000_000_000,
        },
        {
          id: "message-2",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "Second update",
          createdAtMs: 1_700_000_001_000,
        },
      ],
    });
    const scrolledMessageIds: Array<string | null> = [];
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (
      this: Element,
    ) {
      scrolledMessageIds.push(this.getAttribute("data-message-id"));
    });

    const { rerender } = render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={{ ...searchThread }}
        initialFocusMessageId="message-1"
        onError={() => undefined}
      />,
    );

    expect(await screen.findByText("First update")).toBeTruthy();
    await waitFor(() => expect(scrolledMessageIds).toContain("message-1"));

    scrolledMessageIds.length = 0;
    rerender(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={{ ...searchThread }}
        initialFocusMessageId="message-2"
        onError={() => undefined}
      />,
    );

    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(scrolledMessageIds).toContain("message-2"));
  });

  it("drops a deferred scroll after a newer thread open supersedes its request", async () => {
    const secondThread = {
      ...searchThread,
      id: "thread-2",
      title: "Second discussion",
    };
    bridgeMock.listChatMessages.mockImplementation(
      async ({ threadId }: { threadId: string }) => ({
        messages: threadId === searchThread.id
          ? [{
              id: "shared-message",
              threadId,
              authorKind: "human" as const,
              authorDisplayName: "Ice",
              body: "Old thread message",
              createdAtMs: 1,
            }]
          : [
              {
                id: "shared-message",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Ice",
                body: "Same id in the new DOM",
                createdAtMs: 2,
              },
              {
                id: "new-focus",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Ice",
                body: "New focus",
                createdAtMs: 3,
              },
            ],
      }),
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const scrolledMessageIds: Array<string | null> = [];
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (
      this: Element,
    ) {
      scrolledMessageIds.push(this.getAttribute("data-message-id"));
    });

    const view = render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={{ ...searchThread }}
        initialFocusMessageId="shared-message"
        onError={() => undefined}
      />,
    );
    await screen.findByText("Old thread message");
    await waitFor(() => expect(frames).toHaveLength(1));

    view.rerender(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={{ ...secondThread }}
        initialFocusMessageId="new-focus"
        onError={() => undefined}
      />,
    );
    await screen.findByText("New focus");
    await waitFor(() => expect(frames).toHaveLength(2));

    act(() => frames[0]?.(0));
    expect(scrolledMessageIds).toEqual([]);
    act(() => frames[1]?.(1));
    expect(scrolledMessageIds).toEqual(["new-focus"]);
  });
});

// #337 item 3, second path: the Chats navigator lists FILE-linked threads
// beside its channels, but opening one routes here — not through the Chats
// view. Without a read here the durable count never moved, so the navigator's
// badge was not merely stale, it was correct about an unread thread the user
// had just read.
describe("LinkedChatsPanel read cursor", () => {
  function panel(extra: Partial<Parameters<typeof LinkedChatsPanel>[0]> = {}) {
    return (
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={searchThread}
        onError={() => undefined}
        {...extra}
      />
    );
  }

  it("marks the opened thread read up to the last message it showed", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        {
          id: "message-1",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "First.",
          createdAtMs: 1_700_000_000_000,
        },
        {
          id: "message-2",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Ice",
          body: "Second.",
          createdAtMs: 1_700_000_000_001,
        },
      ],
    });
    const onThreadRead = vi.fn();
    render(panel({ onThreadRead }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    await waitFor(() =>
      expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        upToSequence: 2,
      }),
    );
    await waitFor(() => expect(onThreadRead).toHaveBeenCalledTimes(1));
  });

  it("reports the read only after the cursor write lands", async () => {
    let landed!: () => void;
    bridgeMock.markChatThreadRead.mockReturnValue(
      new Promise<void>((resolve) => {
        landed = resolve;
      }),
    );
    const onThreadRead = vi.fn();
    render(panel({ onThreadRead }));

    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalled());
    // A refetch now would read the same count back.
    expect(onThreadRead).not.toHaveBeenCalled();

    await act(async () => {
      landed();
      await Promise.resolve();
    });
    await waitFor(() => expect(onThreadRead).toHaveBeenCalledTimes(1));
  });

  it("a failed cursor write reports nothing and does not surface an error", async () => {
    bridgeMock.markChatThreadRead.mockRejectedValue(new Error("offline"));
    const onThreadRead = vi.fn();
    const onError = vi.fn();
    render(panel({ onThreadRead, onError }));

    await waitFor(() => expect(bridgeMock.markChatThreadRead).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(onThreadRead).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

// #646 PR2: chat follows a file share. A `view` recipient reads the chat and
// adds nothing to it; `comment` and `edit` write. Main refuses a `view` write
// with these exact words (SharedFileReadOnlyError), so the panel states them
// instead of offering a control that can only fail.
describe("LinkedChatsPanel share level", () => {
  function panel(extra: Partial<Parameters<typeof LinkedChatsPanel>[0]> = {}) {
    return (
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
        {...extra}
      />
    );
  }

  it("replaces the composer with the refusal words when the share refuses writes", async () => {
    render(panel({ shareReadOnly: true, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "This shared file is read-only for you.",
    );
  });

  it("offers no new chat when the share refuses writes, and never asks main to create one", async () => {
    render(panel({ shareReadOnly: true }));

    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "This shared file is read-only for you.",
    );
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  // The other half of both gates. Without this, hiding the composer from
  // every share keeps the two pins above green.
  it("keeps the composer and new chat when the share allows writes", async () => {
    const view = render(panel({ shareReadOnly: false }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-new")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();

    view.rerender(panel({ shareReadOnly: false, initialThread: searchThread }));
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });

  // A shared view ALWAYS states the answer, so an absent prop can only mean
  // a workspace this machine owns. The shell is what guarantees that, and it
  // is why this prop carries the decision rather than the level: a damaged
  // grant has no level to read, and reading one would answer "writable".
  it("refuses writes when the share says so, whatever left it unreadable", async () => {
    render(panel({ shareReadOnly: true, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(
      screen.queryByTestId("linked-chat-composer"),
      "MUTATION: a share whose grant cannot be read must not offer a composer",
    ).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "This shared file is read-only for you.",
    );
  });

  it("keeps the composer on a workspace this machine owns", async () => {
    render(panel({ initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });
});
