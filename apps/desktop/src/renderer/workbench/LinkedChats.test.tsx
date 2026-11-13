import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadRecord } from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import { commentTitle, LinkedChatsPanel as ProductionLinkedChatsPanel } from "./LinkedChats";
import { ReactionStoreProvider } from "./reactionStore";
import type { AboutFile } from "./About";
import type { AccessContext } from "./accessReason";

function stubAnimationFrames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => { pending.delete(id); });
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

// History stands in as the file it was given: these tests pin what the panel
// hands it, not what History then reads. Links reads its own query, which
// About.test.tsx pins.
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

// The shell's error hook and Access context, the same objects every render
// as the shell's are.
const notices = { report: vi.fn(), clear: vi.fn() };
const accessContext: AccessContext = {
  facts: { cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: true }, shareView: false },
  openSyncSettings: vi.fn(),
  connect: vi.fn(),
};

type PanelProps = ComponentProps<typeof ProductionLinkedChatsPanel>;
const links: PanelProps["links"] = { revision: 0, onOpenLink: vi.fn() };

// The workspace shell provides the reaction store in production.
function LinkedChatsPanel(props: Omit<PanelProps, "notices" | "accessContext" | "links"> & Partial<Pick<PanelProps, "notices">>) {
  return (
    <ReactionStoreProvider workspaceId={props.workspaceId}>
      <ProductionLinkedChatsPanel notices={notices} accessContext={accessContext} links={links} {...props} />
    </ReactionStoreProvider>
  );
}

// CodeRabbit major (WS-D gate): a chat opened from a search result is
// consumed ONCE. The Shell clears its searchChatThread state through
// onInitialThreadConsumed, so toggling History <-> Chats (which fully
// unmounts/remounts this panel and resets its consumed ref) must not trap
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
  getObjectAccess: vi.fn(),
  requestAccessRefresh: vi.fn(),
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
  // Access opens with the file. Only its owner has it.
  bridgeMock.getObjectAccess.mockImplementation(async (input: { ref: unknown }) => ({
    ref: input.ref, rows: [], visibility: "visible", unknownReason: null,
    coverage: { kind: "granted", complete: true, observation: "interval" },
    checkedAtMs: 0, freshness: "fresh", nextCursor: null,
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
        history={{ revision: 0, paused: false, onOpenMoment: () => undefined, onOpenHistory: () => undefined }}
        onError={() => undefined}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByText("Loading comments...")).toBeTruthy();
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
      path === "docs/old.md" ? forOld.promise : Promise.resolve({ fileObjectId: "object-2", threads: [] }));
    const view = render(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/old.md" onError={() => undefined} />);
    view.rerender(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/new.md" onError={() => undefined} />);
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
    bridgeMock.listChatMessages.mockImplementation(
      async ({ threadId }: { threadId: string }) => ({
        messages: threadId === searchThread.id
          ? [{ presentation: { group: "fixture", hue: null, self: false },
              id: "shared-message",
              threadId,
              authorKind: "human" as const,
              authorDisplayName: "Sam",
              body: "Old thread message",
              createdAtMs: 1,
            }]
          : [
              { presentation: { group: "fixture", hue: null, self: false },
                id: "shared-message",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Sam",
                body: "Same id in the new DOM",
                createdAtMs: 2,
              },
              { presentation: { group: "fixture", hue: null, self: false },
                id: "new-focus",
                threadId,
                authorKind: "human" as const,
                authorDisplayName: "Sam",
                body: "New focus",
                createdAtMs: 3,
              },
            ],
      }),
    );
    const frames = stubAnimationFrames();
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

// A search result opens its thread while this file's Chats are still being
// read. The two reads answer to different owners, so neither drops the other.
describe("LinkedChatsPanel thread and file reads", () => {
  const message = { presentation: { group: "fixture", hue: null, self: false },
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
      <LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={() => undefined} />,
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

    // Try again in Notices reads this file's Chats while the messages are on their way.
    await act(async () => notices.report.mock.calls[0]![0].retry());
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(2);
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
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [searchThread, other] });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages: [{ ...message, id: `${threadId}-message`, threadId, body: `In ${threadId}` }],
    }));
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: { id: "m1", threadId: "thread-1" }, failure: "Error: The bookmark projection stopped.",
    });
    const onError = vi.fn();
    const view = render(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={onError} />);
    const reads = (threadId: string) =>
      bridgeMock.listChatMessages.mock.calls.filter(([input]) => input.threadId === threadId).length;
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
    // The send's own reload opens the chat a second time.
    await waitFor(() => expect(reads("thread-1")).toBe(2));

    // Another chat on the same file stays open.
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

    // A closed panel opens nothing.
    view.unmount();
    again();
    expect(reads("thread-1")).toBe(4);
  });
});

// Chat follows a file share. A `view` recipient reads the chat and
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

  it("offers no comment when the share refuses writes, and never asks main to create one", async () => {
    render(panel({ shareReadOnly: true }));

    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  it("keeps the composer and the comment control when the share allows writes", async () => {
    const view = render(panel({ shareReadOnly: false }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-new")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();

    view.rerender(panel({ shareReadOnly: false, initialThread: searchThread }));
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });

  // A reaction is a write, so a share that refuses writes offers no PICKER.
  // The reactions already on a message are part of the conversation, though,
  // and a reader who can see the messages must see who reacted to them —
  // dropping the whole prop hid other people's reactions along with the
  // affordance to add one.
  it("shows existing reactions but no picker when the share refuses writes", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [
        { presentation: { group: "fixture", hue: null, self: false },
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

    render(panel({ shareReadOnly: true, initialThread: searchThread }));

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

// Independently mounted panels share the workspace's one reaction store, as
// every Chats surface does under the shell: one write chain per cell, one
// set of rows, and errors only for a panel still showing the thread.
describe("LinkedChats reactions through the workspace store", () => {
  const note = { presentation: { group: "fixture", hue: null, self: false },
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
        <ProductionLinkedChatsPanel
          workspaceId="workspace-1"
          filePath="docs/plan.md"
          initialThread={initialThread}
          onError={onError}
          notices={notices}
          accessContext={accessContext}
          links={links}
        />
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
    // The other panel removes it before the add is answered: both paint the
    // removal, and it waits for the add.
    await userEvent.click(thumbsIn("second"));
    expect(thumbsIn("first").getAttribute("aria-pressed")).toBe("false");
    expect(thumbsIn("second").getAttribute("aria-pressed")).toBe("false");
    expect(writes).toHaveLength(1);

    await act(async () => {
      writes[0]!.resolve({});
      await writes[0]!.promise;
    });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(bridgeMock.setChatReaction.mock.calls.map(([payload]) => payload.state)).toEqual(["added", "removed"]);
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
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [searchThread, otherThread] });
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
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenLastCalledWith({ workspaceId: "workspace-1", threadId: "thread-2" }));
    await ready("panel");
    expect(thumbsIn("panel").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryAllByTestId("linked-chat-reaction-pill")).toHaveLength(0);
  });
});

describe("LinkedChatsPanel comment on the file", () => {
  const created: ChatThreadRecord = { id: "thread-new", title: "Tighten the intro", createdAtMs: 1, updatedAtMs: 1 };

  function renderPanel(onError = vi.fn()) {
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: "object-1", threads: [] });
    render(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={onError} />);
    return onError;
  }

  async function writeComment(body: string) {
    fireEvent.click(await screen.findByTestId("linked-chat-new"));
    const composer = screen.getByTestId("linked-chat-new-composer");
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: body } });
    fireEvent.keyDown(composer, { key: "Enter" });
  }

  it("starts the file's chat titled by the comment's first line, posts the comment, then opens it", async () => {
    bridgeMock.createFileChat.mockResolvedValue({ thread: created });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: { id: "m1" } });
    renderPanel();
    await writeComment("Tighten the intro\nIt runs long.");
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(bridgeMock.createFileChat).toHaveBeenCalledWith({ workspaceId: "workspace-1", path: "docs/plan.md", title: "Tighten the intro" });
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({ workspaceId: "workspace-1", threadId: "thread-new", body: "Tighten the intro\nIt runs long." });
  });

  it("keeps the words in the chat's composer when posting them fails", async () => {
    bridgeMock.createFileChat.mockResolvedValue({ thread: created });
    bridgeMock.sendChatMessage.mockRejectedValue(new Error("disk is busy"));
    const onError = renderPanel();
    await writeComment("Tighten the intro");
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect((screen.getByTestId("linked-chat-composer") as HTMLTextAreaElement).value).toBe("Tighten the intro");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("says a comment that posted was posted, and leaves its words out of the composer, when a later step fails", async () => {
    const failure = "Error: Chats stopped because this window changed workspaces.";
    bridgeMock.createFileChat.mockResolvedValue({ thread: created });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: { id: "m1", threadId: "thread-new" }, failure });
    const onError = renderPanel();
    await writeComment("Tighten the intro");
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect((screen.getByTestId("linked-chat-composer") as HTMLTextAreaElement).value).toBe("");
    expect(onError).toHaveBeenCalledExactlyOnceWith("Posted your comment. dohc could not show it yet.", failure, expect.any(Function));
  });

  it("closes the composer on Escape without writing anything", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("linked-chat-new"));
    fireEvent.keyDown(screen.getByTestId("linked-chat-new-composer"), { key: "Escape" });
    expect(screen.queryByTestId("linked-chat-new-composer")).toBeNull();
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });
});

describe("commentTitle", () => {
  it("cuts a long first line with no space before the …, on whole characters", () => {
    expect(commentTitle(`${"a".repeat(198)} bbb\nmore`)).toBe(`${"a".repeat(198)}…`);
    // A chat title holds 200 UTF-16 units. Each emoji takes two, and none is split.
    expect(commentTitle("🎉".repeat(150))).toBe(`${"🎉".repeat(99)}…`);
  });
});
