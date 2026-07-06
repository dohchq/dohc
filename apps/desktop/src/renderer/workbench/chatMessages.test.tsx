// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
