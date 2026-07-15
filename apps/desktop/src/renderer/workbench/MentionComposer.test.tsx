// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "./MentionComposer";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { useState } from "react";

const candidates: MentionCandidate[] = [
  { id: "agent:default", kind: "agent", handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user", handle: "you", label: "You", description: "you" },
];

// A tiny controlled harness so the composer behaves like it does in ChatsView
// (parent owns the value).
function Harness(props: { onSend?: () => void; onEscape?: () => void }) {
  const [value, setValue] = useState("");
  return (
    <MentionComposer
      testIdPrefix="chats"
      composerId="chats-composer"
      value={value}
      sending={false}
      placeholder="Write a message…"
      sendLabel="Send message"
      candidates={candidates}
      onChange={setValue}
      onSend={props.onSend ?? (() => {})}
      {...(props.onEscape ? { onEscape: props.onEscape } : {})}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MentionComposer autocomplete", () => {
  it("opens the roster when the caret enters an @-token and filters by query", async () => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "hey @");
    const menu = await screen.findByTestId("chats-mention-menu");
    // Both candidates offered; the agent leads.
    const options = within(menu).getAllByTestId("chats-mention-option");
    expect(options.map((el) => el.getAttribute("data-candidate-id"))).toEqual([
      "agent:default",
      "user:you",
    ]);

    // "@agent" filters to exactly the agent (the user handle shares no prefix).
    await userEvent.type(composer, "gent");
    expect(
      within(screen.getByTestId("chats-mention-menu"))
        .getAllByTestId("chats-mention-option")
        .map((el) => el.getAttribute("data-candidate-id")),
    ).toEqual(["agent:default"]);
  });

  it("ranks the exact handle first when queries overlap (you vs your agent)", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByTestId("chats-composer"), "@you");
    const options = within(screen.getByTestId("chats-mention-menu")).getAllByTestId(
      "chats-mention-option",
    );
    // Both share the "you" prefix; the exact user handle leads.
    expect(options[0]!.getAttribute("data-candidate-id")).toBe("user:you");
  });

  it("completes with Enter and does NOT send while the menu is open", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "hey @ag");
    await screen.findByTestId("chats-mention-menu");
    await userEvent.keyboard("{Enter}");
    expect(composer.value).toBe("hey @agent ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chats-mention-menu")).toBeNull();
  });

  it("sends on Enter when no mention menu is open", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "just a message");
    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("completes a mention by clicking an option", async () => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "@yo");
    const menu = await screen.findByTestId("chats-mention-menu");
    const userOption = within(menu)
      .getAllByTestId("chats-mention-option")
      .find((el) => el.getAttribute("data-candidate-id") === "user:you")!;
    await userEvent.click(userOption);
    expect(composer.value).toBe("@you ");
  });

  it("does not accept a candidate or send on Enter while IME composing (menu open)", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "hey @ag");
    await screen.findByTestId("chats-mention-menu");
    // Enter fired mid-composition (isComposing) must be a no-op: the composed
    // characters are being confirmed, not a mention accept or a send.
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(composer.value).toBe("hey @ag");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chats-mention-menu")).not.toBeNull();
  });

  it("does not send on Enter while IME composing (no menu)", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "hello");
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("exposes combobox/listbox roles for assistive tech", async () => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer");
    expect(composer.getAttribute("role")).toBe("combobox");
    await userEvent.type(composer, "@");
    const menu = await screen.findByRole("listbox");
    expect(menu.getAttribute("aria-label")).toBe("Mention a person, agent, or file");
    expect(composer.getAttribute("aria-expanded")).toBe("true");
  });
});
