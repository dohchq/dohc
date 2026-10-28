import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reconcileResolvedChatDecision } from "./ChatsView";
import {
  NOW,
  thread,
  message,
  bridgeMock,
  mentionRoster,
  renderView,
} from "./ChatsView.testHarness";

describe("ChatsView decisions", () => {
  it("resolves from composer mode and uses the literal fallback for an empty reply", async () => {
    const user = userEvent.setup();
    const opening = message();
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
    expect(screen.getByTestId("chats-resolving-mode").textContent).toContain(
      "Answering the poll",
    );
    expect(screen.getByTestId("chats-replying-mode").textContent).toContain(
      "Replying to You",
    );
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
    expect(runLine.textContent).toBe("Ran dohc · 1m 24srun run-123");
    const runChip = screen.getByTestId("chats-run-chip");
    expect(runChip.textContent).toBe("run run-123");
    await user.click(runChip);
    expect(screen.getByTestId("chats-run-command").textContent).toBe(
      "dohc agent run review",
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
        liveRunId: "run-1",
        pendingCount: 2,
        paused: false,
      })
      .mockResolvedValue({ liveRunId: null, pendingCount: 0, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "agent working · 2 queued",
    );
    await user.click(screen.getByTestId("chats-stop-agent-run"));
    expect(bridgeMock.stopAgentRun).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      runId: "run-1",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("chats-dispatch-status")).toBeNull(),
    );
  });

  it("shows a paused status and resumes the open thread in place", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.chatDispatchStateForThread
      .mockResolvedValueOnce({
        liveRunId: null,
        pendingCount: 3,
        paused: true,
      })
      .mockResolvedValue({ liveRunId: null, pendingCount: 3, paused: false });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    const status = await screen.findByTestId("chats-dispatch-status");
    expect(status.textContent).toBe("Agent replies pausedResume");
    expect(status.hasAttribute("title")).toBe(false);
    await user.click(screen.getByTestId("chats-resume-dispatch"));
    expect(bridgeMock.resumeThreadDispatch).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });
    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "3 queued",
    );
  });

  it("says when this computer paused dispatch, before the thread's own pause, and resumes it", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.readChatDispatchPaused.mockResolvedValue({ paused: true });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      liveRunId: null,
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
    await user.click(screen.getByTestId("chats-resume-computer-dispatch"));
    expect(bridgeMock.setChatDispatchPaused).toHaveBeenCalledWith({ paused: false });
    expect(screen.getByTestId("chats-dispatch-status").textContent).toBe("Agent replies pausedResume");
  });
});
