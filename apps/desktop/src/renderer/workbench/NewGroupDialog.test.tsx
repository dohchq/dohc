// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { NewGroupDialog } from "./NewGroupDialog";

afterEach(cleanup);

const nameField = () => screen.getByTestId("chats-new-channel-name") as HTMLInputElement;

describe("NewGroupDialog", () => {
  it("starts in Name with Chat picked and Create off until there's a name", () => {
    render(<NewGroupDialog onCreate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("heading").textContent).toBe("New Group");
    expect(screen.getByTestId("chats-new-channel-submit").textContent).toBe("Create Group");
    expect(document.activeElement).toBe(nameField());
    // Optional follows the label; the field holds no placeholder.
    const purpose = screen.getByLabelText("What it's for Optional");
    expect(purpose).toBe(screen.getByTestId("chats-new-channel-purpose"));
    expect(purpose.hasAttribute("placeholder")).toBe(false);
    expect(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(nameField(), { target: { value: "launch" } });
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says a name is missing when Enter is pressed without one, and creates nothing", () => {
    const onCreate = vi.fn();
    render(<NewGroupDialog onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId("chats-new-channel-purpose"), { key: "Enter" });
    expect(screen.getByTestId("chats-new-channel-name-error").textContent).toBe(
      "Give the Group a name.",
    );
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(nameField());
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(nameField(), { target: { value: "l" } });
    expect(screen.queryByTestId("chats-new-channel-name-error")).toBeNull();
  });

  it("moves between kinds with the arrow keys and creates on Enter from a card", async () => {
    const onCreate = vi.fn(async () => null);
    render(<NewGroupDialog onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: " launch " } });
    fireEvent.change(screen.getByTestId("chats-new-channel-purpose"), {
      target: { value: " Ship it " },
    });
    const chat = screen.getByRole("radio", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    const posts = screen.getByRole("radio", { name: "Posts" });
    expect(posts.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(posts);
    fireEvent.keyDown(posts, { key: "Enter" });
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ name: "launch", type: "posts", purpose: "Ship it" }),
    );
  });

  it("keeps what was typed and says why above Create when the group can't be made", async () => {
    const pending = deferred<string | null>();
    const onCreate = vi.fn(() => pending.promise);
    render(<NewGroupDialog onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: "launch" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledOnce();
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    pending.resolve("dohc couldn't create launch.");
    expect((await screen.findByTestId("chats-new-channel-error")).textContent).toBe(
      "dohc couldn't create launch.",
    );
    expect(nameField().value).toBe("launch");
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("closes from Cancel", () => {
    const onClose = vi.fn();
    render(<NewGroupDialog onCreate={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("chats-new-channel-cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends a picked Members level, and none while the Group follows the member level", async () => {
    const onCreate = vi.fn(async () => null);
    render(
      <NewGroupDialog
        onCreate={onCreate}
        access={async () => ({ memberLevel: "comment" })}
        onClose={vi.fn()}
      />,
    );
    const followed = await screen.findByRole("radio", { name: "Default" });
    expect(followed.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("chats-group-access-follows").textContent).toBe(
      "Follows the member level, Comment, so members can post.",
    );
    fireEvent.change(nameField(), { target: { value: "Announcements" } });
    fireEvent.click(screen.getByTestId("chats-new-channel-submit"));
    await waitFor(() =>
      expect(onCreate).toHaveBeenLastCalledWith({
        name: "Announcements",
        type: "chat",
        purpose: "",
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "View only" }));
    fireEvent.click(screen.getByTestId("chats-new-channel-submit"));
    await waitFor(() =>
      expect(onCreate).toHaveBeenLastCalledWith({
        name: "Announcements",
        type: "chat",
        purpose: "",
        level: "view",
      }),
    );
  });

  it("follows the member level again when the pick comes back to Default", async () => {
    const onCreate = vi.fn(async () => null);
    render(
      <NewGroupDialog
        onCreate={onCreate}
        access={async () => ({ memberLevel: "view" })}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("radio", { name: "No access" }));
    fireEvent.click(screen.getByRole("radio", { name: "Default" }));
    fireEvent.change(nameField(), { target: { value: "Announcements" } });
    fireEvent.click(screen.getByTestId("chats-new-channel-submit"));
    await waitFor(() =>
      expect(onCreate).toHaveBeenLastCalledWith({
        name: "Announcements",
        type: "chat",
        purpose: "",
      }),
    );
    expect(screen.getByTestId("chats-group-access-follows")).toBeTruthy();
  });

  it("says members will see the Group with no connection, and has no picker until someone else is here", async () => {
    render(<NewGroupDialog onCreate={vi.fn()} access={async () => "offline"} onClose={vi.fn()} />);
    expect((await screen.findByTestId("chats-new-channel-access-offline")).textContent).toBe(
      "Members will see this Group. Choose access in Group settings once you're connected.",
    );
    expect(screen.queryByRole("radio", { name: "No access" })).toBeNull();
    cleanup();
    const alone = deferred<null>();
    render(<NewGroupDialog onCreate={vi.fn()} access={() => alone.promise} onClose={vi.fn()} />);
    alone.resolve(null);
    await alone.promise;
    expect(screen.queryByTestId("chats-new-channel-access")).toBeNull();
  });
});
