import "../../testing/legendListMock";
import { formatChatDay, formatChatTime } from "../time";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState, type Dispatch, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChatMessageRecord, ChatReactionRecord } from "../../ipc/bridgeContract";
import {
  ChatComposer,
  ChatMessageList,
  type ChatMessageListHandle,
  MentionText,
  chatAuthorLabel,
  runReactionToggle,
  type ReactionToggleContext,
} from "./chatMessages";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import { deferred, type Deferred } from "../../testing/deferred";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { AgentSettingsProvider } from "./AgentBadge";
import { identityHue } from "./ChatAvatar";
import { setChosenColors } from "./chosenColors";

// Real implementations, spied: every message-body render runs the file-token
// scan, so its call count shows whether a message actually re-rendered.
vi.mock("./chatFileMentions", { spy: true });

// Shared Chats pieces (PR 13, WS-E): both the file-rail panel and the Chats
// view send through this composer, so its Enter semantics are load-bearing
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

  it("does not send on Enter during IME composition", () => {
    const { onSend } = renderComposer();
    const composer = screen.getByTestId("test-chat-composer");
    // A CJK/IME user pressing Enter to confirm composed characters: the
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
  it("renders its rows again for a new name, and not for any other settings save", () => {
    setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "plum" });
    const messages: ChatMessageRecord[] = [{
      id: "m1", threadId: "thread", authorKind: "human", authorDisplayName: "Ada",
      body: "Hello", createdAtMs: new Date(2026, 8, 17, 12).getTime(),
    }];
    const listRef = createRef<ChatMessageListHandle>();
    // The same list element throughout, so only the settings change.
    const list = (
      <ChatMessageList testIdPrefix="test-chat" messages={messages} loading={false} emptyLabel="No messages" listRef={listRef} />
    );
    const save = (settings: typeof DEFAULT_USER_SETTINGS) =>
      <AgentSettingsProvider settings={settings}>{list}</AgentSettingsProvider>;
    const { rerender } = render(save(DEFAULT_USER_SETTINGS));
    expect(screen.getByTitle("Ada").className).toContain(`text-hue-${identityHue("Ada")}`);
    const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;

    // A save that hides a sidebar view is a new settings object.
    rerender(save({ ...DEFAULT_USER_SETTINGS, sidebar: { ...DEFAULT_USER_SETTINGS.sidebar, hidden: ["graph"] } }));
    expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);

    rerender(save({ ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" } }));
    expect(screen.getByTitle("Ada").className).toContain("text-hue-plum");
    setChosenColors(DEFAULT_USER_SETTINGS.appearance);
  });

  it.each([
    { name: "same identity after a rename", firstId: "a", secondId: "a", secondName: "Renamed", continues: true },
    { name: "different identities with the same name", firstId: "a", secondId: "b", continues: false },
    { name: "only the earlier identity known", firstId: "a", continues: false },
    { name: "only the later identity known", secondId: "a", continues: false },
    { name: "neither identity known", continues: true },
    { name: "different names without identities", secondName: "Other", continues: false },
    { name: "different author kinds", firstId: "a", secondId: "a", secondKind: "agent" as const, continues: false },
    { name: "five minutes apart", firstId: "a", secondId: "a", gap: 300_000, continues: false },
    { name: "different days", gap: 120_000, start: new Date(2026, 8, 17, 23, 59).getTime(), continues: false },
  ])("groups messages by identity: $name", (test) => {
    const first: ChatMessageRecord = {
      id: "first", threadId: "thread", authorKind: "human", authorDisplayName: "Sam",
      authorUserId: test.firstId, body: "First", createdAtMs: test.start ?? new Date(2026, 8, 17, 12).getTime(),
    };
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[first, {
          ...first, id: "second", authorUserId: test.secondId,
          authorDisplayName: test.secondName ?? first.authorDisplayName,
          authorKind: test.secondKind ?? first.authorKind,
          createdAtMs: first.createdAtMs + (test.gap ?? 60_000),
        }]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
      />,
    );
    expect(screen.getAllByTestId("test-chat-message")[1]?.dataset.continues).toBe(String(test.continues));
  });

  it("renders agent messages as \"their stored name\" and humans by name", () => {
    expect(
      chatAuthorLabel({ authorKind: "agent", authorDisplayName: "Sam" }),
    ).toBe("Sam");
    expect(
      chatAuthorLabel({ authorKind: "human", authorDisplayName: "Sam" }),
    ).toBe("Sam");
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-1",
            threadId: "thread-1",
            authorKind: "agent",
            authorDisplayName: "Sam",
            body: "Report ready.",
            createdAtMs: 1_700_000_000_000,
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
      />,
    );
    expect(screen.getByTestId("test-chat-message-author").textContent).toBe(
      "Sam",
    );
  });

  it("marks an automation message with its lightning mark and badge, and opens the automation", () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-auto",
            threadId: "thread-1",
            authorKind: "automation",
            authorDisplayName: "Stamp the finish date",
            authorOwnerDisplayName: "Ice",
            body: "Finished Book hotel",
            createdAtMs: 1_700_000_000_000,
            automation: { automationId: "collection:Trip/Tasks#stamp", collectionPath: "Trip/Tasks" },
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        onOpenPath={onOpenPath}
      />,
    );
    const author = screen.getByTestId("test-chat-message-author");
    expect(author.textContent).toBe("Stamp the finish date");
    expect(author.dataset.authorKind).toBe("automation");
    expect(screen.queryByTestId("test-chat-agent-badge")).toBeNull();
    expect(screen.getByTitle("Stamp the finish date").querySelector("svg.lucide-zap")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open automation" }));
    expect(onOpenPath).toHaveBeenCalledWith("Trip/Tasks/automations.yaml");
  });

  it("renders file chips without requiring a person or agent roster", () => {
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-file",
            threadId: "thread-1",
            authorKind: "human",
            authorDisplayName: "Sam",
            body: "Read @[docs/plan.md#scope] and `@[docs/code.md]`.",
            createdAtMs: 1_700_000_000_000,
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        mentionCandidates={[]}
      />,
    );

    expect(screen.getAllByTestId("test-chat-message-body-file-mention")).toHaveLength(1);
    const fileChip = screen.getByTestId("test-chat-message-body-file-mention");
    expect(fileChip.textContent).toContain("plan.md#scope");
    expect(fileChip.tagName).toBe("SPAN");
    expect(fileChip.getAttribute("role")).toBeNull();
    expect(screen.getByTestId("test-chat-message-body").textContent)
      .toContain("@[docs/code.md]");
  });

  it("opens a file mention at its heading through the shared message list", () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-file",
            threadId: "thread-1",
            authorKind: "human",
            authorDisplayName: "Sam",
            body: "Read @[docs/plan.md#scope].",
            createdAtMs: 1_700_000_000_000,
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        onOpenPath={onOpenPath}
      />,
    );

    const fileChip = screen.getByRole("button", {
      name: "Open docs/plan.md at #scope",
    });
    expect(fileChip).toBe(screen.getByTestId("test-chat-message-body-file-mention"));
    fireEvent.click(fileChip);
    expect(onOpenPath).toHaveBeenCalledOnce();
    expect(onOpenPath).toHaveBeenCalledWith("docs/plan.md", "scope");
  });

  it("opens hand-typed edge-space mentions through the authoritative attachment path", () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-file",
            threadId: "thread-1",
            authorKind: "human",
            authorDisplayName: "Sam",
            body: "Read @[ docs/plan.md #scope].",
            createdAtMs: 1_700_000_000_000,
            attachments: [
              {
                attachmentId: "attachment-1",
                threadId: "thread-1",
                messageId: "message-file",
                targetKind: "file",
                objectId: "file-1",
                pathHint: "docs/plan.md",
                headingAnchor: "scope",
                createdAtMs: 1_700_000_000_000,
              },
            ],
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        onOpenPath={onOpenPath}
      />,
    );

    fireEvent.click(screen.getByTestId("test-chat-message-body-file-mention"));
    expect(onOpenPath).toHaveBeenCalledWith("docs/plan.md", "scope");
  });

  it("keeps an exact edge-space filename when its authoritative attachment wins", () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-file",
            threadId: "thread-1",
            authorKind: "human",
            authorDisplayName: "Sam",
            body: "Compare @[ docs/plan.md] and @[docs/plan.md].",
            createdAtMs: 1_700_000_000_000,
            attachments: [
              {
                attachmentId: "attachment-trimmed",
                threadId: "thread-1",
                messageId: "message-file",
                targetKind: "file",
                pathHint: "docs/plan.md",
                createdAtMs: 1_700_000_000_000,
              },
              {
                attachmentId: "attachment-exact-space",
                threadId: "thread-1",
                messageId: "message-file",
                targetKind: "file",
                pathHint: " docs/plan.md",
                createdAtMs: 1_700_000_000_000,
              },
            ],
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        onOpenPath={onOpenPath}
      />,
    );

    const chips = screen.getAllByTestId("test-chat-message-body-file-mention");
    fireEvent.click(chips[0] as HTMLElement);
    fireEvent.click(chips[1] as HTMLElement);
    expect(onOpenPath.mock.calls).toEqual([
      [" docs/plan.md", undefined],
      ["docs/plan.md", undefined],
    ]);
  });

  it("does not bind literal mentions to unrelated attachments by heading or order", () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[
          {
            id: "message-file",
            threadId: "thread-1",
            authorKind: "agent",
            authorDisplayName: "Sam",
            body: "Compare @[docs/literal.md#scope] and @[docs/unheaded.md].",
            createdAtMs: 1_700_000_000_000,
            attachments: [
              {
                attachmentId: "attachment-cli",
                threadId: "thread-1",
                messageId: "message-file",
                targetKind: "file",
                objectId: "file-cli",
                pathHint: "docs/independent-cli-input.md",
                headingAnchor: "scope",
                createdAtMs: 1_700_000_000_000,
              },
              {
                attachmentId: "attachment-cli-unheaded",
                threadId: "thread-1",
                messageId: "message-file",
                targetKind: "file",
                objectId: "file-cli-unheaded",
                pathHint: "docs/another-independent-input.md",
                createdAtMs: 1_700_000_000_000,
              },
            ],
          },
        ]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        onOpenPath={onOpenPath}
      />,
    );

    const chips = screen.getAllByTestId("test-chat-message-body-file-mention");
    fireEvent.click(chips[0] as HTMLElement);
    fireEvent.click(chips[1] as HTMLElement);
    expect(onOpenPath.mock.calls).toEqual([
      ["docs/literal.md", "scope"],
      ["docs/unheaded.md", undefined],
    ]);
  });

  it("classifies mention code ranges across the whole message when file chips split rendering", () => {
    render(
      <div data-testid="message">
        <MentionText
          body={[
            "@ice see @[docs/plan.md]",
            "```text",
            "@[docs/inert.md]",
            "@ice remains code in this unclosed fence",
          ].join("\n")}
          candidates={[{ id: "ice", kind: "user", handle: "ice", label: "Sam" }]}
          testId="whole-message"
        />
      </div>,
    );

    expect(screen.getAllByTestId("whole-message-mention")).toHaveLength(1);
    expect(screen.getByTestId("whole-message-mention").textContent).toBe("@ice");
    expect(screen.getAllByTestId("whole-message-file-mention")).toHaveLength(1);
    expect(screen.getByTestId("message").textContent).toContain(
      "@[docs/inert.md]\n@ice remains code",
    );
  });
});

describe("formatChatTime", () => {
  it("includes the year only for day labels outside the current year", () => {
    const now = new Date(2026, 8, 17).getTime();
    for (const year of [2025, 2026, 2027]) {
      const day = new Date(year, 2, 4);
      expect(formatChatDay(day.getTime(), now)).toBe(day.toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
        ...(year !== 2026 ? { year: "numeric" as const } : {}),
      }));
    }
    expect(formatChatDay(now, now)).toBe("Today");
    expect(formatChatDay(new Date(2026, 8, 16).getTime(), now)).toBe("Yesterday");
  });

  // The cached Intl.DateTimeFormat must format exactly like the
  // toLocaleString call it replaced — same ambient locale, same options.
  it("matches the ambient-locale toLocaleString output exactly", () => {
    const at = 1_700_000_000_000;
    expect(formatChatTime(at)).toEqual({
      label: new Date(at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      iso: new Date(at).toISOString(),
    });
  });
});

describe("ChatMessageList memo boundary", () => {
  // Hosts keep composer drafts in the component that renders this list, so a
  // keystroke re-renders the host. The list must not reconcile (and re-scan
  // every message body) when its own props are unchanged.
  it("skips re-rendering when the host re-renders with unchanged props", () => {
    const messages: ChatMessageRecord[] = [
      {
        id: "message-1",
        threadId: "thread-1",
        authorKind: "human",
        authorDisplayName: "Sam",
        body: "Read @[docs/plan.md] before Friday.",
        createdAtMs: 1_700_000_000_000,
      },
    ];
    const endRef = createRef<ChatMessageListHandle>();
    function Host() {
      const [, setTick] = useState(0);
      return (
        <>
          <button data-testid="bump" onClick={() => setTick((tick) => tick + 1)} />
          <ChatMessageList
            testIdPrefix="test-chat"
            messages={messages}
            loading={false}
            emptyLabel="No messages"
            listRef={endRef}
          />
        </>
      );
    }
    render(<Host />);
    const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;
    expect(scans).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("bump"));
    expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);
  });
});

describe("message reactions (WS-MU-C2)", () => {
  const message: ChatMessageRecord = {
    id: "message-1",
    threadId: "thread-1",
    authorKind: "agent",
    authorDisplayName: "Sam",
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
    readOnly = false,
  ) {
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[message]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        reactionControls={{ reactions, viewerAuthorId, onToggle, readOnly }}
      />,
    );
    return { onToggle };
  }

  // jsdom measures every box as empty and the picker dismisses itself when
  // its trigger sits outside the viewport, so the trigger gets a size.
  function openPicker() {
    const trigger = screen.getByTestId("test-chat-add-reaction");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 20, 20));
    fireEvent.click(trigger);
    return screen.getByTestId("test-chat-reaction-picker");
  }

  function choiceEmojis(picker: HTMLElement) {
    return within(picker)
      .getAllByTestId("test-chat-reaction-choice")
      .map((button) => button.dataset.emoji);
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
    const trigger = screen.getByTestId("test-chat-add-reaction");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 20, 20));
    fireEvent.click(trigger);
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
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 20, 20));
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

  it("finds an emoji by search and accepts a pasted emoji outside the catalog", async () => {
    const { onToggle } = renderList([], "you@x");
    const picker = openPicker();
    const search = within(picker).getByLabelText("Search emoji or paste any emoji");
    // Opening focuses the search box so typing starts at once.
    expect(document.activeElement).toBe(search);
    await userEvent.paste("rocket");
    expect(choiceEmojis(picker)).toEqual(["🚀"]);
    fireEvent.click(within(picker).getByTestId("test-chat-reaction-choice"));
    expect(onToggle).toHaveBeenCalledWith({
      messageId: "message-1",
      emoji: "🚀",
      nextState: "added",
    });
    expect(screen.queryByTestId("test-chat-reaction-picker")).toBeNull();

    // A multi-codepoint emoji the catalog does not list still reacts as
    // itself when pasted. Reopening starts from an empty search.
    const family = "👨‍👩‍👧‍👦";
    const reopened = openPicker();
    expect(choiceEmojis(reopened)).toContain("👍");
    await userEvent.paste(family);
    expect(choiceEmojis(reopened)).toEqual([family]);
    fireEvent.click(within(reopened).getByTestId("test-chat-reaction-choice"));
    expect(onToggle).toHaveBeenLastCalledWith({
      messageId: "message-1",
      emoji: family,
      nextState: "added",
    });
  });

  it("toggles a quick reaction from the row toolbar and marks the viewer's own", () => {
    const { onToggle } = renderList([reaction({ emoji: "🙌", authorId: "you@x", authorDisplayName: "You" })], "you@x");
    const toolbar = screen.getByTestId("test-chat-message-toolbar");
    const quick = within(toolbar).getAllByTestId("test-chat-quick-reaction");
    expect(quick.map((button) => button.dataset.emoji)).toEqual(["👍", "🙌"]);
    expect(quick[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(quick[1]!.getAttribute("aria-pressed")).toBe("true");
    // The toolbar holds the one add-reaction trigger; the pill row keeps none.
    expect(within(toolbar).getByTestId("test-chat-add-reaction")).toBeTruthy();
    expect(screen.getAllByTestId("test-chat-add-reaction")).toHaveLength(1);
    fireEvent.click(quick[0]!);
    expect(onToggle).toHaveBeenCalledWith({ messageId: "message-1", emoji: "👍", nextState: "added" });
    fireEvent.click(quick[1]!);
    expect(onToggle).toHaveBeenCalledWith({ messageId: "message-1", emoji: "🙌", nextState: "removed" });
  });

  it("keeps the add-reaction trigger visible but disabled when read-only", () => {
    const { onToggle } = renderList([reaction()], "you@x", vi.fn(), true);
    const trigger = screen.getByTestId("test-chat-add-reaction") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-label")).toBe("Add reaction");
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("test-chat-reaction-picker")).toBeNull();
    const pill = screen.getByTestId("test-chat-reaction-pill") as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    fireEvent.click(pill);
    for (const quick of screen.getAllByTestId("test-chat-quick-reaction")) {
      expect((quick as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(quick);
    }
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders no reaction row when reactionControls is absent", () => {
    render(
      <ChatMessageList
        testIdPrefix="test-chat"
        messages={[message]}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
      />,
    );
    expect(screen.queryByTestId("test-chat-message-reactions")).toBeNull();
  });
});

// The shared reaction toggle (WS-MU-C2) paints the viewer's intent at once,
// rolls back only a rejected write, and lets overlapping toggles settle in
// any order without racing to a wrong or borrowed final state.
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

  const you = (overrides: Partial<ChatReactionRecord> = {}): ChatReactionRecord => ({
    reactionId: "r-you",
    messageId: "m1",
    threadId: "thread-1",
    emoji: "👍",
    authorId: "you@x",
    authorKind: "human",
    authorDisplayName: "You",
    ...overrides,
  });
  const peer = you({ reactionId: "r-peer", authorId: "peer@x", authorDisplayName: "Peer" });
  const listing = (reactions: ChatReactionRecord[]) => ({ reactions, viewerAuthorId: "you@x" });
  type Listing = ReturnType<typeof listing>;
  // One controlled promise per call of the bridge method, in call order.
  function controlled<T>(method: Mock) {
    const calls: Deferred<T>[] = [];
    method.mockImplementation(() => {
      const next = deferred<T>();
      calls.push(next);
      return next.promise;
    });
    return calls;
  }

  // A live mirror of the reactions state plus a real functional setter, so the
  // helper's optimistic update / rollback are observable exactly as a component
  // would apply them. With `deferSetters`, updaters queue until `flush()`, the
  // way React runs a functional setter after the call that queued it.
  function harness(initial: ChatReactionRecord[] = [], options: { deferSetters?: boolean } = {}) {
    let reactions = initial;
    let viewerAuthorId = "you@x";
    const queued: Array<() => void> = [];
    const setReactions: Dispatch<SetStateAction<ChatReactionRecord[]>> = (update) => {
      const apply = () => {
        reactions = typeof update === "function" ? update(reactions) : update;
      };
      if (options.deferSetters) queued.push(apply);
      else apply();
    };
    const setViewerAuthorId: Dispatch<SetStateAction<string>> = (update) => {
      viewerAuthorId = typeof update === "function" ? update(viewerAuthorId) : update;
    };
    const onError = vi.fn();
    const liveToken = { current: 0 };
    const ctx: ReactionToggleContext = {
      workspaceId: "ws",
      threadId: "thread-1",
      viewerAuthorId: "you@x",
      liveToken,
      pendingReactions: { current: new Map() },
      setReactions,
      setViewerAuthorId,
      onError,
    };
    return {
      ctx,
      onError,
      liveToken,
      flush() {
        for (const apply of queued.splice(0)) apply();
      },
      get reactions() {
        return reactions;
      },
      get viewerAuthorId() {
        return viewerAuthorId;
      },
      mineOn(emoji: string, messageId = "m1") {
        return reactions.some(
          (r) => r.messageId === messageId && r.emoji === emoji && r.authorId === "you@x",
        );
      },
    };
  }

  const toggle = (
    h: ReturnType<typeof harness>,
    nextState: "added" | "removed",
    cell: { messageId: string; emoji: string } = { messageId: "m1", emoji: "👍" },
  ) => runReactionToggle(h.ctx, { ...cell, nextState });

  it("rolls a rejected write back to the prior cell state and keeps peers", async () => {
    const h = harness([peer]);
    bridgeMock.setChatReaction.mockRejectedValue(new TypeError("offline"));
    toggle(h, "added");
    // Optimistically shown immediately.
    expect(h.mineOn("👍")).toBe(true);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.onError).toHaveBeenCalledWith("Could not update that reaction.", expect.any(Error));
    // The failed write reverts the cell to its pre-toggle (absent) state.
    expect(h.reactions).toEqual([peer]);
    // The reconcile list is never fetched when the write itself failed.
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged write and reports only the reload failure when the listing fails", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    bridgeMock.listChatReactions.mockRejectedValue(new TypeError("wire"));
    toggle(h, "added");
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.onError).toHaveBeenCalledWith(
      "Your reaction was saved, but dohc could not reload reactions.",
      expect.any(Error),
    );
    // The server accepted the write, so the painted reaction stays.
    expect(h.mineOn("👍")).toBe(true);
  });

  it("restores the confirmed rows, not the inverse of the last toggle, when repeated toggles fail", async () => {
    const h = harness([peer, you()]);
    bridgeMock.setChatReaction.mockRejectedValue(new TypeError("offline"));
    toggle(h, "removed");
    toggle(h, "added");
    expect(h.mineOn("👍")).toBe(true);
    await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
    // Neither write landed: the original row comes back where it was, not a
    // rebuilt one and not the "removed" a naive inverse of the last add gives.
    expect(h.reactions).toEqual([peer, you()]);
  });

  it("rolls a rejected write back to the newest acknowledged intent", async () => {
    const h = harness();
    const reload = deferred<never>();
    bridgeMock.setChatReaction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError("offline"));
    bridgeMock.listChatReactions.mockReturnValue(reload.promise);
    toggle(h, "added");
    toggle(h, "removed");
    expect(h.mineOn("👍")).toBe(false);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    // The add reached the server and the remove did not, so the cell shows
    // the add, even though its own listing never answered.
    expect(h.mineOn("👍")).toBe(true);
  });

  it("shows an earlier accepted write, from the listing, when the write after it is rejected", async () => {
    const h = harness();
    const firstWrite = deferred<undefined>();
    bridgeMock.setChatReaction
      .mockReturnValueOnce(firstWrite.promise)
      .mockRejectedValueOnce(new TypeError("offline"));
    bridgeMock.listChatReactions.mockResolvedValue(listing([you()]));
    toggle(h, "added");
    toggle(h, "removed");
    // The remove waits for the add, so the server cannot settle them out of
    // order. Once the add lands and the remove is rejected, the cell shows
    // the add as the canonical listing names it.
    firstWrite.resolve(undefined);
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.reactions).toEqual([you()]));
  });

  it("captures a new confirmed state when returning to a thread before an old write settles", async () => {
    const h = harness([you()]);
    const oldWrite = deferred<undefined>();
    bridgeMock.setChatReaction
      .mockReturnValueOnce(oldWrite.promise)
      .mockRejectedValueOnce(new TypeError("offline"));
    toggle(h, "removed");
    h.liveToken.current += 1;
    const reopened = you({ reactionId: "r-reopened" });
    h.ctx.setReactions([reopened]);
    toggle(h, "removed");
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.reactions).toEqual([reopened]);
  });

  it("suppresses an optimistic setter queued before the thread changes", () => {
    const h = harness([peer], { deferSetters: true });
    bridgeMock.setChatReaction.mockReturnValue(deferred<undefined>().promise);
    toggle(h, "added");
    h.liveToken.current += 1;
    h.flush();
    expect(h.reactions).toEqual([peer]);
  });

  it("adopts only its own cell from the listing, so another cell's pending write survives", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    const listings = controlled<Listing>(bridgeMock.listChatReactions);
    toggle(h, "added", { messageId: "m1", emoji: "👍" });
    toggle(h, "added", { messageId: "m2", emoji: "🎉" });
    await waitFor(() => expect(listings).toHaveLength(2));

    // The second cell's listing was read before the first cell's write
    // landed, so it does not carry that write.
    const party = you({ reactionId: "r-party", messageId: "m2", emoji: "🎉" });
    listings[1]!.resolve(listing([party]));
    await waitFor(() => expect(h.reactions).toContainEqual(party));
    expect(h.mineOn("👍", "m1")).toBe(true);

    const thumbs = you({ reactionId: "r-thumbs" });
    listings[0]!.resolve(listing([thumbs, party]));
    await waitFor(() => expect(h.reactions).toContainEqual(thumbs));
    expect(h.reactions).toEqual([thumbs, party]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("sends overlapping toggles on one cell in order and reconciles once", async () => {
    const h = harness();
    const writes = controlled<undefined>(bridgeMock.setChatReaction);
    bridgeMock.listChatReactions.mockResolvedValue(listing([peer]));

    // Toggle add then remove: the user's latest intent is "removed".
    toggle(h, "added");
    toggle(h, "removed");
    expect(h.mineOn("👍")).toBe(false);

    // The remove waits for the add, so the server settles them in this order.
    expect(bridgeMock.setChatReaction).toHaveBeenCalledOnce();
    writes[0]!.resolve(undefined);
    await waitFor(() => expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2));
    expect(bridgeMock.setChatReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "removed" }),
    );
    expect(bridgeMock.listChatReactions).not.toHaveBeenCalled();

    writes[1]!.resolve(undefined);
    await waitFor(() => expect(h.reactions).toEqual([peer]));
    expect(bridgeMock.listChatReactions).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("drops a listing answered after a newer toggle on its cell", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockResolvedValue(undefined);
    const listings = controlled<Listing>(bridgeMock.listChatReactions);
    toggle(h, "added");
    await waitFor(() => expect(listings).toHaveLength(1));
    // No write is in flight, so the remove goes out at once.
    toggle(h, "removed");
    expect(bridgeMock.setChatReaction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(listings).toHaveLength(2));
    // The add's listing lands after the remove: it must not revive the row.
    listings[0]!.resolve(listing([you()]));
    await listings[0]!.promise;
    expect(h.reactions).toEqual([]);
    listings[1]!.resolve(listing([]));
    await listings[1]!.promise;
    expect(h.reactions).toEqual([]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("names the viewer from the canonical listing, never from the write result", async () => {
    const h = harness();
    bridgeMock.setChatReaction.mockResolvedValue({
      reaction: { ...you({ authorId: "legacy-alias" }), state: "added" },
      viewerAuthorId: "legacy-alias",
    });
    bridgeMock.listChatReactions.mockResolvedValue({
      reactions: [you({ authorId: "you@normalized" })],
      viewerAuthorId: "you@normalized",
    });
    toggle(h, "added");
    await waitFor(() => expect(h.viewerAuthorId).toBe("you@normalized"));
    expect(h.reactions).toEqual([you({ authorId: "you@normalized" })]);
  });

  it("suppresses a stale rejection's repaint and error after the thread changes", async () => {
    const h = harness();
    const write = deferred<never>();
    bridgeMock.setChatReaction.mockReturnValue(write.promise);
    toggle(h, "added");
    h.liveToken.current += 1;
    write.reject(new TypeError("offline"));
    await write.promise.catch(() => undefined);
    // The helper's own rejection handler ran before ours. Nothing repainted,
    // nothing reported: the caller that changed the thread owns the state now.
    expect(h.mineOn("👍")).toBe(true);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("leaves state alone when the thread changes before a queued rollback runs", async () => {
    const h = harness([], { deferSetters: true });
    bridgeMock.setChatReaction.mockRejectedValue(new TypeError("offline"));
    toggle(h, "added");
    h.flush();
    expect(h.mineOn("👍")).toBe(true);
    // The rejection arrives while the thread is live, so the rollback setter
    // is queued. The thread then changes before React runs it.
    await waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    h.liveToken.current += 1;
    h.flush();
    expect(h.mineOn("👍")).toBe(true);
  });
});
