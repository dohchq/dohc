// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  resolveOutlineHeadingTarget,
  type HeadingNavigationTarget,
} from "./OutlinePanel";

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
