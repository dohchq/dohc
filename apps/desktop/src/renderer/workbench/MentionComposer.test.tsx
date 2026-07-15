// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "./MentionComposer";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { useState } from "react";

const candidates: MentionCandidate[] = [
  { id: "agent:default", kind: "agent", handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user", handle: "you", label: "You", description: "you" },
];

// A tiny controlled harness so the composer behaves like it does in ChatsView
// (parent owns the value).
function Harness(props: {
  onSend?: () => void;
  onEscape?: () => void;
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
}) {
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
      fileCandidates={[{ path: "docs/plan.md", label: "Plan" }]}
      {...(props.loadFileHeadings
        ? { loadFileHeadings: props.loadFileHeadings }
        : {})}
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
    const options = within(menu).getAllByRole("option");
    expect(composer.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(composer.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
  });

  it("tracks the active file and heading option for assistive tech", async () => {
    render(
      <Harness
        loadFileHeadings={() =>
          Promise.resolve([
            { text: "Scope", anchor: "scope", line: 3, level: 2, occurrence: 0 },
          ])
        }
      />,
    );
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "@plan");
    await userEvent.click(await screen.findByTestId("chats-file-mention-option"));
    const wholeFile = await screen.findByTestId("chats-file-mention-whole");
    expect(composer.getAttribute("aria-activedescendant")).toBe(wholeFile.id);

    const heading = await screen.findByTestId("chats-file-mention-heading");
    await userEvent.keyboard("{ArrowDown}");
    expect(composer.getAttribute("aria-activedescendant")).toBe(heading.id);
  });

  it("invalidates a pending heading load when Escape closes the file stage", async () => {
    let resolveHeadings!: (headings: readonly WorkspaceHeadingRecord[]) => void;
    const headings = new Promise<readonly WorkspaceHeadingRecord[]>((resolve) => {
      resolveHeadings = resolve;
    });
    render(<Harness loadFileHeadings={() => headings} />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "@plan");
    await userEvent.click(await screen.findByTestId("chats-file-mention-option"));
    await screen.findByTestId("chats-file-mention-whole");

    await userEvent.keyboard("{Escape}");
    resolveHeadings([
      { text: "Stale", anchor: "stale", line: 1, level: 1, occurrence: 0 },
    ]);
    await headings;
    expect(screen.queryByTestId("chats-file-mention-heading")).toBeNull();
  });

  it("invalidates pending headings on blur and loader/workspace changes", async () => {
    let resolveOld!: (headings: readonly WorkspaceHeadingRecord[]) => void;
    const oldHeadings = new Promise<readonly WorkspaceHeadingRecord[]>((resolve) => {
      resolveOld = resolve;
    });
    const oldLoader = () => oldHeadings;
    const newLoader = () => Promise.resolve<readonly WorkspaceHeadingRecord[]>([]);
    const { rerender } = render(<Harness loadFileHeadings={oldLoader} />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "@plan");
    await userEvent.click(await screen.findByTestId("chats-file-mention-option"));
    await screen.findByTestId("chats-file-mention-whole");

    rerender(<Harness loadFileHeadings={newLoader} />);
    fireEvent.blur(composer);
    resolveOld([
      { text: "Old workspace", anchor: "old", line: 1, level: 1, occurrence: 0 },
    ]);
    await oldHeadings;
    expect(screen.queryByTestId("chats-mention-menu")).toBeNull();
    expect(screen.queryByTestId("chats-file-mention-heading")).toBeNull();
  });
});
