// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridgeMock, channel, message, thread } from "./ChatsView.testHarness";
import { ChatLane } from "./ChatLane";

let activity: (event: { workspaceId: string }) => void;
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
  it("refreshes messages on matching activity and coalesces a burst", async () => {
    render(lane());
    await screen.findByText("Old message");
    const count = bridgeMock.listChannelThreads.mock.calls.length;
    act(() => activity({ workspaceId: "elsewhere" }));
    expect(bridgeMock.listChannelThreads).toHaveBeenCalledTimes(count);
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message({ body: "New message" })] });
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
    await screen.findByText("No messages yet");
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
