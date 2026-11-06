// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridgeMock, channel, message, thread } from "./ChatsView.testHarness";
import { ChatLane } from "./ChatLane";
import { ReactionStoreProvider } from "./reactionStore";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import type { SendChatMessagePayload, WorkspaceActivityEvent } from "../../ipc/bridgeContract";
import { configureDemoDesktopBridge } from "../../../../site/src/demoDesktopBridge";
import { COLLECTION_CHANGE_FILE } from "../collections/collectionChangeFlow";
import { ask, asked, id, proposalPath, world } from "../collections/collectionChangeFlow.testHarness";

vi.mock("./chatFileMentions", { spy: true });

let activity: (event: WorkspaceActivityEvent) => void;
const onError = vi.fn();
const onThreadRead = vi.fn();
const onAgentWaitsForTrust = vi.fn();
function lane(id = "channel-1", workspaceId = "workspace-a", kind: "channel" | "agent" = "channel") {
  return <ReactionStoreProvider workspaceId={workspaceId}>
    <ChatLane workspaceId={workspaceId} channel={channel({ id, type: "chat", kind })}
      locked={false} mentionCandidates={[]} onError={onError} onThreadRead={onThreadRead} revision={0}
      onAgentWaitsForTrust={onAgentWaitsForTrust} />
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
  bridgeMock.onWorkspaceActivity.mockImplementation(callback => { activity = callback; return vi.fn(); });
  // An agent DM also lists its earlier posts; these tests have none.
  bridgeMock.listChannelThreads.mockImplementation(async ({ lane }) => ({ threads: lane === "posts" ? [] : [thread()] }));
  bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Old message" })] });
  bridgeMock.markChatThreadRead.mockResolvedValue(undefined);
});

describe("ChatLane", () => {
  it("loads the site demo conversation through its real bridge", async () => {
    configureDemoDesktopBridge({
      documents: [], folders: [], createFile: vi.fn(), createFolder: vi.fn(),
      movePath: vi.fn(), deletePath: vi.fn(),
    });
    render(lane("channel-general", "marketing-demo"));
    await screen.findByText("What needs attention next?");
    expect(screen.getByText("Start with the launch plan. Once it is approved, save the checklist as a skill.")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    await waitFor(() => expect(onThreadRead).toHaveBeenCalledOnce());
  });

  it("does not render message bodies while typing a draft", async () => {
    render(lane());
    await screen.findByText("Old message");
    const scans = vi.mocked(extractChatFileReferenceTokens).mock.calls.length;
    fireEvent.change(screen.getByTestId("chats-lane-composer"), { target: { value: "A draft" } });
    expect(vi.mocked(extractChatFileReferenceTokens).mock.calls.length).toBe(scans);
  });

  it("does not load conversation content or mark it read on an unchanged revision", async () => {
    render(lane());
    await screen.findByText("Old message");
    const reads = bridgeMock.listChatMessages.mock.calls.length;
    const marks = bridgeMock.markChatThreadRead.mock.calls.length;
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(reads);
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(marks);
  });

  // Follow, history position and own-send scrolling need real layout.
  // Covered by the browser timeline regressions and Electron chat QA.

  it("checks global activity and reloads changed reactions and polls", async () => {
    render(lane());
    await screen.findByText("Old message");
    const reads = bridgeMock.listChatReactions.mock.calls.length;
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Yes", "No"] }] });
    await act(async () => activity({}));
    expect(await screen.findByRole("button", { name: "Yes" })).toBeTruthy();
    expect(bridgeMock.listChatReactions).toHaveBeenCalledTimes(reads + 1);
  });

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

  it("ignores a revision response from a group the reader has left", async () => {
    const revision = deferred<{ revision: number }>();
    bridgeMock.getChatThreadRevision.mockReturnValueOnce(revision.promise);
    const view = render(lane());
    await waitFor(() => expect(bridgeMock.getChatThreadRevision).toHaveBeenCalledOnce());
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ id: "thread-2", channelId: "channel-2" })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ id: "m2", threadId: "thread-2", body: "Second channel" })] });
    view.rerender(lane("channel-2"));
    await screen.findByText("Second channel");
    await act(async () => revision.resolve({ revision: 0 }));
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Second channel")).toBeTruthy();
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

  it("retries a failed mark-read on unchanged activity without reloading content", async () => {
    bridgeMock.markChatThreadRead.mockRejectedValueOnce(new Error("Read cursor unavailable"));
    render(lane());
    await screen.findByText("Old message");
    expect(onThreadRead).not.toHaveBeenCalled();
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledTimes(2);
    expect(bridgeMock.listChatMessages).toHaveBeenCalledTimes(1);
    expect(onThreadRead).toHaveBeenCalledOnce();
  });

  it("keeps one pending mark-read across unchanged activity", async () => {
    const read = deferred<void>();
    bridgeMock.markChatThreadRead.mockReturnValueOnce(read.promise);
    render(lane());
    await screen.findByText("Old message");
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledOnce();
    await act(async () => read.resolve());
    expect(onThreadRead).toHaveBeenCalledOnce();
  });

  it("refreshes messages on matching activity and coalesces a burst", async () => {
    render(lane());
    await screen.findByText("Old message");
    const count = bridgeMock.listChannelThreads.mock.calls.length;
    act(() => activity({ workspaceId: "elsewhere" }));
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(count);
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "New message" })] });
    bridgeMock.getChatThreadRevision.mockResolvedValue({ revision: 1 });
    await act(async () => { activity({ workspaceId: "workspace-a" }); activity({ workspaceId: "workspace-a" }); });
    await screen.findByText("New message");
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(count + 1);
  });

  it("clears the old channel and composer before the next channel loads", async () => {
    const view = render(lane());
    await screen.findByText("Old message");
    fireEvent.change(screen.getByTestId("chats-lane-composer"), { target: { value: "Old draft" } });
    const held = deferred<{ threads: ReturnType<typeof thread>[] }>();
    bridgeMock.listChannelThreads.mockReturnValueOnce(held.promise);
    view.rerender(lane("channel-2"));
    expect(screen.queryByText("Old message")).toBeNull();
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).value).toBe("");
    send("Too early");
    expect(bridgeMock.sendChatMessage).not.toHaveBeenCalled();
    expect(bridgeMock.startChannelThread).not.toHaveBeenCalled();
    await act(async () => held.resolve({ threads: [] }));
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false);
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

  it("asks for trust when the person's own send waits on Restricted Mode, and never for a stale or plain send", async () => {
    const view = render(lane());
    await screen.findByText("Old message");
    bridgeMock.sendChatMessage.mockResolvedValueOnce({ message: message({ id: "plain", body: "Plain" }) });
    send("Plain");
    await screen.findByText("Plain");
    expect(onAgentWaitsForTrust).not.toHaveBeenCalled();

    bridgeMock.sendChatMessage.mockResolvedValueOnce({ message: message({ id: "held", body: "@agent plan" }), waitsForTrust: true });
    send("@agent plan");
    await waitFor(() => expect(onAgentWaitsForTrust).toHaveBeenCalledWith("workspace-a"));
    expect(onAgentWaitsForTrust).toHaveBeenCalledOnce();

    // A reply that lands after the lane moved on asks nothing.
    const stale = deferred<{ message: ReturnType<typeof message>; waitsForTrust: true }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(stale.promise);
    send("@agent again");
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ id: "thread-2", channelId: "channel-2" })] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ id: "m2", threadId: "thread-2", body: "Second channel" })] });
    view.rerender(lane("channel-2"));
    await screen.findByText("Second channel");
    await act(async () => stale.resolve({ message: message({ id: "stale", body: "@agent again" }), waitsForTrust: true }));
    expect(onAgentWaitsForTrust).toHaveBeenCalledOnce();
  });

  it.each(["sent", "failed"] as const)("shows a slow send on the send control until it has %s", async (outcome) => {
    render(lane());
    await screen.findByText("Old message");
    const held = deferred<{ message: ReturnType<typeof message> }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(held.promise);
    vi.useFakeTimers();
    try {
      send("Reply");
      const button = screen.getByRole("button", { name: "Send message" });
      act(() => vi.advanceTimersByTime(999));
      expect(button.getAttribute("aria-busy")).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByText("Sending…")).toBeTruthy();
      await act(async () => {
        if (outcome === "sent") held.resolve({ message: message({ id: "reply", body: "Reply" }) });
        else held.reject(new Error("Engine busy"));
      });
      expect(button.getAttribute("aria-busy")).toBeNull();
      expect(screen.queryByText("Sending…")).toBeNull();
      expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false);
      // A failure keeps the draft and reports through the shell's error hook.
      expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).value).toBe(outcome === "sent" ? "" : "Reply");
      expect(onError).toHaveBeenCalledTimes(outcome === "sent" ? 0 : 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a send finish while an activity refresh is in flight", async () => {
    render(lane());
    await screen.findByText("Old message");
    const held = deferred<{ message: ReturnType<typeof message> }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(held.promise);
    send("Reply");
    await act(async () => activity({ workspaceId: "workspace-a" }));
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ id: "reply", body: "Reply" })] });
    await act(async () => held.resolve({ message: message({ id: "reply", body: "Reply" }) }));
    expect((screen.getByTestId("chats-lane-composer") as HTMLTextAreaElement).disabled).toBe(false);
    await screen.findByText("Reply");
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

  it("loads the existing conversation when a concurrent first send reuses its thread", async () => {
    bridgeMock.listChannelThreads.mockResolvedValueOnce({ threads: [] });
    bridgeMock.startChannelThread.mockImplementationOnce(async () => {
      bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
      bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "Their first message" }), message({ id: "ours", body: "Our first message" })] });
      return { thread: thread(), message: message({ id: "ours", body: "Our first message" }), viewerAuthorId: "you" };
    });
    render(lane());
    await screen.findByText("No messages in #general yet.");
    send("Our first message");
    await screen.findByText("Their first message");
    expect(screen.getByText("Our first message")).toBeTruthy();
  });

  it("marks the loaded thread read and reports completion only after the write", async () => {
    const read = deferred<void>();
    bridgeMock.markChatThreadRead.mockReturnValueOnce(read.promise);
    render(lane());
    await screen.findByText("Old message");
    expect(bridgeMock.markChatThreadRead).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", upToSequence: 1 });
    expect(onThreadRead).not.toHaveBeenCalled();
    await act(async () => read.resolve());
    expect(onThreadRead).toHaveBeenCalledOnce();
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

  it("lands on the message a notice named: scrolls to it, washes it once and moves focus there", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "m1", body: "Asked" }), message({ id: "m2", body: "The reply" }), message({ id: "m3", body: "Later" }),
    ] });
    render(<ReactionStoreProvider workspaceId="workspace-a">
      <ChatLane workspaceId="workspace-a" channel={channel({ id: "channel-1", type: "chat", kind: "agent" })}
        locked={false} mentionCandidates={[]} onError={onError} onThreadRead={onThreadRead} revision={0}
        onAgentWaitsForTrust={onAgentWaitsForTrust} focusMessageId="m2" />
    </ReactionStoreProvider>);
    await screen.findByText("The reply");
    const landed = () => document.querySelector<HTMLElement>('[data-message-id="m2"]');
    await waitFor(() => expect(landed()?.className).toContain("dohc-target-flash"));
    await waitFor(() => expect(document.activeElement).toBe(landed()));
    expect(document.querySelector('[data-message-id="m3"]')?.className).not.toContain("dohc-target-flash");
    // The wash clears once; it does not stay as a selection.
    await waitFor(() => expect(landed()?.className).not.toContain("dohc-target-flash"), { timeout: 2000 });
  });

  it("shows no New divider when everything was read", async () => {
    render(lane());
    await screen.findByText("Old message");
    expect(screen.queryByTestId("chats-lane-new-divider")).toBeNull();
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

  it("uses the oldest chat thread, breaking timestamp ties by id", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [
      thread({ id: "new", createdAtMs: 20 }), thread({ id: "old-b", createdAtMs: 10 }), thread({ id: "old-a", createdAtMs: 10 }),
    ] });
    render(lane());
    await screen.findByText("Old message");
    expect(bridgeMock.listChatMessages).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "old-a" });
  });

  it("shows poll choices and sends the chosen answer with its resolution", async () => {
    const decision = { threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockImplementation(async () => {
      const resolved = { ...decision, state: "resolved", chosenOption: "Monday", resolvedByMessageId: "answer" };
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
      return { message: message({ id: "answer", body: "Monday" }), resolved };
    });
    render(lane());
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    await screen.findByTestId("chats-lane-decision-resolved");
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce();
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Monday",
      resolves: { messageId: "message-1", chosenOption: "Monday" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("says a choice that posted left its question open, with no Try again", async () => {
    const decision = { threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", body: "Monday" }),
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    render(lane());
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "Sent your choice. dohc could not mark the question answered.", "Error: Your server session changed. Try again."));
    expect(onError.mock.lastCall?.[2]).toBeUndefined();
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();
  });

  // A send can fail after main saved the choice, so no failure offers to
  // send it again.
  describe("a choice whose send failed", () => {
    const decision = { threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    async function choose(afterFailure: () => void) {
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
      bridgeMock.sendChatMessage.mockImplementationOnce(async () => {
        afterFailure();
        throw new Error("Your server session changed. Try again.");
      });
      render(lane());
      fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
      await waitFor(() => expect(onError).toHaveBeenCalled());
    }

    it("says dohc can't tell whether it was sent, with no Try again, while the question stays open", async () => {
      await choose(() => undefined);
      expect(onError).toHaveBeenCalledExactlyOnceWith("dohc could not tell whether your choice was sent.", expect.any(Error));
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce();
    });

    it("says dohc can't tell whether it was sent when the question can't be read either", async () => {
      await choose(() => {
        bridgeMock.listChatThreadDecisions.mockRejectedValueOnce(new Error("The engine stopped."));
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith("dohc could not tell whether your choice was sent.", expect.any(Error));
    });

    it("says nothing when the question now shows the choice answered", async () => {
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
      bridgeMock.sendChatMessage.mockImplementationOnce(async () => {
        bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [
          { ...decision, state: "resolved", chosenOption: "Monday", resolvedByMessageId: "answer" }] });
        throw new Error("Your server session changed. Try again.");
      });
      render(lane());
      fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
      await waitFor(() => expect(screen.getAllByTestId("chats-lane-decision-resolved")[0]!.textContent).toBe("Answered"));
      expect(onError).not.toHaveBeenCalled();
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledOnce();
    });

    it("still says it can't tell when someone else answered with another choice", async () => {
      await choose(() => {
        bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [
          { ...decision, state: "resolved", chosenOption: "Friday", resolvedByMessageId: "other" }] });
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith("dohc could not tell whether your choice was sent.", expect.any(Error));
    });
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

  it("starts the lane with a poll", async () => {
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [] });
    bridgeMock.startChannelThread.mockResolvedValueOnce({ thread: thread(), message: message({ id: "poll", body: "Lunch?" }), viewerAuthorId: "you" });
    render(lane());
    await screen.findByText("No messages in #general yet.");
    fireEvent.keyDown(draftPoll("Lunch?", ["Soup", "Salad"]), { key: "Enter" });
    expect(bridgeMock.startChannelThread).toHaveBeenCalledWith({
      workspaceId: "workspace-a", channelId: "channel-1", body: "Lunch?", needsDecision: true, options: ["Soup", "Salad"], lane: "chat",
    });
    await waitFor(() => expect(screen.queryByTestId("chats-lane-poll")).toBeNull());
  });

  it("does not send a poll the engine would refuse", async () => {
    render(lane());
    await screen.findByText("Old message");
    const composer = draftPoll("Lunch?", ["Soup", "Soup "]);
    expect((screen.getByTestId("chats-lane-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(bridgeMock.sendChatMessage).not.toHaveBeenCalled();
  });

  it("sends a removed poll's question as a plain message, then forgets its choices", async () => {
    render(lane());
    await screen.findByText("Old message");
    const composer = draftPoll("Lunch?", ["Soup", "Salad"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove poll" }));
    bridgeMock.sendChatMessage.mockResolvedValueOnce({ message: message({ id: "plain", body: "Lunch?" }) });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", body: "Lunch?" });
    await waitFor(() => expect(composer.value).toBe(""));
    openPoll();
    expect(choiceValues()).toEqual(["", ""]);
  });

  const working = { liveRunId: "run-1", liveTriggerMessageId: null, pendingCount: 0, paused: false };
  const idle = { liveRunId: null, liveTriggerMessageId: null, pendingCount: 0, paused: false };

  it("says why a run didn't reply under the message that asked, with Try again only when it can run again", async () => {
    const failedRun = { runId: "run-1", triggerMessageId: "message-1", words: "Nova didn't reply. dohc quit during its run.", retryable: true };
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...idle, failedRun });
    render(lane("agent-dm", "workspace-a", "agent"));
    const line = await screen.findByTestId("chats-lane-run-failed");
    expect(line.closest("[data-message-id]")?.getAttribute("data-message-id")).toBe("message-1");
    expect(line.textContent).toBe(`${failedRun.words}Try again`);

    bridgeMock.retryStoppedRun.mockImplementationOnce(async () => {
      bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...idle, pendingCount: 1 });
      return { queued: true };
    });
    fireEvent.click(screen.getByTestId("chats-lane-run-try-again"));
    expect(bridgeMock.retryStoppedRun).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", runId: "run-1" });
    await waitFor(() => expect(screen.queryByTestId("chats-lane-run-failed")).toBeNull());

    bridgeMock.chatDispatchStateForThread.mockResolvedValue({
      ...idle, failedRun: { ...failedRun, words: "Nova didn't reply. Its run ended with an error.", retryable: false },
    });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect((await screen.findByTestId("chats-lane-run-failed")).textContent).toBe("Nova didn't reply. Its run ended with an error.");
    expect(screen.queryByTestId("chats-lane-run-try-again")).toBeNull();
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

  it("shows and announces a run that starts without a new message", async () => {
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Old message");
    expect(screen.queryByTestId("chats-lane-working")).toBeNull();
    // The region is already mounted, so a screen reader hears its text change.
    const announcement = screen.getByTestId("chats-lane-dispatch-announcement");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.textContent).toBe("");
    bridgeMock.chatDispatchStateForThread.mockResolvedValue({ ...working, pendingCount: 2 });
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect((await screen.findByTestId("chats-lane-working")).textContent).toBe("Your agentWorkingStop");
    expect(screen.getByTestId("chats-lane-dispatch-announcement")).toBe(announcement);
    expect(announcement.textContent).toBe("Agent working, 2 queued");
  });

  it("ignores a run answer from a workspace the reader left", async () => {
    const stale = deferred<typeof working>();
    bridgeMock.chatDispatchStateForThread.mockReturnValueOnce(stale.promise);
    const view = render(lane("agent-dm", "workspace-a", "agent"));
    await waitFor(() => expect(bridgeMock.chatDispatchStateForThread).toHaveBeenCalledOnce());
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ id: "m2", body: "Workspace B" })] });
    view.rerender(lane("agent-dm", "workspace-b", "agent"));
    await screen.findByText("Workspace B");
    await act(async () => stale.resolve(working));
    expect(screen.queryByTestId("chats-lane-working")).toBeNull();
  });

  it("does not report a stop that finishes after the reader left the workspace", async () => {
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(working);
    const stop = deferred<void>();
    bridgeMock.stopAgentRun.mockReturnValueOnce(stop.promise);
    const view = render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop agent run" }));
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(idle);
    view.rerender(lane("agent-dm", "workspace-b", "agent"));
    await act(async () => stop.reject(new Error("Run ended")));
    expect(onError).not.toHaveBeenCalled();
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

  it("shows the conversation without Stop when its run state can't be read, and Stop on the next read", async () => {
    bridgeMock.chatDispatchStateForThread.mockRejectedValue(new Error("Dispatch unavailable"));
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Old message");
    expect(screen.queryByTestId("chats-lane-working")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    bridgeMock.chatDispatchStateForThread.mockResolvedValue(working);
    await act(async () => activity({ workspaceId: "workspace-a" }));
    expect(await screen.findByTestId("chats-lane-stop-agent-run")).toBeTruthy();
  });

  it("reads no run state for a group's chat", async () => {
    render(lane());
    await screen.findByText("Old message");
    expect(bridgeMock.chatDispatchStateForThread).not.toHaveBeenCalled();
    expect(bridgeMock.chatRunRecordsForThread).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chats-lane-more")).toBeNull();
  });

  it("shows an agent reply's run details from its More menu", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Plan the trip" }),
      message({ id: "reply", body: "Here is a plan", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.chatRunRecordsForThread.mockResolvedValue({ runs: {
      reply: { runId: "run-1", threadId: "thread-1", triggerMessageId: "ask", command: "nova reply", startedAtMs: 1_000, exitCode: 0 },
    } });
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Here is a plan");
    expect(bridgeMock.chatRunRecordsForThread).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1" });
    // Only the reply that has a run gets More.
    expect(screen.getAllByTestId("chats-lane-more")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("chats-lane-more"));
    // A chat row clips what overflows it, so the list opens over the page.
    expect(screen.getByTestId("chats-lane-more-menu").getAttribute("popover")).toBe("manual");
    fireEvent.click(await screen.findByTestId("chats-lane-more-run-details"));
    const details = await screen.findByTestId("chats-lane-run-details");
    expect(details.textContent).toContain("nova reply");
    fireEvent.click(screen.getByTestId("chats-lane-more"));
    expect((await screen.findByTestId("chats-lane-more-run-details")).textContent).toBe("Hide run details");
    fireEvent.click(screen.getByTestId("chats-lane-more-run-details"));
    await waitFor(() => expect(screen.queryByTestId("chats-lane-run-details")).toBeNull());
  });

  it("shows an agent DM without run details when its runs can't be read", async () => {
    bridgeMock.chatRunRecordsForThread.mockRejectedValue(new Error("engine busy"));
    render(lane("agent-dm", "workspace-a", "agent"));
    await screen.findByText("Old message");
    expect(screen.queryByTestId("chats-lane-more")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
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

  it("answers a poll in a thread inside that thread", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "When do we leave?" }),
      message({ id: "poll", body: "Which day?", parentMessageId: "ask", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    const decision = { threadId: "thread-1", messageId: "poll", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "answer", body: "Monday", parentMessageId: "ask" }) });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-thread-summary"));
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Monday", parentMessageId: "ask",
      resolves: { messageId: "poll", chosenOption: "Monday" },
    }));
  });

  it("answers a poll in an earlier post when the DM has no chat yet", async () => {
    bridgeMock.listChannelThreads.mockImplementation(async ({ lane }) => ({ threads: lane === "posts" ? [thread({ id: "post-1" })] : [] }));
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "poll", threadId: "post-1", body: "Which day?", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    const decision = { threadId: "post-1", messageId: "poll", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "answer", threadId: "post-1", body: "Monday" }) });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "post-1", body: "Monday",
      resolves: { messageId: "poll", chosenOption: "Monday" },
    }));
  });

  it("shows a Collection change on the message that attaches it, and Apply answers that message", async () => {
    const place = world();
    ask(place);
    vi.stubGlobal("dohcDesktop", { ...window.dohcDesktop, ...place.api });
    const attachment = { attachmentId: "attachment-1", threadId: "thread-1", messageId: "asks", targetKind: "file" as const, pathHint: proposalPath, createdAtMs: 3_000 };
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "asks", body: "Here's the due date.", authorKind: "agent", authorDisplayName: "Claude Code", createdAtMs: 3_000, attachments: [attachment] }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "asks", state: "open", atMs: 1 }] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "applied", body: "Applied the change to Volunteers." }) });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-change-apply"));
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Applied the change to Volunteers.", resolves: { messageId: "asks" },
    }));
    expect(screen.queryByTestId("chats-lane-decision-open")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
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

  it.each([
    ["an agent's DM", "agent"],
    ["a group", "channel"],
  ] as const)("answers an open question with no options in %s by a reply in its thread", async (_, kind) => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "question", body: "What should I call the file?", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    const decision = { threadId: "thread-1", messageId: "question", state: "open", atMs: 1 };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    const resolved = { ...decision, state: "resolved", resolvedByMessageId: "answer" };
    const reload = deferred<{ decisions: (typeof resolved)[] }>();
    bridgeMock.sendChatMessage.mockImplementation(async () => {
      bridgeMock.listChatThreadDecisions.mockReturnValue(reload.promise);
      return { message: message({ id: "answer", body: "Call it notes.md", parentMessageId: "question" }), resolved };
    });
    render(lane(kind === "agent" ? "agent-dm" : "channel-1", "workspace-a", kind));
    expect((await screen.findByTestId("chats-lane-decision-open")).textContent).toBe("Unanswered");
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const reply = await screen.findByTestId("chats-lane-thread-composer");
    await waitFor(() => expect(document.activeElement).toBe(reply));
    fireEvent.change(reply, { target: { value: "Call it notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Call it notes.md", parentMessageId: "question",
      resolves: { messageId: "question" },
    }));
    await waitFor(() => expect(screen.getAllByTestId("chats-lane-decision-resolved")[0]!.textContent).toBe("Answered"));
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    await act(async () => reload.resolve({ decisions: [resolved] }));
  });

  it("says a reply that posted left its question open, with no Try again", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "question", body: "What should I call the file?", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "question", state: "open", atMs: 1 }] });
    bridgeMock.sendChatMessage.mockResolvedValue({
      message: message({ id: "answer", body: "notes.md", parentMessageId: "question" }),
      resolveFailure: "Error: Your server session changed. Try again.",
    });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    const reply = await screen.findByTestId("chats-lane-thread-composer");
    fireEvent.change(reply, { target: { value: "notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      "Sent your reply. dohc could not mark the question answered.", "Error: Your server session changed. Try again."));
    expect(onError.mock.lastCall?.[2]).toBeUndefined();
    expect(screen.queryByTestId("chats-lane-decision-resolved")).toBeNull();
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

  it("leaves the cursor where the person put it when a reply still sending ends after Answer", async () => {
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
    const answer = screen.getByRole("button", { name: "Answer" });
    answer.focus();
    fireEvent.click(answer);
    // The person moves on to the conversation's own box before the send ends.
    const composer = screen.getByTestId("chats-lane-composer");
    composer.focus();
    sent.resolve({ message: message({ id: "plain", body: "One moment", parentMessageId: "ask" }) });
    await waitFor(() => expect(reply.disabled).toBe(false));
    expect(document.activeElement).toBe(composer);
  });

  it("leaves the cursor where the person put it when an answer's send fails", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "ask", body: "Write the summary" }),
      message({ id: "question", body: "Which file?", parentMessageId: "ask", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "question", state: "open", atMs: 1 }] });
    const sent = deferred<never>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(sent.promise);
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByTestId("chats-lane-thread-summary"));
    const reply = await screen.findByTestId("chats-lane-thread-composer") as HTMLTextAreaElement;
    reply.blur();
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    await waitFor(() => expect(document.activeElement).toBe(reply));
    fireEvent.change(reply, { target: { value: "notes.md" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(reply.disabled).toBe(true));
    const composer = screen.getByTestId("chats-lane-composer");
    composer.focus();
    sent.reject(new Error("disk full"));
    await waitFor(() => expect(reply.disabled).toBe(false));
    expect(onError).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);
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

  it("sends a reply without Answer, or after its thread closed, as a plain reply", async () => {
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [
      message({ id: "question", body: "What should I call the file?", authorKind: "agent", authorDisplayName: "Nova" }),
    ] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ threadId: "thread-1", messageId: "question", state: "open", atMs: 1 }] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "reply", body: "Thinking", parentMessageId: "question" }) });
    render(lane("agent-dm", "workspace-a", "agent"));
    fireEvent.click(await screen.findByRole("button", { name: "Answer" }));
    fireEvent.click(await screen.findByTestId("chats-lane-thread-close"));
    fireEvent.click(screen.getByTestId("chats-lane-reply-in-thread"));
    const reply = await screen.findByTestId("chats-lane-thread-composer");
    fireEvent.change(reply, { target: { value: "Thinking" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() => expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
      workspaceId: "workspace-a", threadId: "thread-1", body: "Thinking", parentMessageId: "question",
    }));
  });

  it("drops the poll with the draft when the group changes", async () => {
    const view = render(lane());
    await screen.findByText("Old message");
    draftPoll("Lunch?", ["Soup", "Salad"]);
    view.rerender(lane("channel-2"));
    expect(screen.queryByTestId("chats-lane-poll")).toBeNull();
  });
});
