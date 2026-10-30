import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridgeMock, channel, message, renderView, thread } from "./ChatsView.testHarness";

const decision = {
  threadId: "thread-1",
  messageId: "message-1",
  state: "open",
  atMs: 1,
  options: ["Soup", "Salad"],
};

// A new post has a Poll button; a chat bar starts a poll from its "+".
function openPoll(prefix: string) {
  if (prefix === "chats-new-thread") {
    fireEvent.mouseDown(screen.getByTestId(`${prefix}-poll-toggle`));
    return;
  }
  fireEvent.click(screen.getByTestId(`${prefix}-add`));
  fireEvent.click(screen.getByTestId(`${prefix}-poll-toggle`));
}
function fillPoll(prefix: string, choices: string[]) {
  openPoll(prefix);
  choices.forEach((choice, index) => {
    fireEvent.change(screen.getAllByTestId(`${prefix}-poll-choice`)[index]!, { target: { value: choice } });
  });
}
const choiceValues = (prefix: string) =>
  screen.getAllByTestId(`${prefix}-poll-choice`).map((input) => (input as HTMLInputElement).value);

describe("ChatsView polls", () => {
  // The decisions list stays empty: the poll comes with its message.
  it("starts a post with a poll and shows its choices in the new thread", async () => {
    const user = userEvent.setup();
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: thread({ title: "Lunch?" }),
      message: message({ body: "Lunch?" }),
      viewerAuthorId: "you@example.com",
      decision,
    });
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "Lunch?");
    fillPoll("chats-new-thread", [" Soup", "Salad "]);
    fireEvent.click(screen.getByTestId("chats-new-thread-send"));
    await waitFor(() =>
      expect(bridgeMock.startChannelThread).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        channelId: "channel-1",
        body: "Lunch?",
        needsDecision: true,
        options: ["Soup", "Salad"],
      }),
    );
    const posted = await screen.findAllByTestId("chats-message-poll-option");
    expect(posted.map((option) => option.textContent)).toEqual(["Soup", "Salad"]);
  });

  it("keeps a new post's poll when the start fails", async () => {
    const user = userEvent.setup();
    bridgeMock.startChannelThread.mockRejectedValue(new Error("Engine busy"));
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "Lunch?");
    fillPoll("chats-new-thread", ["Soup", "Salad"]);
    fireEvent.click(screen.getByTestId("chats-new-thread-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(choiceValues("chats-new-thread")).toEqual(["Soup", "Salad"]);
  });

  it.each(["sent", "failed"] as const)("asks a poll in a comment and keeps it until it has %s", async (outcome) => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    if (outcome === "sent") {
      bridgeMock.sendChatMessage.mockResolvedValue({
        message: message({ id: "message-2", body: "Lunch?" }),
        decision: { ...decision, messageId: "message-2" },
      });
    } else {
      bridgeMock.sendChatMessage.mockRejectedValue(new Error("Engine busy"));
    }
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fillPoll("chats", ["Soup", "Salad"]);
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        threadId: "thread-1",
        body: "Lunch?",
        needsDecision: true,
        options: ["Soup", "Salad"],
      }),
    );
    if (outcome === "sent") {
      await waitFor(() => expect(screen.queryByTestId("chats-poll")).toBeNull());
      expect((await screen.findAllByTestId("chats-comment-poll-option")).map((option) => option.textContent)).toEqual(["Soup", "Salad"]);
    } else {
      await waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(choiceValues("chats")).toEqual(["Soup", "Salad"]);
      expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("Lunch?");
    }
  });

  // Answering a poll may send an empty message; a new poll still needs its
  // own question, not the answer's fallback.
  it("does not send a comment poll without a question of its own", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click((await screen.findAllByTestId("chats-message-poll-option"))[1]!);
    expect(screen.getByTestId("chats-resolving-mode").textContent).toContain("Salad");
    fillPoll("chats", ["Soup", "Salad"]);
    expect((screen.getByTestId("chats-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    expect(bridgeMock.sendChatMessage).not.toHaveBeenCalled();
  });

  it("keeps a comment's poll in its own thread and drops it in another", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread(), thread({ id: "thread-2", title: "Another chat" })],
    });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages: [message({ id: `${threadId}-opening`, threadId })],
    }));
    renderView();
    const openThread = async (id: string) => {
      const card = (await screen.findAllByTestId("chats-thread")).find((node) => node.dataset.threadId === id)!;
      await user.click(card);
      await screen.findByTestId("chats-thread-view");
    };
    await user.click(await screen.findByTestId("chats-channel"));
    await openThread("thread-1");
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fillPoll("chats", ["Soup", "Salad"]);
    await user.click(screen.getByTestId("chats-thread-back"));
    await openThread("thread-1");
    expect(choiceValues("chats")).toEqual(["Soup", "Salad"]);
    await user.click(screen.getByTestId("chats-thread-back"));
    await openThread("thread-2");
    expect(screen.queryByTestId("chats-poll")).toBeNull();
  });

  it("keeps a new post's poll in its own group and drops it in another", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "channel-2", name: "random", slug: "random" })],
      fileThreads: [],
    });
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    renderView();
    const openChannel = async (name: string) => {
      const row = (await screen.findAllByTestId("chats-channel")).find((node) => node.textContent?.includes(name))!;
      await user.click(row);
      await screen.findByTestId("chats-channel-view");
    };
    await openChannel("general");
    await user.type(screen.getByTestId("chats-new-thread-composer"), "Where?");
    fillPoll("chats-new-thread", ["Lisbon", "Porto"]);
    await user.click(await screen.findByTestId("chats-thread"));
    await user.click(await screen.findByTestId("chats-thread-back"));
    await screen.findByTestId("chats-channel-view");
    expect(choiceValues("chats-new-thread")).toEqual(["Lisbon", "Porto"]);
    await user.click(screen.getByTestId("chats-channel-back"));
    await openChannel("random");
    expect(screen.queryByTestId("chats-new-thread-poll")).toBeNull();
  });

  it("reports a drafted poll so the next mount gets its choices", async () => {
    const user = userEvent.setup();
    const onDraftsChange = vi.fn();
    renderView(vi.fn(), vi.fn(), { onDraftsChange });
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "Where?");
    fillPoll("chats-new-thread", ["Lisbon", "Porto"]);
    await waitFor(() =>
      expect(onDraftsChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          newThreadBody: "Where?",
          newThreadPoll: { channelId: "channel-1", choices: ["Lisbon", "Porto"], open: true },
        }),
      ),
    );
  });

  it("sends a removed poll's question as a plain comment, then forgets its choices", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "message-2", body: "Lunch?" }) });
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fillPoll("chats", ["Soup", "Salad"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove poll" }));
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    await waitFor(() =>
      expect(bridgeMock.sendChatMessage).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1", body: "Lunch?" }),
    );
    await waitFor(() => expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe(""));
    openPoll("chats");
    expect(choiceValues("chats")).toEqual(["", ""]);
  });

  // The person leaves the thread and comes back while the send is in flight.
  // The reload on return read the thread before the write, so the poll's
  // choices come only with the sent message.
  it("shows a comment's poll when the person left and came back during the send", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    const held = deferred<{ message: ReturnType<typeof message>; decision: typeof decision }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(held.promise);
    renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fillPoll("chats", ["Soup", "Salad"]);
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    await user.click(screen.getByTestId("chats-thread-back"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-message-body");

    await act(async () => held.resolve({
      message: message({ id: "message-2", body: "Lunch?" }),
      decision: { ...decision, messageId: "message-2" },
    }));
    expect((await screen.findAllByTestId("chats-comment-poll-option")).map((node) => node.textContent)).toEqual(["Soup", "Salad"]);
    expect(screen.queryByTestId("chats-poll")).toBeNull();
  });
});
