// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkeletonRows, SkeletonSlot } from "./SkeletonRows";

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
    const { rerender } = render(<SkeletonSlot><SkeletonRows inSlot key="fallback" label="Loading apps..." /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot><SkeletonRows inSlot key="view" label="Loading apps…" testId="view" /></SkeletonSlot>);
    expect(waiting("view")).toBe(false);
  });

  it("keeps the wait when the lines it replaces were still blank", () => {
    const time = clock(20_000);
    painted("0");
    const { rerender } = render(<SkeletonSlot><SkeletonRows inSlot key="fallback" label="Loading…" /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot><SkeletonRows inSlot key="view" label="Loading…" testId="view" /></SkeletonSlot>);
    expect(waiting("view")).toBe(true);
  });

  // The view's own lines leave as its content arrives, and a loader deeper in
  // that content, such as a message list, starts in another place.
  it("keeps the wait for lines nested in the slot that do not stand in its place", () => {
    const time = clock(25_000);
    painted("1");
    const { rerender } = render(<SkeletonSlot><SkeletonRows inSlot key="view" label="Loading Chats..." /></SkeletonSlot>);
    time.now += 200;
    rerender(<SkeletonSlot><div><SkeletonRows key="messages" label="Loading..." testId="nested" /></div></SkeletonSlot>);
    expect(waiting("nested")).toBe(true);
  });

  // A tab or workspace switch mounts new lines while other lines leave.
  it("keeps the wait for lines in another place, or in no slot", () => {
    const time = clock(30_000);
    painted("1");
    const { rerender } = render(<>
      <SkeletonSlot><SkeletonRows inSlot key="a" label="Loading apps…" /></SkeletonSlot>
      <SkeletonSlot>{null}</SkeletonSlot>
      <SkeletonRows key="c" label="Loading…" />
    </>);
    time.now += 200;
    rerender(<>
      <SkeletonSlot>{null}</SkeletonSlot>
      <SkeletonSlot><SkeletonRows inSlot key="b" label="Loading Chats..." testId="other-slot" /></SkeletonSlot>
      <SkeletonRows key="d" label="Loading…" testId="no-slot" />
    </>);
    expect(waiting("other-slot")).toBe(true);
    expect(waiting("no-slot")).toBe(true);
  });





  // The wait is what keeps a quick load from flashing, and it lives in the
  // stylesheet, so a change there must fail here. Reduced motion shortens
  // only the duration, so the wait survives it.
});
