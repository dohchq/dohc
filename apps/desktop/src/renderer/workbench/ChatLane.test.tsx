// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridgeMock, channel, message, thread } from "./ChatsView.testHarness";
import { ChatLane } from "./ChatLane";
import { ipcErrorMessage } from "../ipcError";
import { ReactionStoreProvider } from "./reactionStore";
import type { ChatDispatchFailedRun, SendChatMessagePayload, WorkspaceActivityEvent } from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { COLLECTION_CHANGE_FILE } from "../collections/collectionChangeFlow";
import { ask, asked, id, proposalPath, world } from "../collections/collectionChangeFlow.testHarness";

let activity: (event: WorkspaceActivityEvent) => void;
const onError = vi.fn();
const onThreadRead = vi.fn();
const onAgentWaitsForTrust = vi.fn();
const onOpenAgentSettings = vi.fn();
function lane(id = "channel-1", workspaceId = "workspace-a", kind: "channel" | "agent" = "channel", agentId?: string, mentionCandidates: MentionCandidate[] = [], dispatchPaused = false) {
  return <ReactionStoreProvider workspaceId={workspaceId}>
    <ChatLane workspaceId={workspaceId} channel={channel({ id, type: "chat", kind, ...(agentId ? { agentId } : {}) })}
      locked={false} mentionCandidates={mentionCandidates} onError={onError} onThreadRead={onThreadRead} revision={0} dispatchPaused={dispatchPaused}
      onAgentWaitsForTrust={onAgentWaitsForTrust} onOpenAgentSettings={onOpenAgentSettings} />
  </ReactionStoreProvider>;
}
function send(body: string) {
  const composer = screen.getByTestId("chats-lane-composer");
  fireEvent.change(composer, { target: { value: body } });
  fireEvent.keyDown(composer, { key: "Enter" });
}
beforeEach(() => {
  onError.mockReset();
  onThreadRead.mockReset();
  onAgentWaitsForTrust.mockReset();
  onOpenAgentSettings.mockReset();
  bridgeMock.onWorkspaceActivity.mockImplementation(callback => { activity = callback; return vi.fn(); });
  // An agent DM also lists its earlier posts; these tests have none.
  bridgeMock.listChannelThreads.mockImplementation(async ({ lane }) => ({ threads: lane === "posts" ? [] : [thread()] }));
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Old message" })] });
  bridgeMock.markChatThreadRead.mockResolvedValue(undefined);
});

describe("ChatLane", () => {

  it("does not cache a newer revision over an older content snapshot", async () => {
    const snapshot = deferred<{ messages: ReturnType<typeof message>[] }>();
    bridgeMock.listChatMessages.mockReturnValueOnce(snapshot.promise);
    render(lane());
    await waitFor(() => expect(bridgeMock.listChatMessages).toHaveBeenCalledOnce());
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    await act(async () => snapshot.resolve({ messages: [message({ body: "Old message" })] }));
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "New revision" })] });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(await screen.findByText("New revision")).toBeTruthy();
  });

  it("retries a failed content read without treating its revision as painted", async () => {
    render(lane());
    await screen.findByText("Old message");
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    bridgeMock.listChatMessages.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(onError).toHaveBeenCalledOnce();
    expect(screen.getByText("Old message")).toBeTruthy();
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "After retry" })] });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(await screen.findByText("After retry")).toBeTruthy();
  });

  it("ignores a send from the previous channel without unlocking the current send", async () => {
    const view = render(lane());
    await screen.findByText("Old message");
    const oldSend = deferred<{ message: ReturnType<typeof message> }>();
    const newSend = deferred<{ message: ReturnType<typeof message> }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(oldSend.promise).mockReturnValueOnce(newSend.promise);
    send("Old send");
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ id: "thread-2", channelId: "channel-2" })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ id: "m2", threadId: "thread-2", body: "Second channel" })] });
    view.rerender(lane("channel-2"));
    await screen.findByText("Second channel");
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false);
    send("New send");
    await act(async () => oldSend.resolve({ message: message({ id: "old-send", body: "Old send" }) }));
    expect(screen.queryByText("Old send")).toBeNull();
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(true);
    expect(bridgeMock.sendChatMessage).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", threadId: "thread-2", body: "New send" });
    await act(async () => newSend.resolve({ message: message({ id: "new-send", threadId: "thread-2", body: "New send" }) }));
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("does not let an older activity snapshot erase a completed send", async () => {
    render(lane());
    await screen.findByText("Old message");
    const snapshot = deferred<{ messages: ReturnType<typeof message>[] }>();
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    bridgeMock.listChatMessages.mockReturnValueOnce(snapshot.promise);
    await act(async () => activity({ workspaceId: "workspace-a" }));
    bridgeMock.sendChatMessage.mockImplementationOnce(async () => {
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [
        message({ body: "Old message" }), message({ id: "remote", body: "Remote reply" }), message({ id: "reply", body: "Reply" }),
      ] });
      return { message: message({ id: "reply", body: "Reply" }) };
    });
    send("Reply");
    await screen.findByText("Reply");
    await act(async () => snapshot.resolve({ messages: [message({ body: "Old message" }), message({ id: "remote", body: "Remote reply" })] }));
    expect(screen.getByText("Reply")).toBeTruthy();
    expect(screen.getByText("Remote reply")).toBeTruthy();
  });

  it("gives a message that saved a Try again that reloads its conversation, only while the lane shows it", async () => {
    const view = render(lane());
    await screen.findByText("Old message");
    bridgeMock.sendChatMessage.mockResolvedValueOnce({ message: { id: "reply", threadId: "thread-1" }, failure: "Error: The bookmark projection stopped." });
    const before = bridgeMock.listChatMessages.mock.calls.length;
    send("Reply");
    // The send's own reload has read the conversation before the message shows.
    await waitFor(() => expect(bridgeMock.listChatMessages.mock.calls.length).toBeGreaterThan(before));
    expect(onError).toHaveBeenCalledOnce();
    const again = onError.mock.lastCall?.[2] as () => void;
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Old message" }), message({ id: "reply", body: "Reply" })] });
    await act(async () => again());
    await screen.findByText("Reply");

    // Once the lane shows another workspace, Try again reads nothing.
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Other workspace" })] });
    view.rerender(lane("channel-1", "workspace-b"));
    await screen.findByText("Other workspace");
    const reads = bridgeMock.listChatMessages.mock.calls.length;
    await act(async () => again());
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(reads);
    expect(bridgeMock.listChannelThreads).not.toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "workspace-a" }));
  });

  it.each(["message", "post"] as const)("says a %s that saved nothing failed to send and keeps the draft", async (kind) => {
    if (kind === "post") bridgeMock.listChannelThreads.mockResolvedValueOnce({ threads: [] });
    render(lane());
    await screen.findByText(kind === "post" ? "No messages in #general yet." : "Old message");
    const refusal = new Error("Chats stopped because this window changed workspaces.");
    (kind === "post" ? bridgeMock.startChannelThread : bridgeMock.sendChatMessage).mockRejectedValueOnce(refusal);
    send("Reply");
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(ipcErrorMessage(refusal, "Could not send that message."), refusal));
    expect(onError.mock.lastCall?.[0]).not.toMatch(/^Sent/);
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).value).toBe("Reply");
  });

  it("does not report an old read after switching workspaces", async () => {
    const read = deferred<void>();
    bridgeMock.markChatThreadRead.mockReturnValueOnce(read.promise);
    const view = render(lane());
    await screen.findByText("Old message");
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    view.rerender(lane("channel-2", "workspace-b"));
    await act(async () => read.resolve());
    expect(onThreadRead).not.toHaveBeenCalled();
  });

  it("marks the first unread message with a New divider when the lane opens", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ messageCount: 3, lastReadSequence: 1, unreadCount: 2 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "m1", body: "Seen" }), message({ id: "m2", body: "First unread" }), message({ id: "m3", body: "Second unread" }),
    ] });
    render(lane());
    const divider = await screen.findByTestId("chats-lane-new-divider");
    expect(divider.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("m2");
    // The read cursor moves after the paint; the divider stays for this visit.
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ messageCount: 3, lastReadSequence: 3, unreadCount: 0 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "m1", body: "Seen" }), message({ id: "m2", body: "First unread after refresh" }), message({ id: "m3", body: "Second unread" }),
    ] });
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    await screen.findByText("First unread after refresh");
    expect(screen.getByTestId("chats-lane-new-divider")).toBeTruthy();
  });

  it("orders equal-time messages by ID, so the New divider sits above every unread one", async () => {
    // Arrival is a, z, b at one time. The account read a; the engine's first
    // unread by (time, ID) is b, two messages in arrival order.
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ messageCount: 3, lastReadSequence: 2, unreadCount: 2 })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "a", body: "Read" }), message({ id: "z", body: "Unread z" }), message({ id: "b", body: "Unread b" }),
    ] });
    render(lane());
    const divider = await screen.findByTestId("chats-lane-new-divider");
    expect(divider.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("b");
    const shown = [...new Set([...document.querySelectorAll("[data-message-id]")].map(row => row.getAttribute("data-message-id")))];
    expect(shown).toEqual(["a", "b", "z"]);
  });

  it("counts arrivals while reading history and returns to the end on click", async () => {
    render(lane());
    await screen.findByText("Old message");
    const list = screen.getByRole("list");
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 500 });
    list.scrollTop = 200;
    fireEvent.scroll(list);
    expect(screen.queryByTestId("chats-lane-new-messages")).toBeNull();
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ body: "Old message" }), message({ id: "m2", body: "Arrived" }), message({ id: "m3", body: "Arrived too" }),
    ] });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    await screen.findByText("Arrived too");
    const pill = screen.getByTestId("chats-lane-new-messages");
    expect(pill.textContent).toBe("2new messages");
    const scrollIntoView = vi.fn();
    list.lastElementChild!.scrollIntoView = scrollIntoView;
    fireEvent.click(pill);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    list.scrollTop = 1500;
    fireEvent.scroll(list);
    expect(screen.queryByTestId("chats-lane-new-messages")).toBeNull();
  });

  it("marks the poll answered from Try again on a choice that posted while it stayed open, and never sends again", async () => {
    const words = "Sent your choice. dohc could not mark the question answered.";
    const decision = { threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    const resolved = { ...decision, state: "resolved", chosenOption: "Monday", resolvedByMessageId: "answer" };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", body: "Monday" }),
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    const refusal = new Error("Your server session changed. Try again.");
    bridgeMock.resolveChatDecision.mockRejectedValueOnce(refusal).mockImplementationOnce(async () => {
      // The engine holds the answer now, so the reload after it reads it too.
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
      return { resolved };
    });
    const notices = () => onError.mock.calls.filter(([said]) => said === words);
    render(lane());
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]?.[1]).toBe("Error: Your server session changed. Try again.");
    expect(notices()[0]?.[2], "Try again on the choice's toast").toEqual(expect.any(Function));
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();

    // A try that fails says so again, with Try again again.
    await act(async () => { notices()[0]?.[2]?.(); });
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[1]?.[1]).toBe(refusal);
    expect(notices()[1]?.[2], "Try again after a failed try").toEqual(expect.any(Function));
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();

    await act(async () => { notices()[1]?.[2]?.(); });
    await screen.findByTestId("chats-lane-decision-resolved");
    const answer = { workspaceId: "workspace-a", threadId: "thread-1", messageId: "message-1", resolvedByMessageId: "answer", chosenOption: "Monday" };
    expect(bridgeMock.resolveChatDecision.mock.calls).toEqual([[answer], [answer]]);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce();
    expect(notices()).toHaveLength(2);
  });

  function openPoll() {
    fireEvent.click(screen.getByTestId("chats-lane-add"));
    fireEvent.click(screen.getByTestId("chats-lane-poll-toggle"));
  }
  function draftPoll(question: string, choices: string[]) {
    const composer = screen.getByTestId("chats-lane-composer");
    fireEvent.change(composer, { target: { value: question } });
    openPoll();
    choices.forEach((choice, index) => {
      if (index >= 2) fireEvent.click(screen.getByTestId("chats-lane-poll-add"));
      fireEvent.change(screen.getAllByTestId("chats-lane-poll-choice")[index]!, { target: { value: choice } });
    });
    return composer as HTMLTextAreaElement;
  }
  const choiceValues = () => screen.getAllByTestId("chats-lane-poll-choice").map((input) => (input as HTMLInputElement).value);

  it.each(["sent", "failed"] as const)("asks a poll with its trimmed choices and keeps them until it has %s", async (outcome) => {
    render(lane());
    await screen.findByText("Old message");
    const composer = draftPoll("Lunch?", [" Soup ", "", "Salad"]);
    if (outcome === "sent") bridgeMock.sendChatMessage.mockResolvedValueOnce({ message: message({ id: "poll", body: "Lunch?" }) });
    else bridgeMock.sendChatMessage.mockRejectedValueOnce(new Error("Engine busy"));
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Lunch?", needsDecision: true, options: ["Soup", "Salad"],
    });
    if (outcome === "sent") {
      await waitFor(() => expect(screen.queryByTestId("chats-lane-poll")).toBeNull());
      expect(composer.value).toBe("");
    } else {
      await waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(composer.value).toBe("Lunch?");
      expect(choiceValues()).toEqual([" Soup ", "", "Salad"]);
    }
  });

  it("does not send a poll the engine would refuse", async () => {
    render(lane());
    await screen.findByText("Old message");
    const composer = draftPoll("Lunch?", ["Soup", "Soup "]);
    expect((screen.getByTestId("chats-lane-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(bridgeMock.sendChatMessage).not.toHaveBeenCalled();
  });

  const working = { liveRunId: "run-1", liveTriggerMessageId: null, pendingCount: 0, paused: false };
  const idle = { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };

  it("says why a run didn't reply under the message that asked, with Try again only when it can run again", async () => {
    const failedRun = { runId: "run-1", triggerMessageId: "message-1", words: "Nova didn't reply. dohc quit during its run.", retryable: true };
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...idle, failedRun });
    render(lane("agent-dm", "workspace-a", "agent", "nova"));
    const line = await screen.findByTestId("chats-lane-run-failed");
    expect(line.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("message-1");
    expect(line.textContent).toBe(`${failedRun.words}Try again`);
    expect(screen.queryByTestId("chats-lane-run-next-step")).toBeNull();

    bridgeMock.retryStoppedRun.mockImplementationOnce(async () => {
      bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...idle, pendingCount: 1 });
      return { queued: true };
    });
    fireEvent.click(screen.getByTestId("chats-lane-run-try-again"));
    expect(bridgeMock.retryStoppedRun).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", runId: "run-1" });
    await waitFor(() => expect(screen.queryByTestId("chats-lane-run-failed")).toBeNull());

    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      ...idle,
      failedRun: {
        ...failedRun,
        words: "Nova didn't reply. Its run ended with an error.",
        nextStep: { kind: "message", agentId: "nova", name: "Nova", handle: "Nova" },
        retryable: false,
      },
    });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    const failed = await screen.findByTestId("chats-lane-run-failed");
    // In Nova's own chat a message asks it: the button focuses the composer
    // and adds nothing to the draft.
    expect(within(failed).getAllByRole("status").map((node) => node.textContent))
      .toEqual(["Nova didn't reply. Its run ended with an error."]);
    expect(screen.queryByTestId("chats-lane-run-try-again")).toBeNull();
    expect(screen.queryByTestId("chats-lane-run-next-step")).toBeNull();
    const composer = screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement;
    await waitFor(() => expect(composer.disabled).toBe(false));
    const sends = bridgeMock.sendChatMessage.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Message Nova" }));
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("");
    expect(bridgeMock.sendChatMessage.mock.calls.length).toBe(sends);

    // Another agent's run with no @handle: its own chat, in words, since no
    // button can ready that message here.
    const failedWith = async (nextStep: NonNullable<ChatDispatchFailedRun["nextStep"]>) => {
      bridgeMock.chatDispatchStateForThread.mockResolvedValue({
        ...idle,
        failedRun: { ...failedRun, words: "Nova didn't reply. Its run ended with an error.", nextStep, retryable: false },
      });
      await act(async () => activity({ workspaceId: "workspace-a" }));
    };
    await failedWith({ kind: "message", agentId: "fox", name: "\u{1F98A}" });
    await waitFor(() => expect(screen.getByTestId("chats-lane-run-next-step").textContent)
      .toBe("Message \u{1F98A} in its own chat to ask again."));
    expect(screen.queryByTestId("chats-lane-run-actions")).toBeNull();
    // An agent a message won't wake: the step in Settings is a button that
    // opens the Agents page, on the same line a message button takes.
    for (const [nextStep, label] of [
      [{ kind: "add-agent" }, "Add an agent in Settings"],
      [{ kind: "turn-on", name: "Nova" }, "Turn Nova on in Settings"],
    ] as const) {
      await failedWith(nextStep);
      await waitFor(() => expect(screen.getByTestId("chats-lane-run-open-settings").textContent).toBe(label));
      expect(screen.queryByTestId("chats-lane-run-next-step")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Turn Nova on in Settings" }));
    expect(onOpenAgentSettings).toHaveBeenCalledTimes(1);
  });

  it("stops the agent's run from its DM", async () => {
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(working);
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Old message");
    expect(bridgeMock.chatDispatchStateForThread).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1" });
    bridgeMock.stopAgentRun.mockImplementationOnce(async () => {
      bridgeMock.chatDispatchStateForThread.mockResolvedValue(idle);
    });
    expect(screen.getByTestId("chats-lane-dispatch-announcement").textContent).toBe("Agent working");
    fireEvent.click(screen.getByRole("button", { name: "Stop agent run" }));
    await waitFor(() => expect(screen.queryByTestId("chats-lane-working")).toBeNull());
    expect(screen.getByTestId("chats-lane-dispatch-announcement").textContent).toBe("");
    expect(bridgeMock.stopAgentRun).toHaveBeenCalledWith({ workspaceId: "workspace-a", runId: "run-1" });
  });

  it("hides the waiting line while this computer pauses agent replies, and reads it again on resume", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Plan day 1" }),
      message({ id: "later", body: "Add the ferry times" }),
    ] });
    const queued = { ...working, liveTriggerMessageId: "ask", pendingCount: 1 };
    const waiting = { ...queued, waiting: { agentId: "nova", name: "Nova", triggerMessageIds: ["later"] } };
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(waiting);
    const view = render(lane("agent-dm", "workspace-a", "agent", "nova"));
    await screen.findByTestId("chats-lane-waiting");

    view.rerender(lane("agent-dm", "workspace-a", "agent", "nova", [], true));
    expect(screen.queryByTestId("chats-lane-waiting")).toBeNull();
    // While paused, main names no request waiting on Nova, and another joins the queue.
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...queued, pendingCount: 2 });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    await waitFor(() => expect(screen.getByTestId("chats-lane-dispatch-announcement").textContent).toBe("Agent working, 2 queued"));

    // No activity follows the resume, so the lane reads its dispatch itself.
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...waiting, pendingCount: 2 });
    view.rerender(lane("agent-dm", "workspace-a", "agent", "nova", [], false));
    expect((await screen.findByTestId("chats-lane-waiting")).textContent).toBe("Nova will reply when it's free.");
  });

  it("finishes a stop after the reader left the workspace without painting the new one", async () => {
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(working);
    const stop = deferred<void>();
    bridgeMock.stopAgentRun.mockReturnValueOnce(stop.promise);
    const view = render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop agent run" }));
    // Workspace B has its own run, and its Stop is pressed and still going.
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...working, liveRunId: "run-b", liveTriggerMessageId: null });
    bridgeMock.stopAgentRun.mockReturnValueOnce(new Promise(() => undefined));
    view.rerender(lane("agent-dm", "workspace-b", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop agent run" }));
    const reads = bridgeMock.chatDispatchStateForThread.mock.calls.length;
    await act(async () => stop.resolve());
    expect(bridgeMock.chatDispatchStateForThread).toHaveBeenCalledTimes(reads);
    expect((screen.getByRole("button", { name: "Stop agent run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a run's exit code once it ends, with no new message", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Plan the trip" }),
      message({ id: "reply", body: "Here is a plan", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    const run = { runId: "run-1", threadId: "thread-1", triggerMessageId: "ask", command: "nova reply", startedAtMs: 1_000 };
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: { reply: run } });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(working);
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Here is a plan");
    fireEvent.click(screen.getByTestId("chats-lane-more"));
    fireEvent.click(await screen.findByTestId("chats-lane-more-run-details"));
    expect((await screen.findByTestId("chats-run-exit-code")).textContent).toBe("—");
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: { reply: { ...run, exitCode: 0 } } });
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(idle);
    await act(async () => activity({ workspaceId: "workspace-a" }));
    await waitFor(() => expect(screen.getByTestId("chats-run-exit-code").textContent).toBe("0"));
  });

  it("attaches the change a review applied to its reply, and the asking message shows that change applied", async () => {
    const place = world();
    ask(place);
    // Ada adds a field after the message, so the review applies another change than the one asked.
    const phone = structuredClone(asked);
    phone.tables[0]!.fields.push({ fieldId: id(10), name: "Phone", sqlColumn: "phone", type: "text", required: false, unique: false });
    place.files["volunteers/dataset.json"] = JSON.stringify(phone, null, 2);
    place.moments.push(place.moment(5, "volunteers/dataset.json", 3_500, { personAuthorName: "Ada" }, JSON.stringify(phone)));
    vi.stubGlobal("dohcDesktop", { ...window.dohcDesktop, ...place.api });
    const attachment = (messageId: string, pathHint: string, createdAtMs: number) =>
      ({ attachmentId: `attachment-${messageId}`, threadId: "thread-1", messageId, targetKind: "file" as const, pathHint, createdAtMs });
    const asks = message({ id: "asks", body: "Here's the due date.", authorKind: "agent", authorDisplayName: "Claude Code", createdAtMs: 3_000, attachments: [attachment("asks", proposalPath, 3_000)] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [asks] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "asks", state: "open", atMs: 1 }] });
    bridgeMock.sendChatMessage.mockImplementation(async (input: SendChatMessagePayload) => {
      const reply = message({ id: "applied", body: input.body, createdAtMs: 4_000, attachments: (input.fileReferences ?? []).map(reference => attachment("applied", reference.path, 4_000)) });
      const resolved = { threadId: "thread-1", messageId: "asks", state: "resolved" as const, resolvedByMessageId: "applied", atMs: 4_000 };
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [asks, reply] });
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
      return { message: reply, resolved };
    });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-change-review-button"));
    const dialog = await screen.findByTestId("chats-lane-change-review-dialog");
    const apply = within(dialog).getByTestId("chats-lane-change-review-apply");
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce());
    const sent = bridgeMock.sendChatMessage.mock.calls[0]![0];
    expect(sent.resolves).toEqual({ messageId: "asks" });
    const recorded = sent.fileReferences?.[0]?.path ?? "";
    expect(recorded).toMatch(COLLECTION_CHANGE_FILE);
    expect(recorded).not.toBe(proposalPath);
    expect(JSON.parse(place.files[recorded]!).revisionSha256).toBe(place.head().revisionSha256);
    expect(await screen.findByText("Applied")).toBeTruthy();
    // Ada's part of the applied change names her.
    expect(within(screen.getByText("Added the field Phone").closest("li")!).getByText(/^Ada · /u)).toBeTruthy();
    expect(screen.queryByTestId("chats-lane-change-edited")).toBeNull();
    expect(screen.queryByText("Undone")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("marks the question answered from Try again on a reply that posted while it stayed open, and never sends again", async () => {
    const words = "Sent your reply. dohc could not mark the question answered.";
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "question", body: "What should I call the file?", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    const decision = { threadId: "thread-1", messageId: "question", state: "open", atMs: 1 };
    const resolved = { ...decision, state: "resolved", resolvedByMessageId: "answer" };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", body: "notes.md", parentMessageId: "question" }),
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    const refusal = new Error("Your server session changed. Try again.");
    bridgeMock.resolveChatDecision.mockRejectedValueOnce(refusal).mockImplementationOnce(async () => {
      // The engine holds the answer now, so the reload after it reads it too.
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
      return { resolved };
    });
    const notices = () => onError.mock.calls.filter(([said]) => said === words);
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    const reply = await screen.findByTestId("chats-lane-thread-composer");
    fireEvent.change(reply, { target: { value: "notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0]?.[1]).toBe("Error: Your server session changed. Try again.");
    expect(notices()[0]?.[2], "Try again on the reply's toast").toEqual(expect.any(Function));
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();

    // A try that fails says so again, with Try again again.
    await act(async () => { notices()[0]?.[2]?.(); });
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[1]?.[1]).toBe(refusal);
    expect(notices()[1]?.[2], "Try again after a failed try").toEqual(expect.any(Function));
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();

    await act(async () => { notices()[1]?.[2]?.(); });
    await waitFor(() => expect(screen.getAllByTestId("chats-lane-decision-resolved")[0]!.textContent).toBe("Answered"));
    const answer = { workspaceId: "workspace-a", threadId: "thread-1", messageId: "question", resolvedByMessageId: "answer" };
    expect(bridgeMock.resolveChatDecision.mock.calls).toEqual([[answer], [answer]]);
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce();
    expect(notices()).toHaveLength(2);
  });

  it("puts the cursor in the reply box once a reply still sending ends, when Answer is pressed meanwhile", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Write the summary" }),
      message({ id: "question", body: "Which file?", parentMessageId: "ask", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "question", state: "open", atMs: 1 }] });
    const sent = deferred<{ message: ReturnType<typeof message> }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(sent.promise);
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-thread-summary"));
    const reply = await screen.findByTestId("chats-lane-thread-composer") as HTMLTextAreaElement;
    fireEvent.change(reply, { target: { value: "One moment" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(reply.disabled).toBe(true));
    // Pressing Answer moves focus to it, as a click does in a browser.
    const answer = screen.getByRole("button", { name: "Answer" });
    answer.focus();
    fireEvent.click(answer);
    expect(document.activeElement).not.toBe(reply);
    sent.resolve({ message: message({ id: "plain", body: "One moment", parentMessageId: "ask" }) });
    await waitFor(() => expect(document.activeElement).toBe(reply));
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "answer", body: "notes.md", parentMessageId: "ask" }) });
    fireEvent.change(reply, { target: { value: "notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "notes.md", parentMessageId: "ask",
      resolves: { messageId: "question" },
    }));
  });

  it("answers an open question asked in a thread from that thread", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Write the summary" }),
      message({ id: "question", body: "Which file?", parentMessageId: "ask", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "question", state: "open", atMs: 1 }] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "answer", body: "notes.md", parentMessageId: "ask" }) });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-thread-summary"));
    const reply = await screen.findByTestId("chats-lane-thread-composer");
    reply.blur();
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    await waitFor(() => expect(document.activeElement).toBe(reply));
    fireEvent.change(reply, { target: { value: "notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "notes.md", parentMessageId: "ask",
      resolves: { messageId: "question" },
    }));
    // Answer covers one reply. The next is a plain reply.
    await waitFor(() => expect((reply as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(reply, { target: { value: "Thanks" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenLastCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Thanks", parentMessageId: "ask",
    }));
  });

});
