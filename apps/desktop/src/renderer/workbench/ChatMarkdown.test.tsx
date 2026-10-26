// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { bridge } from "../bridge";
import { ChatMarkdown } from "./ChatMarkdown";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
