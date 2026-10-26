// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { bridge } from "../bridge";
import { ChatMarkdown, createDrawnCache } from "./ChatMarkdown";
import { stripMarkdown } from "../markdown/stripMarkdown";
import {
  answerChatParse,
  CHAT_MARKDOWN_MAX_LENGTH,
  chatChips,
  parseChatMarkdown,
  type ChatParseRequest,
} from "./chatMarkdownParse";
import { CHAT_PARSE_DEADLINE_MS } from "./chatMarkdownWorker";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));
vi.mock("./chatMarkdownParse", async (original) => {
  const actual = await original<typeof import("./chatMarkdownParse")>();
  return { ...actual, parseChatMarkdown: vi.fn(actual.parseChatMarkdown) };
});

// The chat's parse worker, run in this thread. `workerMode` decides whether it
// answers, never answers, crashes, or holds its answer until a test sends it.
let workerMode: "answer" | "hang" | "crash" | "hold" = "answer";
const workers: FakeWorker[] = [];
const held: Array<() => void> = [];
let posts = 0;
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(data: ChatParseRequest) {
    posts++;
    if (workerMode === "hang") return;
    if (workerMode === "crash") {
      queueMicrotask(() => this.onerror?.(new Event("error")));
      return;
    }
    const answer = structuredClone(answerChatParse(data));
    if (workerMode === "hold") held.push(() => this.onmessage?.({ data: answer }));
    else queueMicrotask(() => this.onmessage?.({ data: answer }));
  }
  terminate() {
    this.terminated = true;
  }
}

beforeAll(() => {
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  workerMode = "answer";
  held.length = 0;
});

const CANDIDATES: MentionCandidate[] = [
  { id: "sam", kind: "user", handle: "sam", label: "Sam" },
  { id: "agent", kind: "agent", handle: "agent", label: "Claude Code" },
];

function renderBody(body: string, extra: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown body={body} candidates={CANDIDATES} testId="body" {...extra} />);
}

// The external open waits on the confirm gate, a microtask after the click.
const flushExternalOpen = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ChatMarkdown", () => {
  it("formats an agent's reply", () => {
    const view = renderBody(
      "I'm in the **Personal** workspace, which has `Hello.md`.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```",
    );
    expect(view.container.querySelector("strong")?.textContent).toBe("Personal");
    expect(view.container.querySelector("p code")?.textContent).toBe("Hello.md");
    expect([...view.container.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["one", "two"]);
    expect(view.container.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect(view.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("**");
  });

  it("keeps a single newline as a line break", () => {
    for (const body of ["first line\nsecond line", "**first** line\nsecond line"]) {
      const view = renderBody(body);
      expect(view.container.querySelectorAll("p")).toHaveLength(1);
      expect(view.container.querySelectorAll("br")).toHaveLength(1);
      expect(view.container.textContent).toBe("first line\nsecond line");
      cleanup();
    }
  });

  it("shows raw HTML as text and runs none of it", () => {
    const view = renderBody('Look <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("shows a remote image as a link to it and never loads it", () => {
    const view = renderBody("![the cabin](https://example.com/cabin.png)");
    expect(view.container.querySelector("img")).toBeNull();
    const link = view.getByRole("link", { name: "the cabin" });
    expect(link.getAttribute("href")).toBe("https://example.com/cabin.png");
  });

  it("opens http links through the external-link path and refuses other schemes", async () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({ openExternalUrl } as unknown as ReturnType<typeof bridge>);
    const view = renderBody(
      "[Cabins](https://example.com/cabins) [Bad](javascript:alert(1)) [Data](data:text/html,hi) [Local](notes.md) [Mail](mailto:sam@example.com)",
    );
    expect(view.queryByRole("link", { name: "Bad" })).toBeNull();
    expect(view.queryByRole("link", { name: "Data" })).toBeNull();
    expect(view.queryByRole("link", { name: "Local" })).toBeNull();
    expect(view.container.textContent).toContain("Bad");
    expect(view.getByRole("link", { name: "Mail" })).toBeTruthy();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    expect(view.getByRole("link", { name: "Cabins" }).dispatchEvent(click)).toBe(false);
    await flushExternalOpen();
    expect(openExternalUrl).toHaveBeenCalledWith({ url: "https://example.com/cabins" });
  });

  it("draws a mention chip inside bold text, and none inside code", () => {
    const view = renderBody("**thanks @sam** and `@agent` and\n```\n@agent\n```");
    const mentions = view.getAllByTestId("body-mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.textContent).toBe("@sam");
    expect(mentions[0]?.closest("strong")).not.toBeNull();
    expect(mentions[0]?.dataset.mentionKind).toBe("user");
  });

  it("draws a page chip that opens its attachment's path", () => {
    const onOpenPath = vi.fn();
    const view = renderBody("See @[notes/Trip plan.md#Day 1] and **@agent**.", {
      onOpenPath,
      attachments: [{ attachmentId: "a", kind: "file", pathHint: "notes/Trip plan.md", headingAnchor: "Day 1" }] as never,
    });
    view.getByTestId("body-file-mention").click();
    expect(onOpenPath).toHaveBeenCalledWith("notes/Trip plan.md", "Day 1");
    // The engine reads "**@agent" as no mention, so neither does the chat.
    expect(view.queryByTestId("body-mention")).toBeNull();
  });

  it("draws chips in plain text without the parser", () => {
    const view = renderBody("hey @agent\nsee @[plan.md]");
    expect(view.getByTestId("body-mention").textContent).toBe("@agent");
    expect(view.getByTestId("body-file-mention")).toBeTruthy();
    expect(view.container.querySelectorAll("br")).toHaveLength(1);
  });

  it("shows a task list's boxes without letting them change", () => {
    const view = renderBody("- [x] flights\n- [ ] cabin");
    const boxes = view.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([[true, true], [false, true]]);
  });

  it("copies the Markdown source when the whole message is selected", () => {
    const body = "Hi **Sam**, see [the plan](https://example.com).";
    const view = renderBody(body);
    const root = view.getByTestId("body");
    const range = document.createRange();
    range.selectNodeContents(root);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { setData } });
    root.dispatchEvent(event);
    expect(setData).toHaveBeenCalledWith("text/plain", body);
    expect(event.defaultPrevented).toBe(true);
  });

  it("places a chip at the engine's range, not at a matching text before it", () => {
    const view = renderBody("\\@sam then @sam");
    const mentions = view.getAllByTestId("body-mention");
    expect(mentions).toHaveLength(1);
    expect(view.container.textContent).toBe("@sam then @sam");
    expect(mentions[0]?.previousSibling?.textContent).toBe("@sam then ");
  });

  it("keeps a page chip whole when its path holds Markdown syntax", () => {
    const view = renderBody("See @[notes/_draft_.md] **now**", {
      attachments: [{ attachmentId: "a", kind: "file", pathHint: "notes/_draft_.md" }] as never,
    });
    expect(view.getByTestId("body-file-mention").textContent).toContain("_draft_.md");
    expect(view.container.querySelector("em")).toBeNull();
    expect(view.container.querySelector("strong")?.textContent).toBe("now");
  });

  it("draws a mention inside link text, with one target for a safe link", () => {
    const view = renderBody("[hello @sam](notes.md) and [hi @sam](https://example.com/hi)");
    expect(view.getAllByTestId("body-mention")).toHaveLength(2);
    expect(view.getAllByRole("link")).toHaveLength(1);
    expect(view.getByRole("link").querySelector("[data-testid=body-mention]")).not.toBeNull();
  });

  it("opens a file chip inside a link as part of the link, not as its own button", () => {
    const view = renderBody("[see @[plan.md]](https://example.com/plan)", { onOpenPath: vi.fn() });
    expect(view.getByTestId("body-file-mention").closest("button")).toBeNull();
    expect(view.getAllByRole("link")).toHaveLength(1);
  });

  it("ignores chip markers typed into the body", () => {
    const view = renderBody("forged \uFDD00\uFDD1 and **hi** @sam");
    expect(view.getAllByTestId("body-mention")).toHaveLength(1);
    expect(view.container.textContent).toBe("forged \uFFFD0\uFFFD and hi @sam");
  });

  it("keeps chips at their ranges after astral characters and across CRLF", () => {
    const view = renderBody("😀🎉 **hi** @sam\r\nnext @agent");
    expect(view.getAllByTestId("body-mention").map((chip) => chip.textContent)).toEqual(["@sam", "@agent"]);
    expect(view.container.querySelectorAll("br")).toHaveLength(1);
  });

  it("keeps line breaks inside a nested list item", () => {
    const view = renderBody("- one\n  - two\n    still two");
    const nested = view.container.querySelector("li li");
    expect(nested?.querySelectorAll("br")).toHaveLength(1);
    expect(nested?.textContent).toBe("two\nstill two");
  });

  it("draws no chip inside an indented code block", () => {
    const view = renderBody("Run this:\n\n    notify @sam now");
    expect(view.container.querySelector("pre code")?.textContent).toBe("notify @sam now");
    expect(view.queryByTestId("body-mention")).toBeNull();
  });

  it("gives a linked image one link, which opens once", async () => {
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({ openExternalUrl } as unknown as ReturnType<typeof bridge>);
    const view = renderBody("[![the cabin](https://example.com/cabin.png)](https://example.com/page)");
    const links = view.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/page");
    links[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    await flushExternalOpen();
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith({ url: "https://example.com/page" });
  });

  it("puts headings 6px from the block before them", () => {
    const view = renderBody("Intro\n\n## Plan");
    const heading = view.container.querySelector("h2")!;
    expect(heading.className).toContain("mt-1.5");
    expect(heading.className).not.toContain("mt-2");
  });

  it("copies a code block's own text from its Copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const view = renderBody("Try:\n\n```ts\nconst a = 1;\nconst b = `two`;\n```");
    const copy = view.getByRole("button", { name: "Copy code" });
    expect(copy.parentElement?.className).toContain("right-px top-px");
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("const a = 1;\nconst b = `two`;");
  });

  describe("whole-message copy", () => {
    const select = (start: Node, end: Node) => {
      const range = document.createRange();
      range.setStartBefore(start);
      range.setEndAfter(end);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    };
    const copy = (target: Element) => {
      const setData = vi.fn();
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.assign(event, { clipboardData: { setData } });
      target.dispatchEvent(event);
      return setData;
    };

    it("gives the source when the selection covers the text but not the code block's controls", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const body = "Run:\n\n```\nls\n```";
      const view = renderBody(body);
      // "Copied" now sits in the code block's live region.
      await act(async () => view.getByRole("button", { name: "Copy code" }).click());
      const root = view.getByTestId("body");
      select(root.querySelector("p")!.firstChild!, root.querySelector("pre code")!.firstChild!);
      expect(copy(root)).toHaveBeenCalledWith("text/plain", body);
    });

    it("copies text as shown for a partial selection", () => {
      const view = renderBody("Hi **Sam**, and more");
      const root = view.getByTestId("body");
      const strong = root.querySelector("strong")!;
      select(strong, strong);
      expect(copy(root)).not.toHaveBeenCalled();
    });

    it("gives the source only when the selection reaches a page chip at the end", () => {
      const body = "**hello** @[notes.md]";
      const view = renderBody(body, {
        onOpenPath: vi.fn(),
        attachments: [{ attachmentId: "a", kind: "file", pathHint: "notes.md" }] as never,
      });
      const root = view.getByTestId("body");
      const strong = root.querySelector("strong")!;
      select(strong, strong);
      expect(copy(root)).not.toHaveBeenCalled();
      select(strong, view.getByTestId("body-file-mention"));
      expect(copy(root)).toHaveBeenCalledWith("text/plain", body);
    });

    it("copies text as shown across two messages", () => {
      const first = render(<ChatMarkdown body="one **a**" candidates={CANDIDATES} testId="first" />);
      const second = render(<ChatMarkdown body="two **b**" candidates={CANDIDATES} testId="second" />);
      select(first.getByTestId("first").firstChild!, second.getByTestId("second").firstChild!);
      expect(copy(first.getByTestId("first"))).not.toHaveBeenCalled();
    });

    for (const [name, body] of [
      ["a link title", 'See [the plan](https://example.com "secret")'],
      ["a refused link", "See [the plan](javascript:alert(1))"],
      ["a reference definition", "See [the plan][p]\n\n[p]: https://example.com"],
      ["an unused definition", "See the plan\n\n[p]: https://example.com/hidden"],
      ["a code block's info string", "```ts secret\nls\n```"],
    ] as const) {
      it(`copies text as shown when the source hides ${name}`, () => {
        const view = renderBody(body);
        const root = view.getByTestId("body");
        const range = document.createRange();
        range.selectNodeContents(root);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        expect(copy(root)).not.toHaveBeenCalled();
      });
    }
  });

  describe("bodies the main thread does not parse", () => {
    const long = (unit: string, size = 1500) => unit.repeat(Math.ceil(size / unit.length));
    const LONG_REPLY = `## Plan\n\n${long("We meet at the **harbor** with `tickets.csv`. ")}\n\n- pack\n- go`;

    it("parse in the worker and show their words without syntax until the tree arrives", async () => {
      const view = renderBody(LONG_REPLY);
      expect(view.container.querySelector("h2")).toBeNull();
      expect(view.container.textContent).not.toContain("**");
      expect(view.container.textContent).toContain("We meet at the harbor with tickets.csv.");
      await waitFor(() => expect(view.container.querySelector("h2")?.textContent).toBe("Plan"));
      expect(view.container.querySelectorAll("li")).toHaveLength(2);
    });

    it("parse in the worker when a short body nests deeply or has a long table", () => {
      for (const body of [
        `${"> ".repeat(40)}deep`,
        `${"[".repeat(40)}a${"]".repeat(40)}`,
        `| a | b |\n| - | - |\n${"| x | y |\n".repeat(110)}`.slice(0, 1024),
      ]) {
        const view = renderBody(body);
        expect(parseChatMarkdown).not.toHaveBeenCalled();
        view.unmount();
      }
    });

    it("keep their words when the worker runs past its deadline, and a new worker takes the next body", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      workerMode = "hang";
      const view = renderBody(long("stuck **here** ", 1200));
      const stuck = workers.at(-1)!;
      await act(async () => {
        vi.advanceTimersByTime(CHAT_PARSE_DEADLINE_MS);
      });
      expect(stuck.terminated).toBe(true);
      expect(view.container.textContent).toContain("stuck here");
      expect(view.container.querySelector("strong")).toBeNull();
      view.unmount();

      // The body stays text for the session without asking the worker again.
      const count = workers.length;
      const again = renderBody(long("stuck **here** ", 1200));
      expect(again.container.textContent).toContain("stuck here");
      again.unmount();
      expect(workers.length).toBe(count);

      workerMode = "answer";
      vi.useRealTimers();
      const next = renderBody(long("next **body** ", 1200));
      await waitFor(() => expect(next.container.querySelector("strong")).not.toBeNull());
      expect(workers.length).toBe(count + 1);
    });

    it("keep their words when the worker crashes", async () => {
      workerMode = "crash";
      const view = renderBody(long("crash **here** ", 1200));
      const crashed = workers.at(-1)!;
      await waitFor(() => expect(crashed.terminated).toBe(true));
      expect(view.container.textContent).toContain("crash here");
      expect(view.container.querySelector("strong")).toBeNull();
    });

    it("show a body over the length cap as text, with its chips", async () => {
      const view = renderBody(`hi @sam ${long("**word** ", 50_001)}`);
      await waitFor(() => expect(view.queryByTestId("body-mention")).not.toBeNull());
      expect(view.container.querySelector("strong")).toBeNull();
      expect(view.container.textContent).not.toContain("**");
    });

    it("keep page names as typed while waiting and after giving up", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      workerMode = "hang";
      const page = "@[notes/_draft_ *x* `y`.md]";
      const view = renderBody(`${long("wait **here** ", 1200)}${page} done`);
      expect(view.container.textContent).toContain(`wait here ${page} done`);
      await act(async () => {
        vi.advanceTimersByTime(CHAT_PARSE_DEADLINE_MS);
      });
      expect(view.container.textContent).toContain(`wait here ${page} done`);
    });

    it("show a body whose tree is too large as text", async () => {
      const view = renderBody(`${"[a][r] ".repeat(300)}\n\n[r]: https://example.com/${"x".repeat(1000)}`);
      await act(async () => {});
      expect(view.queryByRole("link")).toBeNull();
      expect(view.container.textContent).toContain("a a a");
      expect(view.container.textContent).not.toContain("example.com");
    });

    it("show the current body when one is edited, deleted or remounted while its parse is pending", async () => {
      workerMode = "hold";
      const draw = (body: string) => <ChatMarkdown body={body} candidates={CANDIDATES} testId="body" />;
      const view = render(draw(long("first **draft** ", 1200)));
      view.rerender(draw(long("edited **draft** ", 1200)));
      await act(async () => held.shift()!());
      expect(view.container.querySelector("strong")).toBeNull();
      expect(view.container.textContent).toContain("edited draft");
      await act(async () => held.shift()!());
      expect(view.container.querySelector("strong")?.textContent).toBe("draft");
      expect(view.container.textContent).not.toContain("first");

      view.rerender(draw(long("deleted **draft** ", 1200)));
      view.rerender(draw(""));
      await act(async () => held.shift()!());
      expect(view.container.textContent).toBe("");
      view.unmount();

      const body = long("remounted **draft** ", 1200);
      const count = posts;
      renderBody(body).unmount();
      const again = renderBody(body);
      await act(async () => held.shift()!());
      expect(again.container.querySelector("strong")?.textContent).toBe("draft");
      expect(posts).toBe(count + 1);
    });

    it("move queued bodies to a new worker after a deadline, and ignore the old worker's late answer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      workerMode = "hold";
      const slow = renderBody(long("slow **one** ", 1200));
      const queued = render(<ChatMarkdown body={long("queued **two** ", 1200)} candidates={CANDIDATES} testId="queued" />);
      const old = workers.at(-1)!;
      expect(held).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(CHAT_PARSE_DEADLINE_MS);
      });
      expect(old.terminated).toBe(true);
      expect(workers.at(-1)).not.toBe(old);
      expect(held).toHaveLength(2);
      await act(async () => held.shift()!());
      expect(slow.getByTestId("body").querySelector("strong")).toBeNull();
      expect(slow.getByTestId("body").textContent).toContain("slow one");
      await act(async () => held.shift()!());
      expect(queued.getByTestId("queued").querySelector("strong")?.textContent).toBe("two");
    });

    it("keep a body that ran past its deadline as text when its chips' lists change, without asking again", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      workerMode = "hang";
      const body = `hi @sam ${long("late **words** ", 1200)}`;
      const view = renderBody(body);
      await act(async () => {
        vi.advanceTimersByTime(CHAT_PARSE_DEADLINE_MS);
      });
      const count = posts;
      const more: MentionCandidate[] = [...CANDIDATES, { id: "kim", kind: "user", handle: "kim", label: "Kim" }];
      view.rerender(<ChatMarkdown body={body} candidates={more} testId="body" />);
      await act(async () => {});
      expect(posts).toBe(count);
      expect(view.container.textContent).toContain("hi @sam late words");
      expect(view.container.querySelector("strong")).toBeNull();
    });

    it("show the words when the parse throws, and remember that", () => {
      vi.mocked(parseChatMarkdown).mockImplementationOnce(() => {
        throw new RangeError("Maximum call stack size exceeded");
      });
      const body = "a **thrown** body @sam";
      const view = renderBody(body);
      expect(view.container.textContent).toBe("a thrown body @sam");
      expect(view.getByTestId("body-mention")).toBeTruthy();
      view.unmount();
      renderBody(body);
      expect(parseChatMarkdown).toHaveBeenCalledTimes(1);
    });
  });

  it("parses a body once across remounts, and again when it is edited", () => {
    const view = renderBody("remount **me** once");
    view.unmount();
    const again = renderBody("remount **me** once");
    expect(parseChatMarkdown).toHaveBeenCalledTimes(1);
    again.rerender(<ChatMarkdown body="remount **me** edited" candidates={CANDIDATES} testId="body" />);
    expect(again.container.textContent).toBe("remount me edited");
    expect(parseChatMarkdown).toHaveBeenCalledTimes(2);
    again.rerender(<ChatMarkdown body="" candidates={CANDIDATES} testId="body" />);
    expect(again.container.textContent).toBe("");
  });
});

describe("the parse worker's answer", () => {
  it("gives up on a tree with too many nodes", () => {
    const answer = answerChatParse({ id: 1, body: "- a\n".repeat(6000), candidates: CANDIDATES, attachments: [] });
    expect(answer.parsed).toBeUndefined();
  });

  it("gives up on deep nesting instead of throwing", () => {
    const answer = answerChatParse({ id: 2, body: `${"> ".repeat(2000)}a`, candidates: CANDIDATES, attachments: [] });
    expect(answer.parsed).toBeUndefined();
  });

  it("keeps an ordinary long reply", () => {
    const answer = answerChatParse({
      id: 3,
      body: "## Day\n\nWe meet at the **harbor**.\n\n- pack\n- go\n\n".repeat(400),
      candidates: CANDIDATES,
      attachments: [],
    });
    expect(answer.parsed).toBeDefined();
  });

  it("keeps a reply at the length cap that links on every line", () => {
    const line = "See [the plan](https://example.com/trips/2026/plan) at the **harbor**.\n\n";
    const body = line.repeat(Math.floor(CHAT_MARKDOWN_MAX_LENGTH / line.length));
    expect(answerChatParse({ id: 4, body, candidates: CANDIDATES, attachments: [] }).parsed).toBeDefined();
  });

  it("weighs a table by its nodes as well as its text", () => {
    const row = `|${"a|".repeat(20)}\n`;
    const body = `${row}|${"-|".repeat(20)}\n${row.repeat(250)}`;
    const parsed = parseChatMarkdown(body, []);
    const answer = answerChatParse({ id: 6, body, candidates: CANDIDATES, attachments: [] });
    expect(answer.parsed?.weight).toBe(parsed.chars + parsed.nodes * 64);
    // So the cache holds a few such tables, not a hundred.
    expect(answer.parsed!.weight).toBeGreaterThan(500_000);
  });

  it("gives up on a short body that repeats a long target or title", () => {
    const uses = "[a][r] ".repeat(300);
    for (const definition of [`[r]: https://example.com/${"x".repeat(1000)}`, `[r]: https://example.com "${"t".repeat(1000)}"`]) {
      const answer = answerChatParse({ id: 5, body: `${uses}\n\n${definition}`, candidates: CANDIDATES, attachments: [] });
      expect(answer.parsed).toBeUndefined();
    }
  });
});

describe("footnotes", () => {
  for (const [name, body] of [
    ["one that refers only to itself", "Text\n\n[^a]: see [^a]"],
    ["two that refer only to each other", "Text\n\n[^a]: see [^b]\n\n[^b]: see [^a]"],
    ["a repeated identifier", "Text[^a]\n\n[^a]: one\n\n[^a]: two"],
  ] as const) {
    it(`hide ${name}, so copy gives the text as shown`, () => {
      expect(parseChatMarkdown(body, []).copiesSource).toBe(false);
    });
  }
});

// The text shown before the tree arrives has the words the tree shows, with
// chips as typed.
describe("the waiting text", () => {
  type Node = { type: string; value?: string; tagName?: string; properties?: { alt?: string; src?: string }; children?: Node[] };
  const BLOCKS = new Set(["p", "li", "pre", "blockquote", "h1", "h2", "h3", "br", "td", "th"]);
  const shown = (node: Node): string => {
    if (node.type === "text") return node.value ?? "";
    // An image draws as a link holding its alt text, else its address.
    if (node.tagName === "img") return node.properties?.alt || node.properties?.src || "";
    const inner = (node.children ?? []).map(shown).join("");
    return node.tagName && BLOCKS.has(node.tagName) ? ` ${inner} ` : inner;
  };
  const words = (text: string) => text.split(/\s+/u).filter(Boolean);

  for (const body of [
    "snake_case and file_name.txt",
    "my_draft_file",
    "_draft_ here",
    "a *b* c",
    "2*3*4",
    "x __y__ z",
    "intra_word_s and intra*word*s and **bold**er",
    "see @[notes/_draft_.md] and @[a*b*c.md] and @[`code` notes.md]",
    "see @[my_draft_file.md#Day_1] and @[a__b__.md]",
    "[the dish](https://en.wikipedia.org/wiki/Fish_(food)) and [x](https://x.com/a_(b)_c) after",
    "\\*not\\* \\_x\\_ \\`y\\` \\\\ \\[z\\]",
    "&amp; &lt;b&gt; &#x41; &#65; &bogus; &copy; &hellip;",
    "use `a*b*c` and ``x ` y`` and `@sam`",
    "hi @sam_x_ and **@agent**",
    "file_ and a* b and ~c and __init__",
    "*one\ntwo* and ~~three\nfour~~",
    "a*b\n> c* and > d*e\nf*",
    '[plan](https://example.com "title ( here") after',
    "**bold *italic***",
    "**hello*",
    "[a [b](c) d](e) and ![x [y](z)](w)",
    "[a](<b c>) [d](<e) [f](g 'h') [i](j (k)) [l]( m ) [n](o\"p\")",
    "[plan](docs/(my draft).md) after",
    "See ![](https://example.com/plot.png).",
    "[![](https://example.com/plot.png)](https://example.com) and ![](<a b&amp;c\\_d.png>) and ![]( é.png )",
  ]) {
    it(`matches the tree for ${JSON.stringify(body)}`, () => {
      const chips = chatChips(body, CANDIDATES, []);
      const tree = words(shown(parseChatMarkdown(body, chips).tree as Node));
      expect(words(stripMarkdown(body, chips).text)).toEqual(tree);
    });
  }

  // 20,000 different bodies of one line from a small alphabet, so every
  // emphasis and link rule meets every other, from a fixed seed.
  it("matches the tree for 20,000 generated bodies", () => {
    const alphabet = ["*", "*", "_", "_", "(", ")", "[", "]", '"', "<", ">", "\\", "`", "a", "b", " ", " "];
    // mulberry32
    let seed = 20261027;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const bodies = new Set<string>();
    while (bodies.size < 20_000) {
      let body = "a";
      const size = 1 + Math.floor(random() * 24);
      for (let at = 0; at < size; at++) body += alphabet[Math.floor(random() * alphabet.length)];
      bodies.add(body);
    }
    const mismatches: string[] = [];
    for (const body of bodies) {
      const tree = words(shown(parseChatMarkdown(body, []).tree as Node)).join(" ");
      if (words(stripMarkdown(body).text).join(" ") !== tree) mismatches.push(body);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("the drawn-body cache", () => {
  it("drops the oldest bodies past its size and keeps recent ones", () => {
    const cache = createDrawnCache<string>(10);
    cache.remember("aaaa", "A");
    cache.remember("bbbb", "B");
    expect(cache.recall("aaaa")).toBe("A");
    cache.remember("cccc", "C");
    expect(cache.recall("bbbb")).toBeUndefined();
    expect(cache.recall("aaaa")).toBe("A");
    expect(cache.recall("cccc")).toBe("C");
    cache.remember("x".repeat(11), "too big");
    expect(cache.recall("x".repeat(11))).toBeUndefined();
  });

  it("counts the text a tree holds, not only its key", () => {
    const cache = createDrawnCache<string>(10);
    cache.remember("aa", "A");
    cache.remember("bb", "B", 7);
    expect(cache.recall("aa")).toBeUndefined();
    expect(cache.recall("bb")).toBe("B");
    cache.remember("cc", "C", 9);
    expect(cache.recall("cc")).toBeUndefined();
  });
});
