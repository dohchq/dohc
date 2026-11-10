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

// A send whose store write held while a later step failed answers with the
// saved message's ids and why. What it said shows once a reload lists it.
describe("ChatsView sends that saved before a later step failed", () => {
  const failure = "Error: The bookmark projection stopped.";
  const bodies = () => screen.queryAllByTestId("chats-message-body").map((node) => node.textContent);
  const groupReads = () => bridgeMock.listChannelThreads.mock.calls.filter(([input]) => input.lane === undefined).length;
  const threadReads = (threadId: string) =>
    bridgeMock.listChatMessages.mock.calls.filter(([input]) => input.threadId === threadId).length;

  it("clears a saved comment's draft, reloads its thread to show it, and says why once", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: { id: "message-2", threadId: "thread-1" }, failure });
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await screen.findByTestId("chats-message-body");
    const reload = deferred<{ messages: ReturnType<typeof message>[] }>();
    bridgeMock.listChatMessages.mockReturnValueOnce(reload.promise);
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith("Sent your message. dohc could not show it yet.", failure, expect.any(Function));
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("");
    expect(bodies()).toEqual(["Should we ship on Friday?"]);
    await act(async () => reload.resolve({ messages: [message(), message({ id: "message-2", body: "Lunch?" })] }));
    await waitFor(() => expect(bodies()).toEqual(["Should we ship on Friday?", "Lunch?"]));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("gives a comment that saved a Try again that reloads its thread, only while the window shows it", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.sendChatMessage.mockResolvedValue({ message: { id: "message-2", threadId: "thread-1" }, failure });
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const again = onError.mock.lastCall?.[2] as () => void;

    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message(), message({ id: "message-2", body: "Lunch?" })] });
    const before = threadReads("thread-1");
    act(() => again());
    expect(threadReads("thread-1")).toBe(before + 1);
    await waitFor(() => expect(bodies()).toContain("Lunch?"));

    // Back in the Group, Try again reads nothing.
    await user.click(screen.getByTestId("chats-thread-back"));
    await screen.findByTestId("chats-channel-view");
    const left = threadReads("thread-1");
    act(() => again());
    expect(threadReads("thread-1")).toBe(left);
  });

  it("clears a saved post and its poll and reloads the Group to list it, without opening it", async () => {
    const user = userEvent.setup();
    const onThreadStarted = vi.fn();
    const onNavCommand = vi.fn();
    bridgeMock.startChannelThread.mockResolvedValue({ message: { id: "message-1", threadId: "thread-1" }, failure });
    const { onError } = renderView(vi.fn(), vi.fn(), { onThreadStarted, onNavCommand });
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "Lunch?");
    fillPoll("chats-new-thread", ["Soup", "Salad"]);
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread({ title: "Lunch?" })] });
    const before = groupReads();
    onNavCommand.mockClear();
    fireEvent.click(screen.getByTestId("chats-new-thread-send"));

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith("Posted your message. dohc could not open it yet.", failure, expect.any(Function));
    expect(onThreadStarted).toHaveBeenCalledOnce();
    expect((screen.getByTestId("chats-new-thread-composer") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByTestId("chats-new-thread-poll")).toBeNull();
    expect(groupReads()).toBe(before + 1);
    expect((await screen.findByTestId("chats-thread")).dataset.threadId).toBe("thread-1");
    expect(screen.getByTestId("chats-channel-view")).toBeTruthy();
    expect(screen.queryByTestId("chats-thread-view")).toBeNull();
    expect(onNavCommand).not.toHaveBeenCalled();
  });

  it("gives a post that saved a Try again that reloads only its own Group, and nothing once the view closes", async () => {
    const user = userEvent.setup();
    bridgeMock.listChatChannels.mockResolvedValue({
      channels: [channel(), channel({ id: "channel-2", name: "random", slug: "random" })],
      fileThreads: [],
    });
    bridgeMock.startChannelThread.mockResolvedValue({ message: { id: "message-1", threadId: "thread-1" }, failure });
    const { onError, unmount } = renderView();
    const openChannel = async (name: string) => {
      const row = (await screen.findAllByTestId("chats-channel")).find((node) => node.textContent?.includes(name))!;
      await user.click(row);
      await screen.findByTestId("chats-channel-empty");
    };
    const reads = (channelId: string) => bridgeMock.listChannelThreads.mock.calls
      .filter(([input]) => input.lane === undefined && input.channelId === channelId).length;
    await openChannel("general");
    await user.type(screen.getByTestId("chats-new-thread-composer"), "Lunch?");
    fireEvent.click(screen.getByTestId("chats-new-thread-send"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const again = onError.mock.lastCall?.[2] as () => void;

    // Another Group is not reloaded as if it were the post's.
    await user.click(screen.getByTestId("chats-channel-back"));
    await openChannel("random");
    const before = [reads("channel-1"), reads("channel-2")];
    act(() => again());
    expect([reads("channel-1"), reads("channel-2")]).toEqual(before);

    await user.click(screen.getByTestId("chats-channel-back"));
    await openChannel("general");
    const shown = reads("channel-1");
    act(() => again());
    expect(reads("channel-1")).toBe(shown + 1);

    unmount();
    again();
    expect(reads("channel-1")).toBe(shown + 1);
  });

  // Leaving and reopening the Group keeps the same send context, so only the
  // navigation token tells this answer is stale.
  it("leaves the reopened Group alone when a post saved after the person left it", async () => {
    const user = userEvent.setup();
    const onThreadStarted = vi.fn();
    const held = deferred<{ message: { id: string; threadId: string }; failure: string }>();
    bridgeMock.startChannelThread.mockReturnValueOnce(held.promise);
    const { onError } = renderView(vi.fn(), vi.fn(), { onThreadStarted });
    await user.click(await screen.findByTestId("chats-channel"));
    await user.type(await screen.findByTestId("chats-new-thread-composer"), "Lunch?");
    fireEvent.click(screen.getByTestId("chats-new-thread-send"));
    await user.click(screen.getByTestId("chats-channel-back"));
    await user.click(await screen.findByTestId("chats-channel"));
    await screen.findByTestId("chats-channel-empty");
    const before = groupReads();

    await act(async () => held.resolve({ message: { id: "message-1", threadId: "thread-1" }, failure }));
    expect(onError).not.toHaveBeenCalled();
    expect(onThreadStarted).not.toHaveBeenCalled();
    expect(groupReads()).toBe(before);
    expect(screen.getByTestId("chats-channel-view")).toBeTruthy();
  });

  it("leaves another thread's draft alone when a comment saved after the person left its thread", async () => {
    const user = userEvent.setup();
    bridgeMock.listChannelThreads.mockResolvedValue({
      threads: [thread(), thread({ id: "thread-2", title: "Another chat" })],
    });
    bridgeMock.listChatMessages.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      messages: [message({ id: `${threadId}-opening`, threadId })],
    }));
    const held = deferred<{ message: { id: string; threadId: string }; failure: string }>();
    bridgeMock.sendChatMessage.mockReturnValueOnce(held.promise);
    const { onError } = renderView();
    const openThread = async (id: string) => {
      const card = (await screen.findAllByTestId("chats-thread")).find((node) => node.dataset.threadId === id)!;
      await user.click(card);
      await screen.findByTestId("chats-thread-view");
    };
    await user.click(await screen.findByTestId("chats-channel"));
    await openThread("thread-1");
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fireEvent.keyDown(screen.getByTestId("chats-composer"), { key: "Enter" });
    await user.click(screen.getByTestId("chats-thread-back"));
    await openThread("thread-2");
    fireEvent.change(screen.getByTestId("chats-composer"), { target: { value: "Other words" } });
    const before = [threadReads("thread-1"), threadReads("thread-2")];

    await act(async () => held.resolve({ message: { id: "message-2", threadId: "thread-1" }, failure }));
    expect(onError).not.toHaveBeenCalled();
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("Other words");
    expect([threadReads("thread-1"), threadReads("thread-2")]).toEqual(before);
  });

  it.each(["post", "comment"] as const)("keeps a %s's draft when its send saved nothing", async (kind) => {
    const user = userEvent.setup();
    const refusal = new Error("Engine busy");
    bridgeMock.listChannelThreads.mockResolvedValue({ threads: [thread()] });
    bridgeMock.listChatMessages.mockResolvedValue({ messages: [message()] });
    bridgeMock.startChannelThread.mockRejectedValue(refusal);
    bridgeMock.sendChatMessage.mockRejectedValue(refusal);
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    if (kind === "comment") await user.click(await screen.findByTestId("chats-thread"));
    const composerId = kind === "post" ? "chats-new-thread-composer" : "chats-composer";
    await user.type(await screen.findByTestId(composerId), "Lunch?");
    fireEvent.keyDown(screen.getByTestId(composerId), { key: "Enter" });

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.any(String), refusal);
    expect((screen.getByTestId(composerId) as HTMLTextAreaElement).value).toBe("Lunch?");
  });
});
