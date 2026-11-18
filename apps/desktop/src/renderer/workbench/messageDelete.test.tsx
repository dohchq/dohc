// @vitest-environment jsdom
import "../../testing/legendListMock";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MembersRequest, MembersResult } from "@dohc/cli/members";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { ChatMessageList, type ChatMessageListHandle } from "./chatMessages";
import { MessageDeleteRole, useMessageDelete } from "./messageDelete";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = 1_700_000_000_000;
const mine: ChatMessageRecord = {
  presentation: { group: "fixture", hue: null, self: true },
  id: "message-mine",
  threadId: "thread-1",
  authorKind: "human",
  authorDisplayName: "You",
  authorUserId: "user-me",
  body: "My plan",
  createdAtMs: at,
};
const theirs: ChatMessageRecord = {
  ...mine,
  presentation: { group: "fixture", hue: null, self: false },
  id: "message-theirs",
  authorDisplayName: "Sam",
  authorUserId: "user-sam",
  body: "Sam's plan",
  createdAtMs: at + 600_000,
};
const deleted: ChatMessageRecord = {
  ...theirs,
  id: "message-deleted",
  body: "",
  attachments: [],
  createdAtMs: at + 1_200_000,
  deletedAtMs: at + 1_300_000,
};

type Role = "owner" | "admin" | "member";
const view = (role: Role): MembersResult => ({
  status: "ready",
  view: {
    workspaceId: "relay-ws",
    workspaceName: "Trip",
    viewer: { memberId: role === "owner" ? "owner" : "member-me", role },
    memberLevel: "edit",
    inviteLink: role === "member" ? null : { enabled: false, url: null },
    people: [],
  },
});

// The bridge's Members action: a list answers with the role, and each delete
// waits for the test to answer it.
function stubMembers(list: () => Promise<MembersResult>) {
  const deletes: Array<{
    request: MembersRequest;
    answer: ReturnType<typeof deferred<MembersResult>>;
  }> = [];
  const workspaceMembers = vi.fn(
    (input: { workspaceId: string; request: MembersRequest }): Promise<MembersResult> => {
      if (input.request.action === "list") return list();
      const answer = deferred<MembersResult>();
      deletes.push({ request: input.request, answer });
      return answer.promise;
    },
  );
  vi.stubGlobal("dohcDesktop", { workspaceMembers });
  return { workspaceMembers, deletes };
}

function Chat(props: { messages: ChatMessageRecord[]; enabled?: boolean }) {
  const remove = useMessageDelete({
    workspaceId: "ws",
    viewerAuthorId: "user-me",
    enabled: props.enabled ?? true,
  });
  return (
    <>
      <ChatMessageList
        testIdPrefix="chat"
        messages={props.messages}
        loading={false}
        emptyLabel="No messages"
        listRef={createRef<ChatMessageListHandle>()}
        reactionControls={{
          reactions: [
            {
              reactionId: "r1",
              messageId: "message-deleted",
              threadId: "thread-1",
              emoji: "👍",
              authorId: "user-sam",
              authorKind: "human",
              authorDisplayName: "Sam",
            },
          ],
          viewerAuthorId: "user-me",
          onToggle: () => {},
        }}
        rowActions={(message) => remove.action(message, "chat-delete")}
      />
      {remove.dialog}
    </>
  );
}

function renderChat(messages: ChatMessageRecord[], enabled?: boolean) {
  return render(
    <WorkspaceSessionProvider workspaceId="ws">
      <MessageDeleteRole workspaceId="ws">
        <Chat messages={messages} enabled={enabled} />
      </MessageDeleteRole>
    </WorkspaceSessionProvider>,
  );
}

const row = (id: string) =>
  screen.getAllByTestId("chat-message").find((element) => element.dataset.messageId === id)!;
const deleteIn = (id: string) => within(row(id)).queryByTestId("chat-delete");

describe("Delete on a message", () => {
  it("shows a member Delete only on their own messages", async () => {
    stubMembers(async () => view("member"));
    renderChat([mine, theirs]);
    await waitFor(() => expect(deleteIn("message-mine")).not.toBeNull());
    expect(deleteIn("message-theirs")).toBeNull();
  });

  it.each(["owner", "admin"] as const)("shows the %s Delete on every message", async (role) => {
    stubMembers(async () => view(role));
    renderChat([mine, theirs]);
    await waitFor(() => expect(deleteIn("message-theirs")).not.toBeNull());
    expect(deleteIn("message-mine")).not.toBeNull();
  });

  it("offers no Delete in a workspace that never synced, or in a chat with an agent", async () => {
    const { workspaceMembers } = stubMembers(() =>
      Promise.reject(new Error("This workspace doesn't sync yet.")),
    );
    const view1 = renderChat([mine, theirs]);
    await waitFor(() => expect(workspaceMembers).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(deleteIn("message-mine")).toBeNull();
    view1.unmount();

    stubMembers(async () => view("owner"));
    renderChat([mine, theirs], false);
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteIn("message-mine")).toBeNull();
    expect(deleteIn("message-theirs")).toBeNull();
  });

  it("shows a deleted message as its author, time and line, with nothing it held", async () => {
    stubMembers(async () => view("owner"));
    renderChat([theirs, deleted]);
    await waitFor(() => expect(deleteIn("message-theirs")).not.toBeNull());
    const line = row("message-deleted");
    expect(within(line).getByTestId("chat-message-deleted").textContent).toBe("Message deleted");
    expect(within(line).queryByTestId("chat-message-body")).toBeNull();
    // No reactions, no hover bar, so no Delete or Copy on it.
    expect(within(line).queryByTestId("chat-message-reactions")).toBeNull();
    expect(within(line).queryByTestId("chat-message-toolbar")).toBeNull();
    expect(within(line).queryByTestId("chat-delete")).toBeNull();
  });

  it("asks, shows progress, and closes when the relay deletes", async () => {
    const { deletes } = stubMembers(async () => view("member"));
    renderChat([mine]);
    await waitFor(() => expect(deleteIn("message-mine")).not.toBeNull());
    fireEvent.click(deleteIn("message-mine")!);

    const dialog = screen.getByTestId("message-delete");
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete this message?");
    expect(dialog.textContent).toContain("People who already read it may keep a copy.");
    const confirm = screen.getByTestId("message-delete-confirm") as HTMLButtonElement;
    expect(document.activeElement).toBe(confirm);
    // The message stays as it is until the relay answers.
    expect(within(row("message-mine")).getByTestId("chat-message-body").textContent).toContain(
      "My plan",
    );

    fireEvent.click(confirm);
    expect(confirm.textContent).toBe("Deleting…");
    expect(confirm.disabled).toBe(true);
    expect((screen.getByTestId("message-delete-cancel") as HTMLButtonElement).disabled).toBe(true);
    expect(deletes.map((sent) => sent.request)).toEqual([
      { action: "deleteMessage", threadId: "thread-1", messageId: "message-mine" },
    ]);
    // Escape doesn't close it while the delete runs.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByTestId("message-delete")).not.toBeNull();

    deletes[0]!.answer.resolve({ status: "done" });
    await waitFor(() => expect(screen.queryByTestId("message-delete")).toBeNull());
  });

  it.each([
    ["a refusal", "You can no longer delete it."],
    ["no connection", "Deleting needs a connection."],
  ])("shows %s in the dialog with Try again", async (_case, words) => {
    const { deletes } = stubMembers(async () => view("member"));
    renderChat([mine]);
    await waitFor(() => expect(deleteIn("message-mine")).not.toBeNull());
    fireEvent.click(deleteIn("message-mine")!);
    fireEvent.click(screen.getByTestId("message-delete-confirm"));
    deletes[0]!.answer.reject(new Error(words));

    const error = await screen.findByTestId("message-delete-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(`Couldn't delete the message. ${words}`);
    const retry = screen.getByTestId("message-delete-confirm") as HTMLButtonElement;
    expect(retry.textContent).toBe("Try again");
    expect(retry.disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(retry));
    // Nothing changed on this computer, so the message still shows.
    expect(within(row("message-mine")).getByTestId("chat-message-body").textContent).toContain(
      "My plan",
    );

    fireEvent.click(retry);
    expect(deletes).toHaveLength(2);
    expect(screen.queryByTestId("message-delete-error")).toBeNull();
    deletes[1]!.answer.resolve({ status: "done" });
    await waitFor(() => expect(screen.queryByTestId("message-delete")).toBeNull());
  });
});
