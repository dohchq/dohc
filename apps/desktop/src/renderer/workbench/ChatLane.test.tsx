// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridgeMock, channel, message, thread } from "./ChatsView.testHarness";
import { ChatLane } from "./ChatLane";
import { extractChatFileReferenceTokens } from "./chatFileMentions";
import type { WorkspaceActivityEvent } from "../../ipc/bridgeContract";
import { configureDemoDesktopBridge } from "../../../../site/src/demoDesktopBridge";

vi.mock("./chatFileMentions", { spy: true });

let activity: (event: WorkspaceActivityEvent) => void;
const onError = vi.fn();
const onThreadRead = vi.fn();
function lane(id = "channel-1", workspaceId = "workspace-a") {
  return <ChatLane workspaceId={workspaceId} channel={channel({ id, type: "chat" })}
    locked={false} mentionCandidates={[]} onError={onError} onThreadRead={onThreadRead} revision={0} />;
}
function send(body: string) {
  const composer = screen.getByTestId("chats-lane-composer");
  fireEvent.change(composer, { target: { value: body } });
  fireEvent.keyDown(composer, { key: "Enter" });
}
beforeEach(() => {
  onError.mockReset();
  onThreadRead.mockReset();
  bridgeMock.onWorkspaceActivity.mockImplementation(callback => { activity = callback; return vi.fn(); });
  bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
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

  it("shows poll choices and sends the chosen answer before resolving", async () => {
    const decision = { threadId: "thread-1", messageId: "message-1", state: "open", atMs: 1, options: ["Friday", "Monday"] };
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "answer", body: "Monday" }) });
    bridgeMock.resolveChatDecision.mockImplementation(async () => {
      const resolved = { ...decision, state: "resolved", chosenOption: "Monday", resolvedByMessageId: "answer" };
      bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [resolved] });
      return { decision: resolved };
    });
    render(lane());
    fireEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await screen.findByTestId("chats-lane-decision-resolved");
    expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", body: "Monday" });
    expect(bridgeMock.resolveChatDecision).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", messageId: "message-1", resolvedByMessageId: "answer", chosenOption: "Monday" });
    expect(bridgeMock.sendChatMessage.mock.invocationCallOrder[0]).toBeLessThan(bridgeMock.resolveChatDecision.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe("true"));
  });
});
