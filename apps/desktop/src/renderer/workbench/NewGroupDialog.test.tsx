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
    expect(document.activeElement).toBe(nameField());
    expect(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: "launch" } });
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says a name is missing when Enter is pressed without one, and creates nothing", () => {
    const onCreate = vi.fn();
    render(<NewGroupDialog onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByTestId("chats-new-channel-purpose"), { key: "Enter" });
    expect(screen.getByTestId("chats-new-channel-name-error").textContent).toBe("Give the group a name.");
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
    fireEvent.change(screen.getByTestId("chats-new-channel-purpose"), { target: { value: " Ship it " } });
    const chat = screen.getByRole("radio", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    const posts = screen.getByRole("radio", { name: "Posts" });
    expect(posts.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(posts);
    fireEvent.keyDown(posts, { key: "Enter" });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: "launch", type: "posts", purpose: "Ship it" }));
  });

  it("keeps what was typed and says why above Create when the group can't be made", async () => {
    const pending = deferred<string | null>();
    const onCreate = vi.fn(() => pending.promise);
    render(<NewGroupDialog onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.change(nameField(), { target: { value: "launch" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledOnce();
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(true);
    pending.resolve("dohc could not create launch.");
    expect((await screen.findByTestId("chats-new-channel-error")).textContent).toBe("dohc could not create launch.");
    expect(nameField().value).toBe("launch");
    expect((screen.getByTestId("chats-new-channel-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes from Cancel", () => {
    const onClose = vi.fn();
    render(<NewGroupDialog onCreate={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("chats-new-channel-cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
