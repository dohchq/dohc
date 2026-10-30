import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadRecord } from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import { LinkedChatsPanel as ProductionLinkedChatsPanel } from "./LinkedChats";
import { ReactionStoreProvider } from "./reactionStore";
import type { AboutFile } from "./About";
import type { AccessContext } from "./accessReason";

const messageRenderGate = vi.hoisted(() => ({
  current: null as { resume: Promise<void>; onRender: () => void } | null,
}));

// Hold the loaded list's render so a response frame can run before commit.
vi.mock("./chatMessages", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chatMessages")>();
  const { createElement } = await import("react");
  return {
    ...original,
    ChatMessageList: (props: ComponentProps<typeof original.ChatMessageList>) => {
      if (messageRenderGate.current && !props.loading && props.messages.length > 0) {
        messageRenderGate.current.onRender();
        throw messageRenderGate.current.resume;
      }
      return createElement(original.ChatMessageList, props);
    },
  };
});

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
  messageRenderGate.current = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LinkedChatsPanel with no file focused", () => {
  it.each([
    [true, false, "Switch to a file or a conversation to see who has access."],
    [true, true, "Switch to a file's tab to see its comments and access."],
    [false, false, "Open a file or a conversation to see who has access."],
    [false, true, "Open a file to see its comments and access."],
  ] as const)("aboutTabOpen %s, shared %s", (aboutTabOpen, shared, copy) => {
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath={null}
        aboutTabOpen={aboutTabOpen}
        {...(shared ? { shareReadOnly: true } : { history: { revision: 0, paused: false, onOpenMoment: () => undefined, onOpenHistory: () => undefined } })}
        onError={() => undefined}
      />,
    );
    expect(screen.getByTestId("linked-chats-empty").textContent).toBe(copy);
    expect(bridgeMock.listFileChats).not.toHaveBeenCalled();
  });
});

describe("LinkedChatsPanel startup", () => {
  it("shows loading lines until the first read answers", async () => {
    const fileRead = deferred<unknown>();
    bridgeMock.listFileChats.mockReturnValue(fileRead.promise);
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        history={{ revision: 0, paused: false, onOpenMoment: () => undefined, onOpenHistory: () => undefined }}
        onError={() => undefined}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByTestId("about-chats-toggle")).toBeTruthy();
    expect(screen.getByText("Loading comments...")).toBeTruthy();
    expect(screen.queryByTestId("linked-chats-panel")).toBeNull();
    expect(screen.queryByTestId("about-chats-count")).toBeNull();
    expect(screen.getByTestId("about-history-file").textContent).toBe("loading");

    await act(async () => {
      fileRead.resolve({ fileObjectId: "object-1", threads: [] });
      await fileRead.promise;
    });
    expect(screen.getByTestId("about-chats-count").textContent).toBe("0");
    expect(screen.queryByTestId("about-chats-toggle")).toBeNull();
    expect(screen.getByTestId("about-history-file").textContent).toBe("ready:object-1");
  });

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

  it("reports an ordinary load failure through the shell once, without retrying it", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    bridgeMock.listFileChats.mockRejectedValue(error);

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
      />,
    );

    await act(async () => undefined);
    // The words go to a toast and a Notices row; the section shows Try again.
    expect(notices.report).toHaveBeenCalledWith({
      identity: "about-chats:docs/plan.md",
      message: "offline",
      cause: error,
      retry: expect.any(Function),
    });
    expect(screen.queryByText("offline")).toBeNull();
    expect(within(screen.getByTestId("linked-chats-failed")).getByText("Try again")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that only has the old updating message", async () => {
    vi.useFakeTimers();
    bridgeMock.listFileChats.mockRejectedValue(
      new Error("Workspace is still updating. Try again."),
    );

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
      />,
    );

    await act(async () => undefined);
    expect(screen.getByTestId("linked-chats-failed")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(1);
  });

  // The engine ends its first capture ready or degraded, so its answer ends
  // the wait, not a deadline here.
  it("keeps waiting with no deadline while the engine reads the workspace in", async () => {
    vi.useFakeTimers();
    bridgeMock.listFileChats.mockResolvedValue({
      status: "refused",
      code: "workspace-updating",
    });

    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        onError={() => undefined}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(301);
    expect(notices.report).not.toHaveBeenCalled();
    expect(screen.getByText("Loading comments...")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();

    bridgeMock.listFileChats.mockResolvedValue({
      fileObjectId: "object-1",
      threads: [],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId("about-chats-count")).toBeTruthy();
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(302);
  });

  it("cancels an updating retry when the selected file changes", async () => {
    vi.useFakeTimers();
    bridgeMock.listFileChats
      .mockResolvedValueOnce({
        status: "refused",
        code: "workspace-updating",
      })
      .mockResolvedValue({ fileObjectId: "object-2", threads: [] });
    const view = render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/old.md"
        onError={() => undefined}
      />,
    );
    await act(async () => undefined);

    view.rerender(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/new.md"
        onError={() => undefined}
      />,
    );
    await act(async () => undefined);
    expect(screen.getByTestId("about-chats-count")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(2);
    expect(bridgeMock.listFileChats).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      path: "docs/new.md",
    });
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

  it("takes a file's Notices row with it when the file leaves About, so rows never pile up", async () => {
    bridgeMock.listFileChats.mockRejectedValue(new Error("offline"));
    const view = render(
      <LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={() => undefined} />,
    );
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(1));
    view.rerender(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/other.md" onError={() => undefined} />);
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(2));
    expect(notices.clear).toHaveBeenCalledWith("about-chats:docs/plan.md");
    expect(notices.report.mock.calls.map(([failure]) => failure.identity)).toEqual([
      "about-chats:docs/plan.md", "about-chats:docs/other.md",
    ]);
    // Closing the panel takes the last row too.
    const before = notices.clear.mock.calls.length;
    view.unmount();
    expect(notices.clear.mock.calls.slice(before).map(([identity]) => identity)).toContain("about-chats:docs/other.md");
  });

  it("reports the same file failing again under the same identity, so the shell replaces its row", async () => {
    bridgeMock.listFileChats.mockRejectedValue(new Error("offline"));
    render(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={() => undefined} />);
    const retry = await screen.findByText("Try again");
    await act(async () => retry.click());
    await waitFor(() => expect(notices.report).toHaveBeenCalledTimes(2));
    expect(notices.report.mock.calls.map(([failure]) => failure.identity)).toEqual([
      "about-chats:docs/plan.md", "about-chats:docs/plan.md",
    ]);
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
        { presentation: { group: "fixture", hue: null, self: false },
          id: "message-file",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Sam",
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
        { presentation: { group: "fixture", hue: null, self: false },
          id: "message-1",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Sam",
          body: "First update",
          createdAtMs: 1_700_000_000_000,
        },
        { presentation: { group: "fixture", hue: null, self: false },
          id: "message-2",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Sam",
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

  it("reveals a historical file message after a deferred reload commits", async () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      id: `message-${index}`, threadId: searchThread.id,
      presentation: { group: "fixture", hue: null, self: false },
      authorKind: "human" as const, authorDisplayName: "Reader",
      body: `File message ${index}`, createdAtMs: index + 1,
    }));
    bridgeMock.listChatMessages.mockResolvedValue({ messages });
    const frames = stubAnimationFrames();
    const scrolled: Array<string | null> = [];
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
      scrolled.push(this.getAttribute("data-message-id"));
    });
    const view = render(
      <Suspense fallback={null}>
        <LinkedChatsPanel workspaceId="workspace-1" filePath="topic.md" onError={() => undefined} />
      </Suspense>,
    );
    await userEvent.setup().click(await screen.findByTestId("linked-chat-open"));
    await screen.findByText("File message 299");
    await waitFor(() => expect(frames.pending.size).toBe(1));
    act(() => frames.run());
    expect(scrolled).toContain("message-299");
    scrolled.length = 0;

    const reload = deferred<{ messages: typeof messages }>();
    const suspended = deferred<void>();
    const resume = deferred<void>();
    bridgeMock.listChatMessages.mockReturnValueOnce(reload.promise);
    view.rerender(
      <Suspense fallback={null}>
        <LinkedChatsPanel workspaceId="workspace-1" filePath="topic.md"
          initialThread={{ ...searchThread }} initialFocusMessageId="message-0"
          onError={() => undefined} />
      </Suspense>,
    );
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(2));
    messageRenderGate.current = { resume: resume.promise, onRender: () => suspended.resolve() };
    await act(async () => { reload.resolve({ messages }); });
    await suspended.promise;
    // The reload has reached render, but its list cannot commit yet.
    act(() => frames.run());
    expect(scrolled).toEqual([]);
    await act(async () => {
      messageRenderGate.current = null;
      resume.resolve();
    });
    await screen.findByText("File message 299");
    act(() => frames.run());
    expect(scrolled).toContain("message-0");
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

  it("cancels a pending reveal when the panel unmounts", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [{
      id: "message-1", threadId: searchThread.id, authorKind: "human",
      presentation: { group: "fixture", hue: null, self: false },
      authorDisplayName: "Reader", body: "Pending reveal", createdAtMs: 1,
    }] });
    const frames = stubAnimationFrames();
    const view = render(
      <LinkedChatsPanel workspaceId="workspace-1" filePath="topic.md"
        initialThread={searchThread} initialFocusMessageId="message-1"
        onError={() => undefined} />,
    );
    await screen.findByText("Pending reveal");
    await waitFor(() => expect(frames.pending.size).toBe(1));
    const frame = [...frames.pending.keys()][0]!;
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    view.unmount();

    expect(frames.cancel).toHaveBeenCalledWith(frame);
    expect(frames.pending.size).toBe(0);
    act(() => frames.run());
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
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

  it("hands History this file's object after Back from a search-opened thread", async () => {
    const fileRead = deferred<unknown>();
    bridgeMock.listFileChats.mockReturnValue(fileRead.promise);
    render(
      <LinkedChatsPanel
        workspaceId="workspace-1"
        filePath="docs/plan.md"
        initialThread={searchThread}
        history={{ revision: 0, paused: false, onOpenMoment: () => undefined, onOpenHistory: () => undefined }}
        onError={() => undefined}
      />,
    );
    await screen.findByTestId("linked-chat-thread");
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1));
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(1);

    // The file's read answers after the thread opened.
    await act(async () => {
      fileRead.resolve({ fileObjectId: "object-1", threads: [searchThread] });
      await fileRead.promise;
    });
    await userEvent.click(screen.getByTestId("linked-chat-back"));

    await waitFor(() =>
      expect(screen.getByTestId("about-history-file").textContent).toBe("ready:object-1"),
    );
    expect(screen.getByTestId("linked-chats-panel")).toBeTruthy();
    expect(bridgeMock.listFileChats).toHaveBeenCalledTimes(1);
  });

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
        { presentation: { group: "fixture", hue: null, self: false },
          id: "message-1",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Sam",
          body: "First.",
          createdAtMs: 1_700_000_000_000,
        },
        { presentation: { group: "fixture", hue: null, self: false },
          id: "message-2",
          threadId: searchThread.id,
          authorKind: "human",
          authorDisplayName: "Sam",
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

  it("replaces the composer with the refusal words when the share refuses writes", async () => {
    render(panel({ shareReadOnly: true, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-composer")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
  });

  it("offers no comment when the share refuses writes, and never asks main to create one", async () => {
    render(panel({ shareReadOnly: true }));

    await waitFor(() => expect(screen.getByTestId("linked-chats-panel")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  // The other half of both gates. Without this, hiding the composer from
  // every share keeps the two pins above green.
  it("keeps the composer and the comment control when the share allows writes", async () => {
    const view = render(panel({ shareReadOnly: false }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-new")).toBeTruthy());
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();

    view.rerender(panel({ shareReadOnly: false, initialThread: searchThread }));
    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
  });

  // A shared view always states the answer, so an absent prop can only mean
  // a workspace this machine owns. The shell is what guarantees that, and it
  // is why this prop carries the decision rather than the level: a damaged
  // grant has no level to read, and reading one would answer "writable".
  it("refuses writes when the share says so, whatever left it unreadable", async () => {
    render(panel({ shareReadOnly: true, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(
      screen.queryByTestId("linked-chat-composer"),
      "a share whose grant cannot be read must not offer a composer",
    ).toBeNull();
    expect(screen.getByTestId("linked-chat-readonly-note").textContent).toBe(
      "Chats are read-only in this shared view.",
    );
  });

  // The seam the e2e missed. `LinkedChats` loads messages and reactions in one
  // Promise.all, so a handler left on the capture gate rejects the whole
  // thread open — the panel shows "Could not load this chat" and PR2's
  // headline capability is unreachable, at every level, through the only
  // surface a person uses. Driving IPC directly never sees it.
  it("opens a thread by loading messages and reactions together", async () => {
    render(panel({ shareReadOnly: false, initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(bridgeMock.listChatMessages).toHaveBeenCalled();
    expect(
      bridgeMock.listChatReactions,
      "a reactions handler that refuses a share view refuses the whole thread open",
    ).toHaveBeenCalled();
    expect(screen.queryByText(/Could not load this chat/i)).toBeNull();
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
  });

  it("reports the thread as unloadable when either half of that load refuses", async () => {
    // The failure this file must be able to see: whichever half refuses, the
    // reader gets the same dead panel, so a test that stubs both to resolve
    // proves nothing about either.
    bridgeMock.listChatReactions.mockRejectedValueOnce(
      new Error("Chats are not enabled for this workspace."),
    );
    const onError = vi.fn();
    render(panel({ shareReadOnly: false, initialThread: searchThread, onError }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(String(onError.mock.calls[0]?.[0])).toContain(
      "Chats are not enabled for this workspace.",
    );
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

  it("keeps the composer on a workspace this machine owns", async () => {
    render(panel({ initialThread: searchThread }));

    await waitFor(() => expect(screen.getByTestId("linked-chat-thread")).toBeTruthy());
    expect(screen.getByTestId("linked-chat-composer")).toBeTruthy();
    expect(screen.queryByTestId("linked-chat-readonly-note")).toBeNull();
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

  it("keeps a closed panel's write ahead of the reopened panel's, and reports it to nobody", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [note] });
    const writes = controlledWrites();
    const left = vi.fn();
    const reopened = vi.fn();
    // The provider stays; only the panel closes and opens again.
    const view = (onError: ((message: string) => void) | null) => (
      <ReactionStoreProvider workspaceId="workspace-1">
        {onError ? openPanel("panel", onError) : null}
      </ReactionStoreProvider>
    );
    const { rerender } = render(view(left));
    await ready("panel");
    await userEvent.click(thumbsIn("panel"));
    expect(writes).toHaveLength(1);

    rerender(view(null));
    rerender(view(reopened));
    await ready("panel");
    // The add is still on its way, so the reopened panel shows it.
    await waitFor(() => expect(thumbsIn("panel").getAttribute("aria-pressed")).toBe("true"));
    await userEvent.click(thumbsIn("panel"));
    expect(writes).toHaveLength(1);

    await act(async () => {
      writes[0]!.reject(new Error("ECONNRESET"));
      await writes[0]!.promise.catch(() => undefined);
    });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(bridgeMock.setChatReaction.mock.lastCall?.[0].state).toBe("removed");
    await act(async () => {
      writes[1]!.resolve({});
      await writes[1]!.promise;
    });
    expect(thumbsIn("panel").getAttribute("aria-pressed")).toBe("false");
    expect(left).not.toHaveBeenCalled();
    expect(reopened).not.toHaveBeenCalled();
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

  it("closes the composer on Escape without writing anything", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("linked-chat-new"));
    fireEvent.keyDown(screen.getByTestId("linked-chat-new-composer"), { key: "Escape" });
    expect(screen.queryByTestId("linked-chat-new-composer")).toBeNull();
    expect(bridgeMock.createFileChat).not.toHaveBeenCalled();
  });

  it("says why a file dohc does not track takes no comments, and offers none", async () => {
    bridgeMock.listFileChats.mockResolvedValue({ fileObjectId: null, threads: [] });
    render(<LinkedChatsPanel workspaceId="workspace-1" filePath="docs/plan.md" onError={vi.fn()} />);
    expect((await screen.findByTestId("linked-chats-untracked")).textContent).toBe(
      "dohc does not track this file, so it cannot have comments.",
    );
    expect(screen.queryByTestId("linked-chat-new")).toBeNull();
  });
});
