import "../../testing/legendListMock";
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectConversation, DirectMessage } from "@dohc/security-contract/direct-messages";
import { bridgeMock, emitCloudSessionChanged, renderView } from "./ChatsView.testHarness";
import { chatTabPath } from "./workbenchState";
import { directStore } from "./directConversations";

// Direct messages live on the account's server, so every workspace lists the
// same People. Each conversation is between two people. Nothing is kept on
// this computer: while the server is away, the views say so with Try again.

const VIEWER = "me";

function directStoreViewer(): string | null {
  const state = directStore().snapshot();
  return state.status === "ready" ? state.viewerId : null;
}
const sam = { personId: "sam", name: "Sam Rivera", blocked: false };
const ana = { personId: "ana", name: "Ana Diaz", blocked: false };

function sent(seq: number, authorId: string, body: string): DirectMessage {
  return {
    seq,
    messageId: `message-${seq}`,
    authorId,
    authorName: authorId === VIEWER ? null : authorId === "sam" ? sam.name : ana.name,
    body,
    createdAtMs: 1_000 + seq,
  };
}

function conversation(overrides: Partial<DirectConversation> = {}): DirectConversation {
  return {
    conversationId: "conversation-sam",
    person: sam,
    last: sent(2, "sam", "See you at nine"),
    unread: 0,
    ...overrides,
  };
}

function signedIn(conversations: DirectConversation[]) {
  bridgeMock.directConversations.mockResolvedValue({
    available: true,
    viewerId: VIEWER,
    conversations,
  });
}

function history(messages: DirectMessage[], conversationId = "conversation-sam") {
  bridgeMock.directHistory.mockResolvedValue({ conversationId, messages, more: false });
}

const UNREACHABLE = (channel: string) =>
  new Error(
    `Error invoking remote method 'desktop:${channel}': DirectMessageError [direct-retry]: dohc could not reach your server. Check your connection.`,
  );

function members(
  people: Array<{
    memberId: string;
    name: string | null;
    state?: "active" | "invited" | "removed";
  }>,
) {
  bridgeMock.workspaceMembers.mockResolvedValue({
    status: "ready",
    view: {
      workspaceId: "workspace-a",
      workspaceName: "Work",
      viewer: { memberId: VIEWER, role: "owner" },
      memberLevel: "edit",
      inviteLink: null,
      people: [
        {
          memberId: VIEWER,
          role: "owner",
          state: "active",
          name: "Me",
          paletteSlot: 0,
          email: "me@example.com",
          invitedAtMs: null,
          joinedAtMs: 1,
          removedAtMs: null,
        },
        ...people.map((person) => ({
          memberId: person.memberId,
          role: "member" as const,
          state: person.state ?? "active",
          name: person.name,
          paletteSlot: 0,
          email: `${person.memberId}@example.com`,
          invitedAtMs: null,
          joinedAtMs: 1,
          removedAtMs: null,
        })),
      ],
    },
  });
}

async function openSam() {
  fireEvent.click(await screen.findByTestId("chats-dm-item"));
  return screen.findByTestId("chats-dm-view");
}

describe("ChatsView direct messages", () => {
  beforeEach(() => {
    bridgeMock.directMarkRead.mockResolvedValue(undefined);
  });

  it("hides People while signed out of the server", async () => {
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    await screen.findByTestId("chats-view");
    await waitFor(() => expect(bridgeMock.directConversations).toHaveBeenCalled());
    expect(screen.queryByTestId("chats-dms-section")).toBeNull();
  });

  it("lists each conversation by the other person's name, with unread, preview, and blocked marks, and no email", async () => {
    signedIn([
      conversation({ unread: 2 }),
      conversation({
        conversationId: "conversation-ana",
        person: ana,
        last: sent(5, "ana", "Booked the table"),
        unread: 0,
      }),
      conversation({
        conversationId: "conversation-lee",
        person: { personId: "lee", name: null, blocked: true },
        last: sent(1, VIEWER, "Hi"),
      }),
    ]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    const rows = await screen.findAllByTestId("chats-dm-item");
    expect(rows.map((row) => within(row).getByTestId("chats-dm-name").textContent)).toEqual([
      "Sam Rivera",
      "Ana Diaz",
      "Someone",
    ]);
    // Only the unread row shows its last message and a count.
    expect(within(rows[0]!).getByTestId("chats-dm-unread").textContent).toBe("2");
    expect(rows[0]!.textContent).toContain("See you at nine");
    expect(rows[1]!.textContent).not.toContain("Booked the table");
    expect(within(rows[1]!).queryByTestId("chats-dm-unread")).toBeNull();
    expect(rows[2]!.dataset.blocked).toBe("true");
    expect(within(rows[2]!).getByTestId("chats-dm-blocked")).toBeTruthy();
    expect(screen.getByTestId("chats-dms-section").textContent).not.toContain("@");
  });

  it("reads the list again when the server says something changed, and when the session settles", async () => {
    let changed: () => void = () => {};
    bridgeMock.onDirectChanged.mockImplementation((listener: () => void) => {
      changed = listener;
      return () => undefined;
    });
    signedIn([conversation()]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    await screen.findByTestId("chats-dm-item");
    signedIn([conversation({ unread: 1, last: sent(3, "sam", "Running late") })]);
    act(() => changed());
    expect((await screen.findByTestId("chats-dm-unread")).textContent).toBe("1");

    signedIn([conversation({ unread: 4, last: sent(6, "sam", "Here now") })]);
    act(() => emitCloudSessionChanged("session-a", "ready"));
    await waitFor(() => expect(screen.getByTestId("chats-dm-unread").textContent).toBe("4"));
  });

  it("says when the list can't be read, as a notice with Try again", async () => {
    bridgeMock.directConversations.mockRejectedValue(new Error("relay unreachable"));
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    const retry = await screen.findByTestId("chats-dms-retry");
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [, , tryAgain, , options] = onError.mock.calls.at(-1)!;
    expect(options).toEqual({ identity: expect.stringContaining("direct") });
    signedIn([conversation()]);
    act(() => (tryAgain as () => void)());
    expect(await screen.findByTestId("chats-dm-item")).toBeTruthy();
    expect(retry.isConnected).toBe(false);
  });

  it("shows a conversation opened while the server is away as failed, with Try again that reads it once the server answers", async () => {
    bridgeMock.directConversations.mockRejectedValue(UNREACHABLE("direct-conversations"));
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "direct", conversationId: "conversation-sam" },
    });
    const failed = await screen.findByTestId("chats-dm-history-retry");
    expect(failed.textContent).toContain("dohc could not reach your server.");
    expect(screen.queryByTestId("chats-dm-composer")).toBeNull();
    expect(bridgeMock.directHistory).not.toHaveBeenCalled();

    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByTestId("chats-dm-message")).toHaveLength(1));
    expect(await screen.findByTestId("chats-dm-composer")).toBeTruthy();
  });

  it("heads a conversation with the name saved with its tab while the server is away, and the server's name once it answers", async () => {
    bridgeMock.directConversations.mockRejectedValue(UNREACHABLE("direct-conversations"));
    const savedDirectName = (conversationId: string) =>
      conversationId === "conversation-sam" ? "Sam" : undefined;
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      savedDirectName,
      initialNav: { level: "direct", conversationId: "conversation-sam" },
    });
    const failed = await screen.findByTestId("chats-dm-history-retry");
    expect(screen.getByTestId("chats-dm-title").textContent).toBe("Sam");

    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByTestId("chats-dm-title").textContent).toBe("Sam Rivera"),
    );
  });

  it("shows a history read that fails with Try again", async () => {
    signedIn([conversation()]);
    bridgeMock.directHistory.mockRejectedValueOnce(UNREACHABLE("direct-history"));
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    await openSam();
    const failed = await screen.findByTestId("chats-dm-history-retry");
    expect(failed.textContent).toContain("dohc could not reach your server.");
    history([sent(2, "sam", "See you at nine")]);
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByTestId("chats-dm-message")).toHaveLength(1));
  });

  it("opens a conversation with its messages and marks it read once the newest is in view", async () => {
    signedIn([conversation({ unread: 1 })]);
    history([sent(1, VIEWER, "Dinner Friday?"), sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    const view = await openSam();
    expect(within(view).getByTestId("chats-dm-title").textContent).toBe("Sam Rivera");
    await waitFor(() => expect(within(view).getAllByTestId("chats-dm-message")).toHaveLength(2));
    expect(bridgeMock.directHistory).toHaveBeenCalledWith({
      viewerId: VIEWER,
      conversationId: "conversation-sam",
    });
    await waitFor(() =>
      expect(bridgeMock.directMarkRead).toHaveBeenCalledWith({
        viewerId: VIEWER,
        conversationId: "conversation-sam",
        seq: 2,
      }),
    );
    expect(screen.queryByTestId("chats-dm-unread")).toBeNull();
    // No one else is in a conversation of two, so its composer offers no Mention.
    expect(within(view).queryByRole("button", { name: "Mention" })).toBeNull();
  });

  it("drops a list read for the account signed in before, even on the first session event", async () => {
    let resolveBefore: (value: unknown) => void = () => {};
    bridgeMock.directConversations.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBefore = resolve;
      }),
    );
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    await waitFor(() => expect(bridgeMock.directConversations).toHaveBeenCalled());
    act(() => emitCloudSessionChanged("session-b", "changing"));
    await act(async () =>
      resolveBefore({ available: true, viewerId: VIEWER, conversations: [conversation()] }),
    );
    expect(screen.queryByTestId("chats-dm-item")).toBeNull();
    signedIn([
      conversation({ conversationId: "conversation-ana", person: ana, last: sent(4, "ana", "Hi") }),
    ]);
    act(() => emitCloudSessionChanged("session-b", "ready"));
    const row = await screen.findByTestId("chats-dm-item");
    expect(within(row).getByTestId("chats-dm-name").textContent).toBe("Ana Diaz");
  });

  it("marks read only through the newest message on screen", async () => {
    signedIn([conversation({ unread: 1, last: sent(3, "sam", "Running late") })]);
    bridgeMock.directHistory
      .mockResolvedValueOnce({
        conversationId: "conversation-sam",
        messages: [sent(2, "sam", "See you at nine")],
        more: false,
      })
      .mockReturnValue(new Promise(() => {}));
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    await openSam();
    await waitFor(() =>
      expect(bridgeMock.directMarkRead).toHaveBeenCalledWith({
        viewerId: VIEWER,
        conversationId: "conversation-sam",
        seq: 2,
      }),
    );
    expect(bridgeMock.directMarkRead).not.toHaveBeenCalledWith(expect.objectContaining({ seq: 3 }));
  });

  it("names the account that wrote a message when Try again outlives a change of account, so main refuses it", async () => {
    const user = userEvent.setup();
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    bridgeMock.directSend.mockRejectedValueOnce(new Error("relay unreachable"));
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    await openSam();
    await user.type(
      await screen.findByTestId("chats-dm-composer"),
      "From the first account{Enter}",
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [, , tryAgain] = onError.mock.calls.at(-1)!;
    bridgeMock.directConversations.mockResolvedValue({
      available: true,
      viewerId: "someone-else",
      conversations: [],
    });
    act(() => emitCloudSessionChanged("session-other", "ready"));
    await act(async () => (tryAgain as () => void)());
    expect(
      bridgeMock.directSend.mock.calls.map(([input]) => (input as { viewerId: string }).viewerId),
    ).toEqual([VIEWER, VIEWER]);
  });

  it("closes the New message tab once its conversation opens in a tab of its own", async () => {
    signedIn([conversation()]);
    members([{ memberId: "sam", name: "Sam Rivera" }]);
    bridgeMock.directResolve.mockResolvedValue({ conversationId: "conversation-sam", person: sam });
    const onOpenInTab = vi.fn();
    const onCloseTab = vi.fn();
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      editorTabPath: chatTabPath({ kind: "new" }),
      onOpenInTab,
      onCloseTab,
      initialNav: { level: "direct-new", memberId: "sam" },
    });
    await waitFor(() =>
      expect(onOpenInTab).toHaveBeenCalledWith(
        expect.objectContaining({ level: "direct", conversationId: "conversation-sam" }),
      ),
    );
    expect(onCloseTab).toHaveBeenCalledOnce();
  });

  it("files no notice when a conversation can't be read because nobody is signed in", async () => {
    // The session ended between reading the list and reading the conversation.
    bridgeMock.directConversations
      .mockResolvedValueOnce({ available: true, viewerId: VIEWER, conversations: [conversation()] })
      .mockResolvedValue({ available: false });
    bridgeMock.directHistory.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:direct-history': DirectMessageError [direct-signed-out]: Sign in to your server to send direct messages.",
      ),
    );
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    await openSam();
    await screen.findByTestId("chats-dm-signed-out");
    expect(onError).not.toHaveBeenCalled();
  });

  it("hides the other person's name on a conversation after signing out", async () => {
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    const view = await openSam();
    await waitFor(() =>
      expect(within(view).getByTestId("chats-dm-title").textContent).toBe("Sam Rivera"),
    );
    bridgeMock.directConversations.mockResolvedValue({ available: false });
    act(() => emitCloudSessionChanged("session-signed-out", "ready"));
    await screen.findByTestId("chats-dm-signed-out");
    expect(screen.getByTestId("chats-dm-title").textContent).toBe("Direct message");
  });

  it("clears an open conversation when the account changes", async () => {
    signedIn([conversation()]);
    history([sent(1, VIEWER, "Dinner Friday?"), sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    const view = await openSam();
    await waitFor(() => expect(within(view).getAllByTestId("chats-dm-message")).toHaveLength(2));
    bridgeMock.directConversations.mockReturnValue(new Promise(() => {}));
    bridgeMock.directHistory.mockReturnValue(new Promise(() => {}));
    act(() => emitCloudSessionChanged("session-other", "ready"));
    expect(screen.queryAllByTestId("chats-dm-message")).toHaveLength(0);
  });

  it("clears New message's pick and words when the account changes", async () => {
    const user = userEvent.setup();
    signedIn([]);
    members([
      { memberId: "sam", name: "Sam Rivera" },
      { memberId: "ana", name: "Ana Diaz" },
    ]);
    bridgeMock.directResolve.mockResolvedValue({ conversationId: null, person: ana });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "direct-new", memberId: "ana" },
    });
    await waitFor(() => expect(screen.getAllByTestId("chats-dm-new-pick")).toHaveLength(1));
    await user.type(screen.getByTestId("chats-dm-new-composer"), "Written as the first account");
    act(() => emitCloudSessionChanged("session-other", "ready"));
    await waitFor(() =>
      expect((screen.getByTestId("chats-dm-new-composer") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(screen.queryAllByTestId("chats-dm-new-pick")).toHaveLength(0);
  });

  it.each([
    ["direct-final", false],
    ["direct-retry", true],
  ] as const)(
    "reports a %s send failure with Try again only where it can help",
    async (code, offered) => {
      const user = userEvent.setup();
      signedIn([conversation()]);
      history([sent(2, "sam", "See you at nine")]);
      bridgeMock.directSend.mockRejectedValueOnce(
        new Error(
          `Error invoking remote method 'desktop:direct-send': DirectMessageError [${code}]: You can't message this person.`,
        ),
      );
      const onError = vi.fn();
      renderView(vi.fn(), onError, { variant: "panel" });
      await openSam();
      await user.type(await screen.findByTestId("chats-dm-composer"), "Still on?{Enter}");
      await waitFor(() => expect(onError).toHaveBeenCalled());
      expect(typeof onError.mock.calls.at(-1)![2]).toBe(offered ? "function" : "undefined");
    },
  );

  it("keeps the words of a send that failed, and Try again resends them with the same message id", async () => {
    const user = userEvent.setup();
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    bridgeMock.directSend.mockRejectedValueOnce(UNREACHABLE("direct-send"));
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    await openSam();
    const composer = (await screen.findByTestId("chats-dm-composer")) as HTMLTextAreaElement;
    expect(composer.placeholder).toBe("Message Sam Rivera");
    await user.type(composer, "On my way{Enter}");
    await waitFor(() => expect(onError).toHaveBeenCalled());
    // The notice says whose message failed, since the history shows nothing for it.
    expect(onError.mock.calls.at(-1)![4]).toMatchObject({
      title: "Your message to Sam Rivera wasn't sent",
    });
    const first = bridgeMock.directSend.mock.calls[0]![0] as {
      conversationId: string;
      messageId: string;
      body: string;
    };
    expect(first).toMatchObject({
      viewerId: VIEWER,
      conversationId: "conversation-sam",
      body: "On my way",
    });
    // The words stay, and so does the composer, so nothing typed is lost.
    expect(composer.value).toBe("On my way");
    expect(screen.getByTestId("chats-dm-composer")).toBe(composer);

    bridgeMock.directSend.mockResolvedValueOnce({ conversationId: "conversation-sam", seq: 3 });
    const [, , tryAgain] = onError.mock.calls.at(-1)!;
    await act(async () => (tryAgain as () => void)());
    expect(bridgeMock.directSend).toHaveBeenCalledTimes(2);
    expect(bridgeMock.directSend.mock.calls[1]![0]).toEqual(first);
    await waitFor(() => expect(composer.value).toBe(""));
    expect(screen.getAllByTestId("chats-dm-message").at(-1)!.textContent).toContain("On my way");

    // Sending the same words again after they went is a new message.
    bridgeMock.directSend.mockResolvedValueOnce({ conversationId: "conversation-sam", seq: 4 });
    await user.type(composer, "On my way{Enter}");
    await waitFor(() => expect(bridgeMock.directSend).toHaveBeenCalledTimes(3));
    expect((bridgeMock.directSend.mock.calls[2]![0] as { messageId: string }).messageId).not.toBe(
      first.messageId,
    );
  });

  it("blocks from the row menu and unblocks from the conversation", async () => {
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    bridgeMock.directBlock.mockResolvedValue(undefined);
    const onNotice = vi.fn();
    renderView(vi.fn(), vi.fn(), { variant: "panel", onNotice });
    fireEvent.contextMenu(await screen.findByTestId("chats-dm-item"), { clientX: 40, clientY: 60 });
    // The server lists the block once it holds it.
    signedIn([conversation({ person: { ...sam, blocked: true } })]);
    fireEvent.click(await screen.findByTestId("chat-row-menu-block"));
    await waitFor(() =>
      expect(bridgeMock.directBlock).toHaveBeenCalledWith({
        viewerId: VIEWER,
        conversationId: "conversation-sam",
        blocked: true,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("chats-dm-item").dataset.blocked).toBe("true"));
    await openSam();
    const line = await screen.findByTestId("chats-dm-blocked-line");
    expect(line.textContent).toContain("You blocked Sam Rivera. They can't message you.");
    expect(screen.queryByTestId("chats-dm-composer")).toBeNull();
    // The line shows the block where it happened, so no notice repeats it.
    expect(onNotice).not.toHaveBeenCalled();
    signedIn([conversation()]);
    fireEvent.click(within(line).getByTestId("chats-dm-blocked-line-action"));
    await waitFor(() =>
      expect(bridgeMock.directBlock).toHaveBeenLastCalledWith({
        viewerId: VIEWER,
        conversationId: "conversation-sam",
        blocked: false,
      }),
    );
    expect(await screen.findByTestId("chats-dm-composer")).toBeTruthy();
  });

  it("offers Block and Unblock for the other person from the conversation's options", async () => {
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    bridgeMock.directBlock.mockResolvedValue(undefined);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    await openSam();
    fireEvent.click(await screen.findByTestId("chats-dm-options"));
    signedIn([conversation({ person: { ...sam, blocked: true } })]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block Sam Rivera" }));
    await waitFor(() =>
      expect(bridgeMock.directBlock).toHaveBeenCalledWith({
        viewerId: VIEWER,
        conversationId: "conversation-sam",
        blocked: true,
      }),
    );
    fireEvent.click(await screen.findByTestId("chats-dm-options"));
    expect(await screen.findByRole("menuitem", { name: "Unblock Sam Rivera" })).toBeTruthy();
  });

  it("names the account that asked for a block when Try again outlives a change of account, so main refuses it", async () => {
    signedIn([conversation()]);
    history([sent(2, "sam", "See you at nine")]);
    bridgeMock.directBlock.mockRejectedValueOnce(new Error("relay unreachable"));
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    await openSam();
    fireEvent.click(await screen.findByTestId("chats-dm-options"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block Sam Rivera" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [, , tryAgain] = onError.mock.calls.at(-1)!;
    // Sam signs in on this computer; their list has the same conversation.
    bridgeMock.directConversations.mockResolvedValue({
      available: true,
      viewerId: "sam",
      conversations: [conversation()],
    });
    act(() => emitCloudSessionChanged("session-sam", "ready"));
    await waitFor(() => expect(directStoreViewer()).toBe("sam"));
    await act(async () => (tryAgain as () => void)());
    expect(
      bridgeMock.directBlock.mock.calls.map(([input]) => (input as { viewerId: string }).viewerId),
    ).toEqual([VIEWER, VIEWER]);
  });

  it("starts a new message with one person picked from the workspace's members", async () => {
    const user = userEvent.setup();
    signedIn([]);
    members([
      { memberId: "sam", name: "Sam Rivera" },
      { memberId: "ana", name: "Ana Diaz" },
      { memberId: "gone", name: "Gone Person", state: "removed" },
    ]);
    bridgeMock.directResolve.mockImplementation(async ({ memberId }: { memberId: string }) => ({
      conversationId: null,
      person: memberId === "sam" ? sam : ana,
    }));
    bridgeMock.directStart.mockResolvedValue({ conversationId: "conversation-sam", seq: 1 });
    history([sent(1, VIEWER, "Lunch?")]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    fireEvent.click(await screen.findByTestId("chats-new-dm"));
    await screen.findByTestId("chats-dm-new");
    const options = await screen.findAllByTestId("chats-dm-new-member");
    // Active members other than the viewer, by name, never by email.
    expect(options.map((option) => option.dataset.memberId)).toEqual(["ana", "sam"]);
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Ana Diaz"),
      expect.stringContaining("Sam Rivera"),
    ]);
    expect(screen.getByTestId("chats-dm-new").textContent).not.toContain("@");
    expect(
      screen.getByRole("listbox", { name: "Members" }).getAttribute("aria-multiselectable"),
    ).toBeNull();
    // To shows an example of what to type: the first member's first name, the row Enter would pick.
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).placeholder).toBe("Ana");

    // A message without anyone picked asks who it is for.
    const composer = screen.getByTestId("chats-dm-new-composer") as HTMLTextAreaElement;
    await user.type(composer, "Lunch?{Enter}");
    expect(screen.getByText("Choose who to message.")).toBeTruthy();
    expect(bridgeMock.directStart).not.toHaveBeenCalled();

    // Focus stays in To, so the arrow keys scroll the list to keep the active member in view.
    const scrolled: string[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this.getAttribute("data-member-id") ?? "");
      });
    fireEvent.keyDown(screen.getByTestId("chats-dm-recipients"), { key: "ArrowDown" });
    expect(scrolled).toEqual(["sam"]);
    scrollIntoView.mockRestore();
    fireEvent.keyDown(screen.getByTestId("chats-dm-recipients"), { key: "ArrowUp" });

    // Picking another person replaces the pick: a conversation is two people.
    await user.click(options[0]!);
    expect(screen.getAllByTestId("chats-dm-new-pick").map((pick) => pick.dataset.memberId)).toEqual(
      ["ana"],
    );
    // With a pick, To shows no example beside it.
    expect((screen.getByTestId("chats-dm-recipients") as HTMLInputElement).placeholder).toBe("");
    // Keyboard: type to filter, Enter picks.
    await user.type(screen.getByTestId("chats-dm-recipients"), "sam{Enter}");
    expect(screen.getAllByTestId("chats-dm-new-pick").map((pick) => pick.dataset.memberId)).toEqual(
      ["sam"],
    );
    // The whole list is back, and the active row is the pick, not the row that was first in the filter.
    expect(screen.getByTestId("chats-dm-recipients").getAttribute("aria-activedescendant")).toMatch(
      /-sam$/,
    );
    await waitFor(() =>
      expect(bridgeMock.directResolve).toHaveBeenLastCalledWith({
        viewerId: VIEWER,
        workspaceId: "workspace-a",
        memberId: "sam",
      }),
    );
    expect(screen.queryByText("Choose who to message.")).toBeNull();
    expect(composer.placeholder).toBe("Message Sam Rivera");

    await user.click(composer);
    await user.type(composer, "{Enter}");
    await waitFor(() => expect(bridgeMock.directStart).toHaveBeenCalledTimes(1));
    expect(bridgeMock.directStart.mock.calls[0]![0]).toMatchObject({
      viewerId: VIEWER,
      workspaceId: "workspace-a",
      memberId: "sam",
      body: "Lunch?",
    });
    const view = await screen.findByTestId("chats-dm-view");
    expect(view.dataset.conversationId).toBe("conversation-sam");
  });

  it("offers no composer to a person the viewer blocked, as their conversation does, until Unblock", async () => {
    const user = userEvent.setup();
    signedIn([
      conversation({ conversationId: "conversation-ana", person: { ...ana, blocked: true } }),
    ]);
    members([{ memberId: "membership-ana", name: "Ana Diaz" }]);
    // Membership ids differ from account ids; only the resolution knows who is blocked.
    bridgeMock.directResolve
      .mockResolvedValueOnce({
        conversationId: "conversation-ana",
        person: { ...ana, blocked: true },
      })
      .mockResolvedValue({ conversationId: "conversation-ana", person: ana });
    bridgeMock.directBlock.mockResolvedValue(undefined);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    fireEvent.click(await screen.findByTestId("chats-new-dm-action"));
    expect(await screen.findByTestId("chats-dm-new-composer")).toBeTruthy();
    await user.click(await screen.findByTestId("chats-dm-new-member"));
    const line = await screen.findByTestId("chats-dm-new-blocked-line");
    expect(line.textContent).toContain("You blocked Ana Diaz. They can't message you.");
    expect(screen.queryByTestId("chats-dm-new-composer")).toBeNull();
    await user.click(screen.getByTestId("chats-dm-new-blocked-line-action"));
    expect(bridgeMock.directBlock).toHaveBeenCalledWith({
      viewerId: VIEWER,
      conversationId: "conversation-ana",
      blocked: false,
    });
    await waitFor(() => expect(screen.queryByTestId("chats-dm-new-blocked-line")).toBeNull());
    expect(screen.getByTestId("chats-dm-new-composer")).toBeTruthy();
  });

  it("clears New message's blocked line when Unblock works on Try again", async () => {
    const user = userEvent.setup();
    signedIn([
      conversation({ conversationId: "conversation-ana", person: { ...ana, blocked: true } }),
    ]);
    members([{ memberId: "membership-ana", name: "Ana Diaz" }]);
    let unblocked = false;
    bridgeMock.directResolve.mockImplementation(async () => ({
      conversationId: "conversation-ana",
      person: { ...ana, blocked: !unblocked },
    }));
    bridgeMock.directBlock
      .mockRejectedValueOnce(UNREACHABLE("direct-block"))
      .mockImplementation(async () => {
        unblocked = true;
      });
    const onError = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel" });
    fireEvent.click(await screen.findByTestId("chats-new-dm-action"));
    await user.click(await screen.findByTestId("chats-dm-new-member"));
    await user.click(await screen.findByTestId("chats-dm-new-blocked-line-action"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByTestId("chats-dm-new-blocked-line")).toBeTruthy();
    await act(async () => (onError.mock.calls.at(-1)![2] as () => void)());
    await waitFor(() => expect(screen.queryByTestId("chats-dm-new-blocked-line")).toBeNull());
  });

  it("stays in New message when the person starts typing a name before Members' pick resolves", async () => {
    const user = userEvent.setup();
    signedIn([conversation()]);
    members([
      { memberId: "sam", name: "Sam Rivera" },
      { memberId: "ana", name: "Ana Diaz" },
    ]);
    let resolveSam: (value: unknown) => void = () => {};
    bridgeMock.directResolve.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSam = resolve;
      }),
    );
    history([sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "direct-new", memberId: "sam" },
    });
    await waitFor(() => expect(bridgeMock.directResolve).toHaveBeenCalled());
    await user.type(screen.getByTestId("chats-dm-recipients"), "Ana");
    await act(async () => resolveSam({ conversationId: "conversation-sam", person: sam }));
    expect(screen.getByTestId("chats-dm-new")).toBeTruthy();
    expect(screen.queryByTestId("chats-dm-view")).toBeNull();
  });

  it("asks to sync a workspace that is only on this computer, without a failure notice", async () => {
    signedIn([]);
    bridgeMock.workspaceMembers.mockRejectedValue(
      new Error(
        "Error invoking remote method 'desktop:workspace-members': Error [workspace-not-synced]: Sync this workspace before sharing.",
      ),
    );
    const onError = vi.fn();
    const onOpenSettings = vi.fn();
    renderView(vi.fn(), onError, { variant: "panel", onOpenSettings });
    fireEvent.click(await screen.findByTestId("chats-new-dm-action"));
    expect((await screen.findByTestId("chats-dm-new-unsynced")).textContent).toContain(
      "Sync this workspace to message its members.",
    );
    expect(onError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("chats-dm-new-unsynced-action"));
    expect(onOpenSettings).toHaveBeenCalledWith("cloud");
  });

  it("offers the conversation the two of you already have", async () => {
    const user = userEvent.setup();
    signedIn([conversation()]);
    members([{ memberId: "sam", name: "Sam Rivera" }]);
    bridgeMock.directResolve.mockResolvedValue({ conversationId: "conversation-sam", person: sam });
    history([sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), { variant: "panel" });
    fireEvent.click(await screen.findByTestId("chats-new-dm-action"));
    await user.click(await screen.findByTestId("chats-dm-new-member"));
    const existing = await screen.findByTestId("chats-dm-new-existing");
    expect(existing.textContent).toContain("You already have a conversation with Sam Rivera.");
    expect(screen.queryByRole("button", { name: "Mention" })).toBeNull();
    await user.type(screen.getByTestId("chats-dm-new-composer"), "Lunch?");
    fireEvent.click(within(existing).getByTestId("chats-dm-new-open-existing"));
    const view = await screen.findByTestId("chats-dm-view");
    expect(view.dataset.conversationId).toBe("conversation-sam");
    // The words written in New message go along to the conversation.
    await waitFor(() =>
      expect((within(view).getByTestId("chats-dm-composer") as HTMLTextAreaElement).value).toBe(
        "Lunch?",
      ),
    );
    expect(bridgeMock.directStart).not.toHaveBeenCalled();
  });

  it("opens the existing conversation when Members' Message names someone already in one", async () => {
    signedIn([conversation()]);
    members([{ memberId: "sam", name: "Sam Rivera" }]);
    bridgeMock.directResolve.mockResolvedValue({ conversationId: "conversation-sam", person: sam });
    history([sent(2, "sam", "See you at nine")]);
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "direct-new", memberId: "sam" },
    });
    expect((await screen.findByTestId("chats-dm-view")).dataset.conversationId).toBe(
      "conversation-sam",
    );
    expect(screen.queryByTestId("chats-dm-new")).toBeNull();
  });

  it("opens New message with a member already picked, as Members' Message does", async () => {
    signedIn([]);
    members([
      { memberId: "sam", name: "Sam Rivera" },
      { memberId: "ana", name: "Ana Diaz" },
    ]);
    bridgeMock.directResolve.mockResolvedValue({ conversationId: null, person: ana });
    renderView(vi.fn(), vi.fn(), {
      variant: "page",
      initialNav: { level: "direct-new", memberId: "ana" },
    });
    await waitFor(() =>
      expect(
        screen.getAllByTestId("chats-dm-new-pick").map((pick) => pick.dataset.memberId),
      ).toEqual(["ana"]),
    );
    expect((screen.getByTestId("chats-dm-new-composer") as HTMLTextAreaElement).placeholder).toBe(
      "Message Ana Diaz",
    );
  });
});
