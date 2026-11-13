import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NOW, thread, message, bridgeMock, renderView } from "./ChatsView.testHarness";

describe("ChatsView decisions", () => {
  it("cancels the answer and its reply together, so the next comment is neither", async () => {
    const user = userEvent.setup();
    const opening = message({ authorDisplayName: "Nova" });
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
      message: message({ id: "comment-2", body: "Plain comment" }),
    });
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

  it("marks the question answered from Try again on a reply that posted while it stayed open, and never sends again", async () => {
    const user = userEvent.setup();
    const words = "Sent your reply. dohc could not mark the question answered.";
    const opening = message();
    const openDecision = {
      threadId: "thread-1",
      messageId: opening.id,
      state: "open" as const,
      atMs: NOW,
    };
    const resolved = {
      ...openDecision,
      state: "resolved" as const,
      resolvedByMessageId: "resolution-message",
      atMs: NOW + 1,
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
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    const refusal = new Error("Your server session changed. Try again.");
    bridgeMock.resolveChatDecision
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({ resolved });
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
    await act(async () => {
      notices()[0]?.[2]?.();
    });
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[1]?.[1]).toBe(refusal);
    expect(notices()[1]?.[2], "Try again after a failed try").toEqual(expect.any(Function));
    expect(screen.getByTestId("chats-message-decision-open")).toBeTruthy();

    // The engine holds the answer once a try succeeds, so the reload after it reads it too.
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
    await act(async () => {
      notices()[1]?.[2]?.();
    });
    expect(await screen.findByTestId("chats-message-decision-resolved")).toBeTruthy();
    expect(bridgeMock.resolveChatDecision.mock.calls).toEqual([
      [
        {
          workspaceId: "workspace-a",
          threadId: "thread-1",
          messageId: opening.id,
          resolvedByMessageId: "resolution-message",
        },
      ],
      [
        {
          workspaceId: "workspace-a",
          threadId: "thread-1",
          messageId: opening.id,
          resolvedByMessageId: "resolution-message",
        },
      ],
    ]);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(2);
  });

  it("answers a poll by picking a choice, and the choice travels with the answer", async () => {
    const user = userEvent.setup();
    const opening = message({
      presentation: { group: "fixture", hue: null, self: false },
      authorKind: "agent",
      authorDisplayName: "You",
      body: "Ship on which day?",
    });
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

  it("opens attachment paths and shows linked agent-run details", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const opening = message();
    const agentComment = message({
      presentation: { group: "fixture", hue: null, self: false },
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
    expect(screen.getByTestId("chats-run-command").textContent).toBe("dohc agent run review");
    expect(screen.getByTestId("chats-run-id").textContent).toBe("run-123456789");
    await user.click(screen.getByTestId("chats-run-copy-id"));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("run-123456789"));
    expect(screen.getByTestId("chats-run-exit-code").textContent).toBe("0");
    expect(screen.getByTestId("chats-run-log-path").textContent).toBe("logs/run-123456789.log");
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
        liveTriggerMessageId: null,
        pendingCount: 2,
        paused: false,
        waiting: { agentId: "nova", name: "Nova", triggerMessageIds: ["message-1"] },
      })
      .mockResolvedValue({
        liveRunId: null,
        liveTriggerMessageId: null,
        pendingCount: 0,
        paused: false,
      });
    renderView();

    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));

    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe(
      "agent working · 2 queued",
    );
    // The post asked Nova while it worked on another run.
    expect((await screen.findByTestId("chats-waiting")).textContent).toBe(
      "Nova will reply when it's free.",
    );
    const announcement = screen.getByTestId("chats-dispatch-announcement");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.textContent).toBe("Agent working, 2 queued");
    await user.click(screen.getByTestId("chats-stop-agent-run"));
    expect(bridgeMock.stopAgentRun).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      runId: "run-1",
    });
    await waitFor(() => expect(screen.queryByTestId("chats-dispatch-status")).toBeNull());
    expect(screen.queryByTestId("chats-waiting")).toBeNull();
    // The region stays mounted with no text, ready for the next run.
    expect(screen.getByTestId("chats-dispatch-announcement")).toBe(announcement);
    expect(announcement.textContent).toBe("");
  });
});

describe("ChatsView runs that didn't reply", () => {
  const STOPPED = { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };
  const QUIT = "Nova didn't reply. dohc quit during its run.";
  const failedRun = (retryable = true, words = QUIT) => ({
    ...STOPPED,
    failedRun: { runId: "run-1", triggerMessageId: "message-1", words, retryable },
  });

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
    expect(bridgeMock.retryStoppedRun).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      threadId: "thread-1",
      runId: "run-1",
    });
    await waitFor(() => expect(screen.queryByTestId("chats-run-failed")).toBeNull());
    expect((await screen.findByTestId("chats-dispatch-status")).textContent).toBe("agent working");
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
});
