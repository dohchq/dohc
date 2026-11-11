import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileResolvedChatDecision } from "./ChatsView";
import { chatOnScreen } from "./chatsOnScreen";
import { tellWindowFocused } from "../../testing/windowFocus";
import {
  NOW,
  thread,
  message,
  bridgeMock,
  chatDispatchPausedCallbacks,
  emitWorkspaceActivity,
  mentionRoster,
  renderView,
} from "./ChatsView.testHarness";

// The words of a composer bar, without its cancel button.
const barWords = (testId: string) => screen.getByTestId(testId).firstElementChild?.textContent;

describe("ChatsView work reports", () => {
  it("shows each report on its own message, the opening post's included", async () => {
    const user = userEvent.setup();
    const opening = message({
      authorKind: "agent", authorDisplayName: "Nova", body: "Fix the login redirect",
      work: { status: "working", url: "https://example.com/threads/7" },
    });
    const working = message({
      id: "message-working", parentMessageId: opening.id, authorKind: "agent", authorDisplayName: "Nova",
      body: "On it", createdAtMs: NOW + 1, work: { status: "waiting" },
    });
    const done = message({
      id: "message-done", parentMessageId: opening.id, authorKind: "agent", authorDisplayName: "Nova",
      body: "Merged", createdAtMs: NOW + 2, work: { status: "done" },
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ messageCount: 3 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, working, done] });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    // A later report never replaces the opening post's own, and no report
    // takes another's link.
    const own = await screen.findByTestId("chats-message-work");
    expect(own.getAttribute("data-status")).toBe("working");
    expect(screen.getByTestId("chats-message-work-open").getAttribute("title")).toBe("https://example.com/threads/7");
    expect(screen.getAllByTestId("chats-comment-work").map((report) => report.getAttribute("data-status"))).toEqual(["waiting", "done"]);
    expect(screen.queryByTestId("chats-comment-work-open")).toBeNull();
  });
});

describe("ChatsView decisions", () => {
  it("resolves from composer mode and uses the literal fallback for an empty reply", async () => {
    const user = userEvent.setup();
    const opening = message({ presentation: { group: "fixture", hue: null, self: true } });
    const openDecision = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
    };
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openDecisionCount: 1 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [openDecision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({
        id: "resolution-message",
        parentMessageId: opening.id,
        body: "Resolved ✓",
      }),
      resolved: {
        ...openDecision,
        state: "resolved",
        resolvedByMessageId: "resolution-message",
        atMs: NOW + 1,
      },
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(await screen.findByTestId("chats-message-decision-open")).toBeTruthy();
    await user.click(screen.getByTestId("chats-message-decision-resolve"));
    // The answer is also the reply, so one bar says both, and the reply link still goes.
    expect(barWords("chats-resolving-mode")).toBe("Answering your question");
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    await user.click(screen.getByTestId("chats-send"));

    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: "message-1",
        body: "Resolved ✓",
        resolves: { messageId: "message-1" },
      }),
    );
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(screen.queryByTestId("chats-resolving-mode")).toBeNull();
  });

  // "your" comes from main's self mark on a person, never from the name, so a
  // person named anything, and your own agent, are named.
  const whoseQuestion: [words: string, name: string, kind: "human" | "agent", self: boolean, pick: string | null][] = [
    ["Answering Nova's question", "Nova", "human", false, null],
    ["Answering Nova's question · Region A", "Nova", "human", false, "Region A"],
    ["Answering your question", "Sam", "human", true, null],
    ["Answering James's question", "James", "human", false, null],
    ["Answering Trip agent's question", "Trip agent", "agent", true, null],
  ];
  it.each(whoseQuestion)("says %s", async (words, name, kind, self, pick) => {
    const user = userEvent.setup();
    const opening = message({ authorKind: kind, authorDisplayName: name, presentation: { group: "fixture", hue: null, self } });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ openDecisionCount: 1 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{
      threadId: "thread-1", messageId: opening.id, state: "open" as const, atMs: NOW,
      ...(pick ? { options: ["Region A", "Region B"] } : {}),
    }] });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    if (pick) {
      const options = await screen.findAllByTestId("chats-message-poll-option");
      await user.click(options.find((option) => option.textContent === pick)!);
    } else {
      await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    }
    expect(barWords("chats-resolving-mode")).toBe(words);
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
  });

  it("cancels the answer and its reply together, so the next comment is neither", async () => {
    const user = userEvent.setup();
    const opening = message({ authorDisplayName: "Nova" });
    const openDecision = { threadId: "thread-1", messageId: opening.id, state: "open" as const, atMs: NOW };
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ openDecisionCount: 1 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [openDecision] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "comment-2", body: "Plain comment" }) });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    await user.click(screen.getByRole("button", { name: "Cancel answer" }));
    expect(screen.queryByTestId("chats-resolving-mode")).toBeNull();
    expect(screen.queryByTestId("chats-replying-mode")).toBeNull();
    await user.type(screen.getByTestId("chats-composer"), "Plain comment");
    await user.click(screen.getByTestId("chats-send"));

    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        body: "Plain comment",
      }),
    );
  });

  it("keeps a reply bar of its own when the reply goes to another message", async () => {
    const user = userEvent.setup();
    const opening = message({ authorDisplayName: "Nova" });
    const openDecision = { threadId: "thread-1", messageId: opening.id, state: "open" as const, atMs: NOW };
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ openDecisionCount: 1 })] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [opening, message({ id: "comment-1", authorDisplayName: "Sam", body: "Friday works." })],
    });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [openDecision] });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    await user.click((await screen.findAllByTestId("chats-comment-reply"))[0]!);
    expect(barWords("chats-resolving-mode")).toBe("Answering Nova's question");
    expect(barWords("chats-replying-mode")).toBe("Replying to Sam");
  });

  it("marks the question answered from Try again on a reply that posted while it stayed open, and never sends again", async () => {
    const user = userEvent.setup();
    const words = "Sent your reply. dohc could not mark the question answered.";
    const opening = message();
    const openDecision = { threadId: "thread-1", messageId: opening.id, state: "open" as const, atMs: NOW };
    const resolved = { ...openDecision, state: "resolved" as const, resolvedByMessageId: "resolution-message", atMs: NOW + 1 };
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ openDecisionCount: 1 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [openDecision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "resolution-message", parentMessageId: opening.id, body: "Resolved ✓" }),
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    const refusal = new Error("Your server session changed. Try again.");
    bridgeMock.resolveChatDecision.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ resolved });
    const { onError } = renderView();
    const notices = () => onError.mock.calls.filter(([said]) => said === words);

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    await user.click(screen.getByTestId("chats-send"));

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]?.[1]).toBe("Error: Your server session changed. Try again.");
    expect(notices()[0]?.[2], "Try again on the reply's toast").toEqual(expect.any(Function));
    expect(screen.getByTestId("chats-message-decision-open")).toBeTruthy();

    // A try that fails says so again, with Try again again.
    await act(async () => { notices()[0]?.[2]?.(); });
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[1]?.[1]).toBe(refusal);
    expect(notices()[1]?.[2], "Try again after a failed try").toEqual(expect.any(Function));
    expect(screen.getByTestId("chats-message-decision-open")).toBeTruthy();

    // The engine holds the answer once a try succeeds, so the reload after it reads it too.
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
    await act(async () => { notices()[1]?.[2]?.(); });
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(bridgeMock.resolveChatDecision.mock.calls).toEqual([
      [{ workspaceId: "workspace-a", threadId: "thread-1", messageId: opening.id, resolvedByMessageId: "resolution-message" }],
      [{ workspaceId: "workspace-a", threadId: "thread-1", messageId: opening.id, resolvedByMessageId: "resolution-message" }],
    ]);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(2);
  });

  it("answers a poll by picking a choice, and the choice travels with the answer", async () => {
    const user = userEvent.setup();
    const opening = message({ presentation: { group: "fixture", hue: null, self: false }, authorKind: "agent", authorDisplayName: "You", body: "Ship on which day?" });
    const poll = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
      options: ["Friday", "Monday"],
    };
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ openDecisionCount: 1 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [poll] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", parentMessageId: opening.id, body: "Monday" }),
      resolved: {
        ...poll,
        state: "resolved",
        resolvedByMessageId: "answer",
        chosenOption: "Monday",
        atMs: NOW + 1,
      },
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    // A poll with choices offers the choices, not a bare Answer button.
    const options = await screen.findAllByTestId("chats-message-poll-option");
    expect(options.map((node) => node.textContent)).toEqual(["Friday", "Monday"]);
    expect(screen.queryByTestId("chats-message-decision-resolve")).toBeNull();
    await user.click(options[1]!);
    expect(screen.getByTestId("chats-resolving-mode").textContent).toContain("Monday");
    await user.click(screen.getByTestId("chats-send"));

    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        parentMessageId: "message-1",
        body: "Monday",
        resolves: { messageId: "message-1", chosenOption: "Monday" },
      }),
    );
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    // The answered poll keeps its choices and marks the one taken.
    const answered = screen.getAllByTestId("chats-message-poll-option");
    expect(answered.map((node) => node.dataset.chosen)).toEqual(["false", "true"]);
    expect(answered.every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
  });

  it("does not decrement again when a refreshed decision is already resolved", async () => {
    const user = userEvent.setup();
    const opening = message({ body: "Resolve this" });
    const otherMessage = message({
      id: "message-other-decision",
      parentMessageId: opening.id,
      body: "Keep this decision open",
    });
    const targetOpen = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
    };
    const targetResolved = {
      ...targetOpen,
      state: "resolved" as const,
      resolvedByMessageId: "resolution-message",
      atMs: NOW + 1,
    };
    const otherOpen = {
      threadId: "thread-1",
      messageId: otherMessage.id,
      state: "open" as const,
      atMs: NOW,
    };
    const resolutionMessage = message({
      id: "resolution-message",
      parentMessageId: opening.id,
      body: "Resolved ✓",
    });
    let refreshed = false;
    bridgeMock.listChannelThreads.mockImplementation(() =>
      Promise.resolve({
        threads: [thread({ openDecisionCount: refreshed ? 1 : 2 })],
      }),
    );
    bridgeMock.listChatMessages.mockImplementation(() =>
      Promise.resolve({
        messages: refreshed
          ? [opening, otherMessage, resolutionMessage]
          : [opening, otherMessage],
      }),
    );
    bridgeMock.listChatThreadDecisions.mockImplementation(() =>
      Promise.resolve({
        decisions: refreshed
          ? [targetResolved, otherOpen]
          : [targetOpen, otherOpen],
      }),
    );
    type Answered = { message: typeof resolutionMessage; resolved: typeof targetResolved };
    let finishAnswer!: (value: Answered) => void;
    const pendingAnswer = new Promise<Answered>((resolve) => {
      finishAnswer = resolve;
    });
    bridgeMock.sendChatMessage.mockImplementation(() => pendingAnswer);

    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-message-decision-resolve"));
    await user.click(screen.getByTestId("chats-send"));
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1));

    refreshed = true;
    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(await screen.findByTestId("chats-comment-decision-open")).toBeTruthy();

    await act(async () => {
      finishAnswer({ message: resolutionMessage, resolved: targetResolved });
      await pendingAnswer;
    });

    expect(screen.getAllByTestId("chats-comment-decision-open")).toHaveLength(1);
    expect(screen.getByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(screen.getByTestId("chats-thread-view").dataset.openDecisionCount).toBe(
      "1",
    );
    expect(
      reconcileResolvedChatDecision(
        [targetResolved, otherOpen],
        targetResolved,
      ).wasOpen,
    ).toBe(false);
  });

  it("appends a resolved decision that was absent from the current snapshot", () => {
    const resolved = {
      threadId: "thread-1",
      messageId: "message-late-resolution",
      state: "resolved" as const,
      resolvedByMessageId: "message-resolution",
      atMs: NOW,
    };

    const reconciliation = reconcileResolvedChatDecision([], resolved);

    expect(reconciliation.wasOpen).toBe(false);
    expect(reconciliation.decisions).toEqual([resolved]);
  });
});

describe("ChatsView plain posts", () => {
  it("renders a short post's mention as a chip in the visible body", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ title: "Ask @Nova to check the exports" })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message({ body: "Ask @Nova to check the exports" })],
    });
    renderView(vi.fn(), vi.fn(), { mentionCandidates: mentionRoster });
    await userEvent.click(await screen.findByTestId("chats-channel"));
    await userEvent.click(await screen.findByTestId("chats-thread"));

    const body = await screen.findByTestId("chats-message-body");
    expect(body.className).toContain("select-text");
    expect(body.className).not.toContain("sr-only");
    expect(body.querySelector("[data-mention-kind]")).not.toBeNull();
    expect(screen.getByTestId("chats-thread-post-title").className).toContain("sr-only");
  });
});

describe("ChatsView work and run links", () => {
  it("renders a redacted shared attachment as an opaque attachment chip", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-redacted",
          threadId: "thread-1",
          messageId: "message-1",
          targetKind: "file",
          createdAtMs: NOW,
        },
      ],
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const chip = await screen.findByTestId("chats-attachment-chip");
    expect(chip.textContent).toBe("attachment");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("title")).toBeNull();
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("names a heading attachment by its file and heading, as before the chip", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-heading",
          threadId: "thread-1",
          messageId: "message-1",
          targetKind: "file",
          objectId: "object-1",
          pathHint: "projects/launch/brief.md",
          headingText: "Scope",
          headingAnchor: "scope",
          createdAtMs: NOW,
        },
      ],
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const chip = await screen.findByTestId("chats-attachment-chip");
    expect(screen.getByRole("button", { name: "brief.md#Scope" })).toBe(chip);
    await user.click(chip);
    expect(onOpenPath).toHaveBeenCalledWith("projects/launch/brief.md", "scope");
  });

  const changeFile = "volunteers/changes/3f2a91c0-5b7d-4e2a-9c1f-2d8e6a4b7c90.json";

  // Opens a thread whose message attaches changeFile, which reads as `text`.
  async function openThreadWithChangeFile(text: Promise<string>) {
    const user = userEvent.setup();
    const readWorkspaceText = vi.fn(async (input: { relativePath: string }) => {
      if (input.relativePath !== changeFile) throw new Error("not found");
      return { text: await text, truncated: false };
    });
    const dataset = vi.fn(async () => ({ kind: "description", dataset: { name: "Volunteers" } }));
    vi.stubGlobal("dohcDesktop", { ...window.dohcDesktop, readWorkspaceText, dataset });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-change",
          threadId: "thread-1",
          messageId: "message-1",
          targetKind: "file",
          objectId: "object-1",
          pathHint: changeFile,
          createdAtMs: NOW,
        },
      ],
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath: vi.fn() });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    return { dataset };
  }

  it("names a Collection change file by the Collection's current name, and calls it a Collection change while that loads", async () => {
    const proposal = {
      kind: "dohc-collection-change", version: 1, datasetId: "dataset-1", name: "Helpers",
      datasetPath: "volunteers/dataset.json", migrationPath: "volunteers/migrations/0002.sql",
      base: { revision: 1, revisionSha256: "a".repeat(64) }, revisionSha256: "b".repeat(64), changeSha256: "c".repeat(64),
      files: ["volunteers/dataset.json"], rows: [{ kind: "code-changed", key: "code" }], note: null,
    };
    let release!: () => void;
    const { dataset } = await openThreadWithChangeFile(new Promise(resolve => { release = () => resolve(JSON.stringify(proposal)); }));

    const loading = await screen.findByRole("button", { name: "Collection change" });
    expect(screen.getByTestId("chats-attachment-chip")).toBe(loading);
    expect(loading.textContent).toBe("Collection change");
    expect(loading.getAttribute("title")).toBe(changeFile);
    expect(loading.querySelector("svg")?.classList.contains("lucide-table-2")).toBe(true);
    expect(screen.queryByText(/3f2a91c0/)).toBeNull();

    release();
    const chip = await screen.findByRole("button", { name: "Change to Volunteers" });
    expect(screen.getByTestId("chats-attachment-chip")).toBe(chip);
    expect(chip.textContent).toBe("Change to Volunteers");
    expect(chip.getAttribute("title")).toBe(changeFile);
    expect(chip.querySelector("svg")?.classList.contains("lucide-table-2")).toBe(true);
    expect(dataset).toHaveBeenCalledWith({
      workspaceId: "workspace-a", datasetPath: "volunteers/dataset.json", expectedDatasetId: "dataset-1", action: "describe",
    });
  });

  it("names a change file that doesn't read as a change by its file name", async () => {
    await openThreadWithChangeFile(Promise.resolve("not a change"));

    const chip = await screen.findByRole("button", { name: "3f2a91c0-5b7d-4e2a-9c1f-2d8e6a4b7c90.json" });
    expect(screen.getByTestId("chats-attachment-chip")).toBe(chip);
    expect(chip.querySelector("svg")?.classList.contains("lucide-file-braces")).toBe(true);
  });

  it("opens attachment paths and shows linked agent-run details", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const opening = message();
    const agentComment = message({ presentation: { group: "fixture", hue: null, self: false },
      id: "agent-report",
      parentMessageId: opening.id,
      authorKind: "agent",
      authorDisplayName: "You",
      body: "I finished the review.",
    });
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread({ messageCount: 2 })],
    });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [opening, agentComment] });
    bridgeMock.listChatThreadAttachments.mockResolvedValue({
      attachments: [
        {
          attachmentId: "attachment-1",
          threadId: "thread-1",
          messageId: opening.id,
          targetKind: "file",
          objectId: "object-1",
          pathHint: "projects/launch/brief.md",
          createdAtMs: NOW,
        },
      ],
    });
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({
      runs: {
        [agentComment.id]: {
          runId: "run-123456789",
          threadId: "thread-1",
          triggerMessageId: opening.id,
          command: "dohc agent run review",
          startedAtMs: NOW,
          endedAtMs: NOW + 84_000,
          exitCode: 0,
          logPath: "logs/run-123456789.log",
        },
      },
    });
    renderView(vi.fn(), vi.fn(), { onOpenPath });

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    const attachment = await screen.findByTestId("chats-attachment-chip");
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledTimes(1);
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
    expect(attachment.textContent).toContain("brief.md");
    expect(attachment.getAttribute("title")).toBe("projects/launch/brief.md");
    expect(screen.getByRole("button", { name: "brief.md" })).toBe(attachment);
    await user.click(attachment);
    expect(onOpenPath).toHaveBeenCalledWith("projects/launch/brief.md");

    const runLine = screen.getByTestId("chats-run-line");
    expect(runLine.getAttribute("data-state")).toBe("done");
    // The line says how the run went. Its id and command wait in Details,
    // where an agent or a person can read and copy them.
    expect(runLine.textContent).toBe("Finished in 1m 24sDetails");
    const runChip = screen.getByRole("button", { name: "Details of run run-123456789" });
    expect(runChip).toBe(screen.getByTestId("chats-run-chip"));
    await user.click(runChip);
    expect(screen.getByTestId("chats-run-command").textContent).toBe(
      "dohc agent run review",
    );
    expect(screen.getByTestId("chats-run-id").textContent).toBe("run-123456789");
    await user.click(screen.getByTestId("chats-run-copy-id"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("run-123456789"),
    );
    expect(screen.getByTestId("chats-run-exit-code").textContent).toBe("0");
    expect(screen.getByTestId("chats-run-log-path").textContent).toBe(
      "logs/run-123456789.log",
    );
    await user.click(screen.getByTestId("chats-run-copy-log"));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("logs/run-123456789.log"),
    );
  });
});

describe("ChatsView dispatch state", () => {
  it("shows working and queued state for this thread and stops its live run", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce({
        liveRunId: "run-1", liveTriggerMessageId: null,
        pendingCount: 2,
        paused: false,
        waiting: { agentId: "nova", name: "Nova", triggerMessageIds: ["message-1"] },
      })
      .mockResolvedValue({ liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "agent working · 2 queued",
    );
    // The post asked Nova while it worked on another run.
    expect((await screen.findByTestId("chats-waiting")).textContent).toBe("Nova will reply when it's free.");
    const announcement = screen.getByTestId("chats-dispatch-announcement");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.textContent).toBe("Agent working, 2 queued");
    await user.click(screen.getByTestId("chats-stop-agent-run"));
    expect(bridgeMock.stopAgentRun).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      runId: "run-1",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("chats-dispatch-status")).toBeNull(),
    );
    expect(screen.queryByTestId("chats-waiting")).toBeNull();
    // The region stays mounted with no text, ready for the next run.
    expect(screen.getByTestId("chats-dispatch-announcement")).toBe(announcement);
    expect(announcement.textContent).toBe("");
  });

  it("hides a post's waiting line while this computer pauses agent replies, and reads it again on resume", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      liveRunId: null, liveTriggerMessageId: null,
      pendingCount: 1,
      paused: false,
      waiting: { agentId: "nova", name: "Nova", triggerMessageIds: ["message-1"] },
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-waiting");

    act(() => chatDispatchPausedCallbacks.forEach((callback) => callback({ paused: true })));
    expect(screen.queryByTestId("chats-waiting")).toBeNull();
    const reads = bridgeMock.chatDispatchStateForThread.mock.calls.length;
    await user.click(await screen.findByTestId("chats-resume-computer-dispatch"));
    // No activity follows the resume, so the thread reads its dispatch itself.
    await waitFor(() => expect(bridgeMock.chatDispatchStateForThread.mock.calls.length).toBeGreaterThan(reads));
    expect((await screen.findByTestId("chats-waiting")).textContent).toBe("Nova will reply when it's free.");
  });

  it("shows a paused status and resumes the open thread in place", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce({
        liveRunId: null, liveTriggerMessageId: null,
        pendingCount: 3,
        paused: true,
      })
      .mockResolvedValue({ liveRunId: null, liveTriggerMessageId: null, pendingCount: 3, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    const status = await screen.findByTestId("chats-dispatch-status");
    expect(status.textContent).toBe("Agent replies pausedResume");
    expect(status.hasAttribute("title")).toBe(false);
    expect(screen.getByTestId("chats-dispatch-announcement").textContent).toBe("Agent replies paused");
    await user.click(screen.getByTestId("chats-resume-dispatch"));
    expect(bridgeMock.resumeThreadDispatch).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "3 queued",
    );
    expect(screen.getByTestId("chats-dispatch-announcement").textContent).toBe("3 queued");
  });

  it("says when this computer paused dispatch, before the thread's own pause, and resumes it", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.readChatDispatchPaused.mockResolvedValue({ paused: true });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      liveRunId: null, liveTriggerMessageId: null,
      pendingCount: 2,
      paused: true,
    });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    await waitFor(() =>
      expect(screen.getByTestId("chats-dispatch-status").textContent).toBe(
        "Agent replies paused on this computerResume",
      ),
    );
    expect(screen.getByTestId("chats-dispatch-announcement").textContent).toBe(
      "Agent replies paused on this computer",
    );
    await user.click(screen.getByTestId("chats-resume-computer-dispatch"));
    expect(bridgeMock.setChatDispatchPaused).toHaveBeenCalledWith({ paused: false });
    expect(screen.getByTestId("chats-dispatch-status").textContent).toBe("Agent replies pausedResume");
  });
});

describe("ChatsView runs that didn't reply", () => {
  const STOPPED = { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };
  const QUIT = "Nova didn't reply. dohc quit during its run.";
  const failedRun = (retryable = true, words = QUIT) =>
    ({ ...STOPPED, failedRun: { runId: "run-1", triggerMessageId: "message-1", words, retryable } });
  const agentPost = (id: string, at: number) =>
    message({ id, parentMessageId: "message-1", authorKind: "agent", authorDisplayName: "Claude Code", body: "Ferry times are in day-2.md.", createdAtMs: at });
  const run = { runId: "run-1", threadId: "thread-1", triggerMessageId: "message-1", command: "claude", startedAtMs: NOW, endedAtMs: NOW + 5_000, exitCode: 143 };

  async function openThread() {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    return user;
  }

  it("says so under the request when the run posted nothing, and Try again puts it back in line", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce(failedRun())
      .mockResolvedValue({ ...STOPPED, liveRunId: "run-2", liveTriggerMessageId: null });
    renderView();
    const user = await openThread();

    const line = await screen.findByTestId("chats-run-failed");
    expect(line.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("message-1");
    expect(line.textContent).toBe(`${QUIT}Try again`);
    await user.click(screen.getByTestId("chats-run-try-again"));
    expect(bridgeMock.retryStoppedRun).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", runId: "run-1" });
    await waitFor(() => expect(screen.queryByTestId("chats-run-failed")).toBeNull());
    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe("agent working");
  });

  it("says so once, under the run's last post", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), agentPost("reply-2", NOW + 2_000), agentPost("reply-1", NOW + 1_000)],
    });
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: { "reply-1": run, "reply-2": run } });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      ...failedRun(true, "Nova stopped before finishing. dohc restarted during its run."),
    });
    renderView();
    await openThread();

    const line = await screen.findByTestId("chats-run-failed");
    expect(screen.getAllByTestId("chats-run-failed")).toHaveLength(1);
    expect(line.textContent).toContain("Nova stopped before finishing. dohc restarted during its run.Try again");
    expect(line.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("reply-2");
    // The earlier post keeps its usual run line.
    expect(screen.getByTestId("chats-run-line").closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("reply-1");
  });

  it("puts Try again under the later of two posts made at once", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({
      messages: [message(), agentPost("reply-a", NOW + 1_000), agentPost("reply-b", NOW + 1_000)],
    });
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: { "reply-a": run, "reply-b": run } });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(failedRun());
    renderView();
    await openThread();

    const tryAgain = await screen.findByTestId("chats-run-try-again");
    expect(tryAgain.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("reply-b");
  });

  it("keeps the words without Try again once the request has had its second attempt", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(failedRun(false));
    renderView();
    await openThread();

    expect((await screen.findByTestId("chats-run-failed")).textContent).toBe(QUIT);
    expect(screen.queryByTestId("chats-run-try-again")).toBeNull();
  });

  it("reports a failed Try again with a Try again that asks once more", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(failedRun());
    bridgeMock.retryStoppedRun.mockRejectedValueOnce(new Error("This workspace is not open. Open it again."));
    const { onError } = renderView();
    const user = await openThread();

    await user.click(await screen.findByTestId("chats-run-try-again"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const [words, , retry] = onError.mock.calls[0]!;
    expect(words).toContain("dohc could not start your agent's run in \"Should we ship on Friday?\" again.");
    expect(screen.getByTestId("chats-run-try-again").getAttribute("aria-disabled")).toBeNull();
    (retry as () => void)();
    await waitFor(() => expect(bridgeMock.retryStoppedRun).toHaveBeenCalledTimes(2));
    expect(bridgeMock.retryStoppedRun).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", runId: "run-1" });
  });

  it("reports a failed Try again that the conversation refreshed under", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(failedRun());
    let fail!: (error: Error) => void;
    bridgeMock.retryStoppedRun.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const { onError } = renderView();
    const user = await openThread();

    await user.click(await screen.findByTestId("chats-run-try-again"));
    const reads = bridgeMock.listChatMessages.mock.calls.length;
    act(() => emitWorkspaceActivity());
    await waitFor(() => expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => fail(new Error("This workspace is not open. Open it again.")));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0]).toContain("dohc could not start your agent's run in \"Should we ship on Friday?\" again.");
  });
});

describe("ChatsView post on screen", () => {
  beforeEach(() => {
    tellWindowFocused(true);
  });
  afterEach(() => {
    tellWindowFocused(false);
  });

  it("counts an open post as on screen, so a notice about its run is skipped", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("chats-channel"));
    expect(chatOnScreen("thread-1")).toBe(false);
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-thread-view");
    expect(chatOnScreen("thread-1")).toBe(true);

    await user.click(screen.getByTestId("chats-thread-back"));
    await screen.findByTestId("chats-channel-view");
    expect(chatOnScreen("thread-1")).toBe(false);
  });
});
