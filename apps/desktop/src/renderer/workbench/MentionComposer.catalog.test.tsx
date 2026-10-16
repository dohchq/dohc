// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { MentionComposer } from "./MentionComposer";
import { activeCatalogQuery, pollChoicesToSend, repeatedPollChoices, type PollDraft } from "./chatPoll";

const candidates: MentionCandidate[] = [
  { id: "agent:default", kind: "agent", handle: "agent", label: "Your agent", description: "your agent" },
  { id: "user:you", kind: "user", handle: "you", label: "You", description: "you" },
];

function Harness(props: {
  offersPoll?: boolean;
  initialValue?: string;
  initialPoll?: PollDraft | null;
  surface?: "post";
  onSend?: () => void;
  onEscape?: () => void;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  const [poll, setPoll] = useState<PollDraft | null>(props.initialPoll ?? null);
  return (
    <>
      <MentionComposer
        {...(props.surface ? { surface: props.surface, authorName: "You" } : {})}
        testIdPrefix="chats"
        composerId="chats-composer"
        value={value}
        sending={false}
        placeholder="Write a message…"
        sendLabel="Send message"
        candidates={candidates}
        fileCandidates={[{ path: "docs/plan.md", label: "Plan" }]}
        onChange={setValue}
        onSend={props.onSend ?? (() => {})}
        {...(props.onEscape ? { onEscape: props.onEscape } : {})}
        {...(props.offersPoll === false ? {} : { poll, onPollChange: setPoll })}
      />
      <output data-testid="poll-state">{JSON.stringify(poll)}</output>
    </>
  );
}

const composer = () => screen.getByTestId("chats-composer") as HTMLTextAreaElement;
const rows = () =>
  within(screen.getByTestId("chats-catalog"))
    .getAllByTestId("chats-catalog-option")
    .map((row) => row.getAttribute("data-row"));
const choices = () => screen.getAllByTestId("chats-poll-choice") as HTMLInputElement[];
const pollState = () => JSON.parse(screen.getByTestId("poll-state").textContent ?? "null") as string[] | null;
const send = () => screen.getByTestId("chats-send") as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the / query", () => {
  it("starts only at the start of a word", () => {
    expect(activeCatalogQuery("/", 1)).toEqual({ start: 0, query: "" });
    expect(activeCatalogQuery("Lunch? /po", 10)).toEqual({ start: 7, query: "po" });
    expect(activeCatalogQuery("one\n/poll", 9)).toEqual({ start: 4, query: "poll" });
    expect(activeCatalogQuery("https://", 8)).toBeNull();
    expect(activeCatalogQuery("a/b", 3)).toBeNull();
    expect(activeCatalogQuery("a/", 2)).toBeNull();
    expect(activeCatalogQuery("@agent/", 7)).toBeNull();
    expect(activeCatalogQuery("@/", 2)).toBeNull();
    expect(activeCatalogQuery("/usr/bin", 8)).toBeNull();
    // The caret, not the end of the text, ends the query.
    expect(activeCatalogQuery("/po later", 3)).toEqual({ start: 0, query: "po" });
    expect(activeCatalogQuery("/po later", 9)).toBeNull();
  });

  it("needs its word to end at the caret, so a path's start is not a query", () => {
    expect(activeCatalogQuery("/poll/results.md", 5)).toBeNull();
    expect(activeCatalogQuery("see /pollresults", 9)).toBeNull();
    expect(activeCatalogQuery("/poll\nnext line", 5)).toEqual({ start: 0, query: "poll" });
  });

  it("does not open a poll from the start of a path", async () => {
    render(<Harness initialValue="/poll/results.md" />);
    const node = composer();
    node.focus();
    node.setSelectionRange(5, 5);
    fireEvent.click(node);
    expect(screen.queryByTestId("chats-catalog")).toBeNull();
    fireEvent.keyDown(node, { key: "Enter" });
    expect(pollState()).toBeNull();
  });

  it.each(["https://", "a/b", "@agent/"])("never opens the catalog for %s", async (typed) => {
    render(<Harness />);
    await userEvent.type(composer(), typed);
    expect(screen.queryByTestId("chats-catalog")).toBeNull();
  });
});

describe("the / catalog", () => {
  it("opens on / with Poll, Person or agent, and File or heading", async () => {
    render(<Harness />);
    await userEvent.type(composer(), "Lunch? /");
    expect(rows()).toEqual(["poll", "mention", "file"]);
    const catalog = screen.getByTestId("chats-catalog");
    expect(catalog.getAttribute("role")).toBe("listbox");
    expect(within(catalog).getByText("/poll").tagName).toBe("KBD");
    expect(within(catalog).getByText("@").tagName).toBe("KBD");
    // `[[` does not work in the composer, so File or heading shows no key.
    expect(within(catalog).queryByText("[[")).toBeNull();
    expect(composer().getAttribute("aria-activedescendant")).toBe("chats-composer-mentions-catalog-poll");
  });

  it.each([
    { typed: "/po", expected: ["poll"] },
    { typed: "/p", expected: ["poll", "mention"] },
    { typed: "/ag", expected: ["mention"] },
    { typed: "/he", expected: ["file"] },
  ])("filters $typed to $expected", async ({ typed, expected }) => {
    render(<Harness />);
    await userEvent.type(composer(), typed);
    expect(rows()).toEqual(expected);
  });

  it("closes when nothing matches", async () => {
    render(<Harness />);
    await userEvent.type(composer(), "/zz");
    expect(screen.queryByTestId("chats-catalog")).toBeNull();
    expect(composer().getAttribute("aria-expanded")).toBe("false");
  });

  it("offers no Poll where a posted poll cannot be answered", async () => {
    render(<Harness offersPoll={false} />);
    await userEvent.type(composer(), "/");
    expect(rows()).toEqual(["mention", "file"]);
    expect(screen.queryByTestId("chats-poll-toggle")).toBeNull();
  });

  it("Poll removes the / word and opens a poll on the question", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await userEvent.type(composer(), "Lunch where? /po");
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(composer().value).toBe("Lunch where? ");
    expect(pollState()).toEqual(["", ""]);
    expect(screen.queryByTestId("chats-catalog")).toBeNull();
    // The question is written, so the first choice takes focus.
    expect(document.activeElement).toBe(choices()[0]);
  });

  it("Poll with no question yet leaves focus on the question", async () => {
    render(<Harness />);
    await userEvent.type(composer(), "/");
    fireEvent.mouseDown(screen.getAllByTestId("chats-catalog-option")[0]!);
    expect(composer().value).toBe("");
    expect(pollState()).toEqual(["", ""]);
    expect(document.activeElement).toBe(composer());
  });

  it("Person or agent turns the / into @ and opens the roster", async () => {
    render(<Harness />);
    await userEvent.type(composer(), "ask /pe");
    fireEvent.mouseDown(screen.getAllByTestId("chats-catalog-option")[0]!);
    expect(composer().value).toBe("ask @");
    const menu = await screen.findByTestId("chats-mention-menu");
    expect(within(menu).getAllByTestId("chats-mention-option")).toHaveLength(2);
    expect(composer().getAttribute("aria-activedescendant")).toBe("chats-composer-mentions-agent:default");
  });

  it("File or heading turns the / into @ with the files active", async () => {
    render(<Harness />);
    await userEvent.type(composer(), "see /fi");
    await userEvent.keyboard("{Tab}");
    expect(composer().value).toBe("see @");
    await screen.findByTestId("chats-mention-menu");
    expect(composer().getAttribute("aria-activedescendant")).toBe("chats-composer-mentions-file-0");
  });

  it("moves with the arrows and closes on Escape before the composer's own Escape", async () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    await userEvent.type(composer(), "/");
    await userEvent.keyboard("{ArrowDown}");
    expect(composer().getAttribute("aria-activedescendant")).toBe("chats-composer-mentions-catalog-mention");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(composer().getAttribute("aria-activedescendant")).toBe("chats-composer-mentions-catalog-file");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("chats-catalog")).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("picks nothing and sends nothing on Enter while IME composing", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await userEvent.type(composer(), "/po");
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    expect(composer().value).toBe("/po");
    expect(pollState()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("chats-catalog")).not.toBeNull();
  });
});

describe("the poll block", () => {
  it("the poll button opens and closes it in both surfaces", async () => {
    for (const surface of [undefined, "post"] as const) {
      render(<Harness surface={surface} initialValue="Lunch?" />);
      const toggle = screen.getByTestId("chats-poll-toggle");
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      fireEvent.mouseDown(toggle);
      expect(pollState()).toEqual(["", ""]);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      fireEvent.mouseDown(toggle);
      expect(pollState()).toBeNull();
      cleanup();
    }
  });

  it("Enter moves to the next choice and adds one at the end", async () => {
    const onSend = vi.fn();
    render(<Harness initialValue="Lunch?" initialPoll={["Soup", ""]} onSend={onSend} />);
    choices()[0]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(choices()[1]);
    await userEvent.keyboard("Salad{Enter}");
    expect(pollState()).toEqual(["Soup", "Salad", ""]);
    expect(document.activeElement).toBe(choices()[2]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter in a choice never posts, even with a poll ready to send", async () => {
    const onSend = vi.fn();
    render(<Harness surface="post" initialValue="Lunch?" initialPoll={["Soup", "Salad"]} onSend={onSend} />);
    expect(send().disabled).toBe(false);
    choices()[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(pollState()).toEqual(["Soup", "Salad", ""]);
  });

  it("Backspace in an empty choice removes it and moves up, to the question from the first", async () => {
    render(<Harness initialValue="Lunch?" initialPoll={["", "Soup", ""]} />);
    choices()[2]!.focus();
    await userEvent.keyboard("{Backspace}");
    expect(pollState()).toEqual(["", "Soup"]);
    expect(document.activeElement).toBe(choices()[1]);
    choices()[0]!.focus();
    await userEvent.keyboard("{Backspace}");
    expect(pollState()).toEqual(["Soup"]);
    expect(document.activeElement).toBe(composer());
  });

  it("keeps a choice's own Backspace when it has text, and the IME's Enter", async () => {
    render(<Harness initialValue="Lunch?" initialPoll={["Soup", ""]} />);
    choices()[0]!.focus();
    fireEvent.keyDown(choices()[0]!, { key: "Enter", isComposing: true });
    expect(document.activeElement).toBe(choices()[0]);
    await userEvent.keyboard("{Backspace}");
    expect(pollState()).toEqual(["Sou", ""]);
  });

  it("reaches every control by Tab", async () => {
    render(<Harness initialValue="Lunch?" initialPoll={["Soup", "Salad"]} />);
    choices()[0]!.focus();
    const order: (string | null)[] = [];
    for (let step = 0; step < 5; step += 1) {
      await userEvent.tab();
      order.push(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null);
    }
    expect(order).toEqual(["Remove choice 1", "Choice 2", "Remove choice 2", "Add a choice", "Remove poll"]);
  });

  it("adds up to twelve choices, removes one, and removes the poll", () => {
    render(<Harness initialValue="Lunch?" initialPoll={Array.from({ length: 11 }, (_, index) => `Dish ${index}`)} />);
    fireEvent.click(screen.getByTestId("chats-poll-add"));
    expect(choices()).toHaveLength(12);
    expect(screen.queryByTestId("chats-poll-add")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove choice 1" }));
    expect(pollState()?.[0]).toBe("Dish 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove poll" }));
    expect(pollState()).toBeNull();
    expect(screen.queryByTestId("chats-poll")).toBeNull();
    expect(document.activeElement).toBe(composer());
  });

  it.each([
    { name: "no question", value: "  ", poll: ["Soup", "Salad"], enabled: false },
    { name: "one choice", value: "Lunch?", poll: ["Soup", " "], enabled: false },
    { name: "two choices", value: "Lunch?", poll: ["Soup", "Salad", ""], enabled: true },
    { name: "a repeat once trimmed", value: "Lunch?", poll: ["Soup", "Soup "], enabled: false },
    { name: "a choice over 200 characters", value: "Lunch?", poll: ["Soup", "x".repeat(201)], enabled: false },
    { name: "a choice of 200 characters", value: "Lunch?", poll: ["Soup", "x".repeat(200)], enabled: true },
  ])("Send with $name is enabled: $enabled", ({ value, poll, enabled }) => {
    render(<Harness initialValue={value} initialPoll={poll} />);
    expect(send().disabled).toBe(!enabled);
  });

  it("marks a repeated choice beside the block", () => {
    render(<Harness initialValue="Lunch?" initialPoll={["Soup", ""]} />);
    expect(screen.queryByText("Each choice appears once.")).toBeNull();
    fireEvent.change(choices()[1]!, { target: { value: " Soup" } });
    expect(choices()[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Each choice appears once.").id).toBe(choices()[1]!.getAttribute("aria-describedby"));
    expect(send().disabled).toBe(true);
  });

  it("stops a choice at the engine's 200 characters", () => {
    render(<Harness initialValue="Lunch?" initialPoll={["", ""]} />);
    expect(choices()[0]!.maxLength).toBe(200);
  });
});

describe("pollChoicesToSend", () => {
  it("sends trimmed, non-empty choices the engine accepts", () => {
    expect(pollChoicesToSend([" Soup ", "", "Salad"])).toEqual(["Soup", "Salad"]);
    expect(pollChoicesToSend(["Soup"])).toBeNull();
    expect(pollChoicesToSend(["Soup", " Soup"])).toBeNull();
    expect(pollChoicesToSend(["Soup", "two\nlines"])).toBeNull();
    expect(pollChoicesToSend(["Soup", "x".repeat(201)])).toBeNull();
    expect(pollChoicesToSend(Array.from({ length: 13 }, (_, index) => `${index}`))).toBeNull();
  });

  // The engine trims with Rust's `str::trim`: Unicode White_Space, which
  // includes U+0085 (next line) and leaves U+FEFF (byte order mark).
  it("trims the way the engine does", () => {
    expect(pollChoicesToSend(["\u0085Soup", "Soup"])).toBeNull();
    expect(pollChoicesToSend(["\u0085", "Soup", "Salad"])).toEqual(["Soup", "Salad"]);
    expect(pollChoicesToSend([" Soup　", "Salad"])).toEqual(["Soup", "Salad"]);
    expect(pollChoicesToSend(["﻿Soup", "Soup"])).toEqual(["﻿Soup", "Soup"]);
    expect(repeatedPollChoices(["Soup", "Soup\u0085"])).toEqual(new Set([1]));
    expect(repeatedPollChoices(["Soup", "Soup﻿"])).toEqual(new Set());
  });
});
