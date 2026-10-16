import "../../testing/legendListMock";
// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { bridgeMock, message, renderView, thread } from "./ChatsView.testHarness";

const decision = {
  threadId: "thread-1",
  messageId: "message-1",
  state: "open",
  atMs: 1,
  options: ["Soup", "Salad"],
};

function fillPoll(prefix: string, choices: string[]) {
  fireEvent.mouseDown(screen.getByTestId(`${prefix}-poll-toggle`));
  choices.forEach((choice, index) => {
    fireEvent.change(screen.getAllByTestId(`${prefix}-poll-choice`)[index]!, { target: { value: choice } });
  });
}
const choiceValues = (prefix: string) =>
  screen.getAllByTestId(`${prefix}-poll-choice`).map((input) => (input as HTMLInputElement).value);

describe("ChatsView polls", () => {
  it("starts a post with a poll and shows its choices in the new thread", async () => {
    const user = userEvent.setup();
    bridgeMock.startChannelThread.mockResolvedValue({
      thread: thread({ title: "Lunch?" }),
      message: message({ body: "Lunch?" }),
      viewerAuthorId: "you@example.com",
    });
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [decision] });
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
    expect(bridgeMock.listChatThreadDecisions).toHaveBeenCalledWith({ workspaceId: "workspace-a", threadId: "thread-1" });
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
      bridgeMock.sendChatMessage.mockResolvedValue({ message: message({ id: "message-2", body: "Lunch?" }) });
    } else {
      bridgeMock.sendChatMessage.mockRejectedValue(new Error("Engine busy"));
    }
    const { onError } = renderView();
    await user.click(await screen.findByTestId("chats-channel"));
    await user.click(await screen.findByTestId("chats-thread"));
    await user.type(screen.getByTestId("chats-composer"), "Lunch?");
    fillPoll("chats", ["Soup", "Salad"]);
    bridgeMock.listChatThreadDecisions.mockResolvedValue({ decisions: [{ ...decision, messageId: "message-2" }] });
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
});
