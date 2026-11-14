// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { bridge } from "../bridge";
import { ChatMarkdown, createDrawnCache } from "./ChatMarkdown";
import {
  CHAT_MARKDOWN_MAX_LENGTH,
  answerChatParse,
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
    expect([...view.container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(view.container.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect(view.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("**");
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
      attachments: [
        { attachmentId: "a", kind: "file", pathHint: "notes/Trip plan.md", headingAnchor: "Day 1" },
      ] as never,
    });
    view.getByTestId("body-file-mention").click();
    expect(onOpenPath).toHaveBeenCalledWith("notes/Trip plan.md", "Day 1");
    // The engine reads "**@agent" as no mention, so neither does the chat.
    expect(view.queryByTestId("body-mention")).toBeNull();
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

  it("ignores chip markers typed into the body", () => {
    const view = renderBody("forged \uFDD00\uFDD1 and **hi** @sam");
    expect(view.getAllByTestId("body-mention")).toHaveLength(1);
    expect(view.container.textContent).toBe("forged \uFFFD0\uFFFD and hi @sam");
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

    it("show a body over the length cap as text, with its chips", async () => {
      const view = renderBody(`hi @sam ${long("**word** ", 50_001)}`);
      await waitFor(() => expect(view.queryByTestId("body-mention")).not.toBeNull());
      expect(view.container.querySelector("strong")).toBeNull();
      expect(view.container.textContent).not.toContain("**");
    });

    it("show a body whose tree is too large as text", async () => {
      const view = renderBody(
        `${"[a][r] ".repeat(300)}\n\n[r]: https://example.com/${"x".repeat(1000)}`,
      );
      await act(async () => {});
      expect(view.queryByRole("link")).toBeNull();
      expect(view.container.textContent).toContain("a a a");
      expect(view.container.textContent).not.toContain("example.com");
    });

    it("show the current body when one is edited, deleted or remounted while its parse is pending", async () => {
      workerMode = "hold";
      const draw = (body: string) => (
        <ChatMarkdown body={body} candidates={CANDIDATES} testId="body" />
      );
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
      const queued = render(
        <ChatMarkdown
          body={long("queued **two** ", 1200)}
          candidates={CANDIDATES}
          testId="queued"
        />,
      );
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
  });
});

describe("the parse worker's answer", () => {
  it("gives up on a tree with too many nodes", () => {
    const answer = answerChatParse({
      id: 1,
      body: "- a\n".repeat(6000),
      candidates: CANDIDATES,
      attachments: [],
    });
    expect(answer.parsed).toBeUndefined();
  });

  it("gives up on deep nesting instead of throwing", () => {
    const answer = answerChatParse({
      id: 2,
      body: `${"> ".repeat(2000)}a`,
      candidates: CANDIDATES,
      attachments: [],
    });
    expect(answer.parsed).toBeUndefined();
  });

  it("keeps a reply at the length cap that links on every line", () => {
    const line = "See [the plan](https://example.com/trips/2026/plan) at the **harbor**.\n\n";
    const body = line.repeat(Math.floor(CHAT_MARKDOWN_MAX_LENGTH / line.length));
    expect(
      answerChatParse({ id: 4, body, candidates: CANDIDATES, attachments: [] }).parsed,
    ).toBeDefined();
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
    for (const definition of [
      `[r]: https://example.com/${"x".repeat(1000)}`,
      `[r]: https://example.com "${"t".repeat(1000)}"`,
    ]) {
      const answer = answerChatParse({
        id: 5,
        body: `${uses}\n\n${definition}`,
        candidates: CANDIDATES,
        attachments: [],
      });
      expect(answer.parsed).toBeUndefined();
    }
  });
});

describe("the drawn-body cache", () => {
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
