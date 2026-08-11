// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Components } from "react-markdown";
import { bridge } from "../bridge";
import { IncrementalMarkdownDocument } from "./IncrementalMarkdownDocument";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

const MULTI_SLICE_HEADING_COUNT = 240;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function largeDocument(label: string) {
  return Array.from(
    { length: 80 },
    (_, index) =>
      `# ${label} ${index + 1}\n\n${`${label.toLowerCase()} body `.repeat(70)}`,
  ).join("\n\n");
}

function multiSliceDocument(label: string) {
  return Array.from(
    { length: MULTI_SLICE_HEADING_COUNT },
    (_, index) =>
      `# ${label} ${index + 1}\n\n${`${label.toLowerCase()} body `.repeat(70)}`,
  ).join("\n\n");
}

async function finishMultiSliceBackfill(container: HTMLElement) {
  let sliceCount = 0;
  while (vi.getTimerCount() > 0) {
    expect(sliceCount).toBeLessThan(MULTI_SLICE_HEADING_COUNT);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    sliceCount += 1;
  }
  expect(sliceCount).toBeGreaterThan(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(container.querySelectorAll("h1")).toHaveLength(
    MULTI_SLICE_HEADING_COUNT,
  );
}

function stubIdleCallbacks() {
  let nextId = 1;
  const scheduled = new Map<number, IdleRequestCallback>();
  const pending = new Map<number, IdleRequestCallback>();
  const request = vi.fn((callback: IdleRequestCallback) => {
    const id = nextId++;
    scheduled.set(id, callback);
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    pending.delete(id);
  });
  const deadline: IdleDeadline = {
    didTimeout: false,
    timeRemaining: () => 50,
  };

  vi.stubGlobal("requestIdleCallback", request);
  vi.stubGlobal("cancelIdleCallback", cancel);

  return {
    request,
    cancel,
    scheduled,
    pending,
    async invoke(callback: IdleRequestCallback) {
      await act(async () => {
        callback(deadline);
      });
    },
    async finishBackfill() {
      let sliceCount = 0;
      while (pending.size > 0) {
        expect(sliceCount).toBeLessThan(MULTI_SLICE_HEADING_COUNT);
        const next = pending.entries().next().value;
        expect(next).toBeDefined();
        const [id, callback] = next!;
        pending.delete(id);
        await act(async () => {
          callback(deadline);
        });
        sliceCount += 1;
      }
      expect(sliceCount).toBeGreaterThan(1);
    },
  };
}

describe("IncrementalMarkdownDocument", () => {
  it("activates a read-only link once for each supported input", () => {
    const openWorkspaceLink = vi.fn();
    const view = render(
      <IncrementalMarkdownDocument
        body="[FAQ](faq%3F.md?mode=preview#a%2520b) [Top](#)"
        components={{}}
        onOpenWorkspaceLink={openWorkspaceLink}
      />,
    );
    const link = view.getByRole("link", { name: "FAQ" });
    expect(link.getAttribute("href")).toBe("faq%3F.md?mode=preview#a%2520b");
    link.focus();
    expect(document.activeElement).toBe(link);

    for (const detail of [1, 2, 3]) {
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail,
      });
      expect(link.dispatchEvent(click)).toBe(false);
      expect(click.defaultPrevented).toBe(true);
    }
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "./faq?.md",
      rawFragment: "a%2520b",
    });
    expect(openWorkspaceLink).toHaveBeenCalledOnce();

    openWorkspaceLink.mockClear();
    const middleClick = new MouseEvent("auxclick", {
      bubbles: true,
      button: 1,
      cancelable: true,
      detail: 1,
    });
    expect(link.dispatchEvent(middleClick)).toBe(false);
    expect(middleClick.defaultPrevented).toBe(true);
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "./faq?.md",
      rawFragment: "a%2520b",
    });
    expect(openWorkspaceLink).toHaveBeenCalledOnce();

    openWorkspaceLink.mockClear();
    for (const repeat of [false, true]) {
      const enter = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        repeat,
      });
      expect(link.dispatchEvent(enter)).toBe(false);
      expect(enter.defaultPrevented).toBe(true);
    }
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "./faq?.md",
      rawFragment: "a%2520b",
    });
    expect(openWorkspaceLink).toHaveBeenCalledOnce();

    openWorkspaceLink.mockClear();
    const top = view.getByRole("link", { name: "Top" });
    const topClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(top.dispatchEvent(topClick)).toBe(false);
    expect(topClick.defaultPrevented).toBe(true);
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "",
      rawFragment: "",
    });
    expect(openWorkspaceLink).toHaveBeenCalledOnce();
  });

  it("keeps root-relative, external, and unsafe link routing separate", () => {
    const openWorkspaceLink = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    vi.mocked(bridge).mockReturnValue({
      openExternalUrl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const view = render(
      <IncrementalMarkdownDocument
        body={[
          "[Root](/plan.md?mode=preview#risks)",
          "[External](https://example.com/plan?mode=preview#risks)",
          "[Unsafe](javascript:alert(1)?mode=preview#risks)",
        ].join(" ")}
        components={{}}
        onOpenWorkspaceLink={openWorkspaceLink}
      />,
    );

    const root = view.getByRole("link", { name: "Root" });
    const rootClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(root.dispatchEvent(rootClick)).toBe(false);
    expect(openWorkspaceLink).toHaveBeenCalledWith({
      path: "/plan.md",
      rawFragment: "risks",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();

    const external = view.getByRole("link", { name: "External" });
    const externalClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    expect(external.dispatchEvent(externalClick)).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/plan?mode=preview#risks",
    });
    expect(openWorkspaceLink).toHaveBeenCalledOnce();

    expect(view.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(view.getByText("Unsafe")).toBeTruthy();
    expect(openExternalUrl).toHaveBeenCalledOnce();
  });

  it("keeps a replacement document inside the opening render window", async () => {
    vi.useFakeTimers();
    const renderedHeadings: string[] = [];
    const components: Components = {
      h1: ({ children }) => {
        renderedHeadings.push(String(children));
        return <h1>{children}</h1>;
      },
    };
    const firstBody = largeDocument("First");
    const secondBody = largeDocument("Second");
    expect(firstBody.length).toBeGreaterThan(32 * 1024);

    const freshReplacement = render(
      <IncrementalMarkdownDocument
        body={secondBody}
        components={components}
      />,
    );
    const secondOpeningHeadingCount = renderedHeadings.length;
    expect(secondOpeningHeadingCount).toBeGreaterThan(0);
    expect(secondOpeningHeadingCount).toBeLessThan(80);
    freshReplacement.unmount();
    renderedHeadings.length = 0;

    const view = render(
      <IncrementalMarkdownDocument
        body={firstBody}
        components={components}
      />,
    );
    const openingHeadingCount = renderedHeadings.length;
    expect(openingHeadingCount).toBeGreaterThan(0);
    expect(openingHeadingCount).toBeLessThan(80);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(renderedHeadings).toHaveLength(80);

    renderedHeadings.length = 0;
    view.rerender(
      <IncrementalMarkdownDocument
        body={secondBody}
        components={components}
      />,
    );

    expect(renderedHeadings).toHaveLength(secondOpeningHeadingCount);
  });

  it("continues idle backfill through every slice", async () => {
    vi.useFakeTimers();
    const components: Components = {};
    const firstBody = multiSliceDocument("First");
    const secondBody = multiSliceDocument("Second");

    const view = render(
      <IncrementalMarkdownDocument
        body={firstBody}
        components={components}
      />,
    );
    expect(view.container.querySelectorAll("h1").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll("h1").length).toBeLessThan(
      MULTI_SLICE_HEADING_COUNT,
    );

    await finishMultiSliceBackfill(view.container);

    view.rerender(
      <IncrementalMarkdownDocument
        body={secondBody}
        components={components}
      />,
    );
    expect(view.container.querySelectorAll("h1").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll("h1").length).toBeLessThan(
      MULTI_SLICE_HEADING_COUNT,
    );

    await finishMultiSliceBackfill(view.container);
  });

  it("ignores a canceled callback after replacing an unfinished document", async () => {
    const idle = stubIdleCallbacks();
    const components: Components = {};
    const firstBody = multiSliceDocument("First");
    const secondBody = multiSliceDocument("Other");
    let commitCount = 0;
    const onRender = () => {
      commitCount += 1;
    };
    const document = (body: string) => (
      <Profiler id="document" onRender={onRender}>
        <IncrementalMarkdownDocument body={body} components={components} />
      </Profiler>
    );

    const view = render(document(firstBody));
    const firstOpeningCount = view.container.querySelectorAll("h1").length;
    const staleEntry = idle.scheduled.entries().next().value;
    expect(staleEntry).toBeDefined();
    const [staleId, staleCallback] = staleEntry!;

    view.rerender(document(secondBody));
    const replacementHeadings = Array.from(
      view.container.querySelectorAll("h1"),
      (heading) => heading.textContent,
    );
    expect(replacementHeadings).toHaveLength(firstOpeningCount);
    expect(
      replacementHeadings.every((heading) => heading?.startsWith("Other")),
    ).toBe(true);
    expect(idle.cancel).toHaveBeenCalledWith(staleId);
    expect(idle.pending.has(staleId)).toBe(false);
    expect(idle.pending.size).toBeGreaterThan(0);

    const replacementCommitCount = commitCount;
    await idle.invoke(staleCallback);
    expect(commitCount).toBe(replacementCommitCount);
    expect(
      Array.from(
        view.container.querySelectorAll("h1"),
        (heading) => heading.textContent,
      ),
    ).toEqual(replacementHeadings);

    await idle.finishBackfill();
    expect(view.container.querySelectorAll("h1")).toHaveLength(
      MULTI_SLICE_HEADING_COUNT,
    );
    expect(
      Array.from(view.container.querySelectorAll("h1")).every((heading) =>
        heading.textContent?.startsWith("Other"),
      ),
    ).toBe(true);
  });
});
