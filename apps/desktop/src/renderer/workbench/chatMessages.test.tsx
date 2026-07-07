// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import { ChatComposer, ChatMessageList, chatAuthorLabel } from "./chatMessages";

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

  it("closes the quick-pick on Escape without reacting", () => {
    const { onToggle } = renderList([], "you@x");
    fireEvent.click(screen.getByTestId("test-chat-add-reaction"));
    const picker = screen.getByTestId("test-chat-reaction-picker");
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByTestId("test-chat-reaction-picker")).toBeNull();
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
