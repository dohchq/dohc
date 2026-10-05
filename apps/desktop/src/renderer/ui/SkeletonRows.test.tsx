// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import css from "../styles.css?raw";
import { SkeletonLines, SkeletonRows, SkeletonSlot } from "./SkeletonRows";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function clock(start: number) {
  const time = { now: start };
  vi.spyOn(performance, "now").mockImplementation(() => time.now);
  return time;
}

// jsdom runs no animations, so the test says what opacity the browser would
// report for lines that are leaving.
function painted(opacity: "0" | "1") {
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ opacity }) as unknown as CSSStyleDeclaration);
}

const waiting = (testId: string) => screen.getByTestId(testId).style.animation !== "none";

describe("SkeletonRows", () => {
  // A lazy view's fallback lines give way to the view's own loading lines in
  // one commit. Waiting again would blank the lines that were already showing.
  it("shows at once when it takes over, in the same slot, from lines that were showing", () => {
    const time = clock(10_000);
    painted("1");
    const { rerender } = render(<SkeletonSlot><SkeletonRows key="fallback" label="Loading apps..." /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot><SkeletonRows key="view" label="Loading apps…" testId="view" /></SkeletonSlot>);
    expect(waiting("view")).toBe(false);
  });

  it("keeps the wait when the lines it replaces were still blank", () => {
    const time = clock(20_000);
    painted("0");
    const { rerender } = render(<SkeletonSlot><SkeletonRows key="fallback" label="Loading…" /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot><SkeletonRows key="view" label="Loading…" testId="view" /></SkeletonSlot>);
    expect(waiting("view")).toBe(true);
  });

  // A tab or workspace switch mounts new lines while other lines leave.
  it("keeps the wait for lines in another place, or in no slot", () => {
    const time = clock(30_000);
    painted("1");
    const { rerender } = render(<>
      <SkeletonSlot><SkeletonRows key="a" label="Loading apps…" /></SkeletonSlot>
      <SkeletonSlot>{null}</SkeletonSlot>
      <SkeletonRows key="c" label="Loading…" />
    </>);
    time.now += 200;
    rerender(<>
      <SkeletonSlot>{null}</SkeletonSlot>
      <SkeletonSlot><SkeletonRows key="b" label="Loading Chats..." testId="other-slot" /></SkeletonSlot>
      <SkeletonRows key="d" label="Loading…" testId="no-slot" />
    </>);
    expect(waiting("other-slot")).toBe(true);
    expect(waiting("no-slot")).toBe(true);
  });

  it("keeps the wait when the clock went back", () => {
    const time = clock(40_000);
    painted("1");
    const { rerender } = render(<SkeletonSlot><SkeletonRows key="fallback" label="Loading…" /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot>{null}</SkeletonSlot>);
    time.now = 1_000;
    rerender(<SkeletonSlot><SkeletonRows key="view" label="Loading…" testId="view" /></SkeletonSlot>);
    expect(waiting("view")).toBe(true);
  });

  it("is one status whose only words are its label", () => {
    render(<SkeletonRows label="Loading history..." testId="loading" />);
    const status = screen.getByRole("status");
    expect(status).toBe(screen.getByTestId("loading"));
    expect(status.textContent).toBe("Loading history...");
  });

  it("draws the drawing's four lines by default, hidden from a screen reader", () => {
    render(<SkeletonRows label="Loading…" />);
    const lines = screen.getByRole("status").querySelectorAll("[aria-hidden]");
    expect([...lines].map((line) => line.className.match(/w-\[\d+%\]/)?.[0])).toEqual([
      "w-[80%]",
      "w-[62%]",
      "w-[90%]",
      "w-[54%]",
    ]);
  });

  it("repeats the widths for more rows", () => {
    render(<SkeletonRows label="Loading…" rows={6} />);
    const lines = screen.getByRole("status").querySelectorAll("[aria-hidden]");
    expect(lines).toHaveLength(6);
    expect(lines[4]?.className).toContain("w-[80%]");
  });

  it("leaves the status to the surface when only the lines are drawn", () => {
    const { container } = render(<SkeletonLines rows={2} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(container.firstElementChild?.textContent).toBe("");
  });

  // The wait is what keeps a quick load from flashing, and it lives in the
  // stylesheet, so a change there must fail here. Reduced motion shortens
  // only the duration, so the wait survives it.
  it("stays blank for 150ms and holds no keyframe afterwards", () => {
    render(<SkeletonRows label="Loading…" />);
    expect(screen.getByRole("status").classList.contains("dohc-reveal-if-slow")).toBe(true);
    expect(css).toMatch(/\.dohc-reveal-if-slow \{\s*animation: dohc-reveal-if-slow \d+ms ease-out 150ms backwards;\s*\}/);
    expect(css).toMatch(/@keyframes dohc-reveal-if-slow \{\s*from \{\s*opacity: 0;\s*\}\s*\}/);
  });
});
