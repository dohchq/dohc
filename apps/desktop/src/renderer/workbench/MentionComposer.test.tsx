// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionComposer } from "./MentionComposer";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import type { WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import { useState } from "react";
import { inListView, mockListLayout } from "../ui/listLayout.testSupport";

const candidates: MentionCandidate[] = [
  { id: "agent:default", kind: "agent", handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user", handle: "you", label: "You", description: "you" },
];

// A tiny controlled harness so the composer behaves like it does in ChatsView
// (parent owns the value).
function Harness(props: {
  fileCandidates?: { path: string; label: string }[];
  onSend?: () => void;
  onRosterPick?: (pick: import("../offers/agentAddressed").AgentRosterPick | null) => void;
  onEscape?: () => void;
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  surface?: "post";
}) {
  const [value, setValue] = useState("");
  return (
    <MentionComposer
      {...(props.surface ? { surface: props.surface, authorName: "You" } : {})}
      testIdPrefix="chats"
      composerId="chats-composer"
      value={value}
      sending={false}
      placeholder="Write a message…"
      sendLabel="Send message"
      candidates={candidates}
      fileCandidates={props.fileCandidates ?? [{ path: "docs/plan.md", label: "Plan" }]}
      {...(props.loadFileHeadings
        ? { loadFileHeadings: props.loadFileHeadings }
        : {})}
      onRosterPick={props.onRosterPick}
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

  it("completes with Enter and does not send while the menu is open", async () => {
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

  it.each([
    ["darwin", "closes the menu and leaves the line break to the textarea", false],
    ["win32", "completes the highlighted mention", true],
  ] as const)("Option+Return with the mention menu open on %s %s", async (platform, _result, completes) => {
    vi.stubGlobal("dohcDesktop", { platform });
    try {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
      await userEvent.type(composer, "hey @ag");
      await screen.findByTestId("chats-mention-menu");
      const event = new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true });
      fireEvent(composer, event);
      expect(event.defaultPrevented).toBe(completes);
      expect(composer.value).toBe(completes ? "hey @agent " : "hey @ag");
      expect(screen.queryByTestId("chats-mention-menu") !== null).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts a new line on Option+Return on macOS instead of sending", async () => {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    try {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} />);
      const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
      await userEvent.type(composer, "hello");
      fireEvent.keyDown(composer, { key: "Enter", altKey: true });
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
    const menu = await screen.findByRole("listbox", { hidden: true });
    expect(menu.getAttribute("aria-label")).toBe("Mention a person, agent, or file");
    expect(composer.getAttribute("aria-expanded")).toBe("true");
    const options = within(menu).getAllByRole("option", { hidden: true });
    expect(composer.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(composer.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
  });

  // jsdom's viewport is 1024 by 768. The menu is a fixed popover anchored to
  // the composer: below it when there is room, otherwise above.
  it.each([
    { name: "below a composer near the top", top: 500, menuTop: 566 },
    { name: "above a composer at the bottom", top: 700, menuTop: 692 },
  ])("floats the roster $name", async ({ top, menuTop }) => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer");
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(new DOMRect(40, top, 300, 60));
    await userEvent.type(composer, "@");
    const menu = await screen.findByTestId("chats-mention-menu");
    expect(menu.getAttribute("popover")).toBe("manual");
    expect(menu.className).toContain("fixed");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe(`${menuTop}px`);
    expect(menu.style.maxHeight).toBe("192px");
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

  it("offers the file choices from the File button", async () => {
    render(<Harness surface="post" />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.click(screen.getByTestId("chats-open"));
    await userEvent.click(await screen.findByRole("button", { name: "Attach a file" }));
    const fileOption = await screen.findByTestId("chats-file-mention-option");
    expect(composer.getAttribute("aria-activedescendant")).toBe(fileOption.id);
    expect(fileOption.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByTestId("chats-file-mention-option"));
    await userEvent.click(await screen.findByTestId("chats-file-mention-whole"));
    expect((composer as HTMLTextAreaElement).value).toContain("@[docs/plan.md]");
  });

  it("offers the file choices from the chat's +", async () => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.click(screen.getByTestId("chats-add"));
    await userEvent.click(screen.getByTestId("chats-attach-page"));
    const fileOption = await screen.findByTestId("chats-file-mention-option");
    expect(composer.getAttribute("aria-activedescendant")).toBe(fileOption.id);
    expect(fileOption.getAttribute("aria-selected")).toBe("true");
  });

  it("gives the File trigger its own word after ordinary text", async () => {
    render(<Harness />);
    const composer = screen.getByTestId("chats-composer");
    await userEvent.type(composer, "See this");
    await userEvent.click(screen.getByTestId("chats-add"));
    await userEvent.click(screen.getByTestId("chats-attach-page"));
    expect((composer as HTMLTextAreaElement).value).toBe("See this @");
    await screen.findByTestId("chats-file-mention-option");
  });

  it("keeps the collapsed prompt on one line inside its pill", async () => {
    render(<Harness surface="post" />);
    const pill = screen.getByTestId("chats-open");
    // A narrow channel column used to wrap this prompt past the pill's fixed
    // height; it now shortens inside the border and the tooltip carries it.
    expect(within(pill).getByText("Write a message…").className).toContain("truncate");
    expect(pill.getAttribute("title")).toBe("Write a message…");
    // Shortening the text costs the pill neither its name nor its job.
    expect(pill.getAttribute("aria-label")).toBe("Write a post");
    await userEvent.click(pill);
    expect(document.activeElement).toBe(screen.getByTestId("chats-composer"));
  });
});

// Two people and six files fill more than the menu's height. The textarea
// keeps focus while the arrows move the active option.
describe("MentionComposer menu on the Menu part's recipe", () => {
  const files = Array.from({ length: 6 }, (_, index) => ({ path: `docs/file-${index + 1}.md`, label: `File ${index + 1}` }));

  it("keeps the active option in the list's view as the arrows move it", async () => {
    const restore = mockListLayout(120);
    try {
      render(<Harness fileCandidates={files} />);
      await userEvent.type(screen.getByTestId("chats-composer"), "@");
      const menu = await screen.findByTestId("chats-mention-menu");
      const options = [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options).toHaveLength(8);
      await userEvent.keyboard("{ArrowUp}");
      const last = options.at(-1)!;
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(inListView(menu, last)).toBe(true);
      await userEvent.keyboard("{ArrowDown}");
      expect(inListView(menu, options[0]!)).toBe(true);
    } finally {
      restore();
    }
  });

  // The @ shows as an icon; a screen reader still hears it, so a person or
  // an agent never reads like a file.
  it("keeps @ in a person's or agent's name", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByTestId("chats-composer"), "@");
    const menu = await screen.findByTestId("chats-mention-menu");
    // The menu is a popover, which jsdom leaves out of the accessibility tree.
    const agent = within(menu).getByRole("option", { hidden: true, name: /^@agent/ });
    const user = within(menu).getByRole("option", { hidden: true, name: "@you" });
    expect(agent.getAttribute("data-candidate-id")).toBe("agent:default");
    expect(user.getAttribute("data-candidate-id")).toBe("user:you");
  });

  it("takes the active option only from a pointer that moves", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByTestId("chats-composer"), "@");
    const menu = await screen.findByTestId("chats-mention-menu");
    const second = menu.querySelectorAll<HTMLElement>('[role="option"]')[1]!;
    fireEvent.mouseMove(second, { movementX: 0, movementY: 0 });
    expect(second.hasAttribute("data-active")).toBe(false);
    fireEvent.mouseMove(second, { movementX: 0, movementY: 2 });
    expect(second.hasAttribute("data-active")).toBe(true);
  });
});


describe("offer roster picks", () => {
  it("emits an agent pick only on roster completion and clears it when removed", async () => {
    const onRosterPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onRosterPick={onRosterPick} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await user.type(composer, "@agent");
    expect(onRosterPick).not.toHaveBeenCalled();
    await user.click(screen.getAllByTestId("chats-mention-option")[0]!);
    expect(onRosterPick).toHaveBeenLastCalledWith({ candidate: candidates[0], from: 0, to: 6 });
    composer.focus();
    composer.setSelectionRange(0, 6);
    await user.keyboard("{Backspace}");
    expect(onRosterPick).toHaveBeenLastCalledWith(null);
  });
  it("moves the picked span when text is inserted before it", async () => {
    const onRosterPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onRosterPick={onRosterPick} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await user.type(composer, "@ag");
    await user.click(screen.getAllByTestId("chats-mention-option")[0]!);
    composer.focus(); composer.setSelectionRange(0, 0);
    await user.paste("Hi ");
    expect(onRosterPick).toHaveBeenLastCalledWith({ candidate: candidates[0], from: 3, to: 9 });
  });
});

describe("agent pick continuity", () => {
  it("keeps the picked agent when a person is picked, and clears it when the agent mention is removed", async () => {
    const onRosterPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onRosterPick={onRosterPick} />);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    await user.type(composer, "@ag");
    await user.click(screen.getAllByTestId("chats-mention-option")[0]!);
    await user.type(composer, "and @yo");
    await user.click(screen.getAllByTestId("chats-mention-option").find(option => option.getAttribute("data-candidate-id") === "user:you")!);
    expect(composer.value).toBe("@agent and @you ");
    expect(onRosterPick).toHaveBeenLastCalledWith({ candidate: candidates[0], from: 0, to: 6 });
    composer.focus(); composer.setSelectionRange(0, 7);
    await user.keyboard("{Backspace}");
    expect(onRosterPick).toHaveBeenLastCalledWith(null);
  });
});
