// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type Dispatch, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import {
  ChatComposer,
  ChatMessageList,
  chatAuthorLabel,
  runReactionToggle,
  type ReactionToggleContext,
} from "./chatMessages";

// Shared Chats pieces (PR 13, WS-E): both the file-rail panel and the Chats
// view send through THIS composer, so its Enter semantics are load-bearing
// for every chat surface at once.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(
    <ChatComposer
      testIdPrefix="test-chat"
      composerId="test-chat-composer"
      value="Hello there"
      sending={false}
      placeholder="Message"
      sendLabel="Send"
      onChange={onChange}
      onSend={onSend}
      {...overrides}
    />,
  );
  return { onSend, onChange };
}

describe("ChatComposer Enter-to-send", () => {
  it("sends on plain Enter", () => {
    const { onSend } = renderComposer();
    fireEvent.keyDown(screen.getByTestId("test-chat-composer"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does NOT send on Enter during IME composition", () => {
    const { onSend } = renderComposer();
    const composer = screen.getByTestId("test-chat-composer");
    // A CJK/IME user pressing Enter to CONFIRM composed characters: the
    // keydown arrives with isComposing = true and must never submit.
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    // The same Enter after composition ends sends normally.
    fireEvent.keyDown(composer, { key: "Enter", isComposing: false });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send on Shift+Enter (newline stays a newline)", () => {
    const { onSend } = renderComposer();
    fireEvent.keyDown(screen.getByTestId("test-chat-composer"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("chat authorship display", () => {
  it("renders agent messages as \"<Name>'s agent\" and humans by name", () => {
    expect(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Ice" }),
    ).toBe("Ice's agent");
    expect(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Ice's agent" }),
    ).toBe("Ice's agent");
    expect(
      chatAuthorLabel({ authorKind: "human", authorDisplayName: "Ice" }),
    ).toBe("Ice");
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-1",
            threadId: "thread-1",
            authorKind: "agent",
            authorDisplayName: "Ice",
            body: "Report ready.",
            createdAtMs: 1_700_000_000_000,
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        endRef={createRef<HTMLDivElement>()}
      />,
    );
    expect(screen.getByTestId("test-chat-message-author").textContent).toBe(
      "Ice's agent",
    );
  });
});

describe("message reactions (WS-MU-C2)", () => {
  const message: ChatMessageRecord = {
    id: "message-1",
    threadId: "thread-1",
    authorKind: "agent",
    authorDisplayName: "Ice",
    body: "Deploy is green.",
    createdAtMs: 1_700_000_000_000,
  };

  function reaction(overrides: Partial<ChatReactionRecord> = {}): ChatReactionRecord {
    return {
      reactionId: "r1",
      messageId: "message-1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "alice@x",
      authorKind: "human",
      authorDisplayName: "Alice",
      ...overrides,
    };
  }

  function renderList(
    reactions: ChatReactionRecord[],
    viewerAuthorId: string,
    onToggle = vi.fn(),
  ) {
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[message]}
        loading={false}
        emptyLabel="No messages"
        endRef={createRef<HTMLDivElement>()}
        reactionControls={{ reactions, viewerAuthorId, onToggle }}
      />,
    );
    return { onToggle };
  }

  it("groups reactions into a pill with a count and reactor tooltip", () => {
    renderList(
      [reaction(), reaction({ reactionId: "r2", authorId: "bob@x", authorDisplayName: "Bob" })],
      "you@x",
    );
    const pill = screen.getByTestId("test-chat-reaction-pill");
    expect(pill.getAttribute("data-emoji")).toBe("👍");
    expect(pill.textContent).toContain("2");
    expect(pill.getAttribute("title")).toBe("Alice, Bob reacted with 👍");
    // The glyph is aria-hidden, so the button's accessible name must come from
    // an aria-label that exposes the emoji + count + reactors — otherwise a
    // screen reader announces only the count. aria-label wins over content, so
    // getByRole's name match is the real accessible name.
    const accessibleName = pill.getAttribute("aria-label") ?? "";
    expect(accessibleName).toContain("👍");
    expect(accessibleName).toContain("2");
    expect(accessibleName).toContain("Alice");
    expect(accessibleName).toContain("Bob");
    expect(screen.getByRole("button", { name: "👍 2 — Alice, Bob" })).toBe(pill);
    // Not the viewer's reaction — not highlighted, aria-pressed false.
    expect(pill.getAttribute("data-mine")).toBe("false");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
  });

  it("marks the viewer's own reaction and removes it on click (toggle off)", () => {
    const { onToggle } = renderList([reaction({ authorId: "you@x", authorDisplayName: "You" })], "you@x");
    const pill = screen.getByTestId("test-chat-reaction-pill");
    expect(pill.getAttribute("data-mine")).toBe("true");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);
    expect(onToggle).toHaveBeenCalledWith({
      messageId: "message-1",
      emoji: "👍",
      nextState: "removed",
    });
  });

  it("adds a reaction from the quick-pick (reacting to an agent message)", () => {
    const { onToggle } = renderList([], "you@x");
    fireEvent.click(screen.getByTestId("test-chat-add-reaction"));
    const picker = screen.getByTestId("test-chat-reaction-picker");
    const choice = within(picker)
      .getAllByTestId("test-chat-reaction-choice")
      .find((button) => button.getAttribute("data-emoji") === "🎉");
    expect(choice).toBeDefined();
    fireEvent.click(choice as HTMLElement);
    expect(onToggle).toHaveBeenCalledWith({
      messageId: "message-1",
      emoji: "🎉",
      nextState: "added",
    });
    // Selecting closes the picker.
    expect(screen.queryByTestId("test-chat-reaction-picker")).toBeNull();
  });

  it("closes the quick-pick on document-level Escape and returns focus to the trigger", () => {
    const { onToggle } = renderList([], "you@x");
    const trigger = screen.getByTestId("test-chat-add-reaction");
    trigger.focus();
    fireEvent.click(trigger);
    // The picker is a lightweight quick-pick: role="group" + plain toggle
    // buttons (no menu semantics we don't implement).
    const picker = screen.getByTestId("test-chat-reaction-picker");
    expect(picker.getAttribute("role")).toBe("group");
    const choice = within(picker).getAllByTestId("test-chat-reaction-choice")[0] as HTMLElement;
    expect(choice.getAttribute("role")).toBeNull();
    expect(choice.getAttribute("aria-pressed")).toBe("false");
    // Move focus INTO the popup, then press Escape FROM the focused choice —
    // dispatching on the real event target (not `document`) exercises the
    // genuine propagation path the document-level handler relies on, so a parent
    // onKeyDownCapture that swallowed the event would be caught. The dismissal
    // must fire regardless of where focus sits, and return it to the trigger so
    // the tab order is preserved.
    choice.focus();
    fireEvent.keyDown(choice, { key: "Escape" });
    expect(screen.queryByTestId("test-chat-reaction-picker")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders no reaction row when reactionControls is absent", () => {
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[message]}
        loading={false}
        emptyLabel="No messages"
        endRef={createRef<HTMLDivElement>()}
      />,
    );
    expect(screen.queryByTestId("test-chat-message-reactions")).toBeNull();
  });
});

// WS-MU-C2 fix 4: the shared reaction toggle must roll back on failure and keep
// overlapping toggles on the same cell from racing into a wrong final state.
describe("runReactionToggle (rollback + per-cell ordering)", () => {
  const bridgeMock = {
    setChatReaction: vi.fn(),
    listChatReactions: vi.fn(),
  };

  beforeEach(() => {
    bridgeMock.setChatReaction.mockReset();
    bridgeMock.listChatReactions.mockReset();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A live mirror of the reactions state plus a real functional setter, so the
  // helper's optimistic update / rollback are observable exactly as a component
  // would apply them.
  function harness() {
    let reactions: ChatReactionRecord[] = [];
    let viewerAuthorId = "you@x";
    const setReactions: Dispatch<SetStateAction<ChatReactionRecord[]>> = (update) => {
      reactions = typeof update === "function" ? update(reactions) : update;
    };
    const setViewerAuthorId: Dispatch<SetStateAction<string>> = (update) => {
      viewerAuthorId = typeof update === "function" ? update(viewerAuthorId) : update;
    };
    const onError = vi.fn();
    const ctx: ReactionToggleContext = {
      workspaceId: "ws",
      threadId: "thread-1",
      viewerAuthorId: "you@x",
      liveToken: { current: 0 },
      reactionSeq: { current: new Map<string, number>() },
      setReactions,
      setViewerAuthorId,
      onError,
    };
    return {
      ctx,
      onError,
      get reactions() {
        return reactions;
      },
      mineOn(emoji: string) {
        return reactions.some((r) => r.emoji === emoji && r.authorId === "you@x");
      },
    };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("rolls the optimistic reaction back when the server write fails", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockRejectedValue(new Error("offline"));
    runReactionToggle(h.ctx, { messageId: "m1", emoji: "👍", nextState: "added" });
    // Optimistically shown immediately.
    expect(h.mineOn("👍")).toBe(true);
    await tick();
    // The failed write reverts the cell to its pre-toggle (absent) state.
    expect(h.mineOn("👍")).toBe(false);
    expect(h.reactions).toEqual([]);
    expect(h.onError).toHaveBeenCalledOnce();
    // The reconcile list is never fetched when the write itself failed.
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
  });

  it("converges two rapid toggles on the same cell to the LATEST intent despite out-of-order responses", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    // Controlled reconcile responses so we can resolve them out of order.
    const resolvers: Array<(value: unknown) => void> = [];
    bridgeMock.listChatReactions.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    // Toggle ADD then REMOVE — the user's LATEST intent is "removed".
    runReactionToggle(h.ctx, { messageId: "m1", emoji: "👍", nextState: "added" });
    runReactionToggle(h.ctx, { messageId: "m1", emoji: "👍", nextState: "removed" });
    // Optimistic latest intent: removed.
    expect(h.mineOn("👍")).toBe(false);

    // Both toggles reach their reconcile fetch.
    await waitFor(() => expect(resolvers).toHaveLength(2));
    const addRecord: ChatReactionRecord = {
      reactionId: "r1",
      messageId: "m1",
      threadId: "thread-1",
      emoji: "👍",
      authorId: "you@x",
      authorKind: "human",
      authorDisplayName: "you@x",
    };
    // The STALE (first, add) reconcile lands LAST — the ordering guard must drop
    // it so it can't revive the reaction the newer remove already cleared.
    resolvers[1]?.({ reactions: [], viewerAuthorId: "you@x" });
    resolvers[0]?.({ reactions: [addRecord], viewerAuthorId: "you@x" });
    await tick();

    // Final state reflects the LATEST toggle (removed), not the late add reconcile.
    expect(h.mineOn("👍")).toBe(false);
    expect(h.reactions).toEqual([]);
    expect(h.onError).not.toHaveBeenCalled();
  });
});
