// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { MarkdownEditor } from "./MarkdownEditor";
import * as intraBlock from "./intraBlock";
import {
  resolveOutlineHeadingTarget,
  revealDocPosition,
  type HeadingNavigationTarget,
} from "./OutlinePanel";

// Every `moveCursorTo` the editor asked for. The block seam must ask for
// none — an external jump reveals a passage, it does not take the caret.
const revealCalls: Array<number | undefined> = [];
vi.mock("./OutlinePanel", async (importActual) => {
  const actual = await importActual<typeof import("./OutlinePanel")>();
  return {
    ...actual,
    revealDocPosition: (
      editor: Parameters<typeof actual.revealDocPosition>[0],
      pos: Parameters<typeof actual.revealDocPosition>[1],
      resolveElement: () => HTMLElement | null,
      moveCursorTo?: number,
    ) => {
      revealCalls.push(moveCursorTo);
      return actual.revealDocPosition(editor, pos, resolveElement, moveCursorTo);
    },
  };
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 0)),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  revealCalls.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveOutlineHeadingTarget", () => {
  const headings = [
    { level: 2, text: "Plan", pos: 2 },
    { level: 2, text: "Plan", pos: 20 },
    { level: 2, text: "Café plan", pos: 40 },
  ];

  it("uses workspace heading anchors and exact duplicate occurrences", () => {
    expect(resolveOutlineHeadingTarget(headings, { anchor: "plan", occurrence: 1 }))
      .toEqual(headings[1]);
    expect(resolveOutlineHeadingTarget(headings, { anchor: "plan-1" }))
      .toEqual(headings[1]);
  });

  it("decodes URL fragments before matching canonical Unicode anchors", () => {
    expect(resolveOutlineHeadingTarget(headings, { anchor: "caf%C3%A9-plan" }))
      .toEqual(headings[2]);
  });

  it("uses the same globally unique allocation for literal suffix collisions", () => {
    const colliding = [
      { level: 2, text: "Foo", pos: 2 },
      { level: 2, text: "Foo-1", pos: 20 },
      { level: 2, text: "Foo", pos: 40 },
    ];

    expect(resolveOutlineHeadingTarget(colliding, { anchor: "foo-2", occurrence: 1 }))
      .toEqual(colliding[2]);
    expect(resolveOutlineHeadingTarget(colliding, { anchor: "foo", occurrence: 1 }))
      .toEqual(colliding[2]);
    expect(resolveOutlineHeadingTarget(colliding, { anchor: "foo-1", occurrence: 1 }))
      .toEqual(colliding[2]);
  });

  it("does not reinterpret a genuine literal suffixed-base occurrence", () => {
    const colliding = [
      { level: 2, text: "Foo", pos: 2 },
      { level: 2, text: "Foo-1", pos: 20 },
      { level: 2, text: "Foo", pos: 40 },
      { level: 2, text: "Foo-1", pos: 60 },
    ];

    expect(resolveOutlineHeadingTarget(colliding, { anchor: "foo-1", occurrence: 1 }))
      .toEqual(colliding[3]);
  });
});

describe("MarkdownEditor heading navigation", () => {
  it("scrolls, flashes, and repeats the same heading jump when nonce changes", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const initialTarget: HeadingNavigationTarget = {
      anchor: "plan",
      occurrence: 1,
      nonce: 1,
    };
    const view = render(
      createElement(MarkdownEditor, {
        value: "# Intro\n\n## Plan\n\nFirst\n\n## Plan\n\nSecond",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/plan.md",
        knownFiles: [],
        headingTarget: initialTarget,
      }),
    );

    await screen.findByTestId("markdown-editor");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const duplicateHeadings = view.container.querySelectorAll("h2");
    expect(duplicateHeadings).toHaveLength(2);
    await waitFor(() =>
      expect(
        view.container
          .querySelectorAll("h2")[1]
          ?.classList.contains("dohc-outline-target-flash"),
      ).toBe(true),
      { timeout: 500 },
    );

    view.rerender(
      createElement(MarkdownEditor, {
        value: "# Intro\n\n## Plan\n\nFirst\n\n## Plan\n\nSecond",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/plan.md",
        knownFiles: [],
        headingTarget: { ...initialTarget, nonce: 2 },
      }),
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(
      view.container
        .querySelectorAll("h2")[1]
        ?.classList.contains("dohc-outline-target-flash"),
    ).toBe(true);
  });
});

// #661: the seam a search line jump lands on. FileInspector maps its pending
// Markdown line to a top-level block index; this reveals that block.
describe("MarkdownEditor block navigation", () => {
  const VALUE = "# Intro\n\nFirst para\n\nSecond para\n\nThird para";

  function renderEditor(blockTarget: { index: number; nonce: number }) {
    return createElement(MarkdownEditor, {
      value: VALUE,
      onDirty: vi.fn(),
      workspaceId: "workspace-1",
      path: "notes/plan.md",
      knownFiles: [],
      blockTarget,
    });
  }

  it("scrolls to and flashes the named block, and repeats on a new nonce", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(renderEditor({ index: 2, nonce: 1 }));
    await screen.findByTestId("markdown-editor");

    // MUTATION: drop the blockTarget effect -> nothing scrolls, and an
    // engine-backed search result opens at the top of the document again.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        view.container.querySelector(".dohc-outline-target-flash")?.textContent,
      ).toBe("Second para"),
    );

    view.rerender(renderEditor({ index: 3, nonce: 2 }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        view.container.querySelector(".dohc-outline-target-flash")?.textContent,
      ).toBe("Third para"),
    );
  });

  it("reveals the nearest block when the index runs past the document", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const view = render(renderEditor({ index: 99, nonce: 1 }));
    await screen.findByTestId("markdown-editor");

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        view.container.querySelector(".dohc-outline-target-flash")?.textContent,
      ).toBe("Third para"),
    );
  });

  // `document.activeElement` cannot answer this: setTextSelection never moves
  // focus, so asserting on it passed with the cursor move left IN. The
  // SELECTION is the thing, and revealDocPosition only touches it when the
  // caller asks — which the block seam never does.
  it("leaves the selection where it is unless the caller asks", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content: "<p>First para</p><p>Second para</p><p>Third para</p>",
    });
    editor.commands.setTextSelection(2);
    const before = editor.state.selection.from;

    // How the block seam calls it: no cursor argument.
    revealDocPosition(editor, 20, () => null);
    expect(editor.state.selection.from).toBe(before);

    // And the heading seam, which does ask, still moves it.
    revealDocPosition(editor, 20, () => null, 20);
    expect(editor.state.selection.from).toBe(20);
    editor.destroy();
  });

  // #688: the block a search result lands on can be a hundred items long.
  // The target carries the block's own source, and the reveal lands the line
  // inside it — proven here through the DOM the reader would be looking at.
  describe("landing inside a long block", () => {
    // Every element the reveal scrolled, and the flashed text it drew.
    function revealDom(view: { container: HTMLElement }) {
      const flashed = Array.from(
        view.container.querySelectorAll<HTMLElement>(".dohc-outline-target-flash"),
      );
      return {
        elements: flashed,
        text: flashed.map((node) => node.textContent).join(""),
      };
    }

    function renderJump(value: string, line: number) {
      const scrollIntoView = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      const view = render(
        createElement(MarkdownEditor, {
          value,
          onDirty: vi.fn(),
          workspaceId: "workspace-1",
          path: "notes/plan.md",
          knownFiles: [],
          // The mapping the shell sends, not a hand-written one.
          blockTarget: { ...intraBlock.blockTargetForLine(value, line), nonce: 1 },
        }),
      );
      return { view, scrollIntoView };
    }

    it("scrolls the matched item of a long list, not the list", async () => {
      const value = Array.from({ length: 60 }, (_, item) => `- Item ${item + 1}`)
        .join("\n");
      const { view, scrollIntoView } = renderJump(value, 47);
      await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      // MUTATION: return null from intraBlockRange -> the flash covers the
      // whole <ul> and the scrolled element is the list, so the reader lands
      // on "Item 1" with the match 46 items below the fold.
      const { elements, text } = revealDom(view);
      expect(text).toBe("Item 47");
      expect(scrollIntoView.mock.instances[0]).toBe(elements[0]);
      expect(elements[0]?.closest("li")?.textContent).toBe("Item 47");
    });

    it("scrolls a formatted list item by its rendered text", async () => {
      const value = "- alpha first\n- **beta** second\n- gamma third";
      const { view, scrollIntoView } = renderJump(value, 2);
      await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      // Pin the formatting-aware renderer wiring in scrollToBlock.
      const { elements, text } = revealDom(view);
      expect(text).toBe("beta second");
      expect(scrollIntoView.mock.instances[0]).toBe(elements[0]);
      expect(elements[0]?.closest("li")?.textContent).toBe("beta second");
    });

    it("scrolls the matched line of a long fenced block", async () => {
      const value = [
        "```",
        ...Array.from({ length: 80 }, (_, line) => `line ${line + 1}`),
        "```",
      ].join("\n");
      const { view, scrollIntoView } = renderJump(value, 65);
      await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      const { elements, text } = revealDom(view);
      expect(text).toBe("line 64");
      expect(scrollIntoView.mock.instances[0]).toBe(elements[0]);
      expect(elements[0]?.closest("pre")).toBeTruthy();
    });

    it("scrolls the block itself when the inner mapping is unsure", async () => {
      // A quote: it has children, and no rule maps a source line onto them.
      const value = ["> one", "> two", "> three", "> four"].join("\n");
      const { view, scrollIntoView } = renderJump(value, 3);
      await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      const { elements } = revealDom(view);
      expect(elements).toHaveLength(1);
      expect(elements[0]?.tagName).toBe("BLOCKQUOTE");
      expect(scrollIntoView.mock.instances[0]).toBe(elements[0]);
    });

    it("drops the inner match when the block index is clamped", async () => {
      const value = "- First\n- Shared\n\nMiddle\n\nLast paragraph";
      const target = {
        ...intraBlock.blockTargetForLine(value, 2),
        index: 99,
        nonce: 1,
      };
      const refine = vi
        .spyOn(intraBlock, "intraBlockRange")
        .mockImplementation((_container, containerPos) => ({
          from: containerPos + 1,
          to: containerPos + 5,
        }));
      const scrollIntoView = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      const view = render(
        createElement(MarkdownEditor, {
          value,
          onDirty: vi.fn(),
          workspaceId: "workspace-1",
          path: "notes/plan.md",
          knownFiles: [],
          blockTarget: target,
        }),
      );
      await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(revealDom(view).elements).toHaveLength(1));

      const { elements, text } = revealDom(view);
      expect(refine).not.toHaveBeenCalled();
      expect(text).toBe("Last paragraph");
      expect(elements).toHaveLength(1);
      expect(elements[0]?.tagName).toBe("P");
      expect(scrollIntoView.mock.instances[0]).toBe(elements[0]);
    });
  });

  it("reveals a block without asking for a cursor move", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const view = render(renderEditor({ index: 2, nonce: 1 }));
    await screen.findByTestId("markdown-editor");
    await waitFor(() =>
      expect(view.container.querySelector(".dohc-outline-target-flash")).toBeTruthy(),
    );

    // MUTATION: pass `pos + 1` as moveCursorTo in scrollToBlock -> the reveal
    // takes the caret over, and this records the argument that did it.
    expect(revealCalls.length).toBeGreaterThan(0);
    for (const call of revealCalls) expect(call).toBeUndefined();
  });
});
