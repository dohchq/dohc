// @vitest-environment jsdom
import "../../testing/legendListMock";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThreadLinesEvent, ChatThreadRecord } from "../../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../../settings/userSettings";
import { AgentThreadLinesProvider } from "./AgentThreadLines";
import { deferred, type Deferred } from "../../testing/deferred";
import { LinkedChatsPanel as ProductionLinkedChatsPanel } from "./LinkedChats";
import { ReactionStoreProvider } from "./reactionStore";
import type { AboutFile } from "./About";
import type { AccessContext } from "./accessReason";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";

function stubAnimationFrames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    pending.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    pending,
    cancel,
    run() {
      for (const id of [...pending.keys()]) {
        const callback = pending.get(id);
        pending.delete(id);
        callback?.(0);
      }
    },
  };
}

vi.mock("./About", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<typeof import("./About")>()),
    AboutHistory: ({ file }: { file: AboutFile }) =>
      createElement(
        "output",
        { "data-testid": "about-history-file" },
        file.status === "ready" ? `ready:${file.objectId}` : file.status,
      ),
    AboutLinks: () => null,
  };
});

const notices = { report: vi.fn(), clear: vi.fn() };
const accessContext: AccessContext = {
  facts: {
    cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true },
    shareView: false,
  },
  openSyncSettings: vi.fn(),
  connect: vi.fn(),
};

type PanelProps = ComponentProps<typeof ProductionLinkedChatsPanel>;
const links: PanelProps["links"] = { revision: 0, onOpenLink: vi.fn() };

function LinkedChatsPanel(
  props: Omit<PanelProps, "notices" | "accessContext" | "links"> &
    Partial<Pick<PanelProps, "notices">>,
) {
  return (
    <WorkspaceSessionProvider workspaceId={props.workspaceId}>
      <ReactionStoreProvider workspaceId={props.workspaceId}>
        <ProductionLinkedChatsPanel
          notices={notices}
          accessContext={accessContext}
          links={links}
          {...props}
        />
      </ReactionStoreProvider>
    </WorkspaceSessionProvider>
  );
}

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
  getObjectAccess: vi.fn(),
  requestAccessRefresh: vi.fn(),
  readAgentThreadLines: vi.fn(),
  onAgentThreadLines: vi.fn(),
  onWorkspaceActivity: vi.fn(),
};
const activity = new Set<(event: { workspaceId?: string }) => void>();

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
  activity.clear();
  bridgeMock.onWorkspaceActivity.mockImplementation(
    (callback: (event: { workspaceId?: string }) => void) => {
      activity.add(callback);
      return () => activity.delete(callback);
    },
  );
  bridgeMock.markChatThreadRead.mockResolvedValue(undefined);
  bridgeMock.getObjectAccess.mockImplementation(async (input: { ref: unknown }) => ({
    ref: input.ref,
    rows: [],
    visibility: "visible",
    unknownReason: null,
    coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: 0,
    freshness: "fresh",
    nextCursor: null,
  }));
  bridgeMock.requestAccessRefresh.mockResolvedValue(undefined);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LinkedChatsPanel startup", () => {
  it("shows loading lines and asks again while the engine reads the workspace in", async () => {
    vi.useFakeTimers();
    bridgeMock.listFileChats
      .mockResolvedValueOnce({
        status: "refused",
        code: "workspace-updating",
      })
      .mockResolvedValue({ fileObjectId: "object-1", threads: [] });

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        history={{
          revision: 0,
          paused: false,
          onOpenMoment: () => undefined,
          onOpenHistory: () => undefined,
        }}
        onError={() => undefined}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByText("Loading comments…")).toBeTruthy();
    expect(screen.queryByTestId("about-chats-count")).toBeNull();
    expect(screen.queryByText("Try again")).toBeNull();
    expect(screen.getByTestId("about-history-file").textContent).toBe("updating");
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("about-chats-count")).toBeTruthy();
  });

  it("keeps manual recovery for an ordinary load failure", async () => {
    bridgeMock.listFileChats
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ fileObjectId: "object-1", threads: [] });

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
      />,
    );

    const retry = await screen.findByText("Try again");
    await act(async () => retry.click());
    expect(await screen.findByTestId("about-chats-count")).toBeTruthy();
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(2);
  });

  it("neither reports nor clears when an old file's read fails after the switch", async () => {
    const forOld = deferred<never>();
    bridgeMock.listFileChats.mockImplementation(({ path }: { path: string }) =>
      path === "docs/old.md"
        ? forOld.promise
        : Promise.resolve({ fileObjectId: "object-2", threads: [] }),
    );
    const view = render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/old.md"
        onError={() => undefined}
      />,
    );
    view.rerender(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/new.md"
        onError={() => undefined}
      />,
    );
    await screen.findByTestId("about-chats-count");
    const clears = notices.clear.mock.calls.length;
    await act(async () => {
      forOld.reject(new Error("offline"));
      await forOld.promise.catch(() => undefined);
    });
    expect(notices.report).not.toHaveBeenCalled();
    expect(notices.clear.mock.calls.length).toBe(clears);
  });
});

function RailHarness() {
  const [searchChatThread, setSearchChatThread] = useState<ChatThreadRecord | null>(searchThread);
  const [view, setView] = useState<"chats" | "history">("chats");
  return (
    <div>
      <button type="button" onClick={() => setView("history")}>
        show-history
      </button>
      <button type="button" onClick={() => setView("chats")}>
        show-chats
      </button>
      <output data-testid="pending-initial-thread">{searchChatThread ? "set" : "cleared"}</output>
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

it("shows what an agent's thread is doing over the composer of a file's chat", async () => {
  let pushLines: (event: AgentThreadLinesEvent) => void = () => undefined;
  bridgeMock.onAgentThreadLines.mockImplementation((listener: typeof pushLines) => {
    pushLines = listener;
    return () => undefined;
  });
  bridgeMock.readAgentThreadLines.mockResolvedValue({
    workspaceId: "workspace-1",
    revision: 1,
    lines: [
      { agentId: "nova", chatThreadId: "thread-1", state: "working", sinceMs: Date.now() },
      { agentId: "nova", chatThreadId: "thread-9", state: "silent", sinceMs: Date.now() },
    ],
  });
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    agents: {
      nova: {
        name: "Nova",
        hue: "olive",
        thread: { tool: "t3-code", id: "t3-nova" },
        workspaces: ["workspace-1"],
        changesFiles: true,
        enabled: true,
        timeoutMinutes: 30,
      },
    },
  };
  render(
    <AgentThreadLinesProvider
      workspaceId="workspace-1"
      ready
      settings={settings}
      report={vi.fn()}
      clear={vi.fn()}
    >
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="notes/plan.md"
        initialThread={searchThread}
        onError={vi.fn()}
      />
    </AgentThreadLinesProvider>,
  );
  const chat = await screen.findByTestId("linked-chat-thread");
  const shown = await within(chat).findByTestId("agent-thread-line");
  expect(shown.dataset.state).toBe("working");
  expect(
    shown.compareDocumentPosition(screen.getByTestId("linked-chat-composer")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  act(() =>
    pushLines({
      workspaceId: "workspace-1",
      revision: 2,
      lines: [
        {
          agentId: "nova",
          chatThreadId: "thread-9",
          questionId: null,
          threadWaiting: false,
          state: "silent",
          sinceMs: 1,
          forwardedAtMs: 1,
        },
      ],
    }),
  );
  expect(screen.queryByTestId("agent-thread-line")).toBeNull();
});

describe("LinkedChatsPanel live thread", () => {
  const comment = (id: string, author: string, body: string, at: number) => ({
    presentation: { group: "fixture", hue: null, self: false },
    id,
    threadId: "thread-1",
    authorKind: "human" as const,
    authorDisplayName: author,
    body,
    createdAtMs: at,
  });
  const maya = comment("message-1", "Maya", "Plant beans in May?", 1_700_000_000_000);
  const sam = comment("message-2", "Sam", "Spam from Sam", 1_700_000_060_000);
  const samDeleted = { ...sam, body: "", deletedAtMs: 1_700_000_120_000 };
  const workspaceChanged = () =>
    act(() => {
      for (const callback of activity) callback({ workspaceId: "workspace-1" });
    });
  const openPanel = () =>
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="notes/plan.md"
        initialThread={searchThread}
        onError={vi.fn()}
      />,
    );

  it("shows a comment deleted elsewhere while its thread is open", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, sam] });
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="notes/plan.md"
        initialThread={searchThread}
        onError={vi.fn()}
      />,
    );
    const chat = await screen.findByTestId("linked-chat-thread");
    await within(chat).findByText("Spam from Sam");

    // The delete lands from the relay; main says the workspace changed.
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [maya, { ...sam, body: "", deletedAtMs: 1_700_000_120_000 }],
    });
    act(() => {
      for (const callback of activity) callback({ workspaceId: "workspace-1" });
    });

    await within(chat).findByTestId("linked-chat-message-deleted");
    expect(chat.textContent).not.toContain("Spam from Sam");
    expect(chat.textContent).toContain("Plant beans in May?");
  });

  it("names an untitled thread for its file once its opening comment is deleted", async () => {
    const opened = { ...searchThread, title: "Plant beans in May?" };
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [opened] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, sam] });
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="notes/plan.md"
        initialThread={opened}
        onError={vi.fn()}
      />,
    );
    const chat = await screen.findByTestId("linked-chat-thread");
    await within(chat).findByText("Spam from Sam");
    expect(screen.getByTestId("linked-chat-title").textContent).toBe("Plant beans in May?");

    // The engine titles an untitled thread by its opening message, and "New
    // chat" once that message is deleted. The heading names the file instead,
    // as a Group's post is named for its Group.
    bridgeMock.listFileChats.mockResolvedValue({
      fileObjectId: "object-1",
      threads: [{ ...opened, title: "New chat", path: "notes/plan.md" }],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [{ ...maya, body: "", deletedAtMs: 1_700_000_120_000 }, sam],
    });
    workspaceChanged();

    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-title").textContent).toBe("Comment on plan.md"),
    );
    expect(chat.textContent).not.toContain("Plant beans in May?");
  });

  describe("an untitled chat whose opening comment is deleted while it is closed", () => {
    const untitled = { ...searchThread, title: "Plant beans in May?" };
    const listPanel = async () => {
      bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [untitled] });
      render(
        <LinkedChatsPanel workspaceId="workspace-1" filePath="notes/plan.md" onError={vi.fn()} />,
      );
      await screen.findByText("Plant beans in May?");
      // Another copy deletes the opening comment and this copy pulls it.
      bridgeMock.listFileChats.mockResolvedValue({
        fileObjectId: "object-1",
        threads: [{ ...untitled, title: "New chat" }],
      });
      bridgeMock.listChatMessages.mockResolvedValue({
        messages: [{ ...maya, body: "", deletedAtMs: 1_700_000_120_000 }, sam],
      });
    };
    const expectFileCommentOpen = async () => {
      const chat = await screen.findByTestId("linked-chat-thread");
      await within(chat).findByText("Spam from Sam");
      await waitFor(() =>
        expect(screen.getByTestId("linked-chat-title").textContent).toBe("Comment on plan.md"),
      );
      expect(document.body.textContent).not.toContain("Plant beans in May?");
    };

    it("takes the list's title off the row once the delete's activity arrives", async () => {
      await listPanel();
      workspaceChanged();
      await waitFor(() => expect(screen.queryByText("Plant beans in May?")).toBeNull());
      // The row is named for its file, as the chat's heading is.
      expect(screen.queryByText("New chat")).toBeNull();
      fireEvent.click(screen.getByText("Comment on plan.md"));
      await expectFileCommentOpen();
    });

    it("heads the chat with the engine's title when it opens before any activity", async () => {
      await listPanel();
      fireEvent.click(screen.getByText("Plant beans in May?"));
      await expectFileCommentOpen();
    });

    it("reads the list again when the delete's activity lands during the first read", async () => {
      const first = deferred<{ fileObjectId: string; threads: (typeof untitled)[] }>();
      bridgeMock.listFileChats.mockReturnValueOnce(first.promise);
      bridgeMock.listFileChats.mockResolvedValue({
        fileObjectId: "object-1",
        threads: [{ ...untitled, title: "New chat" }],
      });
      render(
        <LinkedChatsPanel workspaceId="workspace-1" filePath="notes/plan.md" onError={vi.fn()} />,
      );
      await waitFor(() => expect(activity.size).toBe(1));
      workspaceChanged();
      // The first read answers with the list from before the delete.
      await act(async () => first.resolve({ fileObjectId: "object-1", threads: [untitled] }));
      await screen.findByText("Comment on plan.md");
      expect(screen.queryByText("Plant beans in May?")).toBeNull();
    });
  });

  it("keeps a delete that lands while the thread's first read is still out", async () => {
    // The first read holds the old words until its reactions answer.
    const firstReactions = deferred<{ reactions: []; viewerAuthorId: string }>();
    bridgeMock.listChatReactions.mockReturnValueOnce(firstReactions.promise);
    bridgeMock.listChatMessages.mockResolvedValueOnce({ messages: [maya, sam] });
    openPanel();
    const chat = await screen.findByTestId("linked-chat-thread");
    // The file's list and the open chat each listen.
    await waitFor(() => expect(activity.size).toBe(2));

    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, samDeleted] });
    workspaceChanged();
    // The panel still shows its loading state; the activity's read has answered.
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(2));
    await act(async () => {});

    await act(async () => firstReactions.resolve({ reactions: [], viewerAuthorId: "me" }));
    await within(chat).findByTestId("linked-chat-message-deleted");
    expect(chat.textContent).not.toContain("Spam from Sam");
  });

  it("shows a sent comment once when a read already showed it", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya] });
    const sent = deferred<{ message: typeof sam }>();
    bridgeMock.sendChatMessage.mockReturnValue(sent.promise);
    openPanel();
    const chat = await screen.findByTestId("linked-chat-thread");
    await within(chat).findByText("Plant beans in May?");

    fireEvent.change(screen.getByTestId("linked-chat-composer"), {
      target: { value: "Spam from Sam" },
    });
    fireEvent.click(screen.getByTestId("linked-chat-send"));
    // The comment saved, and another change's activity reads it before the send answers.
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, sam] });
    workspaceChanged();
    await within(chat).findByText("Spam from Sam");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => sent.resolve({ message: sam }));

    expect(within(chat).getAllByText("Spam from Sam")).toHaveLength(1);
    // Two rows with one id would share a React key.
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });

  it("keeps a sent comment's tombstone when a read showed its delete first", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya] });
    const sent = deferred<{ message: typeof sam }>();
    bridgeMock.sendChatMessage.mockReturnValue(sent.promise);
    openPanel();
    const chat = await screen.findByTestId("linked-chat-thread");
    await within(chat).findByText("Plant beans in May?");

    fireEvent.change(screen.getByTestId("linked-chat-composer"), {
      target: { value: "Spam from Sam" },
    });
    fireEvent.click(screen.getByTestId("linked-chat-send"));
    // An admin deletes it before the send answers, and a read shows the delete.
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, samDeleted] });
    workspaceChanged();
    await within(chat).findByTestId("linked-chat-message-deleted");
    await act(async () => sent.resolve({ message: sam }));

    expect(chat.textContent).not.toContain("Spam from Sam");
    expect(within(chat).getAllByTestId("linked-chat-message")).toHaveLength(2);
  });

  it("reads once at a time while activity keeps coming, and shows each answer", async () => {
    bridgeMock.listChatMessages.mockResolvedValueOnce({ messages: [maya, sam] });
    openPanel();
    const chat = await screen.findByTestId("linked-chat-thread");
    await within(chat).findByText("Spam from Sam");

    const held = deferred<{ messages: (typeof maya)[] }>();
    bridgeMock.listChatMessages.mockReturnValueOnce(held.promise);
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [maya, samDeleted] });
    for (let event = 0; event < 5; event += 1) {
      workspaceChanged();
      await act(async () => {});
    }
    // The first open read and one held read: activity during it waits.
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(2);

    await act(async () => held.resolve({ messages: [maya, samDeleted] }));
    await within(chat).findByTestId("linked-chat-message-deleted");
    // One more read for the activity that came meanwhile, then none.
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(3);
  });
});

describe("LinkedChatsPanel initialThread consumption", () => {
  it("clears the parent state on consumption so a History<->Chats remount shows the list, not the stale thread", async () => {
    const user = userEvent.setup();
    render(<RailHarness />);

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
    expect(bridgeMock.listChatMessages).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    expect(screen.getByTestId("pending-initial-thread").textContent).toBe("cleared");

    await user.click(screen.getByText("show-history"));
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    await user.click(screen.getByText("show-chats"));

    await waitFor(() => expect(screen.getByTestId("about-chats-count")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-thread")).toBeNull();
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it("drops a deferred scroll after a newer thread open supersedes its request", async () => {
    const secondThread = {
      ...searchThread,
      id: "thread-2",
      title: "Second discussion",
    };
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages:
        threadId === searchThread.id
          ? [
              {
                presentation: { group: "fixture", hue: null, self: false },
                id: "shared-message",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Sam",
                body: "Old thread message",
                createdAtMs: 1,
              },
            ]
          : [
              {
                presentation: { group: "fixture", hue: null, self: false },
                id: "shared-message",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Sam",
                body: "Same id in the new DOM",
                createdAtMs: 2,
              },
              {
                presentation: { group: "fixture", hue: null, self: false },
                id: "new-focus",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Sam",
                body: "New focus",
                createdAtMs: 3,
              },
            ],
    }));
    const frames = stubAnimationFrames();
    const scrolledMessageIds: Array<string | null> = [];
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
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
    await waitFor(() => expect(frames.pending.size).toBe(1));
    const oldFrame = [...frames.pending.keys()][0]!;
    const oldCallback = frames.pending.get(oldFrame);

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
    await waitFor(() => expect(frames.pending.size).toBe(1));
    expect(frames.cancel).toHaveBeenCalledWith(oldFrame);
    expect(frames.pending.has(oldFrame)).toBe(false);

    act(() => oldCallback?.(0));
    expect(scrolledMessageIds).toEqual([]);
    act(() => frames.run());
    expect(scrolledMessageIds).toEqual(["new-focus"]);
  });
});

describe("LinkedChatsPanel thread and file reads", () => {
  const message = {
    presentation: { group: "fixture", hue: null, self: false },
    id: "message-1",
    threadId: searchThread.id,
    authorKind: "human" as const,
    authorDisplayName: "Sam",
    body: "Still here",
    createdAtMs: 1,
  };

  it("keeps an open thread's messages when Notices retries this file's Chats", async () => {
    bridgeMock.listFileChats.mockRejectedValueOnce(new Error("offline"));
    const messagesRead = deferred<unknown>();
    bridgeMock.listChatMessages.mockReturnValue(messagesRead.promise);
    const view = render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
      />,
    );
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    view.rerender(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={searchThread}
        onError={() => undefined}
      />,
    );
    await screen.findByTestId("linked-chat-thread");
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1));

    const listReads = bridgeMock.listFileChats.mock.calls.length;
    await act(async () => notices.report.mock.calls[0]![0].retry());
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(listReads + 1);
    await act(async () => {
      messagesRead.resolve({ messages: [message] });
      await messagesRead.promise;
    });

    expect(await screen.findByText("Still here")).toBeTruthy();
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      upToSequence: 1,
    });
    await userEvent.click(screen.getByTestId("linked-chat-back"));
    expect(await screen.findByTestId("linked-chats-panel")).toBeTruthy();
  });

  it("opens a saved message's chat again from Try again only while About shows that chat", async () => {
    const other = { ...searchThread, id: "thread-2", title: "Other" };
    bridgeMock.listFileChats.mockResolvedValue({
      fileObjectId: "object-1",
      threads: [searchThread, other],
    });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages: [{ ...message, id: `${threadId}-message`, threadId, body: `In ${threadId}` }],
    }));
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: { id: "m1", threadId: "thread-1" },
      failure: "Error: The bookmark projection stopped.",
    });
    const onError = vi.fn();
    const view = render(
      <LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={onError} />,
    );
    const reads = (threadId: string) =>
      bridgeMock.listChatMessages.mock.calls.filter(([input]) => input.threadId === threadId)
        .length;
    const openThread = async (threadId: string) => {
      const open = await screen.findAllByTestId("linked-chat-open");
      await userEvent.click(open.find((button) => button.dataset.threadId === threadId)!);
      await screen.findByText(`In ${threadId}`);
    };
    await openThread("thread-1");
    fireEvent.change(screen.getByTestId("linked-chat-composer"), { target: { value: "Ship it" } });
    fireEvent.click(screen.getByTestId("linked-chat-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const again = onError.mock.lastCall?.[2] as () => void;
    await waitFor(() => expect(reads("thread-1")).toBe(2));

    await userEvent.click(screen.getByTestId("linked-chat-back"));
    await openThread("thread-2");
    await act(async () => again());
    expect(reads("thread-1")).toBe(2);
    expect(screen.getByTestId("linked-chat-title").textContent).toBe("Other");
    expect(screen.getByText("In thread-2")).toBeTruthy();

    await userEvent.click(screen.getByTestId("linked-chat-back"));
    await openThread("thread-1");
    await act(async () => again());
    expect(reads("thread-1")).toBe(4);

    view.unmount();
    again();
    expect(reads("thread-1")).toBe(4);
  });
});

describe("LinkedChatsPanel share level", () => {
  const READ_ONLY = "Chats are read-only in this shared view.";
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

  it("names the reason it gives, and offers no comment control or composer", async () => {
    const view = render(
      panel({ shared: true, readOnly: "Only people who can comment post here." }),
    );

    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Only people who can comment post here.",
    );

    view.rerender(
      panel({
        shared: true,
        readOnly: "Only people who can comment post here.",
        initialThread: searchThread,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Only people who can comment post here.",
    );
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  it("offers no comment when the share refuses writes, and never asks main to create one", async () => {
    render(panel({ shared: true, readOnly: READ_ONLY }));

    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  it("keeps the composer and the comment control when the share allows writes", async () => {
    const view = render(panel({ shared: true }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-new")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();

    view.rerender(panel({ shared: true, initialThread: searchThread }));
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });

  it("shows existing reactions but no picker when the share refuses writes", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        {
          presentation: { group: "fixture", hue: null, self: false },
          id: "message-1",
          threadId: "thread-1",
          authorKind: "human",
          authorDisplayName: "Granter",
          body: "the comet tail",
          createdAtMs: 1,
          attachments: [],
        },
      ],
    });
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [
        {
          reactionId: "r1",
          messageId: "message-1",
          threadId: "thread-1",
          emoji: "👍",
          authorId: "someone@example.com",
          authorKind: "human",
          authorDisplayName: "someone@example.com",
        },
      ],
      viewerAuthorId: "you@example.com",
    });

    render(panel({ shared: true, readOnly: READ_ONLY, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(
      screen.getAllByTestId("linked-chat-reaction-pill").length,
      "dropping reactionControls hides other people's reactions too",
    ).toBeGreaterThan(0);
    const trigger = screen.getByTestId("linked-chat-add-reaction") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    await userEvent.click(trigger);
    expect(screen.queryByTestId("linked-chat-reaction-picker")).toBeNull();
  });
});

describe("LinkedChats reactions through the workspace store", () => {
  const note = {
    presentation: { group: "fixture", hue: null, self: false },
    id: "message-1",
    threadId: "thread-1",
    authorKind: "human" as const,
    authorDisplayName: "Granter",
    body: "the comet tail",
    createdAtMs: 1,
    attachments: [],
  };

  function controlledWrites() {
    const writes: Deferred<unknown>[] = [];
    bridgeMock.setChatReaction.mockImplementation(() => {
      const write = deferred<unknown>();
      writes.push(write);
      return write.promise;
    });
    return writes;
  }

  function openPanel(
    testId: string,
    onError: (message: string) => void = () => undefined,
    initialThread: ChatThreadRecord | null = searchThread,
  ) {
    return (
      <div key={testId} data-testid={testId}>
        <WorkspaceSessionProvider workspaceId="workspace-1">
          <ProductionLinkedChatsPanel
            workspaceId="workspace-1"
            filePath="docs/plan.md"
            initialThread={initialThread}
            onError={onError}
            notices={notices}
            accessContext={accessContext}
            links={links}
          />
        </WorkspaceSessionProvider>
      </div>
    );
  }

  const thumbsIn = (testId: string) =>
    within(screen.getByTestId(testId))
      .getAllByTestId("linked-chat-quick-reaction")
      .find((button) => button.dataset.emoji === "👍")!;
  const ready = (testId: string) => waitFor(() => expect(thumbsIn(testId)).toBeTruthy());

  it("orders one cell's writes across two open panels and shows both the same rows", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [note] });
    const writes = controlledWrites();
    render(
      <ReactionStoreProvider workspaceId="workspace-1">
        {openPanel("first")}
        {openPanel("second")}
      </ReactionStoreProvider>,
    );
    await ready("first");
    await ready("second");

    await userEvent.click(thumbsIn("first"));
    expect(thumbsIn("first").getAttribute("aria-pressed")).toBe("true");
    expect(thumbsIn("second").getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(thumbsIn("second"));
    expect(thumbsIn("first").getAttribute("aria-pressed")).toBe("false");
    expect(thumbsIn("second").getAttribute("aria-pressed")).toBe("false");
    expect(writes).toHaveLength(1);

    await act(async () => {
      writes[0]!.resolve({});
      await writes[0]!.promise;
    });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => payload.state)).toEqual([
      "added",
      "removed",
    ]);
    expect(thumbsIn("first").getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      writes[1]!.resolve({});
      await writes[1]!.promise;
    });
    await waitFor(() => expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(3));
    expect(screen.queryAllByTestId("linked-chat-reaction-pill")).toHaveLength(0);
  });

  it("does not paint another thread's pending reaction after switching threads", async () => {
    const otherThread = { ...searchThread, id: "thread-2", title: "Other" };
    bridgeMock.listFileChats.mockResolvedValue({
      fileObjectId: "object-1",
      threads: [searchThread, otherThread],
    });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages: [{ ...note, threadId }],
    }));
    controlledWrites();
    render(
      <ReactionStoreProvider workspaceId="workspace-1">
        {openPanel("panel", undefined, null)}
      </ReactionStoreProvider>,
    );
    const openThread = async (threadId: string) => {
      const open = await screen.findAllByTestId("linked-chat-open");
      await userEvent.click(open.find((button) => button.dataset.threadId === threadId)!);
    };
    await openThread("thread-1");
    await ready("panel");
    await userEvent.click(thumbsIn("panel"));
    expect(thumbsIn("panel").getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId("linked-chat-back"));
    await openThread("thread-2");
    await waitFor(() =>
      expect(bridgeMock.listChatMessages).toHaveBeenLastCalledWith({
        workspaceId: "workspace-1",
        threadId: "thread-2",
      }),
    );
    await ready("panel");
    expect(thumbsIn("panel").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryAllByTestId("linked-chat-reaction-pill")).toHaveLength(0);
  });
});

describe("LinkedChatsPanel comment on the file", () => {
  const created: ChatThreadRecord = {
    id: "thread-new",
    title: "Tighten the intro",
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  function renderPanel(onError = vi.fn()) {
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [] });
    render(
      <LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={onError} />,
    );
    return onError;
  }

  async function writeComment(body: string) {
    fireEvent.click(await screen.findByTestId("linked-chat-new"));
    const composer = screen.getByTestId("linked-chat-new-composer");
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: body } });
    fireEvent.keyDown(composer, { key: "Enter" });
  }

  it("starts the file's chat untitled, posts the comment, then heads it with the comment's first line", async () => {
    // An untitled chat reads "New chat" until its first message lands.
    bridgeMock.createFileChat.mockResolvedValue({ thread: { ...created, title: "New chat" } });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: { id: "m1" } });
    renderPanel();
    await screen.findByTestId("linked-chat-new");
    bridgeMock.listFileChats.mockResolvedValue({
      fileObjectId: "object-1",
      threads: [{ ...created, path: "docs/plan.md" }],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        {
          presentation: { group: "fixture", hue: null, self: true },
          id: "m1",
          threadId: "thread-new",
          authorKind: "human",
          authorDisplayName: "You",
          body: "Tighten the intro\nIt runs long.",
          createdAtMs: 2,
        },
      ],
    });
    await writeComment("Tighten the intro\nIt runs long.");
    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-title").textContent).toBe("Tighten the intro"),
    );
    expect(bridgeMock.createFileChat).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      path: "docs/plan.md",
    });
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-new",
      body: "Tighten the intro\nIt runs long.",
    });
  });

  it("keeps the words in the chat's composer when posting them fails", async () => {
    bridgeMock.createFileChat.mockResolvedValue({ thread: created });
    bridgeMock.sendChatMessage.mockRejectedValue(new Error("disk is busy"));
    const onError = renderPanel();
    await writeComment("Tighten the intro");
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect((screen.getByTestId("linked-chat-composer") as HTMLTextAreaElement).value).toBe(
      "Tighten the intro",
    );
    expect(onError).toHaveBeenCalledOnce();
  });

  it("says a comment that posted was posted, and leaves its words out of the composer, when a later step fails", async () => {
    const failure = "Error: Chats stopped because this window changed workspaces.";
    bridgeMock.createFileChat.mockResolvedValue({ thread: created });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: { id: "m1", threadId: "thread-new" },
      failure,
    });
    const onError = renderPanel();
    await writeComment("Tighten the intro");
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect((screen.getByTestId("linked-chat-composer") as HTMLTextAreaElement).value).toBe("");
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      "Posted your comment. dohc could not show it yet.",
      failure,
      expect.any(Function),
    );
  });

  it("closes the composer on Escape without writing anything", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("linked-chat-new"));
    fireEvent.keyDown(screen.getByTestId("linked-chat-new-composer"), { key: "Escape" });
    expect(screen.queryByTestId("linked-chat-new-composer")).toBeNull();
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });
});

// A shared view always states the answer, so an absent prop can only mean
// a workspace this machine owns. The shell is what guarantees that, and it
// is why this prop carries the decision rather than the level: a damaged
// grant has no level to read, and reading one would answer "writable".
